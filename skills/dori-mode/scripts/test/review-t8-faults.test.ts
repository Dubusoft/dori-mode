import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CiFollowUp } from "../src/ci-follow.ts";
import type { OpenPull } from "../src/github-events.ts";
import type { Lane } from "../src/registry.ts";
import { type PrInfo, ReviewGate, type ReviewGateIo } from "../src/review-gate.ts";
import type { ReviewJobRecord } from "../src/review-jobs.ts";
import type { Ran, Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

/**
 * T8 fault injection for the review gate: supervisor restart mid-review, reviewer runner loss, malformed reviewer
 * results, stale callbacks and duplicate delivery. Every scenario runs the real ReviewGate and CiFollowUp over an
 * isolated temp state dir, a fake GitHub (`gh pr view` / `gh pr merge` through deps.run) and fake launch and close
 * effects, and asserts the stored job and receipt history and that `gh pr merge` never ran where it must not.
 */

const T0 = Date.parse("2026-11-14T12:00:00Z");
const REPO = "acme/app";
const sha = (c: string): string => c.repeat(40);
const H7 = sha("a"), H9 = sha("9");

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const greenView = (head: string): Record<string, unknown> => ({
  state: "OPEN", baseRefName: "dev", headRefOid: head, isCrossRepository: false, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], mergeCommit: null,
});

/** How the next review lane launch behaves: started, HOLD, or registered and then thrown (a launch interrupted mid-way). */
type LaunchPlan = "started" | "held" | "register-then-throw";

/** What a reviewer lane writes as its result; every field defaults to a valid submission. */
type Submission = {
  readonly verdict?: "pass" | "findings";
  /** Raw review-body.json text (replaces the generated body). */
  readonly bodyText?: string;
  /** Extra keys merged into the generated body object. */
  readonly bodyExtra?: Record<string, unknown>;
  /** Findings carried by the body regardless of the verdict. */
  readonly findings?: readonly object[];
  /** Raw review-result.json text (replaces the generated result). */
  readonly resultText?: string;
  /** Fields merged into (or overriding) the generated result object. */
  readonly resultExtra?: Record<string, unknown>;
};

const FINDING = { id: "F1", severity: "high", criterionId: "C1", path: "src/x.ts", lineStart: 1, lineEnd: 2, observation: "o", consequence: "c", evidence: ["e"], requestedChange: "r" };

