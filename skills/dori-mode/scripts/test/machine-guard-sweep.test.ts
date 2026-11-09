import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Lane } from "../src/registry.ts";
import { clearShellModes, GUARD_AGENT_TEMPLATE, guardAgentVersion } from "../src/remote-guard.ts";
import type { Ran, Runner } from "../src/run.ts";
import { MACHINE_GUARD_STATE_FILE, supervisorSweeps } from "../src/supervise-loop.ts";
import { RunnerGuardBoard } from "../src/runner/guard.ts";
import { HUB_FILE, RunnerHub } from "../src/runner/hub.ts";
import type { AnyRunnerEvent } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, sent, withState } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const want = guardAgentVersion(await readFile(GUARD_AGENT_TEMPLATE, "utf8"));
const sample = (load1 = 1): Ran => ({ code: 0, out: `DORI_GUARD_SAMPLE version=${want} os=linux load1=${load1} mem_free_pct=50 swap_free_gb=2 disk_free_gb=100`, err: "" });

/** The machine-guard sweep over a scripted `herdr machine list` and ssh; `rebuild` builds the sweeps again on the same stateDir. */
const world = () => {
  const s = withState();
  cleanups.push(s.done);
  clearShellModes();
  const clock = fakeClock(T0);
  let list: () => Ran = () => ({ code: 0, out: JSON.stringify([{ label: "mac", ssh_target: "me@mac" }]), err: "" });
  let ssh: (target: string) => Ran = () => sample();
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    if (argv.join(" ") === "herdr machine list --json") return list();
    if (argv[0] === "ssh") {
      const r = ssh(argv[argv.indexOf("--") + 1] ?? "");
      // The login shell is POSIX sh: a reachable machine answers the shell probe.
      return argv.at(-1)?.startsWith("x=6;") && r.code === 0 ? { ...r, out: "DORI_POSIX_42" } : r;
    }
    return { code: 1, out: "", err: "unexpected" };
  };
  const deps = { ...depsFor(newWorld(), clock, s.dir), run };
  const build = () => supervisorSweeps(deps, s.dir);
  let sweeps = build();
  const tick = async (): Promise<string[]> => {
    const out: string[] = [];
    const step = sweeps.find(([name]) => name === "machine-guard")?.[1];
    if (!step) throw new Error("no machine-guard sweep");
    out.push(...await step(async (line) => { out.push(line); }));
    return out;
  };
  return {
    deps, clock, calls, tick, dir: s.dir,
    rebuild: () => { sweeps = build(); },
    sweeps: () => sweeps,
    setList: (f: () => Ran) => { list = f; },
    setSsh: (f: (target: string) => Ran) => { ssh = f; },
    sshCalls: () => calls.filter((c) => c[0] === "ssh").length,
    listCalls: () => calls.filter((c) => c[0] === "herdr" && c[1] === "machine").length,
  };
};

test("remote sampling is its own last sweep; the host guard sweep reaches no worker machine", async () => {
  const w = world();
  const names = w.sweeps().map(([name]) => name);
  expect(names.at(-1)).toBe("machine-guard");
  expect(names.filter((n) => n === "guard")).toHaveLength(1);
  await w.sweeps().find(([name]) => name === "guard")?.[1](async () => {}).catch(() => []);
  expect(w.sshCalls()).toBe(0);
  expect(w.listCalls()).toBe(0);
});

test("OFFLINE only on the second failure in a row, failed machines back off, and a rebuilt sweep does not re-report", async () => {
  const w = world();
  w.setSsh(() => ({ code: 255, out: "", err: "ssh: connect to host mac port 22: No route to host" }));
  expect(await w.tick()).toEqual([]);
  expect(w.sshCalls()).toBe(1);
  expect(existsSync(join(w.dir, MACHINE_GUARD_STATE_FILE))).toBe(true);
  // Inside the 2 min backoff: not sampled.
  w.clock.at += 60_000;
  expect(await w.tick()).toEqual([]);
  expect(w.sshCalls()).toBe(1);
  // A restart keeps the failure count and the backoff.
  w.rebuild();
  w.clock.at = T0 + 120_000;
  expect(await w.tick()).toEqual(["HOST_GUARD OFFLINE machine=mac unreachable: ssh: connect to host mac port 22: No route to host"]);
  expect(w.sshCalls()).toBe(2);
  const saved = JSON.parse(readFileSync(join(w.dir, MACHINE_GUARD_STATE_FILE), "utf8"));
  expect(saved.mac).toMatchObject({ offline: true, failures: 2, nextAttemptAt: T0 + 120_000 + 240_000 });
  w.rebuild();
  w.clock.at = T0 + 120_000 + 240_000;
  expect(await w.tick()).toEqual([]);
  expect(w.sshCalls()).toBe(3);
  // Back: ONLINE, and sampled every round again.
  w.setSsh(() => sample());
  w.clock.at += 8 * 60_000;
  expect(await w.tick()).toEqual(["HOST_GUARD ONLINE machine=mac"]);
  w.clock.at += 30_000;
  expect(await w.tick()).toEqual([]);
  // The first reachable round also probes the shell once.
  expect(w.sshCalls()).toBe(6);
});

test("a failed herdr machine list keeps the previous list, warns, and is retried within a minute", async () => {
  const w = world();
  expect(await w.tick()).toEqual([]);
  expect(w.listCalls()).toBe(1);
  w.setList(() => ({ code: 1, out: "", err: "herdr: server unreachable" }));
  w.clock.at += 10 * 60_000;
  expect(await w.tick()).toEqual(["SWEEP_WARN machine-guard herdr machine list failed: herdr: server unreachable"]);
  expect(w.sshCalls()).toBe(3);
  w.clock.at += 30_000;
  await w.tick();
  expect(w.listCalls()).toBe(2);
  w.clock.at += 30_000;
  w.setList(() => ({ code: 0, out: "not json", err: "" }));
  const lines = await w.tick();
  expect(w.listCalls()).toBe(3);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("SWEEP_WARN machine-guard herdr machine list failed: invalid JSON: ");
  expect(w.sshCalls()).toBe(5);
});

