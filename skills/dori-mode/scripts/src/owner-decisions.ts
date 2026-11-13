import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { alertsChannelOf, type DoriConfig } from "./config.ts";
import { recordResolved } from "./decision-obligations.ts";
import { scrubForThread } from "./freshness.ts";
import { MessengerError } from "./messenger/http.ts";
import { type DecisionChoices, parseDecisionText, parseRequestText } from "./runner/decision-text.ts";
import { withStateLockSync } from "./state-lock.ts";
import { saveJsonFile } from "./store.ts";
import { appendToMessage, closedByOwner } from "./thread-followup.ts";

/**
 * Owner decisions (decision channel): one question that needs the owner's choice opens one thread, in `decisionsChannel`
 * (else the channel it was asked from, else `discordChannels[0]`), with numbered options, a recommendation and its reason.
 * The thread starts without a message, so the channel body keeps nothing: the question is the thread's first message.
 * The lead opens one with `dori decision open`; a lane question carrying choices (runner/decision-text.ts) is opened by
 * the supervisor. The owner's first reply in the thread raises `OWNER_DECISION_ANSWERED`, a decision obligation
 * (decision-obligations.ts) the lead closes with `dori decision close`, which also writes its `dori resolved` receipt.
 * Not to be confused with those obligations: an owner decision is a question to the owner, an obligation is an event the
 * lead must act on.
 * A request (`kind: "request"`) is the same record for input only the owner can give (a one-time code, a file or value):
 * no options, its `question` is what is needed, and it says where to send it (a reply in the thread, or `file`). It opens,
 * is answered and closes exactly like a decision; thread names start `[요청]` instead of `[결정]`. The channel is wired
 * by id only, so the owner may rename it.
 *
 * Every decision lives in `<stateDir>/decisions.json`, rewritten whole under DECISIONS_LOCK by the CLI and the supervisor.
 * Discord calls run outside the lock.
 */

export const DECISIONS_FILE = "decisions.json";
export const DECISIONS_LOCK = "decisions.lock.sqlite";
/** Discord keeps a decision thread open this long without activity (the longest it allows). */
export const DECISION_AUTO_ARCHIVE_MIN = 10080;
/** A decision still `posting` this long (its writer died mid-post) raises OWNER_DECISION_STUCK once. */
export const DECISION_POSTING_STUCK_MS = 10 * 60_000;
/** Closed decisions are dropped this long after they closed; `dori decision list --all` shows the last DECISION_LIST_CLOSED_MS. */
export const DECISION_KEEP_CLOSED_MS = 30 * 24 * 60 * 60_000;
export const DECISION_LIST_CLOSED_MS = 7 * 24 * 60 * 60_000;
/** The daily reminder of decisions still waiting is posted on the first pass at or after this hour in displayTimeZone. */
export const DECISION_DIGEST_HOUR = 9;

export type OwnerDecisionState = "posting" | "open" | "answered" | "closed";

export type OwnerAnswer = { readonly channel: string; readonly message: string; readonly at: number };

export type OwnerDecision = DecisionChoices & {
  /** `d<n>`. */
  readonly id: string;
  /** Absent: a decision. `request`: owner input; `options` is empty and `question` names what is needed. */
  readonly kind?: "request";
  /** A request's file the owner writes the value to (chmod 600) instead of replying in the thread. */
  readonly file?: string;
  readonly state: OwnerDecisionState;
  readonly task?: number;
  readonly lane?: string;
  /** The thread ref the question came from (a lane's `thread`, or `--thread`), where the link line goes. */
  readonly origin?: string;
  readonly source: "lead" | "lane";
  /** The lane report row a lane decision came from; one decision per row. */
  readonly sourceRef?: string;
  readonly channel: string;
  readonly thread?: string;
  /**
   * Set when a lane decision was posted into the lane's own thread because that thread already sits in decisionsChannel
   * (laneThreadInDecisions): `thread` is the lane thread, no thread of its own is started, no link line is posted, and
   * closing it leaves the lane thread open.
   */
  readonly inLaneThread?: boolean;
  /** The question's message, the first one in the thread. */
  readonly message?: string;
  /** Why Discord's "started a thread" notice was left in the channel body; unset when it was deleted or never posted. */
  readonly noticeKept?: string;
  readonly linkMessage?: string;
  /** Why no link line was posted in the origin thread; set once, never retried. */
  readonly linkSkipped?: string;
  readonly openedAt: number;
  readonly answers?: readonly OwnerAnswer[];
  readonly answeredAt?: number;
  /** The OWNER_DECISION_ANSWERED event id; closing the decision resolves it. */
  readonly answerEvent?: string;
  readonly closedAt?: number;
  readonly choice?: number;
  readonly closeText?: string;
  readonly cancelled?: boolean;
  /** The answer messages (`<channel>/<message>`) the close covers with a handled --reply receipt, set when it closes. */
  readonly coveredAnswers?: readonly string[];
  /** The close's `--tasks` (the task count each covered message is recorded with). */
  readonly closeTasks?: number;
  /** The covered answers whose handled receipt is recorded; a close of a closed decision records the rest. */
  readonly handledAnswers?: readonly string[];
  readonly archivePending?: boolean;
  readonly stuckAt?: number;
  readonly goneAt?: number;
};

export type DecisionsFile = {
  readonly nextSeq: number;
  /** The displayTimeZone date (YYYY-MM-DD) the daily reminder last ran on. */
  readonly digestDay?: string;
  readonly decisions: readonly OwnerDecision[];
};

export class OwnerDecisionError extends Error {
  /** Lines printed on stdout before the error (DECISION_STALE's UNREAD lines, a re-close's DECISION_HANDLED lines). */
  constructor(readonly code: string, message: string, readonly lines: readonly string[] = []) { super(message); }
}

const EMPTY: DecisionsFile = { nextSeq: 1, decisions: [] };

const parseFile = (text: string): DecisionsFile => {
  const value = JSON.parse(text) as Partial<DecisionsFile>;
  if (typeof value !== "object" || value === null || !Array.isArray(value.decisions) || typeof value.nextSeq !== "number") throw new Error("decisions.json is malformed");
  return value as DecisionsFile;
};

/** decisions.json as it is now; no file or an unreadable one reads as no decisions (for readers: status, inbox, list). */
export const readDecisions = (stateDir: string): DecisionsFile => {
  try { return parseFile(readFileSync(join(stateDir, DECISIONS_FILE), "utf8")); } catch { return EMPTY; }
};

