import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ensureRunnerDir, ensureRunnerSubdir, RUNNER_PATHS, writeRunnerFile } from "./runner/fs-safety.ts";
import { RunnerAuth, SupervisorAuth } from "./runner/auth.ts";
import { HUB_FILE, RunnerHub } from "./runner/hub.ts";
import {
  acceptLaneEvent, laneEventsAfter, type LaneHubDeps, type LaneStartReadbackDeps, readBackLaneStarts, runnerJournalHead,
} from "./runner/lanes-hub.ts";
import { COMMAND_RETENTION_MS } from "./runner/durability.ts";
import { RunnerGuardBoard } from "./runner/guard.ts";
import { realTimers, RunnerCalls, RunnerUnavailable, type Timers } from "./runner/call.ts";
import type { InventoryLane, SupervisorCommandBodies } from "./runner/protocol.ts";
import {
  acceptRunners, type HubHooks, LOCAL_RUNNER, loadIdentity, nextEpoch, openRunnerJournal, type RunnerAccept, type RunnerJournal,
} from "./runner/serve.ts";
import type { Listener } from "./runner/transport.ts";
import { controlSocketPath, listenUnix } from "./runner/unix-transport.ts";
import { dialWs, type DialingListener, type DialingOptions } from "./runner/ws-transport.ts";
import { readRunnerEndpoints } from "./runner/endpoints.ts";

/** Supervisor-owned progress through the private runner journal, committed only after successful lane processing. */
export const RUNNER_LANE_CURSOR_FILE = "runner-lane-cursor.json";

/**
 * The committed cursor in `stateDir`: 0 when the file does not exist yet, or undefined when it cannot be read as a
 * non-negative integer; that case logs RUNNER_CURSOR_INVALID with `fallback`, what the caller does instead.
 */
export const readLaneCursor = (stateDir: string, fallback: string): number | undefined => {
  const path = join(stateDir, RUNNER_LANE_CURSOR_FILE);
  if (!existsSync(path)) return 0;
  let invalid: string;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    invalid = "not a non-negative integer";
  } catch (e) {
    invalid = e instanceof Error ? e.message : String(e);
  }
  console.error(`RUNNER_CURSOR_INVALID ${path} ${invalid}; ${fallback}`);
  return undefined;
};

/** Called in the lane work queue; a failed event stops the pass and is retried on the next call. */
export const laneEventReader = (stateDir: string, deps: LaneHubDeps): (() => Promise<void>) => {
  // The hello that marks a recovery must number the journal as this reader does; deps without a head get this journal's.
  if (!deps.journalHead) (deps as { journalHead?: () => number }).journalHead = () => runnerJournalHead(stateDir);
  const path = join(stateDir, RUNNER_LANE_CURSOR_FILE);
  // Stale lane.started events are ignored by the hub, so replaying the journal from the start is safe.
  const committed = readLaneCursor(stateDir, "reading the runner journal from the start");
  if (committed === undefined) writeRunnerFile(path, "0\n");
  let position = committed ?? 0;
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

export type RunnerHubOptions = Pick<HubHooks, "onHeartbeat" | "onHello" | "onEvent" | "onSecret" | "onClosedLanes"> & {
  /** Discovery and reconnect dependencies; production reads runner-endpoints.json. */
  readonly network?: Partial<DialingOptions>;
  /** hostId of a local runner identity created here (default `os.hostname()`). */
  readonly hostId?: string;
  /** The call/query timeout and link silence timers (default real timers). */
  readonly timers?: Timers;
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
  // The proto each label said hello with on its current connection: RunnerCalls refuses newer types to a proto-2 runner.
  const protos = new Map<string, number>();
  let calls: RunnerCalls | undefined;
  const accept = acceptRunners(hub, [listener, network], {
    ...(options.onHeartbeat ? { onHeartbeat: options.onHeartbeat } : {}),
    ...(options.onSecret ? { onSecret: options.onSecret } : {}),
    ...(options.onClosedLanes ? { onClosedLanes: options.onClosedLanes } : {}),
    onHello: (label, body) => { protos.set(label, body.proto); options.onHello?.(label, body); },
    onEvent: (label, frame) => {
      guard.event(label, frame);
      if (frame.type === "guard.sample") hub.setMachine(label, frame.body);
      calls?.onEvent(label, frame);
      options.onEvent?.(label, frame);
    },
    onControl: (label, frame) => { calls?.onControl(label, frame); },
    onStatus: (label, frame) => { calls?.onStatus(label, frame); },
    onDisconnected: (label) => { protos.delete(label); calls?.disconnected(label); },
    auth,
    timers: options.timers ?? realTimers,
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
