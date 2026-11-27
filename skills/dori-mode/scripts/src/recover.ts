import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database, SQLiteError } from "bun:sqlite";

import { fillHook } from "./config.ts";
import { isLaneOutcomeLine, laneOutcomeEventId } from "./autopilot.ts";
import { finishedOutcome } from "./task-finish.ts";
import { closeLane, closeRunning, finishClosedTask, type FlowDeps, finishedReason } from "./done-flow.ts";
import { LaunchError, launchLane, prepareLeadLaneBrief, recoveryFields, restoreFileProposal, SandboxRefusal, startupLine } from "./launch.ts";
import { runnerJournalHead } from "./runner/lanes-hub.ts";
import { resumeArgv } from "./runner/lane-control.ts";
import { argvModel } from "./runner/lane-launch.ts";
import { checkLaneFilesBody } from "./lane-file-contract.ts";
import { LaneOpsError, machineRunner } from "./lane-ops.ts";
import { ALIVE_STATUSES } from "./pane-state.ts";
import type { Pane } from "./panes.ts";
import { STARTUP_GRACE_MS as RUNNER_STARTUP_GRACE_MS } from "./runner/serve.ts";
import { postSandboxNotice, postSkippedNotices } from "./sandbox-notice.ts";
import { discordStatusTransport } from "./lane-status.ts";
import { redirectHookPost } from "./thread-followup.ts";
import { passthroughView, SWEEP_SCREEN_LINES, type SweepView } from "./sweep-view.ts";
import { LANE_KEY, type Lane, statusOf } from "./registry.ts";
import { errText } from "./line-text.ts";

export const RECOVERY_LIMIT = 3;

/** A pane launched this recently whose model cannot be read yet is still starting, not on a missing model. */
export const STARTUP_GRACE_MS = 60_000;

/** Must resolve only after durable acceptance; retries carry the same journal id. */
export type RecoveryEnqueue = (line: string, id: string) => Promise<void>;

/** Lane record fields recovery keeps (the registry stores whatever the record carries). */
export type RecoveryLane = Lane & {
  /** Durable command identity and rollback state for an unresolved replacement. */
  readonly fileProposal?: {
    readonly cmdId: string;
    readonly runId?: string;
    readonly prior: Partial<RecoveryLane>;
  };
  /** Every recovery attempt failed; LANE_RECOVERY_EXHAUSTED was sent once. Cleared when the lane is confirmed again. */
  readonly recoveryExhausted?: boolean;
  /** A session a recovery tried to resume and could not; the next attempt starts from the brief. */
  readonly recoveryResumeFailed?: string;
  /** The live lane's pane was seen working since `turnStopRead`: its next stop is read from the runner once. */
  readonly turnRan?: true;
  /** The runner's last stopped turn of the lane read by recovery, as `gen:stop` (`-`: the runner gave none). */
  readonly turnStopRead?: string;
};

/** Holds that already say why a lane waits: an explicit goal pause, a finished goal, a question (LANE_ASKING). */
const EXPLAINED_HOLDS: ReadonlySet<string> = new Set(["goal-paused", "goal-complete", "question"]);

/**
 * A working lane whose agent is alive on the expected model: nothing is relaunched or retried. Once per stopped stretch
 * (after its pane was seen working, or never read yet) its runner's record of the last stopped turn is read
 * (`lane.observe`); a turn that was aborted (by the user, the system or a failed provider call) with no continuation
 * pending and no hold that explains it is `LANE_TURN_INTERRUPTED`, once per stop, so the lead sees it before any
 * recovery. A finished turn, a goal continuation or watch on duty, and a runner that records no turns say nothing.
 */
