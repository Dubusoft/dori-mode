import { existsSync, type FSWatcher, mkdirSync, readFileSync, watch } from "node:fs";
import { replaceKnownSecrets } from "./redact.ts";
import { SecretStore } from "./secret-store.ts";
import { homedir, hostname } from "node:os";
import { resolveCredential } from "./credentials.ts";
import { alertsChannelOf, deliveryConfigError, loadConfig } from "./config.ts";
import { applyConfigPatch, configReloader, watchConfigFiles } from "./config-watch.ts";
import { ensureLaneWorkspace, ManagedPanesError, saveLeadPane } from "./managed-panes.ts";
import { defaultRunnerDir, ensureRunnerDir, ensureRunnerSubdir, RUNNER_PATHS, writeRunnerFile } from "./runner/fs-safety.ts";
import { RunnerAuth, SupervisorAuth } from "./runner/auth.ts";
import { HUB_FILE, readRunnerRows, RunnerHub } from "./runner/hub.ts";
import { LivenessMonitor, livenessIo } from "./runner/liveness.ts";
import {
  acceptLaneEvent, laneEventsAfter, type LaneHubDeps, type LaneStartReadbackDeps, readBackLaneStarts, reconcileInventory, runnerJournalHead,
} from "./runner/lanes-hub.ts";
import { COMMAND_RETENTION_MS } from "./runner/durability.ts";
import { RunnerGuardBoard } from "./runner/guard.ts";
import { HerdrDownInference } from "./runner/herdr-down.ts";
import { realTimers, type RunnerCall, RunnerCalls, RunnerUnavailable, type Timers } from "./runner/call.ts";
import { type Delivery, laneOps, type LaneOps, machineRunner, runnerOf } from "./lane-ops.ts";
import { supervisorCommandRunner, supervisorGranter, supervisorSecretHandler } from "./runner/secret-serve.ts";
import { cliSocketPath, serveCliRelay } from "./runner/cli-relay.ts";
import { type LocalChild, type LocalChildDeps, localRunnerArgv, spawnProcess, startLocalRunner } from "./runner/local-child.ts";
import { adoptLegacyLanes } from "./runner/adopt-legacy.ts";
import type { InventoryLane, LaneMemoryBody, SupervisorCommandBodies } from "./runner/protocol.ts";
import { type LaneMessageStore, openLaneMessages } from "./lane-messages.ts";
import {
  acceptRunners, drainRunnerAdmin, type HubHooks, LOCAL_RUNNER, loadIdentity, nextEpoch, openRunnerJournal, type RunnerAccept,
  type RunnerJournal,
} from "./runner/serve.ts";
import type { Listener } from "./runner/transport.ts";
import { controlSocketPath, listenUnix } from "./runner/unix-transport.ts";
import { dialWs, type DialingListener, type DialingOptions } from "./runner/ws-transport.ts";
import { readRunnerEndpoints } from "./runner/endpoints.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { type Emit, watchTick, type FlowDeps } from "./done-flow.ts";
import { freshnessTick, scrubForThread } from "./freshness.ts";
import { quotaReport } from "./claude-quota.ts";
import { sharedQuotaLookup } from "./quota-cache.ts";
import { recoverLanes, type RecoveryEnqueue } from "./recover.ts";
import { memorySweep } from "./memory-check.ts";
import { alertReasons, criticalReasons, diskGuardPath, type GuardState, guardTick, type HostSample, memIsLow, sampleHost } from "./host-guard.ts";
import { describeLane, formatKb, type LaneMemory, laneMemoryDetail } from "./lane-memory.ts";
import { pauseLane, type PauseResult } from "./pause.ts";
import type { Lane } from "./registry.ts";
import {
  type GuardMachine, type KillResult, loadMachineGuardState, machineGuardTick, type MachineSample, readGuardMachines, saveMachineGuardState,
} from "./remote-guard.ts";

