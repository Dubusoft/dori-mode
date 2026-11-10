import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { COLD_START_EMOJI } from "./supervise.ts";
import { MessengerError } from "./messenger/http.ts";
import { dropCarried } from "./inbox.ts";
import { hasColumn, JOURNAL_FILE, readStoreView, SQLITE_FILE } from "./store.ts";
import { leadOwes } from "./supervise-journal.ts";

/** The lead's read receipt, the one reaction it puts on an owner message. */
export const EYES_EMOJI = "\u{1F440}";

const DISCORD_ID = /^\d+$/;
/** Only Discord receipts match; any other file left in the acks directory (from a removed channel) is ignored. */
const ACK_FILE = /^(\d+)-(\d+)(?:-[\w-]+)?\.json$/;

/** The journal id of an owner message: discord:<channel>:<message>. */
export const ownerMessageId = (channel: string, message: string): string => `discord:${channel}:${message}`;

const ackDir = (stateDir: string): string => join(stateDir, "acks");

export class AckError extends Error {}

export type MessageCoverage = {
  readonly tasks?: number;
  readonly lanes?: readonly string[];
  readonly reply?: boolean;
  /** The lead declares every task of the message covered (e.g. one reply answering all of them). */
  readonly all?: boolean;
  /** `--awaiting`: the lead's reply waits on the owner (a go-ahead, a choice), so nothing is owed until the owner answers. */
  readonly awaiting?: boolean;
  readonly note?: string;
};

/** How much of an `--awaiting` note is kept (it is printed on every take). */
export const AWAITING_NOTE_MAX = 200;

/** A tracked message's coverage state, as the supervisor keeps it. */
export type TrackedCoverage = Omit<MessageCoverage, "all" | "awaiting" | "note"> & {
  readonly handledAt?: number;
  readonly awaitingOwnerAt?: number;
  readonly awaitingNote?: string;
};

/**
 * Merges a tracked message's coverage with its unconsumed receipts. Each distinct lane and the reply cover one task; --all
 * settles the task count on the coverage. An --awaiting receipt parks the message (the earliest one is the start); any
 * --lane, --reply or --all receipt recorded after it closes the message, as the follow-up the owner's answer led to.
 * Replaying the same receipts gives the same result.
 */
export const mergeCoverage = (entry: TrackedCoverage, receipts: readonly (MessageCoverage & { readonly at: number })[]): {
  readonly tasks: number; readonly lanes: string[]; readonly reply: boolean; readonly covered: boolean;
  readonly awaitingOwnerAt?: number; readonly awaitingNote?: string;
} => {
  const all = receipts.some((receipt) => receipt.all);
  const lanes = [...new Set([...(entry.lanes ?? []), ...receipts.flatMap((receipt) => receipt.lanes ?? [])])];
  const reply = !!(entry.reply || receipts.some((receipt) => receipt.reply) || (all && !lanes.length));
  const tasks = all ? lanes.length + Number(reply) : Math.max(entry.tasks ?? 1, ...receipts.map((receipt) => receipt.tasks ?? 1));
  const parked = receipts.filter((receipt) => receipt.awaiting).sort((a, b) => a.at - b.at);
  const awaitingOwnerAt = entry.awaitingOwnerAt ?? parked[0]?.at;
  const closes = awaitingOwnerAt !== undefined &&
    receipts.some((receipt) => !receipt.awaiting && (receipt.lanes?.length || receipt.reply || receipt.all) && receipt.at > awaitingOwnerAt);
  const awaitingNote = parked.findLast((receipt) => receipt.note !== undefined)?.note ?? entry.awaitingNote;
  return {
    tasks, lanes, reply, covered: closes || lanes.length + Number(reply) >= tasks,
    ...(awaitingOwnerAt !== undefined ? { awaitingOwnerAt } : {}), ...(awaitingNote !== undefined ? { awaitingNote } : {}),
  };
};

export const checkTasks = (tasks: number | undefined): void => {
  if (tasks !== undefined && (!Number.isSafeInteger(tasks) || tasks < 1)) throw new AckError("--tasks must be a positive integer");
};

export type AckReactions = {
  readonly react: (channel: string, message: string, emoji: string) => Promise<void>;
  readonly unreact: (channel: string, message: string, emoji: string) => Promise<void>;
  readonly typing: (channel: string) => Promise<void>;
};

/**
 * The lead's read receipt for one owner message: the handed-over hourglass comes off and the eyes go on back to back,
 * then the ack is recorded for the supervisor. It is recorded only once the eyes are really on the message, so a
 * failed reaction leaves the message unacked and the supervisor keeps reminding.
 */
export const ack = async (stateDir: string, discord: AckReactions, channel: string, message: string, now: number, tasks?: number): Promise<void> => {
  if (!DISCORD_ID.test(channel) || !DISCORD_ID.test(message)) throw new AckError("usage: dori ack <channel> <messageId> (Discord ids, digits only)");
  checkTasks(tasks);
  try { await discord.unreact(channel, message, COLD_START_EMOJI); }
  catch (e) {
    // No hourglass on the message (a warm delivery) is the normal case, not a failure.
    if (!(e instanceof MessengerError && e.status === 404)) throw e;
  }
  await discord.react(channel, message, EYES_EMOJI);
  recordAck(stateDir, channel, message, now, tasks);
  try { await discord.typing(channel); }
  catch (e) { console.error(`ACK_TYPING_FAILED ${channel} ${message}: ${e instanceof Error ? e.message : String(e)}`); }
};

