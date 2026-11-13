import type { Lane } from "./registry.ts";
import type { ToodoWriter } from "./toodo-client.ts";

/**
 * The follow-up of a lane that closed after its PR merged, done by the supervisor instead of the lead: the lane's Toodo
 * task (`dori launch --task`) gets every pending manual criterion checked with the merge as evidence and is completed
 * with a note naming the PR and its merge SHA (ToodoWriter reads every write back), then the lane's last report gets
 * the merge appended. The close line then carries `toodo=done` and, after a claim the lead already took, is digest
 * (event-policy.ts). Anything else (no task, no merge read back, a refused or unconfirmed write) is left to the lead.
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
