import { existsSync } from "node:fs";
import { join } from "node:path";

import { type DoriConfig, reportQuietLane } from "./config.ts";
import { githubTargets } from "./github-events.ts";
import { type Claim, type ClaimedPull, type Lane, type Registry, statusOf, withStatus } from "./registry.ts";
import { ghJson } from "./gh-json.ts";
import { type Clock, iso, type Ran, type Runner } from "./run.ts";
import { OPEN_STATES, openOperations, type Operation, operationId, type OperationStore, plan, type ReadBack, settleOperation } from "./operations.ts";
import { acquireStateLock, StateLockError, tryStateLock } from "./state-lock.ts";
import { type Check, doneRepos, parseSignal, type SignalIo } from "./signals.ts";
import { BRANCH_DELETE, type BranchPlan, planBranchCleanup, readBindings, readBranchBindings, type WorktreeFact } from "./branch-cleanup.ts";
import { eventClass } from "./event-policy.ts";
import type { EventMeta } from "./supervise-journal.ts";
import { LaneOpsError, type LaneOps, type PaneRef } from "./lane-ops.ts";
import { deliverLaneMessage, MERGE_VERIFY, queueSteering } from "./ci-follow.ts";
import { blockedOutcome, finishedOutcome, type LaneMerge, type LaneMergeRead, notCompletedLine, type TaskBlocker, taskCompleted, type TaskFinish, type TaskFinisher } from "./task-finish.ts";
import { openLaneMessages } from "./lane-messages.ts";
import { checkLaneReportText, installLaneReports, laneNotAdoptedFile, laneReportFile, validateLaneOutput, verifyLaneFileReceipt } from "./lane-files.ts";
import { LaneFileError } from "./lane-file-contract.ts";
import type { LaneFileReceipt } from "./runner/protocol.ts";
import type { Tunables } from "./tunables.ts";
import { type Act, actRecorded, type LaneRead, probeWorktree, readLane, type Step, withOperations } from "./flow-io.ts";
import { type CleanupQueue, cleanupPending, closedWorktreeSweep, type PendingCleanup, QUEUED_WORKTREE, remoteWorktrees } from "./closed-cleanup.ts";
import { isLaneOutcomeLine, LANE_FAILED_EVENT, laneAttempt, laneOutcomeEventId, markLaneToodo, settleLaneOutcome, toodoMarkOf } from "./autopilot.ts";
import { OUTCOME_LINE_MAX, recordReported } from "./lane-outcomes.ts";
import { type AutoReportPost, openAsks, QUIET_REPORT, writtenIn } from "./auto-report.ts";
import { latestChecks, type RollupCheck } from "./check-rollup.ts";

export type FlowDeps = {
  readonly newFileRunId?: () => string;
  readonly fileNote?: (id: string, line: string) => void;
  readonly run: Runner;
  readonly clock: Clock;
  readonly registry: Registry;
  readonly config: DoriConfig;
  /** Built-in timings, notices and policies (tunables.ts); production passes BUILT_IN. */
  readonly tunables: Tunables;
  /** Every lane operation, through the lane's runner (lane-ops.ts). */
  readonly ops: LaneOps;
  readonly exists?: (path: string) => boolean;
  /** PATH lookup for laneSandbox.command; absent uses Bun.which. */
  readonly which?: (cmd: string) => string | null;
  /** The OS runner `label` last reported (Windows runners run lanes unsandboxed); absent reads the hub's runners table. */
  readonly runnerOs?: (label: string) => string | undefined;
  /** The lane worktree root runner `label` last reported; absent reads the hub's runners table. */
  readonly runnerWorktreeRoot?: (label: string) => string | undefined;
  readonly signalIo?: SignalIo;
  /** The operation rows; absent opens the configured store per call. */
  readonly operations?: OperationStore;
  /**
   * The supervisor's answer to "has the lead received this journaled event" (a claim's window start). Absent (`dori watch`,
   * which hands its lines to stdout) an event counts as received once it is handed over.
   */
  readonly leadDelivered?: (eventId: string) => boolean;
  /**
   * The supervisor's follow-up of a lane that closed after its merge (task-finish.ts): completes its Toodo task and
   * appends the merge to its report. Absent (`dori watch`), a close carries no `toodo=` tag and the lead finishes the task.
   */
  readonly finishTask?: TaskFinisher;
  /**
   * Records a blocker note on the Toodo task of an autopilot lane that closed cancelled or whose task finishTask could
   * not complete (task-finish.ts taskBlocker). Absent, the failure line goes to the lead with nothing written.
   */
  readonly blockTask?: TaskBlocker;
  /**
   * D11 close hold (review-gate.ts ReviewGate.holdsLane; only PRs of repos in config `review.repos`, reviewEnabledFor,
   * hold for review): true while a review of a PR the lane's claim binds is pending,
   * so the watcher neither closes nor objects to the lane (nor queues its worktrees), past closeAfterMin and
   * mergeWaitMaxMin too, until every bound PR reads merged. Absent (`dori watch`), nothing is held.
   */
  readonly reviewHold?: (lane: Lane) => Promise<boolean>;
  /**
   * The supervisor's auto report of a clean done claim of a lane config `autoReport` covers (auto-report.ts): the claim is
   * posted to the owner and handed to the lead as digest LANE_DONE_AUTO_REPORTED instead of urgent LANE_DONE_CLAIMED.
   * Absent (`dori watch`), every claim goes to the lead.
   */
  readonly autoReport?: AutoReportPost;
};

/**
 * The pane reads a sweep makes: the supervisor round's cached view (sweep-view.ts), else the lane facade itself. Both
 * reach a pane only through its machine's runner.
 */
export type LaneReads = {
  readonly panes: LaneOps["panes"];
  readonly status: LaneOps["status"];
  readonly screen: (ref: PaneRef, lines: number) => Promise<string>;
};

/**
 * The lane's own cwd as a worktree, when it is one the lane's worktrees do not already hold. With `linked`, a main
 * checkout (its `.git` is a directory) never qualifies: the close only ever removes linked worktrees.
 */
const cwdWorktree = async (deps: FlowDeps, lane: Lane, read: LaneRead, linked: boolean): Promise<WorktreeFact | undefined> => {
  const cwd = lane.cwd;
  if (lane.machine || !cwd || read.cwdGone || read.worktrees.some((w) => w.path === cwd)) return undefined;
  if (linked && (await deps.ops.exists(undefined, [join(cwd, ".git", "HEAD")]))[0]) return undefined;
  return probeWorktree(deps, lane, cwd);
};

/** The line a close prints when the lane's own cwd is gone and its signals ran in leadCwd instead. */
const cwdFallbackLine = (deps: FlowDeps, lane: Lane, read: LaneRead): string | undefined =>
  read.cwdGone
    ? `SIGNAL_CWD ${lane.key}: lane cwd ${lane.cwd} no longer exists; Done signals and git ran in leadCwd ${deps.config.leadCwd}`
    : undefined;

const windowMs = (deps: FlowDeps): number => deps.tunables.closeAfterMin * 60_000;

/** Free text in an event line (evidence, reasons) is capped; the registry keeps it whole. */
const EVENT_TEXT_MAX = 300;
export const eventText = (text: string, max = EVENT_TEXT_MAX): string => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A GitHub pull request URL. */
const PULL_URL = /https:\/\/\S+\/pull\/\d+/;

/**
 * The fixed close event: no receipt (the registry keeps it). The first PR URL the close note or a Done signal names is
 * kept, so the lead sees which PR the lane closed with.
 */
export const closedEvent = (key: string, note: string, lines: readonly string[]): string => {
  const pr = [note, ...lines.filter((l) => l.startsWith("SIGNAL "))].map((t) => PULL_URL.exec(t)?.[0]).find(Boolean);
  return `LANE_CLOSED ${key} closed${pr ? ` ${pr}` : ""}`;
};

/** A lane that claims and closes with no lead wake: its brief declared `autoClose: machine`. */
const machineClose = (lane: Lane): boolean => lane.autoClose === "machine";

/**
 * Whether the claim's window waits for the lead to receive it: when the policy makes LANE_DONE_CLAIMED wake the lead
 * (the default), so the later close finds the claim delivered and is marked seen-claim. A policy that makes the claim
 * digest leaves it to the supervisor (live re-check, then close or LANE_NOT_DONE), so the window runs from the hand-over;
 * so does a claim the supervisor auto-reported (`claim.autoReported`), whose close counts as seen.
 */
const claimWaitsForLead = (deps: FlowDeps, lane: Lane, claim?: Claim): boolean =>
  !machineClose(lane) && !claim?.autoReported && eventClass(`LANE_DONE_CLAIMED ${lane.key}`, deps.tunables.eventPolicy) === "lead-urgent";

/** The journal id of a claim's announcement: stable, so a repeated announcement after a crash is the same event. */
export const claimEventId = (key: string, claimAt: string): string => `done-claim:${key}:${claimAt}`;

type PrRow = { readonly number?: unknown; readonly state?: unknown; readonly headRefOid?: unknown; readonly isCrossRepository?: unknown };
const PR_ROW_FIELDS = "number,state,headRefOid,isCrossRepository";

/**
 * The lane's open same-repo PRs and their head SHA right now, read live from GitHub: the PRs its Done signals name and
 * those whose head is one of its branches. The claim records them, and the supervisor merges a PR only at exactly that
 * head (ci-follow.ts claimGate). A fork PR is never recorded, whatever its number or branch; a read that fails records
 * nothing for that target, so that PR is not auto-merged on this claim.
 */
