import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../redact.ts";
import type { EventMeta } from "../supervise-journal.ts";
import {
  PROTO, checkProto, journalId, supervisorControl,
  type AnyRunnerEvent, type RunnerControl, type RunnerFrame, type SupervisorControl, type SupervisorFrame,
} from "./protocol.ts";

/**
 * The supervisor side of the runner protocol. Runner rows live in `<stateDir>/runners.sqlite` (0600, WAL), table
 * `runners {label, hostId, eventAck, cmdSeq, maxGen, proto, version, lastHelloAt, cmdAck}`. An event is committed to
 * the journal through the injected `commit` (`Supervisor.enqueue` in production) under id `runner:<label>:<seq>`, and
 * only after that returns is `eventAck` advanced and persisted. Only the next expected seq (`eventAck + 1`) is
 * committed: a frame past a gap is not committed and leaves `eventAck` where it is, so the runner's replay after its
 * next hello fills the gap in seq order. A seq at or below `eventAck` is a duplicate and is acked without a commit.
 */

export const HUB_FILE = "runners.sqlite";
/** No heartbeat for this long (supervisor monotonic clock): the runner is stale. */
export const RUNNER_STALE_MS = 60_000;
/** No heartbeat for this long: the runner is offline. */
export const RUNNER_OFFLINE_MS = 180_000;

/**
 * Commits one event to the journal; returns false when the id is already there (a duplicate, still committed). It
 * throws when it could not commit, and then the hub does not ack.
 */
export type CommitFn = (id: string, line: string, meta?: EventMeta) => boolean;

export type HubDeps = {
  readonly stateDir: string;
  readonly commit: CommitFn;
  /** Wall clock (persisted times). */
  readonly now: () => number;
  /** Monotonic clock (heartbeat ages); never the runner's clock. */
  readonly monotonic: () => number;
  /** The supervisor epoch, committed before the hub is built. */
  readonly epoch: number;
  /** The proto this supervisor speaks (default `PROTO`). */
  readonly proto?: number;
};

export type RunnerRow = {
  readonly label: string;
  readonly hostId?: string;
  readonly eventAck: number;
  /** The last cmdSeq issued to this runner. */
  readonly cmdSeq: number;
  /** The highest gen this runner has said hello with. */
  readonly maxGen: number;
  /** The runner's cmdAck from its last hello or cmd.result. */
  readonly cmdAck: number;
  readonly proto?: number;
  readonly version?: string;
  readonly lastHelloAt?: number;
  /** Supervisor wall time of the last heartbeat; `dori status` runs in another process and cannot see the monotonic clock. */
  readonly lastHeartbeatAt?: number;
  /** Supervisor wall time the last connection of this runner closed. */
  readonly disconnectedAt?: number;
  /** The outbox figures of the last heartbeat. */
  readonly outbox?: { readonly unacked: number; readonly oldestAgeMs: number };
  /** How many lanes the last hello's inventory listed. */
  readonly lanes?: number;
};

export type RunnerLiveness = "connected" | "stale" | "offline" | "disconnected";

/** One `dori status` row. */
export type RunnerStatus = {
  readonly label: string;
  readonly state: RunnerLiveness;
  readonly proto?: number;
  readonly version?: string;
  readonly gen: number;
  readonly eventAck: number;
  /** Seconds since the last heartbeat, when one arrived since this supervisor started. */
  readonly heartbeatAgeSec?: number;
  readonly outbox?: { readonly unacked: number; readonly oldestAgeMs: number };
};

export type HelloOutcome =
  | { readonly ok: true; readonly reply: SupervisorControl<"hello.ok">; readonly row: RunnerRow }
  | { readonly ok: false; readonly reply: SupervisorControl<"hello.reject"> };

export type ReceiveOutcome = {
  /** `committed`: this call committed it; `duplicate`: at or below eventAck; `gap`: past eventAck + 1, not committed. */
  readonly result: "committed" | "duplicate" | "gap";
  readonly eventAck: number;
  readonly reply: SupervisorControl<"ack">;
};

