import { createHash } from "node:crypto";

import {
  type AnswerDelivery, type AnswerRevision, type DecisionTarget, type DecisionsFile, decisionTargetOf, type DeliveryState, type OwnerDecision,
  OwnerDecisionError, patchOne, readDecisions, sameTarget, type TargetLane, updateDecisions,
} from "./decision-store.ts";
import { type LaneMessage, type LaneMessageStore, queueLaneMessage, updateLaneMessage } from "./lane-messages.ts";
import { RUNNER_LANE_CLI } from "./launch-footer.ts";
import { choiceLabel, closeOwnerDecision, short, syncDecisionButtons, type TickDeps } from "./owner-decisions.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import { errLine } from "./line-text.ts";

/*
 * Decision answers straight to the lane (references/messaging.md): the store side. Each direct answer is an answer
 * revision pinned to the target the decision recorded when it opened, carrying its delivery intent; the lane message
 * `decision-d<ID>-r<n>` is queued under DECISIONS_LOCK right after the intent is recorded. The two stores are not one
 * transaction: reconcileDecisionDeliveries compares intent, queue, ack and close after a restart and repairs the gap
 * without typing anything twice. Classifying an inbound owner message and calling recordAnswerRevision, typing the
 * message into the pane, and closing the decision on the lane's ack belong to their callers.
 */

/** The lane message id of revision `rev` of decision `id`: `decision-d17-r1`. */
export const decisionMessageId = (id: string, rev: number): string => `decision-${id}-r${rev}`;

/** The hash an answer revision keeps of the owner's text (whitespace-trimmed), so the same text seen twice is one revision. */
export const answerContentHash = (content: string): string => createHash("sha256").update(content.trim()).digest("hex").slice(0, 16);

export type AnswerInput = {
  readonly channel: string;
  readonly message: string;
  /** The owner message's edit revision: 0 as first posted, then one more per edit (a delete is its last revision). */
  readonly edit: number;
  /** The message text as seen (empty for a delete). */
  readonly content: string;
  /** The chosen option; absent withdraws the answer this message gave. */
  readonly choice?: number;
  /** The target the caller checked the lane against when the message came in. */
  readonly target: DecisionTarget;
};

export type RevisionResult =
  | { readonly kind: "recorded"; readonly decision: OwnerDecision; readonly revision: AnswerRevision; readonly replaced?: AnswerRevision }
  | { readonly kind: "duplicate"; readonly decision: OwnerDecision; readonly revision: AnswerRevision }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Records one direct answer revision and its delivery intent (`intended`, lane message `decision-d<ID>-r<n>`) under
 * DECISIONS_LOCK. The same owner message at an edit already recorded, or unchanged text, is a duplicate (gateway and
 * REST catch-up both see it). Refused, recording nothing: an unknown, closed or lead decision, a request, a decision
 * opened before targets were recorded, a choice out of range, a target that is no longer the decision's, a withdrawal
 * with no live answer from that message. A new revision supersedes the intents of older ones not yet acked; the queue
 * side follows in queueDecisionAnswer.
 */
