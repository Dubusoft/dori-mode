import type { Runner } from "../run.ts";
import { type SecretStore, SecretStoreError } from "../secret-store.ts";
import type { SecretGrant } from "./lane-socket.ts";

/** Match the lanes or repositories allowed to run a host operation. */
export const laneMatches = (patterns: readonly string[], key: string): boolean =>
  patterns.some((p) => (p.endsWith("*") ? key.startsWith(p.slice(0, -1)) : p === key));

/** Whether lane `key` (repo from `laneRepo`, read only when `repos` is non-empty) matches a rule's `lanes` or `repos`. */
export const ruleMatches = async (rule: { readonly lanes: readonly string[]; readonly repos: readonly string[] }, key: string, laneRepo: () => Promise<string | undefined>): Promise<boolean> => {
  if (laneMatches(rule.lanes, key)) return true;
  const r = rule.repos.length ? (await laneRepo())?.toLowerCase() : undefined;
  return r !== undefined && rule.repos.some((p) => p.toLowerCase() === r);
};

export type SecretSource = { readonly store: Pick<SecretStore, "read"> };

/** Read one store value for a host operation. */
export const readSecretValue = async (src: SecretSource, name: string): Promise<{ readonly ok: true; readonly value: string } | { readonly ok: false; readonly code: string; readonly detail: string }> => {
  try { return { ok: true, value: await src.store.read(name) }; }
  catch (e) {
    if (e instanceof SecretStoreError && e.code === "SECRET_MISSING") return { ok: false, code: "RUNNER_SECRET_MISSING", detail: `${name} is not in the secret store` };
    return { ok: false, code: "RUNNER_SECRET_FAILED", detail: e instanceof Error ? e.message : String(e) };
  }
};

export type SecretGranterDeps = {
  readonly store: Pick<SecretStore, "readAll" | "read">;
  readonly onGranted?: (values: readonly string[]) => void;
};

/** Every store value; named requests from older remote runners read just those names. */
export const secretGranter = (deps: SecretGranterDeps) => async (_key: string, names: readonly string[] = []): Promise<SecretGrant> => {
  try {
    const values: Record<string, string> = {};
    if (names.length) {
      for (const name of names) {
        const read = await readSecretValue(deps, name);
        if (!read.ok) return read;
        values[name] = read.value;
      }
    } else Object.assign(values, Object.fromEntries(await deps.store.readAll(true)));
    deps.onGranted?.(Object.values(values));
    return { ok: true, values };
  } catch (e) { return { ok: false, code: "RUNNER_SECRET_FAILED", detail: e instanceof Error ? e.message : String(e) }; }
};

/** Registers every readable store value for masking; a store that cannot be read at all is logged as RUNNER_SECRET_MASK_FAILED. */
export const maskStoreSecrets = async (store: Pick<SecretStore, "readAll">, register: (values: Iterable<string>) => void, log: (line: string) => void): Promise<void> => {
  try { register((await store.readAll()).values()); }
  catch (e) { log(`RUNNER_SECRET_MASK_FAILED ${e instanceof Error ? e.message : String(e)}`); }
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
