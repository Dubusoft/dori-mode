export type Ran = { readonly code: number; readonly out: string; readonly err: string; readonly timedOut?: boolean };
/** `timeoutMs` overrides the default for one call; 0 means no limit. `stdin`, when set, is written to the command's stdin. */
export type RunOptions = { readonly cwd?: string; readonly timeoutMs?: number; readonly stdin?: string };
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<Ran>;

/** Exit code a timed-out call reports (as coreutils `timeout` does). */
export const RUN_TIMEOUT_CODE = 124;
export const DEFAULT_RUN_TIMEOUT_MS = 60_000;
/** After the command exits (or is killed on timeout), how long the output pipes may take to close before they are abandoned. */
export const RUN_KILL_GRACE_MS = 1_500;
let defaultTimeoutMs = DEFAULT_RUN_TIMEOUT_MS;

/** Sets the limit every call without its own `timeoutMs` gets (config `runTimeoutMs`); 0 turns it off. */
export const setDefaultRunTimeout = (ms: number): void => {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`run timeout must be a non-negative number of ms, got ${ms}`);
  defaultTimeoutMs = ms;
};
export const defaultRunTimeout = (): number => defaultTimeoutMs;

/** taskkill's exit code when no process has the pid. */
export const TASKKILL_NOT_FOUND = 128;
/** `taskkill /PID <pid> /T`, with `/F` when `force`: the process and the children it still has. */
export const taskkillArgv = (pid: number, force: boolean): string[] => ["taskkill", "/PID", String(pid), "/T", ...(force ? ["/F"] : [])];

export type RunSpawnOptions = {
  readonly detached?: boolean; readonly windowsHide?: boolean; readonly stdout: "pipe" | "ignore"; readonly stderr: "pipe" | "ignore";
  readonly cwd?: string; readonly stdin?: Blob;
};
export type RunChild = {
  readonly pid: number; readonly exited: Promise<number>;
  readonly stdout?: ReadableStream<Uint8Array> | number | undefined; readonly stderr?: ReadableStream<Uint8Array> | number | undefined;
};
export type RunDeps = { readonly os: string; readonly spawn: (argv: string[], options: RunSpawnOptions) => RunChild };

/**
 * Runs argv and collects its output. A descendant (a daemon, or one that left the group with setsid) can hold the
 * output pipes open indefinitely, so once the command itself exits its pipes get at most RUN_KILL_GRACE_MS to close;
 * then their readers are cancelled and the command's own exit code comes back with the output read so far. A call
 * that outlives its timeout has its process group killed with SIGKILL, gets the same grace, and comes back as code
 * 124 with `timedOut`. On win32 there are no process groups: the command is spawned hidden in the runner's console and
 * a timeout runs `taskkill /T /F` on its tree instead.
 */
export const makeRunner = (deps: RunDeps): Runner => async (argv, opts = {}) => {
  const limit = opts.timeoutMs ?? defaultTimeoutMs;
  const win = deps.os === "win32";
  let p: RunChild;
  try {
    p = deps.spawn([...argv], {
      ...(win ? { windowsHide: true } : { detached: true }), stdout: "pipe", stderr: "pipe", ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.stdin !== undefined ? { stdin: new Blob([opts.stdin]) } : {}),
    });
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
  const cancels: (() => Promise<void>)[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    cancels.push(() => reader.cancel());
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString();
      chunks.push(value);
    }
  };
  const outputs = Promise.all([collect(p.stdout as ReadableStream<Uint8Array>), collect(p.stderr as ReadableStream<Uint8Array>)]);
  /** Waits for the pipes to close for at most the grace, then cancels their readers so `outputs` settles. */
  const drain = async (): Promise<void> => {
    let grace: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([outputs.then(() => true), new Promise<false>((resolve) => { grace = setTimeout(() => resolve(false), RUN_KILL_GRACE_MS); })]);
    clearTimeout(grace);
    if (!drained) await Promise.all(cancels.map((cancel) => cancel().catch(() => undefined)));
  };
  let exited = false;
  const finished = p.exited.then(async (code) => {
    exited = true;
    await drain();
    const [out, err] = await outputs;
    return { code, out: out.trim(), err: err.trim() };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    if (limit > 0) timer = setTimeout(() => resolve("timeout"), limit);
  });
  try {
    const result = await Promise.race([finished, expired]);
    if (result !== "timeout") return result;
    // The command exited in time and only its pipes were still draining: its own result stands.
    if (exited) return await finished;
    if (win) {
      const code = await deps.spawn(taskkillArgv(p.pid, true), { windowsHide: true, stdout: "ignore", stderr: "ignore" }).exited;
      if (code !== 0 && code !== TASKKILL_NOT_FOUND) throw new Error(`taskkill /T /F of pid ${p.pid} failed with code ${code}`);
    } else {
      try { process.kill(-p.pid, "SIGKILL"); }
      catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ESRCH")) throw e; }
    }
    await drain();
    return { code: RUN_TIMEOUT_CODE, out: "", err: `timed out after ${limit} ms: ${argv.join(" ")}`, timedOut: true };
  } finally {
    clearTimeout(timer);
  }
};

export const run: Runner = makeRunner({ os: process.platform, spawn: (argv, options) => Bun.spawn(argv, options) });

export type Clock = { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export const iso = (clock: Clock): string => new Date(clock.now()).toISOString();
