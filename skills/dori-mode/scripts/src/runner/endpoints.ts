import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { writeRunnerFile } from "./fs-safety.ts";
import { LABEL_PATTERN } from "./protocol.ts";
import { isPrivateListen } from "./ws-transport.ts";

export const RUNNER_ENDPOINTS_FILE = "runner-endpoints.json";
export const RUNNER_PORT = 7411;

const endpointCache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly endpoints: Record<string, string> }>();

/** Supervisor-owned discovery, separate from config.json. Values are private IP host:port addresses. */
export const readRunnerEndpoints = (stateDir: string): Record<string, string> => {
  const path = join(stateDir, RUNNER_ENDPOINTS_FILE);
  if (!existsSync(path)) {
    endpointCache.delete(path);
    return {};
  }
  const { mtimeMs, size } = statSync(path);
  const cached = endpointCache.get(path);
  if (cached?.mtimeMs === mtimeMs && cached.size === size) return { ...cached.endpoints };
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.entries(value).some(([label, endpoint]) => !LABEL_PATTERN.test(label) || typeof endpoint !== "string" || !isPrivateListen(endpoint))) {
    throw new Error(`RUNNER_ENDPOINTS_INVALID ${path}: expected label -> private host:port`);
  }
  const endpoints = value as Record<string, string>;
  endpointCache.set(path, { mtimeMs, size, endpoints });
  return { ...endpoints };
};

/** Atomically preserve other labels and replace this endpoint; the file is mode 0600. */
export const writeRunnerEndpoint = (stateDir: string, label: string, endpoint: string): void => {
  if (!LABEL_PATTERN.test(label) || !isPrivateListen(endpoint)) throw new Error(`RUNNER_LISTEN_REFUSED ${label} ${endpoint}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, RUNNER_ENDPOINTS_FILE);
  writeRunnerFile(path, `${JSON.stringify({ ...readRunnerEndpoints(stateDir), [label]: endpoint }, null, 2)}\n`);
  endpointCache.delete(path);
};

/** Atomically drop this label's endpoint, keeping the others; no file or no entry is a no-op. */
export const removeRunnerEndpoint = (stateDir: string, label: string): void => {
  const { [label]: gone, ...rest } = readRunnerEndpoints(stateDir);
  if (gone === undefined) return;
  const path = join(stateDir, RUNNER_ENDPOINTS_FILE);
  writeRunnerFile(path, `${JSON.stringify(rest, null, 2)}\n`);
  endpointCache.delete(path);
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
