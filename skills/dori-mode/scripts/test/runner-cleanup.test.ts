import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLEANUP_CHECK_MS, CLEANUP_FIRST_DELAY_MS, cleanupLine, closedLanesOf, cleanupPaths, cleanupSettings, type CleanupDeps, type CleanupPaths, type CleanupReport,
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

test("a dry run removes and moves nothing, and reports each target's candidates, bytes and skip reasons", async () => {
  const f = fixture();
  const { paths, tmp } = f;
  const tempOld = file(join(tmp, "stale-dir", "f.txt"), "0123456789");
  const lock = file(join(tmp, "proj", "x.lock"));
  const chromeOld = join(tmp, ".abc.bun-chrome");
  file(join(chromeOld, "Prefs"), "12345");
  const session = file(join(paths.sessions, "--data-old--", "2026-09-01_a.jsonl"), "{}\n");
  const emptyEvidence = join(paths.evidence, "lane-x");
  mkdirSync(emptyEvidence, { recursive: true });
  const agentOld = join(paths.memoryAgents, `gone${memoryAgentSuffix("/data/gone")}`);
  file(join(agentOld, "repo", "a.md"), "abc");
  const repo = join(f.tmp, "..", "repo");
  mkdirSync(repo);
  await git("-C", repo, "init", "-q", "-b", "main");
  file(join(repo, "a.txt"));
  await git("-C", repo, "add", "a.txt");
  await git("-C", repo, "commit", "-q", "-m", "a");
  const gone = join(f.tmp, "..", "wt-gone");
  await git("-C", repo, "worktree", "add", "-q", "-b", "g", gone);
  rmSync(gone, { recursive: true, force: true });

  const report = await runCleanup(deps(f, { repos: [repo], settings: cleanupSettings({ DORI_CLEANUP_DRY_RUN: "1", DORI_CLEANUP_TARGETS: "varTmp=off" }) }));

  for (const kept of [tempOld, lock, chromeOld, session, emptyEvidence, agentOld]) expect({ kept, exists: existsSync(kept) }).toEqual({ kept, exists: true });
  expect(await git("-C", repo, "worktree", "list", "--porcelain")).toContain("wt-gone");
  expect(report.dryRun).toBe(true);
  expect(report.targets.temp).toMatchObject({ mode: "report", removed: 0, bytes: 0, candidates: 2, candidateBytes: 10, skipped: { lock: 1 } });
  expect(report.targets.bunChrome).toMatchObject({ mode: "report", removed: 0, candidates: 1, candidateBytes: 5 });
  expect(report.targets.sessionsArchived).toMatchObject({ removed: 0, candidates: 1, candidateBytes: 3 });
  expect(report.targets.memoryAgents).toMatchObject({ removed: 0, candidates: 1, candidateBytes: 3 });
  expect(report.worktreePrune).toEqual({ mode: "report", ok: 1, failed: 0, candidates: 1 });
  const line = cleanupLine(report);
  expect(line).toMatch(/^RUNNER_CLEANUP at=\S+ dryRun=1 .*bunChrome=report:1\/5B temp=report:2\/10B .*worktreePrune=report:1 freedBytes=0 wouldFreeBytes=\d+ /);
  expect(line).toContain("temp.lock:1");
});

test("DORI_CLEANUP_TARGETS turns single targets off or to report; the rest keep removing", async () => {
  const f = fixture();
  const tempOld = file(join(f.tmp, "stale.txt"));
  const agentOld = join(f.paths.memoryAgents, `gone${memoryAgentSuffix("/data/gone")}`);
  file(join(agentOld, "repo", "a.md"));
  const sandboxOld = file(join(f.paths.laneSandbox, "closed", "a.o"));
  const settings = cleanupSettings({ DORI_CLEANUP_TARGETS: "temp=off, memoryAgents=report,bogus=on,sandbox=maybe" });
  expect(settings).toMatchObject({ dryRun: false, modes: { temp: "off", memoryAgents: "report" } });
  expect(settings.ignored).toHaveLength(2);

  const report = await runCleanup(deps(f, { settings }));
  expect(existsSync(tempOld) && existsSync(agentOld)).toBe(true);
  expect(existsSync(sandboxOld)).toBe(false);
  expect(report.targets.temp).toMatchObject({ mode: "off", skip: "off", candidates: 0 });
  expect(report.targets.memoryAgents).toMatchObject({ mode: "report", candidates: 1, removed: 0 });
  expect(report.errors).toHaveLength(2);
  expect(cleanupLine(report)).toMatch(/ sandbox=2 .*temp=off .*memoryAgents=report:1\/1B /);
  expect(cleanupSettings({ DORI_CLEANUP_DRY_RUN: "0" }).dryRun).toBe(false);
});

