import type { RunnerClient } from "./client.ts";
import type { SecretGrant } from "./lane-socket.ts";
import type { SecretRunResult } from "./secret-run.ts";
import { SECRET_NAME } from "../secret-name.ts";
import type { LaneToodoReader } from "../toodo-lane-read.ts";

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

/**
 * The `toodoRead` handler for a remote runner's lane socket: asks the supervisor with a sealed `toodo.read` (the
 * supervisor decides the scope and holds the Toodo token) and hands the lane the opened `{text, truncated}`, or a refusal.
 */
export const remoteToodoReader = (deps: Pick<RemoteSecretDeps, "client">): LaneToodoReader => async (key, request) => {
  const reply = await deps.client.secretRequest("toodo.read", {
    key, op: request.op,
    ...(request.op === "get" && request.id !== undefined ? { id: request.id } : {}),
    ...(request.op === "search" ? { query: request.query } : {}),
  });
  if (!reply.ok) return reply;
  let parsed: unknown;
  try { parsed = JSON.parse(reply.plaintext); } catch { parsed = undefined; }
  if (!isRecord(parsed) || typeof parsed.text !== "string" || typeof parsed.truncated !== "boolean") {
    return { ok: false, code: "TOODO_LANE_UNREADABLE", detail: "the supervisor's toodo.read.result is not {text, truncated}" };
  }
  return { ok: true, text: parsed.text, truncated: parsed.truncated };
};

export type HostCommandRouterDeps = {
  /** This runner's live runner-config `hostCommands` (a reload rewrites the policy in place). */
  readonly hostCommands: () => Readonly<Record<string, unknown>>;
  /** Runs a hostCommands op on this host (secretCommandRunner over hostCommands). */
  readonly onHost: (key: string, op: string) => Promise<SecretRunResult>;
  /** Hands any other op to the supervisor (remoteSecretRunner). */
  readonly onSupervisor: (key: string, op: string) => Promise<SecretRunResult>;
  /** The hostCommands ops whose lanes/repos match lane `key`. */
  readonly allowedOnHost: (key: string) => Promise<readonly string[]>;
};

const ALLOWED = "; ops this lane may run: ";

/** The op names after ALLOWED in a DENIED detail, and the detail before it; undefined when the detail has no list. */
const allowedOps = (detail: string): { readonly head: string; readonly ops: string[] } | undefined => {
  const at = detail.lastIndexOf(ALLOWED);
  if (at < 0) return undefined;
  const list = detail.slice(at + ALLOWED.length);
  return { head: detail.slice(0, at), ops: list === "none" ? [] : list.split(", ") };
};

/**
 * The `secretRun` handler of a worker runner: an op in this runner's `hostCommands` runs here, on the worker host and
 * outside the lane sandbox; any other op goes to the supervisor's `secretCommands` as before. An op is never both: a
 * hostCommands name shadows the supervisor's. When the supervisor refuses with RUNNER_SECRET_DENIED, the ops this lane
 * may run on this host join its list, so the lane sees every op it can call in one place.
 */
export const hostCommandRouter = (deps: HostCommandRouterDeps) => async (key: string, op: string): Promise<SecretRunResult> => {
  if (Object.hasOwn(deps.hostCommands(), op)) return deps.onHost(key, op);
  const result = await deps.onSupervisor(key, op);
  if (result.ok || result.code !== "RUNNER_SECRET_DENIED") return result;
  const remote = allowedOps(result.detail);
  const local = remote ? await deps.allowedOnHost(key) : [];
  if (!remote || !local.length) return result;
  const ops = [...new Set([...remote.ops, ...local])].sort();
  return { ...result, detail: `${remote.head}${ALLOWED}${ops.join(", ")}` };
};
