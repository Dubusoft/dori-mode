import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane, newPendingCleanup, watchTick } from "../src/done-flow.ts";
import { openOperations, plan, settleOperation } from "../src/operations.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { run as realRun, type Runner } from "../src/run.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { laneOps, type LaneOps } from "../src/lane-ops.ts";
import type { RunnerCall } from "../src/runner/call.ts";
import { laneGitEffect } from "../src/runner/lane-git.ts";
import type { AnySupervisorControl, SupervisorCommandBodies } from "../src/runner/protocol.ts";
import { answerQuery } from "../src/runner/queries.ts";
import { depsFor, fakeClock, newWorld, TEST_STORE, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

// beforeEach and every close run real git subprocesses (init, clone, push, worktree add/remove, update-ref); on a CI runner
// shared with `bun test --parallel` workers that took >5 s. Nothing but the awaited process marks "git is done", so there is
// no event to wait on: the budget only bounds a hang, it does not pace the test.
setDefaultTimeout(30_000);

let state: ReturnType<typeof withState>;
let world: World;
let repo: string;
let wt: string;
let mergedHead: string;
/** What `gh pr list --state merged --head <branch>` answers: the PRs merged from a worktree's branch. */
let mergedFromBranch: object[];

const git = async (...args: string[]): Promise<string> => {
  const r = await realRun(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out.trim();
};
const commit = async (dir: string, file: string): Promise<string> => {
  writeFileSync(join(dir, file), file);
  await git("-C", dir, "add", file);
  await git("-C", dir, "commit", "-q", "-m", file);
  return git("-C", dir, "rev-parse", "HEAD");
};
const localTip = async (): Promise<string | undefined> => {
  const r = await realRun(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/feat-x"]);
  return r.code === 0 ? r.out.trim() : undefined;
};
const remoteTip = async (): Promise<string> => (await git("-C", repo, "ls-remote", "origin", "refs/heads/feat-x")).split(/\s+/)[0] ?? "";

/** git runs for real; gh answers that acme/app#7 merged feat-x at `mergedHead` into main; herdr is the fake. */
const runner = (): Runner => {
  const fake = depsFor(world, fakeClock(T0), state.dir).run;
  return async (argv, opts) => {
    if (argv[0] === "git" || argv[0] === "bash") { world.calls.push([...argv]); return realRun(argv, opts); }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") {
      world.calls.push([...argv]);
      return { code: 0, err: "", out: JSON.stringify(mergedFromBranch) };
    }
    if (argv[0] === "gh" && argv[1] === "pr") {
      world.calls.push([...argv]);
      return { code: 0, err: "", out: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "f".repeat(40) }, headRefName: "feat-x", headRefOid: mergedHead, baseRefName: "main", isCrossRepository: false }) };
    }
    return fake(argv, opts);
  };
};
/**
 * The lane facade over the runner's own code on this host: `q.lane.inspect`/`q.stat` answered by runner/queries.ts and
 * `lane.git` by runner/lane-git.ts, both running `run`, so git facts and cleanup are real; every other operation is
 * `base` (the fake World's). Each `lane.git` is recorded in `w.ops`.
 */
