import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CiFollowUp } from "../src/ci-follow.ts";
import { claimDone, watchTick } from "../src/done-flow.ts";
import type { OpenPull } from "../src/github-events.ts";
import { openLaneReports, type LaneStatusTransport } from "../src/lane-reports.ts";
import { type DecisionContext, type DecisionTransport, readDecisions } from "../src/owner-decisions.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { type PrInfo, REVIEW_POLICY_VERSION, ReviewGate, type ReviewGateIo } from "../src/review-gate.ts";
import type { ReviewJobRecord } from "../src/review-jobs.ts";
import { responseFileName } from "../src/review-response.ts";
import { type ReviewMerge, reviewStatusTick } from "../src/review-status.ts";
import type { Ran, Runner } from "../src/run.ts";
import { withReviewHold } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, sent, withSqliteStore, withState } from "./fakes.ts";

/**
 * T8: the three review flows end to end across the supervisor/runner boundary. Each scenario runs the real CiFollowUp,
 * ReviewGate and done-flow claimDone/objectDone over an isolated state dir; only GitHub (gh through deps.run and the
 * gate's GitHub reads), Discord (decision and status transports) and the runner (fakeLaneOps over a World) are faked.
 * The author lane claims through claimDone, so its claim binds the PR heads GitHub shows; a reviewer lane writes its
 * out files and claims through claimDone too, and the gate's tick takes the result in.
 */

const T0 = Date.parse("2026-11-14T12:00:00Z");
const MIN = 60_000;
const REPO = "acme/app";
const sha = (c: string): string => c.repeat(40);
const H7 = sha("a"), H8 = sha("8"), H9 = sha("9"), FIX = sha("5");
const BASE0 = sha("b");
/** The merge commit GitHub makes for PR `n` (40 hex characters). */
const mergeShaOf = (n: number): string => `f${n}`.padEnd(40, "0");
const headOf = (n: number): string => (n === 7 ? H7 : n === 8 ? H8 : H9);

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const greenView = (n: number, head: string): Record<string, unknown> => ({
  number: n, state: "OPEN", baseRefName: "dev", headRefOid: head, isCrossRepository: false, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], mergeCommit: null,
});

const FINDING = { id: "F1", severity: "high", criterionId: "C1", path: "src/x.ts", lineStart: 1, lineEnd: 2, observation: "the edge case is unguarded", consequence: "a crash on empty input", evidence: ["src/x.ts:1"], requestedChange: "guard the empty input" };

