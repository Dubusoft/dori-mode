import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { replaceKnownSecrets } from "./redact.ts";
import { SecretStore } from "./secret-store.ts";
import { homedir } from "node:os";
import { resolveCredential } from "./credentials.ts";
import { alertsChannelOf, deliveryConfigError } from "./config.ts";
import { applyConfigPatch, configReloader, watchConfigFiles } from "./config-watch.ts";
import { saveLeadPane } from "./managed-panes.ts";
import { readRunnerRows } from "./runner/hub.ts";
import { RunnerGuardBoard } from "./runner/guard.ts";
import type { RunnerCall } from "./runner/call.ts";
import { laneOps, machineRunner } from "./lane-ops.ts";
import type { LocalChildDeps } from "./runner/local-child.ts";
import { type LaneMessageStore, openLaneMessages } from "./lane-messages.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { type Emit, watchTick, type FlowDeps } from "./done-flow.ts";
import { newPendingCleanup } from "./closed-cleanup.ts";
import { resumeAnsweredGoals } from "./decision-resume.ts";
import { freshnessTick, scrubForThread, sweepActLine } from "./freshness.ts";
import { quotaReport } from "./claude-quota.ts";
import { sharedQuotaLookup } from "./quota-cache.ts";
import { recoverLanes, type RecoveryEnqueue } from "./recover.ts";
import { memorySizeTrigger, memorySweep } from "./memory-check.ts";
import { alertReasons, diskGuardPath, type GuardState, guardTick, type HostSample, memIsLow, sampleHost } from "./host-guard.ts";
import { type Lane, statusOf } from "./registry.ts";
import { AutoUpdate, doriRepoOf, noteDevMerge } from "./auto-update.ts";
import { staleBlocker } from "./update-blocker.ts";
import { type GuardMachine, listGuardMachines, loadMachineGuardState, machineGuardTick, saveMachineGuardState } from "./remote-guard.ts";

import { run, type Runner, setDefaultRunTimeout } from "./run.ts";
import { canLaunch, clearLaunchHold, launchHeld } from "./routing.ts";
import { machineVerdict, summaryOf } from "./placement.ts";
import { Discord } from "./messenger/discord.ts";
import { acquireDiscordGateway } from "./messenger/discord-lock.ts";
import { supervisorDiscord, type SupervisorDiscordOptions } from "./messenger/discord-supervisor.ts";
import { closeThreadButton } from "./messenger/discord-commands.ts";
import { fetchHttp } from "./messenger/http.ts";
import { postOwnerLine } from "./lane-finish.ts";
import { appendFollowUp, pruneThreadFollowups, redirectIfClosed } from "./thread-followup.ts";
import { autoReportPoster } from "./auto-report.ts";
import { taskBlocker, taskFinisher } from "./task-finish.ts";
import { ToodoWriter } from "./toodo-client.ts";
import { writeGatewayStatus } from "./gateway-status.ts";
import { lookupStatus } from "./status.ts";
import { OWNER_NOTICE_AFTER_MS, RetryingDelivery, SuperviseError, Supervisor } from "./supervise.ts";
import { Waits } from "./waits.ts";
import { GitHubEvents, githubTargets, type OpenPull } from "./github-events.ts";
import { driftTick, pullOwners } from "./drift.ts";
import { CiFollowUp, defaultCiIo } from "./ci-follow.ts";
import { ReviewGate } from "./review-gate.ts";
import { reviewSectionOf, reviewStatusTick } from "./review-status.ts";
import { mergePauseHolds } from "./merge-pause.ts";
import { newSweepCache, passthroughView, type SweepView, sweepRound } from "./sweep-view.ts";
import { StartupProbe } from "./startup-probe.ts";
import { EventSources, type SourceEnqueue, SourceSpecs } from "./event-sources.ts";
import { autopilotLocalStateKey } from "./autopilot.ts";
import { judgeCandidates, liveJudgeDeps, RECONCILE_JOB } from "./autopilot-cli.ts";
import { AUTOPILOT_KICK_EVENTS, AutopilotTick } from "./autopilot-tick.ts";
import { liveExecutorDeps, reconcileExecutions, runExecutor } from "./autopilot-executor.ts";
import { pidAlive, releaseSlot, trySlot } from "./heavy-slot.ts";
import { ToodoEvents } from "./toodo-events.ts";
import { openOperations, type OperationStore } from "./operations.ts";
import { routeReports } from "./lane-reports.ts";
import { type LaneReportStore, openLaneReports } from "./lane-report-store.ts";
import { firstStatusTick, type LaneStatusTransport, statusTransportOf } from "./lane-status.ts";
import { criticalTick, guardAlertDetail, laneMemoryOf, MACHINE_GUARD_STATE_FILE, type PressureIo, pressureIo, warnMachineLanes } from "./supervise-guard.ts";
import { runnerCallsOf, SupervisorRunners } from "./supervise-runners.ts";
import { decisionDeliveryTick, reconcileDecisionsAtStart } from "./decision-delivery.ts";
import { type DecisionContext, openLaneDecision, ownerDecisionTick } from "./owner-decisions.ts";
import { relayLine, retryDecisionRelays } from "./decision-relay.ts";
import { errLine } from "./line-text.ts";

export { RUNNER_HUB_RETRY_MS } from "./supervise-runners.ts";

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
/**
 * The supervisor's independent tasks. `delivery` hands queued events to the lead and nothing else; `notices` (the owner
 * notices and the lead-side checks, several of which post to Discord) runs beside it, so a slow or failing Discord never
 * holds back lead delivery. `reports` routes lane reports apart from `polling`, so a slow GitHub poll never holds a
 * lane question back.
 */
export const SUPERVISOR_TASKS = ["inbound", "delivery", "notices", "sweeps", "polling", "reports"] as const;
export type SupervisorTask = (typeof SUPERVISOR_TASKS)[number];
/** The seventh task: liveness, lane events, runner admin, journal pruning; it reopens a hub that failed to open. */
export const RUNNERS_TASK = "runners";
/** The autopilot tick's task (autopilot-tick.ts); it judges only while the toodo source is enabled. */
export const AUTOPILOT_TASK = "autopilot";
export const AUTOPILOT_PASS_MS = 5_000;
/** How often the runners task runs; the hub itself answers frames as they arrive. */
export const RUNNERS_PASS_MS = 5_000;
/** How often the polling task delivers queued lane messages (lead steering, CI, rebase), apart from the GitHub poll. */
export const LANE_MESSAGES_PASS_MS = 30_000;

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

/** Runs one best-effort pass; a failure is logged as `CODE message` and never stops the round. */
const isolate = async (code: string, work: () => unknown): Promise<void> => {
  try { await work(); }
  catch (e) { console.error(`${code} ${e instanceof Error ? e.message : String(e)}`); }
};

/** The dori checkout this supervisor runs from (the package dir of `dori update`). */
const PACKAGE_DIR = join(import.meta.dir, "..");

/** dori's own repo (`owner/repo`), read once per process from the checkout's origin; undefined when it has none. */
const doriRepo = (deps: Pick<FlowDeps, "run">): (() => Promise<string | undefined>) => {
  let repo: Promise<string | undefined> | undefined;
  return () => (repo ??= doriRepoOf(deps.run, PACKAGE_DIR).catch(() => undefined));
};

