import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CiFollowUp, mergeLaneKey } from "../src/ci-follow.ts";
import type { OpenPull } from "../src/github-events.ts";
import { MERGE_PAUSE_FILE, mergePauseHolds, mergePauseMain, readMergePause } from "../src/merge-pause.ts";
import type { Lane } from "../src/registry.ts";
import { type PrInfo, ReviewGate, type ReviewGateIo } from "../src/review-gate.ts";
import { readReviewStatus, reviewStatusLines } from "../src/review-status.ts";
import type { Ran, Runner } from "../src/run.ts";
import { withReviewHold } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

/**
 * The merge rollback switch (merge-pause.ts): `dori merge pause` stops every `gh pr merge` of CI follow-up while the
 * review gate keeps running, and `dori merge resume` lets merges go on only through the full gate. CiFollowUp and a real
 * ReviewGate over a fake GitHub, as in review-merge-gate.test.ts, on a temp stateDir with a fake clock.
 */

const T0 = Date.parse("2026-11-14T12:00:00Z");
const REPO = "acme/app";
const sha = (c: string): string => c.repeat(40);
const H7 = sha("a"), H9 = sha("9");
const REASON = "rollout check of the review gate";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const greenView = (head: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: "OPEN", baseRefName: "dev", headRefOid: head, isCrossRepository: false, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], mergeCommit: null, ...patch,
});

