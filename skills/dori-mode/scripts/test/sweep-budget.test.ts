import { afterEach, beforeEach, expect, test } from "bun:test";

import { defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { Registry, type Lane } from "../src/registry.ts";
import type { LaneOps } from "../src/lane-ops.ts";
import type { Pane } from "../src/panes.ts";
import type { Ran } from "../src/run.ts";
import { runSweeps, supervisorSweeps } from "../src/supervise-loop.ts";
import { boundedCalls, newSweepCache, SWEEP_SCREEN_MAX_AGE_MS, sweepRound } from "../src/sweep-view.ts";
import { fakeClock, fakeLaneOps, newWorld, testTunables, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MODEL = defaultConfig("/home/test").defaultModel;
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

type Row = { pane_id: string; workspace_id: string; agent: string; agent_status: string; revision: number };

/** Resolves after the other started calls had their turn, so calls of one machine overlap without a timer. */
const yieldTurns = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** The runners of two machines ("" is this host) behind a LaneOps: counts calls and in-flight calls per machine. */
const herdr = () => {
  const panes = new Map<string, Row[]>([["", []], ["box2", []]]);
  const calls: { readonly op: string; readonly machine: string; readonly pane?: string }[] = [];
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  const counted = async <T>(op: string, machine: string | undefined, pane: string | undefined, body: (rows: Row[]) => T): Promise<T> => {
    const m = machine ?? "";
    calls.push({ op, machine: m, ...(pane !== undefined ? { pane } : {}) });
    inFlight.set(m, (inFlight.get(m) ?? 0) + 1);
    peak.set(m, Math.max(peak.get(m) ?? 0, inFlight.get(m) ?? 0));
    try {
      await yieldTurns();
      return body(panes.get(m) ?? []);
    } finally { inFlight.set(m, (inFlight.get(m) ?? 1) - 1); }
  };
  const base = fakeLaneOps(newWorld());
  const ops: LaneOps = {
    ...base,
    panes: (machine) => counted("panes", machine, undefined, (rows) => rows.map((r): Pane => ({ ...r }))),
    screen: (ref) => counted("screen", ref.machine, ref.pane, (rows) => `screen of ${ref.pane} at ${rows.find((r) => r.pane_id === ref.pane)?.revision}\n❯ `),
    processInfo: (ref) => counted("processInfo", ref.machine, ref.pane, (): Ran => ({ code: 0, out: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: ["omo", "--model", MODEL] }] } } }), err: "" })),
    status: async (ref) => ({ status: (await ops.panes(ref.machine)).find((p) => p.pane_id === ref.pane)?.agent_status }),
  };
  return { panes, calls, peak, ops };
};

