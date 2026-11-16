import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { writeRunnerFile } from "./fs-safety.ts";
import { LABEL_PATTERN } from "./protocol.ts";
import { isPrivateListen } from "./ws-transport.ts";

export const RUNNER_ENDPOINTS_FILE = "runner-endpoints.json";
export const RUNNER_PORT = 7411;

/** Supervisor-owned discovery, separate from config.json. Values are private IP host:port addresses. */
export const readRunnerEndpoints = (stateDir: string): Record<string, string> => {
  const path = join(stateDir, RUNNER_ENDPOINTS_FILE);
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.entries(value).some(([label, endpoint]) => !LABEL_PATTERN.test(label) || typeof endpoint !== "string" || !isPrivateListen(endpoint))) {
    throw new Error(`RUNNER_ENDPOINTS_INVALID ${path}: expected label -> private host:port`);
  }
  return value as Record<string, string>;
};

/** Atomically preserve other labels and replace this endpoint; the file is mode 0600. */
export const writeRunnerEndpoint = (stateDir: string, label: string, endpoint: string): void => {
  if (!LABEL_PATTERN.test(label) || !isPrivateListen(endpoint)) throw new Error(`RUNNER_LISTEN_REFUSED ${label} ${endpoint}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeRunnerFile(join(stateDir, RUNNER_ENDPOINTS_FILE), `${JSON.stringify({ ...readRunnerEndpoints(stateDir), [label]: endpoint }, null, 2)}\n`);
};

/** Atomically drop this label's endpoint, keeping the others; no file or no entry is a no-op. */
export const removeRunnerEndpoint = (stateDir: string, label: string): void => {
  const { [label]: gone, ...rest } = readRunnerEndpoints(stateDir);
  if (gone === undefined) return;
  writeRunnerFile(join(stateDir, RUNNER_ENDPOINTS_FILE), `${JSON.stringify(rest, null, 2)}\n`);
};

/** Resolve the SSH target on the supervisor; never ask a worker to bind a hostname or public address. */
export const runnerListenAddress = async (
  target: string, resolve: (host: string) => Promise<string> = async (host) => (await lookup(host)).address,
): Promise<string> => {
  const authority = target.slice(target.lastIndexOf("@") + 1);
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(authority);
  const host = bracket?.[1] ?? (isIP(authority) ? authority : authority.replace(/:\d+$/, ""));
  let address: string;
  try { address = isIP(host) ? host : await resolve(host); }
  catch (error) { throw new Error(`RUNNER_LISTEN_RESOLVE_FAILED ${host}: ${error instanceof Error ? error.message : String(error)}`); }
  const endpoint = `${address.includes(":") ? `[${address}]` : address}:${RUNNER_PORT}`;
  if (!isPrivateListen(endpoint)) throw new Error(`RUNNER_LISTEN_REFUSED ${host} resolved to ${address}, which is not private`);
  return endpoint;
};
