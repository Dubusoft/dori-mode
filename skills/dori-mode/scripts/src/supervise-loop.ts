import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolveCredential } from "./credentials.ts";
import { configPath, deliveryConfigError, saveLeadPane } from "./config.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

import { askUserTick } from "./ask-user.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { type Emit, watchTick, type FlowDeps } from "./done-flow.ts";
import { freshnessTick, scrubForThread } from "./freshness.ts";
import { lookupQuotaResults, quotaReport } from "./claude-quota.ts";
import { recoverLanes, type RecoveryEnqueue } from "./recover.ts";
import { memorySweep } from "./memory-check.ts";
import { alertReasons, criticalReasons, diskGuardPath, type GuardState, guardTick, type HostSample, memIsLow, sampleHost } from "./host-guard.ts";
import { describeLane, formatKb, type LaneMemory, laneMemory, laneMemoryDetail, type Proc, procLanes, sampleProcs } from "./lane-memory.ts";
import { laneRunner, sendGuarded } from "./panes.ts";
import { pauseLane, type PauseResult } from "./pause.ts";
import { describeKilled, heavyTargets, type KilledProc, killProcs } from "./pressure.ts";
import type { Lane } from "./registry.ts";
import {
  type GuardMachine, guardAgentWants, killOnMachine, type KillResult, loadMachineGuardState,
  machineDue, machineGuardTick, type MachineSample, readGuardAgentScripts, readGuardMachines, sampleMachine, saveMachineGuardState,
} from "./remote-guard.ts";

import { run, type Runner, setDefaultRunTimeout } from "./run.ts";
import { canLaunch, clearLaunchHold, launchHeld } from "./routing.ts";
import { machineVerdict, summaryOf } from "./placement.ts";
import { Discord } from "./messenger/discord.ts";
import { acquireDiscordGateway } from "./messenger/discord-lock.ts";
import { supervisorDiscord, type SupervisorDiscordOptions } from "./messenger/discord-supervisor.ts";
import { fetchHttp } from "./messenger/http.ts";
import { postOwnerLine } from "./lane-finish.ts";
import { writeGatewayStatus } from "./gateway-status.ts";
import { lookupStatus } from "./status.ts";
import { OWNER_NOTICE_AFTER_MS, RetryingDelivery, SuperviseError, Supervisor } from "./supervise.ts";
import { Waits } from "./waits.ts";
import { GitHubEvents } from "./github-events.ts";
import { CiFollowUp } from "./ci-follow.ts";
import { newSweepCache, passthroughView, type SweepView, sweepRound } from "./sweep-view.ts";
import { StartupProbe } from "./startup-probe.ts";
import { type BuiltinSource, EventSources, type SourceEnqueue } from "./event-sources.ts";
import { pidAlive, releaseSlot, trySlot } from "./heavy-slot.ts";
import { openOperations, type OperationStore } from "./operations.ts";
import { type LaneReportStore, leadPaneViolationTick, openLaneReports, routeReports } from "./lane-reports.ts";

/** How long the machine guard reuses `herdr machine list` before reading it again. */
const MACHINE_LIST_TTL_MS = 10 * 60_000;
/** After a failed `herdr machine list`, the previous list is kept and the read is retried this much later. */
const MACHINE_LIST_RETRY_MS = 60_000;
/** The machine guard's state file in the supervisor stateDir, so a restart does not re-report unchanged machines. */
export const MACHINE_GUARD_STATE_FILE = "machine-guard.json";

/** Every text the supervisor itself posts to Discord starts with this, so readers can tell it from the lead. */
export const SYSTEM_PREFIX = "[System] ";
export const systemText = (text: string): string => text.startsWith(SYSTEM_PREFIX) ? text : `${SYSTEM_PREFIX}${text}`;

/** One supervisor writer per stateDir, including across competing CLI invocations. */
export const acquireSupervisor = (stateDir: string): (() => void) => {
  mkdirSync(stateDir, { recursive: true });
  // An OS-backed SQLite lock is released even on SIGKILL; a PID file is not.
  const db = new Database(join(stateDir, "supervisor-lock.sqlite"));
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    db.close();
    throw new SuperviseError(`cannot acquire supervisor lock: ${e instanceof Error ? e.message : String(e)}`);
  }
  return () => { db.close(); };
};

/**
 * Tells systemd (Type=notify units) about `state`, e.g. READY=1 or WATCHDOG=1, through systemd-notify. A no-op returning
 * false when NOTIFY_SOCKET is unset; a failure is logged, never thrown.
 */
export const sdNotify = async (state: string, env: Readonly<Record<string, string | undefined>> = process.env, runner: Runner = run): Promise<boolean> => {
  if (!env.NOTIFY_SOCKET) return false;
  try {
    const r = await runner(["systemd-notify", `--pid=${process.pid}`, state], { timeoutMs: 5_000 });
    if (r.code === 0) return true;
    console.error(`SD_NOTIFY_FAILED ${state} ${r.err || r.out || `exit ${r.code}`}`);
  } catch (e) {
    console.error(`SD_NOTIFY_FAILED ${state} ${e instanceof Error ? e.message : String(e)}`);
  }
  return false;
};

/** A background task or the foreground loop showing no progress this long withholds the systemd watchdog. */
export const WATCHDOG_STALL_MS = 15 * 60_000;
/** How often the watchdog is considered, independent of the loop (so one long sweep does not trip WatchdogSec). */
export const WATCHDOG_PET_MS = 60_000;
/**
 * A supervisor task whose current pass has run this long is reported by name (TASK_STALLED) while the other
 * tasks keep running; past WATCHDOG_STALL_MS it withholds the watchdog as task:<name>, so systemd restarts the supervisor.
 */
export const TASK_ALERT_MS = 5 * 60_000;
/** The supervisor's independent tasks. */
export const SUPERVISOR_TASKS = ["inbound", "delivery", "sweeps", "polling"] as const;
export type SupervisorTask = (typeof SUPERVISOR_TASKS)[number];

/**
 * Decides when systemd may be told WATCHDOG=1: only while the foreground loop has made progress (a finished pass, or a
 * finished inline sweep) within WATCHDOG_STALL_MS and no tracked background task (delivery, waits, GitHub, each sweep)
 * has been running longer. A
 * stuck component therefore lets systemd restart the supervisor even though the loop itself keeps turning.
 */