const harness = async (nums: readonly number[] = [7]) => {
  const state = withState();
  cleanups.push(state.done);
  const dir = state.dir;
  withSqliteStore(dir);
  const clock = fakeClock(T0);
  const world = newWorld();
  world.prState = "OPEN";
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  const prs = new Map<number, PrInfo>(nums.map((n) => [n, { state: "OPEN", baseRef: "dev", headSha: headOf(n), title: `PR ${n}`, body: "" }]));
  const views = new Map<number, Record<string, unknown>>(nums.map((n) => [n, greenView(n, headOf(n))]));
  /** GitHub's base branch: a merge moves its tip to the merge commit, whose first parent is the tip before it. */
  const gh = { baseTip: BASE0, mergeBase: sha("c"), parents: new Map<string, string>(), diff: "diff --git a/src/x.ts b/src/x.ts\n+1\n" };
  const merges: string[][] = [];
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts): Promise<Ran> => {
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return { code: 0, out: JSON.stringify(views.get(Number(argv[3]))), err: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
      merges.push([...argv]);
      const n = Number(argv[3]), oid = mergeShaOf(n);
      gh.parents.set(oid, gh.baseTip);
      gh.baseTip = oid;
      views.set(n, { ...views.get(n), state: "MERGED", mergeCommit: { oid } });
      prs.set(n, { ...prs.get(n)!, state: "MERGED" });
      return { code: 0, out: "", err: "" };
    }
    return base(argv, opts);
  };
  const deps = { ...depsFor(world, clock, dir), run };
  const launches: string[] = [];
  let hex = 0;
  const home = join(dir, "home");
  const io: Partial<ReviewGateIo> = {
    prInfo: async (_repo, num) => { const p = prs.get(num); if (!p) throw new Error(`no PR ${num}`); return p; },
    branchSha: async () => gh.baseTip,
    mergeBase: async () => gh.mergeBase,
    diff: async () => gh.diff,
    fileAt: async (_repo, at, path) => { throw new Error(`no ${path} at ${at}`); },
    mergeParent: async (_repo, mergeSha) => { const p = gh.parents.get(mergeSha); if (!p) throw new Error(`no merge ${mergeSha}`); return p; },
    fetchHead: async () => {},
    prepareSnapshot: async (input) => ({ ok: true, path: input.path, startedAt: clock.now() }),
    checkScope: async () => ({ ok: true }),
    releaseSnapshot: async () => ({ ok: true }),
    // The runner side of a review lane launch: the lane is registered as the shared admission would.
    launch: async (request) => {
      launches.push(request.key);
      const lane: Lane = { key: request.key, title: request.title, thread: "t1", brief: request.brief, done: `file ${join(dir, "out", request.key, "review-result.json")}`, review: true, openedAt: new Date(clock.now()).toISOString() };
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
    randomHex: (bytes) => (++hex).toString(16).padStart(bytes * 2, "0"),
    // objectAuthor is not faked: findings reach the author through the real objectDone (runner notify and pane steering).
  };
  const brief = join(dir, "author.md");
  writeFileSync(brief, "Implement the thing.\n");
  await deps.registry.write({
    key: "author", title: "author", thread: "t1", pane: "w:p1", brief, done: nums.map((n) => `merged ${REPO}#${n}`).join("; "),
    cwd: "/repo/author", openedAt: new Date(T0 - 60 * MIN).toISOString(),
  });
  const events: [string, string][] = [];
  const emit = (id: string, line: string): void => { events.push([id, line]); };
  const gate = new ReviewGate(deps, io);
  const ci = new CiFollowUp(deps, gate, { launch: async () => ({ ok: false, detail: "no merge lane in this test" }) });
  cleanups.unshift(() => { ci.close(); });
  const author = async (): Promise<Lane> => (await deps.registry.read("author"))!;
  const pull = (n: number): OpenPull => ({
    repo: REPO, number: n, sha: prs.get(n)!.headSha, branch: `feat-${n}`, headRepo: REPO, url: `https://github.com/${REPO}/pull/${n}`, conflicting: false, checks: "green",
  });
  /** Lines of one kind, one per journal id (the journal dedupes a repeated id). */
  const lines = (kind: string): string[] => [...new Map(events.filter(([, l]) => l.startsWith(`${kind} `))).values()];
  /** The author lane claims done through the real claimDone; its claim binds the heads GitHub shows now. */
  const claim = async (evidence: string): Promise<string> => claimDone(deps, await author(), evidence);
  /** One supervisor poll over the PRs GitHub lists open (or `pulls`): CI follow-up, then the gate's tick. */
  const poll = async (pulls: readonly OpenPull[] = nums.filter((n) => prs.get(n)!.state === "OPEN").map(pull)): Promise<void> => {
    await ci.tick(pulls, emit);
    await gate.tick(emit);
  };
  const running = (n: number): ReviewJobRecord[] => gate.jobs.list().filter((r) => r.job.snapshot.prNumber === n && r.execution.state === "running");
  /**
   * The reviewer lane of `jobId` writes its result (DORI_LANE_OUT files and the trusted senpi-task record) and claims
   * done through claimDone; the gate's tick takes it in.
   */
  const submit = async (jobId: string, verdict: "pass" | "findings"): Promise<void> => {
    const r = gate.jobs.get(jobId)!;
    const key = r.job.reviewerLaneKey;
    const token = /"jobToken": "([0-9a-f]+)"/.exec(readFileSync(join(dir, "briefs", `${key}.md`), "utf8"))![1]!;
    const out = join(dir, "out", key);
    mkdirSync(out, { recursive: true });
    const recordDir = join(home, ".omo", "agent", "projects", "p", "senpi-task", "tasks");
    mkdirSync(recordDir, { recursive: true });
    const record = join(recordDir, `${key}.json`);
    writeFileSync(record, JSON.stringify({ task_id: key, status: "completed", agent_type: "omo-native-gate-reviewer", resolved_model: { provider: "openai", model_id: "gpt" } }));
    writeFileSync(join(out, "review-body.json"), JSON.stringify({ schemaVersion: 1, jobId, verdict, summary: "s", findings: verdict === "findings" ? [FINDING] : [], notes: [] }));
    writeFileSync(join(out, "review-report.md"), "# report\n");
    writeFileSync(join(out, "review-result.json"), JSON.stringify({
      jobId, jobToken: token, source: "reviewer", body: "review-body.json", taskRecord: record,
      startedAt: new Date(clock.now()).toISOString(), completedAt: new Date(clock.now() + MIN).toISOString(),
    }));
    expect(await claimDone(deps, (await deps.registry.read(key))!, `file ${join(out, "review-result.json")}`)).toStartWith(`LANE_DONE_CLAIMED ${key}`);
    await gate.tick(emit);
    expect(gate.jobs.get(jobId)?.execution.state).toBe("completed");
  };
  /** The author lane pushes a new head to PR `n`. */
  const push = (n: number, head: string): void => {
    prs.set(n, { ...prs.get(n)!, headSha: head });
    views.set(n, greenView(n, head));
  };
  /** The author lane writes its answer to a findings job into its installed reports. */
  const respond = (jobId: string, status: "fixed" | "disputed", note: string): void => {
    mkdirSync(join(dir, "out", "author"), { recursive: true });
    writeFileSync(join(dir, "out", "author", responseFileName(jobId)), JSON.stringify({ jobId, responses: [{ id: "F1", status, note }] }));
  };
  /** What the runner was told for the author lane: every `not-done` notice (the objection delivery), in order. */
  const objections = () => world.ops.filter((e) => e.op === "notify" && e.key === "author" && (e.args as { status?: string }).status === "not-done")
    .map((e) => (e.args as { objection: { reasons: string[] } }).objection.reasons);
  /** Texts typed into the author's pane that tell it it is not done. */
  const notDoneSteers = (): string[] => sent(world).filter((t) => t.startsWith("[LEAD] not done"));
  /** The stored history, read from disk. */
  const storedJobs = (): ReviewJobRecord[] => Object.values((JSON.parse(readFileSync(gate.jobs.path, "utf8")) as { jobs: Record<string, ReviewJobRecord> }).jobs)
    .sort((a, b) => a.job.createdAt - b.job.createdAt || a.job.jobId.localeCompare(b.job.jobId));
  const storedMerges = (): ReviewMerge[] => (existsSync(gate.merges.path) ? (JSON.parse(readFileSync(gate.merges.path, "utf8")) as { merges: ReviewMerge[] }).merges : []);
  return { dir, clock, world, deps, prs, views, gh, merges, launches, gate, ci, events, lines, author, pull, claim, poll, running, submit, push, respond, objections, notDoneSteers, storedJobs, storedMerges };
};

