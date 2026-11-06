/**
 * Keeps a macOS runner host out of idle sleep while the runner serves. A Mac left idle sleeps and only runs during
 * short DarkWake windows, so the runner connects in one window, then misses every heartbeat until the supervisor's
 * idle timeout drops the link, and its reconnect waits for the next window. `caffeinate -i -w <pid>` holds the
 * idle-sleep assertion until the runner process exits, a crash and `SIGKILL` included. Other platforms get nothing.
 */

export type AwakeChild = { kill(): void; readonly exited: Promise<number> };
export type AwakeDeps = {
  readonly os: string;
  readonly pid: number;
  readonly spawn: (argv: readonly string[]) => AwakeChild;
  readonly log: (line: string) => void;
};

export const CAFFEINATE = "/usr/bin/caffeinate";

/** Starts the assertion on darwin and returns its stop; logs and carries on when it cannot be held. */
export const holdAwake = (deps: AwakeDeps): (() => void) => {
  if (deps.os !== "darwin") return () => {};
  let stopping = false;
  let child: AwakeChild;
  try {
    child = deps.spawn([CAFFEINATE, "-i", "-w", String(deps.pid)]);
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
