import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig, type PlacementConfig } from "../src/config.ts";
import { eventKind } from "../src/event-policy.ts";
import { type MachineCheck, planLaunch } from "../src/placement.ts";
import { enqueueLaunch, launchHeld, launchQueue, type QueuedLaunch, recordLaunchVerdict } from "../src/routing.ts";
import type { Runner } from "../src/run.ts";
import { Supervisor } from "../src/supervise.ts";
import { runSweeps, supervisorSweeps } from "../src/supervise-loop.ts";
import { RunnerGuardBoard } from "../src/runner/guard.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState } from "./fakes.ts";
import { enrollRunners, runnerSample } from "./runner-guard-world.ts";

// The CLI cases spawn `bun src/cli.ts`; process startup under a loaded full run outgrows bun's default 5 s.
setDefaultTimeout(30_000);

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = 1_800_000_000_000;
const ok = (out = "") => ({ code: 0, out, err: "" });
const held = (key: string, machine?: string): QueuedLaunch => ({
  key, title: key, done: "merged acme/app#1", brief: `/b/${key}.md`, queuedAt: new Date(T0).toISOString(), reasons: ["full"], ...(machine ? { machine } : {}),
});

/** Supervisor sweeps over three machines with runners: big and spare have room, mini is short of memory; each has one pane. */
const machineWorld = () => {
  const state = withState();
  cleanups.push(state.done);
  const world = newWorld();
  const clock = fakeClock(T0);
  const base = depsFor(world, clock, state.dir, { guardMachines: { big: "u@big", mini: "u@mini", spare: "u@spare" } });
  const run: Runner = async (argv) => {
    if (argv[0] === "df") return ok("Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200");
    return base.run(argv);
  };
  enrollRunners(state.dir, "big", "mini", "spare");
  const board = new RunnerGuardBoard(clock.now);
  for (const [label, memFreePct] of [["big", 60], ["mini", 5], ["spare", 60]] as const) {
    board.event(label, runnerSample({ load1: 1, memFreePct, diskFreeGb: 200, swapFreeGb: 4 }, T0, label));
  }
  // Each machine's runner lists one pane.
  const ops = { ...base.ops, panes: async (machine?: string) => [{ pane_id: `${machine ?? "local"}:p1`, workspace_id: "w" }] };
  const deps = { ...base, run, ops };
  const queue: string[] = [];
  const sweeps = supervisorSweeps(deps, "/home/test", undefined, undefined, undefined, () => board);
  const tick = () => runSweeps(sweeps, async (line) => { queue.push(line); }, clock.now, new Map(), () => {});
  return { deps, state, queue, tick };
};

test("the machine-guard sweep emits LAUNCH_READY machine=<label> only for a held remote machine with room, then clears its flag", async () => {
  const w = machineWorld();
  enqueueLaunch(w.state.dir, held("big-lane", "big"));
  recordLaunchVerdict(w.state.dir, { ok: false, reasons: ["memory free 5% < 20%"] }, T0, "mini");
  await w.tick();
  const ready = w.queue.filter((line) => line.startsWith("LAUNCH_READY"));
  expect(ready).toEqual(["LAUNCH_READY machine=big the machine has room again (memory free 60%, disk free 200 GB, panes 1); start the held work after dori can-launch --machine big"]);
  expect(launchHeld(w.state.dir, "big")).toBe(false);
  expect(launchHeld(w.state.dir, "mini")).toBe(true);
  expect(launchHeld(w.state.dir)).toBe(false);
  await w.tick();
  expect(w.queue.filter((line) => line.startsWith("LAUNCH_READY"))).toHaveLength(1);
  expect(eventKind(ready[0] ?? "")).toBe("LAUNCH_READY");
});

test("a LAUNCH_READY event lists only its own machine's queued launches", () => {
  const state = withState();
  cleanups.push(state.done);
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  const supervisor = new Supervisor(deps);
  cleanups.push(() => supervisor.close());
  enqueueLaunch(state.dir, held("local-lane"));
  enqueueLaunch(state.dir, held("big-lane", "big"));
  enqueueLaunch(state.dir, held("mini-lane", "mini"));
  supervisor.enqueue("ready:big", "LAUNCH_READY machine=big the machine has room again");
  supervisor.enqueue("ready:local", "LAUNCH_READY the host has room again");
  const lines: string[] = readJournal(state.dir).events.map((e: { line: string }) => e.line);
  const big = lines.find((l) => l.startsWith("LAUNCH_READY machine=big")) ?? "";
  const local = lines.find((l) => l.startsWith("LAUNCH_READY the host")) ?? "";
  expect(big).toContain("queued launches (1): big-lane");
  expect(big).not.toContain("local-lane");
  expect(big).not.toContain("mini-lane");
  expect(local).toContain("queued launches (1): local-lane");
  expect(local).not.toContain("big-lane");
  expect(launchQueue(state.dir)).toHaveLength(3);
});

