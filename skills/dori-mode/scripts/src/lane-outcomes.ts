import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { redactSecrets } from "./redact.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { eventClass, forLead } from "./event-policy.ts";
import { unresolved } from "./decision-obligations.ts";
import type { Registry } from "./registry.ts";
import { discordThreadOf } from "./messenger/target.ts";
import { readCloseButtons, recordCloseButton, threadBlockers } from "./thread-finality.ts";
import { readOwnerClosed } from "./thread-followup.ts";
import { Waits } from "./waits.ts";
import type { Event, Journal, JournalCore, LaneOutcome } from "./supervise-journal.ts";

/**
 * Lane outcome reports: "a lane finished, so the owner is told", enforced the way owner messages are (ack, handled,
 * UNHANDLED). A lane claimed done (LANE_DONE_CLAIMED <key>) or finished (LANE_CLOSED <key>, or CI_MERGED ... lane=<key>)
 * opens one report obligation per lane key; a rejected claim (LANE_NOT_DONE, or the lead's `dori object-done`) drops the
 * obligation it opened while no real outcome has joined it. The lead tells the owner itself and then records
 * `dori reported <key>`, an immutable receipt the supervisor consumes.
 * An obligation still open after reportTimeoutMin comes back as urgent `UNREPORTED <key> ...`, re-sent with backoff; in
 * push mode it also keeps the lead pushed and counts toward the push escalation. The supervisor never posts the report.
 *
 * The obligation is also the lane's one finish record: a finish event that joins it with nothing new for the lead is
 * quiet and wakes no one (supervise-delivery.ts); it rides along with the next delivery. That is a claimed lane's first
 * CI_MERGED, or one at a PR head the row already saw merged: the claim already woke the lead, and the merge closes the
 * lane at once (done-flow.ts mergeConfirmed). A claim, a close and a merge at another PR head always wake.
 */

export const REPORTED_DIR = "reported";
/** The open obligations as the supervisor last saw them, for readers without its store (`dori inbox take`). */
export const UNREPORTED_FILE = "unreported.json";
/** Reminders after the first wait reportTimeoutMin, then twice as long each time, up to this. */
export const REPORT_REPEAT_MAX_MS = 60 * 60_000;
/** A reported outcome is kept this long, so a later outcome event of the same lane stays deduplicated. */
export const REPORTED_KEEP_MS = 7 * 24 * 60 * 60_000;
export const OUTCOME_LINE_MAX = 300;

const LANE_KEY = /^[\w.-]+$/;
const RECEIPT_FILE = /^\d+-[\w-]+\.json$/;

export class ReportedError extends Error {}

const CLAIM = "LANE_DONE_CLAIMED ";
const REJECTED = "LANE_NOT_DONE ";
const MERGED = "CI_MERGED ";

/** The PR head a `CI_MERGED ... head=<sha> ...` line names. */
const mergedHead = (line: string): string | undefined => (line.startsWith(MERGED) ? / head=(\S+)/.exec(line)?.[1] : undefined);

const keyOf = (lane: string | undefined): string | undefined => (lane && LANE_KEY.test(lane) ? lane : undefined);

/**
 * The lane an obligation-opening event names: a done claim `LANE_DONE_CLAIMED <key> ...`, or a finished lane
 * `LANE_CLOSED <key> ...` / `CI_MERGED ... lane=<key> ...`. A machine lane's LANE_AUTO_CLAIMED names none.
 */
export const outcomeLane = (line: string): string | undefined =>
  keyOf(line.startsWith("LANE_CLOSED ") || line.startsWith(CLAIM) ? line.split(" ")[1] : line.startsWith("CI_MERGED ") ? / lane=(\S+)/.exec(line)?.[1] : undefined);

/** The lane whose done claim was rejected: `LANE_NOT_DONE <key> ...`. */
export const rejectedLane = (line: string): string | undefined => keyOf(line.startsWith(REJECTED) ? line.split(" ")[1] : undefined);

