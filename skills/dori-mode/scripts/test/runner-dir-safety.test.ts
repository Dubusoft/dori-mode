import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRunnerDir, defaultRunnerDir, ensureRunnerDir, ensureRunnerSubdir, holdServeLock, lockDownDatabase, RunnerDirUnsafe,
  runStartupCheck, SERVE_LOCK, writeRunnerFile,
} from "../src/runner/fs-safety.ts";

const roots: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "dori-fs-safety-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const mode = (p: string): number => lstatSync(p).mode & 0o777;
const reasonOf = (fn: () => void): string | undefined => {
  try { fn(); } catch (e) { if (e instanceof RunnerDirUnsafe) return e.reason; throw e; }
  return undefined;
};
const goodDir = (): string => { const d = join(temp(), "runner"); ensureRunnerDir(d); return d; };

describe("runner dir checks", () => {
  test("default dir is under the home", () => {
    expect(defaultRunnerDir("/home/x")).toBe("/home/x/.dori/runner");
  });

  test("ensure creates 0700 and the check passes", () => {
    const d = join(temp(), "a", "runner");
    ensureRunnerDir(d);
    expect(mode(d)).toBe(0o700);
    checkRunnerDir(d);
  });

  test("0755 dir is unsafe (mode)", () => {
    const d = goodDir();
    chmodSync(d, 0o755);
    expect(reasonOf(() => checkRunnerDir(d))).toBe("mode");
    expect(() => checkRunnerDir(d)).toThrow(/^RUNNER_DIR_UNSAFE .* mode/);
    expect(mode(d)).toBe(0o755); // never repaired
  });

  test("symlinked dir is unsafe", () => {
    const root = temp();
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(root, "link");
    symlinkSync(real, link);
    expect(reasonOf(() => checkRunnerDir(link))).toBe("symlink");
    expect(reasonOf(() => ensureRunnerDir(link))).toBe("symlink");
  });

  test("dangling symlink is not created over", () => {
    const root = temp();
    const link = join(root, "link");
    symlinkSync(join(root, "nowhere"), link);
    expect(reasonOf(() => ensureRunnerDir(link))).toBe("symlink");
  });

  test("missing dir is not-directory", () => {
    expect(reasonOf(() => checkRunnerDir(join(temp(), "none")))).toBe("not-directory");
  });

  test("owner mismatch", () => {
    const d = goodDir();
    const uid = lstatSync(d).uid;
    expect(reasonOf(() => checkRunnerDir(d, { uid: uid + 1 }))).toBe("owner");
    checkRunnerDir(d, { uid });
  });

  test("file modes: 0644 file and nested dir modes are unsafe", () => {
    const d = goodDir();
    writeRunnerFile(join(d, "runner.json"), "{}");
    checkRunnerDir(d);
    chmodSync(join(d, "runner.json"), 0o644);
    expect(reasonOf(() => checkRunnerDir(d))).toBe("mode");
    chmodSync(join(d, "runner.json"), 0o600);
    const sock = ensureRunnerSubdir(d, "sock");
    chmodSync(sock, 0o755);
    expect(reasonOf(() => checkRunnerDir(d))).toBe("mode");
  });

  test("files under bin/ and bun/ may be 0700 executables, owner-only; elsewhere 0700 files stay unsafe", () => {
    const d = goodDir();
    for (const sub of ["bin", "bun"]) mkdirSync(join(d, sub), { mode: 0o700 });
    writeFileSync(join(d, "bin/dori"), "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(join(d, "bin/dori.js"), "", { mode: 0o600 });
    writeFileSync(join(d, "bun/bun"), "", { mode: 0o700 });
    checkRunnerDir(d);
    chmodSync(join(d, "bin/dori"), 0o755);
    expect(reasonOf(() => checkRunnerDir(d))).toBe("mode");
    chmodSync(join(d, "bin/dori"), 0o700);
    writeFileSync(join(d, "health"), "");
    chmodSync(join(d, "health"), 0o700);
    expect(reasonOf(() => checkRunnerDir(d))).toBe("mode");
    rmSync(join(d, "health"));
    mkdirSync(join(d, "logs"), { mode: 0o700 });
    writeFileSync(join(d, "logs/x"), "");
    chmodSync(join(d, "logs/x"), 0o700);
    expect(reasonOf(() => checkRunnerDir(d))).toBe("mode");
  });

  test("symlink or wrong type inside is unsafe", () => {
    const d = goodDir();
    writeFileSync(join(d, "sock"), "", { mode: 0o600 });
    expect(reasonOf(() => checkRunnerDir(d))).toBe("not-directory");
    rmSync(join(d, "sock"));
    symlinkSync("/etc/passwd", join(d, "runner.json"));
    expect(reasonOf(() => checkRunnerDir(d))).toBe("symlink");
    rmSync(join(d, "runner.json"));
    mkdirSync(join(d, "state.sqlite"), { mode: 0o700 });
    expect(reasonOf(() => checkRunnerDir(d))).toBe("not-file");
  });
});

describe("creation and atomic writes", () => {
  test("subdir is 0700 and refuses a symlink", () => {
    const d = goodDir();
    const sock = ensureRunnerSubdir(d, "sock");
    expect(mode(sock)).toBe(0o700);
    expect(ensureRunnerSubdir(d, "sock")).toBe(sock);
    symlinkSync(temp(), join(d, "bodies"));
    expect(reasonOf(() => ensureRunnerSubdir(d, "bodies"))).toBe("symlink");
  });

  test("writeRunnerFile is 0600, replaces content, leaves no temp file", () => {
    const d = goodDir();
    const f = join(d, "runner.json");
    writeRunnerFile(f, "one");
    writeRunnerFile(f, "two");
    expect(readFileSync(f, "utf8")).toBe("two");
    expect(mode(f)).toBe(0o600);
    expect(readdirSync(d)).toEqual(["runner.json"]);
    checkRunnerDir(d);
  });

  test("lockDownDatabase tightens the db and companions that exist", () => {
    const d = goodDir();
    const db = join(d, "state.sqlite");
    for (const f of [db, `${db}-wal`]) writeFileSync(f, "", { mode: 0o644 });
    lockDownDatabase(db);
    expect(mode(db)).toBe(0o600);
    expect(mode(`${db}-wal`)).toBe(0o600);
    expect(() => lstatSync(`${db}-shm`)).toThrow();
    checkRunnerDir(d);
  });
});

describe("serve lock", () => {
  test("a second process cannot take the serve lock while the first holds it; the lock file keeps the dir safe", async () => {
    const d = goodDir();
    const script = `import { holdServeLock } from ${JSON.stringify(join(import.meta.dir, "../src/runner/fs-safety.ts"))};
      const release = holdServeLock(${JSON.stringify(d)});
      console.log(release ? "HELD" : "BUSY");
      if (release) { await Bun.stdin.text(); release(); }`;
    const holder = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe" });
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("HELD");

    expect(holdServeLock(d)).toBeUndefined();
    expect(mode(join(d, SERVE_LOCK))).toBe(0o600);
    checkRunnerDir(d);

    holder.stdin.end();
    expect(await holder.exited).toBe(0);
    const release = holdServeLock(d);
    expect(release).toBeDefined();
    release?.();
  });
});

describe("startup gate", () => {
  const capture = () => {
    const out = { err: "", codes: [] as number[] };
    return { out, io: { stderr: (t: string) => { out.err += t; }, exit: (c: number) => { out.codes.push(c); } } };
  };

  test("safe dir continues without output", () => {
    const { out, io } = capture();
    expect(runStartupCheck(join(temp(), "runner"), io)).toBe(true);
    expect(out).toEqual({ err: "", codes: [] });
  });

  test("0755 dir writes the line and exits 1", () => {
    const d = goodDir();
    chmodSync(d, 0o755);
    const { out, io } = capture();
    expect(runStartupCheck(d, io)).toBe(false);
    expect(out.err).toBe(`RUNNER_DIR_UNSAFE ${d} mode mode=0755\n`);
    expect(out.codes).toEqual([1]);
  });

  test("real process: symlink and 0755 exit 1 with the stderr line", async () => {
    const root = temp();
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(root, "link");
    symlinkSync(real, link);
    const loose = join(root, "loose");
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    const entry = join(root, "entry.ts");
    const mod = join(import.meta.dir, "../src/runner/fs-safety.ts");
    writeFileSync(entry, `import { runStartupCheck } from ${JSON.stringify(mod)};
runStartupCheck(process.argv[2]!, { stderr: (t) => process.stderr.write(t), exit: (c) => process.exit(c) });
`);
    const run = async (dir: string) => {
      const proc = Bun.spawn([process.execPath, "run", entry, dir], { stdout: "pipe", stderr: "pipe" });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { err, code };
    };
    const a = await run(link);
    expect(a.code).toBe(1);
    expect(a.err).toStartWith(`RUNNER_DIR_UNSAFE ${link} symlink`);
    const b = await run(loose);
    expect(b.code).toBe(1);
    expect(b.err).toStartWith(`RUNNER_DIR_UNSAFE ${loose} mode`);
    const ok = await run(join(root, "fresh"));
    expect(ok.code).toBe(0);
  });
});
