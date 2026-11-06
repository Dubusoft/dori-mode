import type { LaneOps, LaneRef } from "./lane-ops.ts";
import type { Lane } from "./registry.ts";
import type { Ran, Runner } from "./run.ts";
import type { Operation, OperationState, OperationStore, ReadBack } from "./operations.ts";
import { parseSignal, splitDone } from "./signals.ts";

/**
 * SHA-bound branch cleanup (design 4.3, item 1.3; rows A17-A19 of the runner design: every git step on the lane's host
 * runs through the lane's runner, `gh` stays on the lead). A close binds each `merged <repo>#N` signal of
 * the lane, and each lane worktree whose branch has a PR merged into the merge base (`ciMergeBase`), to `(repo, PR
 * number, base, merged head SHA)` read from GitHub. A worktree on that branch is removed only when its HEAD is exactly
 * the merged head; the branch is then deleted only when the local ref and the remote ref (when it still exists) still
 * point at that SHA, and the branch is not checked out anywhere, not protected and not named by another open lane's Done
 * line: the remote branch with a lease on that SHA (`lane.git remote-branch-delete` with `sha`: the runner pushes
 * `--force-with-lease=<ref>:<sha>`), then the local one with a compare-and-delete (`lane.git branch-delete` with `sha`: the
 * runner runs `update-ref -d <ref> <sha>`). Anything else keeps the branch (and its
 * worktree) and reports why in the close receipt.
 */
export const BRANCH_DELETE = "branch-delete";
export const REMOTE_BRANCH_DELETE = "remote-branch-delete";

/** Never deleted, whatever a PR says (besides the PR's own base). */
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "dev", "develop", "trunk", "release", "staging", "production"]);

export type Binding = { readonly repo: string; readonly n: string; readonly base: string; readonly branch: string; readonly sha: string };
/** A merged signal whose PR could not be bound: its repo's worktrees and branches are kept. */
export type Unbound = { readonly repo: string; readonly n: string; readonly error: string };

/**
 * One local branch to delete: `root`, a checkout of the repository that outlives the close's worktree removals (the
 * runner's `lane.git` runs `git -C <root>`), and the remote that holds the PR.
 */
export type BranchTarget = Binding & { readonly root: string; readonly remote: string };

/**
 * A lane worktree as the lane's runner read it (`q.lane.inspect` git facts), with the `origin` URL of its checkout.
 * `dirty`/`ahead` are absent (and `error` set) when the runner could not read them.
 */
export type WorktreeFact = {
  readonly path: string; readonly exists: boolean; readonly branch?: string; readonly head?: string;
  readonly dirty?: boolean; readonly ahead?: number; readonly error?: string; readonly origin?: string;
};

/** The close's effect runner (done-flow's `act`): one recorded operation; `cmdId` is the runner command id of this attempt. */
export type BranchAct = (action: string, target: string, effect: (cmdId: string) => Promise<Ran>, readBack: ReadBack) =>
  Promise<{ readonly state: OperationState; readonly err: string; readonly out: string; readonly id?: string; readonly detail?: string }>;

const short = (sha: string): string => sha.slice(0, 10);
const SHA = /^[0-9a-f]{40}$/;

/** Reads every merged signal's PR from GitHub. A PR that is not merged, from a fork or unreadable is Unbound. */
export const readBindings = async (done: string, run: Runner): Promise<(Binding | Unbound)[]> => {
  const out: (Binding | Unbound)[] = [];
  for (const part of splitDone(done)) {
    let parsed;
    try { parsed = parseSignal(part); } catch { continue; }
    if (parsed.kind !== "merged") continue;
    const sig = parsed;
    const r = await run(["gh", "pr", "view", sig.n, "--repo", sig.repo, "--json", "state,headRefName,headRefOid,baseRefName,isCrossRepository"]);
    const unbound = (error: string): Unbound => ({ repo: sig.repo, n: sig.n, error: error.replace(/\s+/g, " ").slice(0, 160) });
    if (r.code !== 0 || r.timedOut) { out.push(unbound(r.err || `gh exited ${r.code}`)); continue; }
    let j: { state?: string; headRefName?: string; headRefOid?: string; baseRefName?: string; isCrossRepository?: boolean };
    try { j = JSON.parse(r.out); } catch { out.push(unbound("unreadable gh answer")); continue; }
    if (j.state !== "MERGED") out.push(unbound(`PR is ${j.state ?? "unknown"}`));
    else if (j.isCrossRepository) out.push(unbound("head branch is in a fork"));
    else if (!j.headRefName || !j.baseRefName || !SHA.test(j.headRefOid ?? "")) out.push(unbound("PR head or base missing"));
    else out.push({ repo: sig.repo, n: sig.n, base: j.baseRefName, branch: j.headRefName, sha: j.headRefOid ?? "" });
  }
  return out;
};

