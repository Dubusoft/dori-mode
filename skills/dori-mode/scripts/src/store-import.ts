import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { GITHUB_FILE, importGithub, retireGithubFile } from "./github-events.ts";
import { acquireSupervisor } from "./supervise-loop.ts";
import { JOURNAL_FIELDS, JOURNAL_FILE, jsonStorePending, PRE_SQLITE_FILE, SQLITE_FILE, SqliteStore, StoreError } from "./store.ts";
import type { Journal } from "./supervise.ts";
import { byAt, OPERATIONS_DDL, OPERATIONS_FILE, type Operation, putRows, readRows } from "./operations.ts";
import { LANE_REPORTS_FILE, LANE_REPORTS_LOCK, type LaneReport, putReportRows, readReportRows, reportOrder } from "./lane-report-store.ts";
import { LANE_MESSAGES_FILE, LANE_MESSAGES_LOCK, type LaneMessage, messageOrder, putMessageRows, readMessageRows } from "./lane-messages.ts";
import { withStateLockSync } from "./state-lock.ts";

/** A source file as the conversion read it: absent, or its byte size and sha256 (for the log: complete lines only). */
type SourceCursor = { readonly path: string; readonly present: boolean; readonly size: number; readonly sha256: string };

const cursor = (path: string, bytes: Buffer | undefined): SourceCursor => ({
  path, present: bytes !== undefined, size: bytes?.length ?? 0, sha256: createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex"),
});

const readIf = (path: string): Buffer | undefined => (existsSync(path) ? readFileSync(path) : undefined);

const fsyncPath = (path: string): void => {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

/** Collections that are empty mean the same as absent; JSON drops undefined fields. */
const normalize = (journal: Journal): unknown => {
  const plain = JSON.parse(JSON.stringify(journal)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(plain)) {
    if ((Array.isArray(value) && !value.length) || (typeof value === "object" && value !== null && !Array.isArray(value) && !Object.keys(value).length)) delete plain[key];
  }
  return plain;
};

const firstDiff = (a: unknown, b: unknown, path = "$"): string | undefined => {
  if (Bun.deepEquals(a, b)) return undefined;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return path;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const found = firstDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
    if (found) return found;
  }
  return path;
};

/** The rows of a retired json store file, in the order the store lists them; none when the file is absent. */
const readJsonRows = <F, T>(path: string, rows: (file: F) => Iterable<T>, order: (a: T, b: T) => number): T[] =>
  existsSync(path) ? [...rows(JSON.parse(readFileSync(path, "utf8")) as F)].sort(order) : [];

/**
 * Journal fields of the quota-driven lead model fallback chain (removed with it): the sqlite store never kept them, so the
 * conversion drops them deliberately instead of refusing. `leadModel` was the chain index; the rest was quota/emergency state.
 */
const OBSOLETE_JOURNAL_FIELDS: readonly string[] = ["leadModel", "primaryRetryAt", "primaryClearChecks", "quotaExhausted", "quotaStallSince", "emergencyEpisode"];

/** Drops the obsolete fields from a parsed journal (and the restart's chain index `modelIndex`, a column the store no longer has). */
const dropObsolete = (parsed: Record<string, unknown>): void => {
  for (const field of OBSOLETE_JOURNAL_FIELDS) delete parsed[field];
  const restart = parsed.restart;
  if (typeof restart === "object" && restart !== null) delete (restart as Record<string, unknown>).modelIndex;
};

/** Keeps a converted source read-only beside the database as `<file>.pre-sqlite`. */
const retire = (path: string, pre = `${path}.pre-sqlite`): void => {
  renameSync(path, pre);
  chmodSync(pre, 0o400);
};

/**
 * Moves a state dir from the retired json store to supervisor.sqlite under a quiesced barrier: the supervisor lock is
 * held for the whole conversion, so no supervisor runs and nothing writes the sources. It records the source cursors, imports every
 * journal field (Appendix D) and every delivery in lead-events.log into a temporary database, reads it back and refuses
 * unless the read-back equals the source field by field, then moves the database into place and keeps supervisor.json
 * read-only as supervisor.json.pre-sqlite; github-events.json moves into the same database the same way (importGithub).
 * lead-events.log stays where it is: the lead tails it, and the store records the byte offset it has read. Lane reports
 * and lane messages move the same way, every row with its id and consumed/delivery state (lane-reports.json and
 * lane-messages.json become *.pre-sqlite). Any refusal leaves the state dir exactly as it was. Returns false when another
 * process converted it first (supervisor.sqlite or its import marker is there).
 */
