import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { redactSecrets } from "./redact.ts";
import type { Lane } from "./registry.ts";
import { RETENTION, SQLITE_FILE, StoreError, storeFile } from "./store.ts";
import type { ReportKind } from "./runner/report-kinds.ts";
import type { LaneFileReceipt } from "./runner/protocol.ts";

/**
 * Where a routed row went: the lead's journal, the lane's thread, a done claim, a late notice in the journal (its lane
 * was closed or gone), an owner decision thread (`decision`: a question with choices), or nowhere (`dropped`: rows
 * written before late notices existed).
 */
export type ReportRoute = "journal" | "thread" | "claim" | "dropped" | "late" | "decision";

export type LaneReport = {
  readonly fileReceipt?: LaneFileReceipt;
  /** `<lane>:<generation>:<seq>`. */
  readonly id: string;
  readonly lane: string;
  /** The lane's ownership generation (design 4.2); 0 until ownership fencing lands. */
  readonly generation: number;
  /** 1, 2, 3, ... per lane, in the order the rows were written. */
  readonly seq: number;
  readonly kind: ReportKind;
  readonly text: string;
  readonly evidence?: string;
  readonly at: number;
  readonly consumedAt?: number;
  readonly route?: ReportRoute;
  /** The journal event the routed row became: `lane-report:<id>`, `lane-report-late:<id>`, or the claim's `done-claim:<key>:<at>`. */
  readonly eventId?: string;
  /** Where the row came from when it was not written here, e.g. a runner's event `runner:<label>:<seq>`; one row per source. */
  readonly source?: string;
};

export type NewReport = Pick<LaneReport, "lane" | "generation" | "kind" | "text" | "evidence" | "at" | "source" | "fileReceipt">;

/** A row written without an ownership generation (older dori, or a writer that does not fence): never fenced. */
export const UNFENCED_GENERATION = 0;

/**
 * The lane's ownership generation: the time recovery last relaunched it into a new pane (0 before any relaunch). A row
 * stamped with an older non-zero generation was written by a replaced session and is routed late, never as the lane.
 */
export const laneGeneration = (lane: Lane): number => lane.lastRecoveryAt ?? UNFENCED_GENERATION;

export interface LaneReportStore {
  /** Writes `report` with the lane's next seq, durably, and returns the stored row. */
  append(report: NewReport): LaneReport;
  /** Rows not yet routed, oldest first (by time, then lane and seq). */
  pending(): LaneReport[];
  list(filter?: { readonly lane?: string }): LaneReport[];
  consume(id: string, at: number, route: ReportRoute, eventId?: string): void;
  /** Removes old consumed history, keeping each lane's latest row for status and its next sequence number. */
  prune(now: number): void;
  close(): void;
}

/** The retired json store's lane reports, converted once into the `lane_reports` table (store-import.ts). */
export const LANE_REPORTS_FILE = "lane-reports.json";
/** Held while lane-reports.json was written by the json store; the conversion holds it so no row lands between its copy and the file's retirement. */
export const LANE_REPORTS_LOCK = "lane-reports.lock.sqlite";

/** The order lane reports list in: by time, lane, then seq. */
export const reportOrder = (a: LaneReport, b: LaneReport): number => a.at - b.at || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0) || a.seq - b.seq;
const withId = (report: NewReport, seq: number): LaneReport => ({
  id: `${report.lane}:${report.generation}:${seq}`, lane: report.lane, generation: report.generation, seq, kind: report.kind,
  text: redactSecrets(report.text), ...(report.evidence ? { evidence: redactSecrets(report.evidence) } : {}), at: report.at,
  ...(report.source ? { source: report.source } : {}),
  ...(report.fileReceipt ? { fileReceipt: report.fileReceipt } : {}),
});

/** Created on first use like the lane_messages table, not by a schema migration. */
const DDL = `CREATE TABLE IF NOT EXISTS lane_reports (
  id TEXT PRIMARY KEY, lane TEXT NOT NULL, generation INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  evidence TEXT, at INTEGER NOT NULL, consumed_at INTEGER, route TEXT, event_id TEXT, source TEXT, UNIQUE (lane, seq));
CREATE INDEX IF NOT EXISTS lane_reports_pending ON lane_reports (consumed_at, at);`;

