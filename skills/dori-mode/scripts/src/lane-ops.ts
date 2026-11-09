import type { Pane } from "./panes.ts";
import type { KilledProc } from "./pressure.ts";
import type { Lane, Objection } from "./registry.ts";
import type { Ran } from "./run.ts";
import type { RunnerCall } from "./runner/call.ts";
import type {
  CommandResults, DurableCommandType, JsonValue, LaneInspection, LaneStatus, MachineObservation, QueryBodies, QueryResults, QueryType,
  SupervisorCommandBodies, TurnEvidence,
} from "./runner/protocol.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import { checkLaneFilesBody, isLaneOutputFiles } from "./lane-files.ts";
import type { LaneBriefFiles, LaneOutputFiles } from "./runner/protocol.ts";

/**
 * The lane facade (design 3.3): every lane and host-pane operation the supervisor and the CLI need, each one a single
 * runner call. Reads are `q.*` queries, effects are durable commands awaited by their `cmd.result`. Supervisor modules
 * reach lanes only through this; this module reaches runners only through `RunnerCall`, and it owns the type guards
 * that turn a runner's JSON answer into `QueryResults` / `CommandResults`.
 */

export type PaneRef = { readonly machine?: string; readonly pane?: string };
export type LaneRef = Pick<Lane, "key" | "machine" | "runner" | "pane" | "tab" | "cwd" | "remoteCwd" | "mode" | "model">;
export type Delivery = "delivered" | "unconfirmed" | "failed" | "sent";
export type SendOptions = {
  readonly mode?: "verified" | "guarded"; readonly inputCheck?: boolean; readonly refuseWhileAsking?: boolean; readonly cmdId?: string;
  /** Hears why a "failed" send failed: the runner's refusal (input line busy, no prompt, ...) or why the runner could not be reached. */
  readonly onFailed?: (detail: string) => void;
};
export type InspectWant = {
  readonly git?: boolean; readonly roots?: readonly string[]; readonly branches?: readonly string[]; readonly done?: string; readonly doneCwd?: string;
  readonly process?: boolean; readonly session?: boolean; readonly sessionsDir?: string; readonly cwd?: string;
};
export type StartInput = {
  readonly files?: LaneBriefFiles;
  readonly key: string; readonly machine?: string; readonly briefText: string; readonly done: string; readonly thread: string; readonly cwd: string;
  readonly sandbox: boolean; readonly mode: string; readonly model: string; readonly keywords: string; readonly session?: string;
  readonly target?: { pane?: string; workspace?: string }; readonly heavySlots?: number; readonly heavyMaxLoad?: number; readonly cmdId?: string;
  /** The herdr workspace a new tab opens in (the supervisor-managed lanes workspace of a local lane). */
  readonly tabWorkspace?: string;
};
export type AdoptInput = { readonly key: string; readonly machine?: string; readonly pane: string; readonly cwd?: string; readonly mode: string; readonly model: string };
export type GitOp =
  | { readonly op: "worktree-remove"; readonly root: string; readonly path: string }
  // `sha`: delete only while the branch is at that commit (the runner's compare-and-delete); absent: unconditional.
  | { readonly op: "branch-delete"; readonly root: string; readonly branch: string; readonly sha?: string }
  | { readonly op: "remote-branch-delete"; readonly root: string; readonly branch: string; readonly remote: string; readonly sha?: string }
  // fetch-branch: `git fetch <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>`; worktree-add: a detached worktree of `ref` at `path`.
  | { readonly op: "fetch-branch"; readonly root: string; readonly remote: string; readonly branch: string }
  | { readonly op: "worktree-add"; readonly root: string; readonly path: string; readonly ref: string };
export type LaneNotice = { readonly status: string; readonly objection?: Objection; readonly claim?: { readonly at: string; readonly evidence: string } };

export type LaneOpsErrorCode = "RUNNER_UNAVAILABLE" | "RUNNER_OUTDATED" | "LANE_OP_FAILED" | "LANE_OP_AMBIGUOUS";

export class LaneOpsError extends Error {
  readonly detail: string;
  constructor(readonly code: LaneOpsErrorCode, readonly label: string, detail: string) {
    super(`${code} runner=${label} ${detail}`);
    this.name = "LaneOpsError";
    this.detail = detail;
  }
}