const isUnbound = (b: Binding | Unbound): b is Unbound => "error" in b;

/** `owner/repo` of a remote URL on any host (its last two path segments), or undefined. */
const repoOfUrl = (url: string): string | undefined => {
  const path = url.trim().replace(/\.git\/?$/, "").replace(/\/+$/, "").replace(/^[^/]*:(?!\/)/, "/");
  const m = /([\w.-]+)\/([\w.-]+)$/.exec(path);
  return m ? `${m[1]}/${m[2]}` : undefined;
};

/** Whether a checkout whose origin is `origin` is `repo` (case-insensitive, any host). */
const sameRepo = (origin: string | undefined, repo: string): boolean => (origin ? repoOfUrl(origin)?.toLowerCase() === repo.toLowerCase() : false);

type MergedPull = { number?: number; headRefName?: string; headRefOid?: string; baseRefName?: string; isCrossRepository?: boolean };

/**
 * Binds each worktree's branch to the PR merged from it into `base` (no Done signal needed): the merged PR whose head is
 * the worktree's HEAD, else the newest one (whose head then differs, so the worktree and branch are kept). A branch with
 * no merged PR, a protected branch or a detached HEAD gives nothing; a lookup that fails is one receipt note. The
 * worktrees' branch, HEAD and origin come from the lane's runner; only `gh` runs here.
 */
export const readBranchBindings = async (
  run: Runner, worktrees: readonly WorktreeFact[], base: string,
): Promise<{ readonly bindings: Binding[]; readonly notes: string[]; readonly atHead: Binding[] }> => {
  const bindings: Binding[] = [];
  /** Bindings whose merged head is exactly the worktree's HEAD: the worktree's work is what was merged. */
  const atHead: Binding[] = [];
  const notes: string[] = [];
  for (const wt of worktrees) {
    if (!wt.exists) continue;
    const branch = wt.branch ?? "";
    if (!branch || branch === base || PROTECTED_BRANCHES.has(branch)) continue;
    const repo = wt.origin ? repoOfUrl(wt.origin) : undefined;
    if (!repo) continue;
    if (bindings.some((b) => b.repo.toLowerCase() === repo.toLowerCase() && b.branch === branch)) continue;
    const r = await run(["gh", "pr", "list", "--repo", repo, "--state", "merged", "--base", base, "--head", branch,
      "--json", "number,headRefName,headRefOid,baseRefName,isCrossRepository", "--limit", "20"]);
    const note = (why: string) => notes.push(`branch cleanup skipped for ${repo} branch ${branch}: ${why.replace(/\s+/g, " ").slice(0, 160)}`);
    if (r.code !== 0 || r.timedOut) { note(r.err || `gh exited ${r.code}`); continue; }
    let pulls: MergedPull[];
    try { pulls = JSON.parse(r.out) as MergedPull[]; } catch { note("unreadable gh answer"); continue; }
    if (!Array.isArray(pulls)) { note("unreadable gh answer"); continue; }
    const ours = pulls.filter((p) => !p.isCrossRepository && p.headRefName === branch && p.baseRefName === base && typeof p.number === "number" && SHA.test(p.headRefOid ?? ""));
    if (!ours.length) continue;
    const exact = wt.head ? ours.find((p) => p.headRefOid === wt.head) : undefined;
    const pick = exact ?? ours[0];
    if (!pick) continue;
    const binding: Binding = { repo, n: String(pick.number), base, branch, sha: pick.headRefOid ?? "" };
    bindings.push(binding);
    if (exact) atHead.push(binding);
  }
  return { bindings, notes, atHead };
};

export type BranchPlan = {
  /** Worktrees that must stay, with why (a commit after the merge, an unreadable PR). */
  readonly holds: ReadonlyMap<string, string>;
  readonly targets: readonly BranchTarget[];
  /** Merged signals that could not be bound, one receipt line each. */
  readonly notes: readonly string[];
  /** Candidate worktrees (the lane's own cwd) that sit exactly at a merged head: these are removed too. */
  readonly adopted: readonly string[];
};