test("a failed in-use listing skips the deleting targets instead of guessing", async () => {
  const f = fixture();
  const tempOld = file(join(f.tmp, "stale.txt"));
  const report = await runCleanup(deps(f, { inUse: async () => { throw new Error("lsof timed out"); } }));
  expect(existsSync(tempOld)).toBe(true);
  expect(report.inUse).toBe("failed");
  expect(cleanupLine(report)).toContain("inUse=failed");
  expect(cleanupLine(report)).toContain("temp=skip:inUseFailed");
});

/** A repo with a linked worktree per name under `<base>/worktrees`, each holding `node_modules/pkg/index.js`. */
const laneWorktrees = async (f: Fixture, names: readonly string[]): Promise<Record<string, string>> => {
  const repo = join(f.tmp, "..", "repo");
  mkdirSync(repo);
  await git("-C", repo, "init", "-q", "-b", "main");
  file(join(repo, "a.txt"));
  await git("-C", repo, "add", "a.txt");
  await git("-C", repo, "commit", "-q", "-m", "a");
  const out: Record<string, string> = {};
  for (const name of names) {
    const wt = join(f.tmp, "..", "worktrees", name);
    await git("-C", repo, "worktree", "add", "-q", "-b", name, wt);
    file(join(wt, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    out[name] = wt;
  }
  return out;
};
const nm = (wt: string): string => join(wt, "node_modules");

test("closed lanes' worktree node_modules: report by default, removed when on, the rest of the worktree stays", async () => {
  const f = fixture();
  const wt = await laneWorktrees(f, ["repo-ap-1-1"]);
  const closedLanes = async () => [{ key: "ap-1-1", closedAt: NOW - 5 * DAY, worktrees: [wt["repo-ap-1-1"]!] }];

  const reported = await runCleanup(deps(f, { closedLanes }));
  expect(existsSync(nm(wt["repo-ap-1-1"]!))).toBe(true);
  expect(reported.targets.closedNodeModules).toMatchObject({ mode: "report", candidates: 1, candidateBytes: 20, removed: 0 });
  expect(cleanupLine(reported)).toContain("closedNodeModules=report:1/20B");

  // A shell whose cwd is the home dir above the worktree holds nothing in it.
  const on = await runCleanup(deps(f, { closedLanes, inUse: async () => ({ files: [], dirs: [f.home, dirname(f.tmp)] }), settings: cleanupSettings({ DORI_CLEANUP_TARGETS: "closedNodeModules=on" }) }));
  expect(existsSync(nm(wt["repo-ap-1-1"]!))).toBe(false);
  expect(existsSync(join(wt["repo-ap-1-1"]!, "a.txt"))).toBe(true);
  expect(on.targets.closedNodeModules).toMatchObject({ mode: "on", candidates: 1, removed: 1, bytes: 20 });
});

test("closed lanes' node_modules stay for open and opening lanes, recent activity, in-use paths, unknown worktrees and reopened lanes", async () => {
  const f = fixture();
  const names = ["repo-open-1", "repo-ap-9-1", "repo-closed-lately", "repo-installing", "repo-held", "repo-busy-cwd", "repo-unknown", "repo-reopened", "repo-committed"];
  const wt = await laneWorktrees(f, names);
  const old = NOW - 5 * DAY;
  fresh(nm(wt["repo-installing"]!), NOW - 60 * 60_000);
  // A commit 2 days before the sweep is the lane's last activity, though the lane closed earlier.
  fresh(file(join(f.tmp, "..", "repo", ".git", "worktrees", "repo-committed", "logs", "HEAD"), "x"), NOW - 2 * DAY);
  let reads = 0;
  const closedLanes = async () => {
    reads++;
    return [
      { key: "open-1", closedAt: old, worktrees: [wt["repo-open-1"]!] },
      { key: "gone-9", closedAt: old, worktrees: [wt["repo-ap-9-1"]!] },
      { key: "lately", closedAt: NOW - DAY, worktrees: [wt["repo-closed-lately"]!] },
      { key: "installing", closedAt: old, worktrees: [wt["repo-installing"]!] },
      { key: "held", closedAt: old, worktrees: [wt["repo-held"]!] },
      { key: "busy", closedAt: old, worktrees: [wt["repo-busy-cwd"]!] },
      { key: "committed", closedAt: old, worktrees: [wt["repo-committed"]!] },
      // Reopened while the first pass counted: gone from the closed list on the second read.
      ...(reads === 1 ? [{ key: "reopened", closedAt: old, worktrees: [wt["repo-reopened"]!] }] : []),
    ];
  };
  const report = await runCleanup(deps(f, {
    closedLanes,
    // An open lane working in a worktree a closed lane also recorded, and an observed lane (no cwd yet) being opened.
    openLanes: [{ key: "open-2", cwd: wt["repo-open-1"]! }, { key: "ap-9-1" }],
    inUse: async () => ({ files: [join(nm(wt["repo-held"]!), "pkg", "index.js")], dirs: [join(wt["repo-busy-cwd"]!, "src")] }),
    settings: cleanupSettings({ DORI_CLEANUP_TARGETS: "closedNodeModules=on" }),
  }));
  for (const name of names) expect({ name, exists: existsSync(nm(wt[name]!)) }).toEqual({ name, exists: true });
  expect(reads).toBe(2);
  expect(report.targets.closedNodeModules).toMatchObject({
    mode: "on", removed: 0, candidates: 0, skipped: { shielded: 4, recent: 3, reopened: 1 },
  });
});

test("closedNodeModules is skipped whole when the in-use listing fails, the registry cannot be read or there is none", async () => {
  const f = fixture();
  const wt = await laneWorktrees(f, ["repo-ap-2-1"]);
  const closedLanes = async () => [{ key: "ap-2-1", closedAt: NOW - 5 * DAY, worktrees: [wt["repo-ap-2-1"]!] }];
  const settings = cleanupSettings({ DORI_CLEANUP_TARGETS: "closedNodeModules=on" });
  const failed = await runCleanup(deps(f, { closedLanes, settings, inUse: async () => { throw new Error("lsof timed out"); } }));
  expect(failed.targets.closedNodeModules).toMatchObject({ skip: "inUseFailed", candidates: 0 });
  expect(cleanupLine(failed)).toContain("closedNodeModules=skip:inUseFailed");
  const unread = await runCleanup(deps(f, { settings, closedLanes: async () => { throw new Error("link down"); } }));
  expect(unread.targets.closedNodeModules).toMatchObject({ skip: "registryFailed", candidates: 0 });
  const none = await runCleanup(deps(f, { settings }));
  expect(none.targets.closedNodeModules).toMatchObject({ skip: "noRegistry" });
  expect(existsSync(nm(wt["repo-ap-2-1"]!))).toBe(true);
});

test("closedLanesOf lists one host's closed lanes with their cwd and recorded worktrees", () => {
  const at = "2026-11-01T00:00:00.000Z";
  const lanes = [
    { key: "a", cwd: "/w/r-a", worktrees: ["/w/r-a", "/w/r-a-2"], openedAt: at, closedAt: at },
    { key: "open", cwd: "/w/r-open", openedAt: at },
    { key: "mac", cwd: "/w/r-mac", machine: "mini", openedAt: at, closedAt: at },
    { key: "bad", cwd: "/w/r-bad", openedAt: at, closedAt: "never" },
  ] as unknown as Parameters<typeof closedLanesOf>[0];
  expect(closedLanesOf(lanes, undefined)).toEqual([{ key: "a", closedAt: Date.parse(at), worktrees: ["/w/r-a", "/w/r-a-2"] }]);
  expect(closedLanesOf(lanes, "mini").map((l) => l.key)).toEqual(["mac"]);
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
  expect(report.worktreePrune).toEqual({ mode: "on", ok: 1, failed: 1, candidates: 0 });
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
  const report = (): CleanupReport => ({ at: new Date(clock).toISOString(), ms: 1, dryRun: false, targets: {}, worktreePrune: { mode: "on", ok: 0, failed: 0, candidates: 0 }, inUse: "ok", skippedRoots: [], errors: [] });
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