export const claimBindings = async (run: Runner, ops: Pick<LaneOps, "inspect">, lane: Lane): Promise<ClaimedPull[]> => {
  const found = new Map<string, ClaimedPull>();
  const add = (repo: string, row: PrRow): void => {
    if (row.isCrossRepository !== false || row.state !== "OPEN" || typeof row.number !== "number" || typeof row.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(row.headRefOid)) return;
    found.set(`${repo}#${row.number}`, { repo, number: row.number, sha: row.headRefOid });
  };
  const read = async (repo: string, argv: readonly string[], shape: "object" | "array"): Promise<void> => {
    const r = await ghJson<PrRow | readonly PrRow[]>(run, argv, shape, { timeoutMs: 20_000 });
    if (!r.ok) {
      console.error(`CLAIM_PR_UNREAD ${lane.key} ${argv.slice(0, 4).join(" ")} ${repo}: ${r.code ? `exit ${r.code}: ` : ""}${r.error}`);
      return;
    }
    for (const row of Array.isArray(r.value) ? r.value : [r.value]) if (row && typeof row === "object") add(repo, row);
  };
  for (const [repo, targets] of await githubTargets([lane], ops)) {
    for (const n of targets.numbers) await read(repo, ["gh", "pr", "view", String(n), "-R", repo, "--json", PR_ROW_FIELDS], "object");
    for (const branch of targets.branches) await read(repo, ["gh", "pr", "list", "-R", repo, "--state", "open", "--head", branch, "--json", PR_ROW_FIELDS], "array");
  }
  return [...found.values()];
};

/** `text` is the lane's own done text (`dori report <key> done --text`), kept on the claim for an auto report. */
export const claimDone = async (deps: FlowDeps, lane: Lane, evidence: string, fileReceipt?: LaneFileReceipt, text?: string): Promise<string> => {
  const stale = (): LaneFileError => new LaneFileError("LANE_REPORT_STALE", lane.key, "the report belongs to an older lane run; claim done again from the current lane");
  const options = { now: deps.clock.now, checkCurrent: () => deps.registry.read(lane.key),
    emit: deps.fileNote ?? ((_id: string, line: string) => console.error(line)) };
  const active = await deps.registry.read(lane.key);
  if ((lane.fileRun && !active?.fileRun) || (active?.fileRun && active.closedAt)) throw stale();
  if (active?.fileRun) {
    checkLaneReportText(lane.key, "", evidence);
    if (!fileReceipt) {
      const snapshot = await deps.ops.files(active);
      if (!snapshot) throw new LaneFileError("LANE_REPORT_FILES_MISSING", lane.key, "this managed lane's done report has no file snapshot; claim done again through its runner");
      validateLaneOutput(lane.key, snapshot, active.fileRun);
      fileReceipt = await installLaneReports(deps.config.stateDir, lane.key, snapshot, options);
    }
    lane = active;
  } else if (fileReceipt) {
    throw stale();
  }
  const admit = async (): Promise<string> => {
  // A repeated claim with the same evidence is the claim already recorded: it keeps that claim (and its single
  // LANE_DONE_CLAIMED, its window and its PR bindings) instead of re-issuing it and waking the lead again.
  const recorded = await deps.registry.read(lane.key);
  if (fileReceipt && (!recorded || recorded.closedAt || recorded.fileRun?.id !== fileReceipt.run.id))
    throw stale();
  const status = recorded ? statusOf(recorded) : undefined;
  if (recorded?.claim && (status === "done-claimed" || status === "verified-done") && recorded.claim.evidence === evidence) {
    return `LANE_DONE_ALREADY_CLAIMED ${lane.key} ${recorded.claim.at} ${eventText(evidence)}`;
  }
  const notClaimed = `LANE_DONE_NOT_CLAIMED ${lane.key} is closed`;
  if (recorded?.closedAt) return notClaimed;
  const pulls = await claimBindings(deps.run, deps.ops, lane);
  const at = iso(deps.clock);
  let closed = false;
  await deps.registry.update(lane.key, (current) => {
    if (fileReceipt && (!current || current.closedAt || current.fileRun?.id !== fileReceipt.run.id))
      throw stale();
    // Closed meanwhile: the archived record keeps the claim it closed on (or none), not this one.
    if (current?.closedAt) { closed = true; return undefined; }
    return withStatus(current ?? lane, "done-claimed", evidence, at, { claim: { at, evidence, emitted: false, pulls, ...(text ? { text } : {}) } });
  });
  if (closed) return notClaimed;
  // `dori lane status` inside the lane answers from what its runner was told (D16).
  await deps.ops.notify(lane, { status: "done-claimed", claim: { at, evidence } });
  if (lane.pane) {
    const closesAt = new Date(deps.clock.now() + windowMs(deps)).toISOString().slice(11, 16);
    const when = claimWaitsForLead(deps, lane)
      ? `${deps.tunables.closeAfterMin} minutes after the lead receives this claim`
      : `at ${closesAt}Z (${deps.tunables.closeAfterMin} minutes) once its Done signals read back live`;
    await steerLane(deps, lane, "claim", `[LEAD] done claim recorded for ${lane.key}: this lane closes automatically ${when} unless the lead objects with reasons; a PR the claim recorded is merged by the supervisor first. Stop here and stay idle: do not watch or wait for the merge. An objection arrives here as [LEAD] not done.`);
  }
  return `LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${eventText(evidence)}`;
  };
  if (!fileReceipt) return admit();
  let result = "";
  await verifyLaneFileReceipt(deps.config.stateDir, lane.key, fileReceipt, {
    ...options,
  }, async () => { result = await admit(); });
  return result;
};

/**
 * The lead's word on a done claim (its notice, an objection) as a lane message: queued durably with an ID the lane acks,
 * replacing the lane's earlier one still open, then typed once now. A pane that does not take it now (other text in
 * its input line, no prompt, runner away) keeps it queued for the supervisor's delivery pass and, unconfirmed after
 * ciConfirmMin, one LANE_MESSAGE_UNCONFIRMED.
 */
const steerLane = async (deps: FlowDeps, lane: Lane, kind: "claim" | "not-done", text: string): Promise<void> => {
  const messages = openLaneMessages(deps.config);
  const ops = deps.operations ?? openOperations(deps.config);
  try {
    const now = deps.clock.now();
    const message = queueSteering(messages, now, lane, { id: `${kind}-${lane.key}-${now}`, subject: `${lane.key} done status`, text });
    await deliverLaneMessage(deps, ops, messages, lane, message);
  } finally {
    if (!deps.operations) ops.close();
    messages.close();
  }
};

export const objectDone = async (deps: FlowDeps, lane: Lane, reasons: readonly string[]): Promise<string> => {
  const at = iso(deps.clock);
  let closed = false;
  await deps.registry.update(lane.key, (current) => {
    // An objection that reaches a closed lane is not recorded: the archived record stays as the close left it.
    if (current?.closedAt) { closed = true; return undefined; }
    return withStatus(current ?? lane, "not-done", reasons.join("; "), at, { objection: { at, reasons } });
  });
  if (closed) return `LANE_NOT_DONE_SKIPPED ${lane.key} is closed; the objection was not recorded`;
  // The reasons reach the lane through its runner (`dori lane status`, D16), before the lane is told to read them.
  await deps.ops.notify(lane, { status: "not-done", objection: { at, reasons } });
  // The reasons are never typed: they carry command output and paths, and a pane is a shell line. The lane reads them.
  const text = lane.machine
      ? `[LEAD] not done: the Done check of ${lane.key} did not pass; the lead has the reasons. Read them with ~/.dori/runner/bin/dori lane status ${lane.key}, keep working, and claim again when fixed`
      : `[LEAD] not done: the Done check of ${lane.key} did not pass. Read the reasons with dori lane status ${lane.key}, keep working, and claim again when fixed`;
  if (lane.pane) await steerLane(deps, lane, "not-done", text);
  return `LANE_NOT_DONE ${lane.key} ${eventText(reasons.join("; "))}`;
};

/** Why the lane's worktrees hold work a close would lose: uncommitted, untracked or unpushed, or unreadable by the runner. */
const unpushedIn = (worktrees: readonly WorktreeFact[]): string[] => worktrees.flatMap((wt) => {
  if (!wt.exists) return [];
  if (wt.error !== undefined || wt.dirty === undefined || wt.ahead === undefined) return [`unpushed work in ${wt.path} (git state unreadable)`];
  return wt.dirty || wt.ahead > 0 ? [`unpushed work in ${wt.path}`] : [];
});

/** Unpushed work in the lane's worktrees, as its runner reads them; none for a remote lane. */
export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => unpushedIn((await readLane(deps, lane)).worktrees);

