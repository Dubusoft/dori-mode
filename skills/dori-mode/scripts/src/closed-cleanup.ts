import { BRANCH_DELETE, type BranchTarget, deleteBranch, REMOTE_BRANCH_DELETE, type WorktreeFact } from "./branch-cleanup.ts";
import type { FlowDeps } from "./done-flow.ts";
import { actRecorded, probeWorktree, type Step, withOperations } from "./flow-io.ts";
import { machineRunner } from "./lane-ops.ts";
import { operationId, type OperationState, settleOperation } from "./operations.ts";
import { type Lane, statusOf } from "./registry.ts";
import { runnerWorktreeRoot } from "./runner/hub.ts";

/** The worktree root a lane's cleanup may remove under: its runner's reported root, else (local lanes only) `config.worktreeRoot`. */
const cleanupRoot = (deps: FlowDeps, lane: Lane): string => {
  const reported = (deps.runnerWorktreeRoot ?? ((label) => runnerWorktreeRoot(deps.config.stateDir, label)))(machineRunner(lane.machine));
  return (reported || (lane.machine ? "" : deps.config.worktreeRoot)).replace(/\/+$/, "");
};

const under = (root: string, path: string): boolean => Boolean(root) && path.startsWith(`${root}/`) && !path.includes("..");

/**
 * A remote lane's worktrees, found by its runner by key under its reported worktree root: each is queued for
 * closedWorktreeSweep, which removes it from inside itself once it is clean and pushed. A runner that cannot answer
 * never holds the close up.
 */