/** Immutable receipts avoid a concurrent supervisor consuming a newer lead update by unlinking an older one. */
const recordReceipt = (stateDir: string, channel: string, message: string, at: number, coverage: MessageCoverage): void => {
  if (!DISCORD_ID.test(channel) || !DISCORD_ID.test(message)) throw new AckError("channel must be a Discord channel id, and message its message id (digits only)");
  checkTasks(coverage.tasks);
  const dir = ackDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${channel}-${message}-${randomUUID()}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ channel, message, at, ...coverage }), { mode: 0o600, flush: true });
  renameSync(tmp, path);
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(stateDir, "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
};

export const recordAck = (stateDir: string, channel: string, message: string, at: number, tasks?: number): void =>
  recordReceipt(stateDir, channel, message, at, { tasks });

/** Each distinct lane and the optional reply cover one declared task; replaying the same link never adds coverage. */
export const recordHandled = (stateDir: string, channel: string, message: string, at: number, coverage: MessageCoverage): void => {
  if (!coverage.lanes?.length && !coverage.reply && !coverage.all && !coverage.awaiting) throw new AckError("handled needs --lane <key>, --reply, --all and/or --awaiting");
  if (coverage.note !== undefined && !coverage.awaiting) throw new AckError("--note goes with --awaiting");
  if (coverage.lanes?.some((lane) => !/^[\w.-]+$/.test(lane))) throw new AckError("--lane must name a lane key");
  recordReceipt(stateDir, channel, message, at, coverage);
  // A message the lead no longer owes (complete, or waiting on the owner) no longer needs its UNFINISHED reminder. That is
  // the supervisor's merge (consumeReceipts) of the coverage it already tracks with the receipts it has not consumed yet;
  // an unreadable store leaves the pruning to the supervisor.
  const id = ownerMessageId(channel, message);
  const tracked = trackedCoverage(stateDir, id);
  if (!tracked) return;
  const merged = mergeCoverage(tracked.entry ?? {}, pendingAcks(stateDir).filter((receipt) => receipt.id === id));
  if (!leadOwes({ handledAt: merged.covered ? at : undefined, awaitingOwnerAt: merged.awaitingOwnerAt })) dropCarried(stateDir, id);
};

/** The coverage the supervisor tracks for owner message `id` (`entry` absent when untracked); undefined when the store cannot be read. */
const trackedCoverage = (stateDir: string, id: string): { readonly entry?: TrackedCoverage } | undefined =>
  !existsSync(join(stateDir, JOURNAL_FILE)) && !existsSync(join(stateDir, SQLITE_FILE)) ? {} : readStoreView(stateDir, {
  json: (journal) => {
    const entry = journal.awaitingAck?.find((tracked) => tracked.id === id);
    return entry ? { entry: { tasks: entry.tasks, lanes: entry.lanes, reply: entry.reply, awaitingOwnerAt: entry.awaitingOwnerAt } } : {};
  },
  sqlite: (db) => {
    // A store the supervisor has not migrated yet has no awaiting column: nothing there is parked.
    const parked = hasColumn(db, "owner_messages", "awaiting_owner_at") ? ", awaiting_owner_at" : "";
    const row = db.query(`SELECT tasks, lanes, reply${parked} FROM owner_messages WHERE id = ?`).get(id) as
      { tasks: number | null; lanes: string | null; reply: number | null; awaiting_owner_at?: number | null } | null;
    return row ? { entry: {
      tasks: row.tasks ?? undefined, lanes: row.lanes ? JSON.parse(row.lanes) as string[] : undefined, reply: row.reply === 1,
      awaitingOwnerAt: row.awaiting_owner_at ?? undefined,
    } } : {};
  },
});

/** Acks waiting for the supervisor, as inbound ids (discord:<channel>:<message>) with their file paths and ack times. */
export const pendingAcks = (stateDir: string): (MessageCoverage & { readonly id: string; readonly path: string; readonly at: number })[] => {
  let names: string[];
  try { names = readdirSync(ackDir(stateDir)); } catch { return []; }
  return names.flatMap((name) => {
    const m = ACK_FILE.exec(name);
    if (!m) return [];
    const path = join(ackDir(stateDir), name);
    try {
      const { at, tasks, lanes, reply, all, awaiting, note } = JSON.parse(readFileSync(path, "utf8")) as
        { at?: unknown; tasks?: unknown; lanes?: unknown; reply?: unknown; all?: unknown; awaiting?: unknown; note?: unknown };
      if (tasks !== undefined && (typeof tasks !== "number" || !Number.isSafeInteger(tasks) || tasks < 1)) return [];
      if (lanes !== undefined && (!Array.isArray(lanes) || !lanes.every((lane): lane is string => typeof lane === "string" && /^[\w.-]+$/.test(lane)))) return [];
      return [{
        id: ownerMessageId(m[1] ?? "", m[2] ?? ""), path, at: typeof at === "number" && Number.isFinite(at) ? at : statSync(path).mtimeMs,
        ...(typeof tasks === "number" ? { tasks } : {}),
        ...(Array.isArray(lanes) ? { lanes } : {}),
        ...(reply === true ? { reply: true } : {}),
        ...(all === true ? { all: true } : {}),
        ...(awaiting === true ? { awaiting: true, ...(typeof note === "string" ? { note } : {}) } : {}),
      }];
    } catch { return []; }
  });
};

export const dropAck = (path: string): void => {
  try { unlinkSync(path); } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
};