/**
 * Reads decisions.json under DECISIONS_LOCK, lets `act` change it, and writes it back when it changed. A malformed file
 * throws instead of being overwritten.
 */
export const updateDecisions = <T>(stateDir: string, act: (file: DecisionsFile) => { readonly file?: DecisionsFile; readonly result: T }): T =>
  withStateLockSync(join(stateDir, DECISIONS_LOCK), () => {
    const path = join(stateDir, DECISIONS_FILE);
    const file = existsSync(path) ? parseFile(readFileSync(path, "utf8")) : EMPTY;
    const { file: next, result } = act(file);
    if (next && next !== file) saveJsonFile(path, next);
    return result;
  });

const patchOne = (stateDir: string, id: string, patch: (d: OwnerDecision) => OwnerDecision | undefined): OwnerDecision | undefined =>
  updateDecisions(stateDir, (file) => {
    const found = file.decisions.find((d) => d.id === id);
    const next = found ? patch(found) : undefined;
    if (!found || !next) return { result: found };
    return { file: { ...file, decisions: file.decisions.map((d) => (d.id === id ? next : d)) }, result: next };
  });

const removeOne = (stateDir: string, id: string): void => {
  updateDecisions(stateDir, (file) => ({ file: { ...file, decisions: file.decisions.filter((d) => d.id !== id) }, result: undefined }));
};

/** What opening, closing and the tick need from Discord; the Discord client fits it. */
export type DecisionTransport = {
  send(channel: string, content: string, stableId?: string): Promise<string>;
  edit(channel: string, messageId: string, content: string): Promise<void>;
  content(channel: string, messageId: string): Promise<string>;
  deleteMessage(channel: string, messageId: string): Promise<void>;
  messagesAfter(channel: string, afterId: string): Promise<readonly { readonly id: string; readonly type: number; readonly reference?: string }[]>;
  startThread(channel: string, messageId: string | undefined, name: string, memberId?: string, autoArchiveMin?: 60 | 1440 | 4320 | 10080): Promise<{ readonly id: string }>;
  setThread(threadId: string, patch: { readonly name?: string; readonly archived?: boolean }): Promise<void>;
  threadState(threadId: string): Promise<{ readonly archived: boolean; readonly parent: string | undefined }>;
  threadArchived(threadId: string): Promise<boolean>;
};

export type DecisionConfig = Pick<DoriConfig, "stateDir" | "discordChannels" | "decisionsChannel" | "alertsChannel" | "displayTimeZone"> & {
  readonly discord?: { readonly ownerId?: string } | undefined;
};

/**
 * What closing needs to settle the owner's answer messages: the lead's stale guard and read/handled receipts (ack.ts and
 * inbox.ts, injected by the CLI). Without it a close touches no answer message.
 */
export type DecisionReceipts = {
  /** Owner events in `channel` the lead has not seen, as `UNREAD ...` lines; the printed ones are recorded as seen. */
  readonly unseen: (channel: string) => { readonly count: number; readonly lines: readonly string[] };
  readonly acked: (channel: string, message: string) => boolean;
  /** `dori ack` on one message (hourglass off, eyes on, read receipt). */
  readonly ack: (channel: string, message: string) => Promise<void>;
  /** `dori handled <channel> <message> --reply --tasks <tasks>`. */
  readonly handled: (channel: string, message: string, tasks: number) => Promise<void>;
};

export type DecisionContext = {
  readonly config: DecisionConfig;
  readonly transport: DecisionTransport;
  readonly now: () => number;
  /** The home directory scrubbed out of posted text. */
  readonly home: string;
  readonly receipts?: DecisionReceipts;
};

/** The Toodo task number in an autopilot lane key `ap-<task>-<attempt>`. */
export const taskOfLane = (lane: string | undefined): number | undefined => {
  const m = lane === undefined ? null : /^ap-(\d+)-\d+$/.exec(lane);
  return m ? Number(m[1]) : undefined;
};

/** The channel and thread ids of a thread ref `discord:<channel>/<thread>` or `discord:<thread>` (channel unknown). */
export const refIds = (ref: string | undefined): { readonly channel?: string; readonly thread: string } | undefined => {
  const m = ref === undefined ? null : /^(?:discord:)?(?:(\d+)\/)?(\d+)$/.exec(ref);
  if (!m) return undefined;
  return { ...(m[1] ? { channel: m[1] } : {}), thread: m[2] as string };
};

export type ChannelChoice = {
  readonly channel: string;
  /** Set when decisionsChannel is unset: the decision went to the requesting channel or the first discordChannels entry. */
  readonly unset?: "requesting" | "first";
};

/**
 * Where a decision is posted: decisionsChannel; else the channel the origin thread hangs under (its ref's channel, or the
 * thread's parent read from Discord); else discordChannels[0]. Undefined when none is known.
 */
export const decisionChannel = async (config: DecisionConfig, origin: string | undefined, transport: Pick<DecisionTransport, "threadState">): Promise<ChannelChoice | undefined> => {
  const set = config.decisionsChannel?.trim();
  if (set) return { channel: set };
  const ids = refIds(origin);
  let requesting = ids?.channel;
  if (ids && !requesting) {
    try { requesting = (await transport.threadState(ids.thread)).parent; } catch { requesting = undefined; }
  }
  if (requesting) return { channel: requesting, unset: "requesting" };
  const first = config.discordChannels[0];
  return first ? { channel: first, unset: "first" } : undefined;
};