const setup = async () => {
  const h = herdr();
  const clock = fakeClock(T0);
  const config = { ...defaultConfig("/home/test"), stateDir: state.dir, defaultCwd: "/repo", leadPane: "lead:p1", laneWorkspace: "none" };
  const deps: FlowDeps = { run: async (): Promise<Ran> => ({ code: 1, out: "", err: "no lane access outside the facade" }), clock, registry: new Registry(state.dir), config, tunables: testTunables(), exists: () => true, ops: h.ops };
  for (let i = 0; i < 100; i++) {
    const machine = i % 2 ? "box2" : "";
    const pane = `w${i}:p1`;
    h.panes.get(machine)?.push({ pane_id: pane, workspace_id: `w${i}`, agent: "omo", agent_status: i % 3 ? "working" : "idle", revision: 1 });
    const lane: Lane = { key: `lane-${i}`, title: `lane ${i}`, thread: "none", pane, ...(machine ? { machine } : {}), brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
    await deps.registry.write(lane);
  }
  const sweeps = supervisorSweeps(deps, "/home/test");
  const lines: string[] = [];
  const round = async (): Promise<{ readonly calls: number; readonly panes: number }> => {
    const before = h.calls.length;
    await runSweeps(sweeps, async (line) => { lines.push(line); }, clock.now, new Map(), () => {});
    clock.at += 30_000;
    return { calls: h.calls.length - before, panes: h.calls.slice(before).filter((c) => c.op === "panes").length };
  };
  return { h, round, lines };
};

const MACHINES = 2;

test("with 100 open lanes a round makes one pane list per machine plus at most 2 reads per changed lane, 4 calls per machine at once", async () => {
  const { h, round, lines } = await setup();
  const first = await round();
  expect(first.calls).toBeLessThanOrEqual(MACHINES + 100 * 2);
  expect(first.panes).toBe(MACHINES);
  const steady = await round();
  expect(steady).toEqual({ calls: MACHINES, panes: MACHINES });
  const changed = [...(h.panes.get("") ?? []).slice(0, 4), ...(h.panes.get("box2") ?? []).slice(0, 3)];
  for (const row of changed) row.revision++;
  const flipped = h.panes.get("box2")?.[10];
  if (flipped) flipped.agent_status = flipped.agent_status === "working" ? "idle" : "working";
  const after = await round();
  expect(after.panes).toBe(MACHINES);
  expect(after.calls).toBeLessThanOrEqual(MACHINES + (changed.length + 1) * 2);
  expect(await round()).toMatchObject({ calls: MACHINES });
  for (const machine of ["", "box2"]) {
    expect(h.peak.get(machine) ?? 0).toBeLessThanOrEqual(4);
    expect(h.peak.get(machine) ?? 0).toBeGreaterThan(1);
  }
  expect(lines.filter((line) => /^(LANE_RECOVER|NUDGED|DEAD_PANE|UNRECOGNISED_PANE)/.test(line))).toEqual([]);
});

/** One pane whose revision, scroll extent and screen the test changes by hand. */
const screenFake = () => {
  const state = { revision: 2, maxOffset: 43, screen: "old screen" };
  const calls: { readonly op: string; readonly lines?: number }[] = [];
  const ops: LaneOps = {
    ...fakeLaneOps(newWorld()),
    panes: async () => {
      calls.push({ op: "panes" });
      return [{ pane_id: "w1:p1", workspace_id: "w1", revision: state.revision, scroll: { max_offset_from_bottom: state.maxOffset } } as Pane];
    },
    screen: async (_ref, lines) => { calls.push({ op: "screen", ...(lines !== undefined ? { lines } : {}) }); return state.screen; },
  };
  const reads = (): number => calls.filter((c) => c.op === "screen").length;
  const lists = (): number => calls.filter((c) => c.op === "panes").length;
  return { state, ops, reads, lists };
};
const PANE = { pane: "w1:p1" };

test("a screen is read again when the scroll extent grows although the revision is unchanged", async () => {
  const f = screenFake();
  const cache = newSweepCache();
  let now = T0;
  const opts = { now: () => now, deadlineMs: 10_000 };
  expect(await (await sweepRound(f.ops, cache, [], opts)).screen(PANE, 50)).toBe("old screen");
  f.state.screen = "old screen\n[REPORT] new";
  f.state.maxOffset = 44;
  now += 30_000;
  expect(await (await sweepRound(f.ops, cache, [], opts)).screen(PANE, 50)).toBe("old screen\n[REPORT] new");
  expect(f.reads()).toBe(2);
});

test("a screen with the same revision and scroll extent is served from the cache while younger than the maximum age", async () => {
  const f = screenFake();
  const cache = newSweepCache();
  let now = T0;
  const opts = { now: () => now, deadlineMs: 10_000 };
  await (await sweepRound(f.ops, cache, [], opts)).screen(PANE, 50);
  f.state.screen = "changed";
  now += SWEEP_SCREEN_MAX_AGE_MS - 1;
  expect(await (await sweepRound(f.ops, cache, [], opts)).screen(PANE, 50)).toBe("old screen");
  expect(f.reads()).toBe(1);
});

test("a screen with the same revision and scroll extent is read again once older than the maximum age", async () => {
  const f = screenFake();
  const cache = newSweepCache();
  let now = T0;
  const opts = { now: () => now, deadlineMs: 10_000 };
  await (await sweepRound(f.ops, cache, [], opts)).screen(PANE, 50);
  f.state.screen = "changed";
  now += SWEEP_SCREEN_MAX_AGE_MS + 1;
  expect(await (await sweepRound(f.ops, cache, [], opts)).screen(PANE, 50)).toBe("changed");
  expect(f.reads()).toBe(2);
});

test("a screen is re-read only when the pane revision or scroll changed, with one pane list per round", async () => {
  const f = screenFake();
  const cache = newSweepCache();
  let now = T0;
  const opts = { now: () => now, deadlineMs: 10_000 };
  for (let i = 0; i < 3; i++) { await (await sweepRound(f.ops, cache, [], opts)).screen(PANE, 50); now += 30_000; }
  expect(f.reads()).toBe(1);
  expect(f.lists()).toBe(3);
  f.state.revision++;
  await (await sweepRound(f.ops, cache, [], opts)).screen(PANE, 50);
  expect(f.reads()).toBe(2);
});

test("a bounded gate never runs more than its limit at once and starts nothing past its deadline", async () => {
  let active = 0;
  let peak = 0;
  let started = 0;
  const call = async (): Promise<string> => {
    started++;
    active++;
    peak = Math.max(peak, active);
    await yieldTurns();
    active--;
    return "ok";
  };
  let now = 0;
  const gate = boundedCalls(4, 1_000, () => now);
  const results = await Promise.all(Array.from({ length: 20 }, () => gate(call)));
  expect(results.every((r) => r === "ok")).toBe(true);
  expect(peak).toBe(4);
  now = 1_000;
  await expect(gate(call)).rejects.toThrow("deadline passed");
  expect(started).toBe(20);
});

test("sweepRound issues one pane list per machine and re-reads only the screens whose pane changed", async () => {
  const h = herdr();
  const lanes: Lane[] = [];
  for (let i = 0; i < 40; i++) {
    const machine = i % 2 ? "box2" : "";
    const pane = `w${i}:p1`;
    h.panes.get(machine)?.push({ pane_id: pane, workspace_id: `w${i}`, agent: "omo", agent_status: "working", revision: 1 });
    lanes.push({ key: `lane-${i}`, title: "t", thread: "none", pane, ...(machine ? { machine } : {}), brief: "/b.md", done: "d", openedAt: new Date(T0).toISOString() });
  }
  const cache = newSweepCache();
  let now = T0;
  const opts = { now: () => now, deadlineMs: 10_000 };
  const round = async () => {
    const before = h.calls.length;
    await sweepRound(h.ops, cache, lanes, opts);
    const made = h.calls.slice(before);
    return { panes: made.filter((c) => c.op === "panes").length, screens: made.filter((c) => c.op === "screen").length };
  };
  expect(await round()).toEqual({ panes: 2, screens: 40 });
  now += 30_000;
  expect(await round()).toEqual({ panes: 2, screens: 0 });
  const row = h.panes.get("box2")?.[0];
  if (row) row.revision++;
  now += 30_000;
  expect(await round()).toEqual({ panes: 2, screens: 1 });
});
