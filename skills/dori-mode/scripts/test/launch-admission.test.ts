import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { type ToodoTask, LAUNCH_ACTION } from "../src/autopilot.ts";
import { judgeCandidates, liveJudgeDeps } from "../src/autopilot-cli.ts";
import { defaultConfig } from "../src/config.ts";
import { admissionSlots, claimSlot, LAUNCH_SLOT_TTL_MS, type LaunchSlot, precheckSlots } from "../src/launch-admission.ts";
import type { LaunchInput } from "../src/launch.ts";
import { admitLaunch, hostSummary, placeLaunch } from "../src/launch-service.ts";
import { SqliteOperations, plan } from "../src/operations.ts";
import { checkMachine, type MachineCheck, verdictLine } from "../src/placement.ts";
import type { Lane } from "../src/registry.ts";
import { launchQueue } from "../src/routing.ts";
import { depsFor, fakeClock, newWorld, withState, storePath } from "./fakes.ts";
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
/** `maxLanes` null: the default placement, whose local lane cap is this host's cores. */
const world = (cap = 20, maxLanes: Record<string, number> | null = { local: cap }) => {
  const state = withState();
  cleanups.push(state.done);
  const w = newWorld(), clock = fakeClock(T0);
  w.panes = [{ pane_id: "p0", workspace_id: "w" }];
  w.inspection = { git: undefined };
  const deps = depsFor(w, clock, state.dir, {
    guard: { ...defaultConfig("/home/test").guard, panesMax: cap },
    ...(maxLanes ? { placement: { defaultMachine: "local", fallback: [], maxLanes } } : {}),
  });
  const input = (key: string): LaunchInput => {
    const brief = join(state.dir, `${key}.md`);
    writeFileSync(brief, "Do the task.\n");
    return { key, brief, title: key, done: "closed acme/app#1" };
  };
  const launch = async (i: LaunchInput) => admitLaunch(deps, i, await placeLaunch(deps, i), () => {});
  return { state, w, deps, clock, input, launch };
};
const lane = (key: string, patch: Partial<Lane> = {}): Lane => ({
  key, title: key, thread: "none", brief: "/b.md", done: "closed acme/app#1", openedAt: new Date(T0).toISOString(), ...patch,
});
const flagged = (n: number): ToodoTask[] => Array.from({ length: n }, (_, i) => ({
  id: i + 1, workspaceId: 1, title: `task ${i + 1}`, description: "Do it", status: "planned", resolution: null, dependsOn: [],
  refs: ["owner:discord:c/m"], criteria: [{ text: "tests pass", kind: "manual" }], wait: null, autopilot: true, dueDate: null, pausedAt: null, waitSetAt: null,
}));
const judgeDeps = (h: ReturnType<typeof world>, store: SqliteOperations, tasks: ToodoTask[]) => ({
  ...liveJudgeDeps(h.deps, store), toodo: () => ({ flaggedTasks: async () => tasks, tasksByIds: async () => [] }),
  quota: async () => ({ readable: true, accounts: [{ name: "default", maxUsedPct: 10 }] }),
});

test("admission formula counts observed panes and pending launches against the cap, and is unlimited while the cap is off", () => {
  expect(admissionSlots(20, 1, 0)).toBe(19);
  expect(admissionSlots(20, 19, 1)).toBe(0);
  expect(admissionSlots(20, 18, 0)).toBe(2);
  for (const cap of [0, -1]) expect(admissionSlots(cap, 30, 8)).toBe(Infinity);
});

test("cap 20 and one other pane admit 19 lanes, hold the 20th, then launch it once a lane closes", async () => {
  const h = world();
  for (let n = 1; n <= 19; n++) expect((await h.launch(h.input(`lane-${n}`))).kind).toBe("launched");
  const waiting = h.input("lane-20");
  expect((await h.launch(waiting)).kind).toBe("held");
  const first = await h.deps.registry.read("lane-1");
  h.w.panes = h.w.panes.filter((p) => p.pane_id !== first?.pane);
  await h.deps.registry.write({ ...first!, status: "closed", closedAt: new Date(T0).toISOString() });
  expect((await h.launch(waiting)).kind).toBe("launched");
  expect(launchQueue(h.state.dir)).toEqual([]);
});