export type BranchPlanOptions = {
  /** The merge base (`ciMergeBase`): each worktree's branch is also bound to a PR merged from it into this base. */
  readonly base?: string;
  /**
   * Linked worktrees the close does not remove by itself (the lane's cwd): each is removed only when its branch is bound
   * to a merged PR and its HEAD is exactly the merged head. The caller passes linked worktrees only.
   */
  readonly candidates?: readonly WorktreeFact[];
  /** Checkouts on the lane's host, in order of preference, where a branch delete may run (defaultCwd, the lane's cwd). */
  readonly roots?: readonly string[];
};

const targetKey = (t: Pick<Binding, "repo" | "n" | "sha">): string => `${t.repo}#${t.n}@${t.sha}`;

/** A target an interrupted close recorded. A row an older dori wrote names the common git dir (`gitDir`) instead of a root. */
const recordedTarget = (data: string | undefined): BranchTarget | undefined => {
  let t: Partial<BranchTarget> & { readonly gitDir?: string };
  try { t = JSON.parse(data ?? "") as typeof t; } catch { return undefined; }
  const root = t.root ?? (typeof t.gitDir === "string" ? t.gitDir.replace(/\/\.git\/?$/, "") : undefined);
  if (!root || !t.repo || !t.n || !t.base || !t.branch || !t.sha) return undefined;
  return { repo: t.repo, n: t.n, base: t.base, branch: t.branch, sha: t.sha, root, remote: t.remote ?? "origin" };
};

/**
 * Before any worktree is removed: binds the lane's merged PRs, decides which worktrees stay, and finds the checkout to
 * delete each local branch from (one that is not about to be removed). Each target is recorded (planned, with its root)
 * in `store`, so a close resumed after its worktree is gone still knows where the branch lives. Git facts come from the
 * lane's runner (`ops.inspect`); `gh` runs here.
 */
export const planBranchCleanup = async (
  run: Runner, ops: Pick<LaneOps, "inspect">, lane: Lane, worktrees: readonly WorktreeFact[], store: OperationStore | undefined, now: () => number,
  opts: BranchPlanOptions = {},
): Promise<BranchPlan> => {
  const signalled = await readBindings(lane.done, run);
  const candidates = (opts.candidates ?? []).filter((c) => c.exists && !worktrees.some((w) => w.path === c.path));
  const all = [...worktrees.filter((w) => w.exists), ...candidates];
  const fromBranches = opts.base ? await readBranchBindings(run, all, opts.base) : { bindings: [], notes: [], atHead: [] };
  const bindings: (Binding | Unbound)[] = [...signalled, ...fromBranches.bindings.filter((b) => !signalled.some((s) => !isUnbound(s) && targetKey(s) === targetKey(b)))];
  const holds = new Map<string, string>();
  const adopted: string[] = [];
  const notes = [...bindings.filter(isUnbound).map((b) => `branch cleanup skipped for ${b.repo}#${b.n}: ${b.error}`), ...fromBranches.notes];
  for (const wt of all) {
    for (const b of bindings) {
      if (!sameRepo(wt.origin, b.repo)) continue;
      if (isUnbound(b)) { holds.set(wt.path, `${b.repo}#${b.n} could not be bound: ${b.error}`); break; }
      if (wt.branch !== b.branch) continue;
      if (!wt.head) { holds.set(wt.path, `cannot read HEAD of branch ${b.branch}: ${(wt.error ?? "the runner reported none").slice(0, 120)}`); break; }
      if (wt.head !== b.sha) { holds.set(wt.path, `branch ${b.branch} tip ${short(wt.head)} is not the merged head ${short(b.sha)} of ${b.repo}#${b.n}`); break; }
      if (candidates.some((c) => c.path === wt.path)) adopted.push(wt.path);
      break;
    }
  }
  const targets = new Map<string, BranchTarget>();
  // Targets an interrupted close recorded: their worktree may be gone, so they are not found again below.
  for (const op of store?.list({ lane: lane.key }).filter((o) => o.action === BRANCH_DELETE && o.state !== "verified") ?? []) {
    const t = recordedTarget(op.data);
    if (t) targets.set(op.target, t);
  }
  // A branch is deleted from a checkout that stays: never one of the worktrees this close removes.
  const removing = new Set([...worktrees.map((w) => w.path), ...adopted].filter((p) => !holds.has(p)));
  const origins = new Map<string, Promise<string | undefined>>(all.map((w) => [w.path, Promise.resolve(w.origin)]));
  const originOf = (path: string): Promise<string | undefined> => {
    let hit = origins.get(path);
    if (!hit) {
      hit = ops.inspect(lane, { git: true, cwd: path }).then((i) => (i.cwdExists ? i.git?.origin : undefined), () => undefined);
      origins.set(path, hit);
    }
    return hit;
  };
  const roots = [...new Set([...(opts.roots ?? []), ...all.map((w) => w.path)])].filter((p) => p && !removing.has(p));
  for (const b of bindings) {
    if (isUnbound(b) || targets.has(targetKey(b))) continue;
    for (const root of roots) {
      if (sameRepo(await originOf(root), b.repo)) { targets.set(targetKey(b), { ...b, root, remote: "origin" }); break; }
    }
  }
  if (store) {
    for (const [key, t] of targets) {
      if (!store.get(`${lane.key}/${BRANCH_DELETE}/${key}`)) store.put(planned(lane.key, key, t, now()));
    }
  }
  return { holds, targets: [...targets.values()], notes, adopted: adopted.filter((wt) => !holds.has(wt)) };
};

