import { deliverLaneMessage, queueSteering } from "./ci-follow.ts";
import { reachedLane } from "./decision-delivery.ts";
import { type DecisionRelay, type OwnerDecision, patchOne } from "./decision-store.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type LaneMessageStore, openLaneMessages, updateLaneMessage } from "./lane-messages.ts";
import { openOperations } from "./operations.ts";
import { errorText, relayFailedLine, short } from "./owner-decisions.ts";
import { statusOf } from "./registry.ts";

/*
 * `dori decision close` on a lane's own question or request (source "lane") hands the close text to that lane: queued as
 * a lead steering message `decision-close-<id>` and typed once right away through the lane's runner (local or remote),
 * like a done-claim notice. A text the pane does not take now is not kept for later: the message is superseded so it is
 * never typed after the lead has handed the answer over itself, and the failure is recorded on the decision for the
 * supervisor tick to raise once as urgent DECISION_RELAY_FAILED. A lane the owner's answer already reached directly
 * (DECISION_ANSWER_DIRECT, delivered or acked) gets nothing more.
 */

export const relayMessageId = (id: string): string => `decision-close-${id}`;

/** The lane's text: the decision, the owner's choice when the close records one, and the lead's close text. */
export const relayText = (d: OwnerDecision, text: string): string => {
  const what = d.kind === "request" ? "request" : "question";
  const picked = d.choice !== undefined ? ` Choice ${d.choice}. ${short(d.options[d.choice - 1] ?? "", 120)}.` : "";
  const head = d.cancelled ? `[LEAD] Your ${what} ${d.id} (${short(d.question, 120)}) was cancelled.` : `[LEAD] Answer to your ${what} ${d.id} (${short(d.question, 120)}).${picked}`;
  return `${head} ${text.replace(/\s+/g, " ").trim()}`;
};

/** The close's line about the relay; undefined when the decision is no lane's. */
export const relayLine = (d: OwnerDecision): string | undefined => {
  const r = d.relay;
  if (!r) return d.lane ? `DECISION_RELAY_SKIPPED ${d.lane} ${d.id}: the lead opened this decision; relay the answer to lane ${d.lane} yourself` : undefined;
  if (r.state === "relayed") return `DECISION_RELAYED ${r.lane} ${d.id} ${r.message ?? "-"}${r.reason ? ` (${r.reason})` : ""}: the close text was typed into the lane; it confirms with dori report ack ${r.message ?? "-"}`;
  if (r.state === "skipped") return `DECISION_RELAY_SKIPPED ${r.lane} ${d.id}: ${r.reason ?? "nothing to relay"}`;
  return relayFailedLine(d);
};

const answeredDirectly = (d: OwnerDecision, store: LaneMessageStore): number | undefined => {
  const r = d.revisions?.at(-1);
  return r && r.choice !== undefined && reachedLane(store.get(r.delivery.id)) ? r.rev : undefined;
};

/**
 * Relays closed decision `d`'s close text to its lane (lane decisions only) and records the outcome on the decision;
 * returns the decision as recorded. Never throws: a failure is the `failed` outcome.
 */
export const relayDecisionClose = async (deps: FlowDeps, d: OwnerDecision): Promise<OwnerDecision> => {
  if (d.state !== "closed" || d.source !== "lane" || !d.lane || d.relay) return d;
  const laneKey = d.lane;
  const at = deps.clock.now();
  const record = (relay: Omit<DecisionRelay, "lane" | "at">): OwnerDecision =>
    patchOne(deps.config.stateDir, d.id, (x) => ({ ...x, relay: { lane: laneKey, at, ...relay } })) ?? d;
  let messages: LaneMessageStore | undefined;
  try {
    messages = openLaneMessages(deps.config);
    const direct = answeredDirectly(d, messages);
    if (direct !== undefined) return record({ state: "skipped", reason: `the owner's answer r${direct} already reached the lane directly` });
    const lane = await deps.registry.read(laneKey);
    if (!lane || statusOf(lane) === "closed") return record({ state: "skipped", reason: `lane ${laneKey} is closed` });
    const id = relayMessageId(d.id);
    const queued = queueSteering(messages, at, lane, { id, subject: `decision:${d.id}`, text: relayText(d, d.closeText ?? "") });
    const ops = deps.operations ?? openOperations(deps.config);
    const sent = await deliverLaneMessage(deps, ops, messages, lane, queued).finally(() => { if (!deps.operations) ops.close(); });
    if (sent.state === "delivered" || sent.state === "acked") return record({ state: "relayed", message: id });
    const reason = sent.blocked ?? `not delivered (${sent.state})`;
    if (sent.state === "queued") updateLaneMessage(messages, sent, { state: "superseded", blocked: `close relay failed: ${reason}` }, deps.clock.now());
    return record({ state: "failed", message: id, reason });
  } catch (e) {
    return record({ state: "failed", reason: errorText(e) });
  } finally {
    messages?.close();
  }
};
