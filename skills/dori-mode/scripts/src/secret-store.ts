/** One 0600 plain file per secret under the 0700 supervisor store; legacy credentials remain readable. */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { replaceFileDurable } from "./durable-write.ts";
import { run, type Runner } from "./run.ts";
import { SECRET_NAME } from "./secret-name.ts";

/** The store directory under a home directory. */
export const secretsDir = (home: string = homedir()): string => join(home, ".dori", "secrets");

export type SecretBackend = "cred" | "plain";
export type SecretEntry = { readonly name: string; readonly backend: SecretBackend };
export type SecretStoreErrorCode =
  | "SECRET_NAME_INVALID" | "SECRET_EXISTS" | "SECRET_MISSING" | "SECRET_VALUE_EMPTY"
  | "SECRET_DECRYPT_FAILED" | "SECRET_DIR_UNSAFE";

/** A store failure; the message starts with the code and never contains a secret value. */
export class SecretStoreError extends Error {
  constructor(readonly code: SecretStoreErrorCode, message: string) {
    super(message);
    this.name = "SecretStoreError";
  }
}

export type SecretStoreDeps = { readonly dir?: string; readonly run?: Runner; readonly log?: (line: string) => void };

const EXTENSIONS: readonly { readonly ext: string; readonly backend: SecretBackend }[] = [
  { ext: ".cred", backend: "cred" },
  { ext: ".plain", backend: "plain" },
];

export class SecretStore {
  readonly dir: string;
  private readonly runner: Runner;
  private readonly log: (line: string) => void;

  constructor(deps: SecretStoreDeps = {}) {
    this.dir = deps.dir ?? secretsDir();
    this.runner = deps.run ?? run;
    this.log = deps.log ?? ((line) => { console.error(line); });
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

  /** The stored names with the backend read() uses, sorted by name. */
  list(): readonly SecretEntry[] {
    if (!existsSync(this.dir)) return [];
    this.checkDirMode();
    const backends = new Map<string, SecretBackend>();
    for (const file of readdirSync(this.dir)) {
      for (const { ext, backend } of EXTENSIONS) {
        if (!file.endsWith(ext)) continue;
        const name = file.slice(0, -ext.length);
        if (SECRET_NAME.test(name) && backends.get(name) !== "plain") backends.set(name, backend);
      }
    }
    return [...backends]
      .map(([name, backend]) => ({ name, backend }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Removes a secret's file(s); SECRET_MISSING when there are none. */
  delete(name: string): void {
    this.checkName(name);
    if (existsSync(this.dir)) this.checkDirMode();
    const found = this.files(name);
    if (found.length === 0) throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING: secret ${name} does not exist`);
    for (const file of found) rmSync(file, { force: true });
  }

  /**
   * The secret's value; SECRET_MISSING when absent, SECRET_DECRYPT_FAILED when systemd-creds refuses. The .plain file
   * wins over a legacy .cred: writes only produce .plain, so a .cred beside it is one a write did not get to remove.
   */
  async read(name: string): Promise<string> {
    this.checkName(name);
    if (existsSync(this.dir)) this.checkDirMode();
    const plain = join(this.dir, `${name}.plain`);
    if (existsSync(plain)) {
      // A hand-written file (echo VALUE > NAME.plain) ends in a newline the value never had.
      const text = readFileSync(plain, "utf8");
      return text.endsWith("\n") ? text.slice(0, -1) : text;
    }
    const cred = join(this.dir, `${name}.cred`);
    if (existsSync(cred)) {
      const res = await this.runner(["systemd-creds", "decrypt", "--user", `--name=${name}`, cred, "-"]);
      if (res.code !== 0) throw new SecretStoreError("SECRET_DECRYPT_FAILED", `SECRET_DECRYPT_FAILED: ${name}: ${res.err}`);
      return res.out;
    }
    throw new SecretStoreError("SECRET_MISSING", `SECRET_MISSING: secret ${name} does not exist`);
  }

  /**
   * Every readable secret by name; strict pulls reject instead of skipping unreadable entries. A skipped entry is logged
   * as SECRET_STORE_READ_SKIPPED with its name and error code only: the error text may quote what systemd-creds printed.
   */
  async readAll(strict = false): Promise<ReadonlyMap<string, string>> {
    const values = new Map<string, string>();
    for (const { name } of this.list()) {
      try { values.set(name, await this.read(name)); } catch (error) {
        if (strict) throw error;
        this.log(`SECRET_STORE_READ_SKIPPED ${name}${error instanceof SecretStoreError ? ` ${error.code}` : ""}`);
      }
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
    replaceFileDurable(join(this.dir, `${name}.plain`), value, 0o600);
    rmSync(join(this.dir, `${name}.cred`), { force: true });
    return { name, backend: "plain" };
  }
}
