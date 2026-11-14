import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CiFollowUp, mergeLaneBrief, mergeLaneKey } from "../src/ci-follow.ts";
import type { OpenPull } from "../src/github-events.ts";
import type { Lane } from "../src/registry.ts";
import { criteriaText, type PrInfo, ReviewGate, type ReviewGateIo } from "../src/review-gate.ts";
import { snapshotKey } from "../src/review-receipt.ts";
import type { Ran, Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

/**
 * The supervisor's merge path with the real review gate (design D3, D4, D9, D10, D12): CiFollowUp over a fake GitHub
 * (`gh pr view` / `gh pr merge` through deps.run) and a ReviewGate over fake GitHub reads, launch and close effects.
 * A pass is produced the real way: the reviewer lane's out files and claim, taken in by the gate's tick.
 */

const T0 = Date.parse("2026-11-14T12:00:00Z");
const REPO = "acme/app";
const sha = (c: string): string => c.repeat(40);
const H7 = sha("a"), H8 = sha("8");

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
  const prs = new Map<number, PrInfo>([
    [7, { state: "OPEN", baseRef: "dev", headSha: H7, title: "Add thing", body: "body" }],
    [8, { state: "OPEN", baseRef: "dev", headSha: H8, title: "Other", body: "" }],
  ]);
  const views = new Map<number, Record<string, unknown>>([[7, greenView(H7)], [8, greenView(H8)]]);
  /** `tips` (when non-empty) answers the next base-tip reads in order, then `baseTip`. */
  /** `files` holds file texts by `<sha>:<path>` for the exemption classifier; a missing one reads as an error. */
  const gh = {
    baseTip: sha("b"), tips: [] as string[], mergeBase: sha("c"), parent: undefined as string | undefined, diff: "diff --git a/x b/x\n+1\n",
    files: new Map<string, string>(),
  };
  const merges: string[][] = [];
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts): Promise<Ran> => {
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return { code: 0, out: JSON.stringify(views.get(Number(argv[3]))), err: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
      merges.push([...argv]);
      const n = Number(argv[3]);
      views.set(n, { ...views.get(n), state: "MERGED", mergeCommit: { oid: sha(String(n % 10)).replace(/^./, "f") } });
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
    branchSha: async () => gh.tips.shift() ?? gh.baseTip,
    mergeBase: async () => gh.mergeBase,
    diff: async () => gh.diff,
    fileAt: async (_repo, at, path) => {
      const text = gh.files.get(`${at}:${path}`);
      if (text === undefined) throw new Error(`no ${path} at ${at}`);
      return text;
    },
    mergeParent: async () => gh.parent ?? gh.baseTip,
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
  const author = (pulls: { number: number; sha: string }[] = [{ number: 7, sha: H7 }], patch: Partial<Lane> = {}): Lane => ({
    key: "author", title: "author", thread: "t1", brief, done: pulls.map((p) => `merged ${REPO}#${p.number}`).join("; ") || `merged ${REPO}#7`,
    cwd: "/repo/author", openedAt: new Date(T0).toISOString(),
    status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "e", emitted: true, pulls: pulls.map((p) => ({ repo: REPO, ...p })) }, ...patch,
  });
  await deps.registry.write(author());
  const events: [string, string][] = [];
  const emit = (id: string, line: string): void => { events.push([id, line]); };
  const gate = new ReviewGate(deps, io);
  const ci = new CiFollowUp(deps, gate, { launch: async () => ({ ok: false, detail: "no merge lane in this test" }) });
  cleanups.unshift(() => { ci.close(); });
  const pull = (num = 7, head = num === 7 ? H7 : H8): OpenPull => ({
    repo: REPO, number: num, sha: head, branch: `feat-${num}`, headRepo: REPO, url: `https://github.com/${REPO}/pull/${num}`, conflicting: false, checks: "green",
  });
  /** Lines of one kind, one per journal id (the journal dedupes a repeated id). */
  const lines = (kind: string): string[] => [...new Map(events.filter(([, l]) => l.startsWith(`${kind} `))).values()];

  /** The reviewer lane of `jobId` submits a valid pass (its out files and done claim); the gate's tick takes it in. */
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
  /** One supervisor poll: CI follow-up, then the gate's tick. */
  const poll = async (pulls: readonly OpenPull[] = [pull()]): Promise<void> => {
    await ci.tick(pulls, emit);
    await gate.tick(emit);
  };
  /** Polls until #num has a review job, approves it, and returns its id. */
  const approve = async (num = 7, pulls: readonly OpenPull[] = [pull(num)]): Promise<string> => {
    await poll(pulls);
    const job = gate.jobs.list().filter((r) => r.job.snapshot.prNumber === num && r.execution.state === "running").at(-1);
    if (!job) throw new Error(`no running review job for #${num}`);
    await pass(job.job.jobId);
    return job.job.jobId;
  };
  return { dir, clock, deps, prs, views, gh, merges, launches, gate, ci, author, pull, events, lines, poll, pass, approve, brief };
};

