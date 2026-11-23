import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran, Runner } from "../src/run.ts";
import { SecretStore, SecretStoreError, secretsDir, type SecretStoreErrorCode } from "../src/secret-store.ts";

const VALUE = "dori-test-throwaway-123";
type Call = { readonly argv: readonly string[]; readonly stdin?: string };

/** Only legacy decrypts may invoke systemd-creds. */
const fakeCreds = (): { run: Runner; calls: Call[] } => {
  const calls: Call[] = [];
  return { calls, run: async (argv) => {
    calls.push({ argv: [...argv] });
    if (argv[1] !== "decrypt") throw new Error("writes must never invoke systemd-creds");
    return { code: 0, out: Buffer.from(readFileSync(argv[argv.length - 2] as string, "utf8"), "base64").toString(), err: "" };
  } };
};

const codeOf = async (p: Promise<unknown> | (() => unknown)): Promise<SecretStoreErrorCode | undefined> => {
  try { await (typeof p === "function" ? p() : p); } catch (e) { return e instanceof SecretStoreError ? e.code : undefined; }
  return undefined;
};
const mode = (path: string): number => statSync(path).mode & 0o777;

let home: string;
let dir: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "secret-store-")); dir = join(home, "secrets"); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("secretsDir", () => {
  test("joins home/.dori/secrets", () => expect(secretsDir("/h")).toBe(join("/h", ".dori", "secrets")));
});

test("writes always use plain with tight modes, without probing or encrypting", async () => {
  const fake = fakeCreds();
  const store = new SecretStore({ dir, run: fake.run });
  expect(await store.add("API_KEY", VALUE)).toEqual({ name: "API_KEY", backend: "plain" });
  expect(store.list()).toEqual([{ name: "API_KEY", backend: "plain" }]);
  expect(await store.read("API_KEY")).toBe(VALUE);
  expect(fake.calls).toEqual([]);
  expect(mode(dir)).toBe(0o700);
  expect(mode(join(dir, "API_KEY.plain"))).toBe(0o600);
  await store.update("API_KEY", "changed\nsecond line");
  expect(await store.read("API_KEY")).toBe("changed\nsecond line");
  // A hand-written file (echo VALUE > NAME.plain) loses the one newline echo added.
  writeFileSync(join(dir, "API_KEY.plain"), "typed\n", { mode: 0o600 });
  expect(await store.read("API_KEY")).toBe("typed");
  store.delete("API_KEY");
  expect(store.list()).toEqual([]);
});

test("legacy cred reads decrypt --user; updating replaces it with plain", async () => {
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "API_KEY.cred"), Buffer.from(VALUE).toString("base64"), { mode: 0o600 });
  const fake = fakeCreds();
  const store = new SecretStore({ dir, run: fake.run });
  expect(store.list()).toEqual([{ name: "API_KEY", backend: "cred" }]);
  expect(await store.read("API_KEY")).toBe(VALUE);
  expect(fake.calls).toEqual([{ argv: ["systemd-creds", "decrypt", "--user", "--name=API_KEY", join(dir, "API_KEY.cred"), "-"] }]);
  await store.update("API_KEY", "replacement");
  expect(readdirSync(dir)).toEqual(["API_KEY.plain"]);
  expect(await store.read("API_KEY")).toBe("replacement");
});

test("an update interrupted before removing the legacy cred still reads the new plain value", async () => {
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "API_KEY.cred"), Buffer.from("old").toString("base64"), { mode: 0o600 });
  writeFileSync(join(dir, "API_KEY.plain"), "new", { mode: 0o600 });
  const fake = fakeCreds();
  const store = new SecretStore({ dir, run: fake.run });
  expect(await store.read("API_KEY")).toBe("new");
  expect(store.list()).toEqual([{ name: "API_KEY", backend: "plain" }]);
  expect([...(await store.readAll(true))]).toEqual([["API_KEY", "new"]]);
  expect(fake.calls).toEqual([]);
});

