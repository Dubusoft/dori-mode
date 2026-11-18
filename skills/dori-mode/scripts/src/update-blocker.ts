import { isLaneOutcomeLine, laneOutcomeEventId } from "./autopilot.ts";
import type { AutoUpdateEmit } from "./auto-update.ts";
import { publishedDecisions } from "./decision-obligations.ts";
import { closedEvent, closeLane, finishClosedTask, type FlowDeps, laneMeta, mergeConfirmed, unpushedWork } from "./done-flow.ts";
import { publishedUnreported } from "./lane-outcomes.ts";
import { LaneOpsError } from "./lane-ops.ts";
import { ownerDecisionBlockers } from "./owner-decisions.ts";
import { type Lane, statusOf } from "./registry.ts";
import { finishedOutcome } from "./task-finish.ts";

/** What became of a stale update blocker: closed (or already gone), else the one line the lead gets about it. */
export type StaleVerdict = { readonly closed: true } | { readonly closed: false; readonly line: string };

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The open decisions of lane `key`: owner decisions bound to it, and decision obligations whose event line names it
 * second (the rule thread-finality.ts threadBlockers reads them by).
 */
const openDecisions = (stateDir: string, key: string): string[] => [
  ...ownerDecisionBlockers(stateDir).filter((d) => d.lane === key).map((d) => d.id),
  ...publishedDecisions(stateDir).filter((d) => d.line?.split(" ")[1] === key).map((d) => d.id),
];

const claimedPulls = (lane: Lane): string =>
  lane.claim?.pulls?.length ? lane.claim.pulls.map((p) => `${p.repo}#${p.number}@${p.sha.slice(0, 7)}`).join(", ") : "none claimed";

/**
 * A lane that has held the automatic update back for tunables.updateBlockerStaleMin (auto-update.ts). It is closed
 * through closeLane, the same close as any other, only when every one of these reads true: its runner reported its agent
 * dead on its current pane (RUNNER_LANE_DEAD, `deadAlertPane`) and no recovery is under way; no owner decision or
 * decision obligation of the lane is open; no outcome of it is unreported; it is a local lane whose worktrees hold no
 * uncommitted or unpushed work; its PR is confirmed merged (mergeConfirmed: the supervisor merged it, a `merged` Done
 * signal reads MERGED, or a PR into ciMergeBase merged at a lane worktree's HEAD). How long it blocked never closes it.
 * Otherwise the verdict carries the lane's state and every reason it stays open, for the lead.
 */
export const staleBlocker = async (deps: FlowDeps, key: string, since: number, emit: AutoUpdateEmit): Promise<StaleVerdict> => {
  const lane = await deps.registry.read(key);
  if (!lane || statusOf(lane) === "closed") return { closed: true };
  const stateDir = deps.config.stateDir;
  const holds: string[] = [];
  if (lane.deadAlertPane === undefined || lane.deadAlertPane !== (lane.pane ?? "")) holds.push("its runner has not reported its agent dead");
  else if (lane.recoveryPending) holds.push("a recovery is under way");
  const decisions = openDecisions(stateDir, key);
  if (decisions.length) holds.push(`open decisions: ${decisions.join(", ")}`);
  if (publishedUnreported(stateDir).some((o) => o.lane === key)) holds.push("an outcome of it is not reported (dori reported)");
  let merged: string | undefined;
  if (lane.machine) holds.push(`a remote lane (${lane.machine}): its worktrees are not read from here`);
  else {
    try {
      holds.push(...await unpushedWork(deps, lane));
      merged = await mergeConfirmed(deps, lane);
      if (!merged) holds.push("no PR of it is confirmed merged");
    } catch (e) {
      if (!(e instanceof LaneOpsError)) throw e;
      holds.push(`its git state is unreadable: ${e.message}`);
    }
  }
  if (!holds.length) {
    const note = `stale update blocker since ${iso(since)}: agent dead, nothing open, worktrees clean, ${merged}`;
    const result = await closeLane(deps, lane, note);
    if (result.closed) {
      // Handed over like any close after a merge: its Toodo task is finished first, and the tag says how.
      const finish = await finishClosedTask(deps, lane);
      const line = closedEvent(key, note, result.lines).replace(/^(LANE_CLOSED \S+ closed)(?= |$)/, `$1${finish ? ` toodo=${finish.tag}` : ""}`);
      await emit(`${line} stale-update-blocker`, `update-blocker-closed:${key}:${since}`, laneMeta(lane));
      for (const extra of finish?.lines ?? []) await emit(extra, `update-blocker-task:${key}:${since}`, laneMeta(lane));
      for (const outcome of result.lines.filter(isLaneOutcomeLine)) await emit(finishedOutcome(outcome, finish), laneOutcomeEventId(key), laneMeta(lane));
      return { closed: true };
    }
    holds.push(result.lines.at(-1) ?? "the close was refused");
  }
  const report = lane.lastRunnerReportAt === undefined ? "none" : iso(lane.lastRunnerReportAt);
  const branch = `${merged ?? "not confirmed merged"}; PRs ${claimedPulls(lane)}`;
  const line = `AUTO_UPDATE_BLOCKER_STALE ${key} status=${statusOf(lane)} holds the automatic update back since ${iso(since)}; last report ${report}; decisions ${decisions.join(", ") || "none"}; branch ${branch}; not closed automatically: ${holds.join("; ")}`;
  return { closed: false, line: line.replace(/\s+/g, " ") };
};
