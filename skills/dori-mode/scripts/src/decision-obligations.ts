import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { eventClass, type EventPolicy, forLead } from "./event-policy.ts";
import type { Event, Journal, JournalCore, Obligation } from "./supervise-journal.ts";

/**
 * Decision obligations (architect review 3.1 A1): a lead-urgent event that asks the lead to decide something (a lane's
 * question or blocked report, a done claim that did not hold, a wait that ended, a dead pane) stays open until the lead
 * runs `dori resolved <eventId>`, enforced like lane outcome reports (lane-outcomes.ts). A live event whose line matches
 * `resolveKinds` (eventPolicy kind syntax) opens one obligation keyed by its event id, in the journal's `pending`. The
 * receipt is an immutable file the supervisor consumes; one that arrives before its event still closes it. Open past
 * resolveTimeoutMin, it comes back as urgent `UNRESOLVED <eventId> <line>`, re-sent with backoff, and keeps a pushed
 * lead pushed. Taking the event is not resolving it.
 */

export const RESOLVED_DIR = "resolved";
/** The open obligations as the supervisor last saw them, for readers without its store (`dori inbox take`, `dori resolved`). */
export const UNRESOLVED_FILE = "unresolved.json";
/** Reminders after the first wait resolveTimeoutMin, then twice as long each time, up to this. */
export const RESOLVE_REPEAT_MAX_MS = 60 * 60_000;
/** A resolved obligation is kept this long, so its event (or a late one, after an early receipt) opens nothing again. */
export const RESOLVED_KEEP_MS = 7 * 24 * 60 * 60_000;
/** The original line carried by an obligation, and the cut of it its UNRESOLVED reminder shows. */
export const OBLIGATION_LINE_MAX = 300;
export const UNRESOLVED_LINE_MAX = 160;

export const DEFAULT_RESOLVE_KINDS: readonly string[] = [
  "LANE_REPORT * question", "LANE_REPORT * blocked",
  "LANE_REPORT_LATE * question", "LANE_REPORT_LATE * blocked", "LANE_REPORT_LATE * done",
  "LANE_NOT_DONE", "WAIT_DONE", "WAIT_TIMEOUT", "WAIT_FAILED", "DEAD_PANE",
];

/** One word without control characters: an event id as a receipt and the UNRESOLVED line can carry it. */
const EVENT_ID = /^[^\s\p{Cc}]{1,300}$/u;
const RECEIPT_FILE = /^\d+-[\w-]+\.json$/;
export const validEventId = (id: string): boolean => EVENT_ID.test(id);

export class ResolvedError extends Error {}

/** `kinds` as a policy whose only class is lead-urgent, so it matches exactly like eventPolicy (event-policy.ts). */
const tables = new WeakMap<readonly string[], EventPolicy>();
const table = (kinds: readonly string[]): EventPolicy => {
  let policy = tables.get(kinds);
  if (!policy) tables.set(kinds, policy = { default: "lead-digest", kinds: Object.fromEntries(kinds.map((kind) => [kind, "lead-urgent"])) });
  return policy;
};

/** `line` is a decision event under `kinds`. */
export const isDecision = (line: string, kinds: readonly string[]): boolean => eventClass(line, table(kinds)) === "lead-urgent";

/** `dori resolved <eventId>`'s receipt: written like `dori reported`'s (tmp, fsync, rename, both directories fsynced). */
export const recordResolved = (stateDir: string, id: string, at: number, note?: string): string => {
  if (!EVENT_ID.test(id)) throw new ResolvedError("usage: dori resolved <eventId> [<eventId> ...] [--note TEXT] (an event id)");
  const dir = join(stateDir, RESOLVED_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${at}-${randomUUID()}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ id, at, ...(note ? { note } : {}) }), { mode: 0o600, flush: true });
  renameSync(tmp, path);
  fsyncDir(dir);
  fsyncDir(stateDir);
  return path;
};

