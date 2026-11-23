import { readFileSync } from "node:fs";
import { join } from "node:path";

import { replaceFileAtomic } from "./durable-write.ts";
import { withStateLockSync } from "./state-lock.ts";
import { NotThreadError } from "./messenger/discord.ts";
import { DISCORD_MESSAGE_LIMIT } from "./messenger/discord-split.ts";
import { guardText, MessengerError } from "./messenger/http.ts";
import { resolveTarget } from "./messenger/target.ts";
import type { Lane } from "./registry.ts";
import type { AppendOutcome } from "./task-finish.ts";

/**
 * Follow-ups after a thread's work is reported (a merge result, a Toodo note) must not reopen a thread the owner closed:
 * a new post into an archived Discord thread unarchives it. So a follow-up is appended to the lane's last report by
 * editing that message, and anything addressed to a thread the owner closed goes to that thread's parent channel (else
 * the owner channel) as one line that links the thread instead.
 */

/**
 * Threads the owner closed with the close-thread button, thread id -> when (epoch ms); written by `dori supervise`.
 * Old records are dropped by pruneThreadFollowups.
 */
export const OWNER_CLOSED_FILE = "owner-closed-threads.json";
/**
 * Each lane's last `dori reported` post into a thread, lane key -> { channel, message, at }; written by `dori reported`.
 * Closed lanes' old records are dropped by pruneThreadFollowups.
 */
export const LAST_REPORTS_FILE = "last-reports.json";

/** How long an owner-closed record or a closed lane's last report is kept, like a closed decision (DECISION_KEEP_CLOSED_MS). */
export const THREAD_FOLLOWUP_KEEP_MS = 30 * 24 * 60 * 60_000;

/** Held while OWNER_CLOSED_FILE or LAST_REPORTS_FILE is read, changed and written back (the supervisor and the CLI both write them). */
export const THREAD_FOLLOWUP_LOCK = "thread-followup.lock.sqlite";

export type LastReport = { readonly channel: string; readonly message: string; readonly at: number };

/** A state file that exists but is not a JSON object. */
export class MalformedStateFileError extends Error {}

