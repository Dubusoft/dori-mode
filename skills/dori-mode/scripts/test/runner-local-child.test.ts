import { expect, test } from "bun:test";
import { childEnv, type ChildProcess, LOCAL_STOP_GRACE_MS, spawnProcess, startLocalRunner } from "../src/runner/local-child.ts";

/** A clock whose sleeps wait for the test: each is parked with its length until `release`. */
const manualClock = () => {
  let at = 0;
  const parked: { ms: number; resolve: () => void }[] = [];
  return {
    now: () => at,
    sleep: (ms: number) => new Promise<void>((resolve) => { parked.push({ ms, resolve }); }),
    parked: () => parked.map((p) => p.ms),
    advance: (ms: number) => { at += ms; },
    /** Resolves the parked sleep of length `ms` (the first one). */
    release: (ms: number) => {
      const i = parked.findIndex((p) => p.ms === ms);
      if (i < 0) throw new Error(`no parked sleep of ${ms}ms (parked: ${parked.map((p) => p.ms).join(",")})`);
      const [p] = parked.splice(i, 1);
      p?.resolve();
    },
  };
};

/** Lets every pending promise reaction run (no timers involved). */
const settle = async (): Promise<void> => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

type FakeChild = ChildProcess & { readonly signals: string[]; exit: (code: number) => void };
const world = (opts: { readonly ignoreTerm?: boolean } = {}) => {
  const children: FakeChild[] = [];
  const envs: Record<string, string>[] = [];
  const spawn = (_argv: readonly string[], env: Record<string, string>): ChildProcess => {
    envs.push(env);
    let exit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    const signals: string[] = [];
    const child: FakeChild = {
      pid: 100 + children.length, exited, signals, exit: (code) => { exit(code); },
      kill: (sig) => { signals.push(sig); if (sig === "SIGKILL" || !opts.ignoreTerm) exit(sig === "SIGKILL" ? 137 : 143); },
    };
    children.push(child);
    return child;
  };
  return { children, envs, spawn };
};

test("the child restarts after each exit with backoff from the clock, and is killed on abort", async () => {
  const clock = manualClock();
  const w = world();
  const logs: string[] = [];
  const controller = new AbortController();
  const child = startLocalRunner({
    spawn: w.spawn, argv: ["bun", "cli.ts", "runner", "serve"], env: { PATH: "/bin", DORI_LANE_KEY: "lane-x", HERDR_PANE_ID: "p3" },
    clock, log: (l) => { logs.push(l); }, random: () => 0.5,
  }, controller.signal);
  expect(w.children).toHaveLength(1);
  expect(w.envs[0]).toEqual({ PATH: "/bin" });
  expect(child.pid()).toBe(100);

  w.children[0]?.exit(1);
  await settle();
  expect(child.pid()).toBeUndefined();
  expect(clock.parked()).toEqual([1_000]);
  clock.release(1_000);
  await settle();
  expect(w.children).toHaveLength(2);

  w.children[1]?.exit(1);
  await settle();
  expect(clock.parked()).toEqual([2_000]);
  clock.release(2_000);
  await settle();
  expect(w.children).toHaveLength(3);

  // A child that stayed up a minute restarts from the first step again.
  clock.advance(60_000);
  w.children[2]?.exit(0);
  await settle();
  expect(clock.parked()).toEqual([1_000]);
  clock.release(1_000);
  await settle();
  expect(w.children).toHaveLength(4);

  controller.abort();
  await settle();
  expect(w.children[3]?.signals).toEqual(["SIGTERM"]);
  await child.stop();
  expect(w.children).toHaveLength(4);
  expect(child.pid()).toBeUndefined();
  expect(logs).toEqual([
    "RUNNER_LOCAL_STARTED pid=100", "RUNNER_LOCAL_EXITED pid=100 code=1", "RUNNER_LOCAL_RESTART in=1000ms attempt=1",
    "RUNNER_LOCAL_STARTED pid=101", "RUNNER_LOCAL_EXITED pid=101 code=1", "RUNNER_LOCAL_RESTART in=2000ms attempt=2",
    "RUNNER_LOCAL_STARTED pid=102", "RUNNER_LOCAL_EXITED pid=102 code=0", "RUNNER_LOCAL_RESTART in=1000ms attempt=1",
    "RUNNER_LOCAL_STARTED pid=103", "RUNNER_LOCAL_EXITED pid=103 code=143",
  ]);
});

test("stop sends SIGKILL when the child ignores SIGTERM past the grace period", async () => {
  const clock = manualClock();
  const w = world({ ignoreTerm: true });
  const child = startLocalRunner({ spawn: w.spawn, argv: ["x"], env: {}, clock, log: () => {}, random: () => 0.5 }, new AbortController().signal);
  const stopped = child.stop();
  await settle();
  expect(w.children[0]?.signals).toEqual(["SIGTERM"]);
  expect(clock.parked()).toEqual([LOCAL_STOP_GRACE_MS]);
  clock.release(LOCAL_STOP_GRACE_MS);
  await stopped;
  expect(w.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(w.children).toHaveLength(1);
});

test("restart stops the running child and spawns the next one without a backoff step", async () => {
  const clock = manualClock();
  const w = world();
  const logs: string[] = [];
  const controller = new AbortController();
  const child = startLocalRunner({ spawn: w.spawn, argv: ["x"], env: {}, clock, log: (l) => { logs.push(l); }, random: () => 0.5 }, controller.signal);
  await child.restart();
  expect(w.children).toHaveLength(2);
  expect(w.children[0]?.signals).toEqual(["SIGTERM"]);
  expect(child.pid()).toBe(101);
  expect(logs).toContain("RUNNER_LOCAL_RESTART requested");
  expect(logs.some((l) => l.includes("in="))).toBe(false);
  controller.abort();
  await child.stop();
  expect(w.children).toHaveLength(2);
});

test("an already aborted signal spawns nothing; a spawn that throws is retried after the backoff", async () => {
  const clock = manualClock();
  const aborted = new AbortController();
  aborted.abort();
  const w = world();
  startLocalRunner({ spawn: w.spawn, argv: ["x"], env: {}, clock, log: () => {} }, aborted.signal);
  expect(w.children).toHaveLength(0);

  let fails = 1;
  const logs: string[] = [];
  const controller = new AbortController();
  const child = startLocalRunner({
    spawn: (argv, env) => { if (fails-- > 0) throw new Error("ENOENT bun"); return w.spawn(argv, env); },
    argv: ["x"], env: {}, clock, log: (l) => { logs.push(l); }, random: () => 0.5,
  }, controller.signal);
  expect(logs).toEqual(["RUNNER_LOCAL_SPAWN_FAILED ENOENT bun", "RUNNER_LOCAL_RESTART in=1000ms attempt=1"]);
  clock.release(1_000);
  await settle();
  expect(w.children).toHaveLength(1);
  controller.abort();
  await child.stop();
});

test("childEnv drops the lane-mode variables; spawnProcess runs a real process and reports its exit code", async () => {
  expect(childEnv({ A: "1", DORI_LANE_KEY: "k", HERDR_PANE_ID: "p" })).toEqual({ A: "1" });
  const proc = spawnProcess(["/bin/sh", "-c", "exit 3"], { PATH: process.env.PATH ?? "/bin" });
  expect(await proc.exited).toBe(3);
});
