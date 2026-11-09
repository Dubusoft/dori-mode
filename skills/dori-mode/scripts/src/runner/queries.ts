import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { type HostSample, sampleHost } from "../host-guard.ts";
import { listPanes, type Pane, readScreen } from "../panes.ts";
import type { Clock, Runner } from "../run.ts";
import { procTable, resolveSession } from "../session-id.ts";
import { checkDone, type SignalIo } from "../signals.ts";
import { gitFacts } from "./lane-git.ts";
import { checkQuery, type RunnerPolicy } from "./policy.ts";
import type {
  AnySupervisorControl, JsonValue, LaneInspection, MachineObservation, ProcessInfo, QueryBodies, QueryResults, QueryType, RunnerControlBodies,
} from "./protocol.ts";
import { laneStatus } from "./serve.ts";
import { checkFileBody, LaneFileError } from "./lane-files.ts";
import type { LaneOutputFiles } from "./protocol.ts";

/**
 * The runner's answers to the supervisor's read-only `q.*` queries (design 0.3, 2.4): control frames that are never
 * queued, journaled or recorded. Each query is answered by exactly one `q.result` with its `qid`: `ok` with the
 * `QueryResults[type]` value, or `ok: false` with the failure detail. Everything is read on the runner's own host.
 */

/** The most screen lines one `q.screen` returns, so a `q.result` stays inside one frame. */
export const SCREEN_MAX_LINES = 400;

/** What the runner knows of one of its lanes (its `lanes.json` record). */
export type QueryLane = { readonly pane?: string; readonly cwd?: string };

export type QueryDeps = {
  readonly files?: (key: string) => LaneOutputFiles | undefined;
  readonly currentPane?: (key: string, panes: readonly Pane[]) => Promise<Pane | undefined>;
  readonly run: Runner;
  readonly clock: Clock;
  /** The runner's own record of lane `key`, if it owns one. */
  readonly lane: (key: string) => QueryLane | undefined;
  /** The host's OS label as `guard.sample.os` carries it (default: node's `platform()`). */
  readonly os?: string;
  /** The filesystem the disk reading samples (default `/`). */
  readonly dataPath?: string;
  readonly readMemInfo?: (path: string) => Promise<string>;
  readonly exists?: (path: string) => boolean;
  /** Extra signal I/O for Done checks (tests inject `http`/`home`); `cwd` is always the inspection's. */
  readonly signalIo?: Omit<SignalIo, "cwd">;
  /** The agent session directory a `session` inspection reads when the query names none. */
  readonly sessionsDir?: string;
  /** The guard thresholds runner-config.json sets (policy.ts `guard`), reported by `q.machine.observe`. */
  readonly guard?: RunnerPolicy["guard"];
};

/** Default agent session directory on a host (omo's own). */
export const defaultSessionsDir = (): string => join(homedir(), ".omo", "agent", "sessions");

type Body<T extends QueryType> = Omit<QueryBodies[T], "qid">;

/** `q.panes`: herdr's pane list of this host. */
export const queryPanes = async (deps: Pick<QueryDeps, "run">): Promise<QueryResults["q.panes"]> => ({ panes: await listPanes(deps.run) });

/** `q.screen`: the visible screen, or the last `lines` (at most SCREEN_MAX_LINES) of scrollback and screen. */
export const queryScreen = async (deps: Pick<QueryDeps, "run">, body: Body<"q.screen">): Promise<QueryResults["q.screen"]> => {
  const lines = Math.min(Math.max(1, body.lines), SCREEN_MAX_LINES);
  return { text: await readScreen(deps.run, body.pane, body.source === "recent" ? lines : undefined) };
};

/** herdr's process-info of `pane`: the info, or the error text of a failed or unreadable answer. */
export const queryProcess = async (deps: Pick<QueryDeps, "run">, body: Body<"q.process">): Promise<QueryResults["q.process"]> => {
  const r = await deps.run(["herdr", "pane", "process-info", "--pane", body.pane]);
  if (r.code !== 0) return { error: (r.err || r.out).trim() || `herdr exited ${r.code}` };
  try {
    const info = (JSON.parse(r.out) as { result?: { process_info?: ProcessInfo } }).result?.process_info;
    return info ? { info } : { error: "herdr process-info: no process_info in the answer" };
  } catch {
    return { error: "herdr process-info: unreadable answer" };
  }
};

