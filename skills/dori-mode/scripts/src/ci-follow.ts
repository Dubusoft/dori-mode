import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import { githubTargets, type OpenPull, sameRepoHead } from "./github-events.ts";
import { diskGuardPath, sampleHost } from "./host-guard.ts";
import { launchLane } from "./launch.ts";
import {
  type LaneMessage, type LaneMessageStore, OPEN_MESSAGE_STATES, openLaneMessages, queueLaneMessage, updateLaneMessage,
} from "./lane-messages.ts";
import {
  FINAL_STATES, type Observed, type Operation, operationId, type OperationSpec, type OperationStore, openOperations, perform, plan, type ReadBack, reconcile, settleOperation,
} from "./operations.ts";
import { agentRefusal } from "./pane-state.ts";
import type { Pane } from "./panes.ts";
import { LANE_KEY, type Lane, statusOf } from "./registry.ts";
import { canLaunch } from "./routing.ts";
import { parseSignal, splitDone } from "./signals.ts";

/**
 * CI follow-up for lane PRs (design 4.5, item 1.4). After each GitHub poll, for every open PR that
 * belongs to an open lane (its Done signal names the PR, or a lane worktree has the PR's branch):
 * - checks failing at the head SHA: a lane message with an ID, delivered safely (deliverLaneMessages);
 * - checks green and mergeable into `ciMergeBase`: the supervisor merges it (`--match-head-commit`, never `--admin`,
 *   never into main) and reads the merge SHA back;
 * - conflicting: while the PR's own lane is live (laneDown) it gets one lane message asking it to rebase, and no merge
 *   lane starts; once that lane is closed, paused or dead, a new merge lane (its own detached worktree) resolves, waits
 *   for green and merges; when none can be launched, the lead hears CI_CONFLICT.
 * - a lane bound to a GitHub issue (Lane.ghIssue): once its PR is confirmed merged into `ciMergeBase`, the issue is
 *   closed with a comment (a `close-issue` operation planned while the PR is open, so a closed lane still settles it).
 * - a merged PR of an open lane that the supervisor did not merge itself: its merge is read back once (a `merge-verify`
 *   operation) as digest MERGE_VERIFIED with the merge SHA, or urgent MERGE_UNVERIFIED when it cannot be confirmed.
 *   The watcher then closes a done-claimed lane at once (done-flow.ts mergeConfirmed), with its worktree and branch.
 * - an open lane PR the supervisor cannot merge for a reason only a person fixes (claimed at its head but no checks, a
 *   required review, a draft; or green and clean while its lane never claimed at that head) for `mergeStallMin`: urgent
 *   MERGE_STALLED once per head. Pending CI is no stall: the claim's own merge wait (done-flow.ts mergeWait) bounds it.
 * Each merge and launch is an operation (operations.ts), keyed by PR and head SHA, so a restart never repeats it. The
 * lanes keep waiting on their own CI; nothing here replaces that wait.
 */

export type CiEmit = (id: string, line: string) => void;

export type MergeLaneRequest = {
  readonly key: string;
  readonly source: Lane;
  readonly pull: OpenPull;
  readonly base: string;
};

export type CiIo = {
  /** Starts a merge lane for `request`; `ok` false with the reason when it cannot (HOLD, no worktree, launch error). */
  readonly launch: (deps: FlowDeps, request: MergeLaneRequest) => Promise<{ readonly ok: boolean; readonly detail: string }>;
};

/** A merge GitHub refused this many times stops retrying and goes to the lead as OPERATION_FAILED. */
export const MERGE_ATTEMPTS = 3;

const short = (sha: string): string => sha.slice(0, 7);
const repoName = (repo: string): string => (repo.split("/")[1] ?? repo).toLowerCase().replace(/[^a-z0-9.-]/g, "-");
const subjectOf = (pull: OpenPull): string => `${pull.repo}#${pull.number}@${pull.sha}`;
/** Queues the message; one superseded earlier whose reason is back at the same head is queued again, with a fresh deadline. */
const requeueLaneMessage = (store: LaneMessageStore, now: number, message: Pick<LaneMessage, "id" | "lane" | "subject" | "text">): LaneMessage => {
  const stored = queueLaneMessage(store, now, message);
  return stored.state === "superseded" ? updateLaneMessage(store, stored, { state: "queued", at: now, blocked: undefined, escalatedAt: undefined }, now) : stored;
};

export const ciMessageId = (pull: OpenPull): string => `ci-${repoName(pull.repo)}-${pull.number}-${short(pull.sha)}`;

/** The merge lane's key: `merge-<repo>-<n>`, shortened to fit LANE_KEY. */
export const mergeLaneKey = (pull: Pick<OpenPull, "repo" | "number">): string => {
  const tail = `-${pull.number}`;
  return `merge-${repoName(pull.repo).slice(0, 60 - 6 - tail.length)}${tail}`;
};

export const rebaseMessageId = (pull: OpenPull): string => `rebase-${repoName(pull.repo)}-${pull.number}-${short(pull.sha)}`;

export const rebaseText = (pull: OpenPull, base: string, id: string): string =>
  `[LEAD] ${pull.repo}#${pull.number} conflicts with ${base} at ${short(pull.sha)} (${pull.url}). Your lane is live, so no merge lane is started: rebase your branch onto origin/${base} yourself, resolve every conflict keeping the intent of both sides, run the tests, push (--force-with-lease, your own branch only) and keep your own CI wait. Confirm you got this message: dori report ack ${id}`;

