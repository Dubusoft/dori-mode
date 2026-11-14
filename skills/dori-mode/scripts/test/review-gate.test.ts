import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eventClass } from "../src/event-policy.ts";
import type { Lane } from "../src/registry.ts";
import { type ObservedReview, type PrInfo, REVIEW_TIMEOUT_MS, ReviewGate, type ReviewGateIo } from "../src/review-gate.ts";
import type { ReviewLaunchRequest, ReviewLaunchResult } from "../src/review-lane.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-14T12:00:00Z");
const REPO = "acme/app";
const sha = (c: string): string => c.repeat(40);
const H7 = sha("a"), H8 = sha("8");

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

type Launch = ReviewLaunchResult["kind"];

/** A gate over a real Registry and job store with fake GitHub, snapshot, launch and close effects. */
const harness = () => {
  const state = withState();
  cleanups.push(state.done);
  const dir = state.dir;
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, dir);
  const prs = new Map<number, PrInfo>([
    [7, { state: "OPEN", baseRef: "dev", headSha: H7, title: "Add thing", body: "body" }],
    [8, { state: "OPEN", baseRef: "dev", headSha: H8, title: "Other", body: "" }],
  ]);
  const gh = { baseTip: sha("b"), mergeBase: sha("c"), parent: sha("b") };
  const launches: ReviewLaunchRequest[] = [];
  const plan: Launch[] = [];
  const closed: string[] = [];
  const released: string[] = [];
  let scope: { ok: true } | { ok: false; code: "scope_violation"; detail: string } = { ok: true };
  let n = 0;
  const home = join(dir, "home");
  const io: Partial<ReviewGateIo> = {
    prInfo: async (_repo, num) => { const p = prs.get(num); if (!p) throw new Error(`no PR ${num}`); return p; },
    branchSha: async () => gh.baseTip,
    mergeBase: async () => gh.mergeBase,
    diff: async () => "diff --git a/x b/x\n+1\n",
    mergeParent: async () => gh.parent,
    fetchHead: async () => {},
    prepareSnapshot: async (input) => ({ ok: true, path: input.path, startedAt: clock.now() }),
    checkScope: async () => scope,
    releaseSnapshot: async (input) => { released.push(input.path); return { ok: true }; },
    launch: async (request) => {
      launches.push(request);
      const kind = plan.shift() ?? "started";
      if (kind === "held") return { kind, reason: "HOLD review reserve 1 on machine local" };
      if (kind === "refused") return { kind, detail: "LaunchError nope" };
      const lane: Lane = { key: request.key, title: request.title, thread: "t1", brief: request.brief, done: "x", review: true, openedAt: new Date(clock.now()).toISOString() };
      await deps.registry.write(lane);
      return { kind, lane, startup: "STARTUP ok" };
    },
    closeLane: async (lane) => {
      closed.push(lane.key);
      await deps.registry.update(lane.key, (cur) => (cur ? { ...cur, status: "closed", closedAt: new Date(clock.now()).toISOString() } : undefined));
      return { closed: true, lines: [`CLOSED ${lane.key}`] };
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
    key: "author", title: "author", thread: "t1", brief, done: `merged ${REPO}#7`, cwd: "/repo/author", openedAt: new Date(T0).toISOString(),
    status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "e", pulls: pulls.map((p) => ({ repo: REPO, ...p })) }, ...patch,
  });
  const events: [string, string][] = [];
  const emit = (id: string, line: string): void => { events.push([id, line]); };
  const kinds = (): string[] => events.map(([, l]) => l.split(" ")[0]!);
  const gate = (): ReviewGate => new ReviewGate(deps, io);
  const registered = deps.registry.write(author());
  const pull = (num = 7, head = num === 7 ? H7 : H8) => ({ repo: REPO, number: num, sha: head, url: `https://github.com/${REPO}/pull/${num}` });

  /** Writes the reviewer lane's installed out files and records its done claim. */
  const submit = async (g: ReviewGate, jobId: string, opts: { verdict?: "pass" | "findings"; token?: string; record?: object; noResult?: boolean } = {}) => {
    const r = g.jobs.get(jobId)!;
    const key = r.job.reviewerLaneKey;
    const token = opts.token ?? /"jobToken": "([0-9a-f]+)"/.exec(readFileSync(join(dir, "briefs", `${key}.md`), "utf8"))![1]!;
    const out = join(dir, "out", key);
    mkdirSync(out, { recursive: true });
    const recordDir = join(home, ".omo", "agent", "projects", "p", "senpi-task", "tasks");
    mkdirSync(recordDir, { recursive: true });
    const record = opts.record ?? { task_id: "t1", status: "completed", agent_type: "omo-native-gate-reviewer", resolved_model: { provider: "openai", model_id: "gpt" } };
    writeFileSync(join(recordDir, "t1.json"), JSON.stringify(record));
    const findings = opts.verdict === "findings"
      ? [{ id: "F1", severity: "high", criterionId: "C1", path: "src/x.ts", lineStart: 1, lineEnd: 2, observation: "o", consequence: "c", evidence: ["e"], requestedChange: "r" }]
      : [];
    writeFileSync(join(out, "review-body.json"), JSON.stringify({ schemaVersion: 1, jobId, verdict: opts.verdict ?? "pass", summary: "s", findings, notes: [] }));
    writeFileSync(join(out, "review-report.md"), "# report\n");
    if (!opts.noResult) {
      writeFileSync(join(out, "review-result.json"), JSON.stringify({
        jobId, jobToken: token, source: "reviewer", body: "review-body.json", taskRecord: join(recordDir, "t1.json"),
        startedAt: "2026-11-14T12:00:00Z", completedAt: "2026-11-14T12:05:00Z",
      }));
    }
    await deps.registry.update(key, (cur) => (cur ? { ...cur, status: "done-claimed", claim: { at: new Date(clock.now()).toISOString(), evidence: "done" } } : undefined));
  };

  const observe = (g: ReviewGate, num = 7, lane = author()): Promise<ObservedReview> => g.observeSnapshot(pull(num), lane);
  return { io, registered, dir, clock, deps, prs, gh, launches, plan, closed, released, author, events, emit, kinds, gate, pull, submit, observe,
    setScope: (s: typeof scope) => { scope = s; } };
};