type DbRow = {
  label: string; hostId: string | null; eventAck: number; cmdSeq: number; maxGen: number; cmdAck: number;
  proto: number | null; version: string | null; lastHelloAt: number | null;
  lastHeartbeatAt: number | null; disconnectedAt: number | null; outboxUnacked: number | null; outboxOldestAgeMs: number | null;
  lanes: number | null;
};

const COLUMNS = "label, hostId, eventAck, cmdSeq, maxGen, cmdAck, proto, version, lastHelloAt, lastHeartbeatAt, disconnectedAt, outboxUnacked, outboxOldestAgeMs, lanes";
/** Columns added after the first table layout; an older table gets them on open. */
const LATER_COLUMNS = ["lastHeartbeatAt", "disconnectedAt", "outboxUnacked", "outboxOldestAgeMs", "lanes"] as const;

const toRow = (r: DbRow): RunnerRow => ({
  label: r.label,
  ...(r.hostId !== null ? { hostId: r.hostId } : {}),
  eventAck: r.eventAck,
  cmdSeq: r.cmdSeq,
  maxGen: r.maxGen,
  cmdAck: r.cmdAck,
  ...(r.proto !== null ? { proto: r.proto } : {}),
  ...(r.version !== null ? { version: r.version } : {}),
  ...(r.lastHelloAt !== null ? { lastHelloAt: r.lastHelloAt } : {}),
  ...(r.lastHeartbeatAt !== null ? { lastHeartbeatAt: r.lastHeartbeatAt } : {}),
  ...(r.disconnectedAt !== null ? { disconnectedAt: r.disconnectedAt } : {}),
  ...(r.outboxUnacked !== null && r.outboxOldestAgeMs !== null ? { outbox: { unacked: r.outboxUnacked, oldestAgeMs: r.outboxOldestAgeMs } } : {}),
  ...(r.lanes !== null ? { lanes: r.lanes } : {}),
});

type Live = { lastSeen: number; heartbeatAt?: number; outbox?: { unacked: number; oldestAgeMs: number } };

export class RunnerHub {
  private readonly db: Database;
  private readonly path: string;
  private readonly live = new Map<string, Live>();

