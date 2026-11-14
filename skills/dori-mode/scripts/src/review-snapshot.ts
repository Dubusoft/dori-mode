import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "./run.ts";

export type SnapshotInput = { readonly repoDir: string; readonly path: string; readonly headSha: string; readonly jobId: string };
export type SnapshotResult = { readonly ok: true; readonly path: string; readonly startedAt: number } | { readonly ok: false; readonly detail: string };
export type ScopeInput = { readonly path: string; readonly headSha: string; readonly since: number };
export type ScopeResult = { readonly ok: true } | { readonly ok: false; readonly code: "scope_violation"; readonly detail: string };
export type ReleaseResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

const SHA_RE = /^[0-9a-f]{40}$/;
/** The only paths omo's own config migration may write inside a review snapshot. */
const OMO_CONFIG_RE = /^\.omo\/omo\.jsonc(\.bak\..+)?$/;

/** `<worktreeRoot>/<repoName>-review-<jobId>`, with the job id reduced to `[A-Za-z0-9._-]`. */
export const reviewSnapshotPath = (worktreeRoot: string, repoName: string, jobId: string): string =>
  `${worktreeRoot.replace(/\/+$/, "")}/${repoName}-review-${jobId.replace(/[^A-Za-z0-9._-]/g, "_")}`;

const tail = (s: string): string => s.trim().split("\n").slice(-3).join(" | ");
const sameDir = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};

/** The `worktree list --porcelain` record for `path`, or undefined when the repo does not list it. */
const listedWorktree = async (run: Runner, repoDir: string, path: string): Promise<{ readonly locked: boolean } | undefined> => {
  const r = await run(["git", "-C", repoDir, "worktree", "list", "--porcelain"]);
  if (r.code !== 0) return undefined;
  for (const block of r.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const wt = lines.find((l) => l.startsWith("worktree "));
    if (wt !== undefined && sameDir(wt.slice("worktree ".length), path)) return { locked: lines.some((l) => l === "locked" || l.startsWith("locked ")) };
  }
  return undefined;
};

const headOf = async (run: Runner, path: string): Promise<string | undefined> => {
  const r = await run(["git", "-C", path, "rev-parse", "HEAD"]);
  return r.code === 0 ? r.out.trim() : undefined;
};

/**
 * Pins a detached, locked worktree of `repoDir` at `headSha` for the review lane to read.
 * `startedAt` is the ms stamp taken after the checkout, to hand to `checkReviewScope` as `since`.
 * Idempotent: a path that already is this repo's worktree at that head is locked (if needed) and reused.
 */
export const prepareReviewSnapshot = async (run: Runner, input: SnapshotInput): Promise<SnapshotResult> => {
  const { repoDir, path, headSha, jobId } = input;
  if (!SHA_RE.test(headSha)) return { ok: false, detail: `head sha is not 40 hex chars: ${headSha}` };
  const lock = ["git", "-C", repoDir, "worktree", "lock", "--reason", `review:${jobId}`, path];
  if (existsSync(path)) {
    const listed = await listedWorktree(run, repoDir, path);
    if (listed === undefined) return { ok: false, detail: `${path} exists and is not a worktree of ${repoDir}` };
    if ((await headOf(run, path)) !== headSha) return { ok: false, detail: `${path} is a worktree at a different head than ${headSha}` };
    if (!listed.locked) {
      const l = await run(lock);
      if (l.code !== 0) return { ok: false, detail: `worktree lock failed: ${tail(l.err)}` };
    }
    return { ok: true, path, startedAt: Date.now() };
  }
  const add = await run(["git", "-C", repoDir, "worktree", "add", "--detach", path, headSha]);
  if (add.code !== 0) return { ok: false, detail: `worktree add failed: ${tail(add.err)}` };
  const l = await run(lock);
  if (l.code !== 0) return { ok: false, detail: `worktree lock failed: ${tail(l.err)}` };
  const head = await headOf(run, path);
  if (head !== headSha) return { ok: false, detail: `snapshot HEAD is ${head ?? "unreadable"}, expected ${headSha}` };
  return { ok: true, path, startedAt: Date.now() };
};

/** Files (and symlinks) under `dir` other than the root `.git`, as paths relative to `root`, whose mtime is newer than `since`. */
const newerFiles = (root: string, dir: string, since: number, out: string[]): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = dir === root ? entry.name : `${dir.slice(root.length + 1)}/${entry.name}`;
    if (rel === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newerFiles(root, full, since, out);
    else if (lstatSync(full).mtimeMs > since) out.push(rel);
  }
};

const statusPath = (line: string): string => {
  const p = line.slice(3);
  const arrow = p.indexOf(" -> ");
  const raw = arrow >= 0 ? p.slice(arrow + 4) : p;
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
};

/**
 * Checks after a review that its snapshot is untouched: HEAD still `headSha`, a clean `git status`, and no file
 * modified after `since` (ignored files included). `.omo/omo.jsonc` and `.omo/omo.jsonc.bak.*` are exempt.
 */
export const checkReviewScope = async (run: Runner, input: ScopeInput): Promise<ScopeResult> => {
  const { path, headSha, since } = input;
  const bad = (detail: string): ScopeResult => ({ ok: false, code: "scope_violation", detail });
  const head = await headOf(run, path);
  if (head !== headSha) return bad(`HEAD is ${head ?? "unreadable"}, expected ${headSha}`);
  const st = await run(["git", "-C", path, "status", "--porcelain", "--untracked-files=all"]);
  if (st.code !== 0) return bad(`git status failed: ${tail(st.err)}`);
  const dirty = st.out.split("\n").filter((l) => l.length > 0 && !OMO_CONFIG_RE.test(statusPath(l)));
  if (dirty.length > 0) return bad(`worktree is not clean: ${dirty.slice(0, 5).join("; ")}`);
  const newer: string[] = [];
  try { newerFiles(path, path, since, newer); } catch (e) { return bad(`mtime scan failed: ${(e as Error).message}`); }
  const changed = newer.filter((p) => !OMO_CONFIG_RE.test(p));
  if (changed.length > 0) return bad(`files modified after the review started: ${changed.slice(0, 5).join(", ")}`);
  return { ok: true };
};

/** Unlocks and force-removes the snapshot worktree; a path that is already gone is ok. */
export const releaseReviewSnapshot = async (run: Runner, input: { readonly repoDir: string; readonly path: string }): Promise<ReleaseResult> => {
  const { repoDir, path } = input;
  if (!existsSync(path)) {
    await run(["git", "-C", repoDir, "worktree", "prune"]);
    return { ok: true };
  }
  await run(["git", "-C", repoDir, "worktree", "unlock", path]);
  const rm = await run(["git", "-C", repoDir, "worktree", "remove", "--force", path]);
  return rm.code === 0 ? { ok: true } : { ok: false, detail: `worktree remove failed: ${tail(rm.err)}` };
};