/** Starts a running job for #7 and returns its id. */
const running = async (h: ReturnType<typeof harness>, g: ReviewGate): Promise<string> => {
  await h.registered;
  const lane = h.author();
  const res = await g.ensureJob(lane, h.pull(), await h.observe(g), h.emit);
  if (res.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(res)}`);
  return res.jobId;
};

describe("review gate trigger", () => {
  test("starts a job only with a valid claim at this head", async () => {
    const h = harness(), g = h.gate();
    const obs = await h.observe(g);
    expect((await g.ensureJob(h.author([], { status: "working", claim: undefined }), h.pull(), obs, h.emit)).kind).toBe("refused");
    expect((await g.ensureJob(h.author([{ number: 7, sha: sha("9") }]), h.pull(), obs, h.emit)).kind).toBe("refused");
    expect(g.jobs.list()).toHaveLength(0);
    expect(h.launches).toHaveLength(0);
    const res = await g.ensureJob(h.author(), h.pull(), obs, h.emit);
    expect(res.kind).toBe("started");
    const [r] = g.jobs.list();
    expect(r?.execution.state).toBe("running");
    expect(r?.job.reviewerLaneKey).toBe(`review-app-7-${H7.slice(0, 7)}`);
    expect(r?.job.jobId).toMatch(/^rv-app-7-aaaaaaa-[0-9a-f]{6}$/);
    expect(r?.job.snapshot).toMatchObject({ baseRef: "dev", baseSha: sha("b"), mergeBaseSha: sha("c"), policyVersion: "t4-1" });
    expect(h.launches[0]).toMatchObject({ key: r?.job.reviewerLaneKey, thread: "t1", cwd: `/wt/app-review-${r?.job.jobId}` });
    expect(readFileSync(join(h.dir, "review-inputs", r!.job.jobId, "diff.patch"), "utf8")).toContain("diff --git");
    expect(h.kinds()).toEqual(["REVIEW_STARTED"]);
    expect(h.events[0]![1]).toStartWith(`REVIEW_STARTED ${REPO}#7 lane=author job=${r!.job.jobId} `);
  });

  test("repeated ensureJob for the same snapshot keeps exactly one job", async () => {
    const h = harness(), g = h.gate();
    await running(h, g);
    for (let i = 0; i < 3; i++) expect((await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit)).kind).toBe("running");
    expect(g.jobs.list()).toHaveLength(1);
    expect(h.launches).toHaveLength(1);
  });

  test("HOLD keeps one queued job and the next poll retries the launch", async () => {
    const h = harness(), g = h.gate();
    h.plan.push("held", "held");
    const a = await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit);
    const b = await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit);
    expect([a.kind, b.kind]).toEqual(["queued", "queued"]);
    expect(g.jobs.list()).toHaveLength(1);
    expect(g.jobs.list()[0]?.execution).toMatchObject({ state: "queued", reason: "HOLD review reserve 1 on machine local" });
    expect(await g.holdsLane(h.author())).toBe(true);
    expect((await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit)).kind).toBe("started");
    expect(g.jobs.list()).toHaveLength(1);
    expect(h.launches).toHaveLength(3);
    expect(h.kinds()).toEqual(["REVIEW_QUEUED", "REVIEW_STARTED"]);
  });

  test("multi-PR claim: only the lowest-numbered open PR into the same base starts", async () => {
    const h = harness(), g = h.gate();
    const lane = h.author([{ number: 7, sha: H7 }, { number: 8, sha: H8 }]);
    expect(await g.ensureJob(lane, h.pull(8), await h.observe(g, 8, lane), h.emit)).toEqual({ kind: "waiting", why: `waiting for ${REPO}#7` });
    expect(g.jobs.list()).toHaveLength(0);
    expect((await g.ensureJob(lane, h.pull(7), await h.observe(g, 7, lane), h.emit)).kind).toBe("started");
    h.prs.set(7, { ...h.prs.get(7)!, state: "MERGED" });
    h.gh.baseTip = sha("d");
    expect((await g.ensureJob(lane, h.pull(8), await h.observe(g, 8, lane), h.emit)).kind).toBe("started");
    expect(g.jobs.list({ prNumber: 8 })[0]?.job.snapshot.baseSha).toBe(sha("d"));
  });
});

