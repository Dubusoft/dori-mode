/**
 * Supervisor-side secret store: one file per secret under ~/.dori/secrets.
 *
 * Values never go to argv, stdout, logs or error text: they reach systemd-creds only through stdin and are
 * otherwise held in memory or in a 0600 file. Protection is file mode 0600 (directory 0700) plus optional
 * systemd-creds encryption at rest (`<NAME>.cred`; `<NAME>.plain` when it is unavailable). It does not protect
 * against other processes running as the same UID outside the lane sandbox.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, type Runner } from "./run.ts";
import { SECRET_NAME } from "./secret-name.ts";

/** The store directory under a home directory. */
export const secretsDir = (home: string = homedir()): string => join(home, ".dori", "secrets");

export type SecretBackend = "systemd-creds" | "plain";
export type SecretEntry = { readonly name: string; readonly backend: SecretBackend };
export type SecretStoreErrorCode =
  | "SECRET_NAME_INVALID" | "SECRET_EXISTS" | "SECRET_MISSING" | "SECRET_VALUE_EMPTY"
  | "SECRET_ENCRYPT_FAILED" | "SECRET_DECRYPT_FAILED" | "SECRET_DIR_UNSAFE";

/** A store failure; the message starts with the code and never contains a secret value. */
export class SecretStoreError extends Error {
  constructor(readonly code: SecretStoreErrorCode, message: string) {
    super(message);
    this.name = "SecretStoreError";
  }
}

export type SecretStoreDeps = { readonly dir?: string; readonly run?: Runner };

const PROBE_NAME = "dori-probe";
const EXTENSIONS: readonly { readonly ext: string; readonly backend: SecretBackend }[] = [
  { ext: ".cred", backend: "systemd-creds" },
  { ext: ".plain", backend: "plain" },
];

export class SecretStore {
  readonly dir: string;
  private readonly runner: Runner;
  private available: Promise<boolean> | undefined;

  constructor(deps: SecretStoreDeps = {}) {
    this.dir = deps.dir ?? secretsDir();
    this.runner = deps.run ?? run;
  }

  /** Whether `systemd-creds --user` can encrypt here; probed once with a fixed non-secret string. */
  encryptionAvailable(): Promise<boolean> {
    this.available ??= (async () => {
      if ((await this.runner(["systemd-creds", "--version"])).code !== 0) return false;
      const probe = await this.runner(["systemd-creds", "encrypt", "--user", `--name=${PROBE_NAME}`, "-", "-"], { stdin: PROBE_NAME });
      return probe.code === 0;
    })();
    return this.available;
  }

  /** Stores a new secret; SECRET_EXISTS when the name is taken. */
  async add(name: string, value: string): Promise<SecretEntry> {
    this.check(name, value);
    this.ensureDir();
    if (this.files(name).length > 0) throw new SecretStoreError("SECRET_EXISTS", `SECRET_EXISTS: secret ${name} already exists`);
    return this.write(name, value);
  }

  /** Replaces an existing secret's value; SECRET_MISSING when the name is unknown. */
  async update(name: string, value: string): Promise<SecretEntry> {
    this.check(name, value);
    this.ensureDir();
    if (this.files(name).length === 0) throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING: secret ${name} does not exist`);
    return this.write(name, value);
  }

  /** The stored names with their backend, sorted by name. */
  list(): readonly SecretEntry[] {
    if (!existsSync(this.dir)) return [];
    this.checkDirMode();
    const entries: SecretEntry[] = [];
    for (const file of readdirSync(this.dir)) {
      for (const { ext, backend } of EXTENSIONS) {
        if (!file.endsWith(ext)) continue;
        const name = file.slice(0, -ext.length);
        if (SECRET_NAME.test(name)) entries.push({ name, backend });
      }
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Removes a secret's file(s); SECRET_MISSING when there are none. */
  delete(name: string): void {
    this.checkName(name);
    if (existsSync(this.dir)) this.checkDirMode();
    const found = this.files(name);
    if (found.length === 0) throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING: secret ${name} does not exist`);
    for (const file of found) rmSync(file, { force: true });
  }

  /** The secret's value; SECRET_MISSING when absent, SECRET_DECRYPT_FAILED when systemd-creds refuses. */
  async read(name: string): Promise<string> {
    this.checkName(name);
    if (existsSync(this.dir)) this.checkDirMode();
    const cred = join(this.dir, `${name}.cred`);
    if (existsSync(cred)) {
      const res = await this.runner(["systemd-creds", "decrypt", "--user", `--name=${name}`, cred, "-"]);
      if (res.code !== 0) throw new SecretStoreError("SECRET_DECRYPT_FAILED", `SECRET_DECRYPT_FAILED: ${name}: ${res.err}`);
      return res.out;
    }
    const plain = join(this.dir, `${name}.plain`);
    if (existsSync(plain)) {
      const text = readFileSync(plain, "utf8");
      return text.endsWith("\n") ? text.slice(0, -1) : text;
    }
    throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING: secret ${name} does not exist`);
  }

  /** Every readable secret by name; entries that fail to read are skipped. */
  async readAll(): Promise<ReadonlyMap<string, string>> {
    const values = new Map<string, string>();
    for (const { name } of this.list()) {
      try { values.set(name, await this.read(name)); } catch { /* skipped: unreadable entry */ }
    }
    return values;
  }

  private checkName(name: string): void {
    if (!SECRET_NAME.test(name)) throw new SecretStoreError("SECRET_NAME_INVALID", "SECRET_NAME_INVALID: secret names are upper case letters, digits and _, starting with a letter, at most 64 characters");
  }

  private check(name: string, value: string): void {
    this.checkName(name);
    if (value === "") throw new SecretStoreError("SECRET_VALUE_EMPTY", `SECRET_VALUE_EMPTY: secret ${name} has an empty value`);
  }

  private checkDirMode(): void {
    if ((statSync(this.dir).mode & 0o077) !== 0) throw new SecretStoreError("SECRET_DIR_UNSAFE", `SECRET_DIR_UNSAFE: ${this.dir} is accessible to group or others; fix it with chmod 700`);
  }

  private ensureDir(): void {
    if (existsSync(this.dir)) { this.checkDirMode(); return; }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  private files(name: string): string[] {
    return EXTENSIONS.map(({ ext }) => join(this.dir, `${name}${ext}`)).filter((file) => existsSync(file));
  }

  private async write(name: string, value: string): Promise<SecretEntry> {
    const tmp = join(this.dir, `.${name}.tmp`);
    const encrypted = await this.encryptionAvailable();
    const [keep, drop] = encrypted ? [".cred", ".plain"] : [".plain", ".cred"];
    try {
      if (encrypted) {
        const res = await this.runner(["systemd-creds", "encrypt", "--user", `--name=${name}`, "-", tmp], { stdin: value });
        if (res.code !== 0) throw new SecretStoreError("SECRET_ENCRYPT_FAILED", `SECRET_ENCRYPT_FAILED: ${name}: ${res.err}`);
      } else {
        writeFileSync(tmp, value, { mode: 0o600 });
      }
      chmodSync(tmp, 0o600);
      renameSync(tmp, join(this.dir, `${name}${keep}`));
    } finally {
      rmSync(tmp, { force: true });
    }
    rmSync(join(this.dir, `${name}${drop}`), { force: true });
    return { name, backend: encrypted ? "systemd-creds" : "plain" };
  }
}
