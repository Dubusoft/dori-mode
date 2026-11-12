import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { secretStoreChecks } from "../src/doctor.ts";
import type { Runner } from "../src/run.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const home = (): string => { const dir = mkdtempSync(join(tmpdir(), "dori-doctor-secrets-")); dirs.push(dir); return dir; };
/** A runner on which systemd-creds is `available` or not. */
const creds = (available: boolean): Runner => async () => ({ code: available ? 0 : 1, out: "", err: "" });
const store = (h: string): string => { const dir = join(h, ".dori", "secrets"); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); return dir; };
const put = (dir: string, file: string, mode: number): void => { writeFileSync(join(dir, file), "x", { mode }); chmodSync(join(dir, file), mode); };
const check = async (h: string, available = true, config: object = defaultConfig()) =>
  (await secretStoreChecks({ config: config as ReturnType<typeof defaultConfig>, home: h, run: creds(available) }))[0]!;

test("an empty or missing store is OK", async () => {
  const c = await check(home());
  expect(c.level).toBe("OK");
  expect(c.detail).toBe("no secrets stored");
});

test("an encrypted store with tight modes is OK", async () => {
  const h = home();
  put(store(h), "A_TOKEN.cred", 0o600);
  const c = await check(h);
  expect(c.level).toBe("OK");
  expect(c.detail).toBe("1 secrets, encrypted (systemd-creds)");
});

test("a plain entry warns", async () => {
  const h = home();
  put(store(h), "A_TOKEN.plain", 0o600);
  const c = await check(h);
  expect(c.level).toBe("WARN");
  expect(c.detail).toContain("A_TOKEN");
  expect(c.fix).toContain("dori secret update NAME");
});

test("a 0644 file warns with a chmod fix", async () => {
  const h = home();
  put(store(h), "A_TOKEN.cred", 0o644);
  const c = await check(h);
  expect(c.level).toBe("WARN");
  expect(c.fix).toContain("chmod 600");
});

test("missing encryption on a non-empty store warns", async () => {
  const h = home();
  put(store(h), "A_TOKEN.cred", 0o600);
  expect((await check(h, false)).detail).toContain("systemd-creds --user is unavailable");
});

test("config secrets absent from the store warn", async () => {
  const h = home();
  put(store(h), "A_TOKEN.cred", 0o600);
  const c = await check(h, true, { ...defaultConfig(), secrets: { A_TOKEN: {}, B_TOKEN: {} } });
  expect(c.level).toBe("WARN");
  expect(c.detail).toContain("B_TOKEN");
  expect(c.detail).not.toContain("not in the store: A_TOKEN");
});
