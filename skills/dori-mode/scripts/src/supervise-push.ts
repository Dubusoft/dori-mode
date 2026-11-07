import { randomUUID } from "node:crypto";

import { eventClass, eventKind } from "./event-policy.ts";
import { completeLines, parseLogLine } from "./inbox.ts";
import type { OutcomeTracking } from "./lane-outcomes.ts";
import { dueDecisions, markDecisionsPushed } from "./decision-obligations.ts";
import { type InputState, inputState as boxState, listPanes, type Pane, PASTE_PLACEHOLDER, readScreen, sendVerified, squash } from "./panes.ts";
import { type AwaitingAck, type Event, type InboxPush, type Journal, type JournalCore, type LaneOutcome, type Obligation, TransientSuperviseError } from "./supervise-journal.ts";
import { type LeadLifecycle, PAUSED } from "./supervise-lead-lifecycle.ts";
import { dueOwners, latest } from "./supervise-owner-tracking.ts";

/**
 * Push delivery. Every delivery pass ends here: events appended to lead-events.log but
 * not yet taken by the lead (`dori inbox take` receipts, or an ack/handled receipt for an owner message) get one short
 * `[dori]` pointer typed into the lead pane. Untaken past push.ackSec it is pushed again, later with backoff; an idle lead
 * that keeps ignoring it is cold-restarted after push.escalateMin, within the restart cap. A finished lane not reported
 * to the owner (`dori reported`) past reportTimeoutMin, an unacked owner message (or one still unhandled past its
 * handling window), and a decision event not resolved (`dori resolved`) past
 * resolveTimeoutMin, count like an untaken urgent event, taken or not. Event bodies are never typed: the lead reads them with `dori inbox take`.
 */

export const POINTER_PREFIX = "[dori] supervisor:";
export const POINTER_TAIL = "Not an owner message. Run dori inbox take, then continue your task.";
export const REPUSH_MAX_MS = 10 * 60_000;

type Untaken = { readonly id: string; readonly line: string; readonly meta?: { readonly lane?: string } };

/**
 * What the lead's input box holds: nothing, only our own pointer (or omo's paste placeholder for it), or anything else,
 * which may be the owner's text and is never typed into or submitted.
 */
export const inputState = (screen: string): InputState => boxState(screen, (text) =>
  (text.startsWith(squash(POINTER_PREFIX)) && text.endsWith(squash(POINTER_TAIL))) || PASTE_PLACEHOLDER.test(text));

/**
 * One ASCII line of at most `maxChars`: how many events wait, their kinds and the lanes they concern (each list cut to
 * `+N more` when too long, lanes first).
 */
