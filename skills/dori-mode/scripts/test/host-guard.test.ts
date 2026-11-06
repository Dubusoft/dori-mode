import { expect, test } from "bun:test";

import type { Runner } from "../src/run.ts";
import { criticalReasons, guardTick, sampleHost } from "../src/host-guard.ts";
import { laneMemory, type Proc, procLanes, sampleProcs } from "../src/lane-memory.ts";
import { guardAlertDetail, laneMemoryOf, WARN_COOLDOWN_MS, warnHeaviestLane } from "../src/supervise-loop.ts";
import { fakeLaneOps, newWorld, sent } from "./fakes.ts";
import type { DoriConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";

const procs: Proc[] = [
  { pid: 1, ppid: 0, rssKb: 9_000_000, comm: "systemd" },
  { pid: 10, ppid: 1, rssKb: 100_000, comm: "omo", lane: "emu-lane" },
  { pid: 11, ppid: 10, rssKb: 200_000, comm: "node" },
  { pid: 12, ppid: 11, rssKb: 300_000, comm: "node" },
  { pid: 13, ppid: 12, rssKb: 4_000_000, comm: "qemu-system-x86" },
  { pid: 20, ppid: 1, rssKb: 150_000, comm: "omo", lane: "small-lane" },
  { pid: 21, ppid: 20, rssKb: 50_000, comm: "tsserver" },
  { pid: 30, ppid: 13, rssKb: 70_000, comm: "adb", lane: "small-lane" },
];

test("laneMemory sums each lane's process tree, its own DORI_LANE_KEY winning over its ancestor's", () => {
  const lanes = laneMemory(procs);
  expect(lanes.map((l) => [l.lane, l.rssKb])).toEqual([["emu-lane", 4_600_000], ["small-lane", 270_000]]);
  expect(lanes[0]!.top[0]).toEqual({ comm: "qemu-system-x86", rssKb: 4_000_000, count: 1 });
  expect(lanes[0]!.top[1]).toEqual({ comm: "node", rssKb: 500_000, count: 2 });
});

test("sampleProcs reads the lane from each environment and skips unreadable ones", async () => {
  const run: Runner = async (argv) => argv.at(-1) === "pid=,args=" ? { code: 1, out: "", err: "" } : ({ code: 0, out: "  10     1 1024 omo\n  11    10 2048 node\n  12    11 512 bad$(name\n", err: "" });
  const env = async (pid: number) => {
    if (pid === 12) throw new Error("EACCES");
    return pid === 10 ? "HOME=/x\0DORI_LANE_KEY=a-lane\0" : pid === 11 ? "DORI_LANE_KEY=bad\nkey\0" : "DORI_LANE_KEY=bad`key\0";
  };
  expect(await sampleProcs(run, env, true)).toEqual([
    { pid: 10, ppid: 1, rssKb: 1024, comm: "omo", lane: "a-lane" },
    { pid: 11, ppid: 10, rssKb: 2048, comm: "node" },
    { pid: 12, ppid: 11, rssKb: 512, comm: "bad__name" },
  ]);
  expect(await sampleProcs(run, env, false)).toEqual([]);
});

const openLane = (key: string, extra: Partial<Lane> = {}): Lane => ({ key, title: key, thread: "t", brief: "b", done: "d", openedAt: "x", pane: `w:${key}`, ...extra });

/** A World with these agent panes; its facade records every send. */
const lanesWorld = (agentPanes: string[]) => {
  const w = newWorld();
  w.panes = agentPanes.map((p) => ({ pane_id: p, workspace_id: "w", agent: "omo", agent_status: "working" }));
  return { w, ops: fakeLaneOps(w) };
};

test("on a memory alert the heaviest open local lane is warned through its runner and the ALERT says so", async () => {
  const { w, ops } = lanesWorld(["w:emu-lane", "w:small-lane"]);
  const deps = { ops, config: { guard: { memFreeMinPct: 10 } } as DoriConfig, registry: { open: async () => [openLane("emu-lane"), openLane("small-lane")] } };
  const sample = { load1: 1, memFreePct: 4, diskFreeGb: 200, swapFreeGb: 0.1, swapTotalGb: 4, panes: 3 };
  const detail = await guardAlertDetail(deps as never, sample, laneMemory(procs));
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 10, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 0 };
  const [alert] = guardTick(sample, t, { alerting: false }, detail);
  expect(alert).toBe("HOST_GUARD ALERT memory free 4% < 10%; lanes by memory: emu-lane 4.4 GB (qemu-system-x86 3.8 GB, node x2 488 MB, omo 98 MB), "
    + "small-lane 264 MB (omo 146 MB, adb 68 MB, tsserver 49 MB); warned emu-lane in its pane w:emu-lane");
  const sends = w.ops.filter((e) => e.op === "send");
  expect(sends.map((e) => e.key)).toEqual(["emu-lane"]);
  expect(sends[0]?.args).toMatchObject({ opts: { mode: "guarded", refuseWhileAsking: true } });
  expect(sent(w)[0]).toStartWith("[System] HOST_GUARD memory warning: memory free 4% < 10% on this host, and this lane (emu-lane) uses the most memory: emu-lane 4.4 GB");
});

