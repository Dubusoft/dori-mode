import { readFileSync } from "node:fs";

import type { ToodoTask } from "./autopilot.ts";

/**
 * The toodo-server clients. ToodoClient reads for autopilot: `list_tasks`, `get_task` and `list_guidelines` over `POST <url>/api/rpc/<command>` with
 * the bearer token read from `tokenFile` (the same url and token file as the toodo event stream). A read that gets no
 * answer (network error, timeout) or a 429 or 5xx is sent again after TOODO_RETRY_DELAY_MS, TOODO_READ_ATTEMPTS times in
 * all: every command is a read, so repeating one is safe. Every failure left (token file missing or empty, the last
 * attempt failing, another non-200, a reply that is not a task list) throws ToodoUnreadable, so a caller maps any of
 * them to `toodo-unreadable`. A missing task on `get_task` (404) is undefined, not an error. In a task list, a task not
 * marked for autopilot whose shape the predicate cannot read is left out with a TOODO_TASK_SKIPPED log line instead (it
 * reads as absent, and an absent prerequisite is not satisfied); a marked one still throws.
 * ToodoWriter (below) writes to a task over the MCP endpoint and reads every write back.
 */

export const TOODO_TIMEOUT_MS = 10_000;
/** Kept small: the autopilot executor reads under the launch lock, so every retry holds it longer. */
export const TOODO_READ_ATTEMPTS = 2;
export const TOODO_RETRY_DELAY_MS = 500;
/** list_tasks takes at most this many ids per call. */
export const TOODO_MAX_IDS = 500;

export type ToodoClientConfig = { readonly url: string; readonly tokenFile: string };
export type ToodoFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The read commands of toodo-server's `/api/rpc` that ToodoClient sends (all in toodo's read-only device scope). */
export type ToodoReadCommand = "list_tasks" | "get_task" | "list_guidelines" | "get_workspace" | "list_task_relations";

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
/** The progress note toodo-server records with `wait_task` (`Waiting until <time>`, or `Wait changed: waiting until <time>`). */
const WAIT_SET_NOTE = /^(Waiting until |Wait changed: waiting until )/;

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
  const milestones = raw.milestones ?? null;
  if (milestones !== null && !isRecord(milestones)) return bad(`unreadable milestones (#${id})`);
  const pausedAt = milestones?.pausedAt ?? null;
  if (pausedAt !== null && typeof pausedAt !== "number") return bad(`unreadable milestones.pausedAt (#${id})`);
  const notes = raw.notes ?? [];
  if (!Array.isArray(notes) || !notes.every((n) => isRecord(n) && typeof n.kind === "string" && typeof n.body === "string" && typeof n.at === "number")) return bad(`unreadable notes (#${id})`);
  const waitSet = (notes as { kind: string; body: string; at: number }[]).filter((n) => n.kind === "progress" && WAIT_SET_NOTE.test(n.body)).map((n) => n.at);
  return {
    id, workspaceId: raw.workspaceId, title: raw.title, description: raw.description, status: raw.status as ToodoTask["status"],
    resolution: resolution as ToodoTask["resolution"], dependsOn: dependsOn as number[], refs: refs as string[],
    criteria: (criteria as Record<string, unknown>[]).map((c) => ({
      text: c.text as string, kind: c.kind as string, ...(typeof c.target === "string" ? { target: c.target } : {}),
    })),
    wait: wait === null ? null : { until: (wait as { until: number }).until, status: (wait as { status: string }).status },
    autopilot, dueDate, pausedAt, waitSetAt: waitSet.length ? Math.max(...waitSet) : null,
  };
};

