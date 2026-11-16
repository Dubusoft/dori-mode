import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as quota from "../src/claude-quota.ts";
import { STARTUP_STEP_BUDGET_MS, StartupProbe } from "../src/startup-probe.ts";
import type { Http } from "../src/messenger/http.ts";
import { cliRunnerCall, cliSocketPath } from "../src/runner/cli-relay.ts";
import { defaultRunnerDir } from "../src/runner/fs-safety.ts";
import { localRunnerArgv } from "../src/runner/local-child.ts";
import { acquireSupervisor, supervise } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

type Spawn = (argv: readonly string[], env: Record<string, string>) => { readonly pid: number; readonly exited: Promise<number>; kill(sig: "SIGTERM" | "SIGKILL"): void };

/** The local runner child: one that runs nothing and exits when killed. */
const idleRunner: Spawn = () => {
  let exit = (_code: number) => {};
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  return { pid: 4242, exited, kill: () => { exit(0); } };
};

/** The real supervise() with fake herdr, Discord and gateway (as fixtures/startup-supervise.ts) and an injected local runner spawn. */
const superviseWith = (stateDir: string, probe: StartupProbe, signal: AbortSignal, notify: (state: string) => Promise<boolean>, spawnRunner: Spawn = idleRunner): Promise<void> => {
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const base = depsFor(world, fakeClock(1_800_000_000_000), stateDir, {
    discord: { applicationId: "100", guildId: "200", ownerId: "123456789012345" }, discordChannels: ["11"], defaultModel: "test/model",
  });
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => argv[0] === "df"
      ? { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200", err: "" }
      : base.run(argv),
  };
  const http: Http = async (request) => ({ status: 200, headers: {}, body: request.url.endsWith("/threads/active") ? JSON.stringify({ threads: [] }) : "[]" });
  return supervise(deps, signal, {
    token: `startup-test-${stateDir}`, gatewayLockDir: `${stateDir}/gateway-locks`, http, lookup: async () => "", statusLookup: async () => "",
    open: () => {
      let closed = (_code: number) => {};
      return {
        send: () => {}, close: () => { closed(1000); },
        onMessage: () => {}, onError: () => {}, onClose: (callback) => { closed = callback; },
      };
    },
    timers: { setInterval: () => 0, clearInterval: () => {} },
    spawnRunner,
  }, notify, probe);
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const FIXTURE = join(import.meta.dir, "fixtures/startup-supervise.ts");
const unitValue = (key: string): string | undefined =>
  readFileSync(join(import.meta.dir, "../templates/dori-supervisor.service"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];
const steps = (line: string | undefined): string[] => (line ?? "").split(" ").slice(3).map((part) => part.split("=")[0] ?? "");

test("an injected 10 min synchronous stall in a named startup step logs STARTUP_SLOW <that step> while blocked, before READY=1", async () => {
  // Given the real supervise() whose "supervisor" step (journal load) blocks the main thread for 10 minutes.
  const state = withState();
  cleanups.push(state.done);
  const child = Bun.spawn([process.execPath, FIXTURE, state.dir, "supervisor", "200"], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: state.dir },
  });
  // When its stderr is read until the watcher names the step (bounded, in case it never does).
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let err = "";
  try {
    while (!/STARTUP_SLOW supervisor .*\n/.test(err)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      err += decoder.decode(chunk.value, { stream: true });
    }
  } finally { clearTimeout(deadline); }
  // The process is still stuck in the step; systemd's TimeoutStartFailureMode=kill does this at TimeoutStartSec.
  const stillRunning = child.exitCode === null;
  child.kill("SIGKILL");
  await child.exited;
  const out = await new Response(child.stdout).text();
  // Then only that step was reported slow, while it still ran, and systemd was never told READY=1.
  expect(stillRunning).toBe(true);
  expect([...err.matchAll(/^STARTUP_SLOW (\S+) still running after \d+s \(budget 0s\)$/gm)].map((m) => m[1])).toEqual(["supervisor"]);
  expect(out).not.toContain("READY=1");
}, 20_000);

