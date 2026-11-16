import type { Clock } from "../run.ts";
import { backoffMs, RECONNECT_MAX_MS } from "./client.ts";

/**
 * The local runner as a child process of `supervise` (design 0.1 (c), section 4). `startLocalRunner` spawns
 * `dori runner serve` with the lane-mode variables removed from its environment (so the runner is never in lane mode),
 * restarts it whenever it exits with client.ts `backoffMs` (1 s doubling to 60 s, with jitter; a child that stayed up
 * for RECONNECT_MAX_MS starts again from the first step), and kills it when `signal` aborts: SIGTERM, up to
 * LOCAL_STOP_GRACE_MS for it to exit, then SIGKILL. `restart()` (the liveness monitor's restart for `local`) stops the
 * running child the same way and spawns the next one at once, without a backoff step.
 *
 * Lines: `RUNNER_LOCAL_STARTED pid=<pid>`, `RUNNER_LOCAL_EXITED pid=<pid> code=<code>`,
 * `RUNNER_LOCAL_RESTART in=<ms>ms attempt=<n>` (or `requested`), `RUNNER_LOCAL_SPAWN_FAILED <error>`.
 */

export const LOCAL_STOP_GRACE_MS = 10_000;
/** The variables that put `dori` into lane mode; the runner child never inherits them. */
export const LANE_MODE_ENV = ["DORI_LANE_KEY", "HERDR_PANE_ID"] as const;

export type ChildProcess = { readonly pid: number; readonly exited: Promise<number>; kill(sig: "SIGTERM" | "SIGKILL"): void };

export type LocalChildDeps = {
  readonly spawn: (argv: readonly string[], env: Record<string, string>) => ChildProcess;
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly clock: Clock;
  readonly log: (line: string) => void;
  readonly random?: () => number;
};

export type LocalChild = { restart(): Promise<void>; stop(): Promise<void>; readonly pid: () => number | undefined };

/** The production argv of the local runner child: this bun running `<cliPath> runner serve`. */
export const localRunnerArgv = (cliPath: string, execPath: string = process.execPath): string[] => [execPath, cliPath, "runner", "serve"];

/** The production `spawn`: Bun.spawn with stdin closed and the child's output on the supervisor's own. */
export const spawnProcess: LocalChildDeps["spawn"] = (argv, env) => {
  const proc = Bun.spawn([...argv], { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return { pid: proc.pid, exited: proc.exited, kill: (sig) => { proc.kill(sig); } };
};

/** `env` without the lane-mode variables. */
export const childEnv = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !(LANE_MODE_ENV as readonly string[]).includes(name)));

export const startLocalRunner = (deps: LocalChildDeps, signal: AbortSignal): LocalChild => {
  const env = childEnv(deps.env);
  let current: ChildProcess | undefined;
  let stopped = false;
  let immediate = false;
  let attempt = 0;
  /** Cuts a backoff wait short (a restart or a stop). */
  let wake: (() => void) | undefined;
  /** Waiters of the next spawn (restart callers); a stop releases them too. */
  let spawned: (() => void)[] = [];
  const released = (): void => { const waiting = spawned; spawned = []; for (const done of waiting) done(); };

  const pause = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    wake = resolve;
    void deps.clock.sleep(ms).then(resolve);
  }).finally(() => { wake = undefined; });

  /** SIGTERM, up to LOCAL_STOP_GRACE_MS for the exit, then SIGKILL and the exit. */
  const terminate = async (child: ChildProcess): Promise<void> => {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    const exited = await Promise.race([child.exited.then(() => true), deps.clock.sleep(LOCAL_STOP_GRACE_MS).then(() => false)]);
    if (exited) return;
    deps.log(`RUNNER_LOCAL_KILL pid=${child.pid} no exit ${LOCAL_STOP_GRACE_MS}ms after SIGTERM`);
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await child.exited;
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      let child: ChildProcess | undefined;
      try {
        child = deps.spawn(deps.argv, env);
      } catch (error) {
        deps.log(`RUNNER_LOCAL_SPAWN_FAILED ${error instanceof Error ? error.message : String(error)}`);
      }
      if (child) {
        current = child;
        const startedAt = deps.clock.now();
        deps.log(`RUNNER_LOCAL_STARTED pid=${child.pid}`);
        released();
        const code = await child.exited.catch(() => -1);
        current = undefined;
        deps.log(`RUNNER_LOCAL_EXITED pid=${child.pid} code=${code}`);
        if (deps.clock.now() - startedAt >= RECONNECT_MAX_MS) attempt = 0;
      }
      if (stopped) break;
      if (immediate) { immediate = false; deps.log("RUNNER_LOCAL_RESTART requested"); continue; }
      const delay = backoffMs(attempt, deps.random);
      attempt += 1;
      deps.log(`RUNNER_LOCAL_RESTART in=${delay}ms attempt=${attempt}`);
      await pause(delay);
      immediate = false;
    }
    released();
  };

  let done: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      stopped = true;
      wake?.();
      const child = current;
      if (child) await terminate(child);
      await done;
      released();
    })();
    return stopping;
  };

  if (signal.aborted) stopped = true;
  else {
    done = loop();
    signal.addEventListener("abort", () => { void stop(); }, { once: true });
  }

  return {
    stop,
    pid: () => current?.pid,
    restart: async () => {
      if (stopped) return;
      immediate = true;
      const next = new Promise<void>((resolve) => { spawned.push(resolve); });
      const child = current;
      if (child) await terminate(child);
      else wake?.();
      await next;
    },
  };
};
