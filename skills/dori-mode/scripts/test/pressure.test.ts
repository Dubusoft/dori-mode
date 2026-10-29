import { expect, test } from "bun:test";

import { procLanes, type Proc } from "../src/lane-memory.ts";
import { describeKilled, heavyTargets, killProcs } from "../src/pressure.ts";
import type { Clock } from "../src/run.ts";

const procs: Proc[] = [
  { pid: 1, ppid: 0, rssKb: 1000, comm: "systemd", args: "/sbin/init" },
  { pid: 10, ppid: 1, rssKb: 100_000, comm: "omo", lane: "dori-12", args: "omo --lane dori-12 qemu-system-note" },
  { pid: 11, ppid: 10, rssKb: 4_000_000, comm: "qemu-system-x86", args: "qemu-system-x86_64 -m 4096" },
  { pid: 12, ppid: 10, rssKb: 500_000, comm: "node", args: "node expo export --platform ios" },
  { pid: 13, ppid: 10, rssKb: 50_000, comm: "node", args: "node server.js" },
  { pid: 20, ppid: 1, rssKb: 300_000, comm: "emulator", lane: "other-lane", args: "emulator -avd x" },
  { pid: 30, ppid: 1, rssKb: 900_000, comm: "qemu-system-x86", args: "qemu-system-x86_64 stray" },
];

test("heavyTargets keeps only matching processes in the given lanes, ignoring blank patterns", () => {
  const got = heavyTargets(procs, ["qemu-system", " ", "expo export"], new Set(["dori-12"]));
  expect(got.map((p) => p.pid)).toEqual([10, 11, 12]);
  expect(heavyTargets(procs, ["emulator"], new Set(["dori-12"]))).toEqual([]);
  expect(heavyTargets(procs, ["  "], new Set(["dori-12"]))).toEqual([]);
});

test("heavyTargets never returns self or an ancestor of self", () => {
  const got = heavyTargets(procs, ["qemu-system"], new Set(["dori-12"]), 12);
  expect(got.map((p) => p.pid)).toEqual([11]);
});

test("killProcs sends TERM, waits five seconds on the clock, then KILLs only survivors", async () => {
  const events: string[] = [];
  const clock: Clock = { now: () => 0, sleep: async (ms) => { events.push(`sleep ${ms}`); } };
  const stubborn = new Set([11]);
  const targets = heavyTargets(procs, ["qemu-system", "expo export"], new Set(["dori-12"]), 10);
  const killed = await killProcs(targets, {
    clock,
    alive: (pid) => stubborn.has(pid),
    signal: (pid, sig) => { events.push(`${sig} ${pid}`); },
  }, procLanes(procs));
  expect(events).toEqual(["SIGTERM 11", "SIGTERM 12", "sleep 5000", "SIGKILL 11"]);
  expect(killed).toEqual([
    { pid: 11, lane: "dori-12", comm: "qemu-system-x86", rssKb: 4_000_000 },
    { pid: 12, lane: "dori-12", comm: "node", rssKb: 500_000 },
  ]);
  expect(describeKilled(killed)).toBe("dori-12 qemu-system-x86 3.8 GB (pid 11), dori-12 node 488 MB (pid 12)");
});

test("a signal that fails with ESRCH counts as already gone", async () => {
  const clock: Clock = { now: () => 0, sleep: async () => {} };
  const sent: string[] = [];
  const killed = await killProcs(procs.slice(1, 3), {
    clock,
    alive: () => true,
    signal: (pid, sig) => {
      if (pid === 10) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      sent.push(`${sig} ${pid}`);
    },
  }, procLanes(procs));
  expect(killed.map((k) => k.pid)).toEqual([11]);
  expect(sent).toEqual(["SIGTERM 11", "SIGKILL 11"]);
});