test("no approval: no gh pr merge, and exactly one review job is triggered across repeated polls", async () => {
  const h = await harness();
  for (let i = 0; i < 4; i++) await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.gate.jobs.list()).toHaveLength(1);
  expect(h.launches).toHaveLength(1);
  expect(h.lines("REVIEW_STARTED")).toHaveLength(1);
  // Waiting for a review is no merge stall.
  h.clock.at += 60 * 60_000;
  await h.poll();
  expect(h.lines("MERGE_STALLED")).toEqual([]);
  expect(h.merges).toEqual([]);
});

test("approval and everything green: merged with --match-head-commit at the approved head", async () => {
  const h = await harness();
  await h.approve();
  await h.poll();
  expect(h.merges).toEqual([["gh", "pr", "merge", "7", "-R", REPO, "--merge", "--match-head-commit", H7]]);
  expect(h.lines("CI_MERGED")).toHaveLength(1);
  expect(h.lines("REVIEW_BASE_RACE")).toEqual([]);
});

for (const [name, change] of [
  ["head moved (claimed again at the new head)", async (h: Awaited<ReturnType<typeof harness>>) => {
    const H9 = sha("9");
    h.views.set(7, greenView(H9));
    h.prs.set(7, { ...h.prs.get(7)!, headSha: H9 });
    await h.deps.registry.update("author", () => h.author([{ number: 7, sha: H9 }]));
    return h.pull(7, H9);
  }],
  ["base moved", async (h: Awaited<ReturnType<typeof harness>>) => { h.gh.baseTip = sha("d"); return h.pull(); }],
  ["policy changed (receipt made under another policy version)", async (h: Awaited<ReturnType<typeof harness>>) => {
    // The approved job and its receipt were made under an older policy: their snapshot is not the one observed now.
    h.gate.jobs.transact((records, put) => {
      for (const r of Object.values(records)) {
        if (!r.receipt) continue;
        const snapshot = { ...r.job.snapshot, policyVersion: "t3-0" };
        put({ ...r, key: snapshotKey(snapshot), job: { ...r.job, snapshot }, receipt: { ...r.receipt, policyVersion: "t3-0" } });
      }
    });
    return h.pull();
  }],
  ["criteria changed (author brief edited)", async (h: Awaited<ReturnType<typeof harness>>) => { writeFileSync(h.brief, "Implement another thing.\n"); return h.pull(); }],
] as const) {
  test(`approval present but ${name}: no merge, a new review job starts`, async () => {
    const h = await harness();
    await h.approve();
    const next = await change(h);
    await h.poll([next]);
    expect(h.merges).toEqual([]);
    expect(h.gate.jobs.list().filter((r) => r.execution.state === "running")).toHaveLength(1);
    expect(h.launches).toHaveLength(2);
  });
}

for (const [name, change] of [
  ["red checks", (h: Awaited<ReturnType<typeof harness>>) => { h.views.set(7, greenView(H7, { statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }] })); }],
  ["not CLEAN", (h: Awaited<ReturnType<typeof harness>>) => { h.views.set(7, greenView(H7, { mergeStateStatus: "BLOCKED" })); }],
  ["not claimed", async (h: Awaited<ReturnType<typeof harness>>) => { await h.deps.registry.update("author", () => h.author([], { status: "working", claim: undefined, done: `merged ${REPO}#7` })); }],
] as const) {
  test(`approval present but ${name}: no merge`, async () => {
    const h = await harness();
    await h.approve();
    await change(h);
    await h.poll();
    await h.poll();
    expect(h.merges).toEqual([]);
    expect(h.lines("CI_MERGED")).toEqual([]);
  });
}