export type CloseOptions = {
  /** `dori close --force`: close despite unpushed/uncommitted work; its worktrees are still queued, and the sweep keeps one that is not clean and pushed. */
  readonly force?: boolean;
  /**
   * `dori close --cancelled --reason`: the owner cancelled the work or its Done can never hold. The Done signals are not
   * checked; the worktree checks and cleanup run as usual, and the close is recorded with the reason as cancelled.
   */
  readonly cancelled?: { readonly reason: string };
  /**
   * An autopilot lane that found nothing to change (notAdoptedConclusion): its `pr` Done signals with no PR from their
   * branch are not required, every other signal still is. `conclusion` is the lead-host path of its `not-adopted.md`;
   * the close is recorded with it and the task is concluded not adopted (task-finish.ts).
   */
  readonly notAdopted?: { readonly conclusion: string };
  /**
   * An autopilot lane that finished work whose deliverable is no PR (a report or research, noPrClose): its `pr` Done
   * signals with no PR from their branch are not required, every other signal still is. `report` is the lead-host path
   * of its `report.md`; the close is recorded with it and the task is completed on that report (task-finish.ts).
   */
  readonly reported?: { readonly report: string };
  /**
   * Done checks the caller read just before (a claim's settlement): reused instead of read again. The worktrees are
   * still re-read under the close lock. Never persisted: a resumed close reads afresh.
   */
  readonly pre?: { readonly checks: readonly Check[] };
};

/** The close sequence's own operation (its intent and resume data); its effects are separate operations of the lane. */
export const CLOSE_ACTION = "close";
const closeId = (key: string): string => operationId({ lane: key, action: CLOSE_ACTION, target: key });
/** Held for a whole close of one lane; a killed holder releases it, so a resumer can tell a live close. */
const closeLockPath = (deps: FlowDeps, key: string): string => join(deps.registry.dir, `${key}.close.lock.sqlite`);

/** A close of lane `key` holds its lock right now (in this or another process). */
export const closeRunning = (deps: FlowDeps, key: string): boolean => {
  const release = tryStateLock(closeLockPath(deps, key));
  if (!release) return true;
  release();
  return false;
};

/** Gone from the pane list of the lane's machine (its runner's) is done; listed is not; an unreadable list cannot tell. */
const paneGone = (deps: FlowDeps, lane: Lane, match: (pane: { readonly pane_id: string; readonly tab_id?: string }) => boolean): ReadBack => async () =>
  (await deps.ops.panes(lane.machine)).some(match) ? "not-done" : "done";

/** The error of a `lane.close` its runner answered with the lane's pane still listed (`gone: false`). */
const STILL_LISTED = "still listed after closing";

/** The lane's runner closes its tab (else its pane), `lane.close`; a refusal or an ambiguous answer is data for the read-back. */
const closeEffect = (deps: FlowDeps, lane: Lane) => async (cmdId: string): Promise<Ran> => {
  try {
    const r = await deps.ops.close(lane, { cmdId });
    return r.gone ? { code: 0, out: `closed ${r.closed}`, err: "" } : { code: 1, out: "", err: `${STILL_LISTED} ${r.closed}` };
  } catch (e) {
    if (e instanceof LaneOpsError) return { code: 1, out: "", err: e.message };
    throw e;
  }
};

/**
 * Close a lane: every Done signal must read back live, and (unless `force`) no worktree may hold unpushed, uncommitted
 * or untracked work. Nothing is removed at the close: the worktrees and SHA-bound branches it may drop are queued in its
 * receipt (`receipt.queue`, with each worktree's repository root and each branch's binding), and the watcher's
 * closedWorktreeSweep removes them once they read clean and pushed again. The lane's thread is left open.
 *
 * The close holds a per-lane lock, records its intent (a `close` operation with the note and
 * force flag) and runs every effect as an operation: a crash anywhere is resumed by `resumeOperations` without
 * repeating an effect, and an operation whose read-back cannot tell stops the close as OPERATION_AMBIGUOUS.
 */
export const closeLane = async (deps: FlowDeps, lane: Lane, note: string, opts: CloseOptions = {}): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  let release: () => void;
  try { release = await acquireStateLock(closeLockPath(deps, lane.key)); } catch (e) {
    if (e instanceof StateLockError) return { closed: false, lines: [`REFUSED ${lane.key}: another close of this lane is still running`] };
    throw e;
  }
  try {
    const closed = await withOperations(deps, async (store) => {
      const id = closeId(lane.key);
      // A close that finished while this one waited for the lock (the CLI and the supervisor resuming the same lane).
      const fresh = (await deps.registry.read(lane.key)) ?? lane;
      if (statusOf(fresh) === "closed") {
        if (store.get(id)?.state === "planned") settleOperation(store, deps.clock.now(), id, "verified", "lane recorded closed");
        return { closed: true, lines: [`CLOSED ${lane.key} already closed`, ...autopilotOutcome(deps, store, fresh)] };
      }
      const data = JSON.stringify({ note, force: Boolean(opts.force), ...(opts.cancelled ? { cancelled: opts.cancelled } : {}), ...(opts.notAdopted ? { notAdopted: opts.notAdopted } : {}), ...(opts.reported ? { reported: opts.reported } : {}) });
      const prior = store.get(id);
      if (!prior) plan(store, deps.clock.now(), { lane: lane.key, action: CLOSE_ACTION, target: lane.key, data });
      else store.put({ ...prior, state: "planned", detail: "close planned", data, updatedAt: deps.clock.now() });
      const result = await closeSequence(deps, lane, note, opts, actRecorded(deps, store, lane), store);
      const now = deps.clock.now();
      if (result.closed) {
        settleOperation(store, now, id, "verified", "lane recorded closed");
        return { closed: true, lines: [...result.lines, ...autopilotOutcome(deps, store, lane, opts.cancelled?.reason ?? null)] };
      }
      if (store.get(id)?.state === "planned") settleOperation(store, now, id, "failed", result.lines.at(-1) ?? "refused");
      return result;
    });
    return await blockFailedAttempt(deps, lane, closed);
  } finally { release(); }
};

/**
 * A close that settled an autopilot attempt failed (AUTOPILOT_LANE_FAILED): the attempt's task gets a blocker note
 * (deps.blockTask, read back) and the line says what was recorded. Marked on the attempt once, so a resumed close never
 * writes it again. The Toodo write runs outside the operation store.
 */
const blockFailedAttempt = async (deps: FlowDeps, lane: Lane, result: { readonly closed: boolean; readonly lines: string[] }): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const at = result.lines.findIndex((line) => line.startsWith(`${LANE_FAILED_EVENT} `));
  const line = result.lines[at];
  const task = line === undefined ? NaN : Number(/^\S+ #(\d+) /.exec(line)?.[1]);
  if (!deps.blockTask || line === undefined || !Number.isSafeInteger(task)) return result;
  const told = (said: string) => ({ ...result, lines: result.lines.map((l, i) => (i === at ? blockedOutcome(l, said) : l)) });
  // The lane is closed by now: a ledger failure is said on the line instead of thrown.
  const failure = (e: unknown) => `launch ledger: ${e instanceof Error ? e.message : String(e)}`;
  let unmarked: boolean;
  try {
    unmarked = await withOperations(deps, async (store) => { const op = laneAttempt(store, lane.key); return op !== undefined && toodoMarkOf(op) === undefined; });
  } catch (e) { return told(`blocker not recorded: ${failure(e)}`); }
  if (!unmarked) return result;
  const said = await deps.blockTask(lane, task, line.slice(LANE_FAILED_EVENT.length + 1).replace(/: tell the owner;.*$/, ""));
  try {
    await withOperations(deps, async (store) => markLaneToodo(store, deps.clock.now(), lane.key, said.startsWith("blocker recorded") ? "blocked" : "failed"));
  } catch (e) { return told(`${said}; attempt not marked: ${failure(e)}`); }
  return told(said);
};

/** A Done check that failed only because no PR from its `pr` signal's branch exists at all. */
const noPrYet = (check: Check): boolean => {
  if (check.ok || check.error !== undefined) return false;
  try {
    const signal = parseSignal(check.signal);
    return signal.kind === "pr" && check.detail === `no PR from ${signal.branch}`;
  } catch { return false; }
};

/** How an autopilot lane with no PR closes: not adopted on its conclusion, or completed on its report. */
type NoPrClose = Pick<CloseOptions, "notAdopted" | "reported">;

/**
 * How the claim of an autopilot lane with no PR closes instead of being objected to, when the lane is an autopilot launch
 * attempt and every Done signal that does not hold is a `pr` signal with no PR from its branch (a lane that opened a PR
 * settles on that PR): with the `not-adopted.md` its claim installed, it investigated and adopted no change, so it closes
 * not adopted; else with its installed `report.md`, it finished work whose deliverable is no PR, so it closes on that
 * report and its task is completed. Undefined with neither file.
 */
const noPrClose = async (deps: FlowDeps, lane: Lane, checks: readonly Check[]): Promise<NoPrClose | undefined> => {
  const failing = checks.filter((c) => !c.ok);
  if (!failing.length || !failing.every(noPrYet)) return undefined;
  const conclusion = laneNotAdoptedFile(deps.config.stateDir, lane.key);
  const report = laneReportFile(deps.config.stateDir, lane.key);
  const close: NoPrClose | undefined = existsSync(conclusion) ? { notAdopted: { conclusion } } : existsSync(report) ? { reported: { report } } : undefined;
  if (!close) return undefined;
  return (await withOperations(deps, async (store) => laneAttempt(store, lane.key) !== undefined)) ? close : undefined;
};

/** The path a closed lane's receipt records under `field.key` (`notAdopted.conclusion`, `reported.report`), else undefined. */
const receiptPath = (lane: Lane, field: "notAdopted" | "reported", key: "conclusion" | "report"): string | undefined => {
  const receipt = lane.receipt;
  if (typeof receipt !== "object" || receipt === null || !(field in receipt)) return undefined;
  const value: unknown = (receipt as Record<string, unknown>)[field];
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const path: unknown = (value as Record<string, unknown>)[key];
  return typeof path === "string" ? path : undefined;
};