const harness = async () => {
  const state = withState();
  cleanups.push(state.done);
  const dir = state.dir;
  const clock = fakeClock(T0);
  const world = newWorld();
  const prs = new Map<number, PrInfo>([[7, { state: "OPEN", baseRef: "dev", headSha: H7, title: "Add thing", body: "body" }]]);
  const views = new Map<number, Record<string, unknown>>([[7, greenView(H7)]]);
  const gh = { baseTip: sha("b"), mergeBase: sha("c"), diff: "diff --git a/x b/x\n+1\n", files: new Map<string, string>() };
  const merges: string[][] = [];
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts): Promise<Ran> => {
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return { code: 0, out: JSON.stringify(views.get(Number(argv[3]))), err: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
      merges.push([...argv]);
      const n = Number(argv[3]);
      views.set(n, { ...views.get(n), state: "MERGED", mergeCommit: { oid: sha("f") } });
      prs.set(n, { ...prs.get(n)!, state: "MERGED" });
      return { code: 0, out: "", err: "" };
    }
    return base(argv, opts);
  };
  const deps = { ...depsFor(world, clock, dir), run };
  const launches: string[] = [];
  let n = 0;
  const home = join(dir, "home");
  const io: Partial<ReviewGateIo> = {
    prInfo: async (_repo, num) => { const p = prs.get(num); if (!p) throw new Error(`no PR ${num}`); return p; },
    branchSha: async () => gh.baseTip,
    mergeBase: async () => gh.mergeBase,
    diff: async () => gh.diff,
    fileAt: async (_repo, at, path) => {
      const text = gh.files.get(`${at}:${path}`);
      if (text === undefined) throw new Error(`no ${path} at ${at}`);
      return text;
    },
    mergeParent: async () => gh.baseTip,
    fetchHead: async () => {},
    prepareSnapshot: async (input) => ({ ok: true, path: input.path, startedAt: clock.now() }),
    checkScope: async () => ({ ok: true }),
    releaseSnapshot: async () => ({ ok: true }),
    launch: async (request) => {
      launches.push(request.key);
      const lane: Lane = { key: request.key, title: request.title, thread: "t1", brief: request.brief, done: "file /x", review: true, openedAt: new Date(clock.now()).toISOString() };
      await deps.registry.write(lane);
      return { kind: "started", lane, startup: "STARTUP ok" };
    },
    closeLane: async (lane) => {
      await deps.registry.update(lane.key, (cur) => (cur ? { ...cur, status: "closed", closedAt: new Date(clock.now()).toISOString() } : undefined));
      return { closed: true, lines: [] };
    },
    outDir: (key) => join(dir, "out", key),
    worktreeRoot: () => "/wt",
    repoDir: () => "/repo/main",
    home,
    randomHex: (bytes) => (++n).toString(16).padStart(bytes * 2, "0"),
  };
  const brief = join(dir, "author.md");
  writeFileSync(brief, "Implement the thing.\n");
  const author = (head = H7, patch: Partial<Lane> = {}): Lane => ({
    key: "author", title: "author", thread: "t1", brief, done: `merged ${REPO}#7`, cwd: "/repo/author", openedAt: new Date(T0).toISOString(),
    status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "e", emitted: true, pulls: [{ repo: REPO, number: 7, sha: head }] }, ...patch,
  });
  await deps.registry.write(author());
  const events: [string, string][] = [];
  const emit = (id: string, line: string): void => { events.push([id, line]); };
  const gate = new ReviewGate(deps, io);
  const ci = new CiFollowUp(deps, gate, { launch: async () => ({ ok: false, detail: "no merge lane in this test" }) });
  cleanups.unshift(() => { ci.close(); });
  const pull = (head = H7): OpenPull => ({
    repo: REPO, number: 7, sha: head, branch: "feat-7", headRepo: REPO, url: `https://github.com/${REPO}/pull/7`, conflicting: false, checks: "green",
  });
  const lines = (kind: string): string[] => [...new Map(events.filter(([, l]) => l.startsWith(`${kind} `))).values()];

  /** The reviewer lane of `jobId` submits a valid pass; the gate's tick stores the receipt. */
  const pass = async (jobId: string): Promise<void> => {
    const r = gate.jobs.get(jobId)!;
    const key = r.job.reviewerLaneKey;
    const token = /"jobToken": "([0-9a-f]+)"/.exec(readFileSync(join(dir, "briefs", `${key}.md`), "utf8"))![1]!;
    const out = join(dir, "out", key);
    mkdirSync(out, { recursive: true });
    const recordDir = join(home, ".omo", "agent", "projects", "p", "senpi-task", "tasks");
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, "t1.json"), JSON.stringify({ task_id: "t1", status: "completed", agent_type: "omo-native-gate-reviewer", resolved_model: { provider: "openai", model_id: "gpt" } }));
    writeFileSync(join(out, "review-body.json"), JSON.stringify({ schemaVersion: 1, jobId, verdict: "pass", summary: "s", findings: [], notes: [] }));
    writeFileSync(join(out, "review-report.md"), "# report\n");
    writeFileSync(join(out, "review-result.json"), JSON.stringify({
      jobId, jobToken: token, source: "reviewer", body: "review-body.json", taskRecord: join(recordDir, "t1.json"),
      startedAt: "2026-11-14T12:00:00Z", completedAt: "2026-11-14T12:05:00Z",
    }));
    await deps.registry.update(key, (cur) => (cur ? { ...cur, status: "done-claimed", claim: { at: new Date(clock.now()).toISOString(), evidence: "done" } } : undefined));
    await gate.tick(emit);
    expect(gate.jobs.get(jobId)?.execution.state).toBe("completed");
  };
  const poll = async (pulls: readonly OpenPull[] = [pull()]): Promise<void> => {
    await ci.tick(pulls, emit);
    await gate.tick(emit);
  };
  /** Polls until #7 has a running review job at `head`, passes it, and returns its id. */
  const approve = async (head = H7): Promise<string> => {
    await poll([pull(head)]);
    const job = gate.jobs.list().filter((r) => r.job.snapshot.headSha === head && r.execution.state === "running").at(-1);
    if (!job) throw new Error(`no running review job at ${head}`);
    await pass(job.job.jobId);
    return job.job.jobId;
  };
  const out: string[] = [];
  const cli = (...args: string[]): number => mergePauseMain(args, {
    stateDir: dir, now: clock.now, who: "lead (test)", out: (l) => { out.push(l); }, err: (l) => { out.push(`ERR ${l}`); },
  });
  const statusLines = async (lane: Lane = author()): Promise<string[]> => reviewStatusLines(lane, await readReviewStatus(deps, gate));
  return { dir, clock, deps, prs, views, gh, merges, launches, gate, ci, author, pull, events, lines, poll, pass, approve, cli, out, statusLines };
};

type Harness = Awaited<ReturnType<typeof harness>>;

