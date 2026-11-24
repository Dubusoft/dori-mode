import { type DoriConfig } from "./config.ts";
import {
  DECISION_AUTO_ARCHIVE_MIN, DECISION_KEEP_CLOSED_MS, DECISION_POSTING_STUCK_MS, DECISION_RELAY_ATTEMPTS, type DecisionTarget, type DecisionsFile, decisionTargetOf, type OwnerDecision,
  OwnerDecisionError, patchOne, readDecisions, removeOne, type TargetLane, updateDecisions,
} from "./decision-store.ts";
import { recordResolved } from "./decision-obligations.ts";
import { scrubForThread } from "./freshness.ts";
import { decisionButtonRows, decisionButtonsKey, hasDecisionButtons, POSTED_BUTTONS_KEY } from "./messenger/decision-buttons.ts";
import { MessengerError } from "./messenger/http.ts";
import { type DecisionChoices, parseDecisionText, parseRequestText } from "./runner/decision-text.ts";
import { appendToMessage, closedByOwner } from "./thread-followup.ts";

import { recordReviewDecision, REVIEW_DECISION_OUTCOMES, type ReviewDecisionOutcome, ReviewJobs } from "./review-jobs.ts";
import type { ReviewCapDecision } from "./decision-store.ts";
import { errLine } from "./line-text.ts";
/** What opening, closing and the tick need from Discord; the Discord client fits it. */
export type DecisionTransport = {
  /** `components` (action rows) ride under the message, as Discord.send puts them. */
  send(channel: string, content: string, stableId?: string, components?: readonly unknown[]): Promise<string>;
  edit(channel: string, messageId: string, content: string): Promise<void>;
  /** Replaces a message's action rows, leaving its text as it is. */
  editComponents(channel: string, messageId: string, components: readonly unknown[]): Promise<void>;
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

/**
 * The thread's starter message: question, numbered options with the recommendation marked, reason, what waits, origin.
 * A question with answer buttons (decisionButtonRows) says the owner can press one. One posted into another decision's
 * thread (attachedTo) or a lane's own thread asks for the answer as a reply to this message, which is how the supervisor
 * tells the answers apart (answerTarget); an attached one also says the thread holds another matter.
 */
export const decisionStartText = (d: OwnerDecision, home: string): string => {
  const head = [`**[${label(d)} ${d.id}]**`, d.task !== undefined ? `Toodo #${d.task}` : undefined, d.lane ? `레인 ${d.lane}` : undefined, d.attachedTo ? `별도 건(${d.attachedTo} 스레드에 함께 올림)` : undefined].filter(Boolean).join(" · ");
  const origin = refIds(d.origin)?.thread;
  // A lane's own thread carries its reports and may hold another of its questions: a reply there names this one too.
  const where = d.attachedTo || d.inLaneThread ? "이 메시지에 답장(reply)해서" : "이 스레드에";
  const shared = d.attachedTo ? [`이 스레드에는 ${d.attachedTo} 등 다른 건도 열려 있어, ${d.id}의 답은 이 메시지에 답장해야 구분됩니다.`] : [];
  if (d.kind === "request") return scrubForThread([
    head,
    `필요한 것: ${d.question}`,
    `이유: ${d.reason}`,
    d.file
      ? `보내는 곳: 파일 \`${d.file}\`에 넣고 권한을 600으로 맞춰 주세요(\`chmod 600 ${d.file}\`). 값은 이 스레드에 붙여넣지 마시고, 넣은 뒤 ${where} "완료"라고만 답해 주세요.`
      : `보내는 곳: ${d.attachedTo || d.inLaneThread ? where : "이 스레드에 답으로"} 보내 주세요(인증코드처럼 한 번 쓰고 끝나는 값만). 비밀번호나 API 키 같은 오래 쓰는 비밀은 여기에 올리지 마세요.`,
    ...shared,
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
    ...shared,
    hasDecisionButtons(d) ? `버튼을 누르거나, ${where} 번호나 문장으로 답해 주세요.` : `${where} 번호나 문장으로 답해 주세요.`,
  ].join("\n"), home);
};

/** The origin thread's one link line; the question itself stays in the decision thread. */
export const decisionLinkText = (d: OwnerDecision): string => `[System] 오너 ${label(d)} ${d.id}: <#${d.thread ?? ""}>`;

export type CloseOptions = {
  /** The close text: the reply to the owner, except for a decision that relays to its lane, where it goes to the lane (relaysToLane). */
  readonly text: string;
  /** The owner's line in the thread confirmation, in place of `text` (or of the automatic line when `text` goes to the lane). */
  readonly ownerText?: string;
  readonly choice?: number;
  /** `<channel>/<message>` of an answer the owner gave outside the decision thread. */
  readonly from?: string;
  readonly cancel?: boolean;
  /** The tasks each covered answer message holds; the close covers one of them (the rest go to `dori handled --lane`). */
  readonly tasks?: number;
  /** Close even when the lead has not seen every owner message in the decision's thread and answer channels. */
  readonly force?: boolean;
};

/**
 * A lane's own question or request (asked with `dori report`), or a lead decision opened with `--relay-to`: its close
 * text is relayed to that lane (decision-relay.ts), not shown to the owner.
 */
export const relaysToLane = (d: Pick<OwnerDecision, "source" | "lane" | "relayTo">): boolean =>
  !!d.lane && (d.source === "lane" || d.relayTo === d.lane);

export const decisionCloseText = (d: OwnerDecision, options: CloseOptions, home: string, keepsThread = d.inLaneThread === true): string => {
  const from = options.from ? /^(\d+)\/(\d+)$/.exec(options.from) : null;
  const picked = options.choice !== undefined ? ` ${options.choice}번(${cut(d.options[options.choice - 1] ?? "", 60)})` : "";
  const by = d.answeredAt === undefined && !d.revisions?.length && !from && !options.cancel ? " (리드가 정함)" : "";
  const where = from ? ` (<#${from[1]}>에서 받은 답: https://discord.com/channels/@me/${from[1]}/${from[2]})` : "";
  const note = (options.ownerText ?? (relaysToLane(d) ? `레인 ${d.lane}에 전달합니다` : options.text)).replace(/\s+/g, " ").trim();
  const outcome = options.cancel ? "취소" : d.kind === "request" ? "요청 처리" : `결정 반영:${picked}`;
  return scrubForThread(`[System] ${d.id} ${outcome}${d.kind === "request" ? "" : by}${where}. ${note}${/[.!?。]$/.test(note) ? "" : "."}${keepsThread ? "" : " 스레드를 닫습니다."}`, home);
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
  readonly target?: DecisionTarget;
  /** A lead decision's `--relay-to`: the same key as `lane`. */
  readonly relayTo?: string;
  readonly reviewCap?: ReviewCapDecision;
};

const isGone = (e: unknown): boolean => e instanceof MessengerError && e.status === 404;

/**
 * Posts the link line into the decision's origin thread and records it: skipped (recorded, never retried) when there is
 * no origin thread or the owner closed it, failed (retried by the tick) when the post throws.
 */
export const postDecisionLink = async (ctx: DecisionContext, d: OwnerDecision): Promise<LinkResult> => {
  if (d.inLaneThread || d.attachedTo) return { kind: "none" };
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
    return { kind: "failed", reason: errLine(e) };
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
    return errLine(e);
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
    // One open blocking question per lane or task gets a thread; a later one joins it instead of opening another.
    const attach = laneThread ? undefined : file.decisions.filter((x) => (x.state === "open" || x.state === "answered") && x.blocking && x.thread
      && ((spec.lane !== undefined && x.lane === spec.lane) || (spec.task !== undefined && x.task === spec.task))).at(-1);
    if (!channel && !attach) return { result: undefined };
    const decision: OwnerDecision = {
      id: `d${file.nextSeq}`, state: "posting", question: spec.question, options: spec.options, recommend: spec.recommend, reason: spec.reason,
      waiting: spec.waiting, blocking: spec.blocking, source: spec.source, channel: attach?.channel ?? channel?.channel ?? "", openedAt: now,
      ...(spec.kind ? { kind: spec.kind } : {}), ...(spec.file ? { file: spec.file } : {}),
      ...(spec.task !== undefined ? { task: spec.task } : {}), ...(spec.lane ? { lane: spec.lane } : {}),
      ...(spec.origin ? { origin: spec.origin } : {}), ...(spec.sourceRef ? { sourceRef: spec.sourceRef } : {}),
      ...(spec.target ? { target: spec.target } : {}), ...(spec.relayTo ? { relayTo: spec.relayTo } : {}),
      ...(spec.reviewCap ? { reviewCap: spec.reviewCap } : {}),
      ...(laneThread ? { thread: laneThread, inLaneThread: true, linkSkipped: "posted in the lane's own thread" } : {}),
      ...(attach ? { thread: attach.thread, attachedTo: attach.id, linkSkipped: `posted in ${attach.id}'s thread`, ...(attach.inLaneThread ? { inLaneThread: true } : {}) } : {}),
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
    const message = d.message ?? await ctx.transport.send(thread, decisionStartText(d, ctx.home), `decision:${d.id}`, decisionButtonRows(d));
    const kept = noticeKept;
    d = patchOne(stateDir, d.id, (x) => ({ ...x, state: "open", message, ...(kept ? { noticeKept: kept } : {}) })) ?? { ...d, state: "open", message };
  } catch (e) {
    removeOne(stateDir, d.id);
    // An attached decision archives the shared thread only when the decisions it joined all closed meanwhile.
    const orphaned = thread !== undefined && !d.inLaneThread && (!d.attachedTo || !readDecisions(stateDir).decisions.some((x) => x.thread === thread && x.state !== "closed"));
    if (thread && orphaned) { try { await ctx.transport.setThread(thread, { archived: true }); } catch { /* the reservation still goes */ } }
    throw new OwnerDecisionError("DECISION_NOT_POSTED", `DECISION_NOT_POSTED ${errLine(e)}`);
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

/**
 * Brings `d`'s answer buttons in line with its state (decision-buttons.ts decisionButtonState) when its starter message
 * shows something else: one edit of the message's action rows, then `buttons` recorded. A failed edit throws and leaves
 * `buttons` as it was, so the next call tries again.
 */
export const syncDecisionButtons = async (ctx: Pick<DecisionContext, "config" | "transport">, d: OwnerDecision): Promise<OwnerDecision> => {
  const rows = decisionButtonRows(d);
  const key = decisionButtonsKey(d);
  if (!rows || !d.thread || !d.message || key === (d.buttons ?? POSTED_BUTTONS_KEY)) return d;
  await ctx.transport.editComponents(d.thread, d.message, rows);
  return patchOne(ctx.config.stateDir, d.id, (x) => ({ ...x, buttons: key })) ?? d;
};

export type CloseResult = {
  readonly decision: OwnerDecision;
  /** Why the answer buttons could not be disabled (the decision is closed; they stay as they were). */
  readonly buttonsNote?: string;
  /** Why archiving failed (the decision is closed; the tick retries the archive). */
  readonly archivePending?: string;
  /** The OWNER_DECISION_ANSWERED event resolved by this close. */
  readonly resolved?: string;
  readonly linkNote?: string;
  /** What the close did with the owner's answer messages (set when the context carries receipts). */
  readonly answers?: AnswerOutcome;
  /** The outcome a review limit decision's choice recorded on its capped job. */
  readonly review?: { readonly jobId: string; readonly outcome: ReviewDecisionOutcome };
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
  // A button press handed to the lead is no Discord message: nothing to ack or record handled.
  const recorded = (d.answers ?? []).filter((a) => a.choice === undefined).map(refKey);
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
      handledFailed.push({ ...ref, error: errLine(e) });
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
 * OWNER_DECISION_ANSWERED obligation; its answer buttons are disabled once it is recorded closed, before the archive; last, records handled --reply (coverage 1/`tasks`) for each covered answer. A
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
  if (d.reviewCap && options.choice === undefined && !options.cancel) {
    throw new OwnerDecisionError("DECISION_BAD_CHOICE", `DECISION_BAD_CHOICE ${id}: a review limit decision closes with --choice 1-${d.options.length} (or --cancel)`);
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
      catch (e) { ackFailed.push({ ...ref, error: errLine(e) }); }
    }
  }
  // A review limit decision's outcome is recorded on its job first too: the review gate reads it from there.
  let review: CloseResult["review"];
  const outcome = d.reviewCap && options.choice !== undefined ? REVIEW_DECISION_OUTCOMES[options.choice - 1] : undefined;
  if (d.reviewCap && outcome) {
    try {
      recordReviewDecision(new ReviewJobs(stateDir), ctx.now(), d.reviewCap.jobId, d.id, outcome);
      review = { jobId: d.reviewCap.jobId, outcome };
    } catch (e) { throw new OwnerDecisionError("DECISION_REVIEW_FAILED", `DECISION_REVIEW_FAILED ${id}: ${errLine(e)}; nothing closed`); }
  }
  let archivePending: string | undefined;
  if (d.thread) {
    // The confirmation's wording only: whether this close archives is settled below, with the close itself.
    const shared = readDecisions(stateDir).decisions.some((x) => x.id !== d.id && x.thread === d.thread && x.state !== "closed");
    const keepsThread = d.inLaneThread === true || shared;
    try { await ctx.transport.send(d.thread, decisionCloseText(d, options, ctx.home, keepsThread), `decision-close:${d.id}`); }
    catch (e) { throw new OwnerDecisionError("DECISION_NOT_CLOSED", `DECISION_NOT_CLOSED ${id} ${errLine(e)}`); }
  }
  const at = ctx.now();
  // Under DECISIONS_LOCK with the close: the close that leaves no other decision waiting in its thread (attachedTo, either
  // way; a lane's own thread never) owns the archive, recorded as archivePending until it is done. Overlapping closes and
  // a decision attaching during the confirmation post therefore archive the thread exactly once, after its last decision.
  const recorded = updateDecisions(stateDir, (file): { file?: DecisionsFile; result: { decision: OwnerDecision; owns: boolean } | undefined } => {
    const x = file.decisions.find((y) => y.id === id);
    if (!x || x.state === "closed") return { result: undefined };
    const owns = x.thread !== undefined && !x.inLaneThread && !file.decisions.some((y) => y.id !== id && y.thread === x.thread && y.state !== "closed");
    const next: OwnerDecision = {
      ...x, state: "closed", closedAt: at, closeText: options.text,
      ...(options.choice !== undefined ? { choice: options.choice } : {}), ...(options.cancel ? { cancelled: true } : {}),
      ...(owns ? { archivePending: true } : {}),
      ...(receipts && targets.covered.length ? { coveredAnswers: targets.covered, closeTasks: tasks } : {}),
    };
    return { file: { ...file, decisions: file.decisions.map((y) => (y.id === id ? next : y)) }, result: { decision: next, owns } };
  });
  let closed = recorded?.decision ?? d;
  // Before the archive: a message in an archived thread cannot be edited.
  let buttonsNote: string | undefined;
  try { closed = await syncDecisionButtons(ctx, closed); }
  catch (e) { buttonsNote = `answer buttons not disabled: ${errLine(e)}`; }
  if (recorded?.owns && closed.thread) {
    try {
      await archiveThread(ctx.transport, closed.thread);
      closed = patchOne(stateDir, id, (x) => { const { archivePending: _, ...rest } = x; return rest; }) ?? closed;
    } catch (e) { archivePending = errLine(e); }
  }
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
      else if (!await appendToMessage(ctx.transport, origin, closed.linkMessage, decisionLinkClosedText(closed), await ctx.transport.threadArchived(origin), `decision-link:${id}`)) linkNote = "link line too long to append";
    } catch (e) { linkNote = `link line not updated: ${errLine(e)}`; }
  }
  let answers: AnswerOutcome | undefined;
  if (receipts) {
    const recorded = await recordAnswersHandled(stateDir, receipts, closed);
    answers = { tasks: closed.closeTasks ?? tasks, acked, ackFailed, left: targets.left.map(refOf), ...recorded };
  }
  const decision = readDecisions(stateDir).decisions.find((x) => x.id === id) ?? closed;
  return { decision, ...(buttonsNote ? { buttonsNote } : {}), ...(archivePending ? { archivePending } : {}), ...(resolved ? { resolved } : {}), ...(linkNote ? { linkNote } : {}), ...(answers ? { answers } : {}), ...(review ? { review } : {}) };
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

/** What an owner message in a decision thread says about its target: the message it replies to and its text. */
export type AnswerHint = { readonly replyTo?: string; readonly content?: string };

/**
 * The decision an owner message in thread `channel` answers. With one waiting decision there, that one; with several (a
 * shared thread), the one whose question message it replies to, else the only one its text names by id (`d136`); never
 * the newest by guess, so a message that names none answers none and the lead reads it and picks. With none waiting,
 * ofThread (a closed decision records nothing).
 */
const answerTarget = (decisions: readonly OwnerDecision[], channel: string, hint: AnswerHint): OwnerDecision | undefined => {
  const waiting = decisions.filter((d) => d.thread === channel && (d.state === "open" || d.state === "answered"));
  if (waiting.length <= 1) return waiting[0] ?? ofThread(decisions, channel);
  const replied = hint.replyTo === undefined ? undefined : waiting.find((d) => d.message === hint.replyTo);
  if (replied) return replied;
  const ids = new Set(Array.from(hint.content?.matchAll(/(?<![A-Za-z0-9])d(\d{1,9})(?![0-9])/gi) ?? [], (m) => `d${Number(m[1])}`));
  const named = waiting.filter((d) => ids.has(d.id));
  return named.length === 1 ? named[0] : undefined;
};

export const answeredEventId = (id: string): string => `owner-decision-answered:${id}`;

/**
 * Records an owner message in decision thread `channel` on the decision it answers (answerTarget): each message id once,
 * on one decision only (REST catch-up and the gateway both see it, and a decision attached later must not take an answer
 * an earlier one already holds). The first answer moves the decision to `answered` and returns `first: true` with the
 * event id to raise. A closed decision records nothing. Undefined when `channel` is no decision's thread, or when a shared
 * thread's message names no one decision.
 */
export const recordOwnerAnswer = (stateDir: string, channel: string, message: string, at: number, hint: AnswerHint = {}): { readonly decision: OwnerDecision; readonly first: boolean } | undefined => {
  if (!decisionOfThread(stateDir, channel)) return undefined;
  return recordAnswer(stateDir, (file) => answerTarget(file.decisions, channel, hint), channel, message, at);
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

/**
 * Records the owner's press of button `choice` on decision `id`, made in `channel` as interaction message `message`
 * (decision-inbound.ts routeDecisionClick, a click the lane cannot take directly), as an answer the lead holds, like
 * recordOwnerAnswer: each click once; the first answer moves the decision to `answered` and returns `first: true`.
 * `added` is false for a click already recorded or a closed decision. Undefined for an unknown decision.
 */
export const recordButtonAnswer = (
  stateDir: string, id: string, channel: string, message: string, choice: number, at: number,
): { readonly decision: OwnerDecision; readonly first: boolean; readonly added: boolean } | undefined =>
  recordAnswer(stateDir, (file) => file.decisions.find((d) => d.id === id), channel, message, at, choice);

/** The decision already holding owner message `channel`/`message` as an answer, or covering it with its close. */
const heldBy = (decisions: readonly OwnerDecision[], channel: string, message: string): OwnerDecision | undefined =>
  decisions.find((d) => d.answers?.some((a) => a.channel === channel && a.message === message) || d.coveredAnswers?.includes(`${channel}/${message}`));

const recordAnswer = (
  stateDir: string, pick: (file: DecisionsFile) => OwnerDecision | undefined, channel: string, message: string, at: number, choice?: number,
): { readonly decision: OwnerDecision; readonly first: boolean; readonly added: boolean } | undefined =>
  updateDecisions(stateDir, (file): { file?: DecisionsFile; result: { decision: OwnerDecision; first: boolean; added: boolean } | undefined } => {
    const held = heldBy(file.decisions, channel, message);
    if (held) return { result: { decision: held, first: false, added: false } };
    const d = pick(file);
    if (!d) return { result: undefined };
    if (d.state === "closed") return { result: { decision: d, first: false, added: false } };
    const first = d.answeredAt === undefined;
    const next: OwnerDecision = {
      ...d, answers: [...(d.answers ?? []), { channel, message, at, ...(choice !== undefined ? { choice } : {}) }],
      ...(first ? { state: "answered" as const, answeredAt: at, answerEvent: answeredEventId(d.id) } : {}),
    };
    return { file: { ...file, decisions: file.decisions.map((x) => (x.id === d.id ? next : x)) }, result: { decision: next, first, added: true } };
  });

export const short = (text: string, max = 80): string => cut(text.replace(/\s+/g, " ").trim(), max);
/** How the lead's lines name a choice: its number and option text, `choice=2 "Replace"`. */
export const choiceLabel = (d: Pick<OwnerDecision, "options">, choice: number): string => `choice=${choice} "${short(d.options[choice - 1] ?? "", 80)}"`;
/** The question as the lead's lines show it: a request marked `[request]`. */
const subject = (d: OwnerDecision, max = 80): string => (d.kind === "request" ? `[request] ${short(d.question, max - 10)}` : short(d.question, max));
const threadRef = (d: OwnerDecision): string => (d.thread ? `discord:${d.channel}/${d.thread}` : `discord:${d.channel}`);

/** The event raised by the owner's first answer; its second word is the lane (`-` for none), as decision obligations read it. */
export const answeredLine = (d: OwnerDecision): string => {
  const answer = d.answers?.[0];
  // A button press the lane could not take directly: its choice is the answer, and no message to point --from at.
  const button = answer?.choice;
  const from = answer && button === undefined && answer.channel !== d.thread ? ` --from ${answer.channel}/${answer.message}` : "";
  const value = d.kind === "request"
    ? `; ${d.file ? `the owner says the value is in ${d.file}` : `the owner's reply is message ${answer?.channel ?? "?"}/${answer?.message ?? "?"}`} (never into a report, the repo or another thread)`
    : "";
  const close = `dori decision close ${d.id}${from}${button !== undefined ? ` --choice ${button}` : ""} --text "..."`;
  const head = `OWNER_DECISION_ANSWERED ${d.lane ?? "-"} ${d.id} ${d.blocking ? "blocking" : "nonblocking"} ${threadRef(d)}: ${subject(d)}${from ? " (answered in the channel body)" : ""}`
    + (button !== undefined ? ` ${choiceLabel(d, button)} via button` : "");
  // One wording for decisions and requests: the close is the first call, and for a decision that relays to its lane it
  // also types --text into that lane (decision-relay.ts), so --text is what the lane needs to go on.
  const relay = relaysToLane(d)
    ? ` and types --text into lane ${d.lane}, so write it for the lane; hand it over yourself only on DECISION_RELAY_FAILED`
    : d.lane ? `; it does not reach lane ${d.lane}, relay it yourself` : "";
  return `${head}${value}; run ${close} first (it acks the answer, posts the reply, records it handled${relay}; --tasks N when the answer asks for more work), then act on it`;
};

/** The lead's urgent line for a close whose text could not be typed into its lane after every attempt (decision-relay.ts). */
export const relayFailedLine = (d: Pick<OwnerDecision, "id" | "relay">): string =>
  `DECISION_RELAY_FAILED ${d.relay?.lane ?? "-"} ${d.id}: ${d.relay?.reason ?? "not delivered"}; the close text did not reach the lane after ${d.relay?.attempts ?? 1} attempts and is not retried again, hand it to the lane yourself with dori lane send naming ${d.id} (its parked goal resumes once the lane acks it)`;

/** The digest event of a decision the supervisor opened from a lane question. */
export const openedLine = (d: OwnerDecision, duplicateOf?: string): string =>
  `OWNER_DECISION_OPENED ${d.id} lane ${d.lane ?? "-"} ${d.blocking ? "blocking" : "nonblocking"} ${threadRef(d)} ${subject(d)}${duplicateOf ? ` (duplicate of ${duplicateOf})` : ""}${d.attachedTo && !duplicateOf ? ` (posted in ${d.attachedTo}'s thread)` : ""}`;

const age = (ms: number): string => {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return min >= 2880 ? `${Math.floor(min / 1440)}d` : min >= 60 ? `${Math.floor(min / 60)}h` : `${min}m`;
};

/** `dori decision list`'s line for one decision. */
export const decisionListLine = (d: OwnerDecision, now: number): string => {
  const last = d.revisions?.at(-1);
  const answer = last ? ` answer=r${last.rev}:${last.choice ?? "withdrawn"} delivery=${last.delivery.state}` : "";
  return `${d.id} ${d.state} ${d.blocking ? "blocking" : "nonblocking"}${d.task !== undefined ? ` task=#${d.task}` : ""}${d.lane ? ` lane=${d.lane}` : ""}${answer} age=${age(now - d.openedAt)} thread=${threadRef(d)} ${subject(d)}`;
};

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

/** Open decisions bound to a lane, as blockers of a thread's automatic close (thread-finality.ts): `{ id, lane }`. */
export const ownerDecisionBlockers = (stateDir: string): { readonly id: string; readonly lane: string }[] =>
  openOwnerDecisions(stateDir).flatMap((d) => (d.lane ? [{ id: d.id, lane: d.lane }] : []));

export type TickDeps = DecisionContext & {
  /** Journals one event under a stable id (the supervisor dedupes ids). */
  readonly enqueue: (id: string, line: string) => unknown;
  readonly log?: (line: string) => void;
};

/**
 * The supervisor's pass over decisions.json: a decision stuck `posting` raises OWNER_DECISION_STUCK once; a missing link
 * line is posted again; a pending archive is retried (a thread Discord no longer has raises OWNER_DECISION_THREAD_GONE
 * once); a close whose text could not be relayed to its lane in DECISION_RELAY_ATTEMPTS tries (decision-relay.ts
 * retryDecisionRelays) raises DECISION_RELAY_FAILED once; closed decisions past
 * DECISION_KEEP_CLOSED_MS are dropped. Nothing is posted
 * to the decisions channel on a schedule: the lead sees open decisions in `dori inbox take`. The owner's answers themselves arrive through inbound (recordOwnerAnswer), and an answered decision left
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
    if (d.state === "closed" && d.relay?.state === "failed" && d.relay.reportedAt === undefined && (d.relay.attempts ?? 1) >= DECISION_RELAY_ATTEMPTS) {
      await deps.enqueue(`decision-relay-failed:${d.id}`, relayFailedLine(d));
      patchOne(stateDir, d.id, (x) => (x.relay ? { ...x, relay: { ...x.relay, reportedAt: now } } : x));
    }
    if (d.state === "closed" && d.archivePending && d.thread && d.goneAt === undefined) {
      try {
        await archiveThread(deps.transport, d.thread);
        patchOne(stateDir, d.id, (x) => { const { archivePending: _, ...rest } = x; return rest; });
      } catch (e) {
        if (isGone(e)) {
          await deps.enqueue(`owner-decision-gone:${d.id}`, `OWNER_DECISION_THREAD_GONE ${d.id} thread ${d.thread} no longer exists (archive retry): nothing to do unless the decision should be asked again`);
          patchOne(stateDir, d.id, (x) => ({ ...x, goneAt: now }));
        } else log(`OWNER_DECISION_ARCHIVE_FAILED ${d.id} ${errLine(e)}`);
      }
    }
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
  ctx: DecisionContext, lane: TargetLane & { readonly thread: string }, report: { readonly id: string; readonly text: string },
): Promise<OpenResult | undefined> => {
  const request = parseRequestText(report.text);
  const choices = request ? requestSpec(request) : parseDecisionText(report.text);
  if (!choices) return undefined;
  const task = lane.task ?? taskOfLane(lane.key);
  return openOwnerDecision(ctx, {
    ...choices, source: "lane", sourceRef: report.id, lane: lane.key, ...(request ? {} : { target: decisionTargetOf(lane) }),
    ...(task !== undefined ? { task } : {}), ...(lane.thread !== "none" && refIds(lane.thread) ? { origin: lane.thread } : {}),
  });
};
