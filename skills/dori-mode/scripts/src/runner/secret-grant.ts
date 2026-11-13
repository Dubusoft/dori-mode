import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SecretRule } from "../config.ts";
import { GithubMintError, mintInstallationToken } from "../github-app-token.ts";
import type { Runner } from "../run.ts";
import { type SecretStore, SecretStoreError } from "../secret-store.ts";
import type { SecretGrant, SecretKind, SecretPutResult } from "./lane-socket.ts";
import type { SecretRunAuditEntry } from "./secret-run.ts";

/**
 * The runner side of the lane socket's `secret` verb: checks the requested names against the config `secrets`
 * allowlist (default deny), reads the values from the secret store and records one audit line per request. Audit
 * lines carry names, lane, runner and time only, never a value or anything derived from one.
 */

/** One audit line: who asked for which names and whether the runner handed them out. */
export type SecretAuditEntry = {
  readonly at: string; readonly runner: string; readonly lane: string; readonly names: readonly string[];
  readonly allowed: boolean; readonly reason?: string;
  /** Names whose value was minted (a GitHub App token) rather than read from the store. */
  readonly minted?: readonly string[];
  /** Set on a `dori secret put` line: the lane stored a value instead of reading one. */
  readonly put?: true;
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
  /** Mints a GitHub App installation token; defaults to `mintInstallationToken`. Injected by tests to stay offline. */
  readonly mint?: typeof mintInstallationToken;
  /**
   * Asks the owner to allow names config `secrets` denied this lane (owner-decisions.ts secretRequester); its sentence is
   * appended to the refusal. A failure only drops the sentence: the refusal stands either way.
   */
  readonly request?: (key: string, names: readonly string[], repo: string | undefined) => Promise<string>;
};

/** Where the runner appends its secret audit lines. */
export const secretAuditPath = (stateDir: string): string => join(stateDir, "secret-audit.jsonl");

/** Whether lane `key` matches one of `patterns`: an exact key or a `prefix-*`. */
export const laneMatches = (patterns: readonly string[], key: string): boolean =>
  patterns.some((p) => (p.endsWith("*") ? key.startsWith(p.slice(0, -1)) : p === key));

/** Whether lane `key` (repo from `laneRepo`, read only when `repos` is non-empty) matches a rule's `lanes` or `repos`. */
export const ruleMatches = async (rule: { readonly lanes: readonly string[]; readonly repos: readonly string[] }, key: string, laneRepo: () => Promise<string | undefined>): Promise<boolean> => {
  if (laneMatches(rule.lanes, key)) return true;
  const r = rule.repos.length ? (await laneRepo())?.toLowerCase() : undefined;
  return r !== undefined && rule.repos.some((p) => p.toLowerCase() === r);
};

/** Where a granted value comes from: the store, or a GitHub App mint for a rule with `mint`. */
export type SecretSource = { readonly store: Pick<SecretStore, "read">; readonly mint?: typeof mintInstallationToken };

/** One value read through `readSecretValue`, or the refusal with its audit reason. */
export type SecretRead =
  | { readonly ok: true; readonly value: string; readonly minted: boolean }
  | { readonly ok: false; readonly code: string; readonly detail: string; readonly reason: string };

/**
 * Reads `name` for lane `key` (no allowlist check: the caller decided): a rule with `mint` mints a token for the lane
 * repo with the App key `keySecret` from the store (never handed out itself), any other name is read from the store.
 * Refusals name names and lanes only.
 */
export const readSecretValue = async (src: SecretSource, name: string, rule: SecretRule | undefined, key: string, laneRepo: () => Promise<string | undefined>): Promise<SecretRead> => {
  const spec = rule?.mint;
  let reading = name;
  try {
    if (!spec) return { ok: true, value: await src.store.read(name), minted: false };
    const lane = await laneRepo();
    if (lane === undefined) return { ok: false, code: "RUNNER_SECRET_DENIED", detail: `${name} is minted per repo and lane ${key} has no repo`, reason: `no repo: ${name}` };
    reading = spec.keySecret;
    const privateKeyPem = await src.store.read(spec.keySecret);
    reading = name;
    const minted = await (src.mint ?? mintInstallationToken)({ appId: spec.appId, installationId: spec.installationId, privateKeyPem, repo: lane, permissions: spec.permissions });
    return { ok: true, value: minted.token, minted: true };
  } catch (e) {
    if (e instanceof GithubMintError) return { ok: false, code: "RUNNER_SECRET_FAILED", detail: e.message, reason: `mint failed: ${name}` };
    if (e instanceof SecretStoreError && e.code === "SECRET_MISSING" && reading !== name) {
      return { ok: false, code: "RUNNER_SECRET_MISSING", detail: `${reading} (App key for ${name}) is not in the secret store`, reason: `missing: ${reading}` };
    }
    if (e instanceof SecretStoreError && e.code === "SECRET_MISSING") {
      return { ok: false, code: "RUNNER_SECRET_MISSING", detail: `${name} is not in the secret store`, reason: `missing: ${name}` };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code: "RUNNER_SECRET_FAILED", detail: message, reason: `read failed: ${reading}` };
  }
};

