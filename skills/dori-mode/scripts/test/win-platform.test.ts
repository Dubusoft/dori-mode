import { expect, test } from "bun:test";

import { procLanes, type Proc } from "../src/lane-memory.ts";
import { killProcs } from "../src/pressure.ts";
import type { Clock } from "../src/run.ts";
import { selectPlatform, type SyncRan } from "../src/runner/platform.ts";

const NOT_FOUND: SyncRan = { code: 128, out: "", err: "ERROR: The process \"77\" not found." };
const REFUSED: SyncRan = { code: 1, out: "", err: "ERROR: The process with PID 11 could not be terminated. Reason: This process can only be terminated forcefully (with /F option)." };

const recorder = (answer: (argv: readonly string[]) => SyncRan = () => ({ code: 0, out: "SUCCESS", err: "" })) => {
  const calls: string[] = [];
  return { calls, run: (argv: readonly string[]) => { calls.push(argv.join(" ")); return answer(argv); } };
};

test("win32 selects the Windows adapters and every other platform keeps the POSIX ones", () => {
  const r = recorder();
  const win = selectPlatform("win32", { run: r.run });
  expect(win.os).toBe("win32");
  win.signal(5, "SIGTERM");
  expect(r.calls).toEqual(["taskkill /PID 5 /T"]);
  for (const os of ["linux", "darwin"]) {
    const posix = selectPlatform(os, { run: () => { throw new Error("POSIX must not run taskkill"); } });
    expect(posix.os).toBe(os);
    // A pid that cannot exist: process.kill answers ESRCH, which the POSIX adapter passes through.
    expect(() => posix.signal(2 ** 30, "SIGTERM")).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }
  expect(selectPlatform().os).toBe(process.platform);
});

test("SIGTERM is taskkill /T without /F, SIGKILL and killTree add /F", () => {
  const r = recorder();
  const win = selectPlatform("win32", { run: r.run });
  win.signal(11, "SIGTERM");
  win.signal(11, "SIGKILL");
  win.killTree(12);
  expect(r.calls).toEqual(["taskkill /PID 11 /T", "taskkill /PID 11 /T /F", "taskkill /PID 12 /T /F"]);
});

test("taskkill not found is an ESRCH error for every adapter", () => {
  const win = selectPlatform("win32", { run: () => NOT_FOUND });
  for (const call of [() => win.signal(77, "SIGTERM"), () => win.signal(77, "SIGKILL"), () => win.killTree(77)]) {
    expect(call).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }
});

test("a refused SIGTERM is logged, not thrown; a failed forced kill is thrown", () => {
  const logs: string[] = [];
  const win = selectPlatform("win32", { run: () => REFUSED, log: (l) => logs.push(l) });
  win.signal(11, "SIGTERM");
  expect(logs).toEqual([`RUNNER_SIGTERM_REFUSED pid=11 code=1 ${REFUSED.err}`]);
  expect(() => win.signal(11, "SIGKILL")).toThrow("taskkill /T /F of pid 11 failed with code 1");
  expect(() => win.killTree(11)).toThrow("taskkill /T /F of pid 11 failed with code 1");
});

test("pressure killProcs sends TERM then KILL through taskkill and treats not found as gone", async () => {
  const procs: Proc[] = [
    { pid: 10, ppid: 1, rssKb: 100_000, comm: "pwsh.exe", lane: "dori-12", args: "pwsh -NoLogo" },
    { pid: 11, ppid: 10, rssKb: 4_000_000, comm: "qemu.exe", args: "qemu-system-x86_64 -m 4096" },
    { pid: 12, ppid: 10, rssKb: 500_000, comm: "node.exe", args: "node expo export" },
    { pid: 13, ppid: 10, rssKb: 400_000, comm: "node.exe", args: "node expo export --gone" },
  ];
  const events: string[] = [];
  const clock: Clock = { now: () => 0, sleep: async (ms) => { events.push(`sleep ${ms}`); } };
  const r = recorder((argv) => {
    if (argv[2] === "13") return NOT_FOUND;
    if (argv[2] === "11" && argv.length === 4) return REFUSED;
    return { code: 0, out: "SUCCESS", err: "" };
  });
  const logs: string[] = [];
  const win = selectPlatform("win32", { run: (argv) => { events.push(argv.join(" ")); return r.run(argv); }, log: (l) => logs.push(l) });
  const stubborn = new Set([11]);
  const killed = await killProcs(procs.slice(1), { clock, alive: (pid) => stubborn.has(pid), signal: win.signal }, procLanes(procs));
  expect(events).toEqual([
    "taskkill /PID 11 /T", "taskkill /PID 12 /T", "taskkill /PID 13 /T", "sleep 5000", "taskkill /PID 11 /T /F",
  ]);
  expect(killed.map((k) => [k.pid, k.lane])).toEqual([[11, "dori-12"], [12, "dori-12"]]);
  expect(logs).toEqual([`RUNNER_SIGTERM_REFUSED pid=11 code=1 ${REFUSED.err}`]);
});

test("the Windows holdAwake uses the injected execution state", () => {
  const flags: number[] = [];
  const win = selectPlatform("win32", { run: () => NOT_FOUND, executionState: (f) => { flags.push(f); return 1; } });
  win.holdAwake({ pid: 1, log: () => { throw new Error("must not log"); } })();
  expect(flags).toEqual([0x80000001, 0x80000000]);
});
