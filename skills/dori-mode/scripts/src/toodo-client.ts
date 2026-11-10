import { readFileSync } from "node:fs";

import type { ToodoTask } from "./autopilot.ts";

/**
 * A read-only toodo-server client for autopilot: `list_tasks` and `get_task` over `POST <url>/api/rpc/<command>` with
 * the bearer token read from `tokenFile` (the same url and token file as the toodo event stream). Every failure (token
 * file missing or empty, network error, timeout, non-200, a reply that is not a task list) throws ToodoUnreadable, so a
 * caller maps any of them to `toodo-unreadable`. A missing task on `get_task` (404) is undefined, not an error.
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
  return {
    id, workspaceId: raw.workspaceId, title: raw.title, description: raw.description, status: raw.status as ToodoTask["status"],
    resolution: resolution as ToodoTask["resolution"], dependsOn: dependsOn as number[], refs: refs as string[],
    criteria: (criteria as Record<string, unknown>[]).map((c) => ({
      text: c.text as string, kind: c.kind as string, ...(typeof c.target === "string" ? { target: c.target } : {}),
    })),
    wait: wait === null ? null : { until: (wait as { until: number }).until, status: (wait as { status: string }).status },
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
    let token: string;
    try { token = readFileSync(this.config.tokenFile, "utf8").trim(); } catch (e) {
      throw new ToodoUnreadable(`cannot read the token file ${this.config.tokenFile}: ${e instanceof Error && "code" in e ? String(e.code) : String(e)}`);
    }
    if (!token) throw new ToodoUnreadable(`the token file ${this.config.tokenFile} is empty`);
    return token;
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

  /** One task, or undefined when toodo-server has no such task (missing or archived). */
  async task(id: number): Promise<ToodoTask | undefined> {
    const reply = await this.call("get_task", { id }, true);
    return reply === undefined ? undefined : toTask(reply);
  }
}