describe("review gate intake and approval", () => {
  test("an accepted pass completes the job and approves exactly that snapshot", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    expect((await g.approval(h.author(), h.pull(), await h.observe(g))).approved).toBe(false);
    await h.submit(g, id);
    await g.tick(h.emit);
    const r = g.jobs.get(id)!;
    expect(r.execution.state).toBe("completed");
    expect(r.receipt?.result.verdict).toBe("pass");
    const approval = await g.approval(h.author(), h.pull(), await h.observe(g));
    expect(approval.approved).toBe(true);
    expect(h.closed).toEqual([r.job.reviewerLaneKey]);
    expect(h.released).toEqual([r.snapshotPath!]);
    expect(h.kinds()).toEqual(["REVIEW_STARTED", "REVIEW_PASSED"]);
    expect(await g.holdsLane(h.author())).toBe(false);
  });

  test("head, base or policy change marks the job stale and approval false", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    await h.submit(g, id);
    await g.tick(h.emit);
    expect((await g.approval(h.author(), h.pull(), await h.observe(g))).approved).toBe(true);
    // Policy: a changed author brief changes the criteria digest.
    writeFileSync(h.author().brief, "Implement another thing.\n");
    expect((await g.approval(h.author(), h.pull(), await h.observe(g))).approved).toBe(false);
    writeFileSync(h.author().brief, "Implement the thing.\n");
    // Head.
    const moved = await g.observeSnapshot({ ...h.pull(), sha: sha("e") }, h.author());
    expect((await g.approval(h.author(), h.pull(), moved)).approved).toBe(false);
    // Base: ensureJob marks the old record stale and starts a new job.
    h.gh.baseTip = sha("f");
    const obs = await h.observe(g);
    expect((await g.approval(h.author(), h.pull(), obs)).approved).toBe(false);
    await g.ensureJob(h.author(), h.pull(), obs, h.emit);
    expect(g.jobs.get(id)?.execution).toMatchObject({ state: "stale", reason: "snapshot changed: baseSha" });
    expect(h.kinds()).toContain("REVIEW_STALE");
    expect(g.jobs.list()).toHaveLength(2);
  });

  test("a late result for a stale job never approves and still closes the reviewer", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    const oldKey = g.jobs.get(id)!.job.reviewerLaneKey;
    h.gh.baseTip = sha("f");
    h.plan.push("held");
    await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit);
    expect(g.jobs.get(id)?.execution.state).toBe("stale");
    await h.submit(g, id);
    await g.tick(h.emit);
    expect(g.jobs.get(id)?.execution.state).toBe("stale");
    expect(g.jobs.get(id)?.receipt).toBeUndefined();
    expect(h.closed).toContain(oldKey);
    expect(h.kinds()).not.toContain("REVIEW_PASSED");
    expect((await g.approval(h.author(), h.pull(), await h.observe(g))).approved).toBe(false);
  });

  test("findings complete the job, alert the lead and hold the lane", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    await h.submit(g, id, { verdict: "findings" });
    await g.tick(h.emit);
    expect(g.jobs.get(id)?.execution.state).toBe("completed");
    expect((await g.approval(h.author(), h.pull(), await h.observe(g))).approved).toBe(false);
    const line = h.events.find(([, l]) => l.startsWith("REVIEW_FINDINGS"))![1];
    expect(line).toStartWith(`REVIEW_FINDINGS ${REPO}#7 lane=author job=${id} findings=1 source=reviewer `);
    expect(await g.holdsLane(h.author())).toBe(true);
  });

  test("rejected submissions fail the job with their code", async () => {
    const cases: [string, (h: ReturnType<typeof harness>, g: ReviewGate, id: string) => Promise<void>, string][] = [
      ["bad token", (h, g, id) => h.submit(g, id, { token: "00".repeat(32) }), "invalid_output"],
      ["no result file", (h, g, id) => h.submit(g, id, { noResult: true }), "input_unavailable"],
      ["wrong reviewer agent", (h, g, id) => h.submit(g, id, { record: { task_id: "t1", status: "completed", agent_type: "explore", resolved_model: { provider: "a", model_id: "b" } } }), "invalid_output"],
      ["scope violation", async (h, g, id) => { h.setScope({ ok: false, code: "scope_violation", detail: "worktree is not clean" }); await h.submit(g, id); }, "scope_violation"],
    ];
    for (const [name, act, code] of cases) {
      const h = harness(), g = h.gate();
      const id = await running(h, g);
      await act(h, g, id);
      await g.tick(h.emit);
      expect({ name, execution: g.jobs.get(id)?.execution }).toMatchObject({ name, execution: { state: "error", code } });
      expect(h.closed).toHaveLength(1);
      expect(h.kinds()).toContain("REVIEW_FAILED");
      expect((await g.approval(h.author(), h.pull(), await h.observe(g))).approved).toBe(false);
    }
  });
});