const mergeArgv = (n: number, head: string): string[] => ["gh", "pr", "merge", String(n), "-R", REPO, "--merge", "--match-head-commit", head];

/** Owner decisions over fake Discord transports, and the supervisor's review status tick that opens them. */
const ownerSide = (h: Awaited<ReturnType<typeof harness>>) => {
  let m = 0;
  const decisionTransport: DecisionTransport = {
    send: async () => `m${++m}`, edit: async () => {}, content: async () => "", deleteMessage: async () => {}, messagesAfter: async () => [],
    startThread: async () => ({ id: `900${++m}` }), setThread: async () => {}, threadState: async () => ({ archived: false, parent: "555" }), threadArchived: async () => true,
  };
  const status: LaneStatusTransport = {
    post: async () => `s${++m}`, edit: async () => {}, remove: async () => {},
    threadState: async () => ({ archived: false, parent: "111" }), laterMessages: async () => ({ messages: [], more: false }),
  };
  const decisions: DecisionContext = {
    config: { stateDir: h.dir, discordChannels: ["999"], decisionsChannel: "555", alertsChannel: undefined, displayTimeZone: "UTC" },
    transport: decisionTransport, now: () => h.clock.now(), home: "/home/test",
  };
  return () => reviewStatusTick({
    flow: h.deps, stores: { jobs: h.gate.jobs, exemptions: h.gate.exemptions, merges: h.gate.merges }, reports: openLaneReports(h.deps.config),
    transport: status, decisions, home: "/home/test", emit: (id, line) => { h.events.push([id, line]); },
  });
};