const turnInterrupted = async (deps: FlowDeps, lane: RecoveryLane, pane: Pane, enqueue: RecoveryEnqueue | undefined): Promise<string[]> => {
  if (pane.agent_status === "working") {
    if (!lane.turnRan) await deps.registry.patch<RecoveryLane>(lane.key, { turnRan: true });
    return [];
  }
  if (lane.turnStopRead !== undefined && !lane.turnRan) return [];
  let turn;
  try { turn = await deps.ops.turn(lane); }
  catch (error) {
    // A runner that is down is the caller's (held silently); a lane the runner cannot observe has no turn to read.
    if (!(error instanceof LaneOpsError) || runnerDown(error)) throw error;
  }
  const id = turn ? `${turn.gen}:${turn.stop}` : "-";
  const event = turn && turn.cause !== "finished" && !turn.continuation && !EXPLAINED_HOLDS.has(turn.hold) && id !== lane.turnStopRead
    ? `LANE_TURN_INTERRUPTED ${lane.key} ${pane.pane_id} gen=${turn.gen} stop=${turn.stop} cause=${turn.cause} hold=${turn.hold} its agent is alive but its last turn stopped with nothing pending to continue it; not relaunched or retried: read its pane, then send it a message to continue, or dori pause and dori resume ${lane.key} (resume confirms a turn runs)`
    : undefined;
  // Enqueued before the read is saved: a crash retries the same durable journal id.
  if (event && enqueue) await enqueue(event, `turn:${JSON.stringify([lane.key, lane.openedAt, id])}`);
  await deps.registry.patch<RecoveryLane>(lane.key, { turnRan: undefined, turnStopRead: id });
  return event && !enqueue ? [event] : [];
};


/** SQLite releases this exclusion even when the recovering process dies. */
export const withRecoveryLock = async (deps: FlowDeps, key: string, action: () => Promise<string[]>): Promise<string[]> => {
  if (!LANE_KEY.test(key)) return [`LANE_RECOVERY_ERROR ${key} invalid-key`];
  mkdirSync(deps.registry.dir, { recursive: true });
  const db = new Database(join(deps.registry.dir, `${key}.recovery.sqlite`), { create: true, strict: true });
  try {
    try { db.exec("BEGIN EXCLUSIVE"); }
    catch (error) {
      if (error instanceof SQLiteError && error.code === "SQLITE_BUSY") return [];
      throw error;
    }
    return await action();
  } finally { db.close(); }
};

/**
 * The omo process's model. omo's own children (an MCP server: `omo …/cli.js mcp`) match too and carry no --model, so
 * every matching process is read and the first one that names a model wins.
 */
const liveModel = (raw: unknown): { readonly omo: boolean; readonly model?: string } => {
  if (typeof raw !== "object" || raw === null || !("result" in raw)) return { omo: false };
  const result = raw.result;
  if (typeof result !== "object" || result === null || !("process_info" in result)) return { omo: false };
  const info = result.process_info;
  if (typeof info !== "object" || info === null || !("foreground_processes" in info) || !Array.isArray(info.foreground_processes)) return { omo: false };
  let omo = false;
  for (const proc of info.foreground_processes) {
    if (typeof proc !== "object" || proc === null || !("argv" in proc) || !Array.isArray(proc.argv)) continue;
    const argv: string[] = proc.argv.filter((arg: unknown): arg is string => typeof arg === "string");
    if (!argv.slice(0, 2).some((arg) => /(?:^|[/\\])omo(?:\.[cm]?[jt]s)?$|[/\\]senpi[/\\]dist[/\\]bundle[/\\]cli\.js$/.test(arg))) continue;
    const model = argvModel(argv);
    if (model) return { omo: true, model };
    omo = true;
  }
  return { omo };
};

/**
 * The pane is there but its agent is gone (its shell is all that runs): no omo process, no live hc status, and past
 * the runner's startup window (where its lane.recover leaves the pane alone).
 */
const agentGoneFrom = (deps: FlowDeps, lane: Lane, pane: Pane, live: { readonly omo: boolean }): boolean =>
  !live.omo && !ALIVE_STATUSES.has(pane.agent_status ?? "")
  && deps.clock.now() - (lane.lastRecoveryAt ?? Date.parse(lane.openedAt)) >= RUNNER_STARTUP_GRACE_MS;

/**
 * Whether the lane's agent is gone as recovery reads it: its registered pane is missing from its runner's pane list, or
 * left with only its shell. A runner that cannot be read, or a pane whose processes cannot be read, says nothing is gone.
 */
