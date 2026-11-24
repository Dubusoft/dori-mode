import { displayTime } from "./display-time.ts";
import type { FlowDeps } from "./done-flow.ts";
import { relayedText, scrubForThread } from "./freshness.ts";
import { Discord, DISCORD_MESSAGES_PAGE, DISCORD_SUPPRESS_NOTIFICATIONS } from "./messenger/discord.ts";
import { fetchHttp } from "./messenger/http.ts";
import { resolveTarget } from "./messenger/target.ts";
import { type LaneReport, type LaneReportStore } from "./lane-report-store.ts";
import { errLine, oneLine } from "./line-text.ts";
import type { Clock } from "./run.ts";
import type { Lane } from "./registry.ts";
import type { ReportKind } from "./runner/report-kinds.ts";
import { ownerClosedRecorded, redirectIfClosed } from "./thread-followup.ts";

/** A message posted after a lane's status message, as the status check reads it: by the bot itself, its Discord type, its text. */
export type LaterMessage = { readonly own: boolean; readonly type: number; readonly content: string };

/**
 * Posts, edits and deletes a lane's status message in its thread; `post` returns the new message's id and `silent` posts
 * it without a notification. `threadState` tells a thread the owner closed (thread-followup.ts closedByOwner) from one
 * that is open and names its last message; `laterMessages` lists what was posted after a message (`more` when Discord
 * has more than one page of them).
 */
export type LaneStatusTransport = {
  post(channel: string, text: string, stableId: string, silent?: boolean): Promise<string>;
  edit(channel: string, messageId: string, text: string): Promise<void>;
  remove(channel: string, messageId: string): Promise<void>;
  threadState(threadId: string): Promise<{ readonly archived: boolean; readonly parent: string | undefined; readonly lastMessageId?: string | undefined }>;
  laterMessages(channel: string, afterId: string): Promise<{ readonly messages: readonly LaterMessage[]; readonly more: boolean }>;
};

/** The status transport over a Discord client (the supervisor's own, or one on DORI_DISCORD_TOKEN). */
export const statusTransportOf = (discord: Discord): LaneStatusTransport => ({
  post: (channel, text, stableId, silent) => discord.send(channel, text, stableId, undefined, silent ? DISCORD_SUPPRESS_NOTIFICATIONS : undefined),
  edit: (channel, id, text) => discord.edit(channel, id, text),
  remove: (channel, id) => discord.deleteMessage(channel, id),
  threadState: (threadId) => discord.threadState(threadId),
  laterMessages: async (channel, afterId) => {
    const [me, messages] = await Promise.all([discord.selfId(), discord.messagesAfter(channel, afterId)]);
    return { messages: messages.map((m) => ({ own: m.authorId === me, type: m.type, content: m.content })), more: messages.length >= DISCORD_MESSAGES_PAGE };
  },
});

/**
 * The Discord status transport, on DORI_DISCORD_TOKEN from the process environment (the supervisor unit loads it from
 * its EnvironmentFile); undefined without a token, so progress falls back to hooks.threadReply or the lead's journal.
 */
export const discordStatusTransport = (clock: Clock, env: Readonly<Record<string, string | undefined>> = process.env): LaneStatusTransport | undefined => {
  const token = env.DORI_DISCORD_TOKEN?.trim();
  if (!token) return undefined;
  return statusTransportOf(new Discord(fetchHttp, clock, token));
};

/** Longest report text a status message line carries. */
export const STATUS_TEXT_MAX = 300;

