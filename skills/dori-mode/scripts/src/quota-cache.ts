import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { lookupQuotaResults, type QuotaResult, type UsageLookup } from "./claude-quota.ts";
import { displayTime } from "./display-time.ts";
import { acquireStateLock, StateLockError } from "./state-lock.ts";

/**
 * One quota read shared by every caller (the autopilot judge, `dori quota`, Discord `/quota`) through a file in the
 * state dir, so the supervisor and CLI invocations together stay well under the usage endpoints' rate limit:
 *
 * - A read younger than the TTL is served from the file without calling the endpoints.
 * - An expired read is refreshed by one caller under a state lock; the others wait for it and reuse its answer, or
 *   serve the old file when the lock is not free within LOCK_WAIT_MS.
 * - An account that answers HTTP 429 backs off for its Retry-After (DEFAULT_BACKOFF_SEC when absent). pi-quota reads
 *   every account in one lookup, so no lookup runs at all until every backoff has passed; meanwhile each account is
 *   served from its last answer, and a rate-limited account from its last good read.
 * - A good read older than STALE_READ_MAX_MS is no longer served as usage: the account reads as `stale-read`, so the
 *   judge holds `quota-unreadable` once no account has a read that recent.
 */

/** Seconds an account backs off after a 429 that carried no Retry-After. */
export const DEFAULT_BACKOFF_SEC = 300;

/**
 * The oldest good read still served as usage. Quota windows move slowly (5 h and 7 d), so a read under 30 minutes old
 * still decides a launch; past that the account counts as unreadable.
 */
export const STALE_READ_MAX_MS = 30 * 60_000;

export const quotaCachePath = (stateDir: string): string => join(stateDir, "quota-cache.json");

type Stamped = { readonly at: number; readonly result: QuotaResult };

type CacheEntry = {
  /** The account's answer from the last lookup. */
  readonly latest: Stamped;
  /** Its last answer with usage windows. */
  readonly good?: Stamped;
  /** Epoch ms before which no lookup runs, after a 429. */
  readonly backoffUntil?: number;
};

type CacheFile = { readonly version: 1; readonly fetchedAt: number; readonly text: string; readonly entries: Readonly<Record<string, CacheEntry>> };

/** Where a served read came from. */
export type QuotaCacheNote = {
  /** When the endpoints were last called. */
  readonly fetchedAt: number;
  /** This call ran the lookup itself. */
  readonly refreshed: boolean;
  /** Accounts backing off after a 429, with the time their backoff ends. */
  readonly backoff: readonly { readonly name: string; readonly until: number }[];
  /** Accounts served from a read older than the TTL (a 429 fallback, or no lookup during a backoff), with its time. */
  readonly stale: readonly { readonly name: string; readonly at: number }[];
};

const nameOf = (r: QuotaResult): string => r.account || r.provider;
const keyOf = (r: QuotaResult): string => `${r.provider}/${r.account ?? ""}`;
const isGood = (r: QuotaResult): boolean => r.kind === "success" && (r.windows ?? []).length > 0;

const isRateLimited = (r: QuotaResult): boolean => {
  if (r.kind !== "failure" || typeof r.reason !== "object" || r.reason === null) return false;
  const { type, status } = r.reason as { type?: unknown; status?: unknown };
  return type === "http-error" && status === 429;
};

const readCache = (path: string): CacheFile | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
    return parsed.version === 1 && typeof parsed.fetchedAt === "number" && typeof parsed.text === "string" && parsed.entries && typeof parsed.entries === "object"
      ? parsed as CacheFile : undefined;
  } catch { return undefined; }
};

const writeCache = (path: string, file: CacheFile): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
  renameSync(tmp, path);
};

const backingOff = (file: CacheFile, now: number): boolean => Object.values(file.entries).some((e) => (e.backoffUntil ?? 0) > now);

/** The file still answers without a lookup: within the TTL, or some account is backing off. */
const servable = (file: CacheFile | undefined, now: number, ttlMs: number): file is CacheFile =>
  file !== undefined && (now - file.fetchedAt < ttlMs || backingOff(file, now));

