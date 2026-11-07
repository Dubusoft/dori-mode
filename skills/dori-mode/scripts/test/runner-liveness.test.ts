import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOperations, plan, type OperationStore } from "../src/operations.ts";
import { LivenessMonitor, livenessIo, type ProbeOutcome } from "../src/runner/liveness.ts";
import type { Runner } from "../src/run.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type RigOptions = {
  /** Runs inside the restart command, before it returns (a hello can arrive while systemctl is still running). */
  readonly duringRestart?: (monitor: LivenessMonitor) => Promise<void>;
  /** Rows already in the operations store when the monitor starts (a supervisor restart). */
  readonly seed?: (operations: OperationStore, wallNow: number) => void;
};

const rig = (probe: (monitor: LivenessMonitor) => ProbeOutcome | Promise<ProbeOutcome>, lanes: readonly string[] = [], options: RigOptions = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "runner-liveness-"));
  dirs.push(dir);
  let at = 0;
  const lines: string[] = [];
  const restarts: number[] = [];
  const operations = openOperations({ stateDir: dir, store: "json" });
  options.seed?.(operations, 1_800_000_000_000);
  const monitor: LivenessMonitor = new LivenessMonitor({
    monotonic: () => at, now: () => 1_800_000_000_000 + at, epoch: 7,
    probe: async () => probe(monitor),
    restart: async () => { restarts.push(at); await options.duringRestart?.(monitor); return { ok: true, detail: "restarted" }; },
    ownedLanes: async () => lanes, operations, emit: (line) => { lines.push(line); },
  });
  monitor.track("worker-a", 1);
  /** Ticks every 5 s (the runners task period) until `untilMs`. */
  const runTo = async (untilMs: number): Promise<void> => { while (at < untilMs) { at = Math.min(untilMs, at + 5_000); await monitor.tick(); } };
  return { monitor, lines, restarts, operations, runTo, at: () => at };
};
const kinds = (lines: readonly string[]): string[] => lines.map((l) => l.split(" ").slice(0, l.startsWith("HOST_GUARD") ? 2 : 1).join(" "));

test("heartbeats stop: RUNNER_STALE at 60 s, HOST_GUARD OFFLINE at 180 s, once each", async () => {
  const r = rig(() => ({ kind: "unreachable", detail: "ssh: no route" }));
  await r.runTo(55_000);
  expect(r.lines).toEqual([]);
  await r.runTo(60_000);
  expect(r.lines).toEqual(["RUNNER_STALE machine=worker-a no heartbeat for 60 s"]);
  await r.runTo(175_000);
  expect(r.lines).toHaveLength(1);
  await r.runTo(180_000);
  expect(r.lines.at(-1)).toBe("HOST_GUARD OFFLINE machine=worker-a runner heartbeat missing for 180 s");
  await r.runTo(600_000);
  expect(kinds(r.lines)).toEqual(["RUNNER_STALE", "HOST_GUARD OFFLINE"]);
  expect(r.restarts).toEqual([]);
});

test("a partition (process alive, health fresh) for 10 min restarts nothing and says RUNNER_UNREACHABLE once", async () => {
  const r = rig(() => ({ kind: "alive" }));
  await r.runTo(180_000 + 10 * 60_000);
  expect(r.restarts).toEqual([]);
  expect(r.lines.filter((l) => l.startsWith("RUNNER_UNREACHABLE"))).toHaveLength(1);
  await r.monitor.heartbeat("worker-a");
  expect(r.lines.at(-1)).toBe("HOST_GUARD ONLINE machine=worker-a");
});

test("a dead runner is restarted once and a hello with a higher gen confirms it", async () => {
  const r = rig(() => ({ kind: "dead", detail: "no process" }));
  await r.runTo(180_000);
  expect(r.restarts).toEqual([180_000]);
  await r.runTo(240_000);
  expect(r.restarts).toHaveLength(1);
  await r.monitor.hello("worker-a", 2);
  expect(r.lines.slice(-2)).toEqual(["RUNNER_RESTARTED machine=worker-a gen=2", "HOST_GUARD ONLINE machine=worker-a"]);
  const op = r.operations.get("runner:worker-a/restart/7-1");
  expect(op?.state).toBe("verified");
  expect(r.monitor.restartsLastHour("worker-a")).toBe(1);
});

