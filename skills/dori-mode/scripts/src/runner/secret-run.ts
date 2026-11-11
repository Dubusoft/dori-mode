import { homedir } from "node:os";
import type { SecretCommand, SecretRule } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { readSecretValue, ruleMatches, type SecretSource } from "./secret-grant.ts";

/**
 * Proxy execution (`dori secret run <op>`): the supervisor host runs a configured `secretCommands.<op>` argv with the
 * op's secrets in a minimal env, outside any lane, and hands the lane only the exit code and the capped, redacted
 * output. The local runner calls it directly; the supervisor calls it for a remote runner's `secret.run`. Neither the
 * audit line nor the log line carries a value.
 */

/** What a lane gets back from a secret command: its exit code and capped, redacted output, or a refusal. */
export type SecretRunResult =
  | { readonly ok: true; readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly truncated: boolean }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/** One audit line of a secret command: which lane ran which op with which names, and its exit code when it ran. */
export type SecretRunAuditEntry = {
  readonly at: string; readonly runner: string; readonly lane: string; readonly op: string; readonly names: readonly string[];
  readonly allowed: boolean; readonly exitCode?: number;
};

/** A started child: `Bun.spawn`'s subprocess shape with piped stdout/stderr. */
export type SecretChild = {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
};

/** Starts `argv` with exactly `env` in `cwd` and stdin closed; throws when it cannot start. */
export type SecretSpawner = (argv: readonly string[], opts: { readonly env: Record<string, string>; readonly cwd: string }) => SecretChild;

export type SecretRunnerDeps = SecretSource & {
  /** The config `secretCommands`, read again per request. */
  readonly commands: () => Promise<Readonly<Record<string, SecretCommand>>>;
  /** The config `secrets` rules: only their `mint` is used here (the op's own lanes/repos decide access). */
  readonly rules: () => Promise<Readonly<Record<string, SecretRule>>>;
  /** The lane's repo when the caller passes none (local runner: the lane worktree's origin). */
  readonly laneRepo?: (key: string) => Promise<string | undefined>;
  readonly audit: (entry: SecretRunAuditEntry) => void;
  readonly log: (line: string) => void;
  readonly runner: string;
  readonly now: () => number;
  /** Called with the values the command got, e.g. to register them for log masking. */
  readonly onGranted?: (values: readonly string[]) => void;
  /** Default `Bun.spawn` with stdin ignored and stdout/stderr piped. */
  readonly spawn?: SecretSpawner;
  /** Arms the kill timer: calls `fire` after `ms` unless the returned cancel runs first. Default setTimeout. */
  readonly timer?: (ms: number, fire: () => void) => () => void;
  /** The host env PATH/HOME/LANG/TMPDIR come from; default `process.env`. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  /** The default cwd (an op without `cwd`); default `os.homedir()`. */
  readonly home?: string;
};

/** The byte cap on each of stdout and stderr. */
export const SECRET_RUN_OUTPUT_CAP = 64 * 1024;
/** The exit code of a command killed at its `timeoutSec`. */
export const SECRET_RUN_TIMEOUT_EXIT = 124;
const HOST_ENV = ["PATH", "HOME", "LANG", "TMPDIR"] as const;

const defaultSpawn: SecretSpawner = (argv, { env, cwd }) => {
  const child = Bun.spawn([...argv], { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { stdout: child.stdout, stderr: child.stderr, exited: child.exited, kill: () => { child.kill("SIGKILL"); } };
};
const defaultTimer = (ms: number, fire: () => void): (() => void) => { const t = setTimeout(fire, ms); return () => { clearTimeout(t); }; };

/** Reads `stream` to its end (or `cancel`), keeping the first `cap` bytes; `over` when more came. */
const capture = (stream: ReadableStream<Uint8Array>, cap: number) => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  const done = (async () => {
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      if (seen < cap) chunks.push(value.subarray(0, cap - seen));
      seen += value.length;
    }
  })().catch(() => {});
  const over = (): boolean => seen > cap;
  return { done, cancel: () => { void reader.cancel().catch(() => {}); }, result: () => ({ bytes: Buffer.concat(chunks), over: over() }) };
};

/**
 * `text` with every secret value replaced by `[REDACTED:<NAME>]` (longest values first), a cut-off value prefix at
 * the end of truncated output masked too, then `redactSecrets`.
 */
const redactOutput = (text: string, secrets: Readonly<Record<string, string>>, truncated: boolean): string => {
  const pairs = Object.entries(secrets).filter(([, v]) => v !== "").sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of pairs) out = out.split(value).join(`[REDACTED:${name}]`);
  if (truncated) {
    for (const [name, value] of pairs) {
      for (let n = Math.min(value.length - 1, out.length); n > 0; n -= 1) {
        if (out.endsWith(value.slice(0, n))) { out = `${out.slice(0, -n)}[REDACTED:${name}]`; break; }
      }
    }
  }
  return redactSecrets(out);
};