/** Lane states that hold back the automatic update: still working, told not done, or waiting on its done claim. */
const UPDATE_BLOCKING = new Set(["working", "not-done", "done-claimed"]);

/**
 * The open lanes of `repo` that hold back the automatic update. A lane whose runner cannot say which repo it works in
 * counts as one: an update is never started under a lane that may be dori's.
 */
export const lanesBlockingUpdate = async (deps: Pick<FlowDeps, "registry" | "ops">, repo: string): Promise<string[]> => {
  const busy: string[] = [];
  for (const lane of await deps.registry.open()) {
    if (!UPDATE_BLOCKING.has(statusOf(lane))) continue;
    const unresolved = new Set<string>();
    const targets = await githubTargets([lane], deps.ops, unresolved);
    if (targets.has(repo) || unresolved.has(lane.key)) busy.push(lane.key);
  }
  return busy;
};

/** A named sweep. It may hand lines over itself through `emit` (as they happen) and/or return them. */
export type Sweep = readonly [name: string, step: (emit: Emit) => Promise<readonly string[]>];

/** The same warning line is enqueued at most once per hour; the console still logs every failure. */
export const WARN_REPEAT_MS = 60 * 60_000;

/**
 * How often the watcher also walks every closed lane in the archive (their kept-worktree cleanup). A lane whose close
 * queued cleanup is swept on every pass in between (closed-cleanup.ts PendingCleanup).
 */
export const ARCHIVE_SWEEP_MS = 10 * 60_000;

/**
 * The sweeps' deps: `deps` with the D11 close hold answered by the supervisor's one review gate (PRs of repos in config
 * `review.repos` only; review-gate.ts reviewEnabledFor), and while merges are
 * paused (merge-pause.ts, read fresh each pass) also by the pause, so an approved lane waiting on its merge stays open.
 */
export const withReviewHold = (deps: FlowDeps, review: Pick<ReviewGate, "holdsLane">): FlowDeps => ({
  ...deps, reviewHold: async (lane) => mergePauseHolds(deps.config.stateDir, lane) || review.holdsLane(lane),
});

/**
 * The supervisor's sweeps over one long-lived state (guard transitions, dead-pane memory, pane read cache). The first
 * sweep takes the round's pane snapshot; every later sweep of the round observes panes through it.
 */