test("the lanes by memory come from the runner's sample; without them the ALERT carries no detail", async () => {
  const { w, ops } = lanesWorld(["w:emu-lane"]);
  const deps = { ops, config: { guard: { memFreeMinPct: 10 } } as DoriConfig, registry: { open: async () => [openLane("emu-lane")] } };
  const sample = { load1: 1, memFreePct: 4, diskFreeGb: 200, swapFreeGb: 0.1, swapTotalGb: 4, panes: 3 };
  expect(await guardAlertDetail(deps as never, sample, undefined)).toBeUndefined();
  const body = [{ key: "emu-lane", rssKb: 4_600_000, top: [{ comm: "qemu-system-x86", rssKb: 4_000_000, count: 1 }] }];
  expect(laneMemoryOf(body)).toEqual([{ lane: "emu-lane", rssKb: 4_600_000, top: [{ comm: "qemu-system-x86", rssKb: 4_000_000, count: 1 }] }]);
  expect(await guardAlertDetail(deps as never, { ...sample, memFreePct: 50 }, laneMemoryOf(body))).toBe("lanes by memory: emu-lane 4.4 GB (qemu-system-x86 3.8 GB)");
  expect(w.ops).toEqual([]);
});

test("a disk-only alert lists the lanes but warns nobody", async () => {
  const { w, ops } = lanesWorld(["w:emu-lane"]);
  const deps = { ops, config: { guard: { memFreeMinPct: 10 } } as DoriConfig, registry: { open: async () => [openLane("emu-lane")] } };
  const detail = await guardAlertDetail(deps as never, { load1: 1, memFreePct: 50, diskFreeGb: 5, swapFreeGb: 4, swapTotalGb: 8, panes: 3 }, laneMemory(procs));
  expect(detail).toStartWith("lanes by memory: emu-lane 4.4 GB");
  expect(detail).not.toContain("warned");
  expect(sent(w)).toEqual([]);
});

test("a heaviest lane that is remote or closed is not swapped for a lighter one", async () => {
  const { w, ops } = lanesWorld(["w:small-lane"]);
  const lanes = laneMemory(procs);
  expect(await warnHeaviestLane(ops, lanes, [openLane("emu-lane", { machine: "mac" }), openLane("small-lane")], "memory free 4% < 10%")).toBe("not typed: heaviest lane emu-lane is not open here");
  expect(await warnHeaviestLane(ops, lanes, [openLane("small-lane")], "memory free 4% < 10%")).toBe("not typed: heaviest lane emu-lane is not open here");
  expect(await warnHeaviestLane(ops, [], [openLane("small-lane")], "memory free 4% < 10%")).toBe("no open local lane to warn");
  expect(sent(w)).toEqual([]);
});

test("a heaviest lane under 1 GB is not typed into", async () => {
  const { w, ops } = lanesWorld(["w:small-lane"]);
  const lanes = laneMemory(procs.filter((p) => p.lane !== "emu-lane" && p.pid < 10 || p.pid >= 20));
  expect(lanes[0]?.lane).toBe("small-lane");
  expect(await warnHeaviestLane(ops, lanes, [openLane("small-lane")], "memory free 4% < 10%")).toBe("not typed: heaviest lane small-lane is below 1.0 GB");
  expect(sent(w)).toEqual([]);
});

test("a lane warned in its pane is not warned again for 30 minutes", async () => {
  const { w, ops } = lanesWorld(["w:emu-lane"]);
  const lanes = laneMemory(procs);
  const open = [openLane("emu-lane")];
  const warnedAt = new Map<string, number>();
  let t = 1_000_000;
  const now = () => t;
  expect(await warnHeaviestLane(ops, lanes, open, "r", warnedAt, now)).toBe("warned emu-lane in its pane w:emu-lane");
  t += 5 * 60_000;
  expect(await warnHeaviestLane(ops, lanes, open, "r", warnedAt, now)).toBe("not typed: emu-lane was warned 5 min ago");
  expect(sent(w).length).toBe(1);
  t += WARN_COOLDOWN_MS;
  expect(await warnHeaviestLane(ops, lanes, open, "r", warnedAt, now)).toBe("warned emu-lane in its pane w:emu-lane");
  expect(sent(w).length).toBe(2);
});

test("a warning the runner refuses (the lane shows a question prompt) is reported as not typed", async () => {
  const { w, ops } = lanesWorld(["w:emu-lane"]);
  w.sendDelivery = "failed";
  const warnedAt = new Map<string, number>();
  expect(await warnHeaviestLane(ops, laneMemory(procs), [openLane("emu-lane")], "memory free 4% < 10%", warnedAt)).toBe("could not warn emu-lane in its pane w:emu-lane");
  expect(warnedAt.size).toBe(0);
});