const fsyncDir = (dir: string): void => {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

const dropReceipt = (path: string): void => {
  try { unlinkSync(path); } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
};

export type ResolvedReceipt = { readonly path: string; readonly id: string; readonly at: number; readonly note?: string };

/** Receipts waiting for the supervisor; unreadable or malformed files are skipped (and never dropped). */
export const pendingResolved = (stateDir: string): ResolvedReceipt[] => {
  const dir = join(stateDir, RESOLVED_DIR);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((name) => RECEIPT_FILE.test(name)).flatMap((name) => {
    const path = join(dir, name);
    try {
      const { id, at, note } = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown; at?: unknown; note?: unknown };
      if (typeof id !== "string" || !EVENT_ID.test(id)) return [];
      return [{
        path, id, at: typeof at === "number" && Number.isFinite(at) ? at : statSync(path).mtimeMs,
        ...(typeof note === "string" && note ? { note } : {}),
      }];
    } catch { return []; }
  });
};

export const unresolved = (journal: Journal): Obligation[] => (journal.pending ?? []).filter((item) => item.resolvedAt === undefined);

export const resolveRule = (id: string): string => `decide and act on it, then run dori resolved ${id}`;

const windowMs = (core: JournalCore): number => core.deps.config.resolveTimeoutMin * 60_000;

/** Open obligations whose first window has passed: they keep a pushed lead pushed (supervise-push.ts). */
export const dueDecisions = (core: JournalCore, now: number): Obligation[] =>
  unresolved(core.journal).filter((item) => item.line !== undefined && now - item.since >= windowMs(core));

/** The first pointer that carried an obligation starts its escalation clock (as for lane outcomes). */
export const markDecisionsPushed = (core: JournalCore, ids: readonly string[], now: number): void => {
  const want = new Set(ids);
  if (!(core.journal.pending ?? []).some((item) => want.has(item.id) && item.pushedAt === undefined)) return;
  core.journal = { ...core.journal, pending: core.journal.pending?.map((item) => (want.has(item.id) && item.pushedAt === undefined ? { ...item, pushedAt: now } : item)) };
  core.persist();
};

/** One line per open obligation for the cold-restart handoff, empty when there is none. */
export const decisionHandoffLines = (journal: Journal): string[] => {
  const owed = unresolved(journal).filter((item) => item.line !== undefined);
  if (!owed.length) return [];
  return [
    "Decisions still open follow: for each, decide and act on it, then run dori resolved <eventId>.",
    ...owed.map((item) => `UNRESOLVED ${item.id} ${item.line ?? ""}`.trimEnd()),
  ];
};

type Published = { readonly id: string; readonly since: number; readonly line?: string };

/** The published open obligations (UNRESOLVED_FILE); empty when unreadable. */
export const publishedDecisions = (stateDir: string): Published[] => {
  let list: unknown;
  try { list = JSON.parse(readFileSync(join(stateDir, UNRESOLVED_FILE), "utf8")); } catch { return []; }
  return Array.isArray(list) ? list.filter((item: Partial<Published>) => typeof item?.id === "string" && EVENT_ID.test(item.id) && typeof item.since === "number") : [];
};

/** `dori inbox take`'s reminder lines (id<TAB>line, like the events) from the supervisor's published obligations. */
export const takeDecisionReminders = (stateDir: string): string[] =>
  publishedDecisions(stateDir).map((item) => `unresolved:${item.id}\tUNRESOLVED ${item.id} since ${new Date(item.since).toISOString()}: ${resolveRule(item.id)}`);

export class DecisionTracking {
  private published?: string;

  constructor(private readonly core: JournalCore, private readonly enqueue: (id: string, line: string) => void) {}

  private get journal(): Journal { return this.core.journal; }
  private set journal(journal: Journal) { this.core.journal = journal; }