const fsyncDir = (dir: string): void => {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

/**
 * Where `dori reported` posted the report: the message id and its target (`platform:to[/thread]`); `thread` is the id of
 * the lane's thread (its bound thread, else the thread the report went into), `button` that the post carried the owner's
 * close-thread button. `followUp` marks a post that is no new report in the thread (an edit appended to the last report,
 * or a line sent to the owner channel because the owner closed the thread): it never re-arms the thread's close button.
 */
export type ReportedPost = { readonly message: string; readonly target: string; readonly thread?: string; readonly button?: boolean; readonly followUp?: boolean };

/**
 * The lead's receipt that it told the owner about lane `lane`'s outcome: tmp, fsync, rename, then both directories.
 * `dori reported` writes it only after its post returned `posted.message`.
 */
export const recordReported = (stateDir: string, lane: string, at: number, note?: string, posted?: ReportedPost): string => {
  if (!LANE_KEY.test(lane)) throw new ReportedError("usage: dori reported <key> --text TEXT [--to TARGET] [--thread ID] [--note TEXT] (a lane key)");
  const dir = join(stateDir, REPORTED_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${at}-${randomUUID()}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lane, at, ...(note ? { note: redactSecrets(note) } : {}), ...(posted ? { message: posted.message, target: posted.target } : {}),
    ...(posted?.thread ? { thread: posted.thread } : {}), ...(posted?.button ? { button: true } : {}), ...(posted?.followUp ? { followUp: true } : {}) }), { mode: 0o600, flush: true });
  renameSync(tmp, path);
  fsyncDir(dir);
  fsyncDir(stateDir);
  return path;
};

/** `message` and `target` are absent in receipts written before `dori reported` posted the report itself. */
export type ReportedReceipt = {
  readonly path: string; readonly lane: string; readonly at: number; readonly note?: string; readonly message?: string; readonly target?: string;
  readonly thread?: string; readonly button?: true; readonly followUp?: true;
};

/** Receipts waiting for the supervisor; unreadable or malformed files are skipped (and never dropped). */
export const pendingReported = (stateDir: string): ReportedReceipt[] => {
  const dir = join(stateDir, REPORTED_DIR);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((name) => RECEIPT_FILE.test(name)).flatMap((name) => {
    const path = join(dir, name);
    try {
      const { lane, at, note, message, target, thread, button, followUp } = JSON.parse(readFileSync(path, "utf8")) as {
        lane?: unknown; at?: unknown; note?: unknown; message?: unknown; target?: unknown; thread?: unknown; button?: unknown; followUp?: unknown;
      };
      if (typeof lane !== "string" || !LANE_KEY.test(lane)) return [];
      return [{
        path, lane, at: typeof at === "number" && Number.isFinite(at) ? at : statSync(path).mtimeMs,
        ...(typeof note === "string" && note ? { note } : {}),
        ...(typeof message === "string" && message ? { message } : {}),
        ...(typeof target === "string" && target ? { target } : {}),
        ...(typeof thread === "string" && /^\d+$/.test(thread) ? { thread } : {}),
        ...(button === true ? { button: true as const } : {}),
        ...(followUp === true ? { followUp: true as const } : {}),
      }];
    } catch { return []; }
  });
};

const dropReported = (path: string): void => {
  try { unlinkSync(path); } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
};

export const unreported = (journal: Journal): LaneOutcome[] => (journal.outcomes ?? []).filter((outcome) => outcome.reportedAt === undefined);

export const reportRule = (lane: string): string => `run dori reported ${lane} --text TEXT to post the outcome to the owner in its thread`;

type Published = { readonly lane: string; readonly since: number; readonly line?: string };

/** `dori inbox take`'s reminder lines (id<TAB>line, like the events) from the supervisor's published obligations. */
export const takeReminders = (stateDir: string): string[] => {
  let list: unknown;
  try { list = JSON.parse(readFileSync(join(stateDir, UNREPORTED_FILE), "utf8")); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: Partial<Published>) => typeof item?.lane === "string" && LANE_KEY.test(item.lane) && typeof item.since === "number"
    ? [`unreported:${item.lane}\tUNREPORTED ${item.lane} since ${new Date(item.since).toISOString()}: ${reportRule(item.lane)}`]
    : []);
};

export class OutcomeTracking {
  private published?: string;

  constructor(private readonly core: JournalCore, private readonly enqueue: (id: string, line: string) => void) {}

  private get journal(): Journal { return this.core.journal; }
  private set journal(journal: Journal) { this.core.journal = journal; }
  private get windowMs(): number { return this.core.deps.tunables.reportTimeoutMin * 60_000; }

