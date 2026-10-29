import { expect, test } from "bun:test";

import type { DoriConfig } from "../src/config.ts";
import { eventClass } from "../src/event-policy.ts";
import type { HostSample } from "../src/host-guard.ts";
import type { Proc } from "../src/lane-memory.ts";
import type { PauseResult } from "../src/pause.ts";
import type { Lane } from "../src/registry.ts";
import type { GuardMachine, KillResult, MachineSample } from "../src/remote-guard.ts";
import type { Runner } from "../src/run.ts";
import { localCriticalTick, machineCriticalTick, type PressureIo, warnMachineLanes } from "../src/supervise-loop.ts";
import { fakeClock } from "./fakes.ts";

const config = {
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 0 },
  heavyKill: ["qemu-system", "emulator", "expo export"],
} as unknown as DoriConfig;

const openLane = (key: string, extra: Partial<Lane> = {}): Lane => ({ key, title: key, thread: "t", brief: "b", done: "d", openedAt: "2026-01-01T00:00:00Z", pane: `w:${key}`, ...extra });

const procs: Proc[] = [
  { pid: 1, ppid: 0, rssKb: 9_000_000, comm: "systemd", args: "/sbin/init" },
  { pid: 10, ppid: 1, rssKb: 100_000, comm: "omo", lane: "emu-lane", args: "omo" },
  { pid: 13, ppid: 10, rssKb: 4_089_446, comm: "qemu-system-x86", args: "/opt/qemu-system-x86_64 -m 4096" },
  { pid: 20, ppid: 1, rssKb: 150_000, comm: "omo", lane: "small-lane", args: "omo" },
];
const noHeavy = procs.filter((p) => p.pid !== 13);

/** A herdr runner whose panes all exist; records every other call. */
const herdr = (panes: string[]) => {
  const sent: string[][] = [];
  const run: Runner = async (argv) => {
    const a = argv[1] === "--machine" ? argv.slice(3) : argv.slice(1);
    if (a[0] === "pane" && a[1] === "list") return { code: 0, out: JSON.stringify({ result: { panes: panes.map((p) => ({ pane_id: p, workspace_id: "w", agent: "omo", agent_status: "working" })) } }), err: "" };
    sent.push([...argv]);
    return { code: 0, out: "", err: "" };
  };
  return { run, sent };
};

const io = (over: Partial<PressureIo> = {}) => {
  const signals: [number, string][] = [];
  const paused: string[] = [];
  const value: PressureIo = {
    procs: async () => procs,
    signal: (pid, sig) => { signals.push([pid, sig]); },
    alive: () => false,
    self: 999,
    killRemote: async () => ({ ok: true, killed: [] }),
    pause: async (lane: Lane, note: string): Promise<PauseResult> => {
      paused.push(`${lane.key}: ${note}`);
      return { lane, lines: [`PAUSED ${lane.key} goal paused`], code: 0 };
    },
    ...over,
  };
  return { value, signals, paused };
};

const critical: HostSample = { load1: 1, memFreePct: 3, diskFreeGb: 200, swapFreeGb: 2, swapTotalGb: 4, panes: 3 };

test("a critical sweep kills the heavy lane process, emits one CRITICAL line and tells the lane", async () => {
  const { run, sent } = herdr(["w:emu-lane", "w:small-lane"]);
  const deps = { run, config, clock: fakeClock(0), registry: { open: async () => [openLane("emu-lane"), openLane("small-lane")] } };
  const fake = io();
  const line = await localCriticalTick(deps as never, critical, { critical: false }, fake.value);
  expect(line).toBe("HOST_GUARD CRITICAL memory free 3% < 5%; killed emu-lane qemu-system-x86 3.9 GB (pid 13) - tell the owner");
  expect(fake.signals).toEqual([[13, "SIGTERM"]]);
  expect(fake.paused).toEqual([]);
  const texts = sent.filter((c) => c[2] === "send-text");
  expect(texts.map((c) => c[3])).toEqual(["w:emu-lane"]);
  expect(texts[0]?.[4]).toStartWith("[System] HOST_GUARD memory critical: memory free 3% < 5% on this host, so the supervisor killed emu-lane qemu-system-x86 3.9 GB (pid 13)");
  expect(eventClass(line!)).toBe("lead-urgent");
});

test("entering critical with nothing to kill pauses the heaviest open local lane; a repeat sweep says nothing", async () => {
  const { run } = herdr(["w:emu-lane", "w:small-lane"]);
  const deps = { run, config, clock: fakeClock(0), registry: { open: async () => [openLane("small-lane"), openLane("emu-lane"), openLane("far", { machine: "mac" })] } };
  const fake = io({ procs: async () => noHeavy });
  const state = { critical: false };
  expect(await localCriticalTick(deps as never, critical, state, fake.value))
    .toBe("HOST_GUARD CRITICAL memory free 3% < 5%; paused small-lane (PAUSED small-lane goal paused) - tell the owner");
  expect(fake.paused).toEqual(["small-lane: memory critical: memory free 3% < 5%"]);
  expect(await localCriticalTick(deps as never, critical, state, fake.value)).toBeUndefined();
  expect(fake.paused).toHaveLength(1);
  // Leaving critical resets the flag, so the next entry acts again.
  expect(await localCriticalTick(deps as never, { ...critical, memFreePct: 30 }, state, fake.value)).toBeUndefined();
  expect(state.critical).toBe(false);
});