test("flow 1: claim -> review job -> reviewer pass taken in -> merged exactly once and recorded in the merges store", async () => {
  const h = await harness();
  expect(await h.claim("PR acme/app#7 pushed")).toStartWith("LANE_DONE_CLAIMED author");
  expect((await h.author()).claim?.pulls).toEqual([{ repo: REPO, number: 7, sha: H7 }]);

  // No approval yet: one review job starts, repeated polls add none and merge nothing.
  await h.poll();
  await h.poll();
  expect(h.merges).toEqual([]);
  expect(h.launches).toEqual([`review-app-7-${H7.slice(0, 7)}`]);
  const [job] = h.running(7);
  expect(job).toBeDefined();
  expect(await h.gate.holdsLane(await h.author())).toBe(true);

  await h.submit(job!.job.jobId, "pass");
  expect(h.lines("REVIEW_PASSED")).toHaveLength(1);
  expect(statusOf((await h.deps.registry.read(job!.job.reviewerLaneKey))!)).toBe("closed");

  await h.poll();
  // GitHub no longer lists it open, and even a stale poll that still names it merges nothing again.
  await h.poll();
  await h.poll([h.pull(7)]);
  expect(h.merges).toEqual([mergeArgv(7, H7)]);
  expect(h.lines("CI_MERGED")).toHaveLength(1);
  expect(h.lines("REVIEW_BASE_RACE")).toEqual([]);
  expect(h.objections()).toEqual([]);
  expect(h.launches).toHaveLength(1);

  // Stored history: one job, completed with a pass receipt bound to the merged snapshot; one merge record.
  const stored = h.storedJobs();
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    execution: { state: "completed" }, reviewerClosed: true, snapshotReleased: true,
    job: { jobId: job!.job.jobId, authorLaneKey: "author", round: 1, snapshot: { repo: REPO, prNumber: 7, headSha: H7, baseRef: "dev", baseSha: BASE0, policyVersion: REVIEW_POLICY_VERSION } },
    receipt: { jobId: job!.job.jobId, headSha: H7, baseSha: BASE0, source: "reviewer", result: { verdict: "pass", findings: [] } },
  });
  expect(stored[0]!.receipt!.policyVersion).toBe(REVIEW_POLICY_VERSION);
  expect(stored[0]!.receipt!.criteriaSha256).toBe(stored[0]!.job.snapshot.criteriaSha256);
  expect(h.storedMerges()).toEqual([{ lane: "author", repo: REPO, prNumber: 7, headSha: H7, mergeSha: mergeShaOf(7), at: T0 }]);
});