export const laneAgentGone = async (deps: FlowDeps, lane: Lane, view: SweepView = passthroughView(deps.ops)): Promise<boolean> => {
  if (!lane.pane) return false;
  try {
    const pane = await view.find(lane);
    if (!pane) return true;
    const got = await view.processInfo({ ...lane, pane: pane.pane_id });
    return got.code === 0 && agentGoneFrom(deps, lane, pane, liveModel(JSON.parse(got.out)));
  } catch (error) {
    if (error instanceof LaneOpsError) return false;
    throw error;
  }
};

const providerOf = (model: string): string | undefined => model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
const bareOf = (model: string): string => model.slice(model.indexOf("/") + 1);

/** Same model, where a side that names no provider (`claude-sonnet-5-5`) matches on the bare name. */
export const sameModel = (live: string, expected: string): boolean =>
  live === expected || ((!providerOf(live) || !providerOf(expected)) && bareOf(live) === bareOf(expected));

/**
 * omo's status bar names the running model near the bottom of the pane: `(provider@account) claude-opus-5-5:medium`,
 * `… claude-opus-5-5 • effort low`, or without the provider tag when the pane is narrow (`claude-sonnet-5-5:medium`).
 * A provider tag, when shown, must be the expected model's provider.
 */
export const barShowsModel = (screen: string, expected: string): boolean => {
  const provider = providerOf(expected);
  const name = bareOf(expected).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shown = new RegExp(`(?:^|\\s)(?:\\(([^()@\\s]+)@[^()\\s]*\\)\\s+)?${name}(?=:|\\s|$)`);
  return screen.split("\n").filter((line) => line.trim()).slice(-3).some((line) => {
    const hit = shown.exec(line);
    return hit !== null && (!hit[1] || !provider || hit[1] === provider);
  });
};

const finishRecovery = async (deps: FlowDeps, lane: Lane, reason: string): Promise<string[]> => {
  const current = await deps.registry.read(lane.key);
  if (!current || current.pendingFileRun || statusOf(current) !== "working" || current.pane !== lane.pane || current.model !== lane.model) return [];
  lane = current;
  // The runner closed the replaced pane's tab itself (lane.recover / lane.close); this only confirms it is gone.
  const previous = lane.recoveryPreviousPane;
  const left = previous && previous !== lane.pane && (await deps.ops.panes(lane.machine)).some((pane) => pane.pane_id === previous)
    ? [`LANE_RECOVERY_WARN ${lane.key} the replaced pane ${previous} is still open; close it by hand`] : [];
  let confirmed = false;
  await deps.registry.update(lane.key, (fresh) => {
    if (!fresh || fresh.closedAt || fresh.pendingFileRun || fresh.pane !== current.pane || fresh.fileRun?.id !== current.fileRun?.id
      || statusOf(fresh) !== "working") return undefined;
    confirmed = true;
    return { ...fresh, recoveryPending: undefined, recoveryPreviousPane: undefined, recoveryExhausted: undefined };
  });
  if (!confirmed) return [];
  const event = `LANE_RECOVERED ${lane.key} ${lane.pane} ${reason}`;
  const hook = deps.config.hooks.threadReply;
  if (hook && lane.thread !== "none") {
    // A thread the owner closed is not posted into: one line linking it goes to its parent channel instead.
    try {
      const to = await redirectHookPost(deps.config.stateDir, discordStatusTransport(deps.clock), lane.thread, event, deps.config.discordChannels[0], `lane-recovered:${lane.key}:${lane.pane}`);
      if (to) return [event, ...left];
    } catch (e) {
      console.error(`LANE_RECOVERY_NOTICE_ERROR ${lane.key} ${e instanceof Error ? e.message : String(e)}`);
      return [event, ...left, `LANE_RECOVERY_NOTICE_ERROR ${lane.key}`];
    }
    const notice = await deps.run(fillHook(hook, { thread: lane.thread, key: lane.key, title: lane.title, text: event }));
    if (notice.code !== 0) return [event, ...left, `LANE_RECOVERY_NOTICE_ERROR ${lane.key}`];
  }
  return [event, ...left];
};