const harness = async () => {
  const state = withState();
  cleanups.push(state.done);
  const dir = state.dir;
  const clock = fakeClock(T0);
  const world = newWorld();
  const prs = new Map<number, PrInfo>([[7, { state: "OPEN", baseRef: "dev", headSha: H7, title: "Add thing", body: "body" }]]);
  const views = new Map<number, Record<string, unknown>>([[7, greenView(H7)]]);
  const gh = { baseTip: sha("b"), mergeBase: sha("c"), diff: "diff --git a/src/x.ts b/src/x.ts\n+1\n" };
  /** Every `gh pr merge` argv the fake GitHub received. */
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
  const plan: LaunchPlan[] = [];
  /** objectAuthor calls as [lane key, reasons]; like objectDone it puts the lane in not-done with the reasons. */
  const objections: [string, string[]][] = [];
  let n = 0;
  const home = join(dir, "home");
  const io: Partial<ReviewGateIo> = {
    prInfo: async (_repo, num) => { const p = prs.get(num); if (!p) throw new Error(`no PR ${num}`); return p; },
    branchSha: async () => gh.baseTip,
    mergeBase: async () => gh.mergeBase,
    diff: async () => gh.diff,
    fileAt: async (_repo, at, path) => { throw new Error(`no ${path} at ${at}`); },
    mergeParent: async () => gh.baseTip,
    fetchHead: async () => {},
    prepareSnapshot: async (input) => ({ ok: true, path: input.path, startedAt: clock.now() }),
    checkScope: async () => ({ ok: true }),
    releaseSnapshot: async () => ({ ok: true }),
    launch: async (request) => {
      launches.push(request.key);
      const kind = plan.shift() ?? "started";
      if (kind === "held") return { kind: "held", reason: "HOLD review reserve 1 on machine local" };
      const lane: Lane = { key: request.key, title: request.title, thread: "t1", brief: request.brief, done: "file /x", review: true, openedAt: new Date(clock.now()).toISOString() };
      await deps.registry.write(lane);
      if (kind === "register-then-throw") throw new Error("supervisor died after the lane registered");
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
    objectAuthor: async (lane, reasons) => {
      objections.push([lane.key, [...reasons]]);
      const at = new Date(clock.now()).toISOString();
      await deps.registry.update(lane.key, (cur) => (cur ? { ...cur, status: "not-done", objection: { at, reasons: [...reasons] } } : undefined));
    },
  };
  const brief = join(dir, "author.md");
  writeFileSync(brief, "Implement the thing.\n");
  const author = (head = H7): Lane => ({
    key: "author", title: "author", thread: "t1", brief, done: `merged ${REPO}#7`, cwd: "/repo/author", openedAt: new Date(T0).toISOString(),
    status: "done-claimed", claim: { at: new Date(clock.now()).toISOString(), evidence: "e", emitted: true, pulls: [{ repo: REPO, number: 7, sha: head }] },
  });
  await deps.registry.write(author());
  const events: [string, string][] = [];
  const emit = (id: string, line: string): void => { events.push([id, line]); };
  /** The running supervisor: a restart replaces both with fresh instances over the same state dir and io. */
  const sup = { gate: undefined as unknown as ReviewGate, ci: undefined as unknown as CiFollowUp };
  const boot = (): void => {
    sup.gate = new ReviewGate(deps, io);
    const ci = new CiFollowUp(deps, sup.gate, { launch: async () => ({ ok: false, detail: "no merge lane in this test" }) });
    sup.ci = ci;
    cleanups.unshift(() => { ci.close(); });
  };
  boot();
  /** Supervisor restart: the old instances are dropped without any shutdown step and new ones read the stored state. */
  const restart = async (): Promise<void> => { sup.ci.close(); boot(); await sup.gate.ready; };
  const pull = (head = H7): OpenPull => ({
    repo: REPO, number: 7, sha: head, branch: "feat-7", headRepo: REPO, url: `https://github.com/${REPO}/pull/7`, conflicting: false, checks: "green",
  });
  /** Lines of one kind, one per journal id (the journal dedupes a repeated id). */
  const lines = (kind: string): string[] => [...new Map(events.filter(([, l]) => l.startsWith(`${kind} `))).values()];
  const jobs = (): ReviewJobRecord[] => sup.gate.jobs.list();
  const running = (): ReviewJobRecord | undefined => jobs().filter((r) => r.execution.state === "running").at(-1);
  /** One supervisor poll: CI follow-up, then the gate's tick. */
  const poll = async (head = H7): Promise<void> => {
    await sup.ci.tick([pull(head)], emit);
    await sup.gate.tick(emit);
  };

  /** The reviewer lane of `jobId` writes its out files and claims done; nothing is taken in until the next tick. */
  const submit = async (jobId: string, s: Submission = {}): Promise<void> => {
    const r = sup.gate.jobs.get(jobId)!;
    const key = r.job.reviewerLaneKey;
    const token = /"jobToken": "([0-9a-f]+)"/.exec(readFileSync(join(dir, "briefs", `${key}.md`), "utf8"))![1]!;
    const out = join(dir, "out", key);
    mkdirSync(out, { recursive: true });
    const recordDir = join(home, ".omo", "agent", "projects", "p", "senpi-task", "tasks");
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, "t1.json"), JSON.stringify({ task_id: "t1", status: "completed", agent_type: "omo-native-gate-reviewer", resolved_model: { provider: "openai", model_id: "gpt" } }));
    const verdict = s.verdict ?? "pass";
    const findings = s.findings ?? (verdict === "findings" ? [FINDING] : []);
    writeFileSync(join(out, "review-body.json"), s.bodyText ?? JSON.stringify({ schemaVersion: 1, jobId, verdict, summary: "s", findings, notes: [], ...s.bodyExtra }));
    writeFileSync(join(out, "review-report.md"), "# report\n");
    writeFileSync(join(out, "review-result.json"), s.resultText ?? JSON.stringify({
      jobId, jobToken: token, source: "reviewer", body: "review-body.json", taskRecord: join(recordDir, "t1.json"),
      startedAt: "2026-11-14T12:00:00Z", completedAt: "2026-11-14T12:05:00Z", ...s.resultExtra,
    }));
    await deps.registry.update(key, (cur) => (cur ? { ...cur, status: "done-claimed", claim: { at: new Date(clock.now()).toISOString(), evidence: "done" } } : undefined));
  };
  /** The reviewer lane's runner and pane are gone: its registry file disappears. */
  const loseLane = async (key: string): Promise<void> => {
    rmSync(join(dir, "lanes", `${key}.json`), { force: true });
    rmSync(join(dir, "lanes-archive", `${key}.json`), { force: true });
    expect(await deps.registry.read(key)).toBeNull();
  };
  /** The reviewer lane was closed behind the gate's back (operator close, runner reaped it). */
  const closeBehind = async (key: string): Promise<void> => {
    await deps.registry.update(key, (cur) => (cur ? { ...cur, status: "closed", closedAt: new Date(clock.now()).toISOString() } : undefined));
  };
  /** Starts the first review of #7 at `head` through one poll and returns its running record. */
  const start = async (head = H7): Promise<ReviewJobRecord> => {
    await poll(head);
    const r = running();
    if (!r) throw new Error("no running review job");
    return r;
  };
  return {
    dir, clock, deps, prs, views, gh, merges, launches, plan, objections, sup, restart, author, pull, events, lines, jobs, running, poll, submit,
    loseLane, closeBehind, start, emit,
  };
};