/** A merged PR from the last poll (GitHubEvents.mergedPulls), for closing the issue its lane was bound to. */
export type MergedPull = Pick<OpenPull, "repo" | "number" | "url" | "headRepo"> & { readonly branch?: string };

export const MERGE_VERIFY = "merge-verify";

/** `owner/repo#N` (a lane's ghIssue, a close-issue target): repo and number, or undefined when it is not one. */
export const parseIssueRef = (ref: string): { readonly repo: string; readonly number: number } | undefined => {
  const m = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(ref.trim());
  return m?.[1] && m[2] ? { repo: m[1], number: Number(m[2]) } : undefined;
};

export const ciFailingText = (pull: OpenPull, id: string): string =>
  `[LEAD] CI is failing on ${pull.repo}#${pull.number} at ${short(pull.sha)} (${pull.url}). Keep your own CI wait: read the failing check, fix it, push and wait for green again. Confirm you got this message: dori report ack ${id}`;

/** Why a pane may not receive an autonomous message now; undefined when it may (exists, runs an agent, idle). */
export const paneRefusal = (lane: Lane, panes: readonly Pane[] | Error): string | undefined => {
  if (statusOf(lane) === "paused") return "lane paused";
  if (!lane.pane) return "lane has no pane";
  if (panes instanceof Error) return `pane list unreadable: ${panes.message.slice(0, 120)}`;
  const pane = panes.find((p) => p.pane_id === lane.pane);
  const noAgent = agentRefusal(panes, lane.pane);
  if (noAgent || !pane) return noAgent;
  if (pane.agent_status !== "idle" && pane.agent_status !== "done") return `pane ${lane.pane} busy (${pane.agent_status ?? "unknown"})`;
  return undefined;
};

/**
 * Why the lane cannot rebase its own PR now (closed, paused, no pane, pane missing, no agent in it); undefined while it
 * is live, busy or idle. An unreadable pane list counts as live: the rebase message waits, and reaches the lead as
 * LANE_MESSAGE_UNCONFIRMED if it is never confirmed, rather than a second agent being started on the same PR.
 */
export const laneDown = (lane: Lane, panes: readonly Pane[] | Error): string | undefined => {
  const status = statusOf(lane);
  if (status === "closed" || status === "paused") return `lane ${status}`;
  if (!lane.pane) return "lane has no pane";
  if (panes instanceof Error) return undefined;
  const pane = panes.find((p) => p.pane_id === lane.pane);
  if (!pane) return `pane ${lane.pane} missing`;
  if (!pane.agent) return `pane ${lane.pane} runs no agent`;
  return undefined;
};

/**
 * A delivery attempt of the same message this recent, still `attempted`, is taken to be running in another process (the
 * CLI's first attempt, the supervisor's pass): left alone, not reconciled to ambiguous under it. One older than this was
 * interrupted, and its read-back decides as for any crash.
 */
export const ATTEMPT_IN_FLIGHT_MS = 2 * 60_000;

const panesReader = (deps: FlowDeps): ((lane: Lane) => Promise<Pane[] | Error>) => {
  const panes = new Map<string, Promise<Pane[] | Error>>();
  return (lane) => {
    const machine = lane.machine ?? "";
    let hit = panes.get(machine);
    if (!hit) {
      hit = deps.ops.panes(lane.machine).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
      panes.set(machine, hit);
    }
    return hit;
  };
};

/**
 * Queues a lead steering message to `lane` (`whileWorking`) with its intent `id` and the line the lane confirms it with
 * (`<dori> report ack <id>`), superseding any open message of the same lane and `subject` it replaces (a newer claim
 * notice or objection). Returns the stored message; a known id is the same intent and stays as it is.
 */
export const queueSteering = (
  store: LaneMessageStore, now: number, lane: Pick<Lane, "key" | "machine">, message: Pick<LaneMessage, "id" | "subject" | "text">,
): LaneMessage => {
  const dori = lane.machine ? "~/.dori/runner/bin/dori" : "dori";
  const queued = queueLaneMessage(store, now, {
    id: message.id, lane: lane.key, subject: message.subject, whileWorking: true,
    text: `${message.text.replace(/\.$/, "")}. Confirm you got this message: ${dori} report ack ${message.id}`,
  });
  for (const old of store.list({ lane: lane.key, states: OPEN_MESSAGE_STATES })) {
    if (old.subject === message.subject && old.id !== queued.id) updateLaneMessage(store, old, { state: "superseded", blocked: `replaced by ${queued.id}` }, now);
  }
  return queued;
};

/** One delivery attempt of a queued message now (its sender's first try); a refusal leaves it queued for deliverLaneMessages. */
export const deliverLaneMessage = async (deps: FlowDeps, ops: OperationStore, messages: LaneMessageStore, lane: Lane, message: LaneMessage): Promise<LaneMessage> =>
  message.state === "queued" ? deliver(deps, ops, messages, lane, message, panesReader(deps)) : message;

/**
 * Why a lead steering message waits without being sent: the lane is paused or has no pane. Anything about the pane
 * itself (no live agent, other text in its input line, no prompt) is the runner's to decide when it is sent.
 */
const steeringRefusal = (lane: Lane): string | undefined =>
  statusOf(lane) === "paused" ? "lane paused" : lane.pane ? undefined : "lane has no pane";

/**
 * Delivers queued lane messages and tells the lead about unconfirmed ones. A message is typed (send-text, then one
 * Enter) only when paneRefusal allows it, as its own operation: an interrupted delivery is never retyped. Anything
 * still queued, or delivered without an ack, `ciConfirmMin` after it was queued is one LANE_MESSAGE_UNCONFIRMED, naming
 * the message and why it was not delivered (the pane's state and the runner's refusal); the message stays queued.
 */