/** The runner that owns a lane: `Lane.runner`, else its machine, else the local runner. */
export const runnerOf = (lane: Pick<Lane, "runner" | "machine">): string => lane.runner ?? lane.machine ?? LOCAL_RUNNER;
export const machineRunner = (machine: string | undefined): string => machine ?? LOCAL_RUNNER;

/** Every lane and host-pane operation the supervisor and the CLI need. Supervisor modules import only this; this module imports only RunnerCall. */
export type LaneOps = {
  readonly files: (lane: LaneRef) => Promise<LaneOutputFiles | undefined>;
  // reads (q.*; throw LaneOpsError RUNNER_UNAVAILABLE / RUNNER_OUTDATED / LANE_OP_FAILED)
  readonly panes: (machine?: string) => Promise<Pane[]>;
  /** `lines` undefined: the visible screen; n: the last n lines of scrollback and screen ("recent"). */
  readonly screen: (ref: PaneRef, lines?: number) => Promise<string>;
  /** herdr's JSON in `out` (`{result:{process_info}}`), code 1 and `err` when the runner could not read it: keeps the existing parsers. */
  readonly processInfo: (ref: PaneRef) => Promise<Ran>;
  /** From `panes()`; never throws. */
  readonly status: (ref: PaneRef) => Promise<{ readonly status?: string; readonly error?: string }>;
  readonly exists: (machine: string | undefined, paths: readonly string[]) => Promise<boolean[]>;
  readonly inspect: (lane: LaneRef, want: InspectWant) => Promise<LaneInspection>;
  readonly observeMachine: (machine?: string) => Promise<MachineObservation>;
  // effects (durable commands)
  /** Never throws: an unreachable runner and a failed result are "failed" (logged once per lane per minute); a timed-out or ambiguous result is "unconfirmed". */
  readonly send: (lane: LaneRef, text: string, opts?: SendOptions) => Promise<Delivery>;
  readonly pause: (lane: LaneRef, step?: "goal" | "stop" | "both") => Promise<CommandResults["lane.pause"]>;
  readonly resume: (lane: LaneRef) => Promise<CommandResults["lane.resume"]>;
  /** Throws LaneOpsError LANE_OP_FAILED with the runner's detail (RUNNER_CMD_REJECTED cwd-outside-roots, RUNNER_LANE_TARGET_BUSY, ...). */
  readonly start: (input: StartInput) => Promise<CommandResults["lane.start"]>;
  readonly adopt: (input: AdoptInput) => Promise<CommandResults["lane.adopt"]>;
  readonly recover: (lane: LaneRef, opts?: { readonly session?: string; readonly tabWorkspace?: string; readonly briefText?: string; readonly files?: LaneBriefFiles; readonly cmdId?: string }) => Promise<CommandResults["lane.recover"]>;
  /** An ambiguous close throws LANE_OP_AMBIGUOUS (closeSequence maps it to its ambiguous step). */
  readonly close: (lane: LaneRef, opts?: { readonly cmdId?: string }) => Promise<CommandResults["lane.close"]>;
  /** failed → {code: 1, err: detail}; ambiguous → {code: 2, err: "ambiguous: ..."} (the operation's read-back decides). */
  readonly git: (lane: LaneRef, op: GitOp, opts?: { readonly cmdId?: string }) => Promise<Ran>;
  /** Never throws (logged). */
  readonly notify: (lane: LaneRef, notice: LaneNotice) => Promise<void>;
  readonly kill: (machine: string | undefined, keys: readonly string[]) => Promise<KilledProc[]>;
  readonly observe: (lane: LaneRef) => Promise<LaneStatus>;
  /** An idle lane's last stopped turn as its runner recorded it (`lane.observe`); undefined when it has none to give. */
  readonly turn: (lane: LaneRef) => Promise<TurnEvidence | undefined>;
  readonly connected: (machine?: string) => boolean;
};

/** The runner profiles `lane.start` names (the runner holds the argv): `sandboxed` wraps `default` in the lane sandbox. */
const AGENT_PROFILE = "default";
const SANDBOXED_PROFILE = "sandboxed";
/** A failed send is logged at most this often per lane. */
const SEND_LOG_EVERY_MS = 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Type guards for the runner's JSON answers
// ---------------------------------------------------------------------------------------------------------------

