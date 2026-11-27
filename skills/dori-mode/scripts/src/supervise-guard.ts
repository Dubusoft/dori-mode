import { type Delivery, type LaneOps } from "./lane-ops.ts";
import type { LaneMemoryBody } from "./runner/protocol.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import type { FlowDeps } from "./done-flow.ts";
import { criticalReasons, type HostSample } from "./host-guard.ts";
import { describeLane, formatKb, type LaneMemory, laneMemoryDetail } from "./lane-memory.ts";
import { pauseLane, type PauseResult } from "./pause.ts";
import type { Lane } from "./registry.ts";
import type { GuardMachine, KillResult, MachineSample } from "./remote-guard.ts";
import { systemText } from "./supervise-loop.ts";
import { errLine } from "./line-text.ts";

/** The machine guard's state file in the supervisor stateDir, so a restart does not re-report unchanged machines. */
export const MACHINE_GUARD_STATE_FILE = "machine-guard.json";

/** A lane lighter than this is never told it uses the most memory. */
export const LANE_WARN_MIN_KB = 1_048_576;

/** A lane warned in its pane is not warned again for this long. */
export const WARN_COOLDOWN_MS = 30 * 60_000;

/**
 * A guard message for a lane, through the lane's runner: a guarded send (nothing pressed when the input line holds
 * someone's text) that the runner refuses while the lane shows a question prompt, whose dialog reads digits, space and
 * 'c' as keys. A refusal, a failed send and an unreachable runner all come back as "failed".
 */
const guardSend = (ops: LaneOps, lane: Lane, text: string): Promise<Delivery> =>
  ops.send(lane, systemText(text), { mode: "guarded", refuseWhileAsking: true });

/**
 * Types a memory warning into the pane of the heaviest lane overall, when that lane is an open local one (remote lanes
 * run on another host's memory) of at least LANE_WARN_MIN_KB and was not warned within WARN_COOLDOWN_MS, so the lane
 * stops what it does not need without the lead relaying it. Returns what happened, for the lead's ALERT line.
 */
export const warnHeaviestLane = async (
  ops: LaneOps, lanes: readonly LaneMemory[], open: readonly Lane[], reason: string,
  warnedAt: Map<string, number> = new Map(), now: () => number = Date.now,
): Promise<string> => {
  const target = lanes[0];
  if (!target) return "no open local lane to warn";
  const lane = open.find((l) => l.key === target.lane && l.pane && !l.machine);
  if (!lane?.pane) return `not typed: heaviest lane ${target.lane} is not open here`;
  if (target.rssKb < LANE_WARN_MIN_KB) return `not typed: heaviest lane ${target.lane} is below ${(LANE_WARN_MIN_KB / 1_048_576).toFixed(1)} GB`;
  const last = warnedAt.get(target.lane);
  if (last !== undefined && now() - last < WARN_COOLDOWN_MS) return `not typed: ${target.lane} was warned ${Math.floor((now() - last) / 60_000)} min ago`;
  const text = `HOST_GUARD memory warning: ${reason} on this host, and this lane (${target.lane}) uses the most memory: ${describeLane(target)}. `
    + "Stop what you are not using now (an emulator, an expo or dev server, a watcher or test runner), then go on with your task. The lead has been told.";
  if (await guardSend(ops, lane, text) === "failed") return `could not warn ${target.lane} in its pane ${lane.pane}`;
  warnedAt.set(target.lane, now());
  return `warned ${target.lane} in its pane ${lane.pane}`;
};

/** A runner's `guard.sample.lanes` as the lane-memory helpers read it (heaviest first, as the runner sent it). */
export const laneMemoryOf = (lanes: readonly LaneMemoryBody[]): LaneMemory[] =>
  lanes.map((l) => ({ lane: l.key, rssKb: l.rssKb, top: l.top.map((c) => ({ ...c })) }));

/**
 * The detail of a new HOST_GUARD ALERT: the heaviest lanes by memory (from the local runner's sample; undefined when
 * the runner sent none) and, when free memory is below its threshold, the warning sent to the heaviest lane. A failure
 * here never costs the ALERT itself.
 */
export const guardAlertDetail = async (
  deps: Pick<FlowDeps, "ops" | "config" | "registry">, sample: HostSample, lanes: readonly LaneMemory[] | undefined,
  warnedAt: Map<string, number> = new Map(), now: () => number = Date.now,
): Promise<string | undefined> => {
  if (!lanes) return undefined;
  try {
    const detail = laneMemoryDetail(lanes);
    const min = deps.config.guard.memFreeMinPct;
    if (sample.memFreePct >= min) return detail;
    const warned = await warnHeaviestLane(deps.ops, lanes, await deps.registry.open(), `memory free ${sample.memFreePct}% < ${min}%`, warnedAt, now);
    return [detail, warned].filter(Boolean).join("; ");
  } catch (e) {
    return `lane memory unreadable: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120)}`;
  }
};

/**
 * What the critical-pressure stage does itself; tests replace it, production uses `pressureIo`. Killing is the
 * runners' (their guard kills under critical memory and reports it in `guard.critical`), so only the pause is left.
 */
export type PressureIo = {
  readonly pause: (lane: Lane, note: string) => Promise<PauseResult>;
};

export const pressureIo = (deps: FlowDeps): PressureIo => ({
  pause: (lane, note) => pauseLane(deps, lane, note),
});


const OWNER = " - tell the owner";

/** Pauses `lane` for critical memory and says how it went; a failure becomes the text, never a throw. */
const pauseForCritical = async (io: PressureIo, lane: Lane | undefined, reasons: readonly string[]): Promise<string> => {
  if (!lane) return "nothing to kill or pause";
  try {
    const res = await io.pause(lane, `memory critical: ${reasons.join(" | ")}`);
    return `paused ${lane.key} (${res.lines.join(" ")})`;
  } catch (e) {
    return `pause of ${lane.key} failed: ${errLine(e, 160)}`;
  }
};