const planned = (lane: string, target: string, t: BranchTarget, at: number): Operation => ({
  id: `${lane}/${BRANCH_DELETE}/${target}`, lane, action: BRANCH_DELETE, target, state: "planned", detail: "planned", data: JSON.stringify(t), attempts: 0, at, updatedAt: at,
});

/** Why another open lane's Done line names the same PR, or undefined. */
const sharedBy = (others: readonly Lane[], t: Binding): string | undefined => {
  const want = `${t.repo.toLowerCase()}#${t.n}`;
  return others.find((l) => splitDone(l.done).some((part) => {
    try { const s = parseSignal(part); return s.kind === "merged" && `${s.repo.toLowerCase()}#${s.n}` === want; } catch { return false; }
  }))?.key;
};

export type BranchResult = {
  readonly line: string;
  readonly step?: Awaited<ReturnType<BranchAct>>;
  readonly kept?: string;
  /** The remote branch's receipt line, when the remote branch was read. */
  readonly remoteLine?: string;
  readonly remoteStep?: Awaited<ReturnType<BranchAct>>;
};

type Presence = { readonly local: boolean; readonly remote: boolean };

/** A failed lease push or compare-and-delete: the ref moved off the SHA it was bound to. */
const MOVED_REMOTE = /stale info|\[rejected\]|fetch first|non-fast-forward/i;
const MOVED_LOCAL = /but expected|cannot lock ref/i;
/** The runner refused a branch delete without running it: the branch is checked out in some worktree, or that list is unreadable. */
const REFUSED = /RUNNER_LANE_GIT_REFUSED (.*)/;

/**
 * After the worktrees: re-reads the branch (local and on origin) through the lane's runner, then deletes it only if it
 * still agrees with the merged head SHA. Both deletes carry that SHA (the runner's lease push and compare-and-delete),
 * so a commit landing between the read and the delete keeps the branch. A branch whose tip a lane worktree shows at
 * another commit, or that a lane worktree still has checked out, is kept without a delete. Returns one receipt line;
 * `kept` is set when the branch stays. A runner that cannot answer throws (the close stops and is resumed).
 */
