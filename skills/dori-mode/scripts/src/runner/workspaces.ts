import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkCwd, type RunnerPolicy } from "./policy.ts";
import type { WorkspaceEntry } from "./protocol.ts";

/**
 * What a runner tells the supervisor about the repos on its host, sent in every hello:
 * - `workspaces`: the repos it declares it owns (runner-config `workspaces`), each path checked to exist under
 *   allowedRoots; an entry that fails is left out and logged `RUNNER_WORKSPACE_SKIPPED`.
 * - `detected`: git checkouts found under allowedRoots (directories with a `.git` directory, at most SCAN_DEPTH below a
 *   root) whose `origin` names a GitHub-style owner/repo it does not declare. Information only: placement never routes by it.
 */

export const SCAN_DEPTH = 3;
/** Directories read per scan at most, so a wide root cannot stall a hello. */
export const SCAN_MAX_DIRS = 2000;
export const DETECTED_MAX = 200;

/** Folders macOS guards with TCC: reading them from a launchd-run runner blocks on a permission prompt. */
const DARWIN_PROTECTED = new Set(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"]);
const SKIP = new Set(["node_modules"]);

/** owner/repo from a remote URL (`git@host:o/r.git`, `https://host/o/r`, `ssh://git@host/o/r.git`), else undefined. */
export const repoFromRemote = (url: string): string | undefined => {
  const m = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
};

export const originUrl = (gitConfig: string): string | undefined => {
  let inOrigin = false;
  for (const raw of gitConfig.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) { inOrigin = /^\[remote\s+"origin"\]$/.test(line); continue; }
    const m = inOrigin ? /^url\s*=\s*(.+)$/.exec(line) : null;
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
};

export type ScanFs = {
  readonly readdir: (dir: string) => readonly { readonly name: string; readonly dir: boolean }[];
  readonly readFile: (path: string) => string;
  readonly isDir: (path: string) => boolean;
};

export const realScanFs: ScanFs = {
  readdir: (dir) => readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })),
  readFile: (path) => readFileSync(path, "utf8"),
  isDir: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
};

/** Checkouts under `roots` (breadth-first, symlinks not followed, dot folders skipped), first path per repo. */
export const scanCheckouts = (roots: readonly string[], fs: ScanFs = realScanFs, os: string = process.platform): WorkspaceEntry[] => {
  const found = new Map<string, WorkspaceEntry>();
  const queue: { path: string; depth: number }[] = roots.map((path) => ({ path, depth: 0 }));
  let read = 0;
  while (queue.length && read < SCAN_MAX_DIRS && found.size < DETECTED_MAX) {
    const { path, depth } = queue.shift() as { path: string; depth: number };
    let entries;
    try { entries = fs.readdir(path); read++; } catch { continue; }
    if (entries.some((e) => e.name === ".git" && e.dir)) {
      let repo: string | undefined;
      try { const url = originUrl(fs.readFile(join(path, ".git", "config"))); repo = url ? repoFromRemote(url) : undefined; } catch { /* no config */ }
      if (repo && ![...found.keys()].some((k) => k.toLowerCase() === repo.toLowerCase())) found.set(repo, { repo, path });
      continue;
    }
    if (depth >= SCAN_DEPTH) continue;
    for (const e of entries) {
      if (!e.dir || e.name.startsWith(".") || SKIP.has(e.name) || (os === "darwin" && DARWIN_PROTECTED.has(e.name))) continue;
      queue.push({ path: join(path, e.name), depth: depth + 1 });
    }
  }
  return [...found.values()];
};

export type WorkspaceReport = { readonly workspaces: readonly WorkspaceEntry[]; readonly detected: readonly WorkspaceEntry[] };

/** The hello `workspaces` and `detected` of a runner with `policy`. */
export const workspaceReport = (policy: RunnerPolicy, deps: {
  readonly realpath: (path: string) => string; readonly log: (line: string) => void; readonly fs?: ScanFs; readonly os?: string;
}): WorkspaceReport => {
  const workspaces: WorkspaceEntry[] = [];
  for (const [repo, path] of Object.entries(policy.workspaces ?? {})) {
    const refused = checkCwd(policy, path, deps.realpath);
    if (refused) deps.log(`RUNNER_WORKSPACE_SKIPPED ${repo} ${refused.rule} ${refused.detail}`);
    else workspaces.push({ repo, path });
  }
  const declared = new Set(Object.keys(policy.workspaces ?? {}).map((repo) => repo.toLowerCase()));
  const detected = policy.detectWorkspaces === false ? [] : scanCheckouts(policy.allowedRoots, deps.fs, deps.os)
    .filter((d) => !declared.has(d.repo.toLowerCase()));
  return { workspaces, detected };
};
