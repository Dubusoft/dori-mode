import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DISCORD_MESSAGE_LIMIT } from "./messenger/discord.ts";
import { guardText } from "./messenger/http.ts";

/**
 * Follow-ups after a thread's work is reported (a merge result, a Toodo note) must not reopen a thread the owner closed:
 * a new post into an archived Discord thread unarchives it. So a follow-up is appended to the lane's last report by
 * editing that message, and anything addressed to a thread the owner closed goes to that thread's parent channel (else
 * the owner channel) as one line that links the thread instead.
 */

/** Threads the owner closed with the close-thread button, thread id -> when (epoch ms); written by `dori supervise`. */
export const OWNER_CLOSED_FILE = "owner-closed-threads.json";
/** Each lane's last `dori reported` post into a thread, lane key -> { channel, message, at }; written by `dori reported`. */
export const LAST_REPORTS_FILE = "last-reports.json";

export type LastReport = { readonly channel: string; readonly message: string; readonly at: number };

const readObject = (path: string): Record<string, unknown> => {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

const writeObject = (path: string, value: Record<string, unknown>): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
};

export const readOwnerClosed = (stateDir: string): Record<string, number> =>
  Object.fromEntries(Object.entries(readObject(join(stateDir, OWNER_CLOSED_FILE)))
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));

/** Records that the owner closed `thread` at `at` (tmp + rename). */
export const recordOwnerClosed = (stateDir: string, thread: string, at: number): void => {
  writeObject(join(stateDir, OWNER_CLOSED_FILE), { ...readOwnerClosed(stateDir), [thread]: at });
};

/** Drops `thread`'s close record: the thread is open again. */
export const forgetOwnerClosed = (stateDir: string, thread: string): void => {
  const closed = readOwnerClosed(stateDir);
  if (!(thread in closed)) return;
  delete closed[thread];
  writeObject(join(stateDir, OWNER_CLOSED_FILE), closed);
};

const isLastReport = (value: unknown): value is LastReport => {
  const v = value as Partial<LastReport> | null;
  return typeof v === "object" && v !== null && typeof v.channel === "string" && typeof v.message === "string" && typeof v.at === "number";
};

export const readLastReports = (stateDir: string): Record<string, LastReport> =>
  Object.fromEntries(Object.entries(readObject(join(stateDir, LAST_REPORTS_FILE))).filter((entry): entry is [string, LastReport] => isLastReport(entry[1])));

/** Records `lane`'s last report message (tmp + rename). */
export const recordLastReport = (stateDir: string, lane: string, report: LastReport): void => {
  writeObject(join(stateDir, LAST_REPORTS_FILE), { ...readLastReports(stateDir), [lane]: report });
};

/** The latest report message posted into `thread` by any lane, or undefined. */
export const lastReportIn = (stateDir: string, thread: string): LastReport | undefined =>
  Object.values(readLastReports(stateDir)).filter((report) => report.channel === thread).sort((a, b) => a.at - b.at).at(-1);

/** What a follow-up needs from Discord. */
export type FollowUpDiscord = {
  send(channelId: string, content: string, stableId?: string): Promise<string>;
  edit(channelId: string, messageId: string, content: string): Promise<void>;
  content(channelId: string, messageId: string): Promise<string>;
  threadArchived(threadId: string): Promise<boolean>;
  threadState(threadId: string): Promise<{ readonly archived: boolean; readonly parent: string | undefined }>;
  setThread(threadId: string, patch: { readonly archived?: boolean }): Promise<void>;
};

/**
 * Whether the owner closed `thread` and it is still closed: a close is recorded and Discord still reports the thread
 * archived. A recorded thread that is open again (the owner wrote in it) has its record dropped and counts as open.
 * A thread with no record is open without asking Discord. A closed thread comes back with its parent channel, where a
 * line redirected from it goes (undefined when Discord names none: the caller's owner channel then); an open one is undefined.
 */
export const closedByOwner = async (stateDir: string, discord: Pick<FollowUpDiscord, "threadState">, thread: string): Promise<{ readonly parent: string | undefined } | undefined> => {
  if (readOwnerClosed(stateDir)[thread] === undefined) return undefined;
  const state = await discord.threadState(thread);
  if (state.archived) return { parent: state.parent };
  forgetOwnerClosed(stateDir, thread);
  return undefined;
};

