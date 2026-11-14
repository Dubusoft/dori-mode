import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { type ToodoTask, LAUNCH_ACTION } from "../src/autopilot.ts";
import { judgeCandidates, liveJudgeDeps } from "../src/autopilot-cli.ts";
import { defaultConfig } from "../src/config.ts";
import { admissionSlots, claimSlot, LAUNCH_SLOT_TTL_MS, type LaunchSlot, precheckSlots, releaseSlot } from "../src/launch-admission.ts";
import type { LaunchInput } from "../src/launch.ts";
import { admitLaunch, hostSummary, placeLaunch } from "../src/launch-service.ts";
import { JsonOperations, plan } from "../src/operations.ts";
import { checkMachine, type MachineCheck, verdictLine } from "../src/placement.ts";
import type { Lane } from "../src/registry.ts";
import { launchQueue } from "../src/routing.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { enrollRunners } from "./runner-guard-world.ts";

const T0 = Date.parse("2026-11-14T12:00:00Z");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });
const slots = (stateDir: string): LaunchSlot[] => {
  const path = join(stateDir, "launch-slots.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).slots : [];
};
const check = (cap = 20, panes = 1, machine = "local"): MachineCheck => ({
  machine, verdict: { ok: true, reasons: [] }, summary: "", paneCap: cap, paneCount: panes,
  paneIds: Array.from({ length: panes }, (_, i) => `p${i}`),
});
const world = (cap = 20) => {
  const state = withState();
  cleanups.push(state.done);
  const w = newWorld(), clock = fakeClock(T0);
  w.panes = [{ pane_id: "p0", workspace_id: "w" }];
  w.inspection = { git: undefined };
  const deps = depsFor(w, clock, state.dir, { guard: { ...defaultConfig("/home/test").guard, panesMax: cap } });
  const input = (key: string, review?: true): LaunchInput => {
    const brief = join(state.dir, `${key}.md`);
    writeFileSync(brief, "Do the task.\n");
    return { key, brief, title: key, done: "closed acme/app#1", ...(review ? { review } : {}) };
  };
  const launch = async (i: LaunchInput) => admitLaunch(deps, i, await placeLaunch(deps, i), () => {});
  return { state, w, deps, clock, input, launch };
};
const lane = (key: string, patch: Partial<Lane> = {}): Lane => ({
  key, title: key, thread: "none", brief: "/b.md", done: "closed acme/app#1", openedAt: new Date(T0).toISOString(), ...patch,
});

test("admission formula reserves one review slot, including while the pane cap is disabled", () => {
  expect(admissionSlots(20, 1, 0, 0)).toEqual({ physicalFree: 19, unfilledReviewReserve: 1, authorAdmissible: 18, reviewAdmissible: 1 });
  expect(admissionSlots(20, 19, 1, 1)).toEqual({ physicalFree: 0, unfilledReviewReserve: 0, authorAdmissible: 0, reviewAdmissible: 0 });
  expect(admissionSlots(20, 18, 0, 1)).toEqual({ physicalFree: 2, unfilledReviewReserve: 0, authorAdmissible: 2, reviewAdmissible: 0 });
  for (const cap of [0, -1]) {
    expect(admissionSlots(cap, 30, 8, 0)).toEqual({ physicalFree: Infinity, unfilledReviewReserve: 1, authorAdmissible: Infinity, reviewAdmissible: 1 });
    expect(admissionSlots(cap, 30, 8, 1).reviewAdmissible).toBe(0);
  }
});

test("cap 20 and one other pane admit 18 authors, hold the 19th, then admit a review and wait for an author to close", async () => {
  const h = world();
  for (let n = 1; n <= 18; n++) expect((await h.launch(h.input(`author-${n}`))).kind).toBe("launched");
  const waiting = h.input("author-19");
  expect((await h.launch(waiting)).kind).toBe("held");
  const review = await h.launch(h.input("review-1", true));
  expect(review.kind).toBe("launched");
  if (review.kind !== "launched") throw new Error("review did not launch");
  expect(review.lane.review).toBe(true);
  expect(h.w.ops.find((o) => o.op === "start" && o.key === "review-1")?.args).toMatchObject({ review: true });
  expect((await h.launch(waiting)).kind).toBe("held");
  const author = await h.deps.registry.read("author-1");
  h.w.panes = h.w.panes.filter((p) => p.pane_id !== author?.pane);
  await h.deps.registry.write({ ...author!, status: "closed", closedAt: new Date(T0).toISOString() });
  expect((await h.launch(waiting)).kind).toBe("launched");
  expect(launchQueue(h.state.dir)).toEqual([]);
});

test("concurrent worker claims serialize under the lock and cannot share the last author slot", async () => {
  const h = world(), barrier = new SharedArrayBuffer(4);
  const start = (key: string) => {
    const worker = new Worker(new URL("./fixtures/launch-slot-worker.ts", import.meta.url), {
      workerData: { stateDir: h.state.dir, check: check(3), key, now: T0, barrier },
    });
    let ready!: () => void, done!: (value: { ok: boolean }) => void;
    const waiting = new Promise<void>((resolve) => { ready = resolve; });
    const result = new Promise<{ ok: boolean }>((resolve, reject) => {
      done = resolve;
      worker.on("error", reject);
    });
    worker.on("message", (value) => value === "ready" ? ready() : done(value));
    return { waiting, result, worker };
  };
  const workers = [start("racer-1"), start("racer-2")];
  await Promise.all(workers.map((w) => w.waiting));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, 2);
  const results = await Promise.all(workers.map((w) => w.result));
  await Promise.all(workers.map((w) => w.worker.terminate()));
  expect(results.map((r) => r.ok).sort()).toEqual([false, true]);
  expect(slots(h.state.dir)).toHaveLength(1);
});

