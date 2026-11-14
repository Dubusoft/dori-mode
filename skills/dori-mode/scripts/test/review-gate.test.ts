import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eventClass } from "../src/event-policy.ts";
import type { Lane } from "../src/registry.ts";
import { type ObservedReview, prBudget, type PrInfo, REVIEW_TIMEOUT_MS, REVIEW_TOTAL_MS, ReviewGate, type ReviewGateIo } from "../src/review-gate.ts";
import type { ReviewLaunchRequest, ReviewLaunchResult } from "../src/review-lane.ts";
import { recordReviewDecision } from "../src/review-jobs.ts";
import { responseFileName } from "../src/review-response.ts";
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
  /** objectAuthor calls as [lane key, reasons]; `objectFailures` makes the next calls throw before any effect. */
  const objections: [string, string[]][] = [];
  const objecting = { failures: 0 };
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
    objectAuthor: async (lane, reasons) => {
      if (objecting.failures > 0) { objecting.failures--; throw new Error("notify failed"); }
      objections.push([lane.key, [...reasons]]);
      const at = new Date(clock.now()).toISOString();
      await deps.registry.update(lane.key, (cur) => (cur ? { ...cur, status: "not-done", objection: { at, reasons: [...reasons] } } : undefined));
    },
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

  /** Writes the author's answer file for a findings job into `laneKey`'s installed reports; returns its raw text. */
  const respond = (laneKey: string, jobId: string, responses: object[]): string => {
    const text = JSON.stringify({ jobId, responses });
    mkdirSync(join(dir, "out", laneKey), { recursive: true });
    writeFileSync(join(dir, "out", laneKey, responseFileName(jobId)), text);
    return text;
  };
  /** The author (or `key`) claims #7 again a minute later at `head`, and the registry records that claim. */
  const reclaim = async (head: string, key = "author", evidence = "e"): Promise<Lane> => {
    clock.at += 60_000;
    const lane = author([{ number: 7, sha: head }], {
      key, status: "done-claimed", claim: { at: new Date(clock.now()).toISOString(), evidence, pulls: [{ repo: REPO, number: 7, sha: head }] },
    });
    await deps.registry.update(key, () => lane);
    return lane;
  };
  return { io, registered, dir, clock, deps, prs, gh, launches, plan, closed, released, author, events, emit, kinds, gate, pull, submit, observe,
    objections, objecting, respond, reclaim, setScope: (s: typeof scope) => { scope = s; } };
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
    for (const k of ["REVIEW_ESCALATED", "REVIEW_BASE_RACE", "REVIEW_DECISION_FAILED"]) expect(eventClass(`${k} ${REPO}#7 lane=a job=j`)).toBe("lead-urgent");
    for (const k of ["REVIEW_STARTED", "REVIEW_QUEUED", "REVIEW_PASSED", "REVIEW_STALE", "REVIEW_FINDINGS", "REVIEW_FAILED", "REVIEW_CAP_REACHED"]) {
      expect(eventClass(`${k} ${REPO}#7 lane=a job=j`)).toBe("lead-digest");
    }
  });
});

