import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { Runner } from "../run.ts";
import type { CleanupPaths, InUse, SkipReason, TargetCount } from "./cleanup.ts";

/**
 * The cleanup sweep's developer-cache targets (all `report` by default):
 * - macOS only: Xcode DerivedData folders (`~/Library/Developer/Xcode/DerivedData/<name>`) and iOS DeviceSupport versions
 *   (`~/Library/Developer/Xcode/iOS DeviceSupport/<version>`) in which nothing changed for 14 and 60 days, and
 *   `xcrun simctl delete unavailable` for simulators whose runtime is gone; all three wait while Xcode, Simulator or
 *   xcodebuild runs;
 * - the global package caches, only through each tool's own command: `bun pm cache rm` (it empties the whole cache, so at
 *   most every 30 days), `npm cache verify` and `pnpm store prune` (garbage collection of what nothing uses); each waits
 *   while its package manager runs.
 * Never touched: Xcode Archives (dSYMs cannot be rebuilt), `~/.expo` (login state), CoreSimulator `Devices` (only simctl
 * removes a simulator), a folder a process holds a file open in or runs in, symlinks and other users' folders.
 */

const DAY_MS = 24 * 60 * 60_000;
export const DEV_CACHE_AGES = {
  /** Nothing in a DerivedData folder changed for this long. */
  xcodeDerivedData: 14 * DAY_MS,
  /** Nothing in a DeviceSupport version folder changed for this long. */
  xcodeDeviceSupport: 60 * DAY_MS,
  /** `bun pm cache rm` runs again only this long after its last run (lastRuns). */
  bunCache: 30 * DAY_MS,
} as const;
export const XCODE_TARGETS = ["xcodeDerivedData", "xcodeDeviceSupport", "simulatorsUnavailable"] as const;
export const PM_TARGETS = ["bunCache", "npmCache", "pnpmStore"] as const;
export type DevCacheTarget = (typeof XCODE_TARGETS)[number] | (typeof PM_TARGETS)[number];

const MAX_DEPTH = 32;
const PS_TIMEOUT_MS = 30_000;
const SIMCTL_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;
/** npm verify or pnpm prune over a store of several GB. */
const PM_TIMEOUT_MS = 15 * 60_000;

/** Where Xcode keeps its caches under `home` (macOS). Archives and CoreSimulator `Devices` are named only to stay out. */
export const xcodePaths = (home: string): { derivedData: string; deviceSupport: string; simulatorDevices: string } => ({
  derivedData: posix.join(home, "Library", "Developer", "Xcode", "DerivedData"),
  deviceSupport: posix.join(home, "Library", "Developer", "Xcode", "iOS DeviceSupport"),
  simulatorDevices: posix.join(home, "Library", "Developer", "CoreSimulator", "Devices"),
});

/** A process on this host: its pid and its command line as `ps` shows it. */
export type Proc = { readonly pid: number; readonly args: string };

/** `ps -A -o pid=,args=` output, without the process `self` (the runner). */
export const parsePs = (out: string, self: number): Proc[] =>
  out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m && Number(m[1]) !== self ? [{ pid: Number(m[1]), args: m[2]! }] : [];
  });

/** The processes of this host (Linux and macOS `ps`); throws when the list cannot be read. */
export const processList = async (run: Runner, self: number): Promise<Proc[]> => {
  const r = await run(["ps", "-A", "-o", "pid=,args="], { timeoutMs: PS_TIMEOUT_MS });
  if (r.code !== 0 || !r.out.trim()) throw new Error(`ps exited ${r.code}: ${r.err.slice(0, 200)}`);
  return parsePs(r.out, self);
};

