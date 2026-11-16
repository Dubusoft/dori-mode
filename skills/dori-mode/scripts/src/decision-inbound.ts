import type { LaneMessageStore } from "./lane-messages.ts";
import { clickMessageId, queueDecisionAnswer, type QueueOutcome, recordAnswerRevision, viaButton } from "./decision-delivery.ts";
import { type AnswerRevision, decisionTargetOf, type OwnerDecision, readDecisions, sameTarget, type TargetLane } from "./decision-store.ts";
import { decisionButtonRows, decisionButtonState } from "./messenger/decision-buttons.ts";
import { answeredEventId, answeredLine, choiceLabel, recordButtonAnswer } from "./owner-decisions.ts";

/*
 * Routing an owner message to exactly one side (references/messaging.md, "Decision answers straight to the lane"):
 * `direct` when it is a qualifying answer to an open question a lane asked, recorded as an answer revision and queued as
 * lane message decision-d<ID>-r<n>; `lead` for everything else, which then reaches the lead as INBOUND exactly as before.
 * A message keeps the side it got first: an edit or delete of a direct answer revises or withdraws it, an edit or delete
 * of any other message goes to the lead.
 */

export type InboundSide = "direct" | "lead";

/** The owner message fields routing reads. */
export type RoutedMessage = {
  readonly id: string;
  readonly content: string;
  readonly attachments: readonly unknown[];
  /** The message this one replies to (Discord message_reference). */
  readonly replyTo?: string;
};

export type DirectRouting = {
  readonly stateDir: string;
  readonly store: () => LaneMessageStore;
  /** The lanes not closed, as the registry has them now. */
  readonly lanes: () => Promise<readonly TargetLane[]>;
  readonly now: () => number;
  /** Journals one event for the lead under a stable id. */
  readonly emit: (id: string, line: string) => Promise<void>;
  readonly log: (line: string) => void;
};

/** The qualifying answer forms: the whole trimmed text is `N`, or `d<ID>=<N>` (`d` either case). Attachments disqualify. */
export type AnswerForm = { readonly choice: number; readonly id?: string };

export const parseAnswerForm = (m: Pick<RoutedMessage, "content" | "attachments">): AnswerForm | undefined => {
  if (m.attachments.length) return undefined;
  const text = m.content.trim();
  const bare = /^(\d{1,3})$/.exec(text);
  if (bare) return { choice: Number(bare[1]) };
  const named = /^d(\d{1,9})=(\d{1,3})$/i.exec(text);
  return named ? { id: `d${Number(named[1])}`, choice: Number(named[2]) } : undefined;
};

const waiting = (d: OwnerDecision): boolean => d.state === "open" || d.state === "answered";

/**
 * The one decision a form names: `d<ID>=<N>` names it outright; a bare `N` names the only waiting question in thread
 * `channel`, or among several the one whose question message it replies to. Never the newest question by guess.
 */
export const answeredDecision = (decisions: readonly OwnerDecision[], channel: string, form: AnswerForm, replyTo?: string): OwnerDecision | undefined => {
  if (form.id !== undefined) {
    const named = decisions.find((d) => d.id === form.id);
    return named && waiting(named) ? named : undefined;
  }
  const here = decisions.filter((d) => d.thread === channel && waiting(d));
  if (here.length === 1) return here[0];
  return replyTo === undefined ? undefined : here.find((d) => d.message === replyTo);
};

/**
 * Whether `d` may take a direct answer now: a lane's own question (not a request, not the lead's), with a recorded
 * target whose lane is still open on the same runner and session, and no answer the lead already holds.
 */
export const delegated = (d: OwnerDecision, lanes: readonly TargetLane[]): boolean => {
  if (d.source !== "lane" || d.kind === "request" || !d.target || d.answers?.length) return false;
  const target = d.target;
  const lane = lanes.find((l) => l.key === target.lane);
  return lane !== undefined && sameTarget(target, decisionTargetOf(lane));
};

/** The decision holding answer revisions from owner message `channel`/`message`, and its newest such revision. */
const directOf = (stateDir: string, channel: string, message: string): { readonly decision: OwnerDecision; readonly last: AnswerRevision } | undefined => {
  let found: { decision: OwnerDecision; last: AnswerRevision } | undefined;
  for (const d of readDecisions(stateDir).decisions) {
    const last = d.revisions?.filter((r) => r.channel === channel && r.message === message).at(-1);
    if (last && (!found || last.at >= found.last.at)) found = { decision: d, last };
  }
  return found;
};

const choiceText = (d: OwnerDecision, r: AnswerRevision): string => (r.choice === undefined ? "withdrawn" : choiceLabel(d, r.choice));

