import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../setup.ts";
import type { BodyRef, RunnerEventBodies, RunnerEventType } from "./protocol.ts";

/**
 * The runner outbox (`<runnerDir>/outbox.sqlite`, WAL): every runner event is appended here before it is sent, with
 * a durable per-runner `seq` that never repeats, not even after pruning. A text field over `OUTBOX_INLINE_MAX` bytes
 * (`lane.report.text`, `job.result.output`) is moved to `<runnerDir>/bodies/<seq>.body` and the row keeps the path
 * and sha256; a text over `OUTBOX_BODY_CAP` is cut there and ends with `TRUNCATION_MARKER`. The database, its WAL and
 * shm files and every body file are 0600. Acked rows (and their body files) are deleted `OUTBOX_ACKED_RETENTION_MS`
 * after their ack.
 */

const HOUR_MS = 60 * 60_000;
export const OUTBOX_FILE = "outbox.sqlite";
export const OUTBOX_BODIES_DIR = "bodies";
export const OUTBOX_INLINE_MAX = 8 * 1024;
export const OUTBOX_BODY_CAP = 256 * 1024;
export const TRUNCATION_MARKER = "\n[truncated by the runner outbox]";
export const OUTBOX_ACKED_RETENTION_MS = 7 * 24 * HOUR_MS;
export const OUTBOX_LARGE_ROWS = 100_000;
export const OUTBOX_LARGE_AGE_MS = 24 * HOUR_MS;

/** A stored event, rehydrated: a moved text is read back from its body file, and `bodyRef` describes it. */
export type OutboxRow<T extends RunnerEventType = RunnerEventType> = {
  readonly seq: number;
  readonly type: T;
  readonly body: RunnerEventBodies[T];
  /** Wall-clock time of the append. */
  readonly at: number;
  readonly ackedAt?: number;
};

export type OutboxStats = { readonly unacked: number; readonly oldestUnackedAt?: number; readonly lastSeq: number };

/** Why the outbox is large: more than `OUTBOX_LARGE_ROWS` unacked rows, or the oldest older than `OUTBOX_LARGE_AGE_MS`. */
export type OutboxLarge = { readonly unacked: number; readonly oldestAgeMs: number };

/** `largeRows` and `largeAgeMs` override the `RUNNER_OUTBOX_LARGE` thresholds (tests keep them small). */
export type OutboxOptions = {
  readonly now: () => number;
  readonly largeRows?: number;
  readonly largeAgeMs?: number;
};

/** The one text field per event type that may be moved to a body file. */
const TEXT_FIELD: Partial<Record<RunnerEventType, string>> = { "lane.report": "text", "job.result": "output" };

type Row = {
  seq: number; type: string; body: string; at: number; acked_at: number | null;
  body_path: string | null; body_sha: string | null; body_bytes: number | null; body_cut: number | null;
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Cuts `text` to at most `OUTBOX_BODY_CAP` bytes on a character boundary and appends the marker. */
const capText = (text: string): { text: string; truncated: boolean } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= OUTBOX_BODY_CAP) return { text, truncated: false };
  let end = OUTBOX_BODY_CAP;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8") + TRUNCATION_MARKER, truncated: true };
};

export class Outbox {
  private readonly db: Database;
  private readonly bodiesDir: string;
  private readonly now: () => number;
  private readonly largeRows: number;
  private readonly largeAgeMs: number;