const H2 = sha("2");
const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Runs one review of #7 at the current head that ends in findings (F1); returns its job id. */
const findingsRound = async (h: ReturnType<typeof harness>, g: ReviewGate, lane?: Lane, head = H7): Promise<string> => {
  await h.registered;
  const claimer = lane ?? h.author();
  const res = await g.ensureJob(claimer, h.pull(7, head), await g.observeSnapshot(h.pull(7, head), claimer), h.emit);
  if (res.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(res)}`);
  await h.submit(g, res.jobId, { verdict: "findings" });
  await g.tick(h.emit);
  return res.jobId;
};

/** All-disputed answer to `jobId`, written into the author's reports; returns its text. */
const dispute = (h: ReturnType<typeof harness>, jobId: string, key = "author", note = "the guard exists at src/x.ts:3; test y covers it"): string =>
  h.respond(key, jobId, [{ id: "F1", status: "disputed", note }]);

/** Two findings rounds at H7 (the second answers the first with an all-disputed response): the PR's cap is reached. */
const capped = async (h: ReturnType<typeof harness>, g: ReviewGate): Promise<{ first: string; second: string }> => {
  const first = await findingsRound(h, g);
  dispute(h, first);
  const second = await findingsRound(h, g, await h.reclaim(H7));
  return { first, second };
};

describe("review fix loop: findings delivery", () => {
  test("findings object the author lane exactly once, across ticks, a restart and a lost annotation", async () => {
    const h = harness(), g = h.gate();
    const id = await findingsRound(h, g);
    const receipt = g.jobs.get(id)!.receipt!;
    expect(h.objections).toHaveLength(1);
    const [key, reasons] = h.objections[0]!;
    expect(key).toBe("author");
    expect(reasons[0]).toContain(`receipt ${receipt.receiptId}`);
    expect(reasons[0]).toContain("(round 1 of 2) found 1 blocking finding(s)");
    expect(reasons.some((r) => r.startsWith("F1 [high] C1 src/x.ts:1-2: o"))).toBe(true);
    expect(reasons.at(-1)).toContain(responseFileName(id));
    expect(await h.deps.registry.read("author")).toMatchObject({ status: "not-done", objection: { reasons } });
    expect(g.jobs.get(id)?.authorNotified).toEqual({ at: h.clock.now(), laneKey: "author" });
    await g.tick(h.emit);
    await g.tick(h.emit);
    await h.gate().tick(h.emit);
    expect(h.objections).toHaveLength(1);
    // A crash after the objection but before the annotation: the lane's objection names the receipt, so only the record is written.
    g.jobs.transact((records, put) => { const { authorNotified: _lost, ...rest } = records[id]!; put(rest); });
    expect(g.jobs.get(id)?.authorNotified).toBeUndefined();
    await h.gate().tick(h.emit);
    expect(h.objections).toHaveLength(1);
    expect(g.jobs.get(id)?.authorNotified).toMatchObject({ laneKey: "author" });
    expect(h.kinds().filter((k) => k === "REVIEW_FINDINGS")).toHaveLength(1);
  });

  test("a failed delivery is retried by the next tick and then recorded", async () => {
    const h = harness(), g = h.gate();
    // The intake's delivery and the same tick's delivery pass both fail.
    h.objecting.failures = 2;
    const id = await findingsRound(h, g);
    expect(h.objections).toHaveLength(0);
    expect(g.jobs.get(id)?.authorNotified).toBeUndefined();
    expect(h.closed).toEqual([g.jobs.get(id)!.job.reviewerLaneKey]);
    await g.tick(h.emit);
    expect(h.objections).toHaveLength(1);
    expect(g.jobs.get(id)?.authorNotified).toBeDefined();
    await g.tick(h.emit);
    expect(h.objections).toHaveLength(1);
  });

  test("a closed author lane is not objected; the record is marked delivered", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    await h.deps.registry.update("author", (cur) => (cur ? { ...cur, closedAt: new Date(h.clock.now()).toISOString() } : undefined));
    await h.submit(g, id, { verdict: "findings" });
    await g.tick(h.emit);
    expect(h.objections).toHaveLength(0);
    expect(g.jobs.get(id)?.authorNotified).toMatchObject({ laneKey: "author" });
  });

  test("an old findings record without authorNotified and a closed author lane is only annotated, past the 60-minute limit too", async () => {
    const h = harness(), g = h.gate();
    const id = await findingsRound(h, g);
    expect(h.objections).toHaveLength(1);
    g.jobs.transact((records, put) => { const { authorNotified: _old, ...rest } = records[id]!; put(rest); });
    await h.deps.registry.update("author", (cur) => (cur ? { ...cur, closedAt: new Date(h.clock.now()).toISOString() } : undefined));
    h.clock.at += REVIEW_TOTAL_MS + 1;
    await g.tick(h.emit);
    expect(g.jobs.get(id)?.authorNotified).toMatchObject({ laneKey: "author" });
    expect(g.jobs.get(id)?.capReached).toBeUndefined();
    expect(h.kinds()).not.toContain("REVIEW_ESCALATED");
    expect(h.objections).toHaveLength(1);
  });
});

describe("review fix loop: answers and re-review", () => {
  test("fixed at a new head: a new reviewer reviews round 2 with the previous findings and the answer", async () => {
    const h = harness(), g = h.gate();
    const id = await findingsRound(h, g);
    const text = h.respond("author", id, [{ id: "F1", status: "fixed", note: "guarded the edge case; test x passes", evidence: ["bun test: 0 fail"] }]);
    h.prs.set(7, { ...h.prs.get(7)!, headSha: H2 });
    const lane = await h.reclaim(H2);
    const res = await g.ensureJob(lane, h.pull(7, H2), await g.observeSnapshot(h.pull(7, H2), lane), h.emit);
    expect(res.kind).toBe("started");
    const next = g.jobs.get((res as { jobId: string }).jobId)!;
    expect(next.job).toMatchObject({ round: 2, previousJobId: id, responseSha256: digest(text) });
    expect(next.job.snapshot.headSha).toBe(H2);
    expect(next.job.reviewerLaneKey).not.toBe(g.jobs.get(id)!.job.reviewerLaneKey);
    const previous = join(h.dir, "review-inputs", next.job.jobId, "previous.md");
    const md = readFileSync(previous, "utf8");
    expect(md).toContain(`# Previous review: job ${id}, round 1, head ${H7}`);
    expect(md).toContain('"id": "F1"');
    expect(md).toContain("guarded the edge case; test x passes");
    const brief = readFileSync(join(h.dir, "briefs", `${next.job.reviewerLaneKey}.md`), "utf8");
    expect(brief).toContain(`Previous review round and the author's answers: ${previous}`);
    const lines = brief.split("\n");
    const at = lines.findIndex((l) => l.endsWith("Tell it: write NO files except its body file"));
    expect(lines[at + 1]).toStartWith('   "$DORI_LANE_OUT/review-body.json", run no command longer than 60 s');
    expect(lines[at + 2]).toBe(`   Also give it ${previous} and tell it to re-check each answered finding there and still review the whole diff.`);
    expect(lines[at + 3]).toStartWith("5. ");
    expect(g.jobs.get(id)?.execution.state).toBe("stale");
    expect(g.jobs.get(id)?.receipt?.result.verdict).toBe("findings");
    expect(prBudget(g.jobs.list())).toMatchObject({ findingsRounds: 1, staleReschedules: 0 });
  });

  test("all disputed at the same head: a new job and reviewer for the same snapshot, and the round count goes up", async () => {
    const h = harness(), g = h.gate();
    const id = await findingsRound(h, g);
    const firstKey = g.jobs.get(id)!.key;
    const text = dispute(h, id);
    const lane = await h.reclaim(H7);
    const res = await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit);
    expect(res.kind).toBe("started");
    const jobId = (res as { jobId: string }).jobId;
    const next = g.jobs.get(jobId)!;
    expect(next.key).toBe(firstKey);
    expect(next.job).toMatchObject({ round: 2, previousJobId: id, responseSha256: digest(text) });
    expect(next.job.reviewerLaneKey).toBe(`review-app-7-${H7.slice(0, 7)}-2`);
    for (let i = 0; i < 2; i++) expect(await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit)).toEqual({ kind: "running", jobId });
    expect(g.jobs.list()).toHaveLength(2);
    expect(h.launches).toHaveLength(2);
    await h.submit(g, jobId, { verdict: "findings" });
    await g.tick(h.emit);
    expect(prBudget(g.jobs.list()).findingsRounds).toBe(2);
  });

  test("a same-head re-review that passed continues as that pass, not the old findings record", async () => {
    const h = harness(), g = h.gate();
    const id = await findingsRound(h, g);
    dispute(h, id);
    const lane = await h.reclaim(H7);
    const started = await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit);
    expect(started.kind).toBe("started");
    const jobId = (started as { jobId: string }).jobId;
    await h.submit(g, jobId, { verdict: "pass" });
    await g.tick(h.emit);
    const res = await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit);
    expect(res).toEqual({ kind: "completed", jobId, verdict: "pass" });
  });

  test("a missing, invalid, fixed-at-the-same-head or already reviewed answer objects and starts no job", async () => {
    const h = harness(), g = h.gate();
    const id = await findingsRound(h, g);
    const ask = async (): Promise<string> => {
      const lane = await h.reclaim(H7);
      const res = await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit);
      expect(res).toMatchObject({ kind: "awaiting-response", jobId: id });
      return res.kind === "awaiting-response" ? res.why : "";
    };
    expect(await ask()).toBe(`no ${responseFileName(id)} in the lane's reports`);
    const [, reasons] = h.objections.at(-1)!;
    expect(reasons[0]).toBe(`review ${id} of ${REPO}#7 is waiting for your answer: no ${responseFileName(id)} in the lane's reports`);
    expect(reasons.slice(1)).toEqual(h.objections[0]![1]);
    h.respond("author", id, [{ id: "F2", status: "disputed", note: "n" }]);
    expect(await ask()).toBe("answer for unknown finding F2");
    h.respond("author", id, [{ id: "F1", status: "fixed", note: "fixed it" }]);
    expect(await ask()).toBe("a fixed finding needs a new head: push the fix, or mark the finding disputed");
    // A record of this snapshot that already reviewed exactly this answer.
    const text = dispute(h, id);
    g.jobs.transact((records, put) => {
      const r = records[id]!;
      put({ ...r, job: { ...r.job, jobId: "rv-reviewed", createdAt: r.job.createdAt - 1, responseSha256: digest(text) },
        receipt: { ...r.receipt!, jobId: "rv-reviewed", result: { schemaVersion: 1, jobId: "rv-reviewed", verdict: "pass", summary: "s", findings: [], notes: [] } } });
    });
    expect(await ask()).toBe("this answer was already reviewed; write a new answer or push a fix");
    expect(g.jobs.list().map((r) => r.job.jobId).sort()).toEqual([id, "rv-reviewed"].sort());
    expect(h.objections).toHaveLength(5);
    expect(h.launches).toHaveLength(1);
  });
});