test("flow 2: findings -> objectDone to the author exactly once -> fix pushed and answered -> reclaim -> fresh review -> pass -> merge", async () => {
  const h = await harness();
  await h.claim("PR acme/app#7 pushed");
  await h.poll();
  const first = h.running(7)[0]!.job.jobId;
  await h.submit(first, "findings");
  expect(h.lines("REVIEW_FINDINGS")).toHaveLength(1);

  // The findings reached the author lane through its runner (notify) and its pane (steering), once.
  const told = h.objections();
  expect(told).toHaveLength(1);
  expect(told[0]![0]).toContain(`review ${first} of ${REPO}#7 at ${H7.slice(0, 7)} (round 1 of 2) found 1 blocking finding(s)`);
  expect(told[0]!.some((r) => r.startsWith("F1 [high] C1 src/x.ts:1-2: the edge case is unguarded"))).toBe(true);
  expect(told[0]!.at(-1)).toContain(responseFileName(first));
  expect(h.notDoneSteers()).toHaveLength(1);
  expect(await h.author()).toMatchObject({ status: "not-done", objection: { reasons: told[0] } });

  // Further polls and ticks neither object again nor merge nor start another review.
  for (let i = 0; i < 3; i++) await h.poll();
  expect(h.objections()).toHaveLength(1);
  expect(h.notDoneSteers()).toHaveLength(1);
  expect(h.merges).toEqual([]);
  expect(h.launches).toHaveLength(1);

  // The author fixes, pushes a new head, answers the finding and claims again.
  h.push(7, FIX);
  h.respond(first, "fixed", "guarded the empty input in src/x.ts:1; test x covers it");
  h.clock.at += MIN;
  expect(await h.claim("F1 fixed and pushed")).toStartWith("LANE_DONE_CLAIMED author");
  expect((await h.author()).claim?.pulls).toEqual([{ repo: REPO, number: 7, sha: FIX }]);

  await h.poll();
  const [second] = h.running(7);
  expect(second?.job).toMatchObject({ round: 2, previousJobId: first, snapshot: { headSha: FIX } });
  expect(second!.job.responseSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(second!.job.reviewerLaneKey).toBe(`review-app-7-${FIX.slice(0, 7)}`);
  expect(readFileSync(join(h.dir, "review-inputs", second!.job.jobId, "previous.md"), "utf8")).toContain("guarded the empty input");
  expect(h.merges).toEqual([]);

  await h.submit(second!.job.jobId, "pass");
  await h.poll();
  await h.poll([h.pull(7)]);
  expect(h.merges).toEqual([mergeArgv(7, FIX)]);
  expect(h.objections()).toHaveLength(1);
  expect(h.launches).toHaveLength(2);

  const stored = h.storedJobs();
  expect(stored.map((r) => [r.job.jobId, r.job.round, r.job.snapshot.headSha, r.execution.state, r.receipt?.result.verdict])).toEqual([
    [first, 1, H7, "stale", "findings"],
    [second!.job.jobId, 2, FIX, "completed", "pass"],
  ]);
  expect(stored[0]!.authorNotified).toMatchObject({ laneKey: "author" });
  expect(stored[1]!.receipt).toMatchObject({ headSha: FIX, baseSha: BASE0, round: 2, source: "reviewer" });
  expect(h.storedMerges()).toEqual([{ lane: "author", repo: REPO, prNumber: 7, headSha: FIX, mergeSha: mergeShaOf(7), at: T0 + MIN }]);
});

test("flow 3: findings twice -> no merge, one owner decision, the author lane held and never closed automatically", async () => {
  const h = await harness();
  const decide = ownerSide(h);
  await h.claim("PR acme/app#7 pushed");
  await h.poll();
  const first = h.running(7)[0]!.job.jobId;
  await h.submit(first, "findings");
  expect(h.objections()).toHaveLength(1);

  h.push(7, FIX);
  h.respond(first, "fixed", "guarded the empty input in src/x.ts:1; test x covers it");
  h.clock.at += MIN;
  await h.claim("F1 fixed and pushed");
  await h.poll();
  const second = h.running(7)[0]!.job.jobId;
  await h.submit(second, "findings");

  // The second findings round reaches the limit: escalated once, not handed to the author.
  const cap = h.lines("REVIEW_CAP_REACHED");
  expect(cap).toHaveLength(1);
  expect(cap[0]).toContain("2 review rounds ended with findings (limit 2)");
  expect(h.objections()).toHaveLength(1);
  expect(h.notDoneSteers()).toHaveLength(1);

  // The supervisor's status pass opens exactly one owner decision for it, however often it runs.
  await decide();
  await decide();
  for (let i = 0; i < 3; i++) await h.poll();
  await decide();
  const opened = readDecisions(h.dir).decisions;
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ lane: "author", reviewCap: { jobId: second, repo: REPO, prNumber: 7 }, sourceRef: expect.stringMatching(new RegExp(`^review-cap:${second}:`)) });
  expect(h.gate.jobs.get(second)?.capReached?.decisionId).toBe(opened[0]!.id);
  expect(h.events.filter(([id]) => id.startsWith("owner-decision-opened:")).map(([id]) => id)).toEqual([`owner-decision-opened:${opened[0]!.id}`]);
  expect(h.lines("REVIEW_CAP_REACHED")).toHaveLength(1);

  // No merge, no third review, the lane stays held.
  expect(h.merges).toEqual([]);
  expect(h.launches).toHaveLength(2);
  expect(await h.gate.holdsLane(await h.author())).toBe(true);

  // The done watcher with the supervisor's review hold: far past closeAfterMin and mergeWaitMaxMin, no close and no objection.
  const watched: string[] = [];
  for (const at of [T0 + 10 * MIN, T0 + 90 * MIN, T0 + 300 * MIN]) {
    h.clock.at = at;
    watched.push(...await watchTick(withReviewHold(h.deps, h.gate)));
    await h.poll();
  }
  // The claim is announced to the lead as usual; it is never settled, objected to or closed.
  expect(watched.filter((l) => l.includes(" author"))).toEqual(["LANE_DONE_CLAIMED author w:p1 F1 fixed and pushed"]);
  expect(h.world.ops.filter((e) => e.op === "close" && e.key === "author")).toEqual([]);
  expect(statusOf(await h.author())).toBe("done-claimed");
  expect(h.objections()).toHaveLength(1);
  expect(h.merges).toEqual([]);
  expect(readDecisions(h.dir).decisions).toHaveLength(1);

  const stored = h.storedJobs();
  expect(stored.map((r) => [r.job.round, r.job.snapshot.headSha, r.execution.state, r.receipt?.result.verdict])).toEqual([
    [1, H7, "stale", "findings"],
    [2, FIX, "completed", "findings"],
  ]);
  expect(stored[1]!.capReached).toMatchObject({ reason: "2 review rounds ended with findings (limit 2)", decisionId: opened[0]!.id });
  expect(stored[1]!.authorNotified).toBeUndefined();
  expect(h.storedMerges()).toEqual([]);
});