test("base moved between the approval check and the final re-read: no merge, the approval goes stale", async () => {
  const h = await harness();
  const jobId = await h.approve();
  // The approval check reads the approved tip; the final re-read right before the merge sees a new one.
  h.gh.tips = [sha("b"), sha("d")];
  await h.ci.tick([h.pull()], (id, line) => { h.events.push([id, line]); });
  expect(h.merges).toEqual([]);
  expect(h.gate.jobs.get(jobId)?.execution.state).toBe("stale");
  expect(h.lines("REVIEW_STALE").some((l) => l.includes(`job=${jobId}`))).toBe(true);
});

test("base race: the merge lands on another base than the approved one: merged, one REVIEW_BASE_RACE, recorded on the job", async () => {
  const h = await harness();
  const jobId = await h.approve();
  h.gh.parent = sha("e");
  await h.poll();
  await h.poll();
  expect(h.merges).toHaveLength(1);
  expect(h.lines("CI_MERGED")).toHaveLength(1);
  const race = h.lines("REVIEW_BASE_RACE");
  expect(race).toHaveLength(1);
  expect(race[0]).toStartWith(`REVIEW_BASE_RACE ${REPO}#7 lane=author job=${jobId} approved-base=${sha("b").slice(0, 7)} merged-onto=${sha("e").slice(0, 7)} merge=`);
  expect(h.gate.jobs.get(jobId)?.baseRace).toMatchObject({ approvedBaseSha: sha("b"), mergedOntoSha: sha("e") });
});

test("an autoClose machine lane's PR goes through the same gate", async () => {
  const h = await harness();
  await h.deps.registry.update("author", () => h.author(undefined, { machine: "m1", autoClose: "machine" }));
  await h.poll();
  await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.gate.jobs.list()).toHaveLength(1);
  await h.approve();
  await h.poll();
  expect(h.merges).toHaveLength(1);
});

test("a merge lane's PR: the owner's claim fails, the merge lane's claim at this head is reviewed and merged (D12)", async () => {
  const h = await harness();
  await h.deps.registry.update("author", () => h.author([], { status: "closed", claim: undefined, closedAt: new Date(T0).toISOString(), done: `merged ${REPO}#7` }));
  // The owner is still the oldest open lane: re-open it working, without a claim at this head.
  await h.deps.registry.update("author", () => h.author([{ number: 7, sha: sha("0") }]));
  const key = mergeLaneKey(h.pull());
  const brief = join(h.dir, "merge.md");
  writeFileSync(brief, "Resolve the conflict.\n");
  await h.deps.registry.write({
    key, title: "merge", thread: "t1", brief, done: `pr ${REPO} "feat-7"`, cwd: "/wt/app/merge", openedAt: new Date(T0 + 1000).toISOString(),
    status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "pushed", emitted: true, pulls: [{ repo: REPO, number: 7, sha: H7 }] },
  });
  await h.poll();
  expect(h.merges).toEqual([]);
  const [job] = h.gate.jobs.list();
  expect(job?.job.authorLaneKey).toBe(key);
  // G1 comes from the original owner's brief, not the merge lane's; intake reuses it, so the pass below is accepted.
  const criteria = readFileSync(join(h.dir, "review-inputs", job!.job.jobId, "criteria.md"), "utf8");
  expect(criteria).toContain("Implement the thing.");
  expect(criteria).not.toContain("Resolve the conflict.");
  expect(job?.job.snapshot.criteriaSha256).toBe(createHash("sha256").update(criteriaText("Implement the thing.\n"), "utf8").digest("hex"));
  await h.pass(job!.job.jobId);
  await h.poll();
  expect(h.merges).toEqual([["gh", "pr", "merge", "7", "-R", REPO, "--merge", "--match-head-commit", H7]]);
});

test("the merge lane brief no longer merges: it claims done at the pushed head and leaves review and merge to the supervisor", async () => {
  const h = await harness();
  const text = mergeLaneBrief({ key: mergeLaneKey(h.pull()), source: h.author(), pull: h.pull(), base: "dev" }, "/wt/x");
  expect(text).not.toContain("gh pr merge 7");
  expect(text).toContain("claim-done");
  expect(text).toContain("supervisor reviews and merges");
});