const runnerGitOps = (run: Runner, base: LaneOps, w: World): LaneOps => {
  const call: RunnerCall = {
    query: async (_label, type, body) =>
      (await answerQuery({ run, clock: fakeClock(T0), lane: () => undefined }, { type, body: { qid: "q", ...body } } as unknown as AnySupervisorControl)) as never,
    call: async (_label, type, body, opts) => {
      if (type !== "lane.git") throw new Error(`unexpected runner command ${type}`);
      const r = await laneGitEffect(run, body as Omit<SupervisorCommandBodies["lane.git"], "cmdId">);
      return { cmdId: opts?.cmdId ?? "-", state: "verified", detail: r.detail, result: r.result } as never;
    },
    connected: () => true,
  };
  const real = laneOps(call, { now: () => T0 });
  return {
    ...base, inspect: real.inspect, exists: real.exists,
    git: async (lane, op, opts) => { w.ops.push({ op: "git", key: lane.key, args: { ...op, ...(opts ? { opts } : {}) } }); return real.git(lane, op, opts); },
  };
};
/** Lane git (facts, worktree removal, branch deletes) runs through runnerGitOps over `run`; gh and the World fakes stay as they are. */
const deps = (patch: Parameters<typeof depsFor>[3] = {}, run: Runner = runner()) => {
  const base = depsFor(world, fakeClock(T0), state.dir, { leadCwd: repo, worktreeRoot: state.dir, ...patch });
  return { ...base, run, exists: undefined, ops: runnerGitOps(run, base.ops, world) };
};
const lane = (): Lane => ({ key: "demo-lane", title: "demo", thread: "none", pane: "w:p1", brief: "/b.md", done: "merged acme/app#7", cwd: wt, worktrees: [wt], openedAt: new Date(T0).toISOString() });
const updateRefs = () => world.calls.filter((c) => c.includes("update-ref"));
/** The close's cleanup lines, read from the registry receipt (the CLOSED line no longer carries it). */
const receipt = async (key = "demo-lane"): Promise<string[]> => ((await deps().registry.read(key))?.receipt as { cleanup: string[] }).cleanup;
/** The close (it queues the worktree and the branch), then one watcher pass (it removes and deletes): a lane's two cleanup stages. */
const closeThenSweep = async (d = deps(), l = lane()): Promise<{ readonly closed: boolean; readonly swept: string[] }> => {
  const r = await closeLane(d, l, "manual");
  return { closed: r.closed, swept: await watchTick(d) };
};
const QUEUED = "removed by the closed-lane cleanup once clean and pushed";

beforeEach(async () => {
  state = withState();
  world = newWorld();
  if (TEST_STORE === "sqlite") new SqliteStore(join(state.dir, SQLITE_FILE), { create: true }).close();
  const origin = join(state.dir, "acme", "app.git");
  mkdirSync(join(state.dir, "acme"));
  repo = join(state.dir, "repo");
  wt = join(state.dir, "wt", "demo-lane");
  await git("init", "-q", "--bare", "-b", "main", origin);
  await git("clone", "-q", origin, repo);
  await commit(repo, "init");
  await git("-C", repo, "push", "-q", "origin", "HEAD:main");
  await git("-C", repo, "worktree", "add", "-q", "-b", "feat-x", wt);
  mergedHead = await commit(wt, "feature");
  await git("-C", wt, "push", "-q", "origin", "feat-x");
  mergedFromBranch = [];
  await deps().registry.write(lane());
});
afterEach(() => state.done());

test("the close queues a branch still at the merged head SHA with its worktree, and the next watcher pass removes both as verified operations", async () => {
  const r = await closeLane(deps(), lane(), "manual");
  expect(r.closed).toBe(true);
  // Stage one: nothing is removed; the worktree (with its root) and the SHA-bound branch are queued in the receipt.
  expect(existsSync(wt)).toBe(true);
  expect(await localTip()).toBe(mergedHead);
  expect(await receipt()).toEqual([
    `worktree ${wt} queued: ${QUEUED}`,
    `branch feat-x queued: deleted by the closed-lane cleanup after its worktrees go, only while it is at acme/app#7 merged head ${mergedHead.slice(0, 10)}`,
    "pane w:p1 closed",
  ]);
  expect(((await deps().registry.read("demo-lane"))?.receipt as { queue: unknown }).queue).toEqual({
    worktrees: [{ path: wt, root: wt }],
    branches: [{ repo: "acme/app", n: "7", base: "main", branch: "feat-x", sha: mergedHead, root: repo, remote: "origin" }],
  });
  expect(world.ops.filter((e) => e.op === "git")).toEqual([]);
  // Stage two: the watcher reads the worktree clean and pushed again, removes it, then deletes the branch.
  expect(await watchTick(deps())).toEqual([
    `WORKTREE_CLEANED demo-lane ${wt}`,
    `BRANCH_CLEANED demo-lane remote branch origin/feat-x deleted (acme/app#7 merged head ${mergedHead.slice(0, 10)}); branch feat-x deleted (acme/app#7 merged head ${mergedHead.slice(0, 10)})`,
  ]);
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBeUndefined();
  // Done is marked in the queue: a later pass repeats nothing.
  expect(await watchTick(deps())).toEqual([]);
  expect(updateRefs()).toEqual([["git", "-C", repo, "update-ref", "-d", "refs/heads/feat-x", mergedHead]]);
  // Both deletes are recorded operations carrying the merged head, so the runner's compare-and-delete guards them.
  const deletes = world.ops.filter((e) => e.op === "git" && (e.args as { op: string }).op !== "worktree-remove").map((e) => e.args);
  expect(deletes).toEqual([
    { op: "remote-branch-delete", root: repo, branch: "feat-x", remote: "origin", sha: mergedHead, opts: { cmdId: `op:demo-lane/remote-branch-delete/acme/app#7@${mergedHead}:1` } },
    { op: "branch-delete", root: repo, branch: "feat-x", sha: mergedHead, opts: { cmdId: `op:demo-lane/branch-delete/acme/app#7@${mergedHead}:1` } },
  ]);
  const ops = openOperations({ stateDir: state.dir, store: TEST_STORE });
  try {
    expect(ops.get(`demo-lane/worktree-remove/${wt}`)?.state).toBe("verified");
    expect(ops.get(`demo-lane/branch-delete/acme/app#7@${mergedHead}`)?.state).toBe("verified");
    expect(ops.get(`demo-lane/remote-branch-delete/acme/app#7@${mergedHead}`)?.state).toBe("verified");
  } finally { ops.close(); }
  expect(await remoteTip()).toBe("");
});

