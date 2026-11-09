import { MessengerError } from "./messenger/http.ts";
import { resolveTarget } from "./messenger/target.ts";
import { appendToMessage, closedByOwner, closedThreadLine, type FollowUpDiscord, lastReportIn } from "./thread-followup.ts";

/**
 * postOwnerLine: how the supervisor's durable owner outbox (supervise-owner-tracking.ts) posts a lead-status line
 * (lead stuck, lead restarts capped) into a Discord thread or the owner's main channel.
 */

export type FinishDiscord = FollowUpDiscord;

export type OwnerLineOptions = {
  /** The state directory: where the owner's thread closes and the lanes' last reports are recorded. */
  readonly stateDir?: string;
  /** The lane `[System]` status message in a thread, used when no report was posted there. */
  readonly statusMessage?: (thread: string) => Promise<string | undefined>;
};

/** A thread that is gone or closed to the bot: the line goes to the main channel instead of being retried there. */
const unreachable = (e: unknown): boolean => e instanceof MessengerError && (e.status === 403 || e.status === 404);

const toMain = async (discord: FinishDiscord, main: string | undefined, text: string, id: string): Promise<string> => {
  if (!main) throw new Error("no discordChannels configured");
  await discord.send(main, text, id);
  return main;
};

/**
 * Posts an owner line: into the lane thread `thread` (a `discord:<channel>[/<thread>]` ref) when there is one, else to
 * `main`. In a thread nothing new is posted when it can be avoided: the line is appended by editing the last
 * `dori reported` post there (else the lane's `[System]` status message); only a thread with neither gets a new post.
 * A thread the owner closed (closedByOwner) is never posted into: the line goes to `main` as one line linking the thread,
 * as does a line too long to append. A thread Discord answers 403/404 for falls back to `main`; any other failure
 * throws, so the outbox retries it (the stable id keeps a retried send from duplicating, and a retried append finds its
 * text already there). An archived thread, reopened by a post, is archived again; that read-back failing is logged,
 * never retried, since the line is already posted. Returns where it went.
 */
export const postOwnerLine = async (discord: FinishDiscord, main: string | undefined, thread: string | undefined, text: string, id: string, options: OwnerLineOptions = {}): Promise<string> => {
  if (thread?.startsWith("discord:")) {
    const to = resolveTarget("discord", thread).to;
    const threadId = /^discord:[^/]+\/(\d+)$/.exec(thread)?.[1];
    try {
      if (threadId && options.stateDir && await closedByOwner(options.stateDir, discord, threadId)) return await toMain(discord, main, closedThreadLine(threadId, text), id);
      const archived = threadId ? await discord.threadArchived(threadId) : false;
      const report = threadId ? (options.stateDir ? lastReportIn(options.stateDir, threadId)?.message : undefined) ?? await options.statusMessage?.(threadId) : undefined;
      if (threadId && report) {
        if (await appendToMessage(discord, threadId, report, text, archived)) return threadId;
        return await toMain(discord, main, closedThreadLine(threadId, text), id);
      }
      await discord.send(to, text, id);
      if (archived && threadId) {
        await discord.setThread(threadId, { archived: true }).catch((e: unknown) => {
          console.error(`LANE_FINISH_REARCHIVE_FAILED ${threadId} ${e instanceof Error ? e.message : String(e)}`);
        });
      }
      return to;
    } catch (e) {
      if (!unreachable(e)) throw e;
      console.error(`LANE_FINISH_THREAD_UNREACHABLE ${thread} ${e instanceof Error ? e.message : String(e)}; posting to the main channel`);
    }
  }
  return toMain(discord, main, text, id);
};