export class Watchdog {
  private last: number;
  private readonly running = new Map<string, number>();
  private withheld?: string;

  constructor(private readonly now: () => number, private readonly notify: (state: string) => Promise<boolean>, private readonly stallMs = WATCHDOG_STALL_MS) {
    this.last = now();
  }

  progress(): void { this.last = this.now(); }

  /** Marks `name` running until `work` settles. */
  track<T>(name: string, work: Promise<T>): Promise<T> {
    this.running.set(name, this.now());
    return work.finally(() => { this.running.delete(name); });
  }

  /** Tracked work whose name starts with `prefix`, with how long it has been running (the supervisor tasks' liveness). */
  busy(prefix: string): readonly (readonly [name: string, ms: number])[] {
    const now = this.now();
    return [...this.running].filter(([name]) => name.startsWith(prefix)).map(([name, since]) => [name, now - since] as const);
  }

  stalled(): string | undefined {
    const now = this.now();
    if (now - this.last >= this.stallMs) return "loop";
    for (const [name, since] of this.running) if (now - since >= this.stallMs) return name;
    return undefined;
  }

  async pet(): Promise<boolean> {
    const stalled = this.stalled();
    if (stalled) {
      if (this.withheld !== stalled) console.error(`WATCHDOG_WITHHELD ${stalled} has made no progress for ${Math.round(this.stallMs / 60_000)} min`);
      this.withheld = stalled;
      return false;
    }
    this.withheld = undefined;
    return this.notify("WATCHDOG=1");
  }
}

/** A lane lighter than this is never told it uses the most memory. */
export const LANE_WARN_MIN_KB = 1_048_576;

/** A lane warned in its pane is not warned again for this long. */
export const WARN_COOLDOWN_MS = 30 * 60_000;

/**
 * Types a memory warning into the pane of the heaviest lane overall, when that lane is an open local one (remote lanes
 * run on another host's memory) of at least LANE_WARN_MIN_KB and was not warned within WARN_COOLDOWN_MS, so the lane
 * stops what it does not need without the lead relaying it. Returns what happened, for the lead's ALERT line.
 */
export const warnHeaviestLane = async (
  run: Runner, lanes: readonly LaneMemory[], open: readonly Lane[], reason: string,
  warnedAt: Map<string, number> = new Map(), now: () => number = Date.now,
): Promise<string> => {
  const target = lanes[0];
  if (!target) return "no open local lane to warn";
  const lane = open.find((l) => l.key === target.lane && l.pane && !l.machine);
  if (!lane?.pane) return `not typed: heaviest lane ${target.lane} is not open here`;
  if (target.rssKb < LANE_WARN_MIN_KB) return `not typed: heaviest lane ${target.lane} is below ${(LANE_WARN_MIN_KB / 1_048_576).toFixed(1)} GB`;
  // The question dialog reads digits, space and 'c' as keys, so typing there could submit an answer nobody chose.
  if (lane.lastAskPrompt) return `not typed: ${target.lane} is on a question prompt`;
  const last = warnedAt.get(target.lane);
  if (last !== undefined && now() - last < WARN_COOLDOWN_MS) return `not typed: ${target.lane} was warned ${Math.floor((now() - last) / 60_000)} min ago`;
  const text = systemText(`HOST_GUARD memory warning: ${reason} on this host, and this lane (${target.lane}) uses the most memory: ${describeLane(target)}. `
    + "Stop what you are not using now (an emulator, an expo or dev server, a watcher or test runner), then go on with your task. The lead has been told.");
  if (await sendGuarded(run, lane.pane, text) !== "sent") return `could not warn ${target.lane} in its pane ${lane.pane}`;
  warnedAt.set(target.lane, now());
  return `warned ${target.lane} in its pane ${lane.pane}`;
};

/**
 * The detail of a new HOST_GUARD ALERT: the heaviest lanes by memory and, when free memory is below its threshold, the
 * warning sent to the heaviest lane. A failure here never costs the ALERT itself.
 */
export const guardAlertDetail = async (
  deps: Pick<FlowDeps, "run" | "config" | "registry">, sample: HostSample, procs: () => Promise<Proc[]> = () => sampleProcs(deps.run),
  warnedAt: Map<string, number> = new Map(), now: () => number = Date.now,
): Promise<string | undefined> => {
  try {
    const lanes = laneMemory(await procs());
    const detail = laneMemoryDetail(lanes);
    const min = deps.config.guard.memFreeMinPct;
    if (sample.memFreePct >= min) return detail;
    const warned = await warnHeaviestLane(deps.run, lanes, await deps.registry.open(), `memory free ${sample.memFreePct}% < ${min}%`, warnedAt, now);
    return [detail, warned].filter(Boolean).join("; ");
  } catch (e) {
    return `lane memory unreadable: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120)}`;
  }
};

/** What the critical-pressure stage reads and does; tests replace these, production uses `pressureIo`. */
export type PressureIo = {
  readonly procs: () => Promise<Proc[]>;
  readonly signal: (pid: number, sig: "SIGTERM" | "SIGKILL") => void;
  readonly alive: (pid: number) => boolean;
  /** The supervisor's own pid: it and its ancestors are never killed. */
  readonly self: number;
  readonly killRemote: (machine: GuardMachine, patterns: readonly string[]) => Promise<KillResult>;
  readonly pause: (lane: Lane, note: string) => Promise<PauseResult>;
};

export const pressureIo = (deps: FlowDeps): PressureIo => ({
  procs: () => sampleProcs(deps.run),
  signal: (pid, sig) => { process.kill(pid, sig); },
  alive: pidAlive,
  self: process.pid,
  killRemote: (machine, patterns) => killOnMachine(deps.run, machine, patterns),
  pause: (lane, note) => pauseLane(deps, lane, note),
});

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);

const OWNER = " - tell the owner";

/** Pauses `lane` for critical memory and says how it went; a failure becomes the text, never a throw. */
const pauseForCritical = async (io: PressureIo, lane: Lane | undefined, reasons: readonly string[]): Promise<string> => {
  if (!lane) return "nothing to kill or pause";
  try {
    const res = await io.pause(lane, `memory critical: ${reasons.join(" | ")}`);
    return `paused ${lane.key} (${res.lines.join(" ")})`;
  } catch (e) {
    return `pause of ${lane.key} failed: ${errText(e)}`;
  }
};

