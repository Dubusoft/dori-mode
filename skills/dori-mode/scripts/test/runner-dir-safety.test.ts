import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  checkRunnerDir, defaultRunnerDir, ensureRunnerDir, ensureRunnerSubdir, holdServeLock, lockDownDatabase, RunnerDirUnsafe,
  runStartupCheck, SERVE_LOCK, writeRunnerFile, type FsSafetyOptions,
} from "../src/runner/fs-safety.ts";
import { IO_REPARSE_TAG_AF_UNIX, type AclInfo } from "../src/runner/win-acl.ts";
import { captureOutput } from "../src/runner/lane-files.ts";

const roots: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "dori-fs-safety-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const mode = (p: string): number => lstatSync(p).mode & 0o777;
const reasonOf = (fn: () => void): string | undefined => {
  try { fn(); } catch (e) { if (e instanceof RunnerDirUnsafe) return e.reason; throw e; }
  return undefined;
};
const goodDir = (): string => { const d = join(temp(), "runner"); ensureRunnerDir(d); return d; };

test("only exact own-key .out roots exempt untrusted children; capture still refuses links", () => {
  const dir = goodDir(), briefs = ensureRunnerSubdir(dir, "briefs"), out = join(briefs, "lane-a.out");
  mkdirSync(out, { mode: 0o700 });
  writeFileSync(join(out, "report.md"), "ordinary 0644 file", { mode: 0o644 });
  symlinkSync(join(dir, "missing"), join(out, "bad"));
  checkRunnerDir(dir);
  expect(() => captureOutput(dir, "lane-a", { id: "00000000-0000-4000-8000-000000000001", requiredReport: false })).toThrow("(symlink)");
  chmodSync(out, 0o755);
  expect(reasonOf(() => checkRunnerDir(dir))).toBe("mode");
  chmodSync(out, 0o700);
  for (const name of ["lane-a.files", "lane-a.out-extra", "con.out", "bad..out"]) {
    const control = join(briefs, name);
    mkdirSync(control, { mode: 0o700 });
    writeFileSync(join(control, "bad"), "", { mode: 0o644 });
    expect(reasonOf(() => checkRunnerDir(dir))).toBe("mode");
    rmSync(control, { recursive: true });
  }
  const elsewhere = ensureRunnerSubdir(dir, "lane-b.out");
  writeFileSync(join(elsewhere, "bad"), "", { mode: 0o644 });
  expect(reasonOf(() => checkRunnerDir(dir))).toBe("mode");
  rmSync(elsewhere, { recursive: true });
  rmSync(out, { recursive: true });
  symlinkSync(briefs, out);
  expect(reasonOf(() => checkRunnerDir(dir))).toBe("symlink");
  rmSync(out); writeFileSync(out, "", { mode: 0o600 });
  expect(reasonOf(() => checkRunnerDir(dir))).toBe("not-directory");
});

test("Windows output root ACL/reparse checks remain strict without reading descendants", () => {
  const dir = goodDir(), briefs = ensureRunnerSubdir(dir, "briefs"), out = join(briefs, "lane-a.out");
  mkdirSync(out, { mode: 0o700 });
  writeFileSync(join(out, "untrusted"), "");
  const sid = "S-1-5-21-1";
  const calls: string[] = [];
  const options = { platform: "win32" as const, userSid: sid, acl: (path: string) => {
    calls.push(path); return { owner: sid, sddl: `O:${sid}D:P(A;;FA;;;${sid})` };
  } };
  checkRunnerDir(dir, options);
  expect(calls).toContain(out);
  expect(calls).not.toContain(join(out, "untrusted"));
  expect(reasonOf(() => checkRunnerDir(dir, { ...options, acl: (path) => ({ ...options.acl(path), ...(path === out ? { reparseTag: 0xa000000c } : {}) }) }))).toBe("symlink");
  expect(reasonOf(() => checkRunnerDir(dir, { ...options, acl: (path) => ({ owner: path === out ? "S-1-5-21-2" : sid, sddl: path === out ? "O:S-1-5-21-2D:P(A;;FA;;;S-1-5-21-2)" : options.acl(path).sddl }) }))).toBe("owner");
});

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

