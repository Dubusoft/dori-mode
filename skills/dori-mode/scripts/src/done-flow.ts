import { join } from "node:path";

import type { DoriConfig } from "./config.ts";
import { githubTargets } from "./github-events.ts";
import { type ClaimedPull, type Lane, type Registry, statusOf, withStatus } from "./registry.ts";
import { type Clock, iso, type Ran, type Runner } from "./run.ts";
import { OPEN_STATES, openOperations, type Operation, operationId, type OperationState, type OperationStore, perform, plan, type ReadBack, settleOperation } from "./operations.ts";
import { acquireStateLock, StateLockError, tryStateLock } from "./state-lock.ts";
import { type Check, parseSignal, type SignalIo } from "./signals.ts";
import { BRANCH_DELETE, type BranchPlan, deleteBranch, planBranchCleanup, readBindings, readBranchBindings, type WorktreeFact } from "./branch-cleanup.ts";
import { eventClass } from "./event-policy.ts";
import type { EventMeta } from "./supervise-journal.ts";
import { LaneOpsError, type LaneOps, machineRunner, type PaneRef } from "./lane-ops.ts";
import { runnerWorktreeRoot } from "./runner/hub.ts";
import { deliverLaneMessage, MERGE_VERIFY, queueSteering } from "./ci-follow.ts";
import { blockedOutcome, finishedOutcome, type LaneMerge, notCompletedLine, type TaskBlocker, taskCompleted, type TaskFinish, type TaskFinisher } from "./task-finish.ts";
import { openLaneMessages } from "./lane-messages.ts";
import { checkLaneReportText, installLaneReports, LaneFileError, validateLaneOutput, verifyLaneFileReceipt } from "./lane-files.ts";
import type { LaneFileReceipt } from "./runner/protocol.ts";
import type { Tunables } from "./tunables.ts";
import { isLaneOutcomeLine, LANE_FAILED_EVENT, laneAttempt, laneOutcomeEventId, markLaneToodo, settleLaneOutcome, toodoMarkOf } from "./autopilot.ts";

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

/** What the lane's runner read of a lane's checkout: its worktrees, Done checks, and where its git ran (design A17, D10). */
type LaneRead = {
  /** The lane's worktrees (found by the runner by key, and those the registry recorded); none for a remote lane. */
  readonly worktrees: readonly WorktreeFact[];
  /** The Done checks, when asked: in the lane's cwd, or in leadCwd for a remote lane or a gone cwd (on the local runner). */
  readonly checks?: readonly Check[];
  /** A local lane's cwd is set and no longer exists. */
  readonly cwdGone: boolean;
  /** Where a local lane's git runs: its cwd, else leadCwd. */
  readonly root: string;
};

const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() ?? "";
const named = (key: string, name: string): boolean => name === key || name.startsWith(`${key}-`);

/**
 * One worktree's git facts (branch, HEAD, dirty, ahead) and its checkout's origin, read by the lane's runner. The
 * runner finds worktrees by name, so the path is inspected under its own directory name, listed from `<path>/.` (a
 * root the listing does not skip). Undefined when git does not list it as a worktree.
 */
const probeWorktree = async (deps: FlowDeps, lane: Lane, path: string): Promise<WorktreeFact | undefined> => {
  const inspection = await deps.ops.inspect({ ...lane, key: baseName(path) }, { git: true, cwd: `${path}/.` });
  const hit = inspection.git?.worktrees.find((w) => w.path === path);
  return hit ? { ...hit, ...(inspection.git?.origin ? { origin: inspection.git.origin } : {}) } : undefined;
};

/**
 * Reads a lane through its runner: one `q.lane.inspect` (git facts, and the Done checks when `done`), then each worktree
 * the registry recorded or the runner found by key, read one by one (the runner cannot see the registry). A remote
 * lane's worktrees are never read (D10); its Done checks run on the local runner in leadCwd. Throws LaneOpsError when
 * the runner cannot answer.
 */