const convertLocked = (stateDir: string, now: number, lock: (stateDir: string) => () => void): boolean => {
  let release: () => void;
  try { release = lock(stateDir); } catch (e) {
    throw new StoreError(`STORE_SUPERVISOR_RUNNING the json store converts once no supervisor holds the lock (${e instanceof Error ? e.message : String(e)})`);
  }
  const database = join(stateDir, SQLITE_FILE);
  const tmp = `${database}.import-${process.pid}`;
  let opsImported = false;
  try {
    const jsonPath = join(stateDir, JOURNAL_FILE);
    const prePath = join(stateDir, PRE_SQLITE_FILE);
    if (!jsonStorePending(stateDir)) return false;
    const laneFiles = [LANE_REPORTS_FILE, LANE_MESSAGES_FILE].filter((file) => existsSync(join(stateDir, file)));
    const retiredLane = laneFiles.find((file) => existsSync(join(stateDir, `${file}.pre-sqlite`)));
    if (retiredLane) throw new StoreError(`STORE_EXISTS ${stateDir} was already imported (${retiredLane}.pre-sqlite exists beside ${retiredLane}); nothing imported`);
    const raw = readIf(jsonPath);
    const parsed: unknown = raw ? JSON.parse(raw.toString("utf8")) : { events: [] };
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { events?: unknown }).events)) {
      throw new StoreError(`STORE_IMPORT_MALFORMED ${jsonPath} has no events array`);
    }
    dropObsolete(parsed as Record<string, unknown>);
    const unknown = Object.keys(parsed).filter((key) => !JOURNAL_FIELDS.includes(key));
    if (unknown.length) throw new StoreError(`STORE_IMPORT_UNKNOWN_FIELD ${jsonPath}: ${unknown.join(", ")} has no destination table; nothing imported`);
    const journal = parsed as Journal;
    const logPath = join(stateDir, "lead-events.log");
    const logBytes = readIf(logPath);
    // A partial final line was never a delivery (the supervisor truncates it at its next start).
    const logEnd = logBytes ? logBytes.lastIndexOf(10) + 1 : 0;
    const logLines = logBytes ? logBytes.subarray(0, logEnd).toString("utf8").split("\n").filter(Boolean) : [];
    const delivered = logLines.map((line) => (JSON.parse(line) as { id: string }).id);
    const sources = {
      journal: cursor(jsonPath, raw),
      log: { ...cursor(logPath, logBytes?.subarray(0, logEnd)), present: logBytes !== undefined, lines: logLines.length },
      githubEvents: cursor(join(stateDir, GITHUB_FILE), readIf(join(stateDir, GITHUB_FILE))),
    };
    const stamped: string[] = [];
    const events = journal.events.map((event) => {
      if (event.at !== undefined) return event;
      stamped.push(event.id);
      return { ...event, at: now };
    });
    rmSync(tmp, { force: true });
    const store = new SqliteStore(tmp, { create: true, wal: false });
    try {
      store.save({ ...journal, events }, "full");
      store.markSynthetic(stamped);
      store.recordDeliveries(delivered, logEnd, now);
      if (sources.githubEvents.present) importGithub(store.database, stateDir, now);
      // Operation rows move from operations.json into the database's operations table.
      const ops = readJsonRows(join(stateDir, OPERATIONS_FILE), (file: { ops: Record<string, Operation> }) => Object.values(file.ops), byAt);
      if (ops.length) {
        store.transaction("full", () => { store.database.exec(OPERATIONS_DDL); putRows(store.database, ops); });
        if (!Bun.deepEquals(readRows(store.database), ops)) {
          throw new StoreError(`STORE_IMPORT_MISMATCH operations differ from ${OPERATIONS_FILE}; nothing imported`);
        }
      }
      opsImported = ops.length > 0;
      // Lane reports and lane messages move into their tables with every column, pending and consumed alike.
      const reports = readJsonRows(join(stateDir, LANE_REPORTS_FILE), (file: { reports: LaneReport[] }) => file.reports, reportOrder);
      const messages = readJsonRows(join(stateDir, LANE_MESSAGES_FILE), (file: { messages: Record<string, LaneMessage> }) => Object.values(file.messages), messageOrder);
      store.transaction("full", () => { putReportRows(store.database, reports); putMessageRows(store.database, messages); });
      if (!Bun.deepEquals(readReportRows(store.database), reports) || !Bun.deepEquals(readMessageRows(store.database), messages)) {
        throw new StoreError(`STORE_IMPORT_MISMATCH lane reports or lane messages differ from ${LANE_REPORTS_FILE}/${LANE_MESSAGES_FILE}; nothing imported`);
      }
      store.transaction("full", () => store.setMeta("import", JSON.stringify({ at: now, sources })));
      const diff = firstDiff(normalize(store.read(true)), normalize(journal));
      if (diff) throw new StoreError(`STORE_IMPORT_MISMATCH the imported journal differs from ${jsonPath} at ${diff}; nothing imported`);
      const ids = store.deliveredIds();
      if (ids.size !== new Set(delivered).size || delivered.some((id) => !ids.has(id))) throw new StoreError(`STORE_IMPORT_MISMATCH deliveries differ from ${logPath}; nothing imported`);
    } finally { store.close(); }
    fsyncPath(tmp);
    renameSync(tmp, database);
    if (raw) retire(jsonPath, prePath);
    if (sources.githubEvents.present) retireGithubFile(stateDir);
    if (opsImported) retire(join(stateDir, OPERATIONS_FILE));
    for (const file of laneFiles) retire(join(stateDir, file));
    fsyncPath(stateDir);
    return true;
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    release();
  }
};

/**
 * Converts a state dir still on the json store to supervisor.sqlite, once (convertLocked), under the lane-report and
 * lane-message file locks so no row an older `dori report` writes lands between the copy and the files' retirement.
 * Returns whether this call converted it. Every config load runs it (config.ts), before anything reads the store.
 */
export const convertJsonStore = (stateDir: string, now: number, lock: (stateDir: string) => () => void = acquireSupervisor): boolean =>
  jsonStorePending(stateDir) && withStateLockSync(join(stateDir, LANE_REPORTS_LOCK), () => withStateLockSync(join(stateDir, LANE_MESSAGES_LOCK), () => convertLocked(stateDir, now, lock)));
