/**
 * Keeps a macOS runner host awake while the runner serves. A Mac left idle sleeps and only runs during short DarkWake
 * windows, so the runner connects in one window, then misses every heartbeat until the supervisor's idle timeout drops
 * the link, and its reconnect waits for the next window. `-i` stops idle sleep from a full wake; a DarkWake ignores it
 * and goes back to sleep unless `-s` (system sleep, honored on AC power) is held too. `-w <pid>` ends both when the
 * runner process exits, a crash and `SIGKILL` included. On win32, when `executionState` is given, the runner's thread
 * holds `ES_CONTINUOUS|ES_SYSTEM_REQUIRED`, which Windows drops when the process exits. Other platforms get nothing.
 */

export type AwakeChild = { kill(): void; readonly exited: Promise<number> };
export type AwakeDeps = {
  readonly os: string;
  readonly pid: number;
  readonly spawn: (argv: readonly string[]) => AwakeChild;
  readonly log: (line: string) => void;
  /** kernel32 `SetThreadExecutionState`: takes the flags, returns the previous state or 0 on failure. */
  readonly executionState?: (flags: number) => number;
};

export const CAFFEINATE = "/usr/bin/caffeinate";
export const ES_CONTINUOUS = 0x80000000;
export const ES_SYSTEM_REQUIRED = 0x00000001;

let kernel32: { readonly SetThreadExecutionState: (flags: number) => number } | undefined;

/** `SetThreadExecutionState` through `bun:ffi`, loaded on the first call so other platforms never open kernel32. */
export const kernelExecutionState = (flags: number): number => {
  if (!kernel32) {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    kernel32 = dlopen("kernel32.dll", { SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 } }).symbols;
  }
  return kernel32.SetThreadExecutionState(flags);
};

const holdExecutionState = (set: (flags: number) => number, log: (line: string) => void): (() => void) => {
  try {
    if (set((ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0) === 0) {
      log("RUNNER_AWAKE_FAILED SetThreadExecutionState returned 0");
      return () => {};
    }
  } catch (error) {
    log(`RUNNER_AWAKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    return () => {};
  }
  return () => {
    try { set(ES_CONTINUOUS); } catch (error) { log(`RUNNER_AWAKE_RELEASE_FAILED ${error instanceof Error ? error.message : String(error)}`); }
  };
};

/** Starts the assertion on darwin (and win32, see above) and returns its stop; logs and carries on when it cannot be held. */
export const holdAwake = (deps: AwakeDeps): (() => void) => {
  if (deps.os === "win32" && deps.executionState) return holdExecutionState(deps.executionState, deps.log);
  if (deps.os !== "darwin") return () => {};
  let stopping = false;
  let child: AwakeChild;
  try {
    child = deps.spawn([CAFFEINATE, "-i", "-s", "-w", String(deps.pid)]);
  } catch (error) {
    deps.log(`RUNNER_AWAKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    return () => {};
  }
  void child.exited.then((code) => { if (!stopping) deps.log(`RUNNER_AWAKE_FAILED caffeinate exited code=${code}`); });
  return () => {
    stopping = true;
    child.kill();
  };
};

export const spawnQuiet = (argv: readonly string[]): AwakeChild =>
  Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
