import { createHash, randomBytes } from "node:crypto";
import type { SecretRule } from "../config.ts";
import { SECRET_NAME } from "../secret-name.ts";
import type { SecretStore } from "../secret-store.ts";
import { readSecretValue, ruleMatches, type SecretAuditEntry } from "./secret-grant.ts";

/**
 * The granting side of the browser fill proxy: issues opaque one-time secret handles to a lane (`secret.handle`) and
 * exchanges one for its value only for that lane's proxy, on a page origin the rule's `origins` lists. Handles live in
 * memory only. Audit lines carry names, lane, origin and `handleId`, never a value or a full handle.
 */

/** A secret handle: `dsh_` + 43 base64url chars (32 random bytes). */
export const SECRET_HANDLE_PATTERN = /^dsh_[A-Za-z0-9_-]{43}$/;

/** The audit id of `handle`: the first 12 hex chars of its sha256. */
export const handleId = (handle: string): string => createHash("sha256").update(handle).digest("hex").slice(0, 12);

/** The default handle lifetime: 5 minutes. */
export const SECRET_HANDLE_TTL_MS = 5 * 60 * 1000;
/** At most this many unused, unexpired handles per lane. */
export const SECRET_HANDLE_CAP = 16;

export type SecretHandlesDeps = {
  readonly store: Pick<SecretStore, "read">;
  readonly rules: () => Promise<Readonly<Record<string, SecretRule>>>;
  /** The lane's repo as "owner/repo", if it has one. */
  readonly laneRepo: (key: string) => Promise<string | undefined>;
  readonly audit: (entry: SecretAuditEntry) => void;
  readonly runner: string;
  readonly now: () => number;
  /** Handle lifetime in ms; default `SECRET_HANDLE_TTL_MS`. */
  readonly ttlMs?: number;
  /** 32 random bytes per handle; default `crypto.randomBytes(32)`. */
  readonly random?: () => Buffer;
  /** Called with the exchanged value, e.g. to register it for log masking. */
  readonly onGranted?: (values: readonly string[]) => void;
};

export type HandleIssue =
  | { readonly ok: true; readonly handle: string; readonly expiresAt: number }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export type HandleExchange =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: string; readonly detail: string };

type Bound = { readonly lane: string; readonly name: string; readonly origins: readonly string[]; readonly expiresAt: number; used: boolean };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The in-memory handle table; one per granting side (local runner, or supervisor for remote runners). */
export class SecretHandles {
  readonly #deps: SecretHandlesDeps;
  readonly #handles = new Map<string, Bound>();

  constructor(deps: SecretHandlesDeps) { this.#deps = deps; }

  #audit(kind: "handle.issue" | "handle.exchange", lane: string, name: string | undefined, allowed: boolean, extra: { handleId?: string; origin?: string; reason?: string }): void {
    this.#deps.audit({ at: new Date(this.#deps.now()).toISOString(), runner: this.#deps.runner, lane, names: name === undefined ? [] : [name], allowed, kind, ...extra });
  }

  /** Drops every handle whose expiry has passed. */
  #prune(now: number): void {
    for (const [handle, bound] of this.#handles) if (bound.expiresAt <= now) this.#handles.delete(handle);
  }

