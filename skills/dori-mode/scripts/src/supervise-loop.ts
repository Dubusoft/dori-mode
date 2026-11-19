import { existsSync, type FSWatcher, mkdirSync, readFileSync, watch } from "node:fs";
import { addKnownSecrets, replaceKnownSecrets } from "./redact.ts";
import { SecretStore } from "./secret-store.ts";
import { homedir } from "node:os";
import { resolveCredential } from "./credentials.ts";
import { alertsChannelOf, deliveryConfigError, loadConfig } from "./config.ts";
import { applyConfigPatch, configReloader, watchConfigFiles } from "./config-watch.ts";
import { ensureLaneWorkspace, ManagedPanesError, saveLeadPane } from "./managed-panes.ts";
import { defaultRunnerDir } from "./runner/fs-safety.ts";
import { readRunnerRows } from "./runner/hub.ts";
import { fileOutageStore, LivenessMonitor, livenessIo } from "./runner/liveness.ts";
import { type LaneHubDeps, reconcileInventory, runnerJournalHead } from "./runner/lanes-hub.ts";
import { RunnerGuardBoard } from "./runner/guard.ts";
import { type RunnerCall, RunnerCalls, RunnerUnavailable } from "./runner/call.ts";
import { laneOps, machineRunner, runnerOf } from "./lane-ops.ts";
import { supervisorCommandRunner, supervisorGranter, supervisorSecretHandler } from "./runner/secret-serve.ts";
import { cliSocketPath, serveCliRelay } from "./runner/cli-relay.ts";
import { type LocalChild, type LocalChildDeps, localRunnerArgv, spawnProcess, startLocalRunner } from "./runner/local-child.ts";
import type { InventoryLane } from "./runner/protocol.ts";
import { type LaneMessageStore, openLaneMessages } from "./lane-messages.ts";
import { drainRunnerAdmin, LOCAL_RUNNER } from "./runner/serve.ts";
import { closedLanesOf } from "./runner/cleanup.ts";
import type { Listener } from "./runner/transport.ts";
import { listenUnix } from "./runner/unix-transport.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { type Emit, watchTick, type FlowDeps } from "./done-flow.ts";
import { newPendingCleanup } from "./closed-cleanup.ts";
import { resumeAnsweredGoals } from "./decision-resume.ts";
import { freshnessTick, scrubForThread } from "./freshness.ts";
import { quotaReport } from "./claude-quota.ts";
import { sharedQuotaLookup } from "./quota-cache.ts";
import { recoverLanes, type RecoveryEnqueue } from "./recover.ts";
import { memorySizeTrigger, memorySweep } from "./memory-check.ts";
import { alertReasons, diskGuardPath, type GuardState, guardTick, type HostSample, memIsLow, sampleHost } from "./host-guard.ts";
import { type Lane, statusOf } from "./registry.ts";
import { AutoUpdate, doriRepoOf, noteDevMerge } from "./auto-update.ts";
import { staleBlocker } from "./update-blocker.ts";
import { type GuardMachine, loadMachineGuardState, machineGuardTick, readGuardMachines, saveMachineGuardState } from "./remote-guard.ts";

import { run, type Runner, setDefaultRunTimeout } from "./run.ts";
import { canLaunch, clearLaunchHold, launchHeld } from "./routing.ts";
import { machineVerdict, summaryOf } from "./placement.ts";
import { Discord } from "./messenger/discord.ts";
import { acquireDiscordGateway } from "./messenger/discord-lock.ts";
import { supervisorDiscord, type SupervisorDiscordOptions } from "./messenger/discord-supervisor.ts";
import { closeThreadButton } from "./messenger/discord-commands.ts";
import { fetchHttp } from "./messenger/http.ts";
import { postOwnerLine } from "./lane-finish.ts";
import { appendFollowUp, redirectIfClosed } from "./thread-followup.ts";
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
import { type BuiltinSource, EventSources, type SourceEnqueue, SourceSpecs } from "./event-sources.ts";
import { autopilotLocalStateKey } from "./autopilot.ts";
import { judgeCandidates, liveJudgeDeps, RECONCILE_JOB } from "./autopilot-cli.ts";
import { AUTOPILOT_KICK_EVENTS, AutopilotTick } from "./autopilot-tick.ts";
import { liveExecutorDeps, reconcileExecutions, runExecutor } from "./autopilot-executor.ts";
import { pidAlive, releaseSlot, trySlot } from "./heavy-slot.ts";
import { ToodoEvents } from "./toodo-events.ts";
import { openOperations, type OperationStore } from "./operations.ts";
import { routeReports } from "./lane-reports.ts";
import { type LaneReportStore, openLaneReports } from "./lane-report-store.ts";
import { firstStatusTick, statusTransportOf } from "./lane-status.ts";
import { criticalTick, errText, guardAlertDetail, laneMemoryOf, MACHINE_GUARD_STATE_FILE, type PressureIo, pressureIo, warnMachineLanes } from "./supervise-guard.ts";
import { laneEventReader, openRunnerHub, readBackRunnerStarts, RUNNER_LANE_CURSOR_FILE, type RunnerHubHandle } from "./supervise-hub.ts";
import { decisionDeliveryTick, reconcileDecisionsAtStart } from "./decision-delivery.ts";
import { type DecisionContext, openLaneDecision, ownerDecisionTick } from "./owner-decisions.ts";
import { relayLine, retryDecisionRelays } from "./decision-relay.ts";