/** Queues the newest revision's lane message and tells the lead: digest, or urgent when the lane may have had an older one. */
const deliver = async (routing: DirectRouting, d: OwnerDecision, r: AnswerRevision): Promise<void> => {
  let outcome: QueueOutcome;
  try { outcome = queueDecisionAnswer(routing.stateDir, routing.store(), d.id, routing.now()); }
  catch (e) {
    // The intent is recorded: the next start's reconcile queues it under the same id.
    routing.log(`DECISION_ROUTE_ERROR ${d.id} r${r.rev} not queued (${e instanceof Error ? e.message : String(e)}); reconciled at the next start`);
    return;
  }
  const from = `from ${r.channel}/${r.message}${viaButton(r)}`;
  const head = `${r.target.lane} ${d.id} r${r.rev} ${choiceText(d, r)} ${r.delivery.id}`;
  const line = outcome.kind === "queued" && outcome.replaces !== undefined
    ? `DECISION_ANSWER_CORRECTED ${head} replaces r${outcome.replaces} ${from}: the lane may have acted on r${outcome.replaces}; it gets the ${r.choice === undefined ? "withdrawal" : "correction"} to ack`
    : outcome.kind === "queued" ? `DECISION_ANSWER_DIRECT ${head} ${from}: queued for the lane, nothing to do`
    : outcome.kind === "none" ? undefined
    : `DECISION_ANSWER_DIRECT ${head} ${from}: ${outcome.reason}, nothing sent`;
  if (!line) return;
  try { await routing.emit(`decision-direct:${d.id}:r${r.rev}`, line); }
  catch { routing.log(`DECISION_ROUTE_ERROR cannot queue the lead's line for ${d.id} r${r.rev}`); }
};

/** Records `choice` (or a withdrawal) from the message as a revision of `d`; "refused" leaves everything as it was. */
const revise = async (routing: DirectRouting, d: OwnerDecision, channel: string, m: RoutedMessage, edit: number, choice?: number): Promise<"recorded" | "duplicate" | "refused"> => {
  if (!d.target) return "refused";
  const result = recordAnswerRevision(routing.stateDir, d.id, {
    channel, message: m.id, edit, content: m.content, target: d.target, ...(choice !== undefined ? { choice } : {}),
  }, routing.now());
  if (result.kind === "recorded") await deliver(routing, result.decision, result.revision);
  return result.kind;
};

/** Answers `form` names, when it qualifies: "direct" once recorded (or seen before), else "lead". */
const answer = async (routing: DirectRouting, channel: string, m: RoutedMessage, edit: number): Promise<InboundSide> => {
  const form = parseAnswerForm(m);
  if (!form) return "lead";
  const d = answeredDecision(readDecisions(routing.stateDir).decisions, channel, form, m.replyTo);
  if (!d || !delegated(d, await routing.lanes())) return "lead";
  return (await revise(routing, d, channel, m, edit, form.choice)) === "refused" ? "lead" : "direct";
};

/**
 * A new owner message. A message already recorded as a direct answer (the gateway and REST catch-up both see it) stays
 * direct with nothing new; a failure before anything is recorded leaves it to the lead.
 */
export const routeOwnerMessage = async (routing: DirectRouting, channel: string, m: RoutedMessage): Promise<InboundSide> => {
  try {
    if (directOf(routing.stateDir, channel, m.id)) return "direct";
    return await answer(routing, channel, m, 0);
  } catch (e) {
    routing.log(`DECISION_ROUTE_ERROR ${channel}/${m.id} goes to the lead (${e instanceof Error ? e.message : String(e)})`);
    return "lead";
  }
};

/**
 * One owner click on answer button `choice` of `decision`, made in channel `channel` (decision-buttons.ts). `late`: its
 * acknowledgement failed, so it reached this process past Discord's answer window (made while the supervisor restarted).
 */
export type DecisionClick = { readonly decision: string; readonly choice: number; readonly channel: string; readonly interaction: string; readonly late?: boolean };

/**
 * What a click gets: the owner's reply text (none when the thread's `[System]` notice already confirms it), and the
 * decision's buttons as they should now show (none when it has none).
 */
export type ClickReply = { readonly content?: string; readonly components?: readonly unknown[] };

/**
 * An owner's answer-button click, routed like typing `d<ID>=<N>` in the decision's thread: when the decision is
 * delegated it becomes an answer revision of owner "message" `click:<interaction>` (so a redelivered click is the same
 * revision) and is queued for the lane, a different button before the lane acks being a correction like an edited
 * answer. Returns the owner's reply with the buttons as they should now show (no reply text for a first direct answer: the decision's `[System]` notice,
 * decision-delivery.ts, confirms it in the thread): a click from another channel than the
 * decision's thread is refused; a closed decision, or an answer the lane already acked, is final; the choice the buttons
 * already show changes nothing.
 *
 * A decision that cannot take a direct answer (the lead opened it, its lane relaunched or closed, the lead already holds
 * an answer) takes the click as an answer the lead holds (recordButtonAnswer, once per interaction, late or not): the
 * first answer raises the urgent OWNER_DECISION_ANSWERED obligation naming the choice `via button`, a later different
 * button the urgent DECISION_ANSWER_CORRECTED; the lead settles it with `dori decision close d<ID> --choice N`.
 */