/** Types the kill notice into each pane; returns the lanes it could not reach. */
const notifyKilled = async (run: Runner, lanes: readonly Lane[], text: (lane: Lane) => string): Promise<string[]> => {
  const failed: string[] = [];
  for (const lane of lanes) {
    // As in warnHeaviestLane: typing into a question dialog could submit an answer nobody chose.
    if (lane.lastAskPrompt) { failed.push(lane.key); continue; }
    const sent = lane.pane ? await sendGuarded(laneRunner(run, lane), lane.pane, systemText(text(lane))).catch(() => "failed" as const) : "failed";
    if (sent !== "sent") failed.push(lane.key);
  }
  return failed;
};

const notReached = (failed: readonly string[]): string => failed.length ? `; could not notify ${failed.join(", ")}` : "";

/**
 * The local critical stage, once per guard sweep. While free memory or swap is critically low it kills the open local
 * lanes' processes matching `config.heavyKill` and tells each affected lane in its pane; on entering critical with
 * nothing killed it pauses the heaviest open local lane. Returns the HOST_GUARD CRITICAL line, or undefined when there
 * is nothing new to say (not critical, or still critical with nothing new to kill).
 */
export const localCriticalTick = async (
  deps: Pick<FlowDeps, "run" | "config" | "registry" | "clock">, sample: HostSample, state: { critical: boolean }, io: PressureIo,
): Promise<string | undefined> => {
  const reasons = criticalReasons(sample, deps.config.guard);
  if (!reasons.length) {
    state.critical = false;
    return undefined;
  }
  const entering = !state.critical;
  state.critical = true;
  const head = `HOST_GUARD CRITICAL ${reasons.join(" | ")}`;
  let local: Lane[] = [];
  let procs: Proc[] = [];
  let failure = "";
  let attempted = false;
  try {
    local = (await deps.registry.open()).filter((l) => l.pane && !l.machine);
    procs = await io.procs();
    const targets = heavyTargets(procs, deps.config.heavyKill, new Set(local.map((l) => l.key)), io.self);
    if (targets.length) {
      attempted = true;
      const killed = await killProcs(targets, { clock: deps.clock, alive: io.alive, signal: io.signal }, procLanes(procs));
      if (killed.length) {
        const byLane = new Map<string, KilledProc[]>();
        for (const k of killed) if (k.lane) byLane.set(k.lane, [...byLane.get(k.lane) ?? [], k]);
        const failed = await notifyKilled(deps.run, local.filter((l) => byLane.has(l.key)), (lane) =>
          `HOST_GUARD memory critical: ${reasons.join(" | ")} on this host, so the supervisor killed ${describeKilled(byLane.get(lane.key) ?? [])} in this lane. `
          + "Do not start it again directly: once memory has recovered, restart it only through dori heavy (dori heavy <label> -- <command>), which waits for a free heavy slot.");
        return `${head}; killed ${describeKilled(killed)}${notReached(failed)}${OWNER}`;
      }
    }
  } catch (e) {
    failure = `kill failed: ${errText(e)}`;
  }
  if (!entering) return failure && attempted ? `${head}; ${failure}${OWNER}` : undefined;
  const open = new Map(local.map((l) => [l.key, l]));
  const heaviest = laneMemory(procs).find((m) => open.has(m.lane));
  const paused = await pauseForCritical(io, heaviest && open.get(heaviest.lane), reasons);
  return `${head}; ${failure ? `${failure}; ` : ""}${paused}${OWNER}`;
};

const machineTag = (label: string): string => `machine=${label.replace(/\s/g, "_")}`;

/**
 * The critical stage for one worker machine: kills its processes matching `config.heavyKill` through the guard agent
 * and tells every open lane there; on entering critical with nothing killed it pauses the most recently opened lane
 * there. `state` holds each machine's critical flag. Returns the HOST_GUARD CRITICAL line, or undefined.
 */
export const machineCriticalTick = async (
  deps: Pick<FlowDeps, "run" | "config">, machine: GuardMachine, sample: MachineSample, open: readonly Lane[],
  state: Map<string, boolean>, io: PressureIo,
): Promise<string | undefined> => {
  // macOS swap files and a system-managed Windows page file grow on demand, so a nearly full swap there is normal;
  // the memory reading decides.
  const reasons = criticalReasons(sample.os === "darwin" || sample.os === "windows" ? { ...sample, swapTotalGb: -1 } : sample, deps.config.guard);
  if (!reasons.length) {
    state.delete(machine.label);
    return undefined;
  }
  const entering = !state.get(machine.label);
  state.set(machine.label, true);
  const head = `HOST_GUARD CRITICAL ${machineTag(machine.label)} ${reasons.join(" | ")}`;
  const lanes = open.filter((l) => l.pane && l.machine !== undefined && (l.machine === machine.label || l.machine === machine.id));
  let failure = "";
  try {
    const res = await io.killRemote(machine, deps.config.heavyKill);
    if (!res.ok) failure = `kill failed: ${res.detail.replace(/\s+/g, " ")}`;
    else if (res.killed.length) {
      const what = res.killed.map((k) => `${k.cmd} ${formatKb(k.rssKb)} (pid ${k.pid})`).join(", ");
      const failed = await notifyKilled(deps.run, lanes, () =>
        `HOST_GUARD memory critical: ${reasons.join(" | ")} on machine ${machine.label}, where this lane runs, so the supervisor killed ${what} there. `
        + `Do not start it again directly: once memory has recovered, restart it only through sh ~/.dori/guard-agent.sh heavy <label> -- <command>, which waits for a free heavy slot.`);
      return `${head}; killed ${what}${notReached(failed)}${OWNER}`;
    }
  } catch (e) {
    failure = `kill failed: ${errText(e)}`;
  }
  if (!entering) return undefined;
  const newest = [...lanes].sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0))[0];
  const paused = await pauseForCritical(io, newest, reasons);
  return `${head}; ${failure ? `${failure}; ` : ""}${paused}${OWNER}`;
};

