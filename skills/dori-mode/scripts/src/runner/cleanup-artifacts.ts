import { readdir, readFile, lstat, realpath, rm } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import type { Runner } from "../run.ts";
import {
  CLEANUP_AGES, changedAt, errText, gitDirOf, isCheckout, keyNames, noteError, safeRoot, skipped, stripSlash, treeBytes,
  type CleanupDeps, type CleanupTarget, type ClosedLane, type Ctx, type InUse, type TargetCount,
} from "./cleanup.ts";

/**
 * Build output in closed lanes' worktrees and Metro's temp caches, the cleanup sweep's targets after closedNodeModules
 * (cleanup.ts runs them; each has its own mode and starts at `report`):
 * - closedAndroidBuild: `android/build`, `android/<module>/build` and `android/.gradle`, the lane idle for 7 days, no Gradle running;
 * - closedExpo: `.expo`, the lane closed and idle for 14 days, no Metro or Expo dev server running;
 * - closedPods: `ios/Pods` that git does not track, the lane idle for 7 days, no Xcode, xcodebuild, Simulator or pod running;
 * - closedCargoTarget: `target` holding cargo's CACHEDIR.TAG, the lane idle and no file in it changed for 7 days, no
 *   cargo, rustc or rust-analyzer running;
 * - metroCache: `metro-*` entries directly in a temp root (Metro's cache and file map) with no change for 3 days, no
 *   Metro or Expo dev server running.
 * Each worktree target looks in the worktree and in its direct subdirectories (a project inside a monorepo), and keeps
 * everything closedNodeModules keeps (open, opening and reopened lanes, in-use paths, recent changes) plus anything git
 * tracks. A matching process anywhere on the host keeps the whole target for the day (`toolRunning`).
 */

/** The process listing's command lines; Windows has none (and refuses to delete a file a process holds open). */
export const processCommands = async (os: string, run: Runner): Promise<readonly string[]> => {
  if (os === "linux") {
    const out: string[] = [];
    for (const pid of (await readdir("/proc")).filter((n) => /^\d+$/.test(n))) {
      try {
        const line = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean).join(" ");
        if (line) out.push(line);
      } catch { /* gone */ }
    }
    return out;
  }
  if (os === "darwin") {
    const r = await run(["ps", "-A", "-o", "command="], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`ps exited ${r.code}: ${r.err.slice(0, 200)}`);
    return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  return [];
};

/** Processes that write into each target: one of them running anywhere keeps that target for the day. */
export const TOOL_PROCESSES = {
  gradle: /GradleDaemon|GradleWrapperMain|gradle-launcher|(^|[/\s])gradlew?(\s|$)/,
  metro: /\bmetro\b|@expo\/cli|(^|[/\s])expo(\.js)?\s+(start|run|export)|react-native(\.js)?\s+(start|run-)/i,
  xcode: /Xcode\.app|xcodebuild|Simulator\.app|(^|[/\s])pod(\s|$)/,
  cargo: /(^|[/\s])(cargo|rustc|rust-analyzer)(\s|$)/,
} as const;

type ArtifactTarget = "closedAndroidBuild" | "closedExpo" | "closedPods" | "closedCargoTarget";
type ArtifactKind = {
  readonly target: ArtifactTarget;
  readonly tool: RegExp;
  /** Candidate dirs relative to a project dir (the worktree or one of its direct subdirectories). */
  readonly dirs: (project: string) => Promise<readonly string[]>;
  /** A file the dir must hold to be this tool's output. */
  readonly marker?: string;
  /** No file inside may have changed within the lane age either (cargo's target, where a lane can build long after its HEAD moved). */
  readonly newestFile?: boolean;
};

const subdirs = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name);
  } catch { return []; }
};

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  {
    target: "closedAndroidBuild", tool: TOOL_PROCESSES.gradle,
    dirs: async (project) => [
      join("android", "build"), join("android", ".gradle"),
      ...(await subdirs(join(project, "android"))).filter((m) => m !== "build").map((m) => join("android", m, "build")),
    ],
  },
  { target: "closedExpo", tool: TOOL_PROCESSES.metro, dirs: async () => [".expo"] },
  { target: "closedPods", tool: TOOL_PROCESSES.xcode, dirs: async () => [join("ios", "Pods")] },
  { target: "closedCargoTarget", tool: TOOL_PROCESSES.cargo, dirs: async () => ["target"], marker: "CACHEDIR.TAG", newestFile: true },
];
export const METRO_ENTRY = /^metro-/;

/** Whether anything under `dir` (or `dir` itself) changed at or after `since`; stops at the first one. */
const changedSince = async (dir: string, since: number, depth = 0): Promise<boolean> => {
  if ((await changedAt(dir)) >= since) return true;
  let names: string[];
  try { names = await readdir(dir); } catch { return false; }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = await lstat(p); } catch { continue; }
    if (Math.max(st.mtimeMs, st.ctimeMs) >= since) return true;
    if (st.isDirectory() && depth < 32 && (await changedSince(p, since, depth + 1))) return true;
  }
  return false;
};