export const pointerText = (total: number, urgent: boolean, kinds: readonly string[], maxChars: number, lanes: readonly string[] = []): string => {
  const counts = new Map<string, number>();
  for (const kind of kinds) {
    const clean = kind.replace(/[^\w*.:/ -]/g, "").trim() || "event";
    counts.set(clean, (counts.get(clean) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => (n > 1 ? `${kind} x${n}` : kind));
  const keys = [...new Set(lanes.map((lane) => lane.replace(/[^\w.:/-]/g, "")).filter(Boolean))];
  const cut = (items: readonly string[], shown: number): string =>
    [...items.slice(0, shown), ...(shown < items.length ? [`+${items.length - shown} more`] : [])].join(", ");
  const head = `${POINTER_PREFIX} ${total} new event${total === 1 ? "" : "s"}`;
  for (let shown = parts.length; shown >= 0; shown--) {
    for (let named = keys.length; named >= 0; named--) {
      const lanePart = keys.length ? `; lanes: ${cut(keys, named)}` : "";
      const text = `${head} (${urgent ? "urgent" : "digest"}: ${cut(parts, shown)}${lanePart}). ${POINTER_TAIL}`;
      if (text.length <= maxChars) return text;
    }
  }
  return `${head}. ${POINTER_TAIL}`.slice(0, maxChars);
};

export class PushDelivery {
  private scan?: { readonly from: number; scannedTo: number; readonly events: Untaken[] };
  private readonly logged = new Set<string>();
  /** Since when a working lead has had events due at this take cursor (in memory: a supervisor restart only delays it). */
  private working?: { readonly offset: number; readonly since: number };

  constructor(private readonly core: JournalCore, private readonly lead: LeadLifecycle, private readonly outcomes: OutcomeTracking) {}

  private get journal(): Journal { return this.core.journal; }
  private set journal(journal: Journal) { this.core.journal = journal; }

  private once(key: string, line: string): void {
    const id = `${this.journal.inbox?.takenOffset}:${key}`;
    if (this.logged.has(id)) return;
    this.logged.add(id);
    console.log(line);
  }

  /** Delivered lines past the take cursor; the log is read incrementally, from scratch only when the cursor moves. */
  private logPastCursor(from: number): readonly Untaken[] {
    if (this.scan?.from !== from) {
      this.scan = { from, scannedTo: from, events: [] };
      this.logged.clear();
    }
    const scan = this.scan;
    for (const line of completeLines(this.core.eventLog, scan.scannedTo)) {
      scan.events.push(parseLogLine(line.text));
      scan.scannedTo = line.end;
    }
    return scan.events;
  }

  /**
   * Ids the lead already has by a stronger receipt (F3a, N2, N3): owner tracking compacted or tombstoned, and an owner
   * message or edit enqueued at or before its ack or handled time. A delete is covered only while its message was never
   * acked: a delete of a message the lead is working on must reach it.
   */
  private covered(): (id: string, at: number | undefined) => boolean {
    const closed = this.core.closedSet();
    const owners = new Map<string, AwaitingAck>();
    for (const entry of this.journal.awaitingAck ?? []) for (const id of [entry.id, ...(entry.revisions ?? [])]) owners.set(id, entry);
    return (id, at) => {
      if (closed.has(id) || this.core.store.tombstoned(id)) return true;
      const entry = owners.get(id);
      if (!entry) return false;
      if (id.endsWith(":delete")) return entry.ackedAt === undefined;
      const by = Math.max(entry.ackedAt ?? -Infinity, entry.handledAt ?? -Infinity);
      return at === undefined ? by > -Infinity : at <= by;
    };
  }

  /** Re-push interval after `attempts` pushes: ackSec for the first retries + 1, then doubling up to REPUSH_MAX_MS (N7). */
  private interval(attempts: number): number {
    const { ackSec, retries } = this.core.deps.config.delivery.push;
    return Math.min(ackSec * 1000 * 2 ** Math.max(0, attempts - retries), Math.max(REPUSH_MAX_MS, ackSec * 1000));
  }

  private savePush(push: InboxPush | undefined): void {
    const inbox = this.journal.inbox;
    if (!inbox) return;
    this.journal = { ...this.journal, inbox: { ...inbox, push } };
    this.core.persist();
  }

  /**
   * The push step of one delivery pass. Returns true when it set a restart (the caller's loop carries it out). Makes no
   * herdr call while nothing untaken is due. A pointer that starts an idle lead's turn is a lead wake, unless this pass
   * already `woke` the lead (the pointer then belongs to that turn).
   */
  async tick(pending: readonly Event[], readPane = async (): Promise<Pane | undefined> =>
    (await listPanes(this.core.deps.run)).find((p) => p.pane_id === this.core.deps.config.leadPane), woke = false): Promise<boolean> {
    const { config, clock, run } = this.core.deps;
    const { delivery } = config;
    if (this.journal.restart) return false;
    // A take receipt written since the last pass moves the cursor before anything is decided.
    this.core.consumeTakes();
    const inbox = this.journal.inbox;
    if (!inbox) return false;
    const now = clock.now();
    const covered = this.covered();
    const past = this.logPastCursor(inbox.takenOffset);
    const want = new Set(past.map((event) => event.id));
    const at = new Map<string, number>();
    for (const event of this.journal.events) if (want.has(event.id) && event.at !== undefined) at.set(event.id, event.at);
    const push = inbox.push;
    const ageOf = (id: string): number => at.get(id) ?? push?.first ?? now;
    // A report receipt also covers its already-journaled reminders: they must not keep pushing a settled report.
    const reported = new Set(this.journal.outcomes?.filter((outcome) => outcome.reportedAt !== undefined).map((outcome) => outcome.lane));
    const untaken = past.filter((event) => !covered(event.id, at.get(event.id)) && !reported.has(/^UNREPORTED (\S+)/.exec(event.line)?.[1] ?? ""));
    const policy = config.eventPolicy;
    const urgent = untaken.filter((event) => eventClass(event.line, policy) === "lead-urgent");
    const overdue = untaken.filter((event) => eventClass(event.line, policy) !== "lead-urgent" &&
      now - ageOf(event.id) >= config.digestMaxDelayMin * 60_000 && !/^\S*_WARN\b/.test(event.line));
    // A finished lane the owner was not told about keeps the lead pushed until dori reported; its UNREPORTED line,
    // when still untaken, already stands for it in the pointer.
    const due = this.outcomes.due(now);
    const listed = new Set(untaken.flatMap((event) => /^UNREPORTED (\S+)/.exec(event.line)?.[1] ?? []));
    const owed = due.filter((outcome) => !listed.has(outcome.lane));
    // Likewise an open decision keeps it pushed until dori resolved; its own event or an UNRESOLVED line, when still
    // untaken, already stands for it.
    const decisions = dueDecisions(this.core, now);
    const named = new Set(untaken.flatMap((event) => [event.id, /^UNRESOLVED (\S+)/.exec(event.line)?.[1] ?? event.id]));
    const open = decisions.filter((item) => !named.has(item.id));
    const owners = dueOwners(this.core, now);
    const ownerIds = new Set(untaken.map((event) => event.id));
    const unlistedOwners = owners.filter((entry) => !ownerIds.has(latest(entry)) && !untaken.some((event) =>
      event.line.startsWith(`UNHANDLED ${entry.id.slice("discord:".length).replace(":", " ")} `)));
    if (!urgent.length && !overdue.length && !due.length && !decisions.length && !owners.length) return false;
    const pane = await readPane();
    if (!pane) throw new TransientSuperviseError(`lead pane ${config.leadPane} does not exist`);
    if (!pane.agent) return false;
    const status = pane.agent_status;
    const idle = status === "idle" || status === "done";
    const batch = push?.batch ?? randomUUID().slice(0, 8);
    if (idle && push) {
      const reason = this.escalation(urgent, push.first, now, ageOf, due, decisions, owners);
      if (reason) {
        if (!this.lead.capRefuses("push ladder")) {
          console.log(`LEAD_PUSH_ESCALATE ${config.leadPane} ${reason}`);
          // A safety restart: owner messages outrank the lead's running children, which it names in the log.
          await this.lead.noteRestart("push-escalate", reason, pane.cwd ?? config.defaultCwd);
          this.lead.setRestart({
            session: randomUUID(), events: pending.map(({ id, line }) => ({ id, line })), offset: this.core.logSize(),
            phase: "stopping", force: true, reason: `it did not take pushed events (${reason}), so the supervisor restarted it`,
          });
          return true;
        }
      }
    }
    // Blocked or unclassified: Enter could answer an approval dialog. A working lead gets the pointer only with toWorking,
    // once its due events waited ackSec at this take cursor (a lead about to finish its turn gets it idle), and only
    // into an empty input box (the input check below never types over other text).
    const working = status === "working" && delivery.push.toWorking;
    if (!working) this.working = undefined;
    if (!idle && !working) return false;
    if (working) {
      if (this.working?.offset !== inbox.takenOffset) this.working = { offset: inbox.takenOffset, since: now };
      if (now - this.working.since < delivery.push.ackSec * 1000) return false;
    }
    // A take permits the next urgent batch immediately, without erasing an unfinished owner's escalation clock.
    if (push && now - push.at < this.interval(push.attempts) && !(inbox.takenOffset >= push.upto && urgent.length)) return false;
    if (push && push.attempts > delivery.push.retries && !push.untakenLogged) {
      console.log(`LEAD_PUSH_UNTAKEN ${batch} ${untaken.length + owed.length + open.length + unlistedOwners.length} event(s) after ${push.attempts} pushes`);
      this.savePush({ ...push, untakenLogged: true });
    }
    const first = push?.first ?? now;
    const attempts = push?.attempts ?? 0;
    const upto = this.core.logSize();
    this.outcomes.markPushed(due.map((outcome) => outcome.lane), now);
    markDecisionsPushed(this.core, decisions.map((item) => item.id), now);
    const screen = await readScreen(run, config.leadPane);
    const input = inputState(screen);
    const total = untaken.length + owed.length + open.length + unlistedOwners.length;
    const pressing = urgent.length || owed.length || open.length || unlistedOwners.length;
    const kinds = pressing
      ? [...urgent.map((event) => eventKind(event.line, policy)), ...owed.map(() => "UNREPORTED"), ...open.map(() => "UNRESOLVED"),
        ...unlistedOwners.map((entry) => entry.ackedAt === undefined ? "INBOUND" : "UNHANDLED")]
      : overdue.map((event) => eventKind(event.line, policy));
    // The lanes the pointed-at events concern, so the lead knows whose results to read before it takes them.
    const lanes = [...(pressing ? urgent : overdue).flatMap((event) => event.meta?.lane ?? /^UNREPORTED (\S+)/.exec(event.line)?.[1] ?? []),
      ...owed.map((outcome) => outcome.lane)];
    if (input === "busy") {
      // Not typed into (it may be the owner's text); the escalation clock still starts.
      this.once("busy", `LEAD_PUSH_INPUT_BUSY ${config.leadPane} ${batch}: its input line holds other text; not typing`);
      this.savePush({ at: now, upto, attempts, batch, first, ...(this.journal.inbox?.push?.untakenLogged ? { untakenLogged: true as const } : {}) });
      return false;
    }
    const pointer = pointerText(total, urgent.length > 0 || owed.length > 0 || open.length > 0 || owners.length > 0, kinds, delivery.push.maxChars, lanes);
    const next: InboxPush = { at: now, upto, attempts: attempts + 1, batch, first, ...(this.journal.inbox?.push?.untakenLogged ? { untakenLogged: true as const } : {}) };
    if (input === "ours") {
      // Our own pointer still sits unsubmitted: one Enter submits it, nothing is typed again.
      this.savePush(next);
      await run(["herdr", "pane", "send-keys", config.leadPane, "enter"]);
      console.log(`LEAD_PUSH_ENTER_RETRY ${config.leadPane} ${batch}`);
      return false;
    }
    if (PAUSED.test(screen)) console.log(`LEAD_RESUMED ${config.leadPane} ${await sendVerified(run, clock, config.leadPane, "/resume")}`);
    // Persisted before the send: a crash mid-send re-pushes at most once, and a take is idempotent.
    this.savePush(next);
    // The pointer's input line is read back below, after pasteCheckMs.
    const sent = await sendVerified(run, clock, config.leadPane, pointer, false);
    console.log(`LEAD_PUSH ${batch} ${total} ${kinds.join(",")} ${sent} attempt=${next.attempts}`);
    if (sent === "delivered") {
      if (idle && !woke) this.core.wakes.recordKinds(this.lead.warmSession, kinds);
      // sendVerified already observed the post-handoff transition to working; do not poll the pane again.
      await this.outcomes.tick(this.core.deps.registry, async () => "working");
      return false;
    }
    await clock.sleep(delivery.push.pasteCheckMs);
    const after = inputState(await readScreen(run, config.leadPane));
    if (after === "ours") {
      await run(["herdr", "pane", "send-keys", config.leadPane, "enter"]);
      console.log(`LEAD_PUSH_ENTER_RETRY ${config.leadPane} ${batch}`);
    } else if (after === "busy") this.once("busy", `LEAD_PUSH_INPUT_BUSY ${config.leadPane} ${batch}: its input line holds other text after the push`);
    return false;
  }

  /**
   * Why an idle lead is escalated, or undefined. With the tail monitor on, only an owner message readable and unacked
   * for escalateMin counts (a lead reading the tail never needs to take). Without it, any untaken urgent event counts,
   * clocked from the latest of its enqueue time, the lead's start and the first push attempt (N1): a new lead is never
   * escalated before it got a pointer and escalateMin passed. So does a due unreported lane outcome, clocked from the
   * latest of its due time, the lead's start and the first pointer that carried it; and a due open decision, alike.
   */
  private escalation(
    urgent: readonly Untaken[], first: number, now: number, ageOf: (id: string) => number, owed: readonly LaneOutcome[], decisions: readonly Obligation[],
    owners: readonly AwaitingAck[],
  ): string | undefined {
    const { delivery } = this.core.deps.config;
    const limit = delivery.push.escalateMin * 60_000;
    const minutes = (since: number): number => Math.round((now - since) / 60_000);
    const ownerSince = (entry: AwaitingAck): number => Math.max(
      entry.ackedAt === undefined ? entry.since ?? now :
        Math.min(entry.unhandledRemindedAt ?? Infinity, (entry.handlingSince ?? entry.ackedAt) + this.core.deps.config.handledTimeoutMin * 60_000),
      this.journal.inbox?.sessionSince ?? 0, first);
    const overdueOwners = owners.filter((entry) => now - ownerSince(entry) >= limit);
    const ownerReason = overdueOwners.length
      ? `${overdueOwners.length} owner message(s) not handled for ${minutes(Math.min(...overdueOwners.map(ownerSince)))} min` : undefined;
    if (delivery.tailMonitor) {
      const unacked = (this.journal.awaitingAck ?? []).filter((entry) => !entry.quarantined && entry.ackedAt === undefined &&
        entry.handledAt === undefined && entry.since !== undefined && this.core.delivered.has(latest(entry)));
      const since = Math.min(...unacked.map((entry) => entry.since ?? now));
      return unacked.length && now - since >= limit && now - first >= limit ? `${unacked.length} owner message(s) unacked for ${minutes(since)} min` : ownerReason;
    }
    const start = (id: string): number => Math.max(ageOf(id), this.journal.inbox?.sessionSince ?? 0, first);
    const stale = urgent.filter((event) => now - start(event.id) >= limit);
    const window = this.core.deps.config.reportTimeoutMin * 60_000;
    const owedSince = (outcome: LaneOutcome): number =>
      Math.max(outcome.since + window, this.journal.inbox?.sessionSince ?? 0, outcome.pushedAt ?? Infinity);
    const late = owed.filter((outcome) => now - owedSince(outcome) >= limit);
    const resolveWindow = this.core.deps.config.resolveTimeoutMin * 60_000;
    const openSince = (item: Obligation): number =>
      Math.max(item.since + resolveWindow, this.journal.inbox?.sessionSince ?? 0, item.pushedAt ?? Infinity);
    const undecided = decisions.filter((item) => now - openSince(item) >= limit);
    const reasons = [
      ...(ownerReason ? [ownerReason] : []),
      ...(stale.length ? [`${stale.length} urgent event(s) untaken for ${minutes(Math.min(...stale.map((event) => start(event.id))))} min`] : []),
      ...(late.length ? [`${late.length} finished lane(s) not reported to the owner for ${minutes(Math.min(...late.map(owedSince)))} min`] : []),
      ...(undecided.length ? [`${undecided.length} decision(s) not resolved for ${minutes(Math.min(...undecided.map(openSince)))} min`] : []),
    ];
    return reasons.length ? reasons.join(", ") : undefined;
  }
}