export const supervisorSweeps = (
  deps: FlowDeps, home: string, enqueueRecovery?: RecoveryEnqueue,
  laneReports: () => LaneReportStore | undefined = () => undefined,
  io: PressureIo = pressureIo(deps),
  runnerGuard: () => RunnerGuardBoard | undefined = () => undefined,
  openPulls: () => readonly OpenPull[] = () => [],
): readonly Sweep[] => {
  const guard: GuardState = { alerting: false };
  const critical = new Map<string, boolean>();
  const machineCritical = new Map<string, boolean>();
  const warnedAt = new Map<string, number>();
  const machineGuardPath = join(deps.config.stateDir, MACHINE_GUARD_STATE_FILE);
  const machineGuard = loadMachineGuardState(machineGuardPath);
  const seen = new Set<string>();
  const dead = newDeadPaneState();
  const cache = newSweepCache();
  let view: SweepView = passthroughView(deps.ops);
  let lastArchive = -Infinity;
  const pendingCleanup = newPendingCleanup();
  // The watch, dead-panes and freshness sweeps read a machine only through an admitted runner connection. A runner
  // without one (right after a restart, before its hello, or gone) is one RUNNER_UNAVAILABLE line per outage, by
  // runner label (the machine it serves as value), instead of one warning per lane and sweep every round.
  const admitted = (machine?: string): boolean => deps.ops.connected(machine);
  const unavailable = new Map<string, string | undefined>();
  const ownRepo = doriRepo(deps);
  const autoUpdate = new AutoUpdate({
    stateDir: deps.config.stateDir, run: deps.run, now: deps.clock.now, env: process.env, log: (line) => { console.error(line); },
    command: [process.execPath, join(PACKAGE_DIR, "src", "cli.ts"), "update", "--dev"],
    busy: async () => {
      const repo = await ownRepo();
      return repo ? lanesBlockingUpdate(deps, repo) : [];
    },
    staleAfterMs: deps.tunables.updateBlockerStaleMin * 60_000,
    staleBlocker: (key, since, emit) => staleBlocker(deps, key, since, emit),
  });
  return [
    ["snapshot", async (emit) => {
      view = passthroughView(deps.ops);
      // A bad deadline warns every round and the sweeps read per lane.
      if (!Number.isFinite(deps.tunables.sweepMachineDeadlineMs) || deps.tunables.sweepMachineDeadlineMs <= 0) throw new SuperviseError("sweepMachineDeadlineMs must be positive");
      const open = await deps.registry.open();
      const machines = new Map<string, string | undefined>([
        [machineRunner(undefined), undefined], ...open.flatMap((l) => l.machine ? [[machineRunner(l.machine), l.machine] as const] : []), ...unavailable,
      ]);
      for (const [label, machine] of machines) {
        if (admitted(machine)) unavailable.delete(label);
        else if (!unavailable.has(label)) {
          unavailable.set(label, machine);
          await emit(`RUNNER_UNAVAILABLE runner=${label} no admitted connection: watch, dead-panes and freshness skip its lanes until it says hello`);
        }
      }
      view = await sweepRound(deps.ops, cache, open, { now: deps.clock.now, deadlineMs: deps.tunables.sweepMachineDeadlineMs });
      return [];
    }],
    ["watch", async (emit) => {
      // The archive's lanes are local: their pass waits for the local runner, so it runs right after its hello.
      const archived = deps.clock.now() - lastArchive >= ARCHIVE_SWEEP_MS && admitted(undefined);
      await watchTick(deps, emit, archived, admitted, pendingCleanup);
      if (archived) lastArchive = deps.clock.now();
      return [];
    }],
    // This host's numbers are the local runner's guard sample (it samples and kills on its host); without a fresh one
    // the sweep says nothing, and the liveness monitor reports the runner.
    ["guard", async (emit) => {
      const board = runnerGuard();
      const fromRunner = board?.sampleFor(LOCAL_RUNNER);
      if (!board || !fromRunner) return [];
      const s = fromRunner.sample;
      const sample: HostSample = {
        load1: s.load1, memFreePct: s.memFreePct, diskFreeGb: s.diskFreeGb, swapFreeGb: s.swapFreeGb, swapTotalGb: s.swapTotalGb, panes: fromRunner.panes ?? -1,
      };
      const memory = fromRunner.lanes ? laneMemoryOf(fromRunner.lanes) : undefined;
      const memJustLow = memIsLow(sample, deps.config.guard, guard.memLow) && !guard.memLow;
      const detail = (memJustLow || (!guard.alerting && alertReasons(sample, deps.config.guard).length)) ? await guardAlertDetail(deps, sample, memory, warnedAt, deps.clock.now) : undefined;
      for (const line of guardTick(sample, deps.config.guard, guard, detail)) await emit(line);
      const criticalLine = await criticalTick(deps, { kind: "local" }, s, await deps.registry.open(), critical, board.takeKills(LOCAL_RUNNER), io, memory);
      if (criticalLine) await emit(criticalLine);
      // Work queued on a HOLD from `dori can-launch` resumes on this, whichever host threshold kept it held. An
      // unreadable pane count (-1) proves no room.
      if (sample.panes >= 0 && launchHeld(deps.config.stateDir) && canLaunch(sample, deps.config.guard).ok) {
        await emit(`LAUNCH_READY the host has room again (load ${sample.load1.toFixed(0)}, memory free ${sample.memFreePct}%, disk free ${sample.diskFreeGb.toFixed(0)} GB, panes ${sample.panes}); start the held work after dori can-launch`);
        clearLaunchHold(deps.config.stateDir);
      }
      return [];
    }],
    ["dead-panes", async () => deadPaneTick(deps.ops, deps.config, seen, new Date(deps.clock.now()).toISOString().slice(0, 13), dead, await deps.registry.open(), view, deps.clock.now, admitted)],
    // Recovery notices are journaled with stable ids before recover saves the flags that suppress them.
    ["recover", async () => recoverLanes(deps, undefined, enqueueRecovery, view)],
    // A lane that parked its goal on its own blocking ask gets it resumed once the answer reached it and its turn ended.
    ["decision-resume", async () => resumeAnsweredGoals(deps, view, admitted)],
    ["freshness", async () => (await freshnessTick(deps, view, laneReports(), admitted)).map(sweepActLine)],
    // Urgent LANE_DRIFT for a working lane overdue on milestones or failing CI head after head; reads the last GitHub poll only.
    ["drift", async (emit) => {
      await driftTick({
        stateDir: deps.config.stateDir, drift: deps.config.drift, now: deps.clock.now, openLanes: () => deps.registry.open(), owners: pullOwners(deps.ops),
      }, laneReports(), openPulls(), emit);
      return [];
    }],
    // The size trigger runs every round in its own unit, so a failing daily check never costs its urgent line.
    ["memory-size", async () => memorySizeTrigger(deps, home)],
    ["memory", async () => memorySweep(deps, home)],
    // `dori update --dev` after a merge of dori's own repo into dev, in its own unit once no lane of that repo is working.
    ["auto-update", async (emit) => {
      await autoUpdate.tick(emit);
      return [];
    }],
    // Each worker machine with an enrolled runner is judged from its runner's guard sample; nothing is sampled over ssh.
    ["machine-guard", async (emit) => {
      const now = deps.clock.now();
      // Only machines with an enrolled runner are guarded (a machine without one is not); each is judged from its runner's
      // fresh sample, and one whose runner is quiet is skipped this round (the liveness monitor reports it). An enrolled
      // label missing from the machine list is its own ssh target. The runner kills by itself, so a machine's critical
      // stage reports the kills it sent.
      const board = runnerGuard();
      if (!board) return [];
      const listedByLabel = new Map(listGuardMachines(deps.config.guardMachines, deps.config.stateDir).map((m) => [m.label, m] as const));
      const enrolled = [...new Set(readRunnerRows(deps.config.stateDir).map((row) => row.label))].filter((label) => label !== LOCAL_RUNNER);
      const results = enrolled.flatMap((label) => {
        const fromRunner = board.sampleFor(label);
        return fromRunner ? [{ machine: listedByLabel.get(label) ?? { label, target: label }, result: fromRunner, sample: fromRunner.sample, fromRunner }] : [];
      });
      if (!results.length) return [];
      const open = await deps.registry.open();
      // Lane memory is read from this host's /proc, so a machine's ALERT names the lanes running there instead.
      // A machine newly in ALERT for low memory warns its lanes first, so its ALERT line can say so.
      const warned = new Map<string, string>();
      await Promise.all(results.map(async ({ machine, sample }) => {
        if (machineGuard.get(machine.label)?.alerting) return;
        const note = await warnMachineLanes(deps.ops, machine, sample, open, deps.config.guard.memFreeMinPct).catch((e) => `warning failed: ${errLine(e, 160)}`);
        if (note) warned.set(machine.label, note);
      }));
      const lanesOn = (m: GuardMachine): string | undefined => {
        const keys = open.filter((l) => l.machine === m.label).map((l) => l.key);
        return [keys.length ? `lanes on this machine: ${keys.join(", ")}` : "", warned.get(m.label) ?? ""].filter(Boolean).join("; ") || undefined;
      };
      const lines = machineGuardTick(results, deps.config.guard, machineGuard, lanesOn, now);
      try {
        for (const line of lines) await emit(line);
        // A machine held by `dori can-launch --machine` or a queued launch resumes the same way, from this round's pane list.
        for (const { machine: { label }, result, sample, fromRunner } of results) {
          if (!launchHeld(deps.config.stateDir, label)) continue;
          const panes = fromRunner.panes ?? await view.panes(label).then((p) => p.length, () => -1);
          if (!machineVerdict(result, panes, deps.config.guard, label).ok) continue;
          await emit(`LAUNCH_READY machine=${label} the machine has room again (${summaryOf(sample.memFreePct, sample.diskFreeGb, panes)}); start the held work after dori can-launch --machine ${label}`);
          clearLaunchHold(deps.config.stateDir, label);
        }
        const criticalLines = await Promise.all(results.map(({ machine, sample, fromRunner }) =>
          criticalTick(deps, { kind: "machine", machine }, sample, open, machineCritical, board.takeKills(machine.label), io, fromRunner.lanes ? laneMemoryOf(fromRunner.lanes) : [])));
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
      const message = errLine(e);
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
 * The supervisor owns the lead pane: before its tasks start it recreates a lead pane that is missing (none recorded, or
 * hc lost it) and records it in dori state. A failure here is logged and left to the
 * lead-pane repair retries.
 */
const ensureLeadPane = async (deps: FlowDeps, supervisor: Supervisor): Promise<FlowDeps> => {
  try {
    await supervisor.repairLeadPane();
    return { ...deps, config: { ...deps.config, leadPane: supervisor.leadPane } };
  } catch (error) {
    console.error(`LEAD_PANE_ENSURE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    return deps;
  }
};

/**
 * How long a stop waits for the task passes in flight. A pass ends at its next pause, but one inside a slow command or
 * request runs on to that call's own timeout (up to runTimeoutMs); the stop goes on without it, so systemd's stop and
 * with it a restart never wait on a pass.
 */
export const STOP_TASKS_GRACE_MS = 3_000;

/**
 * `dori supervise` exits this long after SIGTERM/SIGINT however far shutdown got: past the task grace and the local
 * runner's own stop grace (LOCAL_STOP_GRACE_MS), well inside systemd's stop timeout.
 */
export const SUPERVISE_STOP_DEADLINE_MS = 15_000;

/** Waits for `tasks` up to STOP_TASKS_GRACE_MS. */
const settle = async (tasks: Promise<unknown> | undefined): Promise<void> => {
  if (!tasks) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(true); }, STOP_TASKS_GRACE_MS); });
  const pending = await Promise.race([tasks.then(() => false, () => false), late]);
  clearTimeout(timer);
  if (pending) console.error(`SUPERVISOR_STOP_TASKS_PENDING a task pass still running ${STOP_TASKS_GRACE_MS} ms after the stop; stopping without it`);
};

/**
 * Registers every secret store value with the masking registry and re-registers on changes to the store directory
 * (debounced). Failures are logged as SECRET_STORE_WATCH_FAILED and never thrown; a missing directory is not watched.
 * Returns the function that stops the watch.
 */
export const watchSecretStore = async (
  store: Pick<SecretStore, "dir" | "readAll"> = new SecretStore(),
  log: (line: string) => void = (line) => { console.error(line); },
  debounceMs = 500,
): Promise<() => void> => {
  const load = async (): Promise<void> => {
    try { replaceKnownSecrets((await store.readAll()).values()); }
    catch (e) { log(`SECRET_STORE_WATCH_FAILED ${e instanceof Error ? e.message : String(e)}`); }
  };
  await load();
  if (!existsSync(store.dir)) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher;
  try {
    watcher = watch(store.dir, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, debounceMs);
    });
    watcher.on("error", (e) => { log(`SECRET_STORE_WATCH_FAILED ${e.message}`); });
  } catch (e) {
    log(`SECRET_STORE_WATCH_FAILED ${e instanceof Error ? e.message : String(e)}`);
    return () => {};
  }
  return () => { clearTimeout(timer); watcher.close(); };
};

/** Refuses to start on a tunable or config value out of its bounds, or on an invalid delivery config. */
const checkSuperviseConfig = (deps: FlowDeps): void => {
  const bounds: readonly (readonly [Record<string, unknown>, string, string])[] = [
    [deps.tunables, "cacheTtlMin", "positive"], [deps.tunables, "leadContextCapTokens", "positive"],
    [deps.tunables, "githubPollSeconds", "positive"], [deps.tunables, "githubTimeoutMs", "positive"],
    [deps.tunables, "discordSafetyPollSeconds", "positive"], [deps.tunables, "digestMaxDelayMin", "positive"],
    [deps.tunables, "ackTimeoutSec", "positive"], [deps.config, "runTimeoutMs", "zero or positive"],
    [deps.tunables, "handledTimeoutMin", "positive"], [deps.tunables, "reportTimeoutMin", "positive"],
    [deps.tunables, "resolveTimeoutMin", "positive"], [deps.config, "leadStuckRestartMin", "positive"],
    [deps.config, "leadChildWaitMaxMin", "positive"], [deps.tunables, "idleEscalateMin", "positive"],
    [deps.tunables, "waitMaxFailures", "a positive integer"], [deps.config, "threadCloseAfterHours", "positive"],
  ];
  for (const [source, key, rule] of bounds) {
    const value = source[key] as number;
    const ok = rule === "a positive integer" ? Number.isInteger(value) && value > 0 : Number.isFinite(value) && (rule === "positive" ? value > 0 : value >= 0);
    if (!ok) throw new SuperviseError(`${key} must be ${rule}`);
  }
  const deliveryProblem = deliveryConfigError(deps.tunables.delivery);
  if (deliveryProblem) throw new SuperviseError(deliveryProblem);
};

/**
 * Every built-in enqueues through the source registry, which records its last event and errors. The schedule sources
 * run too, each run an operation row; a heavy job takes a heavy slot like `dori heavy`, without waiting for one.
 */
const openEventSources = (deps: FlowDeps, supervisor: Supervisor, ops: OperationStore, remote: RunnerCall, home: string): EventSources => {
  // The host's load only (no pane count): a scheduled heavy job's maxLoad.
  const heavyLoad = async (): Promise<number> => (await sampleHost(deps.run, diskGuardPath(deps.config), async () => -1)).load1;
  return new EventSources({
    stateDir: deps.config.stateDir, enqueue: (id, line, meta) => supervisor.enqueue(id, line, meta), now: deps.clock.now, run: deps.run,
    policy: deps.tunables.eventPolicy, log: (line) => { console.error(line); }, remote,
    schedules: {
      operations: ops, journaled: (id: string) => supervisor.journaled(id),
      heavy: {
        take: async (label: string) => (await trySlot({
          // One heavy-slot directory per host, shared with the lanes' `dori heavy`.
          dir: join(home || homedir(), ".dori", "heavy"), slots: deps.config.heavySlots, maxLoad: deps.config.heavyMaxLoad, clock: deps.clock,
          load: heavyLoad, alive: pidAlive, pid: process.pid,
        }, label)) ?? undefined,
        release: releaseSlot,
      },
    },
  });
};

/**
 * The autopilot task's pass and the toodo event stream that kicks it. AUTOPILOT_READY counts under the toodo source: it
 * is what toodo's marked tasks add up to. The executor's deps are rebuilt per call over the live `deps`, so a config
 * reload applies; the toodo source journals its notices.
 */
const autopilotTask = (deps: FlowDeps, ops: OperationStore, registry: EventSources): { readonly events: ToodoEvents; readonly pass: () => Promise<void> } => {
  const executorDeps = () => liveExecutorDeps(deps, ops, registry.enqueueFor("toodo"), (line) => { console.error(line); });
  const autopilot = new AutopilotTick({
    tickMs: () => deps.config.autopilot.tickSec * 1000,
    executorOn: () => deps.config.autopilot.executor,
    execute: async (ids) => { const exec = executorDeps(); await reconcileExecutions(exec); return runExecutor(exec, ids); },
    judge: () => judgeCandidates(liveJudgeDeps(deps, ops)), enqueue: registry.enqueueFor("toodo"), now: deps.clock.now,
    localState: async () => autopilotLocalStateKey(ops, new Set((await deps.registry.open()).map((l) => l.key))),
    log: (line) => { console.error(line); },
  });
  // The tick replaced the hourly autopilot-reconcile schedule job; one left from an earlier version is removed.
  try { if (new SourceSpecs(deps.config.stateDir).remove(RECONCILE_JOB)) console.log(`AUTOPILOT_RECONCILE_JOB_REMOVED ${RECONCILE_JOB}: the supervisor's autopilot tick replaces it`); }
  catch (e) { console.error(`AUTOPILOT_RECONCILE_JOB_ERROR ${e instanceof Error ? e.message : String(e)}`); }
  let executorStarted = false;
  const events = new ToodoEvents({
    config: deps.tunables.toodoEvents, stateDir: deps.config.stateDir, enqueue: registry.enqueueFor("toodo"),
    fail: (e) => { registry.fail("toodo", e); }, ok: () => { registry.ok("toodo"); }, log: (line) => { console.error(line); },
    onEvent: (event) => { if (AUTOPILOT_KICK_EVENTS.has(event)) autopilot.kick(); },
  });
  return {
    events,
    pass: async () => {
      // Switch on: crash reconcile once at start (never fatal); the tick reconciles again on every pass.
      if (!executorStarted && deps.config.autopilot.executor) {
        executorStarted = true;
        try { await reconcileExecutions(executorDeps()); } catch (e) { console.error(`AUTOPILOT_EXECUTOR_RECONCILE_ERROR ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (deps.tunables.toodoEvents.enabled) await autopilot.tick();
    },
  };
};

/**
 * The GitHub poll and what reads it. One review gate per supervisor (construction recovers its job store): CI follow-up
 * merges only what it approved, and a merge of dori's own repo into dev queues the automatic update (the auto-update
 * sweep runs it).
 */
const githubPolling = (deps: FlowDeps, probe: StartupProbe, enqueue: SourceEnqueue) => {
  const github = probe.step("github", () => new GitHubEvents(deps.config.stateDir, deps.clock.now));
  const ownRepo = doriRepo(deps);
  const review = probe.step("review-gate", () => new ReviewGate(deps));
  const follow = probe.step("ci-follow", () => new CiFollowUp(deps, review, {
    ...defaultCiIo,
    merged: async (pull, base) => {
      if (base === "dev" && pull.repo.toLowerCase() === await ownRepo()) noteDevMerge(deps.config.stateDir, `${pull.repo}#${pull.number}`);
    },
  }));
  // CI follow-up reads the poll it follows, so it runs right after each GitHub tick.
  const poll = async (): Promise<void> => {
    await github.tick(deps, enqueue);
    await follow.tick(github.openPulls(), enqueue, github.mergedPulls());
    // Timeouts, reviewer intake and close, snapshot release (review-gate.ts); errors per job are logged there.
    await review.tick(enqueue);
  };
  return { github, review, follow, poll };
};

type SweepTaskParts = {
  readonly deps: FlowDeps;
  readonly supervisor: Supervisor;
  readonly discord: Discord;
  readonly review: ReviewGate;
  readonly registry: EventSources;
  readonly enqueue: SourceEnqueue;
  readonly home: string;
  readonly boot: string;
  readonly watchdog: Watchdog;
  readonly probe: StartupProbe;
  readonly reports: () => LaneReportStore | undefined;
  readonly runnerGuard: () => RunnerGuardBoard | undefined;
  readonly openPulls: () => readonly OpenPull[];
};

/**
 * The sweeps task's pass: one round of the supervisor's sweeps. The task gets its own span, so its timings never mix
 * into the startup report, and each sweep is tracked: one stuck past WATCHDOG_STALL_MS withholds the watchdog. The
 * watcher reads its claim announcements back from the journal.
 */
const sweepTask = (p: SweepTaskParts): (() => Promise<void>) => {
  const { deps, supervisor, registry, enqueue, home } = p;
  const sweepProbe = p.probe.span();
  // The supervisor finishes a merged lane's Toodo task and appends the merge to its report (task-finish.ts).
  // An autopilot task it cannot finish, or whose lane closed cancelled, gets a blocker note instead.
  const toodoWriter = new ToodoWriter(deps.tunables.toodoWriter);
  const finishTask = taskFinisher({ writer: toodoWriter, append: (lane, text) => appendFollowUp(deps.config.stateDir, p.discord, lane, text), language: () => deps.config.ownerLanguage });
  // A clean done claim of a lane config autoReport covers is posted as its report by the supervisor (auto-report.ts).
  const autoReport = autoReportPoster({ config: deps.config, discord: p.discord, now: deps.clock.now, home: home || homedir(), language: () => deps.config.ownerLanguage });
  // The watch sweep holds a lane whose review is pending through the same gate CI follow-up merges with (D11).
  const sweepDeps: FlowDeps = withReviewHold({ ...deps, leadDelivered: (id) => supervisor.leadDelivered(id), finishTask, blockTask: taskBlocker(toodoWriter), autoReport }, p.review);
  const sweeps = supervisorSweeps(sweepDeps, home, async (line, id) => { enqueue(id, line); }, p.reports, pressureIo(sweepDeps), p.runnerGuard, p.openPulls).map(([name, step]): Sweep => [name, async (emit) =>
    p.watchdog.track(`sweep:${name}`, sweepProbe.step(`loop:sweep:${name}`, () => step(emit)))]);
  const recentWarnings = new Map<string, number>();
  let sequence = 0;
  const sweep = async (): Promise<void> => {
    const failed: string[] = [];
    await runSweeps(sweeps, async (line, id, meta) => { enqueue(id ?? `sweep:${p.boot}:${sequence++}`, line, meta); }, deps.clock.now, recentWarnings, (line) => {
      console.error(line);
      if (line.startsWith("SWEEP_ERROR ")) failed.push(line.slice("SWEEP_ERROR ".length));
    });
    if (failed.length) registry.fail("sweeps", failed.join("; "));
    else registry.ok("sweeps");
  };
  return () => sweep()
    .catch((e: unknown) => { console.error(`SWEEP_ROUND_ERROR ${e instanceof Error ? e.message : String(e)}`); })
    .finally(() => {
      if (sweepProbe.active) {
        sweepProbe.report("first-sweep");
        sweepProbe.close();
      }
    });
};

/** Lead delivery: flushes queued events to the lead, repairing its pane, and tells the owner when it keeps failing. */
const leadDelivery = (deps: FlowDeps, supervisor: Supervisor, systemPost: (channel: string, text: string) => Promise<void>, boot: string): RetryingDelivery =>
  new RetryingDelivery({
    now: deps.clock.now,
    flush: () => supervisor.flush(),
    repair: () => supervisor.repairLeadPane(),
    enqueue: (id, line) => supervisor.enqueue(id, line),
    notify: async (text) => {
      const channel = alertsChannelOf(deps.config);
      if (!channel) throw new Error("no discordChannels configured");
      await systemPost(channel, `수퍼바이저가 리드에게 이벤트를 계속 전달하지 못하고 있습니다. 이벤트는 보관 중이며 계속 재시도합니다. (${text})`);
    },
    log: (line) => { console.error(line); },
  }, boot);

/** Records whether the Discord gateway is connected, for `dori status`; a failure is logged, never thrown. */
const writeHeartbeat = (deps: FlowDeps, inbound: ReturnType<typeof supervisorDiscord> | undefined): void => {
  try {
    const gateway = inbound?.state() ?? { connected: false, messageContent: false };
    writeGatewayStatus(deps.config.stateDir, { pid: process.pid, at: deps.clock.now(), ...gateway });
  } catch (e) {
    console.error(`GATEWAY_STATUS_ERROR ${e instanceof Error ? e.message : String(e)}`);
  }
};

type LaneReportParts = {
  readonly deps: FlowDeps;
  readonly ops: OperationStore;
  readonly reports: LaneReportStore;
  readonly review: ReviewGate;
  readonly transport: LaneStatusTransport;
  readonly decisions: DecisionContext;
  readonly home: string;
  readonly enqueue: SourceEnqueue;
  readonly watchdog: Watchdog;
};

/**
 * Routes lane reports, as the 5 s reports task's pass, so a question reaches the lead within one pass and one delivery
 * tick of being written, however long a GitHub poll takes. A lane question with choices opens an owner decision
 * thread; failures are logged, never thrown.
 */
const laneReportsPass = (p: LaneReportParts): (() => Promise<void>) => {
  const { deps, reports, transport, decisions, home, enqueue } = p;
  let nextHistoryPrune = 0;
  return () => p.watchdog.track("reports", (async () => {
    const now = deps.clock.now();
    if (now >= nextHistoryPrune) {
      p.ops.prune(now);
      reports.prune(now);
      nextHistoryPrune = now + 60 * 60_000;
    }
    const lines = await routeReports(deps, reports, enqueue, home, transport, (lane, report) => openLaneDecision(decisions, lane, report),
      reviewSectionOf(deps, p.review));
    // Review status in each author lane's status message and the owner decision of a reached review limit
    // (review-status.ts), right after the reports so the two never write one status message at once.
    lines.push(...await reviewStatusTick({
      flow: deps, stores: p.review, reports, transport, decisions, home,
      emit: (id, line) => { enqueue(id, line); },
    }));
    return [...lines, ...await firstStatusTick(deps, transport, reports, home)];
  })())
    .then((lines) => { for (const line of lines) console.log(line); })
    .catch((e: unknown) => { console.error(`LANE_REPORTS_ERROR ${e instanceof Error ? e.message : String(e)}`); });
};

type NoticeParts = {
  readonly deps: FlowDeps;
  readonly supervisor: Supervisor;
  readonly discord: Discord;
  readonly decisions: DecisionContext;
  readonly laneMessages: () => LaneMessageStore;
  /** An owner notice goes where the message came from: its Discord channel or thread. */
  readonly ownerNotice: (channel: string, text: string, id: string) => Promise<void>;
};

/** The notices task's pass: the owner notices, then the report, decision and thread checks, each failing on its own. */
const ownerNotices = (p: NoticeParts): (() => Promise<void>) => {
  const { deps, supervisor, decisions, laneMessages } = p;
  // One plain line to the owner per message a lead-side check found due; each notice is attempted once per round.
  const noticeDue = async (
    kind: "delay" | "ack" | "unhandled", text: string, checkCode: string, failCode: string,
    findDue: () => ReturnType<typeof supervisor.overdueOwnerMessages>, announce?: string,
  ): Promise<void> => {
    let due: ReturnType<typeof supervisor.overdueOwnerMessages>;
    try { due = findDue(); }
    catch (e) { console.error(`${checkCode} ${e instanceof Error ? e.message : String(e)}`); return; }
    for (const { channel, message } of due) {
      if (announce) console.log(`${announce} ${channel}/${message}`);
      try {
        supervisor.noticeAttempt(kind, channel, message);
        await p.ownerNotice(channel, text, `${kind}:${channel}:${message}`);
        supervisor.noticeSent(kind, channel, message);
      }
      catch (e) { console.error(`${failCode} ${channel}/${message}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  };
  // A finished lane the lead did not report to the owner (dori reported) in time: UNREPORTED wakes the lead. The
  // supervisor never tells the owner itself.
  let decisionsReconciled = false;
  const checkReported = async (): Promise<void> => {
    await isolate("REPORT_CHECK_ERROR", () => supervisor.reportTick());
    // A decision event the lead did not close (dori resolved) in time: UNRESOLVED wakes the lead.
    await isolate("RESOLVE_CHECK_ERROR", () => supervisor.resolveTick());
    // Once per start: direct decision answers' delivery intents against the lane message queue (crash repair).
    if (!decisionsReconciled) {
      await isolate("DECISION_RECONCILE_ERROR", async () => {
        const open = (await deps.registry.list()).filter((lane) => statusOf(lane) !== "closed");
        await reconcileDecisionsAtStart(deps.config.stateDir, laneMessages(), open, deps.clock.now(),
          (id, line) => supervisor.enqueue(id, line), (line) => { console.error(line); });
        decisionsReconciled = true;
      });
    }
    // Every round: direct answers' acks close their decisions, the owner's status line follows each answer, and an
    // answer whose lane session went away is handed to the lead once.
    await isolate("DECISION_DELIVERY_ERROR", () => decisionDeliveryTick({ ...decisions, enqueue: (id, line) => supervisor.enqueue(id, line), log: (line) => { console.error(line); } },
      laneMessages(), async () => (await deps.registry.list()).filter((lane) => statusOf(lane) !== "closed")));
    // A close text its lane did not take is tried again before the tick raises DECISION_RELAY_FAILED for it.
    await isolate("DECISION_RELAY_RETRY_ERROR", async () => {
      for (const d of await retryDecisionRelays(deps)) { const line = relayLine(d); if (line) console.error(line); }
    });
    // Owner decisions: a stuck post, a missing link line, a pending archive, a queued secret request.
    await isolate("OWNER_DECISION_CHECK_ERROR", () => ownerDecisionTick({ ...decisions, enqueue: (id, line) => supervisor.enqueue(id, line), log: (line) => { console.error(line); } }));
    // Owner-closed records and closed lanes' last reports past THREAD_FOLLOWUP_KEEP_MS are dropped.
    await isolate("THREAD_FOLLOWUP_PRUNE_ERROR", async () => { pruneThreadFollowups(deps.config.stateDir, deps.clock.now(), await deps.registry.open()); });
    // A thread whose work is all finished and reported gets the owner's close button on its last report, and is closed
    // (archived) once threadCloseAfterHours pass with no click.
    await isolate("THREAD_AUTO_CLOSE_CHECK_ERROR", () => supervisor.autoCloseTick({
      button: (thread, message, state) => p.discord.editComponents(thread, message, state === "none" ? [] : closeThreadButton(thread, state === "closed")),
      archive: (thread) => p.discord.setThread(thread, { archived: true }),
    }));
  };
  return async () => {
    // An owner message the lead has not taken within a minute gets one plain line in its own channel or thread.
    await noticeDue("delay", deps.tunables.ownerDelayNotice, "OWNER_NOTICE_ERROR", "OWNER_NOTICE_FAILED",
      () => supervisor.overdueOwnerMessages(OWNER_NOTICE_AFTER_MS));
    // A message the lead was handed but never acked is re-pushed, and after a second window the owner gets one line.
    await noticeDue("ack", deps.tunables.ackMissingNotice, "ACK_CHECK_ERROR", "ACK_NOTICE_FAILED",
      () => supervisor.ackTick(deps.tunables.ackTimeoutSec * 1_000), "ACK_MISSING_NOTICE");
    // A message the lead acked but never linked to lanes or a reply: UNHANDLED wakes it, then the owner gets one line.
    await noticeDue("unhandled", deps.tunables.unhandledNotice, "HANDLED_CHECK_ERROR", "UNHANDLED_NOTICE_FAILED",
      () => supervisor.handledTick(deps.tunables.handledTimeoutMin * 60_000), "UNHANDLED_NOTICE");
    await checkReported();
  };
};

type PollingParts = {
  readonly deps: FlowDeps;
  readonly registry: EventSources;
  readonly waits: Waits;
  readonly enqueueWait: SourceEnqueue;
  readonly enqueueSweep: SourceEnqueue;
  readonly pollGithub: () => Promise<void>;
  readonly follow: CiFollowUp;
  readonly watchdog: Watchdog;
};

/** The polling task's pass: waits, the GitHub poll when due, queued lane messages when due, and the sources. */
const pollingPass = (p: PollingParts): (() => Promise<void>) => {
  const { deps, registry, watchdog } = p;
  let lastGitHub = -Infinity;
  let lastLaneMessages = -Infinity;
  return async () => {
    const polls = [watchdog.track("waits", registry.guard("waits", p.waits.tick(deps.clock.now, deps.run, p.enqueueWait)))
      .catch((e: unknown) => { console.error(`WAIT_ERROR ${e instanceof Error ? e.message : String(e)}`); })];
    if (deps.clock.now() - lastGitHub >= deps.tunables.githubPollSeconds * 1_000) {
      lastGitHub = deps.clock.now();
      polls.push(watchdog.track("github", registry.guard("github", p.pollGithub()))
        .catch((e: unknown) => { console.error(`GITHUB_ERROR ${e instanceof Error ? e.message : String(e)}`); }));
    }
    if (deps.clock.now() - lastLaneMessages >= LANE_MESSAGES_PASS_MS) {
      lastLaneMessages = deps.clock.now();
      polls.push(watchdog.track("lane-messages", p.follow.deliver(p.enqueueSweep))
        .catch((e: unknown) => { console.error(`LANE_MESSAGE_ERROR ${e instanceof Error ? e.message : String(e)}`); }));
    }
    polls.push(watchdog.track("sources", registry.tick())
      .catch((e: unknown) => { console.error(`SOURCES_ERROR ${e instanceof Error ? e.message : String(e)}`); }));
    await Promise.all(polls);
  };
};

type TaskName = SupervisorTask | typeof RUNNERS_TASK | typeof AUTOPILOT_TASK;

/**
 * Runs each task as its own loop until `halted`, so one stuck pass costs only that task. Every pass is tracked as
 * task:<name>: watchTasks reports one running past TASK_ALERT_MS by name, and past WATCHDOG_STALL_MS it withholds the
 * watchdog. Each task's first pass is reported as `first-<task>` (the sweeps task reports its own `first-sweep`).
 */
const taskRunner = (probe: StartupProbe, watchdog: Watchdog, wait: Pause, halted: AbortSignal) =>
  (name: TaskName, pauseMs: number, pass: () => Promise<void>): Promise<void> => (async () => {
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

/**
 * The foreground loop until `halted`: a task pass running past TASK_ALERT_MS is reported once (TASK_STALLED) to the lead,
 * a stuck delivery task to the owner too, and its end once (TASK_RECOVERED); every round marks progress and pets the watchdog.
 */
const watchTasks = async (
  deps: FlowDeps, supervisor: Supervisor, watchdog: Watchdog, systemPost: (channel: string, text: string, id?: string) => Promise<void>,
  boot: string, wait: Pause, halted: AbortSignal,
): Promise<void> => {
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
      // A stuck delivery task cannot hand the line to the lead, so the owner hears it in the alerts channel (else the
      // main channel). Not awaited: a hung post must not stop this loop.
      const channel = alertsChannelOf(deps.config);
      if (which === "delivery" && channel) {
        const notice = `도리 경고: 수퍼바이저의 전달 작업이 ${Math.round(ms / 60_000)}분째 끝나지 않고 있습니다. 다른 작업은 계속 돌아가며, ${Math.round(WATCHDOG_STALL_MS / 60_000)}분까지 멈춰 있으면 수퍼바이저가 재시작됩니다. (TASK_STALLED ${which})`;
        void systemPost(channel, scrubForThread(notice, homedir()), id)
          .catch((e: unknown) => { console.error(`TASK_STALLED_NOTIFY_FAILED ${which} ${e instanceof Error ? e.message : String(e)}`); });
      }
    }
    watchdog.progress();
    await watchdog.pet();
    await wait(5_000, halted);
  }
};

/**
 * Polling and sweeps enqueue independently of the single serialized lead delivery. There is no single loop: inbound,
 * lead delivery, the owner notices with the lead-side checks, sweeps and GitHub/wait polling each run as their own task,
 * so none waits behind another; a stuck one is reported by name (TASK_STALLED) while the others keep working, and each sweep
 * is tracked by the watchdog. Each startup step up to READY=1 is timed by `probe` (STARTUP_TIMINGS, STARTUP_SLOW <step>),
 * so a hang names its step, and each task's first pass is reported as `first-<task>` (`first-sweep` for the sweeps).
 */
export const supervise = async (
  deps: FlowDeps, signal: AbortSignal,
  options: Partial<Omit<SupervisorDiscordOptions, "emit">> & {
    readonly gatewayLockDir?: string;
    /** Starts the local runner child (default Bun.spawn); tests inject one that starts nothing. */
    readonly spawnRunner?: LocalChildDeps["spawn"];
    /** The config.json to hot-reload (cli.ts: configPath()); without it nothing is watched. */
    readonly configFile?: string;
  } = {},
  notify: (state: string) => Promise<boolean> = sdNotify, probe = new StartupProbe(), wait: Pause = pause,
): Promise<void> => {
  const { gatewayLockDir, spawnRunner, configFile, ...discordOptions } = options;
  checkSuperviseConfig(deps);
  setDefaultRunTimeout(deps.config.runTimeoutMs);
  let release: (() => void) | undefined;
  let ready = false;
  let releaseGateway: (() => void) | undefined;
  let inbound: ReturnType<typeof supervisorDiscord> | undefined;
  let sources: EventSources | undefined;
  let scheduleOps: OperationStore | undefined;
  let reports: LaneReportStore | undefined;
  let runners: SupervisorRunners | undefined;
  let laneMessages: LaneMessageStore | undefined;
  let stopConfigWatch: (() => void) | undefined;
  const hubCall = runnerCallsOf(() => runners?.handle);
  // The caller's ops (cli.ts: the CLI relay, which this process serves) are replaced by the hub's own.
  deps = { ...deps, ops: laneOps(hubCall, { now: deps.clock.now, log: (line) => { console.error(line); } }) };
  const watchdog = new Watchdog(deps.clock.now, notify);
  let petting: ReturnType<typeof setInterval> | undefined;
  const stop = new AbortController();
  let tasks: Promise<unknown> | undefined;
  let ci: CiFollowUp | undefined;
  try {
    release = probe.step("lock", () => acquireSupervisor(deps.config.stateDir));
    const token = discordOptions.token ?? probe.step("credential", () => resolveCredential("DORI_DISCORD_TOKEN"));
    if (!token) throw new SuperviseError("supervise requires DORI_DISCORD_TOKEN for lossless paginated Discord polling");
    releaseGateway = probe.step("gateway-lock", () => acquireDiscordGateway(token, gatewayLockDir));
    const discord = new Discord(fetchHttp, deps.clock, token);
    const stateDir = deps.config.stateDir;
    // A [System] post of the supervisor's own into `channel`; a thread the owner closed gets nothing (a post would reopen
    // it): one line linking it goes to its parent channel, else the owner channel (redirectIfClosed).
    const systemPost = async (channel: string, text: string, id?: string): Promise<void> => {
      const body = systemText(text);
      const redirected = await redirectIfClosed(stateDir, discord, channel, body, deps.config.discordChannels[0], (target, line) => discord.send(target, line, id));
      if (redirected) console.log(`SYSTEM_POST_REDIRECTED ${channel}: closed by the owner, one line went to ${redirected}`);
      else await discord.send(channel, body, id);
    };
    const supervisor = probe.step("supervisor", () => new Supervisor(deps, {
      react: (op, channel, message, emoji) => op === "add" ? discord.react(channel, message, emoji) : discord.unreact(channel, message, emoji),
      persistLeadPane: (pane) => { saveLeadPane(stateDir, pane); },
      // A line into a lane thread is appended to its last report (or status message), never a new post into a thread the owner closed.
      // A line with no thread (lead stuck, restarts capped) is a system notice: config alertsChannel, else the main channel.
      announce: async (text, id, thread) => {
        await postOwnerLine(discord, thread ? deps.config.discordChannels[0] : alertsChannelOf(deps.config), thread, systemText(text), id, {
          stateDir,
          statusMessage: async (threadId) => (await deps.registry.open()).find((lane) => lane.thread.endsWith(`/${threadId}`))?.statusMessageId,
        });
      },
    }));
    deps = await ensureLeadPane(deps, supervisor);
    const ops = scheduleOps = probe.step("schedules", () => openOperations(deps.config));
    const home = process.env.HOME ?? "";
    const registry = sources = openEventSources(deps, supervisor, ops, hubCall, home);
    const enqueueSweep = registry.enqueueFor("sweeps");
    const enqueueWait = registry.enqueueFor("waits");
    const enqueueDiscord = registry.enqueueFor("discord");
    const autopilot = autopilotTask(deps, ops, registry);
    const waits = probe.step("waits", () => new Waits(deps.config.stateDir, deps.tunables.waitMaxFailures, hubCall));
    const { github, review, follow, poll: pollGithub } = githubPolling(deps, probe, registry.enqueueFor("github"));
    ci = follow;
    const boot = randomUUID();
    const sweep = sweepTask({
      deps, supervisor, discord, review, registry, enqueue: enqueueSweep, home, boot, watchdog, probe,
      reports: () => reports, runnerGuard: () => runners?.guard, openPulls: () => github.openPulls(),
    });
    const retry = leadDelivery(deps, supervisor, systemPost, boot);
    let deliveryError: unknown;
    const laneMessageStore = (): LaneMessageStore => (laneMessages ??= openLaneMessages(deps.config));
    const discordInbound = inbound = probe.step("inbound", () => supervisorDiscord(deps, {
      ...discordOptions, token, emit: async (id, line) => { enqueueDiscord(id, line); }, laneMessages: laneMessageStore,
      http: discordOptions.http ?? ((request) => fetchHttp({
        ...request, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      })),
      lookup: discordOptions.lookup ?? quotaReport(sharedQuotaLookup(deps.config), deps.config.displayTimeZone),
      // The lead pane is read per request: a pane recreated after startup is in the supervisor, not in deps.
      statusLookup: discordOptions.statusLookup ?? ((lookupSignal, page) =>
        lookupStatus({ ...deps, config: { ...deps.config, leadPane: supervisor.leadPane } })(lookupSignal, page)),
    }));
    const reportStore = reports = probe.step("lane-reports", () => openLaneReports(deps.config));
    // The status message rides the supervisor's own Discord client, so a token from ~/.dori/env works as well as the environment.
    const statusTransport = statusTransportOf(discord);
    // Owner decision threads ride the same client: a lane question with choices opens one (owner-approved exception to
    // the supervisor never talking to the owner), and the decision tick runs with the report checks.
    const decisionCtx: DecisionContext = { config: deps.config, transport: discord, now: deps.clock.now, home };
    const routeLaneReports = laneReportsPass({
      deps, ops, reports: reportStore, review, transport: statusTransport, decisions: decisionCtx, home, enqueue: enqueueSweep, watchdog,
    });
    const notices = ownerNotices({ deps, supervisor, discord, decisions: decisionCtx, laneMessages: laneMessageStore, ownerNotice: systemPost });
    const hub = runners = new SupervisorRunners({
      deps, home, operations: ops, boot, emit: (id, line) => { enqueueSweep(id, line); }, reports: () => reports, laneMessages: laneMessageStore,
      settleWait: (label, waitId) => { waits.settleRemote(label, waitId, enqueueWait); }, systemPost, spawnRunner, signal: AbortSignal.any([signal, stop.signal]),
    });
    await hub.tryOpen((name, work) => probe.step(name, work));
    // config.json edits apply without a restart: the live keys are written into the config objects every part holds
    // (this loop's and the supervisor core's), so in-flight events, waits, lanes and the gateway are untouched.
    if (configFile) {
      const reload = configReloader({
        path: configFile, current: () => deps.config,
        apply: (patch) => { applyConfigPatch([deps.config, supervisor.config], patch); },
        enqueue: (id, line) => { enqueueSweep(id, line); }, log: (line) => { console.error(line); },
      });
      stopConfigWatch = watchConfigFiles([configFile], reload);
    }
    console.log(`SUPERVISOR_READY ${supervisor.eventLog}`);
    await probe.step("ready", () => notify("READY=1"));
    ready = true;
    probe.report("ready");
    petting = setInterval(() => { void watchdog.pet(); }, WATCHDOG_PET_MS);
    const halted = AbortSignal.any([signal, stop.signal]);
    const task = taskRunner(probe, watchdog, wait, halted);
    tasks = Promise.all([
      // A long-lived stream, not a pass: it reconnects on its own and is not tracked by the watchdog.
      autopilot.events.run(halted),
      task("inbound", 5_000, async () => {
        try { await registry.guard("discord", discordInbound.tick()); } catch (e) { console.error(`INBOUND_ERROR ${e instanceof Error ? e.message : String(e)}`); }
        writeHeartbeat(deps, inbound);
      }),
      task("delivery", 5_000, async () => {
        if (!retry.due) return;
        // A fatal delivery error ends the supervisor, as in the loop.
        try { await watchdog.track("delivery", retry.tick()); } catch (e) { deliveryError = e; stop.abort(); }
      }),
      // Owner notices and the lead-side checks post to Discord (each post can take minutes against a failing Discord), so
      // they run beside lead delivery, never in front of it.
      task("notices", 5_000, notices),
      task("sweeps", 30_000, sweep),
      task("polling", 5_000, pollingPass({ deps, registry, waits, enqueueWait, enqueueSweep, pollGithub, follow, watchdog })),
      // Lane reports ride their own loop: a GitHub call can hold a polling pass for its whole timeout.
      task("reports", 5_000, routeLaneReports),
      task(AUTOPILOT_TASK, AUTOPILOT_PASS_MS, autopilot.pass),
      task(RUNNERS_TASK, RUNNERS_PASS_MS, () => hub.pass()),
    ]);
    probe.close();
    await watchTasks(deps, supervisor, watchdog, systemPost, boot, wait, halted);
    stop.abort();
    await settle(tasks);
    // Waited for once: the finally below does not spend a second grace on a pass still running.
    tasks = undefined;
    if (deliveryError) throw deliveryError;
  } finally {
    // A startup that failed or was stopped early still logs how far it got.
    if (probe.active) {
      probe.report(ready ? "first-pass-incomplete" : "startup-incomplete");
      probe.close();
    }
    if (petting !== undefined) clearInterval(petting);
    stopConfigWatch?.();
    stop.abort();
    await settle(tasks);
    await inbound?.close();
    if (inbound) writeGatewayStatus(deps.config.stateDir, { pid: process.pid, at: deps.clock.now(), connected: false, messageContent: false });
    reports?.close();
    await runners?.close();
    laneMessages?.close();
    sources?.close();
    scheduleOps?.close();
    ci?.close();
    releaseGateway?.();
    release?.();
  }
};