export const recordAnswerRevision = (stateDir: string, id: string, input: AnswerInput, now: number): RevisionResult =>
  updateDecisions(stateDir, (file): { file?: DecisionsFile; result: RevisionResult } => {
    const d = file.decisions.find((x) => x.id === id);
    const refuse = (reason: string) => ({ result: { kind: "refused" as const, reason } });
    if (!d) return refuse("unknown decision");
    if (d.state === "closed" || d.state === "posting") return refuse(`decision is ${d.state}`);
    if (d.source !== "lane" || d.kind === "request") return refuse("not a lane decision");
    if (!d.target) return refuse("decision has no recorded target");
    if (!sameTarget(d.target, input.target)) return refuse("target changed since the question was asked");
    if (input.choice !== undefined && (!Number.isInteger(input.choice) || input.choice < 1 || input.choice > d.options.length)) return refuse(`choice must be 1-${d.options.length}`);
    const revisions = d.revisions ?? [];
    const hash = answerContentHash(input.content);
    const ofMessage = revisions.filter((r) => r.channel === input.channel && r.message === input.message);
    const seen = ofMessage.find((r) => r.edit === input.edit) ?? (ofMessage.at(-1)?.hash === hash ? ofMessage.at(-1) : undefined);
    if (seen) return { result: { kind: "duplicate" as const, decision: d, revision: seen } };
    const last = revisions.at(-1);
    if (input.choice === undefined && (last?.choice === undefined || last.channel !== input.channel || last.message !== input.message)) return refuse("no live answer from this message to withdraw");
    const rev = (last?.rev ?? 0) + 1;
    const revision: AnswerRevision = {
      rev, channel: input.channel, message: input.message, edit: input.edit, hash, ...(input.choice !== undefined ? { choice: input.choice } : {}),
      target: d.target, at: now, delivery: { id: decisionMessageId(d.id, rev), state: "intended", updatedAt: now },
    };
    const older = revisions.map((r): AnswerRevision => (r.delivery.state === "intended" || r.delivery.state === "queued"
      ? { ...r, delivery: { ...r.delivery, state: "superseded", updatedAt: now, reason: `replaced by r${rev}` } } : r));
    const next: OwnerDecision = { ...d, revisions: [...older, revision] };
    return { file: { ...file, decisions: file.decisions.map((x) => (x.id === id ? next : x)) }, result: { kind: "recorded" as const, decision: next, revision, ...(last ? { replaced: last } : {}) } };
  });

/** States in which a lane message may have reached the lane. */
export const reachedLane = (m: LaneMessage | undefined): boolean => m?.state === "delivered" || m?.state === "acked";

/**
 * The lane message of revision `r`: the answer; a correction naming the revision it replaces when `replaces` (a revision
 * that may have reached the lane) is given; a withdrawal when `r` has no choice. The ack command is the `dori` the lane
 * runs: a lane on a worker has only the runner's own CLI, never a `dori` on PATH (launch-footer.ts laneCli).
 */
export const decisionAnswerText = (d: OwnerDecision, r: AnswerRevision, replaces?: number): string => {
  const q = short(d.question, 120);
  const ack = `Confirm with: ${r.target.runner === LOCAL_RUNNER ? "dori" : RUNNER_LANE_CLI} report ack ${r.delivery.id}`;
  if (r.choice === undefined) return `[dori] Owner withdrew the answer to ${d.id} (${q}). Revision r${r.rev} replaces r${replaces ?? r.rev - 1}: do not act on that answer; the question is open again. ${ack}`;
  const picked = `${r.choice}. ${short(d.options[r.choice - 1] ?? "", 120)}`;
  if (replaces !== undefined) return `[dori] Owner changed the answer to ${d.id} (${q}): ${picked}. Revision r${r.rev} replaces r${replaces}; follow r${r.rev}. ${ack}`;
  return `[dori] Owner answered ${d.id} (${q}): ${picked}. Revision r${r.rev}. ${ack}`;
};

export type QueueOutcome =
  | { readonly kind: "queued"; readonly message: LaneMessage; readonly replaces?: number }
  | { readonly kind: "cancelled" | "superseded"; readonly reason: string }
  | { readonly kind: "none" };

const withDelivery = (d: OwnerDecision, rev: number, patch: Omit<AnswerDelivery, "id">): OwnerDecision => ({
  ...d, revisions: (d.revisions ?? []).map((r) => (r.rev === rev ? { ...r, delivery: { id: r.delivery.id, ...patch } } : r)),
});

/**
 * Queues the newest revision's lane message when its intent is still `intended`, under DECISIONS_LOCK (the lane message
 * store takes its own lock inside it; nothing takes them the other way round). Older revisions' messages still queued
 * are superseded first; when one may have reached the lane, the new message is a correction (or a withdrawal) naming
 * it. A withdrawal nothing reached is cancelled with no message. A closed decision supersedes the intent. The lane
 * message id is fixed per revision, so a repeat after a crash finds the queued message instead of adding one.
 */
