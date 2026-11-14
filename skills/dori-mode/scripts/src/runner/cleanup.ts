import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readdir, readlink, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import type { Runner } from "../run.ts";
import { writeRunnerFile } from "./fs-safety.ts";

/**
 * The runner's daily cleanup sweep: every runner host (Linux, macOS, Windows) cleans its own caches and temp the same
 * way, with no per-machine cron or tmpfiles rule. Targets and ages:
 * - lane sandbox TMPDIRs (`~/.cache/omo-tmp/lane-sandbox/<key>`) and the rest of the lanes' build temp (`omo-tmp`): 3 days;
 * - the user's own entries in the system temp dirs (`/tmp`, macOS `$TMPDIR`, Windows `%TEMP%`): 2 days; `/var/tmp` on
 *   Linux: 30 days; live-session state (sockets, locks, herdr/tmux/senpi and the like) is never touched;
 * - headless browser profiles (`.<id>.bun-chrome` in a temp dir): 2 hours;
 * - omo sessions (`~/.omo/agent/sessions/<cwd>/*.jsonl` and their `-artifacts` dirs) untouched for 14 days are moved to
 *   `~/.omo/agent/sessions-archive/<cwd>/`, and empty `-artifacts` dirs and empty dirs under the runner's `evidence/` go;
 * - omo memory agents (`~/.omo/memory/agents/<slug>-<hash>`) untouched for 30 days;
 * - `git worktree prune` in every repo the runner knows (drops records of worktrees whose directory is gone).
 * Never removed: anything outside those roots, `~/.dori/secrets`, `~/.secrets`, an open lane's cwd, sandbox TMPDIR,
 * session dir and memory agent, the lead's memory agent, any git checkout (a worktree, dirty or clean, stays as it is),
 * anything a process holds open or runs in (Linux /proc, macOS lsof; Windows refuses to delete an open file), sockets,
 * FIFOs, symlinks, lock files and other users' files.
 * Each target runs in a mode (CleanupMode): `on` removes, `report` only counts what it would remove (candidates, bytes,
 * skip reasons) and touches nothing, `off` skips it. `DORI_CLEANUP_DRY_RUN=1` puts every target in `report`;
 * `DORI_CLEANUP_TARGETS=temp=off,memoryAgents=report` sets single targets (cleanupSettings).
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
export const CLEANUP_AGES = {
  sandbox: 3 * DAY_MS,
  omoTmp: 3 * DAY_MS,
  temp: 2 * DAY_MS,
  varTmp: 30 * DAY_MS,
  bunChrome: 2 * HOUR_MS,
  sessions: 14 * DAY_MS,
  emptyDirs: DAY_MS,
  memoryAgents: 30 * DAY_MS,
} as const;
/** The sweep's targets, as they appear in the report and in `DORI_CLEANUP_TARGETS`. */
export const CLEANUP_TARGETS = [
  "sandbox", "omoTmp", "bunChrome", "temp", "varTmp", "sessionsArchived", "emptyArtifactDirs", "memoryAgents", "worktreePrune",
] as const;
export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];
/** `on`: remove (or move, for sessions); `report`: count candidates and bytes, change nothing; `off`: skip the target. */
export type CleanupMode = "on" | "report" | "off";
const CLEANUP_MODES: readonly CleanupMode[] = ["on", "report", "off"];
/** A target missing from `DORI_CLEANUP_TARGETS` runs in this mode. A new target starts at `report`. */
export const CLEANUP_DEFAULT_MODES: Readonly<Record<CleanupTarget, CleanupMode>> = {
  sandbox: "on", omoTmp: "on", bunChrome: "on", temp: "on", varTmp: "on", sessionsArchived: "on", emptyArtifactDirs: "on",
  memoryAgents: "on", worktreePrune: "on",
};
export type CleanupSettings = {
  /** Every target that is not `off` runs in `report`. */
  readonly dryRun: boolean;
  readonly modes: Readonly<Partial<Record<CleanupTarget, CleanupMode>>>;
  /** Entries of the settings that were not understood; the report lists them as errors. */
  readonly ignored: readonly string[];
};

/**
 * The sweep's settings from the runner's environment: `DORI_CLEANUP_DRY_RUN` (any value but empty, `0`, `false`, `no`
 * or `off` turns it on) and `DORI_CLEANUP_TARGETS` (`<target>=<on|report|off>` entries split by commas or spaces).
 */