export const deleteBranch = async (
  ops: Pick<LaneOps, "inspect" | "git" | "exists">, lane: LaneRef, act: BranchAct, t: BranchTarget, otherOpen: readonly Lane[], worktrees: readonly WorktreeFact[],
): Promise<BranchResult> => {
  const ref = `refs/heads/${t.branch}`;
  const kept = (why: string): BranchResult => ({ line: `branch ${t.branch} kept: ${why}`, kept: why });
  if (PROTECTED_BRANCHES.has(t.branch) || t.branch === t.base) return kept(`protected (base ${t.base} of ${t.repo}#${t.n})`);
  const sharing = sharedBy(otherOpen, t);
  if (sharing) return kept(`open lane ${sharing} also names ${t.repo}#${t.n}`);
  const presence = async (): Promise<Presence | undefined> =>
    (await ops.inspect(lane, { git: true, cwd: t.root, branches: [t.branch] })).git?.branches?.[t.branch];
  const local = await presence();
  if (!local) return kept(`cannot read ${ref} in ${t.root}`);
  const readBack: ReadBack = async () => {
    const now = await presence();
    return now === undefined ? "unknown" : now.local ? "not-done" : "done";
  };
  const effect = (cmdId: string) => ops.git(lane, { op: "branch-delete", root: t.root, branch: t.branch, sha: t.sha }, { cmdId });
  const key = targetKey(t);
  if (!local.local) {
    const remote = await deleteRemote(ops, lane, act, t, key, local.remote, presence);
    if (remote.step?.state === "ambiguous") return { line: "", remoteStep: remote.step };
    if (remote.held) return { ...kept(remote.held), remoteStep: remote.step };
    const step = await act(BRANCH_DELETE, key, effect, readBack);
    return { line: `branch ${t.branch} already gone`, step, remoteLine: remote.line, remoteStep: remote.step };
  }
  const tip = worktrees.find((w) => w.exists && w.branch === t.branch && w.head)?.head;
  if (tip && tip !== t.sha) return kept(`tip ${short(tip)} is not the merged head ${short(t.sha)} of ${t.repo}#${t.n} (a commit after the merge)`);
  const holders = worktrees.filter((w) => w.branch === t.branch).map((w) => w.path);
  if (holders.length && (await ops.exists(lane.machine, holders)).some(Boolean)) return kept("checked out in a worktree");
  // Remote first: a close interrupted between the two still finds the local branch, and with it this target, on resume.
  const remoteDone = await deleteRemote(ops, lane, act, t, key, local.remote, presence);
  if (remoteDone.step?.state === "ambiguous") return { line: "", remoteStep: remoteDone.step };
  if (remoteDone.held) return { ...kept(remoteDone.held), remoteStep: remoteDone.step };
  if (remoteDone.moved) {
    return { ...kept(`${t.remote}/${t.branch} is at another commit than the merged head ${short(t.sha)} of ${t.repo}#${t.n} (a commit pushed after the merge)`), remoteStep: remoteDone.step };
  }
  const remoteFields = { remoteLine: remoteDone.line, remoteStep: remoteDone.step };
  const step = await act(BRANCH_DELETE, key, effect, readBack);
  if (step.state === "verified") return { line: `branch ${t.branch} deleted (${t.repo}#${t.n} merged head ${short(t.sha)})`, step, ...remoteFields };
  if (step.state === "ambiguous") return { line: "", step };
  const why = (step.err || step.out).replace(/\s+/g, " ").slice(0, 120);
  const refused = REFUSED.exec(step.err)?.[1];
  if (refused) return { ...kept(refused.trim()), step, ...remoteFields };
  return { ...kept(MOVED_LOCAL.test(why) ? `moved off the merged head ${short(t.sha)} while deleting` : `delete failed: ${why}`), step, ...remoteFields };
};

/**
 * Deletes the PR's remote branch while it still points at the merged head: the runner's push carries a lease on that
 * SHA, so a commit pushed meanwhile makes the remote refuse (`moved`). A remote branch already gone (GitHub deletes
 * merged heads) is no line.
 */
const deleteRemote = async (
  ops: Pick<LaneOps, "git">, lane: LaneRef, act: BranchAct, t: BranchTarget, key: string, present: boolean,
  presence: () => Promise<Presence | undefined>,
): Promise<{ readonly line?: string; readonly step?: Awaited<ReturnType<BranchAct>>; readonly moved?: boolean; readonly held?: string }> => {
  if (!present) return {};
  const name = `${t.remote}/${t.branch}`;
  const readBack: ReadBack = async () => {
    const now = await presence();
    return now === undefined ? "unknown" : now.remote ? "not-done" : "done";
  };
  const step = await act(REMOTE_BRANCH_DELETE, key, (cmdId) => ops.git(lane, { op: "remote-branch-delete", root: t.root, branch: t.branch, remote: t.remote, sha: t.sha }, { cmdId }), readBack);
  if (step.state === "verified") return { line: `remote branch ${name} deleted (${t.repo}#${t.n} merged head ${short(t.sha)})`, step };
  if (step.state === "ambiguous") return { step };
  // The runner refused (the branch is checked out somewhere): the local branch is kept too, for the same reason.
  const refused = REFUSED.exec(step.err)?.[1];
  if (refused) return { step, held: refused.trim() };
  const why = (step.err || step.out).replace(/\s+/g, " ").slice(0, 120);
  if (MOVED_REMOTE.test(why)) return { step, moved: true, line: `remote branch ${name} kept: not at the merged head ${short(t.sha)} of ${t.repo}#${t.n}` };
  return { line: `remote branch ${name} kept: delete failed: ${why}`, step };
};