  /**
   * A live done claim or finished-lane event opens its lane's obligation; a later one of the same lane (the claim, then
   * its seen-claim close; CI_MERGED, then LANE_CLOSED) joins it, so one lane is one report. Only an event that reaches
   * the lead counts. A row opened by a claim stays marked `claim` until a real outcome joins it; LANE_NOT_DONE drops
   * such a row, reported or not, so the next claim is owed afresh. The caller persists.
   */
  track(event: Event): void {
    const rejected = rejectedLane(event.line);
    if (rejected) { this.dropClaim(rejected); return; }
    const lane = outcomeLane(event.line);
    if (!lane || !forLead(eventClass(event.line, this.core.deps.tunables.eventPolicy))) return;
    const outcomes = this.journal.outcomes ?? [];
    const at = outcomes.findIndex((outcome) => outcome.lane === lane);
    const line = event.line.slice(0, OUTCOME_LINE_MAX);
    const found = at < 0 ? undefined : outcomes[at];
    if (found?.events?.includes(event.id)) return;
    // Claim-only while every event in the row is a claim (a receipt-only row has none yet).
    const claim = event.line.startsWith(CLAIM) && (!found || found.claim === true || !found.events?.length);
    const head = mergedHead(event.line);
    const heads = found?.heads ?? [];
    // A merge after the claim (of the claimed head, or one already merged) adds nothing the lead must do now.
    const quiet = event.line.startsWith(MERGED) && found?.claimed === true && (!heads.length || (head !== undefined && heads.includes(head)));
    const { claim: _was, ...kept } = found ?? { lane, since: event.at ?? this.core.deps.clock.now() };
    const next: LaneOutcome = {
      ...kept, line: kept.line ?? line, events: [...(kept.events ?? []), event.id], ...(claim ? { claim } : {}),
      ...(event.line.startsWith(CLAIM) ? { claimed: true as const } : {}),
      ...(head && !heads.includes(head) ? { heads: [...heads, head] } : {}),
      ...(quiet ? { quiet: [...(kept.quiet ?? []), event.id] } : {}),
    };
    this.journal = { ...this.journal, outcomes: at < 0 ? [...outcomes, next] : outcomes.map((outcome, i) => (i === at ? next : outcome)) };
  }

  /** Drops `lane`'s row if a claim opened it and no real outcome joined it. */
  private dropClaim(lane: string): void {
    const outcomes = this.journal.outcomes ?? [];
    if (!outcomes.some((outcome) => outcome.lane === lane && outcome.claim)) return;
    this.journal = { ...this.journal, outcomes: outcomes.filter((outcome) => !(outcome.lane === lane && outcome.claim)) };
    console.log(`LANE_OUTCOME_CLAIM_DROPPED ${lane}`);
  }

  /**
   * `dori reported` receipts close their lane's obligation; one for a lane with none yet (reported before its outcome
   * event arrived) is kept, so that event opens nothing. Persisted before the receipts are dropped: a replay only takes
   * the earliest report time again. A repeat report of a lane into the same thread without a button keeps its last report
   * time, so it does not re-arm that thread's close button; new work in a thread runs under a new lane key. A follow-up
   * receipt (an appended edit, or a line sent to the owner channel for a closed thread) leaves the thread and its last
   * report time as they were. Receipts are taken in time order.
   */
  consumeReceipts(): void {
    const receipts = pendingReported(this.core.deps.config.stateDir).sort((a, b) => a.at - b.at);
    if (!receipts.length) return;
    const outcomes = [...(this.journal.outcomes ?? [])];
    for (const receipt of receipts) {
      const at = outcomes.findIndex((outcome) => outcome.lane === receipt.lane);
      const found = at < 0 ? undefined : outcomes[at];
      const note = found?.note ?? receipt.note;
      const thread = receipt.thread ?? found?.thread;
      const repeat = found?.lastReportAt !== undefined && receipt.thread === found.thread && !receipt.button;
      const next: LaneOutcome = {
        ...(found ?? { lane: receipt.lane, since: receipt.at }),
        reportedAt: Math.min(found?.reportedAt ?? Infinity, receipt.at),
        ...(note ? { note } : {}),
        ...(thread && !receipt.followUp ? { thread, lastReportAt: repeat ? found.lastReportAt : Math.max(found?.lastReportAt ?? -Infinity, receipt.at) } : {}),
      };
      // A --final report's button counts as the thread's close button: the supervisor posts none for that report.
      if (receipt.button && receipt.thread) recordCloseButton(this.core.deps.config.stateDir, receipt.thread, receipt.at);
      if (at < 0) outcomes.push(next); else outcomes[at] = next;
      if (found?.reportedAt === undefined) console.log(`LANE_OUTCOME_REPORTED ${receipt.lane}`);
    }
    this.journal = { ...this.journal, outcomes };
    this.core.persist();
    for (const receipt of receipts) dropReported(receipt.path);
    this.publish();
  }

