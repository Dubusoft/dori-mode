import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Runner } from "../src/run.ts";
import { parseWinSample, runnerSampleArgv, sampleHost, sampleLoad1, type WinSample, winSampleSource } from "../src/host-guard.ts";
import { laneMemory, procLanes, sampleProcs, winProcs } from "../src/lane-memory.ts";

const T0 = Date.UTC(2026, 10, 7, 8, 0, 0);

/** Recorded runner-sample.ps1 output (a shell 500 in lane-a, its agent and a node child, an orphan whose ppid was reused). */
const RECORDED = "\uFEFF" + JSON.stringify({
  load1: 3.52, memFreePct: 23, swapFreeKb: 1_572_864, swapTotalKb: 4_194_304, diskFreeKb: 104_857_600,
  procs: [
    { pid: 0, ppid: 0, rss: 8, name: "System Idle Process", cmd: "", created: 0 },
    { pid: 4, ppid: 0, rss: 140, name: "System", cmd: "", created: T0 - 86_400_000 },
    { pid: 400, ppid: 4, rss: 20_000, name: "herdr.exe", cmd: "herdr.exe server", created: T0 - 3_600_000 },
    { pid: 500, ppid: 400, rss: 60_000, name: "pwsh.exe", cmd: "pwsh.exe -NoLogo", created: T0 - 600_000 },
    { pid: 510, ppid: 500, rss: 300_000, name: "omo.exe", cmd: "omo.exe --lane", created: T0 - 500_000 },
    { pid: 520, ppid: 510, rss: 1_200_000, name: "node.exe", cmd: "node.exe expo start", created: T0 - 400_000 },
    // Its parent 700 started after it: the pid was reused, so it is not this process's parent.
    { pid: 600, ppid: 700, rss: 900_000, name: "qemu system.exe", cmd: "qemu-system-x86_64.exe -m 4G", created: T0 - 300_000 },
    { pid: 700, ppid: 510, rss: 10_000, name: "cmd.exe", cmd: "cmd.exe /c build", created: T0 - 100_000 },
    { pid: "bad", ppid: 1, rss: 1, name: "x", cmd: "", created: T0 },
  ],
}) + "\r\n";

const seeds = new Map([[500, "lane-a"]]);

test("parseWinSample reads the recorded sampler JSON and drops malformed rows", () => {
  const s = parseWinSample(RECORDED) as WinSample;
  expect([s.load1, s.memFreePct, s.swapFreeKb, s.swapTotalKb, s.diskFreeKb]).toEqual([3.52, 23, 1_572_864, 4_194_304, 104_857_600]);
  expect(s.procs.map((p) => p.pid)).toEqual([0, 4, 400, 500, 510, 520, 600, 700]);
  expect(s.procs[4]).toEqual({ pid: 510, ppid: 500, rss: 300_000, name: "omo.exe", cmd: "omo.exe --lane", created: T0 - 500_000 });
  expect(parseWinSample("not json")).toBeUndefined();
  expect(parseWinSample("[1]")).toBeUndefined();
  expect(parseWinSample(JSON.stringify({ load1: -1, memFreePct: "x", procs: null }))).toEqual({ load1: -1, memFreePct: -1, swapFreeKb: -1, swapTotalKb: -1, diskFreeKb: -1, procs: [] });
});

test("sampleHost on win32 takes every metric from one sampler run, in GB", async () => {
  const seen: string[][] = [];
  const run: Runner = async (argv) => { seen.push([...argv]); return { code: 0, out: RECORDED, err: "" }; };
  const sample = await sampleHost(run, "D:\\work", async () => 4, async () => { throw new Error("no meminfo on Windows"); }, "win32",
    () => (async () => parseWinSample((await run(runnerSampleArgv("C:\\Users\\u\\.dori\\runner", "D:\\work"))).out))());
  expect(sample).toEqual({ load1: 3.52, memFreePct: 23, diskFreeGb: 100, swapFreeGb: 1.5, swapTotalGb: 4, panes: 4 });
  expect(seen).toEqual([["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\Users\\u\\.dori\\runner\\bin\\runner-sample.ps1", "D:\\work"]]);
});

