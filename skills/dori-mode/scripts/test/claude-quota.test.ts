import { expect, test } from "bun:test";

import { claudeUsage, NO_CLAUDE, quotaReport, readUsage, usageLine, type QuotaResult, type UsageLookup } from "../src/claude-quota.ts";

const NOW = Date.parse("2026-10-22T03:00:00.000Z");
const RESET_5H = Date.parse("2026-10-22T06:10:00.000Z"); // 15:10 KST
const RESET_7D = Date.parse("2026-10-23T13:00:00.000Z"); // 10-23 22:00 KST

const claude = (fiveLeft: number, weekLeft: number, extra: Partial<QuotaResult> = {}): QuotaResult => ({
  kind: "success", provider: "claude-sdk-oauth",
  windows: [{ label: "Five-hour", remainingPercent: fiveLeft, resetAt: new Date(RESET_5H) }, { label: "Weekly", remainingPercent: weekLeft, resetAt: new Date(RESET_7D) }],
  ...extra,
});
const openai: QuotaResult = { kind: "success", provider: "openai-codex", windows: [{ label: "Weekly", remainingPercent: 1 }] };
const lookupOf = (...results: QuotaResult[]): UsageLookup => async () => ({ results, text: "pi-quota text" });

test("Claude usage keeps every Claude account that answered; other providers and failed reads are ignored", () => {
  const results = [openai, { kind: "unavailable", provider: "anthropic" }, claude(10, 50, { account: "a" }), claude(60, 80, { account: "b" })];
  expect(claudeUsage(results, NOW)).toEqual({ at: NOW, accounts: [
    { name: "a", fiveHour: { usedPct: 90, resetAt: RESET_5H }, weekly: { usedPct: 50, resetAt: RESET_7D } },
    { name: "b", fiveHour: { usedPct: 40, resetAt: RESET_5H }, weekly: { usedPct: 20, resetAt: RESET_7D } },
  ] });
  expect(claudeUsage([openai], NOW)).toBeUndefined();
});

test("the Discord /quota reply is pi-quota's own block with no QUOTA line, with or without a Claude account", async () => {
  for (const results of [[claude(15, 50)], [openai]]) {
    expect(await quotaReport(lookupOf(...results))(AbortSignal.timeout(5_000))).toBe("pi-quota text");
  }
});

test("the dori quota line names every account with each window's usage and reset time, and no gate verdict", async () => {
  const read = await readUsage(lookupOf(claude(15, 50, { account: "a" }), { kind: "success", provider: "anthropic", account: "b", windows: [{ label: "Weekly", remainingPercent: 90 }] }), NOW, AbortSignal.timeout(5_000));
  expect(read.text).toBe("pi-quota text");
  expect(usageLine(read.usage ?? { at: NOW, accounts: [] })).toBe("QUOTA | Claude a: 5h 85% used (resets 10-22 15:10 KST), 7d 50% used (resets 10-23 22:00 KST) | b: 7d 10% used");
  expect(await readUsage(lookupOf(openai), NOW, AbortSignal.timeout(5_000))).toEqual({ text: "pi-quota text" });
  expect(NO_CLAUDE).toBe("QUOTA | no Claude subscription usage reported");
});
