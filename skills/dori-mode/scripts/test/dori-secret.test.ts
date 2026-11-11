import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DORI_SECRET_TEMPLATE } from "../src/runner/install.ts";

const VALUE = "s3cr3t-Value with spaces";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A keychain of generic-password items behind a fake `security`, which logs each call's argv. */
const keychain = (items: Record<string, string>, opts: { refuse?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "dori-secret-"));
  dirs.push(dir);
  for (const [name, value] of Object.entries(items)) writeFileSync(join(dir, `item-${name}`), value);
  const log = join(dir, "calls.log");
  const security = join(dir, "security");
  writeFileSync(security, [
    "#!/bin/bash",
    `printf '%s\\n' "$*" >> '${log}'`,
    'case "$1" in',
    "  find-generic-password)",
    `    f='${dir}/item-'"$3"`,
    '    [ -f "$f" ] || { echo "security: The specified item could not be found in the keychain." >&2; exit 44; }',
    `    if [ "$4" = -w ]; then ${opts.refuse ? 'echo "security: User interaction is not allowed." >&2; exit 36' : 'cat "$f"; echo'}; else echo "keychain: \\"$5\\""; fi ;;`,
    "  dump-keychain)",
    `    for f in '${dir}'/item-*; do [ -f "$f" ] || continue; n=\${f##*/item-}; printf '    "svce"<blob>="%s"\\n' "$n"; done`,
    `    printf '    "svce"<blob>="login.other"\\n' ;;`,
    "esac",
  ].join("\n"));
  chmodSync(security, 0o755);
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bash", DORI_SECRET_TEMPLATE, ...args], { stdout: "pipe", stderr: "pipe", env: { HOME: dir, PATH: process.env.PATH ?? "/usr/bin:/bin", DORI_SECRET_SECURITY: security } });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out, err };
  };
  const calls = () => { try { return readFileSync(log, "utf8"); } catch { return ""; } };
  return { run, calls, kc: join(dir, "Library/Keychains/login.keychain-db") };
};

test("run gives each named secret to the command's environment, under the derived or the given name, and prints no value itself", async () => {
  const k = keychain({ "dori.gh-token": VALUE, "dori.npm": "other" });
  const result = await k.run("run", "dori.gh-token", "NPM_TOKEN=dori.npm", "--", "sh", "-c", 'test "$DORI_GH_TOKEN" = "$1" && test "$NPM_TOKEN" = other && echo MATCH', "sh", VALUE);
  expect(result).toEqual({ code: 0, out: "MATCH\n", err: "" });
  expect(k.calls()).toContain(`find-generic-password -s dori.gh-token -w ${k.kc}`);
});

test("run passes the command's own exit code through", async () => {
  const k = keychain({ "dori.x": VALUE });
  expect((await k.run("run", "dori.x", "--", "sh", "-c", "exit 7")).code).toBe(7);
});

test("names outside dori.<name>, bad variable names and a run without -- or a command are refused before the keychain is asked", async () => {
  const k = keychain({ "dori.x": VALUE });
  for (const args of [["run", "login", "--", "true"], ["run", "dori.", "--", "true"], ["run", "Dori.X", "--", "true"], ["run", "dori.x;id", "--", "true"], ["run", "1BAD=dori.x", "--", "true"], ["run", "dori.x", "true"], ["run", "dori.x", "--"], ["run", "--", "true"], ["has", "github"]]) {
    const result = await k.run(...args);
    expect({ args, code: result.code }).toEqual({ args, code: 2 });
    expect(result.out + result.err).not.toContain(VALUE);
  }
  expect(k.calls()).toBe("");
});

test("a missing item exits 3 and a refused one 4, naming the item but no value, and the command never runs", async () => {
  const missing = await keychain({}).run("run", "dori.nope", "--", "echo", "RAN");
  expect(missing.code).toBe(3);
  expect(missing.out).toBe("");
  expect(missing.err).toContain("no dori.nope in the login keychain");
  const refused = await keychain({ "dori.x": VALUE }, { refuse: true }).run("run", "dori.x", "--", "echo", "RAN");
  expect(refused.code).toBe(4);
  expect(refused.out).toBe("");
  expect(refused.err).toContain("refused to give dori.x");
});

test("has and list print item names only, and list leaves out every non-dori item", async () => {
  const k = keychain({ "dori.b": VALUE, "dori.a": VALUE });
  expect(await k.run("has", "dori.a")).toEqual({ code: 0, out: "dori.a present\n", err: "" });
  expect(await k.run("has", "dori.zzz")).toEqual({ code: 1, out: "dori.zzz missing\n", err: "" });
  expect(await k.run("list")).toEqual({ code: 0, out: "dori.a\ndori.b\n", err: "" });
  expect(k.calls()).not.toContain("-w");
});