export const cleanupSettings = (env: Readonly<Record<string, string | undefined>>): CleanupSettings => {
  const dry = (env.DORI_CLEANUP_DRY_RUN ?? "").trim().toLowerCase();
  const modes: Partial<Record<CleanupTarget, CleanupMode>> = {};
  const ignored: string[] = [];
  for (const entry of (env.DORI_CLEANUP_TARGETS ?? "").split(/[\s,]+/).filter(Boolean)) {
    const [name = "", mode = "", ...rest] = entry.split("=");
    if (rest.length || !(CLEANUP_TARGETS as readonly string[]).includes(name) || !(CLEANUP_MODES as readonly string[]).includes(mode)) {
      ignored.push(`DORI_CLEANUP_TARGETS entry ${JSON.stringify(entry)} ignored: want <target>=<on|report|off>, targets ${CLEANUP_TARGETS.join(",")}`);
      continue;
    }
    modes[name as CleanupTarget] = mode as CleanupMode;
  }
  return { dryRun: !["", "0", "false", "no", "off"].includes(dry), modes, ignored };
};

/** The mode `target` runs in: its setting or default, and `report` instead of `on` in a dry run. */
export const cleanupMode = (settings: CleanupSettings | undefined, target: CleanupTarget): CleanupMode => {
  const mode = settings?.modes[target] ?? CLEANUP_DEFAULT_MODES[target];
  return mode === "on" && settings?.dryRun ? "report" : mode;
};

/** The sweep runs once a day; the runner checks hourly whether the last one (its status file) is that old. */
export const CLEANUP_EVERY_MS = DAY_MS;
export const CLEANUP_CHECK_MS = HOUR_MS;
/** The first check waits this long after the runner starts, so a restart does not sweep while the host is busy coming up. */
export const CLEANUP_FIRST_DELAY_MS = 10 * 60_000;
/** `<runnerDir>/logs/cleanup.json`: the last sweep's report, the sweep's status on this host. */
export const CLEANUP_STATUS_FILE = "cleanup.json";
/** Bounds one tree walk; deeper entries are left for a later day. */
const MAX_DEPTH = 32;
const GIT_PRUNE_TIMEOUT_MS = 30_000;
const IN_USE_TIMEOUT_MS = 60_000;

/** Top-level temp entries that belong to live sessions (the same set the Linux host's tmpfiles rule excluded). */
export const TEMP_EXCLUDES: readonly string[] = [
  ".X11-unix", ".ICE-unix", ".XIM-unix", ".font-unix", "systemd-private-*", "snap-private-tmp", "tmux-*", "herdr*", ".*.hm",
  "*.sock", "*.lock", "clr-debug-pipe-*", "dotnet-diagnostic-*", "senpi-*", "event-log-*", "metro-file-map-*", "node-compile-cache",
  "com.apple.*", ".com.apple.*", "launchd*", "*.pid",
];
const globRegex = (glob: string): RegExp =>
  new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
const TEMP_EXCLUDE_RES = TEMP_EXCLUDES.map(globRegex);
export const tempExcluded = (name: string): boolean => TEMP_EXCLUDE_RES.some((re) => re.test(name));
/** A lock file anywhere in a swept tree is kept (tmpfiles' `x /tmp/*\/*.lock`). */
const lockName = (name: string): boolean => name.endsWith(".lock") || name === "lock" || name === "LOCK";
export const BUN_CHROME = /^\..+\.bun-chrome$/;

export type CleanupPaths = {
  readonly os: string;
  readonly home: string;
  readonly omoTmp: string;
  readonly laneSandbox: string;
  readonly sessions: string;
  readonly sessionsArchive: string;
  readonly memoryAgents: string;
  readonly evidence: string;
  /** The system temp dirs swept for the user's own files and for browser profiles. */
  readonly temps: readonly string[];
  /** Linux only. */
  readonly varTmp?: string;
  /** Never removed, nor anything inside them. */
  readonly secrets: readonly string[];
};

const stripSlash = (p: string, path: typeof posix): string => (p.length > path.parse(p).root.length ? p.replace(/[\\/]+$/, "") : p);

/**
 * Where the sweep looks on `os`: Linux from `$HOME`, `/tmp` and `/var/tmp`; macOS from `$HOME`, `$TMPDIR` and `/tmp`;
 * Windows from `%USERPROFILE%` and `%TEMP%` (else `%TMP%`, else `%LOCALAPPDATA%\Temp`). `fallbackHome` stands in for an
 * unset home variable. Path syntax follows `os`, not the host this runs on.
 */