test("with no local lane the CRITICAL line says nothing could be done, and a failing sampler still yields the line", async () => {
  const deps = { run: herdr([]).run, config, clock: fakeClock(0), registry: { open: async () => [] } };
  expect(await localCriticalTick(deps as never, critical, { critical: false }, io().value))
    .toBe("HOST_GUARD CRITICAL memory free 3% < 5%; nothing to kill or pause - tell the owner");
  const broken = io({ procs: async () => { throw new Error("ps gone"); } });
  expect(await localCriticalTick(deps as never, critical, { critical: false }, broken.value))
    .toBe("HOST_GUARD CRITICAL memory free 3% < 5%; kill failed: ps gone; nothing to kill or pause - tell the owner");
});

const machine: GuardMachine = { label: "mac mini", target: "mac.local" };
const remote: MachineSample = { version: "v1", os: "Darwin", load1: 1, memFreePct: 2, swapFreeGb: -1, swapTotalGb: -1, diskFreeGb: 100 };

test("a critical machine has its heavy processes killed through the agent and its lanes told", async () => {
  const { run, sent } = herdr(["w:app-1"]);
  const kills: string[][] = [];
  const fake = io({
    killRemote: async (m, patterns): Promise<KillResult> => {
      kills.push([m.label, ...patterns]);
      return { ok: true, killed: [{ pid: 4242, rssKb: 3_145_728, cmd: "qemu-system-aarch64" }] };
    },
  });
  const open = [openLane("app-1", { machine: "mac mini" }), openLane("local-1")];
  const line = await machineCriticalTick({ run, config }, machine, remote, open, new Map(), fake.value);
  expect(line).toBe("HOST_GUARD CRITICAL machine=mac_mini memory free 2% < 5%; killed qemu-system-aarch64 3.0 GB (pid 4242) - tell the owner");
  expect(kills).toEqual([["mac mini", "qemu-system", "emulator", "expo export"]]);
  const texts = sent.filter((c) => c.includes("send-text"));
  expect(texts.map((c) => c.slice(0, 3))).toEqual([["herdr", "--machine", "mac mini"]]);
  expect(texts[0]?.at(-1)).toContain("guard-agent.sh heavy");
});

test("a machine entering critical with nothing killed pauses its newest lane once", async () => {
  const { run } = herdr([]);
  const fake = io();
  const state = new Map<string, boolean>();
  const open = [openLane("old", { machine: "mac mini" }), openLane("new", { machine: "mac mini", openedAt: "2026-02-01T00:00:00Z" })];
  expect(await machineCriticalTick({ run, config }, machine, remote, open, state, fake.value))
    .toBe("HOST_GUARD CRITICAL machine=mac_mini memory free 2% < 5%; paused new (PAUSED new goal paused) - tell the owner");
  expect(await machineCriticalTick({ run, config }, machine, remote, open, state, fake.value)).toBeUndefined();
  expect(await machineCriticalTick({ run, config }, machine, remote, [], new Map(), io({ killRemote: async () => ({ ok: false, detail: "unreachable: timeout" }) }).value))
    .toBe("HOST_GUARD CRITICAL machine=mac_mini memory free 2% < 5%; kill failed: unreachable: timeout; nothing to kill or pause - tell the owner");
});

test("a machine low on memory has every lane there warned in its remote pane", async () => {
  const { run, sent } = herdr(["w:app-1"]);
  const open = [openLane("app-1", { machine: "mac mini" }), openLane("local-1")];
  expect(await warnMachineLanes(run, machine, { ...remote, memFreePct: 12 }, open, 20)).toBe("warned app-1");
  expect(sent.find((c) => c.includes("send-text"))?.at(-1)).toStartWith("[System] HOST_GUARD memory warning: memory free 12% < 20% on machine mac mini");
  expect(await warnMachineLanes(run, machine, { ...remote, memFreePct: 50 }, open, 20)).toBeUndefined();
});

test("a nearly full swap is not critical on macOS, which grows its swap on demand, but is on Linux", async () => {
  const { run } = herdr([]);
  const fullSwap: MachineSample = { ...remote, memFreePct: 40, swapFreeGb: 0.05, swapTotalGb: 2 };
  expect(await machineCriticalTick({ run, config }, machine, { ...fullSwap, os: "darwin" }, [], new Map(), io().value)).toBeUndefined();
  expect(await machineCriticalTick({ run, config }, machine, { ...fullSwap, os: "linux" }, [], new Map(), io().value)).toContain("swap free 0.05 GB of 2.0 GB");
});

test("a lane on a question prompt is not typed into when its process is killed", async () => {
  const { run, sent } = herdr(["w:emu-lane"]);
  const deps = { run, config, clock: fakeClock(0), registry: { open: async () => [openLane("emu-lane", { lastAskPrompt: "q" })] } };
  const line = await localCriticalTick(deps as never, critical, { critical: false }, io().value);
  expect(line).toContain("could not notify emu-lane");
  expect(sent.filter((c) => c.includes("send-text"))).toEqual([]);
});
