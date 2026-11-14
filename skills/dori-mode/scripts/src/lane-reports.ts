import { redactSecrets } from "./redact.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { fillHook } from "./config.ts";
import { displayTime } from "./display-time.ts";
import { claimDone, type Emit, type FlowDeps, laneMeta } from "./done-flow.ts";
import { relayedText, scrubForThread } from "./freshness.ts";
import { Discord, DISCORD_MESSAGES_PAGE, DISCORD_SUPPRESS_NOTIFICATIONS } from "./messenger/discord.ts";
import { fetchHttp } from "./messenger/http.ts";
import { resolveTarget } from "./messenger/target.ts";
import type { Clock } from "./run.ts";
import { type Lane, statusOf } from "./registry.ts";
import { withStateLockSync } from "./state-lock.ts";
import type { EventMeta } from "./supervise-journal.ts";
import { RETENTION, saveJsonFile, SQLITE_FILE, StoreError, type StoreKind } from "./store.ts";
import { REPORT_KINDS, type ReportKind } from "./runner/report-kinds.ts";
import type { LaneFileReceipt } from "./runner/protocol.ts";
import { LaneFileError } from "./lane-files.ts";
import { ownerClosedRecorded, redirectIfClosed } from "./thread-followup.ts";
import { type OpenResult, openedLine } from "./owner-decisions.ts";
export { REPORT_KINDS, isReportKind, type ReportKind } from "./runner/report-kinds.ts";

/**
 * Structured lane reports (design 3.3): `dori report <key> <kind> --text T [--evidence E]` writes one
 * row, and the supervisor routes each row once and marks it consumed. Nothing is typed into the lead's pane.
 */
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

export const LANE_REPORTS_FILE = "lane-reports.json";
/** Held while lane-reports.json is written; `dori store import` holds it so no row lands between its copy and the file's retirement. */
export const LANE_REPORTS_LOCK = "lane-reports.lock.sqlite";

