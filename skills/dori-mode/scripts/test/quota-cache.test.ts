import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { quotaSummary } from "../src/autopilot-cli.ts";
import { DEFAULT_AUTOPILOT, judge, singleHost, type ToodoTask } from "../src/autopilot.ts";
import { type QuotaResult, readUsage, skippedClaudeAccounts, type UsageLookup } from "../src/claude-quota.ts";
import { cachedQuotaLookup, cacheNoteLines, DEFAULT_BACKOFF_SEC, STALE_READ_MAX_MS } from "../src/quota-cache.ts";

const T0 = Date.parse("2026-11-12T03:00:00.000Z");
const TTL = 90_000;
const SIGNAL = AbortSignal.timeout(5_000);

const good = (account: string, weekLeft: number): QuotaResult => ({
  kind: "success", provider: "claude-sdk-oauth", account, windows: [{ label: "Weekly", remainingPercent: weekLeft }],
});
const limited = (account: string, retryAfterSeconds?: number): QuotaResult => ({
  kind: "failure", provider: "claude-sdk-oauth", account, reason: { type: "http-error", status: 429 },
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

let dir = "";
let now = T0;
let answers: QuotaResult[][] = [];
let calls = 0;

const fake: UsageLookup = async () => {
  const results = answers[Math.min(calls, answers.length - 1)] ?? [];
  calls++;
  return { results, text: `pi-quota text ${calls}` };
};
const cached = (lookup: UsageLookup = fake) => cachedQuotaLookup(lookup, { path: join(dir, "quota-cache.json"), ttlMs: TTL, now: () => now });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "quota-cache-")); now = T0; answers = []; calls = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("a read within the TTL is served from the shared file without calling the endpoints; an expired one refreshes", async () => {
  answers = [[good("a", 60)], [good("a", 40)]];
  const first = await cached()(SIGNAL);
  expect(first.cache?.refreshed).toBe(true);
  now += TTL - 1;
  // A second lookup over the same file (another process) sees the first one's read.
  const second = await cached()(SIGNAL);
  expect(calls).toBe(1);
  expect(second.cache?.refreshed).toBe(false);
  expect(second.results).toEqual([good("a", 60)]);
  expect(cacheNoteLines(second.cache, now)).toEqual(["QUOTA | cached read from 1m ago"]);
  now += 1;
  const third = await cached()(SIGNAL);
  expect(calls).toBe(2);
  expect(third.results).toEqual([good("a", 40)]);
  expect(third.text).toBe("pi-quota text 2");
});

test("after a 429 no lookup runs until Retry-After passes, and the account is served from its last good read", async () => {
  answers = [[good("a", 60), good("b", 90)], [limited("a", 600), good("b", 80)], [good("a", 50), good("b", 70)]];
  await cached()(SIGNAL);
  now += TTL;
  const hit = await cached()(SIGNAL);
  expect(calls).toBe(2);
  expect(hit.results).toEqual([good("a", 60), good("b", 80)]);
  expect(hit.cache?.backoff).toEqual([{ name: "a", until: now + 600_000 }]);
  expect(cacheNoteLines(hit.cache, now, "UTC")).toEqual([
    "QUOTA | a: stale, last good read 1m ago",
    "QUOTA | a: rate-limited (HTTP 429), no usage call until 11-12 03:11 UTC",
  ]);
  now += 599_000;
  const waiting = await cached()(SIGNAL);
  expect(calls).toBe(2);
  expect(waiting.cache?.stale.map((s) => s.name)).toEqual(["a", "b"]);
  expect(cacheNoteLines(waiting.cache, now)).toContain("QUOTA | a: stale, last good read 11m ago");
  now += 1_000;
  const after = await cached()(SIGNAL);
  expect(calls).toBe(3);
  expect(after.results).toEqual([good("a", 50), good("b", 70)]);
  expect(after.cache?.backoff).toEqual([]);
});

test("a 429 without Retry-After backs off for the default; with no good read yet the account stays skipped as http-error 429", async () => {
  answers = [[limited("a")], [good("a", 10)]];
  const read = await readUsage(cached(), now, SIGNAL);
  expect(read.usage).toBeUndefined();
  expect(read.skipped).toEqual([{ name: "a", reason: "http-error 429" }]);
  now += DEFAULT_BACKOFF_SEC * 1000 - 1;
  await cached()(SIGNAL);
  expect(calls).toBe(1);
  now += 1;
  await cached()(SIGNAL);
  expect(calls).toBe(2);
});

test("the judge counts a stale read with its age as readable, and holds quota-unreadable once it passes the stale bound", async () => {
  answers = [[good("a", 60)], [limited("a", 3 * 3600)]];
  await cached()(SIGNAL);
  now += TTL;
  await cached()(SIGNAL);
  now += 20 * 60_000;
  const stale = await readUsage(cached(), now, SIGNAL);
  const summary = quotaSummary(stale.usage, stale.skipped, stale.cache, now);
  expect(summary).toEqual({ readable: true, accounts: [{ name: "a", maxUsedPct: 40 }], stale: ["a (21m)"] });

  now = T0 + STALE_READ_MAX_MS + 1;
  const expired = await readUsage(cached(), now, SIGNAL);
  expect(calls).toBe(2);
  expect(skippedClaudeAccounts((await cached()(SIGNAL)).results)).toEqual([{ name: "a", reason: "stale-read" }]);
  const unreadable = quotaSummary(expired.usage, expired.skipped, expired.cache, now);
  expect(unreadable).toEqual({ readable: false, skipped: ["a (stale-read)"] });
  const task: ToodoTask = {
    id: 1, workspaceId: 1, title: "t", description: "d", status: "planned", resolution: null, dependsOn: [], refs: ["owner:x"],
    criteria: [{ text: "c", kind: "manual" }], wait: null, autopilot: true, dueDate: null,
  };
  const ctx = { tasks: new Map([[1, task]]), ledger: [], openLanes: new Set<string>(), hosts: singleHost({ ok: true }), config: DEFAULT_AUTOPILOT };
  expect(judge({ ...ctx, taskId: 1, quota: summary }).verdict).toBe("LAUNCH");
  expect(judge({ ...ctx, taskId: 1, quota: unreadable }).reasons).toContain("quota-unreadable");
});

test("concurrent callers on an expired cache run one lookup; the rest wait for it and share its answer", async () => {
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const slow: UsageLookup = async (signal) => { await gate; return fake(signal); };
  answers = [[good("a", 30)]];
  const reads = Promise.all(Array.from({ length: 5 }, () => cached(slow)(SIGNAL)));
  open();
  const all = await reads;
  expect(calls).toBe(1);
  expect(all.map((r) => r.results)).toEqual(Array.from({ length: 5 }, () => [good("a", 30)]));
  expect(all.filter((r) => r.cache?.refreshed).length).toBe(1);
});