/** The cancel reason a closed lane's receipt records (`dori close --cancelled`), else undefined. */
const cancelledReason = (lane: Lane): string | undefined => {
  const receipt = lane.receipt;
  if (typeof receipt !== "object" || receipt === null || !("cancelled" in receipt)) return undefined;
  const cancelled = receipt.cancelled;
  return typeof cancelled === "object" && cancelled !== null && "reason" in cancelled && typeof cancelled.reason === "string" ? cancelled.reason : undefined;
};

/**
 * Settles the autopilot launch attempt of a lane that is now closed (autopilot.ts settleLaneOutcome): a cancelled close
 * failed, any other done. `cancelled` is the close's own reason, null for a close that was not cancelled; undefined reads
 * it from the closed lane's receipt (a close finished earlier). Returns the line for the lead, if any.
 */
const autopilotOutcome = (deps: FlowDeps, store: OperationStore, lane: Lane, cancelled?: string | null): string[] => {
  const reason = cancelled === undefined ? cancelledReason(lane) : cancelled ?? undefined;
  const line = settleLaneOutcome(store, deps.clock.now(), lane.key, reason === undefined ? undefined : `cancelled: ${reason}`);
  return line ? [line] : [];
};

/** The autopilot outcome lines of a close, each handed over under its lane's stable outcome id. */
const pushOutcomes = async (push: Emit, lane: Lane, lines: readonly string[]): Promise<void> => {
  for (const line of lines.filter(isLaneOutcomeLine)) await push(line, laneOutcomeEventId(lane.key), laneMeta(lane));
};

const closeSequence = async (
  deps: FlowDeps, lane: Lane, note: string, opts: CloseOptions, act: Act, store: OperationStore,
): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const cancelled = opts.cancelled;
  const notAdopted = opts.notAdopted;
  const reported = opts.reported;
  let read: LaneRead;
  try {
    read = await readLane(deps, lane, { done: !cancelled && !opts.pre });
  } catch (e) {
    // Fail closed (D7): with the lane's runner away nothing is checked, removed or closed.
    if (e instanceof LaneOpsError) return { closed: false, lines: [`REFUSED ${lane.key}: ${e.message}; the lane is left open`] };
    throw e;
  }
  const checks = cancelled ? [] : opts.pre?.checks ?? read.checks ?? [];
  const fallback = cancelled ? undefined : cwdFallbackLine(deps, lane, read);
  const lines = [
    ...(fallback ? [fallback] : []),
    ...(cancelled ? [`SIGNAL SKIPPED ${lane.key}: cancelled by the lead: ${cancelled.reason}`] : []),
    ...checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`),
    ...(notAdopted ? [`SIGNAL SKIPPED ${lane.key}: not adopted, no PR needed: ${notAdopted.conclusion}`] : []),
    ...(reported ? [`SIGNAL SKIPPED ${lane.key}: completed with no PR, on its report: ${reported.report}`] : []),
  ];
  if (checks.some((c) => !c.ok && !((notAdopted || reported) && noPrYet(c)))) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: a Done signal is not live (to give the lane up: dori close ${lane.key} --cancelled --reason TEXT)`] };
  if (!opts.force) {
    const unpushed = unpushedIn(read.worktrees);
    if (unpushed.length) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: ${unpushed.join("; ")} (commit and push it, or dori close --force)`] };
  }
  const cleanup: string[] = [];
  const ambiguous = (step: Step) => {
    settleOperation(store, deps.clock.now(), closeId(lane.key), "ambiguous", `stopped at ${step.id}`);
    return { closed: false, lines: [...lines, ...cleanup, `OPERATION_AMBIGUOUS ${step.id} ${step.detail}`,
      `REFUSED ${lane.key}: the close stopped at an operation that may or may not have happened; check it, run dori ops resolve ${step.id} --as verified|retry, then close again`] };
  };
  // Nothing is removed here: each worktree and branch the close may drop is queued in its receipt, and the watcher's
  // closedWorktreeSweep removes it once it is clean with nothing unpushed (two stages, the same for local and remote lanes).
  const queue: CleanupQueue = { worktrees: [], branches: [] };
  if (lane.machine) {
    const remote = await remoteWorktrees(deps, lane);
    cleanup.push(remoteWorktreeNote(lane), ...remote.lines);
    queue.worktrees.push(...remote.queued.map((path) => ({ path, root: path })));
  }
  const root = read.root;
  // A worktree an interrupted close already removed is no longer found; its operation still has to settle.
  const pending = store.list({ lane: lane.key }).filter((op) => op.action === "worktree-remove" && op.state !== "verified").map((op) => op.target);
  const present = read.worktrees.filter((wt) => wt.exists);
  const worktrees = [...new Set([...present.map((wt) => wt.path), ...pending])];
  // A lane worktree removed before the close (removed by hand or by another tool) is already cleaned, never a refusal.
  const gone = lane.machine ? [] : [...new Set([...(read.cwdGone && lane.cwd ? [lane.cwd] : []), ...read.worktrees.filter((wt) => !wt.exists).map((wt) => wt.path)])].filter((wt) => !pending.includes(wt));
  cleanup.push(...gone.map((wt) => `worktree ${wt} already removed`));
  // Bound before any worktree goes: a worktree whose branch moved past the merged head stays with its branch.
  // The lane's own cwd, when it is a linked worktree, goes too once it sits exactly at a PR merged into the merge base.
  let branches: BranchPlan | undefined;
  let candidate: WorktreeFact | undefined;
  if (!lane.machine) {
    candidate = await cwdWorktree(deps, lane, read, true);
    branches = await planBranchCleanup(deps.run, deps.ops, lane, present, store, deps.clock.now, {
      base: deps.config.ciMergeBase, candidates: candidate ? [candidate] : [], roots: [deps.config.leadCwd, root],
    });
  }
  cleanup.push(...(branches?.notes ?? []));
  const adopted = new Set(branches?.adopted ?? []);
  for (const wt of [...worktrees, ...adopted]) {
    const hold = branches?.holds.get(wt);
    if (hold) { cleanup.push(`branch-bound worktree ${wt} kept: ${hold}`); continue; }
    queue.worktrees.push({ path: wt, root });
    cleanup.push(`worktree ${wt} queued: ${QUEUED_WORKTREE}`);
  }
  // Each branch target is also a planned operation (planBranchCleanup), so a close resumed before it records the lane
  // closed finds it again; once closed, the receipt's queue is what the sweep works from.
  const facts = [...present, ...(candidate ? [candidate] : [])];
  for (const target of branches?.targets ?? []) {
    // A branch a worktree of the lane shows past its merged head stays for good (that worktree stays too: a branch hold).
    const tip = facts.find((w) => w.exists && w.branch === target.branch && w.head)?.head;
    if (tip && tip !== target.sha) {
      const why = `tip ${tip.slice(0, 10)} is not the merged head ${target.sha.slice(0, 10)} of ${target.repo}#${target.n} (a commit after the merge)`;
      settleOperation(store, deps.clock.now(), operationId({ lane: lane.key, action: BRANCH_DELETE, target: `${target.repo}#${target.n}@${target.sha}` }), "failed", `kept: ${why}`);
      cleanup.push(`branch ${target.branch} kept: ${why}`);
      continue;
    }
    queue.branches.push(target);
    cleanup.push(`branch ${target.branch} queued: deleted by the closed-lane cleanup after its worktrees go, only while it is at ${target.repo}#${target.n} merged head ${target.sha.slice(0, 10)}`);
  }
  // A lane whose agent may still run is never recorded closed: it would be left with no record to report through or
  // to close again. The failed close operation stays retryable, so the next close tries it again.
  const stillListed = (what: string, detail: string) => ({ closed: false, lines: [...lines, ...cleanup,
    `REFUSED ${lane.key}: ${what} is still listed after its close (${detail.slice(0, 120)}); the lane is left open, close it again`] });
  // The lane's thread stays open: only the owner closes it, with the button on the lead's report.
  if (lane.tab) {
    const tab = lane.tab;
    const step = await act("tab-close", tab, closeEffect(deps, lane), paneGone(deps, lane, (p) => p.tab_id === tab));
    if (step.state === "ambiguous") return ambiguous(step);
    if (step.state !== "verified") return stillListed(`tab ${tab}`, step.err);
    cleanup.push(`tab ${tab} closed`);
  } else if (lane.pane) {
    const pane = lane.pane;
    const step = await act("pane-close", pane, closeEffect(deps, lane), paneGone(deps, lane, (p) => p.pane_id === pane));
    if (step.state === "ambiguous") return ambiguous(step);
    if (step.state !== "verified") return stillListed(`pane ${pane}`, step.err);
    cleanup.push(`pane ${pane} closed`);
  } else if (lane.runner) {
    // No pane yet: a start may still be out (a cancelled reservation). lane.close by key stops a lane the runner
    // already recorded; a start that lands after the close is stopped by the supervisor (LANE_STARTED_AFTER_CLOSE).
    const r = await closeEffect(deps, lane)(`close-by-key:${lane.key}:${deps.clock.now()}`);
    if (r.err.startsWith(STILL_LISTED)) return stillListed(`runner lane ${lane.key}`, r.err);
    cleanup.push(r.code === 0 ? `runner lane ${lane.key} ${r.out}` : `runner lane ${lane.key} not closed: ${r.err.slice(0, 120)}`);
  }
  const at = iso(deps.clock);
  const operations = store.list({ lane: lane.key }).filter((op) => op.action !== CLOSE_ACTION).map((op) => ({ id: op.id, state: op.state }));
  const receipt = { checks, note, cleanup, ...(cancelled ? { cancelled } : {}), ...(notAdopted ? { notAdopted } : {}), ...(reported ? { reported } : {}), ...(lane.machine ? { worktreeCheck: { status: "skipped", detail: remoteWorktreeNote(lane) } } : {}), operations,
    ...(queue.worktrees.length || queue.branches.length ? { queue } : {}) };
  await deps.registry.update(lane.key, (current) => withStatus(current ?? lane, "closed", note, at, { closedAt: at, receipt }));
  return { closed: true, lines: [...lines, ...(lane.machine ? [`WORKTREE_CHECK SKIPPED ${lane.key}: ${remoteWorktreeNote(lane)}`] : []), `CLOSED ${lane.key}${cancelled ? " cancelled" : notAdopted ? " not-adopted" : reported ? " reported" : ""}`] };
};

