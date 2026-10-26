import { existsSync, readFileSync } from "node:fs";
import { redactMeta, redactSecrets } from "./redact.ts";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { EVENT_LOG, parseLogLine } from "./inbox.ts";
import { DEFAULT_LEAD, readStoreView, TAKES_FILE } from "./store.ts";
import type { Event, Journal, LaneOutcome } from "./supervise-journal.ts";

/**
 * `dori event trace <id>`: one event's path through the supervisor, read from the journal store without its lock.
 * enqueued -> delivered (in lead-events.log) -> taken (a consumed `dori inbox take` receipt, with its session) ->
 * acked/handled (an owner message) or reported (an event of a finished lane's report obligation).
 */

/** What the store holds about one event id, whichever backend it is. */
export type TraceSources = {
  readonly event?: Event;
  /** Pruned by retention: the body is gone, the dedupe tombstone remains. */
  readonly tombstoned?: boolean;
  readonly delivered: boolean;
  /** Absent on the json store, which records no delivery times. */
  readonly deliveredAt?: number;
  readonly takenAt?: number;
  readonly takenSession?: string;
  readonly owner?: { readonly ackedAt?: number; readonly handledAt?: number; readonly deleted?: boolean };
  /** The owner message was handled long enough ago that its tracking was compacted to a tombstone. */
  readonly ownerClosed?: boolean;
  readonly outcome?: LaneOutcome;
};

export type TraceStep = { readonly step: string; readonly at?: number; readonly detail?: string };
export type Trace = {
  readonly id: string;
  readonly line?: string;
  readonly meta?: Event["meta"];
  readonly steps: readonly TraceStep[];
  /** Steps still owed, in order (e.g. "taken" while the lead has not read it). */
  readonly open: readonly string[];
};

/** The timeline of event `id`; undefined when the store knows nothing about it. Pure. */
export const buildTrace = (id: string, src: TraceSources): Trace | undefined => {
  const { event } = src;
  if (!event && !src.tombstoned && !src.delivered) return undefined;
  const steps: TraceStep[] = [];
  const open: string[] = [];
  if (event) steps.push({ step: "enqueued", ...(event.at !== undefined ? { at: event.at } : {}) });
  else if (src.tombstoned) steps.push({ step: "pruned", detail: "body expired; dedupe tombstone kept" });
  if (src.delivered) steps.push({ step: "delivered", ...(src.deliveredAt !== undefined ? { at: src.deliveredAt } : {}) });
  else open.push("delivered");
  if (src.takenAt !== undefined) steps.push({ step: "taken", at: src.takenAt, ...(src.takenSession ? { detail: `session ${src.takenSession}` } : {}) });
  else if (src.delivered) open.push("taken");
  const { owner } = src;
  if (owner) {
    if (owner.ackedAt !== undefined) steps.push({ step: "acked", at: owner.ackedAt });
    if (owner.deleted) steps.push({ step: "deleted", detail: "the owner deleted the message" });
    else if (owner.handledAt !== undefined) steps.push({ step: "handled", at: owner.handledAt });
    else open.push(...(owner.ackedAt === undefined ? ["acked"] : []), "handled");
  } else if (src.ownerClosed) steps.push({ step: "handled", detail: "owner tracking compacted" });
  const { outcome } = src;
  if (outcome) {
    if (outcome.reportedAt !== undefined) steps.push({ step: "reported", at: outcome.reportedAt, detail: redactSecrets(`lane ${outcome.lane}${outcome.note ? `: ${outcome.note}` : ""}`) });
    else open.push("reported");
  }
  return { id, ...(event ? { line: redactSecrets(event.line) } : {}), ...(event?.meta ? { meta: redactMeta(event.meta) } : {}), steps, open };
};

/** The trace as printed lines: a header, then one `<ISO time | ->  <step>  <detail>` per step and the open steps. */
export const traceText = (trace: Trace): string[] => [
  `EVENT ${trace.id}${trace.line ? ` ${trace.line}` : ""}`,
  ...(trace.meta ? [`META ${Object.entries(trace.meta).map(([key, value]) => `${key}=${value}`).join(" ")}`] : []),
  ...trace.steps.map((s) => `${s.at !== undefined ? new Date(s.at).toISOString() : "-"}\t${s.step}${s.detail ? `\t${s.detail}` : ""}`),
  ...(trace.open.length ? [`OPEN ${trace.open.join(", ")}`] : []),
];