export const channelUnsetLine = (choice: ChannelChoice): string =>
  `DECISION_CHANNEL_UNSET ${choice.channel}: decisionsChannel is not set, so the decision went to ${choice.unset === "requesting" ? "the requesting channel" : "the first discordChannels entry"}`;

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 3)}...`);

export const DECISION_THREAD_NAME_MAX = 40;

const label = (d: Pick<OwnerDecision, "kind">): string => (d.kind === "request" ? "요청" : "결정");

/** The thread's name: `[결정] d12 · #889 · <question>` (`[요청]` for a request), cut to DECISION_THREAD_NAME_MAX characters. */
export const decisionThreadName = (d: Pick<OwnerDecision, "id" | "task" | "question" | "kind">): string => {
  const chars = Array.from(`[${label(d)}] ${d.id}${d.task !== undefined ? ` · #${d.task}` : ""} · ${d.question.replace(/\s+/g, " ").trim()}`);
  return chars.length <= DECISION_THREAD_NAME_MAX ? chars.join("") : `${chars.slice(0, DECISION_THREAD_NAME_MAX - 1).join("").trimEnd()}…`;
};

/** The thread's starter message: question, numbered options with the recommendation marked, reason, what waits, origin. */
export const decisionStartText = (d: OwnerDecision, home: string): string => {
  const head = [`**[${label(d)} ${d.id}]**`, d.task !== undefined ? `Toodo #${d.task}` : undefined, d.lane ? `레인 ${d.lane}` : undefined].filter(Boolean).join(" · ");
  const origin = refIds(d.origin)?.thread;
  if (d.kind === "request") return scrubForThread([
    head,
    `필요한 것: ${d.question}`,
    `이유: ${d.reason}`,
    d.file
      ? `보내는 곳: 파일 \`${d.file}\`에 넣고 권한을 600으로 맞춰 주세요(\`chmod 600 ${d.file}\`). 값은 이 스레드에 붙여넣지 마시고, 넣은 뒤 이 스레드에 "완료"라고만 답해 주세요.`
      : "보내는 곳: 이 스레드에 답으로 보내 주세요(인증코드처럼 한 번 쓰고 끝나는 값만). 비밀번호나 API 키 같은 오래 쓰는 비밀은 여기에 올리지 마세요.",
    d.blocking ? `기다리는 쪽: ${d.lane ? `레인 ${d.lane}, ` : ""}${d.waiting}` : `먼저 진행 중: ${d.lane ? `레인 ${d.lane}, ` : ""}${d.waiting}`,
    ...(origin && !d.inLaneThread ? [`원래 스레드: <#${origin}>`] : []),
  ].join("\n"), home);
  return scrubForThread([
    head,
    `질문: ${d.question}`,
    ...d.options.map((option, i) => `${i + 1}. ${option}${i + 1 === d.recommend ? " ← 추천" : ""}`),
    `추천 이유: ${d.reason}`,
    d.blocking ? `기다리는 동안 멈춘 것: ${d.waiting}` : `먼저 진행 중: 추천안(${d.recommend}번)으로 진행하고 있습니다(${d.waiting}). 다르게 정하시면 되돌립니다.`,
    ...(origin && !d.inLaneThread ? [`원래 스레드: <#${origin}>`] : []),
    "이 스레드에 번호나 문장으로 답해 주세요.",
  ].join("\n"), home);
};

/** The origin thread's one link line; the question itself stays in the decision thread. */
export const decisionLinkText = (d: OwnerDecision): string => `[System] 오너 ${label(d)} ${d.id}: <#${d.thread ?? ""}>`;

export type CloseOptions = {
  readonly text: string;
  readonly choice?: number;
  /** `<channel>/<message>` of an answer the owner gave outside the decision thread. */
  readonly from?: string;
  readonly cancel?: boolean;
  /** The tasks each covered answer message holds; the close covers one of them (the rest go to `dori handled --lane`). */
  readonly tasks?: number;
  /** Close even when the lead has not seen every owner message in the decision's thread and answer channels. */
  readonly force?: boolean;
};

export const decisionCloseText = (d: OwnerDecision, options: CloseOptions, home: string): string => {
  const from = options.from ? /^(\d+)\/(\d+)$/.exec(options.from) : null;
  const picked = options.choice !== undefined ? ` ${options.choice}번(${cut(d.options[options.choice - 1] ?? "", 60)})` : "";
  const by = d.answeredAt === undefined && !from && !options.cancel ? " (리드가 정함)" : "";
  const where = from ? ` (<#${from[1]}>에서 받은 답: https://discord.com/channels/@me/${from[1]}/${from[2]})` : "";
  const note = options.text.replace(/\s+/g, " ").trim();
  const outcome = options.cancel ? "취소" : d.kind === "request" ? "요청 처리" : `결정 반영:${picked}`;
  return scrubForThread(`[System] ${d.id} ${outcome}${d.kind === "request" ? "" : by}${where}. ${note}${/[.!?。]$/.test(note) ? "" : "."}${d.inLaneThread ? "" : " 스레드를 닫습니다."}`, home);
};

/** The line appended to the origin thread's link message when the decision closes. */
export const decisionLinkClosedText = (d: Pick<OwnerDecision, "cancelled" | "choice" | "kind">): string =>
  d.cancelled ? "→ 취소됨" : d.kind === "request" ? "→ 처리됨" : d.choice !== undefined ? `→ 결정됨: ${d.choice}번` : "→ 결정됨";

export type LinkResult =
  | { readonly kind: "linked"; readonly origin: string; readonly message: string }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "none" };

export type OpenResult = {
  readonly decision: OwnerDecision;
  readonly channel: ChannelChoice;
  readonly link: LinkResult;
  /** An open decision of the same lane with the same question (lane decisions only): nothing new was posted. */
  readonly duplicateOf?: string;
  /** Why Discord's "started a thread" notice stayed in the channel body (set only when deleting it failed). */
  readonly noticeKept?: string;
};