const elapsed = (ms: number): string => {
  const min = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`;
};

/**
 * The text of a lane's status message as of `report` (absent: every row): its key, time since it opened, and its last
 * milestone and last progress (rows up to `report`, late ones left out), each with its time, scrubbed like a thread post.
 */
export const laneStatusText = (
  lane: Lane, rows: readonly LaneReport[], report: LaneReport | undefined, now: number, home: string, timeZone?: string, review: readonly string[] = [],
): string => {
  const stamp = (at: number): string => displayTime(at, timeZone);
  const upTo = rows.filter((r) => (!report || r.seq <= report.seq) && r.route !== "late" && (r.kind === "milestone" || r.kind === "progress"));
  const last = (kind: ReportKind): LaneReport | undefined =>
    [...upTo, ...(!report || upTo.some((r) => r.id === report.id) ? [] : [report])].filter((r) => r.kind === kind).sort((a, b) => a.seq - b.seq).at(-1);
  const line = (label: string, row: LaneReport | undefined): string => {
    if (!row) return `${label}: 아직 없음`;
    const text = scrubForThread(oneLine(row.text), home);
    return `${label} (${stamp(row.at)}): ${text.length <= STATUS_TEXT_MAX ? text : `${text.slice(0, STATUS_TEXT_MAX)}...`}`;
  };
  const opened = Date.parse(lane.openedAt);
  return [
    `[System] 레인 ${lane.key} 상태, 진행 ${Number.isNaN(opened) ? "(알 수 없음)" : elapsed(now - opened)} (갱신 ${stamp(now)})`,
    line("마지막 마일스톤", last("milestone")),
    line("마지막 진행", last("progress")),
    ...review.map((line) => scrubForThread(line, home)),
  ].join("\n");
};

const STATUS_HEAD = /^\[System\] 레인 \S+ 상태, 진행 /;

/** Whether `text` is a lane status message (laneStatusText) of any lane. */
export const isLaneStatusText = (text: string): boolean => STATUS_HEAD.test(text);

/**
 * Whether status message `statusId` is still the latest thing in thread `channel`: the thread is not archived, and
 * either its last message is the status message or everything posted after it is the bot's own plain status message
 * of some lane (so lanes sharing a thread never push each other's status up). Anything else after it, a thread system
 * message (rename, member added, pin) included, means it is not.
 */
const statusIsLatest = async (transport: LaneStatusTransport, channel: string, statusId: string): Promise<boolean> => {
  const state = await transport.threadState(channel);
  if (state.archived) return false;
  if (state.lastMessageId === statusId) return true;
  const later = await transport.laterMessages(channel, statusId);
  return !later.more && later.messages.every((m) => m.own && m.type === 0 && isLaneStatusText(m.content));
};

/** The Discord channel id of a lane's thread, or undefined for no thread or a non-Discord one. */
export const statusChannel = (lane: Lane): string | undefined =>
  lane.thread !== "none" && lane.thread.startsWith("discord:") ? resolveTarget("discord", lane.thread).to : undefined;

/**
 * Keeps the lane's status message at the bottom of its thread with the text as of `report`. While it is still the latest
 * there (statusIsLatest) it is edited in place; once something else was posted after it, or Discord archived the thread,
 * a new one is posted without a notification, its id stored on the lane (statusMessageId), and only then the old one
 * deleted (a failed delete is logged). It is posted when there is none yet or the edit fails (a deleted message). A failed
 * latest check is logged and the message edited as before. A thread the owner closed is neither edited nor
 * posted into (either would reopen it): the report goes as one line linking the thread to its parent channel, else the
 * owner channel (redirectIfClosed), and the status message is left as it is. A failed post throws.
 */
export const upsertStatus = async (
  deps: FlowDeps, transport: LaneStatusTransport, channel: string, lane: Lane, store: LaneReportStore, report: LaneReport, home: string,
  review: readonly string[] = [],
): Promise<void> => {
  const relayed = relayedText(lane.key, scrubForThread(oneLine(report.text), home));
  const redirected = await redirectIfClosed(deps.config.stateDir, transport, channel, relayed, deps.config.discordChannels[0],
    (target, line) => transport.post(target, line, `lane-status:${report.id}`));
  if (redirected) {
    console.error(`LANE_STATUS_REDIRECTED ${lane.key} ${report.id}: thread ${channel} was closed by the owner, so one line went to ${redirected}`);
    return;
  }
  const text = laneStatusText(lane, store.list({ lane: lane.key }), report, deps.clock.now(), home, deps.config.displayTimeZone, review);
  await writeLaneStatus(deps, transport, channel, lane, text, `lane-status:${report.id}`);
};

/**
 * Writes `text` as the lane's status message in `channel` (upsertStatus without the closed-thread redirect): edited in
 * place while it is the latest, else posted anew without a notification and the old one deleted; posted when there is
 * none yet (silent when `silent`) or the edit fails. A failed post throws; nothing but the lane's statusMessageId changes.
 */
export const writeLaneStatus = async (
  deps: FlowDeps, transport: LaneStatusTransport, channel: string, lane: Lane, text: string, stableId: string, silent = false,
): Promise<void> => {
  const previous = lane.statusMessageId;
  if (previous) {
    let latest = true;
    try { latest = await statusIsLatest(transport, channel, previous); }
    catch (e) { console.error(`LANE_STATUS_CHECK_FAILED ${lane.key} ${previous} ${errLine(e, 160)}; editing it in place`); }
    if (!latest) {
      const id = await transport.post(channel, text, stableId, true);
      await deps.registry.patch(lane.key, { statusMessageId: id });
      try { await transport.remove(channel, previous); }
      catch (e) { console.error(`LANE_STATUS_DELETE_FAILED ${lane.key} ${previous} ${errLine(e, 160)}`); }
      return;
    }
    try {
      await transport.edit(channel, previous, text);
      return;
    } catch (e) {
      console.error(`LANE_STATUS_EDIT_FAILED ${lane.key} ${previous} ${errLine(e, 160)}; posting a new status message`);
    }
  }
  const id = await transport.post(channel, text, stableId, silent);
  await deps.registry.patch(lane.key, { statusMessageId: id });
};

/** How long after it opened a lane that has not reported yet gets its first status message from the supervisor. */
export const FIRST_STATUS_AFTER_MS = 2 * 60_000;
/** Lanes opened longer ago than this never get a first status message (no burst over older lanes when this ships). */
export const FIRST_STATUS_WINDOW_MS = 15 * 60_000;

/**
 * Posts the first status message of each open lane whose thread has none yet FIRST_STATUS_AFTER_MS after it opened (and
 * within FIRST_STATUS_WINDOW_MS), so the owner sees the lane working in its thread even before its first progress or
 * milestone report. Skips a lane still reserving its launch, one with no Discord thread, and a thread the owner closed.
 * A failed post is logged and retried on the next pass. Returns one log line per posted message.
 */
export const firstStatusTick = async (
  deps: FlowDeps, transport: LaneStatusTransport, store: LaneReportStore, home: string,
): Promise<string[]> => {
  const out: string[] = [];
  const now = deps.clock.now();
  for (const lane of await deps.registry.open()) {
    const channel = statusChannel(lane);
    const age = now - Date.parse(lane.openedAt);
    if (lane.statusMessageId || lane.launchReservation || !channel || !(age >= FIRST_STATUS_AFTER_MS && age < FIRST_STATUS_WINDOW_MS)) continue;
    if (ownerClosedRecorded(deps.config.stateDir, lane.thread)) continue;
    try {
      const text = laneStatusText(lane, store.list({ lane: lane.key }), undefined, now, home, deps.config.displayTimeZone);
      await writeLaneStatus(deps, transport, channel, lane, text, `lane-status:first:${lane.key}`);
      out.push(`LANE_STATUS_FIRST ${lane.key}`);
    } catch (e) {
      console.error(`LANE_STATUS_FIRST_FAILED ${lane.key} ${errLine(e, 160)}`);
    }
  }
  return out;
};