/** The tasks of a `list_tasks` reply; one that toTask cannot read is skipped and logged unless it is (or may be) marked for autopilot. */
const toTasks = (reply: readonly unknown[], log: (line: string) => void): ToodoTask[] => {
  const out: ToodoTask[] = [];
  for (const raw of reply) {
    try { out.push(toTask(raw)); } catch (e) {
      if (!(e instanceof ToodoUnreadable) || !isRecord(raw) || (raw.autopilot ?? false) !== false) throw e;
      log(`TOODO_TASK_SKIPPED ${isId(raw.id) ? `#${raw.id}` : "(no id)"} not marked for autopilot: ${e.message}`);
    }
  }
  return out;
};

/** A workspace guideline as `list_guidelines` returns it: a `rule` agents follow or a `memory` recorded for the workspace. */
export type ToodoGuideline = {
  readonly id: number;
  readonly workspaceId: number;
  readonly kind: "rule" | "memory";
  /** Markdown. */
  readonly body: string;
  /** Seconds since the epoch. */
  readonly updatedAt: number;
};

const toGuideline = (raw: unknown): ToodoGuideline => {
  const bad = (what: string): never => { throw new ToodoUnreadable(`toodo-server returned a guideline with ${what}`); };
  if (!isRecord(raw) || !isId(raw.id)) return bad("no id");
  if (!isId(raw.workspaceId)) return bad(`no workspaceId (${raw.id})`);
  if (raw.kind !== "rule" && raw.kind !== "memory") return bad(`kind ${JSON.stringify(raw.kind)} (${raw.id})`);
  if (typeof raw.body !== "string") return bad(`no body (${raw.id})`);
  if (typeof raw.updatedAt !== "number") return bad(`no updatedAt (${raw.id})`);
  return { id: raw.id, workspaceId: raw.workspaceId, kind: raw.kind, body: raw.body, updatedAt: raw.updatedAt };
};

export class ToodoClient {
  private readonly fetch: ToodoFetch;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  /** `log` receives the TOODO_TASK_SKIPPED lines (default: stderr). */
  constructor(
    private readonly config: ToodoClientConfig,
    deps: {
      readonly fetch?: ToodoFetch; readonly timeoutMs?: number; readonly log?: (line: string) => void;
      readonly sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = deps.timeoutMs ?? TOODO_TIMEOUT_MS;
    this.log = deps.log ?? ((line) => { console.error(line); });
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private token(): string {
    return readToken(this.config.tokenFile, (message) => new ToodoUnreadable(message));
  }

  /** One read command; `allow404` returns undefined on 404 instead of throwing. */
  private async call(command: ToodoReadCommand, args: unknown, allow404 = false): Promise<unknown> {
    const url = `${this.config.url.replace(/\/+$/, "")}/api/rpc/${command}`;
    const token = this.token();
    for (let attempt = 1; ; attempt++) {
      const last = attempt === TOODO_READ_ATTEMPTS;
      const tried = attempt > 1 ? ` (tried ${attempt} times)` : "";
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
        if (!last) { await this.sleep(TOODO_RETRY_DELAY_MS); continue; }
        throw new ToodoUnreadable(`toodo-server ${command} at ${url} failed${tried}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (allow404 && response.status === 404) return undefined;
      if (!last && (response.status === 429 || response.status >= 500)) { await this.sleep(TOODO_RETRY_DELAY_MS); continue; }
      if (response.status !== 200) throw new ToodoUnreadable(`toodo-server ${command} answered HTTP ${response.status}${response.status === 401 ? " (the token was refused)" : ""}${tried}`, response.status);
      try { return JSON.parse(text) as unknown; } catch { throw new ToodoUnreadable(`toodo-server ${command} answered non-JSON`); }
    }
  }

  /**
   * One read command's reply as toodo-server sends it, unparsed (undefined on 404): what a lane's `dori toodo` shows
   * (toodo-lane-read.ts). Only read commands are typed, so a lane's request can never reach a write.
   */
  raw(command: ToodoReadCommand, args: unknown): Promise<unknown> {
    return this.call(command, args, true);
  }

  /** The tasks with these ids that toodo still has (archived or deleted ones are absent), in batches of TOODO_MAX_IDS. */
  async tasksByIds(ids: readonly number[]): Promise<ToodoTask[]> {
    const unique = [...new Set(ids)];
    const out: ToodoTask[] = [];
    for (let i = 0; i < unique.length; i += TOODO_MAX_IDS) {
      const reply = await this.call("list_tasks", { filter: { ids: unique.slice(i, i + TOODO_MAX_IDS) } });
      if (!Array.isArray(reply)) throw new ToodoUnreadable("toodo-server list_tasks did not answer a task list");
      out.push(...toTasks(reply, this.log));
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
    return toTasks(reply, this.log).filter((t) => t.autopilot);
  }

  /** One task, or undefined when toodo-server has no such task (missing or archived). */
  async task(id: number): Promise<ToodoTask | undefined> {
    const reply = await this.call("get_task", { id }, true);
    return reply === undefined ? undefined : toTask(reply);
  }

  /** The guidelines (rules and memories) of one workspace, for the autopilot contract's snapshot. */
  async guidelines(workspaceId: number): Promise<ToodoGuideline[]> {
    const reply = await this.call("list_guidelines", { workspaceId });
    if (!Array.isArray(reply)) throw new ToodoUnreadable("toodo-server list_guidelines did not answer a guideline list");
    return reply.map(toGuideline);
  }

  /**
   * A workspace's optional `repository` (free text toodo does not interpret), the default repo of its autopilot tasks;
   * null when it has none or toodo-server has no such workspace.
   */
  async workspaceRepository(workspaceId: number): Promise<string | null> {
    const reply = await this.call("get_workspace", { id: workspaceId }, true);
    if (reply === undefined) return null;
    if (!isRecord(reply) || (reply.repository != null && typeof reply.repository !== "string")) throw new ToodoUnreadable(`toodo-server get_workspace returned workspace ${workspaceId} with an unreadable repository`);
    return reply.repository ?? null;
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

/** The task of a `get_task` reply: toodo-server's MCP wraps it with its links (`{task, dependsOn, dependents, related, guidelines, ...}`); a bare task is read as is. */
const toTaskRecord = (reply: unknown): ToodoTaskRecord => {
  const raw = isRecord(reply) && isRecord(reply.task) ? reply.task : reply;
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

  /** Concludes the task not adopted (`done`, `not_adopted`) with its required note; already written when it reads so. */
  concludeNotAdopted(id: number, note: string): Promise<ToodoWrite> {
    return this.write(id, (t) => t.status === "done" && t.resolution === "not_adopted", "conclude_task", { id, note: note.trim(), outcome: "not_adopted" });
  }
}