test("memory turning low while already alerting for disk emits one more ALERT line", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 10, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 0 };
  const state = { alerting: false } as { alerting: boolean; memLow?: boolean };
  const sample = { load1: 1, memFreePct: 50, diskFreeGb: 5, swapFreeGb: 4, swapTotalGb: 8, panes: 3 };
  expect(guardTick(sample, t, state)).toEqual(expect.arrayContaining([expect.stringContaining("HOST_GUARD ALERT disk")]));
  expect(guardTick({ ...sample, memFreePct: 4 }, t, state, "warned x")).toEqual(["HOST_GUARD ALERT memory free 4% < 10% | disk free 5 GB < 50 GB; warned x"]);
  expect(guardTick({ ...sample, memFreePct: 4 }, t, state, "warned x")).toEqual([]);
});

test("low memory latches until free memory is 2 points above the threshold", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 10, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 0 };
  const state = { alerting: false } as { alerting: boolean; memLow?: boolean };
  const at = (memFreePct: number) => ({ load1: 1, memFreePct, diskFreeGb: 200, swapFreeGb: 4, swapTotalGb: 8, panes: 3 });
  guardTick(at(9), t, state);
  expect(state.memLow).toBe(true);
  guardTick(at(11), t, state);
  expect(state.memLow).toBe(true);
  guardTick(at(12), t, state);
  expect(state.memLow).toBe(false);
  guardTick(at(11), t, state);
  expect(state.memLow).toBe(false);
});

test("sampleHost reads Linux memory and swap from injected meminfo", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 2097152", err: "" };
  };
  const sample = await sampleHost(
    run,
    "/data",
    async () => 3,
    async (path) => {
      expect(path).toBe("/proc/meminfo");
      return "MemTotal:       8000000 kB\nMemAvailable:   2000000 kB\nSwapTotal:      4000000 kB\nSwapFree:       1048576 kB\n";
    },
  );

  expect(sample).toMatchObject({ memFreePct: 25, diskFreeGb: 2, swapFreeGb: 1, swapTotalGb: 4000000 / 1_048_576, panes: 3 });
  expect(calls).toEqual([["df", "-k", "/data"]]);
});

test("sampleHost reads macOS swap total from vm.swapusage, and -1 when it is unreadable", async () => {
  if (process.platform === "linux") return;
  const mk = (swap: string): Runner => async (argv) => ({ code: 0, out: argv[0] === "sysctl" ? swap : "Filesystem 1K-blocks Used Available\n/dev/x 1 1 2097152", err: "" });
  const ok = await sampleHost(mk("total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)"), "/", async () => 1);
  expect(ok).toMatchObject({ swapTotalGb: 2, swapFreeGb: 1 });
  expect((await sampleHost(mk(""), "/", async () => 1)).swapTotalGb).toBe(-1);
});

const crit = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 20 };

test("criticalReasons names low memory and low swap, and ignores unreadable metrics and hosts without swap", () => {
  expect(criticalReasons({ memFreePct: 3, swapFreeGb: 0.07, swapTotalGb: 4 }, crit))
    .toEqual(["memory free 3% < 5%", "swap free 0.07 GB of 4.0 GB (2%) < 5%"]);
  expect(criticalReasons({ memFreePct: 50, swapFreeGb: 2, swapTotalGb: 4 }, crit)).toEqual([]);
  expect(criticalReasons({ memFreePct: -1, swapFreeGb: -1, swapTotalGb: 4 }, crit)).toEqual([]);
  expect(criticalReasons({ memFreePct: 50, swapFreeGb: 0, swapTotalGb: -1 }, crit)).toEqual([]);
  expect(criticalReasons({ memFreePct: 50, swapFreeGb: 0, swapTotalGb: 0 }, crit)).toEqual([]);
});

test("sampleProcs merges the full command line by pid and procLanes attributes by nearest ancestor", async () => {
  const run: Runner = async (argv) => argv.at(-1) === "pid=,args="
    ? { code: 0, out: "  10 omo --lane x\n  11 qemu-system-x86_64 -m 4096\n", err: "" }
    : { code: 0, out: "  10 1 100 omo\n  11 10 200 qemu-system-x86\n  12 10 5 sleep\n", err: "" };
  const got = await sampleProcs(run, async (pid) => (pid === 10 ? "DORI_LANE_KEY=lane-x\0" : ""), true);
  expect(got.find((p) => p.pid === 11)?.args).toBe("qemu-system-x86_64 -m 4096");
  expect(got.find((p) => p.pid === 12)?.args).toBeUndefined();
  expect(procLanes(got).get(11)).toBe("lane-x");
});
