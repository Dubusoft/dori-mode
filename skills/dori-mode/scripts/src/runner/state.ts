import { Database } from "bun:sqlite";
import { chmodSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import type { CommandOutcome, JsonValue, SupervisorCommandType } from "./protocol.ts";

/**
 * The runner's own durable state (`<runnerDir>/state.sqlite`, 0600 with its WAL):
 * - `gen`: bumped by `boot()` in one committed transaction before the first hello of a process;
 * - `maxEpoch`: the highest supervisor epoch seen; a command whose epoch is lower is stale and is refused right
 *   before its effect;
 * - `commands`: `{cmdId, cmdSeq, type, key, epoch, state, result, result_json}`; the intent row is committed before
 *   the effect, the result after it. `result` is the detail text, `result_json` (added in proto 3 with `ALTER TABLE`,
 *   nullable) the effect's structured result, so a resent cmdId can be answered again in full;
 * - `cmdAck`: the highest `cmdSeq` such that every `cmdSeq` up to it has a final (non-intent) row.
 */

export const STATE_FILE = "state.sqlite";
/** Command rows are kept this long after their last update. */
export const COMMAND_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type CommandRowState = "intent" | CommandOutcome;

export type CommandRecord = {
  readonly cmdId: string;
  readonly cmdSeq: number;
  readonly type: SupervisorCommandType;
  /** The lane key, for lane commands. */
  readonly key?: string;
  readonly epoch: number;
  readonly state: CommandRowState;
  readonly result?: string;
  /** The structured result stored with the final state (`result_json`); absent on old rows and detail-only results. */
  readonly resultValue?: JsonValue;
  readonly at: number;
  readonly updatedAt: number;
};

export type CommandIntent = Pick<CommandRecord, "cmdId" | "cmdSeq" | "type" | "key" | "epoch">;

export type RunnerStateOptions = { readonly now: () => number };

type CommandRow = {
  cmdId: string;
  cmdSeq: number;
  type: string;
  key: string | null;
  epoch: number;
  state: string;
  result: string | null;
  result_json: string | null;
  at: number;
  updated_at: number;
};

const COLUMNS = "cmdId, cmdSeq, type, key, epoch, state, result, result_json, at, updated_at";

/** A stored structured result; a value that does not parse reads as absent rather than breaking the record. */
const parseResult = (text: string | null): JsonValue | undefined => {
  if (text === null) return undefined;
  try { return JSON.parse(text) as JsonValue; } catch { return undefined; }
};

const toRecord = (row: CommandRow): CommandRecord => {
  const resultValue = parseResult(row.result_json);
  return {
    cmdId: row.cmdId,
    cmdSeq: row.cmdSeq,
    type: row.type as SupervisorCommandType,
    ...(row.key === null ? {} : { key: row.key }),
    epoch: row.epoch,
    state: row.state as CommandRowState,
    ...(row.result === null ? {} : { result: row.result }),
    ...(resultValue === undefined ? {} : { resultValue }),
    at: row.at,
    updatedAt: row.updated_at,
  };
};

export class RunnerState {
  private readonly db: Database;
  private readonly now: () => number;

  /** Opens or creates `<runnerDir>/state.sqlite`; the caller has checked the directory. */
  constructor(readonly runnerDir: string, options: RunnerStateOptions) {
    this.now = options.now;
    const path = join(runnerDir, STATE_FILE);
    // Create the database and its sidecars owner-only before SQLite does it with the process umask.
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      closeSync(openSync(file, "a", 0o600));
      chmodSync(file, 0o600);
    }
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (
        cmdId TEXT PRIMARY KEY,
        cmdSeq INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL,
        key TEXT,
        epoch INTEGER NOT NULL,
        state TEXT NOT NULL,
        result TEXT,
        at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // A state file from before proto 3 has no result_json; add it nullable so its rows keep loading.
    const columns = this.db.query("PRAGMA table_info(commands)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "result_json")) this.db.exec("ALTER TABLE commands ADD COLUMN result_json TEXT");
  }

  private meta(name: string): number {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(name) as { value: number } | null;
    return row?.value ?? 0;
  }

  /** Commits `gen = gen + 1` and returns the new gen. Called once per process start, before connecting. */
  boot(): number {
    return this.db.transaction(() => {
      const next = this.meta("gen") + 1;
      this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('gen', ?)").run(next);
      return next;
    }).immediate();
  }

  /** The current gen (0 before the first boot). */
  gen(): number {
    return this.meta("gen");
  }

  maxEpoch(): number {
    return this.meta("maxEpoch");
  }

  /** Durably raises `maxEpoch` to `epoch` when higher; returns the resulting maxEpoch. */
  observeEpoch(epoch: number): number {
    return this.db.transaction(() => {
      const current = this.meta("maxEpoch");
      if (epoch <= current) return current;
      this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('maxEpoch', ?)").run(epoch);
      return epoch;
    }).immediate();
  }

  /** Whether a command stamped `epoch` is fenced off (`epoch < maxEpoch`). */
  isStale(epoch: number): boolean {
    return epoch < this.maxEpoch();
  }

  /** Commits the intent row. `existing` when that cmdId is already recorded: the command is not run again. */
  recordIntent(intent: CommandIntent): { readonly fresh: true } | { readonly fresh: false; readonly existing: CommandRecord } {
    return this.db.transaction(() => {
      const existing = this.command(intent.cmdId);
      if (existing) return { fresh: false as const, existing };
      const at = this.now();
      this.db
        .query("INSERT INTO commands (cmdId, cmdSeq, type, key, epoch, state, result, at, updated_at) VALUES (?, ?, ?, ?, ?, 'intent', NULL, ?, ?)")
        .run(intent.cmdId, intent.cmdSeq, intent.type, intent.key ?? null, intent.epoch, at, at);
      return { fresh: true as const };
    }).immediate();
  }

  /** Commits the final state, the detail and (optionally) the structured result of a recorded command. */
  recordResult(cmdId: string, state: CommandOutcome, result: string, value?: JsonValue): void {
    const changes = this.db
      .query("UPDATE commands SET state = ?, result = ?, result_json = ?, updated_at = ? WHERE cmdId = ?")
      .run(state, result, value === undefined ? null : JSON.stringify(value), this.now(), cmdId).changes;
    if (changes === 0) throw new Error(`RUNNER_STATE no intent recorded for ${cmdId}`);
  }

  command(cmdId: string): CommandRecord | undefined {
    const row = this.db.query(`SELECT ${COLUMNS} FROM commands WHERE cmdId = ?`).get(cmdId) as CommandRow | null;
    return row ? toRecord(row) : undefined;
  }

  /** Rows still in `intent`: after a restart they are judged by observation, never re-run. */
  pendingIntents(): CommandRecord[] {
    const rows = this.db.query(`SELECT ${COLUMNS} FROM commands WHERE state = 'intent' ORDER BY cmdSeq`).all() as CommandRow[];
    return rows.map(toRecord);
  }

  /** Max contiguous cmdSeq with a final row (0 when none). */
  cmdAck(): number {
    // `ackFloor` covers rows already pruned, which were all final and contiguous at the time.
    let ack = this.meta("ackFloor");
    const rows = this.db
      .query("SELECT cmdSeq FROM commands WHERE cmdSeq > ? AND state != 'intent' ORDER BY cmdSeq")
      .all(ack) as { cmdSeq: number }[];
    for (const { cmdSeq } of rows) {
      if (cmdSeq !== ack + 1) break;
      ack = cmdSeq;
    }
    return ack;
  }

  /** Deletes final rows last updated before `cutoff`; returns how many went. */
  pruneCommands(cutoff: number): number {
    return this.db.transaction(() => {
      // Remember the cursor first so deleting old rows can never lower it.
      this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('ackFloor', ?)").run(this.cmdAck());
      return this.db.query("DELETE FROM commands WHERE state != 'intent' AND updated_at < ?").run(cutoff).changes;
    }).immediate();
  }

  close(): void {
    this.db.close();
  }
}
