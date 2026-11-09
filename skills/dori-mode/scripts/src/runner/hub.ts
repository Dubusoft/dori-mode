import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventMeta } from "../supervise-journal.ts";
import { decideHello, recordHello, resetGen, type StoredRunner } from "./fencing.ts";
import {
  PROTO, checkProto, journalId, supervisorControl,
  type AnyRunnerEvent, type RunnerControl, type RunnerEventBodies, type RunnerFrame, type SupervisorControl, type SupervisorFrame,
  type WorkspaceEntry,
} from "./protocol.ts";

/**
 * The supervisor side of the runner protocol. Runner rows live in `<stateDir>/runners.sqlite` (0600, WAL), table
 * `runners {label, hostId, eventAck, cmdSeq, maxGen, proto, version, lastHelloAt, cmdAck}` plus the later columns
 * (LATER_COLUMNS, among them `herdr` and `herdrSince` from herdr-down.ts). An event is committed to
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

/** A command an earlier supervisor run sent and never saw the result of (`runner_attempts`). */
export type AttemptRow = { readonly cmdId: string; readonly type: string; readonly key?: string; readonly body: Record<string, unknown> };

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
  /** The runner's machine's herdr as its guard samples showed it (herdr-down.ts); absent until a sample carried a pane count. */
  readonly herdr?: "up" | "down" | "hung";
  /** Supervisor wall time `herdr` was entered. */
  readonly herdrSince?: number;
  /** The machine readings of the runner's last `guard.sample` (absent until one arrived). */
  readonly machine?: RunnerMachine;
  /** The repos the last hello that reported any declared and detected (kept while the runner is away); absent: never reported. */
  readonly workspaces?: RunnerWorkspaces;
};

export type RunnerWorkspaces = { readonly declared: readonly WorkspaceEntry[]; readonly detected: readonly WorkspaceEntry[] };

const entries = (v: unknown): WorkspaceEntry[] =>
  Array.isArray(v) ? v.filter((e): e is WorkspaceEntry => typeof e?.repo === "string" && typeof e?.path === "string").map((e) => ({ repo: e.repo, path: e.path })) : [];

/** The saved `workspaces` column, or undefined when it is missing or does not read as one. */
const parseWorkspaces = (text: string | null): RunnerWorkspaces | undefined => {
  if (text === null) return undefined;
  try {
    const v = JSON.parse(text) as Record<string, unknown> | null;
    return v && typeof v === "object" ? { declared: entries(v.declared), detected: entries(v.detected) } : undefined;
  } catch { return undefined; }
};

/** One runner's last `guard.sample` as the hub saves it: `at` is the supervisor wall time it arrived, -1 a reading the runner could not take. */
export type RunnerMachine = {
  readonly at: number;
  readonly level: "ok" | "alert" | "critical";
  readonly reasons: readonly string[];
  readonly os?: string;
  readonly load1?: number;
  readonly memFreePct?: number;
  readonly diskFreeGb?: number;
  readonly swapFreeGb?: number;
  readonly swapTotalGb?: number;
  readonly panes?: number;
  /** Resident memory of the runner's lanes together, from `guard.sample.lanes`. */
  readonly lanesRssKb?: number;
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The saved `machine` column, or undefined when it is missing or does not read as one. */
const parseMachine = (text: string | null): RunnerMachine | undefined => {
  if (text === null) return undefined;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return undefined; }
  if (typeof v !== "object" || v === null) return undefined;
  const m = v as Record<string, unknown>;
  if (!isNum(m.at) || (m.level !== "ok" && m.level !== "alert" && m.level !== "critical")) return undefined;
  const nums = ["load1", "memFreePct", "diskFreeGb", "swapFreeGb", "swapTotalGb", "panes", "lanesRssKb"] as const;
  return {
    at: m.at, level: m.level,
    reasons: Array.isArray(m.reasons) ? m.reasons.filter((r): r is string => typeof r === "string") : [],
    ...(typeof m.os === "string" ? { os: m.os } : {}),
    ...Object.fromEntries(nums.filter((k) => isNum(m[k])).map((k) => [k, m[k]])),
  };
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
  /** `replace`: the runner restarted (higher gen), so the connection held for the label must be closed. */
  | { readonly ok: true; readonly reply: SupervisorControl<"hello.ok">; readonly row: RunnerRow; readonly replace: boolean }
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
  lanes: number | null; herdr: string | null; herdrSince: number | null; machine: string | null; workspaces: string | null;
};

