import { dirname, join, resolve } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import { LaunchError, type LaunchInput } from "./launch.ts";
import { admitLaunch, placeLaunch } from "./launch-service.ts";
import { LOCAL_MACHINE } from "./placement.ts";
import type { Lane } from "./registry.ts";
import { GATE_REVIEWER_AGENT, type ReviewJob } from "./review-receipt.ts";

/**
 * The review lane (design D5/D6): its brief, and its launch through the shared admission. The lane orchestrates on the
 * normal lane default model, runs QA on the read-only snapshot itself, and has exactly one `omo-native-gate-reviewer`
 * subagent render the verdict. It never edits code, commits, pushes or merges.
 */

/** File names the review lane writes into DORI_LANE_OUT; the gate reads them from the installed lane reports. */
export const REVIEW_RESULT_FILE = "review-result.json";
export const REVIEW_BODY_FILE = "review-body.json";
export const REVIEW_REPORT_FILE = "review-report.md";

/** What the brief points the lane at: the snapshot worktree and the supervisor-written inputs. */
export type ReviewBriefInputs = {
  readonly url: string;
  readonly title: string;
  readonly snapshotPath: string;
  /** `<stateDir>/review-inputs/<jobId>/` with the three files below. */
  readonly inputDir: string;
  readonly diffPath: string;
  readonly criteriaPath: string;
  readonly prPath: string;
};

/** Where the supervisor installs a lane's DORI_LANE_OUT files after its done claim (lane-files.ts installLaneReports). */
export const installedOutDir = (stateDir: string, laneKey: string): string => join(dirname(resolve(stateDir)), "research", laneKey);

/** The review lane's Done line: its result file, installed under the supervisor's state by its done claim. */
export const reviewDone = (stateDir: string, laneKey: string): string => `file ${join(installedOutDir(stateDir, laneKey), REVIEW_RESULT_FILE)}`;