type H = Awaited<ReturnType<typeof harness>>;

/** The approval the gate gives #7 at `head` right now (false with a reason when it must not merge). */
const approvalNow = async (h: H, head = H7): Promise<boolean> => {
  const lane = (await h.deps.registry.read("author"))!;
  const res = await h.sup.gate.approval(lane, h.pull(head), await h.sup.gate.observeSnapshot(h.pull(head), lane));
  return res.approved;
};

const MERGE_H7 = ["gh", "pr", "merge", "7", "-R", REPO, "--merge", "--match-head-commit", H7];

describe("T8 (a) supervisor restart mid-review", () => {
  test("a queued (held) job is relaunched by the new gate as the same job: no second job for the snapshot key", async () => {
    const h = await harness();
    h.plan.push("held");
    await h.poll();
    const [queued] = h.jobs();
    expect(queued?.execution).toEqual({ state: "queued", reason: "HOLD review reserve 1 on machine local" });
    await h.restart();
    expect(h.jobs()).toEqual([queued!]);
    await h.poll();
    await h.poll();
    expect(h.jobs()).toHaveLength(1);
    expect(h.jobs()[0]).toMatchObject({ job: { jobId: queued!.job.jobId }, execution: { state: "running" }, attempts: 1 });
    expect(h.launches).toEqual([queued!.job.reviewerLaneKey, queued!.job.reviewerLaneKey]);
    expect(h.lines("REVIEW_STARTED")).toHaveLength(1);
    expect(h.merges).toEqual([]);
  });

  test("a launch interrupted after the reviewer lane registered: the new gate adopts that lane, never launches a second reviewer", async () => {
    const h = await harness();
    h.plan.push("register-then-throw");
    await h.poll();
    const [queued] = h.jobs();
    expect(queued?.execution.state).toBe("queued");
    await h.restart();
    await h.poll();
    expect(h.launches).toHaveLength(1);
    expect(h.jobs()).toHaveLength(1);
    expect(h.jobs()[0]).toMatchObject({ job: { jobId: queued!.job.jobId }, execution: { state: "running", reviewerLaneKey: queued!.job.reviewerLaneKey } });
    expect(h.merges).toEqual([]);
  });

  test("a running job with a live reviewer survives the restart; its pass arriving after the restart is taken in and merged once", async () => {
    const h = await harness();
    const r = await h.start();
    await h.restart();
    expect(h.sup.gate.jobs.get(r.job.jobId)?.execution).toEqual(r.execution);
    // Polls after the restart neither duplicate the reviewer nor merge without the result.
    await h.poll();
    await h.poll();
    expect(h.launches).toHaveLength(1);
    expect(h.jobs()).toHaveLength(1);
    expect(h.merges).toEqual([]);
    expect(await approvalNow(h)).toBe(false);
    await h.submit(r.job.jobId);
    await h.restart();
    await h.sup.gate.tick(h.emit);
    const done = h.sup.gate.jobs.get(r.job.jobId)!;
    expect(done.execution.state).toBe("completed");
    expect(done.receipt).toMatchObject({ jobId: r.job.jobId, headSha: H7, baseSha: sha("b"), result: { verdict: "pass" } });
    expect(done.reviewerClosed).toBe(true);
    await h.poll();
    await h.poll();
    expect(h.merges).toEqual([MERGE_H7]);
    expect(h.lines("REVIEW_PASSED")).toHaveLength(1);
  });

  test("a running job whose reviewer is gone at the restart becomes runner_lost; exactly one retry job starts, nothing merges", async () => {
    const h = await harness();
    const r = await h.start();
    await h.loseLane(r.job.reviewerLaneKey);
    await h.restart();
    expect(h.sup.gate.jobs.get(r.job.jobId)?.execution).toMatchObject({ state: "error", code: "runner_lost" });
    await h.poll();
    await h.poll();
    expect(h.lines("REVIEW_FAILED").filter((l) => l.includes(`job=${r.job.jobId}`) && l.includes("code=runner_lost"))).toHaveLength(1);
    expect(h.jobs().map((j) => j.execution.state)).toEqual(["error", "running"]);
    expect(h.launches).toHaveLength(2);
    expect(h.jobs().every((j) => j.receipt === undefined)).toBe(true);
    expect(h.merges).toEqual([]);
  });
});