import { run, type Runner, setDefaultRunTimeout } from "./run.ts";
import { canLaunch, clearLaunchHold, launchHeld } from "./routing.ts";
import { machineVerdict, summaryOf } from "./placement.ts";
import { Discord } from "./messenger/discord.ts";
import { acquireDiscordGateway } from "./messenger/discord-lock.ts";
import { supervisorDiscord, type SupervisorDiscordOptions } from "./messenger/discord-supervisor.ts";
import { fetchHttp } from "./messenger/http.ts";
import { postOwnerLine } from "./lane-finish.ts";
import { redirectIfClosed } from "./thread-followup.ts";
import { writeGatewayStatus } from "./gateway-status.ts";
import { lookupStatus } from "./status.ts";
import { OWNER_NOTICE_AFTER_MS, RetryingDelivery, SuperviseError, Supervisor } from "./supervise.ts";
import { Waits } from "./waits.ts";
import { GitHubEvents, type OpenPull } from "./github-events.ts";
import { driftTick, pullOwners } from "./drift.ts";
import { CiFollowUp } from "./ci-follow.ts";
import { newSweepCache, passthroughView, type SweepView, sweepRound } from "./sweep-view.ts";
import { StartupProbe } from "./startup-probe.ts";
import { type BuiltinSource, EventSources, type SourceEnqueue, SourceSpecs } from "./event-sources.ts";
import { autopilotLocalStateKey } from "./autopilot.ts";
import { judgeCandidates, liveJudgeDeps, RECONCILE_JOB } from "./autopilot-cli.ts";
import { AUTOPILOT_KICK_EVENTS, AutopilotTick } from "./autopilot-tick.ts";
import { pidAlive, releaseSlot, trySlot } from "./heavy-slot.ts";
import { ToodoEvents } from "./toodo-events.ts";
import { openOperations, type OperationStore } from "./operations.ts";
import { type LaneReportStore, openLaneReports, routeReports, statusTransportOf } from "./lane-reports.ts";
import { type DecisionContext, openLaneDecision, ownerDecisionTick } from "./owner-decisions.ts";

/** How long the machine guard reuses `herdr machine list` before reading it again. */
const MACHINE_LIST_TTL_MS = 10 * 60_000;
/** After a failed `herdr machine list`, the previous list is kept and the read is retried this much later. */
const MACHINE_LIST_RETRY_MS = 60_000;
/** The machine guard's state file in the supervisor stateDir, so a restart does not re-report unchanged machines. */
export const MACHINE_GUARD_STATE_FILE = "machine-guard.json";

/** Supervisor-owned progress through the private runner journal, committed only after successful lane processing. */
export const RUNNER_LANE_CURSOR_FILE = "runner-lane-cursor.json";

/** Called in the lane work queue; a failed event stops the pass and is retried on the next call. */
export const laneEventReader = (stateDir: string, deps: LaneHubDeps): (() => Promise<void>) => {
  // The hello that marks a recovery must number the journal as this reader does; deps without a head get this journal's.
  if (!deps.journalHead) (deps as { journalHead?: () => number }).journalHead = () => runnerJournalHead(stateDir);
  const path = join(stateDir, RUNNER_LANE_CURSOR_FILE);
  let position = 0;
  let invalid: string | undefined;
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0) position = parsed;
      else invalid = "not a non-negative integer";
    } catch (e) {
      invalid = e instanceof Error ? e.message : String(e);
    }
  }
  if (invalid !== undefined) {
    // Stale lane.started events are ignored by the hub, so replaying the journal from the start is safe.
    console.error(`RUNNER_CURSOR_INVALID ${path} ${invalid}; reading the runner journal from the start`);
    writeRunnerFile(path, "0\n");
  }
  const db = new Database(join(stateDir, HUB_FILE), { readonly: true });
  try {
    const row = db.query("SELECT MAX(rowid) AS position FROM runner_events").get() as { position: number | null };
    if (position > (row.position ?? 0)) {
      position = 0;
      writeRunnerFile(path, `${position}\n`);
    }
  } finally {
    db.close();
  }
  return async () => {
    for (const event of laneEventsAfter(stateDir, position)) {
      await acceptLaneEvent(deps, event.label, event.frame, event.rowid);
      writeRunnerFile(path, `${event.rowid}\n`);
      position = event.rowid;
    }
  };
};

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
/** The fifth task: liveness, lane events, runner admin, legacy adoption, journal pruning; it reopens a hub that failed to open. */
export const RUNNERS_TASK = "runners";
/** The autopilot tick's task (autopilot-tick.ts); it judges only while the toodo source is enabled. */
export const AUTOPILOT_TASK = "autopilot";
export const AUTOPILOT_PASS_MS = 5_000;
/** How often the runners task tries to adopt open lanes that have no runner yet. */
export const LEGACY_ADOPT_MS = 60_000;
/** How often the runners task runs; the hub itself answers frames as they arrive. */
export const RUNNERS_PASS_MS = 5_000;
/** How often the polling task delivers queued lane messages (lead steering, CI, rebase), apart from the GitHub poll. */
export const LANE_MESSAGES_PASS_MS = 30_000;
/** How often the runners task tries to open a runner hub that failed to open. */
export const RUNNER_HUB_RETRY_MS = 30_000;
/** How often the runners task drops old rows from the hub's runner event journal. */
const RUNNER_JOURNAL_PRUNE_MS = 60 * 60_000;