export const routeDecisionClick = async (routing: DirectRouting, click: DecisionClick): Promise<ClickReply> => {
  const d = readDecisions(routing.stateDir).decisions.find((x) => x.id === click.decision);
  if (!d || d.thread !== click.channel) return { content: "이 스레드의 질문 버튼이 아닙니다." };
  const reply = (content?: string): ClickReply => {
    const rows = decisionButtonRows(readDecisions(routing.stateDir).decisions.find((x) => x.id === d.id) ?? d);
    return { content, ...(rows ? { components: rows } : {}) };
  };
  if (!waiting(d)) return reply(`${d.id}은 이미 닫힌 질문입니다.`);
  const newest = d.revisions?.at(-1);
  if (newest?.choice !== undefined && newest.delivery.state === "acked") return reply(`레인이 이미 ${d.id}의 ${newest.choice}번을 받았습니다. 다른 답은 스레드에 적어 주세요.`);
  const shown = decisionButtonState(d).selected;
  const toLead = async (): Promise<ClickReply> => {
    const recorded = recordButtonAnswer(routing.stateDir, d.id, click.channel, clickMessageId(click.interaction), click.choice, routing.now());
    if (!recorded?.added) return reply(recorded?.decision.state === "closed" ? `${d.id}은 이미 닫힌 질문입니다.` : `${d.id}에 이미 ${click.choice}번으로 답했습니다.`);
    const at = recorded.first ? answeredEventId(d.id) : `decision-button:${d.id}:${click.interaction}`;
    const line = recorded.first ? answeredLine(recorded.decision)
      : `DECISION_ANSWER_CORRECTED ${d.lane ?? "-"} ${d.id} ${choiceLabel(d, click.choice)}${shown !== undefined ? ` replaces choice=${shown}` : ""} via button: `
        + `the owner changed the answer the lead holds; settle it with dori decision close ${d.id} --choice ${click.choice} --text "..."`;
    await routing.emit(at, line);
    return reply(recorded.first || shown === undefined
      ? `${d.id}에 ${click.choice}번으로 답했습니다. 레인에 바로 전달할 수 없어 리드에게 넘겼습니다.`
      : `${d.id}의 답을 ${click.choice}번으로 바꾸었습니다. 리드에게 정정을 넘겼습니다.`);
  };
  if (shown === click.choice) return reply(`${d.id}에 이미 ${click.choice}번으로 답했습니다.`);
  if (!delegated(d, await routing.lanes())) return toLead();
  const m: RoutedMessage = { id: clickMessageId(click.interaction), content: `${d.id}=${click.choice}`, attachments: [] };
  if ((await revise(routing, d, click.channel, m, 0, click.choice)) === "refused") return toLead();
  return reply(newest?.choice !== undefined ? `${d.id}의 답을 ${click.choice}번으로 바꾸었습니다. 레인에 정정을 전달합니다.` : undefined);
};

/** Withdraws the live answer `found` holds from this message; refused when there is none (already withdrawn, or closed). */
const withdraw = async (routing: DirectRouting, found: { readonly decision: OwnerDecision; readonly last: AnswerRevision }, channel: string, m: RoutedMessage, edit: number): Promise<void> => {
  const newest = found.decision.revisions?.at(-1);
  if (newest?.choice === undefined || newest.channel !== channel || newest.message !== m.id) return;
  await revise(routing, found.decision, channel, m, edit);
};

/**
 * An owner edit at `edit` (the edited_timestamp in ms). An edit of a message the lead got stays with the lead. An edit
 * of a direct answer that still answers the same decision is a new revision ("direct"); one that leaves the form, or
 * names another decision, withdraws the answer, and the new text is routed afresh: another qualifying answer is direct,
 * anything else reaches the lead ("lead").
 */
export const routeOwnerEdit = async (routing: DirectRouting, channel: string, m: RoutedMessage, edit: number): Promise<InboundSide> => {
  try {
    const found = directOf(routing.stateDir, channel, m.id);
    if (!found) return "lead";
    const form = parseAnswerForm(m);
    const same = form && answeredDecision(readDecisions(routing.stateDir).decisions, channel, form, m.replyTo)?.id === found.decision.id;
    if (form && same && delegated(found.decision, await routing.lanes())
      && (await revise(routing, found.decision, channel, m, edit, form.choice)) !== "refused") return "direct";
    await withdraw(routing, found, channel, m, edit);
    return same ? "lead" : await answer(routing, channel, m, edit);
  } catch (e) {
    routing.log(`DECISION_ROUTE_ERROR edit ${channel}/${m.id} goes to the lead (${e instanceof Error ? e.message : String(e)})`);
    return "lead";
  }
};

/** An owner delete: a direct answer is withdrawn ("direct", the lead never saw it); any other message is the lead's. */
export const routeOwnerDelete = async (routing: DirectRouting, channel: string, id: string): Promise<InboundSide> => {
  try {
    const found = directOf(routing.stateDir, channel, id);
    if (!found) return "lead";
    await withdraw(routing, found, channel, { id, content: "", attachments: [] }, routing.now());
    return "direct";
  } catch (e) {
    routing.log(`DECISION_ROUTE_ERROR delete ${channel}/${id} (${e instanceof Error ? e.message : String(e)})`);
    return directOf(routing.stateDir, channel, id) ? "direct" : "lead";
  }
};
