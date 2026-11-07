import { holdAwake, kernelExecutionState, spawnQuiet } from "./awake.ts";
import { pidAlive } from "./health.ts";
import { TASKKILL_NOT_FOUND, taskkillArgv } from "../run.ts";

/**
 * What the runner does differently per host OS, chosen once in `serveMain`. POSIX keeps signals and process groups;
 * win32 has neither, so `taskkill /T` stands in: without `/F` for SIGTERM (a polite close that console processes
 * refuse, which is logged), with `/F` for SIGKILL. taskkill's "not found" becomes an `ESRCH` error, so callers that
 * treat ESRCH as "already gone" (`pressure.ts` `send`) work unchanged.
 */

export type KillSignal = "SIGTERM" | "SIGKILL";
export type SyncRan = { readonly code: number; readonly out: string; readonly err: string };
/** Runs argv to completion; taskkill returns quickly, and the callers (`KillDeps.signal`) are synchronous. */
export type SyncRun = (argv: readonly string[]) => SyncRan;

export type RunnerPlatform = {
  readonly os: string;
  /** Kills `pid` and its descendants outright; throws an `ESRCH` error when it is gone. */
  readonly killTree: (pid: number) => void;
  /** Sends `sig` to `pid`; throws an `ESRCH` error when it is gone. */
  readonly signal: (pid: number, sig: KillSignal) => void;
  readonly pidAlive: (pid: number) => boolean;
  /** Keeps the host from sleeping while the runner serves; returns the release. */
  readonly holdAwake: (deps: { readonly pid: number; readonly log: (line: string) => void }) => () => void;
};

export type PlatformDeps = {
  readonly run?: SyncRun;
  readonly log?: (line: string) => void;
  readonly executionState?: (flags: number) => number;
};

export const runSync: SyncRun = (argv) => {
  const r = Bun.spawnSync([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

const esrch = (pid: number, detail: string): Error =>
  Object.assign(new Error(`no such process ${pid}: ${detail}`), { code: "ESRCH" });

const posixPlatform = (os: string): RunnerPlatform => ({
  os,
  killTree: (pid) => { process.kill(-pid, "SIGKILL"); },
  signal: (pid, sig) => { process.kill(pid, sig); },
  pidAlive,
  holdAwake: ({ pid, log }) => holdAwake({ os, pid, spawn: spawnQuiet, log }),
});

const windowsPlatform = (deps: PlatformDeps): RunnerPlatform => {
  const run = deps.run ?? runSync;
  const log = deps.log ?? ((line: string) => { console.log(line); });
  const taskkill = (pid: number, force: boolean): SyncRan => {
    const r = run(taskkillArgv(pid, force));
    if (r.code === TASKKILL_NOT_FOUND) throw esrch(pid, r.err || r.out);
    return r;
  };
  const killTree = (pid: number): void => {
    const r = taskkill(pid, true);
    if (r.code !== 0) throw new Error(`taskkill /T /F of pid ${pid} failed with code ${r.code}: ${r.err || r.out}`);
  };
  return {
    os: "win32",
    killTree,
    signal: (pid, sig) => {
      if (sig === "SIGKILL") return killTree(pid);
      const r = taskkill(pid, false);
      if (r.code !== 0) log(`RUNNER_SIGTERM_REFUSED pid=${pid} code=${r.code} ${r.err || r.out}`);
    },
    pidAlive,
    holdAwake: ({ pid, log: awakeLog }) =>
      holdAwake({ os: "win32", pid, spawn: spawnQuiet, log: awakeLog, executionState: deps.executionState ?? kernelExecutionState }),
  };
};

/** The adapters for `platform`: Windows ones on win32, today's POSIX behavior everywhere else. */
export const selectPlatform = (platform: string = process.platform, deps: PlatformDeps = {}): RunnerPlatform =>
  platform === "win32" ? windowsPlatform(deps) : posixPlatform(platform);