test("a queued worktree that is dirty or holds a commit no remote has stays, and its branch waits for it", async () => {
  expect((await closeLane(deps(), lane(), "manual")).closed).toBe(true);
  writeFileSync(join(wt, "scratch"), "x");
  expect(await watchTick(deps())).toEqual([]);
  await git("-C", wt, "add", "scratch");
  await git("-C", wt, "commit", "-q", "-m", "local only");
  expect(await watchTick(deps())).toEqual([]);
  expect(existsSync(wt)).toBe(true);
  expect(await localTip()).not.toBe(mergedHead);
  expect(world.ops.filter((e) => e.op === "git")).toEqual([]);
});

/** One watcher pass that skips the archive (the supervisor's passes between two archive walks). */
const quickPass = (pending: ReturnType<typeof newPendingCleanup>) => watchTick(deps(), undefined, false, () => true, pending);

test("a lane closed between passes has its queued worktree and branch cleaned by the next pass that skips the archive", async () => {
  const pending = newPendingCleanup();
  expect(await quickPass(pending)).toEqual([]);
  expect((await closeLane(deps(), lane(), "manual")).closed).toBe(true);
  expect(await quickPass(pending)).toEqual([
    `WORKTREE_CLEANED demo-lane ${wt}`,
    `BRANCH_CLEANED demo-lane remote branch origin/feat-x deleted (acme/app#7 merged head ${mergedHead.slice(0, 10)}); branch feat-x deleted (acme/app#7 merged head ${mergedHead.slice(0, 10)})`,
  ]);
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBeUndefined();
  expect(pending.keys.size).toBe(0);
  expect(await quickPass(pending)).toEqual([]);
});

test("queued cleanup still to do survives a supervisor restart: its first archive pass picks it up and later quick passes finish it", async () => {
  const before = newPendingCleanup();
  await quickPass(before);
  expect((await closeLane(deps(), lane(), "manual")).closed).toBe(true);
  writeFileSync(join(wt, "scratch"), "x");
  expect(await quickPass(before)).toEqual([]);
  expect([...before.keys]).toEqual(["demo-lane"]);
  // Restart: the watcher's memory is gone; the queue in the receipt is not.
  const after = newPendingCleanup();
  expect(await quickPass(after)).toEqual([]);
  expect(await watchTick(deps(), undefined, true, () => true, after)).toEqual([]);
  expect([...after.keys]).toEqual(["demo-lane"]);
  expect(existsSync(wt)).toBe(true);
  rmSync(join(wt, "scratch"));
  expect((await quickPass(after))[0]).toBe(`WORKTREE_CLEANED demo-lane ${wt}`);
  expect(existsSync(wt)).toBe(false);
  expect(after.keys.size).toBe(0);
});

test("a local lane's queued worktree outside the worktree root is still removed: the close found and checked it as the lane's", async () => {
  const r = await closeThenSweep(deps({ worktreeRoot: join(state.dir, "elsewhere") }));
  expect(r.closed).toBe(true);
  expect(r.swept[0]).toBe(`WORKTREE_CLEANED demo-lane ${wt}`);
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBeUndefined();
});