test("observed panes leave Q, a claiming key is replaced, and successful launches keep their ledger entry", async () => {
  const h = world(4);
  expect(claimSlot(h.state.dir, check(4), "pending-1", "author", T0).ok).toBe(true);
  expect(claimSlot(h.state.dir, check(4), "pending-1", "author", T0 + 1).ok).toBe(true);
  expect(slots(h.state.dir)).toHaveLength(1);
  await h.deps.registry.write(lane("pending-1", { pane: "p1" }));
  const observed = { ...check(4, 2), paneIds: ["p0", "p1"] };
  expect(precheckSlots(h.state.dir, observed, T0).authorAdmissible).toBe(1);
  expect(slots(h.state.dir)).toEqual([]);
  const launched = await h.launch(h.input("success-1"));
  expect(launched.kind).toBe("launched");
  expect(slots(h.state.dir).map((s) => s.key)).toEqual(["success-1"]);
});

test("manual placeLaunch/admitLaunch honours the reserve and queues memory or disk HOLD without a slot", async () => {
  const h = world(2), input = h.input("manual-held");
  const placed = await placeLaunch(h.deps, input);
  const held = await admitLaunch(h.deps, input, placed, () => {});
  expect(held.kind).toBe("held");
  if (held.kind !== "held") throw new Error("expected HOLD");
  expect(verdictLine(held.target, held.verdict)).toBe("HOLD review reserve 1 on machine local: author slots 0");
  expect(slots(h.state.dir)).toEqual([]);
  for (const metric of [{ memFreePct: 0 }, { diskFreeGb: 0 }]) {
    const ops = { ...h.deps.ops, observeMachine: async () => {
      const observation = await h.deps.ops.observeMachine();
      return { ...observation, sample: { ...observation.sample, ...metric } };
    } };
    const deps = { ...h.deps, ops }, review = h.input("manual-review", true);
    const refused = await admitLaunch(deps, review, await placeLaunch(deps, review), () => {});
    expect(refused.kind).toBe("held");
    if (refused.kind === "held") expect(refused.verdict.reasons.join(" ")).toContain("free");
    expect(slots(h.state.dir)).toEqual([]);
  }
  expect(h.w.ops.filter((o) => o.op === "start")).toEqual([]);
});

test("offline owning runner holds unchecked and writes no slot", async () => {
  const h = world();
  enrollRunners(h.state.dir, "box");
  // enrollRunners leaves the runner offline; the owner declaration pins the launch.
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(h.state.dir, "runners.sqlite"));
  try {
    db.query("UPDATE runners SET workspaces = ? WHERE label = ?").run(JSON.stringify({
      declared: [{ repo: "acme/app", path: "/repo/app" }], detected: [],
    }), "box");
  } finally { db.close(); }
  const input = h.input("offline-review", true), placed = await placeLaunch(h.deps, input);
  expect(placed.plan.check.verdict.ok).toBe(false);
  expect(placed.plan.check.verdict.reasons.join(" ")).toContain("offline");
  expect((await admitLaunch(h.deps, input, placed, () => {})).kind).toBe("held");
  expect(h.w.ops.filter((o) => o.op === "observeMachine")).toEqual([]);
  expect(slots(h.state.dir)).toEqual([]);
});

test("an unobservable runner holds with no slot", async () => {
  const h = world();
  h.w.runnerDown = true;
  expect((await h.launch(h.input("unreachable-review", true))).kind).toBe("held");
  expect(slots(h.state.dir)).toEqual([]);
});

