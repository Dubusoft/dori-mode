import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SecretRule } from "../config.ts";
import type { Runner } from "../run.ts";
import { type SecretStore, SecretStoreError } from "../secret-store.ts";
import type { SecretGrant } from "./lane-socket.ts";

/**
 * The runner side of the lane socket's `secret` verb: checks the requested names against the config `secrets`
 * allowlist (default deny), reads the values from the secret store and records one audit line per request. Audit
 * lines carry names, lane, runner and time only, never a value or anything derived from one.
 */

/** One audit line: who asked for which names and whether the runner handed them out. */
export type SecretAuditEntry = {
  readonly at: string; readonly runner: string; readonly lane: string; readonly names: readonly string[];
  readonly allowed: boolean; readonly reason?: string;
};

export type SecretGranterDeps = {
  readonly store: Pick<SecretStore, "read">;
  readonly rules: () => Promise<Readonly<Record<string, SecretRule>>>;
  /** The lane's repo as "owner/repo", if it has one. */
  readonly laneRepo: (key: string) => Promise<string | undefined>;
  readonly audit: (entry: SecretAuditEntry) => void;
  readonly runner: string;
  readonly now: () => number;
  /** Called with the granted values, e.g. to register them for log masking. */
  readonly onGranted?: (values: readonly string[]) => void;
};

/** Where the runner appends its secret audit lines. */
export const secretAuditPath = (stateDir: string): string => join(stateDir, "secret-audit.jsonl");

const laneMatches = (patterns: readonly string[], key: string): boolean =>
  patterns.some((p) => (p.endsWith("*") ? key.startsWith(p.slice(0, -1)) : p === key));

/** The `secrets` handler for the lane socket: grants all of `names` to lane `key`, or refuses the whole request. */
export const secretGranter = (deps: SecretGranterDeps) => async (key: string, names: readonly string[]): Promise<SecretGrant> => {
  const audit = (allowed: boolean, reason?: string): void => {
    deps.audit({ at: new Date(deps.now()).toISOString(), runner: deps.runner, lane: key, names: [...names], allowed, ...(reason !== undefined ? { reason } : {}) });
  };
  const refuse = (code: string, detail: string, reason: string): SecretGrant => {
    audit(false, reason);
    return { ok: false, code, detail };
  };
  let rules: Readonly<Record<string, SecretRule>>;
  try { rules = await deps.rules(); } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return refuse("RUNNER_SECRET_FAILED", message, `config: ${message}`);
  }
  let repo: Promise<string | undefined> | undefined;
  const laneRepo = (): Promise<string | undefined> => (repo ??= deps.laneRepo(key).catch(() => undefined));
  const denied: string[] = [];
  for (const name of names) {
    const rule = Object.hasOwn(rules, name) ? rules[name] : undefined;
    if (rule && laneMatches(rule.lanes, key)) continue;
    const r = rule && rule.repos.length ? (await laneRepo())?.toLowerCase() : undefined;
    if (rule && r !== undefined && rule.repos.some((p) => p.toLowerCase() === r)) continue;
    denied.push(name);
  }
  if (denied.length) {
    const list = denied.join(",");
    return refuse("RUNNER_SECRET_DENIED", `${key} may not receive ${list} (config secrets)`, `not allowed: ${list}`);
  }
  const values: Record<string, string> = {};
  for (const name of names) {
    try {
      values[name] = await deps.store.read(name);
    } catch (e) {
      if (e instanceof SecretStoreError && e.code === "SECRET_MISSING") {
        return refuse("RUNNER_SECRET_MISSING", `${name} is not in the secret store`, `missing: ${name}`);
      }
      const message = e instanceof Error ? e.message : String(e);
      return refuse("RUNNER_SECRET_FAILED", message, `read failed: ${name}`);
    }
  }
  audit(true);
  deps.onGranted?.(Object.values(values));
  return { ok: true, values };
};

/**
 * An audit function that appends one JSON line per entry to `path`; a new file is created with mode 0600 (and its
 * directory 0700 when missing). A write
 * failure goes to `log` and is not thrown.
 */
export const appendSecretAudit = (path: string, log: (line: string) => void = () => {}) => (entry: SecretAuditEntry): void => {
  try {
    const created = !existsSync(path);
    if (created) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (created) chmodSync(path, 0o600);
  } catch (e) {
    log(`RUNNER_SECRET_AUDIT_FAILED ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** "owner/repo" from a GitHub-style remote URL (https, scp-like ssh or ssh://), else undefined. */
export const repoFromRemote = (url: string): string | undefined => {
  const u = url.trim();
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u)
    ?? /^[^@/\s]+@[^:/\s]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u)
    ?? /^ssh:\/\/(?:[^@/]+@)?[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  return m ? `${m[1]}/${m[2]}` : undefined;
};

/** The lane's repo from `git remote get-url origin` in its cwd; undefined without a cwd, an origin or a parseable URL. */
export const laneRepoOf = (run: Runner, cwdOf: (key: string) => string | undefined) => async (key: string): Promise<string | undefined> => {
  const cwd = cwdOf(key);
  if (cwd === undefined) return undefined;
  const result = await run(["git", "-C", cwd, "remote", "get-url", "origin"]);
  return result.code === 0 ? repoFromRemote(result.out) : undefined;
};
