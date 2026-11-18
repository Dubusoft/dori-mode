import { deliverLaneMessage, queueSteering } from "./ci-follow.ts";
import type { FlowDeps } from "./done-flow.ts";
import { openLaneMessages, updateLaneMessage } from "./lane-messages.ts";
import { openOperations } from "./operations.ts";
import type { Lane } from "./registry.ts";

/*
 * `dori lane send <key> --text`: the lead's free-form message to a lane, local or remote, instead of typing into its
 * pane by hand. It is a lead steering message (queueSteering) with its own id, typed once now through the lane's runner,
 * which does the pre-send check (live agent, empty input line, a prompt) and refuses while the lane shows a question
 * prompt (`refuseWhileAsking`). A text the pane does not take now is superseded, never typed later behind the lead's
 * back: the lead reads the line and decides.
 */

export type LaneSendResult = { readonly ok: boolean; readonly line: string };

export const laneSendId = (key: string, now: number): string => `lane-send-${key}-${now}`;

export const laneSendText = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.startsWith("[LEAD]") ? line : `[LEAD] ${line}`;
};

export const sendToLane = async (deps: FlowDeps, lane: Lane, text: string): Promise<LaneSendResult> => {
  const messages = openLaneMessages(deps.config);
  const ops = deps.operations ?? openOperations(deps.config);
  try {
    const now = deps.clock.now();
    const id = laneSendId(lane.key, now);
    const queued = queueSteering(messages, now, lane, { id, subject: id, text: laneSendText(text), refuseWhileAsking: true });
    const sent = await deliverLaneMessage(deps, ops, messages, lane, queued);
    if (sent.state === "acked" || (sent.state === "delivered" && !sent.unconfirmed)) {
      return { ok: true, line: `LANE_SEND_DELIVERED ${lane.key} ${id}: the lane confirms with dori report ack ${id}` };
    }
    if (sent.state === "delivered") {
      return { ok: true, line: `LANE_SEND_UNCONFIRMED ${lane.key} ${id}: typed, but the pane did not confirm it took the text; read the pane or wait for dori report ack ${id}` };
    }
    const why = sent.blocked ?? `not delivered (${sent.state})`;
    if (sent.state === "queued") updateLaneMessage(messages, sent, { state: "superseded", blocked: `lane send not delivered: ${why}` }, deps.clock.now());
    const kind = why.includes("RUNNER_LANE_ASKING") ? "LANE_SEND_REFUSED" : "LANE_SEND_FAILED";
    return { ok: false, line: `${kind} ${lane.key} ${id}: ${why}; nothing was typed` };
  } finally {
    if (!deps.operations) ops.close();
    messages.close();
  }
};
