import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chatNumber, TOODO_CHANNEL, type ToodoApi, type ToodoPendingItem } from "./toodo.ts";

/*
 * The built-in `toodo` source. Each pass reads the Toodo inbox the crash-safe way external-lead.md prescribes: peek,
 * journal every item under a stable id (the store dedupes a repeat), and only then take those ids. A crash between the
 * journal write and the take leaves the items pending; the next pass peeks them again and the journal drops them as
 * duplicates before taking. A pass runs on every `chat-changed` from the event stream and on a safety timer.
 *
 *   chat-<n>   a person's message: `INBOUND toodo <n> user <text>`, id toodo:chat:<n>, tracked like a Discord owner message
 *   event-<n>  a followed task's status change: `TOODO_TASK ...`, id toodo:event:<n>, informational
 *   system     the server's finish reports, read from list_chat past a saved cursor: `TOODO_FINISH ...`, id toodo:system:<n>
 */

export const TOODO_CURSOR_FILE = "toodo-inbound.json";
/** The supervisor's Toodo heartbeat (event stream open or not), read by dori status and dori doctor. */
export const TOODO_STATUS_FILE = "toodo-status.json";
export const TOODO_STALE_MS = 60_000;

export type ToodoStatus = { readonly pid: number; readonly at: number; readonly connected: boolean; readonly url: string };

export const writeToodoStatus = (stateDir: string, status: ToodoStatus): void => {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, TOODO_STATUS_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(status), { mode: 0o600 });
  renameSync(tmp, path);
};

export const readToodoStatus = (stateDir: string): ToodoStatus | undefined => {
  try {
    const s = JSON.parse(readFileSync(join(stateDir, TOODO_STATUS_FILE), "utf8")) as Record<string, unknown>;
    return typeof s.at === "number" && typeof s.connected === "boolean" && typeof s.pid === "number" && typeof s.url === "string"
      ? { pid: s.pid, at: s.at, connected: s.connected, url: s.url } : undefined;
  } catch { return undefined; }
};

export type ToodoView = { readonly state: "live" | "disconnected" | "stale" | "missing"; readonly text: string };

/** The channel as dori status and doctor show it: live while the supervisor holds the event stream open. */
export const toodoView = (status: ToodoStatus | undefined, now: number): ToodoView => {
  if (!status) return { state: "missing", text: "no Toodo status file (supervisor not running with toodo configured)" };
  const age = Math.max(0, Math.round((now - status.at) / 1000));
  if (now - status.at > TOODO_STALE_MS) return { state: "stale", text: `stale: last heartbeat ${age}s ago` };
  if (!status.connected) return { state: "disconnected", text: `event stream not open, safety poll only (heartbeat ${age}s ago)` };
  return { state: "live", text: `live, event stream open (heartbeat ${age}s ago)` };
};
/** At most this many peek/take rounds per pass (50 items each); the rest follows on the next pass. */
export const TOODO_ROUNDS = 20;

export type ToodoInboundDeps = {
  readonly toodo: () => ToodoApi;
  /** Supervisor.enqueue through the source registry: durable before it returns; false for an id already journaled. */
  readonly enqueue: (id: string, line: string) => boolean;
  readonly stateDir: string;
  readonly now: () => number;
  readonly pollMs: number;
  readonly log?: (line: string) => void;
  /** Reads the event stream until it ends (toodo.ts listenToodoEvents); absent leaves the safety poll only. */
  readonly listen?: (wake: () => void, signal: AbortSignal, onOpen: () => void) => Promise<void>;
  /** Waits before reconnecting the stream; tests resolve at once. */
  readonly backoff?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The journal id and line of one inbox item, or undefined for an item this version does not know. */
export const toodoItemEvent = (item: ToodoPendingItem): { readonly id: string; readonly line: string } | undefined => {
  const chat = chatNumber(item.id);
  if (item.kind === "chat" && chat !== undefined) {
    return { id: `toodo:chat:${chat}`, line: `INBOUND ${TOODO_CHANNEL} ${chat} user ${flat(item.body ?? "") || "(empty message)"}` };
  }
  const event = /^event-(\d+)$/.exec(item.id)?.[1];
  if (item.kind === "task_event" && event) {
    const report = item.reportId !== undefined ? ` (reported in the Toodo chat as message ${item.reportId})` : "";
    return { id: `toodo:event:${event}`, line: `TOODO_TASK ${item.id} task ${item.taskId ?? "?"} ${item.status ?? "?"}: ${flat(item.title ?? "")}${report}` };
  }
  return undefined;
};

type Cursor = { readonly chat: number };

const readCursor = (path: string): Cursor | undefined => {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw === "object" && raw !== null && "chat" in raw && Number.isSafeInteger(raw.chat) ? { chat: raw.chat as number } : undefined;
  } catch { return undefined; }
};