/**
 * The lane socket's `secret-run` handler on the supervisor host: runs `secretCommands.<op>` for lane `key` (repo
 * `repo`, else `deps.laneRepo`), or refuses. Unknown op or a lane its lanes/repos do not match -> `RUNNER_SECRET_DENIED`;
 * a secret that cannot be read or minted -> the granter's code; a command that cannot start -> `RUNNER_SECRET_FAILED`.
 * The command gets env {PATH, HOME, LANG, TMPDIR (when set on the host)} + its secrets, stdin closed, cwd = `cwd` ??
 * home, and is killed after `timeoutSec` (exit 124, stderr says so). Each of stdout/stderr keeps its first 64 KiB.
 */
export const secretCommandRunner = (deps: SecretRunnerDeps) => async (key: string, op: string, repo?: string): Promise<SecretRunResult> => {
  let names: readonly string[] = [];
  const audit = (allowed: boolean, exitCode?: number): void => {
    deps.audit({ at: new Date(deps.now()).toISOString(), runner: deps.runner, lane: key, op, names: [...names], allowed, ...(exitCode !== undefined ? { exitCode } : {}) });
  };
  const refuse = (code: string, detail: string): SecretRunResult => {
    audit(false);
    deps.log(`RUNNER_SECRET_DENIED lane=${key} op=${op} code=${code}`);
    return { ok: false, code, detail };
  };
  let commands: Readonly<Record<string, SecretCommand>>;
  let rules: Readonly<Record<string, SecretRule>>;
  try { [commands, rules] = await Promise.all([deps.commands(), deps.rules()]); } catch (e) {
    return refuse("RUNNER_SECRET_FAILED", e instanceof Error ? e.message : String(e));
  }
  const command = Object.hasOwn(commands, op) ? commands[op] : undefined;
  if (!command) return refuse("RUNNER_SECRET_DENIED", `${op} is not a configured secret command (config secretCommands)`);
  names = command.secrets;
  let laneRepoP: Promise<string | undefined> | undefined;
  const laneRepo = (): Promise<string | undefined> => (laneRepoP ??= repo !== undefined ? Promise.resolve(repo) : (deps.laneRepo?.(key) ?? Promise.resolve(undefined)).catch(() => undefined));
  if (!await ruleMatches(command, key, laneRepo)) return refuse("RUNNER_SECRET_DENIED", `${key} may not run ${op} (config secretCommands)`);
  const values: Record<string, string> = {};
  for (const name of command.secrets) {
    const read = await readSecretValue(deps, name, Object.hasOwn(rules, name) ? rules[name] : undefined, key, laneRepo);
    if (!read.ok) return refuse(read.code, read.detail);
    values[name] = read.value;
  }
  deps.onGranted?.(Object.values(values));
  const host = deps.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of HOST_ENV) { const v = host[name]; if (v !== undefined) env[name] = v; }
  Object.assign(env, values);
  let child: SecretChild;
  try { child = (deps.spawn ?? defaultSpawn)(command.argv, { env, cwd: command.cwd ?? deps.home ?? homedir() }); } catch (e) {
    return refuse("RUNNER_SECRET_FAILED", `${op}: ${command.argv[0]} did not start: ${redactOutput(e instanceof Error ? e.message : String(e), values, false)}`);
  }
  const out = capture(child.stdout, SECRET_RUN_OUTPUT_CAP);
  const err = capture(child.stderr, SECRET_RUN_OUTPUT_CAP);
  let timedOut = false;
  const cancel = (deps.timer ?? defaultTimer)(command.timeoutSec * 1000, () => {
    timedOut = true;
    child.kill();
    // A grandchild may hold the pipes open after the kill; stop reading them.
    out.cancel();
    err.cancel();
  });
  let code: number;
  try { [code] = await Promise.all([child.exited, out.done, err.done]); } finally { cancel(); }
  const exitCode = timedOut ? SECRET_RUN_TIMEOUT_EXIT : code;
  const o = out.result();
  const e = err.result();
  const decode = (bytes: Buffer): string => new TextDecoder().decode(bytes);
  const stderr = redactOutput(decode(e.bytes), values, e.over) + (timedOut ? `${e.bytes.length ? "\n" : ""}dori: ${op} killed after ${command.timeoutSec}s (timeoutSec)\n` : "");
  audit(true, exitCode);
  deps.log(`RUNNER_SECRET_RUN lane=${key} op=${op} exit=${exitCode}`);
  return { ok: true, exitCode, stdout: redactOutput(decode(o.bytes), values, o.over), stderr, truncated: o.over || e.over };
};