export type ArtifactSweep = {
  readonly deps: CleanupDeps;
  /** cleanup.ts's target gate: the count when the target runs, undefined (reason recorded) when off or the in-use list failed. */
  readonly runs: (name: CleanupTarget, needsInUse: boolean) => TargetCount | undefined;
  readonly used: InUse;
  /** The temp roots, real paths. */
  readonly temps: readonly string[];
  readonly ctx: Ctx;
};

type Pick = { readonly kind: ArtifactKind; readonly count: TargetCount; readonly key: string; readonly closedAt: number; readonly dir: string; readonly bytes: number };

export const sweepArtifacts = async ({ deps, runs, used, temps, ctx }: ArtifactSweep): Promise<void> => {
  const counts = new Map<ArtifactKind, TargetCount>();
  for (const kind of ARTIFACT_KINDS) { const c = runs(kind.target, true); if (c) counts.set(kind, c); }
  const metro = runs("metroCache", true);
  if (!counts.size && !metro) return;
  let commands: readonly string[];
  try { commands = await deps.procs(); } catch (e) {
    for (const c of [...counts.values(), ...(metro ? [metro] : [])]) c.skip = "procsFailed";
    if (ctx.errors.length < 20) ctx.errors.push(`process listing failed: ${errText(e)}`);
    return;
  }
  const running = (tool: RegExp): boolean => commands.some((c) => tool.test(c));
  for (const [kind, count] of counts) if (running(kind.tool)) { count.skip = "toolRunning"; counts.delete(kind); }
  if (metro && running(TOOL_PROCESSES.metro)) metro.skip = "toolRunning";
  else if (metro) await sweepMetro(deps, temps, metro, ctx);
  if (!counts.size) return;
  if (!deps.closedLanes) { for (const c of counts.values()) c.skip = "noRegistry"; return; }
  await sweepClosedArtifacts(deps, deps.closedLanes, counts, used, ctx);
};

/** metroCache: top-level `metro-*` entries of the temp roots, this user's, nothing in them changed for 3 days. */
const sweepMetro = async (deps: CleanupDeps, temps: readonly string[], count: TargetCount, ctx: Ctx): Promise<void> => {
  const since = deps.now - CLEANUP_AGES.metroCache;
  for (const root of temps) {
    if (!safeRoot(root, deps.paths)) { skipped(count, "unsafeRoot"); continue; }
    let names: string[];
    try { names = await readdir(root); } catch { continue; }
    for (const name of names.filter((n) => METRO_ENTRY.test(n))) {
      const p = join(root, name);
      if (ctx.shield.covers(p)) { count.kept++; skipped(count, "shielded"); continue; }
      try {
        const st = await lstat(p);
        if (deps.uid !== undefined && st.uid !== deps.uid) { skipped(count, "otherUser"); continue; }
        if (!st.isDirectory() && !st.isFile()) continue;
        if (st.isDirectory() ? await changedSince(p, since) : Math.max(st.mtimeMs, st.ctimeMs) >= since) { skipped(count, "recent"); continue; }
        const bytes = st.isDirectory() ? await treeBytes(p) : st.size;
        count.candidates++;
        count.candidateBytes += bytes;
        if (count.mode !== "on") continue;
        await rm(p, { recursive: true, force: true });
        count.removed++;
        count.bytes += bytes;
      } catch (e) { noteError(ctx, count, p, e); }
    }
  }
};