const checks = (verdicts: Record<string, string[]>) => {
  const asked: string[] = [];
  const check = async (machine: string): Promise<MachineCheck> => {
    asked.push(machine);
    const reasons = verdicts[machine] ?? [];
    return { machine, verdict: { ok: reasons.length === 0, reasons }, summary: "" };
  };
  return { asked, check };
};
const placement = (patch: Partial<PlacementConfig>): PlacementConfig => ({ ...defaultConfig("/home/test").placement, ...patch });

test("planLaunch moves a held default launch to the first fallback machine with room", async () => {
  const c = checks({ big: ["memory free 5% < 20%"], mini: ["panes 9 >= 8"] });
  const plan = await planLaunch({ done: "" }, placement({ defaultMachine: "big", fallback: ["big", "mini", "local", "spare"] }), c.check);
  expect(plan.check.machine).toBe("local");
  expect(plan.lines).toEqual(["PLACEMENT machine=big source=default", "PLACEMENT_FALLBACK big -> local (memory free 5% < 20%)"]);
  expect(c.asked).toEqual(["big", "mini", "local"]);
});

test("planLaunch keeps a pinned or workspace launch on its HOLD target, and a default one when no fallback has room", async () => {
  const p = placement({ defaultMachine: "big", workspaces: { "*": "big" }, fallback: ["local"] });
  for (const input of [{ machine: "big", done: "" }, { cwd: "/repo/x", done: "" }]) {
    const c = checks({ big: ["full"] });
    const plan = await planLaunch(input, p, c.check);
    expect(plan.check).toEqual({ machine: "big", verdict: { ok: false, reasons: ["full"] }, summary: "" });
    expect(c.asked).toEqual(["big"]);
  }
  const none = await planLaunch({ done: "" }, p, checks({ big: ["full"], local: ["disk"] }).check);
  expect(none.check.machine).toBe("big");
  expect(none.lines).toHaveLength(1);
});

/** `bun src/cli.ts` with a config saving machine big and fake herdr/ssh on PATH; no supervisor runs, so no runner observes big. */
const cliWorld = () => {
  const state = withState();
  cleanups.push(state.done);
  const bin = join(state.dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of [["ssh", "echo 'ssh: connect to host big: No route to host' >&2; exit 255"], ["herdr", "echo '{\"result\":{\"panes\":[]}}'"]] as const) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ guardMachines: { big: "u@big" } }));
  const cli = async (args: string[]) => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: state.dir, TMPDIR: process.env.TMPDIR ?? state.dir, DORI_CONFIG: config, DORI_STATE_DIR: state.dir },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  return { state, cli };
};

test("dori launch on a HOLD machine queues the launch with machine=<label> and exits 4", async () => {
  const w = cliWorld();
  const r = await w.cli(["launch", "big-lane", "--title", "t", "--brief", "/b.md", "--done", "merged acme/app#1", "--machine", "big"]);
  expect(r.code).toBe(4);
  expect(r.out).toContain("PLACEMENT machine=big source=flag");
  // The reason is checkMachine's (placement.test.ts): big has no runner to observe it.
  expect(r.out).toContain("HOLD machine=big ");
  expect(r.out).toContain("QUEUED big-lane (1 waiting; dori hold list)");
  expect(launchQueue(w.state.dir).map((q) => [q.key, q.machine])).toEqual([["big-lane", "big"]]);
  expect(launchHeld(w.state.dir, "big")).toBe(true);
});

test("dori can-launch --machine records that machine's verdict and prints its line", async () => {
  const w = cliWorld();
  const r = await w.cli(["can-launch", "--machine", "big"]);
  expect(r.code).toBe(4);
  expect(r.out.trim()).toStartWith("HOLD machine=big ");
  expect(launchHeld(w.state.dir, "big")).toBe(true);
  const all = await w.cli(["can-launch", "--all"]);
  expect(all.code).toBe(4);
  const lines = all.out.trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^(CAN_LAUNCH|HOLD )/);
  expect(lines[1]).toStartWith("HOLD machine=big ");
});
