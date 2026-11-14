import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupLine, cleanupPaths, cleanupSettings, type CleanupDeps, type CleanupPaths, runCleanup } from "../src/runner/cleanup.ts";
import { parsePs, pmBusy, type Proc, xcodeBusy } from "../src/runner/cleanup-dev-caches.ts";
import type { Ran, Runner } from "../src/run.ts";

const DAY = 24 * 60 * 60_000;
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** ctime cannot be set back, so the sweep runs 100 days ahead: entries made now are old, `fresh` ones are moved near NOW. */
const NOW = Date.now() + 100 * DAY;
const file = (path: string, text = "0123456789"): string => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
const fresh = (path: string, at = NOW - DAY): string => { utimesSync(path, new Date(at), new Date(at)); return path; };
const UDID_GONE = "11111111-2222-3333-4444-555555555555";
const UDID_KEPT = "66666666-7777-8888-9999-AAAAAAAAAAAA";
const ALL_ON = cleanupSettings({
  DORI_CLEANUP_TARGETS: "xcodeDerivedData=on,xcodeDeviceSupport=on,simulatorsUnavailable=on,bunCache=on,npmCache=on,pnpmStore=on",
});

type Fixture = {
  home: string; paths: CleanupPaths; calls: string[][];
  dd: string; ds: string; devices: string; bun: string; npm: string; pnpm: string;
  run: Runner;
};
const fixture = (os = "darwin", answers: Record<string, Ran> = {}): Fixture => {
  const base = mkdtempSync(join(tmpdir(), "dori-devcache-"));
  roots.push(base);
  const home = join(base, "home"), tmp = join(base, "tmp");
  mkdirSync(tmp, { recursive: true });
  const { varTmp: _v, ...rest } = cleanupPaths(os, { HOME: home }, "/unused");
  const dev = join(home, "Library", "Developer");
  const f = {
    home, paths: { ...rest, temps: [tmp] }, calls: [] as string[][],
    dd: join(dev, "Xcode", "DerivedData"), ds: join(dev, "Xcode", "iOS DeviceSupport"), devices: join(dev, "CoreSimulator", "Devices"),
    bun: join(home, ".bun", "install", "cache"), npm: join(home, ".npm"), pnpm: join(home, ".local", "share", "pnpm", "store", "v10"),
  };
  // simctl lists the unavailable simulator until it deletes it.
  const simList = (): string => JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-16-0":
    existsSync(join(f.devices, UDID_GONE)) ? [{ udid: UDID_GONE, isAvailable: false, name: "iPhone 14" }] : [] } });
  const replies: Record<string, Ran> = {
    "bun pm cache": { code: 0, out: `${f.bun}\n`, err: "" },
    "npm config get cache": { code: 0, out: `${f.npm}\n`, err: "" },
    "pnpm store path": { code: 0, out: `${f.pnpm}\n`, err: "" },
    ...answers,
  };
  const run: Runner = async (argv) => {
    f.calls.push([...argv]);
    const key = argv.join(" ");
    // What the real tools would do to their own caches.
    if (key === "xcrun simctl delete unavailable") rmSync(join(f.devices, UDID_GONE), { recursive: true, force: true });
    if (key === "bun pm cache rm") rmSync(f.bun, { recursive: true, force: true });
    if (key === "xcrun simctl list --json devices unavailable" && !replies[key]) return { code: 0, out: simList(), err: "" };
    return replies[key] ?? { code: 0, out: "", err: "" };
  };
  return { ...f, run };
};
const deps = (f: Fixture, over: Partial<CleanupDeps> = {}): CleanupDeps => ({
  paths: f.paths, now: NOW, run: f.run, log: () => {}, repos: [], openLanes: [], keepAgents: [],
  inUse: async () => ({ files: [], dirs: [] }), procs: async () => [], uid: process.getuid?.(), processes: async () => [], ...over,
});
/** Old and fresh entries of every target, plus what no target may touch. */
const seed = (f: Fixture) => {
  const s = {
    ddOld: file(join(f.dd, "App-abcdefghijklmnopqrstuvwxyzab", "Build", "Intermediates", "a.o")),
    ddFresh: fresh(file(join(f.dd, "Other-bcdefghijklmnopqrstuvwxyzabc", "Index", "deep", "store.db"))),
    dsOld: file(join(f.ds, "16.4 (20E247)", "Symbols", "lib.dylib")),
    dsFresh: fresh(file(join(f.ds, "17.2 (21C62)", "Symbols", "lib.dylib")), NOW - 30 * DAY),
    simGone: file(join(f.devices, UDID_GONE, "data", "app.db")),
    simKept: file(join(f.devices, UDID_KEPT, "data", "app.db")),
    bunFile: file(join(f.bun, "pkg@1.0.0", "index.js")),
    npmFile: file(join(f.npm, "_cacache", "content-v2", "sha512", "ab", "cd")),
    archive: file(join(f.home, "Library", "Developer", "Xcode", "Archives", "2026-01-01", "App.xcarchive", "dSYMs", "App.dSYM")),
    expo: file(join(f.home, ".expo", "state.json")),
  };
  return s;
};
const acts = (calls: string[][]): string[] =>
  calls.map((c) => c.join(" ")).filter((c) => / (rm|verify|prune|delete)( |$)/.test(c));

