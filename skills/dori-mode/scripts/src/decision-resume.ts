import { askedThisSession, directAnswer, laneOwnerWait, type OwnerDecision, patchOne, readDecisions } from "./decision-store.ts";
import type { FlowDeps, LaneReads } from "./done-flow.ts";
import { LaneOpsError } from "./lane-ops.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { SweepView } from "./sweep-view.ts";

/**
 * Resumes the goal a lane parked on its own blocking question or request once the answer reached it. The lane footer
 * tells it to set its goal blocked and end its turn while it waits, and omo lets neither the model (update_goal sets only
 * complete or blocked) nor an answer typed into the pane (it reactivates only mechanical blocks) make that goal active
 * again; `/goal resume` does. So once a lane's wait is over (decision-store.ts laneOwnerWait) and its answer reached it
 * (the close text relayed, or the direct answer acked), the first time its pane is idle with its last turn held by a
 * blocked goal, the lane's runner types `/goal resume` and reads `Goal active` back (`lane.resume`): goal continuation
 * then carries the work on past the answer turn. Each answered ask is dealt with once (OwnerDecision.goalResume); a
 * lane whose goal is not blocked then (it never parked, or already went on) gets nothing typed.
 */

/** The ask's answer reached the lane: closed with its close text typed in (or skipped because the direct answer did), or the newest direct answer acked. */
const answerReached = (d: OwnerDecision): boolean =>
  d.state === "closed" ? d.relay?.state !== "failed" : directAnswer(d)?.state === "acked";

export const resumeAnsweredGoals = async (deps: FlowDeps, view?: SweepView, admitted: (machine?: string) => boolean = () => true): Promise<string[]> => {
  const lanes = (await deps.registry.open()).filter((l) => statusOf(l) === "working" && l.pane && !l.recoveryPending && admitted(l.machine));
  if (!lanes.length) return [];
  const decisions = readDecisions(deps.config.stateDir).decisions;
  const owner = laneOwnerWait(decisions, lanes);
  const reads: LaneReads = view ?? deps.ops;
  const out: string[] = [];
  for (const lane of lanes) {
    if (owner.waiting.has(lane.key)) continue;
    const due = decisions.filter((d) => d.source === "lane" && d.blocking && d.lane === lane.key && d.goalResume === undefined && askedThisSession(d, lane) && answerReached(d));
    if (!due.length || (await reads.status(lane)).status === "working") continue;
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
