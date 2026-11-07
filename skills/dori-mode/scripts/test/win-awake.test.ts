import { expect, test } from "bun:test";

import { ES_CONTINUOUS, ES_SYSTEM_REQUIRED, holdAwake } from "../src/runner/awake.ts";

const noSpawn = () => { throw new Error("must not spawn"); };

test("on win32 the runner holds ES_CONTINUOUS|ES_SYSTEM_REQUIRED and clears it on stop, spawning nothing", () => {
  const flags: number[] = [];
  const logs: string[] = [];
  const stop = holdAwake({ os: "win32", pid: 1, spawn: noSpawn, log: (l) => logs.push(l), executionState: (f) => { flags.push(f); return ES_CONTINUOUS; } });
  expect(flags).toEqual([0x80000001]);
  expect(ES_CONTINUOUS + ES_SYSTEM_REQUIRED).toBe(0x80000001);
  stop();
  expect(flags).toEqual([0x80000001, 0x80000000]);
  expect(logs).toEqual([]);
});

test("a win32 execution state that fails or cannot load is logged and the runner carries on", () => {
  const logs: string[] = [];
  const calls: number[] = [];
  holdAwake({ os: "win32", pid: 1, spawn: noSpawn, log: (l) => logs.push(l), executionState: (f) => { calls.push(f); return 0; } })();
  holdAwake({ os: "win32", pid: 1, spawn: noSpawn, log: (l) => logs.push(l), executionState: () => { throw new Error("kernel32.dll not found"); } })();
  expect(calls).toEqual([0x80000001]);
  expect(logs).toEqual(["RUNNER_AWAKE_FAILED SetThreadExecutionState returned 0", "RUNNER_AWAKE_FAILED kernel32.dll not found"]);
});

test("execution state is only used on win32", () => {
  for (const os of ["linux", "freebsd"]) {
    holdAwake({ os, pid: 1, spawn: noSpawn, log: () => { throw new Error("must not log"); }, executionState: () => { throw new Error("must not call"); } })();
  }
});