  /** Event `id` joined its lane's finish record with nothing new for the lead: it must not wake it (supervise-delivery.ts). */
  quiet(id: string): boolean {
    return (this.journal.outcomes ?? []).some((outcome) => outcome.quiet?.includes(id));
  }

  /** Reminded obligations, or those past their first window: they keep a pushed lead pushed (supervise-push.ts). */
  due(now: number): LaneOutcome[] {
    return unreported(this.journal).filter((outcome) => (outcome.reminders ?? 0) > 0 || now - outcome.since >= this.windowMs);
  }

  /** The delivery log is the handoff boundary. Do not use a pane sample taken before this write as working evidence. */
  markDelivered(): void {
    if (this.journal.restart) return;
    const ready = (outcome: LaneOutcome) => outcome.reportedAt === undefined && outcome.deliveredAt === undefined &&
      outcome.events?.some((id) => this.core.delivered.has(id));
    if (!this.journal.outcomes?.some(ready)) return;
    const now = this.core.deps.clock.now();
    this.journal = { ...this.journal, outcomes: this.journal.outcomes.map((outcome) => ready(outcome) ? { ...outcome, deliveredAt: now } : outcome) };
    this.core.persist("normal");
  }

  /** The first pointer that carried an obligation starts its escalation clock (no escalation before a pointer, N1). */
  markPushed(lanes: readonly string[], now: number): void {
    const want = new Set(lanes);
    if (!(this.journal.outcomes ?? []).some((outcome) => want.has(outcome.lane) && outcome.pushedAt === undefined)) return;
    this.journal = {
      ...this.journal,
      outcomes: this.journal.outcomes?.map((outcome) => (want.has(outcome.lane) && outcome.pushedAt === undefined ? { ...outcome, pushedAt: now } : outcome)),
    };
    this.core.persist();
  }

  /**
   * One pass: receipts first, then one urgent UNREPORTED when a delivered turn ends (working observed after delivery,
   * then idle/done), or reportTimeoutMin passes. Later reminders back off up to REPORT_REPEAT_MAX_MS. A lane whose brief declared
   * `autoClose: machine` closes with no lead wake and owes no report. Nothing is reminded while a lead restart runs: the
   * published list is kept current, and the new lead's `dori inbox take` prints every open obligation. Reported rows are
   * dropped after REPORTED_KEEP_MS. A claim-only row is dropped once the registry holds an objection made at or after it
   * opened: `dori object-done` writes only the registry and is never an event.
   */
  async tick(registry: Pick<Registry, "read">, leadStatus?: () => Promise<string | undefined>): Promise<void> {
    this.consumeReceipts();
    if (this.journal.restart) { this.publish(); return; }
    const watching = (outcome: LaneOutcome) => outcome.reportedAt === undefined && outcome.deliveredAt !== undefined && !(outcome.reminders ?? 0);
    const status = leadStatus && this.journal.outcomes?.some(watching) ? await leadStatus() : undefined;
    // A receipt arriving during the pane lookup wins too.
    this.consumeReceipts();
    if (this.journal.restart) { this.publish(); return; }
    const now = this.core.deps.clock.now();
    const window = this.windowMs;
    let changed = false;
    const outcomes: LaneOutcome[] = [];
    for (let outcome of this.journal.outcomes ?? []) {
      const objection = outcome.claim ? (await registry.read(outcome.lane))?.objection : undefined;
      if (objection && Date.parse(objection.at) >= outcome.since) {
        console.log(`LANE_OUTCOME_CLAIM_DROPPED ${outcome.lane}`);
        changed = true;
        continue;
      }
      if (outcome.reportedAt !== undefined) {
        if (now - outcome.reportedAt >= REPORTED_KEEP_MS) changed = true;
        else outcomes.push(outcome);
        continue;
      }
      const reminders = outcome.reminders ?? 0;
      const turnEnded = watching(outcome) && outcome.deliveredWorking && (status === "idle" || status === "done");
      if (watching(outcome) && status === "working" && !outcome.deliveredWorking) {
        outcome = { ...outcome, deliveredWorking: true };
        changed = true;
      }
      const wait = reminders === 0 ? window : Math.min(window * 2 ** (reminders - 1), Math.max(REPORT_REPEAT_MAX_MS, window));
      if (!turnEnded && now - (outcome.remindedAt ?? outcome.since) < wait) { outcomes.push(outcome); continue; }
      if (reminders === 0 && (await registry.read(outcome.lane))?.autoClose === "machine") {
        outcomes.push({ ...outcome, reportedAt: now, note: "autoClose: machine" });
        changed = true;
        continue;
      }
      const minutes = Math.round((now - outcome.since) / 60_000);
      this.enqueue(`unreported:${outcome.lane}:${outcome.since}:${reminders + 1}`,
        `UNREPORTED ${outcome.lane} ${outcome.claim ? "claimed done" : "finished"} ${minutes} min ago and the owner has not been told: ${reportRule(outcome.lane)}. ${outcome.line ?? ""}`.trimEnd());
      outcomes.push({ ...outcome, reminders: reminders + 1, remindedAt: now });
      changed = true;
    }
    if (changed) {
      this.journal = { ...this.journal, outcomes };
      this.core.persist("normal");
    }
    this.publish();
  }

