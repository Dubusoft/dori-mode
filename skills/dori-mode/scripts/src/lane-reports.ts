import { createHash } from "node:crypto";
import { redactSecrets } from "./redact.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { fillHook } from "./config.ts";
import { claimDone, type Emit, type FlowDeps, laneMeta, REMOTE_SEEN_MAX } from "./done-flow.ts";
import { relayedText, scrubForThread } from "./freshness.ts";
import { Discord } from "./messenger/discord.ts";
import { fetchHttp } from "./messenger/http.ts";
import { resolveTarget } from "./messenger/target.ts";
import { readScreen } from "./panes.ts";
import type { Clock } from "./run.ts";
import { type Lane, statusOf } from "./registry.ts";
import { withStateLockSync } from "./state-lock.ts";
import type { EventMeta } from "./supervise-journal.ts";
import { saveJsonFile, SQLITE_FILE, StoreError, type StoreKind } from "./store.ts";
import { REPORT_KINDS, isReportKind, type ReportKind } from "./runner/report-kinds.ts";
export { REPORT_KINDS, isReportKind, type ReportKind } from "./runner/report-kinds.ts";

/**
 * Structured lane reports (design 3.3): `dori report <key> <kind> --text T [--evidence E]` writes one
 * row, and the supervisor routes each row once and marks it consumed. Nothing is typed into the lead's pane.
 */
/**
 * Where a routed row went: the lead's journal, the lane's thread, a done claim, a late notice in the journal (its lane
 * was closed or gone), or nowhere (`dropped`: rows written before late notices existed).
 */
export type ReportRoute = "journal" | "thread" | "claim" | "dropped" | "late";

export type LaneReport = {
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

export type NewReport = Pick<LaneReport, "lane" | "generation" | "kind" | "text" | "evidence" | "at" | "source">;

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
  close(): void;
}

export const LANE_REPORTS_FILE = "lane-reports.json";
/** Held while lane-reports.json is written; `dori store import` holds it so no row lands between its copy and the file's retirement. */
export const LANE_REPORTS_LOCK = "lane-reports.lock.sqlite";

const order = (a: LaneReport, b: LaneReport): number => a.at - b.at || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0) || a.seq - b.seq;
const withId = (report: NewReport, seq: number): LaneReport => ({
  id: `${report.lane}:${report.generation}:${seq}`, lane: report.lane, generation: report.generation, seq, kind: report.kind,
  text: redactSecrets(report.text), ...(report.evidence ? { evidence: redactSecrets(report.evidence) } : {}), at: report.at,
  ...(report.source ? { source: report.source } : {}),
});

/** `lane-reports.json` beside supervisor.json, rewritten whole under a short state lock (lanes and the supervisor both write). */
export class JsonLaneReports implements LaneReportStore {
  private readonly path: string;
  private readonly lock: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, LANE_REPORTS_FILE);
    this.lock = join(stateDir, LANE_REPORTS_LOCK);
  }
  private read(): LaneReport[] {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as { reports: LaneReport[] }).reports : [];
  }
  append(report: NewReport): LaneReport {
    return withStateLockSync(this.lock, () => {
      const reports = this.read();
      const known = report.source ? reports.find((r) => r.source === report.source) : undefined;
      if (known) return known;
      const seq = reports.reduce((max, r) => (r.lane === report.lane ? Math.max(max, r.seq) : max), 0) + 1;
      const row = withId(report, seq);
      saveJsonFile(this.path, { reports: [...reports, row] });
      return row;
    });
  }
  pending(): LaneReport[] { return this.read().filter((r) => r.consumedAt === undefined).sort(order); }
  list(filter: { readonly lane?: string } = {}): LaneReport[] {
    return this.read().filter((r) => filter.lane === undefined || r.lane === filter.lane).sort(order);
  }
  consume(id: string, at: number, route: ReportRoute, eventId?: string): void {
    withStateLockSync(this.lock, () => {
      saveJsonFile(this.path, { reports: this.read().map((r) => (r.id === id && r.consumedAt === undefined ? { ...r, consumedAt: at, route, ...(eventId ? { eventId } : {}) } : r)) });
    });
  }
  close(): void {}
}

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
};

