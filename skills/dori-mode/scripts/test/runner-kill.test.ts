import { expect, test } from "bun:test";
import type { HostSample } from "../src/host-guard.ts";
import type { Proc } from "../src/lane-memory.ts";
import { RunnerGuard } from "../src/runner/guard.ts";
import type { RunnerEventType } from "../src/runner/protocol.ts";
import { fakeClock } from "./fakes.ts";

const thresholds = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 20 };
const critical: HostSample = { load1: 4, memFreePct: 3, diskFreeGb: 100, swapFreeGb: 1, swapTotalGb: 8, panes: 3 };

// lane-a's agent (10) runs an emulator (11); a second emulator (20) belongs to no lane; the runner (31) itself
// matches the pattern and runs under a process (30) that carries lane-a's key.
const procs: Proc[] = [
  { pid: 10, ppid: 1, rssKb: 100_000, comm: "omo", lane: "lane-a", args: "omo --lane lane-a" },
  { pid: 11, ppid: 10, rssKb: 4_000_000, comm: "qemu-system-x86", args: "qemu-system-x86_64 -m 4096" },
  { pid: 20, ppid: 1, rssKb: 4_000_000, comm: "qemu-system-x86", args: "qemu-system-x86_64 -m 4096" },
  { pid: 30, ppid: 1, rssKb: 10_000, comm: "sh", lane: "lane-a", args: "sh -c qemu-system wrapper" },
  { pid: 31, ppid: 30, rssKb: 60_000, comm: "bun", args: "bun dori.js runner serve qemu-system" },
];

const guardWith = (sample: HostSample) => {
  const clock = fakeClock(1_000);
  const signals: [number, string][] = [];
  const published: [RunnerEventType, unknown][] = [];
  const guard = new RunnerGuard({
    sample: async () => sample, thresholds, heavyKill: ["qemu-system"], procs: async () => procs, self: 31,
    kill: { clock, alive: () => false, signal: (pid, sig) => { signals.push([pid, sig]); } },
    publish: (type, body) => { published.push([type, body]); }, now: clock.now, os: "linux",
  });
  return { guard, signals, published };
};

test("under critical memory only the lane's matching process is killed, never one outside a lane or the runner and its ancestors", async () => {
  const { guard, signals, published } = guardWith(critical);
  await guard.tick();
  expect(signals).toEqual([[11, "SIGTERM"]]);
  expect(published.map(([type]) => type)).toEqual(["guard.sample", "guard.alert", "guard.critical"]);
  expect(published[2]?.[1]).toEqual({ killed: [11], paused: [], reasons: ["memory free 3% < 5%"], rssKb: [4_000_000], cmds: ["qemu-system-x86"] });
});

test("guard.kill limits the kill to the named lanes", async () => {
  const { guard, signals } = guardWith({ ...critical, memFreePct: 50 });
  expect(await guard.killLanes(["lane-b"])).toEqual([]);
  expect(signals).toEqual([]);
  expect((await guard.killLanes(["lane-a"])).map((k) => k.pid)).toEqual([11]);
  expect(signals).toEqual([[11, "SIGTERM"]]);
});

test("a healthy sample kills nothing and is sent once a minute and on a level change", async () => {
  const { guard, signals, published } = guardWith({ ...critical, memFreePct: 50, swapFreeGb: 6 });
  await guard.tick();
  await guard.tick();
  expect(signals).toEqual([]);
  expect(published.map(([type]) => type)).toEqual(["guard.sample"]);
});

test("guard.sample carries the pane count and per-lane memory, heaviest commands first", async () => {
  const { guard, published } = guardWith({ ...critical, memFreePct: 50, swapFreeGb: 6 });
  await guard.tick();
  expect(published[0]?.[1]).toMatchObject({
    level: "ok", panes: 3,
    lanes: [{ key: "lane-a", rssKb: 4_170_000, top: [{ comm: "qemu-system-x86", rssKb: 4_000_000, count: 1 }, { comm: "omo", rssKb: 100_000, count: 1 }, { comm: "bun", rssKb: 60_000, count: 1 }, { comm: "sh", rssKb: 10_000, count: 1 }] }],
  });
});
