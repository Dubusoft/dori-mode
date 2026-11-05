import { readFile } from "node:fs/promises";
import { clearShellModes, GUARD_AGENT_TEMPLATE, guardAgentVersion } from "../src/remote-guard.ts";
import type { Ran, Runner } from "../src/run.ts";
import { RunnerGuardBoard } from "../src/runner/guard.ts";
import type { AnyRunnerEvent } from "../src/runner/protocol.ts";
import { supervisorSweeps } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

export const T0 = 1_800_000_000_000;
export const want = guardAgentVersion(await readFile(GUARD_AGENT_TEMPLATE, "utf8"));
export type Reading = { load1: number; memFreePct: number; diskFreeGb: number; swapFreeGb: number };
export const agentLine = (r: Reading): Ran => ({ code: 0, out: `DORI_GUARD_SAMPLE version=${want} os=linux load1=${r.load1} mem_free_pct=${r.memFreePct} swap_free_gb=${r.swapFreeGb} disk_free_gb=${r.diskFreeGb}`, err: "" });
export const runnerSample = (r: Reading, at: number): AnyRunnerEvent => ({
  v: 1, runner: "mac", gen: 1, epoch: 1, seq: 1, type: "guard.sample",
  body: { level: "ok", reasons: [], sampledAt: at, ...r, swapTotalGb: -1, os: "linux" },
}) as unknown as AnyRunnerEvent;

/** The machine-guard sweep for one machine "mac", sampled over a scripted ssh or from a runner board. */
export const guardWorld = (withBoard: boolean, cleanups: (() => void)[]) => {
  const s = withState();
  cleanups.push(s.done);
  clearShellModes();
  const clock = fakeClock(T0);
  let ssh: () => Ran = () => ({ code: 255, out: "", err: "ssh: connect to host mac port 22: No route to host" });
  let sshCalls = 0;
  const run: Runner = async (argv) => {
    if (argv.join(" ") === "herdr machine list --json") return { code: 0, out: JSON.stringify([{ label: "mac", ssh_target: "me@mac" }]), err: "" };
    if (argv[0] === "ssh") {
      sshCalls += 1;
      const r = ssh();
      return argv.at(-1)?.startsWith("x=6;") && r.code === 0 ? { ...r, out: "DORI_POSIX_42" } : r;
    }
    return { code: 1, out: "", err: "unexpected" };
  };
  const board = new RunnerGuardBoard(clock.now);
  const deps = { ...depsFor(newWorld(), clock, s.dir), run };
  const sweeps = supervisorSweeps(deps, s.dir, undefined, undefined, undefined, () => (withBoard ? board : undefined));
  const tick = async (): Promise<string[]> => {
    const out: string[] = [];
    const step = sweeps.find(([name]) => name === "machine-guard")?.[1];
    if (!step) throw new Error("no machine-guard sweep");
    out.push(...await step(async (line) => { out.push(line); }));
    return out;
  };
  return { clock, board, tick, sshCalls: () => sshCalls, setSsh: (f: () => Ran) => { ssh = f; } };
};

