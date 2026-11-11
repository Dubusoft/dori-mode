import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLEANUP_CHECK_MS, CLEANUP_FIRST_DELAY_MS, cleanupLine, cleanupPaths, type CleanupDeps, type CleanupPaths, type CleanupReport,
  memoryAgentSuffix, parseLsof, runCleanup, sessionDirName, startCleanup,
} from "../src/runner/cleanup.ts";
import { run as realRun } from "../src/run.ts";

// Real git subprocesses (init, worktree add/prune) run in the fixture; the budget only bounds a hang.
setDefaultTimeout(30_000);

const DAY = 24 * 60 * 60_000;
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** ctime cannot be set back, so the sweep runs at `NOW` (40 days ahead): entries made now are old, `fresh` ones are moved to NOW. */
const NOW = Date.now() + 40 * DAY;
const file = (path: string, text = "x"): string => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
const fresh = (path: string, at = NOW): string => { utimesSync(path, new Date(at), new Date(at)); return path; };
const git = async (...args: string[]): Promise<string> => {
  const r = await realRun(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
};

type Fixture = { home: string; tmp: string; paths: CleanupPaths };
const fixture = (): Fixture => {
  const base = mkdtempSync(join(tmpdir(), "dori-cleanup-"));
  roots.push(base);
  const home = join(base, "home"), tmp = join(base, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const linux = cleanupPaths("linux", { HOME: home }, "/unused");
  const { varTmp: _varTmp, ...rest } = linux;
  return { home, tmp, paths: { ...rest, temps: [tmp] } };
};
const deps = (f: Fixture, over: Partial<CleanupDeps> = {}): CleanupDeps => ({
  paths: f.paths, now: NOW, run: realRun, log: () => {}, repos: [], openLanes: [], keepAgents: [],
  inUse: async () => ({ files: [], dirs: [] }), uid: process.getuid?.(), ...over,
});

test("removes aged lane temp, temp files, browser profiles, memory agents and empty dirs; archives old sessions", async () => {
  const f = fixture();
  const { paths, tmp } = f;
  const sandboxOld = file(join(paths.laneSandbox, "closed-lane", "build", "a.o"));
  const omoOld = file(join(paths.omoTmp, "tmp.abc", "out.bin"), "0123456789");
  const omoFresh = fresh(file(join(paths.omoTmp, "tmp.new", "out.bin")));
  const tempOld = file(join(tmp, "stale-dir", "deep", "f.txt"));
  const tempFresh = fresh(file(join(tmp, "recent.txt")));
  const chromeOld = join(tmp, ".abc.bun-chrome");
  file(join(chromeOld, "Default", "Prefs"));
  const chromeFresh = join(tmp, ".def.bun-chrome");
  fresh(file(join(chromeFresh, "Prefs")));
  const sessionDir = join(paths.sessions, "--data-old--");
  const oldSession = file(join(sessionDir, "2026-09-01_a.jsonl"), "{}\n");
  file(join(sessionDir, "2026-09-01_a-artifacts", "shot.png"));
  const newSession = fresh(file(join(sessionDir, "2026-11-01_b.jsonl"), "{}\n"));
  const emptyArtifacts = join(sessionDir, "2026-10-01_c-artifacts");
  mkdirSync(emptyArtifacts);
  const emptyEvidence = join(paths.evidence, "lane-x", "shots");
  mkdirSync(emptyEvidence, { recursive: true });
  const agentOld = join(paths.memoryAgents, `gone${memoryAgentSuffix("/data/gone")}`);
  file(join(agentOld, "repo", "system", "persona.md"));

  const report = await runCleanup(deps(f));

  for (const gone of [sandboxOld, join(paths.laneSandbox, "closed-lane"), omoOld, tempOld, join(tmp, "stale-dir"), chromeOld, emptyArtifacts, emptyEvidence, agentOld]) {
    expect({ gone, exists: existsSync(gone) }).toEqual({ gone, exists: false });
  }
  for (const kept of [omoFresh, tempFresh, chromeFresh, newSession, paths.evidence, paths.laneSandbox]) expect(existsSync(kept)).toBe(true);
  expect(existsSync(oldSession)).toBe(false);
  const archived = join(paths.sessionsArchive, "--data-old--");
  expect(readFileSync(join(archived, "2026-09-01_a.jsonl"), "utf8")).toBe("{}\n");
  expect(existsSync(join(archived, "2026-09-01_a-artifacts", "shot.png"))).toBe(true);
  expect(report.targets.sessionsArchived?.removed).toBe(1);
  expect(report.targets.bunChrome?.removed).toBe(1);
  expect(report.targets.memoryAgents?.removed).toBe(1);
  expect(report.inUse).toBe("ok");
  expect(cleanupLine(report)).toMatch(/^RUNNER_CLEANUP at=\S+ .*sandbox=\d+ .*bunChrome=1 .*memoryAgents=1 .*errors=0 /);
});

test("never removes open lanes' dirs, git checkouts, secrets, live-session temp, in-use files or roots that hold home", async () => {
  const f = fixture();
  const { paths, tmp, home } = f;
  const laneCwd = join(tmp, "open-lane-cwd");
  const laneFile = file(join(laneCwd, "notes.txt"));
  const sandboxOpen = file(join(paths.laneSandbox, "open-lane", "cache.bin"));
  const sessionOpen = file(join(paths.sessions, sessionDirName(laneCwd), "2026-09-01_x.jsonl"));
  const agentOpen = join(paths.memoryAgents, `open${memoryAgentSuffix(laneCwd)}`);
  file(join(agentOpen, "repo", "a.md"));
  const agentLead = join(paths.memoryAgents, `lead${memoryAgentSuffix("/home/u/.dori/lead")}`);
  file(join(agentLead, "repo", "a.md"));
  // A dirty checkout in temp, old by age: left whole.
  const dirty = join(tmp, "scratch-wt");
  mkdirSync(dirty);
  await git("-C", dirty, "init", "-q");
  const dirtyFile = file(join(dirty, "wip.ts"), "uncommitted");
  const secretsA = file(join(home, ".dori", "secrets", "store.json"));
  const secretsB = file(join(home, ".secrets", "token"));
  const live = [file(join(tmp, "tmux-1000", "default")), file(join(tmp, "herdr-x", "s")), file(join(tmp, "senpi-abc", "f")), file(join(tmp, "a.lock")), file(join(tmp, "proj", "x.lock"))];
  const held = file(join(tmp, "held", "open.log"));
  const busyDir = file(join(tmp, "busy", "inner", "f.txt"));
  const outside = file(join(dirname(home), "outside", "keep.txt"));
  symlinkSync(join(dirname(home), "outside"), join(tmp, "link-out"));

  const report = await runCleanup(deps(f, {
    openLanes: [{ key: "open-lane", cwd: laneCwd }],
    keepAgents: ["/home/u/.dori/lead"],
    inUse: async () => ({ files: [held], dirs: [join(tmp, "busy")] }),
  }));
  for (const kept of [laneFile, sandboxOpen, sessionOpen, agentOpen, agentLead, dirtyFile, secretsA, secretsB, ...live, held, busyDir, outside, join(tmp, "link-out")]) {
    expect({ kept, exists: existsSync(kept) }).toEqual({ kept, exists: true });
  }
  expect(report.targets.temp?.kept).toBeGreaterThan(0);

  // A temp root that is the home dir, or a secret store, is refused whole.
  const refused = await runCleanup(deps(f, { paths: { ...paths, temps: [home, join(home, ".dori", "secrets"), "/"] } }));
  expect(refused.skippedRoots).toEqual(expect.arrayContaining([home, join(home, ".dori", "secrets"), "/"]));
  expect(existsSync(secretsA) && existsSync(secretsB)).toBe(true);
});

test("a failed in-use listing skips the deleting targets instead of guessing", async () => {
  const f = fixture();
  const tempOld = file(join(f.tmp, "stale.txt"));
  const report = await runCleanup(deps(f, { inUse: async () => { throw new Error("lsof timed out"); } }));
  expect(existsSync(tempOld)).toBe(true);
  expect(report.inUse).toBe("failed");
  expect(cleanupLine(report)).toContain("inUse=failed");
});

test("git worktree prune drops records of deleted worktrees and keeps existing dirty ones", async () => {
  const f = fixture();
  const repo = join(f.tmp, "..", "repo");
  mkdirSync(repo);
  await git("-C", repo, "init", "-q", "-b", "main");
  file(join(repo, "a.txt"));
  await git("-C", repo, "add", "a.txt");
  await git("-C", repo, "commit", "-q", "-m", "a");
  const gone = join(f.tmp, "..", "wt-gone"), dirty = join(f.tmp, "..", "wt-dirty");
  await git("-C", repo, "worktree", "add", "-q", "-b", "g", gone);
  await git("-C", repo, "worktree", "add", "-q", "-b", "d", dirty);
  file(join(dirty, "wip.txt"), "uncommitted");
  rmSync(gone, { recursive: true, force: true });

  const report = await runCleanup(deps(f, { repos: [repo, join(f.tmp, "..", "not-a-repo")] }));
  const listed = await git("-C", repo, "worktree", "list", "--porcelain");
  expect(listed).not.toContain("wt-gone");
  expect(listed).toContain("wt-dirty");
  expect(readFileSync(join(dirty, "wip.txt"), "utf8")).toBe("uncommitted");
  expect(report.worktreePrune).toEqual({ ok: 1, failed: 1 });
});

test("paths resolve per OS: Windows from USERPROFILE and TEMP, macOS adds TMPDIR, Linux sweeps /tmp and /var/tmp", () => {
  const win = cleanupPaths("win32", { USERPROFILE: "C:\\Users\\dori", TEMP: "C:\\Users\\dori\\AppData\\Local\\Temp\\" }, "C:\\fallback");
  expect(win.home).toBe("C:\\Users\\dori");
  expect(win.temps).toEqual(["C:\\Users\\dori\\AppData\\Local\\Temp"]);
  expect(win.omoTmp).toBe("C:\\Users\\dori\\.cache\\omo-tmp");
  expect(win.sessions).toBe("C:\\Users\\dori\\.omo\\agent\\sessions");
  expect(win.memoryAgents).toBe("C:\\Users\\dori\\.omo\\memory\\agents");
  expect(win.evidence).toBe("C:\\Users\\dori\\.dori\\runner\\evidence");
  expect(win.secrets).toEqual(["C:\\Users\\dori\\.dori\\secrets", "C:\\Users\\dori\\.secrets"]);
  expect(win.varTmp).toBeUndefined();
  expect(cleanupPaths("win32", { USERPROFILE: "D:\\u", TMP: "D:\\t" }, "x").temps).toEqual(["D:\\t"]);
  expect(cleanupPaths("win32", { USERPROFILE: "D:\\u", LOCALAPPDATA: "D:\\u\\AppData\\Local" }, "x").temps).toEqual(["D:\\u\\AppData\\Local\\Temp"]);
  expect(cleanupPaths("win32", {}, "C:\\Users\\fb").home).toBe("C:\\Users\\fb");

  const mac = cleanupPaths("darwin", { HOME: "/Users/dori", TMPDIR: "/var/folders/ab/xyz/T/" }, "/x");
  expect(mac.temps).toEqual(["/var/folders/ab/xyz/T", "/tmp"]);
  expect(mac.varTmp).toBeUndefined();
  const linux = cleanupPaths("linux", { HOME: "/home/u", TMPDIR: "/home/u/.lane-tmp" }, "/x");
  expect(linux.temps).toEqual(["/tmp"]);
  expect(linux.varTmp).toBe("/var/tmp");
  expect(linux.laneSandbox).toBe("/home/u/.cache/omo-tmp/lane-sandbox");
});

test("a Windows TEMP inside the profile is a valid root, the profile itself is not", async () => {
  const f = fixture();
  const inside = join(f.home, "AppData", "Local", "Temp");
  const old = file(join(inside, "x.tmp"));
  const report = await runCleanup(deps(f, { paths: { ...f.paths, temps: [inside, f.home] } }));
  expect(existsSync(old)).toBe(false);
  expect(report.skippedRoots).toEqual([f.home, f.home]);
});

test("parseLsof splits open files from working directories", () => {
  expect(parseLsof("p12\nfcwd\nn/Users/u/proj\nf3\nn/private/tmp/a.log\nf4\nn/dev/null\n")).toEqual({ files: ["/private/tmp/a.log", "/dev/null"], dirs: ["/Users/u/proj"] });
});

test("the schedule sweeps after the first delay, then only when the last sweep is a day old", async () => {
  const f = fixture();
  const statusFile = join(f.tmp, "cleanup.json");
  let clock = NOW;
  let delayed: (() => void) | undefined, ticker: (() => void) | undefined, delayMs = 0, everyMs = 0;
  const lines: string[] = [];
  let sweeps = 0;
  let settle: () => void = () => {};
  const report = (): CleanupReport => ({ at: new Date(clock).toISOString(), ms: 1, targets: {}, worktreePrune: { ok: 0, failed: 0 }, inUse: "ok", skippedRoots: [], errors: [] });
  const stop = startCleanup({
    statusFile, now: () => clock, log: (l) => { lines.push(l); settle(); },
    delay: (ms, fn) => { delayMs = ms; delayed = fn; return () => {}; },
    every: (ms, fn) => { everyMs = ms; ticker = fn; return () => {}; },
    sweep: async () => { sweeps++; return report(); },
  });
  const logged = (): Promise<void> => new Promise((resolve) => { settle = resolve; });
  expect(delayMs).toBe(CLEANUP_FIRST_DELAY_MS);
  let next = logged();
  delayed?.();
  await next;
  expect(sweeps).toBe(1);
  expect(everyMs).toBe(CLEANUP_CHECK_MS);
  expect(JSON.parse(readFileSync(statusFile, "utf8")).at).toBe(new Date(NOW).toISOString());
  expect(lines[0]).toStartWith("RUNNER_CLEANUP at=");
  clock += 23 * 60 * 60_000;
  ticker?.();
  expect(sweeps).toBe(1);
  clock += 60 * 60_000;
  next = logged();
  ticker?.();
  await next;
  expect(sweeps).toBe(2);
  stop();
});
