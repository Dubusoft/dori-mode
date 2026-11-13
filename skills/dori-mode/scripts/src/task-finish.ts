import { LANE_DONE_EVENT, LANE_FAILED_EVENT } from "./autopilot.ts";
import type { Lane } from "./registry.ts";
import type { ToodoWriter } from "./toodo-client.ts";

/**
 * The follow-up of a lane that closed after its PR merged, done by the supervisor instead of the lead: the lane's Toodo
 * task (`dori launch --task`) gets every pending manual criterion checked with the merge as evidence and is completed
 * with a note naming the PR and its merge SHA (ToodoWriter reads every write back), then the lane's last report gets
 * the merge appended. The close line then carries `toodo=done` and, after a claim the lead already took, is digest
 * (event-policy.ts). Anything else (no task, no merge read back, a refused or unconfirmed write) is left to the lead.
 *
 * An autopilot lane's close is told the same way: its AUTOPILOT_LANE_DONE is rewritten `toodo=done` (digest) once the
 * supervisor completed the task (finishedOutcome). An autopilot task the supervisor did not finish, or whose lane closed
 * cancelled, gets a blocker note (taskBlocker, read back) and its one failure line says so; done-flow.ts marks the
 * launch attempt (autopilot.ts markLaneToodo) so the task is written to and told about once, and never relaunched.
 */

/** A lane PR read back merged: its merge SHA and base, as CI_MERGED / MERGE_VERIFIED report them. */
export type LaneMerge = { readonly repo: string; readonly number: number; readonly url: string; readonly base: string; readonly sha: string };

/**
 * What a close says about its task, as `toodo=<tag>` on the close line: `done` (completed and read back; the report was
 * appended, or there was nothing it could be appended to without a new post), `append-failed` (completed, the append
 * failed), `failed` (not completed), `unmerged` (no merge read back, so not completed), `no-task`.
 */
export type TaskFinishTag = "done" | "append-failed" | "failed" | "unmerged" | "no-task";
export type TaskFinish = { readonly tag: TaskFinishTag; readonly lines: readonly string[] };

/** How an append ended: `appended`, or `skipped` with why (a closed thread, no report message, too long). Throws on a failed edit. */
export type AppendOutcome = { readonly appended: true; readonly message: string } | { readonly appended: false; readonly why: string };

export type TaskFinisherDeps = {
  readonly writer: Pick<ToodoWriter, "read" | "checkCriterion" | "completeTask">;
  /** Appends `text` to `lane`'s last report (thread-followup.ts appendFollowUp). */
  readonly append: (lane: Lane, text: string) => Promise<AppendOutcome>;
};

export type TaskFinisher = (lane: Lane, task: number, merges: readonly LaneMerge[]) => Promise<TaskFinish>;

const flat = (text: string, max = 200): string => text.replace(/\s+/g, " ").trim().slice(0, max);
const errorText = (e: unknown): string => flat(e instanceof Error ? e.message : String(e));

/** Records why an autopilot lane's task was not finished, as a blocker note; returns what to say about it (never throws). */
export type TaskBlocker = (lane: Lane, task: number, why: string) => Promise<string>;

/**
 * The blocker note is the same text for the same lane and reason, so a repeated write finds it and sends nothing
 * (ToodoWriter.reportBlocker). The task's status stays: the lead decides whether to fix, drop or retry it.
 */
export const taskBlocker = (writer: Pick<ToodoWriter, "reportBlocker">): TaskBlocker => async (lane, task, why) => {
  const note = `Autopilot lane ${lane.key} ended without finishing this task: ${flat(why, 500)}. Autopilot does not launch it again; the lead decides whether to fix, drop or retry it.`;
  try {
    await writer.reportBlocker(task, note);
    return `blocker recorded on toodo task #${task}`;
  } catch (e) {
    return `blocker not recorded on toodo task #${task}: ${errorText(e)}`;
  }
};

/** Tags whose task the supervisor completed and read back. */
export const taskCompleted = (finish: TaskFinish | undefined): boolean => finish?.tag === "done" || finish?.tag === "append-failed";

/**
 * An autopilot outcome line after its lane's task follow-up: AUTOPILOT_LANE_DONE asks the lead to complete the task only
 * while the supervisor has not (`toodo=done` otherwise, which is digest). Any other line is returned as is.
 */
export const finishedOutcome = (line: string, finish: TaskFinish | undefined): string =>
  line.startsWith(`${LANE_DONE_EVENT} `) && taskCompleted(finish)
    ? line.replace(/: complete toodo task (#\d+)$/, " toodo=done: toodo task $1 completed and read back by the supervisor")
    : line;

/** An AUTOPILOT_LANE_FAILED line with what was recorded on its task (`said`, from TaskBlocker) and `toodo=blocked`. */
export const blockedOutcome = (line: string, said: string): string =>
  line.startsWith(`${LANE_FAILED_EVENT} `) ? line.replace(/: tell the owner; /, ` toodo=blocked: ${said}; tell the owner; `) : line;

export const notCompletedLine = (lane: Lane, task: number, why: string): string =>
  `TOODO_TASK_NOT_COMPLETED ${lane.key} #${task} ${flat(why)}; finish it yourself (complete_task with the PR and its merge SHA, then dori reported ${lane.key} --append)`;

export const taskFinisher = (deps: TaskFinisherDeps): TaskFinisher => async (lane, task, merges) => {
  const merged = merges.map((m) => `${m.url} merged into ${m.base} as ${m.sha}`).join("; ");
  try {
    const record = await deps.writer.read(task);
    const evidence = `${merged} (lane ${lane.key} closed after its Done signals read back live)`;
    for (const criterion of record.criteria) {
      // A URL criterion is checked by toodo itself when the task completes.
      if (criterion.kind === "manual" && criterion.state !== "met") await deps.writer.checkCriterion(task, criterion.id, evidence);
    }
    await deps.writer.completeTask(task, { note: `Merged: ${merged}. Completed by the dori supervisor when lane ${lane.key} closed.`, refs: merges.map((m) => m.url) });
  } catch (e) {
    return { tag: "failed", lines: [notCompletedLine(lane, task, `toodo: ${errorText(e)}`)] };
  }
  const text = `머지 확인: ${merges.map((m) => `${m.url} (${m.sha.slice(0, 7)})`).join(", ")} · Toodo #${task} 완료`;
  const head = `TOODO_TASK_COMPLETED ${lane.key} #${task} ${merges.map((m) => `${m.url} merge=${m.sha}`).join(" ")}`;
  try {
    const appended = await deps.append(lane, text);
    return { tag: "done", lines: [`${head}; report ${appended.appended ? `appended (${appended.message})` : `not appended: ${appended.why}`}`] };
  } catch (e) {
    return { tag: "append-failed", lines: [`${head}; report not appended: ${errorText(e)}; append it with dori reported ${lane.key} --append`] };
  }
};