  /** Opens or creates `<runnerDir>/outbox.sqlite` and `<runnerDir>/bodies/`; the caller has checked the directory. */
  constructor(readonly runnerDir: string, options: OutboxOptions) {
    this.now = options.now;
    this.largeRows = options.largeRows ?? OUTBOX_LARGE_ROWS;
    this.largeAgeMs = options.largeAgeMs ?? OUTBOX_LARGE_AGE_MS;
    this.bodiesDir = join(runnerDir, OUTBOX_BODIES_DIR);
    mkdirSync(this.bodiesDir, { recursive: true, mode: 0o700 });
    const path = join(runnerDir, OUTBOX_FILE);
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = FULL");
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY, type TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, acked_at INTEGER,
      body_path TEXT, body_sha TEXT, body_bytes INTEGER, body_cut INTEGER)`);
    this.db.run("CREATE INDEX IF NOT EXISTS events_acked ON events (acked_at)");
    this.db.run("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    this.db.run("INSERT OR IGNORE INTO meta (k, v) VALUES ('next_seq', 1)");
    this.lockDown();
  }

  /** Durably appends one event and returns its row; `seq` is one more than the highest ever appended. */
  append<T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]): OutboxRow<T> {
    const at = this.now();
    const field = TEXT_FIELD[type];
    const text = field ? (body as Record<string, unknown>)[field] : undefined;
    const move = typeof text === "string" && Buffer.byteLength(text, "utf8") > OUTBOX_INLINE_MAX;
    let seq = 0;
    let bodyPath: string | null = null;
    let ref: BodyRef | undefined;
    this.db.transaction(() => {
      seq = (this.db.query("SELECT v FROM meta WHERE k = 'next_seq'").get() as { v: number }).v;
      let stored: unknown = body;
      if (move && field) {
        const capped = capText(text as string);
        bodyPath = join(this.bodiesDir, `${seq}.body`);
        writeFileAtomic(bodyPath, capped.text, 0o600);
        ref = bodyRefFor(capped.text, capped.truncated);
        stored = { ...(body as object), [field]: "" };
      }
      this.db.query(
        "INSERT INTO events (seq, type, body, at, body_path, body_sha, body_bytes, body_cut) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(seq, type, JSON.stringify(stored), at, bodyPath, ref?.sha256 ?? null, ref?.bytes ?? null, ref ? (ref.truncated ? 1 : 0) : null);
      this.db.query("UPDATE meta SET v = ? WHERE k = 'next_seq'").run(seq + 1);
    }).immediate();
    this.lockDown();
    return this.hydrate(this.db.query("SELECT * FROM events WHERE seq = ?").get(seq) as Row) as OutboxRow<T>;
  }

  /** Every row with `seq > since` that is not acked, ascending by seq: the replay after a hello. */
  unacked(since: number): OutboxRow[] {
    const rows = this.db.query("SELECT * FROM events WHERE seq > ? AND acked_at IS NULL ORDER BY seq").all(since) as Row[];
    return rows.map((row) => this.hydrate(row));
  }

  /** Marks every row with `seq <= upTo` acked (at `now()`); returns how many changed. A lower `upTo` than before is a no-op. */
  ack(upTo: number): number {
    return this.db.query("UPDATE events SET acked_at = ? WHERE seq <= ? AND acked_at IS NULL").run(this.now(), upTo).changes;
  }

  /** Deletes rows acked before `now - OUTBOX_ACKED_RETENTION_MS` and their body files; returns how many went. */
  prune(now: number): number {
    const cutoff = now - OUTBOX_ACKED_RETENTION_MS;
    const old = this.db.query("SELECT seq, body_path FROM events WHERE acked_at IS NOT NULL AND acked_at < ?").all(cutoff) as
      { seq: number; body_path: string | null }[];
    for (const row of old) if (row.body_path) rmSync(row.body_path, { force: true });
    return this.db.query("DELETE FROM events WHERE acked_at IS NOT NULL AND acked_at < ?").run(cutoff).changes;
  }

  stats(): OutboxStats {
    const agg = this.db.query("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM events WHERE acked_at IS NULL").get() as
      { n: number; oldest: number | null };
    const next = (this.db.query("SELECT v FROM meta WHERE k = 'next_seq'").get() as { v: number }).v;
    return { unacked: agg.n, ...(agg.oldest === null ? {} : { oldestUnackedAt: agg.oldest }), lastSeq: next - 1 };
  }

  /** The `RUNNER_OUTBOX_LARGE` condition at `now`, or undefined when the outbox is within bounds. */
  large(now: number): OutboxLarge | undefined {
    const { unacked, oldestUnackedAt } = this.stats();
    const oldestAgeMs = oldestUnackedAt === undefined ? 0 : Math.max(0, now - oldestUnackedAt);
    return unacked > this.largeRows || oldestAgeMs > this.largeAgeMs ? { unacked, oldestAgeMs } : undefined;
  }

  close(): void {
    this.db.close();
  }

  private hydrate(row: Row): OutboxRow {
    let body = JSON.parse(row.body) as Record<string, unknown>;
    if (row.body_path) {
      const field = TEXT_FIELD[row.type as RunnerEventType]!;
      body = { ...body, [field]: readFileSync(row.body_path, "utf8") };
      if (row.type === "lane.report") body.bodyRef = { sha256: row.body_sha!, bytes: row.body_bytes!, truncated: row.body_cut === 1 };
    }
    return {
      seq: row.seq, type: row.type as RunnerEventType, body: body as never, at: row.at,
      ...(row.acked_at === null ? {} : { ackedAt: row.acked_at }),
    };
  }

  /** SQLite creates the WAL and shm files lazily; make sure every database file is owner-only. */
  private lockDown(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(this.runnerDir, OUTBOX_FILE + suffix);
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }
}

/** The body reference a moved or cut text carries: sha256 of the stored text, its byte size, whether it was cut. */
export const bodyRefFor = (text: string, truncated: boolean): BodyRef => ({
  sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8"), truncated,
});

/** `RUNNER_OUTBOX_LARGE unacked=<n> oldestAgeMs=<n>` */
export const outboxLargeLine = (large: OutboxLarge): string =>
  `RUNNER_OUTBOX_LARGE unacked=${large.unacked} oldestAgeMs=${large.oldestAgeMs}`;