/** The review lane's brief (D6). English, explicit commands, the exact result shapes. */
export const reviewBrief = (job: ReviewJob, token: string, inputs: ReviewBriefInputs): string => {
  const s = job.snapshot;
  const resultShape = JSON.stringify({
    jobId: job.jobId, jobToken: token, source: "reviewer", body: REVIEW_BODY_FILE,
    taskRecord: "<absolute path ~/.omo/agent/projects/<project>/senpi-task/tasks/<taskId>.json of the gate reviewer>",
    startedAt: "<UTC ISO, e.g. 2026-11-14T12:00:00Z>", completedAt: "<UTC ISO>",
  }, null, 2);
  const bodyShape = JSON.stringify({
    schemaVersion: 1, jobId: job.jobId, verdict: "pass | findings", summary: "<one paragraph>",
    findings: [{
      id: "F1", severity: "critical | high | medium", criterionId: "<criterion id, e.g. C1 or G1>", path: "<repo-relative path>",
      lineStart: 1, lineEnd: 1, observation: "<what is wrong>", consequence: "<why it matters>", evidence: ["<command output, line quote>"],
      requestedChange: "<what to change>",
    }],
    notes: [{ path: null, text: "<non-blocking remark>" }],
  }, null, 2);
  return [
    `Review job ${job.jobId}: ${s.repo}#${s.prNumber} (${inputs.url}) "${inputs.title}", author lane ${job.authorLaneKey}.`,
    "",
    "## Role",
    "You are a review lane started by the supervisor. You orchestrate a review on your own default model; the verdict comes from",
    `exactly ONE \`${GATE_REVIEWER_AGENT}\` subagent. You NEVER edit code, commit, push, merge, open or comment on PRs, or change any`,
    "file in the snapshot. Your only writes are files in DORI_LANE_OUT.",
    "",
    "## Snapshot",
    `- Snapshot worktree (read-only, detached at the head): ${inputs.snapshotPath}`,
    `- Head ${s.headSha}; base ${s.baseRef} at ${s.baseSha}; merge base ${s.mergeBaseSha}; policy ${s.policyVersion}.`,
    `- Diff (merge base...head): ${inputs.diffPath}`,
    `- Review criteria with ids: ${inputs.criteriaPath}`,
    `- PR title and body: ${inputs.prPath}`,
    "",
    "## Steps",
    "1. Record the start time: `date -u +%Y-%m-%dT%H:%M:%SZ` (startedAt).",
    `2. QA: in ${inputs.snapshotPath}, run the repo's typecheck and tests as its docs (README, AGENTS.md, CONTRIBUTING) describe.`,
    "   Write every command with its exit code and a short output tail into \"$DORI_LANE_OUT/qa.md\" (the QA matrix).",
    "   Do not install into or write anything inside the snapshot; when a step needs writes there, record it as not runnable.",
    "3. If QA FAILS (a typecheck or test command that should pass exits non-zero): skip the reviewer. Write",
    `   "$DORI_LANE_OUT/${REVIEW_BODY_FILE}" with verdict "findings" (one finding per failing command, criterionId C2) and`,
    `   "$DORI_LANE_OUT/${REVIEW_RESULT_FILE}" with source "qa" and taskRecord null. Then go to step 7.`,
    `4. Otherwise spawn exactly one subagent with the task tool, subagent_type "${GATE_REVIEWER_AGENT}". Give it: the goal (review job`,
    `   ${job.jobId} of ${s.repo}#${s.prNumber}), the criteria file with its ids, the snapshot path, base and head SHAs, the diff path,`,
    "   your QA matrix, and the ReviewBody contract below. Tell it: write NO files except its body file",
    `   "$DORI_LANE_OUT/${REVIEW_BODY_FILE}", run no command longer than 60 s, and answer with exactly one JSON object.`,
    "5. Validate the body: exactly one JSON object (no fence, no prose), schemaVersion 1, jobId " + JSON.stringify(job.jobId) + ",",
    "   verdict pass (findings []) or findings (at least one finding), every key of the contract and no other. If it is invalid,",
    "   send the reviewer ONE correction message naming the problem; if it is still invalid, keep its last body as is.",
    "6. Find the reviewer's senpi-task record: the newest ~/.omo/agent/projects/*/senpi-task/tasks/<taskId>.json whose task_id is",
    `   the reviewer's task id and whose agent_type is "${GATE_REVIEWER_AGENT}". Put its absolute path in taskRecord.`,
    `7. Write "$DORI_LANE_OUT/${REVIEW_RESULT_FILE}" (completedAt = \`date -u +%Y-%m-%dT%H:%M:%SZ\`) and a human report`,
    `   "$DORI_LANE_OUT/${REVIEW_REPORT_FILE}" (verdict, summary, findings, QA matrix).`,
    `8. Run: dori report ${job.reviewerLaneKey} done --text "review ${job.jobId} complete" --evidence "${REVIEW_RESULT_FILE} written"`,
    "",
    `## ${REVIEW_RESULT_FILE} (exact shape; jobToken is secret, copy it exactly and never print it elsewhere)`,
    "```json",
    resultShape,
    "```",
    "",
    `## ReviewBody contract (${REVIEW_BODY_FILE})`,
    "```json",
    bodyShape,
    "```",
    "",
    "## Done",
    `${REVIEW_RESULT_FILE}, ${REVIEW_BODY_FILE} and ${REVIEW_REPORT_FILE} are in DORI_LANE_OUT and the done report is sent.`,
    "",
  ].join("\n");
};

export type ReviewLaunchRequest = {
  readonly key: string;
  readonly title: string;
  /** The brief file path (`<stateDir>/briefs/<key>.md`). */
  readonly brief: string;
  readonly cwd: string;
  /** The author lane's thread, shared with it. */
  readonly thread?: string;
};

export type ReviewLaunchResult =
  | { readonly kind: "started"; readonly lane: Lane; readonly startup: string }
  | { readonly kind: "held"; readonly reason: string }
  | { readonly kind: "refused"; readonly detail: string };

/**
 * Launches a review lane through the shared admission (placeLaunch + admitLaunch, `review: true`, this machine, the lane
 * default model, the snapshot as cwd, sharing the author's thread). A held machine is `held`; a launch refusal
 * (LaunchError, SandboxRefusal) is `refused`; anything else is rethrown.
 */
export const launchReviewLane = async (
  deps: FlowDeps, request: ReviewLaunchRequest, err: (line: string) => void = (line) => console.error(line),
): Promise<ReviewLaunchResult> => {
  const input: LaunchInput = {
    review: true, key: request.key, title: request.title, brief: request.brief, done: reviewDone(deps.config.stateDir, request.key),
    model: deps.config.defaultModel, cwd: request.cwd, machine: LOCAL_MACHINE, shareThread: true,
    ...(request.thread ? { thread: request.thread } : {}),
  };
  try {
    const placed = await placeLaunch(deps, input);
    const outcome = await admitLaunch(deps, input, placed, err);
    if (outcome.kind === "held") return { kind: "held", reason: `HOLD ${outcome.verdict.reasons.join(" | ")}` };
    return { kind: "started", lane: outcome.lane, startup: outcome.startup };
  } catch (e) {
    if (e instanceof LaunchError) return { kind: "refused", detail: e.message };
    throw e;
  }
};