test("a start that hangs is killed and restarted within TimeoutStartSec + 60 s, and its slow step is logged before the kill", () => {
  // Given the shipped unit's deadlines.
  const startSec = Number(unitValue("TimeoutStartSec"));
  // Then a hung start is SIGKILLed at TimeoutStartSec (no extra TimeoutStopSec, the blocked process cannot handle SIGTERM),
  // and restarted RestartSec later; the per-step budget fires well before the kill.
  expect(startSec).toBe(300);
  expect(unitValue("TimeoutStartFailureMode")).toBe("kill");
  expect(unitValue("Restart")).toBe("always");
  expect(startSec + Number(unitValue("RestartSec"))).toBeLessThanOrEqual(startSec + 60);
  expect(STARTUP_STEP_BUDGET_MS).toBeLessThan(startSec * 1_000);
  // The runtime deadline stays separate: WatchdogSec applies only after READY=1.
  expect(unitValue("WatchdogSec")).toBe("300");
});

/** The first-pass timing line of each supervisor task (the sweeps report theirs as first-sweep). */
const FIRSTS = ["first-autopilot", "first-delivery", "first-inbound", "first-polling", "first-runners", "first-sweep"];

test("a normal start logs one STARTUP_TIMINGS line for the steps up to READY=1 and one for each task's first pass", async () => {
  // Given the real supervise() on fakes, stopped as soon as every task has reported its first pass.
  const state = withState();
  cleanups.push(state.done);
  const home = process.env.HOME;
  const socket = process.env.NOTIFY_SOCKET;
  process.env.HOME = state.dir;
  delete process.env.NOTIFY_SOCKET;
  cleanups.push(() => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (socket === undefined) delete process.env.NOTIFY_SOCKET; else process.env.NOTIFY_SOCKET = socket;
  });
  spyOn(quota, "lookupQuotaResults").mockReturnValue(async () => ({ results: [], text: "" }));
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response("[]", { status: 404 }), { preconnect: fetch.preconnect }));
  const controller = new AbortController();
  const lines: string[] = [];
  const probe = new StartupProbe(STARTUP_STEP_BUDGET_MS, (line) => {
    lines.push(line);
    if (FIRSTS.every((name) => lines.some((l) => l.startsWith(`STARTUP_TIMINGS ${name} `)))) controller.abort();
  });
  const notified: string[] = [];
  // When it starts and runs one pass.
  await superviseWith(state.dir, probe, controller.signal, async (s) => { notified.push(s); return true; });
  // Then each named step is timed in order, READY=1 was sent and nothing was slow. The tasks run side by side, so their
  // first-pass lines land in any order after ready.
  const label = (name: string) => lines.find((line) => line.startsWith(`STARTUP_TIMINGS ${name} `));
  expect(lines.map((line) => line.split(" ")[1]).sort()).toEqual([...FIRSTS, "ready"].sort());
  expect(lines[0]?.startsWith("STARTUP_TIMINGS ready ")).toBe(true);
  expect(steps(label("ready"))).toEqual(["lock", "gateway-lock", "supervisor", "schedules", "waits", "github", "ci-follow", "inbound", "lane-reports", "runners", "ready"]);
  for (const task of ["inbound", "delivery", "polling", "runners"]) expect(steps(label(`first-${task}`))).toEqual([`task:${task}`]);
  expect(steps(label("first-sweep"))).toEqual([
    "loop:sweep:snapshot", "loop:sweep:watch", "loop:sweep:guard", "loop:sweep:dead-panes", "loop:sweep:recover", "loop:sweep:freshness",
    "loop:sweep:drift", "loop:sweep:memory", "loop:sweep:auto-update", "loop:sweep:machine-guard",
  ]);
  expect(lines.every((line) => /^STARTUP_TIMINGS \S+ \d+ms( \S+=\d+ms)+$/.test(line))).toBe(true);
  expect(notified[0]).toBe("READY=1");
  expect(probe.active).toBe(false);
});