describe("T8 (b) reviewer runner loss", () => {
  for (const [name, lose] of [
    ["the reviewer lane disappears", (h: H, key: string) => h.loseLane(key)],
    ["the reviewer lane is closed without a result", (h: H, key: string) => h.closeBehind(key)],
  ] as const) {
    test(`${name}: runner_lost, one automatic retry, a second loss escalates; never a receipt or a merge`, async () => {
      const h = await harness();
      const first = await h.start();
      await lose(h, first.job.reviewerLaneKey);
      await h.sup.gate.tick(h.emit);
      expect(h.sup.gate.jobs.get(first.job.jobId)?.execution).toMatchObject({ state: "error", code: "runner_lost" });
      expect(h.merges).toEqual([]);

      await h.poll();
      const second = h.running();
      expect(second?.job.jobId).not.toBe(first.job.jobId);
      expect(second?.key).toBe(first.key);
      expect(h.launches).toHaveLength(2);

      await lose(h, second!.job.reviewerLaneKey);
      await h.sup.gate.tick(h.emit);
      expect(h.sup.gate.jobs.get(second!.job.jobId)?.execution).toMatchObject({ state: "escalated" });
      expect(h.lines("REVIEW_ESCALATED")).toHaveLength(1);
      expect(h.lines("REVIEW_ESCALATED")[0]).toContain("2 review runs failed (last runner_lost");

      for (let i = 0; i < 3; i++) await h.poll();
      expect(h.launches).toHaveLength(2);
      expect(h.jobs().map((j) => j.execution.state)).toEqual(["error", "escalated"]);
      expect(h.jobs().every((j) => j.receipt === undefined)).toBe(true);
      expect(await approvalNow(h)).toBe(false);
      expect(await h.sup.gate.holdsLane((await h.deps.registry.read("author"))!)).toBe(true);
      expect(h.merges).toEqual([]);
    });
  }

  test("a reviewer lost after its out files were written but before its claim: still runner_lost, the files are never taken in", async () => {
    const h = await harness();
    const r = await h.start();
    await h.submit(r.job.jobId);
    // The claim is undone: the lane died between writing its result and the supervisor seeing the claim.
    await h.closeBehind(r.job.reviewerLaneKey);
    await h.sup.gate.tick(h.emit);
    expect(h.sup.gate.jobs.get(r.job.jobId)).toMatchObject({ execution: { state: "error", code: "runner_lost" } });
    expect(h.sup.gate.jobs.get(r.job.jobId)?.receipt).toBeUndefined();
    await h.poll();
    expect(h.merges).toEqual([]);
  });
});

