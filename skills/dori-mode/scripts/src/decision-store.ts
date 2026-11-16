import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runnerOf } from "./lane-ops.ts";
import { type DecisionChoices } from "./runner/decision-text.ts";
import { withStateLockSync } from "./state-lock.ts";
import { saveJsonFile } from "./store.ts";

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

export type OwnerDecisionState = "posting" | "open" | "answered" | "closed";

/**
 * An owner answer the lead holds: a message in the decision's thread or channel, or an answer-button click the lane could
 * not take directly (`message` `click:<interaction id>`, `choice` the button's option), which is no Discord message.
 */
export type OwnerAnswer = { readonly channel: string; readonly message: string; readonly at: number; readonly choice?: number };

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
  /** A lane decision's target when it opened: a direct answer goes to this lane session only (references/messaging.md). */
  readonly target?: DecisionTarget;
  /** Direct answer revisions, oldest first (`rev` 1, 2, ...), each with its delivery intent. */
  readonly revisions?: readonly AnswerRevision[];
  /**
   * The open blocking decision of the same lane or task whose thread this one was posted into instead of a thread of its
   * own (openOwnerDecision). A thread shared that way is archived only when its last decision closes.
   */
  readonly attachedTo?: string;
  /** The `[System]` status message of the direct answer in the decision's thread, edited in place (decisionDeliveryTick). */
  readonly notice?: { readonly message: string; readonly text: string };
  /**
   * What the starter message's answer buttons last showed (messenger/decision-buttons.ts decisionButtonsKey); unset while
   * they still show what was posted. syncDecisionButtons edits them when the decision moves on.
   */
  readonly buttons?: string;
  /** What `dori decision close` did with its text for the lane (decision-relay.ts); set once, when it closes. */
  readonly relay?: DecisionRelay;
};

/**
 * The close text's way to a lane decision's lane: `relayed` (typed into its pane, lane message `message`), `failed`
 * (not typed; the supervisor tick raises urgent DECISION_RELAY_FAILED once, then sets `reportedAt`), or `skipped` (the
 * owner's answer already reached the lane directly, or the lane is closed).
 */
export type DecisionRelay = {
  readonly state: "relayed" | "failed" | "skipped";
  readonly lane: string;
  readonly at: number;
  readonly message?: string;
  readonly reason?: string;
  readonly reportedAt?: number;
};

/**
 * The lane session a lane decision belongs to: lane key, owning runner, session generation (lane-reports.ts
 * laneGeneration: the last recovery, 0 before any) and the registry's openedAt (a lane closed and opened again under the
 * same key is a new lane). Another value of any of them is another target.
 */
export type DecisionTarget = { readonly lane: string; readonly runner: string; readonly generation: number; readonly openedAt?: string };

/**
 * Where a revision's lane message stands, as decisions.json records it: `intended` (recorded, the lane message may not
 * be queued yet), `queued` (the lane message `decision-d<ID>-r<n>` exists), `acked` (the lane confirmed it), `superseded`
 * (a newer revision or a close replaced it), `cancelled` (a withdrawal before anything reached the lane: nothing to send),
 * `undelivered` (its lane session is gone or its queue entry was lost; the lead takes the answer over).
 */
export type DeliveryState = "intended" | "queued" | "acked" | "superseded" | "cancelled" | "undelivered";

export type AnswerDelivery = { readonly id: string; readonly state: DeliveryState; readonly updatedAt: number; readonly reason?: string };

export type AnswerRevision = {
  readonly rev: number;
  /** The owner message (`channel`/`message`) and its edit revision (0 for the message as first posted). */
  readonly channel: string;
  readonly message: string;
  readonly edit: number;
  /** answerContentHash of the message text. */
  readonly hash: string;
  /** The chosen option; absent when this revision withdraws the answer (an edit out of the answer form, or a delete). */
  readonly choice?: number;
  readonly target: DecisionTarget;
  readonly at: number;
  readonly delivery: AnswerDelivery;
};

export type DecisionsFile = {
  readonly nextSeq: number;
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
  // Retired credential requests must not resume or block ordinary owner decisions.
  return { nextSeq: value.nextSeq, decisions: value.decisions.filter((d) => !("secretRequest" in d) && !d.sourceRef?.startsWith("secret:")) };
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

export const patchOne = (stateDir: string, id: string, patch: (d: OwnerDecision) => OwnerDecision | undefined): OwnerDecision | undefined =>
  updateDecisions(stateDir, (file) => {
    const found = file.decisions.find((d) => d.id === id);
    const next = found ? patch(found) : undefined;
    if (!found || !next) return { result: found };
    return { file: { ...file, decisions: file.decisions.map((d) => (d.id === id ? next : d)) }, result: next };
  });

export const removeOne = (stateDir: string, id: string): void => {
  updateDecisions(stateDir, (file) => ({ file: { ...file, decisions: file.decisions.filter((d) => d.id !== id) }, result: undefined }));
};

/** The lane fields a decision target is read from (a registry Lane fits). */
export type TargetLane = {
  readonly key: string;
  /** The Toodo task the lane was launched for (registry Lane.task); else read from an autopilot key (taskOfLane). */
  readonly task?: number;
  readonly runner?: string;
  readonly machine?: string;
  readonly lastRecoveryAt?: number;
  readonly openedAt?: string;
};

/** The lane's target as it is now; generation is lane-reports.ts laneGeneration (not imported: that module imports this one). */
export const decisionTargetOf = (lane: TargetLane): DecisionTarget => ({
  lane: lane.key, runner: runnerOf(lane), generation: lane.lastRecoveryAt ?? 0, ...(lane.openedAt ? { openedAt: lane.openedAt } : {}),
});

export const sameTarget = (a: DecisionTarget, b: DecisionTarget): boolean =>
  a.lane === b.lane && a.runner === b.runner && a.generation === b.generation && (a.openedAt === undefined || b.openedAt === undefined || a.openedAt === b.openedAt);
