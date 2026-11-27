import { redactSecrets } from "./redact.ts";
import type { ToodoReadCommand } from "./toodo-client.ts";

/**
 * A lane's read-only view of Toodo (`dori toodo get [<id>] | search <query> | guidelines` in a lane). It runs on the
 * supervisor host only, where toodo-server's token is: the local runner calls it for its lanes and the supervisor for
 * a remote runner's sealed `toodo.read`. A lane never holds a Toodo token, and only the read commands below reach
 * toodo-server; Toodo writes stay with `dori report` and the supervisor.
 *
 * Scope: a lane reads through its own task, the task of its autopilot key `ap-<task>-<n>`. It may read that task, the
 * tasks it depends on or is related to (in any workspace), every task of the same workspace (`get` and `search`), and
 * that workspace's guidelines. Any other task is TOODO_LANE_OUT_OF_SCOPE, so the other workspaces (personal ones too)
 * stay closed, and a lane without a task (not an autopilot key) is TOODO_LANE_NO_TASK. A linked task outside that scope
 * shows only its id. The answer is JSON text through redactSecrets, cut at LANE_TOODO_OUTPUT_CAP bytes.
 */

export type LaneToodoRequest =
  | { readonly op: "get"; readonly id?: number }
  | { readonly op: "search"; readonly query: string }
  | { readonly op: "guidelines" };

export type LaneToodoResult =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export type LaneToodoReader = (key: string, request: LaneToodoRequest) => Promise<LaneToodoResult>;

/** What the reader needs of ToodoClient: one read command's raw reply, undefined on 404. */
export type ToodoRawReader = { raw(command: ToodoReadCommand, args: unknown): Promise<unknown> };

export const LANE_TOODO_QUERY_MAX = 200;
/** The byte cap on an answer; a sealed answer stays far under the frame limit (MAX_FRAME_BYTES). */
export const LANE_TOODO_OUTPUT_CAP = 256 * 1024;
export const LANE_TOODO_SEARCH_LIMIT = 50;
/** list_tasks pages (500 tasks each) a search reads of the workspace, newest first. */
const SEARCH_PAGES = 10;
const PAGE = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * The request a lane socket line or a `toodo.read` body carries, checked again on the supervisor side (a runner
 * passes on what its lane sent); undefined when it is not one of the three reads.
 */
export const laneToodoRequest = (op: unknown, id: unknown, query: unknown): LaneToodoRequest | undefined => {
  if (op === "guidelines" && id === undefined && query === undefined) return { op };
  if (op === "get" && query === undefined && (id === undefined || isId(id))) return id === undefined ? { op } : { op, id };
  if (op === "search" && id === undefined && typeof query === "string" && query.trim() && query.length <= LANE_TOODO_QUERY_MAX) return { op, query: query.trim() };
  return undefined;
};

/** The task id of an autopilot lane key `ap-<task>-<attempt>`; undefined for any other key. */
export const laneTaskId = (key: string): number | undefined => {
  const m = /^ap-(\d+)-\d+$/.exec(key);
  const id = m ? Number(m[1]) : NaN;
  return isId(id) ? id : undefined;
};

type Task = Record<string, unknown> & { readonly id: number; readonly workspaceId: number; readonly dependsOn: readonly number[] };

class Unreadable extends Error {}

const asTask = (raw: unknown, what: string): Task => {
  if (!isRecord(raw) || !isId(raw.id) || !isId(raw.workspaceId)) throw new Unreadable(`toodo-server returned ${what} without id or workspaceId`);
  const dependsOn = raw.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || !dependsOn.every(isId)) throw new Unreadable(`toodo-server returned task #${raw.id} with unreadable dependsOn`);
  return { ...raw, id: raw.id, workspaceId: raw.workspaceId, dependsOn };
};

const asTasks = (raw: unknown): Task[] => {
  if (!Array.isArray(raw)) throw new Unreadable("toodo-server list_tasks did not answer a task list");
  return raw.map((t) => asTask(t, "a task"));
};

/** The ids related to `id` in a `list_task_relations` reply (links go both ways). */
const relatedIds = (relations: unknown, id: number): number[] => {
  if (!Array.isArray(relations)) throw new Unreadable("toodo-server list_task_relations did not answer a relation list");
  const out = new Set<number>();
  for (const r of relations) {
    if (!isRecord(r) || !isId(r.taskId) || !isId(r.relatedId)) throw new Unreadable("toodo-server returned an unreadable task relation");
    if (r.taskId === id) out.add(r.relatedId);
    if (r.relatedId === id) out.add(r.taskId);
  }
  return [...out].sort((a, b) => a - b);
};