test("concurrent worker claims serialize under the lock and cannot share the last slot", async () => {
  const h = world(), barrier = new SharedArrayBuffer(4);
  const start = (key: string) => {
    const worker = new Worker(new URL("./fixtures/launch-slot-worker.ts", import.meta.url), {
      workerData: { stateDir: h.state.dir, check: check(2), key, now: T0, barrier },
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
  expect(claimSlot(h.state.dir, check(4), "pending-1", T0).ok).toBe(true);
  expect(claimSlot(h.state.dir, check(4), "pending-1", T0 + 1).ok).toBe(true);
  expect(slots(h.state.dir)).toHaveLength(1);
  await h.deps.registry.write(lane("pending-1", { pane: "p1" }));
  const observed = { ...check(4, 2), paneIds: ["p0", "p1"] };
  expect(precheckSlots(h.state.dir, observed, T0).free).toBe(2);
  expect(slots(h.state.dir)).toEqual([]);
  const launched = await h.launch(h.input("success-1"));
  expect(launched.kind).toBe("launched");
  expect(slots(h.state.dir).map((s) => s.key)).toEqual(["success-1"]);
});

test("manual placeLaunch/admitLaunch holds while pending launches fill the cap and queues memory or disk HOLD without a slot", async () => {
  const h = world(2), input = h.input("manual-held");
  expect(claimSlot(h.state.dir, check(2), "pending-1", T0).ok).toBe(true);
  const placed = await placeLaunch(h.deps, input);
  const held = await admitLaunch(h.deps, input, placed, () => {});
  expect(held.kind).toBe("held");
  if (held.kind !== "held") throw new Error("expected HOLD");
  expect(verdictLine(held.target, held.verdict)).toBe("HOLD launch slots 0 on machine local: 1 pending launch(es) fill the pane cap 2");
  expect(slots(h.state.dir).map((s) => s.key)).toEqual(["pending-1"]);
  for (const metric of [{ memFreePct: 0 }, { diskFreeGb: 0 }]) {
    const ops = { ...h.deps.ops, observeMachine: async () => {
      const observation = await h.deps.ops.observeMachine();
      return { ...observation, sample: { ...observation.sample, ...metric } };
    } };
    const deps = { ...h.deps, ops }, other = h.input("manual-metric");
    const refused = await admitLaunch(deps, other, await placeLaunch(deps, other), () => {});
    expect(refused.kind).toBe("held");
    if (refused.kind === "held") expect(refused.verdict.reasons.join(" ")).toContain("free");
    expect(slots(h.state.dir).map((s) => s.key)).toEqual(["pending-1"]);
  }
  expect(h.w.ops.filter((o) => o.op === "start")).toEqual([]);
});

test("a persisted slot of the retired review kind parses and counts as an ordinary pending launch", async () => {
  const h = world(3);
  writeFileSync(join(h.state.dir, "launch-slots.json"), JSON.stringify({ slots: [{ key: "old-review", machine: "local", kind: "review", at: T0 }] }));
  const room = precheckSlots(h.state.dir, check(3), T0);
  expect([room.free, room.reservedKeys]).toEqual([1, ["old-review"]]);
  expect(claimSlot(h.state.dir, check(3), "next-1", T0).ok).toBe(true);
  expect(claimSlot(h.state.dir, check(3), "next-2", T0).ok).toBe(false);
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
  const input = h.input("offline-1"), placed = await placeLaunch(h.deps, input);
  expect(placed.plan.check.verdict.ok).toBe(false);
  expect(placed.plan.check.verdict.reasons.join(" ")).toContain("offline");
  expect((await admitLaunch(h.deps, input, placed, () => {})).kind).toBe("held");
  expect(h.w.ops.filter((o) => o.op === "observeMachine")).toEqual([]);
  expect(slots(h.state.dir)).toEqual([]);
});

test("an unobservable runner holds with no slot", async () => {
  const h = world();
  h.w.runnerDown = true;
  expect((await h.launch(h.input("unreachable-1"))).kind).toBe("held");
  expect(slots(h.state.dir)).toEqual([]);
});

test("disabled pane cap keeps launches unlimited", async () => {
  // No lane cap either (the default local one is the cores): this test is about the pane cap alone.
  const h = world(0, { local: Infinity });
  for (let n = 0; n < 25; n++) expect(claimSlot(h.state.dir, check(0), `uncapped-${n}`, T0).ok).toBe(true);
  const first = h.input("uncapped-first"), second = h.input("uncapped-second");
  const [a, b] = await Promise.all([placeLaunch(h.deps, first), placeLaunch(h.deps, second)]);
  expect(a.lines.join("\n")).toContain("LAUNCH_WARN");
  expect((await admitLaunch(h.deps, first, a, () => {})).kind).toBe("launched");
  expect((await admitLaunch(h.deps, second, b, () => {})).kind).toBe("launched");
  expect(hostSummary(await checkMachine(h.deps.ops, h.deps.config, "local"), h.state.dir, T0).slots).toBeUndefined();
});

test("launch failure releases the slot and a later launch can claim it", async () => {
  const h = world(3), missing = { ...h.input("missing-brief"), brief: join(h.state.dir, "absent.md") };
  const failure = await h.launch(missing).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect(slots(h.state.dir)).toEqual([]);
  expect((await h.launch(h.input("after-failure"))).kind).toBe("launched");
});

test("pruning removes closed entries at once, keeps a not-yet-observed pane within the TTL and expires it after", async () => {
  const h = world();
  for (const key of ["closed-1", "expired-1", "starting-1"]) expect(claimSlot(h.state.dir, check(), key, T0).ok).toBe(true);
  await h.deps.registry.write(lane("closed-1", { status: "closed" }));
  await h.deps.registry.write(lane("starting-1", { pane: "not-observed" }));
  expect(precheckSlots(h.state.dir, check(), T0 + LAUNCH_SLOT_TTL_MS).reservedKeys.sort()).toEqual(["expired-1", "starting-1"]);
  // A pane still unobserved after the TTL is gone (it died before any observation): its slot is released.
  expect(precheckSlots(h.state.dir, check(), T0 + LAUNCH_SLOT_TTL_MS + 1).reservedKeys).toEqual([]);
  expect(slots(h.state.dir)).toEqual([]);
});

test("a default machine filled by pending launches tries fallback and uses the remote runner's pane cap", async () => {
  const h = world(2);
  expect(claimSlot(h.state.dir, check(2), "pending-local", T0).ok).toBe(true);
  const deps = {
    ...h.deps, config: { ...h.deps.config, placement: { defaultMachine: "local", fallback: ["box"] } },
    ops: { ...h.deps.ops, observeMachine: async (machine?: string) => ({
      ...(await h.deps.ops.observeMachine(machine)), ...(machine ? { guard: { panesMax: 5 } } : {}),
    }) },
  };
  const input = { ...h.input("fallback-1"), done: "" }, placed = await placeLaunch(deps, input);
  expect(placed.target).toBe("box");
  expect(placed.plan.check.paneCap).toBe(5);
  expect(placed.lines.join("\n")).toContain("PLACEMENT_FALLBACK local -> box (launch slots 0");
});

test("a lane cap counts the machine's open lanes and pending launches once by key, never the candidate's own key", async () => {
  const h = world(), capped = { ...check(), laneCap: 3 };
  await h.deps.registry.write(lane("open-1"));
  await h.deps.registry.write(lane("open-2", { machine: "local" }));
  await h.deps.registry.write(lane("closed-1", { status: "closed", closedAt: new Date(T0).toISOString() }));
  await h.deps.registry.write(lane("remote-1", { machine: "box" }));
  expect(claimSlot(h.state.dir, check(), "open-1", T0).ok).toBe(true);
  expect(precheckSlots(h.state.dir, capped, T0, "next-1")).toMatchObject({ verdict: { ok: true }, free: 1 });
  expect(claimSlot(h.state.dir, capped, "next-1", T0).ok).toBe(true);
  expect(claimSlot(h.state.dir, capped, "next-1", T0 + 1).ok).toBe(true);
  expect(claimSlot(h.state.dir, capped, "next-2", T0)).toEqual({ ok: false, reasons: ["lanes 3 >= maxLanes 3 on machine local"] });
  expect(precheckSlots(h.state.dir, { ...check(), laneCap: 1, machine: "box" }, T0).verdict.reasons).toEqual(["lanes 1 >= maxLanes 1 on machine box"]);
});

test("a default machine at its placement.maxLanes falls back to the next machine", async () => {
  const h = world();
  await h.deps.registry.write(lane("open-1"));
  const deps = { ...h.deps, config: { ...h.deps.config, placement: { defaultMachine: "local", fallback: ["box"], maxLanes: { local: 1 } } } };
  const input = { ...h.input("capped-1"), done: "" }, placed = await placeLaunch(deps, input);
  expect(placed.target).toBe("box");
  expect(placed.lines.join("\n")).toContain("PLACEMENT_FALLBACK local -> box (lanes 1 >= maxLanes 1 on machine local)");
});

test("autopilot plans 19 lanes and de-duplicates shared ledger claims against pending reservations by key", async () => {
  const h = world(), store = new SqliteOperations(storePath(h.state.dir));
  cleanups.push(() => store.close());
  const deps = judgeDeps(h, store, flagged(20));
  const report = await judgeCandidates(deps);
  expect(report.slots).toBe(19);
  expect(report.verdicts.filter((v) => v.verdict === "LAUNCH")).toHaveLength(19);
  expect(report.verdicts.filter((v) => v.verdict === "HOLD")).toHaveLength(1);
  expect(claimSlot(h.state.dir, check(), "ap-99-1", T0).ok).toBe(true);
  plan(store, T0, { lane: "toodo:99", action: LAUNCH_ACTION, target: "1", data: JSON.stringify({ laneKey: "ap-99-1" }) });
  const deduped = await judgeCandidates(deps);
  expect(deduped.slots).toBe(18);
  expect(deduped.verdicts.filter((v) => v.verdict === "LAUNCH")).toHaveLength(18);
});

test("without placement.maxLanes this host holds open lanes at its cores: slots stay within them and a burst after resume holds the rest", async () => {
  const h = world(20, null), store = new SqliteOperations(storePath(h.state.dir));
  cleanups.push(() => store.close());
  await h.deps.registry.write(lane("running-1"));
  const cores = availableParallelism(), room = Math.min(cores - 1, 19);
  expect((await judgeCandidates(judgeDeps(h, store, flagged(20)))).slots).toBe(room);
  // The executor places and admits each LAUNCH task in turn, as one tick does right after a resume.
  const kinds: string[] = [];
  for (let n = 1; n <= room + 3; n++) kinds.push((await h.launch(h.input(`ap-${n}-1`))).kind);
  expect(kinds).toEqual([...Array(room).fill("launched"), ...Array(3).fill("held")]);
  expect(launchQueue(h.state.dir).map((q) => q.reasons)).toEqual(Array(3).fill([`lanes ${cores} >= maxLanes ${cores} on machine local`]));
});