test("developer caches start in report: candidates and bytes counted, nothing removed, no cleaning command run", async () => {
  const f = fixture();
  const s = seed(f);
  const report = await runCleanup(deps(f));
  for (const p of Object.values(s)) expect(existsSync(p)).toBe(true);
  expect(acts(f.calls)).toEqual([]);
  expect(report.targets.xcodeDerivedData).toMatchObject({ mode: "report", candidates: 1, candidateBytes: 10, removed: 0, skipped: { recent: 1 } });
  expect(report.targets.xcodeDeviceSupport).toMatchObject({ mode: "report", candidates: 1, candidateBytes: 10, skipped: { recent: 1 } });
  expect(report.targets.simulatorsUnavailable).toMatchObject({ mode: "report", candidates: 1, candidateBytes: 10 });
  expect(report.targets.bunCache).toMatchObject({ mode: "report", candidates: 1, candidateBytes: 10 });
  expect(report.targets.npmCache).toMatchObject({ mode: "report", candidates: 1, candidateBytes: 0 });
  expect(report.targets.pnpmStore).toMatchObject({ mode: "report", candidates: 1 });
  expect(report.lastRuns).toBeUndefined();
  expect(cleanupLine(report)).toContain("xcodeDerivedData=report:1/10B");
});

test("on: old Xcode folders go, the tools run exactly their own commands; Archives, ~/.expo and Devices stay", async () => {
  const f = fixture();
  const s = seed(f);
  const report = await runCleanup(deps(f, { settings: ALL_ON }));
  expect([existsSync(s.ddOld), existsSync(s.ddFresh), existsSync(s.dsOld), existsSync(s.dsFresh)]).toEqual([false, true, false, true]);
  expect(acts(f.calls)).toEqual(["xcrun simctl delete unavailable", "bun pm cache rm", "npm cache verify", "pnpm store prune"]);
  // simctl removed its own simulator; the sweep removed nothing under Devices, Archives or ~/.expo.
  expect([existsSync(s.simGone), existsSync(s.simKept), existsSync(s.archive), existsSync(s.expo), existsSync(s.npmFile)]).toEqual([false, true, true, true, true]);
  expect(report.targets.xcodeDerivedData).toMatchObject({ mode: "on", removed: 1, bytes: 10 });
  expect(report.targets.xcodeDeviceSupport).toMatchObject({ mode: "on", removed: 1, bytes: 10 });
  expect(report.targets.simulatorsUnavailable).toMatchObject({ removed: 1, bytes: 10 });
  expect(report.targets.bunCache).toMatchObject({ removed: 1, bytes: 10 });
  expect(Object.keys(report.lastRuns ?? {}).sort()).toEqual(["bunCache", "npmCache", "pnpmStore", "simulatorsUnavailable"]);

  // The next sweep carries lastRuns: bun's cache is emptied again only 30 days later; npm and pnpm run daily.
  f.calls.length = 0;
  const next = await runCleanup(deps(f, { settings: ALL_ON, now: NOW + DAY, lastRuns: report.lastRuns }));
  expect(next.targets.bunCache).toMatchObject({ skip: "notDue", removed: 0 });
  expect(acts(f.calls)).toEqual(["npm cache verify", "pnpm store prune"]);
  expect(next.lastRuns?.bunCache).toBe(report.lastRuns?.bunCache);
  const later = await runCleanup(deps(f, { settings: ALL_ON, now: NOW + 31 * DAY, lastRuns: next.lastRuns }));
  expect(later.targets.bunCache?.skip).toBeUndefined();
});

