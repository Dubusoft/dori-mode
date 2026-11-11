import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran, Runner } from "../src/run.ts";
import { SecretStore, SecretStoreError, secretsDir, type SecretStoreErrorCode } from "../src/secret-store.ts";

const VALUE = "dori-test-throwaway-123";
type Call = { readonly argv: readonly string[]; readonly stdin?: string };

/** Emulates systemd-creds with base64; code 127 for every call when `missing`; encrypting to a file fails when `failEncrypt` (the probe still passes). */
const fakeCreds = (opts: { missing?: boolean; failEncrypt?: boolean } = {}): { run: Runner; calls: Call[] } => {
  const calls: Call[] = [];
  const run: Runner = async (argv, o) => {
    calls.push({ argv: [...argv], ...(o?.stdin !== undefined ? { stdin: o.stdin } : {}) });
    const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
    if (opts.missing) return { code: 127, out: "", err: "not found" };
    const [, sub] = argv;
    if (sub === "--version") return ok("systemd 999");
    if (sub === "encrypt") {
      const target = argv[argv.length - 1] as string;
      if (opts.failEncrypt && target !== "-") return { code: 1, out: "", err: "Failed to encrypt: no user manager" };
      if (target !== "-") writeFileSync(target, Buffer.from(o?.stdin ?? "").toString("base64"));
      return ok();
    }
    if (sub === "decrypt") {
      const file = argv[argv.length - 2] as string;
      return ok(Buffer.from(readFileSync(file, "utf8"), "base64").toString());
    }
    return { code: 2, out: "", err: "unknown" };
  };
  return { run, calls };
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

describe("systemd-creds backend", () => {
  test("add, list, read, update, delete", async () => {
    const fake = fakeCreds();
    const store = new SecretStore({ dir, run: fake.run });
    expect(await store.add("API_KEY", VALUE)).toEqual({ name: "API_KEY", backend: "systemd-creds" });
    expect(existsSync(join(dir, "API_KEY.cred"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["API_KEY.cred"]);
    expect(store.list()).toEqual([{ name: "API_KEY", backend: "systemd-creds" }]);
    expect(await store.read("API_KEY")).toBe(VALUE);
    await store.update("API_KEY", "dori-test-throwaway-456");
    expect(await store.read("API_KEY")).toBe("dori-test-throwaway-456");
    store.delete("API_KEY");
    expect(store.list()).toEqual([]);
  });

  test("value only goes through stdin, never argv; files are 0600 and dir 0700", async () => {
    const fake = fakeCreds();
    const store = new SecretStore({ dir, run: fake.run });
    await store.add("API_KEY", VALUE);
    await store.read("API_KEY");
    expect(fake.calls.some((c) => c.stdin === VALUE)).toBe(true);
    for (const c of fake.calls) expect(c.argv.join(" ")).not.toContain(VALUE);
    expect(mode(join(dir, "API_KEY.cred"))).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
  });

  test("encryptionAvailable probes once with a non-secret string", async () => {
    const fake = fakeCreds();
    const store = new SecretStore({ dir, run: fake.run });
    expect(await store.encryptionAvailable()).toBe(true);
    expect(await store.encryptionAvailable()).toBe(true);
    expect(fake.calls).toEqual([
      { argv: ["systemd-creds", "--version"] },
      { argv: ["systemd-creds", "encrypt", "--user", "--name=dori-probe", "-", "-"], stdin: "dori-probe" },
    ]);
  });

  test("failed encrypt is SECRET_ENCRYPT_FAILED and leaves no tmp file", async () => {
    const store = new SecretStore({ dir, run: fakeCreds({ failEncrypt: true }).run });
    let message = "";
    try { await store.add("API_KEY", VALUE); } catch (e) { message = (e as Error).message; }
    expect(message).toStartWith("SECRET_ENCRYPT_FAILED");
    expect(message).toContain("no user manager");
    expect(message).not.toContain(VALUE);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("failed decrypt is SECRET_DECRYPT_FAILED", async () => {
    const fake = fakeCreds();
    const store = new SecretStore({ dir, run: fake.run });
    await store.add("API_KEY", VALUE);
    const failing = new SecretStore({ dir, run: async () => ({ code: 1, out: "", err: "bad" }) });
    expect(await codeOf(failing.read("API_KEY"))).toBe("SECRET_DECRYPT_FAILED");
  });

  test("update moves a plain secret to .cred", async () => {
    const plain = new SecretStore({ dir, run: fakeCreds({ missing: true }).run });
    await plain.add("API_KEY", VALUE);
    const store = new SecretStore({ dir, run: fakeCreds().run });
    expect(await store.update("API_KEY", VALUE)).toEqual({ name: "API_KEY", backend: "systemd-creds" });
    expect(readdirSync(dir)).toEqual(["API_KEY.cred"]);
  });
});

describe("plain backend", () => {
  test("falls back when systemd-creds is missing (127)", async () => {
    const fake = fakeCreds({ missing: true });
    const store = new SecretStore({ dir, run: fake.run });
    expect(await store.encryptionAvailable()).toBe(false);
    expect(await store.add("API_KEY", VALUE)).toEqual({ name: "API_KEY", backend: "plain" });
    expect(readdirSync(dir)).toEqual(["API_KEY.plain"]);
    expect(mode(join(dir, "API_KEY.plain"))).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(store.list()).toEqual([{ name: "API_KEY", backend: "plain" }]);
    expect(await store.read("API_KEY")).toBe(VALUE);
    await store.update("API_KEY", "dori-test-throwaway-456");
    expect(await store.read("API_KEY")).toBe("dori-test-throwaway-456");
    for (const c of fake.calls) expect(c.argv.join(" ")).not.toContain(VALUE);
    store.delete("API_KEY");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("read strips one trailing newline", async () => {
    const store = new SecretStore({ dir, run: fakeCreds({ missing: true }).run });
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "A.plain"), `${VALUE}\n\n`);
    expect(await store.read("A")).toBe(`${VALUE}\n`);
  });

  test("probe failure after a working --version also falls back", async () => {
    const run: Runner = async (argv) => ({ code: argv[1] === "--version" ? 0 : 1, out: "", err: "no manager" });
    expect(await new SecretStore({ dir, run }).encryptionAvailable()).toBe(false);
  });
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

  test("readAll skips entries that fail", async () => {
    const store = new SecretStore({ dir, run: fakeCreds().run });
    await store.add("GOOD", VALUE);
    writeFileSync(join(dir, "BAD.cred"), "###");
    const failing: Runner = async (argv, o) => (argv[0] === "systemd-creds" && argv[1] === "decrypt" && String(argv[argv.length - 2]).endsWith("BAD.cred")
      ? { code: 1, out: "", err: "bad" }
      : fakeCreds().run(argv, o));
    const all = await new SecretStore({ dir, run: failing }).readAll();
    expect([...all]).toEqual([["GOOD", VALUE]]);
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
