import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { outcomeLane } from "./lane-outcomes.ts";

/**
 * The lead's read path for delivered events (`dori inbox take`). It prints lead-events.log from the take cursor to the
 * last complete line, at most `maxBytes` of whole lines, and writes an immutable take receipt for exactly what it
 * printed. The supervisor consumes the receipts (supervise-journal.ts consumeTakes), moves its cursor and publishes it
 * as state/inbox-cursor.json, so this CLI never opens the supervisor's store or lock.
 */

export const EVENT_LOG = "lead-events.log";
export const CURSOR_FILE = "inbox-cursor.json";
const TAKE_FILE = /^\d+-[\w-]+\.json$/;

export const takesDir = (stateDir: string): string => join(stateDir, "takes");
const cursorPath = (stateDir: string): string => join(stateDir, CURSOR_FILE);

export class InboxError extends Error {}

const fsyncDir = (dir: string): void => {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

/** tmp, fsync, rename, then the directory fsync: a crash leaves either the old file or the complete new one. */
const writeDurable = (path: string, dir: string, text: string): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flush: true });
  renameSync(tmp, path);
  fsyncDir(dir);
};

export type TakeReceipt = { readonly path: string; readonly offset: number; readonly at: number };

const offsetOk = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Take receipts waiting for the supervisor; unreadable or malformed files are skipped (and never dropped). */
export const pendingTakes = (stateDir: string): TakeReceipt[] => {
  let names: string[];
  try { names = readdirSync(takesDir(stateDir)); } catch { return []; }
  return names.filter((name) => TAKE_FILE.test(name)).flatMap((name) => {
    const path = join(takesDir(stateDir), name);
    try {
      const { offset, at } = JSON.parse(readFileSync(path, "utf8")) as { offset?: unknown; at?: unknown };
      if (!offsetOk(offset)) return [];
      return [{ path, offset, at: typeof at === "number" && Number.isFinite(at) ? at : statSync(path).mtimeMs }];
    } catch { return []; }
  });
};

export const dropTake = (path: string): void => {
  try { unlinkSync(path); } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
};

export const readCursorFile = (stateDir: string): number | undefined => {
  try {
    const { offset } = JSON.parse(readFileSync(cursorPath(stateDir), "utf8")) as { offset?: unknown };
    return offsetOk(offset) ? offset : undefined;
  } catch { return undefined; }
};

export const writeCursorFile = (stateDir: string, offset: number): void => {
  writeDurable(cursorPath(stateDir), stateDir, JSON.stringify({ offset }));
};

/**
 * Where the next take starts: the published cursor or any receipt the supervisor has not consumed yet, whichever is
 * further. Receipts are dropped only after the cursor file covers them, so this never goes backwards.
 */
export const takeCursor = (stateDir: string): number | undefined => {
  const cursor = readCursorFile(stateDir);
  if (cursor === undefined) return undefined;
  return Math.max(cursor, ...pendingTakes(stateDir).map((receipt) => receipt.offset));
};

export type LogLine = { readonly text: string; readonly end: number };

/** The complete lines (ending in a newline) of `path` from byte `from`; a partial last line is left out. */
export const completeLines = (path: string, from: number): LogLine[] => {
  let size: number;
  try { size = statSync(path).size; } catch { return []; }
  if (size <= from) return [];
  const data = Buffer.alloc(size - from);
  const fd = openSync(path, "r");
  try {
    let at = 0;
    while (at < data.length) {
      const read = readSync(fd, data, at, data.length - at, from + at);
      if (read === 0) break;
      at += read;
    }
  } finally { closeSync(fd); }
  const lines: LogLine[] = [];
  let start = 0;
  for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
    lines.push({ text: data.subarray(start, nl).toString("utf8"), end: from + nl + 1 });
    start = nl + 1;
  }
  return lines;
};

export type TakenEvent = { readonly id: string; readonly line: string; readonly meta?: { readonly lane?: string; readonly thread?: string; readonly cwd?: string } };

/** The string lane/thread/cwd of a log line's `meta` field; undefined when it has none (or only malformed parts). */
const metaOf = (value: unknown): TakenEvent["meta"] => {
  if (typeof value !== "object" || value === null) return undefined;
  const { lane, thread, cwd } = value as Record<string, unknown>;
  const meta = {
    ...(typeof lane === "string" && lane ? { lane } : {}),
    ...(typeof thread === "string" && thread ? { thread } : {}),
    ...(typeof cwd === "string" && cwd ? { cwd } : {}),
  };
  return Object.keys(meta).length ? meta : undefined;
};