/** The `secrets` handler for the lane socket: grants all of `names` to lane `key`, or refuses the whole request. */
export const secretGranter = (deps: SecretGranterDeps) => async (key: string, names: readonly string[]): Promise<SecretGrant> => {
  const minted: string[] = [];
  const audit = (allowed: boolean, reason?: string): void => {
    deps.audit({ at: new Date(deps.now()).toISOString(), runner: deps.runner, lane: key, names: [...names], allowed, ...(reason !== undefined ? { reason } : {}), ...(minted.length ? { minted: [...minted] } : {}) });
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
    if (!rule || !await ruleMatches(rule, key, laneRepo)) denied.push(name);
  }
  if (denied.length) {
    const list = denied.join(",");
    const asked = deps.request ? await laneRepo().then((r) => deps.request?.(key, denied, r)).catch(() => undefined) : undefined;
    return refuse("RUNNER_SECRET_DENIED", `${key} may not receive ${list} (config secrets)${asked ? `; ${asked}` : ""}`, `not allowed: ${list}`);
  }
  const values: Record<string, string> = {};
  const kinds: Record<string, Exclude<SecretKind, "env">> = {};
  for (const name of names) {
    const rule = rules[name] as SecretRule;
    const read = await readSecretValue(deps, name, rule, key, laneRepo);
    if (!read.ok) return refuse(read.code, read.detail, read.reason);
    values[name] = read.value;
    if (read.minted) minted.push(name);
    if (rule.as === "ssh-key" || rule.as === "file") kinds[name] = rule.as;
  }
  audit(true);
  deps.onGranted?.(Object.values(values));
  return { ok: true, values, ...(Object.keys(kinds).length ? { kinds } : {}) };
};

export type SecretDepositorDeps = Omit<SecretGranterDeps, "store" | "mint" | "request" | "onGranted"> & {
  readonly store: Pick<SecretStore, "put">;
  /** Called with the stored value, e.g. to register it for log masking. */
  readonly onStored?: (value: string) => void;
};

/**
 * The `secretPut` handler for the lane socket: stores `value` under `name` for lane `key` when the name's rule has a
 * `put` entry matching the lane, else `RUNNER_SECRET_DENIED`. Write only: it grants no read, so the lane gets the value
 * back through `secret exec` only when the rule's own `lanes`/`repos` allow it. One audit line per request (`put: true`),
 * never the value.
 */
export const secretDepositor = (deps: SecretDepositorDeps) => async (key: string, name: string, value: string): Promise<SecretPutResult> => {
  const audit = (allowed: boolean, reason?: string): void => {
    deps.audit({ at: new Date(deps.now()).toISOString(), runner: deps.runner, lane: key, names: [name], allowed, put: true, ...(reason !== undefined ? { reason } : {}) });
  };
  const refuse = (code: string, detail: string, reason: string): SecretPutResult => {
    audit(false, reason);
    return { ok: false, code, detail };
  };
  let rules: Readonly<Record<string, SecretRule>>;
  try { rules = await deps.rules(); } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return refuse("RUNNER_SECRET_FAILED", message, `config: ${message}`);
  }
  const put = Object.hasOwn(rules, name) ? rules[name]?.put : undefined;
  if (!put || !await ruleMatches(put, key, () => deps.laneRepo(key).catch(() => undefined))) {
    return refuse("RUNNER_SECRET_DENIED", `${key} may not store ${name} (config secrets.${name}.put)`, `put not allowed: ${name}`);
  }
  try {
    const entry = await deps.store.put(name, value);
    audit(true);
    deps.onStored?.(value);
    return { ok: true, created: entry.created, backend: entry.backend };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return refuse("RUNNER_SECRET_FAILED", message, `write failed: ${name}`);
  }
};

/**
 * An audit function that appends one JSON line per entry to `path`; a new file is created with mode 0600 (and its
 * directory 0700 when missing). A write
 * failure goes to `log` and is not thrown.
 */
export const appendSecretAudit = (path: string, log: (line: string) => void = () => {}) => (entry: SecretAuditEntry | SecretRunAuditEntry): void => {
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
