import { homedir } from "node:os";
import { join } from "node:path";

import { displayTime } from "./display-time.ts";

/** The subset of pi-quota's ProviderResult this module reads. */
export type QuotaResult = {
  readonly kind: string;
  readonly provider: string;
  readonly account?: string;
  /** Why an unavailable or failed result has no usage: a string, or `{ type, status? }` for a failure. */
  readonly reason?: unknown;
  readonly windows?: readonly { readonly label: string; readonly remainingPercent: number; readonly resetAt?: Date | string }[];
};

/** Percent used (0-100) and the reset time (epoch ms) of one Claude window. */
export type ClaudeWindow = { readonly usedPct: number; readonly resetAt?: number };

/** One Claude account's windows; absent windows were not reported. */
export type ClaudeAccount = { readonly name: string; readonly fiveHour?: ClaudeWindow; readonly weekly?: ClaudeWindow };

/** Claude subscription usage of every account that answered (see claudeUsage). */
export type ClaudeUsage = { readonly at: number; readonly accounts: readonly ClaudeAccount[] };

const CLAUDE_PROVIDERS = new Set(["anthropic", "claude-sdk-oauth"]);

const windowOf = (w: NonNullable<QuotaResult["windows"]>[number]): ClaudeWindow => {
  const usedPct = Math.round(Math.min(100, Math.max(0, 100 - (Number.isFinite(w.remainingPercent) ? w.remainingPercent : 0))));
  const reset = w.resetAt === undefined ? NaN : new Date(w.resetAt).getTime();
  return { usedPct, ...(Number.isFinite(reset) ? { resetAt: reset } : {}) };
};

const FIVE_HOUR = /five|5\s*h/i;
const WEEKLY = /week|7\s*d/i;

/**
 * Claude usage from pi-quota results: every anthropic or claude-sdk-oauth account that answered with a 5h or 7d
 * window. Undefined when no Claude account answered.
 */
export const claudeUsage = (results: readonly QuotaResult[], at: number): ClaudeUsage | undefined => {
  const accounts: ClaudeAccount[] = [];
  for (const r of results) {
    if (r.kind !== "success" || !CLAUDE_PROVIDERS.has(r.provider)) continue;
    let fiveHour: ClaudeWindow | undefined;
    let weekly: ClaudeWindow | undefined;
    for (const w of r.windows ?? []) {
      if (FIVE_HOUR.test(w.label)) fiveHour = windowOf(w);
      else if (WEEKLY.test(w.label) && !weekly) weekly = windowOf(w);
    }
    if (!fiveHour && !weekly) continue;
    accounts.push({ name: r.account || r.provider, ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) });
  }
  return accounts.length ? { at, accounts } : undefined;
};

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
 * Every Claude account claudeUsage leaves out, with why; the readable accounts alone decide the usage. A provider
 * nobody signed into (unlabelled oauth-not-configured) is not an account and is not listed.
 */
export const skippedClaudeAccounts = (results: readonly QuotaResult[]): ClaudeSkip[] =>
  results
    .filter((r) => CLAUDE_PROVIDERS.has(r.provider) && !(r.account === undefined && r.reason === "oauth-not-configured")
      && (r.kind !== "success" || !(r.windows ?? []).some((w) => FIVE_HOUR.test(w.label) || WEEKLY.test(w.label))))
    .map((r) => ({ name: r.account || r.provider, reason: skipReason(r) }));

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

/** A Claude usage read: pi-quota's results plus its formatted text. */
export type UsageLookup = (signal: AbortSignal) => Promise<{ readonly results: readonly QuotaResult[]; readonly text: string }>;

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
export type UsageRead = { readonly text: string; readonly usage?: ClaudeUsage; readonly skipped: readonly ClaudeSkip[] };

export const readUsage = async (lookup: UsageLookup, now: number, signal: AbortSignal): Promise<UsageRead> => {
  const { results, text } = await lookup(signal);
  const usage = claudeUsage(results, now);
  const skipped = skippedClaudeAccounts(results);
  return usage ? { text, usage, skipped } : { text, skipped };
};

/** The `/quota` text: pi-quota's own usage block only (it already shows reset times). */
export const quotaReport = (lookup: UsageLookup) => async (signal: AbortSignal): Promise<string> => (await lookup(signal)).text;
