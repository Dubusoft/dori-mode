import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretRule } from "../src/config.ts";
import { SecretStoreError } from "../src/secret-store.ts";
import { GithubMintError } from "../src/github-app-token.ts";
import { appendSecretAudit, repoFromRemote, type SecretAuditEntry, type SecretGranterDeps, secretAuditPath, secretGranter } from "../src/runner/secret-grant.ts";

const VALUE = "dori-test-throwaway-123";

const setup = (rules: Record<string, SecretRule>, opts: { repo?: string; stored?: Record<string, string>; mint?: SecretGranterDeps["mint"] } = {}) => {
  const audit: SecretAuditEntry[] = [];
  const granted: string[][] = [];
  const stored = opts.stored ?? { NPM_TOKEN: VALUE, OTHER_TOKEN: VALUE };
  const grant = secretGranter({
    store: {
      read: async (name: string) => {
        const value = stored[name];
        if (value === undefined) throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING ${name}`);
        return value;
      },
    },
    rules: async () => rules,
    laneRepo: async () => opts.repo,
    audit: (entry) => { audit.push(entry); },
    runner: "local", now: () => 0,
    onGranted: (values) => { granted.push([...values]); },
    ...(opts.mint ? { mint: opts.mint } : {}),
  });
  return { grant, audit, granted };
};

const rule = (lanes: string[], repos: string[] = []): SecretRule => ({ lanes, repos });

test("a lane listed exactly receives the value", async () => {
  const { grant, audit, granted } = setup({ NPM_TOKEN: rule(["lane-a"]) });
  expect(await grant("lane-a", ["NPM_TOKEN"])).toEqual({ ok: true, values: { NPM_TOKEN: VALUE } });
  expect(audit).toEqual([{ at: "1970-01-01T00:00:00.000Z", runner: "local", lane: "lane-a", names: ["NPM_TOKEN"], allowed: true }]);
  expect(granted).toEqual([[VALUE]]);
});

test("a lane matching a prefix* entry receives the value", async () => {
  const { grant } = setup({ NPM_TOKEN: rule(["build-*"]) });
  expect((await grant("build-42", ["NPM_TOKEN"])).ok).toBe(true);
  expect((await grant("buil", ["NPM_TOKEN"])).ok).toBe(false);
});

test("a lane whose repo is listed receives the value, case-insensitively", async () => {
  const { grant } = setup({ NPM_TOKEN: rule([], ["Dubusoft/dori-mode"]) }, { repo: "dubusoft/DORI-mode" });
  expect((await grant("lane-x", ["NPM_TOKEN"])).ok).toBe(true);
});

test("no rule, another lane or another repo is denied", async () => {
  expect(await setup({}).grant("lane-a", ["NPM_TOKEN"])).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-a may not receive NPM_TOKEN (config secrets)" });
  expect((await setup({ NPM_TOKEN: rule(["lane-b"]) }).grant("lane-a", ["NPM_TOKEN"])).ok).toBe(false);
  expect((await setup({ NPM_TOKEN: rule([], ["o/r"]) }, { repo: "o/other" }).grant("lane-a", ["NPM_TOKEN"])).ok).toBe(false);
  expect((await setup({ NPM_TOKEN: rule([], ["o/r"]) }).grant("lane-a", ["NPM_TOKEN"])).ok).toBe(false);
});

test("one name not allowed denies the whole request", async () => {
  const { grant, audit, granted } = setup({ NPM_TOKEN: rule(["lane-a"]) });
  expect(await grant("lane-a", ["NPM_TOKEN", "OTHER_TOKEN"])).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-a may not receive OTHER_TOKEN (config secrets)" });
  expect(audit).toEqual([{ at: "1970-01-01T00:00:00.000Z", runner: "local", lane: "lane-a", names: ["NPM_TOKEN", "OTHER_TOKEN"], allowed: false, reason: "not allowed: OTHER_TOKEN" }]);
  expect(granted).toEqual([]);
});

test("an allowed name missing from the store is refused", async () => {
  const { grant, audit } = setup({ GONE_TOKEN: rule(["lane-a"]) });
  expect(await grant("lane-a", ["GONE_TOKEN"])).toEqual({ ok: false, code: "RUNNER_SECRET_MISSING", detail: "GONE_TOKEN is not in the secret store" });
  expect(audit[0]?.allowed).toBe(false);
});

test("audit lines are JSON without the value, in a 0600 file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-secret-audit-"));
  try {
    const path = secretAuditPath(dir);
    const write = appendSecretAudit(path);
    const granter = secretGranter({
      store: { read: async () => VALUE }, rules: async () => ({ NPM_TOKEN: rule(["lane-a"]) }), laneRepo: async () => undefined,
      audit: write, runner: "local", now: () => 0,
    });
    await granter("lane-a", ["NPM_TOKEN"]);
    await granter("lane-b", ["NPM_TOKEN"]);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(VALUE);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as SecretAuditEntry);
    expect(lines.map((l) => [l.lane, l.allowed])).toEqual([["lane-a", true], ["lane-b", false]]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an audit write failure is logged, not thrown", () => {
  const logs: string[] = [];
  appendSecretAudit("/nonexistent-dori-dir/secret-audit.jsonl", (l) => { logs.push(l); })({ at: "", runner: "local", lane: "a", names: [], allowed: false });
  expect(logs[0]).toStartWith("RUNNER_SECRET_AUDIT_FAILED");
});

test("repoFromRemote parses https, scp-like and ssh:// remotes", () => {
  expect(repoFromRemote("https://github.com/Dubusoft/dori-mode.git")).toBe("Dubusoft/dori-mode");
  expect(repoFromRemote("https://github.com/o/r")).toBe("o/r");
  expect(repoFromRemote("git@github.com:o/r.git")).toBe("o/r");
  expect(repoFromRemote("ssh://git@host.example/o/r.git")).toBe("o/r");
  expect(repoFromRemote("/local/path/repo")).toBeUndefined();
  expect(repoFromRemote("https://github.com/only-owner")).toBeUndefined();
});

const PEM = "dori-test-throwaway-pem";
const TOKEN = "dori-test-throwaway-minted";
const mintRule: SecretRule = { lanes: ["lane-a"], repos: [], mint: { kind: "github-app", appId: "1", installationId: "2", keySecret: "APP_KEY", permissions: { contents: "read" } } };

test("a minted name returns the minted token and records minted in the audit", async () => {
  const calls: unknown[] = [];
  const { grant, audit, granted } = setup({ GH_TOKEN: mintRule }, {
    repo: "o/r", stored: { APP_KEY: PEM },
    mint: async (opts) => { calls.push({ ...opts }); return { token: TOKEN, expiresAt: "x" }; },
  });
  expect(await grant("lane-a", ["GH_TOKEN"])).toEqual({ ok: true, values: { GH_TOKEN: TOKEN } });
  expect(calls).toEqual([{ appId: "1", installationId: "2", privateKeyPem: PEM, repo: "o/r", permissions: { contents: "read" } }]);
  expect(audit).toEqual([{ at: "1970-01-01T00:00:00.000Z", runner: "local", lane: "lane-a", names: ["GH_TOKEN"], allowed: true, minted: ["GH_TOKEN"] }]);
  expect(granted).toEqual([[TOKEN]]);
  expect(JSON.stringify(audit)).not.toContain(PEM);
});

test("a minted name for a lane without a repo is denied", async () => {
  let minted = 0;
  const { grant, audit } = setup({ GH_TOKEN: mintRule }, { stored: { APP_KEY: PEM }, mint: async () => { minted++; return { token: TOKEN, expiresAt: "x" }; } });
  expect(await grant("lane-a", ["GH_TOKEN"])).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "GH_TOKEN is minted per repo and lane lane-a has no repo" });
  expect(minted).toBe(0);
  expect(audit[0]?.allowed).toBe(false);
});

test("a mint failure is RUNNER_SECRET_FAILED with the mint message and no key or token", async () => {
  const { grant, audit, granted } = setup({ GH_TOKEN: mintRule }, {
    repo: "o/r", stored: { APP_KEY: PEM },
    mint: async () => { throw new GithubMintError("GITHUB_MINT_FAILED 403: Resource not accessible"); },
  });
  const r = await grant("lane-a", ["GH_TOKEN"]);
  expect(r).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "GITHUB_MINT_FAILED 403: Resource not accessible" });
  expect(JSON.stringify([r, audit])).not.toContain(PEM);
  expect(audit[0]?.allowed).toBe(false);
  expect(audit[0]?.minted).toBeUndefined();
  expect(granted).toEqual([]);
});

// Decision: a keySecret absent from the store is RUNNER_SECRET_MISSING (an operator setup gap, like a missing stored secret), naming the key secret.
test("a keySecret missing from the store is RUNNER_SECRET_MISSING", async () => {
  const { grant } = setup({ GH_TOKEN: mintRule }, { repo: "o/r", stored: {}, mint: async () => ({ token: TOKEN, expiresAt: "x" }) });
  expect(await grant("lane-a", ["GH_TOKEN"])).toEqual({ ok: false, code: "RUNNER_SECRET_MISSING", detail: "APP_KEY (App key for GH_TOKEN) is not in the secret store" });
});

test("a name whose rule says ssh-key is reported in kinds, others are not", async () => {
  const { grant } = setup({ DEPLOY_KEY: { lanes: ["lane-a"], repos: [], as: "ssh-key" }, NPM_TOKEN: rule(["lane-a"]) }, { stored: { DEPLOY_KEY: VALUE, NPM_TOKEN: VALUE } });
  expect(await grant("lane-a", ["DEPLOY_KEY", "NPM_TOKEN"])).toEqual({ ok: true, values: { DEPLOY_KEY: VALUE, NPM_TOKEN: VALUE }, kinds: { DEPLOY_KEY: "ssh-key" } });
  expect(await grant("lane-a", ["NPM_TOKEN"])).toEqual({ ok: true, values: { NPM_TOKEN: VALUE } });
});