/** The open runner hub: its listeners, the hub, its journal, the key store, the live connections, the guard board and the calls. */
export type RunnerHubHandle = {
  readonly hub: RunnerHub;
  readonly journal: RunnerJournal;
  /** The local control socket. */
  readonly listener: Listener;
  /** Supervisor dialer for the recorded worker endpoints. */
  readonly network: DialingListener;
  readonly auth: SupervisorAuth;
  /** Live connection operations (revoke, rotate, commands). */
  readonly accept: RunnerAccept;
  /** Each runner's latest guard sample and unreported kills, for the machine-guard sweep. */
  readonly guard: RunnerGuardBoard;
  /** Awaitable commands and queries over the live connections (the facade's RunnerCall). */
  readonly calls: RunnerCalls;
  close(): void;
};

export type RunnerHubOptions = Pick<HubHooks, "onHeartbeat" | "onHello" | "onEvent" | "onSecret"> & {
  /** Discovery and reconnect dependencies; production reads runner-endpoints.json. */
  readonly network?: Partial<DialingOptions>;
  /** hostId of a local runner identity created here (default `os.hostname()`). */
  readonly hostId?: string;
  /** The call/query timeout timers (default real timers). */
  readonly timers?: Timers;
  /** A runner machine's herdr went down or came back (`HERDR_DOWN` / `HERDR_UP`), already saved on its hub row. */
  readonly onHerdr?: (id: string, line: string) => void;
};

/**
 * Enrolls the local runner in-process when it has never been enrolled with this supervisor, or its pinned supervisor
 * key is not this one (both key stores are on this host, so no code crosses a link). A revoked local runner stays
 * revoked until `dori runner enroll`.
 */
const enrollLocalRunner = (auth: SupervisorAuth, hub: RunnerHub, runnerDir: string, hostId: string, log: (line: string) => void): void => {
  const identity = loadIdentity(runnerDir, LOCAL_RUNNER, hostId);
  const runnerAuth = new RunnerAuth(runnerDir);
  const row = auth.key(identity.label);
  if (row?.revokedAt !== undefined) return;
  if (row && runnerAuth.supervisorKey() === auth.publicKey) return;
  const { code } = auth.issueCode(identity.label);
  const request = runnerAuth.enrollRequest(code, identity.label, identity.hostId);
  const enrolled = auth.enroll(request);
  if (!enrolled.ok) throw new Error(`${enrolled.code} ${enrolled.detail}`);
  runnerAuth.pinSupervisor(code, request, enrolled.reply, auth.fingerprint);
  hub.bindHost(identity.label, identity.hostId);
  log(`RUNNER_ENROLLED runner=${identity.label} hostId=${identity.hostId} local`);
};

/**
 * Opens the runner hub on `<runnerDir>/sock/control` and dials the recorded worker endpoints over WebSocket.
 * Every connection runs the signed handshake (auth.ts) against the keys in `<stateDir>`; the local runner is
 * enrolled in-process first. The runner directory and its 0700 `sock/` are created or checked first; the supervisor
 * epoch is committed before any listener opens. Failed network connections retry while the local socket keeps
 * serving. Runner events are committed to the hub's own journal
 * table, never to the lead's events, and nothing here changes a lane.
 */
