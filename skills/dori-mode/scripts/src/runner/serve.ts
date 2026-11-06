import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paneAlive, type Pane } from "../panes.ts";
import type { Clock } from "../run.ts";
import { backoffMs, type RunnerClient, yieldTurn } from "./client.ts";
import { RUNNER_PATHS, writeRunnerFile } from "./fs-safety.ts";
import { HUB_FILE, type CommitFn, type RunnerHub } from "./hub.ts";
import { fingerprint, type PendingHello, type Session, type SupervisorAuth } from "./auth.ts";
import { checkEffectEpoch } from "./fencing.ts";
import { checkCommand, rejectionText, type RunnerPolicy } from "./policy.ts";
import {
  decodeFrame, encodeFrame, LABEL_PATTERN, ProtocolError, supervisorCommand, supervisorControl,
  type AnyRunnerEvent, type AnySupervisorCommand, type CommandResults, type Frame, type InventoryLane, type JsonValue, type LaneStatus,
  type QueryBodies, type QueryType, type RejectCode, type RunnerControl, type RunnerEventBodies, type SupervisorCommandBodies,
  type SupervisorCommandType,
} from "./protocol.ts";
import type { RunnerState } from "./state.ts";
import type { Connector, Listener, Transport } from "./transport.ts";

/**
 * The P1 wiring between the runner modules and the product: the runner's identity file, the supervisor epoch, the hub's
 * connection handling over any `Listener`, and the runner's serve loop. Every function takes its
 * clock and IO as arguments; `dori runner serve` and `supervise` pass the real ones.
 */

/** The local runner's default label. */
export const LOCAL_RUNNER = "local";
/** How often a runner reads its host's lanes (serveRunner's default observe period). */
export const OBSERVE_MS = 30_000;
/** Committed runner events are kept this long in the hub's journal table. */
export const RUNNER_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Runner identity
// ---------------------------------------------------------------------------------------------------------------

export type RunnerIdentity = { readonly id: string; readonly label: string; readonly hostId: string };

/**
 * Reads `<runnerDir>/runner.json`, or creates it (0600, atomic) with a new id, `label` and `hostId` on first start. A
 * stored label wins over `label`, so a runner keeps its name; a stored file that does not read is an error.
 */
export const loadIdentity = (runnerDir: string, label: string, hostId: string): RunnerIdentity => {
  const path = join(runnerDir, RUNNER_PATHS.identity);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RunnerIdentity>;
    if (typeof raw.id !== "string" || typeof raw.label !== "string" || typeof raw.hostId !== "string" || !LABEL_PATTERN.test(raw.label)) {
      throw new Error(`RUNNER_IDENTITY_INVALID ${path}`);
    }
    return { id: raw.id, label: raw.label, hostId: raw.hostId };
  }
  if (!LABEL_PATTERN.test(label)) throw new Error(`RUNNER_LABEL_INVALID ${label}`);
  const identity = { id: randomUUID(), label, hostId };
  writeRunnerFile(path, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
};

// ---------------------------------------------------------------------------------------------------------------
// Supervisor side: epoch, journal, connections
// ---------------------------------------------------------------------------------------------------------------

const openHubDb = (stateDir: string): Database => {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, HUB_FILE);
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS hub_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  db.transaction(() => {
    db.run("CREATE TABLE IF NOT EXISTS runner_events (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, line TEXT NOT NULL, at INTEGER NOT NULL)");
    const columns = db.query("PRAGMA table_info(runner_events)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "position")) {
      db.run("ALTER TABLE runner_events RENAME TO runner_events_legacy");
      db.run("CREATE TABLE runner_events (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, line TEXT NOT NULL, at INTEGER NOT NULL)");
      db.run("INSERT INTO runner_events (position, id, line, at) SELECT rowid, id, line, at FROM runner_events_legacy ORDER BY rowid");
      db.run("DROP TABLE runner_events_legacy");
    }
  }).immediate();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
  return db;
};