export const deliverLaneMessages = async (deps: FlowDeps, ops: OperationStore, messages: LaneMessageStore, emit: CiEmit): Promise<void> => {
  const panesOf = panesReader(deps);
  for (let message of messages.list({ states: OPEN_MESSAGE_STATES })) {
    const lane = await deps.registry.read(message.lane);
    if (!lane || statusOf(lane) === "closed") {
      updateLaneMessage(messages, message, { state: "superseded", blocked: "lane closed" }, deps.clock.now());
      continue;
    }
    if (message.state === "queued") message = await deliver(deps, ops, messages, lane, message, panesOf);
    if (message.state === "acked" || message.escalatedAt !== undefined) continue;
    if (deps.clock.now() - message.at < deps.config.ciConfirmMin * 60_000) continue;
    const why = message.state === "delivered" ? "delivered but not confirmed" : `not delivered: ${message.blocked ?? "waiting"}`;
    // Journaled before escalatedAt is saved: a crash in between re-emits the same id, which the journal dedupes.
    emit(`lane-message-unconfirmed:${message.id}`, `LANE_MESSAGE_UNCONFIRMED ${message.lane} ${message.id} ${why} after ${deps.config.ciConfirmMin} min; about ${message.subject}`);
    updateLaneMessage(messages, message, { escalatedAt: deps.clock.now() }, deps.clock.now());
  }
};

const deliver = async (
  deps: FlowDeps, ops: OperationStore, messages: LaneMessageStore, lane: Lane, message: LaneMessage, panesOf: (lane: Lane) => Promise<Pane[] | Error>,
): Promise<LaneMessage> => {
  const now = deps.clock.now();
  const refusal = message.whileWorking ? steeringRefusal(lane) : paneRefusal(lane, await panesOf(lane));
  if (refusal) return refusal === message.blocked ? message : updateLaneMessage(messages, message, { blocked: refusal }, now);
  const spec: OperationSpec = { lane: lane.key, action: "lane-message", target: message.id };
  const inFlight = ops.get(operationId(spec));
  if (inFlight?.state === "attempted" && now - inFlight.updatedAt < ATTEMPT_IN_FLIGHT_MS) return message;
  // The runner's send refuses while the lane's input box holds the owner's text and presses Enter at most once; its
  // verdict is the only evidence of this attempt. A failed send typed nothing (not done), delivered or unconfirmed is
  // done. An interrupted attempt (a new process, no verdict seen) stays unknown, so it is ambiguous and never retyped.
  // The lane's ack proves the text arrived and wins over everything.
  let typedHere: Observed = "unknown";
  const readBack: ReadBack = async () => (messages.get(message.id)?.state === "acked" ? "done" : typedHere);
  let refused: string | undefined;
  const { op } = await perform(ops, deps.clock.now, spec, async () => {
    // The runner answers a repeated cmdId with its first result, so each attempt has its own id (done-flow.ts act):
    // a retry after a definitive failure reaches the effect again, while a replay of one attempt keeps its id.
    const id = operationId(spec);
    const delivery = await deps.ops.send(lane, message.text, {
      mode: "verified", inputCheck: true, cmdId: `op:${id}:${ops.get(id)?.attempts ?? 0}`, onFailed: (detail) => { refused = detail; },
    });
    if (delivery === "failed") {
      typedHere = "not-done";
      return { ok: false, detail: refused ?? "the runner could not deliver the text (input line busy, refused, or runner unavailable)" };
    }
    typedHere = "done";
    return { ok: true, detail: delivery === "unconfirmed" ? "typed, not confirmed in the pane" : "" };
  }, readBack);
  const current = messages.get(message.id) ?? message;
  if (current.state === "acked") return current;
  if (op.state === "verified") return updateLaneMessage(messages, current, { state: "delivered", deliveredAt: deps.clock.now(), blocked: undefined }, deps.clock.now());
  const panes = await panesOf(lane);
  const status = panes instanceof Error ? "status unreadable" : (panes.find((p) => p.pane_id === lane.pane)?.agent_status ?? "not listed");
  const where = `pane ${lane.pane ?? "-"} ${status}`;
  const blocked = op.state === "ambiguous"
    ? "an interrupted delivery may or may not have been typed; not retyped"
    : `send failed (${where}): ${(refused ?? op.detail).replace(/\s+/g, " ").slice(0, 240)}`;
  return updateLaneMessage(messages, current, { blocked }, deps.clock.now());
};

type PrView = {
  readonly state?: string;
  readonly baseRefName?: string;
  readonly headRefOid?: string;
  readonly isDraft?: boolean;
  readonly mergeable?: string;
  readonly mergeStateStatus?: string;
  readonly statusCheckRollup?: readonly { readonly __typename?: string; readonly status?: string; readonly conclusion?: string; readonly state?: string }[];
  readonly mergeCommit?: { readonly oid?: string } | null;
  readonly isCrossRepository?: boolean;
};

const PR_FIELDS = "state,baseRefName,headRefOid,isCrossRepository,isDraft,mergeable,mergeStateStatus,statusCheckRollup,mergeCommit";

const viewPull = async (deps: FlowDeps, pull: Pick<OpenPull, "repo" | "number">, fields = PR_FIELDS): Promise<PrView> => {
  const r = await deps.run(["gh", "pr", "view", String(pull.number), "-R", pull.repo, "--json", fields], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`gh pr view ${pull.repo}#${pull.number} exit ${r.code}: ${(r.err || r.out).trim().slice(0, 160)}`);
  return JSON.parse(r.out) as PrView;
};