test("a multi-PR claim into one base is reviewed and merged lowest number first", async () => {
  const h = await harness();
  await h.deps.registry.update("author", () => h.author([{ number: 7, sha: H7 }, { number: 8, sha: H8 }]));
  const both = [h.pull(8), h.pull(7)];
  await h.poll(both);
  // Only #7 is reviewed; #8 waits for it.
  expect(h.gate.jobs.list().map((r) => r.job.snapshot.prNumber)).toEqual([7]);
  const job7 = h.gate.jobs.list()[0]!.job.jobId;
  await h.pass(job7);
  // #7 merges, the base moves, and #8 is reviewed on the new base in the same poll.
  h.gh.parent = sha("b");
  const merged = h.ci.tick(both, (id, line) => { h.events.push([id, line]); });
  await merged;
  expect(h.merges.map((m) => m[3])).toEqual(["7"]);
  h.gh.baseTip = sha("d");
  await h.poll([h.pull(8)]);
  const job8 = h.gate.jobs.list().filter((r) => r.job.snapshot.prNumber === 8 && r.execution.state === "running").at(-1);
  expect(job8?.job.snapshot.baseSha).toBe(sha("d"));
  await h.pass(job8!.job.jobId);
  await h.poll([h.pull(8)]);
  expect(h.merges.map((m) => m[3])).toEqual(["7", "8"]);
});

/** T6: H7 is a one-line prose fix of README.md on top of the merge base. */
const docsOnly = (h: Awaited<ReturnType<typeof harness>>, head = H7): void => {
  h.gh.diff = "diff --git a/README.md b/README.md\nindex 1111111..2222222 100644\n--- a/README.md\n+++ b/README.md\n@@ -3 +3 @@\n-Teh fix.\n+The fix.\n";
  h.gh.files.set(`${h.gh.mergeBase}:README.md`, "# App\n\nTeh fix.\n");
  h.gh.files.set(`${head}:README.md`, "# App\n\nThe fix.\n");
};

test("an exempt docs-only PR: merged without a reviewer, recorded once as kind exempt, and the close hold releases", async () => {
  const h = await harness();
  docsOnly(h);
  const decision = await h.gate.exemption(await h.gate.observeSnapshot(h.pull(), h.author()));
  expect(decision).toMatchObject({ kind: "exempt", receipt: { kind: "exempt", headSha: H7, baseSha: sha("b"), files: ["README.md"] } });
  expect(await h.gate.holdsLane(h.author())).toBe(false);
  await h.poll();
  await h.poll();
  expect(h.merges).toEqual([["gh", "pr", "merge", "7", "-R", REPO, "--merge", "--match-head-commit", H7]]);
  expect(h.launches).toEqual([]);
  expect(h.gate.jobs.list()).toEqual([]);
  expect(h.gate.exemptions.list()).toHaveLength(1);
});

test("a non-exempt PR still holds the lane and gets a reviewer; an unreadable file is never exempt", async () => {
  const h = await harness();
  docsOnly(h);
  h.gh.files.delete(`${H7}:README.md`);
  expect(await h.gate.holdsLane(h.author())).toBe(true);
  await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.launches).toHaveLength(1);
  expect(h.gate.exemptions.list()).toMatchObject([{ kind: "review", reason: `README.md unreadable: no README.md at ${H7}` }]);
});

test("an exemption binds its head: a new head with code is classified again and reviewed", async () => {
  const h = await harness();
  docsOnly(h);
  expect((await h.gate.exemption(await h.gate.observeSnapshot(h.pull(), h.author()))).kind).toBe("exempt");
  const H9 = sha("9");
  h.views.set(7, greenView(H9));
  h.prs.set(7, { ...h.prs.get(7)!, headSha: H9 });
  await h.deps.registry.update("author", () => h.author([{ number: 7, sha: H9 }]));
  h.gh.diff = "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
  await h.poll([h.pull(7, H9)]);
  expect(h.merges).toEqual([]);
  expect(h.launches).toHaveLength(1);
  expect(h.gate.exemptions.list().map((d) => [d.kind, d.kind === "exempt" ? d.receipt.headSha : d.key.includes(H9)])).toEqual([["exempt", H7], ["review", true]]);
});

test("an exemption binds its base: a moved base is classified again before the merge, never reviewed for it", async () => {
  const h = await harness();
  docsOnly(h);
  expect((await h.gate.exemption(await h.gate.observeSnapshot(h.pull(), h.author()))).kind).toBe("exempt");
  h.gh.baseTip = sha("d");
  await h.poll();
  expect(h.merges).toHaveLength(1);
  expect(h.launches).toEqual([]);
  expect(h.gate.exemptions.list().map((d) => (d.kind === "exempt" ? d.receipt.baseSha : d.kind))).toEqual([sha("b"), sha("d")]);
});
