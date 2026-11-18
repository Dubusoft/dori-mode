import type { RunnerClient } from "./client.ts";
import type { SecretGrant } from "./lane-socket.ts";
import type { SecretRunResult } from "./secret-run.ts";
import { SECRET_NAME } from "../secret-name.ts";

export type RemoteSecretDeps = {
  readonly client: Pick<RunnerClient, "secretRequest">;
  readonly laneRepo: (key: string) => Promise<string | undefined>;
  readonly log: (line: string) => void;
  readonly onGranted?: (values: readonly string[]) => void;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pull every value over the authenticated, sealed supervisor link. */
export const remoteSecretGranter = (deps: RemoteSecretDeps) => async (key: string): Promise<SecretGrant> => {
  try {
    const reply = await deps.client.secretRequest("secret.get", { key, names: [] });
    if (!reply.ok) return reply;
    const parsed: unknown = JSON.parse(reply.plaintext);
    if (!isRecord(parsed) || !isRecord(parsed.values) || !Object.entries(parsed.values).every(([name, value]) => SECRET_NAME.test(name) && typeof value === "string")) {
      return { ok: false, code: "RUNNER_SECRET_FAILED", detail: "the supervisor's grant is not a map of secret names to values" };
    }
    const values = parsed.values as Record<string, string>;
    deps.onGranted?.(Object.values(values));
    return { ok: true, values };
  } catch { return { ok: false, code: "RUNNER_SECRET_FAILED", detail: "the supervisor's grant could not be read" }; }
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
