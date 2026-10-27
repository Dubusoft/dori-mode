import { MessengerError } from "./messenger/http.ts";
import { resolveTarget } from "./messenger/target.ts";

/**
 * The supervisor's own lane-finish line (laneFinishNotice): a lane the supervisor saw finish (LANE_CLOSED,
 * LANE_AUTO_CLOSED, CI_MERGED ... lane=<key>, MERGE_VERIFIED ... lane=<key>) gets one plain line in its thread, or the
 * main channel when it has none, so the owner hears of it even while the lead is busy or restarting.
 * It is not the lead's report: the lead still reports the outcome itself and runs `dori reported` (lane-outcomes.ts).
 *
 * Once per lane: the line goes through the durable owner outbox under id `lane-finish:<key>`, and the same id is
 * journaled as an engine-only LANE_FINISH_NOTICE event, whose dedupe (and tombstone) outlives the outbox row.
 */

export const LANE_FINISH_PREFIX = "lane-finish:";
/** A finish line waits this long before its first post, so CI_MERGED and LANE_CLOSED of one lane become one line. */
export const LANE_FINISH_HOLD_MS = 60_000;

const LANE_KEY = /^[\w.-]+$/;
const PULL_URL = /https:\/\/\S+\/pull\/\d+/;

/** What is known about a finished lane; stored as the outbox item's text (JSON) until it is posted. */
export type LaneFinish = {
  readonly lane: string;
  readonly merged?: true;
  readonly closed?: "closed" | "auto-closed";
  /** The PR URL, else its `owner/repo#N` ref. */
  readonly pr?: string;
  readonly merge?: string;
};

/** The finish facts one event line carries, or undefined for a line that does not finish a lane. */
export const laneFinish = (line: string): LaneFinish | undefined => {
  const [kind = "", second = ""] = line.split(" ");
  const closing = kind === "LANE_CLOSED" || kind === "LANE_AUTO_CLOSED";
  const merging = kind === "CI_MERGED" || kind === "MERGE_VERIFIED";
  const lane = closing ? second : merging ? / lane=(\S+)/.exec(line)?.[1] : undefined;
  if (!lane || !LANE_KEY.test(lane)) return undefined;
  const pr = PULL_URL.exec(line)?.[0] ?? (merging && /^[\w.-]+\/[\w.-]+#\d+$/.test(second) ? second : undefined);
  const merge = / merge=([0-9a-f]{7,40})\b/.exec(line)?.[1];
  return {
    lane,
    ...(merging ? { merged: true as const } : {}),
    ...(closing ? { closed: kind === "LANE_AUTO_CLOSED" ? "auto-closed" as const : "closed" as const } : {}),
    ...(pr ? { pr } : {}),
    ...(merge ? { merge } : {}),
  };
};

/** Two fact sets of one lane joined; the earlier wins where both know a value. */
export const mergeFinish = (a: LaneFinish, b: LaneFinish): LaneFinish => ({
  lane: a.lane,
  ...(a.merged ?? b.merged ? { merged: true as const } : {}),
  ...(a.closed ?? b.closed ? { closed: a.closed ?? b.closed } : {}),
  ...(a.pr ?? b.pr ? { pr: a.pr && PULL_URL.test(a.pr) ? a.pr : b.pr && PULL_URL.test(b.pr) ? b.pr : a.pr ?? b.pr } : {}),
  ...(a.merge ?? b.merge ? { merge: a.merge ?? b.merge } : {}),
});

/** Parses an outbox item's stored facts; undefined when the text is not one (never thrown). */
export const parseFinish = (text: string): LaneFinish | undefined => {
  try {
    const value = JSON.parse(text) as Partial<LaneFinish>;
    return typeof value?.lane === "string" && LANE_KEY.test(value.lane) ? value as LaneFinish : undefined;
  } catch { return undefined; }
};

/** The one plain line: `Lane <key> finished (<title>): merged and closed. PR <url>. Merge <sha>.` */
export const laneFinishText = (finish: LaneFinish, title?: string): string => {
  const outcome = [finish.merged ? "merged" : "", finish.closed ?? ""].filter(Boolean).join(" and ") || "finished";
  const name = title?.replace(/\s+/g, " ").trim();
  return [
    `Lane ${finish.lane} finished${name ? ` (${name.slice(0, 200)})` : ""}: ${outcome}.`,
    ...(finish.pr ? [`PR ${finish.pr}.`] : []),
    ...(finish.merge ? [`Merge ${finish.merge.slice(0, 12)}.`] : []),
  ].join(" ");
};

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
