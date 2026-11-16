import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import { autopilotLaneKey, DEFAULT_AUTOPILOT, type ToodoTask } from "../src/autopilot.ts";
import { type ExecutorDeps, liveExecutorDeps, runExecutor } from "../src/autopilot-executor.ts";
import { defaultConfig } from "../src/config.ts";
import { type LaunchSlot, precheckSlots } from "../src/launch-admission.ts";
import type { LaunchInput } from "../src/launch.ts";
import type { LaneOps } from "../src/lane-ops.ts";
import { admitLaunch, type LaunchOutcome, placeLaunch } from "../src/launch-service.ts";
import { JsonOperations } from "../src/operations.ts";
import { checkMachine } from "../src/placement.ts";
import { launchReviewLane } from "../src/review-lane.ts";
import { launchQueue } from "../src/routing.ts";
import type { ToodoTaskRecord } from "../src/toodo-client.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

/**
 * T8 admission faults: reviewers keep their reserved slot when panes are full, manual `dori launch` (placeLaunch +
 * admitLaunch) never takes the review reserve, a memory/disk HOLD binds reviews too, and a crashed reviewer returns its
 * reservation. Every scenario runs on an isolated temp stateDir with the fake World, runner and clock.
 */

const T0 = Date.parse("2026-11-14T12:00:00Z");
const SRC = join(import.meta.dir, "..", "src");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const slots = (stateDir: string): LaunchSlot[] => {
  const path = join(stateDir, "launch-slots.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).slots : [];
};

/** A machine with pane cap `cap` and one pane that is not a lane ("p0"). */
const world = (cap: number) => {
  const state = withState();
  cleanups.push(state.done);
  const w = newWorld(), clock = fakeClock(T0);
  w.panes = [{ pane_id: "p0", workspace_id: "w" }];
  w.inspection = { git: undefined };
  const deps = depsFor(w, clock, state.dir, {
    guard: { ...defaultConfig("/home/test").guard, panesMax: cap }, autopilot: { ...DEFAULT_AUTOPILOT, executor: true },
  });
  const brief = (key: string): string => {
    const path = join(state.dir, "briefs", `${key}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "Do the task.\n");
    return path;
  };
  /** A manual `dori launch` input: an author lane, never `review`. */
  const manual = (key: string): LaunchInput => ({ key, brief: brief(key), title: key, done: "closed acme/app#1" });
  const manualLaunch = async (input: LaunchInput): Promise<LaunchOutcome> => admitLaunch(deps, input, await placeLaunch(deps, input), () => {});
  const review = (key: string) => launchReviewLane(deps, { key, title: key, brief: brief(key), cwd: state.dir, thread: `discord:c/${key}` }, () => {});
  const started = (): string[] => w.ops.filter((o) => o.op === "start").map((o) => o.key!);
  /** The pane of a lane dies (crash): it leaves every later observation; the registry still reads it open. */
  const crash = async (key: string) => {
    const lane = await deps.registry.read(key);
    w.panes = w.panes.filter((p) => p.pane_id !== lane?.pane);
  };
  /** The lane's pane closes and the registry closes the lane. */
  const close = async (key: string) => {
    const lane = (await deps.registry.read(key))!;
    w.panes = w.panes.filter((p) => p.pane_id !== lane.pane);
    await deps.registry.write({ ...lane, status: "closed", closedAt: new Date(clock.now()).toISOString() });
  };
  const observe = async () => precheckSlots(state.dir, await checkMachine(deps.ops, deps.config, "local"), clock.now());
  /** The fake LaneOps, writable so a scenario can inject a runner fault. */
  const ops = deps.ops as { -readonly [K in keyof LaneOps]: LaneOps[K] };
  return { state, w, deps, ops, clock, manual, manualLaunch, review, started, crash, close, observe };
};

type World = ReturnType<typeof world>;

/** Real autopilot executor over the World: only Toodo, Discord threads, quota and the lock are faked. */
const autopilot = (h: World, count: number) => {
  const store = new JsonOperations(h.state.dir);
  cleanups.push(() => store.close());
  const worktrees = withState();
  cleanups.push(worktrees.done);
  const tasks = new Map<number, ToodoTask>(Array.from({ length: count }, (_, i) => [i + 1, {
    id: i + 1, workspaceId: 1, title: `task ${i + 1}`, description: "Do it", status: "planned", resolution: null, dependsOn: [],
    refs: ["owner:discord:c/m", "repo:acme/app"], criteria: [{ text: "tests pass", kind: "manual" }], wait: null, autopilot: true, dueDate: null,
  } satisfies ToodoTask]));
  const record = (id: number): ToodoTaskRecord => {
    const t = tasks.get(id)!;
    return { id, status: t.status, resolution: t.resolution, refs: t.refs, notes: [], criteria: [] };
  };
  const notices: string[] = [];
  const live = liveExecutorDeps(h.deps, store, (_id, line) => { notices.push(line); }, () => {});
  const deps: ExecutorDeps = {
    ...live,
    lock: async () => () => {},
    quota: async () => ({ readable: true, accounts: [{ name: "default", maxUsedPct: 10 }] }),
    parentChannel: "c",
    toodo: () => ({
      task: async (id) => tasks.get(id),
      tasksByIds: async (ids) => ids.map((id) => tasks.get(id)).filter((t): t is ToodoTask => t !== undefined),
      flaggedTasks: async () => [...tasks.values()],
      guidelines: async () => [],
    }),
    writer: {
      startTask: async (id, opts) => {
        const t = tasks.get(id)!;
        tasks.set(id, { ...t, status: "in_progress", refs: [...t.refs, ...(opts?.refs ?? [])] });
        return { wrote: true, task: record(id) };
      },
      read: async (id) => record(id),
      reportBlocker: async (id) => ({ wrote: true, task: record(id) }),
    },
    createThread: async (thread) => ({ id: `thread-${thread.title.split(":")[0]}`, member: "added" }),
    findThread: async (thread) => thread.id,
    worktreeRoot: () => worktrees.dir,
  };
  return { deps, run: (ids: readonly number[]) => runExecutor(deps, ids), notices };
};

// ---------------------------------------------------------------------------------------------------------------------
// (a) full-pane batch through autopilot

test("autopilot fills 18 of 19 author slots, a review lane takes the reserve, and the 19th author starts only after an author closes", async () => {
  const h = world(20), ap = autopilot(h, 19);
  const ids = Array.from({ length: 19 }, (_, i) => i + 1);
  const first = await ap.run(ids);
  const launched = first.filter((r) => r.kind === "launched").map((r) => r.taskId);
  expect(launched).toEqual(ids.slice(0, 18));
  expect(first.find((r) => r.taskId === 19)?.kind).not.toBe("launched");
  expect(h.started()).toEqual(ids.slice(0, 18).map((id) => autopilotLaneKey(id, 1)));
  // 1 other pane + 18 authors: physical room 1, held for the unfilled review reserve.
  expect(await h.observe()).toMatchObject({ physicalFree: 1, authorAdmissible: 0, reviewAdmissible: 1 });

  // A claim on author ap-1-1 starts its review lane in the reserved slot.
  const review = await h.review("review-app-1-aaaaaaa");
  expect(review.kind).toBe("started");
  if (review.kind !== "started") throw new Error("review did not start");
  expect(review.lane.review).toBe(true);
  expect(h.w.panes).toHaveLength(20);

  // The 19th author still waits: the pane cap is full.
  const waiting = await ap.run([19]);
  expect(waiting[0]?.kind).not.toBe("launched");
  expect(h.started()).not.toContain(autopilotLaneKey(19, 1));
  expect(await h.observe()).toMatchObject({ physicalFree: 0, authorAdmissible: 0, reviewAdmissible: 0 });

  // An author pane closes: the freed slot goes to the 19th author (the reserve is filled by the running review).
  await h.close(autopilotLaneKey(1, 1));
  const resumed = await ap.run([19]);
  expect(resumed[0]?.kind).toBe("launched");
  expect(h.started()).toContain(autopilotLaneKey(19, 1));
  expect(h.w.panes).toHaveLength(20);
  expect(launchQueue(h.state.dir)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// (b) manual `dori launch` racing a review for the last free slot

test("a manual author launch racing a review for the last free slot holds on the reserve in either order", async () => {
  for (const reviewFirst of [true, false]) {
    // Cap 2 with one other pane: one physical slot, which is the review reserve.
    const h = world(2);
    const author = h.manual("manual-1");
    // Whichever call is made first runs first up to its first await; both then interleave.
    let reviewRun: ReturnType<typeof h.review>, manualRun: Promise<LaunchOutcome>;
    if (reviewFirst) { reviewRun = h.review("review-1"); manualRun = h.manualLaunch(author); }
    else { manualRun = h.manualLaunch(author); reviewRun = h.review("review-1"); }
    const [reviewed, manual] = await Promise.all([reviewRun, manualRun]);
    expect(reviewed.kind).toBe("started");
    expect(manual.kind).toBe("held");
    if (manual.kind === "held") expect(manual.verdict.reasons.join(" ")).toContain("review reserve 1 on machine local: author slots 0");
    expect(h.started()).toEqual(["review-1"]);
    expect(launchQueue(h.state.dir).map((q) => q.key)).toEqual(["manual-1"]);
    expect(launchQueue(h.state.dir)[0]?.review).toBeUndefined();
  }
});

test("concurrent manual authors and reviews placed before any claim never over-admit or spill into the reserve", async () => {
  // Cap 4 with one other pane: 3 physical slots = 2 author + 1 review.
  const h = world(4);
  const authors = ["manual-1", "manual-2", "manual-3"].map(h.manual);
  // Every launch is placed (prechecked) while the machine is still empty, then all admissions run at once.
  const placed = await Promise.all(authors.map((input) => placeLaunch(h.deps, input)));
  expect(placed.every((p) => p.plan.check.verdict.ok)).toBe(true);
  const outcomes = await Promise.all([
    ...authors.map((input, i) => admitLaunch(h.deps, input, placed[i]!, () => {})),
    h.review("review-1"), h.review("review-2"),
  ]);
  const authorKinds = outcomes.slice(0, 3).map((o) => o.kind).sort();
  const reviewKinds = outcomes.slice(3).map((o) => o.kind).sort();
  expect(authorKinds).toEqual(["held", "launched", "launched"]);
  expect(reviewKinds).toEqual(["held", "started"]);
  expect(h.w.panes).toHaveLength(4);
  expect(slots(h.state.dir).filter((s) => s.kind === "review")).toHaveLength(1);
  expect(slots(h.state.dir).filter((s) => s.kind === "author")).toHaveLength(2);
});

/** Claims from separate threads on one ledger, released together by a shared barrier. */
const raceClaims = async (stateDir: string, cap: number, claims: readonly { key: string; kind: LaunchSlot["kind"] }[]) => {
  const worker = join(stateDir, "claim-worker.ts");
  writeFileSync(worker, [
    `import { parentPort, workerData } from "node:worker_threads";`,
    `import { claimSlot } from ${JSON.stringify(join(SRC, "launch-admission.ts"))};`,
    `const { stateDir, check, key, kind, now, barrier } = workerData;`,
    `parentPort.postMessage("ready");`,
    `Atomics.wait(new Int32Array(barrier), 0, 0);`,
    `parentPort.postMessage(claimSlot(stateDir, check, key, kind, now));`,
  ].join("\n"));
  const barrier = new SharedArrayBuffer(4);
  const check = { machine: "local", verdict: { ok: true, reasons: [] }, summary: "", paneCap: cap, paneCount: 1, paneIds: ["p0"] };
  const workers = claims.map(({ key, kind }) => {
    const thread = new Worker(worker, { workerData: { stateDir, check, key, kind, now: T0, barrier } });
    let ready!: () => void, done!: (v: { ok: boolean }) => void;
    const waiting = new Promise<void>((resolve) => { ready = resolve; });
    const result = new Promise<{ ok: boolean }>((resolve, reject) => { done = resolve; thread.on("error", reject); });
    thread.on("message", (v) => v === "ready" ? ready() : done(v));
    return { thread, waiting, result };
  });
  await Promise.all(workers.map((x) => x.waiting));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, workers.length);
  const results = await Promise.all(workers.map((x) => x.result));
  await Promise.all(workers.map((x) => x.thread.terminate()));
  return results.map((r) => r.ok);
};

test("cross-thread claims for the last slot: the author claim never wins the review reserve", async () => {
  const h = world(2);
  const [author, review] = await raceClaims(h.state.dir, 2, [{ key: "manual-1", kind: "author" }, { key: "review-1", kind: "review" }]);
  expect([author, review]).toEqual([false, true]);
  expect(slots(h.state.dir).map((s) => [s.key, s.kind])).toEqual([["review-1", "review"]]);
});

test("cross-thread claims from four authors and two reviews admit exactly 2 authors and 1 review", async () => {
  const h = world(4);
  const claims = [
    ...["a1", "a2", "a3", "a4"].map((key) => ({ key, kind: "author" as const })),
    ...["r1", "r2"].map((key) => ({ key, kind: "review" as const })),
  ];
  const results = await raceClaims(h.state.dir, 4, claims);
  expect(results.slice(0, 4).filter(Boolean)).toHaveLength(2);
  expect(results.slice(4).filter(Boolean)).toHaveLength(1);
  expect(slots(h.state.dir)).toHaveLength(3);
});

// ---------------------------------------------------------------------------------------------------------------------
// (c) memory/disk HOLD

test("a review launch does not bypass a memory or disk HOLD and keeps the reserve for later", async () => {
  for (const metric of [{ memFreePct: 0 }, { diskFreeGb: 0 }]) {
    const h = world(20);
    const observeMachine = h.ops.observeMachine;
    h.ops.observeMachine = async (machine?: string) => {
      const seen = await observeMachine(machine);
      return { ...seen, sample: { ...seen.sample, ...metric } };
    };
    const held = await launchReviewLane(h.deps, { key: "review-1", title: "review-1", brief: join(h.state.dir, "absent.md"), cwd: h.state.dir }, () => {});
    expect(held.kind).toBe("held");
    if (held.kind === "held") expect(held.reason).toMatch(/^HOLD .*free/);
    expect(h.started()).toEqual([]);
    expect(slots(h.state.dir)).toEqual([]);
    expect(launchQueue(h.state.dir).map((q) => [q.key, q.review])).toEqual([["review-1", true]]);
    // The pressure clears: the reserve is still there for the review.
    h.ops.observeMachine = observeMachine;
    expect((await h.review("review-1")).kind).toBe("started");
    expect(launchQueue(h.state.dir)).toEqual([]);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// (d) reviewer crash

test("a reviewer pane crash after it was observed returns the reserve to the next review", async () => {
  const h = world(3);
  expect((await h.review("review-1")).kind).toBe("started");
  // The next admission observes the pane, which turns the ledger entry into a running review.
  expect((await h.review("review-2")).kind).toBe("held");
  expect(slots(h.state.dir)).toEqual([]);
  await h.crash("review-1");
  expect((await h.review("review-2")).kind).toBe("started");
  expect((await h.deps.registry.read("review-1"))?.status).not.toBe("closed");
});

test("a failed review start releases its claim at once", async () => {
  const h = world(2);
  const start = h.ops.start;
  h.ops.start = async () => { throw new Error("runner lost during lane.start"); };
  const failed = await h.review("review-1");
  expect(failed.kind).toBe("refused");
  if (failed.kind === "refused") expect(failed.detail).toContain("runner lost");
  expect(slots(h.state.dir)).toEqual([]);
  h.ops.start = start;
  expect((await h.review("review-2")).kind).toBe("started");
});

test("closing a crashed reviewer's lane returns its reservation even when its pane was never observed", async () => {
  const h = world(2);
  expect((await h.review("review-1")).kind).toBe("started");
  await h.crash("review-1");
  await h.deps.registry.write({ ...(await h.deps.registry.read("review-1"))!, status: "closed", closedAt: new Date(T0).toISOString() });
  expect((await h.review("review-2")).kind).toBe("started");
});

test("a reviewer whose pane crashed before any observation returns its reservation after the slot TTL", async () => {
  // launch-admission.ts expires an unobserved slot after LAUNCH_SLOT_TTL_MS, so a review pane that died between its start
  // and the next observation releases the reserve without waiting for the lane to close.
  const h = world(2);
  expect((await h.review("review-1")).kind).toBe("started");
  await h.crash("review-1");
  h.clock.at += 60 * 60_000;
  expect((await h.review("review-2")).kind).toBe("started");
});