/**
 * The warn stage on a worker machine: when it newly enters ALERT with free memory below `guard.memFreeMinPct`, every
 * open lane there gets the memory warning in its pane. Returns the ALERT detail (`warned <keys>`), or undefined.
 */
export const warnMachineLanes = async (
  run: Runner, machine: GuardMachine, sample: MachineSample, open: readonly Lane[], minPct: number,
): Promise<string | undefined> => {
  if (sample.memFreePct < 0 || sample.memFreePct >= minPct) return undefined;
  const lanes = open.filter((l) => l.pane && l.machine !== undefined && (l.machine === machine.label || l.machine === machine.id));
  if (!lanes.length) return undefined;
  const reason = `memory free ${sample.memFreePct}% < ${minPct}%`;
  const failed = await notifyKilled(run, lanes, (lane) => `HOST_GUARD memory warning: ${reason} on machine ${machine.label}, where this lane (${lane.key}) runs. `
    + "Stop what you are not using now (an emulator, an expo or dev server, a watcher or test runner), then go on with your task. The lead has been told.");
  const warned = lanes.map((l) => l.key).filter((k) => !failed.includes(k));
  return [warned.length ? `warned ${warned.join(", ")}` : "", failed.length ? `could not warn ${failed.join(", ")}` : ""].filter(Boolean).join("; ");
};

/** A named sweep. It may hand lines over itself through `emit` (as they happen) and/or return them. */
export type Sweep = readonly [name: string, step: (emit: Emit) => Promise<readonly string[]>];

/** The same warning line is enqueued at most once per hour; the console still logs every failure. */
export const WARN_REPEAT_MS = 60 * 60_000;

/** How often the watcher also walks the closed lanes in the archive (their kept-worktree cleanup). */
export const ARCHIVE_SWEEP_MS = 10 * 60_000;

/**
 * The supervisor's sweeps over one long-lived state (guard transitions, dead-pane memory, pane read cache). The first
 * sweep takes the round's pane snapshot; every later sweep of the round observes panes through it.
 */
export const supervisorSweeps = (
  deps: FlowDeps, home: string, enqueueRecovery?: RecoveryEnqueue,
  laneReports: () => LaneReportStore | undefined = () => undefined,
  io: PressureIo = pressureIo(deps),
): readonly Sweep[] => {
  const guard: GuardState = { alerting: false };
  const critical = { critical: false };
  const machineCritical = new Map<string, boolean>();
  const warnedAt = new Map<string, number>();
  const machineGuardPath = join(deps.config.stateDir, MACHINE_GUARD_STATE_FILE);
  const machineGuard = loadMachineGuardState(machineGuardPath);
  // The saved machines change rarely: re-listed every MACHINE_LIST_TTL_MS, so a steady round adds no herdr call.
  let guardMachines: { readonly at: number; readonly list: GuardMachine[] } | undefined;
  const seen = new Set<string>();
  const dead = newDeadPaneState();
  const cache = newSweepCache();
  let view: SweepView = passthroughView(deps.run);
  let lastArchive = -Infinity;
  return [
    ["snapshot", async () => {
      view = passthroughView(deps.run);
      // A bad deadline warns every round and the sweeps read per lane.
      if (!Number.isFinite(deps.config.sweepMachineDeadlineMs) || deps.config.sweepMachineDeadlineMs <= 0) throw new SuperviseError("sweepMachineDeadlineMs must be positive");
      view = await sweepRound(deps.run, cache, await deps.registry.open(), { now: deps.clock.now, deadlineMs: deps.config.sweepMachineDeadlineMs });
      return [];
    }],
    ["watch", async (emit) => {
      const archived = deps.clock.now() - lastArchive >= ARCHIVE_SWEEP_MS;
      await watchTick(deps, emit, view, archived);
      if (archived) lastArchive = deps.clock.now();
      return [];
    }],
    ["guard", async (emit) => {
      const sample = await sampleHost(deps.run, diskGuardPath(deps.config), () => view.panes().then((panes) => panes.length, () => -1));
      const memJustLow = memIsLow(sample, deps.config.guard, guard.memLow) && !guard.memLow;
      const detail = (memJustLow || (!guard.alerting && alertReasons(sample, deps.config.guard).length)) ? await guardAlertDetail(deps, sample, undefined, warnedAt, deps.clock.now) : undefined;
      for (const line of guardTick(sample, deps.config.guard, guard, detail)) await emit(line);
      const criticalLine = await localCriticalTick(deps, sample, critical, io);
      if (criticalLine) await emit(criticalLine);
      // Work queued on a HOLD from `dori can-launch` resumes on this, whichever host threshold kept it held. An
      // unreadable pane count (-1) proves no room.
      if (sample.panes >= 0 && launchHeld(deps.config.stateDir) && canLaunch(sample, deps.config.guard).ok) {
        await emit(`LAUNCH_READY the host has room again (load ${sample.load1.toFixed(0)}, memory free ${sample.memFreePct}%, disk free ${sample.diskFreeGb.toFixed(0)} GB, panes ${sample.panes}); start the held work after dori can-launch`);
        clearLaunchHold(deps.config.stateDir);
      }
      return [];
    }],
    ["dead-panes", async () => deadPaneTick(deps.run, deps.config, seen, new Date(deps.clock.now()).toISOString().slice(0, 13), dead, await deps.registry.open(), view, deps.clock.now)],
    // Recovery notices are journaled with stable ids before recover saves the flags that suppress them.
    ["recover", async () => recoverLanes(deps, undefined, enqueueRecovery, view)],
    ["freshness", async () => (await freshnessTick(deps, home, view, laneReports())).map((act) => `${act.kind.toUpperCase()} ${act.lane} ${act.detail}`)],
    // A lane asking through its agent's on-screen question UI instead of dori report: one urgent LANE_ASKING per question.
    ["ask-user", async (emit) => { await askUserTick(deps, emit, view); return []; }],
    ["memory", async () => memorySweep(deps, home)],
    // Counts [REPORT] lines of `dori report` lanes found in the lead's pane; reads nothing while no such lane is open.
    ["lead-pane", async (emit) => { await leadPaneViolationTick(deps, emit); return []; }],
    // Last, so a slow or unreachable worker machine never delays the pane reads of the sweeps before it. A machine
    // whose sample failed waits out its backoff instead of costing an ssh timeout every round.
    ["machine-guard", async (emit) => {
      const now = deps.clock.now();
      if (!guardMachines || now - guardMachines.at >= MACHINE_LIST_TTL_MS) {
        const listed = await readGuardMachines(deps.run, deps.config.guardMachines);
        if (listed.ok) guardMachines = { at: now, list: listed.machines };
        else {
          guardMachines = { at: now - MACHINE_LIST_TTL_MS + MACHINE_LIST_RETRY_MS, list: guardMachines?.list ?? listed.machines };
          await emit(`SWEEP_WARN machine-guard herdr machine list failed: ${listed.detail}`);
        }
      }
      const due = guardMachines.list.filter((m) => machineDue(machineGuard, m.label, now));
      if (!due.length) return [];
      const results = await Promise.all(due.map(async (machine) => ({ machine, result: await sampleMachine(deps.run, machine) })));
      const want = guardAgentWants(await readGuardAgentScripts());
      const open = await deps.registry.open();
      // Lane memory is read from this host's /proc, so a machine's ALERT names the lanes running there instead.
      // A machine newly in ALERT for low memory warns its lanes first, so its ALERT line can say so.
      const warned = new Map<string, string>();
      await Promise.all(results.map(async ({ machine, result }) => {
        if (!result.ok || machineGuard.get(machine.label)?.alerting) return;
        const note = await warnMachineLanes(deps.run, machine, result.sample, open, deps.config.guard.memFreeMinPct).catch((e) => `warning failed: ${errText(e)}`);
        if (note) warned.set(machine.label, note);
      }));
      const lanesOn = (m: GuardMachine): string | undefined => {
        const keys = open.filter((l) => l.machine !== undefined && (l.machine === m.label || l.machine === m.id)).map((l) => l.key);
        return [keys.length ? `lanes on this machine: ${keys.join(", ")}` : "", warned.get(m.label) ?? ""].filter(Boolean).join("; ") || undefined;
      };
      const lines = machineGuardTick(results, deps.config.guard, want, machineGuard, lanesOn, now);
      try {
        for (const line of lines) await emit(line);
        // A machine held by `dori can-launch --machine` or a queued launch resumes the same way, from this round's pane list.
        for (const { machine: { label }, result } of results) {
          if (!result.ok || !launchHeld(deps.config.stateDir, label)) continue;
          const panes = await view.panes(label).then((p) => p.length, () => -1);
          if (!machineVerdict(result, panes, deps.config.guard, label).ok) continue;
          await emit(`LAUNCH_READY machine=${label} the machine has room again (${summaryOf(result.sample.memFreePct, result.sample.diskFreeGb, panes)}); start the held work after dori can-launch --machine ${label}`);
          clearLaunchHold(deps.config.stateDir, label);
        }
        const criticalLines = await Promise.all(results.map(({ machine, result }) =>
          result.ok ? machineCriticalTick(deps, machine, result.sample, open, machineCritical, io) : Promise.resolve(undefined)));
        for (const line of criticalLines) if (line) await emit(line);
      } finally {
        saveMachineGuardState(machineGuardPath, machineGuard);
      }
      return [];
    }],
  ];
};