export const queueDecisionAnswer = (stateDir: string, store: LaneMessageStore, id: string, now: number): QueueOutcome =>
  updateDecisions(stateDir, (file): { file?: DecisionsFile; result: QueueOutcome } => {
    const d = file.decisions.find((x) => x.id === id);
    const r = d?.revisions?.at(-1);
    if (!d || !r || r.delivery.state !== "intended") return { result: { kind: "none" } };
    const save = (next: OwnerDecision) => ({ ...file, decisions: file.decisions.map((x) => (x.id === id ? next : x)) });
    if (d.state === "closed") {
      const reason = "decision closed";
      return { file: save(withDelivery(d, r.rev, { state: "superseded", updatedAt: now, reason })), result: { kind: "superseded", reason } };
    }
    let replaces: number | undefined;
    for (const older of (d.revisions ?? []).slice(0, -1)) {
      const m = store.get(older.delivery.id);
      if (m?.state === "queued") updateLaneMessage(store, m, { state: "superseded", blocked: `replaced by r${r.rev}` }, now);
      else if (reachedLane(m)) replaces = older.rev;
    }
    if (r.choice === undefined && replaces === undefined) {
      const reason = "withdrawn before anything reached the lane";
      return { file: save(withDelivery(d, r.rev, { state: "cancelled", updatedAt: now, reason })), result: { kind: "cancelled", reason } };
    }
    const message = queueLaneMessage(store, now, { id: r.delivery.id, lane: r.target.lane, subject: `decision:${d.id}`, text: decisionAnswerText(d, r, replaces) });
    return { file: save(withDelivery(d, r.rev, { state: "queued", updatedAt: now })), result: { kind: "queued", message, ...(replaces !== undefined ? { replaces } : {}) } };
  });

export type ReconcileAction = {
  readonly decision: string;
  readonly rev: number;
  /** What was repaired: queued (an intent without its message), recorded (the message existed), acked, closed, undelivered, queue-superseded. */
  readonly action: "queued" | "recorded" | "acked" | "closed" | "undelivered" | "queue-superseded";
  readonly message: string;
  readonly lane: string;
  readonly reason?: string;
};

/** The log line of one reconcile action. */
export const reconcileLine = (a: ReconcileAction): string =>
  `DECISION_DELIVERY_RECONCILED ${a.decision} r${a.rev} ${a.action} ${a.message} lane=${a.lane}${a.reason ? `: ${a.reason}` : ""}`;

/** The lead's event for an answer whose lane session is gone: the lead takes it over (messaging.md, Failures). */
export const undeliveredLine = (a: ReconcileAction): string =>
  `DECISION_ANSWER_UNDELIVERED ${a.lane} ${a.decision} r${a.rev} ${a.message}: ${a.reason ?? "not delivered"}; take the answer over with dori decision close ${a.decision}`;

/**
 * Repairs the gap between decisions.json and the lane message store after a restart: for every revision whose intent
 * is not final, an acked lane message marks it acked; a closed decision supersedes it (and its queued message); a target
 * missing from `lanes` (the open lanes' current targets) or no longer equal marks it undelivered and supersedes a queued
 * message; an `intended` newest revision is queued (queueDecisionAnswer), or recorded as queued when its message already
 * exists; a `queued` intent whose message is gone is undelivered, never queued again. A final intent whose message is
 * still queued has that message superseded. Returns what it changed.
 */