type Row = { id: string; lane: string; generation: number; seq: number; kind: string; text: string; evidence: string | null; at: number; consumed_at: number | null; route: string | null; event_id?: string | null; source?: string | null };
const reportOf = (row: Row): LaneReport => ({
  id: row.id, lane: row.lane, generation: row.generation, seq: row.seq, kind: row.kind as ReportKind, text: row.text,
  ...(row.evidence !== null ? { evidence: row.evidence } : {}), at: row.at,
  ...(row.consumed_at !== null ? { consumedAt: row.consumed_at } : {}), ...(row.route !== null ? { route: row.route as ReportRoute } : {}),
  ...(row.event_id != null ? { eventId: row.event_id } : {}),
  ...(row.source != null ? { source: row.source } : {}),
});

/** Every row of `db`'s lane_reports table, as stored and in list() order; no table reads as no rows (`dori store export`). */
export const readReportRows = (db: Database): LaneReport[] =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lane_reports'").get()
    ? (db.query("SELECT * FROM lane_reports ORDER BY at, lane, seq").all() as Row[]).map(reportOf)
    : [];

/** Inserts `rows` with every column kept (id, seq, consumed_at, route), for `dori store import`; an id already there throws. */
export const putReportRows = (db: Database, rows: readonly LaneReport[]): void => {
  ensureSchema(db);
  const insert = db.query("INSERT INTO lane_reports (id, lane, generation, seq, kind, text, evidence, at, consumed_at, route, event_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) insert.run(r.id, r.lane, r.generation, r.seq, r.kind, r.text, r.evidence ?? null, r.at, r.consumedAt ?? null, r.route ?? null, r.eventId ?? null, r.source ?? null);
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
      this.db.query("INSERT INTO lane_reports (id, lane, generation, seq, kind, text, evidence, at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.lane, row.generation, row.seq, row.kind, row.text, row.evidence ?? null, row.at, row.source ?? null);
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
  close(): void { this.db.close(); }
}

/**
 * Each lane's latest row (highest seq), read-only for `dori status`: lane-reports.json, or the lane_reports table opened
 * read-only (never the DDL a store connection runs). No file, no table or an unreadable one reads as no rows.
 */
export const latestLaneReports = (config: { readonly stateDir: string; readonly store: StoreKind }): Map<string, LaneReport> => {
  let rows: LaneReport[] = [];
  try {
    if (config.store === "json") rows = new JsonLaneReports(config.stateDir).list();
    else if (existsSync(join(config.stateDir, SQLITE_FILE))) {
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

export const openLaneReports = (config: { readonly stateDir: string; readonly store: StoreKind }): LaneReportStore =>
  config.store === "sqlite" ? new SqliteLaneReports(join(config.stateDir, SQLITE_FILE)) : new JsonLaneReports(config.stateDir);

/**
 * The synthetic `blocked` row of a lane whose pane died (dead-panes.ts): the lane stopped without reporting, so its
 * result is a row under its key like any report. Written once per (lane, pane): a row with the same text is kept.
 * Returns the row id, or undefined when that row already exists.
 */
export const appendDeadPaneReport = (config: { readonly stateDir: string; readonly store: StoreKind }, lane: Lane, pane: string, at: number): string | undefined => {
  const text = `pane ${pane} stopped (a dead marker held on its screen) and the lane wrote no report; recovery may relaunch it, else the lead decides`;
  const store = openLaneReports(config);
  try {
    if (store.list({ lane: lane.key }).some((r) => r.kind === "blocked" && r.text === text)) return undefined;
    return store.append({ lane: lane.key, generation: laneGeneration(lane), kind: "blocked", text, at }).id;
  } finally { store.close(); }
};

/** A report's text as one line (it lands in an event line and a thread message). */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Longest text or evidence an event carries inline; a longer one, or one of more than INLINE_REPORT_LINES lines, is saved to a file the event points at. */
export const INLINE_REPORT_MAX = 200;
export const INLINE_REPORT_LINES = 3;
/** Where full report bodies are saved, under the state directory. */
export const REPORT_BODIES_DIR = "reports";

const inline = (text: string): boolean => text.trim().split("\n").length <= INLINE_REPORT_LINES && oneLine(text).length <= INLINE_REPORT_MAX;

/**
 * Saves a row whose text or evidence is long or has many lines to `<stateDir>/reports/<row id>.txt`, as written (already
 * redacted), and returns that path; a short one-line row saves nothing and returns undefined. Rewriting is harmless.
 */
export const saveReportBody = (stateDir: string, report: LaneReport): string | undefined => {
  if (inline(report.text) && (!report.evidence || inline(report.evidence))) return undefined;
  const dir = join(stateDir, REPORT_BODIES_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${report.id.replace(/[^\w.-]/g, "_")}.txt`);
  writeFileSync(path, `lane: ${report.lane}\nkind: ${report.kind}\nreport: ${report.id}\nat: ${new Date(report.at).toISOString()}\n\n${report.text}\n${report.evidence ? `\nevidence:\n${report.evidence}\n` : ""}`);
  return path;
};

const summary = (text: string): string => { const flat = oneLine(text); return flat.length <= INLINE_REPORT_MAX ? flat : `${flat.slice(0, INLINE_REPORT_MAX)}...`; };

/**
 * The event a routed row becomes: `LANE_REPORT <key> <kind> <text>`, with ` (evidence: E)` when given. With `body` (the
 * file saveReportBody wrote) the text and evidence are cut to INLINE_REPORT_MAX and the event ends ` (full report: <path>)`.
 */
export const reportLine = (report: LaneReport, body?: string, kind = "LANE_REPORT"): string =>
  `${kind} ${report.lane} ${report.kind} ${summary(report.text)}${report.evidence ? ` (evidence: ${summary(report.evidence)})` : ""}${body ? ` (full report: ${body})` : ""}`;

/** Failed routing passes in a row after which a pending row raises one urgent event (it stays pending and is retried). */
export const POISON_ALERT_AFTER = 3;
const failures = new WeakMap<LaneReportStore, Map<string, number>>();

/** Journals one line under a stable id; the supervisor dedupes a repeat of the same id. */
export type ReportEnqueue = (id: string, line: string, meta?: EventMeta) => unknown;

/** Posts and edits a lane's status message in its thread; `post` returns the new message's id. */
export type LaneStatusTransport = {
  post(channel: string, text: string, stableId: string): Promise<string>;
  edit(channel: string, messageId: string, text: string): Promise<void>;
};

/**
 * The Discord status transport, on DORI_DISCORD_TOKEN from the process environment (the supervisor unit loads it from
 * its EnvironmentFile); undefined without a token, so progress falls back to hooks.threadReply or the lead's journal.
 */
export const discordStatusTransport = (clock: Clock, env: Readonly<Record<string, string | undefined>> = process.env): LaneStatusTransport | undefined => {
  const token = env.DORI_DISCORD_TOKEN?.trim();
  if (!token) return undefined;
  const discord = new Discord(fetchHttp, clock, token);
  return { post: (channel, text, stableId) => discord.send(channel, text, stableId), edit: (channel, id, text) => discord.edit(channel, id, text) };
};

/** Longest report text a status message line carries. */
export const STATUS_TEXT_MAX = 300;

const elapsed = (ms: number): string => {
  const min = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const stamp = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const errorText = (e: unknown): string => oneLine(e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * The text of a lane's status message as of `report`: its key, time since it opened, and its last milestone and last
 * progress (rows up to `report`, late ones left out), each with its time, scrubbed like a thread post.
 */
export const laneStatusText = (lane: Lane, rows: readonly LaneReport[], report: LaneReport, now: number, home: string): string => {
  const upTo = rows.filter((r) => r.seq <= report.seq && r.route !== "late" && (r.kind === "milestone" || r.kind === "progress"));
  const last = (kind: ReportKind): LaneReport | undefined =>
    [...upTo, ...(upTo.some((r) => r.id === report.id) ? [] : [report])].filter((r) => r.kind === kind).sort((a, b) => a.seq - b.seq).at(-1);
  const line = (label: string, row: LaneReport | undefined): string => {
    if (!row) return `${label}: none yet`;
    const text = scrubForThread(oneLine(row.text), home);
    return `${label} (${stamp(row.at)}): ${text.length <= STATUS_TEXT_MAX ? text : `${text.slice(0, STATUS_TEXT_MAX)}...`}`;
  };
  const opened = Date.parse(lane.openedAt);
  return [
    `[System] status of lane ${lane.key}, open ${Number.isNaN(opened) ? "(unknown)" : elapsed(now - opened)} (updated ${stamp(now)})`,
    line("last milestone", last("milestone")),
    line("last progress", last("progress")),
  ].join("\n");
};

/** The Discord channel id of a lane's thread, or undefined for no thread or a non-Discord one. */
const statusChannel = (lane: Lane): string | undefined =>
  lane.thread !== "none" && lane.thread.startsWith("discord:") ? resolveTarget("discord", lane.thread).to : undefined;

/**
 * Edits the lane's status message to the text as of `report`, or posts it when there is none yet or the edit fails (a
 * deleted message), and stores the new id on the lane (statusMessageId). A failed post throws.
 */
const upsertStatus = async (deps: FlowDeps, transport: LaneStatusTransport, channel: string, lane: Lane, store: LaneReportStore, report: LaneReport, home: string): Promise<void> => {
  const text = laneStatusText(lane, store.list({ lane: lane.key }), report, deps.clock.now(), home);
  if (lane.statusMessageId) {
    try {
      await transport.edit(channel, lane.statusMessageId, text);
      return;
    } catch (e) {
      console.error(`LANE_STATUS_EDIT_FAILED ${lane.key} ${lane.statusMessageId} ${errorText(e)}; posting a new status message`);
    }
  }
  const id = await transport.post(channel, text, `lane-status:${report.id}`);
  await deps.registry.patch(lane.key, { statusMessageId: id });
};

/**
 * Routes every pending row once, oldest first, and marks it consumed after its effect. question, blocked and milestone
 * become a `LANE_REPORT` event under the id `lane-report:<row id>` (its class comes from eventPolicy: question and
 * blocked wake the lead, milestone is digest by default). progress and milestone also update the lane's one `[System]`
 * status message in its thread (laneStatusText), posted the first time and edited afterwards through `transport`
 * (default: discordStatusTransport); its id lives on the lane (statusMessageId). Without a transport progress is posted
 * through hooks.threadReply as before, and without either, or a thread, or when the post fails, it is a digest
 * LANE_REPORT instead; a failed status update of a milestone is only logged (the lead has the row). done is the
 * lane's done claim, as `dori claim-done`. A row whose lane is closed or unregistered is not lost: it becomes a
 * `LANE_REPORT_LATE <key> <kind> <text>` event under `lane-report-late:<row id>` (route `late`). A crash between the
 * effect and the mark repeats the effect: the journal dedupes the event by id, and a thread post may show twice.
 * A row stamped with an older non-zero generation than its lane's (laneGeneration: a session recovery replaced) is
 * routed late too, with ` (from a replaced session)`, so it never acts as the lane. A long or multi-line row's body is
 * saved to a file and its event carries the path (reportLine). Progress posted to the thread is marked `[System]`
 * relayed (freshness.ts relayedText), so the owner never reads it as the lane speaking. The consumed row records the
 * event it became (eventId), the done claim's `done-claim:<key>:<at>` included.
 * A row whose routing throws is logged and left pending (retried next pass); the rest are still routed. After
 * POISON_ALERT_AFTER failed passes in a row it raises one urgent `LANE_REPORT <key> blocked REPORT_STUCK ...` event
 * under `lane-report-stuck:<row id>`. Returns one log line per routed row.
 */
export const routeReports = async (
  deps: FlowDeps, store: LaneReportStore, enqueue: ReportEnqueue, home = process.env.HOME ?? "",
  transport: LaneStatusTransport | null = discordStatusTransport(deps.clock) ?? null,
): Promise<string[]> => {
  const out: string[] = [];
  const failed = failures.get(store) ?? new Map<string, number>();
  failures.set(store, failed);
  for (const report of store.pending()) {
    try {
      const lane = await deps.registry.read(report.lane);
      let route: ReportRoute;
      let eventId: string | undefined;
      const stale = lane && report.generation !== UNFENCED_GENERATION && report.generation < laneGeneration(lane);
      if (!lane || statusOf(lane) === "closed" || stale) {
        eventId = `lane-report-late:${report.id}`;
        const line = reportLine(report, saveReportBody(deps.config.stateDir, report), "LANE_REPORT_LATE");
        await enqueue(eventId, stale ? `${line} (from a replaced session)` : line, lane ? laneMeta(lane) : { lane: report.lane });
        route = "late";
      } else if (report.kind === "done") {
        await claimDone(deps, lane, oneLine(report.evidence ?? report.text));
        const claim = (await deps.registry.read(report.lane))?.claim;
        // done-flow.ts claimEventId's format, spelled here: test/cli-sync-watch.test.ts mocks done-flow with a fixed export list.
        if (claim) eventId = `done-claim:${report.lane}:${claim.at}`;
        route = "claim";
      } else if (report.kind === "progress" && transport && statusChannel(lane)) {
        try {
          await upsertStatus(deps, transport, statusChannel(lane) ?? "", lane, store, report, home);
          route = "thread";
        } catch (e) {
          eventId = `lane-report:${report.id}`;
          await enqueue(eventId, `${reportLine(report, saveReportBody(deps.config.stateDir, report))} (status message failed: ${errorText(e)})`, laneMeta(lane));
          route = "journal";
        }
      } else if (report.kind === "progress" && deps.config.hooks.threadReply && lane.thread !== "none") {
        const posted = await deps.run(fillHook(deps.config.hooks.threadReply, { thread: lane.thread, text: relayedText(lane.key, scrubForThread(oneLine(report.text), home)), key: lane.key }));
        if (posted.code === 0) route = "thread";
        else {
          const error = (posted.err || posted.out || `exit ${posted.code}`).replace(/\s+/g, " ").slice(0, 160);
          eventId = `lane-report:${report.id}`;
          await enqueue(eventId, `${reportLine(report, saveReportBody(deps.config.stateDir, report))} (thread post failed: ${error})`, laneMeta(lane));
          route = "journal";
        }
      } else {
        eventId = `lane-report:${report.id}`;
        await enqueue(eventId, reportLine(report, saveReportBody(deps.config.stateDir, report)), laneMeta(lane));
        route = "journal";
        const channel = statusChannel(lane);
        if (report.kind === "milestone" && transport && channel) {
          try { await upsertStatus(deps, transport, channel, lane, store, report, home); }
          catch (e) { console.error(`LANE_STATUS_ERROR ${lane.key} ${report.id} ${errorText(e)}`); }
        }
      }
      // A routed report is the lane being heard, like a thread reply: freshness neither nudges it nor raises NO-REPORT.
      if (route !== "late") await deps.registry.patch(report.lane, { lastReplyAt: deps.clock.now() });
      store.consume(report.id, deps.clock.now(), route, eventId);
      failed.delete(report.id);
      out.push(`LANE_REPORT_ROUTED ${report.id} ${report.kind} ${route}`);
    } catch (e) {
      // Poison isolation: the row stays pending and is retried on the next supervisor pass, never in a hot loop.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`LANE_REPORT_ERROR ${report.id} ${message}`);
      const n = (failed.get(report.id) ?? 0) + 1;
      failed.set(report.id, n);
      if (n !== POISON_ALERT_AFTER) continue;
      try {
        // LANE_REPORT ... blocked is urgent in the default event policy; the journal dedupes the id across restarts.
        await enqueue(`lane-report-stuck:${report.id}`, `LANE_REPORT ${report.lane} blocked REPORT_STUCK ${report.id} (${report.kind}) failed to route ${n} times: ${oneLine(message).slice(0, 160)}; it stays pending and is retried every pass`, { lane: report.lane });
      } catch (alert) {
        console.error(`LANE_REPORT_STUCK_ERROR ${report.id} ${alert instanceof Error ? alert.message : String(alert)}`);
      }
    }
  }
  return out;
};

/** How many lead-pane lines the violation sweep reads: more than one screen, so a line is seen before it scrolls away. */
export const LEAD_PANE_LINES = 200;

/** Every `[REPORT] <key> | <kind> | <text>` line of `key` in the lead's pane, wherever it sits on the line (input box, quote). */
export const leadPaneReportLines = (screen: string, key: string): string[] => {
  const shape = new RegExp(`\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| \\w+ \\| (?!<)\\S.*$`);
  return screen.split("\n").flatMap((l) => { const m = shape.exec(l); return m ? [m[0].trimEnd()] : []; });
};

const lineHash = (line: string): string => createHash("sha256").update(line).digest("hex").slice(0, 16);

/** The report row a lead-pane `[REPORT] <key> | <kind> | <text>` line stands for: `blocker` is blocked, an unknown kind a milestone. */
const rowOfPaneLine = (lane: Lane, line: string, at: number): NewReport => {
  const m = /\[REPORT\] \S+ \| (\w+) \| (.*)$/.exec(line);
  const word = m?.[1] ?? "milestone";
  const kind: ReportKind = word === "blocker" ? "blocked" : isReportKind(word) ? word : "milestone";
  const text = (m?.[2] ?? line).trim();
  return { lane: lane.key, generation: laneGeneration(lane), kind, text, ...(kind === "done" ? { evidence: text } : {}), at };
};

/**
 * The lead-pane ban is a brief rule, not a technical one (design 3.3): a lane can still type into the lead's pane. Each
 * distinct [REPORT] line of an open `reportVia: cli` lane (every local launch and relaunch) found in the lead's pane is counted once on that lane (`leadPaneViolations`), rerouted as a
 * report row (routeReports then acts on it as the lane's report: a question wakes the lead, a done line is the claim),
 * and announced as a digest `LANE_PANE_VIOLATION <key> <count> <line> (rerouted as report <id>)`. `reports` defaults to
 * the configured store, opened only when a new line is found. A lane still on the old footer (launched by an older dori,
 * not relaunched since) reports there by design and is not counted. No such lane open, or no leadPane: nothing is read.
 */
export const leadPaneViolationTick = async (deps: FlowDeps, emit: Emit, reports?: LaneReportStore): Promise<void> => {
  if (!deps.config.leadPane) return;
  const lanes = (await deps.registry.open()).filter((lane) => lane.reportVia === "cli" && statusOf(lane) !== "closed");
  if (!lanes.length) return;
  const screen = await readScreen(deps.run, deps.config.leadPane, LEAD_PANE_LINES);
  let opened: LaneReportStore | undefined;
  const reroute = (lane: Lane, line: string): string => {
    try {
      const store = reports ?? (opened ??= openLaneReports(deps.config));
      return ` (rerouted as report ${store.append(rowOfPaneLine(lane, line, deps.clock.now())).id})`;
    } catch (e) {
      return ` (not rerouted: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160)})`;
    }
  };
  try {
    for (const lane of lanes) await violationsOf(deps, emit, lane, screen, reroute);
  } finally { opened?.close(); }
};

const violationsOf = async (deps: FlowDeps, emit: Emit, lane: Lane, screen: string, reroute: (lane: Lane, line: string) => string): Promise<void> => {
  let seen = lane.leadPaneSeen ?? [];
  let count = lane.leadPaneViolations ?? 0;
  const found: [number, string][] = [];
  for (const line of leadPaneReportLines(screen, lane.key)) {
    const hash = lineHash(line);
    if (seen.some((s) => s.hash === hash)) continue;
    seen = [...seen, { hash, at: new Date(deps.clock.now()).toISOString() }].slice(-REMOTE_SEEN_MAX);
    count++;
    found.push([count, line]);
  }
  if (!found.length) return;
  // Saved before the rows and events: a crash in between loses a reroute and an announcement, never repeats a count or a row.
  await deps.registry.patch(lane.key, { leadPaneSeen: seen, leadPaneViolations: count });
  for (const [n, line] of found) await emit(`LANE_PANE_VIOLATION ${lane.key} ${n} ${oneLine(line)}${reroute(lane, line)}`);
};