type Relaunched = { readonly lane: Lane; readonly startup?: string; readonly ok: boolean; readonly resumed: boolean; readonly notes?: readonly string[] };

/** The runner knows no lane `key` (a lane it never started, or one closed for a replacement that did not start). */
const unknownToRunner = (error: unknown): boolean => error instanceof LaneOpsError && error.code === "LANE_OP_FAILED" && error.detail.includes("RUNNER_LANE_UNKNOWN");

/** Starts the lane again from its brief through its runner (`lane.start`, launchLane with the stored record). */
const startAgain = async (deps: FlowDeps, lane: Lane, stored: RecoveryLane, session: string | undefined): Promise<Relaunched> => {
  lane = stored;
  const cwd = lane.machine ? lane.remoteCwd : lane.cwd;
  const launched = await launchLane(deps, {
    key: lane.key, title: lane.title, brief: lane.brief, done: lane.done, thread: lane.thread,
    model: lane.model ?? deps.config.defaultModel,
    ...(lane.mode ? { mode: lane.mode } : {}),
    ...(cwd ? { cwd } : {}), ...(lane.machine ? { machine: lane.machine } : {}),
    ...(lane.sandbox ? { sandbox: true as const } : {}),
    ...(lane.grants?.length ? { grants: lane.grants } : {}),
    ...(session !== undefined ? { session } : {}),
  }, stored);
  return { lane: launched.lane, startup: launched.startup, ok: launched.startup.startsWith("STARTUP_OK "), resumed: session !== undefined,
    notes: launched.notes.filter((note) => /^(?:LANE_FILE_NOT_SHIPPED|LANE_FILES_SKIPPED|SANDBOX_SKIPPED) /.test(note)) };
};

/**
 * A lane whose pane or agent is gone: its runner relaunches it from its own record (`lane.recover`, which closes the
 * dead pane and keeps the lane token's brief and profile). A runner that has no record of the lane starts it anew.
 */
const runnerRecover = async (deps: FlowDeps, lane: Lane, stored: RecoveryLane, session: string | undefined,
  prepared: Awaited<ReturnType<typeof prepareLeadLaneBrief>>, cmdId: string, prior: Lane): Promise<Relaunched> => {
  let r;
  try {
    r = await deps.ops.recover(stored, { briefText: prepared.briefText, files: prepared.files, cmdId,
      ...(session !== undefined ? { session } : {}) });
  } catch (error) {
    if (unknownToRunner(error)) {
      await restoreFileProposal(deps, lane.key, prepared.files.run.id, prior);
      const fresh = await deps.registry.read(lane.key);
      if (!fresh) throw new LaunchError(`lane ${lane.key} disappeared during recovery`);
      return startAgain(deps, lane, fresh, session);
    }
    if (error instanceof LaneOpsError && (error.code === "LANE_OP_FAILED" || error.code === "RUNNER_OUTDATED"
      || (error.code === "RUNNER_UNAVAILABLE" && error.detail.startsWith("disconnected"))))
      await restoreFileProposal(deps, lane.key, prepared.files.run.id, prior);
    throw error;
  }
  const moved = await deps.registry.update(lane.key, (current) => {
    if (!current || current.closedAt) return undefined;
    // A runner profile that pins its own model runs that one: the lane is judged against it from now on.
    const model = r.relaunched && r.model && r.model !== current.model ? { model: r.model } : undefined;
    if (current.pendingFileRun?.id !== prepared.files.run.id) {
      // The run's lane.started landed first and confirmed it (pane and fileRun): only the model is left to record.
      return model && current.fileRun?.id === prepared.files.run.id && !current.pendingFileRun ? { ...current, ...model } : undefined;
    }
    return { ...current, pane: r.pane, ...(r.tab ? { tab: r.tab } : {}), ...model,
      fileRun: r.relaunched ? prepared.files.run : current.fileRun, pendingFileRun: undefined, fileProposal: undefined };
  });
  const next: Lane = moved ?? await deps.registry.read(lane.key) ?? stored;
  // A live lane the runner left alone: its record had the pane the registry lost.
  if (!r.relaunched) return { lane: next, ok: true, resumed: false, notes: prepared.notes };
  const startup = r.startup ? startupLine(lane.key, r.pane, r.startup) : `STARTUP_UNCONFIRMED ${lane.key} ${r.pane}: the runner gave no startup verdict`;
  return { lane: next, startup, ok: r.startup?.verdict === "ok", resumed: r.resumed, notes: prepared.notes };
};

