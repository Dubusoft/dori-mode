import { randomUUID } from "node:crypto";

import type { DoriConfig } from "./config.ts";
import { recordReported } from "./lane-outcomes.ts";
import { oneLine } from "./lane-report-store.ts";
import { discordThreadOf, resolveTarget } from "./messenger/target.ts";
import type { Lane } from "./registry.ts";
import { closedByOwner, closedThreadLine, type FollowUpDiscord, recordLastReport } from "./thread-followup.ts";

/**
 * A lane's outcome report to the owner, posted and recorded the one way both `dori reported <key> --text` (the lead) and
 * the supervisor's auto report of a clean done claim (done-flow.ts) do it: into the lane's thread (or `to`), as the
 * lane's last report (thread-followup.ts recordLastReport, so the merge fact the supervisor appends at the close lands on
 * it), then the receipt that closes the lane's report obligation (lane-outcomes.ts recordReported). A thread the owner
 * closed gets nothing: one line linking it goes to its parent channel (else the owner channel) as a follow-up receipt.
 * A failed post records nothing, so the obligation stays open.
 */

export class ReportPostError extends Error {}

export type ReportPostDeps = {
  /** The live config: its first discordChannels entry is the owner channel a closed thread's line falls back to. */
  readonly config: Pick<DoriConfig, "stateDir" | "discordChannels">;
  readonly discord: Pick<FollowUpDiscord, "send" | "threadState">;
  readonly now: () => number;
};

export type ReportPosted =
  | { readonly kind: "posted"; readonly message: string }
  /** `parent`: the line went to the closed thread's parent channel, else to the owner channel. */
  | { readonly kind: "redirected"; readonly message: string; readonly thread: string; readonly target: string; readonly parent: boolean };

/**
 * Posts one line linking thread `thread`, which the owner closed, to its parent channel (else the owner channel) and
 * records it as a follow-up receipt of lane `lane`. Throws ReportPostError, posting nothing, when neither is known.
 */
export const redirectReport = async (
  deps: ReportPostDeps, lane: string, thread: string, text: string, parent: string | undefined, note?: string,
): Promise<ReportPosted> => {
  const target = parent ?? deps.config.discordChannels[0];
  if (!target) throw new ReportPostError(`REPORT_NOT_POSTED ${lane}: thread ${thread} was closed by the owner, its parent channel is unknown and no discordChannels entry names the owner channel; nothing recorded`);
  const message = await deps.discord.send(target, closedThreadLine(thread, text), randomUUID());
  recordReported(deps.config.stateDir, lane, deps.now(), note ? oneLine(note) : undefined, { message, target: `discord:${target}`, followUp: true });
  return { kind: "redirected", message, thread, target, parent: parent !== undefined };
};

const isDiscord = (ref: string | undefined): boolean => ref?.startsWith("discord:") === true;

/**
 * Posts `text` as lane `lane`'s report: to `to` (a thread ref, or a bare id when the lane's bound thread is a Discord
 * one) or the lane's bound thread, with `thread` naming the thread inside `to`. Throws ReportPostError, recording
 * nothing, when there is nowhere to post or Discord returns no message id.
 */
export const postLaneReport = async (
  deps: ReportPostDeps, lane: Lane, text: string, opts: { readonly to?: string; readonly thread?: string; readonly note?: string } = {},
): Promise<ReportPosted> => {
  const bound = lane.thread && lane.thread !== "none" ? lane.thread : undefined;
  const ref = opts.to ?? bound;
  if (!ref) throw new ReportPostError(`lane ${lane.key} has no bound thread; name where to post with --to TARGET (a thread ref such as discord:<channel>/<thread>)`);
  // A Discord ref posts there; a bare --to id posts on Discord only when the lane's bound thread is a Discord one.
  if (!isDiscord(ref) && (ref.includes(":") || !isDiscord(bound))) throw new ReportPostError(`cannot tell the platform of "${ref}"; use a thread ref such as discord:<channel>/<thread>`);
  const { to, thread } = resolveTarget("discord", ref, opts.thread);
  // `discord:<thread>` and a bare thread id count as a thread too, unless the id is a configured channel.
  const threadId = opts.thread ?? discordThreadOf(ref, deps.config.discordChannels);
  const closed = threadId === to ? await closedByOwner(deps.config.stateDir, deps.discord, to) : undefined;
  if (closed) return redirectReport(deps, lane.key, to, text, closed.parent, opts.note);
  // Each post is its own message: without a unique id Discord would dedupe a repeat of the same text.
  const message = await deps.discord.send(to, text, randomUUID());
  if (!message) throw new ReportPostError(`REPORT_NOT_POSTED ${lane.key}: discord returned no message id; nothing recorded`);
  // The message a later --append (and the supervisor's merge fact line) edits.
  if (threadId === to) recordLastReport(deps.config.stateDir, lane.key, { channel: to, message, at: deps.now() });
  // The lane's thread for the supervisor's automatic close: its bound thread, else the thread this report went into.
  const laneThread = (bound && isDiscord(bound) ? discordThreadOf(bound, deps.config.discordChannels) : undefined) ?? (threadId === to ? to : undefined);
  recordReported(deps.config.stateDir, lane.key, deps.now(), opts.note ? oneLine(opts.note) : undefined,
    { message, target: `discord:${to}${thread ? `/${thread}` : ""}`, ...(laneThread ? { thread: laneThread } : {}) });
  return { kind: "posted", message };
};