const base = (token: string): string => token.slice(token.lastIndexOf("/") + 1);
/** Xcode, Simulator or xcodebuild: the executable's name ends a path segment of the command line. */
const XCODE_RE = /(?:^|\/)(?:Xcode|Simulator|xcodebuild)(?=\s|$)/;
export const xcodeBusy = (procs: readonly Proc[]): Proc | undefined => procs.find((p) => XCODE_RE.test(p.args));
/** bun subcommands that read or write the install cache. */
const BUN_PM_COMMANDS = new Set(["install", "i", "add", "a", "remove", "rm", "update", "pm", "link", "unlink", "outdated", "patch", "x", "create", "c"]);
const PM_NAMES: Readonly<Record<"npmCache" | "pnpmStore", readonly string[]>> = {
  npmCache: ["npm", "npx", "npm-cli.js", "npx-cli.js"],
  pnpmStore: ["pnpm", "pnpx", "pnpm.cjs", "pnpm.mjs", "pnpm.js"],
};
/** A running process of the package manager whose cache `target` is: `bunx` or a bun package command, any npm or pnpm. */
export const pmBusy = (target: (typeof PM_TARGETS)[number], procs: readonly Proc[]): Proc | undefined =>
  procs.find((p) => {
    const tokens = p.args.split(/\s+/).filter(Boolean);
    return tokens.some((token, i) => {
      const name = base(token);
      if (target !== "bunCache") return PM_NAMES[target].includes(name);
      if (name === "bunx") return true;
      return name === "bun" && BUN_PM_COMMANDS.has(bunCommand(tokens.slice(i + 1)));
    });
  });
/** bun's subcommand: the first argument that is neither a flag nor the value of `--cwd` / `--config`. */
const bunCommand = (args: readonly string[]): string => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--cwd" || arg === "--config") i++;
    else if (!arg.startsWith("-")) return arg;
  }
  return "";
};

/** Each tool target's command, the probe that finds its cache dir (and that the tool is installed), and the dir from it. */
const PM_COMMANDS: Readonly<Record<(typeof PM_TARGETS)[number], { probe: string[]; dir: (out: string) => string; act: string[] }>> = {
  bunCache: { probe: ["bun", "pm", "cache"], dir: (out) => out.trim(), act: ["bun", "pm", "cache", "rm"] },
  npmCache: { probe: ["npm", "config", "get", "cache"], dir: (out) => posix.join(out.trim(), "_cacache"), act: ["npm", "cache", "verify"] },
  pnpmStore: { probe: ["pnpm", "store", "path"], dir: (out) => out.trim(), act: ["pnpm", "store", "prune"] },
};
/** The exact commands the tool targets run, and the only ones. */
export const pmCommands = (): Readonly<Record<(typeof PM_TARGETS)[number], readonly string[]>> =>
  ({ bunCache: PM_COMMANDS.bunCache.act, npmCache: PM_COMMANDS.npmCache.act, pnpmStore: PM_COMMANDS.pnpmStore.act });

/** The `lastRuns` of the status file's last report: when each tool target last ran its command. */
export const readLastRuns = (statusFile: string): Partial<Record<DevCacheTarget, string>> => {
  try {
    const runs = (JSON.parse(readFileSync(statusFile, "utf8")) as { lastRuns?: unknown }).lastRuns;
    return runs && typeof runs === "object" ? (runs as Partial<Record<DevCacheTarget, string>>) : {};
  } catch { return {}; }
};

