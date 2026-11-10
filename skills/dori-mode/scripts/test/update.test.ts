import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run, type Runner } from "../src/run.ts";
import { updateInstall } from "../src/update.ts";

setDefaultTimeout(30_000);

let dir = "";
let origin = "";
let install = "";
let pkg = "";
let calls: string[] = [];
let lines: string[] = [];
let unitState = "active";
let quotaBump = false;

const sh = async (cwd: string, ...argv: string[]) => {
  const r = await run(argv, { cwd });
  if (r.code !== 0) throw new Error(`${argv.join(" ")}: ${r.err}`);
  return r.out;
};
const commit = async (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  await sh(cwd, "git", "add", "-A");
  await sh(cwd, "git", "commit", "-qm", `edit ${file}`);
};
/** Real git; systemctl and bun are recorded and answered here. */
const runner: Runner = async (argv, opts) => {
  if (argv[0] === "systemctl" || argv[0] === "bun") {
    calls.push(argv.join(" "));
    if (argv[1] === "update" && quotaBump) writeFileSync(join(pkg, "bun.lock"), "pi-quota newer\n");
    return { code: 0, out: argv[2] === "is-active" ? unitState : "", err: "" };
  }
  return run(argv, opts);
};
const update = (branch: "main" | "dev", force = false) =>
  updateInstall({ run: runner, sleep: async () => undefined, log: (l) => lines.push(l) }, { packageDir: pkg, branch, force });

const updateWith = (upgradeRunners: () => Promise<number>, branch: "main" | "dev") =>
  updateInstall({ run: runner, sleep: async () => undefined, log: (l) => lines.push(l), upgradeRunners }, { packageDir: pkg, branch, force: false });