test("a commit pushed after the merge keeps the worktree and the branch, says why, and the closed-lane sweep leaves them", async () => {
  const later = await commit(wt, "after-merge");
  await git("-C", wt, "push", "-q", "origin", "feat-x");
  const r = await closeLane(deps(), lane(), "manual");
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(true);
  expect(await localTip()).toBe(later);
  expect((await receipt())).toContain(`branch-bound worktree ${wt} kept: branch feat-x tip ${later.slice(0, 10)} is not the merged head ${mergedHead.slice(0, 10)} of acme/app#7`);
  expect((await receipt())).toContain(`branch feat-x kept: tip ${later.slice(0, 10)} is not the merged head ${mergedHead.slice(0, 10)} of acme/app#7 (a commit after the merge)`);
  expect(updateRefs()).toEqual([]);
  expect(await watchTick(deps())).toEqual([]);
  expect(existsSync(wt)).toBe(true);
  expect(statusOf((await deps().registry.read("demo-lane")) ?? lane())).toBe("closed");
});

/**
 * A closed lane whose close left no kept line (its worktree `<root>/app-demo-lane` is not named by the key and sits on a
 * detached HEAD, so the close never found it), with gitignored build output in it.
 */
const closedUnfound = async (): Promise<{ readonly path: string; readonly closed: Lane }> => {
  const path = join(state.dir, "wt", "app-demo-lane");
  await git("-C", repo, "worktree", "add", "-q", "--detach", path, mergedHead);
  writeFileSync(join(path, ".gitignore"), "node_modules/\n");
  await git("-C", path, "add", ".gitignore");
  await git("-C", path, "commit", "-q", "-m", "ignore");
  await git("-C", path, "push", "-q", "origin", "HEAD:refs/heads/app-demo");
  mkdirSync(join(path, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(path, "node_modules", "dep", "index.js"), "x");
  const closed: Lane = { ...lane(), cwd: path, worktrees: [path], status: "closed", closedAt: new Date(T0).toISOString(), receipt: { cleanup: [] } };
  await deps().registry.write(closed);
  return { path, closed };
};
const listed = async (path: string): Promise<boolean> => (await git("-C", repo, "worktree", "list", "--porcelain")).split("\n").includes(`worktree ${path}`);

test("the closed-lane sweep removes the lane's own clean, pushed worktree the close never found, gitignored output and all", async () => {
  const { path } = await closedUnfound();
  expect(await watchTick(deps())).toEqual([`WORKTREE_CLEANED demo-lane ${path}`]);
  expect(existsSync(path)).toBe(false);
  expect(await listed(path)).toBe(false);
});

test("the closed-lane sweep keeps the lane's own worktree with a tracked change, a commit no remote has, or an open lane in it", async () => {
  const { path, closed } = await closedUnfound();
  writeFileSync(join(path, "init"), "changed");
  expect(await watchTick(deps())).toEqual([]);
  await git("-C", path, "commit", "-q", "-am", "local only");
  expect(await watchTick(deps())).toEqual([]);
  await git("-C", path, "push", "-q", "origin", "HEAD:refs/heads/app-demo");
  await deps().registry.write({ ...lane(), key: "other-lane", pane: "w:p2", cwd: path, worktrees: [] });
  expect(await watchTick(deps())).toEqual([]);
  expect(existsSync(path) && await listed(path)).toBe(true);
  expect(statusOf((await deps().registry.read(closed.key)) ?? closed)).toBe("closed");
});

test("a closed remote lane's own worktree under its runner's root is removed from inside itself once clean and pushed", async () => {
  const { path, closed } = await closedUnfound();
  await deps().registry.write({ ...closed, machine: "build host" });
  const remote = { ...deps({ worktreeRoot: "" }), runnerWorktreeRoot: (label: string) => (label === "build host" ? join(state.dir, "wt") : undefined) };
  expect(await watchTick(remote)).toEqual([`WORKTREE_CLEANED demo-lane ${path}`]);
  expect(world.ops.filter((e) => e.op === "git").map((e) => e.args)).toEqual([{ op: "worktree-remove", root: path, path, opts: { cmdId: `op:demo-lane/worktree-remove/${path}:1` } }]);
  expect(await listed(path)).toBe(false);
});

test("a remote branch that moved after the merge keeps the local branch even when the local tip is the merged head", async () => {
  await commit(wt, "pushed-elsewhere");
  await git("-C", wt, "push", "-q", "origin", "feat-x");
  await git("-C", wt, "reset", "-q", "--hard", mergedHead);
  const r = await closeThenSweep();
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBe(mergedHead);
  expect(r.swept.some((l) => l.startsWith("LANE_WATCH_WARN demo-lane branch feat-x kept: origin/feat-x is at ") && l.includes("a commit pushed after the merge"))).toBe(true);
  expect(await remoteTip()).not.toBe(mergedHead);
  expect(updateRefs()).toEqual([]);
  // A keep no later pass can change is settled: it is said once and never tried again.
  expect(await watchTick(deps())).toEqual([]);
});

test("another open lane naming the same PR keeps the branch until that lane no longer names it", async () => {
  const other: Lane = { ...lane(), key: "other-lane", pane: "w:p2", cwd: repo, worktrees: [] };
  await deps().registry.write(other);
  const r = await closeThenSweep();
  expect(r.closed).toBe(true);
  expect(await localTip()).toBe(mergedHead);
  expect(r.swept).toEqual([`WORKTREE_CLEANED demo-lane ${wt}`, "LANE_WATCH_WARN demo-lane branch feat-x not deleted yet: open lane other-lane also names acme/app#7"]);
  expect(await watchTick(deps())).toEqual([]);
  await deps().registry.write({ ...other, done: 'command ["bash","-c","echo OK"] stdout~"OK"' });
  expect((await watchTick(deps()))[0]).toStartWith("BRANCH_CLEANED demo-lane ");
  expect(await localTip()).toBeUndefined();
});

test("a sweep interrupted after the worktree went still deletes the branch on the next pass, from the root it recorded", async () => {
  expect((await closeLane(deps(), lane(), "manual")).closed).toBe(true);
  const live = runner();
  const crashing: Runner = async (argv, opts) => {
    if (argv.includes("ls-remote")) throw new Error("killed");
    return live(argv, opts);
  };
  expect(await watchTick(deps({}, crashing))).toEqual(["LANE_WATCH_WARN demo-lane LANE_OP_FAILED runner=local killed"]);
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBe(mergedHead);
  // The worktree is gone (its operation verified, the queue not yet marked): only the branch is left, and it goes.
  expect(await watchTick(deps())).toEqual([`BRANCH_CLEANED demo-lane remote branch origin/feat-x deleted (acme/app#7 merged head ${mergedHead.slice(0, 10)}); branch feat-x deleted (acme/app#7 merged head ${mergedHead.slice(0, 10)})`]);
  expect(await localTip()).toBeUndefined();
  expect(world.ops.filter((e) => e.op === "git" && (e.args as { op: string }).op === "worktree-remove")).toHaveLength(1);
});

test("a queued worktree removed by hand before the sweep still has its branch deleted", async () => {
  expect((await closeLane(deps(), lane(), "manual")).closed).toBe(true);
  await git("-C", repo, "worktree", "remove", wt);
  expect(await watchTick(deps())).toEqual([`BRANCH_CLEANED demo-lane remote branch origin/feat-x deleted (acme/app#7 merged head ${mergedHead.slice(0, 10)}); branch feat-x deleted (acme/app#7 merged head ${mergedHead.slice(0, 10)})`]);
  expect(await localTip()).toBeUndefined();
  expect(await remoteTip()).toBe("");
});

/** A lane launched in its worktree (cwd), named apart from its branch, whose Done line names no PR (the usual launch). */
const branchLane = (): Lane => ({ ...lane(), key: "plain-lane", done: 'command ["bash","-c","echo OK"] stdout~"OK"', worktrees: undefined });
const mergedPr = (sha: string) => ({ number: 9, headRefName: "feat-x", headRefOid: sha, baseRefName: "dev", isCrossRepository: false });

test("a lane whose worktree branch has a PR merged into dev loses its worktree, local and remote branch with no merged Done signal", async () => {
  mergedFromBranch = [mergedPr(mergedHead)];
  // The default open lane works elsewhere, so the sweep may take this one's directory.
  await deps().registry.write({ ...lane(), cwd: repo, worktrees: [] });
  await deps().registry.write(branchLane());
  const r = await closeThenSweep(deps(), branchLane());
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBeUndefined();
  expect(await remoteTip()).toBe("");
  expect((await receipt("plain-lane"))).toEqual([
    `worktree ${wt} queued: ${QUEUED}`,
    `branch feat-x queued: deleted by the closed-lane cleanup after its worktrees go, only while it is at acme/app#9 merged head ${mergedHead.slice(0, 10)}`,
    "pane w:p1 closed",
  ]);
  expect(r.swept).toEqual([
    `WORKTREE_CLEANED plain-lane ${wt}`,
    `BRANCH_CLEANED plain-lane remote branch origin/feat-x deleted (acme/app#9 merged head ${mergedHead.slice(0, 10)}); branch feat-x deleted (acme/app#9 merged head ${mergedHead.slice(0, 10)})`,
  ]);
  expect(world.calls.find((c) => c[0] === "gh" && c[2] === "list")).toEqual(["gh", "pr", "list", "--repo", "acme/app", "--state", "merged", "--base", "dev", "--head", "feat-x", "--json", "number,headRefName,headRefOid,baseRefName,isCrossRepository", "--limit", "20"]);
});

test("a lane whose worktree branch has no merged PR keeps its worktree and both branches", async () => {
  await deps().registry.write(branchLane());
  const r = await closeLane(deps(), branchLane(), "manual");
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(true);
  expect(await localTip()).toBe(mergedHead);
  expect(await remoteTip()).toBe(mergedHead);
  expect(updateRefs()).toEqual([]);
  expect(world.calls.filter((c) => c.includes("push"))).toEqual([]);
});

test("a worktree branch that moved past its merged PR keeps its worktree and both branches", async () => {
  mergedFromBranch = [mergedPr(mergedHead)];
  const later = await commit(wt, "after-merge");
  await git("-C", wt, "push", "-q", "origin", "feat-x");
  await deps().registry.write(branchLane());
  const r = await closeLane(deps(), branchLane(), "manual");
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(true);
  expect(await localTip()).toBe(later);
  expect(await remoteTip()).toBe(later);
  expect((await receipt("plain-lane"))).toContain(`branch feat-x kept: tip ${later.slice(0, 10)} is not the merged head ${mergedHead.slice(0, 10)} of acme/app#9 (a commit after the merge)`);
  expect(world.calls.filter((c) => c.includes("push") || c.includes("update-ref") || (c.includes("worktree") && c.includes("remove")))).toEqual([]);
});

/** The lane claimed done one minute ago: its five-minute window is still open. */
const claimed = (): Lane => ({ ...branchLane(), status: "done-claimed", claim: { at: new Date(T0 - 60_000).toISOString(), evidence: "PR green", emitted: true } });

test("a done-claimed lane whose PR the supervisor merged (CI_MERGED) closes at once, with its branch cleanup", async () => {
  await deps().registry.write(claimed());
  const ops = openOperations({ stateDir: state.dir, store: TEST_STORE });
  try {
    const op = plan(ops, T0, { lane: "plain-lane", action: "merge", target: `acme/app#9@${mergedHead}` });
    settleOperation(ops, T0, op.id, "verified", "");
  } finally { ops.close(); }
  mergedFromBranch = [mergedPr(mergedHead)];
  const lines = await watchTick(deps());
  expect(lines[0]).toStartWith("LANE_CLOSED plain-lane");
  expect(statusOf((await deps().registry.read("plain-lane")) ?? lane())).toBe("closed");
  expect(existsSync(wt)).toBe(true);
  // The open demo-lane still works in that directory: the worktree stays, and its branch waits for it without a word.
  expect(await watchTick(deps())).toEqual([]);
  expect(existsSync(wt)).toBe(true);
  await deps().registry.write({ ...lane(), cwd: repo, worktrees: [] });
  expect((await watchTick(deps()))[0]).toBe(`WORKTREE_CLEANED plain-lane ${wt}`);
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBeUndefined();
});

test("a done-claimed lane whose worktree branch GitHub reports merged at its HEAD closes at once", async () => {
  await deps().registry.write(claimed());
  mergedFromBranch = [mergedPr(mergedHead)];
  const lines = await watchTick(deps());
  expect(lines[0]).toStartWith("LANE_CLOSED plain-lane");
  expect((await deps().registry.read("plain-lane"))?.receipt).toMatchObject({ note: expect.stringContaining("closed at once: acme/app#9 merged into dev") });
});

/** `runner()` with every git read whose argv matches `hit` failing as git does without access (exit 128), from when `armed()` holds. */
const failingReads = (hit: (argv: readonly string[]) => boolean, armed: () => boolean = () => true): Runner => {
  const live = runner();
  return async (argv, opts) => (hit(argv) && armed() ? { code: 128, out: "", err: "fatal: permission denied" } : live(argv, opts));
};
const localRead = (argv: readonly string[]) => argv.includes("rev-parse") && argv.includes("refs/heads/feat-x");
const remoteRead = (argv: readonly string[]) => argv.includes("ls-remote");

test("an unreadable local branch is kept as unreadable, never 'already gone', and its remote branch is left", async () => {
  const r = await closeThenSweep(deps({}, failingReads(localRead)));
  expect(r.closed).toBe(true);
  expect(r.swept).toContain(`LANE_WATCH_WARN demo-lane branch feat-x not deleted yet: cannot read refs/heads/feat-x in ${repo}`);
  expect(r.swept.some((l) => l.includes("already gone"))).toBe(false);
  expect(await localTip()).toBe(mergedHead);
  expect(await remoteTip()).toBe(mergedHead);
  expect(world.ops.filter((e) => e.op === "git" && (e.args as { op: string }).op !== "worktree-remove")).toEqual([]);
});

test("a failed remote read keeps the branch instead of passing the remote-tip gate", async () => {
  const r = await closeThenSweep(deps({}, failingReads(remoteRead)));
  expect(r.closed).toBe(true);
  expect(r.swept).toContain(`LANE_WATCH_WARN demo-lane branch feat-x not deleted yet: cannot read refs/heads/feat-x in ${repo}`);
  expect(await localTip()).toBe(mergedHead);
  expect(await remoteTip()).toBe(mergedHead);
  expect(updateRefs()).toEqual([]);
});

test("a branch delete whose read-back fails is ambiguous, never verified", async () => {
  const failing = deps({}, failingReads(localRead, () => updateRefs().length > 0));
  const r = await closeThenSweep(failing);
  expect(r.closed).toBe(true);
  expect(r.swept.some((l) => l.startsWith(`OPERATION_AMBIGUOUS demo-lane/branch-delete/acme/app#7@${mergedHead}`))).toBe(true);
  const ops = openOperations({ stateDir: state.dir, store: TEST_STORE });
  try { expect(ops.get(`demo-lane/branch-delete/acme/app#7@${mergedHead}`)?.state).toBe("ambiguous"); } finally { ops.close(); }
  // An ambiguous delete is the lead's (dori ops resolve): it is told once and never retried on a guess.
  expect(await watchTick(failing)).toEqual([]);
  expect(updateRefs()).toHaveLength(1);
});

for (const [name, hold] of [
  // The main checkout's HEAD names feat-x (git refuses a checkout of a branch another worktree has; HEAD is set directly).
  ["the main checkout", async () => { await git("-C", repo, "symbolic-ref", "HEAD", "refs/heads/feat-x"); return repo; }],
  ["an unrelated worktree", async () => { const other = join(state.dir, "unrelated"); await git("-C", repo, "worktree", "add", "-q", "-f", other, "feat-x"); return other; }],
] as const) {
  test(`a merged branch still checked out in ${name} is kept, locally and on the remote`, async () => {
    const at = await hold();
    const r = await closeThenSweep();
    expect(r.closed).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(await localTip()).toBe(mergedHead);
    expect(await remoteTip()).toBe(mergedHead);
    expect(updateRefs()).toEqual([]);
    expect(r.swept).toContain(`LANE_WATCH_WARN demo-lane branch feat-x not deleted yet: branch feat-x is checked out in ${at}`);
  });
}

test("a done-claimed lane with no merged PR waits out its claim window", async () => {
  await deps().registry.write(claimed());
  expect(await watchTick(deps())).toEqual([]);
  expect(statusOf((await deps().registry.read("plain-lane")) ?? lane())).toBe("done-claimed");
  expect(existsSync(wt)).toBe(true);
});