const writeCursor = (stateDir: string, path: string, cursor: Cursor): void => {
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(cursor)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
};

export const supervisorToodo = (deps: ToodoInboundDeps) => {
  const log = deps.log ?? console.error;
  const cursorPath = join(deps.stateDir, TOODO_CURSOR_FILE);
  const controller = new AbortController();
  let lastPass = -Infinity;
  let running: Promise<void> | undefined;
  let again = false;
  let connected = false;

  /** Peek, journal, then take: the take never runs before every peeked item is journaled. */
  const inbox = async (toodo: ToodoApi): Promise<void> => {
    for (let round = 0; round < TOODO_ROUNDS; round++) {
      const peeked = await toodo.peek();
      const ids: string[] = [];
      for (const item of peeked.items) {
        const event = toodoItemEvent(item);
        if (!event) { log(`TOODO_ITEM_UNKNOWN ${item.id} kind=${item.kind}; left pending`); continue; }
        deps.enqueue(event.id, event.line);
        ids.push(item.id);
      }
      if (!ids.length) return;
      await toodo.take(ids);
      if (!peeked.remaining) return;
    }
  };

  /**
   * The server's finish reports past the saved cursor. The first pass ever only sets the cursor at the newest message:
   * reports from before the channel was set up are history, not news.
   */
  const finishes = async (toodo: ToodoApi): Promise<void> => {
    const saved = readCursor(cursorPath);
    let after = saved?.chat ?? 0;
    for (;;) {
      const feed = await toodo.listChat(after);
      for (const message of feed.messages) {
        if (saved && message.author === "system" && !message.origin) {
          deps.enqueue(`toodo:system:${message.id}`, `TOODO_FINISH ${message.id} ${flat(message.body)}`);
        }
        after = Math.max(after, message.id);
      }
      if (!feed.more || !feed.messages.length) break;
    }
    if (!saved || after !== saved.chat) writeCursor(deps.stateDir, cursorPath, { chat: after });
  };

  const pass = (): Promise<void> => {
    again = true;
    if (running) return running;
    running = (async () => {
      while (again && !controller.signal.aborted) {
        again = false;
        lastPass = deps.now();
        const toodo = deps.toodo();
        await inbox(toodo);
        await finishes(toodo);
      }
    })().finally(() => { running = undefined; });
    return running;
  };

  const wake = (): void => { void pass().catch((e: unknown) => { log(`TOODO_INBOUND_ERROR ${e instanceof Error ? e.message : String(e)}`); }); };

  const listening = deps.listen ? (async () => {
    const backoff = deps.backoff ?? ((ms, signal) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }));
    let delay = 1_000;
    while (!controller.signal.aborted) {
      try {
        await deps.listen?.(wake, controller.signal, () => { connected = true; delay = 1_000; });
      } catch (e) {
        if (!controller.signal.aborted) log(`TOODO_STREAM_ERROR ${e instanceof Error ? e.message : String(e)}`);
      }
      connected = false;
      if (controller.signal.aborted) break;
      await backoff(delay, controller.signal);
      delay = Math.min(delay * 2, 30_000);
    }
  })() : Promise.resolve();

  return {
    /** Whether the event stream is open (the heartbeat file). */
    state: () => ({ connected }),
    /** The safety poll: a pass when none ran for pollMs. Errors reach the caller (the source registry records them). */
    async tick(): Promise<void> {
      if (running) { await running; return; }
      if (deps.now() - lastPass >= deps.pollMs) await pass();
    },
    /** Runs a pass now (tests, and a wake from the stream). */
    pass,
    async close(): Promise<void> {
      controller.abort();
      await listening;
      await running?.catch(() => {});
    },
  };
};