const summary = (t: Task) => ({ id: t.id, workspaceId: t.workspaceId, title: t.title, status: t.status, resolution: t.resolution ?? null, dependsOn: t.dependsOn });

/** `text` cut to `cap` UTF-8 bytes (never inside a character). */
const capText = (text: string, cap: number): { text: string; truncated: boolean } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= cap) return { text, truncated: false };
  return { text: new TextDecoder().decode(bytes.subarray(0, cap)).replace(/\uFFFD$/, ""), truncated: true };
};

export const laneToodoReader = (deps: { readonly client: () => ToodoRawReader; readonly log: (line: string) => void }): LaneToodoReader => async (key, request) => {
  const refuse = (code: string, detail: string): LaneToodoResult => {
    deps.log(`TOODO_LANE_READ_DENIED lane=${key} op=${request.op} code=${code}`);
    return { ok: false, code, detail };
  };
  const ownId = laneTaskId(key);
  if (ownId === undefined) return refuse("TOODO_LANE_NO_TASK", `${key} is not an autopilot lane (ap-<task>-<n>), so it has no Toodo task to read through`);
  try {
    const api = deps.client();
    const ownRaw = await api.raw("get_task", { id: ownId });
    if (ownRaw === undefined) return refuse("TOODO_LANE_NO_TASK", `toodo has no task #${ownId} (archived or deleted)`);
    const own = asTask(ownRaw, `task #${ownId}`);
    const relations = await api.raw("list_task_relations", {});
    const ownLinks = new Set([...own.dependsOn, ...relatedIds(relations, ownId)]);
    const inScope = (t: Task): boolean => t.id === ownId || t.workspaceId === own.workspaceId || ownLinks.has(t.id);
    let value: unknown;
    if (request.op === "guidelines") {
      value = { workspaceId: own.workspaceId, guidelines: await api.raw("list_guidelines", { workspaceId: own.workspaceId }) ?? [] };
    } else if (request.op === "search") {
      const needle = request.query.toLowerCase();
      const idQuery = /^#?(\d+)$/.exec(request.query)?.[1];
      const hits: Task[] = [];
      let before: number | undefined;
      let more = false;
      for (let page = 0; page < SEARCH_PAGES && hits.length <= LANE_TOODO_SEARCH_LIMIT; page++) {
        const tasks = asTasks(await api.raw("list_tasks", { filter: { workspaceId: own.workspaceId, limit: PAGE, ...(before === undefined ? {} : { before }) } }) ?? []);
        for (const t of tasks) {
          const text = [t.title, t.description, ...(Array.isArray(t.refs) ? t.refs : [])].filter((s) => typeof s === "string").join("\n").toLowerCase();
          if ((idQuery !== undefined && t.id === Number(idQuery)) || text.includes(needle)) hits.push(t);
        }
        more = tasks.length === PAGE;
        if (!more) break;
        before = Math.min(...tasks.map((t) => t.id));
      }
      value = {
        workspaceId: own.workspaceId, query: request.query,
        tasks: hits.slice(0, LANE_TOODO_SEARCH_LIMIT).map(summary),
        more: hits.length > LANE_TOODO_SEARCH_LIMIT || more,
      };
    } else {
      const id = request.id ?? ownId;
      const raw = id === ownId ? ownRaw : await api.raw("get_task", { id });
      if (raw === undefined) return refuse("TOODO_LANE_NOT_FOUND", `toodo has no task #${id} (archived or deleted)`);
      const task = id === ownId ? own : asTask(raw, `task #${id}`);
      if (!inScope(task)) {
        return refuse("TOODO_LANE_OUT_OF_SCOPE", `#${id} is in another workspace and is neither a dependency nor a related task of #${ownId}; a lane reads its own task, the tasks it depends on or is related to, and the tasks of its own workspace`);
      }
      const related = relatedIds(relations, id);
      const linkIds = [...new Set([...task.dependsOn, ...related])];
      const linked = linkIds.length ? asTasks(await api.raw("list_tasks", { filter: { ids: linkIds } }) ?? []) : [];
      const show = (ids: readonly number[]) => ids.map((n) => {
        const t = linked.find((x) => x.id === n);
        return t && inScope(t) ? summary(t) : { id: n };
      });
      value = { task: raw, dependsOn: show(task.dependsOn), related: show(related) };
    }
    deps.log(`TOODO_LANE_READ lane=${key} op=${request.op}`);
    const { text, truncated } = capText(redactSecrets(JSON.stringify(value, null, 2)), LANE_TOODO_OUTPUT_CAP);
    return { ok: true, text, truncated };
  } catch (e) {
    return refuse("TOODO_LANE_UNREADABLE", (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300));
  }
};
