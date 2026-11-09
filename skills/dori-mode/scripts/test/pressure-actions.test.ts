import { expect, test } from "bun:test";

import type { DoriConfig } from "../src/config.ts";
import { eventClass } from "../src/event-policy.ts";
import type { HostSample } from "../src/host-guard.ts";
import type { LaneMemory } from "../src/lane-memory.ts";
import type { PauseResult } from "../src/pause.ts";
import type { Lane } from "../src/registry.ts";
import type { GuardMachine, KillResult, MachineSample } from "../src/remote-guard.ts";
import { criticalTick, type PressureIo, warnMachineLanes } from "../src/supervise-loop.ts";
import { fakeLaneOps, newWorld, sent, type World } from "./fakes.ts";

const config = {
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 0 },
  heavyKill: ["qemu-system", "emulator", "expo export"],
} as unknown as DoriConfig;

const openLane = (key: string, extra: Partial<Lane> = {}): Lane => ({ key, title: key, thread: "t", brief: "b", done: "d", openedAt: "2026-01-01T00:00:00Z", pane: `w:${key}`, ...extra });

/** A World whose panes all exist; its facade records every send. */
const world = (panes: string[]): { w: World; deps: { ops: ReturnType<typeof fakeLaneOps>; config: DoriConfig } } => {
  const w = newWorld();
  w.panes = panes.map((p) => ({ pane_id: p, workspace_id: "w", agent: "omo", agent_status: "working" }));
  return { w, deps: { ops: fakeLaneOps(w), config } };
};

const io = () => {
  const paused: string[] = [];
  const value: PressureIo = {
    pause: async (lane: Lane, note: string): Promise<PauseResult> => {
      paused.push(`${lane.key}: ${note}`);
      return { lane, lines: [`PAUSED ${lane.key} goal paused`], code: 0 };
    },
  };
  return { value, paused };
};

const none: KillResult = { ok: true, killed: [] };
const critical: HostSample & { os: string } = { os: "linux", load1: 1, memFreePct: 3, diskFreeGb: 200, swapFreeGb: 2, swapTotalGb: 4, panes: 3 };
const memory: LaneMemory[] = [
  { lane: "emu-lane", rssKb: 4_189_446, top: [{ comm: "qemu-system-x86", rssKb: 4_089_446, count: 1 }] },
  { lane: "small-lane", rssKb: 150_000, top: [{ comm: "omo", rssKb: 150_000, count: 1 }] },
];

test("a local runner's critical kill becomes one CRITICAL line, the local lanes are told through their runner, and nothing is signalled here", async () => {
  const { w, deps } = world(["w:emu-lane", "w:small-lane"]);
  const fake = io();
  const kills: KillResult = { ok: true, killed: [{ pid: 13, rssKb: 4_089_446, cmd: "qemu-system-x86" }] };
  const open = [openLane("emu-lane"), openLane("small-lane"), openLane("far", { machine: "mac" })];
  const line = await criticalTick(deps, { kind: "local" }, critical, open, new Map(), kills, fake.value, memory);
  expect(line).toBe("HOST_GUARD CRITICAL memory free 3% < 5%; killed qemu-system-x86 3.9 GB (pid 13) - tell the owner");
  expect(fake.paused).toEqual([]);
  const sends = w.ops.filter((e) => e.op === "send");
  expect(sends.map((e) => e.key)).toEqual(["emu-lane", "small-lane"]);
  expect(sends[0]?.args).toMatchObject({ opts: { mode: "guarded", refuseWhileAsking: true } });
  expect(sent(w)[0]).toStartWith("[System] HOST_GUARD memory critical: memory free 3% < 5% on this host, so its runner killed qemu-system-x86 3.9 GB (pid 13) there.");
  expect(sent(w)[0]).toContain("dori heavy <label> -- <command>");
  expect(w.calls).toEqual([]);
  expect(eventClass(line!)).toBe("lead-urgent");
});

test("entering critical with nothing killed pauses the heaviest open local lane; a repeat sweep says nothing", async () => {
  const { deps } = world(["w:emu-lane", "w:small-lane"]);
  const fake = io();
  const state = new Map<string, boolean>();
  const open = [openLane("small-lane"), openLane("emu-lane"), openLane("far", { machine: "mac" })];
  expect(await criticalTick(deps, { kind: "local" }, critical, open, state, none, fake.value, memory))
    .toBe("HOST_GUARD CRITICAL memory free 3% < 5%; paused emu-lane (PAUSED emu-lane goal paused) - tell the owner");
  expect(fake.paused).toEqual(["emu-lane: memory critical: memory free 3% < 5%"]);
  expect(await criticalTick(deps, { kind: "local" }, critical, open, state, none, fake.value, memory)).toBeUndefined();
  expect(fake.paused).toHaveLength(1);
  // Leaving critical resets the flag, so the next entry acts again.
  expect(await criticalTick(deps, { kind: "local" }, { ...critical, memFreePct: 30 }, open, state, none, fake.value, memory)).toBeUndefined();
  expect(state.get("local")).toBeUndefined();
});