describe("T8 (c) malformed reviewer results", () => {
  const fence = (jobId: string): string => `\`\`\`json\n${JSON.stringify({ schemaVersion: 1, jobId, verdict: "pass", summary: "s", findings: [], notes: [] })}\n\`\`\`\n`;
  const cases: [string, (jobId: string) => Submission, string][] = [
    ["review-result.json is not JSON", () => ({ resultText: "verdict: pass, trust me" }), "review-result.json is not JSON"],
    ["review-result.json is a JSON array", () => ({ resultText: "[]" }), "source must be reviewer or qa"],
    ["the body is not JSON", () => ({ bodyText: "LGTM, ship it" }), "body must be a single JSON object"],
    ["the body is fenced JSON", (jobId) => ({ bodyText: fence(jobId) }), "no fence or prose"],
    ["the body has an extra key", () => ({ bodyExtra: { approved: true } }), "unknown key(s) approved"],
    ["the body names another job", () => ({ bodyExtra: { jobId: "rv-acme-7-other" } }), "does not match the issued job"],
    ["verdict pass carries findings", () => ({ verdict: "pass", findings: [FINDING] }), "verdict pass requires findings []"],
    ["the result names another job", () => ({ resultExtra: { jobId: "rv-acme-7-other" } }), "job_mismatch"],
    ["the result carries a wrong job token", () => ({ resultExtra: { jobToken: "f".repeat(64) } }), "bad_token"],
    ["the result has no job token", () => ({ resultExtra: { jobToken: 7 } }), "bad_token"],
  ];
  for (const [name, make, detail] of cases) {
    test(`${name}: error invalid_output, no receipt, no approval, no merge`, async () => {
      const h = await harness();
      const r = await h.start();
      await h.submit(r.job.jobId, make(r.job.jobId));
      await h.sup.gate.tick(h.emit);
      const after = h.sup.gate.jobs.get(r.job.jobId)!;
      expect(after.execution).toMatchObject({ state: "error", code: "invalid_output" });
      expect(after.execution.state === "error" ? after.execution.detail : "").toContain(detail);
      expect(after.receipt).toBeUndefined();
      expect(after.reviewerClosed).toBe(true);
      expect(await approvalNow(h)).toBe(false);
      await h.poll();
      expect(h.merges).toEqual([]);
      expect(h.lines("REVIEW_PASSED")).toEqual([]);
      expect(h.objections).toEqual([]);
    });
  }

  test("two malformed results in a row escalate; no third reviewer and no merge", async () => {
    const h = await harness();
    const first = await h.start();
    await h.submit(first.job.jobId, { bodyText: "LGTM" });
    await h.sup.gate.tick(h.emit);
    await h.poll();
    const second = h.running()!;
    expect(second.job.jobId).not.toBe(first.job.jobId);
    await h.submit(second.job.jobId, { verdict: "pass", findings: [FINDING] });
    await h.sup.gate.tick(h.emit);
    for (let i = 0; i < 3; i++) await h.poll();
    expect(h.jobs().map((j) => [j.execution.state, j.execution.state === "error" ? j.execution.code : ""])).toEqual([["error", "invalid_output"], ["escalated", ""]]);
    expect(h.lines("REVIEW_ESCALATED")).toHaveLength(1);
    expect(h.launches).toHaveLength(2);
    expect(h.merges).toEqual([]);
  });

  test("a valid pass written after a malformed one was rejected is not taken in for the failed job", async () => {
    const h = await harness();
    const r = await h.start();
    await h.submit(r.job.jobId, { bodyText: "LGTM" });
    await h.sup.gate.tick(h.emit);
    // The reviewer lane is closed now; a corrected result and a fresh claim on it must not revive the failed job.
    await h.submit(r.job.jobId);
    await h.sup.gate.tick(h.emit);
    expect(h.sup.gate.jobs.get(r.job.jobId)).toMatchObject({ execution: { state: "error", code: "invalid_output" } });
    expect(h.sup.gate.jobs.get(r.job.jobId)?.receipt).toBeUndefined();
    expect(h.merges).toEqual([]);
  });

  test("an extra key in review-result.json is invalid_output", async () => {
    const h = await harness();
    const r = await h.start();
    await h.submit(r.job.jobId, { resultExtra: { verdict: "pass", approvedBy: "reviewer" } });
    await h.sup.gate.tick(h.emit);
    expect(h.sup.gate.jobs.get(r.job.jobId)?.execution).toMatchObject({ state: "error", code: "invalid_output" });
  });
});