/** Sends the guard notice to each lane through its runner; returns the lanes it could not reach. */
const notifyLanes = async (ops: LaneOps, lanes: readonly Lane[], text: (lane: Lane) => string): Promise<string[]> => {
  const failed: string[] = [];
  for (const lane of lanes) {
    const sent = lane.pane ? await guardSend(ops, lane, text(lane)).catch(() => "failed" as const) : "failed";
    if (sent === "failed") failed.push(lane.key);
  }
  return failed;
};

const notReached = (failed: readonly string[]): string => failed.length ? `; could not notify ${failed.join(", ")}` : "";

const machineTag = (label: string): string => `machine=${label.replace(/\s/g, "_")}`;

/** Whose critical stage: this host (its local runner) or one worker machine. */
export type CriticalScope = { readonly kind: "local" } | { readonly kind: "machine"; readonly machine: GuardMachine };

/** The open lanes with a pane in `scope`: local lanes, or lanes naming the machine by label. */
const lanesIn = (scope: CriticalScope, open: readonly Lane[]): Lane[] => open.filter((l) => l.pane && (scope.kind === "local"
  ? !l.machine
  : l.machine === scope.machine.label));

/**
 * The critical stage of one host, once per guard sweep: this host (`scope.kind` "local", the local runner's sample) or
 * a worker machine. The supervisor kills nothing: `kills` are what that host's runner killed by itself under critical
 * memory (`RunnerGuardBoard.takeKills`, from `guard.critical`); each open lane there is told through its runner. On
 * entering critical with nothing killed it pauses the heaviest open lane there by the runner's per-lane memory
 * (`memory`), else the most recently opened one. `state` holds each scope's critical flag (keyed by runner label).
 * Returns the HOST_GUARD CRITICAL line, or undefined when there is nothing new to say.
 */
export const criticalTick = async (
  deps: Pick<FlowDeps, "ops" | "config">, scope: CriticalScope,
  sample: Pick<MachineSample, "os" | "memFreePct" | "swapFreeGb" | "swapTotalGb">, open: readonly Lane[],
  state: Map<string, boolean>, kills: KillResult, io: PressureIo, memory: readonly LaneMemory[] = [],
): Promise<string | undefined> => {
  const label = scope.kind === "local" ? LOCAL_RUNNER : scope.machine.label;
  // macOS swap files and a system-managed Windows page file grow on demand, so a nearly full swap there is normal;
  // the memory reading decides.
  const reasons = criticalReasons(sample.os === "darwin" || sample.os === "windows" ? { ...sample, swapTotalGb: -1 } : sample, deps.config.guard);
  if (!reasons.length) {
    state.delete(label);
    return undefined;
  }
  const entering = !state.get(label);
  state.set(label, true);
  const where = scope.kind === "local" ? "on this host," : `on machine ${scope.machine.label}, where this lane runs,`;
  const heavy = scope.kind === "local" ? "dori heavy <label> -- <command>" : "~/.dori/runner/bin/dori heavy <label> -- <command>";
  const head = `HOST_GUARD CRITICAL ${scope.kind === "local" ? "" : `${machineTag(label)} `}${reasons.join(" | ")}`;
  const lanes = lanesIn(scope, open);
  let failure = "";
  if (!kills.ok) failure = `kill failed: ${kills.detail.replace(/\s+/g, " ")}`;
  else if (kills.killed.length) {
    const what = kills.killed.map((k) => `${k.cmd} ${formatKb(k.rssKb)} (pid ${k.pid})`).join(", ");
    const failed = await notifyLanes(deps.ops, lanes, () =>
      `HOST_GUARD memory critical: ${reasons.join(" | ")} ${where} so its runner killed ${what} there. `
      + `Do not start it again directly: once memory has recovered, restart it only through ${heavy}, which waits for a free heavy slot.`);
    return `${head}; killed ${what}${notReached(failed)}${OWNER}`;
  }
  if (!entering) return undefined;
  const byKey = new Map(lanes.map((l) => [l.key, l]));
  const heaviest = memory.find((m) => byKey.has(m.lane));
  const newest = [...lanes].sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0))[0];
  const paused = await pauseForCritical(io, heaviest ? byKey.get(heaviest.lane) : newest, reasons);
  return `${head}; ${failure ? `${failure}; ` : ""}${paused}${OWNER}`;
};

/**
 * The warn stage on a worker machine: when it newly enters ALERT with free memory below `guard.memFreeMinPct`, every
 * open lane there gets the memory warning through its runner. Returns the ALERT detail (`warned <keys>`), or undefined.
 */
export const warnMachineLanes = async (
  ops: LaneOps, machine: GuardMachine, sample: MachineSample, open: readonly Lane[], minPct: number,
): Promise<string | undefined> => {
  if (sample.memFreePct < 0 || sample.memFreePct >= minPct) return undefined;
  const lanes = lanesIn({ kind: "machine", machine }, open);
  if (!lanes.length) return undefined;
  const reason = `memory free ${sample.memFreePct}% < ${minPct}%`;
  const failed = await notifyLanes(ops, lanes, (lane) => `HOST_GUARD memory warning: ${reason} on machine ${machine.label}, where this lane (${lane.key}) runs. `
    + "Stop what you are not using now (an emulator, an expo or dev server, a watcher or test runner), then go on with your task. The lead has been told.");
  const warned = lanes.map((l) => l.key).filter((k) => !failed.includes(k));
  return [warned.length ? `warned ${warned.join(", ")}` : "", failed.length ? `could not warn ${failed.join(", ")}` : ""].filter(Boolean).join("; ");
};