test("a startup that fails still logs how far it got", async () => {
  // Given a second supervisor on a state directory whose lock is already held.
  const state = withState();
  cleanups.push(state.done);
  const lines: string[] = [];
  const held = acquireSupervisor(state.dir);
  cleanups.push(held);
  // When it starts.
  const started = superviseWith(state.dir, new StartupProbe(STARTUP_STEP_BUDGET_MS, (line) => { lines.push(line); }), new AbortController().signal, async () => true);
  // Then it fails at the lock and reports an incomplete startup with that step timed.
  await expect(started).rejects.toThrow("cannot acquire supervisor lock");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^STARTUP_TIMINGS startup-incomplete \d+ms lock=\d+ms$/);
});

test("supervise starts the local runner child before SUPERVISOR_READY and serves the CLI relay next to the control socket", async () => {
  // Given the real supervise() on fakes, with HOME (so the runner directory) in a temp dir and a recording runner spawn.
  const state = withState();
  cleanups.push(state.done);
  const home = process.env.HOME;
  const socket = process.env.NOTIFY_SOCKET;
  process.env.HOME = state.dir;
  process.env.DORI_LANE_KEY = "a-lane";
  delete process.env.NOTIFY_SOCKET;
  cleanups.push(() => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (socket === undefined) delete process.env.NOTIFY_SOCKET; else process.env.NOTIFY_SOCKET = socket;
    delete process.env.DORI_LANE_KEY;
  });
  spyOn(quota, "lookupQuotaResults").mockReturnValue(async () => ({ results: [], text: "" }));
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response("[]", { status: 404 }), { preconnect: fetch.preconnect }));
  const logged: string[] = [];
  spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  const relay = cliSocketPath(defaultRunnerDir(state.dir));
  const spawned: { argv: readonly string[]; env: Record<string, string>; readyBefore: boolean; relayUp: boolean }[] = [];
  let relayAnswer: Promise<boolean> | undefined;
  let killed: string | undefined;
  const controller = new AbortController();
  const spawn: Spawn = (argv, env) => {
    spawned.push({ argv, env, readyBefore: logged.some((l) => l.startsWith("SUPERVISOR_READY")), relayUp: existsSync(relay) });
    // The relay answers a CLI request; the supervisor stops once it has.
    relayAnswer = cliRunnerCall(relay).refresh("local").finally(() => { controller.abort(); });
    let exit = (_code: number) => {};
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    return { pid: 4242, exited, kill: (sig) => { killed = sig; exit(0); } };
  };
  // When it starts.
  await superviseWith(state.dir, new StartupProbe(STARTUP_STEP_BUDGET_MS, () => {}), controller.signal, async () => true, spawn);
  // Then the child was spawned once, through the injected spawn, before READY, with the lane-mode variables removed,
  // the relay was up by then and answered (no runner connected), and the child was stopped with the supervisor.
  expect(spawned).toHaveLength(1);
  expect(spawned[0]?.argv).toEqual(localRunnerArgv(join(import.meta.dir, "..", "src", "cli.ts")));
  expect(spawned[0]?.readyBefore).toBe(false);
  expect(spawned[0]?.relayUp).toBe(true);
  expect(spawned[0]?.env.DORI_LANE_KEY).toBeUndefined();
  expect(spawned[0]?.env.HOME).toBe(state.dir);
  expect(await relayAnswer).toBe(false);
  expect(logged.some((l) => l.startsWith("SUPERVISOR_READY"))).toBe(true);
  expect(logged).toContain("RUNNER_LOCAL_STARTED pid=4242");
  expect(killed).toBe("SIGTERM");
});