  /**
   * Posts the owner's close-thread button into each thread whose work is finished: a report into it was recorded after the
   * last close button there (from a --final report or from this tick), and threadBlockers finds nothing left on it. A
   * report for a lane that closed before that button is covered by it and re-arms nothing; one for a lane that closed
   * later (or has not closed yet) is new work. A thread the owner closed after its last report gets none: a post would
   * reopen it. Run
   * every pass, so it fires right after the last report or right after the last lane closes, whichever comes later. A
   * failed post is retried on the next pass; `post` gets a stable id per thread and report, so a retry is not doubled.
   */
  async closeButtonTick(registry: Pick<Registry, "open" | "read">, post: (thread: string, id: string) => Promise<void>): Promise<void> {
    const stateDir = this.core.deps.config.stateDir;
    const outcomes = this.journal.outcomes ?? [];
    const buttons = readCloseButtons(stateDir);
    const latest = new Map<string, number>();
    for (const outcome of outcomes) {
      if (outcome.thread === undefined || outcome.lastReportAt === undefined) continue;
      const button = buttons[outcome.thread];
      if (button !== undefined && outcome.lastReportAt > button) {
        const closedAt = (await registry.read(outcome.lane))?.closedAt;
        if (closedAt && Date.parse(closedAt) < button) continue;
      }
      latest.set(outcome.thread, Math.max(latest.get(outcome.thread) ?? -Infinity, outcome.lastReportAt));
    }
    const closed = readOwnerClosed(stateDir);
    const due = [...latest].filter(([thread, at]) => at > (buttons[thread] ?? -Infinity) && at > (closed[thread] ?? -Infinity));
    if (!due.length) return;
    const open = await registry.open();
    const waits = new Waits(stateDir).list();
    const decisions = unresolved(this.journal).map(({ id, line }) => ({ id, ...(line ? { line } : {}) }));
    // Unreported lanes have no receipt yet: their thread comes from the registry (an open lane, else the archive).
    const threadOf = new Map<string, string | undefined>();
    for (const outcome of unreported(this.journal)) {
      const bound = open.find((lane) => lane.key === outcome.lane)?.thread ?? (await registry.read(outcome.lane))?.thread;
      threadOf.set(outcome.lane, bound && bound !== "none" ? discordThreadOf(bound, this.core.deps.config.discordChannels) : undefined);
    }
    for (const [thread, at] of due) {
      const blockers = threadBlockers({
        thread, open, waits, decisions,
        lanes: outcomes.filter((outcome) => outcome.thread === thread).map((outcome) => outcome.lane),
        unreported: [...threadOf].filter(([, on]) => on === thread).map(([lane]) => lane),
      });
      if (blockers.length) continue;
      try { await post(thread, `close-button:${thread}:${at}`); }
      catch (e) { console.error(`CLOSE_BUTTON_FAILED ${thread}: ${e instanceof Error ? e.message : String(e)}`); continue; }
      recordCloseButton(stateDir, thread, this.core.deps.clock.now());
      console.log(`CLOSE_BUTTON_POSTED ${thread}`);
    }
  }

  /** Writes UNREPORTED_FILE when the open obligations changed (tmp + rename; it is derived, the store is the record). */
  publish(): void {
    const list: Published[] = unreported(this.journal).map(({ lane, since, line }) => ({ lane, since, ...(line ? { line } : {}) }));
    const text = JSON.stringify(list);
    if (text === this.published) return;
    const path = join(this.core.deps.config.stateDir, UNREPORTED_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
    this.published = text;
  }
}