type Obj = { readonly [k: string]: unknown };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const optStr = (v: unknown): boolean => v === undefined || isStr(v);
const optBool = (v: unknown): boolean => v === undefined || isBool(v);
const oneOf = <T extends string>(values: readonly T[]) => (v: unknown): v is T => isStr(v) && (values as readonly string[]).includes(v);
const listOf = (v: unknown, item: (x: unknown) => boolean): v is readonly unknown[] => Array.isArray(v) && v.every(item);

const LANE_STATUSES = oneOf<LaneStatus>(["working", "idle", "dead", "missing"]);
const GOALS = oneOf(["confirmed", "unconfirmed", "failed"]);
const CLOSED = oneOf(["tab", "pane", "none"]);
const DELIVERIES = oneOf<Delivery>(["delivered", "unconfirmed", "failed", "sent"]);
const isPane = (v: unknown): boolean => isObj(v) && isStr(v.pane_id) && isStr(v.workspace_id);
const isStartup = (v: unknown): boolean => isObj(v) && oneOf(["ok", "error", "unconfirmed"])(v.verdict) && isStr(v.detail);
const isCheck = (v: unknown): boolean => isObj(v) && isStr(v.signal) && isBool(v.ok) && isStr(v.detail);
const isWorktree = (v: unknown): boolean => isObj(v) && isStr(v.path) && isBool(v.exists);
const isTurn = (v: unknown): boolean => isObj(v) && isNum(v.gen) && isNum(v.stop) && isNum(v.at) && isBool(v.continuation)
  && oneOf(["finished", "aborted", "system-aborted", "provider-failed"])(v.cause)
  && oneOf(["none", "goal-paused", "session-paused", "goal-stopped", "goal-blocked", "goal-complete", "no-goal", "question"])(v.hold);

const QUERY_GUARDS: { readonly [T in QueryType]: (v: unknown) => boolean } = {
  "q.lane.files": (v) => isObj(v) && Object.keys(v).every((k) => k === "files") && (v.files === undefined || isLaneOutputFiles(v.files)),
  "q.panes": (v) => isObj(v) && listOf(v.panes, isPane),
  "q.screen": (v) => isObj(v) && isStr(v.text),
  "q.process": (v) => isObj(v) && (v.info === undefined || isObj(v.info)) && optStr(v.error),
  "q.stat": (v) => isObj(v) && listOf(v.exists, isBool),
  "q.lane.inspect": (v) => isObj(v) && LANE_STATUSES(v.status) && isStr(v.cwd) && isBool(v.cwdExists)
    && (v.pane === undefined || isPane(v.pane)) && (v.process === undefined || isObj(v.process))
    && (v.git === undefined || (isObj(v.git) && listOf(v.git.worktrees, isWorktree) && (v.git.branches === undefined || isObj(v.git.branches))))
    && (v.done === undefined || (isObj(v.done) && isStr(v.done.cwd) && isBool(v.done.fallback) && listOf(v.done.checks, isCheck)))
    && (v.session === undefined || (isObj(v.session) && isStr(v.session.id) && isStr(v.session.via))),
  "q.machine.observe": (v) => isObj(v) && isStr(v.os) && isNum(v.sampledAt) && isObj(v.sample) && listOf(v.panes, isPane),
};

export const RESULT_GUARDS: { readonly [T in DurableCommandType]: (v: unknown) => boolean } = {
  "lane.start": (v) => isObj(v) && isStr(v.pane) && isStr(v.tab) && isStartup(v.startup),
  "lane.adopt": (v) => isObj(v) && isStr(v.pane) && isStr(v.tab) && isStr(v.tokenFile),
  "lane.stop": (v) => isObj(v) && CLOSED(v.closed) && isBool(v.gone),
  "lane.close": (v) => isObj(v) && CLOSED(v.closed) && isBool(v.gone),
  "lane.pause": (v) => isObj(v) && (v.goal === undefined || GOALS(v.goal)) && optBool(v.working) && optBool(v.stopped),
  "lane.resume": (v) => isObj(v) && GOALS(v.goal),
  "lane.recover": (v) => isObj(v) && isStr(v.pane) && isStr(v.tab) && isBool(v.relaunched) && isBool(v.resumed) && (v.startup === undefined || isStartup(v.startup)),
  "lane.send": (v) => isObj(v) && DELIVERIES(v.delivery) && optStr(v.refusal),
  "lane.notify": (v) => v === undefined || isObj(v),
  "lane.git": (v) => isObj(v) && isNum(v.code) && isStr(v.out) && isStr(v.err),
  "lane.observe": (v) => isObj(v) && LANE_STATUSES(v.status) && (v.turn === undefined || isTurn(v.turn)),
  "guard.kill": (v) => isObj(v) && listOf(v.killed, (k) => isObj(k) && isNum(k.pid) && isStr(k.comm) && isNum(k.rssKb) && optStr(k.lane)),
  "host.herdr": (v) => isObj(v) && oneOf(["start", "restart", "stop", "status"])(v.action) && oneOf(["up", "down", "hung"])(v.state)
    && optStr(v.instance) && isBool(v.managed) && isBool(v.paused),
  "wait.check": (v) => isObj(v) && isBool(v.met) && optStr(v.error),
  "job.run": (v) => isObj(v) && isNum(v.exitCode) && isBool(v.timedOut) && isStr(v.output) && isStr(v.err),
};