describe("win32 rules (injected ACL reader)", () => {
  const USER = "S-1-5-21-1004336348-1177238915-682003330-1001";
  const OTHER = "S-1-5-21-1004336348-1177238915-682003330-1002";
  const ROOT_SDDL = `O:${USER}G:${USER}D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
  const CHILD_SDDL = `O:${USER}G:${USER}D:AI(A;OICIID;FA;;;${USER})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`;
  const JUNCTION_TAG = 0xa0000003;

  /** The root gets the protected DACL, everything else the inherited one; `overrides` are keyed by path relative to the root. */
  const win = (root: string, overrides: Record<string, Partial<AclInfo>> = {}, read: string[] = []): FsSafetyOptions => ({
    platform: "win32",
    userSid: USER,
    acl: (path) => {
      read.push(path);
      const rel = relative(root, path);
      return { owner: USER, sddl: rel === "" ? ROOT_SDDL : CHILD_SDDL, ...overrides[rel] };
    },
  });
  const winDir = (): string => {
    const d = goodDir();
    writeRunnerFile(join(d, "runner.json"), "{}");
    mkdirSync(join(d, "sock"), { mode: 0o700 });
    mkdirSync(join(d, "logs"), { mode: 0o700 });
    writeFileSync(join(d, "logs", "runner.log"), "", { mode: 0o600 });
    return d;
  };
  const messageOf = (fn: () => void): string | undefined => {
    try { fn(); } catch (e) { if (e instanceof RunnerDirUnsafe) return e.message; throw e; }
    return undefined;
  };

  test("a protected owner-only root with inherited children passes, and every entry is read", () => {
    const d = winDir();
    const read: string[] = [];
    checkRunnerDir(d, win(d, {}, read));
    expect(read.map((p) => relative(d, p)).sort()).toEqual(["", "logs", "logs/runner.log", "runner.json", "sock"]);
  });

  test("uid and mode are not checked on win32", () => {
    const d = winDir();
    chmodSync(d, 0o755);
    chmodSync(join(d, "runner.json"), 0o644);
    checkRunnerDir(d, { ...win(d), uid: lstatSync(d).uid + 1 });
    expect(reasonOf(() => checkRunnerDir(d))).toBe("mode");
  });

  test("an inherited (unprotected) DACL on the root fails as acl", () => {
    const d = winDir();
    expect(messageOf(() => checkRunnerDir(d, win(d, { "": { sddl: CHILD_SDDL } })))).toBe(`RUNNER_DIR_UNSAFE ${d} acl dacl=unprotected`);
  });

  test("Everyone, Users or another SID on any entry fails as acl", () => {
    const d = winDir();
    const file = join(d, "logs", "runner.log");
    expect(messageOf(() => checkRunnerDir(d, win(d, { "logs/runner.log": { sddl: `${CHILD_SDDL}(A;;0x1200a9;;;WD)` } })))).toBe(`RUNNER_DIR_UNSAFE ${file} acl allow=S-1-1-0`);
    expect(messageOf(() => checkRunnerDir(d, win(d, { "": { sddl: `${ROOT_SDDL}(A;OICI;0x1200a9;;;BU)` } })))).toBe(`RUNNER_DIR_UNSAFE ${d} acl allow=S-1-5-32-545`);
    expect(messageOf(() => checkRunnerDir(d, win(d, { sock: { sddl: `${CHILD_SDDL}(A;OICI;FA;;;${OTHER})` } })))).toBe(`RUNNER_DIR_UNSAFE ${join(d, "sock")} acl allow=${OTHER}`);
  });

  test("an Administrators owner fails as owner", () => {
    const d = winDir();
    const opts = win(d, { "runner.json": { owner: "S-1-5-32-544", sddl: CHILD_SDDL.replace(`O:${USER}`, "O:BA") } });
    expect(messageOf(() => checkRunnerDir(d, opts))).toBe(`RUNNER_DIR_UNSAFE ${join(d, "runner.json")} owner owner=S-1-5-32-544`);
  });

  test("symlinks and junctions fail as symlink", () => {
    const d = winDir();
    symlinkSync(temp(), join(d, "bodies"));
    expect(reasonOf(() => checkRunnerDir(d, win(d)))).toBe("symlink");
    rmSync(join(d, "bodies"));
    mkdirSync(join(d, "bodies"), { mode: 0o700 });
    expect(messageOf(() => checkRunnerDir(d, win(d, { bodies: { reparseTag: JUNCTION_TAG } })))).toBe(`RUNNER_DIR_UNSAFE ${join(d, "bodies")} symlink tag=0xa0000003`);
    expect(reasonOf(() => checkRunnerDir(d, win(d, { "": { reparseTag: JUNCTION_TAG } })))).toBe("symlink");
  });

  test("the AF_UNIX socket reparse point passes only directly under sock", () => {
    const d = winDir();
    writeFileSync(join(d, "sock", "lane.sock"), "");
    checkRunnerDir(d, win(d, { "sock/lane.sock": { reparseTag: IO_REPARSE_TAG_AF_UNIX } }));
    expect(reasonOf(() => checkRunnerDir(d, win(d, { "logs/runner.log": { reparseTag: IO_REPARSE_TAG_AF_UNIX } })))).toBe("symlink");
    expect(reasonOf(() => checkRunnerDir(d, win(d, { "runner.json": { reparseTag: IO_REPARSE_TAG_AF_UNIX } })))).toBe("symlink");
    expect(reasonOf(() => checkRunnerDir(d, win(d, { sock: { reparseTag: IO_REPARSE_TAG_AF_UNIX } })))).toBe("symlink");
    mkdirSync(join(d, "sock", "nested"), { mode: 0o700 });
    writeFileSync(join(d, "sock", "nested", "x.sock"), "");
    expect(reasonOf(() => checkRunnerDir(d, win(d, { "sock/nested/x.sock": { reparseTag: IO_REPARSE_TAG_AF_UNIX } })))).toBe("symlink");
    rmSync(join(d, "sock", "nested"), { recursive: true });
    rmSync(join(d, "sock", "lane.sock"));
    symlinkSync(join(d, "runner.json"), join(d, "sock", "lane.sock"));
    expect(reasonOf(() => checkRunnerDir(d, win(d)))).toBe("symlink");
  });

  test("UNC paths fail as remote before anything is read or created", () => {
    for (const unc of ["\\\\server\\share\\runner", "//server/share/runner", "\\\\?\\UNC\\server\\share\\runner"]) {
      const read: string[] = [];
      expect(messageOf(() => ensureRunnerDir(unc, win(unc, {}, read)))).toBe(`RUNNER_DIR_UNSAFE ${unc} remote unc`);
      expect(read).toEqual([]);
    }
    const out = { err: "", codes: [] as number[] };
    expect(runStartupCheck("//server/share/runner", { stderr: (t) => { out.err += t; }, exit: (c) => { out.codes.push(c); } }, win("//server/share/runner"))).toBe(false);
    expect(out).toEqual({ err: "RUNNER_DIR_UNSAFE //server/share/runner remote unc\n", codes: [1] });
  });

  test("lockDownDatabase leaves modes alone on win32", () => {
    const d = goodDir();
    const db = join(d, "state.sqlite");
    writeFileSync(db, "", { mode: 0o644 });
    chmodSync(db, 0o644);
    lockDownDatabase(db, { platform: "win32" });
    expect(mode(db)).toBe(0o644);
    lockDownDatabase(db, { platform: "linux" });
    expect(mode(db)).toBe(0o600);
  });

  test("ensureRunnerDir creates the dir on win32 and checks it with the ACL reader", () => {
    const d = join(temp(), "w", "runner");
    const read: string[] = [];
    ensureRunnerDir(d, win(d, {}, read));
    expect(lstatSync(d).isDirectory()).toBe(true);
    expect(read).toEqual([d]);
    expect(ensureRunnerSubdir(d, "keys", { platform: "win32" })).toBe(join(d, "keys"));
  });
});