/** `q.stat`: whether each path exists on this host. */
export const queryStat = (deps: Pick<QueryDeps, "exists">, body: Body<"q.stat">): QueryResults["q.stat"] => {
  const exists = deps.exists ?? existsSync;
  return { exists: body.paths.map((p) => exists(p)) };
};

/**
 * `q.lane.inspect`: lane `key`'s status from herdr's pane list (`laneStatus`), its pane row and process-info when
 * listed, its cwd (the query's `cwd`, else the record's) and whether it exists, and on request:
 * - `git`: toplevel/origin/branch of the cwd, the lane's worktrees in the cwd and `roots` with dirty/ahead, and the
 *   `branches` asked;
 * - `done`: the Done checks (signals.ts `checkDone`) run in the cwd, or in `doneCwd` when the cwd is gone or unset
 *   (`fallback` says the cwd was gone);
 * - `session`: session-id.ts `resolveSession` of the pane on this host.
 * A lane the runner holds no record of (or no pane for) reads `missing` without listing panes.
 */
export const laneInspect = async (deps: QueryDeps, body: Body<"q.lane.inspect">): Promise<LaneInspection> => {
  const exists = deps.exists ?? existsSync;
  const record = deps.lane(body.key);
  const paneId = record?.pane;
  let pane: Pane | undefined;
  if (paneId) {
    const panes = await listPanes(deps.run);
    pane = deps.currentPane ? await deps.currentPane(body.key, panes) : panes.find((p) => p.pane_id === paneId);
  }
  const process = pane ? (await queryProcess(deps, { pane: pane.pane_id })).info : undefined;
  const cwd = body.cwd ?? record?.cwd ?? "";
  const cwdExists = cwd !== "" && exists(cwd);
  const git = body.git
    ? await gitFacts(deps.run, { key: body.key, ...(cwdExists ? { cwd } : {}), roots: body.roots ?? [], branches: body.branches ?? [], exists })
    : undefined;
  let done: LaneInspection["done"];
  if (body.done !== undefined) {
    const where = cwdExists ? cwd : body.doneCwd ?? cwd;
    const checks = await checkDone(body.done, deps.run, { ...deps.signalIo, ...(where ? { cwd: where } : {}) });
    done = { cwd: where, fallback: !cwdExists && cwd !== "" && body.doneCwd !== undefined, checks };
  }
  let session: LaneInspection["session"];
  if (body.session) {
    if (!pane) session = { id: "", via: "none" };
    else {
      const hit = await resolveSession(pane.pane_id, cwd, await procTable(deps.run), { run: deps.run, sessionsDir: body.sessionsDir ?? deps.sessionsDir ?? defaultSessionsDir() });
      session = { id: hit.id, via: hit.via };
    }
  }
  return {
    status: laneStatus(pane), ...(pane ? { pane } : {}), ...(process ? { process } : {}), cwd, cwdExists,
    ...(git ? { git } : {}), ...(done ? { done } : {}), ...(session ? { session } : {}),
  };
};

/**
 * `q.machine.observe`: this host's guard sample (its `panes` filled from the pane list, -1 when unreadable), pane list,
 * and the guard thresholds its runner-config.json sets (`guard`, only when it sets any).
 */
export const observeMachine = async (deps: QueryDeps): Promise<MachineObservation> => {
  let panes: Pane[] | undefined;
  try { panes = await listPanes(deps.run); } catch { panes = undefined; }
  const listed = panes;
  const sample: HostSample = await sampleHost(deps.run, deps.dataPath ?? "/", async () => listed?.length ?? -1, deps.readMemInfo);
  const guard = deps.guard && Object.keys(deps.guard).length > 0 ? { guard: deps.guard } : {};
  return { os: deps.os ?? platform(), sampledAt: deps.clock.now(), sample, panes: listed ?? [], ...guard };
};

