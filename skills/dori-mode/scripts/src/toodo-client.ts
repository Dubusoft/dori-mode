import { readFileSync } from "node:fs";

import type { ToodoTask } from "./autopilot.ts";

/**
 * The toodo-server clients. ToodoClient reads for autopilot: `list_tasks` and `get_task` over `POST <url>/api/rpc/<command>` with
 * the bearer token read from `tokenFile` (the same url and token file as the toodo event stream). Every failure (token
 * file missing or empty, network error, timeout, non-200, a reply that is not a task list) throws ToodoUnreadable, so a
 * caller maps any of them to `toodo-unreadable`. A missing task on `get_task` (404) is undefined, not an error.
 * ToodoWriter (below) writes to a task over the MCP endpoint and reads every write back.
 */

export const TOODO_TIMEOUT_MS = 10_000;
/** list_tasks takes at most this many ids per call. */
export const TOODO_MAX_IDS = 500;

export type ToodoClientConfig = { readonly url: string; readonly tokenFile: string };
export type ToodoFetch = (url: string, init: RequestInit) => Promise<Response>;

export class ToodoUnreadable extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ToodoUnreadable";
  }
}

/** The token in `tokenFile`; `fail` builds the error for a file that cannot be read or is empty. */
const readToken = (tokenFile: string, fail: (message: string) => Error): string => {
  let token: string;
  try { token = readFileSync(tokenFile, "utf8").trim(); } catch (e) {
    throw fail(`cannot read the token file ${tokenFile}: ${e instanceof Error && "code" in e ? String(e.code) : String(e)}`);
  }
  if (!token) throw fail(`the token file ${tokenFile} is empty`);
  return token;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const STATUSES = new Set(["planned", "in_progress", "in_review", "done"]);
const RESOLUTIONS = new Set(["merged", "completed", "not_adopted"]);

/** The predicate's fields of one task as toodo-server returns it; ToodoUnreadable on a shape the predicate cannot read. */
const toTask = (raw: unknown): ToodoTask => {
  const bad = (what: string): never => { throw new ToodoUnreadable(`toodo-server returned a task with ${what}`); };
  if (!isRecord(raw) || !isId(raw.id)) return bad("no id");
  const id = raw.id;
  if (!isId(raw.workspaceId)) return bad(`no workspaceId (#${id})`);
  if (typeof raw.title !== "string" || typeof raw.description !== "string") return bad(`no title or description (#${id})`);
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) return bad(`status ${JSON.stringify(raw.status)} (#${id})`);
  const resolution = raw.resolution ?? null;
  if (resolution !== null && (typeof resolution !== "string" || !RESOLUTIONS.has(resolution))) return bad(`resolution ${JSON.stringify(resolution)} (#${id})`);
  const dependsOn = raw.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || !dependsOn.every(isId)) return bad(`unreadable dependsOn (#${id})`);
  const refs = raw.refs ?? [];
  if (!Array.isArray(refs) || !refs.every((r) => typeof r === "string")) return bad(`unreadable refs (#${id})`);
  const criteria = raw.criteria ?? [];
  if (!Array.isArray(criteria) || !criteria.every((c) => isRecord(c) && typeof c.text === "string" && typeof c.kind === "string")) return bad(`unreadable criteria (#${id})`);
  const wait = raw.wait ?? null;
  if (wait !== null && (!isRecord(wait) || typeof wait.until !== "number" || typeof wait.status !== "string")) return bad(`unreadable wait (#${id})`);
  const autopilot = raw.autopilot ?? false;
  if (typeof autopilot !== "boolean") return bad(`unreadable autopilot (#${id})`);
  const dueDate = raw.dueDate ?? null;
  if (dueDate !== null && typeof dueDate !== "string") return bad(`unreadable dueDate (#${id})`);
  return {
    id, workspaceId: raw.workspaceId, title: raw.title, description: raw.description, status: raw.status as ToodoTask["status"],
    resolution: resolution as ToodoTask["resolution"], dependsOn: dependsOn as number[], refs: refs as string[],
    criteria: (criteria as Record<string, unknown>[]).map((c) => ({
      text: c.text as string, kind: c.kind as string, ...(typeof c.target === "string" ? { target: c.target } : {}),
    })),
    wait: wait === null ? null : { until: (wait as { until: number }).until, status: (wait as { status: string }).status },
    autopilot, dueDate,
  };
};