const recoverOne = async (deps: FlowDeps, lane: Lane, enqueue: RecoveryEnqueue | undefined, view: SweepView): Promise<string[]> => {
  if (statusOf(lane) !== "working") return [];
  const old = lane.pane ? await view.find(lane) : undefined;
  let reason = "missing-pane";
  if (old) {
    const got = await view.processInfo({ ...lane, pane: old.pane_id });
    if (got.code !== 0) throw new LaunchError(`process-info failed: ${got.err || got.out}`);
    const live = liveModel(JSON.parse(got.out));
    // An agent gone from its pane is relaunched by the runner like a missing pane. A pane with another live agent, or one
    // still in the runner's startup window, is left alone.
    if (!live.omo) {
      if (!agentGoneFrom(deps, lane, old, live)) return [];
      reason = "agent-gone";
    } else {
    const expected = lane.model ?? deps.config.defaultModel;
    // argv without a model (a restored session) still runs the expected model when its status bar shows it.
    const model = live.model ?? (barShowsModel(await view.screen({ ...lane, pane: old.pane_id }, SWEEP_SCREEN_LINES), expected) ? expected : undefined);
    if (model && sameModel(model, expected)) {
      if (lane.recoveryPending && (old.agent_status === "working" || old.agent_status === "idle" || old.agent_status === "done")) {
        return finishRecovery(deps, lane, "startup-confirmed");
      }
      return lane.recoveryPending ? [] : turnInterrupted(deps, lane, old, enqueue);
    }
    // The pane in the registry was started by the last recovery, or else by the launch.
    const launchedAt = lane.lastRecoveryAt ?? Date.parse(lane.openedAt);
    if (!model && deps.clock.now() - launchedAt < STARTUP_GRACE_MS) return [];
    reason = model ? "model-mismatch" : "missing-model";
    }
  }
  const read = await deps.registry.read(lane.key);
  if (!read || statusOf(read) !== "working" || read.pane !== lane.pane || read.model !== lane.model) return [];
  // A running close takes the pane's tab down before it writes the lane closed: that missing pane is not relaunched.
  if (closeRunning(deps, lane.key)) return [];
  const current: RecoveryLane = read;
  // An unresolved proposal may still start. Its journal/result must settle before a new recovery.
  if (current.pendingFileRun) return [];
  // A lane whose work is finished (Done signals hold, PR merged) is never relaunched: close it, or leave it for the close.
  const finished = await finishedReason(deps, current);
  if (finished) {
    const closed = await closeLane(deps, current, `recovery: ${finished}; not relaunched`);
    const event = `LANE_RECOVERY_SKIPPED ${lane.key} ${lane.pane ?? "-"} ${reason}: ${finished}; ${closed.closed ? "lane closed" : `not relaunched, left for dori close (${closed.lines.at(-1) ?? "refused"})`}`;
    // An autopilot lane's close also settles its launch attempt (AUTOPILOT_LANE_DONE).
    // The supervisor finishes the closed lane's Toodo task as after a done claim (TOODO_TASK_COMPLETED / _NOT_COMPLETED);
    // an AUTOPILOT_LANE_DONE whose task it completed is then digest (toodo=done).
    const finish = closed.closed ? await finishClosedTask(deps, current) : undefined;
    const outcomes = closed.lines.filter(isLaneOutcomeLine).map((line) => finishedOutcome(line, finish));
    const taskLines = finish?.lines ?? [];
    if (!enqueue) return [event, ...outcomes, ...taskLines];
    // A refused close leaves the lane for the next sweep: the same lane, generation and reason is said once.
    await enqueue(event, `recovery-skipped:${JSON.stringify([lane.key, lane.openedAt, current.lastRecoveryAt ?? null, reason, finished, closed.closed])}`);
    for (const line of outcomes) await enqueue(line, laneOutcomeEventId(lane.key));
    for (const line of taskLines) await enqueue(line, `task-finish:${lane.key}:${lane.openedAt}`);
    return [];
  }
  const noticeId = (kind: string, detail = ""): string =>
    `recovery:${JSON.stringify([lane.key, lane.openedAt, lane.pane, lane.model, current.recoveryAttempts ?? 0, current.lastRecoveryAt, kind, detail])}`;
  if ((current.recoveryAttempts ?? 0) >= RECOVERY_LIMIT) {
    // Freshness skips a recoveryPending lane, so this is the only word the lead gets: sent once, status/doctor keep showing it.
    if (current.recoveryExhausted) return [];
    const event = `LANE_RECOVERY_EXHAUSTED ${lane.key} ${lane.pane ?? "-"} ${reason} after ${current.recoveryAttempts ?? 0} recovery attempts; lane is not relaunched or nudged again, inspect it or dori close ${lane.key}`;
    // Enqueued before the flag is saved: a crash retries the same durable journal id.
    if (enqueue) await enqueue(event, noticeId("exhausted"));
    await deps.registry.patch<RecoveryLane>(lane.key, { recoveryPending: true, recoveryExhausted: true });
    return enqueue ? [] : [event];
  }
  const now = deps.clock.now();
  // Resume the lane's own session when the registry has one, so it continues its work instead of restarting from the brief.
  const session = current.recoveryResumeFailed !== current.session && resumeArgv(deps.config.agentCommand, current.session) ? current.session : undefined;
  const prepared = await prepareLeadLaneBrief(deps, current, undefined, true);
  const cmdId = `recover:${lane.key}:${now}`;
  checkLaneFilesBody(lane.key, { cmdId, key: lane.key, briefText: prepared.briefText, files: prepared.files, ...(session ? { session } : {}) });
  const pending = (fresh: RecoveryLane): Partial<RecoveryLane> => ({
    ...(session ? {} : { session: undefined, sessionVia: undefined }),
    recoveryAttempts: (fresh.recoveryAttempts ?? 0) + 1, lastRecoveryAt: now, recoveryPending: true,
    runner: current.runner ?? machineRunner(current.machine), pendingFileRun: prepared.files.run,
    fileProposal: { cmdId, runId: prepared.files.run.id, prior: recoveryFields(fresh) },
    recoveryAfter: runnerJournalHead(deps.config.stateDir),
    ...(old ? { recoveryPreviousPane: old.pane_id } : {}),
  });
  let admitted = false;
  const stored = await deps.registry.update(lane.key, (fresh) => {
    if (!fresh || fresh.closedAt || statusOf(fresh) !== "working" || fresh.pane !== current.pane
      || fresh.model !== current.model || fresh.runner !== current.runner || fresh.fileRun?.id !== current.fileRun?.id
      || fresh.pendingFileRun) return undefined;
    admitted = true;
    return { ...fresh, ...pending(fresh) };
  });
  if (!admitted || !stored) return [];
  let relaunched: Relaunched;
  if (old && reason !== "agent-gone") {
    // A live agent on the wrong model: the runner leaves a live lane alone, so the lane is closed and started again.
    await deps.ops.close(stored);
    await restoreFileProposal(deps, lane.key, prepared.files.run.id, current);
    relaunched = await startAgain(deps, lane, await deps.registry.read(lane.key) ?? stored, session);
  } else {
    relaunched = await runnerRecover(deps, lane, stored, session, prepared, cmdId, current);
  }
  // A relaunch that runs without a sandbox (a lane recorded without one) is said to the owner and the lead every time.
  const skipped = (relaunched.notes ?? []).filter((note) => note.startsWith("SANDBOX_SKIPPED"));
  const unsandboxed = [...(relaunched.notes ?? []), ...await postSkippedNotices(deps, lane, skipped)];
  if (!relaunched.ok) {
    const startup = relaunched.startup ?? `STARTUP_UNCONFIRMED ${lane.key} -`;
    if (!session) return [startup, `LANE_RECOVERY_ERROR ${lane.key} replacement-unconfirmed`, ...unsandboxed];
    await deps.registry.patch<RecoveryLane>(lane.key, { session: undefined, sessionVia: undefined, recoveryResumeFailed: current.session });
    return [startup, `LANE_RECOVERY_ERROR ${lane.key} replacement-unconfirmed; session ${current.session} not resumed, the next attempt starts from the brief`, ...unsandboxed];
  }
  const why = relaunched.startup ? (relaunched.resumed ? `${reason} session-resumed` : reason) : `${reason} runner-alive`;
  return [...await finishRecovery(deps, relaunched.lane, why), ...(relaunched.startup ? [relaunched.startup] : []), ...unsandboxed];
};