const readLane = async (deps: FlowDeps, lane: Lane, want: { readonly done?: boolean } = {}): Promise<LaneRead> => {
  const done = want.done ? { done: lane.done, doneCwd: deps.config.leadCwd } : {};
  if (lane.machine) {
    const checks = want.done ? (await deps.ops.inspect(lane, done)).done?.checks : undefined;
    return { worktrees: [], ...(checks ? { checks } : {}), cwdGone: false, root: deps.config.leadCwd };
  }
  const inspection = await deps.ops.inspect(lane, { git: true, roots: [deps.config.leadCwd], ...done });
  const cwdGone = Boolean(lane.cwd) && !inspection.cwdExists;
  const listed = (inspection.git?.worktrees ?? []).filter((w) => named(lane.key, baseName(w.path)) || named(lane.key, (w.branch ?? "").split("/").pop() ?? ""));
  const paths = [...new Set([...listed.map((w) => w.path), ...(lane.worktrees ?? []).map((p) => p.replace(/\/+$/, ""))])];
  const present = paths.length ? await deps.ops.exists(undefined, paths) : [];
  const worktrees: WorktreeFact[] = [];
  for (const [i, path] of paths.entries()) {
    if (!present[i]) { worktrees.push({ path, exists: false }); continue; }
    worktrees.push((await probeWorktree(deps, lane, path)) ?? listed.find((w) => w.path === path) ?? { path, exists: true, error: "git lists no worktree there" });
  }
  const checks = inspection.done?.checks;
  return { worktrees, ...(checks ? { checks } : {}), cwdGone, root: lane.cwd && !cwdGone ? lane.cwd : deps.config.leadCwd };
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
export const eventText = (text: string): string => text.length > EVENT_TEXT_MAX ? `${text.slice(0, EVENT_TEXT_MAX - 1)}…` : text;

/** A GitHub pull request URL. */
const PULL_URL = /https:\/\/\S+\/pull\/\d+/;

/**
 * The fixed close event: no receipt (the registry keeps it). The first PR URL the close note or a Done signal names is
 * kept, so the lead sees which PR the lane closed with.
 */
const closedEvent = (key: string, note: string, lines: readonly string[]): string => {
  const pr = [note, ...lines.filter((l) => l.startsWith("SIGNAL "))].map((t) => PULL_URL.exec(t)?.[0]).find(Boolean);
  return `LANE_CLOSED ${key} closed${pr ? ` ${pr}` : ""}`;
};

/** A lane that claims and closes with no lead wake: its brief declared `autoClose: machine`. */
const machineClose = (lane: Lane): boolean => lane.autoClose === "machine";

/**
 * Whether the claim's window waits for the lead to receive it: when the policy makes LANE_DONE_CLAIMED wake the lead
 * (the default), so the later close finds the claim delivered and is marked seen-claim. A policy that makes the claim
 * digest leaves it to the supervisor (live re-check, then close or LANE_NOT_DONE), so the window runs from the hand-over.
 */
const claimWaitsForLead = (deps: FlowDeps, lane: Lane): boolean =>
  !machineClose(lane) && eventClass(`LANE_DONE_CLAIMED ${lane.key}`, deps.tunables.eventPolicy) === "lead-urgent";

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
  const read = async (repo: string, argv: readonly string[]): Promise<void> => {
    const r = await run([...argv], { timeoutMs: 20_000 });
    try {
      if (r.code !== 0) throw new Error(`exit ${r.code}: ${(r.err || r.out).trim().slice(0, 160)}`);
      const body: unknown = JSON.parse(r.out);
      for (const row of Array.isArray(body) ? body : [body]) if (row && typeof row === "object") add(repo, row as PrRow);
    } catch (e) {
      console.error(`CLAIM_PR_UNREAD ${lane.key} ${argv.slice(0, 4).join(" ")} ${repo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  for (const [repo, targets] of await githubTargets([lane], ops)) {
    for (const n of targets.numbers) await read(repo, ["gh", "pr", "view", String(n), "-R", repo, "--json", PR_ROW_FIELDS]);
    for (const branch of targets.branches) await read(repo, ["gh", "pr", "list", "-R", repo, "--state", "open", "--head", branch, "--json", PR_ROW_FIELDS]);
  }
  return [...found.values()];
};

export const claimDone = async (deps: FlowDeps, lane: Lane, evidence: string, fileReceipt?: LaneFileReceipt): Promise<string> => {
  const active = await deps.registry.read(lane.key);
  if (lane.fileRun && !active?.fileRun) throw new LaneFileError("LANE_REPORT_STALE", lane.key, "the report belongs to an older lane run; claim done again from the current lane");
  if (active?.fileRun) {
    checkLaneReportText(lane.key, "", evidence);
    if (active.closedAt) throw new LaneFileError("LANE_REPORT_STALE", lane.key, "the report belongs to an older lane run; claim done again from the current lane");
    const options = { now: deps.clock.now, checkCurrent: () => deps.registry.read(lane.key),
      emit: deps.fileNote ?? ((_id: string, line: string) => console.error(line)) };
    if (!fileReceipt) {
      const snapshot = await deps.ops.files(active);
      if (!snapshot) throw new LaneFileError("LANE_REPORT_FILES_MISSING", lane.key, "this managed lane's done report has no file snapshot; claim done again through its runner");
      validateLaneOutput(lane.key, snapshot, active.fileRun);
      fileReceipt = await installLaneReports(deps.config.stateDir, lane.key, snapshot, options);
    }
    lane = active;
  } else if (fileReceipt) {
    throw new LaneFileError("LANE_REPORT_STALE", lane.key, "the report belongs to an older lane run; claim done again from the current lane");
  }
  const admit = async (): Promise<string> => {
  // A repeated claim with the same evidence is the claim already recorded: it keeps that claim (and its single
  // LANE_DONE_CLAIMED, its window and its PR bindings) instead of re-issuing it and waking the lead again.
  const recorded = await deps.registry.read(lane.key);
  if (fileReceipt && (!recorded || recorded.closedAt || recorded.fileRun?.id !== fileReceipt.run.id))
    throw new LaneFileError("LANE_REPORT_STALE", lane.key, "the report belongs to an older lane run; claim done again from the current lane");
  const status = recorded ? statusOf(recorded) : undefined;
  if (recorded?.claim && (status === "done-claimed" || status === "verified-done") && recorded.claim.evidence === evidence) {
    return `LANE_DONE_ALREADY_CLAIMED ${lane.key} ${recorded.claim.at} ${eventText(evidence)}`;
  }
  const pulls = await claimBindings(deps.run, deps.ops, lane);
  const at = iso(deps.clock);
  await deps.registry.update(lane.key, (current) => {
    if (fileReceipt && (!current || current.closedAt || current.fileRun?.id !== fileReceipt.run.id))
      throw new LaneFileError("LANE_REPORT_STALE", lane.key, "the report belongs to an older lane run; claim done again from the current lane");
    return withStatus(current ?? lane, "done-claimed", evidence, at, { claim: { at, evidence, emitted: false, pulls } });
  });
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
    now: deps.clock.now, checkCurrent: () => deps.registry.read(lane.key),
    emit: deps.fileNote ?? ((_id, line) => console.error(line)),
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
  await deps.registry.update(lane.key, (current) => withStatus(current ?? lane, "not-done", reasons.join("; "), at, { objection: { at, reasons } }));
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
  /** `dori close --force`: close despite unpushed/uncommitted work; a worktree git refuses to remove is kept, as before. */
  readonly force?: boolean;
  /**
   * `dori close --cancelled --reason`: the owner cancelled the work or its Done can never hold. The Done signals are not
   * checked; the worktree checks and cleanup run as usual, and the close is recorded with the reason as cancelled.
   */
  readonly cancelled?: { readonly reason: string };
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

const withOperations = async <T>(deps: FlowDeps, body: (store: OperationStore) => Promise<T>): Promise<T> => {
  const store = deps.operations ?? openOperations(deps.config);
  try { return await body(store); } finally { if (!deps.operations) store.close(); }
};

/** One effect's result for the close sequence: `err`/`out` are the effect's own output when it ran (today's receipt text). */
type Step = { readonly state: OperationState; readonly err: string; readonly out: string; readonly id?: string; readonly detail?: string };
type Act = (action: string, target: string, effect: (cmdId: string) => Promise<Ran>, readBack: ReadBack) => Promise<Step>;

/**
 * The effect runs at most once per verified operation, and a read-back decides (operations.ts). Its runner command id is
 * `op:<operation id>:<attempt>`: the runner answers a repeated command id with its first result, so a retry of a failed
 * operation (a worktree cleaned since) needs its own.
 */
const actRecorded = (deps: FlowDeps, store: OperationStore, lane: Lane): Act => async (action, target, effect, readBack) => {
  let ran: Ran | undefined;
  const id = operationId({ lane: lane.key, action, target });
  const { op } = await perform(store, deps.clock.now, { lane: lane.key, action, target }, async () => {
    ran = await effect(`op:${id}:${store.get(id)?.attempts ?? 0}`);
    return { ok: ran.code === 0, detail: ran.code === 0 ? "" : ran.err || ran.out };
  }, readBack);
  return { state: op.state, err: ran?.err ?? op.detail, out: ran?.out ?? "", id: op.id, detail: op.detail };
};

/** Gone from the pane list of the lane's machine (its runner's) is done; listed is not; an unreadable list cannot tell. */
const paneGone = (deps: FlowDeps, lane: Lane, match: (pane: { readonly pane_id: string; readonly tab_id?: string }) => boolean): ReadBack => async () =>
  (await deps.ops.panes(lane.machine)).some(match) ? "not-done" : "done";

/** The lane's runner closes its tab (else its pane), `lane.close`; a refusal or an ambiguous answer is data for the read-back. */
const closeEffect = (deps: FlowDeps, lane: Lane) => async (cmdId: string): Promise<Ran> => {
  try {
    const r = await deps.ops.close(lane, { cmdId });
    return r.gone ? { code: 0, out: `closed ${r.closed}`, err: "" } : { code: 1, out: "", err: `still listed after closing ${r.closed}` };
  } catch (e) {
    if (e instanceof LaneOpsError) return { code: 1, out: "", err: e.message };
    throw e;
  }
};

/**
 * Close a lane: every Done signal must read back live, and (unless `force`) no worktree may hold unpushed, uncommitted
 * or untracked work. Worktrees are removed before the pane closes, so a failed removal leaves the lane and its pane up.
 * The thread is marked done only when no other open lane works in it.
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
      const data = JSON.stringify({ note, force: Boolean(opts.force), ...(opts.cancelled ? { cancelled: opts.cancelled } : {}) });
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
  ];
  if (checks.some((c) => !c.ok)) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: a Done signal is not live (to give the lane up: dori close ${lane.key} --cancelled --reason TEXT)`] };
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
  if (lane.machine) cleanup.push(remoteWorktreeNote(lane), ...(await remoteWorktrees(deps, lane)));
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
    const step = await act("worktree-remove", wt, (cmdId) => deps.ops.git(lane, { op: "worktree-remove", root, path: wt }, { cmdId }),
      async () => ((await deps.ops.exists(lane.machine, [wt]))[0] ? "not-done" : "done"));
    if (step.state === "ambiguous") return ambiguous(step);
    // The lane's cwd was never checked for unpushed work: git refuses to remove it dirty, and it is kept, not a refusal.
    if (step.state !== "verified" && !opts.force && !adopted.has(wt)) {
      return { closed: false, lines: [...lines, ...cleanup, `REFUSED ${lane.key}: worktree ${wt} not removed: ${(step.err || step.out).slice(0, 120)}; the pane is left open (dori close --force keeps the worktree and closes)`] };
    }
    cleanup.push(step.state === "verified" ? `worktree ${wt} removed` : `worktree ${wt} kept: ${step.err.slice(0, 120)}`);
  }
  if (branches?.targets.length) {
    const others = (await deps.registry.open()).filter((l) => l.key !== lane.key);
    for (const target of branches.targets) {
      const r = await deleteBranch(deps.ops, lane, act, target, others, [...present, ...(candidate ? [candidate] : [])]);
      if (r.remoteStep?.state === "ambiguous") return ambiguous(r.remoteStep);
      if (r.step?.state === "ambiguous") return ambiguous(r.step);
      if (r.kept && r.step === undefined) settleOperation(store, deps.clock.now(), operationId({ lane: lane.key, action: BRANCH_DELETE, target: `${target.repo}#${target.n}@${target.sha}` }), "failed", `kept: ${r.kept}`);
      if (r.remoteLine) cleanup.push(r.remoteLine);
      cleanup.push(r.line);
    }
  }
  // The lane's thread stays open: only the owner closes it, with the button on the lead's report.
  if (lane.tab) {
    const tab = lane.tab;
    const step = await act("tab-close", tab, closeEffect(deps, lane), paneGone(deps, lane, (p) => p.tab_id === tab));
    if (step.state === "ambiguous") return ambiguous(step);
    cleanup.push(step.state === "verified" ? `tab ${tab} closed` : `tab ${tab} not closed`);
  } else if (lane.pane) {
    const pane = lane.pane;
    const step = await act("pane-close", pane, closeEffect(deps, lane), paneGone(deps, lane, (p) => p.pane_id === pane));
    if (step.state === "ambiguous") return ambiguous(step);
    cleanup.push(step.state === "verified" ? `pane ${pane} closed` : `pane ${pane} not closed`);
  } else if (lane.runner) {
    // No pane yet: a start may still be out (a cancelled reservation). lane.close by key stops a lane the runner
    // already recorded; a start that lands after the close is stopped by the supervisor (LANE_STARTED_AFTER_CLOSE).
    const r = await closeEffect(deps, lane)(`close-by-key:${lane.key}:${deps.clock.now()}`);
    cleanup.push(r.code === 0 ? `runner lane ${lane.key} ${r.out}` : `runner lane ${lane.key} not closed: ${r.err.slice(0, 120)}`);
  }
  const at = iso(deps.clock);
  const operations = store.list({ lane: lane.key }).filter((op) => op.action !== CLOSE_ACTION).map((op) => ({ id: op.id, state: op.state }));
  const receipt = { checks, note, cleanup, ...(cancelled ? { cancelled } : {}), ...(lane.machine ? { worktreeCheck: { status: "skipped", detail: remoteWorktreeNote(lane) } } : {}), operations };
  await deps.registry.update(lane.key, (current) => withStatus(current ?? lane, "closed", note, at, { closedAt: at, receipt }));
  return { closed: true, lines: [...lines, ...(lane.machine ? [`WORKTREE_CHECK SKIPPED ${lane.key}: ${remoteWorktreeNote(lane)}`] : []), `CLOSED ${lane.key}${cancelled ? " cancelled" : ""}`] };
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
    const { note, force, cancelled } = JSON.parse(op.data ?? "{}") as { note?: string; force?: boolean; cancelled?: { reason: string } };
    const result = await closeLane(deps, lane, note ?? "closed after an interrupted close", { force: Boolean(force), ...(cancelled ? { cancelled } : {}) });
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
  readonly statusCheckRollup?: readonly { readonly __typename?: string; readonly status?: string; readonly conclusion?: string; readonly state?: string }[];
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
    const r = await deps.run(["gh", "pr", "view", s.n, "-R", s.repo, "--json", WAIT_FIELDS], { timeoutMs: 20_000 });
    let view: WaitView | undefined;
    try { view = r.code === 0 ? (JSON.parse(r.out) as WaitView) : undefined; } catch { view = undefined; }
    if (!view) continue;
    const failed = (view.statusCheckRollup ?? []).filter((c) => c.__typename === "StatusContext" ? c.state === "FAILURE" || c.state === "ERROR" : c.status === "COMPLETED" && CHECK_FAILED.has(c.conclusion ?? ""));
    if (view.state !== "OPEN") why.push(`${ref} is ${view.state ?? "unknown"}`);
    else if (view.headRefOid !== bound.sha) why.push(`${ref} head moved to ${(view.headRefOid ?? "unknown").slice(0, 10)} after the claim at ${bound.sha.slice(0, 10)} (claim again)`);
    else if (view.isDraft) why.push(`${ref} is a draft, which the supervisor never merges`);
    else if (view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY") why.push(`${ref} conflicts with its base`);
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
 * `mergeWaitMaxMin` since the window started; a PR that cannot be read this pass keeps the wait. Anything the
 * supervisor cannot merge as it stands (MERGE_STALLED tells the lead) closes the lane as before.
 */
const boundMergeWait = async (deps: FlowDeps, lane: Lane, start: number): Promise<boolean> => {
  if (deps.clock.now() - start >= deps.tunables.mergeWaitMaxMin * 60_000) return false;
  for (const bound of lane.claim?.pulls ?? []) {
    const r = await deps.run(["gh", "pr", "view", String(bound.number), "-R", bound.repo, "--json", `${WAIT_FIELDS},baseRefName`], { timeoutMs: 20_000 });
    let view: (WaitView & { readonly baseRefName?: string }) | undefined;
    try { view = r.code === 0 ? (JSON.parse(r.out) as WaitView & { readonly baseRefName?: string }) : undefined; } catch { view = undefined; }
    if (!view) return true;
    if (view.state !== "OPEN" || view.baseRefName !== deps.config.ciMergeBase || view.headRefOid !== bound.sha || view.isDraft) continue;
    if (view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY") continue;
    const failed = (view.statusCheckRollup ?? []).some((c) => c.__typename === "StatusContext" ? c.state === "FAILURE" || c.state === "ERROR" : c.status === "COMPLETED" && CHECK_FAILED.has(c.conclusion ?? ""));
    if (!failed) return true;
  }
  return false;
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
  if (failing.length) {
    const wait = await mergeWait(deps, lane, failing, start);
    if (wait.waiting) return undefined;
    return { line: await objectDone(deps, lane, [...failing.map((c) => `${c.signal} -> ${c.detail}`), ...wait.why]) };
  }
  if (await boundMergeWait(deps, lane, start)) return undefined;
  // The close's intent is durable before the lane reads verified-done: a crash from here on resumes it.
  await withOperations(deps, async (store) => {
    const prior = store.get(closeId(lane.key));
    const data = JSON.stringify({ note: `Done: ${evidence}`, force: false });
    if (!prior) plan(store, deps.clock.now(), { lane: lane.key, action: CLOSE_ACTION, target: lane.key, data });
    else if (prior.state !== "planned") store.put({ ...prior, state: "planned", detail: "close planned", data, updatedAt: deps.clock.now() });
  });
  // Only the claim being settled is verified: an objection, pause or newer claim written meanwhile stands.
  const superseded = { status: "" };
  let verified: Lane = lane;
  await deps.registry.update(lane.key, (current) => {
    const fresh = current ?? lane;
    if (statusOf(fresh) !== "done-claimed" || fresh.claim?.at !== lane.claim?.at) { superseded.status = statusOf(fresh); return undefined; }
    return (verified = withStatus(fresh, "verified-done", "Done signals read back live", iso(deps.clock)));
  });
  if (superseded.status) {
    await withOperations(deps, async (store) => settleOperation(store, deps.clock.now(), closeId(lane.key), "failed", `superseded: lane is ${superseded.status}`));
    return { line: `LANE_SETTLE_SKIPPED ${lane.key} is now ${superseded.status}; the done claim being settled was superseded, not closed` };
  }
  const result = await closeLane(deps, verified, `Done: ${evidence}`, { pre: { checks } });
  if (!result.closed) {
    const signals = result.lines.filter((l) => l.startsWith("SIGNAL NOT"));
    return { line: await objectDone(deps, (await deps.registry.read(lane.key)) ?? verified, signals.length ? signals : result.lines.filter((l) => l.startsWith("REFUSED"))) };
  }
  return { line: closedEvent(lane.key, `Done: ${evidence}`, result.lines), outcomes: result.lines };
};

const remoteWorktreeNote = (lane: Lane): string =>
  `worktree checks (unpushed/uncommitted) skipped on machine ${lane.machine}: a remote lane closes without them (D10); its worktrees under its runner's worktree root are left to the closed-lane cleanup`;

/** The worktree root a lane's cleanup may remove under: its runner's reported root, else (local lanes only) `config.worktreeRoot`. */
const cleanupRoot = (deps: FlowDeps, lane: Lane): string => {
  const reported = (deps.runnerWorktreeRoot ?? ((label) => runnerWorktreeRoot(deps.config.stateDir, label)))(machineRunner(lane.machine));
  return (reported || (lane.machine ? "" : deps.config.worktreeRoot)).replace(/\/+$/, "");
};

const under = (root: string, path: string): boolean => Boolean(root) && path.startsWith(`${root}/`) && !path.includes("..");

/**
 * The receipt lines of a remote lane's worktrees, found by its runner by key under its reported worktree root: each
 * `worktree <path> kept: ...`, so closedWorktreeSweep removes it once it is clean and pushed. A runner that cannot
 * answer never holds the close up.
 */
const remoteWorktrees = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const root = cleanupRoot(deps, lane);
  if (!root) return [];
  let found: readonly { readonly path: string }[];
  try {
    found = (await deps.ops.inspect(lane, { git: true })).git?.worktrees ?? [];
  } catch (e) {
    return [`remote worktrees not read on machine ${lane.machine}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`];
  }
  return [...new Set(found.map((w) => w.path.replace(/\/+$/, "")))].filter((p) => under(root, p))
    .map((p) => `worktree ${p} kept: remote lane, removed by the closed-lane cleanup once clean and pushed`);
};

/**
 * Worktrees a lane's close had to keep (`<prefix><path> kept: ...` in its receipt): with `worktree `, usually because
 * they were dirty then; with `branch-bound worktree `, held with a branch that moved past its merged head.
 */
const keptWorktrees = (lane: Lane, prefix = "worktree "): string[] => {
  const receipt = lane.receipt;
  if (typeof receipt !== "object" || receipt === null || !("cleanup" in receipt) || !Array.isArray(receipt.cleanup)) return [];
  return receipt.cleanup.flatMap((line: unknown) => {
    if (typeof line !== "string" || !line.startsWith(prefix)) return [];
    const end = line.indexOf(" kept: ");
    return end > prefix.length ? [line.slice(prefix.length, end)] : [];
  });
};

/**
 * Finish a closed lane's worktree cleanup: a worktree its close kept is removed once it is clean, only under
 * the lane's runner's reported worktree root, or (local lanes) `config.worktreeRoot` while that runner has reported
 * none. A remote lane's worktree, never checked for unpushed work at its close, also needs no commit that no remote
 * has. The lane's own cwd and the worktrees its record lists are candidates too, on the same terms plus no commit that
 * no remote has: a close that did not find them (a `<repo>-<key>` directory, a detached HEAD) left no kept line; one the
 * close held with its branch (`branch-bound worktree ... kept`) stays. Open
 * lanes (working, not-done, paused, done-claimed) are never touched, nor any path an open lane uses: their Done signals
 * have not all read back yet, and work can continue after a merge. Failures come back as LANE_WATCH_WARN lines.
 */
export const closedWorktreeSweep = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  if (statusOf(lane) !== "closed") return [];
  const root = cleanupRoot(deps, lane);
  const kept = keptWorktrees(lane).filter((wt) => under(root, wt));
  const own = [...new Set([...(lane.cwd ? [lane.cwd] : []), ...(lane.worktrees ?? [])].map((p) => p.replace(/\/+$/, "")))]
    .filter((p) => under(root, p) && !kept.includes(p) && !keptWorktrees(lane, "branch-bound worktree ").includes(p));
  if (!kept.length && !own.length) return [];
  const [cwdThere = false, ...present] = lane.machine
    ? [false, ...(await deps.ops.exists(lane.machine, [...kept, ...own]))]
    : await deps.ops.exists(undefined, [lane.cwd ?? deps.config.leadCwd, ...kept, ...own]);
  const candidates = [...kept, ...own].filter((_, i) => present[i]);
  if (!candidates.length) return [];
  const busy = new Set([deps.config.leadCwd, ...(await deps.registry.open()).flatMap((l) => [...(l.cwd ? [l.cwd] : []), ...(l.worktrees ?? [])])]
    .map((p) => p.replace(/\/+$/, "")));
  const repo = lane.cwd && cwdThere ? lane.cwd : deps.config.leadCwd;
  const removed: string[] = [];
  const out: string[] = [];
  for (const wt of candidates) {
    if (busy.has(wt)) continue;
    const recorded = own.includes(wt);
    const fact = await probeWorktree(deps, lane, wt);
    if (!fact || fact.error !== undefined || fact.dirty === undefined) out.push(`LANE_WATCH_WARN ${lane.key} cannot read git status of ${wt}: ${(fact?.error ?? "git lists no worktree there").slice(0, 160)}`);
    else if (fact.dirty || ((lane.machine || recorded) && fact.ahead !== 0)) continue;
    else {
      // A remote worktree, and one found from the lane's record, is removed from inside itself: its repository is not known here.
      const r = await deps.ops.git(lane, { op: "worktree-remove", root: lane.machine || recorded ? wt : repo, path: wt });
      if (r.code === 0) removed.push(wt);
      else out.push(`LANE_WATCH_WARN ${lane.key} worktree ${wt} not removed: ${(r.err || r.out).slice(0, 160)}`);
    }
  }
  return removed.length ? [`WORKTREE_CLEANED ${lane.key} ${removed.join(" ")}`, ...out] : out;
};

/**
 * The lane this process runs inside, or undefined for the lead. `dori launch` sets DORI_LANE_KEY in a local lane's
 * pane; a pane registered to an open lane (HERDR_PANE_ID) counts as that lane too, so unsetting the variable is not
 * enough. The lead pane (config.leadPane) is never a lane.
 */
export const callerLane = async (deps: Pick<FlowDeps, "registry" | "config">, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | undefined> => {
  const key = env.DORI_LANE_KEY?.trim();
  if (key) return key;
  const pane = env.HERDR_PANE_ID?.trim();
  if (!pane || pane === deps.config.leadPane) return undefined;
  return (await deps.registry.byPane(pane))?.key;
};

/** Why a lane may not run `command` on lane `target`, or undefined when it may (the lead always may). */
export const laneActRefusal = (caller: string | undefined, command: string, target: string): string | undefined =>
  caller === undefined || caller === target ? undefined : `LANE_PERMISSION_DENIED lane ${caller} may not ${command} lane ${target}; only its own key (the lead can act on any lane)`;

/**
 * Why `caller` may not run `dori send`, or undefined for the lead. Only the lead talks to the owner: a lane, even in its
 * own work thread, asks through `dori report <key> question` and the lead relays the answer.
 */
export const laneSendRefusal = (caller: string | undefined): string | undefined =>
  caller === undefined
    ? undefined
    : `LANE_PERMISSION_DENIED lane ${caller} may not run send; it is lead-only. Ask the lead instead: dori report ${caller} question --text "..."`;

/**
 * Why `caller` may not run `dori decision`, or undefined for the lead. Only the lead opens, closes and lists owner
 * decisions: a lane asks with a question report carrying choices, which the supervisor opens as a decision.
 */
export const laneDecisionRefusal = (caller: string | undefined): string | undefined =>
  caller === undefined
    ? undefined
    : `LANE_PERMISSION_DENIED lane ${caller} may not run decision; it is lead-only. Ask with dori report ${caller} question --option ... --recommend N --reason ...`;

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
  const machine = machineClose(lane);
  if (!claim.emitted) {
    // Enqueued before the emitted mark is saved: a crash in between repeats the announcement instead of losing it
    // (under the same id, so the supervisor journals it once).
    const event = !machine ? claimEventId(lane.key, claim.at) : undefined;
    await push(`${machine ? "LANE_AUTO_CLAIMED" : "LANE_DONE_CLAIMED"} ${lane.key} ${lane.pane ?? "-"} ${eventText(claim.evidence)}`, event, laneMeta(lane));
    const announced = { emitted: true, ...(event ? { event } : {}) };
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
  const settled = await settle(deps, lane, evidence, start ?? deps.clock.now());
  if (settled === undefined) return;
  const line = settled.line;
  // A close whose claim announcement already reached the lead is marked seen-claim. It wakes the lead unless the
  // supervisor finished the lane's task itself (`seen-claim toodo=done`, digest).
  const event = claim.event;
  const seen = event !== undefined && (!deps.leadDelivered || deps.leadDelivered(event));
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
export const laneMerges = async (deps: FlowDeps, lane: Lane): Promise<{ readonly merges: readonly LaneMerge[] } | { readonly why: string }> => {
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
    const r = await deps.run(["gh", "pr", "view", String(number), "-R", repo, "--json", "state,url,baseRefName,mergeCommit"], { timeoutMs: 20_000 });
    let view: { readonly state?: string; readonly url?: string; readonly baseRefName?: string; readonly mergeCommit?: { readonly oid?: string } | null } | undefined;
    try { view = r.code === 0 ? JSON.parse(r.out) : undefined; } catch { view = undefined; }
    if (!view) return { why: `${repo}#${number} could not be read: ${(r.err || r.out).replace(/\s+/g, " ").slice(0, 120)}` };
    const sha = view.mergeCommit?.oid;
    if (view.state !== "MERGED" || !sha) return { why: `${repo}#${number} reads ${view.state ?? "unknown"}${sha ? "" : " with no merge commit"}` };
    merges.push({ repo, number, url: view.url ?? `https://github.com/${repo}/pull/${number}`, base: view.baseRefName ?? "its base", sha });
  }
  return { merges };
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
  if (task === undefined || !Number.isSafeInteger(task)) return { tag: "no-task", lines: [] };
  // Finished at an earlier close of the lane (a resumed close): nothing is written or told again.
  const mark = attempt ? toodoMarkOf(attempt) : undefined;
  if (mark !== undefined) return { tag: mark === "done" ? "done" : "failed", lines: [] };
  let finish: TaskFinish;
  let why: string | undefined;
  try {
    const read = await laneMerges(deps, lane);
    if ("why" in read) {
      why = `no merge read back: ${read.why}`;
      finish = { tag: "unmerged", lines: [notCompletedLine(lane, task, why)] };
    } else finish = await deps.finishTask(lane, task, read.merges);
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
  const marked = done ? "done" : said?.startsWith("blocker recorded") ? "blocked" : "failed";
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
 * into `ciMergeBase` from a lane worktree's branch at exactly that worktree's HEAD.
 */
export const mergeConfirmed = async (deps: FlowDeps, lane: Lane): Promise<string | undefined> => {
  if (lane.machine) return undefined;
  const op = await withOperations(deps, async (store) => store.list({ lane: lane.key }).find((o) => o.action === "merge" && o.state === "verified"));
  if (op) return `CI_MERGED ${op.target}`;
  const signalled = (await readBindings(lane.done, deps.run)).find((b) => !("error" in b));
  if (signalled) return `${signalled.repo}#${signalled.n} merged`;
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
  if (claimWaitsForLead(deps, lane) && deps.leadDelivered && !deps.leadDelivered(claim.event)) return undefined;
  const at = iso(deps.clock);
  await deps.registry.patch(lane.key, (current) => (current.claim?.at === claim.at ? { claim: { ...current.claim, deliveredAt: at } } : undefined));
  return Date.parse(at);
};

/**
 * One pass over every lane. With `emit`, each line is handed over the moment it exists (the supervisor enqueues it
 * durably); the lines are also returned. One lane's failure is a LANE_WATCH_WARN line and never stops the others.
 * `archived: false` skips the closed lanes in the archive (their worktree cleanup), so a pass reads open lanes only.
 * A lane whose machine is not `admitted` (its runner has no admitted connection) is skipped without a line, and so is a
 * lane whose runner dropped its connection during the pass: the supervisor's RUNNER_UNAVAILABLE line reports that outage.
 */
export const watchTick = async (deps: FlowDeps, emit?: Emit, archived = true, admitted: (machine?: string) => boolean = () => true): Promise<string[]> => {
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
  for (const listed of archived ? await deps.registry.list() : await deps.registry.open()) {
    if (!admitted(listed.machine)) continue;
    try {
      await watchLane(deps, listed, push);
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === "RUNNER_UNAVAILABLE" && !admitted(listed.machine)) continue;
      await push(`LANE_WATCH_WARN ${listed.key} ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  return out;
};