/** Longest follow-up text the owner-channel line carries. */
export const CLOSED_LINE_TEXT_MAX = 1500;

/** The redirected line for a thread the owner closed: a link to the thread (`<#id>`) and the text on one line. */
export const closedThreadLine = (thread: string, text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `<#${thread}> ${flat.length <= CLOSED_LINE_TEXT_MAX ? flat : `${flat.slice(0, CLOSED_LINE_TEXT_MAX)}...`}`;
};

/**
 * The closed-thread rule for a post the supervisor makes on its own (an owner notice, an alert, a lane status update):
 * when `channel` is a thread the owner closed (closedByOwner), nothing is posted or edited in it (either would need it
 * reopened) and `send` gets one line linking it (closedThreadLine) for the thread's parent channel, else `owner`.
 * Returns the channel the line went to, or undefined when `channel` is not closed by the owner (post there as usual).
 * Throws when the thread is closed and neither a parent nor `owner` is known.
 */
export const redirectIfClosed = async (
  stateDir: string, discord: Pick<FollowUpDiscord, "threadState">, channel: string, text: string, owner: string | undefined,
  send: (target: string, line: string) => Promise<unknown>,
): Promise<string | undefined> => {
  const closed = await closedByOwner(stateDir, discord, channel);
  if (!closed) return undefined;
  const target = closed.parent ?? owner;
  if (!target) throw new Error(`thread ${channel} was closed by the owner and neither its parent channel nor the owner channel is known`);
  await send(target, closedThreadLine(channel, text));
  return target;
};

/** The thread id a `discord:<channel>/<thread>` ref names, or undefined for any other ref. */
const threadOfRef = (ref: string): string | undefined => /^discord:[^/]+\/(\d+)$/.exec(ref)?.[1];

/** Whether a close by the owner is recorded for the thread lane thread ref `ref` names (no Discord read). */
export const ownerClosedRecorded = (stateDir: string, ref: string): boolean => {
  const thread = threadOfRef(ref);
  return thread !== undefined && readOwnerClosed(stateDir)[thread] !== undefined;
};

/** What a redirected hook post needs: the thread's state and a plain post (returning the message id). */
export type RedirectTransport = Pick<FollowUpDiscord, "threadState"> & { post(channel: string, text: string, stableId: string): Promise<string> };

/**
 * The closed-thread rule ahead of a post through hooks.threadReply into lane thread `ref` (the hook cannot tell a
 * closed thread): undefined when no close is recorded for it or Discord reports it open again (post through the hook);
 * else the channel one line linking it went to through `transport` (redirectIfClosed). Throws, posting nothing, when
 * the thread is recorded closed and there is no transport (no DORI_DISCORD_TOKEN) to post that line with.
 */
export const redirectHookPost = async (
  stateDir: string, transport: RedirectTransport | undefined, ref: string, text: string, owner: string | undefined, stableId: string,
): Promise<string | undefined> => {
  const thread = threadOfRef(ref);
  if (thread === undefined || readOwnerClosed(stateDir)[thread] === undefined) return undefined;
  if (!transport) throw new Error(`thread ${thread} was closed by the owner and there is no DORI_DISCORD_TOKEN to post one line to its parent channel`);
  return redirectIfClosed(stateDir, transport, thread, text, owner, (target, line) => transport.post(target, line, stableId));
};

/**
 * Appends `text` on a new line to message `message` in `channel` by editing it; no new message is posted. A thread
 * Discord archived on its own (not closed by the owner; check closedByOwner first) is unarchived for the edit and archived
 * again. A message that already ends with `text` (a retried append) is left as it is. Returns false, editing nothing,
 * when the result would not fit one Discord message.
 */
export const appendToMessage = async (discord: FollowUpDiscord, channel: string, message: string, text: string, archived: boolean): Promise<boolean> => {
  const current = await discord.content(channel, message);
  if (current.endsWith(`\n${text}`)) return true;
  const next = `${current}\n${text}`;
  if (guardText(next).length > DISCORD_MESSAGE_LIMIT) return false;
  if (archived) await discord.setThread(channel, { archived: false });
  try {
    await discord.edit(channel, message, next);
  } finally {
    if (archived) await discord.setThread(channel, { archived: true });
  }
  return true;
};