describe("review gate failures", () => {
  test("timeout fails the job, one retry starts, a second error escalates", async () => {
    const h = harness(), g = h.gate();
    const first = await running(h, g);
    h.clock.at += REVIEW_TIMEOUT_MS + 1;
    await g.tick(h.emit);
    expect(g.jobs.get(first)?.execution).toMatchObject({ state: "error", code: "timeout" });
    expect(h.closed).toHaveLength(1);
    const retry = await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit);
    expect(retry.kind).toBe("started");
    const second = (retry as { jobId: string }).jobId;
    expect(g.jobs.get(second)?.job.reviewerLaneKey).toBe(`review-app-7-${H7.slice(0, 7)}-2`);
    h.clock.at += REVIEW_TIMEOUT_MS + 1;
    await g.tick(h.emit);
    expect(g.jobs.get(second)?.execution.state).toBe("escalated");
    expect((await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit)).kind).toBe("escalated");
    expect(g.jobs.list()).toHaveLength(2);
    expect(h.kinds()).toEqual(["REVIEW_STARTED", "REVIEW_FAILED", "REVIEW_STARTED", "REVIEW_FAILED", "REVIEW_ESCALATED"]);
    expect(await g.holdsLane(h.author())).toBe(true);
  });

  test("a queued job that never starts times out too", async () => {
    const h = harness(), g = h.gate();
    h.plan.push("held");
    await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit);
    h.clock.at += REVIEW_TIMEOUT_MS + 1;
    await g.tick(h.emit);
    expect(g.jobs.list()[0]?.execution).toMatchObject({ state: "error", code: "timeout" });
  });

  test("model_unavailable escalates at once", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    await h.submit(g, id, { record: { task_id: "t1", status: "failed", failure_kind: "model_unavailable", agent_type: "omo-native-gate-reviewer" } });
    await g.tick(h.emit);
    expect(g.jobs.get(id)?.execution.state).toBe("escalated");
    expect((await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit)).kind).toBe("escalated");
    expect(g.jobs.list()).toHaveLength(1);
    expect(h.kinds()).toEqual(["REVIEW_STARTED", "REVIEW_FAILED", "REVIEW_ESCALATED"]);
  });

  test("restart recovery marks a running job whose reviewer is gone runner_lost", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    const key = g.jobs.get(id)!.job.reviewerLaneKey;
    await h.deps.registry.update(key, (cur) => (cur ? { ...cur, closedAt: new Date(h.clock.now()).toISOString() } : undefined));
    const again = h.gate();
    await again.ready;
    expect(again.jobs.get(id)?.execution).toMatchObject({ state: "error", code: "runner_lost" });
    await again.tick(h.emit);
    expect(h.kinds()).toEqual(["REVIEW_STARTED", "REVIEW_FAILED"]);
    expect(h.released).toHaveLength(1);
  });

  test("a live reviewer survives a restart", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    const again = h.gate();
    await again.ready;
    expect(again.jobs.get(id)?.execution.state).toBe("running");
  });
});