export const cleanupPaths = (os: string, env: Readonly<Record<string, string | undefined>>, fallbackHome: string): CleanupPaths => {
  const windows = os === "win32";
  const path = windows ? win32 : posix;
  const home = stripSlash((windows ? env.USERPROFILE : env.HOME) || fallbackHome, path);
  const omoTmp = path.join(home, ".cache", "omo-tmp");
  const omoAgent = path.join(home, ".omo", "agent");
  const temps = windows
    ? [env.TEMP || env.TMP || path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Temp")]
    : [...(os === "darwin" && env.TMPDIR ? [env.TMPDIR] : []), "/tmp"];
  const unique = [...new Set(temps.filter((t) => path.isAbsolute(t)).map((t) => stripSlash(path.normalize(t), path)))];
  return {
    os, home, omoTmp,
    laneSandbox: path.join(omoTmp, "lane-sandbox"),
    sessions: path.join(omoAgent, "sessions"),
    sessionsArchive: path.join(omoAgent, "sessions-archive"),
    memoryAgents: path.join(home, ".omo", "memory", "agents"),
    evidence: path.join(home, ".dori", "runner", "evidence"),
    temps: unique,
    ...(os === "linux" ? { varTmp: "/var/tmp" } : {}),
    secrets: [path.join(home, ".dori", "secrets"), path.join(home, ".secrets")],
  };
};

/** The omo memory agent dir suffix for a session started in `cwd` (memory-check.ts resolveMemoryRepo). */
export const memoryAgentSuffix = (cwd: string): string => `-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`;
/** omo's session dir name for `cwd`: `/data/dori` -> `--data-dori--`. */
export const sessionDirName = (cwd: string): string => `--${cwd.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-")}--`;

/**
 * Paths the sweep must leave alone. `subtree` covers the path and everything inside it; every path added also covers its
 * ancestors, so a directory holding a shielded path is never removed whole.
 */
export class Shield {
  private readonly trees = new Set<string>();
  private readonly ancestors = new Set<string>();
  constructor(private readonly path: typeof posix) {}
  private key(p: string): string { return this.path === win32 ? p.toLowerCase() : p; }
  add(p: string, subtree: boolean): void {
    let cur = this.path.normalize(p);
    if (subtree) this.trees.add(this.key(cur));
    for (;;) {
      this.ancestors.add(this.key(cur));
      const up = this.path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  covers(p: string): boolean {
    let cur = this.path.normalize(p);
    if (this.ancestors.has(this.key(cur))) return true;
    for (;;) {
      if (this.trees.has(this.key(cur))) return true;
      const up = this.path.dirname(cur);
      if (up === cur) return false;
      cur = up;
    }
  }
}

/** What a process holds: files it has open (`files`) and directories it runs in (`dirs`, the whole tree counts). */
export type InUse = { readonly files: readonly string[]; readonly dirs: readonly string[] };

/** Linux: every fd target and cwd under /proc this user can read. */
const procInUse = async (): Promise<InUse> => {
  const files: string[] = [], dirs: string[] = [];
  let pids: string[] = [];
  try { pids = (await readdir("/proc")).filter((n) => /^\d+$/.test(n)); } catch { return { files, dirs }; }
  for (const pid of pids) {
    try { dirs.push(await readlink(`/proc/${pid}/cwd`)); } catch { /* gone, or another user's */ }
    let fds: string[];
    try { fds = await readdir(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const target = (await readlink(`/proc/${pid}/fd/${fd}`)).replace(/ \(deleted\)$/, "");
        if (target.startsWith("/")) files.push(target);
      } catch { /* closed meanwhile */ }
    }
  }
  return { files, dirs };
};

/** macOS: `lsof -Fn` for this user's processes; `fcwd` marks a process's working directory. */
export const parseLsof = (out: string): InUse => {
  const files: string[] = [], dirs: string[] = [];
  let fd = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("f")) fd = line.slice(1);
    else if (line.startsWith("n/")) (fd === "cwd" ? dirs : files).push(line.slice(1));
  }
  return { files, dirs };
};

/** The paths in use on this host; Windows has no cheap listing, and refuses to delete an open file anyway. */
export const inUsePaths = async (os: string, run: Runner, uid: number | undefined): Promise<InUse> => {
  if (os === "linux") return procInUse();
  if (os === "darwin" && uid !== undefined) {
    const r = await run(["lsof", "-n", "-P", "-w", "-u", String(uid), "-Fn"], { timeoutMs: IN_USE_TIMEOUT_MS });
    // lsof exits 1 when some process could not be read; its output is still the list.
    if (r.out) return parseLsof(r.out);
    throw new Error(`lsof exited ${r.code}: ${r.err.slice(0, 200)}`);
  }
  return { files: [], dirs: [] };
};

/** Why an entry the target walked was left: shielded (open lane, in use, secret store), a git checkout, a lock file,
 * another user's, a live-session temp name, an archive copy already there, a root the sweep refuses. */
export type SkipReason = "shielded" | "checkout" | "lock" | "otherUser" | "excluded" | "archived" | "unsafeRoot";
/**
 * One target's counts. `candidates`/`candidateBytes`: what qualified for removal (removed in `on`, only counted in
 * `report`); `removed`/`bytes`: what was actually removed. `skip`: why the whole target did not run.
 */
export type TargetCount = {
  mode: CleanupMode;
  removed: number;
  bytes: number;
  candidates: number;
  candidateBytes: number;
  kept: number;
  errors: number;
  skipped: Partial<Record<SkipReason, number>>;
  skip?: "off" | "inUseFailed";
};
export type CleanupReport = {
  readonly at: string;
  readonly ms: number;
  /** Every target ran in `report` or `off`. */
  readonly dryRun: boolean;
  readonly targets: Readonly<Record<string, TargetCount>>;
  /** `candidates`: worktree records `git worktree prune --dry-run` lists (report mode). */
  readonly worktreePrune: { readonly mode: CleanupMode; readonly ok: number; readonly failed: number; readonly candidates: number };
  /** `failed`: the in-use listing failed, so the temp, build temp and memory agent targets were skipped this time. */
  readonly inUse: "ok" | "failed";
  readonly skippedRoots: readonly string[];
  readonly errors: readonly string[];
};

export type CleanupDeps = {
  readonly paths: CleanupPaths;
  readonly now: number;
  readonly run: Runner;
  readonly log: (line: string) => void;
  /** The repos to `git worktree prune`. */
  readonly repos: readonly string[];
  /** The lanes open on this host: their sandbox dir (by key), cwd, session dir and memory agent stay. */
  readonly openLanes: readonly { readonly key: string; readonly cwd?: string }[];
  /** cwds whose memory agent always stays (the lead's). */
  readonly keepAgents: readonly string[];
  readonly inUse: () => Promise<InUse>;
  /** POSIX: only this user's entries are removed. Undefined on Windows. */
  readonly uid: number | undefined;
  /** Per-target modes and dry run; absent runs every target in its default mode. */
  readonly settings?: CleanupSettings;
};

type Ctx = {
  readonly shield: Shield;
  readonly uid: number | undefined;
  readonly errors: string[];
};

const ageOf = (st: { mtimeMs: number; ctimeMs: number; atimeMs: number }): number => Math.max(st.mtimeMs, st.ctimeMs, st.atimeMs);
const newCount = (mode: CleanupMode): TargetCount => ({ mode, removed: 0, bytes: 0, candidates: 0, candidateBytes: 0, kept: 0, errors: 0, skipped: {} });
const skipped = (count: TargetCount, reason: SkipReason): void => { count.skipped[reason] = (count.skipped[reason] ?? 0) + 1; };
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const noteError = (ctx: Ctx, count: TargetCount, path: string, e: unknown): void => {
  count.errors++;
  if (ctx.errors.length < 20) ctx.errors.push(`${path}: ${errText(e)}`);
};

const isCheckout = async (dir: string): Promise<boolean> => {
  try { await lstat(join(dir, ".git")); return true; } catch { return false; }
};

type WalkOptions = {
  readonly cutoff: number;
  /** false: only empty directories are removed, files stay. */
  readonly files: boolean;
  /** Top-level names left alone. */
  readonly skipTop?: (name: string) => boolean;
};

/** The size of the files under `dir` (symlinks not followed), bounded like a sweep walk. */
const treeBytes = async (dir: string, depth = 0): Promise<number> => {
  let names: string[];
  try { names = await readdir(dir); } catch { return 0; }
  let total = 0;
  for (const name of names) {
    try {
      const st = await lstat(join(dir, name));
      if (st.isFile()) total += st.size;
      else if (st.isDirectory() && depth < MAX_DEPTH) total += await treeBytes(join(dir, name), depth + 1);
    } catch { /* gone */ }
  }
  return total;
};

/**
 * Removes, under `dir` (never `dir` itself), files older than the cutoff and directories that are then empty and were
 * older than it before the walk, as systemd-tmpfiles ages a tree. Returns how many entries remain directly in `dir`.
 * In `report` mode nothing is removed: candidates count as gone, so a directory of candidates is a candidate too.
 */
const sweepChildren = async (dir: string, opts: WalkOptions, ctx: Ctx, count: TargetCount, depth = 0): Promise<number> => {
  const live = count.mode === "on";
  let names: string[];
  try { names = await readdir(dir); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") noteError(ctx, count, dir, e);
    return 1;
  }
  let remaining = 0;
  for (const name of names) {
    const path = join(dir, name);
    if (depth === 0 && opts.skipTop?.(name)) { remaining++; skipped(count, "excluded"); continue; }
    if (lockName(name)) { remaining++; skipped(count, "lock"); continue; }
    if (ctx.shield.covers(path)) { remaining++; count.kept++; skipped(count, "shielded"); continue; }
    let st;
    try { st = await lstat(path); } catch { remaining++; continue; }
    if (ctx.uid !== undefined && st.uid !== ctx.uid) { remaining++; skipped(count, "otherUser"); continue; }
    if (st.isDirectory()) {
      if (await isCheckout(path)) { remaining++; count.kept++; skipped(count, "checkout"); continue; }
      const old = ageOf(st) < opts.cutoff;
      const left = depth < MAX_DEPTH ? await sweepChildren(path, opts, ctx, count, depth + 1) : 1;
      if (left === 0 && old) {
        count.candidates++;
        if (live) { try { await rmdir(path); count.removed++; } catch (e) { remaining++; noteError(ctx, count, path, e); } }
      } else remaining++;
    } else if (st.isFile() && opts.files && ageOf(st) < opts.cutoff) {
      count.candidates++;
      count.candidateBytes += st.size;
      if (live) { try { await unlink(path); count.removed++; count.bytes += st.size; } catch (e) { remaining++; noteError(ctx, count, path, e); } }
    } else remaining++;
  }
  return remaining;
};

/** A root the sweep may walk: absolute, not a filesystem root, and neither the home dir nor above it or a secret store. */
const safeRoot = (root: string, paths: CleanupPaths): boolean => {
  const path = paths.os === "win32" ? win32 : posix;
  if (!path.isAbsolute(root) || path.parse(root).root === path.normalize(root)) return false;
  const shield = new Shield(path);
  shield.add(paths.home, false);
  for (const s of paths.secrets) shield.add(s, false);
  return !shield.covers(root);
};

const listDirs = async (dir: string): Promise<string[]> => {
  try { return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
};

/** The newest mtime of a memory agent: its dir and the git files a commit or checkout touches. */
const agentAge = async (dir: string): Promise<number> => {
  let newest = 0;
  for (const p of [dir, join(dir, "repo"), join(dir, "repo", ".git"), join(dir, "repo", ".git", "index"), join(dir, "repo", ".git", "HEAD"), join(dir, "repo", ".git", "logs", "HEAD")]) {
    try { newest = Math.max(newest, ageOf(await lstat(p))); } catch { /* absent */ }
  }
  return newest;
};

/** One sweep over every target. A target that fails is counted and logged; the others still run. */
export const runCleanup = async (deps: CleanupDeps): Promise<CleanupReport> => {
  const started = Date.now();
  const { paths, now } = deps;
  const pathApi = paths.os === "win32" ? win32 : posix;
  const shield = new Shield(pathApi);
  for (const s of paths.secrets) shield.add(s, true);
  for (const lane of deps.openLanes) {
    shield.add(pathApi.join(paths.laneSandbox, lane.key), true);
    if (lane.cwd) shield.add(lane.cwd, true);
  }
  const errors: string[] = [];
  try {
    const used = await deps.inUse();
    for (const f of used.files) shield.add(f, false);
    for (const d of used.dirs) shield.add(d, true);
  } catch (e) {
    // Without the list a busy entry could be removed: skip the targets that depend on it.
    errors.push(`in-use listing failed: ${errText(e)}`);
  }
  const inUseKnown = errors.length === 0;
  // macOS `/tmp` and `$TMPDIR` are links into /private, where lsof reports open files: walk the real paths.
  const temps = [...new Set(await Promise.all(paths.temps.map((t) => realpath(t).catch(() => t))))];
  const ctx: Ctx = { shield, uid: deps.uid, errors };
  if (deps.settings) errors.push(...deps.settings.ignored);
  const targets: Record<string, TargetCount> = {};
  const skippedRoots: string[] = [];
  const target = (name: CleanupTarget): TargetCount => (targets[name] ??= newCount(cleanupMode(deps.settings, name)));
  /** The target's count when it runs this sweep; undefined, with the reason recorded, when it is off or needs the in-use list. */
  const runs = (name: CleanupTarget, needsInUse: boolean): TargetCount | undefined => {
    const count = target(name);
    if (count.mode === "off") { count.skip = "off"; return undefined; }
    if (needsInUse && !inUseKnown) { count.skip = "inUseFailed"; return undefined; }
    return count;
  };
  const walk = async (count: TargetCount, root: string, opts: WalkOptions): Promise<void> => {
    if (!safeRoot(root, paths)) { skippedRoots.push(root); skipped(count, "unsafeRoot"); return; }
    if (!existsSync(root)) return;
    await sweepChildren(root, opts, ctx, count);
  };

  const sandbox = runs("sandbox", true);
  if (sandbox) await walk(sandbox, paths.laneSandbox, { cutoff: now - CLEANUP_AGES.sandbox, files: true });
  const omoTmp = runs("omoTmp", true);
  if (omoTmp) await walk(omoTmp, paths.omoTmp, { cutoff: now - CLEANUP_AGES.omoTmp, files: true, skipTop: (n) => n === "lane-sandbox" });
  // Browser profiles first: they are also temp entries, but on a 2 hour clock.
  const chrome = runs("bunChrome", true);
  if (chrome) {
    for (const root of temps) {
      if (!safeRoot(root, paths)) { skippedRoots.push(root); skipped(chrome, "unsafeRoot"); continue; }
      for (const name of await listDirs(root)) {
        if (!BUN_CHROME.test(name)) continue;
        const dir = join(root, name);
        if (shield.covers(dir)) { chrome.kept++; skipped(chrome, "shielded"); continue; }
        try {
          const st = await lstat(dir);
          if (deps.uid !== undefined && st.uid !== deps.uid) { skipped(chrome, "otherUser"); continue; }
          let newest = st.mtimeMs;
          for (const child of await readdir(dir)) { try { newest = Math.max(newest, (await lstat(join(dir, child))).mtimeMs); } catch { /* gone */ } }
          if (newest >= now - CLEANUP_AGES.bunChrome) continue;
          const bytes = await treeBytes(dir);
          chrome.candidates++;
          chrome.candidateBytes += bytes;
          if (chrome.mode !== "on") continue;
          await rm(dir, { recursive: true, force: true });
          chrome.removed++;
          chrome.bytes += bytes;
        } catch (e) { noteError(ctx, chrome, dir, e); }
      }
    }
  }
  const temp = runs("temp", true);
  if (temp) for (const root of temps) await walk(temp, root, { cutoff: now - CLEANUP_AGES.temp, files: true, skipTop: (n) => tempExcluded(n) || BUN_CHROME.test(n) });
  const varTmp = paths.varTmp ? runs("varTmp", true) : undefined;
  if (varTmp && paths.varTmp) await walk(varTmp, paths.varTmp, { cutoff: now - CLEANUP_AGES.varTmp, files: true, skipTop: tempExcluded });

  // Sessions: archived (moved), never deleted. An open lane's session dir stays where omo resumes it from.
  const archived = runs("sessionsArchived", false);
  const emptyDirs = runs("emptyArtifactDirs", false);
  const openSessionDirs = new Set(deps.openLanes.flatMap((l) => (l.cwd ? [sessionDirName(l.cwd)] : [])));
  const sessionsCount = archived ?? emptyDirs;
  if (sessionsCount && !(safeRoot(paths.sessions, paths) && safeRoot(paths.sessionsArchive, paths))) {
    skippedRoots.push(paths.sessions);
    skipped(sessionsCount, "unsafeRoot");
  } else if (sessionsCount) {
    for (const cwdDir of await listDirs(paths.sessions)) {
      if (cwdDir.startsWith(".") || openSessionDirs.has(cwdDir)) continue;
      const dir = join(paths.sessions, cwdDir);
      let names: string[];
      try { names = await readdir(dir); } catch (e) { noteError(ctx, sessionsCount, dir, e); continue; }
      if (archived) for (const name of names.filter((n) => n.endsWith(".jsonl"))) {
        const file = join(dir, name);
        if (shield.covers(file)) { archived.kept++; skipped(archived, "shielded"); continue; }
        try {
          const st = await lstat(file);
          if (!st.isFile() || st.mtimeMs >= now - CLEANUP_AGES.sessions) continue;
          const dest = join(paths.sessionsArchive, cwdDir);
          if (existsSync(join(dest, name))) { skipped(archived, "archived"); continue; }
          archived.candidates++;
          archived.candidateBytes += st.size;
          if (archived.mode !== "on") continue;
          await mkdir(dest, { recursive: true, mode: 0o700 });
          await rename(file, join(dest, name));
          archived.removed++;
          archived.bytes += st.size;
          const artifacts = `${name.slice(0, -".jsonl".length)}-artifacts`;
          if (existsSync(join(dir, artifacts)) && !existsSync(join(dest, artifacts))) await rename(join(dir, artifacts), join(dest, artifacts));
        } catch (e) { noteError(ctx, archived, file, e); }
      }
      // Empty artifact dirs left behind by sessions that never wrote one.
      if (emptyDirs) for (const name of names.filter((n) => n.endsWith("-artifacts"))) {
        const art = join(dir, name);
        try {
          const st = await lstat(art);
          if (!st.isDirectory() || st.mtimeMs >= now - CLEANUP_AGES.emptyDirs || (await readdir(art)).length) continue;
          emptyDirs.candidates++;
          if (emptyDirs.mode !== "on") continue;
          await rmdir(art);
          emptyDirs.removed++;
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") noteError(ctx, emptyDirs, art, e); }
      }
    }
  }
  if (emptyDirs) await walk(emptyDirs, paths.evidence, { cutoff: now - CLEANUP_AGES.emptyDirs, files: false });

  // Memory agents of lanes long gone. The lead's and every open lane's stay.
  const agents = runs("memoryAgents", true);
  const keepSuffixes = [...deps.keepAgents, ...deps.openLanes.flatMap((l) => (l.cwd ? [l.cwd] : []))].map(memoryAgentSuffix);
  if (agents && !safeRoot(paths.memoryAgents, paths)) skipped(agents, "unsafeRoot");
  else if (agents) {
    for (const name of await listDirs(paths.memoryAgents)) {
      const dir = join(paths.memoryAgents, name);
      if (keepSuffixes.some((s) => name.endsWith(s)) || shield.covers(dir)) { agents.kept++; skipped(agents, "shielded"); continue; }
      try {
        const st = await lstat(dir);
        if (deps.uid !== undefined && st.uid !== deps.uid) { skipped(agents, "otherUser"); continue; }
        if (await agentAge(dir) >= now - CLEANUP_AGES.memoryAgents) continue;
        const bytes = await treeBytes(dir);
        agents.candidates++;
        agents.candidateBytes += bytes;
        if (agents.mode !== "on") continue;
        await rm(dir, { recursive: true, force: true });
        agents.removed++;
        agents.bytes += bytes;
      } catch (e) { noteError(ctx, agents, dir, e); }
    }
  }

  // Worktree records whose directory is gone; git keeps locked ones and never touches a worktree that exists.
  // In report mode `--dry-run --verbose` lists the records (`Removing worktrees/<name>: ...`) without dropping them.
  const pruneMode = cleanupMode(deps.settings, "worktreePrune");
  let ok = 0, failed = 0, candidates = 0;
  for (const repo of pruneMode === "off" ? [] : new Set(deps.repos)) {
    const r = await deps.run(["git", "-C", repo, "worktree", "prune", ...(pruneMode === "report" ? ["--dry-run", "--verbose"] : [])], { timeoutMs: GIT_PRUNE_TIMEOUT_MS });
    if (r.code === 0) {
      ok++;
      if (pruneMode === "report") candidates += `${r.out}\n${r.err}`.split("\n").filter((l) => l.startsWith("Removing ")).length;
    } else { failed++; if (errors.length < 20) errors.push(`git worktree prune ${repo}: ${(r.err || r.out).slice(0, 200)}`); }
  }
  return {
    at: new Date(now).toISOString(), ms: Date.now() - started, dryRun: deps.settings?.dryRun ?? false, targets,
    worktreePrune: { mode: pruneMode, ok, failed, candidates }, inUse: inUseKnown ? "ok" : "failed", skippedRoots, errors,
  };
};

/**
 * `RUNNER_CLEANUP at=... sandbox=<removed> ... freedBytes=... kept=... errors=...`: one line per sweep. A target in
 * `report` mode shows `report:<candidates>/<bytes>B`, an `off` one `off`, one skipped for a failed in-use listing
 * `skip:inUseFailed`; `skipped=<target>.<reason>:<n>,...` lists why entries were left.
 */
export const cleanupLine = (report: CleanupReport): string => {
  const counts = Object.entries(report.targets);
  const sum = (k: "bytes" | "kept" | "errors", of = counts): number => of.reduce((n, [, c]) => n + c[k], 0);
  const shown = (c: TargetCount): string =>
    c.skip === "off" ? "off" : c.skip ? `skip:${c.skip}` : c.mode === "report" ? `report:${c.candidates}/${c.candidateBytes}B` : String(c.removed);
  const reported = counts.filter(([, c]) => c.mode === "report" && !c.skip);
  const skips = counts.flatMap(([name, c]) => Object.entries(c.skipped).map(([reason, n]) => `${name}.${reason}:${n}`));
  const prune = report.worktreePrune;
  return [
    `RUNNER_CLEANUP at=${report.at}`,
    ...(report.dryRun ? ["dryRun=1"] : []),
    ...counts.map(([name, c]) => `${name}=${shown(c)}`),
    `worktreePrune=${prune.mode === "off" ? "off" : prune.mode === "report" ? `report:${prune.candidates}` : `${prune.ok}/${prune.ok + prune.failed}`}`,
    `freedBytes=${sum("bytes")}`,
    ...(reported.length ? [`wouldFreeBytes=${reported.reduce((n, [, c]) => n + c.candidateBytes, 0)}`] : []),
    `kept=${sum("kept")}`, `inUse=${report.inUse}`, `errors=${sum("errors") + prune.failed}`,
    ...(skips.length ? [`skipped=${skips.join(",")}`] : []),
    ...(report.skippedRoots.length ? [`skippedRoots=${report.skippedRoots.join(",")}`] : []),
    `ms=${report.ms}`,
  ].join(" ");
};

export type CleanupSchedule = {
  readonly statusFile: string;
  readonly now: () => number;
  readonly every: (ms: number, tick: () => void) => () => void;
  readonly delay: (ms: number, fn: () => void) => () => void;
  readonly sweep: () => Promise<CleanupReport>;
  readonly log: (line: string) => void;
};

const lastSweepAt = (statusFile: string): number | undefined => {
  try {
    const at = Date.parse((JSON.parse(readFileSync(statusFile, "utf8")) as { at?: string }).at ?? "");
    return Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
};

/**
 * Runs `sweep` once a day: CLEANUP_FIRST_DELAY_MS after start, then every CLEANUP_CHECK_MS, when the status file's last
 * sweep is CLEANUP_EVERY_MS old (or missing), so restarts neither skip a day nor sweep twice. Each sweep's report is
 * written to the status file and logged. Returns the stop.
 */
export const startCleanup = (deps: CleanupSchedule): (() => void) => {
  let running = false;
  const writeStatus = (body: object): void => {
    try { writeRunnerFile(deps.statusFile, `${JSON.stringify(body)}\n`); } catch (e) { deps.log(`RUNNER_CLEANUP_STATUS_FAILED ${errText(e)}`); }
  };
  const sweepOnce = async (): Promise<void> => {
    let report: CleanupReport;
    try { report = await deps.sweep(); } catch (e) {
      running = false;
      deps.log(`RUNNER_CLEANUP_FAILED ${errText(e)}`);
      // Recorded as a sweep, so a failing one is retried tomorrow rather than every hour.
      writeStatus({ at: new Date(deps.now()).toISOString(), failed: errText(e) });
      return;
    }
    running = false;
    writeStatus(report);
    deps.log(cleanupLine(report));
    for (const e of report.errors) deps.log(`RUNNER_CLEANUP_ERROR ${e}`);
  };
  const tick = (): void => {
    if (running) return;
    const last = lastSweepAt(deps.statusFile);
    if (last !== undefined && deps.now() - last < CLEANUP_EVERY_MS) return;
    running = true;
    void sweepOnce();
  };
  let stopEvery: (() => void) | undefined;
  const stopDelay = deps.delay(CLEANUP_FIRST_DELAY_MS, () => { tick(); stopEvery = deps.every(CLEANUP_CHECK_MS, tick); });
  return () => { stopDelay(); stopEvery?.(); };
};