/** T6: H7 is a one-line prose fix of README.md. */
const docsOnly = (h: Harness): void => {
  h.gh.diff = "diff --git a/README.md b/README.md\nindex 1111111..2222222 100644\n--- a/README.md\n+++ b/README.md\n@@ -3 +3 @@\n-Teh fix.\n+The fix.\n";
  h.gh.files.set(`${h.gh.mergeBase}:README.md`, "# App\n\nTeh fix.\n");
  h.gh.files.set(`${H7}:README.md`, "# App\n\nThe fix.\n");
};

const MERGED_AT_H7 = ["gh", "pr", "merge", "7", "-R", REPO, "--merge", "--match-head-commit", H7];

test("paused: the review runs and its pass receipt is stored, but no gh pr merge; the lane stays held and its status shows the pause", async () => {
  const h = await harness();
  expect(h.cli("pause", "--reason", REASON)).toBe(0);
  const jobId = await h.approve();
  expect(h.gate.jobs.get(jobId)?.receipt?.result.verdict).toBe("pass");
  for (let i = 0; i < 3; i++) await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.lines("CI_MERGED")).toEqual([]);
  const paused = h.lines("MERGE_PAUSED");
  expect(paused).toHaveLength(1);
  expect(paused[0]).toContain(`merge paused: ${REASON}`);
  // A long pause is no merge stall: the pause, not the PR, is what waits.
  h.clock.at += 2 * 60 * 60_000;
  await h.poll();
  expect(h.lines("MERGE_STALLED")).toEqual([]);
  // The pass releases the review gate's own hold, the pause keeps the lane open (no close, no objection).
  expect(await h.gate.holdsLane(h.author())).toBe(false);
  expect(await withReviewHold(h.deps, h.gate).reviewHold!(h.author())).toBe(true);
  const status = await h.statusLines();
  expect(status[0]).toStartWith(`merge paused: ${REASON}`);
  expect(status.some((l) => l.includes("리뷰 통과"))).toBe(true);
});

test("resume: the next poll merges through the full gate at the approved head, and the pause line leaves the status", async () => {
  const h = await harness();
  h.cli("pause", "--reason", REASON);
  await h.approve();
  await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.cli("resume")).toBe(0);
  // Read fresh: no restart, no new CiFollowUp or ReviewGate.
  expect(await withReviewHold(h.deps, h.gate).reviewHold!(h.author())).toBe(false);
  expect((await h.statusLines()).some((l) => l.includes("merge paused"))).toBe(false);
  await h.poll();
  expect(h.merges).toEqual([MERGED_AT_H7]);
  expect(h.lines("CI_MERGED")).toHaveLength(1);
});

test("head moved during the pause: after resume the stale pass never merges; the new head is reviewed first", async () => {
  const h = await harness();
  h.cli("pause", "--reason", REASON);
  const first = await h.approve();
  await h.poll();
  // The author pushes H9 and claims again at it while merges are paused.
  h.views.set(7, greenView(H9));
  h.prs.set(7, { ...h.prs.get(7)!, headSha: H9 });
  await h.deps.registry.update("author", () => h.author(H9));
  h.cli("resume");
  await h.poll([h.pull(H9)]);
  expect(h.merges).toEqual([]);
  const running = h.gate.jobs.list().filter((r) => r.execution.state === "running");
  expect(running.map((r) => r.job.snapshot.headSha)).toEqual([H9]);
  expect(running[0]!.job.jobId).not.toBe(first);
  // A poll that still lists the old head cannot merge it either: GitHub's head moved.
  await h.poll([h.pull(H7)]);
  expect(h.merges).toEqual([]);
  await h.pass(running[0]!.job.jobId);
  await h.poll([h.pull(H9)]);
  expect(h.merges).toEqual([["gh", "pr", "merge", "7", "-R", REPO, "--merge", "--match-head-commit", H9]]);
});

test("base moved during the pause: after resume the approval is stale and a fresh review runs before any merge", async () => {
  const h = await harness();
  h.cli("pause", "--reason", REASON);
  await h.approve();
  await h.poll();
  h.gh.baseTip = sha("d");
  h.cli("resume");
  await h.poll();
  expect(h.merges).toEqual([]);
  const running = h.gate.jobs.list().filter((r) => r.execution.state === "running");
  expect(running.map((r) => r.job.snapshot.baseSha)).toEqual([sha("d")]);
  await h.pass(running[0]!.job.jobId);
  await h.poll();
  expect(h.merges).toEqual([MERGED_AT_H7]);
});