export class ToodoClient {
  private readonly fetch: ToodoFetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: ToodoClientConfig, deps: { readonly fetch?: ToodoFetch; readonly timeoutMs?: number } = {}) {
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = deps.timeoutMs ?? TOODO_TIMEOUT_MS;
  }

  private token(): string {
    return readToken(this.config.tokenFile, (message) => new ToodoUnreadable(message));
  }

  /** One read command; `allow404` returns undefined on 404 instead of throwing. */
  private async call(command: "list_tasks" | "get_task", args: unknown, allow404 = false): Promise<unknown> {
    const url = `${this.config.url.replace(/\/+$/, "")}/api/rpc/${command}`;
    const token = this.token();
    let response: Response;
    let text: string;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (e) {
      throw new ToodoUnreadable(`toodo-server ${command} at ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (allow404 && response.status === 404) return undefined;
    if (response.status !== 200) throw new ToodoUnreadable(`toodo-server ${command} answered HTTP ${response.status}${response.status === 401 ? " (the token was refused)" : ""}`, response.status);
    try { return JSON.parse(text) as unknown; } catch { throw new ToodoUnreadable(`toodo-server ${command} answered non-JSON`); }
  }

  /** The tasks with these ids that toodo still has (archived or deleted ones are absent), in batches of TOODO_MAX_IDS. */
  async tasksByIds(ids: readonly number[]): Promise<ToodoTask[]> {
    const unique = [...new Set(ids)];
    const out: ToodoTask[] = [];
    for (let i = 0; i < unique.length; i += TOODO_MAX_IDS) {
      const reply = await this.call("list_tasks", { filter: { ids: unique.slice(i, i + TOODO_MAX_IDS) } });
      if (!Array.isArray(reply)) throw new ToodoUnreadable("toodo-server list_tasks did not answer a task list");
      out.push(...reply.map(toTask));
    }
    return out;
  }

  /**
   * The planned tasks marked for autopilot, of every workspace. The RPC task filter has no autopilot key, so this reads
   * every planned task and keeps the marked ones.
   */
  async flaggedTasks(): Promise<ToodoTask[]> {
    const reply = await this.call("list_tasks", { filter: { statuses: ["planned"] } });
    if (!Array.isArray(reply)) throw new ToodoUnreadable("toodo-server list_tasks did not answer a task list");
    return reply.map(toTask).filter((t) => t.autopilot);
  }

  /** One task, or undefined when toodo-server has no such task (missing or archived). */
  async task(id: number): Promise<ToodoTask | undefined> {
    const reply = await this.call("get_task", { id }, true);
    return reply === undefined ? undefined : toTask(reply);
  }
}

/** A refused, unanswered or unconfirmed toodo write; `code` is toodo's error code when the server gave one (e.g. `taskNotFound`). */
export class ToodoWriteFailed extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "ToodoWriteFailed";
  }
}

/** The fields of a task that ToodoWriter's writes change, as `get_task` shows them. */
export type ToodoTaskRecord = {
  readonly id: number;
  readonly status: ToodoTask["status"];
  readonly resolution: ToodoTask["resolution"];
  readonly refs: readonly string[];
  /** Oldest first; `kind` is `progress`, `decision` or `blocker`. */
  readonly notes: readonly { readonly kind: string; readonly body: string }[];
  /** `state` is `pending`, `met` or `failed`. */
  readonly criteria: readonly { readonly id: number; readonly kind: string; readonly state: string; readonly evidence: string | null }[];
};

/** A confirmed write: `wrote` is false when the task already was in the wanted state and nothing was sent. */
export type ToodoWrite = { readonly wrote: boolean; readonly task: ToodoTaskRecord };

const toTaskRecord = (raw: unknown): ToodoTaskRecord => {
  const bad = (what: string): never => { throw new ToodoWriteFailed(`toodo-server get_task returned a task with ${what}`); };
  if (!isRecord(raw) || !isId(raw.id)) return bad("no id");
  const id = raw.id;
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) return bad(`status ${JSON.stringify(raw.status)} (#${id})`);
  const resolution = raw.resolution ?? null;
  if (resolution !== null && (typeof resolution !== "string" || !RESOLUTIONS.has(resolution))) return bad(`resolution ${JSON.stringify(resolution)} (#${id})`);
  const refs = raw.refs ?? [];
  if (!Array.isArray(refs) || !refs.every((r) => typeof r === "string")) return bad(`unreadable refs (#${id})`);
  const notes = raw.notes ?? [];
  if (!Array.isArray(notes) || !notes.every((n) => isRecord(n) && typeof n.kind === "string" && typeof n.body === "string")) return bad(`unreadable notes (#${id})`);
  const criteria = raw.criteria ?? [];
  if (!Array.isArray(criteria) || !criteria.every((c) => isRecord(c) && isId(c.id) && typeof c.kind === "string" && typeof c.state === "string"
    && (c.evidence === undefined || c.evidence === null || typeof c.evidence === "string"))) return bad(`unreadable criteria (#${id})`);
  return {
    id, status: raw.status as ToodoTask["status"], resolution: resolution as ToodoTask["resolution"], refs: refs as string[],
    notes: (notes as Record<string, unknown>[]).map((n) => ({ kind: n.kind as string, body: n.body as string })),
    criteria: (criteria as Record<string, unknown>[]).map((c) => ({
      id: c.id as number, kind: c.kind as string, state: c.state as string, evidence: (c.evidence as string | null | undefined) ?? null,
    })),
  };
};

const hasRefs = (task: ToodoTaskRecord, refs: readonly string[]): boolean => refs.every((r) => task.refs.includes(r));

/**
 * Writes to a toodo task over toodo-server's MCP endpoint: `POST <url>/mcp` with one stateless JSON-RPC `tools/call`,
 * and the bearer token read from `tokenFile`. That is the server's `mcp-token`: `/mcp` refuses the web token, and `/api`
 * refuses the MCP token. The `/api/rpc` commands have no progress note or blocker, so all writes go through MCP.
 *
 * Every write is idempotent and confirmed. It reads the task with `get_task` first, and when the task already is in the
 * wanted state it sends nothing (`wrote: false`). Otherwise it calls the tool and reads the task back, so a write whose
 * reply was lost (network error, timeout, a 5xx) still succeeds once the read-back shows it. Any other outcome throws
 * ToodoWriteFailed: a refused write (with toodo's message and code), a read-back that does not show the write, or a
 * token, read or reply that cannot be used. Notes count as written when the task has a note of the same kind and text.
 */
export class ToodoWriter {
  private readonly fetch: ToodoFetch;
  private readonly timeoutMs: number;
  private requestId = 0;

  constructor(private readonly config: ToodoClientConfig, deps: { readonly fetch?: ToodoFetch; readonly timeoutMs?: number } = {}) {
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = deps.timeoutMs ?? TOODO_TIMEOUT_MS;
  }

  /** One tool call; its result parsed from the JSON text toodo answers with. */
  private async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const url = `${this.config.url.replace(/\/+$/, "")}/mcp`;
    const token = readToken(this.config.tokenFile, (message) => new ToodoWriteFailed(message));
    let response: Response;
    let text: string;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method: "tools/call", params: { name, arguments: args } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (e) {
      throw new ToodoWriteFailed(`toodo-server ${name} at ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (response.status !== 200) throw new ToodoWriteFailed(`toodo-server ${name} answered HTTP ${response.status}${response.status === 401 ? " (the token was refused)" : ""}`);
    let reply: unknown;
    try { reply = JSON.parse(text); } catch { throw new ToodoWriteFailed(`toodo-server ${name} answered non-JSON`); }
    if (!isRecord(reply)) throw new ToodoWriteFailed(`toodo-server ${name} answered no JSON-RPC reply`);
    if (isRecord(reply.error)) throw new ToodoWriteFailed(`toodo-server ${name} failed: ${String(reply.error.message)}`);
    const result = reply.result;
    const content = isRecord(result) && Array.isArray(result.content) ? result.content[0] : undefined;
    const body = isRecord(content) && typeof content.text === "string" ? content.text : undefined;
    if (!isRecord(result) || body === undefined) throw new ToodoWriteFailed(`toodo-server ${name} answered no tool result`);
    if (result.isError === true) {
      const error = isRecord(result.structuredContent) && isRecord(result.structuredContent.error) ? result.structuredContent.error : undefined;
      throw new ToodoWriteFailed(`toodo-server refused ${name}: ${body}`, typeof error?.code === "string" ? error.code : undefined);
    }
    try { return JSON.parse(body) as unknown; } catch { throw new ToodoWriteFailed(`toodo-server ${name} answered a result that is not JSON`); }
  }

  /** The task as toodo has it now. */
  async read(id: number): Promise<ToodoTaskRecord> {
    return toTaskRecord(await this.tool("get_task", { id }));
  }

  /** Calls `name` unless `written` already holds, then reads the task back until `written` is shown or the write fails. */
  private async write(id: number, written: (task: ToodoTaskRecord) => boolean, name: string, args: Record<string, unknown>): Promise<ToodoWrite> {
    const before = await this.read(id);
    if (written(before)) return { wrote: false, task: before };
    let failure: ToodoWriteFailed | undefined;
    try { await this.tool(name, args); } catch (e) {
      if (!(e instanceof ToodoWriteFailed)) throw e;
      failure = e;
    }
    const after = await this.read(id).catch((e: unknown) => { throw failure ?? e; });
    if (written(after)) return { wrote: true, task: after };
    throw failure ?? new ToodoWriteFailed(`toodo-server ${name} on #${id} answered, but reading the task back does not show the write`);
  }

  /** Starts the task (`in_progress`) and appends `refs`; already written when it is in progress with every ref. */
  startTask(id: number, opts: { readonly reason?: string; readonly refs?: readonly string[] } = {}): Promise<ToodoWrite> {
    const refs = (opts.refs ?? []).map((r) => r.trim());
    return this.write(id, (t) => t.status === "in_progress" && hasRefs(t, refs), "start_task", {
      id, refs, ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    });
  }

  /** Adds a progress (or decision) note in Markdown. */
  addProgressNote(taskId: number, note: string, kind: "progress" | "decision" = "progress"): Promise<ToodoWrite> {
    const body = note.trim();
    return this.write(taskId, (t) => t.notes.some((n) => n.kind === kind && n.body === body), "add_progress_note", { task_id: taskId, note: body, kind });
  }

  /** Records what blocks the task (a `blocker` note; the status stays). */
  reportBlocker(taskId: number, note: string): Promise<ToodoWrite> {
    const body = note.trim();
    return this.write(taskId, (t) => t.notes.some((n) => n.kind === "blocker" && n.body === body), "report_blocker", { task_id: taskId, note: body });
  }

  /** Checks a manual criterion with its evidence (`met` false unchecks it); already written when it shows that state and evidence. */
  checkCriterion(taskId: number, criterionId: number, evidence: string, met = true): Promise<ToodoWrite> {
    const shown = evidence.trim();
    return this.write(taskId, (t) => {
      const c = t.criteria.find((x) => x.id === criterionId);
      return c !== undefined && (met ? c.state === "met" && c.evidence === shown : c.state === "pending");
    }, "check_criterion", { task_id: taskId, criterion_id: criterionId, met, evidence: shown });
  }

  /** Completes the task (`done`, `completed`) and appends `refs`; toodo refuses while a criterion is not met. */
  completeTask(id: number, opts: { readonly note?: string; readonly refs?: readonly string[] } = {}): Promise<ToodoWrite> {
    const refs = (opts.refs ?? []).map((r) => r.trim());
    return this.write(id, (t) => t.status === "done" && t.resolution === "completed" && hasRefs(t, refs), "complete_task", {
      id, refs, ...(opts.note === undefined ? {} : { note: opts.note }),
    });
  }
}