/** Creates the table, and adds event_id and source to a table made before they existed (older rows read them as unset). */
const ensureSchema = (db: Database): void => {
  db.exec(DDL);
  const columns = db.query("PRAGMA table_info(lane_reports)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "event_id")) db.exec("ALTER TABLE lane_reports ADD COLUMN event_id TEXT");
  if (!columns.some((c) => c.name === "source")) db.exec("ALTER TABLE lane_reports ADD COLUMN source TEXT");
  if (!columns.some((c) => c.name === "file_receipt")) db.exec("ALTER TABLE lane_reports ADD COLUMN file_receipt TEXT");
};

type Row = { id: string; lane: string; generation: number; seq: number; kind: string; text: string; evidence: string | null; at: number; consumed_at: number | null; route: string | null; event_id?: string | null; source?: string | null; file_receipt?: string | null };
const reportOf = (row: Row): LaneReport => ({
  id: row.id, lane: row.lane, generation: row.generation, seq: row.seq, kind: row.kind as ReportKind, text: row.text,
  ...(row.evidence !== null ? { evidence: row.evidence } : {}), at: row.at,
  ...(row.consumed_at !== null ? { consumedAt: row.consumed_at } : {}), ...(row.route !== null ? { route: row.route as ReportRoute } : {}),
  ...(row.event_id != null ? { eventId: row.event_id } : {}),
  ...(row.source != null ? { source: row.source } : {}),
  ...(row.file_receipt != null ? { fileReceipt: JSON.parse(row.file_receipt) as LaneFileReceipt } : {}),
});

/** Every row of `db`'s lane_reports table, as stored and in list() order; no table reads as no rows (the json conversion's read-back). */
export const readReportRows = (db: Database): LaneReport[] =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lane_reports'").get()
    ? (db.query("SELECT * FROM lane_reports ORDER BY at, lane, seq").all() as Row[]).map(reportOf)
    : [];

/** Inserts `rows` with every column kept (id, seq, consumed_at, route), for the json conversion; an id already there throws. */
export const putReportRows = (db: Database, rows: readonly LaneReport[]): void => {
  ensureSchema(db);
  const insert = db.query("INSERT INTO lane_reports (id, lane, generation, seq, kind, text, evidence, at, consumed_at, route, event_id, source, file_receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) insert.run(r.id, r.lane, r.generation, r.seq, r.kind, r.text, r.evidence ?? null, r.at, r.consumedAt ?? null, r.route ?? null, r.eventId ?? null, r.source ?? null, r.fileReceipt ? JSON.stringify(r.fileReceipt) : null);
};

/** The `lane_reports` table of supervisor.sqlite, on its own connection (WAL: the supervisor's connection keeps writing). */
export class SqliteLaneReports implements LaneReportStore {
  private readonly db: Database;
  constructor(path: string) {
    if (!existsSync(path)) throw new StoreError(`STORE_MISSING ${path}; lane reports live in the sqlite store`);
    this.db = new Database(path, { strict: true });
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA synchronous = FULL");
      ensureSchema(this.db);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  append(report: NewReport): LaneReport {
    // IMMEDIATE: two lanes (or two reports of one lane) never read the same max seq.
    return this.db.transaction(() => {
      if (report.source) {
        const known = this.db.query("SELECT * FROM lane_reports WHERE source = ?").get(report.source) as Row | null;
        if (known) return reportOf(known);
      }
      const max = this.db.query("SELECT max(seq) AS seq FROM lane_reports WHERE lane = ?").get(report.lane) as { seq: number | null };
      const row = withId(report, (max.seq ?? 0) + 1);
      this.db.query("INSERT INTO lane_reports (id, lane, generation, seq, kind, text, evidence, at, source, file_receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.lane, row.generation, row.seq, row.kind, row.text, row.evidence ?? null, row.at, row.source ?? null, row.fileReceipt ? JSON.stringify(row.fileReceipt) : null);
      return row;
    }).immediate();
  }
  pending(): LaneReport[] {
    return (this.db.query("SELECT * FROM lane_reports WHERE consumed_at IS NULL ORDER BY at, lane, seq").all() as Row[]).map(reportOf);
  }
  list(filter: { readonly lane?: string } = {}): LaneReport[] {
    const rows = filter.lane === undefined
      ? this.db.query("SELECT * FROM lane_reports ORDER BY at, lane, seq").all() as Row[]
      : this.db.query("SELECT * FROM lane_reports WHERE lane = ? ORDER BY at, seq").all(filter.lane) as Row[];
    return rows.map(reportOf);
  }
  consume(id: string, at: number, route: ReportRoute, eventId?: string): void {
    this.db.query("UPDATE lane_reports SET consumed_at = ?, route = ?, event_id = ? WHERE id = ? AND consumed_at IS NULL").run(at, route, eventId ?? null, id);
  }
  prune(now: number): void {
    this.db.query(`DELETE FROM lane_reports WHERE consumed_at < ?
      AND seq < (SELECT max(latest.seq) FROM lane_reports latest WHERE latest.lane = lane_reports.lane)`)
      .run(now - RETENTION.statusHistoryMs);
  }
  close(): void { this.db.close(); }
}

/**
 * Each lane's latest row (highest seq), read-only for `dori status`: the lane_reports table opened read-only (never the
 * DDL a store connection runs). No database, no table or an unreadable one reads as no rows.
 */
export const latestLaneReports = (config: { readonly stateDir: string }): Map<string, LaneReport> => {
  let rows: LaneReport[] = [];
  try {
    if (existsSync(join(config.stateDir, SQLITE_FILE))) {
      const db = new Database(join(config.stateDir, SQLITE_FILE), { readonly: true });
      try {
        rows = (db.query("SELECT r.* FROM lane_reports r JOIN (SELECT lane, max(seq) AS seq FROM lane_reports GROUP BY lane) m ON r.lane = m.lane AND r.seq = m.seq").all() as Row[]).map(reportOf);
      } finally { db.close(); }
    }
  } catch { /* no reports yet */ }
  const latest = new Map<string, LaneReport>();
  for (const row of rows) if ((latest.get(row.lane)?.seq ?? 0) < row.seq) latest.set(row.lane, row);
  return latest;
};

export const openLaneReports = (config: { readonly stateDir: string }): LaneReportStore => new SqliteLaneReports(storeFile(config.stateDir));

/**
 * The synthetic `blocked` row of a lane whose pane died (dead-panes.ts): the lane stopped without reporting, so its
 * result is a row under its key like any report. Written once per (lane, pane): a row with the same text is kept.
 * Returns the row id, or undefined when that row already exists.
 */
export const appendDeadPaneReport = (config: { readonly stateDir: string }, lane: Lane, pane: string, at: number): string | undefined => {
  const text = `pane ${pane} stopped (a dead marker held on its screen) and the lane wrote no report; recovery may relaunch it, else the lead decides`;
  const store = openLaneReports(config);
  try {
    if (store.list({ lane: lane.key }).some((r) => r.kind === "blocked" && r.text === text)) return undefined;
    return store.append({ lane: lane.key, generation: laneGeneration(lane), kind: "blocked", text, at }).id;
  } finally { store.close(); }
};

