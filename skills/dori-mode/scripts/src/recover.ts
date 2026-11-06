import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database, SQLiteError } from "bun:sqlite";

import { type ArgvTemplate, fillHook } from "./config.ts";
import { closeLane, type FlowDeps, finishedReason } from "./done-flow.ts";
import { LaunchError, laneTabWorkspace, launchLane, startupLine } from "./launch.ts";
import { LaneOpsError, machineRunner } from "./lane-ops.ts";
import { herdrDownSince } from "./runner/herdr-down.ts";
import { passthroughView, SWEEP_SCREEN_LINES, type SweepView } from "./sweep-view.ts";
import { LANE_KEY, type Lane, statusOf } from "./registry.ts";

export const RECOVERY_LIMIT = 3;

/** A pane launched this recently whose model cannot be read yet is still starting, not on a missing model. */
export const STARTUP_GRACE_MS = 60_000;

/** Must resolve only after durable acceptance; retries carry the same journal id. */
export type RecoveryEnqueue = (line: string, id: string) => Promise<void>;

/** Lane record fields recovery keeps (the registry stores whatever the record carries). */
export type RecoveryLane = Lane & {
  /** Every recovery attempt failed; LANE_RECOVERY_EXHAUSTED was sent once. Cleared when the lane is confirmed again. */
  readonly recoveryExhausted?: boolean;
  /** A session a recovery tried to resume and could not; the next attempt starts from the brief. */
  readonly recoveryResumeFailed?: string;
};

/** omo's flag that continues an existing session file or id (`omo --session <path|id>`). */
export const RESUME_FLAG = "--session";

/**
 * The agent command that resumes `session` instead of starting fresh: `--session <id>` before the prompt. Undefined
 * when it cannot (no {prompt} slot, the template already picks a session, or an id that is not a plain token).
 */
export const resumeCommand = (template: ArgvTemplate, session: string | undefined): string[] | undefined => {
  if (!session || !/^[\w.:/-]+$/.test(session) || session.startsWith("-")) return undefined;
  if (template.some((part) => /^--(?:session|session-id|resume|continue|fork)(?:=|$)|^-[rc]$/.test(part))) return undefined;
  const at = template.findIndex((part) => part.includes("{prompt}"));
  return at < 1 ? undefined : [...template.slice(0, at), RESUME_FLAG, session, ...template.slice(at)];
};

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
    const at = argv.indexOf("--model");
    const model = at >= 0 ? argv[at + 1] : argv.find((arg) => arg.startsWith("--model="))?.slice(8);
    if (model) return { omo: true, model };
    omo = true;
  }
  return { omo };
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
  if (!current || statusOf(current) !== "working" || current.pane !== lane.pane || current.model !== lane.model) return [];
  lane = current;
  // The runner closed the replaced pane's tab itself (lane.recover / lane.close); this only confirms it is gone.
  const previous = lane.recoveryPreviousPane;
  const left = previous && previous !== lane.pane && (await deps.ops.panes(lane.machine)).some((pane) => pane.pane_id === previous)
    ? [`LANE_RECOVERY_WARN ${lane.key} the replaced pane ${previous} is still open; close it by hand`] : [];
  await deps.registry.patch<RecoveryLane>(lane.key, { recoveryPending: undefined, recoveryPreviousPane: undefined, recoveryExhausted: undefined });
  const event = `LANE_RECOVERED ${lane.key} ${lane.pane} ${reason}`;
  const hook = deps.config.hooks.threadReply;
  if (hook && lane.thread !== "none") {
    const notice = await deps.run(fillHook(hook, { thread: lane.thread, key: lane.key, title: lane.title, text: event }));
    if (notice.code !== 0) return [event, ...left, `LANE_RECOVERY_NOTICE_ERROR ${lane.key}`];
  }
  return [event, ...left];
};

type Relaunched = { readonly lane: Lane; readonly startup?: string; readonly ok: boolean; readonly resumed: boolean };

/** The runner knows no lane `key` (a lane it never started, or one closed for a replacement that did not start). */
const unknownToRunner = (error: unknown): boolean => error instanceof LaneOpsError && error.code === "LANE_OP_FAILED" && error.detail.includes("RUNNER_LANE_UNKNOWN");