describe("T8 (d) stale callbacks", () => {
  for (const verdict of ["pass", "findings"] as const) {
    test(`a ${verdict} for the old head arriving after the author pushed: stored stale, no merge, the author is not objected`, async () => {
      const h = await harness();
      const r = await h.start();
      // The author pushes H9 and claims again before the reviewer of H7 finishes.
      h.prs.set(7, { ...h.prs.get(7)!, headSha: H9 });
      h.views.set(7, greenView(H9));
      await h.deps.registry.write(h.author(H9));
      await h.submit(r.job.jobId, { verdict });
      await h.sup.gate.tick(h.emit);
      const after = h.sup.gate.jobs.get(r.job.jobId)!;
      expect(after.execution).toMatchObject({ state: "stale", reason: expect.stringContaining("headSha") });
      expect(after.receipt).toBeUndefined();
      expect(after.authorNotified).toBeUndefined();
      expect(h.lines("REVIEW_STALE").some((l) => l.includes(`job=${r.job.jobId}`))).toBe(true);
      expect(h.lines(verdict === "pass" ? "REVIEW_PASSED" : "REVIEW_FINDINGS")).toEqual([]);
      // Polls at the new head start a fresh review for H9 and never merge on the stale callback.
      await h.poll(H9);
      await h.poll(H9);
      expect(h.objections).toEqual([]);
      expect((await h.deps.registry.read("author"))?.status).toBe("done-claimed");
      expect(h.merges).toEqual([]);
      expect(await approvalNow(h, H9)).toBe(false);
      expect(h.running()?.job.snapshot.headSha).toBe(H9);
      expect(h.jobs()).toHaveLength(2);
    });
  }

  test("a pass for the old base arriving after the base moved: stored stale, no merge, a fresh review at the new base", async () => {
    const h = await harness();
    const r = await h.start();
    h.gh.baseTip = sha("d");
    await h.submit(r.job.jobId);
    await h.sup.gate.tick(h.emit);
    const after = h.sup.gate.jobs.get(r.job.jobId)!;
    expect(after.execution).toMatchObject({ state: "stale", reason: expect.stringContaining("baseSha") });
    expect(after.receipt).toBeUndefined();
    await h.poll();
    await h.poll();
    expect(h.merges).toEqual([]);
    expect(h.objections).toEqual([]);
    expect(h.running()?.job.snapshot.baseSha).toBe(sha("d"));
  });

  test("a pass for a job the gate already marked stale (new head polled first) is never taken in", async () => {
    const h = await harness();
    const r = await h.start();
    h.prs.set(7, { ...h.prs.get(7)!, headSha: H9 });
    h.views.set(7, greenView(H9));
    await h.deps.registry.write(h.author(H9));
    await h.poll(H9);
    expect(h.sup.gate.jobs.get(r.job.jobId)?.execution.state).toBe("stale");
    await h.submit(r.job.jobId);
    await h.sup.gate.tick(h.emit);
    await h.poll(H9);
    expect(h.sup.gate.jobs.get(r.job.jobId)).toMatchObject({ execution: { state: "stale" } });
    expect(h.sup.gate.jobs.get(r.job.jobId)?.receipt).toBeUndefined();
    // The gate closed the stale reviewer at the H9 poll; the late claim lands on the archived lane, which stays shut.
    expect((await h.deps.registry.open()).map((l) => l.key)).not.toContain(r.job.reviewerLaneKey);
    expect(h.objections).toEqual([]);
    expect(h.merges).toEqual([]);
  });

  test("an old approved head never merges the new head: a pass of H7 does not approve H9", async () => {
    const h = await harness();
    const r = await h.start();
    await h.submit(r.job.jobId);
    await h.sup.gate.tick(h.emit);
    expect(h.sup.gate.jobs.get(r.job.jobId)?.execution.state).toBe("completed");
    h.prs.set(7, { ...h.prs.get(7)!, headSha: H9 });
    h.views.set(7, greenView(H9));
    await h.deps.registry.write(h.author(H9));
    await h.poll(H9);
    await h.poll(H9);
    expect(h.merges).toEqual([]);
    expect(h.sup.gate.jobs.get(r.job.jobId)?.execution.state).toBe("stale");
    expect(await approvalNow(h, H9)).toBe(false);
  });
});

