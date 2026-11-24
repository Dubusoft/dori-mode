import { deliverLaneMessage, queueSteering } from "./ci-follow.ts";
import { reachedLane } from "./decision-delivery.ts";
import { DECISION_RELAY_ATTEMPTS, DECISION_RELAY_RETRY_MS, type DecisionRelay, type OwnerDecision, patchOne, readDecisions } from "./decision-store.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type LaneMessageStore, openLaneMessages, updateLaneMessage } from "./lane-messages.ts";
import { openOperations } from "./operations.ts";
import { relayFailedLine, relaysToLane, short } from "./owner-decisions.ts";
import { statusOf } from "./registry.ts";
import { errLine } from "./line-text.ts";

/*
 * `dori decision close` on a decision that relays to its lane (a lane's own question or request, or a lead decision
 * opened with `--relay-to`: relaysToLane) hands the close text to that lane: queued as a lead steering message
 * `decision-close-<id>` and typed once right away through the lane's runner (local or remote), like a done-claim notice.
 * A text the pane does not take is superseded between attempts, so the general lane message pass never types it on its
 * own; the supervisor tries it again (retryDecisionRelays) under the same message id and delivery operation, so a text
 * that was typed is never typed twice, up to DECISION_RELAY_ATTEMPTS tries DECISION_RELAY_RETRY_MS apart. Only then does
 * the tick raise urgent DECISION_RELAY_FAILED once, and the lead hands the answer over itself. A lane the owner's answer
 * already reached directly (DECISION_ANSWER_DIRECT, delivered or acked) gets nothing more.
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
  if (!r) return d.lane && !relaysToLane(d) ? `DECISION_RELAY_SKIPPED ${d.lane} ${d.id}: the lead opened this decision without --relay-to; relay the answer to lane ${d.lane} yourself` : undefined;
  if (r.state === "relayed") return `DECISION_RELAYED ${r.lane} ${d.id} ${r.message ?? "-"}${r.reason ? ` (${r.reason})` : ""}: the close text was typed into the lane; it confirms with dori report ack ${r.message ?? "-"}`;
  if (r.state === "skipped") return `DECISION_RELAY_SKIPPED ${r.lane} ${d.id}: ${r.reason ?? "nothing to relay"}`;
  const attempts = r.attempts ?? 1;
  return r.reportedAt === undefined && attempts < DECISION_RELAY_ATTEMPTS
    ? `DECISION_RELAY_RETRYING ${r.lane} ${d.id}: ${r.reason ?? "not delivered"}; the supervisor tries again (attempt ${attempts} of ${DECISION_RELAY_ATTEMPTS}); hand it to the lane yourself only on DECISION_RELAY_FAILED`
    : relayFailedLine(d);
};

/** The direct answer revision that already reached the lane, unless the close settled on another choice (a button press the lead took over). */
const answeredDirectly = (d: OwnerDecision, store: LaneMessageStore): number | undefined => {
  const r = d.revisions?.at(-1);
  return r && r.choice !== undefined && (d.choice === undefined || d.choice === r.choice) && reachedLane(store.get(r.delivery.id)) ? r.rev : undefined;
};

/**
 * Relays closed decision `d`'s close text to its lane (decisions that relay to their lane only) and records the outcome
 * on the decision; returns the decision as recorded. Never throws: a failure is the `failed` outcome, retried by
 * retryDecisionRelays.
 */
export const relayDecisionClose = async (deps: FlowDeps, d: OwnerDecision): Promise<OwnerDecision> =>
  d.state !== "closed" || !relaysToLane(d) || d.relay ? d : attemptRelay(deps, d, 1);

/**
 * The supervisor's retry of close texts not typed yet: each failed relay not reported, with attempts left and its last
 * try DECISION_RELAY_RETRY_MS ago, is tried once more. Returns the decisions as recorded after this pass's attempts.
 */
export const retryDecisionRelays = async (deps: FlowDeps): Promise<OwnerDecision[]> => {
  const now = deps.clock.now();
  const due = readDecisions(deps.config.stateDir).decisions.filter((d) => d.state === "closed" && relaysToLane(d) && d.relay?.state === "failed"
    && d.relay.reportedAt === undefined && (d.relay.attempts ?? 1) < DECISION_RELAY_ATTEMPTS && now - d.relay.at >= DECISION_RELAY_RETRY_MS);
  const done: OwnerDecision[] = [];
  for (const d of due) done.push(await attemptRelay(deps, d, (d.relay?.attempts ?? 1) + 1));
  return done;
};

/** One try at typing `d`'s close text into its lane, recorded as attempt `attempts`. Never throws. */
const attemptRelay = async (deps: FlowDeps, d: OwnerDecision, attempts: number): Promise<OwnerDecision> => {
  const laneKey = d.lane ?? "";
  const at = deps.clock.now();
  const record = (relay: Omit<DecisionRelay, "lane" | "at" | "attempts">): OwnerDecision =>
    patchOne(deps.config.stateDir, d.id, (x) => ({ ...x, relay: { lane: laneKey, at, attempts, ...relay } })) ?? d;
  let messages: LaneMessageStore | undefined;
  try {
    messages = openLaneMessages(deps.config);
    const direct = answeredDirectly(d, messages);
    if (direct !== undefined) return record({ state: "skipped", reason: `the owner's answer r${direct} already reached the lane directly` });
    const lane = await deps.registry.read(laneKey);
    if (!lane || statusOf(lane) === "closed") return record({ state: "skipped", reason: `lane ${laneKey} is closed` });
    const id = relayMessageId(d.id);
    let queued = queueSteering(messages, at, lane, { id, subject: `decision:${d.id}`, text: relayText(d, d.closeText ?? "") });
    // A retry finds the message the last attempt superseded and queues it again under its id: its delivery operation
    // decides whether to type it (a failed send is retried; a typed or possibly typed one is not typed again).
    if (queued.state === "superseded") queued = updateLaneMessage(messages, queued, { state: "queued" }, at);
    const ops = deps.operations ?? openOperations(deps.config);
    const sent = await deliverLaneMessage(deps, ops, messages, lane, queued).finally(() => { if (!deps.operations) ops.close(); });
    if (sent.state === "delivered" || sent.state === "acked") return record({ state: "relayed", message: id });
    const reason = sent.blocked ?? `not delivered (${sent.state})`;
    if (sent.state === "queued") updateLaneMessage(messages, sent, { state: "superseded", blocked: `close relay failed: ${reason}` }, deps.clock.now());
    return record({ state: "failed", message: id, reason });
  } catch (e) {
    return record({ state: "failed", reason: errLine(e) });
  } finally {
    messages?.close();
  }
};
