import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { SourceEnqueue } from "./event-sources.ts";
import { redactSecrets } from "./redact.ts";

/*
 * The Toodo task events (the built-in `toodo` source). The supervisor follows toodo-server's event stream
 * (`GET <url>/api/events`, server-sent events, bearer token read from `tokenFile`) and journals:
 *   task-status-changed  -> TOODO_TASK_STATUS #<task> <from>-><to> workspace=<id>         (digest)
 *   task-ready           -> TOODO_TASK_READY #<task> workspace=<id> unblocked-by=#<task>  (urgent)
 *   resync               -> TOODO_TASK_RESYNC ...                                         (digest)
 * The event id is `toodo:<stream id>`, so the journal's dedupe drops a replayed event. The id of the last event handled
 * is saved in <stateDir>/toodo-events.json only after its line is journaled and sent back as Last-Event-ID on the next
 * connection, so a supervisor restart resumes where it stopped: nothing lost, nothing delivered twice.
 * The stream runs beside the supervisor's tasks, never inside them: a toodo-server that is down, refuses the token or
 * stops sending is retried with backoff (TOODO_RETRY_MIN_MS doubling to TOODO_RETRY_MAX_MS) and never blocks a pass.
 */

export const TOODO_CURSOR_FILE = "toodo-events.json";
export const TOODO_RETRY_MIN_MS = 1_000;
export const TOODO_RETRY_MAX_MS = 60_000;
/** toodo-server sends a keep-alive comment every 15 s; a stream silent this long is dead and is reopened. */
export const TOODO_IDLE_MS = 45_000;

export type ToodoEventsConfig = {
  /** Base URL of toodo-server; the stream is `<url>/api/events`. */
  readonly url: string;
  /** File holding the bearer token (toodo-server's web-token or a device token; its mcp-token is refused on /api). */
  readonly tokenFile: string;
  readonly enabled: boolean;
};

export type ToodoEventsDeps = {
  readonly config: ToodoEventsConfig;
  readonly stateDir: string;
  readonly enqueue: SourceEnqueue;
  /** The source registry's status: a failure as it starts, and recovery once a stream opens. */
  readonly fail: (error: unknown) => void;
  readonly ok: () => void;
  readonly log: (line: string) => void;
  /** Every stream event's name, journaled or not (e.g. `tasks-changed`), after its line is enqueued: the autopilot tick's kick. */
  readonly onEvent?: (event: string) => void;
  readonly fetch?: typeof fetch;
  readonly idleMs?: number;
  readonly retryMinMs?: number;
  readonly retryMaxMs?: number;
};

type SseEvent = { readonly id: string; readonly event: string; readonly data: string };

class ToodoStreamError extends Error {}

const text = (e: unknown): string => redactSecrets(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

/** The last stream id handled, or undefined with no (or an unreadable) cursor file. */
export const readToodoCursor = (stateDir: string): string | undefined => {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, TOODO_CURSOR_FILE), "utf8")) as { lastEventId?: unknown };
    return typeof raw.lastEventId === "string" && raw.lastEventId ? raw.lastEventId : undefined;
  } catch { return undefined; }
};

const writeCursor = (stateDir: string, lastEventId: string): void => {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, TOODO_CURSOR_FILE);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify({ lastEventId })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
};

const field = (data: Record<string, unknown>, name: string): string => {
  const value = data[name];
  return typeof value === "number" || typeof value === "string" ? String(value) : "?";
};