test("a failed legacy decrypt remains SECRET_DECRYPT_FAILED", async () => {
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "A.cred"), "legacy");
  const store = new SecretStore({ dir, run: async () => ({ code: 1, out: "", err: "bad" }) });
  expect(await codeOf(store.read("A"))).toBe("SECRET_DECRYPT_FAILED");
});

describe("store rules", () => {
  test("names and values are validated", async () => {
    const store = new SecretStore({ dir, run: fakeCreds().run });
    for (const bad of ["lower", "1ABC", "A-B", "", "A".repeat(65)]) {
      expect(await codeOf(store.add(bad, VALUE))).toBe("SECRET_NAME_INVALID");
    }
    expect(await codeOf(store.read("bad"))).toBe("SECRET_NAME_INVALID");
    expect(await codeOf(() => store.delete("bad"))).toBe("SECRET_NAME_INVALID");
    expect(await codeOf(store.add("OK", ""))).toBe("SECRET_VALUE_EMPTY");
  });

  test("SECRET_EXISTS and SECRET_MISSING", async () => {
    const store = new SecretStore({ dir, run: fakeCreds().run });
    expect(await codeOf(store.update("API_KEY", VALUE))).toBe("SECRET_MISSING");
    expect(await codeOf(store.read("API_KEY"))).toBe("SECRET_MISSING");
    expect(await codeOf(() => store.delete("API_KEY"))).toBe("SECRET_MISSING");
    await store.add("API_KEY", VALUE);
    expect(await codeOf(store.add("API_KEY", VALUE))).toBe("SECRET_EXISTS");
    writeFileSync(join(dir, "OTHER.plain"), VALUE, { mode: 0o600 });
    expect(await codeOf(store.add("OTHER", VALUE))).toBe("SECRET_EXISTS");
  });

  test("list is sorted, skips other files, and is empty for a missing dir", async () => {
    const store = new SecretStore({ dir, run: fakeCreds().run });
    expect(store.list()).toEqual([]);
    await store.add("ZED", VALUE);
    await store.add("ALPHA", VALUE);
    writeFileSync(join(dir, "lower.plain"), "x");
    writeFileSync(join(dir, "NOTE.txt"), "x");
    expect(store.list().map((e) => e.name)).toEqual(["ALPHA", "ZED"]);
  });

  test("readAll skips unreadable entries for masking but rejects a strict lane pull", async () => {
    const store = new SecretStore({ dir, run: fakeCreds().run });
    await store.add("GOOD", VALUE);
    writeFileSync(join(dir, "BAD.cred"), "###");
    const failing: Runner = async (argv, o) => (argv[0] === "systemd-creds" && argv[1] === "decrypt" && String(argv[argv.length - 2]).endsWith("BAD.cred")
      ? { code: 1, out: "", err: "bad" }
      : fakeCreds().run(argv, o));
    const lines: string[] = [];
    expect([...(await new SecretStore({ dir, run: failing, log: (line) => { lines.push(line); } }).readAll())]).toEqual([["GOOD", VALUE]]);
    // Name and code only: the systemd-creds error text ("bad") stays out of the log.
    expect(lines).toEqual(["SECRET_STORE_READ_SKIPPED BAD SECRET_DECRYPT_FAILED"]);
    expect(await codeOf(new SecretStore({ dir, run: failing, log: (line) => { lines.push(line); } }).readAll(true))).toBe("SECRET_DECRYPT_FAILED");
    expect(lines).toHaveLength(1);
  });

  test("an existing dir with group/other bits is refused and left alone", async () => {
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const store = new SecretStore({ dir, run: fakeCreds().run });
    expect(await codeOf(store.add("API_KEY", VALUE))).toBe("SECRET_DIR_UNSAFE");
    expect(await codeOf(() => store.list())).toBe("SECRET_DIR_UNSAFE");
    expect(mode(dir)).toBe(0o755);
  });
});