/** One delivery log line as `{id, line, meta?}`; a line that does not parse keeps its raw text under the id `?`. */
export const parseLogLine = (text: string): TakenEvent => {
  try {
    const event = JSON.parse(text) as { id?: unknown; line?: unknown; meta?: unknown };
    if (typeof event.id === "string" && typeof event.line === "string") {
      const meta = metaOf(event.meta);
      return { id: event.id, line: event.line, ...(meta ? { meta } : {}) };
    }
  } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  return { id: "?", line: text };
};

export type Take = {
  readonly events: readonly TakenEvent[];
  /** The end of the last printed line: what the receipt covers. */
  readonly offset: number;
  /** Complete lines (and their bytes) left past `offset` because of the byte bound. */
  readonly more?: { readonly lines: number; readonly bytes: number };
  readonly receipt?: string;
};

/**
 * Takes the delivered events past the cursor: whole lines only, at most `maxBytes` of them, but always at least one so
 * a single long line cannot block progress. Unless `peek`, writes a receipt for exactly the printed range. Nothing new
 * writes no receipt.
 */
export const take = (stateDir: string, options: { readonly maxBytes: number; readonly peek?: boolean; readonly now: number; readonly session?: string }): Take => {
  const from = takeCursor(stateDir);
  if (from === undefined) throw new InboxError(`INBOX_UNAVAILABLE the supervisor has not published ${cursorPath(stateDir)} yet; read the end of ${join(stateDir, EVENT_LOG)} instead`);
  const lines = completeLines(join(stateDir, EVENT_LOG), from);
  const printed: LogLine[] = [];
  let start = from;
  for (const line of lines) {
    if (printed.length && line.end - from > options.maxBytes) break;
    printed.push(line);
    start = line.end;
  }
  const events = printed.map((line) => parseLogLine(line.text));
  const rest = lines.slice(printed.length);
  const more = rest.length ? { lines: rest.length, bytes: (rest.at(-1)?.end ?? start) - start } : undefined;
  if (!printed.length || options.peek) return { events, offset: start, ...(more ? { more } : {}) };
  // A receipt advances the next take before the CLI prints. Preserve owner text first, so even a process dying
  // immediately after that write cannot hide it from the next take. The supervisor prunes these once handled.
  const owners = events.filter((event) => /^(INBOUND|INBOUND_EDIT) /.test(event.line) &&
    /^discord:\d+:\d+(?::edit:.+)?$/.test(event.id));
  if (owners.length) {
    const carried = new Map(readCarried(stateDir).map((item) => [item.id, item]));
    for (const event of owners) carried.set(event.id, { kind: "owner", id: event.id, line: event.line });
    writeCarried(stateDir, [...carried.values()]);
  }
  const dir = takesDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${options.now}-${randomUUID()}.json`);
  writeDurable(path, dir, JSON.stringify({ offset: start, ids: events.map((event) => event.id), at: options.now, session: options.session ?? "" }));
  fsyncDir(stateDir);
  return { events, offset: start, ...(more ? { more } : {}), receipt: path };
};

/**
 * Durable reminders beyond the take cursor (state/carried.json): owner text preserved before a take receipt and
 * unfinished work handed over at a cold start, plus the held launch queue. The supervisor prunes them as work is
 * handled. `dori inbox take` prints them as reminder lines every time until they are gone.
 */
export const CARRIED_FILE = "carried.json";
export type Carried = { readonly kind: "owner" | "held"; readonly id: string; readonly line: string };

export const readCarried = (stateDir: string): Carried[] => {
  let list: unknown;
  try { list = JSON.parse(readFileSync(join(stateDir, CARRIED_FILE), "utf8")); } catch { return []; }
  return Array.isArray(list)
    ? list.filter((item: Partial<Carried>) => (item?.kind === "owner" || item?.kind === "held") && typeof item.id === "string" && typeof item.line === "string")
    : [];
};

/** Durable like the cursor file; an empty list removes the file. */
export const writeCarried = (stateDir: string, items: readonly Carried[]): void => {
  if (items.length) writeDurable(join(stateDir, CARRIED_FILE), stateDir, JSON.stringify(items));
  else dropTake(join(stateDir, CARRIED_FILE));
};

/** Removes one carried entry (an owner message that is fully handled); no write when it is not there. */
export const dropCarried = (stateDir: string, id: string): void => {
  const carried = readCarried(stateDir);
  const next = carried.filter((item) => item.id !== id);
  if (next.length !== carried.length) writeCarried(stateDir, next);
};

/** `dori inbox take`'s reminder lines (id<TAB>line, like the events) for unfinished taken or carried work. */
export const takeCarriedReminders = (stateDir: string, skipIds: ReadonlySet<string> = new Set()): string[] => readCarried(stateDir)
  .filter((item) => !skipIds.has(item.id)).map((item) => item.kind === "owner"
  ? `unfinished:${item.id}\tUNFINISHED ${item.id} taken and not handled (dori ack it unless acked, then handle it): ${item.line}`
  : `${item.id}\t${item.line}`);

/** Owner chat lines: a message, an edit of one, or a visitor's message. */
const OWNER_LINE = /^(INBOUND|INBOUND_EDIT|VISITOR)\b/;

const metaHeader = (meta: TakenEvent["meta"]): string =>
  `## ${[meta?.lane ? `lane ${meta.lane}` : "", meta?.thread ? `thread ${meta.thread}` : "", meta?.cwd ? `cwd ${meta.cwd}` : ""].filter(Boolean).join("  ")}`;

/**
 * The CLI's output for a take: one `id<TAB>line` per event, then INBOX_MORE, or INBOX_EMPTY when there was nothing.
 * When any event carries meta, the events are grouped under `## lane <lane>  thread <thread>  cwd <cwd>` headers in
 * first-seen order (absent parts omitted), and the events without meta follow under `## other`.
 */
export const takeOutput = (result: Take): string[] => {
  if (!result.events.length) return ["INBOX_EMPTY"];
  const text = (event: TakenEvent): string => `${event.id}\t${event.line}`;
  // Owner chat leads, whatever lane groups follow: it never hides behind lane output (log order kept within each part).
  const isOwner = (event: TakenEvent): boolean => OWNER_LINE.test(event.line);
  const events = [...result.events.filter(isOwner), ...result.events.filter((event) => !isOwner(event))];
  let body: string[];
  if (events.some((event) => event.meta)) {
    const groups = new Map<string, string[]>();
    const owner = events.filter(isOwner).map(text);
    const other: string[] = [];
    for (const event of events) {
      if (isOwner(event)) continue;
      if (!event.meta) { other.push(text(event)); continue; }
      const header = metaHeader(event.meta);
      groups.set(header, [...(groups.get(header) ?? []), text(event)]);
    }
    body = [...(owner.length ? ["## owner", ...owner] : []), ...[...groups].flatMap(([header, lines]) => [header, ...lines]), ...(other.length ? ["## other", ...other] : [])];
  } else body = events.map(text);
  return [
    ...body,
    ...(result.more ? [`INBOX_MORE ${result.more.lines} ${result.more.bytes}`] : []),
  ];
};

/** How many unread owner events `dori ack` previews per acked channel, and how much of each line it shows. */
export const UNREAD_PREVIEW_MAX = 5;
const UNREAD_PREVIEW_CHARS = 160;

const UNREAD_KIND = /^(INBOUND|INBOUND_EDIT|INBOUND_DELETE) (\d+) (\d+)(?: (.*))?$/s;

/**
 * `dori ack`'s read-only follow-up: the owner events (INBOUND, INBOUND_EDIT, INBOUND_DELETE) past the take cursor in
 * each acked channel, so a follow-up that arrived with or after the acked message is seen before the reply. It never
 * writes a take receipt or carried owner text, so the next `dori inbox take` still prints these events. Only the acked
 * originals are left out: their edits and deletes stay. Per channel (first-acked order, each once) it prints at most
 * `max` lines `UNREAD <channel> <kind> <eventId> <preview>`, then `UNREAD_MORE <channel> <n>` for the rest, or
 * `UNREAD_NONE <channel>`. A missing cursor or a failed read prints one `UNREAD_UNAVAILABLE` line instead of throwing:
 * the ack is already recorded and must not fail because of the preview.
 */
export const unreadAfterAck = (stateDir: string, acked: readonly { readonly channel: string; readonly message: string }[], max = UNREAD_PREVIEW_MAX): string[] => {
  try {
    const from = takeCursor(stateDir);
    if (from === undefined) return [`UNREAD_UNAVAILABLE the supervisor has not published ${cursorPath(stateDir)} yet; run dori inbox take`];
    const skip = new Set(acked.map(({ channel, message }) => `discord:${channel}:${message}`));
    const channels = [...new Set(acked.map(({ channel }) => channel))];
    const byChannel = new Map<string, OwnerEvent[]>(channels.map((channel) => [channel, []]));
    for (const event of ownerEventsPast(stateDir, from)) {
      if (!skip.has(event.id)) byChannel.get(event.channel)?.push(event);
    }
    // Seen from here on: the acked originals and every event printed below (never the ones cut off by `max`).
    const shown = [...skip];
    const out = channels.flatMap((channel) => {
      const events = byChannel.get(channel) ?? [];
      if (!events.length) return [`UNREAD_NONE ${channel}`];
      shown.push(...events.slice(0, max).map((event) => event.id));
      return [...events.slice(0, max).map((event) => event.text), ...(events.length > max ? [`UNREAD_MORE ${channel} ${events.length - max}`] : [])];
    });
    recordSeen(stateDir, shown);
    return out;
  } catch (e) {
    return [`UNREAD_UNAVAILABLE ${e instanceof Error ? e.message : String(e)}; run dori inbox take`];
  }
};

/**
 * `dori send`'s stale guard: owner events in `channel` (a channel or thread id) that the lead has not seen. Seen = taken
 * (at or before the take cursor), acked, or printed by an ack preview or an earlier SEND_STALE (state/seen-owner.json).
 * Returns the `UNREAD ...` lines in the ack preview's format (at most `max`, then `UNREAD_MORE`) plus the total count, and
 * records the printed ones as seen so a resend after merging them goes through. No cursor: nothing to compare, not stale.
 */
export const staleOwnerEvents = (stateDir: string, channel: string, max = UNREAD_PREVIEW_MAX): { readonly count: number; readonly lines: string[] } => {
  const from = takeCursor(stateDir);
  if (from === undefined) return { count: 0, lines: [] };
  const seen = new Set(readSeen(stateDir));
  const events = ownerEventsPast(stateDir, from).filter((event) => event.channel === channel && !seen.has(event.id));
  if (!events.length) return { count: 0, lines: [] };
  recordSeen(stateDir, events.slice(0, max).map((event) => event.id));
  return { count: events.length, lines: [...events.slice(0, max).map((event) => event.text), ...(events.length > max ? [`UNREAD_MORE ${channel} ${events.length - max}`] : [])] };
};

type OwnerEvent = { readonly channel: string; readonly id: string; readonly text: string };

/** Owner events (INBOUND, INBOUND_EDIT, INBOUND_DELETE) of the Discord log past `from`, as `UNREAD ...` preview lines. */
const ownerEventsPast = (stateDir: string, from: number): OwnerEvent[] => {
  const out: OwnerEvent[] = [];
  for (const { text } of completeLines(join(stateDir, EVENT_LOG), from)) {
    const event = parseLogLine(text);
    const m = UNREAD_KIND.exec(event.line);
    if (!m || !event.id.startsWith(`discord:${m[2]}:`)) continue;
    const body = (m[4] ?? "").replace(/\s+/g, " ").trim();
    const preview = body.length > UNREAD_PREVIEW_CHARS ? `${body.slice(0, UNREAD_PREVIEW_CHARS)}...` : body;
    out.push({ channel: m[2] ?? "", id: event.id, text: `UNREAD ${m[2]} ${m[1]} ${event.id}${preview ? ` ${preview}` : ""}` });
  }
  return out;
};

/** Event ids the lead has seen without taking them (ack, ack preview, SEND_STALE); the newest SEEN_MAX are kept. */
export const SEEN_FILE = "seen-owner.json";
const SEEN_MAX = 500;
export const readSeen = (stateDir: string): string[] => {
  try {
    const ids: unknown = JSON.parse(readFileSync(join(stateDir, SEEN_FILE), "utf8"));
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
};
const recordSeen = (stateDir: string, ids: readonly string[]): void => {
  if (!ids.length) return;
  const merged = [...new Set([...readSeen(stateDir), ...ids])];
  writeDurable(join(stateDir, SEEN_FILE), stateDir, JSON.stringify(merged.slice(-SEEN_MAX)));
};

/**
 * The one-line checklist for a taken batch that mixes owner chat (INBOUND / VISITOR) with lane outcome obligations (an
 * outcome event, or an UNREPORTED reminder): `checklist:<first id>\tCHECKLIST this batch owes: ...`, in the same
 * id<TAB>line shape as the other lines. `lines` are id<TAB>line texts (events plus reminders). Undefined unless both
 * kinds are present.
 */
export const checklistLine = (lines: readonly string[]): string | undefined => {
  // Distinct owner messages: a just-taken one also comes back as its own `unfinished:<id>` reminder (same id).
  const owners = new Set<string>();
  const lanes: string[] = [];
  let firstId: string | undefined;
  for (const text of lines) {
    const tab = text.indexOf("\t");
    if (tab < 0) continue;
    const id = text.slice(0, tab);
    const line = text.slice(tab + 1);
    firstId ??= id;
    if (OWNER_LINE.test(line)) owners.add(id);
    else if (id.startsWith("unfinished:") && line.startsWith("UNFINISHED ")) owners.add(id.slice("unfinished:".length));
    const lane = outcomeLane(line) ?? (line.startsWith("UNREPORTED ") ? line.split(" ")[1] : undefined);
    if (lane && !lanes.includes(lane)) lanes.push(lane);
  }
  const owner = owners.size;
  if (!owner || !lanes.length || firstId === undefined) return undefined;
  return `checklist:${firstId}\tCHECKLIST this batch owes: reply to ${owner} owner message(s); report lane ${lanes.join(", ")} (dori reported <key> --text ...)`;
};