export const reconcileDecisionDeliveries = (stateDir: string, store: LaneMessageStore, lanes: ReadonlyMap<string, DecisionTarget>, now: number): ReconcileAction[] => {
  const actions: ReconcileAction[] = [];
  for (const d of readDecisions(stateDir).decisions) {
    const revisions = d.revisions ?? [];
    for (const r of revisions) {
      const note = (action: ReconcileAction["action"], reason?: string): void => {
        actions.push({ decision: d.id, rev: r.rev, action, message: r.delivery.id, lane: r.target.lane, ...(reason ? { reason } : {}) });
      };
      const settle = (state: DeliveryState, reason?: string): void => {
        updateDecisions(stateDir, (file) => {
          const x = file.decisions.find((y) => y.id === d.id);
          const cur = x?.revisions?.find((y) => y.rev === r.rev);
          if (!x || !cur || cur.delivery.state !== r.delivery.state) return { result: undefined };
          return { file: { ...file, decisions: file.decisions.map((y) => (y.id === d.id ? withDelivery(x, r.rev, { state, updatedAt: now, ...(reason ? { reason } : {}) }) : y)) }, result: undefined };
        });
      };
      const m = store.get(r.delivery.id);
      const supersedeQueued = (why: string): void => { if (m?.state === "queued") updateLaneMessage(store, m, { state: "superseded", blocked: why }, now); };
      const state = r.delivery.state;
      if (state === "acked") continue;
      if (state !== "intended" && state !== "queued") {
        if (m?.state === "queued") { supersedeQueued(r.delivery.reason ?? state); note("queue-superseded", r.delivery.reason ?? state); }
        continue;
      }
      if (m?.state === "acked") { settle("acked"); note("acked"); continue; }
      if (d.state === "closed") { supersedeQueued("decision closed"); settle("superseded", "decision closed"); note("closed", "decision closed"); continue; }
      const current = lanes.get(r.target.lane);
      if (!current || !sameTarget(r.target, current) || m?.state === "superseded") {
        const reason = !current ? `lane ${r.target.lane} is closed`
          : !sameTarget(r.target, current) ? `lane ${r.target.lane} was relaunched, replaced or moved`
          : m?.blocked ?? `lane ${r.target.lane} is closed`;
        supersedeQueued(reason); settle("undelivered", reason); note("undelivered", reason); continue;
      }
      if (state === "queued") {
        if (!m) { const reason = "its lane message is missing from the queue"; settle("undelivered", reason); note("undelivered", reason); }
        continue;
      }
      if (m) { settle("queued"); note("recorded"); continue; }
      if (r !== revisions.at(-1)) { settle("superseded", "a newer revision exists"); continue; }
      const queued = queueDecisionAnswer(stateDir, store, d.id, now);
      if (queued.kind === "queued") note("queued");
    }
  }
  return actions;
};

/**
 * The supervisor's start: reconcileDecisionDeliveries against the open lanes, each change logged, then one
 * DECISION_ANSWER_UNDELIVERED per open decision whose newest revision is undelivered, under a stable id (the journal
 * dedupes it, so a crash between the reconcile and the enqueue is repaired by the next start).
 */
export const reconcileDecisionsAtStart = async (
  stateDir: string, store: LaneMessageStore, openLanes: readonly TargetLane[], now: number,
  enqueue: (id: string, line: string) => unknown, log: (line: string) => void,
): Promise<void> => {
  const lanes = new Map(openLanes.map((l) => [l.key, decisionTargetOf(l)] as const));
  for (const a of reconcileDecisionDeliveries(stateDir, store, lanes, now)) log(reconcileLine(a));
  for (const d of readDecisions(stateDir).decisions) {
    const r = d.revisions?.at(-1);
    if (d.state === "closed" || r?.delivery.state !== "undelivered") continue;
    await enqueue(`decision-undelivered:${d.id}:r${r.rev}`, undeliveredLine({
      decision: d.id, rev: r.rev, action: "undelivered", message: r.delivery.id, lane: r.target.lane, ...(r.delivery.reason ? { reason: r.delivery.reason } : {}),
    }));
  }
};

const DECISION_MESSAGE_ID = /^decision-(d\d+)-r(\d+)$/;