/** The lane's runner has no admitted connection (not said hello yet, gone, or too old for the call): nothing to recover through. */
const runnerDown = (error: unknown): error is LaneOpsError =>
  error instanceof LaneOpsError && (error.code === "RUNNER_UNAVAILABLE" || error.code === "RUNNER_OUTDATED");

const runnerHeld = (lane: Lane, runner: string): string =>
  `LANE_RECOVERY_HELD ${lane.key} runner=${runner.replace(/\s/g, "_")} is not connected; recovery resumes once it says hello`;

const relaunchLane = async (deps: FlowDeps, lane: Lane, enqueue: RecoveryEnqueue | undefined, view: SweepView, byKey: boolean): Promise<string[]> =>
  withRecoveryLock(deps, lane.key, async () => {
    const current = await deps.registry.read(lane.key);
    if (!current || current.pane !== lane.pane || current.model !== lane.model) return [];
    try { return await recoverOne(deps, current, enqueue, view); }
    catch (error) {
      // A runner that dropped mid-recovery is the liveness monitor's to report; the lane is tried again once it is back.
      if (runnerDown(error)) return byKey ? [runnerHeld(lane, error.label)] : [];
      // A lane its sandbox refused stays down until someone fixes the sandbox: the owner hears it in the lane's thread
      // and the lead gets an urgent LANE_RECOVERY_ERROR <key> sandbox-missing|sandbox-broken|sandbox-unavailable: (event-policy.ts).
      if (error instanceof SandboxRefusal) {
        const event = `LANE_RECOVERY_ERROR ${lane.key} ${error.code.toLowerCase().replace("_", "-")}: ${error.message}`;
        return [event, ...await postSandboxNotice(deps, current, error.message)];
      }
      return [`LANE_RECOVERY_ERROR ${lane.key} ${errText(error)}`];
    }
  });