type Row = Record<string, string | number | null>;
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** The first take of `id` in the json store's takes file. */
const jsonTake = (stateDir: string, id: string): { takenAt?: number; takenSession?: string } => {
  const path = join(stateDir, TAKES_FILE);
  if (!existsSync(path)) return {};
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (!text) continue;
    let row: { ids?: unknown; at?: unknown; session?: unknown };
    try { row = JSON.parse(text); } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    if (Array.isArray(row.ids) && row.ids.includes(id) && typeof row.at === "number") {
      return { takenAt: row.at, ...(typeof row.session === "string" ? { takenSession: row.session } : {}) };
    }
  }
  return {};
};

const inLog = (stateDir: string, id: string): boolean => {
  const path = join(stateDir, EVENT_LOG);
  return existsSync(path) && readFileSync(path, "utf8").split("\n").some((text) => text !== "" && parseLogLine(text).id === id);
};

const fromJson = (stateDir: string, id: string, journal: Journal): TraceSources => {
  const owner = journal.awaitingAck?.find((entry) => entry.id === id);
  const outcome = journal.outcomes?.find((entry) => entry.events?.includes(id));
  return {
    ...(() => { const event = journal.events.find((e) => e.id === id); return event ? { event } : {}; })(),
    delivered: inLog(stateDir, id),
    ...jsonTake(stateDir, id),
    ...(owner ? { owner: { ackedAt: owner.ackedAt, handledAt: owner.handledAt, deleted: owner.deleted === true } } : {}),
    ...(journal.closedOwners?.includes(id) ? { ownerClosed: true } : {}),
    ...(outcome ? { outcome } : {}),
  };
};

/** `SELECT *` throughout: a database the supervisor has not migrated yet simply lacks the newer columns. */
const fromSqlite = (id: string, db: Database): TraceSources => {
  const eventRow = db.query("SELECT * FROM events WHERE id = ?").get(id) as Row | null;
  const delivery = db.query("SELECT * FROM deliveries WHERE event_id = ?").get(id) as Row | null;
  const ownerRow = db.query("SELECT * FROM owner_messages WHERE id = ?").get(id) as Row | null;
  const state = db.query("SELECT * FROM lead_state WHERE lead = ?").get(DEFAULT_LEAD) as Row | null;
  const outcomes = typeof state?.outcomes === "string" ? JSON.parse(state.outcomes) as LaneOutcome[] : [];
  const outcome = outcomes.find((entry) => entry.events?.includes(id));
  const at = num(eventRow?.at);
  const meta = typeof eventRow?.meta === "string" ? JSON.parse(eventRow.meta) as Event["meta"] : undefined;
  return {
    ...(eventRow ? { event: { id, line: String(eventRow.line), ...(at !== undefined ? { at } : {}), ...(meta ? { meta } : {}) } } : {}),
    tombstoned: db.query("SELECT 1 AS hit FROM event_tombstones WHERE id = ?").get(id) !== null,
    delivered: delivery !== null,
    ...(delivery ? { deliveredAt: num(delivery.delivered_at), takenAt: num(delivery.taken_at), ...(typeof delivery.taken_session === "string" ? { takenSession: delivery.taken_session } : {}) } : {}),
    ...(ownerRow ? { owner: { ackedAt: num(ownerRow.acked_at), handledAt: num(ownerRow.handled_at), deleted: ownerRow.deleted === 1 } } : {}),
    ...(db.query("SELECT 1 AS hit FROM owner_tombstones WHERE id = ?").get(id) !== null ? { ownerClosed: true } : {}),
    ...(outcome ? { outcome } : {}),
  };
};

/** What this state dir's store holds about `id` (read-only); undefined when the store cannot be read. */
export const loadTrace = (stateDir: string, id: string): TraceSources | undefined =>
  readStoreView(stateDir, { json: (journal) => fromJson(stateDir, id, journal), sqlite: (db) => fromSqlite(id, db) });