  /**
   * A live decision event that reaches the lead opens its obligation; an id already known (open, resolved, or resolved
   * early by a receipt) opens nothing. The caller persists.
   */
  track(event: Event): void {
    const { config } = this.core.deps;
    if (!EVENT_ID.test(event.id) || !isDecision(event.line, config.resolveKinds) || !forLead(eventClass(event.line, config.eventPolicy))) return;
    const pending = this.journal.pending ?? [];
    const line = event.line.slice(0, OBLIGATION_LINE_MAX);
    const at = pending.findIndex((item) => item.id === event.id);
    if (at < 0) {
      this.journal = { ...this.journal, pending: [...pending, { id: event.id, since: event.at ?? this.core.deps.clock.now(), line }] };
      return;
    }
    // Resolved before it arrived: keep the line for the record, it stays closed.
    if ((pending[at] as Obligation).line === undefined) this.journal = { ...this.journal, pending: pending.map((item, i) => (i === at ? { ...item, line } : item)) };
  }

  /**
   * `dori resolved` receipts close their obligation; one naming no obligation yet is kept (resolved before its event
   * arrived, or a mistyped id: logged as unmatched), so that event opens nothing. Persisted before the receipts are
   * dropped: a replay only takes the earliest resolve time again.
   */
  consumeReceipts(): void {
    const receipts = pendingResolved(this.core.deps.config.stateDir);
    if (!receipts.length) return;
    const pending = [...(this.journal.pending ?? [])];
    for (const receipt of receipts) {
      const at = pending.findIndex((item) => item.id === receipt.id);
      const found = at < 0 ? undefined : pending[at];
      const note = found?.note ?? receipt.note;
      const next: Obligation = {
        ...(found ?? { id: receipt.id, since: receipt.at }),
        resolvedAt: Math.min(found?.resolvedAt ?? Infinity, receipt.at),
        ...(note ? { note } : {}),
      };
      if (at < 0) pending.push(next); else pending[at] = next;
      if (!found) console.log(`DECISION_RESOLVED_UNMATCHED ${receipt.id}`);
      else if (found.resolvedAt === undefined) console.log(`DECISION_RESOLVED ${receipt.id}`);
    }
    this.journal = { ...this.journal, pending };
    this.core.persist();
    for (const receipt of receipts) dropReceipt(receipt.path);
    this.publish();
  }

  /**
   * One pass: receipts first, then each open obligation past its window gets one urgent UNRESOLVED (the first after
   * resolveTimeoutMin, then after twice the previous wait, up to RESOLVE_REPEAT_MAX_MS). Nothing is reminded while a lead
   * restart runs: the new lead's handoff lists every open obligation. Resolved rows are dropped after RESOLVED_KEEP_MS.
   */
  tick(): void {
    this.consumeReceipts();
    if (this.journal.restart) return;
    const now = this.core.deps.clock.now();
    const window = windowMs(this.core);
    let changed = false;
    const pending: Obligation[] = [];
    for (const item of this.journal.pending ?? []) {
      if (item.resolvedAt !== undefined) {
        if (now - item.resolvedAt >= RESOLVED_KEEP_MS) changed = true;
        else pending.push(item);
        continue;
      }
      const reminders = item.reminders ?? 0;
      const wait = reminders === 0 ? window : Math.min(window * 2 ** (reminders - 1), Math.max(RESOLVE_REPEAT_MAX_MS, window));
      if (item.line === undefined || now - (item.remindedAt ?? item.since) < wait) { pending.push(item); continue; }
      this.enqueue(`unresolved:${item.id}:${reminders + 1}`, `UNRESOLVED ${item.id} ${item.line.slice(0, UNRESOLVED_LINE_MAX)}`);
      pending.push({ ...item, reminders: reminders + 1, remindedAt: now });
      changed = true;
    }
    if (changed) {
      this.journal = { ...this.journal, pending };
      this.core.persist("normal");
    }
    this.publish();
  }

  /** Writes UNRESOLVED_FILE when the open obligations changed (tmp + rename; it is derived, the store is the record). */
  publish(): void {
    const list: Published[] = unresolved(this.journal).filter((item) => item.line !== undefined).map(({ id, since, line }) => ({ id, since, line }));
    const text = JSON.stringify(list);
    if (text === this.published) return;
    const path = join(this.core.deps.config.stateDir, UNRESOLVED_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
    this.published = text;
  }
}