export type DecisionSpec = DecisionChoices & {
  readonly kind?: "request";
  readonly file?: string;
  readonly task?: number;
  readonly lane?: string;
  readonly origin?: string;
  readonly source: "lead" | "lane";
  readonly sourceRef?: string;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
const isGone = (e: unknown): boolean => e instanceof MessengerError && e.status === 404;

/**
 * Posts the link line into the decision's origin thread and records it: skipped (recorded, never retried) when there is
 * no origin thread or the owner closed it, failed (retried by the tick) when the post throws.
 */
export const postDecisionLink = async (ctx: DecisionContext, d: OwnerDecision): Promise<LinkResult> => {
  if (d.inLaneThread) return { kind: "none" };
  const origin = refIds(d.origin)?.thread;
  if (!origin || !d.thread) {
    if (!d.linkSkipped) patchOne(ctx.config.stateDir, d.id, (x) => ({ ...x, linkSkipped: "no origin thread" }));
    return d.origin ? { kind: "skipped", reason: "no origin thread" } : { kind: "none" };
  }
  try {
    if (await closedByOwner(ctx.config.stateDir, ctx.transport, origin)) {
      const reason = `the owner closed origin thread ${origin}`;
      patchOne(ctx.config.stateDir, d.id, (x) => ({ ...x, linkSkipped: reason }));
      return { kind: "skipped", reason };
    }
    const message = await ctx.transport.send(origin, decisionLinkText(d), `decision-link:${d.id}`);
    patchOne(ctx.config.stateDir, d.id, (x) => ({ ...x, linkMessage: message }));
    return { kind: "linked", origin, message };
  } catch (e) {
    return { kind: "failed", reason: errorText(e) };
  }
};

/** Discord's THREAD_CREATED message type: the "started a thread" notice a thread started without a message leaves in its channel. */
const THREAD_CREATED = 18;

/**
 * Deletes the "started a thread" notice Discord posts in `channel` when `thread` starts there without a message (a
 * THREAD_CREATED message whose reference names the thread). Returns why it stayed, if it did, including when no notice
 * is found. Used by decisions and by `dori thread --drop-notice`.
 */
export const removeThreadNotice = async (transport: Pick<DecisionTransport, "messagesAfter" | "deleteMessage">, channel: string, thread: string): Promise<string | undefined> => {
  try {
    // The notice carries the thread's own id, and `after` excludes that id, so read from the id just before it.
    const notice = (await transport.messagesAfter(channel, (BigInt(thread) - 1n).toString())).find((m) => m.type === THREAD_CREATED && m.reference === thread);
    if (!notice) return `no "started a thread" notice for ${thread} in ${channel}`;
    await transport.deleteMessage(channel, notice.id);
    return undefined;
  } catch (e) {
    return errorText(e);
  }
};

/**
 * The lane thread a lane decision is posted into instead of a thread of its own: its origin thread when that already
 * sits in decisionsChannel (the ref's channel, else the thread's parent read from Discord) and the owner has not closed
 * it. Undefined otherwise, and when reading the thread fails (the decision then opens its own thread as before).
 */
const laneThreadInDecisions = async (ctx: DecisionContext, origin: string | undefined): Promise<string | undefined> => {
  const set = ctx.config.decisionsChannel?.trim();
  const ids = refIds(origin);
  if (!set || !ids) return undefined;
  try {
    const parent = ids.channel ?? (await ctx.transport.threadState(ids.thread)).parent;
    if (parent !== set || await closedByOwner(ctx.config.stateDir, ctx.transport, ids.thread)) return undefined;
    return ids.thread;
  } catch {
    return undefined;
  }
};

/**
 * Opens a decision: reserves its id as `posting`, starts a thread without a message in the channel with the owner as a
 * member, deletes Discord's "started a thread" notice from the channel body, posts the question as the thread's first
 * message (stable nonce `decision:<id>`, so a retry within Discord's dedupe window reuses it), records it `open`, then
 * posts the link line into the origin thread. A spec whose `sourceRef` already has a decision resumes that one instead
 * (a crash mid-post): a thread already recorded is reused. When the thread or its message cannot be made, the thread is
 * archived, the reservation dropped, and OwnerDecisionError DECISION_NOT_POSTED thrown. A notice that cannot be deleted
 * is recorded as `noticeKept`; a link that fails leaves the decision open (the tick retries it).
 * A lane decision whose lane thread already sits in decisionsChannel (laneThreadInDecisions) is posted into that thread
 * instead (`inLaneThread`): no thread is started, no notice deleted, no link posted, and a failed post leaves the lane
 * thread open.
 */
export const openOwnerDecision = async (ctx: DecisionContext, spec: DecisionSpec): Promise<OpenResult> => {
  const { stateDir } = ctx.config;
  const now = ctx.now();
  const channel = await decisionChannel(ctx.config, spec.origin, ctx.transport);
  const laneThread = spec.source === "lane" ? await laneThreadInDecisions(ctx, spec.origin) : undefined;
  const reserved = updateDecisions(stateDir, (file) => {
    const known = spec.sourceRef ? file.decisions.find((d) => d.source === spec.source && d.sourceRef === spec.sourceRef) : undefined;
    if (known) return { result: { decision: known, duplicateOf: undefined as string | undefined } };
    if (spec.source === "lane" && spec.lane) {
      const same = file.decisions.find((d) => d.state !== "closed" && d.lane === spec.lane && d.question === spec.question);
      if (same) return { result: { decision: same, duplicateOf: same.id } };
    }
    if (!channel) return { result: undefined };
    const decision: OwnerDecision = {
      id: `d${file.nextSeq}`, state: "posting", question: spec.question, options: spec.options, recommend: spec.recommend, reason: spec.reason,
      waiting: spec.waiting, blocking: spec.blocking, source: spec.source, channel: channel.channel, openedAt: now,
      ...(spec.kind ? { kind: spec.kind } : {}), ...(spec.file ? { file: spec.file } : {}),
      ...(spec.task !== undefined ? { task: spec.task } : {}), ...(spec.lane ? { lane: spec.lane } : {}),
      ...(spec.origin ? { origin: spec.origin } : {}), ...(spec.sourceRef ? { sourceRef: spec.sourceRef } : {}),
      ...(laneThread ? { thread: laneThread, inLaneThread: true, linkSkipped: "posted in the lane's own thread" } : {}),
    };
    return { file: { ...file, nextSeq: file.nextSeq + 1, decisions: [...file.decisions, decision] }, result: { decision, duplicateOf: undefined } };
  });
  if (!reserved) throw new OwnerDecisionError("DECISION_NOT_POSTED", "DECISION_NOT_POSTED no channel: set decisionsChannel (dori setup --set decisionsChannel=<channel id>)");
  const chosen: ChannelChoice = channel && channel.channel === reserved.decision.channel ? channel : { channel: reserved.decision.channel };
  if (reserved.duplicateOf) return { decision: reserved.decision, channel: chosen, link: { kind: "none" }, duplicateOf: reserved.duplicateOf };
  let d = reserved.decision;
  if (d.state !== "posting") {
    const link = d.linkMessage || d.linkSkipped ? { kind: "none" as const } : await postDecisionLink(ctx, d);
    return { decision: readDecisions(stateDir).decisions.find((x) => x.id === d.id) ?? d, channel: chosen, link };
  }
  let thread = d.thread;
  let noticeKept: string | undefined;
  try {
    if (!thread) {
      const started = (await ctx.transport.startThread(d.channel, undefined, decisionThreadName(d), ctx.config.discord?.ownerId, DECISION_AUTO_ARCHIVE_MIN)).id;
      thread = started;
      d = patchOne(stateDir, d.id, (x) => ({ ...x, thread: started })) ?? { ...d, thread: started };
      noticeKept = await removeThreadNotice(ctx.transport, d.channel, started);
    }
    const message = d.message ?? await ctx.transport.send(thread, decisionStartText(d, ctx.home), `decision:${d.id}`);
    const kept = noticeKept;
    d = patchOne(stateDir, d.id, (x) => ({ ...x, state: "open", message, ...(kept ? { noticeKept: kept } : {}) })) ?? { ...d, state: "open", message };
  } catch (e) {
    if (thread && !d.inLaneThread) { try { await ctx.transport.setThread(thread, { archived: true }); } catch { /* the reservation still goes */ } }
    removeOne(stateDir, d.id);
    throw new OwnerDecisionError("DECISION_NOT_POSTED", `DECISION_NOT_POSTED ${errorText(e)}`);
  }
  const link = await postDecisionLink(ctx, d);
  return { decision: readDecisions(stateDir).decisions.find((x) => x.id === d.id) ?? d, channel: chosen, link, ...(noticeKept ? { noticeKept } : {}) };
};

/**
 * Archives a closed decision's thread (its name stays as opened), then reads it back. A thread still open on read-back is
 * archived once more; still open after that throws, so the caller records the archive as pending.
 */
const archiveThread = async (transport: Pick<DecisionTransport, "setThread" | "threadArchived">, thread: string): Promise<void> => {
  await transport.setThread(thread, { archived: true });
  if (await transport.threadArchived(thread)) return;
  await transport.setThread(thread, { archived: true });
  if (!await transport.threadArchived(thread)) throw new Error(`thread ${thread} is still open after archiving it`);
};

export type CloseResult = {
  readonly decision: OwnerDecision;
  /** Why archiving failed (the decision is closed; the tick retries the archive). */
  readonly archivePending?: string;
  /** The OWNER_DECISION_ANSWERED event resolved by this close. */
  readonly resolved?: string;
  readonly linkNote?: string;
  /** What the close did with the owner's answer messages (set when the context carries receipts). */
  readonly answers?: AnswerOutcome;
};

export type AnswerRef = { readonly channel: string; readonly message: string };

export type AnswerOutcome = {
  /** The task count each covered message was recorded with (coverage 1/tasks). */
  readonly tasks: number;
  readonly acked: readonly AnswerRef[];
  readonly ackFailed: readonly (AnswerRef & { readonly error: string })[];
  readonly handled: readonly AnswerRef[];
  readonly handledFailed: readonly (AnswerRef & { readonly error: string })[];
  /** Answer messages acked but not covered (a decision in a lane's own thread covers only its first answer). */
  readonly left: readonly AnswerRef[];
};

const refKey = (a: AnswerRef): string => `${a.channel}/${a.message}`;
const refOf = (key: string): AnswerRef => {
  const [channel = "", message = ""] = key.split("/");
  return { channel, message };
};

/**
 * The answer messages a close covers, and the ones it only acks: every recorded answer plus `--from`; in a lane's own
 * thread (where every owner message counts as an answer while the decision is open) only the first answer and `--from`.
 */
const answerTargets = (d: OwnerDecision, from: string | undefined): { readonly covered: string[]; readonly left: string[] } => {
  const recorded = (d.answers ?? []).map(refKey);
  const fromKey = from && /^\d+\/\d+$/.test(from) ? [from] : [];
  const covered = [...new Set([...(d.inLaneThread ? recorded.slice(0, 1) : recorded), ...fromKey])];
  return { covered, left: [...new Set(recorded)].filter((key) => !covered.includes(key)) };
};

/** The close's lines about the answer messages, in the order they happened. */
export const answerOutcomeLines = (o: AnswerOutcome): string[] => {
  const tasks = o.tasks > 1 ? ` --tasks ${o.tasks}` : "";
  return [
    ...o.acked.map((a) => `DECISION_ACKED ${a.channel} ${a.message}`),
    ...o.ackFailed.map((a) => `DECISION_ACK_FAILED ${a.channel} ${a.message}: ${a.error}; the close went on`),
    ...o.handled.map((a) => `DECISION_HANDLED ${a.channel} ${a.message} coverage=1/${o.tasks}`),
    ...o.handledFailed.map((a) => `DECISION_HANDLED_FAILED ${a.channel} ${a.message}: ${a.error}; run the close again, or dori handled ${a.channel} ${a.message} --reply${tasks}`),
    ...o.left.map((a) => `DECISION_ANSWER_LEFT ${a.channel} ${a.message}: acked, not covered by the close; cover it with dori handled ${a.channel} ${a.message} --reply|--lane KEY`),
  ];
};

/** Records handled --reply for each covered answer not recorded yet, each success noted on the decision at once. */
const recordAnswersHandled = async (
  stateDir: string, receipts: DecisionReceipts, d: OwnerDecision,
): Promise<{ readonly handled: AnswerRef[]; readonly handledFailed: (AnswerRef & { readonly error: string })[] }> => {
  const handled: AnswerRef[] = [];
  const handledFailed: (AnswerRef & { readonly error: string })[] = [];
  const done = new Set(d.handledAnswers ?? []);
  for (const key of d.coveredAnswers ?? []) {
    if (done.has(key)) continue;
    const ref = refOf(key);
    try {
      await receipts.handled(ref.channel, ref.message, d.closeTasks ?? 1);
      patchOne(stateDir, d.id, (x) => ({ ...x, handledAnswers: [...new Set([...(x.handledAnswers ?? []), key])] }));
      handled.push(ref);
    } catch (e) {
      handledFailed.push({ ...ref, error: errorText(e) });
    }
  }
  return { handled, handledFailed };
};

/**
 * Closes a decision, the lead's one call on the owner's answer. In order: validates; with receipts, refuses
 * (DECISION_STALE, unless `force`) when the lead has not seen every owner message in the decision's thread and answer
 * channels, then acks the answer messages before the thread is archived (a failed ack only warns); posts the `[System]`
 * confirmation into its thread (stable nonce `decision-close:<id>`, so two closes post it once), archives the thread and
 * reads it back (archiveThread), records it closed, appends the outcome to the origin link line, and resolves its
 * OWNER_DECISION_ANSWERED obligation; last, records handled --reply (coverage 1/`tasks`) for each covered answer. A
 * close of a closed decision records the handled receipts still missing, then throws DECISION_ALREADY_CLOSED with their
 * lines. Throws OwnerDecisionError DECISION_UNKNOWN, DECISION_ALREADY_CLOSED, DECISION_BAD_CHOICE, DECISION_STALE, or
 * DECISION_NOT_CLOSED (the confirmation could not be posted; nothing closed).
 */
export const closeOwnerDecision = async (ctx: DecisionContext, id: string, options: CloseOptions): Promise<CloseResult> => {
  const { stateDir } = ctx.config;
  const { receipts } = ctx;
  const d = readDecisions(stateDir).decisions.find((x) => x.id === id);
  if (!d) throw new OwnerDecisionError("DECISION_UNKNOWN", `DECISION_UNKNOWN ${id}`);
  if (d.state === "closed") {
    const again = receipts ? await recordAnswersHandled(stateDir, receipts, d) : { handled: [], handledFailed: [] };
    const lines = answerOutcomeLines({ tasks: d.closeTasks ?? 1, acked: [], ackFailed: [], left: [], ...again });
    throw new OwnerDecisionError("DECISION_ALREADY_CLOSED", `DECISION_ALREADY_CLOSED ${id}`, lines);
  }
  if (options.choice !== undefined && d.kind === "request") throw new OwnerDecisionError("DECISION_BAD_CHOICE", `DECISION_BAD_CHOICE ${id}: a request takes no --choice`);
  if (options.choice !== undefined && (!Number.isInteger(options.choice) || options.choice < 1 || options.choice > d.options.length)) {
    throw new OwnerDecisionError("DECISION_BAD_CHOICE", `DECISION_BAD_CHOICE ${id}: --choice must be 1-${d.options.length}`);
  }
  const tasks = options.tasks ?? 1;
  const targets = answerTargets(d, options.from);
  const acked: AnswerRef[] = [];
  const ackFailed: (AnswerRef & { readonly error: string })[] = [];
  if (receipts) {
    if (!options.force) {
      const channels = [...new Set([d.thread, ...[...targets.covered, ...targets.left].map((key) => refOf(key).channel)].filter((c): c is string => !!c))];
      const stale = channels.map((channel) => receipts.unseen(channel));
      const count = stale.reduce((sum, s) => sum + s.count, 0);
      if (count) throw new OwnerDecisionError("DECISION_STALE", `DECISION_STALE ${count}`, stale.flatMap((s) => s.lines));
    }
    // Before the archive: a reaction on a message in an archived thread may be refused.
    for (const key of [...targets.covered, ...targets.left]) {
      const ref = refOf(key);
      if (receipts.acked(ref.channel, ref.message)) continue;
      try { await receipts.ack(ref.channel, ref.message); acked.push(ref); }
      catch (e) { ackFailed.push({ ...ref, error: errorText(e) }); }
    }
  }
  let archivePending: string | undefined;
  if (d.thread) {
    try { await ctx.transport.send(d.thread, decisionCloseText(d, options, ctx.home), `decision-close:${d.id}`); }
    catch (e) { throw new OwnerDecisionError("DECISION_NOT_CLOSED", `DECISION_NOT_CLOSED ${id} ${errorText(e)}`); }
    // A decision posted in a lane's own thread leaves that thread open: the lane keeps working there.
    if (!d.inLaneThread) {
      try { await archiveThread(ctx.transport, d.thread); }
      catch (e) { archivePending = errorText(e); }
    }
  }
  const at = ctx.now();
  const closed = patchOne(stateDir, id, (x) => (x.state === "closed" ? undefined : {
    ...x, state: "closed", closedAt: at, closeText: options.text,
    ...(options.choice !== undefined ? { choice: options.choice } : {}), ...(options.cancel ? { cancelled: true } : {}),
    ...(archivePending ? { archivePending: true } : {}),
    ...(receipts && targets.covered.length ? { coveredAnswers: targets.covered, closeTasks: tasks } : {}),
  })) ?? d;
  let resolved: string | undefined;
  if (closed.answerEvent) {
    recordResolved(stateDir, closed.answerEvent, at, `decision ${id}`);
    resolved = closed.answerEvent;
  }
  let linkNote: string | undefined;
  const origin = refIds(closed.origin)?.thread;
  if (origin && closed.linkMessage) {
    try {
      if (await closedByOwner(stateDir, ctx.transport, origin)) linkNote = "origin thread closed by the owner; link line left as it is";
      else if (!await appendToMessage(ctx.transport, origin, closed.linkMessage, decisionLinkClosedText(closed), await ctx.transport.threadArchived(origin))) linkNote = "link line too long to append";
    } catch (e) { linkNote = `link line not updated: ${errorText(e)}`; }
  }
  let answers: AnswerOutcome | undefined;
  if (receipts) {
    const recorded = await recordAnswersHandled(stateDir, receipts, closed);
    answers = { tasks: closed.closeTasks ?? tasks, acked, ackFailed, left: targets.left.map(refOf), ...recorded };
  }
  const decision = readDecisions(stateDir).decisions.find((x) => x.id === id) ?? closed;
  return { decision, ...(archivePending ? { archivePending } : {}), ...(resolved ? { resolved } : {}), ...(linkNote ? { linkNote } : {}), ...(answers ? { answers } : {}) };
};

/**
 * The decision whose thread is `channel` (any state but posting): the newest one not closed when the thread holds
 * several (a lane thread that took more than one question), else the newest. A closed decision posted in a lane's own
 * thread no longer claims that thread.
 */
const ofThread = (decisions: readonly OwnerDecision[], channel: string): OwnerDecision | undefined => {
  const mine = decisions.filter((d) => d.thread === channel && d.state !== "posting" && !(d.inLaneThread && d.state === "closed"));
  return mine.filter((d) => d.state !== "closed").at(-1) ?? mine.at(-1);
};

/** The decision whose thread is `channel` (ofThread), from the file as it is now. */
export const decisionOfThread = (stateDir: string, channel: string): OwnerDecision | undefined => ofThread(readDecisions(stateDir).decisions, channel);

export const answeredEventId = (id: string): string => `owner-decision-answered:${id}`;

/**
 * Records an owner message in decision thread `channel`: each message id once (REST catch-up and the gateway both see
 * it). The first answer moves the decision to `answered` and returns `first: true` with the event id to raise. A closed
 * decision records nothing. Undefined when `channel` is no decision's thread.
 */
export const recordOwnerAnswer = (stateDir: string, channel: string, message: string, at: number): { readonly decision: OwnerDecision; readonly first: boolean } | undefined => {
  if (!decisionOfThread(stateDir, channel)) return undefined;
  return recordAnswer(stateDir, (file) => ofThread(file.decisions, channel), channel, message, at);
};

const waitingIn = (decisions: readonly OwnerDecision[], channel: string): OwnerDecision[] =>
  decisions.filter((d) => d.channel === channel && (d.state === "open" || d.state === "answered"));

/**
 * Records an owner message posted in the body of decision channel `channel` (not in a thread) as an answer, like
 * recordOwnerAnswer, when exactly one decision there is waiting; with none or several it records nothing and returns
 * undefined (the message still reaches the lead as an owner message).
 */
export const recordChannelAnswer = (stateDir: string, channel: string, message: string, at: number): { readonly decision: OwnerDecision; readonly first: boolean } | undefined => {
  if (waitingIn(readDecisions(stateDir).decisions, channel).length !== 1) return undefined;
  return recordAnswer(stateDir, (file) => { const waiting = waitingIn(file.decisions, channel); return waiting.length === 1 ? waiting[0] : undefined; }, channel, message, at);
};

const recordAnswer = (
  stateDir: string, pick: (file: DecisionsFile) => OwnerDecision | undefined, channel: string, message: string, at: number,
): { readonly decision: OwnerDecision; readonly first: boolean } | undefined =>
  updateDecisions(stateDir, (file) => {
    const d = pick(file);
    if (!d) return { result: undefined };
    if (d.state === "closed" || d.answers?.some((a) => a.message === message)) return { result: { decision: d, first: false } };
    const first = d.answeredAt === undefined;
    const next: OwnerDecision = {
      ...d, answers: [...(d.answers ?? []), { channel, message, at }],
      ...(first ? { state: "answered" as const, answeredAt: at, answerEvent: answeredEventId(d.id) } : {}),
    };
    return { file: { ...file, decisions: file.decisions.map((x) => (x.id === d.id ? next : x)) }, result: { decision: next, first } };
  });

const short = (text: string, max = 80): string => cut(text.replace(/\s+/g, " ").trim(), max);
/** The question as the lead's lines show it: a request marked `[request]`. */
const subject = (d: OwnerDecision, max = 80): string => (d.kind === "request" ? `[request] ${short(d.question, max - 10)}` : short(d.question, max));
const threadRef = (d: OwnerDecision): string => (d.thread ? `discord:${d.channel}/${d.thread}` : `discord:${d.channel}`);

/** The event raised by the owner's first answer; its second word is the lane (`-` for none), as decision obligations read it. */
export const answeredLine = (d: OwnerDecision): string => {
  const answer = d.answers?.[0];
  const from = answer && answer.channel !== d.thread ? ` --from ${answer.channel}/${answer.message}` : "";
  const act = d.kind === "request"
    ? `${d.file ? `the owner says the value is in ${d.file}` : `the owner's reply is message ${answer?.channel ?? "?"}/${answer?.message ?? "?"}`}: hand it to ${d.lane ? `lane ${d.lane}` : "the work that waits"} (never into a report, the repo or another thread)`
    : undefined;
  const close = `dori decision close ${d.id}${from} --text "..."`;
  const head = `OWNER_DECISION_ANSWERED ${d.lane ?? "-"} ${d.id} ${d.blocking ? "blocking" : "nonblocking"} ${threadRef(d)}: ${subject(d)}${from ? " (answered in the channel body)" : ""}`;
  // A request closes once the value is handed over; a decision closes first (it acks, answers and covers the answer).
  if (act) return `${head}; ${act}, then run ${close} right away`;
  return `${head}; run ${close} first (it acks the answer, posts the reply and records it handled; --tasks N when the answer asks for more work), then act on it${d.lane ? ` and relay it to lane ${d.lane}` : ""}`;
};

/** The digest event of a decision the supervisor opened from a lane question. */
export const openedLine = (d: OwnerDecision, duplicateOf?: string): string =>
  `OWNER_DECISION_OPENED ${d.id} lane ${d.lane ?? "-"} ${d.blocking ? "blocking" : "nonblocking"} ${threadRef(d)} ${subject(d)}${duplicateOf ? ` (duplicate of ${duplicateOf})` : ""}`;

const age = (ms: number): string => {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return min >= 2880 ? `${Math.floor(min / 1440)}d` : min >= 60 ? `${Math.floor(min / 60)}h` : `${min}m`;
};

/** `dori decision list`'s line for one decision. */
export const decisionListLine = (d: OwnerDecision, now: number): string =>
  `${d.id} ${d.state} ${d.blocking ? "blocking" : "nonblocking"}${d.task !== undefined ? ` task=#${d.task}` : ""}${d.lane ? ` lane=${d.lane}` : ""} age=${age(now - d.openedAt)} thread=${threadRef(d)} ${subject(d)}`;

/** Decisions not closed, oldest first. */
export const openOwnerDecisions = (stateDir: string): OwnerDecision[] =>
  readDecisions(stateDir).decisions.filter((d) => d.state !== "closed").sort((a, b) => a.openedAt - b.openedAt);

/**
 * `dori inbox take`'s informational lines (not checklist items: the owner has not answered yet, or the answer is already
 * an UNRESOLVED reminder): one per decision not closed.
 */
export const takeOwnerDecisionLines = (stateDir: string, now: number): string[] =>
  openOwnerDecisions(stateDir).map((d) =>
    `decision:${d.id}\tDECISION_${d.state === "answered" ? "ANSWERED" : "WAITING"} ${d.id} ${d.blocking ? "blocking" : "nonblocking"}${d.task !== undefined ? ` task=#${d.task}` : ""}${d.lane ? ` lane=${d.lane}` : ""} open ${age(now - d.openedAt)}: ${subject(d)}`);

/** Open decisions bound to a lane, as close-button blockers (thread-finality.ts): `{ id, lane }`. */
export const ownerDecisionBlockers = (stateDir: string): { readonly id: string; readonly lane: string }[] =>
  openOwnerDecisions(stateDir).flatMap((d) => (d.lane ? [{ id: d.id, lane: d.lane }] : []));

/** The local date (YYYY-MM-DD) and hour of `ms` in `timeZone`. */
export const localDayHour = (ms: number, timeZone: string): { readonly day: string; readonly hour: number } => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};

/** The daily reminder: one line per decision still waiting on the owner or on the lead. */
export const digestText = (decisions: readonly OwnerDecision[], now: number): string => [
  `[System] 답을 기다리는 결정·요청 ${decisions.length}건`,
  ...decisions.map((d) => {
    const days = Math.floor(Math.max(0, now - d.openedAt) / 86_400_000) + 1;
    const state = d.state === "answered" ? "답 받음, 리드 반영 대기" : `${days}일째, ${d.blocking ? "막는 중" : "선진행"}`;
    return `- [${label(d)}] ${d.id} <#${d.thread ?? d.channel}> ${state} · ${d.task !== undefined ? `#${d.task} ` : ""}${short(d.question, 60)}`;
  }),
].join("\n");

export type TickDeps = DecisionContext & {
  /** Journals one event under a stable id (the supervisor dedupes ids). */
  readonly enqueue: (id: string, line: string) => unknown;
  readonly log?: (line: string) => void;
};

/**
 * The supervisor's pass over decisions.json: a decision stuck `posting` raises OWNER_DECISION_STUCK once; a missing link
 * line is posted again; a pending archive is retried (a thread Discord no longer has raises OWNER_DECISION_THREAD_GONE
 * once); the daily reminder goes to decisionsChannel (else alertsChannelOf) on the first pass at or after
 * DECISION_DIGEST_HOUR in displayTimeZone when anything still waits; closed decisions past DECISION_KEEP_CLOSED_MS are
 * dropped. The owner's answers themselves arrive through inbound (recordOwnerAnswer), and an answered decision left
 * unclosed is reminded as an UNRESOLVED obligation.
 */
export const ownerDecisionTick = async (deps: TickDeps): Promise<void> => {
  const { stateDir } = deps.config;
  const log = deps.log ?? console.error;
  const now = deps.now();
  const file = readDecisions(stateDir);
  for (const d of file.decisions) {
    if (d.state === "posting" && d.stuckAt === undefined && now - d.openedAt >= DECISION_POSTING_STUCK_MS) {
      await deps.enqueue(`owner-decision-stuck:${d.id}`, `OWNER_DECISION_STUCK ${d.id} posting since ${new Date(d.openedAt).toISOString()}${d.lane ? ` lane ${d.lane}` : ""}: its writer stopped mid-post; check the decisions channel for its thread, then dori decision close ${d.id} --cancel --text "..." and open it again`);
      patchOne(stateDir, d.id, (x) => ({ ...x, stuckAt: now }));
    }
    if ((d.state === "open" || d.state === "answered") && d.thread && d.origin && !d.linkMessage && !d.linkSkipped) {
      const link = await postDecisionLink(deps, d);
      if (link.kind === "failed") log(`OWNER_DECISION_LINK_FAILED ${d.id} ${link.reason}`);
    }
    if (d.state === "closed" && d.archivePending && d.thread && d.goneAt === undefined) {
      try {
        await archiveThread(deps.transport, d.thread);
        patchOne(stateDir, d.id, (x) => { const { archivePending: _, ...rest } = x; return rest; });
      } catch (e) {
        if (isGone(e)) {
          await deps.enqueue(`owner-decision-gone:${d.id}`, `OWNER_DECISION_THREAD_GONE ${d.id} thread ${d.thread} no longer exists (archive retry): nothing to do unless the decision should be asked again`);
          patchOne(stateDir, d.id, (x) => ({ ...x, goneAt: now }));
        } else log(`OWNER_DECISION_ARCHIVE_FAILED ${d.id} ${errorText(e)}`);
      }
    }
  }
  const { day, hour } = localDayHour(now, deps.config.displayTimeZone);
  if (hour >= DECISION_DIGEST_HOUR && readDecisions(stateDir).digestDay !== day) {
    const waiting = openOwnerDecisions(stateDir).filter((d) => d.state === "open" || d.state === "answered");
    const target = deps.config.decisionsChannel?.trim() || alertsChannelOf(deps.config);
    if (waiting.length && target) {
      try {
        await deps.transport.send(target, digestText(waiting, now), `decision-digest:${day}`);
        updateDecisions(stateDir, (f) => ({ file: { ...f, digestDay: day }, result: undefined }));
      } catch (e) { log(`OWNER_DECISION_DIGEST_FAILED ${errorText(e)}`); }
    } else updateDecisions(stateDir, (f) => ({ file: { ...f, digestDay: day }, result: undefined }));
  }
  if (readDecisions(stateDir).decisions.some((d) => d.state === "closed" && now - (d.closedAt ?? now) >= DECISION_KEEP_CLOSED_MS)) {
    updateDecisions(stateDir, (f) => ({ file: { ...f, decisions: f.decisions.filter((d) => !(d.state === "closed" && now - (d.closedAt ?? now) >= DECISION_KEEP_CLOSED_MS)) }, result: undefined }));
  }
};

/** A request as a decision spec: what is needed as its question, no options. */
export const requestSpec = (request: { readonly need: string; readonly reason: string; readonly file?: string; readonly waiting: string; readonly blocking: boolean }): DecisionChoices & Pick<DecisionSpec, "kind" | "file"> => ({
  kind: "request", question: request.need, options: [], recommend: 0, reason: request.reason, waiting: request.waiting, blocking: request.blocking,
  ...(request.file ? { file: request.file } : {}),
});

/**
 * Opens the decision or request a lane question carries (its text in a runner/decision-text.ts form: DECISION v1 or
 * REQUEST v1), once per report row; undefined when the text is a free-text question (routed as before). Throws like
 * openOwnerDecision.
 */
export const openLaneDecision = async (
  ctx: DecisionContext, lane: { readonly key: string; readonly thread: string }, report: { readonly id: string; readonly text: string },
): Promise<OpenResult | undefined> => {
  const request = parseRequestText(report.text);
  const choices = request ? requestSpec(request) : parseDecisionText(report.text);
  if (!choices) return undefined;
  const task = taskOfLane(lane.key);
  return openOwnerDecision(ctx, {
    ...choices, source: "lane", sourceRef: report.id, lane: lane.key,
    ...(task !== undefined ? { task } : {}), ...(lane.thread !== "none" && refIds(lane.thread) ? { origin: lane.thread } : {}),
  });
};
