import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const VALUE = "dori-test-throwaway-123";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const home = (): string => { const dir = mkdtempSync(join(tmpdir(), "dori-secret-cli-")); dirs.push(dir); return dir; };

const dori = async (h: string, args: readonly string[], stdin = ""): Promise<{ code: number; out: string; err: string }> => {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: h };
  delete env.DORI_LANE_KEY;
  delete env.HERDR_PANE_ID;
  const p = Bun.spawn([process.execPath, CLI, "secret", ...args], { env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

test("add, list, update and delete never print the value", async () => {
  const h = home();
  const added = await dori(h, ["add", "TEST_TOKEN"], `${VALUE}\n`);
  expect(added.code).toBe(0);
  expect(added.out).toMatch(/^SECRET_ADDED TEST_TOKEN backend=(systemd-creds|plain)$/m);
  const again = await dori(h, ["add", "TEST_TOKEN"], VALUE);
  expect(again.code).toBe(1);
  expect(again.err).toContain("SECRET_EXISTS");
  const listed = await dori(h, ["list"]);
  expect(listed.out).toMatch(/^TEST_TOKEN (systemd-creds|plain)$/m);
  const json = JSON.parse((await dori(h, ["list", "--json"])).out) as { name: string; backend: string }[];
  expect(json.map((entry) => entry.name)).toEqual(["TEST_TOKEN"]);
  const updated = await dori(h, ["update", "TEST_TOKEN"], VALUE);
  expect(updated.out).toMatch(/^SECRET_UPDATED TEST_TOKEN backend=/m);
  const deleted = await dori(h, ["delete", "TEST_TOKEN"]);
  expect(deleted.out).toContain("SECRET_DELETED TEST_TOKEN");
  expect((await dori(h, ["list"])).out).toBe("");
  for (const r of [added, again, listed, updated, deleted]) expect(r.out + r.err).not.toContain(VALUE);
});

test("an empty value and a bad name are refused", async () => {
  const h = home();
  expect((await dori(h, ["add", "TEST_TOKEN"], "\n")).err).toContain("SECRET_VALUE_EMPTY");
  expect((await dori(h, ["add", "bad-name"], VALUE)).err).toContain("SECRET_NAME_INVALID");
});

test("there is no get subcommand, and exec is lane-only", async () => {
  const h = home();
  expect((await dori(h, ["get", "TEST_TOKEN"])).code).toBe(2);
  expect((await dori(h, ["show", "TEST_TOKEN"])).code).toBe(2);
  const exec = await dori(h, ["exec", "TEST_TOKEN", "--", "true"]);
  expect(exec.code).toBe(2);
  expect(exec.err).toContain("SECRET_EXEC_LANE_ONLY");
});