/**
 * Runs each sweep on its own. Lines are enqueued as each sweep produces them, so a later failure cannot drop them,
 * and a sweep that throws costs only its own remaining lines: it becomes one digest warning (LANE_WATCH_WARN for the
 * watcher, SWEEP_WARN <name> otherwise) and the next sweep still runs. Nothing here ends the supervisor.
 */
export const runSweeps = async (sweeps: readonly Sweep[], emit: Emit, now: () => number, recent: Map<string, number>, log: (line: string) => void): Promise<void> => {
  const put: Emit = async (line, id, meta) => {
    if (/^\S*_WARN\b/.test(line)) {
      for (const [seen, at] of recent) if (now() - at >= WARN_REPEAT_MS) recent.delete(seen);
      const last = recent.get(line);
      if (last !== undefined && now() - last < WARN_REPEAT_MS) return;
      recent.set(line, now());
    }
    await emit(line, id, meta);
  };
  for (const [name, step] of sweeps) {
    try {
      for (const line of await step(put)) await put(line);
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
      log(`SWEEP_ERROR ${name} ${message}`);
      try { await put(name === "watch" ? `LANE_WATCH_WARN ${message}` : `SWEEP_WARN ${name} ${message}`); }
      catch (w) { log(`SWEEP_WARN_LOST ${name} ${w instanceof Error ? w.message : String(w)}`); }
    }
  }
};

/** How supervise() waits between passes; tests inject one that waits for the test instead of real time. */
export type Pause = (ms: number, signal: AbortSignal) => Promise<void>;

/** Resolves after `ms`, or at once when `signal` aborts. */
const pause: Pause = (ms, signal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  if (signal.aborted) done();
});

/**
 * Polling and sweeps enqueue independently of the single serialized lead delivery. There is no single loop: inbound,
 * delivery (with the owner notices and ack ticks), sweeps and GitHub/wait polling each run as their own task, so none
 * waits behind another; a stuck one is reported by name (TASK_STALLED) while the other three keep working, and each sweep
 * is tracked by the watchdog. Each startup step up to READY=1 is timed by `probe` (STARTUP_TIMINGS, STARTUP_SLOW <step>),
 * so a hang names its step, and each task's first pass is reported as `first-<task>` (`first-sweep` for the sweeps).
 */