describe("T8 (e) duplicate delivery", () => {
  test("the same findings result delivered twice (a repeated claim, extra ticks, a restart): the author is objected exactly once", async () => {
    const h = await harness();
    const r = await h.start();
    await h.submit(r.job.jobId, { verdict: "findings" });
    await h.sup.gate.tick(h.emit);
    const done = h.sup.gate.jobs.get(r.job.jobId)!;
    expect(done.execution.state).toBe("completed");
    expect(done.authorNotified?.laneKey).toBe("author");
    expect(h.objections).toHaveLength(1);
    expect(h.objections[0]![0]).toBe("author");
    expect(h.objections[0]![1].join("\n")).toContain(done.receipt!.receiptId);

    // The reviewer lane's claim arrives again with the same out files.
    await h.deps.registry.update(r.job.reviewerLaneKey, (cur) => (cur ? { ...cur, status: "done-claimed", closedAt: undefined } : undefined));
    await h.submit(r.job.jobId, { verdict: "findings" });
    await h.sup.gate.tick(h.emit);
    await h.sup.gate.tick(h.emit);
    await h.restart();
    await h.sup.gate.tick(h.emit);
    await h.poll();

    expect(h.objections).toHaveLength(1);
    expect(h.sup.gate.jobs.get(r.job.jobId)).toMatchObject({ execution: { state: "completed" }, receipt: { receiptId: done.receipt!.receiptId } });
    expect(h.jobs()).toHaveLength(1);
    expect(h.lines("REVIEW_FINDINGS")).toHaveLength(1);
    expect((await h.deps.registry.read(r.job.reviewerLaneKey))?.status).toBe("closed");
    expect(h.merges).toEqual([]);
  });

  test("a findings receipt whose authorNotified mark was lost is not objected again when the author already carries it", async () => {
    const h = await harness();
    const r = await h.start();
    await h.submit(r.job.jobId, { verdict: "findings" });
    await h.sup.gate.tick(h.emit);
    expect(h.objections).toHaveLength(1);
    // A crash between objectAuthor and the annotation: the store lost the mark, the author kept the objection.
    h.sup.gate.jobs.transact((records, put) => {
      const { authorNotified: _gone, ...rest } = records[r.job.jobId]!;
      put(rest);
    });
    await h.restart();
    await h.sup.gate.tick(h.emit);
    await h.sup.gate.tick(h.emit);
    expect(h.objections).toHaveLength(1);
    expect(h.sup.gate.jobs.get(r.job.jobId)?.authorNotified?.laneKey).toBe("author");
    expect(h.merges).toEqual([]);
  });
});