test("with no local lane the CRITICAL line says nothing could be done", async () => {
  const { deps } = world([]);
  expect(await criticalTick(deps, { kind: "local" }, critical, [], new Map(), none, io().value))
    .toBe("HOST_GUARD CRITICAL memory free 3% < 5%; nothing to kill or pause - tell the owner");
});

const machine: GuardMachine = { label: "mac mini", target: "mac.local" };
const remote: MachineSample = { version: "v1", os: "Darwin", load1: 1, memFreePct: 2, swapFreeGb: -1, swapTotalGb: -1, diskFreeGb: 100 };

test("a critical machine reports its runner's kills and tells its lanes through that runner", async () => {
  const { w, deps } = world(["w:app-1"]);
  const kills: KillResult = { ok: true, killed: [{ pid: 4242, rssKb: 3_145_728, cmd: "qemu-system-aarch64" }] };
  const open = [openLane("app-1", { machine: "mac mini" }), openLane("local-1")];
  const line = await criticalTick(deps, { kind: "machine", machine }, remote, open, new Map(), kills, io().value);
  expect(line).toBe("HOST_GUARD CRITICAL machine=mac_mini memory free 2% < 5%; killed qemu-system-aarch64 3.0 GB (pid 4242) - tell the owner");
  expect(w.ops.filter((e) => e.op === "send").map((e) => e.key)).toEqual(["app-1"]);
  expect(sent(w)[0]).toContain("on machine mac mini, where this lane runs, so its runner killed");
  expect(sent(w)[0]).toContain("~/.dori/runner/bin/dori heavy");
});

test("a machine entering critical with nothing killed pauses its newest lane once; a failed kill report is in the line", async () => {
  const { deps } = world([]);
  const fake = io();
  const state = new Map<string, boolean>();
  const open = [openLane("old", { machine: "mac mini" }), openLane("new", { machine: "mac mini", openedAt: "2026-02-01T00:00:00Z" })];
  expect(await criticalTick(deps, { kind: "machine", machine }, remote, open, state, none, fake.value))
    .toBe("HOST_GUARD CRITICAL machine=mac_mini memory free 2% < 5%; paused new (PAUSED new goal paused) - tell the owner");
  expect(await criticalTick(deps, { kind: "machine", machine }, remote, open, state, none, fake.value)).toBeUndefined();
  expect(await criticalTick(deps, { kind: "machine", machine }, remote, [], new Map(), { ok: false, detail: "unreachable: timeout" }, io().value))
    .toBe("HOST_GUARD CRITICAL machine=mac_mini memory free 2% < 5%; kill failed: unreachable: timeout; nothing to kill or pause - tell the owner");
});

test("a machine low on memory has every lane there warned through its runner", async () => {
  const { w, deps } = world(["w:app-1"]);
  const open = [openLane("app-1", { machine: "mac mini" }), openLane("local-1")];
  expect(await warnMachineLanes(deps.ops, machine, { ...remote, memFreePct: 12 }, open, 20)).toBe("warned app-1");
  expect(sent(w)[0]).toStartWith("[System] HOST_GUARD memory warning: memory free 12% < 20% on machine mac mini");
  expect(await warnMachineLanes(deps.ops, machine, { ...remote, memFreePct: 50 }, open, 20)).toBeUndefined();
});

test("a nearly full swap is not critical on macOS, which grows its swap on demand, but is on Linux", async () => {
  const { deps } = world([]);
  const fullSwap: MachineSample = { ...remote, memFreePct: 40, swapFreeGb: 0.05, swapTotalGb: 2 };
  expect(await criticalTick(deps, { kind: "machine", machine }, { ...fullSwap, os: "darwin" }, [], new Map(), none, io().value)).toBeUndefined();
  expect(await criticalTick(deps, { kind: "machine", machine }, { ...fullSwap, os: "linux" }, [], new Map(), none, io().value)).toContain("swap free 0.05 GB of 2.0 GB");
});

test("a lane whose runner refuses the notice (a question prompt) or is down is named as not notified", async () => {
  const { w, deps } = world(["w:emu-lane"]);
  w.sendDelivery = "failed";
  const kills: KillResult = { ok: true, killed: [{ pid: 13, rssKb: 4_089_446, cmd: "qemu-system-x86" }] };
  const line = await criticalTick(deps, { kind: "local" }, critical, [openLane("emu-lane")], new Map(), kills, io().value);
  expect(line).toContain("could not notify emu-lane");
});