test("disabled pane cap keeps authors unlimited and holds a second concurrent review", async () => {
  const h = world(0);
  for (let n = 0; n < 25; n++) expect(claimSlot(h.state.dir, check(0), `uncapped-${n}`, "author", T0).ok).toBe(true);
  const first = h.input("review-first", true), second = h.input("review-second", true);
  const [a, b] = await Promise.all([placeLaunch(h.deps, first), placeLaunch(h.deps, second)]);
  expect(a.lines.join("\n")).toContain("LAUNCH_WARN");
  expect((await admitLaunch(h.deps, first, a, () => {})).kind).toBe("launched");
  expect((await admitLaunch(h.deps, second, b, () => {})).kind).toBe("held");
  expect(hostSummary(await checkMachine(h.deps.ops, h.deps.config, "local"), h.state.dir, T0).slots).toBeUndefined();
});

test("review pane crash returns its reserve before the registry closes the lane", async () => {
  const h = world(), first = await h.launch(h.input("review-crash", true));
  if (first.kind !== "launched") throw new Error("expected review launch");
  expect((await placeLaunch(h.deps, h.input("review-held", true))).plan.check.verdict.ok).toBe(false);
  expect(slots(h.state.dir)).toEqual([]);
  h.w.panes = h.w.panes.filter((p) => p.pane_id !== first.lane.pane);
  expect((await h.launch(h.input("review-next", true))).kind).toBe("launched");
  expect((await h.deps.registry.read(first.lane.key))?.status).not.toBe("closed");
});

test("launch failure releases the slot and a later launch can claim it", async () => {
  const h = world(3), missing = { ...h.input("missing-brief"), brief: join(h.state.dir, "absent.md") };
  const failure = await h.launch(missing).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect(slots(h.state.dir)).toEqual([]);
  expect((await h.launch(h.input("after-failure"))).kind).toBe("launched");
});

test("pruning removes closed and expired pane-less entries, but keeps a launch with a not-yet-observed pane", async () => {
  const h = world();
  for (const key of ["closed-1", "expired-1", "starting-1"]) expect(claimSlot(h.state.dir, check(), key, "author", T0).ok).toBe(true);
  await h.deps.registry.write(lane("closed-1", { status: "closed" }));
  await h.deps.registry.write(lane("starting-1", { pane: "not-observed" }));
  expect(precheckSlots(h.state.dir, check(), T0 + LAUNCH_SLOT_TTL_MS + 1).reservedKeys).toEqual(["starting-1"]);
  expect(slots(h.state.dir).map((s) => s.key)).toEqual(["starting-1"]);
  releaseSlot(h.state.dir, "starting-1");
  expect(slots(h.state.dir)).toEqual([]);
});

test("reserve-only default placement tries fallback and uses the remote runner's pane cap", async () => {
  const h = world(2);
  const deps = {
    ...h.deps, config: { ...h.deps.config, placement: { defaultMachine: "local", fallback: ["box"] } },
    ops: { ...h.deps.ops, observeMachine: async (machine?: string) => ({
      ...(await h.deps.ops.observeMachine(machine)), ...(machine ? { guard: { panesMax: 5 } } : {}),
    }) },
  };
  const input = { ...h.input("fallback-1"), done: "" }, placed = await placeLaunch(deps, input);
  expect(placed.target).toBe("box");
  expect(placed.plan.check.paneCap).toBe(5);
  expect(placed.lines.join("\n")).toContain("PLACEMENT_FALLBACK local -> box (review reserve");
});

test("autopilot plans 18 authors and de-duplicates shared ledger claims against pending reservations by key", async () => {
  const h = world(), store = new JsonOperations(h.state.dir);
  cleanups.push(() => store.close());
  const tasks: ToodoTask[] = Array.from({ length: 19 }, (_, i) => ({
    id: i + 1, workspaceId: 1, title: `task ${i + 1}`, description: "Do it", status: "planned", resolution: null, dependsOn: [],
    refs: ["owner:discord:c/m"], criteria: [{ text: "tests pass", kind: "manual" }], wait: null, autopilot: true, dueDate: null,
  }));
  const live = liveJudgeDeps(h.deps, store);
  const deps = {
    ...live, toodo: () => ({ flaggedTasks: async () => tasks, tasksByIds: async () => [] }),
    quota: async () => ({ readable: true, accounts: [{ name: "default", maxUsedPct: 10 }] }),
  };
  const report = await judgeCandidates(deps);
  expect(report.slots).toBe(18);
  expect(report.verdicts.filter((v) => v.verdict === "LAUNCH")).toHaveLength(18);
  expect(report.verdicts.filter((v) => v.verdict === "HOLD")).toHaveLength(1);
  expect(claimSlot(h.state.dir, check(), "ap-99-1", "author", T0).ok).toBe(true);
  plan(store, T0, { lane: "toodo:99", action: LAUNCH_ACTION, target: "1", data: JSON.stringify({ laneKey: "ap-99-1" }) });
  const deduped = await judgeCandidates(deps);
  expect(deduped.slots).toBe(17);
  expect(deduped.verdicts.filter((v) => v.verdict === "LAUNCH")).toHaveLength(17);
});