test("sampleHost on win32 falls back like POSIX when the sampler fails", async () => {
  const run: Runner = async () => ({ code: 1, out: "", err: "Get-CimInstance failed" });
  expect(await sampleHost(run, "C:\\", async () => -1, undefined, "win32")).toEqual({ load1: -1, memFreePct: 100, diskFreeGb: 0, swapFreeGb: 0, swapTotalGb: -1, panes: -1 });
});

test("winProcs seeds the lane on the shell pid and procLanes carries it to descendants", () => {
  const procs = winProcs((parseWinSample(RECORDED) as WinSample).procs, seeds);
  const owner = procLanes(procs);
  expect([500, 510, 520, 700].map((pid) => owner.get(pid))).toEqual(["lane-a", "lane-a", "lane-a", "lane-a"]);
  expect([0, 4, 400].map((pid) => owner.get(pid))).toEqual([undefined, undefined, undefined]);
  expect(procs.find((p) => p.pid === 500)).toEqual({ pid: 500, ppid: 400, rssKb: 60_000, comm: "pwsh.exe", lane: "lane-a", args: "pwsh.exe -NoLogo" });
  expect(procs.find((p) => p.pid === 600)?.comm).toBe("qemu_system.exe");
  expect(laneMemory(procs).map((l) => [l.lane, l.rssKb])).toEqual([["lane-a", 1_570_000]]);
});

test("a parent link is kept only when the parent was created before the child", () => {
  const procs = winProcs((parseWinSample(RECORDED) as WinSample).procs, seeds);
  const orphan = procs.find((p) => p.pid === 600);
  expect(orphan?.ppid).toBe(0);
  expect(procLanes(procs).get(600)).toBeUndefined();
  const row = (pid: number, ppid: number, created: number) => ({ pid, ppid, rss: 1, name: "a.exe", cmd: "", created });
  const same = winProcs([row(1, 0, T0), row(2, 1, T0), row(3, 1, T0 + 1), row(4, 9, T0), row(5, 6, T0 + 5), row(6, 0, 0)], new Map());
  expect(same.map((p) => p.ppid)).toEqual([0, 0, 1, 0, 0, 0]);
  expect(winProcs([row(7, 7, T0)], new Map([[7, "bad key!"]]))).toEqual([{ pid: 7, ppid: 0, rssKb: 1, comm: "a.exe" }]);
});

test("sampleProcs on Windows reads the sampler and the lane shells; one spawn feeds the host and the processes", async () => {
  let spawns = 0;
  let now = T0;
  const run: Runner = async () => { spawns++; return { code: 0, out: RECORDED, err: "" }; };
  const source = winSampleSource(async () => parseWinSample((await run(["sampler"])).out), () => now);
  const procs = () => sampleProcs(run, async () => { throw new Error("no environ"); }, false, { sample: source.procs, seeds: () => seeds });
  const host = await sampleHost(run, "C:\\", async () => 1, undefined, "win32", source.host);
  expect(host.load1).toBe(3.52);
  const got = await procs();
  expect(spawns).toBe(1);
  expect(procLanes(got).get(520)).toBe("lane-a");
  now += 10_001;
  await procs();
  expect(spawns).toBe(2);
  const failing = winSampleSource(async () => undefined, () => now);
  expect(await sampleProcs(run, undefined, false, { sample: failing.procs, seeds: () => seeds })).toEqual([]);
  expect(await sampleProcs(run, undefined, false)).toEqual([]);
});

test("sampleLoad1 runs the sampler on win32 and reads loadavg elsewhere", async () => {
  const seen: string[][] = [];
  const run: Runner = async (argv) => { seen.push([...argv]); return { code: 0, out: RECORDED, err: "" }; };
  expect(await sampleLoad1("win32", run, "C:\\r", "C:\\data")).toBe(3.52);
  expect(seen[0]?.slice(-2)).toEqual(["C:\\r\\bin\\runner-sample.ps1", "C:\\data"]);
  expect(await sampleLoad1("win32", async () => ({ code: 1, out: "", err: "" }), "C:\\r")).toBe(-1);
  expect(typeof await sampleLoad1("linux", run, "/r")).toBe("number");
  expect(seen.length).toBe(1);
});

test("runner-sample.ps1 is ASCII with LF line endings", () => {
  const bytes = readFileSync(join(import.meta.dir, "..", "templates", "runner-sample.ps1"));
  expect(bytes.every((b) => b < 0x80)).toBe(true);
  expect(bytes.includes(0x0d)).toBe(false);
});