/**
 * Why decision answer `message` must not be typed into `lane` now (the check right before each delivery attempt), or
 * undefined: its decision is closed or gone, its revision is no longer the newest live one, or `lane` is no longer the
 * session that asked (relaunched, replaced or moved). Any other lane message is never refused here.
 */
export const decisionDeliveryRefusal = (stateDir: string, message: Pick<LaneMessage, "id">, lane: TargetLane): string | undefined => {
  const m = DECISION_MESSAGE_ID.exec(message.id);
  if (!m) return undefined;
  const d = readDecisions(stateDir).decisions.find((x) => x.id === m[1]);
  const r = d?.revisions?.find((x) => x.rev === Number(m[2]));
  if (!d || !r) return "its decision is no longer recorded";
  if (d.state === "closed") return "decision closed";
  if (r !== d.revisions?.at(-1) || r.delivery.state !== "queued") return `revision r${r.rev} is no longer the one to deliver (${r.delivery.state})`;
  if (!sameTarget(r.target, decisionTargetOf(lane))) return `lane ${lane.key} was relaunched, replaced or moved`;
  return undefined;
};

/**
 * The owner's `[System]` status line for newest revision `r` of `d` (references/messaging.md, Owner-facing notices), or
 * undefined when there is none to show (a close or a newer revision took over). `m` is its lane message; `corrects`
 * says an older revision may have reached the lane.
 */
export const decisionNoticeText = (d: OwnerDecision, r: AnswerRevision, m: LaneMessage | undefined, corrects: boolean): string | undefined => {
  const head = `[System] ${d.id}:`;
  const lane = r.target.lane;
  switch (r.delivery.state) {
    case "acked": return r.choice === undefined ? `${head} 레인 ${lane}이 답 취소를 받았습니다. 질문은 다시 열려 있습니다.` : `${head} 레인 ${lane}이 ${r.choice}번을 받았습니다.`;
    case "undelivered": return `${head} 레인 ${lane}이 종료되거나 바뀌어 전달하지 못했습니다. 리드가 이어받습니다.`;
    case "cancelled": return `${head} 답을 취소했습니다. 질문은 다시 열려 있습니다.`;
    case "superseded": return undefined;
    default: break;
  }
  if (r.choice === undefined) return `${head} 답을 취소했다고 레인 ${lane}에 알렸습니다.`;
  if (corrects) return `${head} 레인 ${lane}에 정정(${r.choice}번)을 보냈습니다.`;
  if (m?.state === "delivered") return `${head} ${r.choice}번을 레인 ${lane}에 전달했습니다. 레인의 수신 확인을 기다립니다.`;
  const recorded = `${head} ${r.choice}번으로 ${r.rev > 1 ? "바꿔 " : ""}기록했습니다.`;
  return m?.blocked ? `${recorded} 레인 ${lane}이 받을 수 있게 되면 전달합니다.` : `${recorded} 레인 ${lane}에 전달하는 중입니다.`;
};

/** The owner "message" of an answer-button click (decision-inbound.ts routeDecisionClick): one per interaction. */
export const clickMessageId = (interaction: string): string => `click:${interaction}`;

/** ` via button` when revision `r` came from an answer button, else nothing. */
export const viaButton = (r: Pick<AnswerRevision, "message">): string => (r.message.startsWith(clickMessageId("")) ? " via button" : "");

/** The lead's digest line once the lane acked a direct answer and its decision closes. */
export const ackedLine = (d: OwnerDecision, r: AnswerRevision): string =>
  `DECISION_ANSWER_ACKED ${r.target.lane} ${d.id} r${r.rev} ${r.choice === undefined ? "choice=-" : choiceLabel(d, r.choice)} ${r.delivery.id}${viaButton(r)}: the lane confirmed it received the answer; the decision closes, nothing to do`;