export const openRunnerHub = (
  stateDir: string, runnerDir: string, now: () => number, monotonic: () => number, log: (line: string) => void,
  options: RunnerHubOptions = {},
): RunnerHubHandle => {
  ensureRunnerDir(runnerDir);
  ensureRunnerSubdir(runnerDir, RUNNER_PATHS.sock);
  const epoch = nextEpoch(stateDir);
  const journal = openRunnerJournal(stateDir, now);
  const hub = new RunnerHub({ stateDir, commit: journal.commit, now, monotonic, epoch });
  let auth: SupervisorAuth | undefined;
  let listener: Listener;
  try {
    auth = new SupervisorAuth(stateDir, { now });
    enrollLocalRunner(auth, hub, runnerDir, options.hostId ?? hostname(), log);
    listener = listenUnix(controlSocketPath(runnerDir));
  } catch (e) { auth?.close(); hub.close(); journal.close(); throw e; }
  const network = dialWs({ endpoints: () => readRunnerEndpoints(stateDir), log, ...options.network });
  const guard = new RunnerGuardBoard(monotonic);
  const herdr = new HerdrDownInference({
    read: (label) => {
      const row = hub.runner(label);
      return row?.herdr ? { state: row.herdr, since: row.herdrSince ?? 0 } : undefined;
    },
    save: (label, record) => { hub.setHerdr(label, record.state, record.since); },
  }, now);
  // The proto each label said hello with on its current connection: RunnerCalls refuses newer types to a proto-2 runner.
  const protos = new Map<string, number>();
  let calls: RunnerCalls | undefined;
  const accept = acceptRunners(hub, [listener, network], {
    ...(options.onHeartbeat ? { onHeartbeat: options.onHeartbeat } : {}),
    ...(options.onSecret ? { onSecret: options.onSecret } : {}),
    onHello: (label, body) => { protos.set(label, body.proto); options.onHello?.(label, body); },
    onEvent: (label, frame) => {
      guard.event(label, frame);
      if (frame.type === "guard.sample") hub.setMachine(label, frame.body);
      const changed = herdr.event(label, frame, protos.get(label) ?? hub.runner(label)?.proto);
      if (changed) { log(changed.line); options.onHerdr?.(changed.id, changed.line); }
      calls?.onEvent(label, frame);
      options.onEvent?.(label, frame);
    },
    onControl: (label, frame) => { calls?.onControl(label, frame); },
    onStatus: (label, frame) => { calls?.onStatus(label, frame); },
    onDisconnected: (label) => { protos.delete(label); calls?.disconnected(label); },
    auth,
    log,
  });
  calls = new RunnerCalls({
    accept, proto: (label) => protos.get(label), now, timers: options.timers ?? realTimers, log,
    attempts: {
      record: (label, type, cmdId, key, body) => { hub.recordAttempt(label, type, cmdId, key, body); },
      settle: (label, cmdId) => { hub.settleAttempt(label, cmdId); },
    },
  });
  log(`RUNNER_HUB_READY epoch=${epoch} socket=${controlSocketPath(runnerDir)} network=dial`);
  const keys = auth;
  return {
    hub, journal, listener, auth: keys, accept, guard, calls, network,
    close() { accept(); listener.close(); network?.close(); keys.close(); hub.close(); journal.close(); },
  };
};

/**
 * At a runner's hello: reads back each `lane.start` an earlier supervisor run sent to it and never saw answered
 * (lanes-hub.ts `readBackLaneStarts`) over the hub's own attempt records and calls. A start proven never run is sent
 * again; when that send cannot go out the lead hears `RUNNER_LAUNCH_FAILED`. Logs `RUNNER_READBACK` per attempt.
 */