export type DevCacheDeps = {
  readonly paths: CleanupPaths;
  readonly now: number;
  readonly run: Runner;
  readonly uid: number | undefined;
  /** What processes hold open or run in; the Xcode folder targets do not run without it. */
  readonly used: InUse;
  readonly processes: (() => Promise<readonly Proc[]>) | undefined;
  readonly lastRuns: Readonly<Partial<Record<DevCacheTarget, string>>>;
  /** The target's count when it runs this sweep (undefined: off, or it needs the in-use list and that failed). */
  readonly count: (target: DevCacheTarget, needsInUse: boolean) => TargetCount | undefined;
  readonly treeBytes: (dir: string) => Promise<number>;
  readonly noteError: (count: TargetCount, path: string, e: unknown) => void;
  readonly skipped: (count: TargetCount, reason: SkipReason) => void;
  readonly errors: string[];
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const notInstalled = (code: number): boolean => code === 127;

/** Whether `dir` or anything under it changed (mtime or ctime; atime is no change) at or after `cutoff`. */
const changedSince = async (dir: string, cutoff: number, depth = 0): Promise<boolean> => {
  const st = await lstat(dir);
  if (Math.max(st.mtimeMs, st.ctimeMs) >= cutoff) return true;
  if (!st.isDirectory() || depth >= MAX_DEPTH) return false;
  for (const name of await readdir(dir)) {
    try { if (await changedSince(join(dir, name), cutoff, depth + 1)) return true; } catch { /* gone */ }
  }
  return false;
};

/**
 * The developer-cache targets. Returns when each tool target that ran its command (in `on`) did, for the report's
 * `lastRuns`; Xcode folders are removed directly, everything else only through the tools' own commands.
 */
export const sweepDevCaches = async (deps: DevCacheDeps): Promise<Partial<Record<DevCacheTarget, string>>> => {
  const { paths, now, run } = deps;
  const ran: Partial<Record<DevCacheTarget, string>> = {};
  const darwin = paths.os === "darwin";
  const counts = new Map<DevCacheTarget, TargetCount>();
  for (const target of XCODE_TARGETS) {
    const count = deps.count(target, target !== "simulatorsUnavailable");
    if (!count) continue;
    if (!darwin) count.skip = "platform";
    else counts.set(target, count);
  }
  for (const target of PM_TARGETS) {
    const count = deps.count(target, false);
    if (!count) continue;
    if (paths.os === "win32") count.skip = "platform";
    else counts.set(target, count);
  }
  if (!counts.size) return ran;

  let procs: readonly Proc[];
  if (!deps.processes) {
    for (const count of counts.values()) count.skip = "processesFailed";
    return ran;
  }
  try {
    procs = await deps.processes();
  } catch (e) {
    // Without the list a running Xcode or package manager could lose its cache mid-build: skip them all.
    for (const count of counts.values()) count.skip = "processesFailed";
    if (deps.errors.length < 20) deps.errors.push(`process listing failed: ${errText(e)}`);
    return ran;
  }

  // Xcode folders: only what is inside a folder counts as in use, not a shell whose cwd is the home dir above it.
  const held = [...deps.used.files, ...deps.used.dirs].map((p) => posix.normalize(p));
  const inUseUnder = (dir: string): boolean => held.some((p) => p === dir || p.startsWith(`${dir}/`));
  const sweepAged = async (count: TargetCount, root: string, age: number): Promise<void> => {
    let names: string[];
    try { names = await readdir(root); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") deps.noteError(count, root, e);
      return;
    }
    for (const name of names) {
      const dir = posix.join(root, name);
      try {
        const st = await lstat(dir);
        if (!st.isDirectory()) continue;
        if (deps.uid !== undefined && st.uid !== deps.uid) { deps.skipped(count, "otherUser"); continue; }
        if (inUseUnder(dir)) { count.kept++; deps.skipped(count, "shielded"); continue; }
        if (await changedSince(dir, now - age)) { deps.skipped(count, "recent"); continue; }
        const bytes = await deps.treeBytes(dir);
        count.candidates++;
        count.candidateBytes += bytes;
        if (count.mode !== "on") continue;
        await rm(dir, { recursive: true, force: true });
        count.removed++;
        count.bytes += bytes;
      } catch (e) { deps.noteError(count, dir, e); }
    }
  };
  const xcode = xcodePaths(paths.home);
  const busyXcode = xcodeBusy(procs);
  const derived = counts.get("xcodeDerivedData");
  const support = counts.get("xcodeDeviceSupport");
  const sims = counts.get("simulatorsUnavailable");
  for (const count of [derived, support, sims]) if (count && busyXcode) count.skip = "busy";
  if (derived && !busyXcode) await sweepAged(derived, xcode.derivedData, DEV_CACHE_AGES.xcodeDerivedData);
  if (support && !busyXcode) await sweepAged(support, xcode.deviceSupport, DEV_CACHE_AGES.xcodeDeviceSupport);
  if (sims && !busyXcode) {
    const list = await run(["xcrun", "simctl", "list", "--json", "devices", "unavailable"], { timeoutMs: SIMCTL_TIMEOUT_MS });
    if (notInstalled(list.code)) sims.skip = "notInstalled";
    else if (list.code !== 0) deps.noteError(sims, "xcrun simctl list", new Error(`exited ${list.code}: ${(list.err || list.out).slice(0, 200)}`));
    else {
      let udids: string[] = [];
      try {
        const devices = (JSON.parse(list.out) as { devices?: Record<string, { udid?: unknown; isAvailable?: unknown }[]> }).devices ?? {};
        udids = Object.values(devices).flat()
          .filter((d) => d.isAvailable === false && typeof d.udid === "string" && /^[0-9A-Fa-f-]{36}$/.test(d.udid))
          .map((d) => d.udid as string);
      } catch (e) { deps.noteError(sims, "xcrun simctl list", e); }
      // Bytes are counted only: simctl, never the sweep, removes a simulator's folder under Devices.
      const sizes = await Promise.all(udids.map((u) => deps.treeBytes(posix.join(xcode.simulatorDevices, u))));
      sims.candidates += udids.length;
      sims.candidateBytes += sizes.reduce((a, b) => a + b, 0);
      if (udids.length && sims.mode === "on") {
        const del = await run(["xcrun", "simctl", "delete", "unavailable"], { timeoutMs: SIMCTL_TIMEOUT_MS });
        if (del.code !== 0) deps.noteError(sims, "xcrun simctl delete unavailable", new Error(`exited ${del.code}: ${(del.err || del.out).slice(0, 200)}`));
        else {
          ran.simulatorsUnavailable = new Date(now).toISOString();
          for (const [i, u] of udids.entries()) {
            try { await lstat(posix.join(xcode.simulatorDevices, u)); } catch { sims.removed++; sims.bytes += sizes[i]!; }
          }
        }
      }
    }
  }

  // Package caches: each tool's own command, in a scratch dir (bun's pm commands need a package.json to start).
  const pms = PM_TARGETS.flatMap((t) => { const c = counts.get(t); return c ? [[t, c] as const] : []; });
  if (!pms.length) return ran;
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(tmpdir(), "dori-cleanup-pm-"));
    await writeFile(join(scratch, "package.json"), "{}\n");
    for (const [target, count] of pms) {
      const busy = pmBusy(target, procs);
      if (busy) { count.skip = "busy"; continue; }
      const last = Date.parse(deps.lastRuns[target] ?? "");
      if (target === "bunCache" && Number.isFinite(last) && now - last < DEV_CACHE_AGES.bunCache) { count.skip = "notDue"; continue; }
      const cmd = PM_COMMANDS[target];
      const probe = await run(cmd.probe, { cwd: scratch, timeoutMs: PROBE_TIMEOUT_MS });
      if (notInstalled(probe.code)) { count.skip = "notInstalled"; continue; }
      if (probe.code !== 0) { deps.noteError(count, cmd.probe.join(" "), new Error(`exited ${probe.code}: ${(probe.err || probe.out).slice(0, 200)}`)); continue; }
      const dir = cmd.dir(probe.out);
      const sized = posix.isAbsolute(dir) ? dir : undefined;
      const before = sized ? await deps.treeBytes(sized) : 0;
      count.candidates++;
      // bun's command empties the cache; npm's and pnpm's collect only what nothing uses, unknown until they run.
      count.candidateBytes += target === "bunCache" ? before : 0;
      if (count.mode !== "on") continue;
      const r = await run(cmd.act, { cwd: scratch, timeoutMs: PM_TIMEOUT_MS });
      if (r.code !== 0) { deps.noteError(count, cmd.act.join(" "), new Error(`exited ${r.code}: ${(r.err || r.out).slice(0, 200)}`)); continue; }
      ran[target] = new Date(now).toISOString();
      count.removed++;
      count.bytes += sized ? Math.max(0, before - (await deps.treeBytes(sized))) : 0;
    }
  } catch (e) {
    if (deps.errors.length < 20) deps.errors.push(`package caches: ${errText(e)}`);
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return ran;
};
