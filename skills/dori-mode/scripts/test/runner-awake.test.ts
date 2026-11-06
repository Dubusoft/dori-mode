import { expect, test } from "bun:test";
import { type AwakeChild, CAFFEINATE, holdAwake } from "../src/runner/awake.ts";

const fakeChild = () => {
  let exit: (code: number) => void = () => {};
  const child = { killed: 0, kill() { child.killed += 1; exit(143); }, exited: new Promise<number>((resolve) => { exit = resolve; }) };
  return { child, exit: (code: number) => exit(code) };
};

test("on darwin the runner holds an idle-sleep assertion tied to its pid until stopped, with nothing logged", async () => {
  const spawned: (readonly string[])[] = [];
  const logs: string[] = [];
  const { child } = fakeChild();
  const stop = holdAwake({ os: "darwin", pid: 4242, spawn: (argv) => { spawned.push(argv); return child as AwakeChild; }, log: (l) => logs.push(l) });
  expect(spawned).toEqual([[CAFFEINATE, "-i", "-w", "4242"]]);
  stop();
  await child.exited;
  await Bun.sleep(0);
  expect(child.killed).toBe(1);
  expect(logs).toEqual([]);
});

test("other platforms spawn nothing", () => {
  for (const os of ["linux", "win32"]) {
    const stop = holdAwake({ os, pid: 1, spawn: () => { throw new Error("must not spawn"); }, log: () => { throw new Error("must not log"); } });
    stop();
  }
});

test("a caffeinate that cannot start or exits on its own is logged and the runner carries on", async () => {
  const logs: string[] = [];
  holdAwake({ os: "darwin", pid: 1, spawn: () => { throw new Error("ENOENT"); }, log: (l) => logs.push(l) })();
  const { child, exit } = fakeChild();
  holdAwake({ os: "darwin", pid: 1, spawn: () => child as AwakeChild, log: (l) => logs.push(l) });
  exit(1);
  await child.exited;
  await Bun.sleep(0);
  expect(logs).toEqual(["RUNNER_AWAKE_FAILED ENOENT", "RUNNER_AWAKE_FAILED caffeinate exited code=1"]);
});