test("flow 4: one claim with three PRs into one base, no findings: all reviewed and merged lowest number first with no human input", async () => {
  const h = await harness([9, 7, 8]);
  const decide = ownerSide(h);
  expect(await h.claim("PRs acme/app#7 #8 #9 pushed")).toStartWith("LANE_DONE_CLAIMED author");
  expect([...(await h.author()).claim!.pulls!].sort((a, b) => a.number - b.number)).toEqual([7, 8, 9].map((n) => ({ repo: REPO, number: n, sha: headOf(n) })));

  await h.poll();
  // Only #7 is reviewed; #8 and #9 wait for it.
  expect(h.gate.jobs.list().map((r) => r.job.snapshot.prNumber)).toEqual([7]);
  for (const n of [7, 8, 9]) {
    const [job] = h.running(n);
    expect(job?.job.snapshot.prNumber).toBe(n);
    await h.submit(job!.job.jobId, "pass");
    // This poll merges #n; the base moves to its merge commit and the next PR is reviewed on that base in the same poll.
    await h.poll();
    await decide();
  }
  await h.poll();
  expect(h.merges).toEqual([mergeArgv(7, H7), mergeArgv(8, H8), mergeArgv(9, H9)]);
  expect(h.lines("CI_MERGED")).toHaveLength(3);
  expect(h.lines("REVIEW_BASE_RACE")).toEqual([]);
  expect(h.lines("REVIEW_STALE")).toEqual([]);
  expect(h.lines("REVIEW_CAP_REACHED")).toEqual([]);
  // Zero human input: no objection, no owner decision, nothing escalated.
  expect(h.objections()).toEqual([]);
  expect(readDecisions(h.dir).decisions).toEqual([]);
  expect(h.launches).toHaveLength(3);

  const stored = h.storedJobs();
  expect(stored.map((r) => [r.job.snapshot.prNumber, r.job.snapshot.baseSha, r.execution.state, r.receipt?.result.verdict])).toEqual([
    [7, BASE0, "completed", "pass"],
    [8, mergeShaOf(7), "completed", "pass"],
    [9, mergeShaOf(8), "completed", "pass"],
  ]);
  expect(h.storedMerges().map((m) => [m.prNumber, m.headSha, m.mergeSha])).toEqual([7, 8, 9].map((n) => [n, headOf(n), mergeShaOf(n)]));
});
