import { MessengerError } from "./messenger/http.ts";
import { resolveTarget } from "./messenger/target.ts";

/**
 * postOwnerLine: how the supervisor's durable owner outbox (supervise-owner-tracking.ts) posts a lead-status line
 * (lead stuck, lead restarts capped) into a Discord thread or the owner's main channel.
 */

export type FinishDiscord = {
  send(channelId: string, content: string, stableId?: string): Promise<string>;
  threadArchived(threadId: string): Promise<boolean>;
  setThread(threadId: string, patch: { readonly archived?: boolean }): Promise<void>;
};

/** A thread that is gone or closed to the bot: the line goes to the main channel instead of being retried there. */
const unreachable = (e: unknown): boolean => e instanceof MessengerError && (e.status === 403 || e.status === 404);

/**
 * Posts an owner line: into the lane thread `thread` (a `discord:<channel>[/<thread>]` ref) when there is one, else to
 * `main`. A thread Discord answers 403/404 for falls back to `main`; any other failure throws, so the outbox retries
 * it (the stable id keeps a retried send from duplicating). An archived thread, reopened by the post, is archived
 * again; that read-back failing is logged, never retried, since the line is already posted. Returns where it went.
 */
export const postOwnerLine = async (discord: FinishDiscord, main: string | undefined, thread: string | undefined, text: string, id: string): Promise<string> => {
  if (thread?.startsWith("discord:")) {
    const to = resolveTarget("discord", thread).to;
    const threadId = /^discord:[^/]+\/(\d+)$/.exec(thread)?.[1];
    try {
      const archived = threadId ? await discord.threadArchived(threadId) : false;
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
  if (!main) throw new Error("no discordChannels configured");
  await discord.send(main, text, id);
  return main;
};