/**
 * Supervisor and `dori watch`: finishes every close a crash interrupted. A close whose lock is held
 * is still running and is left alone. A lane already recorded closed only settles the row; otherwise the close runs
 * again with its recorded note and force flag, and its operations skip what is verified, reconcile what was in flight
 * and stop at anything ambiguous. Each outcome is one line: LANE_CLOSED, OPERATION_AMBIGUOUS or OPERATION_FAILED.
 */
export const resumeOperations = async (deps: FlowDeps, push: Emit): Promise<void> => {
  const open = await withOperations(deps, async (store) => store.list({ states: OPEN_STATES }).filter((op) => op.action === CLOSE_ACTION));
  for (const op of open) {
    const release = tryStateLock(closeLockPath(deps, op.lane));
    if (!release) continue;
    release();
    const lane = await deps.registry.read(op.lane);
    if (!lane || statusOf(lane) === "closed") {
      const outcome = await withOperations(deps, async (store) => {
        settleOperation(store, deps.clock.now(), op.id, lane ? "verified" : "failed", lane ? "lane recorded closed" : "lane not registered");
        return lane ? autopilotOutcome(deps, store, lane) : [];
      });
      if (lane) await pushOutcomes(push, lane, outcome);
      continue;
    }
    const { note, force, cancelled, notAdopted, reported } = JSON.parse(op.data ?? "{}") as { note?: string; force?: boolean; cancelled?: { reason: string }; notAdopted?: { conclusion: string }; reported?: { report: string } };
    const result = await closeLane(deps, lane, note ?? "closed after an interrupted close", { force: Boolean(force), ...(cancelled ? { cancelled } : {}), ...(notAdopted ? { notAdopted } : {}), ...(reported ? { reported } : {}) });
    const last = result.lines.at(-1) ?? "";
    if (result.closed) {
      await push(closedEvent(lane.key, note ?? "", result.lines), undefined, laneMeta(lane));
      await pushOutcomes(push, lane, result.lines);
    } else {
      const ambiguousLines = result.lines.filter((line) => line.startsWith("OPERATION_AMBIGUOUS "));
      for (const line of ambiguousLines.length ? ambiguousLines : [`OPERATION_FAILED ${op.id} the interrupted close was not finished: ${last}`]) await push(line, undefined, laneMeta(lane));
    }
  }
};

const WAIT_FIELDS = "state,headRefOid,isDraft,mergeable,mergeStateStatus,statusCheckRollup";
const CHECK_FAILED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
type WaitView = {
  readonly state?: string; readonly headRefOid?: string; readonly isDraft?: boolean; readonly mergeable?: string; readonly mergeStateStatus?: string;
  readonly statusCheckRollup?: readonly RollupCheck[];
};

/** The PR's failed checks, judged by each check's newest run (check-rollup.ts): a run a newer one replaced never counts. */
const failedChecks = (view: WaitView) =>
  latestChecks(view.statusCheckRollup ?? []).filter((c) => c.__typename === "StatusContext" ? c.state === "FAILURE" || c.state === "ERROR" : c.status === "COMPLETED" && CHECK_FAILED.has(c.conclusion ?? ""));
const conflicting = (view: WaitView): boolean => view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY";

/** The PR's checks in one word: a failed one wins, then one still running; a PR with no checks reads none, never green. */
const checksWord = (view: WaitView): string => {
  const rollup = latestChecks(view.statusCheckRollup ?? []);
  if (failedChecks(view).length) return "failed";
  if (rollup.some((c) => c.__typename === "StatusContext" ? c.state === "PENDING" || c.state === "EXPECTED" : c.status !== "COMPLETED")) return "pending";
  return rollup.length ? "green" : "none";
};

/** At most this many bound PRs are spelled out in a claim's snapshot; the rest are counted. */
const SNAPSHOT_PRS = 2;

/**
 * One read of a fresh claim before it wakes the lead: its worktrees and Done signals (through its runner) and each PR it
 * bound (live from GitHub). `snapshot` is the `verified: ...` text the announcement carries, so the lead need not re-read
 * the PR; `reasons` are the mechanical failures the supervisor objects to at once instead (work not pushed, a bound PR
 * that conflicts, has a failed check or moved past the bound head). Running checks are not a failure, and anything that
 * cannot be read is UNREAD, never green and never an objection: the settle at the window's end stays the judge.
 * `clean` is a snapshot with nothing left to look at: every bound PR read open with `checks=green conflict=no` (or none
 * bound, `pr=none`), every Done signal live (`sig=ok`) and nothing UNREAD.
 */