/**
 * Legacy callers receive lines; supervisors must pass enqueue to durably accept notices before their flags are saved.
 * A lane whose runner has no admitted connection (right after a supervisor restart, before the runner's hello) is held:
 * nothing is read, relaunched or counted against its recovery attempts. The sweep holds it silently (the runner's own
 * liveness reports a runner that stays away); a recovery asked for by key says LANE_RECOVERY_HELD. The first sweep
 * after its hello recovers what is still missing.
 */
export const recoverLanes = async (deps: FlowDeps, key?: string, enqueue?: RecoveryEnqueue, view: SweepView = passthroughView(deps.ops)): Promise<string[]> => {
  const lanes = key ? [await deps.registry.read(key)].filter((lane): lane is Lane => lane !== null) : await deps.registry.open();
  const events: string[] = [];
  for (const lane of lanes) {
    const runner = lane.runner ?? machineRunner(lane.machine);
    if (!deps.ops.connected(lane.machine)) {
      if (key && statusOf(lane) === "working") events.push(runnerHeld(lane, runner));
      continue;
    }
    // A paused lane is the owner's to resume; `dori resume` relaunches one whose agent is gone (pause.ts resumeLane).
    if (key && statusOf(lane) === "paused") {
      events.push(`LANE_PAUSED_NOT_RECOVERED ${lane.key} is paused; dori resume ${lane.key} resumes it and relaunches its agent if it is gone`);
      continue;
    }
    events.push(...await relaunchLane(deps, lane, enqueue, view, key !== undefined));
  }
  return events;
};