test("a runner that keeps dying is restarted 3 times in the hour, then each open lane it owns gets LANE_RUNNER_LOST once", async () => {
  const r = rig(() => ({ kind: "dead", detail: "no process" }), ["lane-a", "lane-b"]);
  await r.runTo(60 * 60_000);
  expect(r.restarts).toHaveLength(3);
  expect(r.lines.filter((l) => l.startsWith("RUNNER_RESTART_FAILED"))).toHaveLength(3);
  const lost = r.lines.filter((l) => l.startsWith("LANE_RUNNER_LOST"));
  expect(lost).toHaveLength(2);
  expect(lost[0]).toStartWith("LANE_RUNNER_LOST lane-a runner=worker-a restart circuit open");
  expect(lost[1]).toStartWith("LANE_RUNNER_LOST lane-b runner=worker-a");
  expect(["runner:worker-a/restart/7-1", "runner:worker-a/restart/7-2", "runner:worker-a/restart/7-3"].map((id) => r.operations.get(id)?.state)).toEqual(["failed", "failed", "failed"]);
});

test("a runner that reconnects while it is being probed is not restarted", async () => {
  const r = rig(async (monitor) => { await monitor.heartbeat("worker-a"); return { kind: "dead", detail: "health read before the reconnect" }; });
  await r.runTo(180_000);
  expect(r.restarts).toEqual([]);
  expect(r.lines.at(-1)).toBe("HOST_GUARD ONLINE machine=worker-a");
});

test("a hello that arrives while the restart command is still running verifies the restart", async () => {
  const r = rig(() => ({ kind: "dead", detail: "no process" }), [], { duringRestart: (monitor) => monitor.hello("worker-a", 2) });
  await r.runTo(180_000);
  expect(r.restarts).toEqual([180_000]);
  expect(r.lines).toContain("RUNNER_RESTARTED machine=worker-a gen=2");
  expect(r.operations.get("runner:worker-a/restart/7-1")?.state).toBe("verified");
});

test("the local runner is restarted through the supervisor's child, never a systemd unit; a worker over ssh", async () => {
  const argv: string[][] = [];
  const run: Runner = async (a) => { argv.push([...a]); return { code: 0, out: "", err: "" }; };
  let childRestarts = 0;
  const io = livenessIo(run, "local", async () => [{ label: "worker-a", target: "u@a" } as never], async () => { childRestarts += 1; }, async () => ({ ok: true, kind: "posix" }));
  expect(await io.restart("local")).toEqual({ ok: true, detail: "child restart" });
  expect(childRestarts).toBe(1);
  expect(argv).toEqual([]);
  expect((await io.restart("worker-a")).ok).toBe(true);
  expect(argv).toHaveLength(1);
  expect(argv[0]?.[0]).toBe("ssh");
  // Without the child hook a local restart fails instead of touching systemd.
  expect((await livenessIo(run, "local", async () => []).restart("local")).ok).toBe(false);
  expect(argv).toHaveLength(1);
});

test("restarts from before a supervisor restart still count toward the circuit", async () => {
  const r = rig(() => ({ kind: "dead", detail: "no process" }), ["lane-a"], {
    seed: (ops, wallNow) => { for (const n of [1, 2, 3]) plan(ops, wallNow - n * 10 * 60_000, { lane: "runner:worker-a", action: "restart", target: `6-${n}` }); },
  });
  await r.runTo(180_000);
  expect(r.restarts).toEqual([]);
  expect(r.lines.at(-1)).toStartWith("LANE_RUNNER_LOST lane-a runner=worker-a restart circuit open");
});
