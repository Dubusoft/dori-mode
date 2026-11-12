import type { RunnerClient } from "./client.ts";
import type { SecretGrant } from "./lane-socket.ts";
import type { SecretRunResult } from "./secret-run.ts";

/**
 * The lane socket's `secret` verb on a remote runner: the runner holds no store, so it asks the supervisor with
 * `secret.get` over the authenticated link (client.ts `secretRequest`) and hands the opened values to the lane. The
 * supervisor checks the allowlist and audits; this side reads the lane's repo from its worktree origin (as phase 1
 * does), registers granted values for log masking and logs names and codes only, never a value.
 */

export type RemoteSecretDeps = {
  readonly client: Pick<RunnerClient, "secretRequest">;
  /** The lane's repo as "owner/repo", if it has one (secret-grant.ts `laneRepoOf`). */
  readonly laneRepo: (key: string) => Promise<string | undefined>;
  readonly log: (line: string) => void;
  /** Called with the granted values, e.g. to register them for log masking. */
  readonly onGranted?: (values: readonly string[]) => void;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type Granted = { readonly values: Record<string, string>; readonly kinds?: Record<string, "env" | "ssh-key"> };

/**
 * The values (and `kinds`, ssh-key entries only) of a `secret.value` plaintext when it grants exactly `names` as
 * strings; else undefined.
 */
const grantedValues = (plaintext: string, names: readonly string[]): Granted | undefined => {
  let parsed: unknown;
  try { parsed = JSON.parse(plaintext); } catch { return undefined; }
  if (!isRecord(parsed) || !isRecord(parsed.values)) return undefined;
  const got = parsed.values;
  if (Object.keys(got).length !== names.length) return undefined;
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = Object.hasOwn(got, name) ? got[name] : undefined;
    if (typeof value !== "string") return undefined;
    values[name] = value;
  }
  if (parsed.kinds === undefined) return { values };
  if (!isRecord(parsed.kinds)) return undefined;
  const kinds: Record<string, "env" | "ssh-key"> = {};
  for (const [name, kind] of Object.entries(parsed.kinds)) {
    if (!Object.hasOwn(values, name) || (kind !== "env" && kind !== "ssh-key")) return undefined;
    if (kind === "ssh-key") kinds[name] = kind;
  }
  return Object.keys(kinds).length ? { values, kinds } : { values };
};

/** The `secrets` handler for a remote runner's lane socket: grants all of `names` to lane `key` via the supervisor, or refuses. */
export const remoteSecretGranter = (deps: RemoteSecretDeps) => async (key: string, names: readonly string[]): Promise<SecretGrant> => {
  const list = names.join(",");
  const refuse = (code: string, detail: string): SecretGrant => {
    deps.log(`RUNNER_SECRET_DENIED lane=${key} names=${list} code=${code}`);
    return { ok: false, code, detail };
  };
  const repo = await deps.laneRepo(key).catch(() => undefined);
  const reply = await deps.client.secretRequest("secret.get", { key, names: [...names], ...(repo !== undefined ? { repo } : {}) });
  if (!reply.ok) return refuse(reply.code, reply.detail);
  const granted = grantedValues(reply.plaintext, names);
  if (!granted) return refuse("RUNNER_SECRET_FAILED", `the supervisor's grant does not carry exactly ${list}`);
  deps.onGranted?.(Object.values(granted.values));
  deps.log(`RUNNER_SECRET_GRANTED lane=${key} names=${list}`);
  return { ok: true, ...granted };
};

export type RemoteSecretRunDeps = Omit<RemoteSecretDeps, "onGranted">;

/** The exit code and output of a `secret.run.result` plaintext when it is well formed; else undefined. */
const runOutcome = (plaintext: string): SecretRunResult | undefined => {
  let parsed: unknown;
  try { parsed = JSON.parse(plaintext); } catch { return undefined; }
  if (!isRecord(parsed)) return undefined;
  const { exitCode, stdout, stderr, truncated } = parsed;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || typeof stdout !== "string" || typeof stderr !== "string" || typeof truncated !== "boolean") return undefined;
  return { ok: true, exitCode, stdout, stderr, truncated };
};

/**
 * The `secretRun` handler for a remote runner's lane socket: asks the supervisor to run `secretCommands.<op>` for lane
 * `key` with `secret.run` and hands the lane the opened result (exit code and the supervisor's capped, redacted output),
 * or a refusal. Logs lane, op and exit code or refusal code only, never output.
 */
export const remoteSecretRunner = (deps: RemoteSecretRunDeps) => async (key: string, op: string): Promise<SecretRunResult> => {
  const refuse = (code: string, detail: string): SecretRunResult => {
    deps.log(`RUNNER_SECRET_DENIED lane=${key} op=${op} code=${code}`);
    return { ok: false, code, detail };
  };
  const repo = await deps.laneRepo(key).catch(() => undefined);
  const reply = await deps.client.secretRequest("secret.run", { key, op, ...(repo !== undefined ? { repo } : {}) });
  if (!reply.ok) return refuse(reply.code, reply.detail);
  const outcome = runOutcome(reply.plaintext);
  if (!outcome?.ok) return refuse("RUNNER_SECRET_FAILED", "the supervisor's secret.run.result is not {exitCode, stdout, stderr, truncated}");
  deps.log(`RUNNER_SECRET_RUN lane=${key} op=${op} exit=${outcome.exitCode}`);
  return outcome;
};