/** A revision that still moves (its notice may change, its ack may close the decision). */
const live = (d: OwnerDecision): boolean => d.state !== "closed" && d.state !== "posting" && !!d.revisions?.length;

/**
 * The supervisor's pass over direct answers, every delivery round (decision-inbound.ts queues them, ci-follow.ts types
 * them). In order: reconcileDecisionDeliveries against the open lanes (a lane message the lane acked marks its revision
 * acked; one superseded because its lane closed or changed marks it undelivered), each change logged, and one
 * DECISION_ANSWER_UNDELIVERED for a newest revision it just found undelivered; the owner's `[System]` status message per
 * decision, posted once (stable id `decision-notice:<id>`) and edited as the answer moves; its answer buttons edited to
 * show the chosen option, all disabled once the answer is acked or undelivered (syncDecisionButtons); then a newest revision
 * acked with a choice closes its decision as `dori decision close` would (choice, confirmation, archive, link line),
 * after DECISION_ANSWER_ACKED (digest) under a stable id. Every step reads its state back from decisions.json and the
 * lane message store, so a pass cut short by a crash or a failed post is finished by a later one. `lanes` is read only
 * when a direct answer is still moving.
 */
export const decisionDeliveryTick = async (deps: TickDeps, store: LaneMessageStore, lanes: () => Promise<readonly TargetLane[]>): Promise<void> => {
  const { stateDir } = deps.config;
  const log = deps.log ?? console.error;
  if (!readDecisions(stateDir).decisions.some(live)) return;
  const now = deps.now();
  const targets = new Map((await lanes()).map((l) => [l.key, decisionTargetOf(l)] as const));
  for (const a of reconcileDecisionDeliveries(stateDir, store, targets, now)) {
    log(reconcileLine(a));
    if (a.action !== "undelivered") continue;
    const d = readDecisions(stateDir).decisions.find((x) => x.id === a.decision);
    if (d && d.state !== "closed" && d.revisions?.at(-1)?.rev === a.rev) await deps.enqueue(`decision-undelivered:${a.decision}:r${a.rev}`, undeliveredLine(a));
  }
  for (const d of readDecisions(stateDir).decisions.filter(live)) {
    const revisions = d.revisions ?? [];
    const r = revisions.at(-1);
    if (!r || !d.thread) continue;
    const corrects = revisions.slice(0, -1).some((o) => reachedLane(store.get(o.delivery.id)));
    const text = decisionNoticeText(d, r, store.get(r.delivery.id), corrects);
    if (text && text !== d.notice?.text) {
      try {
        if (d.notice) await deps.transport.edit(d.thread, d.notice.message, text);
        const message = d.notice?.message ?? await deps.transport.send(d.thread, text, `decision-notice:${d.id}`);
        patchOne(stateDir, d.id, (x) => ({ ...x, notice: { message, text } }));
      } catch (e) { log(`DECISION_NOTICE_FAILED ${d.id} r${r.rev}: ${errLine(e)}; retried next round`); }
    }
    try { await syncDecisionButtons(deps, d); }
    catch (e) { log(`DECISION_BUTTONS_FAILED ${d.id} r${r.rev}: ${errLine(e)}; retried next round`); }
    if (r.delivery.state !== "acked" || r.choice === undefined) continue;
    await deps.enqueue(`decision-acked:${d.id}:r${r.rev}`, ackedLine(d, r));
    try {
      const received = `레인 ${r.target.lane}이 ${r.choice}번을 받았습니다`;
      await closeOwnerDecision(deps, d.id, { text: received, ownerText: received, choice: r.choice, force: true });
      log(`DECISION_CLOSED_ON_ACK ${d.id} r${r.rev} ${r.delivery.id}`);
    } catch (e) {
      if (!(e instanceof OwnerDecisionError && e.code === "DECISION_ALREADY_CLOSED")) log(`DECISION_CLOSE_ON_ACK_FAILED ${d.id} r${r.rev}: ${errLine(e)}; retried next round`);
    }
  }
};