/** A RunnerUnavailable from call.ts (or rebuilt by the CLI relay): matched by shape, not class identity. */
const asUnavailable = (e: unknown): { readonly label: string; readonly why: string; readonly message: string } | undefined =>
  e instanceof Error && (e as { code?: unknown }).code === "RUNNER_UNAVAILABLE" && isStr((e as { label?: unknown }).label) && isStr((e as { why?: unknown }).why)
    ? (e as Error & { label: string; why: string }) : undefined;

/** Any error of a runner call as a LaneOpsError: an outdated runner is RUNNER_OUTDATED, a missing or silent one RUNNER_UNAVAILABLE. */
const toOpsError = (e: unknown, label: string): LaneOpsError => {
  if (e instanceof LaneOpsError) return e;
  const down = asUnavailable(e);
  if (down) {
    const prefix = `RUNNER_UNAVAILABLE runner=${down.label} `;
    const detail = down.message.startsWith(prefix) ? down.message.slice(prefix.length) : down.message;
    return new LaneOpsError(down.why === "outdated" ? "RUNNER_OUTDATED" : "RUNNER_UNAVAILABLE", down.label, detail);
  }
  return new LaneOpsError("LANE_OP_FAILED", label, e instanceof Error ? e.message : String(e));
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const laneOps = (call: RunnerCall, deps: { readonly now: () => number; readonly log?: (line: string) => void }): LaneOps => {
  const log = deps.log ?? (() => {});
  const sendLoggedAt = new Map<string, number>();

  const query = async <T extends QueryType>(label: string, type: T, body: Omit<QueryBodies[T], "qid">): Promise<QueryResults[T]> => {
    let value: unknown;
    try {
      value = await call.query(label, type, body);
    } catch (e) {
      throw toOpsError(e, label);
    }
    if (!QUERY_GUARDS[type](value as JsonValue)) throw new LaneOpsError("LANE_OP_FAILED", label, `malformed q.result ${type}`);
    return value as QueryResults[T];
  };

  /** A durable command that must verify: failed is LANE_OP_FAILED, ambiguous LANE_OP_AMBIGUOUS, both with the runner's detail. */
  const effect = async <T extends DurableCommandType>(
    label: string, type: T, body: Omit<SupervisorCommandBodies[T], "cmdId">, cmdId?: string,
  ): Promise<CommandResults[T]> => {
    let r;
    try {
      if (type === "lane.start" || type === "lane.recover") {
        cmdId ??= `${type === "lane.start" ? "lane-start" : "recover"}:${(body as { key?: string }).key}:${deps.now()}`;
        checkLaneFilesBody((body as { key?: string }).key!, { ...body, cmdId });
      }
      r = await call.call(label, type, body, cmdId ? { cmdId } : undefined);
    } catch (e) {
      throw toOpsError(e, label);
    }
    if (r.state === "failed") throw new LaneOpsError("LANE_OP_FAILED", label, `${type} ${r.detail}`);
    if (r.state === "ambiguous") throw new LaneOpsError("LANE_OP_AMBIGUOUS", label, `${type} ${r.detail}`);
    if (!RESULT_GUARDS[type](r.result)) throw new LaneOpsError("LANE_OP_FAILED", label, `malformed cmd.result ${type}`);
    return (r.result ?? {}) as CommandResults[T];
  };

  const sendFailed = (key: string, label: string, detail: string, onFailed?: (detail: string) => void): Delivery => {
    onFailed?.(detail);
    const now = deps.now();
    const last = sendLoggedAt.get(key);
    if (last === undefined || now - last >= SEND_LOG_EVERY_MS) {
      sendLoggedAt.set(key, now);
      log(`LANE_SEND_FAILED ${key} runner=${label} ${detail}`);
    }
    return "failed";
  };

  const panes = async (machine?: string): Promise<Pane[]> => [...(await query(machineRunner(machine), "q.panes", {})).panes];

  return {
    files: async (lane) => (await query(runnerOf(lane), "q.lane.files", { key: lane.key })).files,
    panes,
    screen: async (ref, lines) => {
      const label = machineRunner(ref.machine);
      if (!ref.pane) throw new LaneOpsError("LANE_OP_FAILED", label, "screen: no pane");
      const body = lines === undefined ? { pane: ref.pane, lines: 0, source: "visible" as const } : { pane: ref.pane, lines, source: "recent" as const };
      return (await query(label, "q.screen", body)).text;
    },
    processInfo: async (ref) => {
      const label = machineRunner(ref.machine);
      if (!ref.pane) return { code: 1, out: "", err: "process-info: no pane" };
      const r = await query(label, "q.process", { pane: ref.pane });
      if (r.info === undefined) return { code: 1, out: "", err: r.error ?? "no process info" };
      return { code: 0, out: JSON.stringify({ result: { process_info: r.info } }), err: "" };
    },
    status: async (ref) => {
      try {
        return { status: (await panes(ref.machine)).find((p) => p.pane_id === ref.pane)?.agent_status };
      } catch (e) {
        return { error: errText(e) };
      }
    },
    exists: async (machine, paths) => {
      const r = await query(machineRunner(machine), "q.stat", { paths: [...paths] });
      if (r.exists.length !== paths.length) throw new LaneOpsError("LANE_OP_FAILED", machineRunner(machine), "malformed q.result q.stat");
      return [...r.exists];
    },
    inspect: async (lane, want) => {
      // D10: a remote lane's Done signals run on the lead host (the local runner) in doneCwd.
      const doneOnLead = want.done !== undefined && lane.machine !== undefined;
      const label = doneOnLead ? LOCAL_RUNNER : runnerOf(lane);
      const cwd = doneOnLead ? want.doneCwd : (want.cwd ?? (lane.machine ? lane.remoteCwd : lane.cwd));
      return query(label, "q.lane.inspect", {
        key: lane.key,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(want.process !== undefined ? { process: want.process } : {}),
        ...(want.git !== undefined ? { git: want.git } : {}),
        ...(want.roots ? { roots: [...want.roots] } : {}),
        ...(want.branches ? { branches: [...want.branches] } : {}),
        ...(want.done !== undefined ? { done: want.done } : {}),
        ...(want.doneCwd !== undefined ? { doneCwd: want.doneCwd } : {}),
        ...(want.session !== undefined ? { session: want.session } : {}),
        ...(want.sessionsDir !== undefined ? { sessionsDir: want.sessionsDir } : {}),
      });
    },
    observeMachine: (machine) => query(machineRunner(machine), "q.machine.observe", {}),

    send: async (lane, text, opts = {}) => {
      const label = runnerOf(lane);
      try {
        const r = await call.call(label, "lane.send", {
          key: lane.key, text, verify: opts.inputCheck ?? true,
          ...(opts.mode ? { mode: opts.mode } : {}),
          ...(opts.refuseWhileAsking !== undefined ? { refuseWhileAsking: opts.refuseWhileAsking } : {}),
        }, opts.cmdId ? { cmdId: opts.cmdId } : undefined);
        if (r.state === "failed") return sendFailed(lane.key, label, r.detail, opts.onFailed);
        // The runner cannot tell whether the text was typed: like a send whose read-back did not confirm it.
        if (r.state === "ambiguous") return "unconfirmed";
        if (!RESULT_GUARDS["lane.send"](r.result)) return sendFailed(lane.key, label, "malformed cmd.result lane.send", opts.onFailed);
        const sentResult = r.result as CommandResults["lane.send"];
        if (sentResult.delivery === "failed") return sendFailed(lane.key, label, sentResult.refusal ?? "not delivered", opts.onFailed);
        return sentResult.delivery;
      } catch (e) {
        // A timeout means the command reached the runner and its result never came back: it may have typed the text,
        // so it is uncertain like an ambiguous result, never a definite failure that would authorize a retry.
        if (asUnavailable(e)?.why === "timeout") return "unconfirmed";
        return sendFailed(lane.key, label, toOpsError(e, label).message, opts.onFailed);
      }
    },
    pause: (lane, step) => effect(runnerOf(lane), "lane.pause", { key: lane.key, ...(step ? { step } : {}) }),
    resume: (lane) => effect(runnerOf(lane), "lane.resume", { key: lane.key }),
    start: (input) => effect(machineRunner(input.machine), "lane.start", {
      key: input.key, briefText: input.briefText, done: input.done, thread: input.thread, cwd: input.cwd,
      agentProfile: input.sandbox ? SANDBOXED_PROFILE : AGENT_PROFILE, mode: input.mode, model: input.model, sandbox: input.sandbox,
      expectedLaneGen: 0, keywords: input.keywords,
      ...(input.files !== undefined ? { files: input.files } : {}),
      ...(input.session !== undefined ? { session: input.session } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.heavySlots !== undefined ? { heavySlots: input.heavySlots } : {}),
      ...(input.heavyMaxLoad !== undefined ? { heavyMaxLoad: input.heavyMaxLoad } : {}),
      ...(input.tabWorkspace !== undefined ? { tabWorkspace: input.tabWorkspace } : {}),
    }, input.cmdId),
    adopt: (input) => effect(machineRunner(input.machine), "lane.adopt", {
      key: input.key, pane: input.pane, mode: input.mode, model: input.model, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    }),
    recover: (lane, opts = {}) => effect(runnerOf(lane), "lane.recover", {
      key: lane.key, ...(opts.session !== undefined ? { session: opts.session } : {}), ...(opts.tabWorkspace !== undefined ? { tabWorkspace: opts.tabWorkspace } : {}),
      ...(opts.briefText !== undefined ? { briefText: opts.briefText } : {}), ...(opts.files !== undefined ? { files: opts.files } : {}),
    }, opts.cmdId),
    // Worktree checks are the supervisor's (q.lane.inspect before the close, D10), never the runner's.
    close: (lane, opts = {}) => effect(runnerOf(lane), "lane.close", { key: lane.key, worktreeChecks: false }, opts.cmdId),
    git: async (lane, op, opts = {}) => {
      const label = runnerOf(lane);
      let r;
      try {
        r = await call.call(label, "lane.git", { key: lane.key, ...op }, opts.cmdId ? { cmdId: opts.cmdId } : undefined);
      } catch (e) {
        throw toOpsError(e, label);
      }
      if (r.state === "failed") return { code: 1, out: "", err: r.detail };
      if (r.state === "ambiguous") return { code: 2, out: "", err: `ambiguous: ${r.detail}` };
      if (!RESULT_GUARDS["lane.git"](r.result)) throw new LaneOpsError("LANE_OP_FAILED", label, "malformed cmd.result lane.git");
      const ran = r.result as CommandResults["lane.git"];
      return { code: ran.code, out: ran.out, err: ran.err };
    },
    notify: async (lane, notice) => {
      const label = runnerOf(lane);
      try {
        const r = await call.call(label, "lane.notify", {
          key: lane.key, status: notice.status,
          ...(notice.objection ? { objection: { at: notice.objection.at, reasons: [...notice.objection.reasons] } } : {}),
          ...(notice.claim ? { claim: { at: notice.claim.at, evidence: notice.claim.evidence } } : {}),
        });
        if (r.state !== "verified") log(`LANE_NOTIFY_FAILED ${lane.key} runner=${label} ${r.state}: ${r.detail}`);
      } catch (e) {
        log(`LANE_NOTIFY_FAILED ${lane.key} runner=${label} ${toOpsError(e, label).message}`);
      }
    },
    kill: async (machine, keys) => [...(await effect(machineRunner(machine), "guard.kill", { keys: [...keys] })).killed],
    observe: async (lane) => (await effect(runnerOf(lane), "lane.observe", { key: lane.key })).status,
    turn: async (lane) => (await effect(runnerOf(lane), "lane.observe", { key: lane.key })).turn,
    connected: (machine) => call.connected(machineRunner(machine)),
  };
};
