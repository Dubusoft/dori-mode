import { LANE_DONE_EVENT, LANE_FAILED_EVENT } from "./autopilot.ts";
import type { Lane } from "./registry.ts";
import type { ToodoWriter } from "./toodo-client.ts";

/**
 * The follow-up of a lane that closed after its PR merged, done by the supervisor instead of the lead: the lane's Toodo
 * task (`dori launch --task`) gets every pending manual criterion checked with the merge as evidence and is completed
 * with a note naming the PR and its merge SHA (ToodoWriter reads every write back), then the lane's last report gets
 * the merge appended as one fixed fact line (mergeFactLine). The close line then carries `toodo=done` and, after a claim
 * the lead already took, is digest (event-policy.ts). A merged lane with no task gets the same line with no Toodo part
 * (`MERGE_FACT <key> ...`, digest); its close stays `toodo=no-task`. So does a lane whose task toodo refused or did not
 * confirm: the merge is appended without the Toodo part and the task is left to the lead (`toodo=failed`). With no merge
 * read back nothing is appended and the task is left to the lead.
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
 * appended, or there was nothing it could be appended to without a new post; or, with no merge read back, the task
 * already reads done and completed), `append-failed` (completed, the append failed), `failed` (not completed),
 * `unmerged` (no merge read back and the task not read done, so not completed), `no-task`.
 */
export type TaskFinishTag = "done" | "append-failed" | "failed" | "unmerged" | "no-task";
export type TaskFinish = { readonly tag: TaskFinishTag; readonly lines: readonly string[] };

/** How an append ended: `appended`, or `skipped` with why (a closed thread, no report message, too long). Throws on a failed edit. */
export type AppendOutcome = { readonly appended: true; readonly message: string } | { readonly appended: false; readonly why: string };

export type TaskFinisherDeps = {
  readonly writer: Pick<ToodoWriter, "read" | "checkCriterion" | "completeTask">;
  /** Appends `text` to `lane`'s last report (thread-followup.ts appendFollowUp). */
  readonly append: (lane: Lane, text: string) => Promise<AppendOutcome>;
  /** The owner's language (config ownerLanguage), read at each finish so a config reload applies. */
  readonly language?: () => string | undefined;
};

/** The merges of a closed lane (done-flow.ts laneMerges), or why none was read back. */
export type LaneMergeRead = { readonly merges: readonly LaneMerge[] } | { readonly why: string };

/** `task` is undefined for a lane with no Toodo task: only the merge fact line is appended. */
export type TaskFinisher = (lane: Lane, task: number | undefined, read: LaneMergeRead) => Promise<TaskFinish>;

const flat = (text: string, max = 200): string => text.replace(/\s+/g, " ").trim().slice(0, max);
const errorText = (e: unknown): string => flat(e instanceof Error ? e.message : String(e));

const FACT_WORDS = {
  ko: { merged: "머지", done: (task: number) => `Toodo #${task} 완료` },
  ja: { merged: "マージ", done: (task: number) => `Toodo #${task} 完了` },
  zh: { merged: "已合并", done: (task: number) => `Toodo #${task} 已完成` },
  en: { merged: "Merged", done: (task: number) => `Toodo #${task} done` },
} as const;

const factLanguage = (language: string | undefined): keyof typeof FACT_WORDS => {
  const l = (language ?? "").trim().toLowerCase();
  if (/^ko\b|korean|한국/.test(l)) return "ko";
  if (/^ja\b|japanese|日本/.test(l)) return "ja";
  if (/^zh\b|chinese|中文|汉语|漢語/.test(l)) return "zh";
  return "en";
};

/**
 * The fact line appended to a merged lane's report, with no judgment in it: each PR as `<repo>#<n> (<sha7>)`, then its
 * Toodo task done when the supervisor completed it, in the owner's language (Korean, Japanese, Chinese; else English).
 */
export const mergeFactLine = (merges: readonly LaneMerge[], task: number | undefined, language: string | undefined): string => {
  const words = FACT_WORDS[factLanguage(language)];
  const pulls = merges.map((m) => `${m.repo}#${m.number} (${m.sha.slice(0, 7)})`).join(", ");
  return `${words.merged} ${pulls}${task === undefined ? "" : ` · ${words.done(task)}`}`;
};

const appendedText = (appended: AppendOutcome): string => appended.appended ? `appended (${appended.message})` : `not appended: ${appended.why}`;

/** The lead's fallback for a fact line the supervisor could not append: an append that never redirects. */
const appendYourself = (lane: Lane): string => `dori reported ${lane.key} --append TEXT --no-redirect`;

/**
 * Appends the merge fact line with no Toodo part (a lane with no task, or one whose task the supervisor did not complete)
 * and says how it ended as a `MERGE_FACT <key> ...` line (digest). Never throws.
 */
const appendMergeFact = async (deps: TaskFinisherDeps, lane: Lane, merges: readonly LaneMerge[]): Promise<string> => {
  const head = `MERGE_FACT ${lane.key} ${merges.map((m) => `${m.url} merge=${m.sha}`).join(" ")}`;
  try {
    return `${head}; report ${appendedText(await deps.append(lane, mergeFactLine(merges, undefined, deps.language?.())))}`;
  } catch (e) {
    return `${head}; report not appended: ${errorText(e)}; append it with ${appendYourself(lane)}`;
  }
};

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
  `TOODO_TASK_NOT_COMPLETED ${lane.key} #${task} ${flat(why)}; finish it yourself (complete_task with the PR and its merge SHA, then ${appendYourself(lane)})`;

/**
 * A close with no merge read back (no PR of the lane, or one not read merged) completes nothing. Its task is read first:
 * one the lead already finished (done, completed) needs no follow-up, so the close says `toodo=done` with no line;
 * otherwise, or when the read fails, the lead is told to finish it.
 */
const unmergedFinish = async (writer: Pick<ToodoWriter, "read">, lane: Lane, task: number, why: string): Promise<TaskFinish> => {
  let unread = "";
  try {
    const record = await writer.read(task);
    if (record.status === "done" && record.resolution === "completed") return { tag: "done", lines: [] };
  } catch (e) {
    unread = `; the task could not be read: ${errorText(e)}`;
  }
  return { tag: "unmerged", lines: [notCompletedLine(lane, task, `no merge read back: ${why}${unread}`)] };
};

export const taskFinisher = (deps: TaskFinisherDeps): TaskFinisher => async (lane, task, read) => {
  if (task === undefined) return "why" in read ? { tag: "no-task", lines: [] } : { tag: "no-task", lines: [await appendMergeFact(deps, lane, read.merges)] };
  if ("why" in read) return unmergedFinish(deps.writer, lane, task, read.why);
  const { merges } = read;
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
    // The merge still happened: its fact line is appended without the Toodo part, and the task stays the lead's.
    return { tag: "failed", lines: [notCompletedLine(lane, task, `toodo: ${errorText(e)}`), await appendMergeFact(deps, lane, merges)] };
  }
  const text = mergeFactLine(merges, task, deps.language?.());
  const head = `TOODO_TASK_COMPLETED ${lane.key} #${task} ${merges.map((m) => `${m.url} merge=${m.sha}`).join(" ")}`;
  try {
    const appended = await deps.append(lane, text);
    return { tag: "done", lines: [`${head}; report ${appendedText(appended)}`] };
  } catch (e) {
    return { tag: "append-failed", lines: [`${head}; report not appended: ${errorText(e)}; append it with ${appendYourself(lane)}`] };
  }
};