describe("review fix loop: per-PR limits", () => {
  test("a second findings round reaches the cap once, objects no more and keeps the lane held", async () => {
    const h = harness(), g = h.gate();
    const { second } = await capped(h, g);
    expect(h.objections).toHaveLength(1);
    const esc = h.events.filter(([, l]) => l.startsWith("REVIEW_CAP_REACHED"));
    expect(esc).toHaveLength(1);
    expect(esc[0]![0]).toBe(`review-cap:${REPO}#7:${second}`);
    expect(esc[0]![1]).toContain("2 review rounds ended with findings (limit 2); automatic review stops for this PR and the owner decides");
    expect(g.jobs.get(second)?.capReached?.reason).toBe("2 review rounds ended with findings (limit 2)");
    expect(g.jobs.get(second)?.authorNotified).toBeUndefined();
    dispute(h, second);
    const lane = await h.reclaim(H7);
    expect(await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit)).toEqual({ kind: "escalated", jobId: second, reason: "2 review rounds ended with findings (limit 2)" });
    await g.tick(h.emit);
    await h.gate().tick(h.emit);
    expect(g.jobs.list()).toHaveLength(2);
    expect(h.objections).toHaveLength(1);
    expect(h.kinds().filter((k) => k === "REVIEW_CAP_REACHED")).toHaveLength(1);
    expect(await g.holdsLane(lane)).toBe(true);
  });

  test("two stale re-schedules are allowed; the third stale run escalates", async () => {
    const h = harness(), g = h.gate();
    await running(h, g);
    const results: string[] = [];
    for (const tip of ["d", "e", "f"]) {
      h.gh.baseTip = sha(tip);
      results.push((await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit)).kind);
    }
    expect(results).toEqual(["started", "started", "escalated"]);
    expect(g.jobs.list()).toHaveLength(3);
    expect(prBudget(g.jobs.list()).staleReschedules).toBe(3);
    expect(h.events.filter(([, l]) => l.startsWith("REVIEW_CAP_REACHED")).map(([, l]) => l))
      .toEqual([expect.stringContaining("3 review runs went stale on head or base changes (limit 2 re-schedules)")]);
    expect((await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit)).kind).toBe("escalated");
    expect(await g.holdsLane(h.author())).toBe(true);
  });

  test("60 minutes after the first request a needed new job escalates; a live job still continues", async () => {
    const h = harness(), g = h.gate();
    const id = await running(h, g);
    h.clock.at += REVIEW_TOTAL_MS;
    expect(await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit)).toEqual({ kind: "running", jobId: id });
    h.gh.baseTip = sha("d");
    expect(await g.ensureJob(h.author(), h.pull(), await h.observe(g), h.emit)).toMatchObject({ kind: "escalated", reason: "no approval within 60 min of the first review request" });
    expect(g.jobs.list()).toHaveLength(1);
    expect(h.launches).toHaveLength(1);
  });

  test("no reset: a new claim, a new author lane and a reopened PR stay escalated", async () => {
    const h = harness(), g = h.gate();
    await capped(h, g);
    const count = g.jobs.list().length;
    const tryLane = async (lane: Lane, head = H7) => g.ensureJob(lane, h.pull(7, head), await g.observeSnapshot(h.pull(7, head), lane), h.emit);
    expect((await tryLane(await h.reclaim(H7, "author", "other evidence"))).kind).toBe("escalated");
    h.prs.set(7, { ...h.prs.get(7)!, headSha: H2 });
    expect((await tryLane(await h.reclaim(H2, "author-2"), H2)).kind).toBe("escalated");
    h.prs.set(7, { ...h.prs.get(7)!, state: "CLOSED" });
    h.prs.set(7, { ...h.prs.get(7)!, state: "OPEN" });
    expect((await tryLane(await h.reclaim(H2, "author-3", "reopened"), H2)).kind).toBe("escalated");
    expect(g.jobs.list()).toHaveLength(count);
    expect(h.kinds().filter((k) => k === "REVIEW_CAP_REACHED")).toHaveLength(1);
  });

  test("owner continue: the held findings go to the author, its answer gets a new reviewer under a fresh budget", async () => {
    const h = harness(), g = h.gate();
    const { first, second } = await capped(h, g);
    recordReviewDecision(g.jobs, h.clock.now(), second, "d1", "continue");
    await g.tick(h.emit);
    expect(h.objections.map(([k, r]) => [k, r[0]!.split(" ")[1]])).toEqual([["author", first], ["author", second]]);
    const lane = await h.reclaim(H7);
    expect((await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit)).kind).toBe("awaiting-response");
    dispute(h, second);
    expect((await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit)).kind).toBe("started");
    expect(g.jobs.list()).toHaveLength(3);
    expect(g.jobs.list().at(-1)?.job).toMatchObject({ round: 3, previousJobId: second });
    expect(h.kinds().filter((k) => k === "REVIEW_CAP_REACHED")).toHaveLength(1);
  });

  test("owner rereview: the findings are dismissed, never sent to the author, and a new reviewer reviews the same head", async () => {
    const h = harness(), g = h.gate();
    const { second } = await capped(h, g);
    recordReviewDecision(g.jobs, h.clock.now(), second, "d1", "rereview");
    await g.tick(h.emit);
    expect(h.objections).toHaveLength(1);
    expect(g.jobs.get(second)?.authorNotified).toMatchObject({ laneKey: "author" });
    const lane = await h.reclaim(H7);
    const res = await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit);
    expect(res.kind).toBe("started");
    const next = g.jobs.get((res as { jobId: string }).jobId)!;
    expect(next.job).toMatchObject({ round: 3, previousJobId: second, responseSha256: digest("owner-rereview:d1") });
    expect(readFileSync(join(h.dir, "review-inputs", next.job.jobId, "previous.md"), "utf8")).toContain("The owner dismissed these findings (decision d1)");
    expect(await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit)).toEqual({ kind: "running", jobId: next.job.jobId });
  });

  test("owner hold: no job, no objection, the lane stays held and the reason names the decision", async () => {
    const h = harness(), g = h.gate();
    const { second } = await capped(h, g);
    recordReviewDecision(g.jobs, h.clock.now(), second, "d1", "hold");
    await g.tick(h.emit);
    dispute(h, second);
    const lane = await h.reclaim(H7);
    expect(await g.ensureJob(lane, h.pull(), await h.observe(g, 7, lane), h.emit)).toEqual({
      kind: "escalated", jobId: second, reason: "held by the owner (decision d1): 2 review rounds ended with findings (limit 2)",
    });
    expect(g.jobs.list()).toHaveLength(2);
    expect(h.objections).toHaveLength(1);
    expect(await g.holdsLane(lane)).toBe(true);
    expect((await g.approval(lane, h.pull(), await h.observe(g, 7, lane))).approved).toBe(false);
    expect(() => recordReviewDecision(g.jobs, h.clock.now(), second, "d1", "continue")).toThrow("already decided hold by d1");
  });

  test("rounds count per PR: a new author lane after one findings round gets round 2", async () => {
    const h = harness(), g = h.gate();
    const id = await findingsRound(h, g);
    const text = h.respond("author-2", id, [{ id: "F1", status: "fixed", note: "fixed in the respawned lane" }]);
    h.prs.set(7, { ...h.prs.get(7)!, headSha: H2 });
    const lane = await h.reclaim(H2, "author-2");
    const res = await g.ensureJob(lane, h.pull(7, H2), await g.observeSnapshot(h.pull(7, H2), lane), h.emit);
    expect(res.kind).toBe("started");
    expect(g.jobs.get((res as { jobId: string }).jobId)?.job).toMatchObject({ round: 2, authorLaneKey: "author-2", responseSha256: digest(text) });
    await h.submit(g, (res as { jobId: string }).jobId, { verdict: "findings" });
    await g.tick(h.emit);
    expect(h.kinds().filter((k) => k === "REVIEW_CAP_REACHED")).toHaveLength(1);
    expect(h.objections.map(([k]) => k)).toEqual(["author"]);
  });
});
