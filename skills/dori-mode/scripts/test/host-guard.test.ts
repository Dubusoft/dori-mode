import { expect, test } from "bun:test";

import type { Runner } from "../src/run.ts";
import { guardTick, sampleHost } from "../src/host-guard.ts";
import { laneMemory, type Proc, sampleProcs } from "../src/lane-memory.ts";
import { guardAlertDetail, warnHeaviestLane } from "../src/supervise-loop.ts";
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
  const run: Runner = async () => ({ code: 0, out: "  10     1 1024 omo\n  11    10 2048 node\n  12    11 512 bad$(name\n", err: "" });
  const env = async (pid: number) => {
    if (pid === 12) throw new Error("EACCES");
    return pid === 10 ? "HOME=/x\0DORI_LANE_KEY=a-lane\0" : "HOME=/x\0";
  };
  expect(await sampleProcs(run, env, true)).toEqual([
    { pid: 10, ppid: 1, rssKb: 1024, comm: "omo", lane: "a-lane" },
    { pid: 11, ppid: 10, rssKb: 2048, comm: "node" },
    { pid: 12, ppid: 11, rssKb: 512, comm: "bad__name" },
  ]);
  expect(await sampleProcs(run, env, false)).toEqual([]);
});

const openLane = (key: string, extra: Partial<Lane> = {}): Lane => ({ key, title: key, thread: "t", brief: "b", done: "d", openedAt: "x", pane: `w:${key}`, ...extra });

const herdr = (agentPanes: string[]) => {
  const sent: string[][] = [];
  const run: Runner = async (argv) => {
    if (argv[1] === "pane" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: agentPanes.map((p) => ({ pane_id: p, workspace_id: "w", agent: "omo", agent_status: "working" })) } }), err: "" };
    sent.push([...argv]);
    return { code: 0, out: "", err: "" };
  };
  return { run, sent };
};

test("on a memory alert the heaviest open local lane is warned in its pane and the ALERT says so", async () => {
  const { run, sent } = herdr(["w:emu-lane", "w:small-lane"]);
  const deps = { run, config: { guard: { memFreeMinPct: 10 } } as DoriConfig, registry: { open: async () => [openLane("emu-lane"), openLane("small-lane")] } };
  const sample = { load1: 1, memFreePct: 4, diskFreeGb: 200, swapFreeGb: 0.1, panes: 3 };
  const detail = await guardAlertDetail(deps as never, sample, async () => procs);
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 10, diskFreeMinGb: 50, panesMax: 0 };
  const [alert] = guardTick(sample, t, { alerting: false }, detail);
  expect(alert).toBe("HOST_GUARD ALERT memory free 4% < 10%; lanes by memory: emu-lane 4.4 GB (qemu-system-x86 3.8 GB, node x2 488 MB, omo 98 MB), "
    + "small-lane 264 MB (omo 146 MB, adb 68 MB, tsserver 49 MB); warned emu-lane in its pane w:emu-lane");
  expect(sent[0]?.slice(0, 4)).toEqual(["herdr", "pane", "send-text", "w:emu-lane"]);
  expect(sent[0]?.[4]).toStartWith("[System] HOST_GUARD memory warning: memory free 4% < 10% on this host, and this lane (emu-lane) uses the most memory: emu-lane 4.4 GB");
  expect(sent[1]).toEqual(["herdr", "pane", "send-keys", "w:emu-lane", "enter"]);
});

test("a disk-only alert lists the lanes but warns nobody", async () => {
  const { run, sent } = herdr(["w:emu-lane"]);
  const deps = { run, config: { guard: { memFreeMinPct: 10 } } as DoriConfig, registry: { open: async () => [openLane("emu-lane")] } };
  const detail = await guardAlertDetail(deps as never, { load1: 1, memFreePct: 50, diskFreeGb: 5, swapFreeGb: 4, panes: 3 }, async () => procs);
  expect(detail).toStartWith("lanes by memory: emu-lane 4.4 GB");
  expect(detail).not.toContain("warned");
  expect(sent).toEqual([]);
});

test("a remote or closed heaviest lane is skipped for the next open local one", async () => {
  const { run, sent } = herdr(["w:small-lane"]);
  const lanes = laneMemory(procs);
  expect(await warnHeaviestLane(run, lanes, [openLane("emu-lane", { machine: "mac" }), openLane("small-lane")], "memory free 4% < 10%")).toBe("warned small-lane in its pane w:small-lane");
  expect(sent[0]?.[3]).toBe("w:small-lane");
  expect(await warnHeaviestLane(run, lanes, [], "memory free 4% < 10%")).toBe("no open local lane to warn");
});

test("a lane on a question prompt is not typed into", async () => {
  const { run, sent } = herdr(["w:emu-lane"]);
  const lanes = laneMemory(procs);
  expect(await warnHeaviestLane(run, lanes, [openLane("emu-lane", { lastAskPrompt: "Which one?" } as Partial<Lane>)], "memory free 4% < 10%")).toBe("not typed: emu-lane is on a question prompt");
  expect(sent).toEqual([]);
});

test("memory turning low while already alerting for disk emits one more ALERT line", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 10, diskFreeMinGb: 50, panesMax: 0 };
  const state = { alerting: false } as { alerting: boolean; memLow?: boolean };
  const sample = { load1: 1, memFreePct: 50, diskFreeGb: 5, swapFreeGb: 4, panes: 3 };
  expect(guardTick(sample, t, state)).toEqual(expect.arrayContaining([expect.stringContaining("HOST_GUARD ALERT disk")]));
  expect(guardTick({ ...sample, memFreePct: 4 }, t, state, "warned x")).toEqual(["HOST_GUARD ALERT memory free 4% < 10% | disk free 5 GB < 50 GB; warned x"]);
  expect(guardTick({ ...sample, memFreePct: 4 }, t, state, "warned x")).toEqual([]);
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

  expect(sample).toMatchObject({ memFreePct: 25, diskFreeGb: 2, swapFreeGb: 1, panes: 3 });
  expect(calls).toEqual([["df", "-k", "/data"]]);
});
