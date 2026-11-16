import { homedir } from "node:os";
import { join } from "node:path";

import { displayTime } from "./display-time.ts";
import { cacheNoteLines, type QuotaCacheNote } from "./quota-presentation.ts";

/** The subset of pi-quota's ProviderResult this module reads. */
export type QuotaResult = {
  readonly kind: string;
  readonly provider: string;
  readonly account?: string;
  /** Why an unavailable or failed result has no usage: a string, or `{ type, status? }` for a failure. */
  readonly reason?: unknown;
  /** A failed request's Retry-After, in seconds. */
  readonly retryAfterSeconds?: number;
  readonly windows?: readonly { readonly label: string; readonly remainingPercent: number; readonly resetAt?: Date | string }[];
};

/** Percent used (0-100) and the reset time (epoch ms) of one Claude window. */
export type ClaudeWindow = { readonly usedPct: number; readonly resetAt?: number };

/** One Claude account's windows; absent windows were not reported. */
export type ClaudeAccount = { readonly name: string; readonly fiveHour?: ClaudeWindow; readonly weekly?: ClaudeWindow };

/** Claude subscription usage of every account that answered (see classifyClaude). */
export type ClaudeUsage = { readonly at: number; readonly accounts: readonly ClaudeAccount[] };

const CLAUDE_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "claude-sdk-oauth"]);

/** pi-quota's provider id for each host provider id (pi-quota's own HOST_PROVIDER_IDS, inverted). */
const QUOTA_PROVIDER_OF: Readonly<Record<string, string>> = {
  "anthropic-subscription": "claude-sdk-oauth", "claude-sdk-oauth": "claude-sdk-oauth", anthropic: "anthropic",
  "chatgpt-subscription": "openai-codex", "openai-codex": "openai-codex",
};

/**
 * The pi-quota provider that serves `model` ("anthropic-subscription/claude-opus-5-5"): one id, or none when the
 * model names no provider or pi-quota cannot read its quota.
 */
export const quotaProvidersFor = (model: string): ReadonlySet<string> => {
  const provider = model.includes("/") ? QUOTA_PROVIDER_OF[model.slice(0, model.indexOf("/"))] : undefined;
  return new Set(provider ? [provider] : []);
};

const windowOf = (w: NonNullable<QuotaResult["windows"]>[number]): ClaudeWindow => {
  const usedPct = Math.round(Math.min(100, Math.max(0, 100 - (Number.isFinite(w.remainingPercent) ? w.remainingPercent : 0))));
  const reset = w.resetAt === undefined ? NaN : new Date(w.resetAt).getTime();
  return { usedPct, ...(Number.isFinite(reset) ? { resetAt: reset } : {}) };
};

const FIVE_HOUR = /five|5\s*h/i;
const WEEKLY = /week|7\s*d/i;

/** A Claude account whose usage could not be read (expired token, failed request, no window), so it is left out. */
export type ClaudeSkip = { readonly name: string; readonly reason: string };

const skipReason = (r: QuotaResult): string => {
  if (typeof r.reason === "string") return r.reason;
  if (typeof r.reason === "object" && r.reason !== null) {
    const { type, status } = r.reason as { type?: unknown; status?: unknown };
    if (typeof type === "string") return typeof status === "number" ? `${type} ${status}` : type;
  }
  return r.kind === "success" ? "no-quota-windows" : r.kind;
};

/**
 * Splits pi-quota results by account of `providers` (default: anthropic and claude-sdk-oauth). `usage` has every account
 * that answered with a 5h or 7d window (undefined when none did); `skipped` has every other one, with why, and the readable
 * accounts alone decide the usage. A provider nobody signed into (unlabelled oauth-not-configured) is not an account and
 * is not listed.
 */
export const classifyClaude = (results: readonly QuotaResult[], at: number, providers = CLAUDE_PROVIDERS): { usage?: ClaudeUsage; skipped: ClaudeSkip[] } => {
  const accounts: ClaudeAccount[] = [];
  const skipped: ClaudeSkip[] = [];
  for (const r of results) {
    if (!providers.has(r.provider)) continue;
    const name = r.account || r.provider;
    let fiveHour: ClaudeWindow | undefined;
    let weekly: ClaudeWindow | undefined;
    for (const w of r.kind === "success" ? r.windows ?? [] : []) {
      if (FIVE_HOUR.test(w.label)) fiveHour = windowOf(w);
      else if (WEEKLY.test(w.label) && !weekly) weekly = windowOf(w);
    }
    if (fiveHour || weekly) accounts.push({ name, ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) });
    else if (!(r.account === undefined && r.reason === "oauth-not-configured")) skipped.push({ name, reason: skipReason(r) });
  }
  return { ...(accounts.length ? { usage: { at, accounts } } : {}), skipped };
};