beforeEach(async () => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dori-update-"));
  calls = []; lines = []; unitState = "active"; quotaBump = false;
  origin = join(dir, "origin");
  mkdirSync(join(origin, "pkg"), { recursive: true });
  await sh(origin, "git", "init", "-q", "-b", "main");
  await sh(origin, "git", "config", "user.email", "t@example.com");
  await sh(origin, "git", "config", "user.name", "t");
  writeFileSync(join(origin, "pkg", "bun.lock"), "v1\n");
  await commit(origin, "notes.txt", "one\n");
  await sh(origin, "git", "branch", "dev");
  install = join(dir, "install");
  await sh(dir, "git", "clone", "-q", "-b", "dev", origin, install);
  await sh(install, "git", "config", "user.email", "t@example.com");
  await sh(install, "git", "config", "user.name", "t");
  pkg = join(install, "pkg");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("nothing new: UP_TO_DATE, no restart; --force restarts anyway", async () => {
  expect(await update("dev")).toBe(0);
  expect(lines.at(-1)).toMatch(/^UP_TO_DATE dev [0-9a-f]{7}$/);
  expect(calls).toEqual(["bun update pi-quota"]);
  expect(await update("dev", true)).toBe(0);
  expect(calls).toContain("systemctl --user restart dori-supervisor.service");
});

test("switches dev -> main, keeps local changes, installs on a lockfile change, restarts", async () => {
  const old = (await sh(install, "git", "rev-parse", "HEAD")).slice(0, 7);
  writeFileSync(join(origin, "pkg", "bun.lock"), "v2\n");
  await commit(origin, "notes.txt", "one\ntwo\n");
  writeFileSync(join(install, "local.txt"), "untracked\n");
  await sh(install, "git", "add", "local.txt");
  expect(await update("main")).toBe(0);
  const now = (await sh(install, "git", "rev-parse", "HEAD")).slice(0, 7);
  expect(lines).toContain("BRANCH_SWITCH dev -> main");
  expect(lines.at(-1)).toBe(`UPDATED main ${old}..${now} supervisor=active`);
  expect(readFileSync(join(install, "local.txt"), "utf8")).toBe("untracked\n");
  expect(await sh(install, "git", "stash", "list")).toBe("");
  expect(calls).toEqual(["bun install --frozen-lockfile", "bun update pi-quota", "systemctl --user restart dori-supervisor.service", "systemctl --user is-active dori-supervisor.service"]);
});

test("workers are migrated on UP_TO_DATE and on UPDATED, and a failure or exception keeps the exit code", async () => {
  let n = 0;
  expect(await updateWith(async () => { n++; return 2; }, "dev")).toBe(0);
  expect(n).toBe(1);
  await commit(origin, "notes.txt", "two\n");
  expect(await updateWith(async () => { n++; throw new Error("boom"); }, "main")).toBe(0);
  expect(n).toBe(2);
  expect(lines).toContain("WARN runners: boom");
  expect(lines.some((l) => l.startsWith("UPDATED main "))).toBe(true);
});

test("the lane sandbox is refreshed on UP_TO_DATE and on UPDATED, its line logged and a throw kept as a WARN", async () => {
  const sandbox = (refreshLaneSandbox: () => string | undefined, branch: "main" | "dev") =>
    updateInstall({ run: runner, sleep: async () => undefined, log: (l) => lines.push(l), refreshLaneSandbox }, { packageDir: pkg, branch, force: false });
  expect(await sandbox(() => "LANE_SANDBOX_UPDATED x", "dev")).toBe(0);
  expect(lines).toContain("LANE_SANDBOX_UPDATED x");
  await commit(origin, "notes.txt", "two\n");
  expect(await sandbox(() => { throw new Error("EACCES"); }, "main")).toBe(0);
  expect(lines).toContain("WARN lane sandbox: EACCES");
  expect(lines.some((l) => l.startsWith("UPDATED main "))).toBe(true);
});

test("the boot-prep script is refreshed before the restart, its line logged and a throw kept as a WARN", async () => {
  const boot = (refreshBootPrep: () => string | undefined, branch: "main" | "dev") =>
    updateInstall({ run: runner, sleep: async () => undefined, log: (l) => lines.push(l), refreshBootPrep }, { packageDir: pkg, branch, force: false });
  expect(await boot(() => "BOOT_PREP_UPDATED x", "dev")).toBe(0);
  expect(lines).toContain("BOOT_PREP_UPDATED x");
  await commit(origin, "notes.txt", "two\n");
  expect(await boot(() => { calls.push("boot"); throw new Error("EACCES"); }, "main")).toBe(0);
  expect(lines).toContain("WARN boot prep: EACCES");
  expect(calls.indexOf("boot")).toBeLessThan(calls.indexOf("systemctl --user restart dori-supervisor.service"));
});

test("workers are migrated only after the restarted supervisor is active", async () => {
  await commit(origin, "notes.txt", "two\n");
  expect(await updateWith(async () => { calls.push("migrate"); return 0; }, "main")).toBe(0);
  expect(calls).toEqual(["bun update pi-quota", "systemctl --user restart dori-supervisor.service", "systemctl --user is-active dori-supervisor.service", "migrate"]);
  await commit(origin, "notes.txt", "three\n");
  unitState = "failed";
  calls = [];
  expect(await updateWith(async () => { calls.push("migrate"); return 0; }, "main")).toBe(1);
  expect(calls).not.toContain("migrate");
});

test("workers are not migrated when the update fails", async () => {
  await sh(install, "git", "checkout", "-q", "main");
  await commit(install, "mine.txt", "local commit\n");
  await commit(origin, "notes.txt", "upstream\n");
  let n = 0;
  expect(await updateWith(async () => { n++; return 0; }, "main")).toBe(1);
  expect(lines.at(-1)).toMatch(/^UPDATE_NOT_FAST_FORWARD /);
  expect(n).toBe(0);
});

test("a newer pi-quota restarts the supervisor without a new commit and leaves the lockfile clean", async () => {
  quotaBump = true;
  const head = (await sh(install, "git", "rev-parse", "HEAD")).slice(0, 7);
  expect(await update("dev")).toBe(0);
  expect(lines).toContain(`PI_QUOTA_UPDATED ${pkg}`);
  expect(lines.at(-1)).toBe(`UPDATED dev ${head}..${head} supervisor=active`);
  expect(calls).toEqual(["bun update pi-quota", "systemctl --user restart dori-supervisor.service", "systemctl --user is-active dori-supervisor.service"]);
  expect(await sh(install, "git", "status", "--porcelain")).toBe("");
});

test("a supervisor that is not active afterwards exits 1", async () => {
  unitState = "failed";
  await commit(origin, "notes.txt", "two\n");
  expect(await update("main")).toBe(1);
  expect(lines.at(-1)).toMatch(/ supervisor=failed$/);
});

test("a stash that does not reapply stops, keeps the stash and does not restart", async () => {
  await commit(origin, "notes.txt", "upstream\n");
  writeFileSync(join(install, "notes.txt"), "local\n");
  expect(await update("main")).toBe(1);
  expect(lines.at(-1)).toMatch(/^UPDATE_STASH_CONFLICT /);
  expect(await sh(install, "git", "stash", "list")).toContain("dori-update");
  expect(calls).toEqual([]);
});

test("a branch that cannot fast-forward stops and restores the checkout", async () => {
  await sh(install, "git", "checkout", "-q", "main");
  await commit(install, "mine.txt", "local commit\n");
  await commit(origin, "notes.txt", "upstream\n");
  writeFileSync(join(install, "notes.txt"), "dirty\n");
  const head = await sh(install, "git", "rev-parse", "HEAD");
  expect(await update("main")).toBe(1);
  expect(lines.at(-1)).toMatch(/^UPDATE_NOT_FAST_FORWARD main /);
  expect(await sh(install, "git", "rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(install, "notes.txt"), "utf8")).toBe("dirty\n");
  expect(calls).toEqual([]);
});
