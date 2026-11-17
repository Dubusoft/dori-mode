import { askedThisSession, directAnswer, type OwnerDecision, patchOne, readDecisions } from "./decision-store.ts";
import type { FlowDeps, LaneReads } from "./done-flow.ts";
import { type LaneMessage, openLaneMessages } from "./lane-messages.ts";
import { LaneOpsError } from "./lane-ops.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { SweepView } from "./sweep-view.ts";

/**
 * Resumes the goal a lane parked on its own blocking question or request once the answer reached it. The lane footer
 * tells it to set its goal blocked and end its turn while it waits, and omo lets neither the model (update_goal sets only
 * complete or blocked) nor an answer typed into the pane (it reactivates only mechanical blocks) make that goal active
 * again; `/goal resume` does. An answer counts as reached only on positive proof: the close text typed in (`relayed`, or
 * `skipped` because the direct answer already was), the newest direct answer acked, or an acked `dori lane send` to the
 * lane that names the ask's id (the lead's own answer, e.g. after DECISION_RELAY_FAILED). A close whose text is still on
 * its way is not. Once every ask of the lane's session still in flight has reached it, the first time its pane is idle
 * with its last turn held by a blocked goal, the lane's runner types `/goal resume` and reads `Goal active` back
 * (`lane.resume`): goal continuation then carries the work on past the answer turn. Each reached ask is dealt with once
 * (OwnerDecision.goalResume); a lane whose goal is not blocked then (it never parked, or already went on) gets nothing typed.
 */

type Send = Pick<LaneMessage, "id" | "lane" | "text" | "ackedAt">;

/** When the ask's answer reached the lane, or undefined while nothing proves it did. */
const reachedAt = (d: OwnerDecision, sends: readonly Send[]): number | undefined => {
  if (d.state === "closed" && (d.relay?.state === "relayed" || d.relay?.state === "skipped")) return d.relay.at;
  const direct = directAnswer(d);
  if (direct?.state === "acked") return direct.updatedAt;
  const named = new RegExp(`\\b${d.id}\\b`);
  const acks = sends.filter((m) => m.lane === d.lane && m.ackedAt !== undefined && m.ackedAt >= d.openedAt && named.test(m.text)).map((m) => m.ackedAt ?? 0);
  return acks.length ? Math.max(...acks) : undefined;
};

/** Still on its way to the lane: open, or closed with its close text not typed in yet and not given up on (DECISION_RELAY_FAILED). */
const inFlight = (d: OwnerDecision): boolean =>
  d.state !== "closed" || d.relay === undefined || (d.relay.state === "failed" && d.relay.reportedAt === undefined);

/** The acked `dori lane send` messages of `lanes` (lane-send.ts laneSendId). */
const laneSends = (deps: FlowDeps, lanes: readonly Lane[]): Send[] => {
  const store = openLaneMessages(deps.config);
  try { return lanes.flatMap((l) => store.list({ lane: l.key, states: ["acked"] }).filter((m) => m.id.startsWith(`lane-send-${l.key}-`))); }
  finally { store.close(); }
};

export const resumeAnsweredGoals = async (deps: FlowDeps, view?: SweepView, admitted: (machine?: string) => boolean = () => true): Promise<string[]> => {
  const lanes = (await deps.registry.open()).filter((l) => statusOf(l) === "working" && l.pane && !l.recoveryPending && admitted(l.machine));
  const decisions = readDecisions(deps.config.stateDir).decisions;
  const asksOf = (lane: Lane) => decisions.filter((d) => d.source === "lane" && d.blocking && d.lane === lane.key && d.goalResume === undefined && askedThisSession(d, lane));
  const asking = lanes.filter((l) => asksOf(l).length);
  if (!asking.length) return [];
  const sends = laneSends(deps, asking);
  const reads: LaneReads = view ?? deps.ops;
  const out: string[] = [];
  for (const lane of asking) {
    const asks = asksOf(lane).map((d) => ({ d, at: reachedAt(d, sends) }));
    const due = asks.filter((a) => a.at !== undefined).map((a) => a.d);
    if (!due.length || asks.some((a) => a.at === undefined && inFlight(a.d))) continue;
    if ((await reads.status(lane)).status === "working") continue;
    const turn = await lastTurn(deps, lane);
    // A runner that records no turns, or none yet for this stop: nothing proves the goal is parked, so the next tick asks again.
    if (!turn) continue;
    const ids = due.map((d) => d.id).join(",");
    const record = (outcome: string): void => {
      const at = deps.clock.now();
      for (const d of due) patchOne(deps.config.stateDir, d.id, (x) => ({ ...x, goalResume: { at, outcome } }));
    };
    if (turn.hold !== "goal-blocked") { record(`not parked (${turn.hold})`); continue; }
    const resumed = await deps.ops.resume(lane);
    record(resumed.goal === "confirmed" ? "resumed" : `resume ${resumed.goal}`);
    out.push(resumed.goal === "confirmed"
      ? `GOAL_RESUMED ${lane.key} ${ids} answered: its parked goal is active again${resumed.execution === "held" ? ", but no turn ran after it (session held)" : ""}`
      : `GOAL_RESUME_FAILED ${lane.key} ${ids} answered, but /goal resume was ${resumed.goal}: its goal stays blocked, so goal continuation does not carry its work on; read its pane and send it a message to continue`);
  }
  return out;
};

const lastTurn = async (deps: FlowDeps, lane: Lane) => {
  try { return await deps.ops.turn(lane); }
  catch (error) {
    // A lane its runner cannot observe now is tried on a later tick; anything else is the caller's.
    if (error instanceof LaneOpsError) return undefined;
    throw error;
  }
};