const order = (a: LaneReport, b: LaneReport): number => a.at - b.at || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0) || a.seq - b.seq;
const withId = (report: NewReport, seq: number): LaneReport => ({
  id: `${report.lane}:${report.generation}:${seq}`, lane: report.lane, generation: report.generation, seq, kind: report.kind,
  text: redactSecrets(report.text), ...(report.evidence ? { evidence: redactSecrets(report.evidence) } : {}), at: report.at,
  ...(report.source ? { source: report.source } : {}),
  ...(report.fileReceipt ? { fileReceipt: report.fileReceipt } : {}),
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
  prune(now: number): void {
    withStateLockSync(this.lock, () => {
      const reports = this.read();
      const latest = new Map<string, number>();
      for (const row of reports) latest.set(row.lane, Math.max(latest.get(row.lane) ?? 0, row.seq));
      const kept = reports.filter((row) => row.consumedAt === undefined || row.consumedAt >= now - RETENTION.statusHistoryMs || row.seq === latest.get(row.lane));
      if (kept.length !== reports.length) saveJsonFile(this.path, { reports: kept });
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

/** Every row of `db`'s lane_reports table, as stored and in list() order; no table reads as no rows (`dori store export`). */
export const readReportRows = (db: Database): LaneReport[] =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lane_reports'").get()
    ? (db.query("SELECT * FROM lane_reports ORDER BY at, lane, seq").all() as Row[]).map(reportOf)
    : [];

/** Inserts `rows` with every column kept (id, seq, consumed_at, route), for `dori store import`; an id already there throws. */
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

/**
 * Opens the owner decision a lane question carries (owner-decisions.ts openLaneDecision); undefined for a free-text
 * question, which is routed to the journal as before.
 */
export type DecisionOpener = (lane: Lane, report: LaneReport) => Promise<OpenResult | undefined>;

/** Journals one line under a stable id; the supervisor dedupes a repeat of the same id. */
export type ReportEnqueue = (id: string, line: string, meta?: EventMeta) => unknown;

/** A message posted after a lane's status message, as the status check reads it: by the bot itself, its Discord type, its text. */
export type LaterMessage = { readonly own: boolean; readonly type: number; readonly content: string };

/**
 * Posts, edits and deletes a lane's status message in its thread; `post` returns the new message's id and `silent` posts
 * it without a notification. `threadState` tells a thread the owner closed (thread-followup.ts closedByOwner) from one
 * that is open and names its last message; `laterMessages` lists what was posted after a message (`more` when Discord
 * has more than one page of them).
 */
export type LaneStatusTransport = {
  post(channel: string, text: string, stableId: string, silent?: boolean): Promise<string>;
  edit(channel: string, messageId: string, text: string): Promise<void>;
  remove(channel: string, messageId: string): Promise<void>;
  threadState(threadId: string): Promise<{ readonly archived: boolean; readonly parent: string | undefined; readonly lastMessageId?: string | undefined }>;
  laterMessages(channel: string, afterId: string): Promise<{ readonly messages: readonly LaterMessage[]; readonly more: boolean }>;
};

/** The status transport over a Discord client (the supervisor's own, or one on DORI_DISCORD_TOKEN). */
export const statusTransportOf = (discord: Discord): LaneStatusTransport => ({
  post: (channel, text, stableId, silent) => discord.send(channel, text, stableId, undefined, silent ? DISCORD_SUPPRESS_NOTIFICATIONS : undefined),
  edit: (channel, id, text) => discord.edit(channel, id, text),
  remove: (channel, id) => discord.deleteMessage(channel, id),
  threadState: (threadId) => discord.threadState(threadId),
  laterMessages: async (channel, afterId) => {
    const [me, messages] = await Promise.all([discord.selfId(), discord.messagesAfter(channel, afterId)]);
    return { messages: messages.map((m) => ({ own: m.authorId === me, type: m.type, content: m.content })), more: messages.length >= DISCORD_MESSAGES_PAGE };
  },
});

/**
 * The Discord status transport, on DORI_DISCORD_TOKEN from the process environment (the supervisor unit loads it from
 * its EnvironmentFile); undefined without a token, so progress falls back to hooks.threadReply or the lead's journal.
 */
export const discordStatusTransport = (clock: Clock, env: Readonly<Record<string, string | undefined>> = process.env): LaneStatusTransport | undefined => {
  const token = env.DORI_DISCORD_TOKEN?.trim();
  if (!token) return undefined;
  return statusTransportOf(new Discord(fetchHttp, clock, token));
};

/** Longest report text a status message line carries. */
export const STATUS_TEXT_MAX = 300;

const elapsed = (ms: number): string => {
  const min = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`;
};
const errorText = (e: unknown): string => oneLine(e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * The text of a lane's status message as of `report` (absent: every row): its key, time since it opened, and its last
 * milestone and last progress (rows up to `report`, late ones left out), each with its time, scrubbed like a thread post;
 * then the lines of `review` (review-status.ts reviewStatusLines), scrubbed the same way.
 */
export const laneStatusText = (
  lane: Lane, rows: readonly LaneReport[], report: LaneReport | undefined, now: number, home: string, timeZone?: string, review: readonly string[] = [],
): string => {
  const stamp = (at: number): string => displayTime(at, timeZone);
  const upTo = rows.filter((r) => (!report || r.seq <= report.seq) && r.route !== "late" && (r.kind === "milestone" || r.kind === "progress"));
  const last = (kind: ReportKind): LaneReport | undefined =>
    [...upTo, ...(!report || upTo.some((r) => r.id === report.id) ? [] : [report])].filter((r) => r.kind === kind).sort((a, b) => a.seq - b.seq).at(-1);
  const line = (label: string, row: LaneReport | undefined): string => {
    if (!row) return `${label}: 아직 없음`;
    const text = scrubForThread(oneLine(row.text), home);
    return `${label} (${stamp(row.at)}): ${text.length <= STATUS_TEXT_MAX ? text : `${text.slice(0, STATUS_TEXT_MAX)}...`}`;
  };
  const opened = Date.parse(lane.openedAt);
  return [
    `[System] 레인 ${lane.key} 상태, 진행 ${Number.isNaN(opened) ? "(알 수 없음)" : elapsed(now - opened)} (갱신 ${stamp(now)})`,
    line("마지막 마일스톤", last("milestone")),
    line("마지막 진행", last("progress")),
    ...review.map((l) => scrubForThread(l, home)),
  ].join("\n");
};

const STATUS_HEAD = /^\[System\] 레인 \S+ 상태, 진행 /;

/** Whether `text` is a lane status message (laneStatusText) of any lane. */
export const isLaneStatusText = (text: string): boolean => STATUS_HEAD.test(text);

/**
 * Whether status message `statusId` is still the latest thing in thread `channel`: the thread is not archived, and
 * either its last message is the status message or everything posted after it is the bot's own plain status message
 * of some lane (so lanes sharing a thread never push each other's status up). Anything else after it, a thread system
 * message (rename, member added, pin) included, means it is not.
 */
const statusIsLatest = async (transport: LaneStatusTransport, channel: string, statusId: string): Promise<boolean> => {
  const state = await transport.threadState(channel);
  if (state.archived) return false;
  if (state.lastMessageId === statusId) return true;
  const later = await transport.laterMessages(channel, statusId);
  return !later.more && later.messages.every((m) => m.own && m.type === 0 && isLaneStatusText(m.content));
};

/** The Discord channel id of a lane's thread, or undefined for no thread or a non-Discord one. */
export const statusChannel = (lane: Lane): string | undefined =>
  lane.thread !== "none" && lane.thread.startsWith("discord:") ? resolveTarget("discord", lane.thread).to : undefined;

/**
 * Keeps the lane's status message at the bottom of its thread with the text as of `report`. While it is still the latest
 * there (statusIsLatest) it is edited in place; once something else was posted after it, or Discord archived the thread,
 * a new one is posted without a notification, its id stored on the lane (statusMessageId), and only then the old one
 * deleted (a failed delete is logged). It is posted when there is none yet or the edit fails (a deleted message). A failed
 * latest check is logged and the message edited as before. A thread the owner closed is neither edited nor
 * posted into (either would reopen it): the report goes as one line linking the thread to its parent channel, else the
 * owner channel (redirectIfClosed), and the status message is left as it is. A failed post throws.
 */
const upsertStatus = async (
  deps: FlowDeps, transport: LaneStatusTransport, channel: string, lane: Lane, store: LaneReportStore, report: LaneReport, home: string,
  review: readonly string[] = [],
): Promise<void> => {
  const relayed = relayedText(lane.key, scrubForThread(oneLine(report.text), home));
  const redirected = await redirectIfClosed(deps.config.stateDir, transport, channel, relayed, deps.config.discordChannels[0],
    (target, line) => transport.post(target, line, `lane-status:${report.id}`));
  if (redirected) {
    console.error(`LANE_STATUS_REDIRECTED ${lane.key} ${report.id}: thread ${channel} was closed by the owner, so one line went to ${redirected}`);
    return;
  }
  const text = laneStatusText(lane, store.list({ lane: lane.key }), report, deps.clock.now(), home, deps.config.displayTimeZone, review);
  await writeLaneStatus(deps, transport, channel, lane, text, `lane-status:${report.id}`);
};

/**
 * Writes `text` as the lane's status message in `channel` (upsertStatus without the closed-thread redirect): edited in
 * place while it is the latest, else posted anew without a notification and the old one deleted; posted when there is
 * none yet (silent when `silent`) or the edit fails. A failed post throws; nothing but the lane's statusMessageId changes.
 */
export const writeLaneStatus = async (
  deps: FlowDeps, transport: LaneStatusTransport, channel: string, lane: Lane, text: string, stableId: string, silent = false,
): Promise<void> => {
  const previous = lane.statusMessageId;
  if (previous) {
    let latest = true;
    try { latest = await statusIsLatest(transport, channel, previous); }
    catch (e) { console.error(`LANE_STATUS_CHECK_FAILED ${lane.key} ${previous} ${errorText(e)}; editing it in place`); }
    if (!latest) {
      const id = await transport.post(channel, text, stableId, true);
      await deps.registry.patch(lane.key, { statusMessageId: id });
      try { await transport.remove(channel, previous); }
      catch (e) { console.error(`LANE_STATUS_DELETE_FAILED ${lane.key} ${previous} ${errorText(e)}`); }
      return;
    }
    try {
      await transport.edit(channel, previous, text);
      return;
    } catch (e) {
      console.error(`LANE_STATUS_EDIT_FAILED ${lane.key} ${previous} ${errorText(e)}; posting a new status message`);
    }
  }
  const id = await transport.post(channel, text, stableId, silent);
  await deps.registry.patch(lane.key, { statusMessageId: id });
};

/** The review lines a lane's status message carries (review-status.ts), read when a report updates it. */
export type ReviewSection = (lane: Lane) => Promise<readonly string[]>;

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
 * With `openDecision`, a question of an open lane is first offered to it: a question with choices opens (or finds, the
 * row id being its sourceRef) one owner decision thread and becomes a digest `OWNER_DECISION_OPENED` event under
 * `owner-decision-opened:<decision id>` (route `decision`); a free-text question (undefined) is journaled as above, and
 * a throw is a failed routing pass like any other.
 * A row whose routing throws is logged and left pending (retried next pass); the rest are still routed. After
 * POISON_ALERT_AFTER failed passes in a row it raises one urgent `LANE_REPORT <key> blocked REPORT_STUCK ...` event
 * under `lane-report-stuck:<row id>`. Returns one log line per routed row.
 */
export const routeReports = async (
  deps: FlowDeps, store: LaneReportStore, enqueue: ReportEnqueue, home = process.env.HOME ?? "",
  transport: LaneStatusTransport | null = discordStatusTransport(deps.clock) ?? null, openDecision?: DecisionOpener, reviewSection?: ReviewSection,
): Promise<string[]> => {
  // A review status that cannot be read never stops a report: the status message goes out without it.
  const review = async (lane: Lane): Promise<readonly string[]> => {
    try { return (await reviewSection?.(lane)) ?? []; } catch (e) {
      console.error(`LANE_STATUS_REVIEW_ERROR ${lane.key} ${errorText(e)}`);
      return [];
    }
  };
  const out: string[] = [];
  const failed = failures.get(store) ?? new Map<string, number>();
  failures.set(store, failed);
  for (const report of store.pending()) {
    try {
      const lane = await deps.registry.read(report.lane);
      let route: ReportRoute;
      let eventId: string | undefined;
      const stale = lane && report.generation !== UNFENCED_GENERATION && report.generation < laneGeneration(lane);
      const late = !lane || statusOf(lane) === "closed" || stale;
      const opened = !late && report.kind === "question" && openDecision ? await openDecision(lane, report) : undefined;
      if (late || !lane) {
        eventId = `lane-report-late:${report.id}`;
        const line = reportLine(report, saveReportBody(deps.config.stateDir, report), "LANE_REPORT_LATE");
        await enqueue(eventId, stale ? `${line} (from a replaced session)` : line, lane ? laneMeta(lane) : { lane: report.lane });
        route = "late";
      } else if (opened) {
        eventId = `owner-decision-opened:${opened.decision.id}`;
        await enqueue(eventId, openedLine(opened.decision, opened.duplicateOf), laneMeta(lane));
        route = "decision";
      } else if (report.kind === "done") {
        if (lane.fileRun && !report.fileReceipt) throw new LaneFileError("LANE_REPORT_FILES_MISSING", lane.key, "this managed lane's done report has no file snapshot; claim done again through its runner");
        await claimDone(deps, lane, oneLine(report.evidence ?? report.text), report.fileReceipt);
        const claim = (await deps.registry.read(report.lane))?.claim;
        // done-flow.ts claimEventId's format, spelled here: test/cli-sync-watch.test.ts mocks done-flow with a fixed export list.
        if (claim) eventId = `done-claim:${report.lane}:${claim.at}`;
        route = "claim";
      } else if (report.kind === "progress" && transport && statusChannel(lane)) {
        try {
          await upsertStatus(deps, transport, statusChannel(lane) ?? "", lane, store, report, home, await review(lane));
          route = "thread";
        } catch (e) {
          eventId = `lane-report:${report.id}`;
          await enqueue(eventId, `${reportLine(report, saveReportBody(deps.config.stateDir, report))} (status message failed: ${errorText(e)})`, laneMeta(lane));
          route = "journal";
        }
      } else if (report.kind === "progress" && deps.config.hooks.threadReply && lane.thread !== "none" && !ownerClosedRecorded(deps.config.stateDir, lane.thread)) {
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
          try { await upsertStatus(deps, transport, channel, lane, store, report, home, await review(lane)); }
          catch (e) { console.error(`LANE_STATUS_ERROR ${lane.key} ${report.id} ${errorText(e)}`); }
        }
      }
      // A routed report is the lane being heard, like a thread reply: freshness neither nudges it nor raises NO-PROGRESS.
      if (route !== "late") await deps.registry.patch(report.lane, { lastReplyAt: deps.clock.now() });
      store.consume(report.id, deps.clock.now(), route, eventId);
      failed.delete(report.id);
      out.push(`LANE_REPORT_ROUTED ${report.id} ${report.kind} ${route}`);
    } catch (e) {
      if (e instanceof LaneFileError && !e.transient) {
        // A permanent file refusal never retries: a stale report is routed late, any other refusal journals its exact leaf line.
        try {
          const lane = await deps.registry.read(report.lane);
          const meta = lane ? laneMeta(lane) : { lane: report.lane };
          let route: ReportRoute = "journal";
          let eventId = `lane-report-refused:${report.id}`;
          if (e.code === "LANE_REPORT_STALE") {
            eventId = `lane-report-late:${report.id}`;
            route = "late";
            await enqueue(eventId, `${reportLine(report, saveReportBody(deps.config.stateDir, report), "LANE_REPORT_LATE")} (from a replaced session)`, meta);
          } else await enqueue(eventId, e.message, meta);
          store.consume(report.id, deps.clock.now(), route, eventId);
          failed.delete(report.id);
          out.push(`LANE_REPORT_ROUTED ${report.id} ${report.kind} ${route}`);
          continue;
        } catch (refuse) {
          console.error(`LANE_REPORT_REFUSE_ERROR ${report.id} ${refuse instanceof Error ? refuse.message : String(refuse)}`);
        }
      }
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