const preverifyClaim = async (deps: FlowDeps, lane: Lane): Promise<{ readonly snapshot: string; readonly reasons: string[]; readonly clean: boolean }> => {
  const reasons: string[] = [];
  const parts: string[] = [];
  const pulls = lane.claim?.pulls ?? [];
  let clean = pulls.length <= SNAPSHOT_PRS;
  for (const bound of pulls.slice(0, SNAPSHOT_PRS)) {
    const ref = `${bound.repo}#${bound.number}`;
    const r = await ghJson<WaitView>(deps.run, ["gh", "pr", "view", String(bound.number), "-R", bound.repo, "--json", WAIT_FIELDS], "object", { timeoutMs: 20_000 });
    const view = r.ok ? r.value : undefined;
    if (!view) { parts.push(`pr=#${bound.number} head=${bound.sha.slice(0, 7)} checks=UNREAD conflict=UNREAD`); clean = false; continue; }
    const head = view.headRefOid ?? bound.sha;
    if (view.state !== "OPEN") { parts.push(`pr=#${bound.number} head=${head.slice(0, 7)} state=${view.state ?? "UNREAD"}`); clean = false; continue; }
    const checks = checksWord(view);
    const conflict = conflicting(view) ? "yes" : view.mergeable === "MERGEABLE" ? "no" : "unknown";
    if (checks !== "green" || conflict !== "no") clean = false;
    parts.push(`pr=#${bound.number} head=${head.slice(0, 7)} checks=${checks} conflict=${conflict}`);
    if (head !== bound.sha) reasons.push(`${ref} head moved to ${head.slice(0, 10)} after the claim at ${bound.sha.slice(0, 10)} (claim again)`);
    if (conflict === "yes") reasons.push(`${ref} conflicts with its base`);
    if (checks === "failed") reasons.push(`${ref} has ${failedChecks(view).length} failed check(s)`);
  }
  if (pulls.length > SNAPSHOT_PRS) parts.push(`+${pulls.length - SNAPSHOT_PRS} pr`);
  if (!pulls.length) parts.push("pr=none");
  let sig = "UNREAD";
  try {
    const read = await readLane(deps, lane, { done: true });
    // Only work read as unpushed is objected to here; a worktree whose git state is unreadable is left to the settle.
    const unread = read.worktrees.some((wt) => wt.exists && (wt.error !== undefined || wt.dirty === undefined || wt.ahead === undefined));
    reasons.unshift(...unpushedIn(read.worktrees.filter((wt) => wt.exists && wt.error === undefined && wt.dirty !== undefined && wt.ahead !== undefined)));
    if (unread) parts.push("git=UNREAD");
    const checks = read.checks;
    if (checks) {
      const noPr = checks.every((c) => c.ok) ? undefined : await noPrClose(deps, lane, checks);
      sig = !checks.length ? "none" : checks.every((c) => c.ok) ? "ok" : noPr?.notAdopted ? "not-adopted" : noPr?.reported ? "reported" : `${checks.filter((c) => c.ok).length}/${checks.length}`;
    }
  } catch (e) {
    console.error(`CLAIM_PREVERIFY_UNREAD ${lane.key}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { snapshot: `verified: ${parts.join(" ")} sig=${sig}`, reasons, clean: clean && (sig === "ok" || sig === "not-adopted" || sig === "reported") && !parts.includes("git=UNREAD") && !reasons.length };
};

/**
 * Whether the supervisor reports a claim to the owner itself (auto-report.ts) instead of waking the lead: config
 * `autoReport` covers the lane (`all`, or `autopilot` and an autopilot launch attempt names it; never a review lane),
 * the preverify snapshot is clean, the lane has no objection on record and nothing open for the lead (openAsks), and its
 * done text is written in the owner's language. Anything else stays an urgent LANE_DONE_CLAIMED.
 */
const autoReportable = async (deps: FlowDeps, lane: Lane, claim: Claim, clean: boolean): Promise<boolean> => {
  const scope = deps.config.autoReport;
  if (scope === "off" || lane.review || !clean || lane.objection || !claim.text) return false;
  if (scope === "autopilot" && !(await withOperations(deps, async (store) => laneAttempt(store, lane.key) !== undefined))) return false;
  return writtenIn(claim.text, deps.config.ownerLanguage) && !openAsks(deps.config.stateDir, lane.key).length;
};

/**
 * Whether a claim is reported quietly: config `reportQuietLanes` names the lane (it posts its own results to the owner),
 * it is no review lane, and it has no objection on record and nothing open for the lead (openAsks). Its done text, its
 * language and the preverify snapshot do not matter: nothing is posted, and the close still re-reads the Done signals,
 * so a failing one comes back to the lead as LANE_NOT_DONE.
 */
const quietReportable = (deps: FlowDeps, lane: Lane): boolean =>
  reportQuietLane(deps.config, lane.key) && !lane.review && !lane.objection && !openAsks(deps.config.stateDir, lane.key).length;

/**
 * The auto report of a fresh claim: its message id once posted, or QUIET_REPORT once a quiet lane's receipt is written
 * (kept on the claim right away, so a pass repeated after a crash never posts or records it twice), the urgent LANE_AUTO_REPORT_FAILED line when the post failed (the claim then wakes the
 * lead as before), or undefined when the claim is not one the supervisor reports.
 */
const autoReportClaim = async (deps: FlowDeps, lane: Lane, claim: Claim, clean: boolean): Promise<{ readonly message: string } | { readonly failed: string } | undefined> => {
  if (claim.autoReported) return { message: claim.autoReported };
  let message: string;
  if (quietReportable(deps, lane)) {
    // The lane posts its own results: the receipt is written with no post, so no thread or message is recorded for it.
    recordReported(deps.config.stateDir, lane.key, deps.clock.now(), "reportQuietLanes: the lane posts its own results");
    message = QUIET_REPORT;
  } else {
    if (!deps.autoReport || !(await autoReportable(deps, lane, claim, clean))) return undefined;
    try {
      message = await deps.autoReport(lane, claim);
    } catch (e) {
      return { failed: `LANE_AUTO_REPORT_FAILED ${lane.key} ${eventText((e instanceof Error ? e.message : String(e)).replace(/\s+/g, " "), 200)}: the claim was not reported to the owner; report it yourself (dori reported ${lane.key} --text TEXT)` };
    }
  }
  const at = claim.at;
  await deps.registry.patch(lane.key, (current) => (current.claim?.at === at ? { claim: { ...current.claim, autoReported: message } } : undefined));
  return { message };
};

/** A claim's announcement: its evidence shortened so the snapshot after it stays inside one outcome line. */
const claimLine = (kind: string, lane: Lane, evidence: string, snapshot?: string): string => {
  const head = `${kind} ${lane.key} ${lane.pane ?? "-"}`;
  if (!snapshot) return `${head} ${eventText(evidence)}`;
  const room = Math.max(40, Math.min(EVENT_TEXT_MAX, OUTCOME_LINE_MAX - head.length - snapshot.length - 5));
  return `${head} ${eventText(evidence, room)} | ${snapshot}`;
};

/**
 * Whether a settling claim is still waiting for the supervisor's merge instead of failing: every failing Done signal is a
 * `merged` PR the claim bound, still OPEN at exactly the bound head, not a draft, not conflicting, with no failed check
 * (pending is fine), and less than `mergeWaitMaxMin` has passed since the window started. Otherwise `why` says what
 * stops the merge, for the objection. A PR that cannot be read this pass keeps the wait; the bound still ends it.
 */
const mergeWait = async (deps: FlowDeps, lane: Lane, failing: readonly Check[], start: number): Promise<{ readonly waiting: boolean; readonly why: string[] }> => {
  const signals = failing.map((c) => { try { return parseSignal(c.signal); } catch { return undefined; } });
  if (!signals.length || signals.some((s) => s?.kind !== "merged")) return { waiting: false, why: [] };
  const maxMin = deps.tunables.mergeWaitMaxMin;
  const why: string[] = [];
  for (const s of signals) {
    if (s?.kind !== "merged") continue;
    const ref = `${s.repo}#${s.n}`;
    const bound = (lane.claim?.pulls ?? []).find((p) => p.repo.toLowerCase() === s.repo.toLowerCase() && String(p.number) === s.n);
    if (!bound) { why.push(`${ref} was not open at a head the claim recorded, so it is not merged for this claim (push, then claim again)`); continue; }
    const r = await ghJson<WaitView>(deps.run, ["gh", "pr", "view", s.n, "-R", s.repo, "--json", WAIT_FIELDS], "object", { timeoutMs: 20_000 });
    if (!r.ok) continue;
    const view = r.value;
    const failed = failedChecks(view);
    if (view.state !== "OPEN") why.push(`${ref} is ${view.state ?? "unknown"}`);
    else if (view.headRefOid !== bound.sha) why.push(`${ref} head moved to ${(view.headRefOid ?? "unknown").slice(0, 10)} after the claim at ${bound.sha.slice(0, 10)} (claim again)`);
    else if (view.isDraft) why.push(`${ref} is a draft, which the supervisor never merges`);
    else if (conflicting(view)) why.push(`${ref} conflicts with its base`);
    else if (failed.length) why.push(`${ref} has ${failed.length} failed check(s)`);
  }
  if (why.length) return { waiting: false, why };
  if (deps.clock.now() - start < maxMin * 60_000) return { waiting: true, why: [] };
  return { waiting: false, why: [`not merged within ${maxMin} min of the claim (mergeWaitMaxMin): the supervisor could not merge it; check its checks, reviews and merge state`] };
};

/**
 * Whether a claim whose Done signals all read back live still waits for the supervisor to merge a PR it bound: a lane
 * ends at its green PR (a `pr` signal is live while the PR is open), and the supervisor merges only a lane that is
 * still claimed (ci-follow.ts claimGate), so closing first would leave that PR unmerged. It waits while a bound PR into
 * `ciMergeBase` is OPEN at exactly the bound head, not a draft, not conflicting, with no failed check, for less than
 * `mergeWaitMaxMin` since the window started; a PR that cannot be read this pass keeps the wait. A bound PR still open
 * that conflicts with its base is `why` instead, whatever its base or the wait: the lane must resolve it, so closing
 * would leave it unmerged. Anything else the supervisor cannot merge as it stands (MERGE_STALLED tells the lead) closes
 * the lane as before.
 */
const boundMergeWait = async (deps: FlowDeps, lane: Lane, start: number): Promise<{ readonly waiting: boolean; readonly why: string[] }> => {
  const waitOver = deps.clock.now() - start >= deps.tunables.mergeWaitMaxMin * 60_000;
  const why: string[] = [];
  let waiting = false;
  for (const bound of lane.claim?.pulls ?? []) {
    const r = await ghJson<WaitView & { readonly baseRefName?: string }>(deps.run, ["gh", "pr", "view", String(bound.number), "-R", bound.repo, "--json", `${WAIT_FIELDS},baseRefName`], "object", { timeoutMs: 20_000 });
    if (!r.ok) { waiting ||= !waitOver; continue; }
    const view = r.value;
    if (view.state === "OPEN" && conflicting(view)) { why.push(`${bound.repo}#${bound.number} conflicts with its base`); continue; }
    if (waitOver || view.state !== "OPEN" || view.baseRefName !== deps.config.ciMergeBase || view.headRefOid !== bound.sha || view.isDraft) continue;
    if (!failedChecks(view).length) waiting = true;
  }
  return { waiting: waiting && !why.length, why };
};

/**
 * Settles a claim whose window ended: closes the lane, or objects. A claim only waiting for the supervisor's merge of
 * its bound PR (mergeWait, boundMergeWait) is kept: undefined, nothing to report, and the next pass settles it again.
 * Returns the line to report and, after a close, the autopilot outcome lines it produced.
 */
const settle = async (deps: FlowDeps, lane: Lane, evidence: string, start: number): Promise<{ readonly line: string; readonly outcomes?: readonly string[] } | undefined> => {
  const read = await readLane(deps, lane, { done: true });
  const blocked = unpushedIn(read.worktrees);
  if (blocked.length) return { line: await objectDone(deps, lane, blocked) };
  const checks = read.checks ?? [];
  const failing = checks.filter((c) => !c.ok);
  // An autopilot lane with no PR closes on its conclusion (not adopted) or its report (completed) instead of its PR.
  const noPr = failing.length ? await noPrClose(deps, lane, checks) : undefined;
  if (failing.length && !noPr) {
    const wait = await mergeWait(deps, lane, failing, start);
    if (wait.waiting) return undefined;
    return { line: await objectDone(deps, lane, [...failing.map((c) => `${c.signal} -> ${c.detail}`), ...wait.why]) };
  }
  if (!noPr) {
    const wait = await boundMergeWait(deps, lane, start);
    if (wait.why.length) return { line: await objectDone(deps, lane, wait.why) };
    if (wait.waiting) return undefined;
  }
  // The close's intent is durable before the lane reads verified-done: a crash from here on resumes it.
  await withOperations(deps, async (store) => {
    const prior = store.get(closeId(lane.key));
    const data = JSON.stringify({ note: `Done: ${evidence}`, force: false, ...noPr });
    if (!prior) plan(store, deps.clock.now(), { lane: lane.key, action: CLOSE_ACTION, target: lane.key, data });
    else if (prior.state !== "planned") store.put({ ...prior, state: "planned", detail: "close planned", data, updatedAt: deps.clock.now() });
  });
  // Only the claim being settled is verified: an objection, pause or newer claim written meanwhile stands.
  const superseded = { status: "" };
  let verified: Lane = lane;
  await deps.registry.update(lane.key, (current) => {
    const fresh = current ?? lane;
    if (statusOf(fresh) !== "done-claimed" || fresh.claim?.at !== lane.claim?.at) { superseded.status = statusOf(fresh); return undefined; }
    const detail = noPr?.notAdopted ? `not adopted, no PR needed: ${noPr.notAdopted.conclusion}` : noPr?.reported ? `completed with no PR, on its report: ${noPr.reported.report}` : "Done signals read back live";
    return (verified = withStatus(fresh, "verified-done", detail, iso(deps.clock)));
  });
  if (superseded.status) {
    await withOperations(deps, async (store) => settleOperation(store, deps.clock.now(), closeId(lane.key), "failed", `superseded: lane is ${superseded.status}`));
    return { line: `LANE_SETTLE_SKIPPED ${lane.key} is now ${superseded.status}; the done claim being settled was superseded, not closed` };
  }
  const result = await closeLane(deps, verified, `Done: ${evidence}`, { pre: { checks }, ...noPr });
  if (!result.closed) {
    const signals = result.lines.filter((l) => l.startsWith("SIGNAL NOT"));
    return { line: await objectDone(deps, (await deps.registry.read(lane.key)) ?? verified, signals.length ? signals : result.lines.filter((l) => l.startsWith("REFUSED"))) };
  }
  return { line: closedEvent(lane.key, `Done: ${evidence}`, result.lines), outcomes: result.lines };
};

const remoteWorktreeNote = (lane: Lane): string =>
  `worktree checks (unpushed/uncommitted) skipped on machine ${lane.machine}: a remote lane closes without them (D10); its worktrees under its runner's worktree root are left to the closed-lane cleanup`;

/** Hands a line over; `id` is its journal id when the line has a stable one (else the supervisor assigns one). */
export type Emit = (line: string, id?: string, meta?: EventMeta) => Promise<void>;

/** The meta of an event about `lane`: its key, thread (when it has one) and cwd (when known). */
export const laneMeta = (lane: Lane): EventMeta => ({
  lane: lane.key,
  ...(lane.thread && lane.thread !== "none" ? { thread: lane.thread } : {}),
  ...(lane.cwd ? { cwd: lane.cwd } : {}),
});

const watchLane = async (deps: FlowDeps, listed: Lane, push: Emit): Promise<void> => {
  const status = statusOf(listed);
  if (status === "closed") {
    for (const line of await closedWorktreeSweep(deps, listed)) await push(line, undefined, laneMeta(listed));
    return;
  }
  // A lane is heard only through its reports (`dori report` or its runner's `lane.report`); its screen is never read for one.
  let lane = listed;
  let claim = lane.claim;
  if (statusOf(lane) !== "done-claimed" || !claim) return;
  // A review lane's claim is the review gate's to take in and close (D7); the done watcher never settles it.
  if (lane.review) return;
  const machine = machineClose(lane);
  if (!claim.emitted) {
    // Enqueued before the emitted mark is saved: a crash in between repeats the announcement instead of losing it
    // (under the same id, so the supervisor journals it once).
    const event = !machine ? claimEventId(lane.key, claim.at) : undefined;
    // A claim that wakes the lead is read once first: a mechanical failure is objected to without waking the lead for it.
    const pre = machine ? undefined : await preverifyClaim(deps, lane);
    if (pre?.reasons.length) {
      await push(await objectDone(deps, lane, pre.reasons), undefined, laneMeta(lane));
      return;
    }
    // A clean claim the supervisor reported to the owner itself reaches the lead as digest; a failed post is said first,
    // and the claim then wakes the lead as before.
    const auto = pre ? await autoReportClaim(deps, lane, claim, pre.clean) : undefined;
    if (auto && "failed" in auto) await push(auto.failed, `auto-report-failed:${lane.key}:${claim.at}`, laneMeta(lane));
    const reported = auto && "message" in auto ? auto.message : undefined;
    const kind = machine ? "LANE_AUTO_CLAIMED" : reported ? "LANE_DONE_AUTO_REPORTED" : "LANE_DONE_CLAIMED";
    await push(claimLine(kind, lane, claim.evidence, pre && (reported ? `${pre.snapshot} report=${reported}` : pre.snapshot)), event, laneMeta(lane));
    const announced = { emitted: true, ...(event ? { event } : {}), ...(reported ? { autoReported: reported } : {}) };
    claim = { ...claim, ...announced };
    lane = { ...lane, claim };
    const at = claim.at;
    await deps.registry.patch(lane.key, (current) => (current.claim?.at === at ? { claim: { ...current.claim, ...announced } } : undefined));
  }
  const start = await windowStart(deps, lane, claim);
  let evidence = claim.evidence;
  if (start === undefined || deps.clock.now() - start < windowMs(deps)) {
    // A merged PR settles the claim: nothing is left to object to, so the lane closes now (its signals still re-read).
    const merged = await mergeConfirmed(deps, lane);
    if (!merged) return;
    evidence = `${claim.evidence} (closed at once: ${merged})`;
  }
  // D11: a pending review holds the lane open (no close, objection or worktree cleanup) until every bound PR is merged.
  if (deps.reviewHold && (await deps.reviewHold(lane)) && "why" in (await laneMerges(deps, lane))) return;
  const settled = await settle(deps, lane, evidence, start ?? deps.clock.now());
  if (settled === undefined) return;
  const line = settled.line;
  // A close whose claim announcement already reached the lead, or whose claim the supervisor reported to the owner, is
  // marked seen-claim. It wakes the lead unless the supervisor finished the lane's task itself or it has none
  // (`seen-claim toodo=done` / `toodo=no-task`, digest).
  const event = claim.event;
  const seen = claim.autoReported !== undefined || (event !== undefined && (!deps.leadDelivered || deps.leadDelivered(event)));
  const marked = seen ? line.replace(/^(LANE_CLOSED \S+ closed)(?= |$)/, "$1 seen-claim") : line;
  // The task follow-up runs before the close is handed over: its tag decides whether the close wakes the lead.
  const finish = marked.startsWith("LANE_CLOSED ") ? await finishClosedTask(deps, lane) : undefined;
  const closed = finish ? marked.replace(/^(LANE_CLOSED \S+ closed(?: seen-claim)?)(?= |$)/, `$1 toodo=${finish.tag}`) : marked;
  await push(machine && closed.startsWith("LANE_CLOSED ") ? `LANE_AUTO_CLOSED ${closed.slice("LANE_CLOSED ".length)}` : closed, undefined, laneMeta(lane));
  for (const extra of finish?.lines ?? []) await push(extra, undefined, laneMeta(lane));
  await pushOutcomes(push, lane, (settled.outcomes ?? []).map((l) => finishedOutcome(l, finish)));
};

const PR_SUBJECT = /^([\w.-]+\/[\w.-]+)#(\d+)(?:@\S+)?$/;

/**
 * The PRs of a closed lane, each read back merged with its merge SHA: the PRs its claim bound and those the supervisor
 * merged or verified merged for it (`merge` / `merge-verify` operations, CI_MERGED / MERGE_VERIFIED). A lane with none,
 * or with one GitHub does not read MERGED with a merge commit, has `why` instead.
 */
export const laneMerges = async (deps: FlowDeps, lane: Lane): Promise<LaneMergeRead> => {
  const pulls = new Map<string, { readonly repo: string; readonly number: number }>();
  for (const p of lane.claim?.pulls ?? []) pulls.set(`${p.repo.toLowerCase()}#${p.number}`, { repo: p.repo, number: p.number });
  const ops = await withOperations(deps, async (store) => store.list({ lane: lane.key }).filter((op) => (op.action === "merge" || op.action === MERGE_VERIFY) && op.state === "verified"));
  for (const op of ops) {
    const m = PR_SUBJECT.exec(op.target);
    if (m?.[1] && m[2]) pulls.set(`${m[1].toLowerCase()}#${m[2]}`, { repo: m[1], number: Number(m[2]) });
  }
  if (!pulls.size) return { why: "no PR of the lane is recorded (no claimed or supervisor-merged PR)" };
  const merges: LaneMerge[] = [];
  for (const { repo, number } of pulls.values()) {
    type MergeView = { readonly state?: string; readonly url?: string; readonly baseRefName?: string; readonly mergeCommit?: { readonly oid?: string } | null };
    const r = await ghJson<MergeView>(deps.run, ["gh", "pr", "view", String(number), "-R", repo, "--json", "state,url,baseRefName,mergeCommit"], "object", { timeoutMs: 20_000 });
    if (!r.ok) return { why: `${repo}#${number} could not be read: ${r.error}` };
    const view = r.value;
    const sha = view.mergeCommit?.oid;
    if (view.state !== "MERGED" || !sha) return { why: `${repo}#${number} reads ${view.state ?? "unknown"}${sha ? "" : " with no merge commit"}` };
    merges.push({ repo, number, url: view.url ?? `https://github.com/${repo}/pull/${number}`, base: view.baseRefName ?? "its base", sha });
  }
  return { merges };
};

/**
 * The report of an autopilot lane with no PR (a repo-less lane, or one closed on its report): the `report.md` its claim
 * installed on the lead host, which completes its task in place of a merge, or why it is not there.
 */
const laneReport = (deps: FlowDeps, lane: Lane): LaneMergeRead => {
  const report = laneReportFile(deps.config.stateDir, lane.key);
  return existsSync(report) ? { report } : { why: `no report of the lane at ${report}` };
};

/** The supervisor's task follow-up of a lane it closed (deps.finishTask), or undefined when it has none to run. */
export const finishClosedTask = async (deps: FlowDeps, lane: Lane): Promise<TaskFinish | undefined> => {
  if (!deps.finishTask) return undefined;
  // The lane is already closed: a throw here would lose its close line, so any failure is the lead's to finish.
  let attempt: Operation | undefined;
  try {
    attempt = await withOperations(deps, async (store) => laneAttempt(store, lane.key));
  } catch (e) {
    return lane.task === undefined ? { tag: "no-task", lines: [] } : { tag: "failed", lines: [notCompletedLine(lane, lane.task, `the launch ledger could not be read: ${e instanceof Error ? e.message : String(e)}`)] };
  }
  // An autopilot lane's task is its launch attempt's, also when the lead launched it without --task.
  const task = lane.task ?? (attempt ? Number(attempt.lane.slice("toodo:".length)) : undefined);
  if (task !== undefined && !Number.isSafeInteger(task)) return { tag: "no-task", lines: [] };
  if (task === undefined) {
    // No task to finish: a merged lane's report still gets the merge fact line (task-finish.ts).
    try {
      return await deps.finishTask(lane, undefined, await laneMerges(deps, lane));
    } catch (e) {
      return { tag: "no-task", lines: [`MERGE_FACT ${lane.key}; report not appended: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  // Finished at an earlier close of the lane (a resumed close): nothing is written or told again.
  const mark = attempt ? toodoMarkOf(attempt) : undefined;
  if (mark !== undefined) return { tag: mark === "done" || mark === "not-adopted" ? mark : "failed", lines: [] };
  let finish: TaskFinish;
  let why: string | undefined;
  try {
    // A lane closed not adopted concludes its task with its conclusion, one closed on its report (or repo-less) completes it
    // on that report; the lane passed in may predate its close receipt.
    const closed = attempt ? ((await deps.registry.read(lane.key)) ?? lane) : undefined;
    const notAdopted = closed ? receiptPath(closed, "notAdopted", "conclusion") : undefined;
    const reported = closed ? receiptPath(closed, "reported", "report") !== undefined : false;
    // With no merge (or no report) read back the finisher completes nothing; it only reads whether the task is already done.
    finish = await deps.finishTask(lane, task, notAdopted ? { notAdopted } : attempt && (reported || !doneRepos(lane.done).length) ? laneReport(deps, lane) : await laneMerges(deps, lane));
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
    finish = { tag: "failed", lines: [notCompletedLine(lane, task, why)] };
  }
  if (!attempt) return finish;
  // An autopilot task left unfinished: its blocker is recorded and its one failure line (TOODO_TASK_NOT_COMPLETED) says so.
  const done = taskCompleted(finish);
  // The finisher says why in its TOODO_TASK_NOT_COMPLETED line; the note keeps only the reason.
  const reason = why ?? (finish.lines[0] ?? finish.tag).replace(/^TOODO_TASK_NOT_COMPLETED \S+ #\d+ /, "").replace(/; finish it yourself .*$/, "");
  const said = !done && deps.blockTask ? await deps.blockTask(lane, task, reason) : undefined;
  const marked = done ? (finish.tag === "not-adopted" ? "not-adopted" : "done") : said?.startsWith("blocker recorded") ? "blocked" : "failed";
  let unmarked: string | undefined;
  try { await withOperations(deps, async (store) => markLaneToodo(store, deps.clock.now(), lane.key, marked)); } catch (e) {
    unmarked = `launch attempt not marked ${marked}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const extra = [said, unmarked].filter((s): s is string => s !== undefined);
  if (!extra.length) return finish;
  return { ...finish, lines: finish.lines.map((l, i) => (i === 0 ? `${l}; ${extra.join("; ")}` : l)) };
};

/**
 * Why a done-claimed lane's PR counts as merged, or undefined: the supervisor merged it (a verified
 * `merge` operation of the lane, its CI_MERGED), a `merged` Done signal's PR reads MERGED, or GitHub reports a PR merged
 * into `ciMergeBase` from a lane worktree's branch at exactly that worktree's HEAD. A remote lane has only the first
 * two: its worktrees are not read from here (D10), while the operation ledger and `gh` are the lead host's own.
 */
export const mergeConfirmed = async (deps: FlowDeps, lane: Lane): Promise<string | undefined> => {
  const op = await withOperations(deps, async (store) => store.list({ lane: lane.key }).find((o) => o.action === "merge" && o.state === "verified"));
  if (op) return `CI_MERGED ${op.target}`;
  const signalled = (await readBindings(lane.done, deps.run)).find((b) => !("error" in b));
  if (signalled) return `${signalled.repo}#${signalled.n} merged`;
  if (lane.machine) return undefined;
  const read = await readLane(deps, lane);
  const cwd = await cwdWorktree(deps, lane, read, false);
  const { atHead } = await readBranchBindings(deps.run, [...(cwd ? [cwd] : []), ...read.worktrees], deps.config.ciMergeBase);
  const pr = atHead[0];
  return pr ? `${pr.repo}#${pr.n} merged into ${pr.base} at ${pr.sha.slice(0, 10)}` : undefined;
};

/** Why a lane's work is already finished (every Done signal reads back live, or its PR is confirmed merged), or undefined. */
export const finishedReason = async (deps: FlowDeps, lane: Lane): Promise<string | undefined> => {
  const checks = (await readLane(deps, lane, { done: true })).checks ?? [];
  if (checks.length > 0 && checks.every((c) => c.ok)) return "every Done signal holds";
  return mergeConfirmed(deps, lane);
};

/**
 * When a claim's objection window starts, or undefined while the lead has not received it yet. For a machine-closed
 * lane, or a claim announced by an older dori (no event id), it is the claim itself. Otherwise it
 * is the first watcher pass that reads the announcement delivered, recorded on the claim so a restart keeps it.
 */
const windowStart = async (deps: FlowDeps, lane: Lane, claim: NonNullable<Lane["claim"]>): Promise<number | undefined> => {
  if (!claim.event) return Date.parse(claim.at);
  if (claim.deliveredAt) return Date.parse(claim.deliveredAt);
  // Only a claim that wakes the lead (the default) waits for its delivery; a digest one or one the policy keeps from
  // the lead is settled by the supervisor, so handing it over counts.
  if (claimWaitsForLead(deps, lane, claim) && deps.leadDelivered && !deps.leadDelivered(claim.event)) return undefined;
  const at = iso(deps.clock);
  await deps.registry.patch(lane.key, (current) => (current.claim?.at === claim.at ? { claim: { ...current.claim, deliveredAt: at } } : undefined));
  return Date.parse(at);
};

/**
 * One pass over every lane. With `emit`, each line is handed over the moment it exists (the supervisor enqueues it
 * durably); the lines are also returned. One lane's failure is a LANE_WATCH_WARN line and never stops the others.
 * `archived: false` skips the closed lanes in the archive (their worktree cleanup), so a pass reads open lanes only,
 * plus, with `pending`, the closed lanes whose queued cleanup is still to do (PendingCleanup), each read by key.
 * A lane whose machine is not `admitted` (its runner has no admitted connection) is skipped without a line, and so is a
 * lane whose runner dropped its connection during the pass: the supervisor's RUNNER_UNAVAILABLE line reports that outage.
 */
export const watchTick = async (
  deps: FlowDeps, emit?: Emit, archived = true, admitted: (machine?: string) => boolean = () => true, pending?: PendingCleanup,
): Promise<string[]> => {
  const out: string[] = [];
  const push: Emit = async (line, id, meta) => {
    if (emit) await (meta ? emit(line, id, meta) : emit(line, id));
    out.push(line);
  };
  try {
    await resumeOperations(deps, push);
  } catch (e) {
    await push(`LANE_WATCH_WARN operations ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  let lanes = archived ? await deps.registry.list() : await deps.registry.open();
  if (pending) {
    const openKeys = new Set(lanes.filter((l) => statusOf(l) !== "closed").map((l) => l.key));
    if (!archived) {
      const closedSince = [...(pending.open ?? [])].filter((k) => !openKeys.has(k));
      const keys = [...new Set([...pending.keys, ...closedSince])].filter((k) => !openKeys.has(k));
      const read = await Promise.all(keys.map((k) => deps.registry.read(k)));
      lanes = [...lanes, ...read.filter((l): l is Lane => l !== null && cleanupPending(deps, l))];
      for (const k of keys) if (!lanes.some((l) => l.key === k)) pending.keys.delete(k);
    }
    pending.open = openKeys;
  }
  for (const listed of lanes) {
    const queued = pending !== undefined && cleanupPending(deps, listed);
    if (queued) pending.keys.add(listed.key);
    if (!admitted(listed.machine)) continue;
    try {
      await watchLane(deps, listed, push);
      // Only a lane that had queued cleanup can settle it; the pass's copy is stale, so the registry is read again.
      if (queued) {
        const after = await deps.registry.read(listed.key);
        if (!after || !cleanupPending(deps, after)) pending.keys.delete(listed.key);
      }
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === "RUNNER_UNAVAILABLE" && !admitted(listed.machine)) continue;
      await push(`LANE_WATCH_WARN ${listed.key} ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  return out;
};