/** The file's object; a missing file is an empty one, any other read error or a file that is not a JSON object throws. */
const loadObject = (path: string): Record<string, unknown> => {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch (e) { throw new MalformedStateFileError(`${path} is malformed: ${e instanceof Error ? e.message : String(e)}`); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new MalformedStateFileError(`${path} is malformed: not a JSON object`);
  return value as Record<string, unknown>;
};

/** Malformed contents already warned about (path + content hash), so a polling reader warns once per corruption. */
const warned = new Set<string>();

/** For readers: a malformed file warns and reads as empty; it stays on disk for the owner to repair (writers refuse it). */
const readObject = (path: string): Record<string, unknown> => {
  try { return loadObject(path); } catch (e) {
    if (!(e instanceof MalformedStateFileError)) throw e;
    const key = `${path}\0${Bun.hash(readFileSync(path))}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.error(`THREAD_STATE_WARNING ${e.message}; it reads as empty and is not written until it is repaired or removed`);
    }
    return {};
  }
};

/**
 * Reads `file` under THREAD_FOLLOWUP_LOCK, lets `change` make the next object (undefined: leave the file as it is) and
 * writes it back (tmp + rename). A malformed file throws instead of being overwritten.
 */
const updateObject = (stateDir: string, file: string, change: (current: Record<string, unknown>) => Record<string, unknown> | undefined): void => {
  withStateLockSync(join(stateDir, THREAD_FOLLOWUP_LOCK), () => {
    const path = join(stateDir, file);
    const next = change(loadObject(path));
    if (next) replaceFileAtomic(path, JSON.stringify(next), 0o600);
  });
};

const ownerClosedOf = (value: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));

export const readOwnerClosed = (stateDir: string): Record<string, number> => ownerClosedOf(readObject(join(stateDir, OWNER_CLOSED_FILE)));

/** Records that the owner closed `thread` at `at`. */
export const recordOwnerClosed = (stateDir: string, thread: string, at: number): void => {
  updateObject(stateDir, OWNER_CLOSED_FILE, (current) => ({ ...ownerClosedOf(current), [thread]: at }));
};

/** Drops `thread`'s close record: the thread is open again. */
export const forgetOwnerClosed = (stateDir: string, thread: string): void => {
  updateObject(stateDir, OWNER_CLOSED_FILE, (current) => {
    const closed = ownerClosedOf(current);
    if (!(thread in closed)) return undefined;
    delete closed[thread];
    return closed;
  });
};

const isLastReport = (value: unknown): value is LastReport => {
  const v = value as Partial<LastReport> | null;
  return typeof v === "object" && v !== null && typeof v.channel === "string" && typeof v.message === "string" && typeof v.at === "number";
};

const lastReportsOf = (value: Record<string, unknown>): Record<string, LastReport> =>
  Object.fromEntries(Object.entries(value).filter((entry): entry is [string, LastReport] => isLastReport(entry[1])));

export const readLastReports = (stateDir: string): Record<string, LastReport> => lastReportsOf(readObject(join(stateDir, LAST_REPORTS_FILE)));

/** Records `lane`'s last report message. */
export const recordLastReport = (stateDir: string, lane: string, report: LastReport): void => {
  updateObject(stateDir, LAST_REPORTS_FILE, (current) => ({ ...lastReportsOf(current), [lane]: report }));
};

/**
 * The supervisor's pass over both files: an owner-closed record THREAD_FOLLOWUP_KEEP_MS old whose thread no open lane
 * is bound to, and a last report THREAD_FOLLOWUP_KEEP_MS old of a lane that is not open, are dropped. A closed lane
 * keeps its last report until then, so the close button and the merge line still find it. A file with nothing to drop
 * is not locked or written, and a malformed one is only warned about (readObject).
 */
export const pruneThreadFollowups = (stateDir: string, now: number, open: readonly Pick<Lane, "key" | "thread">[]): void => {
  const openKeys = new Set(open.map((lane) => lane.key));
  const openThreads = new Set(open.flatMap((lane) => threadOfRef(lane.thread) ?? []));
  const closedExpired = (thread: string, at: number): boolean => now - at >= THREAD_FOLLOWUP_KEEP_MS && !openThreads.has(thread);
  const reportExpired = (lane: string, report: LastReport): boolean => now - report.at >= THREAD_FOLLOWUP_KEEP_MS && !openKeys.has(lane);
  if (Object.entries(readOwnerClosed(stateDir)).some(([thread, at]) => closedExpired(thread, at))) {
    updateObject(stateDir, OWNER_CLOSED_FILE, (current) => Object.fromEntries(Object.entries(ownerClosedOf(current)).filter(([thread, at]) => !closedExpired(thread, at))));
  }
  if (Object.entries(readLastReports(stateDir)).some(([lane, report]) => reportExpired(lane, report))) {
    updateObject(stateDir, LAST_REPORTS_FILE, (current) => Object.fromEntries(Object.entries(lastReportsOf(current)).filter(([lane, report]) => !reportExpired(lane, report))));
  }
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
 * A thread with no record is open without asking Discord. A recorded id Discord reports is not a thread (a plain channel)
 * cannot be closed, and one Discord no longer knows (404: deleted) cannot be posted into or reopened: either way its record
 * is dropped and it counts as open. Any other failed read (403, 5xx) is thrown, keeping the record. A closed thread comes
 * back with its parent channel, where a line redirected from it goes (undefined when Discord names none: the caller's owner
 * channel then); an open one is undefined.
 */
export const closedByOwner = async (stateDir: string, discord: Pick<FollowUpDiscord, "threadState">, thread: string): Promise<{ readonly parent: string | undefined } | undefined> => {
  if (readOwnerClosed(stateDir)[thread] === undefined) return undefined;
  let state: { readonly archived: boolean; readonly parent: string | undefined };
  try { state = await discord.threadState(thread); } catch (e) {
    if (!(e instanceof NotThreadError) && !(e instanceof MessengerError && e.status === 404)) throw e;
    forgetOwnerClosed(stateDir, thread);
    return undefined;
  }
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
 * The invisible tag an append with stable id `id` carries at the start of its line: U+2060 around 32 zero-width bits
 * (U+200B = 0, U+200C = 1) of the id's hash, so a retry can find its own line wherever later appends moved it.
 */
export const appendMarker = (id: string): string =>
  `\u2060${[...Bun.hash.crc32(id).toString(2).padStart(32, "0")].map((bit) => (bit === "0" ? "\u200b" : "\u200c")).join("")}\u2060`;

/** Archives `channel` again after an edit; a failure is logged, not thrown (the edit already landed, or its own error wins). */
const rearchive = async (discord: FollowUpDiscord, channel: string): Promise<void> => {
  await discord.setThread(channel, { archived: true }).catch((e: unknown) => {
    console.error(`THREAD_REARCHIVE_FAILED ${channel} ${e instanceof Error ? e.message : String(e)}; the thread is left open`);
  });
};

/**
 * Appends `text` on a new line to message `message` in `channel` by editing it; no new message is posted. A thread
 * Discord archived on its own (not closed by the owner; check closedByOwner first) is unarchived for the edit and archived
 * again; a failed re-archive is logged (THREAD_REARCHIVE_FAILED) and never hides the edit's own error. With `stableId`
 * the line carries its appendMarker and a message that already holds it (a retried append) is left as it is; the same
 * text under another id, or with no id, is appended again. Returns false, editing nothing, when the result would not
 * fit one Discord message.
 */
export const appendToMessage = async (discord: FollowUpDiscord, channel: string, message: string, text: string, archived: boolean, stableId?: string): Promise<boolean> => {
  const current = await discord.content(channel, message);
  const marker = stableId === undefined ? "" : appendMarker(stableId);
  if (marker && current.includes(marker)) return true;
  const next = `${current}\n${marker}${text}`;
  if (guardText(next).length > DISCORD_MESSAGE_LIMIT) return false;
  if (archived) await discord.setThread(channel, { archived: false });
  try {
    await discord.edit(channel, message, next);
  } catch (e) {
    if (archived) await rearchive(discord, channel);
    throw e;
  }
  if (archived) await rearchive(discord, channel);
  return true;
};

/**
 * The supervisor's own `dori reported <key> --append`: `text` is appended to the lane's last report (else its [System]
 * status message) by editing it. Unlike the CLI it never redirects: a thread the owner or the supervisor closed is left
 * as it is, with no line in its parent channel, and so is a lane with no message to edit or a text that does not fit.
 */
export const appendFollowUp = async (stateDir: string, discord: FollowUpDiscord, lane: Lane, text: string): Promise<AppendOutcome> => {
  const status = lane.statusMessageId && lane.thread.startsWith("discord:") ? { channel: resolveTarget("discord", lane.thread).to, message: lane.statusMessageId } : undefined;
  const last = readLastReports(stateDir)[lane.key] ?? status;
  if (!last) return { appended: false, why: "the lane has no report or status message" };
  if (await closedByOwner(stateDir, discord, last.channel)) return { appended: false, why: `thread ${last.channel} is closed` };
  const archived = await discord.threadArchived(last.channel).catch(() => false);
  // A fact line (a merge, a finished task) states one fact: the same text for the same lane is that fact again.
  if (!(await appendToMessage(discord, last.channel, last.message, text, archived, `follow-up:${lane.key}:${text}`))) return { appended: false, why: "the report would pass Discord's message limit" };
  return { appended: true, message: last.message };
};