/** Commits the next supervisor epoch (one per supervisor start) in `<stateDir>/runners.sqlite` and returns it. */
export const nextEpoch = (stateDir: string): number => {
  const db = openHubDb(stateDir);
  try {
    return db.transaction(() => {
      const row = db.query("SELECT v FROM hub_meta WHERE k = 'epoch'").get() as { v: number } | null;
      const epoch = (row?.v ?? 0) + 1;
      db.query("INSERT INTO hub_meta (k, v) VALUES ('epoch', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(epoch);
      return epoch;
    }).immediate();
  } finally {
    db.close();
  }
};

export type RunnerJournal = { readonly commit: CommitFn; prune(now: number): number; close(): void };

/**
 * The hub's own journal: the hub commits runner events into `runner_events` of `runners.sqlite` instead of the lead's
 * event journal, so a runner's events are durable and acked; the supervisor turns them into lane state itself. `commit` returns false for
 * an id already there, as the contract asks.
 */
export const openRunnerJournal = (stateDir: string, now: () => number): RunnerJournal => {
  const db = openHubDb(stateDir);
  const insert = db.query("INSERT OR IGNORE INTO runner_events (id, line, at) VALUES (?, ?, ?)");
  return {
    commit: (id, line) => insert.run(id, line, now()).changes > 0,
    prune: (at) => db.query("DELETE FROM runner_events WHERE at < ?").run(at - RUNNER_JOURNAL_RETENTION_MS).changes,
    close: () => { db.close(); },
  };
};

export type HubHooks = {
  /** An admitted hello (the runner's label and its hello body). */
  readonly onHello?: (label: string, body: RunnerControl<"hello">["body"]) => void;
  /** An event the hub committed just now. */
  readonly onEvent?: (label: string, frame: AnyRunnerEvent) => void;
  readonly onHeartbeat?: (label: string) => void;
  /** Every admitted, MAC-checked `q.result` (the answer to a query sent with `RunnerAccept.control`). Never journaled. */
  readonly onControl?: (label: string, frame: RunnerControl<"q.result">) => void;
  /** The label's admitted connection closed (not called for a connection a newer one replaced). */
  readonly onDisconnected?: (label: string) => void;
  /** Requires enrollment, the signed handshake and frame MACs (auth.ts). Absent: the P1 unauthenticated local socket. */
  readonly auth?: SupervisorAuth;
  readonly log: (line: string) => void;
};

/** `acceptRunners`' stop function, with the operations on live connections. */
export type RunnerAccept = (() => void) & {
  /** Deletes the label's key, sends `hello.reject RUNNER_REVOKED` and closes its connection; false when it held no key. */
  revoke(label: string): boolean;
  /** Sends `runner.rotate` to the label's connection; returns the cmdId, or undefined when it is not connected. */
  rotate(label: string): string | undefined;
  /** Sends a command to the label's connection with the next cmdSeq; returns the cmdSeq, or undefined when it is not connected. */
  command<T extends SupervisorCommandType>(label: string, type: T, body: SupervisorCommandBodies[T]): number | undefined;
  /**
   * Sends a query control frame (no cmdSeq, not recorded, not epoch-fenced) to the label's connection; false when it is
   * not connected. The answer arrives as `HubHooks.onControl`.
   */
  control<T extends QueryType>(label: string, type: T, body: QueryBodies[T]): boolean;
  /** Whether the label has an admitted connection now. */
  connected(label: string): boolean;
};

type Connection = {
  readonly transport: Transport;
  readonly gen: number;
  readonly send: (frame: Frame) => void;
  /** The cmdId of the `runner.rotate` sent on this connection and not yet answered. */
  rotating?: string;
};

/**
 * Serves runner connections from `listeners` (the local socket and, when configured, the network listener) through
 * `hub`, with one table of live connections across all of them. The first frame must be a hello (or, with
 * `hooks.auth`, an `enroll`); a rejected hello is answered and the connection closed. After it, every frame must name
 * the admitted label. The hub's hello rules (fencing.ts `decideHello`) see the gen of the label's live connection; an
 * admitted hello closes that older connection. An invalid frame, or an event whose commit
 * throws (no ack), closes the connection; the runner reconnects and replays from its hello. Returns a function that
 * stops accepting.
 *
 * With `hooks.auth`:
 * - `enroll` is checked by `SupervisorAuth.enroll`, answered `enroll.ok` (the runner closes) or refused with
 *   `RUNNER_ENROLL_REFUSED` and closed; the label's hub row is bound to the enrolled hostId.
 * - `hello` is answered with the signed `hello.challenge` (or refused: `RUNNER_AUTH_FAILED`, `RUNNER_REVOKED`); the
 *   next frame must be `auth.proof`. A proof that does not verify is refused with `RUNNER_AUTH_FAILED` and closed;
 *   one that verifies opens the session and only then runs the hub's hello rules.
 * - Every later frame must carry the session MAC; one that does not is dropped and logged
 *   `RUNNER_AUTH_FAILED runner=<label> frame dropped: bad mac type=<type>`, and the connection stays open.
 * - `runner.rotated` answering the pending `runner.rotate` stores the new key and is acked with `rotate.ok`.
 */
export const acceptRunners = (hub: RunnerHub, listeners: Listener | readonly Listener[], hooks: HubHooks): RunnerAccept => {
  const current = new Map<string, Connection>();
  const auth = hooks.auth;
  const head = (label: string, gen: number) => ({ runner: label, gen, epoch: hub.epoch });
  const serve = (transport: Transport): void => {
    let label: string | undefined;
    let session: Session | undefined;
    let phase: "start" | "proof" | "ready" | "done" = "start";
    let pending: { readonly hello: RunnerControl<"hello">; readonly handshake: PendingHello } | undefined;
    const reply = (frame: Frame | undefined): void => {
      if (frame && transport.open) transport.send(encodeFrame(session ? session.seal(frame) : frame));
    };
    const refuse = (code: RejectCode, detail: string, who: string, gen: number): void => {
      reply(supervisorControl(head(who, gen), "hello.reject", { code, detail }));
      hooks.log(`${code} runner=${who} ${detail}`);
      phase = "done";
      transport.close(code);
    };
    const admit = (hello: RunnerControl<"hello">): void => {
      const live = current.get(hello.body.label);
      const outcome = hub.hello(hello, live?.transport.open ? live.gen : undefined);
      reply(outcome.reply);
      if (!outcome.ok) {
        hooks.log(`${outcome.reply.body.code} runner=${hello.body.label} ${outcome.reply.body.detail}`);
        phase = "done";
        transport.close(outcome.reply.body.code);
        return;
      }
      label = hello.body.label;
      phase = "ready";
      const previous = current.get(label);
      current.set(label, { transport, gen: hello.body.gen, send: reply });
      if (previous) {
        previous.transport.close("replaced by a newer connection");
        hooks.log(`RUNNER_REPLACED runner=${label} gen=${previous.gen}->${hello.body.gen}`);
      }
      hooks.log(`RUNNER_CONNECTED runner=${label} gen=${hello.body.gen} eventAck=${outcome.row.eventAck}`);
      hooks.onHello?.(label, hello.body);
    };
    transport.onClose(() => {
      if (label !== undefined && current.get(label)?.transport === transport) {
        current.delete(label);
        hub.disconnected(label);
        hooks.log(`RUNNER_DISCONNECTED runner=${label}`);
        hooks.onDisconnected?.(label);
      }
    });
    transport.onLine((line) => {
      try {
        const frame = decodeFrame(line, "runner");
        if (phase === "done") return;
        if (phase === "start") {
          if (frame.type === "enroll" && auth) {
            const body = (frame as RunnerControl<"enroll">).body;
            const enrolled = auth.enroll(body);
            if (!enrolled.ok) { refuse(enrolled.code, enrolled.detail, body.label, frame.gen); return; }
            hub.bindHost(body.label, body.hostId);
            reply(supervisorControl(head(body.label, frame.gen), "enroll.ok", enrolled.reply));
            hooks.log(`RUNNER_ENROLLED runner=${body.label} hostId=${body.hostId} key=${fingerprint(body.runnerPubKey)}`);
            phase = "done";
            return;
          }
          if (frame.type !== "hello" || "seq" in frame) throw new ProtocolError("sequence", `${frame.type} before hello`);
          const hello = frame as RunnerControl<"hello">;
          if (!auth) { admit(hello); return; }
          const begun = auth.beginHello(hello.body);
          if (!begun.ok) { refuse(begun.code, begun.detail, hello.body.label, hello.body.gen); return; }
          pending = { hello, handshake: begun.pending };
          phase = "proof";
          reply(supervisorControl(head(hello.body.label, hello.body.gen), "hello.challenge", begun.challenge));
          return;
        }
        if (phase === "proof" && pending && auth) {
          if (frame.type !== "auth.proof") throw new ProtocolError("sequence", `${frame.type} before auth.proof`);
          const { hello, handshake } = pending;
          pending = undefined;
          // The session key is known to both ends now, so even a refusal goes out sealed.
          session = handshake.session;
          if (!auth.finishHello(handshake, (frame as RunnerControl<"auth.proof">).body.sig)) {
            refuse("RUNNER_AUTH_FAILED", "hello proof is not signed by the enrolled runner key", hello.body.label, hello.body.gen);
            return;
          }
          admit(hello);
          return;
        }
        if (session && !session.check(frame)) {
          hooks.log(`RUNNER_AUTH_FAILED runner=${label ?? "-"} frame dropped: bad mac type=${frame.type}`);
          return;
        }
        if (label === undefined) throw new ProtocolError("sequence", `${frame.type} before hello`);
        if (frame.runner !== label) throw new ProtocolError("envelope-field", `frame for ${frame.runner} on the connection of ${label}`);
        if ("seq" in frame) {
          const outcome = hub.receive(frame);
          reply(outcome.reply);
          if (outcome.result === "committed") hooks.onEvent?.(label, frame);
          else if (outcome.result === "gap") {
            // Only a hello replays from eventAck, so a gap left open would hold back every later event (and every
            // cmd.result) for as long as this connection lives. Closing makes the runner reconnect and fill it.
            hooks.log(`RUNNER_EVENT_GAP runner=${label} seq=${frame.seq} eventAck=${outcome.eventAck}: closing so the runner replays`);
            phase = "done";
            transport.close("RUNNER_EVENT_GAP");
          }
          return;
        }
        if (frame.type === "runner.rotated") {
          const body = (frame as RunnerControl<"runner.rotated">).body;
          const connection = current.get(label);
          if (!auth || !session || connection?.transport !== transport || connection.rotating !== body.cmdId) {
            hooks.log(`RUNNER_ROTATE_REFUSED runner=${label} cmdId=${body.cmdId} no such rotation pending`);
            return;
          }
          if (!auth.rotate(label, session, body)) {
            hooks.log(`RUNNER_AUTH_FAILED runner=${label} rotation signature does not verify`);
            return;
          }
          connection.rotating = undefined;
          reply(supervisorControl(head(label, frame.gen), "rotate.ok", { cmdId: body.cmdId }));
          hooks.log(`RUNNER_KEY_ROTATED runner=${label} key=${fingerprint(body.runnerPubKey)}`);
          return;
        }
        if (frame.type === "enroll" || frame.type === "hello" || frame.type === "auth.proof") {
          throw new ProtocolError("sequence", `${frame.type} on an admitted connection`);
        }
        if (frame.type === "q.result") {
          hooks.onControl?.(label, frame as RunnerControl<"q.result">);
          return;
        }
        reply(hub.handle(frame));
        if (frame.type === "heartbeat") hooks.onHeartbeat?.(label);
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
        hooks.log(error instanceof ProtocolError ? `${detail} runner=${label ?? "-"}` : `RUNNER_HUB_ERROR runner=${label ?? "-"} ${detail}`);
        transport.close(error instanceof ProtocolError ? error.code : "hub error");
      }
    });
  };
  const stops = (Array.isArray(listeners) ? listeners : [listeners as Listener]).map((listener) => listener.onConnection(serve));
  return Object.assign(() => { for (const stop of stops) stop(); }, {
    connected: (name: string): boolean => current.get(name)?.transport.open === true,
    command<T extends SupervisorCommandType>(name: string, type: T, body: SupervisorCommandBodies[T]): number | undefined {
      const connection = current.get(name);
      if (!connection?.transport.open) return undefined;
      const cmdSeq = hub.nextCmdSeq(name);
      connection.send(supervisorCommand(head(name, connection.gen), cmdSeq, type, body) as Frame);
      return cmdSeq;
    },
    control<T extends QueryType>(name: string, type: T, body: QueryBodies[T]): boolean {
      const connection = current.get(name);
      if (!connection?.transport.open) return false;
      connection.send(supervisorControl(head(name, connection.gen), type, body as never) as Frame);
      return true;
    },
    revoke(name: string): boolean {
      const had = auth?.revoke(name) ?? false;
      const connection = current.get(name);
      if (connection) {
        connection.send(supervisorControl(head(name, connection.gen), "hello.reject", { code: "RUNNER_REVOKED", detail: `runner ${name} is revoked` }));
        connection.transport.close("RUNNER_REVOKED");
      }
      hooks.log(`RUNNER_REVOKED runner=${name} key deleted`);
      return had;
    },
    rotate(name: string): string | undefined {
      const connection = current.get(name);
      if (!auth || !connection?.transport.open) return undefined;
      const cmdSeq = hub.nextCmdSeq(name);
      const cmdId = `rotate:${name}:${cmdSeq}`;
      connection.rotating = cmdId;
      connection.send(supervisorCommand(head(name, connection.gen), cmdSeq, "runner.rotate", { cmdId }));
      return cmdId;
    },
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Operator requests to the live hub (`dori runner revoke|rotate`)
// ---------------------------------------------------------------------------------------------------------------

export type RunnerAdminOp = "revoke" | "rotate" | "lane.start";
/** A queued request the supervisor has not taken within this long is answered `expired`. */
export const RUNNER_ADMIN_TTL_MS = 2 * 60_000;

const adminTable = (db: Database): void => {
  db.run("CREATE TABLE IF NOT EXISTS runner_admin (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL, doneAt INTEGER, result TEXT, body TEXT)");
  const columns = db.query("PRAGMA table_info(runner_admin)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "body")) db.run("ALTER TABLE runner_admin ADD COLUMN body TEXT");
};

/**
 * Queues a request for the supervisor's live hub in `runner_admin` of `runners.sqlite` (the CLI runs in another
 * process than the hub). The runners task takes it on its next pass; `runnerAdminResult` reads the answer.
 */
export const queueRunnerAdmin = (stateDir: string, op: RunnerAdminOp, label: string, now: number, body?: object): number => {
  const db = openHubDb(stateDir);
  try {
    adminTable(db);
    return Number(db.query("INSERT INTO runner_admin (op, label, at, body) VALUES (?, ?, ?, ?)").run(op, label, now, body ? JSON.stringify(body) : null).lastInsertRowid);
  } finally {
    db.close();
  }
};

/** The answer to a queued request, or undefined while the supervisor has not taken it. */
export const runnerAdminResult = (stateDir: string, id: number): string | undefined => {
  const db = openHubDb(stateDir);
  try {
    adminTable(db);
    return (db.query("SELECT result FROM runner_admin WHERE id = ? AND doneAt IS NOT NULL").get(id) as { result: string } | null)?.result;
  } finally {
    db.close();
  }
};

/**
 * Supervisor side: answers every open request through `accept`. `revoke` -> `revoked` / `not-enrolled` (the live link
 * is closed either way); `rotate` -> `sent cmdId=<id>` / `not-connected`; older than `RUNNER_ADMIN_TTL_MS` ->
 * `expired`. Returns one log line per request.
 */
export const drainRunnerAdmin = (stateDir: string, accept: Pick<RunnerAccept, "revoke" | "rotate" | "command" | "connected">, now: number): string[] => {
  const db = openHubDb(stateDir);
  try {
    adminTable(db);
    const open = db.query("SELECT id, op, label, at, body FROM runner_admin WHERE doneAt IS NULL ORDER BY id").all() as { id: number; op: string; label: string; at: number; body: string | null }[];
    return open.map((row) => {
      let result: string;
      if (now - row.at > RUNNER_ADMIN_TTL_MS) result = "expired";
      else if (row.op === "revoke") result = accept.revoke(row.label) ? "revoked" : "not-enrolled";
      else if (row.op === "rotate") {
        const cmdId = accept.rotate(row.label);
        result = cmdId ? `sent cmdId=${cmdId}` : "not-connected";
      } else if (row.op === "lane.start" && row.body) {
        // Not connected now: the request stays open and is tried again on the next pass until it expires.
        if (!accept.connected(row.label)) return `RUNNER_ADMIN op=${row.op} runner=${row.label} waiting for the runner`;
        const cmdSeq = accept.command(row.label, "lane.start", JSON.parse(row.body) as SupervisorCommandBodies["lane.start"]);
        result = cmdSeq ? `sent cmdSeq=${cmdSeq}` : "not-connected";
      } else result = `unknown op ${row.op}`;
      db.query("UPDATE runner_admin SET doneAt = ?, result = ? WHERE id = ?").run(now, result, row.id);
      return `RUNNER_ADMIN op=${row.op} runner=${row.label} result=${result}`;
    });
  } finally {
    db.close();
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Runner side
// ---------------------------------------------------------------------------------------------------------------

/** One lane as a runner sees it on its host. */
export type ObservedLane = InventoryLane & { readonly status: LaneStatus; readonly reportHash?: string };

/**
 * A lane's status from its herdr pane, by panes.ts `paneAlive`: no pane: `missing`; a pane whose agent is not alive:
 * `dead`; alive and working: `working`; alive otherwise: `idle`.
 */
export const laneStatus = (pane: Pane | undefined): LaneStatus =>
  !pane ? "missing" : !paneAlive(pane) ? "dead" : pane.agent_status === "working" ? "working" : "idle";

export type Every = (ms: number, tick: () => void) => () => void;

/** `setInterval` as an `Every`. */
export const realEvery: Every = (ms, tick) => {
  const timer = setInterval(tick, ms);
  return () => { clearInterval(timer); };
};

export type ServeDeps = {
  readonly client: RunnerClient;
  /** The client's newest connection (`trackedConnector(...).latest`), so the loop can wait for its close. */
  readonly latest: () => Transport | undefined;
  readonly clock: Clock;
  /** Runs `tick` every `ms` until the returned stop is called; heartbeats and observations each get their own. */
  readonly every: Every;
  readonly heartbeatMs: number;
  /** Reads the runner's lanes; absent when the runner only says hello and heartbeats. */
  readonly observe?: () => Promise<readonly ObservedLane[]>;
  readonly observeMs?: number;
  readonly random?: () => number;
  readonly log: (line: string) => void;
};

/**
 * The runner's serve loop, as `RunnerClient.run` but with a heartbeat right after each hello and on a timer separate
 * from any work (heartbeats never go through the outbox). With `observe` a second timer reads the lanes, keeps the
 * latest list as the hello inventory, and publishes `lane.state {key, status, pane}` for each lane whose status or pane
 * changed (published through the outbox, so nothing is lost while disconnected). A lane no longer observed is
 * forgotten, so it is published again if it comes back. It changes nothing on the host.
 */
export const serveRunner = async (deps: ServeDeps, signal: AbortSignal): Promise<void> => {
  const published = new Map<string, string>();
  const publishedReport = new Map<string, string>();
  const observeOnce = async (): Promise<void> => {
    if (!deps.observe) return;
    try {
      const observed = await deps.observe();
      const keys = new Set(observed.map((lane) => lane.key));
      for (const map of [published, publishedReport]) for (const key of [...map.keys()]) if (!keys.has(key)) map.delete(key);
      for (const lane of observed) {
        const seen = JSON.stringify([lane.status, lane.pane]);
        if (published.get(lane.key) !== seen) {
          published.set(lane.key, seen);
          deps.client.publish("lane.state", { key: lane.key, status: lane.status, pane: lane.pane });
        }
        if (lane.reportHash && publishedReport.get(lane.key) !== lane.reportHash) {
          publishedReport.set(lane.key, lane.reportHash);
          deps.client.publish("lane.progress", { key: lane.key, reportHash: lane.reportHash });
        }
      }
    } catch (error) {
      deps.log(`RUNNER_OBSERVE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const stopHeartbeat = deps.every(deps.heartbeatMs, () => { deps.client.heartbeat(); });
  let observing = false;
  const stopObserve = deps.observe
    ? deps.every(deps.observeMs ?? OBSERVE_MS, () => {
        if (observing) return;
        observing = true;
        void observeOnce().finally(() => { observing = false; });
      })
    : () => {};
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  let attempt = 0;
  try {
    await observeOnce();
    while (!signal.aborted) {
      const outcome = await deps.client.connectOnce();
      if (outcome.ok) {
        attempt = 0;
        deps.log(`RUNNER_CONNECTED eventAck=${outcome.eventAck} replayed=${outcome.replayed}`);
        deps.client.heartbeat();
        const open = deps.latest();
        await Promise.race([
          aborted,
          new Promise<void>((resolve) => { if (!open?.open) resolve(); else open.onClose(() => resolve()); }),
        ]);
        if (signal.aborted) open?.close("aborted");
        else deps.log("RUNNER_DISCONNECTED");
      } else {
        deps.latest()?.close(outcome.code);
        deps.log(`${outcome.code} ${outcome.detail}`);
        attempt += 1;
      }
      await yieldTurn();
      if (signal.aborted) break;
      await Promise.race([aborted, deps.clock.sleep(backoffMs(Math.max(0, attempt - 1), deps.random))]);
    }
  } finally {
    stopHeartbeat();
    stopObserve();
  }
};

/**
 * Reads the `dori runner enroll` output a runner gets on stdin: `code=<base64url>` and `fingerprint=sha256:<hex>` lines
 * (other lines and surrounding blanks are ignored). Undefined when either is missing or malformed.
 */
export const parseEnrollInput = (text: string): { readonly code: string; readonly fingerprint: string } | undefined => {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(code|fingerprint)=(\S+)\s*$/.exec(line);
    if (match) values.set(match[1] as string, match[2] as string);
  }
  const code = values.get("code");
  const fp = values.get("fingerprint");
  if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code) || !fp || !/^sha256:[0-9a-f]{64}$/.test(fp)) return undefined;
  return { code, fingerprint: fp };
};

/**
 * What an effect resolves to: a detail string (the proto 2 shape, still accepted), or the detail with the command's
 * structured result (`CommandResults[type]`), which goes out as `cmd.result.result` and is stored with the record.
 */
export type EffectOutput<T extends SupervisorCommandType = SupervisorCommandType> =
  | string
  | { readonly detail: string; readonly result?: T extends keyof CommandResults ? CommandResults[T] : JsonValue };

export type DispatchDeps = {
  readonly state: RunnerState;
  readonly policy: RunnerPolicy;
  /** `fs.realpathSync` in production: resolves symlinks and throws for a missing path. */
  readonly realpath: (path: string) => string;
  /** Publishes the `cmd.result` event (through the outbox). */
  readonly publish: (body: RunnerEventBodies["cmd.result"]) => void;
  readonly log: (line: string) => void;
  /**
   * The effect of each command type the runner carries out; it resolves to the result detail, or to `{detail, result}`.
   * Others are unsupported.
   */
  readonly effects?: { readonly [T in SupervisorCommandType]?: (command: Extract<AnySupervisorCommand, { readonly type: T }>) => Promise<EffectOutput<T>> };
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The runner's command dispatcher. For every command the supervisor sends (`runner.rotate` is handled by the client):
 * 1. policy.ts `checkCommand` (schema and the runner's own allow lists); a refusal is recorded final and answered
 *    `cmd.result failed "RUNNER_CMD_REJECTED <rule>"`.
 * 2. The intent row is committed in the state; a cmdId already recorded is not run again. A cmdId whose record is
 *    final is answered again with that record's `cmd.result` (state, detail, stored result), so a resent operation
 *    gets its answer; one still at `intent` is left alone (its effect is running, or a restart settles it).
 * 3. Right before the effect, fencing.ts `checkEffectEpoch` against a fresh read of `maxEpoch`; a stale command is
 *    recorded and answered `failed` with the `RUNNER_CMD_REJECTED stale-epoch ...` detail.
 * 4. The effect from `effects`: its detail (and structured result) is recorded `verified`, a throw `failed`. A type without one is answered
 *    `failed "RUNNER_CMD_UNSUPPORTED <type>"`.
 * A frame without a usable cmdId and cmdSeq cannot be answered and is only logged.
 */
export const commandDispatcher = (deps: DispatchDeps) => (raw: unknown): void => {
  const body = isRecord(raw) && isRecord(raw.body) ? raw.body : undefined;
  const cmdId = body?.cmdId;
  const cmdSeq = isRecord(raw) ? raw.cmdSeq : undefined;
  const type = isRecord(raw) && typeof raw.type === "string" ? raw.type : "?";
  if (typeof cmdId !== "string" || !Number.isSafeInteger(cmdSeq) || (cmdSeq as number) < 1) {
    deps.log(`RUNNER_CMD_DROPPED type=${type} no cmdId or cmdSeq to answer`);
    return;
  }
  const seq = cmdSeq as number;
  const epoch = isRecord(raw) && Number.isSafeInteger(raw.epoch) ? (raw.epoch as number) : 0;
  const key = typeof body?.key === "string" ? body.key : undefined;
  const finish = (detail: string, outcome: "verified" | "failed" = "failed", result?: JsonValue): void => {
    deps.state.recordResult(cmdId, outcome, detail, result);
    deps.publish({ cmdId, cmdSeq: seq, state: outcome, detail, ...(result !== undefined ? { result } : {}) });
    deps.log(`${outcome === "verified" ? "RUNNER_CMD_DONE" : "RUNNER_CMD_FAILED"} cmdId=${cmdId} type=${type} ${detail}`);
  };
  const intent = { cmdId, cmdSeq: seq, type: type as SupervisorCommandType, epoch, ...(key !== undefined ? { key } : {}) };
  const checked = checkCommand(deps.policy, raw, deps.realpath);
  const recorded = deps.state.recordIntent(intent);
  if (!recorded.fresh) {
    const record = recorded.existing;
    if (record.state === "intent") return;
    const detail = record.result ?? "";
    deps.publish({
      cmdId, cmdSeq: record.cmdSeq, state: record.state, detail, ...(record.resultValue !== undefined ? { result: record.resultValue } : {}),
    });
    deps.log(`RUNNER_CMD_REPLAYED cmdId=${cmdId} type=${record.type} state=${record.state}`);
    return;
  }
  if (!checked.ok) { finish(rejectionText(checked.rule)); return; }
  deps.state.observeEpoch(checked.command.epoch);
  const fence = checkEffectEpoch(checked.command.epoch, deps.state.maxEpoch());
  if (!fence.ok) { finish(fence.detail); return; }
  const effect = deps.effects?.[checked.command.type] as ((command: AnySupervisorCommand) => Promise<EffectOutput>) | undefined;
  if (!effect) { finish(`RUNNER_CMD_UNSUPPORTED ${checked.command.type}`); return; }
  void effect(checked.command).then(
    (output) => {
      if (typeof output === "string") finish(output, "verified");
      else finish(output.detail, "verified", output.result as JsonValue | undefined);
    },
    (error: unknown) => { finish(`RUNNER_CMD_FAILED ${error instanceof Error ? error.message : String(error)}`); },
  );
};

/** Wraps `connect` so `serveRunner` sees each connection; pass the result to both the client and `serveRunner`. */
export const trackedConnector = (connect: Connector): { readonly connect: Connector; readonly latest: () => Transport | undefined } => {
  let latest: Transport | undefined;
  return {
    connect: async () => (latest = await connect()),
    latest: () => latest,
  };
};