/** "default (token-expired), account-3 (http-error 429)". */
export const skippedText = (skipped: readonly ClaudeSkip[]): string => skipped.map((s) => `${s.name} (${s.reason})`).join(", ");

/**
 * Time left until a reset, in pi-quota's format: whole days plus whole hours ("2d 6h", days alone when no hour
 * remains) from 24h up, half-hours below 24h, whole minutes below 1h. Every step rounds down.
 */
export const resetIn = (resetAt: number, now: number): string => {
  if (resetAt - now <= 0) return "now";
  const totalMinutes = Math.floor((resetAt - now) / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const days = Math.floor(totalMinutes / 1440);
  if (days > 0) {
    const hours = Math.floor((totalMinutes % 1440) / 60);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  return `${Math.floor(totalMinutes / 30) / 2}h`;
};

const windowText = (name: string, w: ClaudeWindow, now: number, timeZone: string | undefined): string =>
  `${name} ${w.usedPct}% used${w.resetAt !== undefined ? ` (resets in ${resetIn(w.resetAt, now)}, ${displayTime(w.resetAt, timeZone, "short")})` : ""}`;

/** One line: "QUOTA | Claude default: 5h 85% used (resets in 3h, ...), 7d 40% used | login-2: 7d 10% used". Usage only, no verdict. */
export const usageLine = (usage: ClaudeUsage, timeZone?: string): string =>
  `QUOTA | Claude ${usage.accounts.map((a) => `${a.name}: ${[
    ...(a.fiveHour ? [windowText("5h", a.fiveHour, usage.at, timeZone)] : []),
    ...(a.weekly ? [windowText("7d", a.weekly, usage.at, timeZone)] : []),
  ].join(", ")}`).join(" | ")}`;

export const NO_CLAUDE = "QUOTA | no Claude subscription usage reported";

/** A Claude usage read: pi-quota's results plus its formatted text, and where a cached read came from (quota-cache.ts). */
export type UsageLookup = (signal: AbortSignal) => Promise<{ readonly results: readonly QuotaResult[]; readonly text: string; readonly cache?: QuotaCacheNote }>;

/** pi-quota through senpi's native auth storage (omo's accounts, no session or model turn). */
export const lookupQuotaResults = (agentDir = join(homedir(), ".omo", "agent")): UsageLookup => async (signal) => {
  const { ModelRuntime, ModelRegistry } = await import("@code-yeongyu/senpi");
  const { lookupQuota } = await import("pi-quota");
  signal.throwIfAborted();
  const runtime = await ModelRuntime.create({
    agentDir,
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
    signal,
  });
  return lookupQuota(new ModelRegistry(runtime, runtime.authStorage), signal);
};

/** pi-quota's text, the Claude usage when a Claude account answered, and the Claude accounts left out. */
export type UsageRead = { readonly text: string; readonly usage?: ClaudeUsage; readonly skipped: readonly ClaudeSkip[]; readonly cache?: QuotaCacheNote };

/** `providers` narrows which pi-quota providers count (default: the Claude ones, see classifyClaude). */
export const readUsage = async (lookup: UsageLookup, now: number, signal: AbortSignal, providers = CLAUDE_PROVIDERS): Promise<UsageRead> => {
  const { results, text, cache } = await lookup(signal);
  return { text, ...classifyClaude(results, now, providers), ...(cache ? { cache } : {}) };
};

/**
 * The `/quota` text: pi-quota's own usage block (it already shows reset times), after lines saying when it came from
 * the cache, which accounts are stale and which back off after a 429.
 */
export const quotaReport = (lookup: UsageLookup, timeZone?: string, now: () => number = Date.now) => async (signal: AbortSignal): Promise<string> => {
  const { text, cache } = await lookup(signal);
  const notes = cacheNoteLines(cache, now(), timeZone);
  return notes.length ? `${notes.join("\n")}\n\n${text}` : text;
};
