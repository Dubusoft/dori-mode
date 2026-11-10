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
