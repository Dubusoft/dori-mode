import { describe, expect, test } from "bun:test";
import type { SecretCommand, SecretRule } from "../src/config.ts";
import { SecretStoreError } from "../src/secret-store.ts";
import { SECRET_RUN_OUTPUT_CAP, secretCommandRunner, type SecretRunAuditEntry, type SecretRunnerDeps, type SecretSpawner } from "../src/runner/secret-run.ts";

const VALUE = "dori-test-throwaway-123";
const HOST_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/home/test", LANG: "C.UTF-8", TMPDIR: "/tmp", UNRELATED_PARENT_VAR: "leak-me" };

const command = (argv: readonly string[], patch: Partial<SecretCommand> = {}): SecretCommand => ({ argv, secrets: ["API_TOKEN"], lanes: ["lane-a", "pre-*"], repos: [], timeoutSec: 300, ...patch });

const harness = (commands: Record<string, SecretCommand>, patch: Partial<SecretRunnerDeps> = {}, rules: Record<string, SecretRule> = {}) => {
  const audit: SecretRunAuditEntry[] = [];
  const logs: string[] = [];
  const run = secretCommandRunner({
    store: {
      read: async (name) => {
        if (name !== "API_TOKEN") throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING: secret ${name} does not exist`);
        return VALUE;
      },
    },
    commands: async () => commands, rules: async () => rules,
    audit: (e) => { audit.push(e); }, log: (l) => { logs.push(l); },
    runner: "local", now: () => 0, hostEnv: HOST_ENV, home: "/",
    ...patch,
  });
  /** Nothing the runner hands back, logs or audits carries the value. */
  const clean = (result: unknown): void => { expect(JSON.stringify([result, audit, logs])).not.toContain(VALUE); };
  return { run, audit, logs, clean };
};

/** A fake child that exits `code` with no output, recording how it was started. */
const fakeSpawn = (seen: { argv?: readonly string[]; env?: Record<string, string>; cwd?: string }, code = 0): SecretSpawner => (argv, opts) => {
  Object.assign(seen, { argv, env: opts.env, cwd: opts.cwd });
  return { stdout: new Response("").body as ReadableStream<Uint8Array>, stderr: new Response("").body as ReadableStream<Uint8Array>, exited: Promise.resolve(code), kill: () => {} };
};

describe("secretCommandRunner", () => {
  test("an op missing from secretCommands is DENIED and audited without names", async () => {
    const h = harness({});
    const result = await h.run("lane-a", "deploy");
    expect(result).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "deploy is not a configured secret command (config secretCommands)" });
    expect(h.audit).toEqual([{ at: "1970-01-01T00:00:00.000Z", runner: "local", lane: "lane-a", op: "deploy", names: [], allowed: false }]);
    expect(h.logs).toEqual(["RUNNER_SECRET_DENIED lane=lane-a op=deploy code=RUNNER_SECRET_DENIED"]);
  });

  test("a lane the op's lanes/repos do not match is DENIED before any secret is read", async () => {
    let reads = 0;
    const h = harness({ deploy: command(["true"], { repos: ["Acme/Widget"] }) }, { store: { read: async () => { reads++; return VALUE; } } });
    expect(await h.run("lane-b", "deploy", "acme/other")).toEqual({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "lane-b may not run deploy (config secretCommands)" });
    expect(reads).toBe(0);
    expect(h.audit[0]).toMatchObject({ lane: "lane-b", op: "deploy", names: ["API_TOKEN"], allowed: false });
    // A matching repo (case-insensitive) or a prefix-* lane is let through.
    expect(await h.run("lane-b", "deploy", "acme/widget")).toMatchObject({ ok: true, exitCode: 0 });
    expect(await h.run("pre-1", "deploy")).toMatchObject({ ok: true, exitCode: 0 });
  });

  test("a grant runs argv with the secret in the child env only, and its output is redacted", async () => {
    const h = harness({ show: command(["sh", "-c", "printf '%s\\n' \"$API_TOKEN\"; printf 'err %s' \"$API_TOKEN\" >&2; test \"$API_TOKEN\" = dori-test-throwaway-123 && exit 3"]) });
    const result = await h.run("lane-a", "show");
    expect(result).toEqual({ ok: true, exitCode: 3, stdout: "[REDACTED:API_TOKEN]\n", stderr: "err [REDACTED:API_TOKEN]", truncated: false });
    expect(Object.values(process.env)).not.toContain(VALUE);
    expect(h.audit).toEqual([{ at: "1970-01-01T00:00:00.000Z", runner: "local", lane: "lane-a", op: "show", names: ["API_TOKEN"], allowed: true, exitCode: 3 }]);
    expect(h.logs).toEqual(["RUNNER_SECRET_RUN lane=lane-a op=show exit=3"]);
    h.clean(result);
  });

  test("the child env is PATH, HOME, LANG, TMPDIR and the secrets, nothing else from the parent", async () => {
    const h = harness({ env: command(["env"]) });
    const result = await h.run("lane-a", "env");
    expect(result.ok).toBe(true);
    const vars = Object.fromEntries((result.ok ? result.stdout : "").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    // redactSecrets also masks the NAME=value shape, so the line reads API_TOKEN=[REDACTED].
    expect(vars).toEqual({ PATH: HOST_ENV.PATH, HOME: "/home/test", LANG: "C.UTF-8", TMPDIR: "/tmp", API_TOKEN: expect.stringMatching(/^\[REDACTED/) });
    h.clean(result);
  });

  test("host vars that are unset stay unset; cwd is the op's cwd, else home; stdin is closed", async () => {
    const seen: { env?: Record<string, string>; cwd?: string } = {};
    const h = harness({ a: command(["x"]), b: command(["x"], { cwd: "/srv/ops" }) }, { spawn: fakeSpawn(seen), hostEnv: { PATH: "/bin", OTHER: "no" }, home: "/home/u" });
    await h.run("lane-a", "a");
    expect(seen).toMatchObject({ env: { PATH: "/bin", API_TOKEN: VALUE }, cwd: "/home/u" });
    expect(Object.keys(seen.env ?? {}).sort()).toEqual(["API_TOKEN", "PATH"]);
    await h.run("lane-a", "b");
    expect(seen.cwd).toBe("/srv/ops");
    const real = harness({ stdin: command(["sh", "-c", "cat; echo eof"]) });
    expect(await real.run("lane-a", "stdin")).toMatchObject({ ok: true, exitCode: 0, stdout: "eof\n" });
  });

  test("each stream keeps 64 KiB and says truncated; a value cut at the cap is still masked", async () => {
    const pad = SECRET_RUN_OUTPUT_CAP - 5;
    const h = harness({
      big: command(["sh", "-c", `head -c 70000 /dev/zero | tr '\\0' a; head -c ${pad} /dev/zero | tr '\\0' b >&2; printf '%s' "$API_TOKEN" >&2`]),
      small: command(["sh", "-c", "printf ok"]),
    });
    const result = await h.run("lane-a", "big");
    if (!result.ok) throw new Error(result.detail);
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("a".repeat(SECRET_RUN_OUTPUT_CAP));
    expect(result.stderr).toBe(`${"b".repeat(pad)}[REDACTED:API_TOKEN]`);
    h.clean(result);
    expect(await h.run("lane-a", "small")).toMatchObject({ stdout: "ok", truncated: false });
  });

  test("a command still running at timeoutSec is killed: exit 124 and stderr says so", async () => {
    let armed: number | undefined;
    const h = harness({ slow: command(["sleep", "30"], { timeoutSec: 2 }) }, {
      // Fires as soon as it is armed: the child is already running, so the kill is what ends it.
      timer: (ms, fire) => { armed = ms; queueMicrotask(fire); return () => {}; },
    });
    const result = await h.run("lane-a", "slow");
    expect(armed).toBe(2000);
    expect(result).toEqual({ ok: true, exitCode: 124, stdout: "", stderr: "dori: slow killed after 2s (timeoutSec)\n", truncated: false });
    expect(h.audit[0]).toMatchObject({ allowed: true, exitCode: 124 });
    expect(h.logs).toEqual(["RUNNER_SECRET_RUN lane=lane-a op=slow exit=124"]);
  });

  test("a missing secret is MISSING, a minted one goes through deps.mint, a command that cannot start is FAILED", async () => {
    const missing = harness({ m: command(["true"], { secrets: ["OTHER"] }) });
    expect(await missing.run("lane-a", "m")).toEqual({ ok: false, code: "RUNNER_SECRET_MISSING", detail: "OTHER is not in the secret store" });
    const seen: { env?: Record<string, string> } = {};
    const rules: Record<string, SecretRule> = {
      GH_TOKEN: { lanes: [], repos: [], mint: { kind: "github-app", appId: "1", installationId: "2", keySecret: "API_TOKEN", permissions: { contents: "write" } } },
    };
    const minted = harness({ gh: command(["x"], { secrets: ["GH_TOKEN"] }) }, {
      spawn: fakeSpawn(seen), mint: async (args) => ({ token: `minted-for-${args.repo}`, expiresAt: "" }),
    }, rules);
    expect(await minted.run("lane-a", "gh", "acme/app")).toMatchObject({ ok: true });
    expect(seen.env?.GH_TOKEN).toBe("minted-for-acme/app");
    expect(await minted.run("lane-a", "gh")).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED", detail: "GH_TOKEN is minted per repo and lane lane-a has no repo" });
    const broken = harness({ b: command(["/nonexistent/dori-no-such-binary"]) });
    const result = await broken.run("lane-a", "b");
    expect(result).toMatchObject({ ok: false, code: "RUNNER_SECRET_FAILED" });
    broken.clean(result);
  });
});