/** How long the machine guard reuses `herdr machine list` before reading it again. */
const MACHINE_LIST_TTL_MS = 10 * 60_000;
/** After a failed `herdr machine list`, the previous list is kept and the read is retried this much later. */
const MACHINE_LIST_RETRY_MS = 60_000;

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
/** The fifth task: liveness, lane events, runner admin, journal pruning; it reopens a hub that failed to open. */
export const RUNNERS_TASK = "runners";
/** The autopilot tick's task (autopilot-tick.ts); it judges only while the toodo source is enabled. */
export const AUTOPILOT_TASK = "autopilot";
export const AUTOPILOT_PASS_MS = 5_000;
/** How often the runners task runs; the hub itself answers frames as they arrive. */
export const RUNNERS_PASS_MS = 5_000;
/** How often the polling task delivers queued lane messages (lead steering, CI, rebase), apart from the GitHub poll. */
export const LANE_MESSAGES_PASS_MS = 30_000;
/** How often the runners task tries to open a runner hub that failed to open. */
export const RUNNER_HUB_RETRY_MS = 30_000;
/** How often the runners task drops old rows from the hub's runner event journal. */
const RUNNER_JOURNAL_PRUNE_MS = 60 * 60_000;

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
  // The saved machines change rarely: re-listed every MACHINE_LIST_TTL_MS, so a steady round adds no herdr call.
  let guardMachines: { readonly at: number; readonly list: GuardMachine[] } | undefined;
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
    ["freshness", async () => (await freshnessTick(deps, view, laneReports(), admitted)).map((act) => `${act.kind.toUpperCase()} ${act.lane} ${act.detail}`)],
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
    // Last, so a slow herdr machine list never delays the pane reads of the sweeps before it.
    ["machine-guard", async (emit) => {
      const now = deps.clock.now();
      if (!guardMachines || now - guardMachines.at >= MACHINE_LIST_TTL_MS) {
        const listed = await readGuardMachines(deps.run, deps.config.guardMachines, deps.config.stateDir);
        if (listed.ok) guardMachines = { at: now, list: listed.machines };
        else {
          guardMachines = { at: now - MACHINE_LIST_TTL_MS + MACHINE_LIST_RETRY_MS, list: guardMachines?.list ?? listed.machines };
          await emit(`SWEEP_WARN machine-guard herdr machine list failed: ${listed.detail}`);
        }
      }
      // Only machines with an enrolled runner are guarded (a machine without one is not); each is judged from its runner's
      // fresh sample, and one whose runner is quiet is skipped this round (the liveness monitor reports it). An enrolled
      // label missing from the machine list is its own ssh target. The runner kills by itself, so a machine's critical
      // stage reports the kills it sent.
      const board = runnerGuard();
      if (!board) return [];
      const listedByLabel = new Map(guardMachines.list.map((m) => [m.label, m] as const));
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
        const note = await warnMachineLanes(deps.ops, machine, sample, open, deps.config.guard.memFreeMinPct).catch((e) => `warning failed: ${errText(e)}`);
        if (note) warned.set(machine.label, note);
      }));
      const lanesOn = (m: GuardMachine): string | undefined => {
        const keys = open.filter((l) => l.machine !== undefined && (l.machine === m.label || l.machine === m.id)).map((l) => l.key);
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
 * The supervisor owns the lead pane and the lanes workspace: before its tasks start it recreates a lead pane that is
 * missing (none recorded, or herdr lost it) and finds or creates the lanes workspace, both recorded in dori state. A herdr
 * failure here is logged and left to the lead-pane repair retries and to the next launch, which ensures the workspace again.
 */
const ensureManagedPanes = async (deps: FlowDeps, supervisor: Supervisor): Promise<FlowDeps> => {
  let config = deps.config;
  try {
    await supervisor.repairLeadPane();
    config = { ...config, leadPane: supervisor.leadPane };
  } catch (error) {
    console.error(`LEAD_PANE_ENSURE_FAILED ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const laneWorkspace = await ensureLaneWorkspace(deps.run, config.stateDir, config.leadCwd, (line) => { console.log(line); });
    config = { ...config, laneWorkspace };
  } catch (error) {
    if (!(error instanceof ManagedPanesError)) throw error;
    console.error(`LANE_WORKSPACE_ENSURE_FAILED ${error.message}`);
  }
  return { ...deps, config };
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
 * Polling and sweeps enqueue independently of the single serialized lead delivery. There is no single loop: inbound,
 * delivery (with the owner notices and ack ticks), sweeps and GitHub/wait polling each run as their own task, so none
 * waits behind another; a stuck one is reported by name (TASK_STALLED) while the other three keep working, and each sweep
 * is tracked by the watchdog. Each startup step up to READY=1 is timed by `probe` (STARTUP_TIMINGS, STARTUP_SLOW <step>),
 * so a hang names its step, and each task's first pass is reported as `first-<task>` (`first-sweep` for the sweeps).
 */
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
  setDefaultRunTimeout(deps.config.runTimeoutMs);
  let release: (() => void) | undefined;
  let ready = false;
  let releaseGateway: (() => void) | undefined;
  let inbound: ReturnType<typeof supervisorDiscord> | undefined;
  let sources: EventSources | undefined;
  let scheduleOps: OperationStore | undefined;
  let reports: LaneReportStore | undefined;
  let runnerHub: RunnerHubHandle | undefined;
  let localRunner: LocalChild | undefined;
  let stopRelay: (() => void) | undefined;
  let relayListener: Listener | undefined;
  let laneMessages: LaneMessageStore | undefined;
  let stopConfigWatch: (() => void) | undefined;
  // Lane operations go through the hub's RunnerCalls; until the hub is open every call fails closed.
  const hubCall: RunnerCall = {
    call: (label, type, body, opts) => {
      if (!runnerHub) return Promise.reject(new RunnerUnavailable(label, "disconnected", "the runner hub is not open"));
      return runnerHub.calls.call(label, type, body, opts);
    },
    query: (label, type, body, opts) => {
      if (!runnerHub) return Promise.reject(new RunnerUnavailable(label, "disconnected", "the runner hub is not open"));
      return runnerHub.calls.query(label, type, body, opts);
    },
    connected: (label) => runnerHub?.calls.connected(label) ?? false,
  };
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
    // An owner notice goes where the message came from: its Discord channel or thread.
    const ownerNotice = (channel: string, text: string, id: string): Promise<void> => systemPost(channel, text, id);
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
    deps = await ensureManagedPanes(deps, supervisor);
    // Every built-in enqueues through the source registry, which records its last event and errors. The schedule sources
    // run too, each run an operation row; a heavy job takes a heavy slot like `dori heavy`, without waiting for one.
    const ops = scheduleOps = probe.step("schedules", () => openOperations(deps.config));
    // The host's load only (no pane count): a scheduled heavy job's maxLoad.
    const heavyLoad = async (): Promise<number> => (await sampleHost(deps.run, diskGuardPath(deps.config), async () => -1)).load1;
    const home = process.env.HOME ?? "";
    const registry = sources = new EventSources({
      stateDir: deps.config.stateDir, enqueue: (id, line, meta) => supervisor.enqueue(id, line, meta), now: deps.clock.now, run: deps.run,
      policy: deps.tunables.eventPolicy, log: (line) => { console.error(line); }, remote: hubCall,
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
    const enqueueOf = (name: BuiltinSource): SourceEnqueue => registry.enqueueFor(name);
    const guarded = <T>(name: BuiltinSource, work: Promise<T>): Promise<T> => registry.guard(name, work);
    const enqueueSweep = enqueueOf("sweeps");
    const enqueueWait = enqueueOf("waits");
    const enqueueGitHub = enqueueOf("github");
    const enqueueDiscord = enqueueOf("discord");
    // AUTOPILOT_READY counts under the toodo source: it is what toodo's marked tasks add up to.
    // The executor's deps are rebuilt per call over the live `deps`, so a config reload applies; the toodo source journals its notices.
    const executorDeps = () => liveExecutorDeps(deps, ops, enqueueOf("toodo"), (line) => { console.error(line); });
    const autopilot = new AutopilotTick({
      tickMs: () => deps.config.autopilot.tickSec * 1000,
      executorOn: () => deps.config.autopilot.executor,
      execute: async (ids) => { const exec = executorDeps(); await reconcileExecutions(exec); return runExecutor(exec, ids); },
      judge: () => judgeCandidates(liveJudgeDeps(deps, ops)), enqueue: enqueueOf("toodo"), now: deps.clock.now,
      localState: async () => autopilotLocalStateKey(ops, new Set((await deps.registry.open()).map((l) => l.key))),
      log: (line) => { console.error(line); },
    });
    // The tick replaced the hourly autopilot-reconcile schedule job; one left from an earlier version is removed.
    try { if (new SourceSpecs(deps.config.stateDir).remove(RECONCILE_JOB)) console.log(`AUTOPILOT_RECONCILE_JOB_REMOVED ${RECONCILE_JOB}: the supervisor's autopilot tick replaces it`); }
    catch (e) { console.error(`AUTOPILOT_RECONCILE_JOB_ERROR ${e instanceof Error ? e.message : String(e)}`); }
    let executorStarted = false;
    const toodoEvents = new ToodoEvents({
      config: deps.tunables.toodoEvents, stateDir: deps.config.stateDir, enqueue: enqueueOf("toodo"),
      fail: (e) => { registry.fail("toodo", e); }, ok: () => { registry.ok("toodo"); }, log: (line) => { console.error(line); },
      onEvent: (event) => { if (AUTOPILOT_KICK_EVENTS.has(event)) autopilot.kick(); },
    });
    const waits = probe.step("waits", () => new Waits(deps.config.stateDir, deps.tunables.waitMaxFailures, hubCall));
    const github = probe.step("github", () => new GitHubEvents(deps.config.stateDir, deps.clock.now));
    const ownRepo = doriRepo(deps);
    // A merge of dori's own repo into dev queues the automatic update (the auto-update sweep runs it).
    // One review gate per supervisor (construction recovers its job store): CI follow-up merges only what it approved.
    const review = probe.step("review-gate", () => new ReviewGate(deps));
    const follow = ci = probe.step("ci-follow", () => new CiFollowUp(deps, review, {
      ...defaultCiIo,
      merged: async (pull, base) => {
        if (base === "dev" && pull.repo.toLowerCase() === await ownRepo()) noteDevMerge(deps.config.stateDir, `${pull.repo}#${pull.number}`);
      },
    }));
    // CI follow-up reads the poll it follows, so it runs right after each GitHub tick.
    const pollGithub = async (): Promise<void> => {
      await github.tick(deps, enqueueGitHub);
      await follow.tick(github.openPulls(), enqueueGitHub, github.mergedPulls());
      // Timeouts, reviewer intake and close, snapshot release (review-gate.ts); errors per job are logged there.
      await review.tick(enqueueGitHub);
    };
    // The sweep task gets its own span, so its timings never mix into the startup report.
    const sweepProbe = probe.span();
    // Each sweep is tracked: one stuck past WATCHDOG_STALL_MS withholds the watchdog.
    // The watcher reads its claim announcements back from the journal.
    // The supervisor finishes a merged lane's Toodo task and appends the merge to its report (task-finish.ts).
    // An autopilot task it cannot finish, or whose lane closed cancelled, gets a blocker note instead.
    const toodoWriter = new ToodoWriter(deps.tunables.toodoWriter);
    const finishTask = taskFinisher({ writer: toodoWriter, append: (lane, text) => appendFollowUp(stateDir, discord, lane, text), language: () => deps.config.ownerLanguage });
    // A clean done claim of a lane config autoReport covers is posted as its report by the supervisor (auto-report.ts).
    const autoReport = autoReportPoster({ config: deps.config, discord, now: deps.clock.now, home: home || homedir(), language: () => deps.config.ownerLanguage });
    // The watch sweep holds a lane whose review is pending through the same gate CI follow-up merges with (D11).
    const sweepDeps: FlowDeps = withReviewHold({ ...deps, leadDelivered: (id) => supervisor.leadDelivered(id), finishTask, blockTask: taskBlocker(toodoWriter), autoReport }, review);
    const sweeps = supervisorSweeps(sweepDeps, home, async (line, id) => { enqueueSweep(id, line); }, () => reports, pressureIo(sweepDeps), () => runnerHub?.guard, () => github.openPulls()).map(([name, step]): Sweep => [name, async (emit) =>
      watchdog.track(`sweep:${name}`, sweepProbe.step(`loop:sweep:${name}`, () => step(emit)))]);
    const recentWarnings = new Map<string, number>();
    const boot = randomUUID();
    const retry = new RetryingDelivery({
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
    let sequence = 0;
    let deliveryError: unknown;
    const emit = async (id: string, line: string): Promise<void> => { enqueueDiscord(id, line); };
    const discordInbound = probe.step("inbound", () => supervisorDiscord(deps, {
      ...discordOptions, token, emit, laneMessages: () => (laneMessages ??= openLaneMessages(deps.config)),
      http: discordOptions.http ?? ((request) => fetchHttp({
        ...request, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      })),
      lookup: discordOptions.lookup ?? quotaReport(sharedQuotaLookup(deps.config), deps.config.displayTimeZone),
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
    // The status message rides the supervisor's own Discord client, so a token from ~/.dori/env works as well as the environment.
    const statusTransport = statusTransportOf(discord);
    // Owner decision threads ride the same client: a lane question with choices opens one (owner-approved exception to
    // the supervisor never talking to the owner), and the decision tick runs with the report checks.
    const decisionCtx: DecisionContext = { config: deps.config, transport: discord, now: deps.clock.now, home };
    let nextHistoryPrune = 0;
    const routeLaneReports = (): Promise<void> => watchdog.track("reports", (async () => {
      const now = deps.clock.now();
      if (now >= nextHistoryPrune) {
        ops.prune(now);
        reportStore.prune(now);
        nextHistoryPrune = now + 60 * 60_000;
      }
      const lines = await routeReports(deps, reportStore, enqueueSweep, home, statusTransport, (lane, report) => openLaneDecision(decisionCtx, lane, report),
        reviewSectionOf(deps, review));
      // Review status in each author lane's status message and the owner decision of a reached review limit
      // (review-status.ts), right after the reports so the two never write one status message at once.
      lines.push(...await reviewStatusTick({
        flow: deps, stores: review, reports: reportStore, transport: statusTransport, decisions: decisionCtx, home,
        emit: (id, line) => { enqueueSweep(id, line); },
      }));
      return [...lines, ...await firstStatusTick(deps, statusTransport, reportStore, home)];
    })())
      .then((lines) => { for (const line of lines) console.log(line); })
      .catch((e: unknown) => { console.error(`LANE_REPORTS_ERROR ${e instanceof Error ? e.message : String(e)}`); });
    const tickSources = (): Promise<void> => watchdog.track("sources", registry.tick())
      .catch((e: unknown) => { console.error(`SOURCES_ERROR ${e instanceof Error ? e.message : String(e)}`); });
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
          await ownerNotice(channel, text, `${kind}:${channel}:${message}`);
          supervisor.noticeSent(kind, channel, message);
        }
        catch (e) { console.error(`${failCode} ${channel}/${message}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    };
    // An owner message the lead has not taken within a minute gets one plain line in its own channel or thread.
    const noticeOverdue = (): Promise<void> => noticeDue("delay", deps.tunables.ownerDelayNotice, "OWNER_NOTICE_ERROR", "OWNER_NOTICE_FAILED",
      () => supervisor.overdueOwnerMessages(OWNER_NOTICE_AFTER_MS));
    // A message the lead was handed but never acked is re-pushed, and after a second window the owner gets one line.
    const noticeUnacked = (): Promise<void> => noticeDue("ack", deps.tunables.ackMissingNotice, "ACK_CHECK_ERROR", "ACK_NOTICE_FAILED",
      () => supervisor.ackTick(deps.tunables.ackTimeoutSec * 1_000), "ACK_MISSING_NOTICE");
    // A message the lead acked but never linked to lanes or a reply: UNHANDLED wakes it, then the owner gets one line.
    const noticeUnhandled = (): Promise<void> => noticeDue("unhandled", deps.tunables.unhandledNotice, "HANDLED_CHECK_ERROR", "UNHANDLED_NOTICE_FAILED",
      () => supervisor.handledTick(deps.tunables.handledTimeoutMin * 60_000), "UNHANDLED_NOTICE");
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
          await reconcileDecisionsAtStart(deps.config.stateDir, laneMessages ??= openLaneMessages(deps.config), open, deps.clock.now(),
            (id, line) => supervisor.enqueue(id, line), (line) => { console.error(line); });
          decisionsReconciled = true;
        });
      }
      // Every round: direct answers' acks close their decisions, the owner's status line follows each answer, and an
      // answer whose lane session went away is handed to the lead once.
      await isolate("DECISION_DELIVERY_ERROR", () => decisionDeliveryTick({ ...decisionCtx, enqueue: (id, line) => supervisor.enqueue(id, line), log: (line) => { console.error(line); } },
        laneMessages ??= openLaneMessages(deps.config), async () => (await deps.registry.list()).filter((lane) => statusOf(lane) !== "closed")));
      // A close text its lane did not take is tried again before the tick raises DECISION_RELAY_FAILED for it.
      await isolate("DECISION_RELAY_RETRY_ERROR", async () => {
        for (const d of await retryDecisionRelays(deps)) { const line = relayLine(d); if (line) console.error(line); }
      });
      // Owner decisions: a stuck post, a missing link line, a pending archive, a queued secret request.
      await isolate("OWNER_DECISION_CHECK_ERROR", () => ownerDecisionTick({ ...decisionCtx, enqueue: (id, line) => supervisor.enqueue(id, line), log: (line) => { console.error(line); } }));
      // A thread whose work is all finished and reported gets the owner's close button on its last report, and is closed
      // (archived) once threadCloseAfterHours pass with no click.
      await isolate("THREAD_AUTO_CLOSE_CHECK_ERROR", () => supervisor.autoCloseTick({
        button: (thread, message, state) => discord.editComponents(thread, message, state === "none" ? [] : closeThreadButton(thread, state === "closed")),
        archive: (thread) => discord.setThread(thread, { archived: true }),
      }));
    };
    let lastGitHub = -Infinity;
    let lastLaneMessages = -Infinity;
    // The hub always opens: every lane is runner-owned, and the local runner is this process's child. An unsafe runner
    // directory or a busy socket costs the hub, never the supervisor: the lead gets RUNNER_HUB_DISABLED, every lane
    // operation fails closed, and the runners task tries again every RUNNER_HUB_RETRY_MS until it opens.
    let liveness: LivenessMonitor | undefined;
    let takeLaneEvents: () => Promise<void> = async () => {};
    const openRunners = async (step: <T>(name: string, work: () => T) => T): Promise<void> => {
      try {
        const runnerDir = defaultRunnerDir(home || undefined);
        // Heartbeats and hellos feed the liveness monitor, built right after the hub because it needs the hub's epoch.
        let monitor: LivenessMonitor | undefined;
        // Lane events and hellos are taken one at a time, in arrival order, so a lane.started lands before its reports.
        let laneWork: Promise<void> = Promise.resolve();
        const laneDeps: LaneHubDeps = {
          stateDir: deps.config.stateDir,
          registry: deps.registry, reports: () => reports, now: deps.clock.now,
          emit: (id, line) => { enqueueSweep(id, line); },
          prepareRecovery: async (label, key) => {
            // Inventory absence means RUNNER_LANE_UNKNOWN; only ordinary recovery scans for a relaunch.
            runnerHub?.accept.checkFileCapability(label, "lane.recover");
            return { cmdId: `recover:${key}:${deps.clock.now()}`, notes: [] };
          },
          recover: (label, key, prepared) => runnerHub?.accept.command(label, "lane.recover", {
            cmdId: prepared.cmdId, key, ...(prepared.briefText !== undefined ? { briefText: prepared.briefText } : {}),
            ...(prepared.files ? { files: prepared.files } : {}),
          }),
          close: (label, key, cmdId) => runnerHub?.accept.command(label, "lane.close", { cmdId, key, worktreeChecks: false }),
          journalHead: () => runnerJournalHead(deps.config.stateDir),
          // A lane's `dori report ack` arrives as lane.ack and is applied to the lane message store.
          messages: () => (laneMessages ??= openLaneMessages(deps.config)),
          // At each hello the runner gets every owned lane's notice back, for `dori lane status` inside the lane.
          notify: (_label, lane) => deps.ops.notify(lane, {
            status: lane.status ?? "working",
            ...(lane.objection ? { objection: lane.objection } : {}),
            ...(lane.claim ? { claim: { at: lane.claim.at, evidence: lane.claim.evidence } } : {}),
          }),
        };
        // After a supervisor restart, a lane.start an earlier run sent and never saw answered is read back (design 5.6).
        const readBackStarts = async (label: string, inventory: readonly InventoryLane[]): Promise<void> => {
          if (runnerHub) await readBackRunnerStarts(runnerHub, deps.registry, label, inventory, enqueueSweep, (line) => { console.log(line); });
        };
        const inOrder = (what: string, work: () => Promise<void>): void => {
          laneWork = laneWork.then(work).catch((e: unknown) => { console.error(`RUNNER_LANE_ERROR ${what} ${e instanceof Error ? e.message : String(e)}`); });
        };
        const hub = runnerHub = step("runners", () => openRunnerHub(deps.config.stateDir, runnerDir, deps.clock.now, () => performance.now(), (line) => { console.log(line); }, {
          onHeartbeat: (label) => { void monitor?.heartbeat(label); },
          onHerdr: (id, line) => { enqueueSweep(id, line); },
          // A runner's cleanup sweep asks for its closed lanes (lanes.closed): local lanes carry no machine, a remote runner's carry its label.
          onClosedLanes: async (label) => closedLanesOf(await deps.registry.archived(), label === LOCAL_RUNNER ? undefined : label),
          // A remote runner's secret.get: decided here with the registry, config and this host's store (secret-serve.ts).
          onSecret: supervisorSecretHandler({
            laneOwner: async (key) => { const lane = (await deps.registry.open()).find((l) => l.key === key); return lane && runnerOf(lane); },
            runnerUnsandboxed: (label) => deps.config.runners?.[label]?.allowUnsandboxed === true,
            granter: supervisorGranter({ store: new SecretStore(), onGranted: addKnownSecrets }),
            // A remote runner's secret.run: the op runs here, outside any lane; only its redacted output goes back.
            commandRunner: supervisorCommandRunner({
              store: new SecretStore(), onGranted: addKnownSecrets,
              commands: async () => (await loadConfig()).secretCommands,
              log: (line) => { console.log(line); },
            }),
            log: (line) => { console.log(line); },
          }),
          // A runner-owned wait that the runner saw met ends here (deduped with the check's own result by its event id);
          // `job.result` is kept in the runner journal only.
          onEvent: (label, frame) => {
            // A runner's own config reload (runner-config.json): reloaded, kept the last good one, or needs a restart.
            if (frame.type === "runner.config") {
              const kind = { reloaded: "RUNNER_CONFIG_RELOADED", invalid: "RUNNER_CONFIG_INVALID", restart: "RUNNER_CONFIG_RESTART_NEEDED" }[frame.body.state];
              enqueueSweep(`runner-config:${label}:${frame.gen}:${frame.seq}`, `${kind} runner=${label} ${frame.body.detail}`);
              return;
            }
            if (frame.type !== "wait.result" || frame.body.outcome !== "WAIT_DONE") return;
            try { waits.settleRemote(label, frame.body.waitId, enqueueWait); }
            catch (e) { console.error(`WAIT_ERROR runner=${label} wait=${frame.body.waitId} ${e instanceof Error ? e.message : String(e)}`); }
          },
          onHello: (label, body) => {
            void monitor?.hello(label, body.gen);
            inOrder(`hello ${label}`, async () => {
              await reconcileInventory(laneDeps, label, body.inventory ?? []);
              // Off the lane-event queue: the read-back awaits the runner's answers, which arrive as lane events too.
              void readBackStarts(label, body.inventory ?? []).catch((e: unknown) => {
                console.error(`RUNNER_READBACK_ERROR runner=${label} ${e instanceof Error ? e.message : String(e)}`);
              });
            });
          },
        }));
        // The lead's `dori` CLI reaches the runners through this process: <runnerDir>/sock/cli next to the control socket.
        relayListener = listenUnix(cliSocketPath(runnerDir));
        stopRelay = serveCliRelay(relayListener, hub.calls, (line) => { console.error(line); });
        // The local runner: `dori runner serve` as this process's child, restarted with backoff, stopped with it.
        const child = localRunner = startLocalRunner({
          spawn: spawnRunner ?? spawnProcess, argv: localRunnerArgv(join(import.meta.dir, "cli.ts")),
          env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
          clock: deps.clock, log: (line) => { console.log(line); },
        }, AbortSignal.any([signal, stop.signal]));
        // Resume after successfully processed events; an upgrade with no cursor reads the retained journal once.
        const readLaneEvents = laneEventReader(deps.config.stateDir, laneDeps);
        takeLaneEvents = () => {
          inOrder("journal", readLaneEvents);
          return laneWork;
        };
        let livenessSeq = 0;
        const io = livenessIo(deps.run, LOCAL_RUNNER, async () => (await readGuardMachines(deps.run, deps.config.guardMachines, deps.config.stateDir)).machines);
        monitor = liveness = new LivenessMonitor({
          monotonic: () => performance.now(), now: deps.clock.now, epoch: hub.hub.epoch, operations: ops,
          probe: io.probe,
          // The local runner is restarted as this process's child, a worker's over ssh.
          restart: async (label) => {
            if (label !== LOCAL_RUNNER) return io.restart(label);
            await child.restart();
            return { ok: true, detail: "child restart" };
          },
          ownedLanes: async (label) => (await deps.registry.open()).filter((l) => l.runner === label).map((l) => l.key),
          emit: (line) => { enqueueSweep(`runner-liveness:${deps.clock.now()}:${++livenessSeq}`, line); },
          // A runner outage the lead is woken for is also a system notice in the alerts channel. Not awaited: a hung post
          // must not stop the liveness tick.
          alert: (text) => {
            const channel = alertsChannelOf(deps.config);
            if (!channel) return;
            void systemPost(channel, scrubForThread(text, homedir()), `runner-liveness-alert:${boot}:${++livenessSeq}`)
              .catch((e: unknown) => { console.error(`RUNNER_ALERT_NOTIFY_FAILED ${e instanceof Error ? e.message : String(e)}`); });
          },
          // Escalated outages outlive this process: a restart neither wakes the lead again nor loses the ONLINE.
          outages: fileOutageStore(deps.config.stateDir),
        });
        for (const row of readRunnerRows(deps.config.stateDir)) monitor.track(row.label, row.maxGen);
      } catch (e) {
        // Whatever opened before the failure is closed, so a retry starts clean and nothing half-open answers calls.
        stopRelay?.();
        stopRelay = undefined;
        relayListener?.close();
        relayListener = undefined;
        await localRunner?.stop();
        localRunner = undefined;
        runnerHub?.close();
        runnerHub = undefined;
        liveness = undefined;
        takeLaneEvents = async () => {};
        throw e;
      }
    };
    // Why the hub is not open, while it is not; the lead hears of the outage once and of its end once.
    let hubDown: string | undefined;
    let lastHubAttempt = deps.clock.now();
    const tryOpenRunners = async (step: <T>(name: string, work: () => T) => T): Promise<void> => {
      lastHubAttempt = deps.clock.now();
      try { await openRunners(step); }
      catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        console.error(`RUNNER_HUB_DISABLED ${why}`);
        if (hubDown === undefined) {
          enqueueSweep(`runner-hub-disabled:${boot}:${lastHubAttempt}`, `RUNNER_HUB_DISABLED ${why}; every lane operation fails until the runner hub opens, the supervisor tries again every ${RUNNER_HUB_RETRY_MS / 1_000} s`);
        }
        hubDown = why;
        return;
      }
      if (hubDown !== undefined) {
        console.log("RUNNER_HUB_OPENED");
        enqueueSweep(`runner-hub-opened:${boot}:${lastHubAttempt}`, `RUNNER_HUB_OPENED the runner hub is open again (it had failed: ${hubDown})`);
        hubDown = undefined;
      }
    };
    await tryOpenRunners((name, work) => probe.step(name, work));
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
    let lastJournalPrune = -Infinity;
    console.log(`SUPERVISOR_READY ${supervisor.eventLog}`);
    await probe.step("ready", () => notify("READY=1"));
    ready = true;
    probe.report("ready");
    petting = setInterval(() => { void watchdog.pet(); }, WATCHDOG_PET_MS);
    // Each task is its own loop, so one stuck pass costs only that task. Every pass is tracked as task:<name>: the
    // loop below reports one running past TASK_ALERT_MS by name, and past WATCHDOG_STALL_MS it withholds the watchdog.
    const halted = AbortSignal.any([signal, stop.signal]);
    const task = (name: SupervisorTask | typeof RUNNERS_TASK | typeof AUTOPILOT_TASK, pauseMs: number, pass: () => Promise<void>): Promise<void> => (async () => {
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
      // A long-lived stream, not a pass: it reconnects on its own and is not tracked by the watchdog.
      toodoEvents.run(halted),
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
        if (deps.clock.now() - lastGitHub >= deps.tunables.githubPollSeconds * 1_000) {
          lastGitHub = deps.clock.now();
          polls.push(watchdog.track("github", guarded("github", pollGithub()))
            .catch((e: unknown) => { console.error(`GITHUB_ERROR ${e instanceof Error ? e.message : String(e)}`); }));
        }
        if (deps.clock.now() - lastLaneMessages >= LANE_MESSAGES_PASS_MS) {
          lastLaneMessages = deps.clock.now();
          polls.push(watchdog.track("lane-messages", follow.deliver(enqueueSweep))
            .catch((e: unknown) => { console.error(`LANE_MESSAGE_ERROR ${e instanceof Error ? e.message : String(e)}`); }));
        }
        polls.push(tickSources(), routeLaneReports());
        await Promise.all(polls);
      }),
      task(AUTOPILOT_TASK, AUTOPILOT_PASS_MS, async () => {
        // Switch on: crash reconcile once at start (never fatal); the tick reconciles again on every pass.
        if (!executorStarted && deps.config.autopilot.executor) {
          executorStarted = true;
          try { await reconcileExecutions(executorDeps()); } catch (e) { console.error(`AUTOPILOT_EXECUTOR_RECONCILE_ERROR ${e instanceof Error ? e.message : String(e)}`); }
        }
        if (deps.tunables.toodoEvents.enabled) await autopilot.tick();
      }),
      task(RUNNERS_TASK, RUNNERS_PASS_MS, async () => {
        if (!runnerHub && deps.clock.now() - lastHubAttempt >= RUNNER_HUB_RETRY_MS) await tryOpenRunners((_name, work) => work());
        const handle = runnerHub;
        if (!handle) return;
        try { await liveness?.tick(); } catch (e) { console.error(`RUNNER_LIVENESS_ERROR ${e instanceof Error ? e.message : String(e)}`); }
        try { await takeLaneEvents(); } catch (e) { console.error(`RUNNER_LANE_ERROR ${e instanceof Error ? e.message : String(e)}`); }
        // `dori runner revoke|rotate` queue their request for the live hub; answer them first.
        try { for (const line of drainRunnerAdmin(deps.config.stateDir, handle.accept, deps.clock.now(), (label) => { liveness?.untrack(label); })) console.log(line); }
        catch (e) { console.error(`RUNNER_ADMIN_ERROR ${e instanceof Error ? e.message : String(e)}`); }
        if (deps.clock.now() - lastJournalPrune >= RUNNER_JOURNAL_PRUNE_MS) {
          lastJournalPrune = deps.clock.now();
          let cursor = 0;
          try {
            const value: unknown = JSON.parse(readFileSync(join(deps.config.stateDir, RUNNER_LANE_CURSOR_FILE), "utf8"));
            if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) cursor = value;
          } catch {}
          handle.journal.prune(lastJournalPrune, cursor);
        }
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
    stopRelay?.();
    relayListener?.close();
    await localRunner?.stop();
    runnerHub?.close();
    laneMessages?.close();
    sources?.close();
    scheduleOps?.close();
    ci?.close();
    releaseGateway?.();
    release?.();
  }
};
