import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../setup.ts";
import { MAX_FRAME_BYTES, type BodyRef, type RunnerEventBodies, type RunnerEventType } from "./protocol.ts";

/**
 * The runner outbox (`<runnerDir>/outbox.sqlite`, WAL): every runner event is appended here before it is sent, with
 * a durable per-runner `seq` that never repeats, not even after pruning. A text field over `OUTBOX_INLINE_MAX` bytes
 * (`lane.report.text`, `job.result.output`) is moved to `<runnerDir>/bodies/<seq>.body` and the row keeps the path
 * and sha256; a text over `OUTBOX_BODY_CAP` is cut there and ends with `TRUNCATION_MARKER`. The database, its WAL and
 * shm files and every body file are 0600. Acked rows (and their body files) are deleted `OUTBOX_ACKED_RETENTION_MS`
 * after their ack.
 *
 * Every event must fit in one frame once it is read back: before an event gets its seq, its longest strings are cut
 * (each ending with `TRUNCATION_MARKER`) until its JSON fits `OUTBOX_EVENT_MAX`, and a row stored before that rule
 * existed is cut the same way when it is read back. A replay therefore never stops at a row the wire cannot carry.
 * An event that still does not fit after every string is cut is refused with `OutboxEventTooLarge` and gets no seq.
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
/** Room a frame keeps for its envelope, the session MAC and a body reference. */
export const FRAME_HEADROOM = 64 * 1024;
/** The largest JSON size of an event body, as read back. */
export const OUTBOX_EVENT_MAX = MAX_FRAME_BYTES - FRAME_HEADROOM;

/** An event whose body cannot be cut to fit `OUTBOX_EVENT_MAX` (it is large without long strings). */
export class OutboxEventTooLarge extends Error {
  constructor(readonly type: string, readonly bytes: number) {
    super(`${type} body is ${bytes} bytes after cutting its strings, over ${OUTBOX_EVENT_MAX}`);
  }
}

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

const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** `text` cut to `chars` UTF-16 units without leaving half a surrogate pair. */
const sliceChars = (text: string, chars: number): string => {
  let end = Math.max(0, chars);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
};

/**
 * `body` with its longest strings cut (each ending with `TRUNCATION_MARKER`) until its JSON is at most `max` bytes;
 * `cut` says whether anything was cut. Undefined when cutting every string is not enough.
 */
export const fitEventBody = <B>(body: B, max: number = OUTBOX_EVENT_MAX): { readonly body: B; readonly cut: boolean } | undefined => {
  let size = encodedBytes(body);
  if (size <= max) return { body, cut: false };
  const copy = JSON.parse(JSON.stringify(body)) as unknown;
  type Leaf = { readonly get: () => string; readonly set: (text: string) => void };
  const leaves: Leaf[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => { if (typeof child === "string") leaves.push({ get: () => node[i] as string, set: (t) => { node[i] = t; } }); else walk(child); });
    } else if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (typeof record[key] === "string") leaves.push({ get: () => record[key] as string, set: (t) => { record[key] = t; } });
        else walk(record[key]);
      }
    }
  };
  walk(copy);
  const markerBytes = encodedBytes(TRUNCATION_MARKER);
  while (size > max) {
    let longest: Leaf | undefined;
    let longestBytes = 0;
    for (const leaf of leaves) {
      const bytes = encodedBytes(leaf.get());
      if (bytes > longestBytes) { longest = leaf; longestBytes = bytes; }
    }
    const current = longest?.get() ?? "";
    const base = current.endsWith(TRUNCATION_MARKER) ? current.slice(0, -TRUNCATION_MARKER.length) : current;
    if (!longest || base.length === 0) return undefined;
    // Keep the share of the string that fits once the excess and the marker are taken out, and always cut something.
    const keepBytes = Math.max(0, longestBytes - (size - max) - markerBytes);
    const keep = Math.min(base.length - 1, Math.floor(base.length * (keepBytes / longestBytes)));
    longest.set(sliceChars(base, keep) + TRUNCATION_MARKER);
    size = encodedBytes(copy);
  }
  return { body: copy as B, cut: true };
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

  /**
   * Durably appends one event and returns its row; `seq` is one more than the highest ever appended. Throws
   * `OutboxEventTooLarge`, appending nothing, when the body cannot be cut to fit a frame.
   */
  append<T extends RunnerEventType>(type: T, body: RunnerEventBodies[T]): OutboxRow<T> {
    const at = this.now();
    const field = TEXT_FIELD[type];
    let input = body as Record<string, unknown>;
    let truncated = false;
    const original = field ? input[field] : undefined;
    if (field && typeof original === "string") {
      const capped = capText(original);
      if (capped.truncated) { input = { ...input, [field]: capped.text }; truncated = true; }
    }
    const fitted = fitEventBody(input);
    if (!fitted) throw new OutboxEventTooLarge(type, encodedBytes(input));
    if (fitted.cut && field && fitted.body[field] !== input[field]) truncated = true;
    input = fitted.body;
    const text = field ? input[field] : undefined;
    const move = typeof text === "string" && Buffer.byteLength(text, "utf8") > OUTBOX_INLINE_MAX;
    let seq = 0;
    let bodyPath: string | null = null;
    let ref: BodyRef | undefined;
    this.db.transaction(() => {
      seq = (this.db.query("SELECT v FROM meta WHERE k = 'next_seq'").get() as { v: number }).v;
      let stored: unknown = input;
      if (move && field) {
        bodyPath = join(this.bodiesDir, `${seq}.body`);
        writeFileAtomic(bodyPath, text as string, 0o600);
        ref = bodyRefFor(text as string, truncated);
        stored = { ...input, [field]: "" };
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
    // A row stored before every event was fitted at append is cut here, so its replay still fits a frame.
    const fitted = fitEventBody(body);
    if (fitted?.cut) body = fitted.body;
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

/** How often the serve loop runs `outboxMaintenance`. */
export const OUTBOX_MAINTENANCE_MS = HOUR_MS;

/**
 * One outbox upkeep pass, for the serve loop to run at start and every `OUTBOX_MAINTENANCE_MS`: prunes acked rows past
 * retention (`RUNNER_OUTBOX_PRUNED <n>`), logs `RUNNER_OUTBOX_LARGE ...` once when the outbox becomes large and
 * `RUNNER_OUTBOX_OK unacked=<n>` once when it is back within bounds. A failing pass logs
 * `RUNNER_OUTBOX_MAINTENANCE_FAILED <error>` and leaves the next pass to try again.
 */
export const outboxMaintenance = (outbox: Outbox, now: () => number, log: (line: string) => void): (() => void) => {
  let wasLarge = false;
  return () => {
    try {
      const pruned = outbox.prune(now());
      if (pruned > 0) log(`RUNNER_OUTBOX_PRUNED ${pruned} acked rows past retention`);
      const large = outbox.large(now());
      if (large && !wasLarge) log(outboxLargeLine(large));
      if (!large && wasLarge) log(`RUNNER_OUTBOX_OK unacked=${outbox.stats().unacked}`);
      wasLarge = large !== undefined;
    } catch (error) {
      log(`RUNNER_OUTBOX_MAINTENANCE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  };
};