export const readBackRunnerStarts = async (
  handle: Pick<RunnerHubHandle, "hub" | "calls">, registry: LaneStartReadbackDeps["registry"], label: string, inventory: readonly InventoryLane[],
  emit: (id: string, line: string) => void, log: (line: string) => void,
): Promise<void> => {
  const outcomes = await readBackLaneStarts({
    registry,
    attempts: (l) => handle.hub.staleAttempts(l, COMMAND_RETENTION_MS),
    settle: (l, cmdId) => { handle.hub.settleAttempt(l, cmdId); },
    status: (l, cmdId) => handle.calls.status(l, cmdId),
    observe: (l, key) => handle.calls.call(l, "lane.observe", { key }),
    resend: (l, attempt) => {
      const body = attempt.body as Omit<SupervisorCommandBodies["lane.start"], "cmdId">;
      handle.calls.call(l, "lane.start", body, { cmdId: attempt.cmdId }).catch((e: unknown) => {
        const why = e instanceof Error ? e.message : String(e);
        log(`RUNNER_READBACK_RESEND_FAILED runner=${l} cmdId=${attempt.cmdId} ${why}`);
        if (e instanceof RunnerUnavailable && e.why === "disconnected") {
          emit(`runner-readback-resend:${l}:${attempt.cmdId}`, `RUNNER_LAUNCH_FAILED ${attempt.key} runner=${l} the start read back as never run, and sending it again failed (${why}); the lane has no agent: dori close ${attempt.key} --cancelled and launch again`);
        }
      });
    },
    emit,
  }, label, inventory);
  for (const [cmdId, outcome] of outcomes) log(`RUNNER_READBACK runner=${label} cmdId=${cmdId} ${outcome}`);
};

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