/** The journal line of one stream event, or undefined for the names the lead does not hear (web app refreshes, `ready`). */
export const toodoLine = (event: string, data: string): string | undefined => {
  if (event === "resync") return "TOODO_TASK_RESYNC toodo-server events were missed (it restarted or more went by than it keeps); read the current state with list_tasks";
  if (event !== "task-status-changed" && event !== "task-ready") return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { throw new ToodoStreamError(`${event} event with data that is not JSON`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ToodoStreamError(`${event} event with data that is not an object`);
  const fields = parsed as Record<string, unknown>;
  if (event === "task-ready") return `TOODO_TASK_READY #${field(fields, "taskId")} workspace=${field(fields, "workspaceId")} unblocked-by=#${field(fields, "unblockedBy")}`;
  const from = fields.from === null ? "new" : field(fields, "from");
  return `TOODO_TASK_STATUS #${field(fields, "taskId")} ${from}->${field(fields, "to")} workspace=${field(fields, "workspaceId")}`;
};

/** Server-sent event blocks from a byte stream; the id carries over to blocks without one, as the SSE spec says. */
async function* sseEvents(body: ReadableStream<Uint8Array>, onBytes: () => void, lastId: string): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let id = lastId;
  let event = "";
  let data: string[] = [];
  for await (const chunk of body) {
    onBytes();
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));
      if (line === "") {
        if (data.length || event) yield { id, event: event || "message", data: data.join("\n") };
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const name = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (name === "id" && !value.includes("\0")) id = value;
      else if (name === "event") event = value;
      else if (name === "data") data.push(value);
    }
  }
}

const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done(): void { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

export class ToodoEvents {
  private failing = false;

  constructor(private readonly deps: ToodoEventsDeps) {}

  /** Follows the stream until `signal` aborts; never rejects. Without `enabled` or a token file it does not start (no failing source). */
  async run(signal: AbortSignal): Promise<void> {
    if (!this.deps.config.enabled || !existsSync(this.deps.config.tokenFile)) return;
    const min = this.deps.retryMinMs ?? TOODO_RETRY_MIN_MS;
    const max = this.deps.retryMaxMs ?? TOODO_RETRY_MAX_MS;
    let delay = min;
    while (!signal.aborted) {
      try {
        await this.follow(signal, () => { delay = min; });
        if (signal.aborted) break;
        this.down(new ToodoStreamError("the event stream ended"), delay);
      } catch (e) {
        if (signal.aborted) break;
        this.down(e, delay);
      }
      await pause(delay, signal);
      delay = Math.min(delay * 2, max);
    }
  }

  private down(error: unknown, delay: number): void {
    if (this.failing) return;
    this.failing = true;
    this.deps.log(`TOODO_EVENTS_DOWN ${text(error)}; retrying with backoff from ${Math.round(delay / 1_000)} s`);
    this.deps.fail(error);
  }

  /** One connection: opens the stream with the saved Last-Event-ID and journals its events until it ends. */
  private async follow(signal: AbortSignal, opened: () => void): Promise<void> {
    const { config, stateDir } = this.deps;
    let token: string;
    try { token = readFileSync(config.tokenFile, "utf8").trim(); } catch (e) {
      throw new ToodoStreamError(`cannot read the token file ${config.tokenFile}: ${e instanceof Error && "code" in e ? String(e.code) : text(e)}`);
    }
    if (!token) throw new ToodoStreamError(`the token file ${config.tokenFile} is empty`);
    const idle = new AbortController();
    const idleMs = this.deps.idleMs ?? TOODO_IDLE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => { idle.abort(new ToodoStreamError(`no data from toodo-server for ${Math.round(idleMs / 1_000)} s`)); }, idleMs);
    };
    const cursor = readToodoCursor(stateDir);
    const url = `${config.url.replace(/\/+$/, "")}/api/events`;
    try {
      alive();
      const response = await (this.deps.fetch ?? fetch)(url, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", ...(cursor ? { "last-event-id": cursor } : {}) },
        signal: AbortSignal.any([signal, idle.signal]),
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new ToodoStreamError(`${url} answered ${response.status}${response.status === 401 ? " (token refused: use the web-token or a device token)" : ""}`);
      }
      opened();
      if (this.failing) this.deps.ok();
      this.deps.log(`TOODO_EVENTS_CONNECTED ${url}${cursor ? ` resuming after ${cursor}` : ""}`);
      this.failing = false;
      for await (const event of sseEvents(response.body, alive, cursor ?? "")) {
        if (!event.id) continue;
        const line = toodoLine(event.event, event.data);
        // Journaled before the cursor moves: a crash in between replays the event, and the journal drops the repeat.
        if (line) this.deps.enqueue(`toodo:${event.id}`, line);
        writeCursor(stateDir, event.id);
        this.deps.onEvent?.(event.event);
      }
    } catch (e) {
      if (idle.signal.aborted && !signal.aborted) throw idle.signal.reason;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