const CHECK_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** mergeGate `wait` reasons that no further CI run clears at the same head: a person has to act. */
const stuckWait = (why: string): boolean => why === "no checks" || why === "draft" || why === "every check skipped or neutral" || why.startsWith("mergeable ");

/**
 * Whether a lane that has not claimed this PR at its head is stuck on its merge rather than still working: a lane told
 * not done, or claimed at another head, waits for a merge that will not come; a working lane only when its Done names
 * this PR as merged (it may be waiting for that merge instead of claiming). A paused lane is left alone.
 */
const waitsOnMerge = (lane: Lane, pull: Pick<OpenPull, "repo" | "number">): boolean => {
  const status = statusOf(lane);
  if (status === "paused") return false;
  if (status !== "working") return true;
  return splitDone(lane.done).some((part) => {
    try {
      const s = parseSignal(part);
      return s.kind === "merged" && s.repo.toLowerCase() === pull.repo.toLowerCase() && s.n === String(pull.number);
    } catch { return false; }
  });
};

/**
 * What a fresh read of the PR allows: `merge` only when it is open, into `base` (never main), still at `sha`, from a
 * branch of its own repo (never a fork), not a draft, every check finished green and GitHub calls it MERGEABLE and CLEAN; `conflict` when GitHub reports a
 * conflict; `wait` (with why) otherwise. Green needs at least one check that passed: a rollup of only SKIPPED or NEUTRAL
 * checks is treated like no checks at all.
 */