test("a machine ALERT names lanes whose machine is the herdr machine id as well as the label", async () => {
  const w = world();
  w.setList(() => ({ code: 0, out: JSON.stringify([{ id: "m-7", label: "mac", ssh_target: "me@mac" }]), err: "" }));
  w.setSsh(() => sample(999));
  const lane = (key: string, machine: string): Lane => ({
    key, title: key, thread: "none", pane: `${key}:p1`, machine, brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0,
  });
  await w.deps.registry.write(lane("by-id", "m-7"));
  await w.deps.registry.write(lane("by-label", "mac"));
  await w.deps.registry.write(lane("elsewhere", "box"));
  const lines = await w.tick();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("HOST_GUARD ALERT machine=mac load 999 > ");
  const lanes = lines[0]?.split("; lanes on this machine: ")[1]?.split(", ").sort();
  expect(lanes).toEqual(["by-id", "by-label"]);
});

const guardEvent = (runner: string, type: "guard.sample" | "guard.critical", body: Record<string, unknown>): AnyRunnerEvent =>
  ({ v: 1, runner, gen: 1, epoch: 1, seq: 1, type, body }) as unknown as AnyRunnerEvent;

test("the host guard reports the local runner's own critical kill without signalling any process itself", async () => {
  // Given a local runner whose sample is critical and that killed a lane's emulator by itself.
  const s = withState();
  cleanups.push(s.done);
  const clock = fakeClock(T0);
  const w = newWorld();
  w.panes = [{ pane_id: "w:emu-lane", workspace_id: "w", agent: "omo", agent_status: "working" }];
  const deps = depsFor(w, clock, s.dir);
  await deps.registry.write({ key: "emu-lane", title: "emu-lane", thread: "none", pane: "w:emu-lane", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString() });
  const board = new RunnerGuardBoard(clock.now);
  board.event("local", guardEvent("local", "guard.sample", {
    level: "critical", reasons: [], sampledAt: T0, load1: 1, memFreePct: 3, diskFreeGb: 200, swapFreeGb: 2, swapTotalGb: 4, os: "linux", panes: 1,
    lanes: [{ key: "emu-lane", rssKb: 4_200_000, top: [{ comm: "qemu-system-x86", rssKb: 4_089_446, count: 1 }] }],
  }));
  board.event("local", guardEvent("local", "guard.critical", { killed: [13], paused: [], reasons: ["memory free 3% < 5%"], rssKb: [4_089_446], cmds: ["qemu-system-x86"] }));
  const kill = spyOn(process, "kill");
  cleanups.push(() => { kill.mockRestore(); });
  const guard = supervisorSweeps(deps, s.dir, undefined, undefined, undefined, () => board).find(([name]) => name === "guard")?.[1];
  if (!guard) throw new Error("no guard sweep");
  // When the guard sweep runs.
  const lines: string[] = [];
  await guard(async (line) => { lines.push(line); });
  // Then the CRITICAL line names the runner's kill, the lane is told through its runner, and nothing was signalled here.
  expect(lines.filter((l) => l.startsWith("HOST_GUARD CRITICAL"))).toEqual(["HOST_GUARD CRITICAL memory free 3% < 5%; killed qemu-system-x86 3.9 GB (pid 13) - tell the owner"]);
  expect(lines.find((l) => l.startsWith("HOST_GUARD ALERT"))).toContain("lanes by memory: emu-lane 4.0 GB (qemu-system-x86 3.9 GB)");
  expect(sent(w).some((text) => text.includes("so its runner killed qemu-system-x86 3.9 GB (pid 13)"))).toBe(true);
  expect(kill).not.toHaveBeenCalled();
  expect(w.calls).toEqual([]);
  // The kills are taken once: the next sweep, still critical, has nothing new to say.
  lines.length = 0;
  await guard(async (line) => { lines.push(line); });
  expect(lines.filter((l) => l.startsWith("HOST_GUARD CRITICAL"))).toEqual([]);
});

test("without a fresh local runner sample the host guard says nothing and samples nothing", async () => {
  const s = withState();
  cleanups.push(s.done);
  const w = newWorld();
  const deps = depsFor(w, fakeClock(T0), s.dir);
  const guard = supervisorSweeps(deps, s.dir, undefined, undefined, undefined, () => new RunnerGuardBoard(() => 0)).find(([name]) => name === "guard")?.[1];
  expect(await guard?.(async () => { throw new Error("no line expected"); })).toEqual([]);
  expect(w.calls).toEqual([]);
  expect(w.ops).toEqual([]);
});

test("a machine with an enrolled runner is never sampled over ssh, even while its runner is quiet", async () => {
  // Given machine "mac" enrolled as a runner (a hub row) that sent no fresh sample.
  const w = world();
  const hub = new RunnerHub({ stateDir: w.dir, commit: (() => {}) as never, now: () => T0, monotonic: () => 0, epoch: 1 });
  hub.close();
  const db = new Database(join(w.dir, HUB_FILE));
  db.query("INSERT INTO runners (label, hostId, eventAck, cmdSeq, maxGen, cmdAck) VALUES ('mac', 'h-mac', 0, 0, 1, 0)").run();
  db.close();
  // When the machine-guard sweep runs.
  expect(await w.tick()).toEqual([]);
  // Then no ssh guard agent was reached.
  expect(w.sshCalls()).toBe(0);
});