/** The lookup's answers laid over the previous file. An account the lookup no longer reports is dropped. */
const merge = (prev: CacheFile | undefined, looked: { readonly results: readonly QuotaResult[]; readonly text: string }, now: number): CacheFile => {
  const entries: Record<string, CacheEntry> = {};
  for (const result of looked.results) {
    const key = keyOf(result);
    const good = isGood(result) ? { at: now, result } : prev?.entries[key]?.good;
    const backoffUntil = isRateLimited(result) ? now + (result.retryAfterSeconds ?? DEFAULT_BACKOFF_SEC) * 1000 : undefined;
    entries[key] = { latest: { at: now, result }, ...(good ? { good } : {}), ...(backoffUntil !== undefined ? { backoffUntil } : {}) };
  }
  return { version: 1, fetchedAt: now, text: looked.text, entries };
};

const serve = (file: CacheFile, now: number, ttlMs: number, refreshed: boolean) => {
  const results: QuotaResult[] = [];
  const stale: { name: string; at: number }[] = [];
  const backoff: { name: string; until: number }[] = [];
  for (const entry of Object.values(file.entries)) {
    const { latest, good } = entry;
    if ((entry.backoffUntil ?? 0) > now) backoff.push({ name: nameOf(latest.result), until: entry.backoffUntil ?? 0 });
    const served = isRateLimited(latest.result) && good ? good : latest;
    if (!isGood(served.result)) { results.push(served.result); continue; }
    if (now - served.at > STALE_READ_MAX_MS) {
      results.push({ kind: "unavailable", provider: served.result.provider, ...(served.result.account !== undefined ? { account: served.result.account } : {}), reason: "stale-read" });
      continue;
    }
    if (now - served.at >= ttlMs) stale.push({ name: nameOf(served.result), at: served.at });
    results.push(served.result);
  }
  const cache: QuotaCacheNote = { fetchedAt: file.fetchedAt, refreshed, backoff, stale };
  return { results, text: file.text, cache };
};

export type QuotaCacheOptions = { readonly path: string; readonly ttlMs: number; readonly now: () => number };

/** `lookup` behind the shared cache file at `path` (see the module comment). */
export const cachedQuotaLookup = (lookup: UsageLookup, { path, ttlMs, now }: QuotaCacheOptions): UsageLookup => async (signal) => {
  const first = readCache(path);
  if (servable(first, now(), ttlMs)) return serve(first, now(), ttlMs, false);
  let release: () => void;
  try {
    release = await acquireStateLock(`${path}.lock`);
  } catch (e) {
    // Another caller is still refreshing: its old answer is better than a second lookup.
    if (e instanceof StateLockError && first) return serve(first, now(), ttlMs, false);
    throw e;
  }
  try {
    const current = readCache(path);
    if (servable(current, now(), ttlMs)) return serve(current, now(), ttlMs, false);
    const looked = await lookup(signal);
    const merged = merge(current, looked, now());
    writeCache(path, merged);
    return serve(merged, merged.fetchedAt, ttlMs, true);
  } finally {
    release();
  }
};

/** The live quota lookup every dori caller shares: pi-quota behind the cache in `stateDir`. */
export const sharedQuotaLookup = (config: { readonly stateDir: string; readonly autopilot: { readonly quotaCacheSec: number } }): UsageLookup =>
  cachedQuotaLookup(lookupQuotaResults(), { path: quotaCachePath(config.stateDir), ttlMs: config.autopilot.quotaCacheSec * 1000, now: Date.now });

export const ageText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** Lines saying a read came from the cache, which accounts are stale and which back off after a 429; none for a fresh read. */
export const cacheNoteLines = (note: QuotaCacheNote | undefined, now: number, timeZone?: string): string[] => {
  if (!note) return [];
  return [
    ...(note.refreshed ? [] : [`QUOTA | cached read from ${ageText(now - note.fetchedAt)} ago`]),
    ...note.stale.map((s) => `QUOTA | ${s.name}: stale, last good read ${ageText(now - s.at)} ago`),
    ...note.backoff.map((b) => `QUOTA | ${b.name}: rate-limited (HTTP 429), no usage call until ${displayTime(b.until, timeZone, "short")}`),
  ];
};