/** The worktree targets, over the closed lanes' worktrees; the registry is read again before anything is removed. */
const sweepClosedArtifacts = async (
  deps: CleanupDeps, closedLanes: () => Promise<readonly ClosedLane[]>, counts: Map<ArtifactKind, TargetCount>, used: InUse, ctx: Ctx,
): Promise<void> => {
  const { paths, now } = deps;
  const pathApi = paths.os === "win32" ? win32 : posix;
  const fold = (p: string): string => (paths.os === "win32" ? pathApi.normalize(p).toLowerCase() : pathApi.normalize(p));
  const held = [...used.files, ...used.dirs].map(fold);
  const inUseUnder = (dir: string): boolean => { const d = fold(dir); return held.some((p) => p === d || p.startsWith(`${d}${pathApi.sep}`)); };
  let lanes: readonly ClosedLane[];
  try { lanes = await closedLanes(); } catch (e) {
    for (const c of counts.values()) c.skip = "registryFailed";
    if (ctx.errors.length < 20) ctx.errors.push(`closed lanes not read: ${errText(e)}`);
    return;
  }
  const openKeys = deps.openLanes.map((l) => l.key);
  const openCwds = new Set(deps.openLanes.flatMap((l) => (l.cwd ? [pathApi.normalize(l.cwd)] : [])));
  const picked: Pick[] = [];
  const seen = new Set<string>();
  for (const lane of lanes) {
    for (const raw of lane.worktrees) {
      const worktree = stripSlash(pathApi.normalize(raw), pathApi);
      if (seen.has(worktree)) continue;
      seen.add(worktree);
      // The candidate dirs that exist, this user's real directories (never a symlink out of the worktree).
      const found: { kind: ArtifactKind; count: TargetCount; dir: string; rel: string }[] = [];
      for (const project of ["", ...(await subdirs(worktree))]) {
        for (const [kind, count] of counts) {
          for (const rel of (await kind.dirs(join(worktree, project))).map((d) => join(project, d))) {
            const dir = join(worktree, rel);
            let st;
            try { st = await lstat(dir); } catch { continue; }
            if (!st.isDirectory()) continue;
            if (deps.uid !== undefined && st.uid !== deps.uid) { skipped(count, "otherUser"); continue; }
            if (kind.marker) { try { await lstat(join(dir, kind.marker)); } catch { continue; } }
            found.push({ kind, count, dir, rel });
          }
        }
      }
      if (!found.length) continue;
      // A linked `android` or `ios` dir would lead the removal out of the worktree: only real paths inside it count.
      const realWorktree = await realpath(worktree).catch(() => undefined);
      if (!realWorktree) continue;
      for (const f of [...found]) {
        const real = await realpath(f.dir).catch(() => undefined);
        if (!real || !real.startsWith(`${realWorktree}${pathApi.sep}`)) { found.splice(found.indexOf(f), 1); skipped(f.count, "unsafeRoot"); }
      }
      if (!found.length) continue;
      const skipAll = (reason: Parameters<typeof skipped>[1], kept = false): void => {
        for (const f of found) { if (kept) f.count.kept++; skipped(f.count, reason); }
      };
      if (!safeRoot(worktree, paths)) { skipAll("unsafeRoot"); continue; }
      if (!(await isCheckout(worktree))) continue;
      if (openKeys.includes(lane.key)) { skipAll("reopened"); continue; }
      const name = pathApi.basename(worktree);
      if (openCwds.has(worktree) || openKeys.some((k) => keyNames(k, name)) || inUseUnder(worktree)) { skipAll("shielded", true); continue; }
      const gitDir = await gitDirOf(worktree);
      const gitTimes = gitDir ? await Promise.all(["HEAD", "index", join("logs", "HEAD")].map((p) => changedAt(join(gitDir, p)))) : [];
      const lastActivity = Math.max(lane.closedAt, ...gitTimes);
      const worktreeChange = Math.max(...(await Promise.all([worktree, join(worktree, ".git")].map(changedAt))));
      for (const f of found) {
        const age = CLEANUP_AGES[f.kind.target];
        const quiet = now - CLEANUP_AGES.worktreeQuiet;
        if (lastActivity >= now - age || Math.max(worktreeChange, await changedAt(f.dir)) >= quiet
          || (f.kind.newestFile && (await changedSince(f.dir, now - age)))) { skipped(f.count, "recent"); continue; }
        // Checked-in output (Pods committed to the repo, a tracked build dir) stays: removing it would dirty the checkout.
        const tracked = await deps.run(["git", "--literal-pathspecs", "-C", worktree, "ls-files", "-z", "--", f.rel], { timeoutMs: 30_000 });
        if (tracked.code !== 0) { noteError(ctx, f.count, f.dir, new Error(`git ls-files exited ${tracked.code}: ${tracked.err.slice(0, 200)}`)); continue; }
        if (tracked.out.length) { f.count.kept++; skipped(f.count, "tracked"); continue; }
        picked.push({ kind: f.kind, count: f.count, key: lane.key, closedAt: lane.closedAt, dir: f.dir, bytes: await treeBytes(f.dir) });
      }
    }
  }
  if (!picked.length) return;
  // Read the registry again: a lane reopened while the sizes were counted keeps its worktree.
  let still: ReadonlySet<string> = new Set();
  if (picked.some((p) => p.count.mode === "on")) {
    try { still = new Set((await closedLanes()).map((l) => `${l.key}\0${l.closedAt}`)); } catch (e) {
      for (const c of counts.values()) if (c.mode === "on") c.skip = "registryFailed";
      if (ctx.errors.length < 20) ctx.errors.push(`closed lanes not read again: ${errText(e)}`);
      picked.splice(0, picked.length, ...picked.filter((p) => p.count.mode !== "on"));
    }
  }
  for (const p of picked) {
    const live = p.count.mode === "on";
    if (live && !still.has(`${p.key}\0${p.closedAt}`)) { skipped(p.count, "reopened"); continue; }
    p.count.candidates++;
    p.count.candidateBytes += p.bytes;
    if (!live) continue;
    try {
      await rm(p.dir, { recursive: true, force: true });
      p.count.removed++;
      p.count.bytes += p.bytes;
    } catch (e) { noteError(ctx, p.count, p.dir, e); }
  }
};