  /** Issues a handle for secret `name` to lane `key` when a rule with `origins` allows the lane; reads no value. */
  async issue(key: string, name: string): Promise<HandleIssue> {
    const now = this.#deps.now();
    this.#prune(now);
    const refuse = (code: string, detail: string, reason: string): HandleIssue => {
      this.#audit("handle.issue", key, name, false, { reason });
      return { ok: false, code, detail };
    };
    if (!SECRET_NAME.test(name)) return refuse("RUNNER_SECRET_DENIED", `${JSON.stringify(name)} is not a secret name`, "bad name");
    let rules: Readonly<Record<string, SecretRule>>;
    try { rules = await this.#deps.rules(); } catch (e) {
      return refuse("RUNNER_SECRET_FAILED", errorText(e), `config: ${errorText(e)}`);
    }
    const rule = Object.hasOwn(rules, name) ? rules[name] : undefined;
    if (!rule || !await ruleMatches(rule, key, () => this.#deps.laneRepo(key).catch(() => undefined))) {
      return refuse("RUNNER_SECRET_DENIED", `${key} may not receive ${name} (config secrets)`, `not allowed: ${name}`);
    }
    if (!rule.origins?.length) return refuse("RUNNER_SECRET_DENIED", `${name} has no origins, so it cannot be filled by the browser proxy (config secrets.${name}.origins)`, `no origins: ${name}`);
    let live = 0;
    for (const bound of this.#handles.values()) if (bound.lane === key && !bound.used) live += 1;
    if (live >= SECRET_HANDLE_CAP) return refuse("RUNNER_SECRET_DENIED", `${key} already holds ${SECRET_HANDLE_CAP} unused secret handles`, "too many handles");
    const handle = `dsh_${(this.#deps.random ?? (() => randomBytes(32)))().toString("base64url")}`;
    if (!SECRET_HANDLE_PATTERN.test(handle) || this.#handles.has(handle)) return refuse("RUNNER_SECRET_FAILED", "could not generate a secret handle", "bad random");
    const expiresAt = now + (this.#deps.ttlMs ?? SECRET_HANDLE_TTL_MS);
    this.#handles.set(handle, { lane: key, name, origins: [...rule.origins], expiresAt, used: false });
    this.#audit("handle.issue", key, name, true, { handleId: handleId(handle) });
    return { ok: true, handle, expiresAt };
  }

  /**
   * Exchanges `handle` for its value on behalf of lane `key`'s proxy, on page `origin`. A live handle is consumed by
   * the attempt whatever the outcome; the rule is read again, so a rule removed or narrowed since issue is honored.
   */
  async exchange(key: string, handle: string, origin: string): Promise<HandleExchange> {
    const now = this.#deps.now();
    const bound = this.#handles.get(handle);
    this.#prune(now);
    const id = handleId(handle);
    const name = bound?.name;
    const refuse = (code: string, detail: string, reason: string): HandleExchange => {
      this.#audit("handle.exchange", key, name, false, { handleId: id, origin, reason });
      return { ok: false, code, detail };
    };
    if (!bound) return refuse("RUNNER_SECRET_DENIED", `unknown secret handle ${id}`, "unknown");
    if (bound.expiresAt <= now) return refuse("RUNNER_SECRET_DENIED", `secret handle ${id} expired`, "expired");
    if (bound.used) return refuse("RUNNER_SECRET_DENIED", `secret handle ${id} was already used`, "used");
    bound.used = true;
    if (bound.lane !== key) return refuse("RUNNER_SECRET_DENIED", `secret handle ${id} was not issued to ${key}`, "wrong lane");
    let rules: Readonly<Record<string, SecretRule>>;
    try { rules = await this.#deps.rules(); } catch (e) {
      return refuse("RUNNER_SECRET_FAILED", errorText(e), `config: ${errorText(e)}`);
    }
    let repo: Promise<string | undefined> | undefined;
    const laneRepo = (): Promise<string | undefined> => (repo ??= this.#deps.laneRepo(key).catch(() => undefined));
    const rule = Object.hasOwn(rules, bound.name) ? rules[bound.name] : undefined;
    if (!rule?.origins || !await ruleMatches(rule, key, laneRepo)) {
      return refuse("RUNNER_SECRET_DENIED", `${key} may no longer receive ${bound.name} (config secrets)`, "rule gone");
    }
    if (!bound.origins.includes(origin) || !rule.origins.includes(origin)) {
      return refuse("RUNNER_SECRET_DENIED", `${bound.name} may not be filled on ${origin} (config secrets.${bound.name}.origins)`, "origin not allowed");
    }
    const read = await readSecretValue(this.#deps, bound.name, rule, key, laneRepo);
    if (!read.ok) return refuse(read.code, read.detail, read.reason);
    this.#audit("handle.exchange", key, bound.name, true, { handleId: id, origin });
    this.#deps.onGranted?.([read.value]);
    return { ok: true, value: read.value };
  }
}