test("a docs-exempt PR is held while paused too, and merges on its exemption after resume", async () => {
  const h = await harness();
  docsOnly(h);
  h.cli("pause", "--reason", REASON);
  await h.poll();
  await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.launches).toEqual([]);
  expect(h.gate.exemptions.list().map((d) => d.kind)).toEqual(["exempt"]);
  expect(h.lines("MERGE_PAUSED")).toHaveLength(1);
  expect(await withReviewHold(h.deps, h.gate).reviewHold!(h.author())).toBe(true);
  expect((await h.statusLines())[0]).toStartWith(`merge paused: ${REASON}`);
  h.cli("resume");
  await h.poll();
  expect(h.merges).toEqual([MERGED_AT_H7]);
  expect(h.launches).toEqual([]);
});

test("a merge lane's PR is held while paused like any other", async () => {
  const h = await harness();
  // The owner's claim is at another head; the merge lane claimed at H7 and stands in for it (D12).
  await h.deps.registry.update("author", () => h.author(sha("0")));
  const brief = join(h.dir, "merge.md");
  writeFileSync(brief, "Resolve the conflict.\n");
  await h.deps.registry.write({
    key: mergeLaneKey(h.pull()), title: "merge", thread: "t1", brief, done: `pr ${REPO} "feat-7"`, cwd: "/wt/app/merge", openedAt: new Date(T0 + 1000).toISOString(),
    status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "pushed", emitted: true, pulls: [{ repo: REPO, number: 7, sha: H7 }] },
  });
  h.cli("pause", "--reason", REASON);
  await h.approve();
  await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.lines("MERGE_PAUSED")[0]).toContain(`lane=${mergeLaneKey(h.pull())}`);
  h.cli("resume");
  await h.poll();
  expect(h.merges).toEqual([MERGED_AT_H7]);
});

test("CLI round trip on a temp stateDir: status, pause (reason, since, who), pause again keeps the first, resume, status", async () => {
  const h = await harness();
  const file = join(h.dir, MERGE_PAUSE_FILE);
  expect(h.cli("status")).toBe(0);
  expect(h.cli("pause")).toBe(2);
  expect(h.cli("resume", "--reason", "x")).toBe(2);
  expect(h.cli("skip-review")).toBe(2);
  expect(existsSync(file)).toBe(false);
  expect(h.cli("pause", "--reason", REASON)).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ reason: REASON, since: new Date(T0).toISOString(), who: "lead (test)" });
  h.clock.at += 60_000;
  expect(h.cli("pause", "--reason", "another")).toBe(0);
  expect(readMergePause(h.dir)?.reason).toBe(REASON);
  expect(h.cli("status")).toBe(0);
  expect(h.cli("resume")).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(h.cli("resume")).toBe(0);
  expect(h.cli("status")).toBe(0);
  const detail = `merge paused: ${REASON} (since ${new Date(T0).toISOString()}, by lead (test))`;
  expect(h.out.filter((l) => !l.startsWith("ERR "))).toEqual([
    "MERGE_ACTIVE automatic merges run through the review gate",
    `MERGE_PAUSED ${detail}`,
    `MERGE_PAUSED ${detail} (already paused)`,
    `MERGE_PAUSED ${detail}`,
    "MERGE_RESUMED merges go on through the full review gate at the next poll",
    "MERGE_NOT_PAUSED",
    "MERGE_ACTIVE automatic merges run through the review gate",
  ]);
});

test("an unreadable pause file still pauses (fails closed)", async () => {
  const h = await harness();
  writeFileSync(join(h.dir, MERGE_PAUSE_FILE), "{not json");
  expect(readMergePause(h.dir)?.reason).toBe("pause file unparsable");
  expect(mergePauseHolds(h.dir, h.author())).toBe(true);
  await h.approve();
  await h.poll();
  expect(h.merges).toEqual([]);
});