const COLUMNS = "label, hostId, eventAck, cmdSeq, maxGen, cmdAck, proto, version, lastHelloAt, lastHeartbeatAt, disconnectedAt, outboxUnacked, outboxOldestAgeMs, lanes, herdr, herdrSince, machine, workspaces";
/** Columns added after the first table layout, with their types; an older table gets them on open. */
const LATER_COLUMNS = {
  lastHeartbeatAt: "INTEGER", disconnectedAt: "INTEGER", outboxUnacked: "INTEGER", outboxOldestAgeMs: "INTEGER", lanes: "INTEGER",
  herdr: "TEXT", herdrSince: "INTEGER", machine: "TEXT", workspaces: "TEXT",
} as const;

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
  ...(r.herdr === "up" || r.herdr === "down" || r.herdr === "hung" ? { herdr: r.herdr } : {}),
  ...(r.herdrSince !== null ? { herdrSince: r.herdrSince } : {}),
  ...(() => { const machine = parseMachine(r.machine); return machine ? { machine } : {}; })(),
  ...(() => { const workspaces = parseWorkspaces(r.workspaces); return workspaces ? { workspaces } : {}; })(),
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
    for (const [column, type] of Object.entries(LATER_COLUMNS)) if (!have.has(column)) this.db.run(`ALTER TABLE runners ADD COLUMN ${column} ${type}`);
    this.db.run(
      `CREATE TABLE IF NOT EXISTS runner_attempts (
        cmdId TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL, key TEXT, body TEXT NOT NULL, epoch INTEGER NOT NULL, at INTEGER NOT NULL
      )`,
    );
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

  /** The supervisor epoch this hub stamps on its frames. */
  get epoch(): number {
    return this.deps.epoch;
  }

  /**
   * Binds an existing runner row to the hostId of a fresh enrollment, so a runner enrolled again on another host is
   * not refused as `RUNNER_CONFLICT`. A label without a row gets one at its first hello.
   */
  bindHost(label: string, hostId: string): void {
    this.db.query("UPDATE runners SET hostId = ? WHERE label = ?").run(hostId, label);
  }

  /**
   * Records a command as attempted before it is sent, under this hub's epoch: a command sent again under the same
   * cmdId takes the current epoch. `settleAttempt` drops it when its `cmd.result` is committed.
   */
  recordAttempt(label: string, type: string, cmdId: string, key: string | undefined, body: object): void {
    this.db.query("INSERT OR REPLACE INTO runner_attempts (cmdId, label, type, key, body, epoch, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(cmdId, label, type, key ?? null, JSON.stringify(body), this.deps.epoch, this.deps.now());
  }

  /** Forgets an attempted command of `label` (its result arrived, or its read-back settled it). */
  settleAttempt(label: string, cmdId: string): void {
    this.db.query("DELETE FROM runner_attempts WHERE cmdId = ? AND label = ?").run(cmdId, label);
  }

  /**
   * The commands an earlier supervisor run attempted on `label` with no `cmd.result` yet, oldest first. A record older
   * than `retentionMs` is deleted instead: the runner keeps its command records no longer than that.
   */
  staleAttempts(label: string, retentionMs: number): AttemptRow[] {
    this.db.query("DELETE FROM runner_attempts WHERE label = ? AND at < ?").run(label, this.deps.now() - retentionMs);
    const rows = this.db.query("SELECT cmdId, type, key, body FROM runner_attempts WHERE label = ? AND epoch < ? ORDER BY at, cmdId")
      .all(label, this.deps.epoch) as { cmdId: string; type: string; key: string | null; body: string }[];
    return rows.map((r) => ({ cmdId: r.cmdId, type: r.type, ...(r.key !== null ? { key: r.key } : {}), body: JSON.parse(r.body) as Record<string, unknown> }));
  }

  /** Issues and persists the next cmdSeq for an admitted runner. */
  nextCmdSeq(label: string): number {
    const row = this.db.query("UPDATE runners SET cmdSeq = cmdSeq + 1 WHERE label = ? RETURNING cmdSeq").get(label) as { cmdSeq: number } | null;
    if (!row) throw new Error(`RUNNER_UNKNOWN ${label}`);
    return row.cmdSeq;
  }

  /**
   * Admits a hello: `checkProto` (`RUNNER_PROTO_MISMATCH`), then fencing.ts `decideHello` against the stored hostId and
   * maxGen (`RUNNER_CONFLICT`: another hostId, a lower gen, or the gen of the live connection `connectedGen` again).
   * On success it persists hostId, the highest gen seen, cmdAck, proto, version and lastHelloAt and replies
   * `hello.ok {proto, epoch, eventAck}`. A label seen for the first time gets a row with eventAck 0. A stored maxGen of
   * 0 means none (a new row, or after `resetRunnerGen`).
   */
  hello(frame: RunnerControl<"hello">, connectedGen?: number): HelloOutcome {
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
    const stored: StoredRunner | undefined = existing
      ? { ...(existing.hostId !== undefined ? { hostId: existing.hostId } : {}), ...(existing.maxGen > 0 ? { maxGen: existing.maxGen } : {}) }
      : undefined;
    const identity = { label, hostId: body.hostId, gen: body.gen };
    const decision = decideHello(stored, identity, connectedGen);
    if (decision.action === "conflict") return reject(decision.code, decision.detail);
    const maxGen = recordHello(stored, identity).maxGen;
    this.db.query(
      `INSERT INTO runners (label, hostId, eventAck, cmdSeq, maxGen, cmdAck, proto, version, lastHelloAt)
       VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET hostId = excluded.hostId, maxGen = excluded.maxGen, cmdAck = excluded.cmdAck,
         proto = excluded.proto, version = excluded.version, lastHelloAt = excluded.lastHelloAt`,
    ).run(label, body.hostId, maxGen, body.cmdAck, body.proto, body.version ?? null, this.deps.now());
    this.db.query("UPDATE runners SET lanes = ? WHERE label = ?").run(body.inventory ? body.inventory.length : null, label);
    // A runner that predates placement reports sends neither field; its last report (if any) stays.
    if (body.workspaces !== undefined || body.detected !== undefined) {
      this.db.query("UPDATE runners SET workspaces = ? WHERE label = ?")
        .run(JSON.stringify({ declared: body.workspaces ?? [], detected: body.detected ?? [] }), label);
    }
    this.lockDown();
    this.live.set(label, { ...(this.live.get(label) ?? {}), lastSeen: this.deps.monotonic() });
    const row = this.get(label) as RunnerRow;
    return {
      ok: true,
      row,
      replace: decision.action === "replace",
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

  /** Saves the runner's machine's herdr state (herdr-down.ts) and when it was entered. */
  setHerdr(label: string, state: "up" | "down" | "hung", since: number): void {
    this.db.query("UPDATE runners SET herdr = ?, herdrSince = ? WHERE label = ?").run(state, since, label);
  }

  /** Saves the readings of a runner's `guard.sample`, stamped with the supervisor's wall clock, for `dori status`. */
  setMachine(label: string, b: RunnerEventBodies["guard.sample"]): void {
    const machine: RunnerMachine = {
      at: this.deps.now(), level: b.level, reasons: [...b.reasons],
      ...(b.os !== undefined ? { os: b.os } : {}),
      ...(b.load1 !== undefined ? { load1: b.load1 } : {}),
      ...(b.memFreePct !== undefined ? { memFreePct: b.memFreePct } : {}),
      ...(b.diskFreeGb !== undefined ? { diskFreeGb: b.diskFreeGb } : {}),
      ...(b.swapFreeGb !== undefined ? { swapFreeGb: b.swapFreeGb } : {}),
      ...(b.swapTotalGb !== undefined ? { swapTotalGb: b.swapTotalGb } : {}),
      ...(b.panes !== undefined ? { panes: b.panes } : {}),
      ...(b.lanes ? { lanesRssKb: b.lanes.reduce((sum, lane) => sum + lane.rssKb, 0) } : {}),
    };
    this.db.query("UPDATE runners SET machine = ? WHERE label = ?").run(JSON.stringify(machine), label);
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

/** Private runner journal line with the original body JSON; report routing applies the same redaction as local reports. */
export const eventLine = (frame: AnyRunnerEvent): string =>
  `RUNNER_EVENT runner=${frame.runner} seq=${frame.seq} type=${frame.type} ${JSON.stringify(frame.body)}`;

/**
 * One `dori status` line:
 * `RUNNER <label> <state> proto=<n> version=<v> gen=<n> hb=<sec> outbox=<unacked>/<oldestAgeSec>`; unknown values print `-`.
 */
export const formatRunnerStatus = (status: RunnerStatus): string => {
  const or = (v: number | string | undefined): string => (v === undefined ? "-" : String(v));
  const outbox = status.outbox ? `${status.outbox.unacked}/${Math.floor(status.outbox.oldestAgeMs / 1000)}` : "-";
  return `RUNNER ${status.label} ${status.state} proto=${or(status.proto)} version=${or(status.version)} gen=${status.gen} hb=${or(status.heartbeatAgeSec)} outbox=${outbox}`;
};

/**
 * `dori runner reset-gen <label>`: clears the label's stored maxGen (fencing.ts `resetGen`, hostId kept) so the next
 * hello from the same host is admitted at any gen. Returns false when the label has no row.
 */
export const resetRunnerGen = (stateDir: string, label: string): boolean => {
  const path = join(stateDir, HUB_FILE);
  if (!existsSync(path)) return false;
  const db = new Database(path);
  try {
    const row = db.query("SELECT hostId, maxGen FROM runners WHERE label = ?").get(label) as { hostId: string | null; maxGen: number } | null;
    if (!row) return false;
    const kept = resetGen({ ...(row.hostId !== null ? { hostId: row.hostId } : {}), maxGen: row.maxGen });
    db.query("UPDATE runners SET hostId = ?, maxGen = ? WHERE label = ?").run(kept.hostId ?? null, kept.maxGen ?? 0, label);
    return true;
  } finally {
    db.close();
  }
};

/**
 * `dori runner remove <label>`: deletes the label's `runners` row and its `runner_attempts`, so a restarted supervisor
 * no longer tracks it. `runner_keys` stays: its revokedAt is the tombstone that refuses later hellos. Returns whether a
 * `runners` row went (false when the file or table is missing).
 */
export const forgetRunner = (stateDir: string, label: string): boolean => {
  const path = join(stateDir, HUB_FILE);
  if (!existsSync(path)) return false;
  const db = new Database(path);
  try {
    const has = (table: string) => db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;
    if (has("runner_attempts")) db.query("DELETE FROM runner_attempts WHERE label = ?").run(label);
    return has("runners") && db.query("DELETE FROM runners WHERE label = ?").run(label).changes > 0;
  } finally {
    db.close();
  }
};

/** Reads runner status rows from `<stateDir>/runners.sqlite` without a live hub (read-only; [] when absent). */
export const readRunnerRows = (stateDir: string): RunnerRow[] => {
  const path = join(stateDir, HUB_FILE);
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    // A table the supervisor has not opened since an upgrade lacks the later columns: they read as NULL.
    const have = new Set((db.query("PRAGMA table_info(runners)").all() as { name: string }[]).map((c) => c.name));
    const select = COLUMNS.split(", ").map((c) => (have.has(c) ? c : `NULL AS ${c}`)).join(", ");
    return (db.query(`SELECT ${select} FROM runners ORDER BY label`).all() as DbRow[]).map(toRow);
  } catch {
    return [];
  } finally {
    db.close();
  }
};