test("a running Xcode, Simulator, xcodebuild or package manager keeps its cache", async () => {
  const procs: Proc[] = [
    { pid: 10, args: "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator" },
    { pid: 11, args: "bun install --frozen-lockfile" },
    { pid: 12, args: "node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci" },
    { pid: 13, args: "/opt/homebrew/bin/pnpm install" },
  ];
  const f = fixture();
  const s = seed(f);
  const report = await runCleanup(deps(f, { settings: ALL_ON, processes: async () => procs }));
  for (const p of Object.values(s)) expect(existsSync(p)).toBe(true);
  expect(acts(f.calls)).toEqual([]);
  for (const t of ["xcodeDerivedData", "xcodeDeviceSupport", "simulatorsUnavailable", "bunCache", "npmCache", "pnpmStore"]) {
    expect({ t, skip: report.targets[t]?.skip }).toEqual({ t, skip: "busy" });
  }
});

test("Xcode targets run on macOS only; a failed process list, a missing tool or a held folder skips instead of guessing", async () => {
  const linux = fixture("linux", { "pnpm store path": { code: 127, out: "", err: "ENOENT" } });
  seed(linux);
  const onLinux = await runCleanup(deps(linux, { settings: ALL_ON }));
  for (const t of ["xcodeDerivedData", "xcodeDeviceSupport", "simulatorsUnavailable"]) expect(onLinux.targets[t]?.skip).toBe("platform");
  expect(onLinux.targets.pnpmStore?.skip).toBe("notInstalled");
  expect(linux.calls.some((c) => c[0] === "xcrun")).toBe(false);
  expect(cleanupLine(onLinux)).toContain("xcodeDerivedData=skip:platform");

  const failed = fixture();
  const s = seed(failed);
  const noPs = await runCleanup(deps(failed, { settings: ALL_ON, processes: async () => { throw new Error("ps timed out"); } }));
  for (const t of ["xcodeDerivedData", "simulatorsUnavailable", "bunCache", "npmCache"]) expect(noPs.targets[t]?.skip).toBe("processesFailed");
  expect(noPs.errors.some((e) => e.includes("ps timed out"))).toBe(true);
  const noList = await runCleanup(deps(failed, { settings: ALL_ON, processes: undefined }));
  expect(noList.targets.bunCache?.skip).toBe("processesFailed");
  const noInUse = await runCleanup(deps(failed, { settings: ALL_ON, processes: async () => { throw new Error("off"); }, inUse: async () => { throw new Error("lsof failed"); } }));
  expect(noInUse.targets.xcodeDerivedData?.skip).toBe("inUseFailed");
  for (const p of Object.values(s)) expect(existsSync(p)).toBe(true);

  // A file held open in an old DerivedData folder keeps it; a shell in the home dir above holds nothing there.
  const held = fixture();
  const h = seed(held);
  const kept = await runCleanup(deps(held, { settings: ALL_ON, inUse: async () => ({ files: [h.ddOld], dirs: [held.home] }) }));
  expect(existsSync(h.ddOld)).toBe(true);
  expect(existsSync(h.dsOld)).toBe(false);
  expect(kept.targets.xcodeDerivedData).toMatchObject({ removed: 0, skipped: { shielded: 1, recent: 1 } });
});

test("process matching: Xcode by executable name, bun only for its package commands, any npm or pnpm", () => {
  const p = (args: string): Proc[] => [{ pid: 1, args }];
  expect(xcodeBusy(p("/Applications/Xcode.app/Contents/MacOS/Xcode"))).toBeDefined();
  expect(xcodeBusy(p("/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme App build"))).toBeDefined();
  expect(xcodeBusy(p("du -sh /Users/me/Library/Developer/Xcode/DerivedData"))).toBeUndefined();
  expect(pmBusy("bunCache", p("bun --cwd app install"))).toBeDefined();
  expect(pmBusy("bunCache", p("/home/me/.bun/bin/bunx tsc"))).toBeDefined();
  expect(pmBusy("bunCache", p("bun /home/me/dori/src/cli.ts runner"))).toBeUndefined();
  expect(pmBusy("bunCache", p("bun test"))).toBeUndefined();
  expect(pmBusy("npmCache", p("npm exec foo"))).toBeDefined();
  expect(pmBusy("npmCache", p("pnpm install"))).toBeUndefined();
  expect(pmBusy("pnpmStore", p("node /x/pnpm/bin/pnpm.cjs add y"))).toBeDefined();
  expect(parsePs("  1 /sbin/init\n 42 bun /x/cli.ts runner\n", 42)).toEqual([{ pid: 1, args: "/sbin/init" }]);
});