/** Runs one checked query and resolves to its result. */
export const answerQuery = async (deps: QueryDeps, query: AnySupervisorControl): Promise<JsonValue> => {
  const { qid: _qid, ...body } = query.body as { readonly qid: string } & Record<string, unknown>;
  const result: QueryResults[QueryType] = await (async () => {
    switch (query.type) {
      case "q.lane.files": {
        if (!deps.files) throw new Error("RUNNER_QUERY_UNSUPPORTED q.lane.files");
        const files = deps.files((body as Body<"q.lane.files">).key);
        return files ? { files } : {};
      }
      case "q.panes": return queryPanes(deps);
      case "q.screen": return queryScreen(deps, body as Body<"q.screen">);
      case "q.process": return queryProcess(deps, body as Body<"q.process">);
      case "q.stat": return queryStat(deps, body as Body<"q.stat">);
      case "q.lane.inspect": return laneInspect(deps, body as Body<"q.lane.inspect">);
      case "q.machine.observe": return observeMachine(deps);
      default: throw new Error(`RUNNER_QUERY_UNSUPPORTED ${query.type}`);
    }
  })();
  return result as unknown as JsonValue;
};

export type QueryDispatchDeps = QueryDeps & {
  /** `guard` (runner-config.json's thresholds) is what `q.machine.observe` reports. */
  readonly policy: Pick<RunnerPolicy, "jobs" | "guard">;
  /** Sends the `q.result` control frame (client.ts `control("q.result", ...)`). */
  readonly reply: (body: RunnerControlBodies["q.result"]) => void;
  readonly log: (line: string) => void;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The runner's query dispatcher, for client.ts `onQuery`: each `q.*` frame is checked (policy.ts `checkQuery`: schema,
 * and `jobs: "deny"` refuses a `q.lane.inspect` with `done`), answered, and replied to with one `q.result`. A refusal
 * is `ok: false` with `RUNNER_CMD_REJECTED <rule>`, a failed read `ok: false` with its error. A frame without a usable
 * `qid` cannot be answered and is only logged; a non-query control frame is ignored.
 */
export const queryDispatcher = (deps: QueryDispatchDeps) => (frame: unknown): void => {
  const type = isRecord(frame) && typeof frame.type === "string" ? frame.type : "?";
  if (!type.startsWith("q.")) return;
  const qid = isRecord(frame) && isRecord(frame.body) && typeof frame.body.qid === "string" ? frame.body.qid : undefined;
  if (!qid) { deps.log(`RUNNER_QUERY_DROPPED type=${type} no qid to answer`); return; }
  const send = (body: RunnerControlBodies["q.result"]): void => {
    try { deps.reply(body); } catch (e) { deps.log(`RUNNER_QUERY_REPLY_FAILED qid=${qid} ${e instanceof Error ? e.message : String(e)}`); }
  };
  const checked = checkQuery({ agents: {}, allowedRoots: [], sandbox: "optional", ...deps.policy }, frame);
  if (!checked.ok) {
    deps.log(`RUNNER_QUERY_REJECTED qid=${qid} type=${type} ${checked.rule}`);
    send({ qid, ok: false, detail: `RUNNER_CMD_REJECTED ${checked.rule}` });
    return;
  }
  void answerQuery({ ...deps, guard: deps.guard ?? deps.policy.guard }, checked.query).then(
    (result) => {
      const response = { qid, ok: true, detail: "", result };
      if (checked.query.type === "q.lane.files") {
        try { checkFileBody(checked.query.body.key, response); }
        catch (error) { send({ qid, ok: false, detail: (error as Error).message }); return; }
      }
      send(response);
    },
    (error: unknown) => {
      const detail = error instanceof LaneFileError ? error.message : `RUNNER_QUERY_FAILED ${type} ${error instanceof Error ? error.message : String(error)}`.slice(0, 400);
      deps.log(`${detail} qid=${qid}`);
      send({ qid, ok: false, detail });
    },
  );
};
