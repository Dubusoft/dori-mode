import { Database } from "bun:sqlite";
import { join } from "node:path";
import { clearShellModes } from "../src/remote-guard.ts";
import type { Runner } from "../src/run.ts";
import { RunnerGuardBoard } from "../src/runner/guard.ts";
import { HUB_FILE, RunnerHub } from "../src/runner/hub.ts";
import type { AnyRunnerEvent } from "../src/runner/protocol.ts";
import { supervisorSweeps } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

export const T0 = 1_800_000_000_000;
export type Reading = { load1: number; memFreePct: number; diskFreeGb: number; swapFreeGb: number };
export const runnerSample = (r: Reading, at: number, runner = "mac"): AnyRunnerEvent => ({
  v: 1, runner, gen: 1, epoch: 1, seq: 1, type: "guard.sample",
  body: { level: "ok", reasons: [], sampledAt: at, ...r, swapTotalGb: -1, os: "linux" },
}) as unknown as AnyRunnerEvent;

/** Enrolls `labels` as runners in `stateDir`'s hub (one hub row each), as `dori runner install` leaves them. */
export const enrollRunners = (stateDir: string, ...labels: string[]): void => {
  const hub = new RunnerHub({ stateDir, commit: (() => {}) as never, now: () => T0, monotonic: () => 0, epoch: 1 });
  hub.close();
  const db = new Database(join(stateDir, HUB_FILE));
  for (const label of labels) db.query("INSERT INTO runners (label, hostId, eventAck, cmdSeq, maxGen, cmdAck) VALUES (?, ?, 0, 0, 1, 0)").run(label, `h-${label}`);
  db.close();
};

/** The machine-guard sweep for one machine "mac" with an enrolled runner, judged from a runner board; ssh is counted, never answered. */
export const guardWorld = (cleanups: (() => void)[]) => {
  const s = withState();
  cleanups.push(s.done);
  clearShellModes();
  enrollRunners(s.dir, "mac");
  const clock = fakeClock(T0);
  let sshCalls = 0;
  const run: Runner = async (argv) => {
    if (argv.join(" ") === "herdr machine list --json") return { code: 0, out: JSON.stringify([{ label: "mac", ssh_target: "me@mac" }]), err: "" };
    if (argv[0] === "ssh") sshCalls += 1;
    return { code: 1, out: "", err: "unexpected" };
  };
  const board = new RunnerGuardBoard(clock.now);
  const deps = { ...depsFor(newWorld(), clock, s.dir), run };
  const sweeps = supervisorSweeps(deps, s.dir, undefined, undefined, undefined, () => board);
  const tick = async (): Promise<string[]> => {
    const out: string[] = [];
    const step = sweeps.find(([name]) => name === "machine-guard")?.[1];
    if (!step) throw new Error("no machine-guard sweep");
    out.push(...await step(async (line) => { out.push(line); }));
    return out;
  };
  return { clock, board, tick, sshCalls: () => sshCalls };
};