export const mergeGate = (view: PrView, sha: string, base: string): { readonly verdict: "merge" | "conflict" | "wait"; readonly why: string } => {
  if (view.state !== "OPEN") return { verdict: "wait", why: `state ${view.state ?? "unknown"}` };
  if (view.baseRefName === "main" || view.baseRefName !== base) return { verdict: "wait", why: `base ${view.baseRefName ?? "unknown"} is not ${base}` };
  if (view.headRefOid !== sha) return { verdict: "wait", why: `head moved to ${short(view.headRefOid ?? "unknown")}` };
  if (view.isCrossRepository !== false) return { verdict: "wait", why: "head is not a branch of this repo" };
  if (view.isDraft) return { verdict: "wait", why: "draft" };
  if (view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY") return { verdict: "conflict", why: `mergeable ${view.mergeable} state ${view.mergeStateStatus}` };
  const checks = view.statusCheckRollup ?? [];
  if (!checks.length) return { verdict: "wait", why: "no checks" };
  const red = checks.filter((c) => c.__typename === "StatusContext" ? c.state !== "SUCCESS" : c.status !== "COMPLETED" || !CHECK_OK.has(c.conclusion ?? ""));
  if (red.length) return { verdict: "wait", why: `${red.length} check(s) not green` };
  if (!checks.some((c) => c.__typename === "StatusContext" || c.conclusion === "SUCCESS")) return { verdict: "wait", why: "every check skipped or neutral" };
  if (view.mergeable !== "MERGEABLE" || view.mergeStateStatus !== "CLEAN") return { verdict: "wait", why: `mergeable ${view.mergeable} state ${view.mergeStateStatus}` };
  return { verdict: "merge", why: "green and clean" };
};

/**
 * Whether the lane has claimed done for exactly this PR at exactly this head: its done claim (`dori claim-done` or a
 * remote `done` report) recorded the PR's number and head SHA (done-flow.ts claimBindings). A lane that never claimed,
 * pushed after its claim, or claimed before this binding was recorded is not merged; commit dates are never trusted.
 */
export const claimGate = (lane: Lane, pull: Pick<OpenPull, "repo" | "number" | "sha">): { readonly ok: boolean; readonly why: string } => {
  const status = statusOf(lane);
  if (status !== "done-claimed" && status !== "verified-done") return { ok: false, why: `lane is ${status}, no done claim` };
  const bound = (lane.claim?.pulls ?? []).find((p) => p.repo.toLowerCase() === pull.repo.toLowerCase() && p.number === pull.number);
  if (!bound) return { ok: false, why: `the done claim recorded no head for ${pull.repo}#${pull.number}` };
  return bound.sha === pull.sha ? { ok: true, why: "claimed at this head" } : { ok: false, why: `head ${short(pull.sha)} is not the claimed ${short(bound.sha)}` };
};

const observedMerge = (view: PrView): Observed => (view.state === "MERGED" ? "done" : view.state === "OPEN" || view.state === "CLOSED" ? "not-done" : "unknown");

/** Follows every open lane PR once per poll; one instance per supervisor (it remembers PRs that wait for a permanent reason). */
export class CiFollowUp {
  readonly ops: OperationStore;
  readonly messages: LaneMessageStore;
  /** Targets a fresh read refused for a reason no later poll changes at the same SHA (wrong base): not re-read. */
  private readonly settled = new Set<string>();
  /** Subjects of this poll's conflicting PRs whose live lane was asked to rebase; any other rebase message is stale. */
  private rebasing = new Set<string>();
  /** Subjects (PR at a head) this process saw stalled, with when it first saw it; dropped once a poll finds it moving. */
  private readonly stalls = new Map<string, { readonly since: number; alerted: boolean }>();
  private stalledNow = new Set<string>();
  /** The delivery pass in progress: the GitHub poll's and the supervisor's own pass never run at once. */
  private delivering: Promise<void> = Promise.resolve();

  constructor(private readonly deps: FlowDeps, private readonly io: CiIo = defaultCiIo, stores?: { readonly ops: OperationStore; readonly messages: LaneMessageStore }) {
    this.ops = stores?.ops ?? deps.operations ?? openOperations(deps.config);
    this.messages = stores?.messages ?? openLaneMessages(deps.config);
  }

  close(): void {
    if (!this.deps.operations) this.ops.close();
    this.messages.close();
  }

  async tick(pulls: readonly OpenPull[], emit: CiEmit, merged: readonly MergedPull[] = []): Promise<void> {
    await this.follow(pulls, emit);
    await this.closeIssues(merged, emit);
    await this.verifyMerges(merged, emit);
    await this.deliver(emit);
  }

  /** Delivers the queued lane messages (CI, rebase and lead steering) once, after any pass still running. */
  deliver(emit: CiEmit): Promise<void> {
    const pass = this.delivering.then(() => deliverLaneMessages(this.deps, this.ops, this.messages, emit));
    this.delivering = pass.catch(() => {});
    return pass;
  }

  /**
   * The open lane of each same-repo PR (`repo#n`, repo lowercased): its Done signal names it, or a lane worktree has its
   * branch. A fork PR (sameRepoHead false) has no lane, so it gets no CI message, merge, merge lane or issue close.
   */
  private async owners(pulls: readonly (Pick<OpenPull, "repo" | "number" | "headRepo"> & { readonly branch?: string })[], unresolved?: Set<string>): Promise<Map<string, Lane>> {
    const owner = new Map<string, Lane>();
    if (!pulls.length) return owner;
    // Oldest lane first: the lane that opened the PR keeps its operations even after a merge lane joins it.
    const lanes = (await this.deps.registry.open()).filter((l) => statusOf(l) !== "closed").sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.key.localeCompare(b.key));
    for (const lane of lanes) {
      for (const [repo, targets] of await githubTargets([lane], this.deps.ops, unresolved)) {
        for (const pull of pulls) {
          if (pull.repo.toLowerCase() !== repo || !sameRepoHead(pull) || !(targets.numbers.has(pull.number) || (pull.branch !== undefined && targets.branches.has(pull.branch)))) continue;
          const key = `${repo}#${pull.number}`;
          if (!owner.has(key)) owner.set(key, lane);
        }
      }
    }
    return owner;
  }

  private async follow(pulls: readonly OpenPull[], emit: CiEmit): Promise<void> {
    const deps = this.deps;
    // Lanes whose runner could not answer this poll: their PRs may be missing from `owner`, so their messages stay open.
    const unresolved = new Set<string>();
    const owner = await this.owners(pulls, unresolved);
    const failing = new Set<string>();
    this.rebasing = new Set();
    this.stalledNow = new Set();
    for (const pull of pulls) {
      const lane = owner.get(`${pull.repo.toLowerCase()}#${pull.number}`);
      if (!lane) continue;
      try {
        // Planned while the PR is open, so the issue is still closed when the lane closes before the merge.
        const issue = lane.ghIssue ? parseIssueRef(lane.ghIssue) : undefined;
        if (issue) plan(this.ops, deps.clock.now(), { lane: lane.key, action: "close-issue", target: `${issue.repo}#${issue.number}@${pull.repo}#${pull.number}` });
        if (pull.checks === "failing") {
          failing.add(subjectOf(pull));
          requeueLaneMessage(this.messages, deps.clock.now(), { id: ciMessageId(pull), lane: lane.key, subject: subjectOf(pull), text: ciFailingText(pull, ciMessageId(pull)) });
        }
        if (pull.conflicting) await this.conflict(lane, pull, emit);
        else if (pull.checks === "green") await this.merge(lane, pull, emit);
        else if (pull.checks === "none") {
          const fresh = (await deps.registry.read(lane.key)) ?? lane;
          if (claimGate(fresh, pull).ok) this.stall(fresh, pull, "no checks", "the supervisor merges only after a green check: add or run its checks, or merge it by hand", emit);
        }
      } catch (e) {
        console.error(`CI_FOLLOW_ERROR ${pull.repo}#${pull.number} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const subject of this.stalls.keys()) if (!this.stalledNow.has(subject)) this.stalls.delete(subject);
    // A failing message whose PR moved on (new head, checks no longer failing, merged or closed) is no longer true.
    for (const message of this.messages.list({ states: OPEN_MESSAGE_STATES })) {
      // Supersede only on a positive observation: a lane the poll could not resolve proves nothing about its PR.
      if (unresolved.has(message.lane)) continue;
      if (message.id.startsWith("ci-") && !failing.has(message.subject)) updateLaneMessage(this.messages, message, { state: "superseded", blocked: "CI no longer failing at this head" }, deps.clock.now());
      // A rebase request whose PR moved on, stopped conflicting, or went to a merge lane (its lane went down) is stale.
      if (message.id.startsWith("rebase-") && !this.rebasing.has(message.subject)) updateLaneMessage(this.messages, message, { state: "superseded", blocked: "no longer a conflict for this live lane at this head" }, deps.clock.now());
    }
  }

  /**
   * Closes the GitHub issue of every planned `close-issue` operation whose PR the last poll saw merged, once a fresh
   * `gh pr view` confirms it MERGED into `ciMergeBase`: `gh issue close --comment`, read back with `gh issue view`. An
   * issue already closed is verified without a comment; a PR merged elsewhere leaves the row planned.
   */
  private async closeIssues(merged: readonly MergedPull[], emit: CiEmit): Promise<void> {
    const deps = this.deps;
    const base = deps.config.ciMergeBase;
    const mergedBy = new Map(merged.map((p) => [`${p.repo.toLowerCase()}#${p.number}`, p]));
    const rows = this.ops.list({ states: ["planned", "attempted", "failed"] }).filter((op) => op.action === "close-issue");
    for (const row of rows) {
      const [issueRef = "", pullRef = ""] = row.target.split("@");
      const issue = parseIssueRef(issueRef);
      const pull = mergedBy.get(pullRef.toLowerCase());
      if (!issue || !pull || this.settled.has(row.id)) continue;
      try {
        const readBack: ReadBack = async () => {
          const r = await deps.run(["gh", "issue", "view", String(issue.number), "-R", issue.repo, "--json", "state"], { timeoutMs: 20_000 });
          if (r.code !== 0) return "unknown";
          const state = (JSON.parse(r.out) as { state?: string }).state;
          return state === "CLOSED" ? "done" : state === "OPEN" ? "not-done" : "unknown";
        };
        const spec: OperationSpec = { lane: row.lane, action: row.action, target: row.target };
        const op = await this.settle(spec, readBack);
        if (op?.state !== "planned" && op?.state !== "failed") continue;
        if (op.state === "failed" && op.attempts >= MERGE_ATTEMPTS) {
          emit(`ci-issue-failed:${op.id}`, `OPERATION_FAILED ${op.id} issue close refused ${op.attempts} times: ${op.detail}; close ${issueRef} by hand`);
          continue;
        }
        const view = await viewPull(deps, pull, "state,baseRefName,mergeCommit");
        if (view.state !== "MERGED") continue;
        if (view.baseRefName !== base) {
          this.settled.add(row.id);
          continue;
        }
        const sha = view.mergeCommit?.oid ?? "unknown";
        const comment = `Closed by dori: ${pull.repo}#${pull.number} (lane ${row.lane}) is merged into ${base} as ${sha}. ${pull.url}`;
        const done = await perform(this.ops, deps.clock.now, spec, async () => {
          const r = await deps.run(["gh", "issue", "close", String(issue.number), "-R", issue.repo, "--comment", comment], { timeoutMs: 30_000 });
          return { ok: r.code === 0, detail: r.code === 0 ? "" : (r.err || r.out).trim() };
        }, readBack);
        // An issue someone already closed is verified quietly; only a close this pass made is reported.
        if (done.op.state === "verified" && done.ran) emit(`ci-issue-closed:${done.op.id}`, `CI_ISSUE_CLOSED ${issueRef} lane=${row.lane} after ${pull.repo}#${pull.number} merged into ${base} merge=${sha} ${pull.url}`);
      } catch (e) {
        console.error(`CI_FOLLOW_ERROR ${row.id} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Reads back, once, the merge of every merged PR that belongs to an open lane and was not merged by the supervisor (its
   * own merges are read back as CI_MERGED): MERGE_VERIFIED (digest) with the base and merge SHA, or MERGE_UNVERIFIED
   * (urgent) when GitHub does not call it merged or `gh pr view` fails MERGE_ATTEMPTS polls in a row. The line is
   * journaled before the row settles: a crash in between re-emits the same id, which the journal dedupes.
   */
  private async verifyMerges(merged: readonly MergedPull[], emit: CiEmit): Promise<void> {
    const deps = this.deps;
    const owners = await this.owners(merged);
    for (const pull of merged) {
      const ref = `${pull.repo}#${pull.number}`;
      const lane = owners.get(ref.toLowerCase());
      if (!lane) continue;
      const spec: OperationSpec = { lane: lane.key, action: MERGE_VERIFY, target: ref };
      const existing = this.ops.get(operationId(spec));
      if (existing && FINAL_STATES.has(existing.state)) continue;
      const prefix = `${ref.toLowerCase()}@`;
      if (this.ops.list({ lane: lane.key }).some((op) => op.action === "merge" && op.state === "verified" && op.target.toLowerCase().startsWith(prefix))) continue;
      const op = plan(this.ops, deps.clock.now(), spec);
      let view: PrView;
      try { view = await viewPull(deps, pull, "state,baseRefName,mergeCommit"); } catch (e) {
        const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
        const attempts = op.attempts + 1;
        if (attempts < MERGE_ATTEMPTS) {
          this.ops.put({ ...op, attempts, detail: why, updatedAt: deps.clock.now() });
          continue;
        }
        emit(`merge-unverified:${ref}`, `MERGE_UNVERIFIED ${ref} lane=${lane.key} merge could not be read back after ${attempts} tries: ${why} ${pull.url}`);
        settleOperation(this.ops, deps.clock.now(), op.id, "failed", why);
        continue;
      }
      const sha = view.mergeCommit?.oid;
      if (view.state === "MERGED" && sha) {
        emit(`merge-verified:${ref}`, `MERGE_VERIFIED ${ref} into ${view.baseRefName ?? "unknown"} lane=${lane.key} merge=${sha} ${pull.url}`);
        settleOperation(this.ops, deps.clock.now(), op.id, "verified", `merge ${sha}`);
      } else {
        const why = `GitHub reads it ${view.state ?? "unknown"}${sha ? "" : " with no merge commit"}`;
        emit(`merge-unverified:${ref}`, `MERGE_UNVERIFIED ${ref} lane=${lane.key} ${why} ${pull.url}`);
        settleOperation(this.ops, deps.clock.now(), op.id, "failed", why);
      }
    }
  }

  /** Reconciles a row a crash left attempted; returns the row as it now stands (undefined when there is none). */
  private async settle(spec: OperationSpec, readBack: ReadBack): Promise<Operation | undefined> {
    const existing = this.ops.get(operationId(spec));
    return existing?.state === "attempted" ? reconcile(this.ops, this.deps.clock.now, existing, readBack) : existing;
  }

  private async merge(lane: Lane, pull: OpenPull, emit: CiEmit): Promise<void> {
    const deps = this.deps;
    const base = deps.config.ciMergeBase;
    const target = subjectOf(pull);
    if (this.settled.has(target)) return;
    const spec: OperationSpec = { lane: lane.key, action: "merge", target };
    let merged: PrView | undefined;
    const readBack: ReadBack = async () => {
      const view = await viewPull(deps, pull, "state,mergeCommit,headRefOid");
      if (view.state === "MERGED") merged = view;
      return observedMerge(view);
    };
    let op = await this.settle(spec, readBack);
    if (op?.state === "ambiguous") return;
    if (op?.state === "failed" && op.attempts >= MERGE_ATTEMPTS) {
      emit(`ci-merge-failed:${op.id}`, `OPERATION_FAILED ${op.id} merge refused ${op.attempts} times: ${op.detail}; merge ${pull.url} by hand or fix it`);
      return;
    }
    if (op?.state !== "verified") {
      const view = await viewPull(deps, pull);
      const gate = mergeGate(view, pull.sha, base);
      if (gate.verdict === "conflict") return this.conflict(lane, pull, emit);
      // Merged only once the lane says it is done with this head; read fresh so a claim made since the poll counts.
      const fresh = (await deps.registry.read(lane.key)) ?? lane;
      const claim = claimGate(fresh, pull);
      if (gate.verdict === "wait") {
        if (gate.why.startsWith("base ")) this.settled.add(target);
        else if (claim.ok && stuckWait(gate.why)) this.stall(fresh, pull, gate.why, "claimed at this head, but the supervisor cannot merge it as it stands: fix its checks, review or draft state, or merge it by hand", emit);
        return;
      }
      if (!claim.ok) {
        if (waitsOnMerge(fresh, pull)) this.stall(fresh, pull, claim.why, "green and clean, but the supervisor merges only a lane that claimed done at this head: have the lane claim again, or merge it by hand", emit);
        return;
      }
      // pull.sha is the head the claim recorded (claimGate) and the fresh read saw (mergeGate): GitHub merges no other.
      ({ op } = await perform(this.ops, deps.clock.now, spec, async () => {
        const r = await deps.run(["gh", "pr", "merge", String(pull.number), "-R", pull.repo, "--merge", "--match-head-commit", pull.sha], { timeoutMs: 60_000 });
        return { ok: r.code === 0, detail: r.code === 0 ? "" : (r.err || r.out).trim() };
      }, readBack));
      if (op.state !== "verified") return;
    }
    const sha = merged?.mergeCommit?.oid ?? (await viewPull(deps, pull, "state,mergeCommit").catch(() => undefined))?.mergeCommit?.oid ?? "unknown";
    emit(`ci-merged:${target}`, `CI_MERGED ${pull.repo}#${pull.number} into ${base} lane=${lane.key} head=${short(pull.sha)} merge=${sha} ${pull.url}`);
  }

  /**
   * Records this poll's stall of `pull`; once it has lasted `mergeStallMin` the lead hears MERGE_STALLED, once per PR head
   * in this process (the journal dedupes the same id after a restart).
   */
  private stall(lane: Lane, pull: OpenPull, why: string, hint: string, emit: CiEmit): void {
    const subject = subjectOf(pull);
    this.stalledNow.add(subject);
    const now = this.deps.clock.now();
    const seen = this.stalls.get(subject) ?? { since: now, alerted: false };
    this.stalls.set(subject, seen);
    const min = this.deps.config.mergeStallMin;
    if (seen.alerted || now - seen.since < min * 60_000) return;
    seen.alerted = true;
    emit(`merge-stalled:${subject}`, `MERGE_STALLED ${pull.repo}#${pull.number} lane=${lane.key} head=${short(pull.sha)} ${why} for ${min}+ min: ${hint} ${pull.url}`);
  }

  private async conflict(lane: Lane, pull: OpenPull, emit: CiEmit): Promise<void> {
    const deps = this.deps;
    const key = mergeLaneKey(pull);
    // The merge lane itself owns its PR's conflicts; the original lane hands off once.
    if (lane.key === key) return;
    const target = subjectOf(pull);
    const spec: OperationSpec = { lane: lane.key, action: "merge-lane", target };
    const readBack: ReadBack = async () => {
      const found = await deps.registry.read(key);
      return found && statusOf(found) !== "closed" ? "done" : "not-done";
    };
    let op = await this.settle(spec, readBack);
    // A failed hand-off was already told to the lead as CI_CONFLICT; it is not retried at this head.
    if (op?.state === "ambiguous" || op?.state === "failed") return;
    let detail = "";
    let down: string | undefined;
    if (op === undefined || op.state === "planned") {
      // The PR's own lane rebases while it is live; a merge lane beside it would resolve the same conflict twice.
      const merging = await deps.registry.read(key);
      if (merging && statusOf(merging) !== "closed") down = "merge lane already open";
      else {
        const fresh = (await deps.registry.read(lane.key)) ?? lane;
        const panes = fresh.pane ? await deps.ops.panes(fresh.machine).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))) : [];
        down = laneDown(fresh, panes);
        if (down === undefined) {
          const id = rebaseMessageId(pull);
          this.rebasing.add(target);
          requeueLaneMessage(this.messages, deps.clock.now(), { id, lane: lane.key, subject: target, text: rebaseText(pull, deps.config.ciMergeBase, id) });
          return;
        }
      }
      ({ op } = await perform(this.ops, deps.clock.now, spec, async () => {
        const r = await this.io.launch(deps, { key, source: lane, pull, base: deps.config.ciMergeBase });
        detail = r.detail;
        return r;
      }, readBack));
    }
    if (op.state === "verified") {
      emit(`ci-merge-lane:${target}`, `CI_MERGE_LANE ${key} resolves the conflict of ${pull.repo}#${pull.number} (lane ${lane.key}${down ? `: ${down}` : ""}, head ${short(pull.sha)}) ${pull.url}`);
      return;
    }
    emit(`ci-conflict:${target}`, `CI_CONFLICT ${pull.repo}#${pull.number} lane=${lane.key} head=${short(pull.sha)} conflicts with ${deps.config.ciMergeBase} and no merge lane could start: ${(detail || op.detail).replace(/\s+/g, " ").slice(0, 200)}; resolve it or launch one ${pull.url}`);
  }
}

/** The merge lane's brief: resolve, push to the PR branch, wait for green itself, merge into the base. */
export const mergeLaneBrief = (request: MergeLaneRequest, worktree: string): string => {
  const { pull, base, source } = request;
  return [
    `Repo ${pull.repo}, PR #${pull.number} (${pull.url}), branch ${pull.branch}, base ${base}.`,
    "",
    "## Task",
    `The supervisor started this merge lane because the PR conflicts with ${base}. Lane ${source.key} owns the change; you only make it mergeable.`,
    `1. Your worktree ${worktree} is a detached checkout of origin/${pull.branch}. Run git fetch origin, merge origin/${base} into it and resolve every conflict, keeping the intent of both sides. Run the repo's tests.`,
    `2. Push to the PR branch: git push origin HEAD:${pull.branch}. Never force-push, never push to ${base} or main.`,
    "3. Wait for CI yourself with your own monitor; fix failures and push again.",
    `4. When every check is green (at least one passed; all skipped or neutral is not green) and the PR is mergeable, merge it: gh pr merge ${pull.number} -R ${pull.repo} --merge --match-head-commit <the head SHA you pushed>. Never --admin, never into main. The supervisor may merge it first; that is fine.`,
    "5. If a conflict needs a product decision, report a question to the lead instead of guessing.",
    "",
    "## Done",
    `PR #${pull.number} merged into ${base}. Then dori claim-done with the merge SHA.`,
    "",
  ].join("\n");
};

/** Launches a merge lane on this host: host guard, a detached worktree of the PR branch, then dori launch. */
export const launchMergeLane = async (deps: FlowDeps, request: MergeLaneRequest): Promise<{ readonly ok: boolean; readonly detail: string }> => {
  const { key, source, pull } = request;
  if (!LANE_KEY.test(key)) return { ok: false, detail: `merge lane key ${key} is not a valid lane key` };
  // The branch name is the PR author's text and reaches git argv: never a fork's, never option-shaped, always a valid ref.
  if (!sameRepoHead(pull)) return { ok: false, detail: `${pull.repo}#${pull.number} has its head in ${pull.headRepo ?? "an unknown repo"}; merge lanes only take same-repo branches` };
  const branch = pull.branch;
  const valid = !branch.startsWith("-") && (await deps.run(["git", "check-ref-format", "--branch", branch])).code === 0;
  if (!valid) return { ok: false, detail: `branch name ${JSON.stringify(branch.slice(0, 80))} of ${pull.repo}#${pull.number} is not a valid branch` };
  if (source.machine) return { ok: false, detail: `lane ${source.key} runs on machine ${source.machine}; merge lanes start on this host only` };
  if (!source.cwd) return { ok: false, detail: `lane ${source.key} has no local checkout to branch from` };
  if (!deps.config.worktreeRoot) return { ok: false, detail: "worktreeRoot is not set" };
  const paneCount = async (): Promise<number> => deps.ops.panes().then((panes) => panes.length, () => -1); // the local runner's panes; -1 when unreadable
  const host = canLaunch(await sampleHost(deps.run, diskGuardPath(deps.config), paneCount), deps.config.guard);
  if (!host.ok) return { ok: false, detail: `HOLD ${host.reasons.join(" | ")}` };
  const worktree = join(deps.config.worktreeRoot, repoName(pull.repo), key);
  if ((await deps.ops.exists(undefined, [worktree]))[0]) return { ok: false, detail: `worktree ${worktree} already exists` };
  const fetched = await deps.ops.git(source, { op: "fetch-branch", root: source.cwd, remote: "origin", branch });
  if (fetched.code !== 0) return { ok: false, detail: `git fetch failed: ${(fetched.err || fetched.out).trim()}` };
  const added = await deps.ops.git(source, { op: "worktree-add", root: source.cwd, path: worktree, ref: `refs/remotes/origin/${branch}` });
  if (added.code !== 0) return { ok: false, detail: `git worktree add failed: ${(added.err || added.out).trim()}` };
  const briefs = join(deps.config.stateDir, "briefs");
  mkdirSync(briefs, { recursive: true });
  const brief = join(briefs, `${key}.md`);
  await Bun.write(brief, mergeLaneBrief(request, worktree));
  const { startup } = await launchLane(deps, {
    key, title: `merge ${pull.repo}#${pull.number} into ${request.base}`, brief, done: `merged ${pull.repo}#${pull.number}`,
    thread: source.thread, cwd: worktree, shareThread: true,
  });
  return { ok: true, detail: startup };
};

export const defaultCiIo: CiIo = { launch: launchMergeLane };