export const remoteWorktrees = async (deps: FlowDeps, lane: Lane): Promise<{ readonly lines: string[]; readonly queued: string[] }> => {
  const root = cleanupRoot(deps, lane);
  if (!root) return { lines: [], queued: [] };
  let found: readonly { readonly path: string }[];
  try {
    found = (await deps.ops.inspect(lane, { git: true })).git?.worktrees ?? [];
  } catch (e) {
    return { lines: [`remote worktrees not read on machine ${lane.machine}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`], queued: [] };
  }
  const queued = [...new Set(found.map((w) => trimPath(w.path)))].filter((p) => under(root, p));
  return { lines: queued.map((p) => `worktree ${p} queued: remote lane, ${QUEUED_WORKTREE}`), queued };
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

/** The receipt line of a worktree a close queued for the closed-lane cleanup. */
export const QUEUED_WORKTREE = "removed by the closed-lane cleanup once clean and pushed";

const trimPath = (path: string): string => path.replace(/\/+$/, "");

/** A worktree a close queued: `root` is the checkout its `git worktree remove` runs in (the worktree itself once that is gone). */
type QueuedWorktree = { readonly path: string; readonly root: string; readonly removed?: true };
/**
 * A SHA-bound branch a close queued (branch-cleanup.ts BranchTarget). `settled` is set once nothing is left to do:
 * `deleted`, or `kept: <why>` when this binding can never be deleted (protected, or moved off its merged head). `note`
 * is the last reason a retry still waits on, so each reason is reported once.
 */
type QueuedBranch = BranchTarget & { readonly settled?: string; readonly note?: string };
/**
 * The cleanup a close leaves to the watcher, in its receipt (`receipt.queue`). `held`: each worktree the last pass kept
 * because it could not prove it safe to remove, with why, so a reason is reported once, not on every pass.
 */
export type CleanupQueue = { readonly worktrees: QueuedWorktree[]; readonly branches: QueuedBranch[]; readonly held?: Readonly<Record<string, string>> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const BRANCH_FIELDS = ["repo", "n", "base", "branch", "sha", "root", "remote"] as const;

/** The cleanup queue in a closed lane's receipt; empty for a lane an older dori closed (its `kept:` lines still count). */
const cleanupQueue = (lane: Lane): CleanupQueue => {
  const queue = isRecord(lane.receipt) ? lane.receipt.queue : undefined;
  if (!isRecord(queue)) return { worktrees: [], branches: [] };
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
  const held = isRecord(queue.held) ? Object.entries(queue.held).filter((e): e is [string, string] => typeof e[1] === "string") : [];
  return {
    worktrees: list(queue.worktrees).filter((w) => typeof w.path === "string" && typeof w.root === "string") as unknown as QueuedWorktree[],
    branches: list(queue.branches).filter((b) => BRANCH_FIELDS.every((k) => typeof b[k] === "string")) as unknown as QueuedBranch[],
    ...(held.length ? { held: Object.fromEntries(held) } : {}),
  };
};

/** Whether a closed lane's close queued cleanup the sweep has still to do (a worktree not yet removed, a branch not settled). */
export const cleanupPending = (deps: FlowDeps, lane: Lane): boolean => {
  if (statusOf(lane) !== "closed") return false;
  const queue = cleanupQueue(lane);
  if (queue.branches.some((b) => !b.settled)) return true;
  const root = lane.machine ? cleanupRoot(deps, lane) : "";
  return queue.worktrees.some((w) => !w.removed && (!lane.machine || under(root, w.path)));
};

/**
 * The watcher's memory, between passes, of closed lanes whose queued cleanup is still to do: `keys` are swept on every
 * pass, also one that skips the archive, so a close's queue is worked off on the next pass instead of the next archive
 * walk. `open` is the previous pass's open keys: a key gone from it was closed since (by this watcher or `dori close`).
 * The queue itself is durable (`receipt.queue`); this is only an index, rebuilt by every archive pass, and a supervisor
 * starts with an archive pass, so a restart loses nothing.
 */
export type PendingCleanup = { open?: ReadonlySet<string>; readonly keys: Set<string> };
export const newPendingCleanup = (): PendingCleanup => ({ keys: new Set() });

/** Why a path stays when git lists no worktree there. */
const UNLISTED = "git lists no worktree there";
/** The held-worktrees warning is cut to this many characters (the receipt keeps every reason whole). */
const HELD_LINE_MAX = 600;

/** A branch keep no later pass can change: the branch is protected, or it moved off the merged head it was bound to. */
const FINAL_KEEP = /^protected|is not the merged head|at another commit than the merged head|moved off the merged head/;

/**
 * The watcher's half of a lane's close (two stages: the close queues, this removes). For a closed lane:
 *
 * - Each worktree its close queued (`receipt.queue`) is read again and removed once it is clean and has no commit that
 *   no remote has; one whose unpushed commits cannot be read stays, with a warning. Then each SHA-bound branch the
 *   close queued is deleted (branch-cleanup.ts deleteBranch: remote with a lease, then local with a compare-and-delete,
 *   both only at the merged head), also when its worktree was already gone. A branch still checked out in a queued
 *   worktree that stays waits for it.
 * - Outside the root: a local lane's queued worktree is removed wherever it is, because its close found it as the
 *   lane's and checked it (the close itself used to remove exactly these). A remote lane's queued worktree, a worktree an
 *   older close listed as kept (`worktree <path> kept: ...`), and the lane's own directory (`cwd`, a remote lane's
 *   `remoteCwd`) and recorded worktrees are removed only under the lane's runner's reported worktree root, or (local
 *   lanes) `config.worktreeRoot` while that runner has reported none. One the close held with its branch
 *   (`branch-bound worktree ... kept`) stays.
 * - A queued path git lists no worktree at any more (git removed or pruned it, and omo wrote its config back) is
 *   removed under that root only while omo's own files are all it holds (`lane.git leftover-remove`); one holding
 *   anything else, outside the root, or not queued stays.
 * - What stays because it cannot be proven safe is one LANE_WATCH_WARN line per lane naming every such path and why,
 *   sent only when a path is newly held or held for another reason than on the last pass (`receipt.queue.held`), never
 *   again each hour.
 * - Every removal and delete is a recorded operation with a read-back (operations.ts), so a crash mid-sweep is resumed by
 *   the next pass without repeating an effect; what is done is marked in the receipt's queue, so an operation row pruned
 *   later never runs it again. A newly ambiguous operation is one OPERATION_AMBIGUOUS line.
 *
 * Open lanes (working, not-done, paused, done-claimed) are never touched, nor any path an open lane uses (its cwd,
 * remoteCwd or worktrees) or the lead's cwd. Failures come back as LANE_WATCH_WARN lines.
 */
export const closedWorktreeSweep = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  if (statusOf(lane) !== "closed") return [];
  const root = cleanupRoot(deps, lane);
  const queue = cleanupQueue(lane);
  const queuedPaths = queue.worktrees.map((w) => w.path);
  const queued = queue.worktrees.filter((w) => !w.removed && (!lane.machine || under(root, w.path)));
  const bound = keptWorktrees(lane, "branch-bound worktree ");
  const kept = keptWorktrees(lane).filter((wt) => under(root, wt) && !queuedPaths.includes(wt));
  const dir = lane.machine ? lane.remoteCwd : lane.cwd;
  const own = [...new Set([...(dir ? [dir] : []), ...(lane.worktrees ?? [])].map(trimPath))]
    .filter((p) => under(root, p) && !kept.includes(p) && !queuedPaths.includes(p) && !bound.includes(p));
  const branches = queue.branches.filter((b) => !b.settled);
  if (!queued.length && !kept.length && !own.length && !branches.length) return [];
  const paths = [...new Set([...queued.flatMap((w) => [w.path, w.root]), ...kept, ...own])];
  const [cwdThere = false, ...present] = lane.machine
    ? [false, ...(await deps.ops.exists(lane.machine, paths))]
    : await deps.ops.exists(undefined, [lane.cwd ?? deps.config.leadCwd, ...paths]);
  const there = new Map(paths.map((p, i) => [p, Boolean(present[i])]));
  const openLanes = await deps.registry.open();
  const busy = new Set([deps.config.leadCwd, ...openLanes.flatMap((l) => [l.cwd ?? "", l.remoteCwd ?? "", ...(l.worktrees ?? [])])]
    .filter(Boolean).map(trimPath));
  const repo = lane.cwd && cwdThere ? lane.cwd : deps.config.leadCwd;
  return withOperations(deps, async (store) => {
    const act = actRecorded(deps, store, lane);
    const out: string[] = [];
    const removed: string[] = [];
    const gone = new Set<string>();
    /** Queued or candidate worktrees that stay this pass, as read: a branch they hold waits for them. */
    const staying: WorktreeFact[] = [];
    const stateOf = (action: string, target: string) => store.get(operationId({ lane: lane.key, action, target }))?.state;
    const ambiguousOnce = (step: Step, before: OperationState | undefined) => {
      if (before !== "ambiguous") out.push(`OPERATION_AMBIGUOUS ${step.id} ${step.detail}`);
    };
    /** Worktrees kept this pass because they cannot be proven safe to remove, with why. */
    const held = new Map<string, string>();
    /** `clean`: it may go (clean, nothing unpushed); `unlisted`: git lists no worktree there; else it stays (held when unreadable). */
    const verdict = async (wt: string): Promise<"clean" | "unlisted" | "stays"> => {
      const fact = await probeWorktree(deps, lane, wt);
      if (!fact) return "unlisted";
      if (fact.error === undefined && fact.dirty === false && fact.ahead === 0) return "clean";
      staying.push(fact);
      if (fact.error !== undefined || fact.dirty === undefined) held.set(wt, `cannot read its git status: ${(fact.error ?? "no answer").slice(0, 120)}`);
      else if (!fact.dirty && fact.ahead === undefined) held.set(wt, "cannot read its unpushed commits");
      return "stays";
    };
    const goneBack = (wt: string) => async () => ((await deps.ops.exists(lane.machine, [wt]))[0] ? "not-done" as const : "done" as const);
    const remove = async (wt: string, gitRoot: string, wasThere: boolean): Promise<void> => {
      const before = stateOf("worktree-remove", wt);
      const step = await act("worktree-remove", wt, (cmdId) => deps.ops.git(lane, { op: "worktree-remove", root: gitRoot, path: wt }, { cmdId }), goneBack(wt));
      if (step.state === "verified") {
        gone.add(wt);
        if (wasThere) removed.push(wt);
      } else if (step.state === "ambiguous") ambiguousOnce(step, before);
      else out.push(`LANE_WATCH_WARN ${lane.key} worktree ${wt} not removed: ${(step.err || step.out).slice(0, 160)}`);
    };
    /** A queued path git lists no worktree at: removed only while omo's files are all it holds (the runner checks). */
    const removeLeftover = async (wt: string): Promise<void> => {
      const before = stateOf("leftover-remove", wt);
      const step = await act("leftover-remove", wt, (cmdId) => deps.ops.git(lane, { op: "leftover-remove", root: wt, path: wt }, { cmdId }), goneBack(wt));
      if (step.state === "verified") {
        gone.add(wt);
        removed.push(wt);
      } else if (step.state === "ambiguous") ambiguousOnce(step, before);
      else held.set(wt, `${UNLISTED}, not removed: ${(step.err || step.out).replace(/\s+/g, " ").slice(0, 120)}`);
    };
    for (const w of queued) {
      if (busy.has(w.path)) {
        // An open lane works there: it stays, and so does a branch it has checked out.
        const fact = there.get(w.path) ? await probeWorktree(deps, lane, w.path) : undefined;
        if (fact) staying.push(fact);
        continue;
      }
      // A queued worktree already gone (removed by hand, or by a pass a crash cut short) only settles its operation.
      if (!there.get(w.path)) { await remove(w.path, w.path, false); continue; }
      const v = await verdict(w.path);
      if (v === "clean") await remove(w.path, there.get(w.root) && !gone.has(w.root) ? w.root : w.path, true);
      else if (v === "unlisted") {
        if (under(root, w.path)) await removeLeftover(w.path);
        else held.set(w.path, `${UNLISTED}, outside the worktree root`);
      }
    }
    for (const wt of [...kept, ...own]) {
      if (!there.get(wt) || busy.has(wt)) continue;
      // A remote worktree, and one found from the lane's record, is removed from inside itself: its repository is not known here.
      const v = await verdict(wt);
      if (v === "clean") await remove(wt, lane.machine || own.includes(wt) ? wt : repo, true);
      else if (v === "unlisted") held.set(wt, `${UNLISTED}, and the close did not queue it`);
    }
    const heldNow = Object.fromEntries(held);
    const heldBefore = queue.held ?? {};
    const heldChanged = !Bun.deepEquals(heldNow, heldBefore);
    // Only a path newly held, or held for another reason, is news; one that left the set (removed, or now in use) is not.
    if ([...held].some(([p, why]) => heldBefore[p] !== why)) {
      const line = `LANE_WATCH_WARN ${lane.key} kept ${held.size} worktree${held.size > 1 ? "s" : ""} it cannot prove safe to remove: ${[...held].map(([p, why]) => `${p} (${why})`).join("; ")}`;
      out.push(line.length > HELD_LINE_MAX ? `${line.slice(0, HELD_LINE_MAX - 1)}…` : line);
    }
    const settled = new Map<string, Pick<QueuedBranch, "settled" | "note">>();
    const cleaned: string[] = [];
    const others = branches.length ? openLanes.filter((l) => l.key !== lane.key) : [];
    for (const t of branches) {
      if (staying.some((f) => f.branch === t.branch)) continue;
      const key = `${t.repo}#${t.n}@${t.sha}`;
      const before = new Map([REMOTE_BRANCH_DELETE, BRANCH_DELETE].map((a) => [operationId({ lane: lane.key, action: a, target: key }), stateOf(a, key)]));
      // An ambiguous delete is the lead's to resolve (dori ops resolve); it was told once and is never retried on a guess.
      if ([...before.values()].includes("ambiguous")) continue;
      const r = await deleteBranch(deps.ops, lane, act, t, others, staying);
      const stuck = [r.remoteStep, r.step].find((s) => s?.state === "ambiguous");
      if (stuck) { ambiguousOnce(stuck, before.get(stuck.id ?? "")); continue; }
      if (!r.kept && r.step?.state === "verified") {
        settled.set(key, { settled: "deleted" });
        cleaned.push(...(r.remoteLine ? [r.remoteLine] : []), r.line);
        continue;
      }
      const why = r.kept ?? `delete failed: ${(r.step?.err || r.step?.out || "no answer").replace(/\s+/g, " ").slice(0, 120)}`;
      if (r.kept && FINAL_KEEP.test(r.kept)) {
        if (r.step === undefined) settleOperation(store, deps.clock.now(), operationId({ lane: lane.key, action: BRANCH_DELETE, target: key }), "failed", `kept: ${r.kept}`);
        settled.set(key, { settled: `kept: ${r.kept}` });
        out.push(`LANE_WATCH_WARN ${lane.key} branch ${t.branch} kept: ${r.kept}`);
      } else if (t.note !== why) {
        settled.set(key, { note: why });
        out.push(`LANE_WATCH_WARN ${lane.key} branch ${t.branch} not deleted yet: ${why}`);
      }
    }
    if (queue.worktrees.some((w) => gone.has(w.path)) || settled.size || heldChanged) {
      await deps.registry.patch(lane.key, (current) => {
        if (!isRecord(current.receipt)) return undefined;
        const now = cleanupQueue(current);
        return { receipt: { ...current.receipt, queue: {
          worktrees: now.worktrees.map((w) => (gone.has(w.path) ? { ...w, removed: true as const } : w)),
          branches: now.branches.map((b) => ({ ...b, ...settled.get(`${b.repo}#${b.n}@${b.sha}`) })),
          ...(held.size ? { held: heldNow } : {}),
        } } };
      });
    }
    return [
      ...(removed.length ? [`WORKTREE_CLEANED ${lane.key} ${removed.join(" ")}`] : []),
      ...(cleaned.length ? [`BRANCH_CLEANED ${lane.key} ${cleaned.join("; ")}`] : []),
      ...out,
    ];
  });
};
