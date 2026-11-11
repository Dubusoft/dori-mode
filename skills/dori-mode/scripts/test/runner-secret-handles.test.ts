import { expect, test } from "bun:test";
import type { SecretRule } from "../src/config.ts";
import { SecretStoreError } from "../src/secret-store.ts";
import type { SecretAuditEntry } from "../src/runner/secret-grant.ts";
import { handleId, SECRET_HANDLE_PATTERN, SecretHandles } from "../src/runner/secret-handles.ts";

const VALUE = "dori-test-throwaway-pw";
const ORIGIN = "https://login.example.com";

const setup = (initial: Record<string, SecretRule>, opts: { repo?: string; stored?: Record<string, string> } = {}) => {
  let rules = initial;
  let clock = 1_000;
  let seed = 0;
  const audit: SecretAuditEntry[] = [];
  const granted: string[][] = [];
  const stored = opts.stored ?? { SITE_PW: VALUE };
  const reads: string[] = [];
  const handles = new SecretHandles({
    store: {
      read: async (name) => {
        reads.push(name);
        const v = stored[name];
        if (v === undefined) throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING ${name}`);
        return v;
      },
    },
    rules: async () => rules,
    laneRepo: async () => opts.repo,
    audit: (e) => { audit.push(e); },
    runner: "local", now: () => clock, ttlMs: 60_000,
    // Deterministic, distinct 32-byte buffers.
    random: () => Buffer.alloc(32, ++seed),
    onGranted: (values) => { granted.push([...values]); },
  });
  return {
    handles, audit, granted, reads,
    setRules: (r: Record<string, SecretRule>) => { rules = r; },
    advance: (ms: number) => { clock += ms; },
  };
};

const site = (patch: Partial<SecretRule> = {}): SecretRule => ({ lanes: ["lane-a"], repos: [], origins: [ORIGIN], ...patch });

const issued = async (h: SecretHandles, key = "lane-a", name = "SITE_PW"): Promise<string> => {
  const r = await h.issue(key, name);
  if (!r.ok) throw new Error(r.detail);
  return r.handle;
};

test("issue follows lanes/repos and reads nothing from the store", async () => {
  const s = setup({ SITE_PW: site({ lanes: ["build-*"], repos: ["Acme/App"] }) }, { repo: "acme/app" });
  const r = await s.handles.issue("build-1", "SITE_PW");
  expect(r).toMatchObject({ ok: true, expiresAt: 61_000 });
  if (r.ok) expect(r.handle).toMatch(SECRET_HANDLE_PATTERN);
  expect((await s.handles.issue("other", "SITE_PW")).ok).toBe(true); // repo match
  const denied = setup({ SITE_PW: site() }, { repo: "acme/other" });
  expect(await denied.handles.issue("lane-b", "SITE_PW")).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-b may not receive SITE_PW (config secrets)" });
  expect(await denied.handles.issue("lane-a", "NO_RULE")).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  expect(await denied.handles.issue("lane-a", "lower")).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  expect(denied.audit.map((e) => [e.kind, e.allowed, e.reason])).toEqual([
    ["handle.issue", false, "not allowed: SITE_PW"], ["handle.issue", false, "not allowed: NO_RULE"], ["handle.issue", false, "bad name"],
  ]);
  expect(s.reads).toEqual([]);
});

test("a rule without origins is denied a handle", async () => {
  const s = setup({ SITE_PW: { lanes: ["lane-a"], repos: [] } });
  expect(await s.handles.issue("lane-a", "SITE_PW")).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  expect(s.audit[0]).toMatchObject({ kind: "handle.issue", allowed: false, reason: "no origins: SITE_PW" });
});

test("exchange gives the value once; the second attempt is refused as used", async () => {
  const s = setup({ SITE_PW: site() });
  const h = await issued(s.handles);
  expect(await s.handles.exchange("lane-a", h, ORIGIN)).toEqual({ ok: true, value: VALUE });
  expect(s.granted).toEqual([[VALUE]]);
  expect(await s.handles.exchange("lane-a", h, ORIGIN)).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  const id = handleId(h);
  expect(s.audit.slice(1)).toEqual([
    { at: "1970-01-01T00:00:01.000Z", runner: "local", lane: "lane-a", names: ["SITE_PW"], allowed: true, kind: "handle.exchange", handleId: id, origin: ORIGIN },
    { at: "1970-01-01T00:00:01.000Z", runner: "local", lane: "lane-a", names: ["SITE_PW"], allowed: false, kind: "handle.exchange", handleId: id, origin: ORIGIN, reason: "used" },
  ]);
  expect(s.audit[0]).toMatchObject({ kind: "handle.issue", allowed: true, handleId: id });
});

test("an unknown or expired handle is refused", async () => {
  const s = setup({ SITE_PW: site() });
  expect(await s.handles.exchange("lane-a", `dsh_${"A".repeat(43)}`, ORIGIN)).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  const h = await issued(s.handles);
  s.advance(60_000);
  expect(await s.handles.exchange("lane-a", h, ORIGIN)).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  expect(s.audit.filter((e) => e.kind === "handle.exchange").map((e) => e.reason)).toEqual(["unknown", "expired"]);
  expect(s.reads).toEqual([]);
});

test("another lane's proxy is refused and the handle is consumed", async () => {
  const s = setup({ SITE_PW: site({ lanes: ["lane-a", "lane-b"] }) });
  const h = await issued(s.handles);
  expect(await s.handles.exchange("lane-b", h, ORIGIN)).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  expect(await s.handles.exchange("lane-a", h, ORIGIN)).toMatchObject({ ok: false });
  expect(s.audit.slice(1).map((e) => [e.lane, e.reason])).toEqual([["lane-b", "wrong lane"], ["lane-a", "used"]]);
});

test("an origin not listed is refused, and that attempt consumes the handle", async () => {
  const s = setup({ SITE_PW: site() });
  const h = await issued(s.handles);
  expect(await s.handles.exchange("lane-a", h, "https://evil.example")).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "SITE_PW may not be filled on https://evil.example (config secrets.SITE_PW.origins)" });
  expect(await s.handles.exchange("lane-a", h, ORIGIN)).toMatchObject({ ok: false });
  expect(s.audit.slice(1).map((e) => e.reason)).toEqual(["origin not allowed", "used"]);
  expect(s.reads).toEqual([]);
});

test("a rule edited after issue is honored at exchange", async () => {
  const s = setup({ SITE_PW: site({ origins: [ORIGIN, "https://b.example"] }) });
  const a = await issued(s.handles);
  const b = await issued(s.handles);
  const c = await issued(s.handles);
  s.setRules({ SITE_PW: site() });
  expect((await s.handles.exchange("lane-a", a, "https://b.example")).ok).toBe(false);
  expect((await s.handles.exchange("lane-a", b, ORIGIN)).ok).toBe(true);
  s.setRules({});
  expect((await s.handles.exchange("lane-a", c, ORIGIN)).ok).toBe(false);
  expect(s.audit.filter((e) => e.kind === "handle.exchange").map((e) => e.reason)).toEqual(["origin not allowed", undefined, "rule gone"]);
});

test("a store miss at exchange maps like the granter", async () => {
  const s = setup({ SITE_PW: site() }, { stored: {} });
  const h = await issued(s.handles);
  expect(await s.handles.exchange("lane-a", h, ORIGIN)).toEqual({ ok: false, code: "RUNNER_SECRET_MISSING", detail: "SITE_PW is not in the secret store" });
  expect(s.audit[1]).toMatchObject({ allowed: false, reason: "missing: SITE_PW" });
});

test("at most 16 unused handles per lane; used or expired ones free a slot", async () => {
  const s = setup({ SITE_PW: site({ lanes: ["lane-a", "lane-b"] }) });
  const first = await issued(s.handles);
  for (let i = 1; i < 16; i++) await issued(s.handles);
  expect(await s.handles.issue("lane-a", "SITE_PW")).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  expect(s.audit.at(-1)).toMatchObject({ kind: "handle.issue", allowed: false, reason: "too many handles" });
  expect((await s.handles.issue("lane-b", "SITE_PW")).ok).toBe(true);
  await s.handles.exchange("lane-a", first, ORIGIN);
  expect((await s.handles.issue("lane-a", "SITE_PW")).ok).toBe(true);
  s.advance(60_000);
  expect((await s.handles.issue("lane-a", "SITE_PW")).ok).toBe(true);
});

test("audit lines never carry the value or a full handle", async () => {
  const s = setup({ SITE_PW: site() });
  const h1 = await issued(s.handles);
  const h2 = await issued(s.handles);
  await s.handles.exchange("lane-a", h1, ORIGIN);
  await s.handles.exchange("lane-a", h1, ORIGIN);
  await s.handles.exchange("lane-b", h2, ORIGIN);
  const text = JSON.stringify(s.audit);
  expect(text).not.toContain(VALUE);
  expect(text).not.toContain(h1);
  expect(text).not.toContain(h2);
  expect(text).not.toContain(h1.slice(4));
  expect(handleId(h1)).toMatch(/^[0-9a-f]{12}$/);
});