describe("review gate holds and base race", () => {
  test("holdsLane: an open PR at the claimed head with no pass holds durably (no job yet, after a restart, unreadable); merged, closed, moved, red or off-base releases", async () => {
    const h = harness(), g = h.gate();
    const lane8 = h.author([{ number: 8, sha: H8 }]);
    // No job was ever started for #8 (it waits behind #7): held, also long after and by a freshly constructed gate.
    expect(g.jobs.list()).toHaveLength(0);
    expect(await g.holdsLane(lane8)).toBe(true);
    h.clock.at += 60 * 60_000;
    const restarted = h.gate();
    expect(await restarted.holdsLane(lane8)).toBe(true);
    // An unreadable PR holds.
    expect(await restarted.holdsLane(h.author([{ number: 9, sha: sha("9") }]))).toBe(true);
    const open = h.prs.get(8)!;
    for (const [why, info] of [
      ["merged", { ...open, state: "MERGED" }], ["closed", { ...open, state: "CLOSED" }], ["head moved", { ...open, headSha: sha("e") }],
      ["red checks", { ...open, checks: "red" as const }], ["base is not ciMergeBase", { ...open, baseRef: "feature" }],
    ] as const) {
      h.prs.set(8, info);
      expect([why, await restarted.holdsLane(lane8)]).toEqual([why, false]);
    }
    h.prs.set(8, { ...open, checks: "pending" });
    expect(await restarted.holdsLane(lane8)).toBe(true);
    // No claimed PRs: nothing to hold.
    expect(await g.holdsLane(h.author([]))).toBe(false);
  });

  test("holdsLane: running holds, a reviewer pass at the claimed head releases while the PR is still open", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    expect(await g.holdsLane(h.author())).toBe(true);
    await h.submit(g, id);
    await g.tick(h.emit);
    expect(h.prs.get(7)?.state).toBe("OPEN");
    expect(await g.holdsLane(h.author())).toBe(false);
  });

  test("holdsLane: an error or escalated record holds only while the PR is open, green or pending, at the claimed head", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    await h.submit(g, id, { record: { task_id: "t1", status: "failed", failure_kind: "model_unavailable", agent_type: "omo-native-gate-reviewer" } });
    await g.tick(h.emit);
    expect(g.jobs.get(id)?.execution.state).toBe("escalated");
    expect(await g.holdsLane(h.author())).toBe(true);
    const open = h.prs.get(7)!;
    h.prs.set(7, { ...open, checks: "red" });
    expect(await g.holdsLane(h.author())).toBe(false);
    h.prs.set(7, { ...open, state: "CLOSED" });
    expect(await g.holdsLane(h.author())).toBe(false);
    h.prs.set(7, { ...open, state: "MERGED" });
    expect(await g.holdsLane(h.author())).toBe(false);
  });

  test("holdsLane: an error record (one failed run) releases once the PR is closed", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    await h.submit(g, id, { noResult: true });
    await g.tick(h.emit);
    expect(g.jobs.get(id)?.execution).toMatchObject({ state: "error", code: "input_unavailable" });
    expect(await g.holdsLane(h.author())).toBe(true);
    h.prs.set(7, { ...h.prs.get(7)!, state: "CLOSED" });
    expect(await g.holdsLane(h.author())).toBe(false);
  });

  test("a failed head fetch is named in the failure detail when the snapshot then fails", async () => {
    const h = harness();
    await h.registered;
    const g = new ReviewGate(h.deps, {
      ...h.io,
      fetchHead: async () => { throw new Error("git fetch origin aaaaaaa exit 128: no such ref"); },
      prepareSnapshot: async () => ({ ok: false, code: "input_unavailable", detail: "head not present" }),
    });
    const res = await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit);
    expect(res).toMatchObject({ kind: "failed", code: "input_unavailable" });
    const detail = res.kind === "failed" ? res.detail : "";
    expect(detail).toContain("snapshot: head not present");
    expect(detail).toContain("git fetch origin aaaaaaa exit 128: no such ref");
  });

  test("a base race is recorded on the job and emitted once", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    await h.submit(g, id);
    await g.tick(h.emit);
    expect(await g.recordBaseRace(h.author(), h.pull(), sha("m"), h.emit)).toMatchObject({ raced: false });
    h.gh.parent = sha("9");
    expect(await g.recordBaseRace(h.author(), h.pull(), sha("m"), h.emit)).toMatchObject({ raced: true, mergedOntoSha: sha("9") });
    expect(await g.recordBaseRace(h.author(), h.pull(), sha("m"), h.emit)).toMatchObject({ raced: true });
    const races = h.events.filter(([, l]) => l.startsWith("REVIEW_BASE_RACE"));
    expect(races).toEqual([[`review-base-race:${REPO}#7@${H7}`,
      `REVIEW_BASE_RACE ${REPO}#7 lane=author job=${id} approved-base=bbbbbbb merged-onto=9999999 merge=${sha("m")} https://github.com/${REPO}/pull/7`]]);
    expect(g.jobs.get(id)?.baseRace).toMatchObject({ approvedBaseSha: sha("b"), mergedOntoSha: sha("9"), mergeSha: sha("m") });
  });

  test("review event kinds are registered as urgent or digest", () => {
    for (const k of ["REVIEW_FINDINGS", "REVIEW_FAILED", "REVIEW_ESCALATED", "REVIEW_BASE_RACE"]) expect(eventClass(`${k} ${REPO}#7 lane=a job=j`)).toBe("lead-urgent");
    for (const k of ["REVIEW_STARTED", "REVIEW_QUEUED", "REVIEW_PASSED", "REVIEW_STALE"]) expect(eventClass(`${k} ${REPO}#7 lane=a job=j`)).toBe("lead-digest");
  });
});