/** The open lanes with a pane in `scope`: local lanes, or lanes naming the machine by label or herdr id. */
const lanesIn = (scope: CriticalScope, open: readonly Lane[]): Lane[] => open.filter((l) => l.pane && (scope.kind === "local"
  ? !l.machine
  : l.machine !== undefined && (l.machine === scope.machine.label || l.machine === scope.machine.id)));

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
  // The watch, dead-panes and freshness sweeps read a machine only through an admitted runner connection. A runner
  // without one (right after a restart, before its hello, or gone) is one RUNNER_UNAVAILABLE line per outage, by
  // runner label (the machine it serves as value), instead of one warning per lane and sweep every round.
  const admitted = (machine?: string): boolean => deps.ops.connected(machine);
  const unavailable = new Map<string, string | undefined>();
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
      await watchTick(deps, emit, archived, admitted);
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
    ["freshness", async () => (await freshnessTick(deps, view, laneReports(), admitted)).map((act) => `${act.kind.toUpperCase()} ${act.lane} ${act.detail}`)],
    // Urgent LANE_DRIFT for a working lane overdue on milestones or failing CI head after head; reads the last GitHub poll only.
    ["drift", async (emit) => {
      await driftTick({
        stateDir: deps.config.stateDir, drift: deps.config.drift, now: deps.clock.now, openLanes: () => deps.registry.open(), owners: pullOwners(deps.ops),
      }, laneReports(), openPulls(), emit);
      return [];
    }],
    ["memory", async () => memorySweep(deps, home)],
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
  if (!Number.isFinite(deps.tunables.cacheTtlMin) || deps.tunables.cacheTtlMin <= 0) throw new SuperviseError("cacheTtlMin must be positive");
  if (!Number.isFinite(deps.tunables.leadContextCapTokens) || deps.tunables.leadContextCapTokens <= 0) throw new SuperviseError("leadContextCapTokens must be positive");
  if (!Number.isFinite(deps.tunables.githubPollSeconds) || deps.tunables.githubPollSeconds <= 0) throw new SuperviseError("githubPollSeconds must be positive");
  if (!Number.isFinite(deps.tunables.githubTimeoutMs) || deps.tunables.githubTimeoutMs <= 0) throw new SuperviseError("githubTimeoutMs must be positive");
  if (!Number.isFinite(deps.tunables.discordSafetyPollSeconds) || deps.tunables.discordSafetyPollSeconds <= 0) throw new SuperviseError("discordSafetyPollSeconds must be positive");
  if (!Number.isFinite(deps.tunables.digestMaxDelayMin) || deps.tunables.digestMaxDelayMin <= 0) throw new SuperviseError("digestMaxDelayMin must be positive");
  if (!Number.isFinite(deps.tunables.ackTimeoutSec) || deps.tunables.ackTimeoutSec <= 0) throw new SuperviseError("ackTimeoutSec must be positive");
  if (!Number.isFinite(deps.config.runTimeoutMs) || deps.config.runTimeoutMs < 0) throw new SuperviseError("runTimeoutMs must be zero or positive");
  if (!Number.isFinite(deps.tunables.handledTimeoutMin) || deps.tunables.handledTimeoutMin <= 0) throw new SuperviseError("handledTimeoutMin must be positive");
  if (!Number.isFinite(deps.tunables.reportTimeoutMin) || deps.tunables.reportTimeoutMin <= 0) throw new SuperviseError("reportTimeoutMin must be positive");
  if (!Number.isFinite(deps.tunables.resolveTimeoutMin) || deps.tunables.resolveTimeoutMin <= 0) throw new SuperviseError("resolveTimeoutMin must be positive");
  if (!Number.isFinite(deps.config.leadStuckRestartMin) || deps.config.leadStuckRestartMin <= 0) throw new SuperviseError("leadStuckRestartMin must be positive");
  if (!Number.isFinite(deps.config.leadChildWaitMaxMin) || deps.config.leadChildWaitMaxMin <= 0) throw new SuperviseError("leadChildWaitMaxMin must be positive");
  if (!Number.isFinite(deps.tunables.idleEscalateMin) || deps.tunables.idleEscalateMin <= 0) throw new SuperviseError("idleEscalateMin must be positive");
  if (!Number.isInteger(deps.tunables.waitMaxFailures) || deps.tunables.waitMaxFailures <= 0) throw new SuperviseError("waitMaxFailures must be a positive integer");
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
    const autopilot = new AutopilotTick({
      tickMs: () => deps.config.autopilot.tickSec * 1000,
      judge: () => judgeCandidates(liveJudgeDeps(deps, ops)), enqueue: enqueueOf("toodo"), now: deps.clock.now,
      localState: async () => autopilotLocalStateKey(ops, new Set((await deps.registry.open()).map((l) => l.key))),
      log: (line) => { console.error(line); },
    });
    // The tick replaced the hourly autopilot-reconcile schedule job; one left from an earlier version is removed.
    try { if (new SourceSpecs(deps.config.stateDir).remove(RECONCILE_JOB)) console.log(`AUTOPILOT_RECONCILE_JOB_REMOVED ${RECONCILE_JOB}: the supervisor's autopilot tick replaces it`); }
    catch (e) { console.error(`AUTOPILOT_RECONCILE_JOB_ERROR ${e instanceof Error ? e.message : String(e)}`); }
    const toodoEvents = new ToodoEvents({
      config: deps.tunables.toodoEvents, stateDir: deps.config.stateDir, enqueue: enqueueOf("toodo"),
      fail: (e) => { registry.fail("toodo", e); }, ok: () => { registry.ok("toodo"); }, log: (line) => { console.error(line); },
      onEvent: (event) => { if (AUTOPILOT_KICK_EVENTS.has(event)) autopilot.kick(); },
    });
    const waits = probe.step("waits", () => new Waits(deps.config.stateDir, deps.tunables.waitMaxFailures, hubCall));
    const github = probe.step("github", () => new GitHubEvents(deps.config.stateDir, deps.config.store, deps.clock.now));
    const follow = ci = probe.step("ci-follow", () => new CiFollowUp(deps));
    // CI follow-up reads the poll it follows, so it runs right after each GitHub tick.
    const pollGithub = async (): Promise<void> => {
      await github.tick(deps, enqueueGitHub);
      await follow.tick(github.openPulls(), enqueueGitHub, github.mergedPulls());
    };
    // The sweep task gets its own span, so its timings never mix into the startup report.
    const sweepProbe = probe.span();
    // Each sweep is tracked: one stuck past WATCHDOG_STALL_MS withholds the watchdog.
    // The watcher reads its claim announcements back from the journal.
    const sweepDeps: FlowDeps = { ...deps, leadDelivered: (id) => supervisor.leadDelivered(id) };
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
      ...discordOptions, token, emit,
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
      return routeReports(deps, reportStore, enqueueSweep, home, statusTransport, (lane, report) => openLaneDecision(decisionCtx, lane, report));
    })())
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
          await ownerNotice(channel, deps.tunables.ownerDelayNotice, `delay:${channel}:${message}`);
          supervisor.noticeSent("delay", channel, message);
        }
        catch (e) { console.error(`OWNER_NOTICE_FAILED ${channel}/${message}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    };
    // A message the lead was handed but never acked is re-pushed, and after a second window the owner gets one line.
    const noticeUnacked = async (): Promise<void> => {
      let due: ReturnType<typeof supervisor.ackTick>;
      try { due = supervisor.ackTick(deps.tunables.ackTimeoutSec * 1_000); }
      catch (e) { console.error(`ACK_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); return; }
      for (const { channel, message } of due) {
        console.log(`ACK_MISSING_NOTICE ${channel}/${message}`);
        try {
          supervisor.noticeAttempt("ack", channel, message);
          await ownerNotice(channel, deps.tunables.ackMissingNotice, `ack:${channel}:${message}`);
          supervisor.noticeSent("ack", channel, message);
        }
        catch (e) { console.error(`ACK_NOTICE_FAILED ${channel}/${message}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    };
    // A message the lead acked but never linked to lanes or a reply: UNHANDLED wakes it, then the owner gets one line.
    const noticeUnhandled = async (): Promise<void> => {
      let due: ReturnType<typeof supervisor.handledTick>;
      try { due = supervisor.handledTick(deps.tunables.handledTimeoutMin * 60_000); }
      catch (e) { console.error(`HANDLED_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); return; }
      for (const { channel, message } of due) {
        console.log(`UNHANDLED_NOTICE ${channel}/${message}`);
        try {
          supervisor.noticeAttempt("unhandled", channel, message);
          await ownerNotice(channel, deps.tunables.unhandledNotice, `unhandled:${channel}:${message}`);
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
      // Owner decisions: a stuck post, a missing link line, a pending archive, the daily reminder.
      try { await ownerDecisionTick({ ...decisionCtx, enqueue: (id, line) => supervisor.enqueue(id, line), log: (line) => { console.error(line); } }); }
      catch (e) { console.error(`OWNER_DECISION_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); }
      // A thread whose work is all finished and reported is closed (archived) once; the owner gets no button to press.
      try { await supervisor.autoCloseTick(async (thread) => { await discord.setThread(thread, { archived: true }); }); }
      catch (e) { console.error(`THREAD_AUTO_CLOSE_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); }
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
          // A remote runner's secret.get: decided here with the registry, config and this host's store (secret-serve.ts).
          onSecret: supervisorSecretHandler({
            laneOwner: async (key) => { const lane = (await deps.registry.open()).find((l) => l.key === key); return lane && runnerOf(lane); },
            runnerUnsandboxed: (label) => deps.config.runners?.[label]?.allowUnsandboxed === true,
            granter: supervisorGranter({
              stateDir: deps.config.stateDir, store: new SecretStore(), rules: async () => (await loadConfig()).secrets, now: deps.clock.now,
              log: (line) => { console.log(line); },
            }),
            // A remote runner's secret.run: the op runs here, outside any lane; only its redacted output goes back.
            commandRunner: supervisorCommandRunner({
              stateDir: deps.config.stateDir, store: new SecretStore(), rules: async () => (await loadConfig()).secrets,
              commands: async () => (await loadConfig()).secretCommands, now: deps.clock.now,
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
    let lastAdoption = -Infinity;
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
        if (deps.tunables.toodoEvents.enabled) await autopilot.tick();
      }),
      task(RUNNERS_TASK, RUNNERS_PASS_MS, async () => {
        if (!runnerHub && deps.clock.now() - lastHubAttempt >= RUNNER_HUB_RETRY_MS) await tryOpenRunners((_name, work) => work());
        const handle = runnerHub;
        if (!handle) return;
        try { await liveness?.tick(); } catch (e) { console.error(`RUNNER_LIVENESS_ERROR ${e instanceof Error ? e.message : String(e)}`); }
        try { await takeLaneEvents(); } catch (e) { console.error(`RUNNER_LANE_ERROR ${e instanceof Error ? e.message : String(e)}`); }
        // Open lanes from before every lane was runner-owned are adopted once the local runner is up (D18).
        if (deps.clock.now() - lastAdoption >= LEGACY_ADOPT_MS && handle.calls.connected(LOCAL_RUNNER)) {
          lastAdoption = deps.clock.now();
          try {
            const adopted = await adoptLegacyLanes({ registry: deps.registry, ops: deps.ops, emit: (id, line) => { enqueueSweep(id, line); }, log: (line) => { console.error(line); } });
            for (const key of adopted) console.log(`LANE_RUNNER_ADOPTED ${key}`);
          } catch (e) { console.error(`LANE_ADOPT_ERROR ${e instanceof Error ? e.message : String(e)}`); }
        }
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