/** Starts the lane again from its brief through its runner (`lane.start`, launchLane with the stored record). */
const startAgain = async (deps: FlowDeps, lane: Lane, stored: RecoveryLane, session: string | undefined): Promise<Relaunched> => {
  const cwd = lane.machine ? lane.remoteCwd : lane.cwd;
  const launched = await launchLane(deps, {
    key: lane.key, title: lane.title, brief: lane.brief, done: lane.done, thread: lane.thread,
    model: lane.model ?? deps.config.defaultModel,
    ...(lane.mode ? { mode: lane.mode } : {}),
    ...(cwd ? { cwd } : {}), ...(lane.machine ? { machine: lane.machine } : {}),
    ...(lane.sandbox ? { sandbox: true as const } : {}),
    ...(session !== undefined ? { session } : {}),
  }, stored);
  return { lane: launched.lane, startup: launched.startup, ok: launched.startup.startsWith("STARTUP_OK "), resumed: session !== undefined };
};

/**
 * A lane whose pane or agent is gone: its runner relaunches it from its own record (`lane.recover`, which closes the
 * dead pane's tab and keeps the lane token's brief and profile). A runner that has no record of the lane starts it anew.
 */
const runnerRecover = async (deps: FlowDeps, lane: Lane, stored: RecoveryLane, session: string | undefined): Promise<Relaunched> => {
  let r;
  try {
    // A local relaunch opens its new tab in the lanes workspace as it is now (herdr may have renumbered it since the start).
    const tabWorkspace = lane.machine ? undefined : await laneTabWorkspace(deps, (line) => { console.error(line); });
    r = await deps.ops.recover(stored, { ...(session !== undefined ? { session } : {}), ...(tabWorkspace ? { tabWorkspace } : {}) });
  } catch (error) {
    if (unknownToRunner(error)) return startAgain(deps, lane, stored, session);
    throw error;
  }
  const moved = await deps.registry.patch<RecoveryLane>(lane.key, { pane: r.pane, ...(r.tab ? { tab: r.tab } : {}) });
  const next: Lane = moved ?? { ...stored, pane: r.pane, ...(r.tab ? { tab: r.tab } : {}) };
  // A live lane the runner left alone: its record had the pane the registry lost.
  if (!r.relaunched) return { lane: next, ok: true, resumed: false };
  const startup = r.startup ? startupLine(lane.key, r.pane, r.startup) : `STARTUP_UNCONFIRMED ${lane.key} ${r.pane}: the runner gave no startup verdict`;
  return { lane: next, startup, ok: r.startup?.verdict === "ok", resumed: r.resumed };
};