  /** Opens or creates `<stateDir>/runners.sqlite`. */
  constructor(private readonly deps: HubDeps) {
    mkdirSync(deps.stateDir, { recursive: true });
    this.path = join(deps.stateDir, HUB_FILE);
    this.db = new Database(this.path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS runners (
        label TEXT PRIMARY KEY, hostId TEXT, eventAck INTEGER NOT NULL DEFAULT 0, cmdSeq INTEGER NOT NULL DEFAULT 0,
        maxGen INTEGER NOT NULL DEFAULT 0, cmdAck INTEGER NOT NULL DEFAULT 0, proto INTEGER, version TEXT, lastHelloAt INTEGER
      )`,
    );
    const have = new Set((this.db.query("PRAGMA table_info(runners)").all() as { name: string }[]).map((c) => c.name));
    for (const column of LATER_COLUMNS) if (!have.has(column)) this.db.run(`ALTER TABLE runners ADD COLUMN ${column} INTEGER`);
    this.lockDown();
  }

  private lockDown(): void {
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(this.path + suffix)) chmodSync(this.path + suffix, 0o600);
  }

  private get(label: string): RunnerRow | undefined {
    const r = this.db.query(`SELECT ${COLUMNS} FROM runners WHERE label = ?`).get(label) as DbRow | null;
    return r ? toRow(r) : undefined;
  }

  private head(label: string, gen: number) {
    return { runner: label, gen, epoch: this.deps.epoch };
  }

  /**
   * Admits a hello: `checkProto` (`RUNNER_PROTO_MISMATCH`), the same label under another hostId or a gen below the
   * stored maxGen (`RUNNER_CONFLICT`). On success it persists hostId, maxGen, cmdAck, proto, version and lastHelloAt
   * and replies `hello.ok {proto, epoch, eventAck}`. A label seen for the first time gets a row with eventAck 0.
   */
  hello(frame: RunnerControl<"hello">): HelloOutcome {
    const body = frame.body;
    const supervisorProto = this.deps.proto ?? PROTO;
    const reject = (code: "RUNNER_PROTO_MISMATCH" | "RUNNER_CONFLICT", detail: string): HelloOutcome => ({
      ok: false,
      reply: supervisorControl(this.head(frame.runner, frame.gen), "hello.reject", { code, detail }),
    });
    const check = checkProto(body.proto, supervisorProto);
    if (!check.ok) return reject(check.code, check.detail);
    const label = body.label;
    const existing = this.get(label);
    if (existing?.hostId !== undefined && existing.hostId !== body.hostId) {
      return reject("RUNNER_CONFLICT", `label ${label} is bound to another host`);
    }
    if (existing && body.gen < existing.maxGen) {
      return reject("RUNNER_CONFLICT", `gen ${body.gen} is below the recorded gen ${existing.maxGen}`);
    }
    this.db.query(
      `INSERT INTO runners (label, hostId, eventAck, cmdSeq, maxGen, cmdAck, proto, version, lastHelloAt)
       VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET hostId = excluded.hostId, maxGen = excluded.maxGen, cmdAck = excluded.cmdAck,
         proto = excluded.proto, version = excluded.version, lastHelloAt = excluded.lastHelloAt`,
    ).run(label, body.hostId, body.gen, body.cmdAck, body.proto, body.version ?? null, this.deps.now());
    this.db.query("UPDATE runners SET lanes = ? WHERE label = ?").run(body.inventory ? body.inventory.length : null, label);
    this.lockDown();
    this.live.set(label, { ...(this.live.get(label) ?? {}), lastSeen: this.deps.monotonic() });
    const row = this.get(label) as RunnerRow;
    return {
      ok: true,
      row,
      reply: supervisorControl(this.head(label, body.gen), "hello.ok", { proto: supervisorProto, epoch: this.deps.epoch, eventAck: row.eventAck }),
    };
  }

  /** Receives one event from an admitted runner (see the module comment for the commit-then-ack order). */
  receive(frame: AnyRunnerEvent): ReceiveOutcome {
    const label = frame.runner;
    const row = this.get(label);
    const make = (result: ReceiveOutcome["result"], eventAck: number): ReceiveOutcome => ({
      result,
      eventAck,
      reply: supervisorControl(this.head(label, frame.gen), "ack", { eventAck }),
    });
    if (!row) return make("gap", 0);
    const live = this.live.get(label);
    if (live) live.lastSeen = this.deps.monotonic();
    if (frame.seq <= row.eventAck) return make("duplicate", row.eventAck);
    if (frame.seq > row.eventAck + 1) return make("gap", row.eventAck);
    this.deps.commit(journalId(label, frame.seq), eventLine(frame));
    this.db.query("UPDATE runners SET eventAck = ? WHERE label = ?").run(frame.seq, label);
    return make("committed", frame.seq);
  }

  /** Records a heartbeat at `monotonic()` and its outbox figures (in memory only). */
  heartbeat(frame: RunnerControl<"heartbeat">): void {
    const at = this.deps.monotonic();
    const previous = this.live.get(frame.runner);
    this.live.set(frame.runner, {
      lastSeen: at,
      heartbeatAt: at,
      ...(frame.body.outbox ? { outbox: { ...frame.body.outbox } } : previous?.outbox ? { outbox: previous.outbox } : {}),
    });
    // Persisted with the supervisor's wall clock so `dori status` (another process) can tell how fresh it is.
    const outbox = frame.body.outbox;
    this.db.query(
      outbox
        ? "UPDATE runners SET lastHeartbeatAt = ?, outboxUnacked = ?, outboxOldestAgeMs = ? WHERE label = ?"
        : "UPDATE runners SET lastHeartbeatAt = ? WHERE label = ?",
    ).run(...(outbox ? [this.deps.now(), outbox.unacked, outbox.oldestAgeMs, frame.runner] : [this.deps.now(), frame.runner]));
  }

  /** Dispatches any runner frame and returns the reply to send, if one is due. */
  handle(frame: RunnerFrame): SupervisorFrame | undefined {
    if ("seq" in frame) return this.receive(frame).reply;
    if (frame.type === "hello") return this.hello(frame as RunnerControl<"hello">).reply;
    if (frame.type === "heartbeat") this.heartbeat(frame as RunnerControl<"heartbeat">);
    return undefined;
  }

  /** Marks a runner's connection closed (its row stays). */
  disconnected(label: string): void {
    this.live.delete(label);
    this.db.query("UPDATE runners SET disconnectedAt = ? WHERE label = ?").run(this.deps.now(), label);
  }

  runner(label: string): RunnerRow | undefined {
    return this.get(label);
  }

  runners(): RunnerRow[] {
    return (this.db.query(`SELECT ${COLUMNS} FROM runners ORDER BY label`).all() as DbRow[]).map(toRow);
  }

  /** Status rows for every known runner, liveness by `monotonic()` against `RUNNER_STALE_MS`/`RUNNER_OFFLINE_MS`. */
  status(): RunnerStatus[] {
    const at = this.deps.monotonic();
    return this.runners().map((row) => {
      const live = this.live.get(row.label);
      let state: RunnerLiveness = "disconnected";
      if (live) {
        const idle = at - live.lastSeen;
        state = idle >= RUNNER_OFFLINE_MS ? "offline" : idle >= RUNNER_STALE_MS ? "stale" : "connected";
      }
      return {
        label: row.label,
        state,
        ...(row.proto !== undefined ? { proto: row.proto } : {}),
        ...(row.version !== undefined ? { version: row.version } : {}),
        gen: row.maxGen,
        eventAck: row.eventAck,
        ...(live?.heartbeatAt !== undefined ? { heartbeatAgeSec: Math.floor((at - live.heartbeatAt) / 1000) } : {}),
        ...(live?.outbox ? { outbox: live.outbox } : {}),
      };
    });
  }

  close(): void {
    this.db.close();
  }
}

/** The journal line of a runner event: `RUNNER_EVENT runner=<label> seq=<n> type=<type>` followed by the redacted body JSON. */
export const eventLine = (frame: AnyRunnerEvent): string =>
  `RUNNER_EVENT runner=${frame.runner} seq=${frame.seq} type=${frame.type} ${redactSecrets(JSON.stringify(frame.body))}`;

/**
 * One `dori status` line:
 * `RUNNER <label> <state> proto=<n> version=<v> gen=<n> hb=<sec> outbox=<unacked>/<oldestAgeSec>`; unknown values print `-`.
 */
export const formatRunnerStatus = (status: RunnerStatus): string => {
  const or = (v: number | string | undefined): string => (v === undefined ? "-" : String(v));
  const outbox = status.outbox ? `${status.outbox.unacked}/${Math.floor(status.outbox.oldestAgeMs / 1000)}` : "-";
  return `RUNNER ${status.label} ${status.state} proto=${or(status.proto)} version=${or(status.version)} gen=${status.gen} hb=${or(status.heartbeatAgeSec)} outbox=${outbox}`;
};

/** Reads runner status rows from `<stateDir>/runners.sqlite` without a live hub (read-only; [] when absent). */
export const readRunnerRows = (stateDir: string): RunnerRow[] => {
  const path = join(stateDir, HUB_FILE);
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return (db.query(`SELECT ${COLUMNS} FROM runners ORDER BY label`).all() as DbRow[]).map(toRow);
  } catch {
    return [];
  } finally {
    db.close();
  }
};