export const supervise = async (
  deps: FlowDeps, signal: AbortSignal, discordOptions: Partial<Omit<SupervisorDiscordOptions, "emit">> = {},
  notify: (state: string) => Promise<boolean> = sdNotify, probe = new StartupProbe(), wait: Pause = pause,
): Promise<void> => {
  if (!deps.config.leadPane) throw new SuperviseError("supervise requires leadPane");
  if (!Number.isFinite(deps.config.cacheTtlMin) || deps.config.cacheTtlMin <= 0) throw new SuperviseError("cacheTtlMin must be positive");
  if (!Number.isFinite(deps.config.leadContextCapTokens) || deps.config.leadContextCapTokens <= 0) throw new SuperviseError("leadContextCapTokens must be positive");
  if (!Number.isFinite(deps.config.leadContextHardCapTokens) || deps.config.leadContextHardCapTokens <= 0) throw new SuperviseError("leadContextHardCapTokens must be positive");
  if (!Number.isFinite(deps.config.githubPollSeconds) || deps.config.githubPollSeconds <= 0) throw new SuperviseError("githubPollSeconds must be positive");
  if (!Number.isFinite(deps.config.githubTimeoutMs) || deps.config.githubTimeoutMs <= 0) throw new SuperviseError("githubTimeoutMs must be positive");
  if (!Number.isFinite(deps.config.discordSafetyPollSeconds) || deps.config.discordSafetyPollSeconds <= 0) throw new SuperviseError("discordSafetyPollSeconds must be positive");
  if (!Number.isFinite(deps.config.digestMaxDelayMin) || deps.config.digestMaxDelayMin <= 0) throw new SuperviseError("digestMaxDelayMin must be positive");
  if (!Number.isFinite(deps.config.ackTimeoutSec) || deps.config.ackTimeoutSec <= 0) throw new SuperviseError("ackTimeoutSec must be positive");
  if (!Number.isFinite(deps.config.runTimeoutMs) || deps.config.runTimeoutMs < 0) throw new SuperviseError("runTimeoutMs must be zero or positive");
  if (!Number.isFinite(deps.config.handledTimeoutMin) || deps.config.handledTimeoutMin <= 0) throw new SuperviseError("handledTimeoutMin must be positive");
  if (!Number.isFinite(deps.config.reportTimeoutMin) || deps.config.reportTimeoutMin <= 0) throw new SuperviseError("reportTimeoutMin must be positive");
  if (!Number.isFinite(deps.config.resolveTimeoutMin) || deps.config.resolveTimeoutMin <= 0) throw new SuperviseError("resolveTimeoutMin must be positive");
  if (!Number.isFinite(deps.config.leadStuckRestartMin) || deps.config.leadStuckRestartMin <= 0) throw new SuperviseError("leadStuckRestartMin must be positive");
  if (!Number.isFinite(deps.config.leadChildWaitMaxMin) || deps.config.leadChildWaitMaxMin <= 0) throw new SuperviseError("leadChildWaitMaxMin must be positive");
  if (!Number.isFinite(deps.config.leadUnreadRestartMin) || deps.config.leadUnreadRestartMin <= 0) throw new SuperviseError("leadUnreadRestartMin must be positive");
  if (!Number.isInteger(deps.config.waitMaxFailures) || deps.config.waitMaxFailures <= 0) throw new SuperviseError("waitMaxFailures must be a positive integer");
  const deliveryProblem = deliveryConfigError(deps.config.delivery);
  if (deliveryProblem) throw new SuperviseError(deliveryProblem);
  setDefaultRunTimeout(deps.config.runTimeoutMs);
  let release: (() => void) | undefined;
  let ready = false;
  let releaseGateway: (() => void) | undefined;
  let inbound: ReturnType<typeof supervisorDiscord> | undefined;
  let sources: EventSources | undefined;
  let scheduleOps: OperationStore | undefined;
  let reports: LaneReportStore | undefined;
  const watchdog = new Watchdog(deps.clock.now, notify);
  let petting: ReturnType<typeof setInterval> | undefined;
  const stop = new AbortController();
  let tasks: Promise<unknown> | undefined;
  let ci: CiFollowUp | undefined;
  try {
    release = probe.step("lock", () => acquireSupervisor(deps.config.stateDir));
    const token = discordOptions.token ?? probe.step("credential", () => resolveCredential("DORI_DISCORD_TOKEN"));
    if (!token) throw new SuperviseError("supervise requires DORI_DISCORD_TOKEN for lossless paginated Discord polling");
    releaseGateway = probe.step("gateway-lock", () => acquireDiscordGateway(token));
    const discord = new Discord(fetchHttp, deps.clock, token);
    // An owner notice goes where the message came from: its Discord channel or thread.
    const ownerNotice = async (channel: string, text: string, id: string): Promise<void> => {
      await discord.send(channel, systemText(text), id);
    };
    // Resolved once: the file this process loaded (DORI_CONFIG or ~/.dori/config.json).
    const loadedConfig = configPath();
    const supervisor = probe.step("supervisor", () => new Supervisor(deps, {
      react: (op, channel, message, emoji) => op === "add" ? discord.react(channel, message, emoji) : discord.unreact(channel, message, emoji),
      persistLeadPane: (pane) => { saveLeadPane(loadedConfig, pane); },
      announce: async (text, id, thread) => { await postOwnerLine(discord, deps.config.discordChannels[0], thread, systemText(text), id); },
    }));
    // Every built-in enqueues through the source registry, which records its last event and errors. The schedule sources
    // run too, each run an operation row; a heavy job takes a heavy slot like `dori heavy`, without waiting for one.
    const ops = scheduleOps = probe.step("schedules", () => openOperations(deps.config));
    const heavyLoad = async (): Promise<number> => (await sampleHost(deps.run, diskGuardPath(deps.config))).load1;
    const registry = sources = new EventSources({
      stateDir: deps.config.stateDir, enqueue: (id, line, meta) => supervisor.enqueue(id, line, meta), now: deps.clock.now, run: deps.run,
      policy: deps.config.eventPolicy, log: (line) => { console.error(line); },
      schedules: {
        operations: ops, journaled: (id: string) => supervisor.journaled(id),
        heavy: {
          take: async (label: string) => (await trySlot({
            dir: join(deps.config.stateDir, "heavy"), slots: deps.config.heavySlots, maxLoad: deps.config.heavyMaxLoad, clock: deps.clock,
            load: heavyLoad, alive: pidAlive, pid: process.pid,
          }, label)) ?? undefined,
          release: releaseSlot,
        },
      },
    });
    const enqueueOf = (name: BuiltinSource): SourceEnqueue => registry.enqueueFor(name);
    const guarded = <T>(name: BuiltinSource, work: Promise<T>): Promise<T> => registry.guard(name, work);
    const enqueueSweep = enqueueOf("sweeps");
    const enqueueWait = enqueueOf("waits");
    const enqueueGitHub = enqueueOf("github");
    const enqueueDiscord = enqueueOf("discord");
    const waits = probe.step("waits", () => new Waits(deps.config.stateDir, deps.config.waitMaxFailures));
    const github = probe.step("github", () => new GitHubEvents(deps.config.stateDir, deps.config.store, deps.clock.now));
    const follow = ci = probe.step("ci-follow", () => new CiFollowUp(deps));
    // CI follow-up reads the poll it follows, so it runs right after each GitHub tick.
    const pollGithub = async (): Promise<void> => {
      await github.tick(deps, enqueueGitHub);
      await follow.tick(github.openPulls(), enqueueGitHub, github.mergedPulls());
    };
    const home = process.env.HOME ?? "";
    // The sweep task gets its own span, so its timings never mix into the startup report.
    const sweepProbe = probe.span();
    // Each sweep is tracked: one stuck past WATCHDOG_STALL_MS withholds the watchdog.
    // The watcher reads its claim announcements back from the journal.
    const sweeps = supervisorSweeps({ ...deps, leadDelivered: (id) => supervisor.leadDelivered(id) }, home, async (line, id) => { enqueueSweep(id, line); }, () => reports).map(([name, step]): Sweep => [name, async (emit) =>
      watchdog.track(`sweep:${name}`, sweepProbe.step(`loop:sweep:${name}`, () => step(emit)))]);
    const recentWarnings = new Map<string, number>();
    const boot = randomUUID();
    const retry = new RetryingDelivery({
      now: deps.clock.now,
      flush: () => supervisor.flush(),
      repair: () => supervisor.repairLeadPane(),
      enqueue: (id, line) => supervisor.enqueue(id, line),
      notify: async (text) => {
        const channel = deps.config.discordChannels[0];
        if (!channel) throw new Error("no discordChannels configured");
        await discord.send(channel, systemText(text));
      },
      log: (line) => { console.error(line); },
    }, boot);
    let sequence = 0;
    let deliveryError: unknown;
    const emit = async (id: string, line: string): Promise<void> => { enqueueDiscord(id, line); };
    const discordInbound = probe.step("inbound", () => supervisorDiscord(deps, {
      ...discordOptions, token, emit,
      http: discordOptions.http ?? ((request) => fetchHttp({
        ...request, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      })),
      lookup: discordOptions.lookup ?? quotaReport(lookupQuotaResults()),
      // The lead pane is read per request: a pane recreated after startup is in the supervisor, not in deps.
      statusLookup: discordOptions.statusLookup ?? ((lookupSignal, page) =>
        lookupStatus({ ...deps, config: { ...deps.config, leadPane: supervisor.leadPane } })(lookupSignal, page)),
    }));
    inbound = discordInbound;
    const heartbeat = (): void => {
      try {
        const gateway = inbound?.state() ?? { connected: false, messageContent: false };
        writeGatewayStatus(deps.config.stateDir, { pid: process.pid, at: deps.clock.now(), ...gateway });
      } catch (e) {
        console.error(`GATEWAY_STATUS_ERROR ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const sweep = async (): Promise<void> => {
      const failed: string[] = [];
      await runSweeps(sweeps, async (line, id, meta) => { enqueueSweep(id ?? `sweep:${boot}:${sequence++}`, line, meta); }, deps.clock.now, recentWarnings, (line) => {
        console.error(line);
        if (line.startsWith("SWEEP_ERROR ")) failed.push(line.slice("SWEEP_ERROR ".length));
      });
      if (failed.length) registry.fail("sweeps", failed.join("; "));
      else registry.ok("sweeps");
    };
    // Lane reports are routed in the 5 s polling pass, so a question reaches the lead within one pass and one delivery
    // tick of being written.
    const reportStore = reports = probe.step("lane-reports", () => openLaneReports(deps.config));
    const routeLaneReports = (): Promise<void> => watchdog.track("reports", routeReports(deps, reportStore, enqueueSweep, home))
      .then((lines) => { for (const line of lines) console.log(line); })
      .catch((e: unknown) => { console.error(`LANE_REPORTS_ERROR ${e instanceof Error ? e.message : String(e)}`); });
    const tickSources = (): Promise<void> => watchdog.track("sources", registry.tick())
      .catch((e: unknown) => { console.error(`SOURCES_ERROR ${e instanceof Error ? e.message : String(e)}`); });
    // An owner message the lead has not taken within a minute gets one plain line in its own channel or thread.
    const noticeOverdue = async (): Promise<void> => {
      let due: ReturnType<typeof supervisor.overdueOwnerMessages>;
      try { due = supervisor.overdueOwnerMessages(OWNER_NOTICE_AFTER_MS); }
      catch (e) { console.error(`OWNER_NOTICE_ERROR ${e instanceof Error ? e.message : String(e)}`); return; }
      for (const { channel, message } of due) {
        try {
          supervisor.noticeAttempt("delay", channel, message);
          await ownerNotice(channel, deps.config.ownerDelayNotice, `delay:${channel}:${message}`);
          supervisor.noticeSent("delay", channel, message);
        }
        catch (e) { console.error(`OWNER_NOTICE_FAILED ${channel}/${message}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    };
    // A message the lead was handed but never acked is re-pushed, and after a second window the owner gets one line.
    const noticeUnacked = async (): Promise<void> => {
      let due: ReturnType<typeof supervisor.ackTick>;
      try { due = supervisor.ackTick(deps.config.ackTimeoutSec * 1_000); }
      catch (e) { console.error(`ACK_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); return; }
      for (const { channel, message } of due) {
        console.log(`ACK_MISSING_NOTICE ${channel}/${message}`);
        try {
          supervisor.noticeAttempt("ack", channel, message);
          await ownerNotice(channel, deps.config.ackMissingNotice, `ack:${channel}:${message}`);
          supervisor.noticeSent("ack", channel, message);
        }
        catch (e) { console.error(`ACK_NOTICE_FAILED ${channel}/${message}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    };
    // A message the lead acked but never linked to lanes or a reply: UNHANDLED wakes it, then the owner gets one line.
    const noticeUnhandled = async (): Promise<void> => {
      let due: ReturnType<typeof supervisor.handledTick>;
      try { due = supervisor.handledTick(deps.config.handledTimeoutMin * 60_000); }
      catch (e) { console.error(`HANDLED_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); return; }
      for (const { channel, message } of due) {
        console.log(`UNHANDLED_NOTICE ${channel}/${message}`);
        try {
          supervisor.noticeAttempt("unhandled", channel, message);
          await ownerNotice(channel, deps.config.unhandledNotice, `unhandled:${channel}:${message}`);
          supervisor.noticeSent("unhandled", channel, message);
        }
        catch (e) { console.error(`UNHANDLED_NOTICE_FAILED ${channel}/${message}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    };
    // A finished lane the lead did not report to the owner (dori reported) in time: UNREPORTED wakes the lead. The
    // supervisor never tells the owner itself.
    const checkReported = async (): Promise<void> => {
      try { await supervisor.reportTick(); }
      catch (e) { console.error(`REPORT_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); }
      // A decision event the lead did not close (dori resolved) in time: UNRESOLVED wakes the lead.
      try { supervisor.resolveTick(); }
      catch (e) { console.error(`RESOLVE_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); }
    };
    let lastGitHub = -Infinity;
    console.log(`SUPERVISOR_READY ${supervisor.eventLog}`);
    await probe.step("ready", () => notify("READY=1"));
    ready = true;
    probe.report("ready");
    petting = setInterval(() => { void watchdog.pet(); }, WATCHDOG_PET_MS);
    // Each task is its own loop, so one stuck pass costs only that task. Every pass is tracked as task:<name>: the
    // loop below reports one running past TASK_ALERT_MS by name, and past WATCHDOG_STALL_MS it withholds the watchdog.
    const halted = AbortSignal.any([signal, stop.signal]);
    const task = (name: SupervisorTask, pauseMs: number, pass: () => Promise<void>): Promise<void> => (async () => {
      const span = name === "sweeps" ? undefined : probe.span();
      while (!halted.aborted) {
        // The pass starts only once task:<name> is tracked, so the watchdog names the task before any work it tracks inside.
        try { await watchdog.track(`task:${name}`, Promise.resolve().then(() => span?.active ? span.step(`task:${name}`, pass) : pass())); }
        catch (e) { console.error(`TASK_ERROR ${name} ${e instanceof Error ? e.message : String(e)}`); }
        if (span?.active) {
          span.report(`first-${name}`);
          span.close();
        }
        await wait(pauseMs, halted);
      }
    })();
    tasks = Promise.all([
      task("inbound", 5_000, async () => {
        try { await guarded("discord", discordInbound.tick()); } catch (e) { console.error(`INBOUND_ERROR ${e instanceof Error ? e.message : String(e)}`); }
        heartbeat();
      }),
      task("delivery", 5_000, async () => {
        await noticeOverdue();
        await noticeUnacked();
        await noticeUnhandled();
        await checkReported();
        if (!retry.due) return;
        // A fatal delivery error ends the supervisor, as in the loop.
        try { await watchdog.track("delivery", retry.tick()); } catch (e) { deliveryError = e; stop.abort(); }
      }),
      task("sweeps", 30_000, () => sweep()
        .catch((e: unknown) => { console.error(`SWEEP_ROUND_ERROR ${e instanceof Error ? e.message : String(e)}`); })
        .finally(() => {
          if (sweepProbe.active) {
            sweepProbe.report("first-sweep");
            sweepProbe.close();
          }
        })),
      task("polling", 5_000, async () => {
        const polls = [watchdog.track("waits", guarded("waits", waits.tick(deps.clock.now, deps.run, enqueueWait)))
          .catch((e: unknown) => { console.error(`WAIT_ERROR ${e instanceof Error ? e.message : String(e)}`); })];
        if (deps.clock.now() - lastGitHub >= deps.config.githubPollSeconds * 1_000) {
          lastGitHub = deps.clock.now();
          polls.push(watchdog.track("github", guarded("github", pollGithub()))
            .catch((e: unknown) => { console.error(`GITHUB_ERROR ${e instanceof Error ? e.message : String(e)}`); }));
        }
        polls.push(tickSources(), routeLaneReports());
        await Promise.all(polls);
      }),
    ]);
    probe.close();
    const stalled = new Set<string>();
    while (!halted.aborted) {
      const busy = new Map(watchdog.busy("task:"));
      for (const name of stalled) {
        if ((busy.get(name) ?? 0) >= TASK_ALERT_MS) continue;
        stalled.delete(name);
        console.log(`TASK_RECOVERED ${name.slice("task:".length)}`);
      }
      for (const [name, ms] of busy) {
        if (ms < TASK_ALERT_MS || stalled.has(name)) continue;
        stalled.add(name);
        const which = name.slice("task:".length);
        const line = `TASK_STALLED ${which} its pass has run ${Math.round(ms / 60_000)} min without finishing; the other supervisor tasks keep running, and the supervisor restarts if it is still stuck at ${Math.round(WATCHDOG_STALL_MS / 60_000)} min`;
        const id = `task-stalled:${boot}:${which}:${deps.clock.now() - ms}`;
        console.error(line);
        try { supervisor.enqueue(id, line); } catch (e) { console.error(`TASK_STALLED_ENQUEUE_FAILED ${which} ${e instanceof Error ? e.message : String(e)}`); }
        // A stuck delivery task cannot hand the line to the lead, so the owner hears it in the main channel. Not awaited:
        // a hung post must not stop this loop.
        const channel = deps.config.discordChannels[0];
        if (which === "delivery" && channel) {
          void discord.send(channel, systemText(scrubForThread(`Dori warning: ${line}`, homedir())), id)
            .catch((e: unknown) => { console.error(`TASK_STALLED_NOTIFY_FAILED ${which} ${e instanceof Error ? e.message : String(e)}`); });
        }
      }
      watchdog.progress();
      await watchdog.pet();
      await wait(5_000, halted);
    }
    stop.abort();
    await tasks;
    if (deliveryError) throw deliveryError;
  } finally {
    // A startup that failed or was stopped early still logs how far it got.
    if (probe.active) {
      probe.report(ready ? "first-pass-incomplete" : "startup-incomplete");
      probe.close();
    }
    if (petting !== undefined) clearInterval(petting);
    stop.abort();
    await tasks;
    await inbound?.close();
    if (inbound) writeGatewayStatus(deps.config.stateDir, { pid: process.pid, at: deps.clock.now(), connected: false, messageContent: false });
    reports?.close();
    sources?.close();
    scheduleOps?.close();
    ci?.close();
    releaseGateway?.();
    release?.();
  }
};