const recoverOne = async (deps: FlowDeps, lane: Lane, enqueue: RecoveryEnqueue | undefined, view: SweepView): Promise<string[]> => {
  if (statusOf(lane) !== "working") return [];
  const old = lane.pane ? await view.find(lane) : undefined;
  let reason = "missing-pane";
  if (old) {
    const got = await view.processInfo({ ...lane, pane: old.pane_id });
    if (got.code !== 0) throw new LaunchError(`process-info failed: ${got.err || got.out}`);
    const live = liveModel(JSON.parse(got.out));
    if (!live.omo) return [];
    const expected = lane.model ?? deps.config.defaultModel;
    // argv without a model (a restored session) still runs the expected model when its status bar shows it.
    const model = live.model ?? (barShowsModel(await view.screen({ ...lane, pane: old.pane_id }, SWEEP_SCREEN_LINES), expected) ? expected : undefined);
    if (model && sameModel(model, expected)) {
      if (lane.recoveryPending && (old.agent_status === "working" || old.agent_status === "idle" || old.agent_status === "done")) {
        return finishRecovery(deps, lane, "startup-confirmed");
      }
      return [];
    }
    // The pane in the registry was started by the last recovery, or else by the launch.
    const launchedAt = lane.lastRecoveryAt ?? Date.parse(lane.openedAt);
    if (!model && deps.clock.now() - launchedAt < STARTUP_GRACE_MS) return [];
    reason = model ? "model-mismatch" : "missing-model";
  }
  const read = await deps.registry.read(lane.key);
  if (!read || statusOf(read) !== "working" || read.pane !== lane.pane || read.model !== lane.model) return [];
  const current: RecoveryLane = read;
  // A lane whose work is finished (Done signals hold, PR merged) is never relaunched: close it, or leave it for the close.
  const finished = await finishedReason(deps, current);
  if (finished) {
    const closed = await closeLane(deps, current, `recovery: ${finished}; not relaunched`);
    return [`LANE_RECOVERY_SKIPPED ${lane.key} ${lane.pane ?? "-"} ${reason}: ${finished}; ${closed.closed ? "lane closed" : `not relaunched, left for dori close (${closed.lines.at(-1) ?? "refused"})`}`];
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
  const session = current.recoveryResumeFailed !== current.session && resumeCommand(deps.config.agentCommand, current.session) ? current.session : undefined;
  const pending = (fresh: RecoveryLane): Partial<RecoveryLane> => ({
    ...(session ? {} : { session: undefined, sessionVia: undefined }),
    recoveryAttempts: (fresh.recoveryAttempts ?? 0) + 1, lastRecoveryAt: now, recoveryPending: true,
    ...(old ? { recoveryPreviousPane: old.pane_id } : {}),
  });
  const stored = (await deps.registry.patch<RecoveryLane>(lane.key, pending)) ?? { ...current, ...pending(current) };
  let relaunched: Relaunched;
  if (old) {
    // A live agent on the wrong model: the runner leaves a live lane alone, so the lane is closed and started again.
    await deps.ops.close(stored);
    relaunched = await startAgain(deps, lane, stored, session);
  } else {
    relaunched = await runnerRecover(deps, lane, stored, session);
  }
  if (!relaunched.ok) {
    const startup = relaunched.startup ?? `STARTUP_UNCONFIRMED ${lane.key} -`;
    if (!session) return [startup, `LANE_RECOVERY_ERROR ${lane.key} replacement-unconfirmed`];
    await deps.registry.patch<RecoveryLane>(lane.key, { session: undefined, sessionVia: undefined, recoveryResumeFailed: current.session });
    return [startup, `LANE_RECOVERY_ERROR ${lane.key} replacement-unconfirmed; session ${current.session} not resumed, the next attempt starts from the brief`];
  }
  const why = relaunched.startup ? (relaunched.resumed ? `${reason} session-resumed` : reason) : `${reason} runner-alive`;
  return [...await finishRecovery(deps, relaunched.lane, why), ...(relaunched.startup ? [relaunched.startup] : [])];
};

const relaunchLane = async (deps: FlowDeps, lane: Lane, enqueue: RecoveryEnqueue | undefined, view: SweepView): Promise<string[]> =>
  withRecoveryLock(deps, lane.key, async () => {
    const current = await deps.registry.read(lane.key);
    if (!current || current.pane !== lane.pane || current.model !== lane.model) return [];
    try { return await recoverOne(deps, current, enqueue, view); }
    catch (error) { return [`LANE_RECOVERY_ERROR ${lane.key} ${message(error)}`]; }
  });

/**
 * Legacy callers receive lines; supervisors must pass enqueue to durably accept notices before their flags are saved.
 * A lane whose runner's machine has herdr down (herdr-down.ts) is held: nothing is read, relaunched or counted against
 * its recovery attempts until herdr reads again. The sweep holds it silently (HERDR_DOWN already told the lead); a
 * recovery asked for by key says LANE_RECOVERY_HELD.
 */
export const recoverLanes = async (deps: FlowDeps, key?: string, enqueue?: RecoveryEnqueue, view: SweepView = passthroughView(deps.ops)): Promise<string[]> => {
  const lanes = key ? [await deps.registry.read(key)].filter((lane): lane is Lane => lane !== null) : await deps.registry.open();
  const down = herdrDownSince(deps.config.stateDir);
  const events: string[] = [];
  for (const lane of lanes) {
    const runner = lane.runner ?? machineRunner(lane.machine);
    if (down.has(runner)) {
      if (key && statusOf(lane) === "working") events.push(`LANE_RECOVERY_HELD ${lane.key} herdr is down on machine=${runner.replace(/\s/g, "_")}; recovery resumes once it reads again`);
      continue;
    }
    events.push(...await relaunchLane(deps, lane, enqueue, view));
  }
  return events;
};
