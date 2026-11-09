import { existsSync } from "node:fs";
import { basename } from "node:path";

import type { Runner } from "../run.ts";
import type { CommandResults, LaneInspection, SupervisorCommandBodies } from "./protocol.ts";

/**
 * Runner-side git facts and git cleanup steps of a lane (design C7/C8, rows A17-A19): worktree discovery with each
 * worktree's dirty/ahead state, the checkout's toplevel/origin/branch, local and remote branch presence, and the
 * `lane.git` ops (`worktree-remove`, `branch-delete`, `remote-branch-delete`) with their output capped at 4 KiB.
 * Discovery and the unpushed-work reads are copied from done-flow.ts (`discoverWorktrees`, `unpushedWorkIn`).
 * None of these reach GitHub: `gh` stays on the lead.
 */

/** `lane.git` output (`out`, `err`) is capped at this many bytes each. */
export const GIT_OUTPUT_CAP = 4096;
/** A single git read; a `push` (remote delete) gets `GIT_PUSH_TIMEOUT_MS`. */
export const GIT_TIMEOUT_MS = 30_000;
export const GIT_PUSH_TIMEOUT_MS = 60_000;

/** `text` cut to at most `GIT_OUTPUT_CAP` UTF-8 bytes (never inside a character). */
export const capOutput = (text: string): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= GIT_OUTPUT_CAP) return text;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, GIT_OUTPUT_CAP)).replace(/\uFFFD+$/, "");
};

export type ListedWorktree = { readonly path: string; readonly branch?: string; readonly head?: string };

/** `git worktree list --porcelain` of `root`, or undefined when git cannot read it. */
export const listWorktrees = async (run: Runner, root: string): Promise<ListedWorktree[] | undefined> => {
  const r = await run(["git", "-C", root, "worktree", "list", "--porcelain"], { timeoutMs: GIT_TIMEOUT_MS });
  if (r.code !== 0) return undefined;
  const out: { path: string; branch?: string; head?: string }[] = [];
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) out.push({ path: line.slice(9) });
    const last = out.at(-1);
    if (!last) continue;
    if (line.startsWith("HEAD ")) last.head = line.slice(5);
    else if (line.startsWith("branch ")) last.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return out;
};

/**
 * The worktrees of lane `key`: in each root (the lane's cwd first, then `roots`), every linked worktree other than the
 * root itself whose branch or directory name is the key or starts with `<key>-`. Unreadable roots are skipped.
 */
export const discoverWorktrees = async (run: Runner, key: string, roots: readonly string[]): Promise<ListedWorktree[]> => {
  const ours = (name: string): boolean => name === key || name.startsWith(`${key}-`);
  const found = new Map<string, ListedWorktree>();
  for (const root of new Set(roots.filter(Boolean))) {
    for (const wt of (await listWorktrees(run, root)) ?? []) {
      if (wt.path === root || !wt.branch) continue;
      if ((ours(wt.branch.split("/").pop() ?? "") || ours(basename(wt.path))) && !found.has(wt.path)) found.set(wt.path, wt);
    }
  }
  return [...found.values()];
};

export type WorktreeFacts = LaneInspection extends { readonly git?: infer G } ? G extends { readonly worktrees: readonly (infer W)[] } ? W : never : never;

/**
 * One worktree's state: `dirty` (tracked changes or untracked files, gitignored ones excluded: a close would delete
 * them with the worktree) and `ahead` (commits on HEAD that no remote has). A missing worktree is `exists: false`; an
 * unreadable one carries `error`.
 */
export const worktreeState = async (run: Runner, wt: ListedWorktree, exists: (path: string) => boolean): Promise<WorktreeFacts> => {
  const base = { path: wt.path, ...(wt.branch ? { branch: wt.branch } : {}), ...(wt.head ? { head: wt.head } : {}) };
  if (!exists(wt.path)) return { ...base, exists: false };
  const dirty = await run(["git", "-C", wt.path, "status", "--porcelain", "--untracked-files=normal"], { timeoutMs: GIT_TIMEOUT_MS });
  const ahead = await run(["git", "-C", wt.path, "rev-list", "--count", "HEAD", "--not", "--remotes"], { timeoutMs: GIT_TIMEOUT_MS });
  const count = Number(ahead.out.trim());
  if (dirty.code !== 0 || ahead.code !== 0 || !Number.isSafeInteger(count)) {
    const why = (dirty.code !== 0 ? dirty.err || dirty.out : ahead.err || ahead.out).trim().slice(0, 160) || "git state unreadable";
    return { ...base, exists: true, error: why };
  }
  return { ...base, exists: true, dirty: dirty.out.trim() !== "", ahead: count };
};

const gitLine = async (run: Runner, cwd: string, args: readonly string[]): Promise<string | undefined> => {
  const r = await run(["git", "-C", cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  const out = r.out.trim();
  return r.code === 0 && out ? out : undefined;
};

/** A branch name git would take as a name, not as an option or a range. */
const plainRef = (name: string): boolean => name.length > 0 && !name.startsWith("-") && !/[\s~^:?*[\\]|\.\.|@\{/.test(name);

/**
 * Whether each branch exists locally (`refs/heads/<b>` in `cwd`) and on `origin` (`git ls-remote --heads`). A branch
 * name that is not a plain ref reads absent on both sides. Only `rev-parse --verify --quiet`'s silent exit 1 (no such
 * ref) is local absence; any other failed read, local or remote, leaves the branch out of the answer: unknown, which the
 * supervisor keeps (never "absent", so never "already gone" or past the remote-tip gate).
 */
export const branchPresence = async (run: Runner, cwd: string, branches: readonly string[]): Promise<Record<string, { local: boolean; remote: boolean }>> => {
  const out: Record<string, { local: boolean; remote: boolean }> = {};
  for (const b of branches) {
    if (!plainRef(b)) { out[b] = { local: false, remote: false }; continue; }
    const local = await run(["git", "-C", cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { timeoutMs: GIT_TIMEOUT_MS });
    const missing = local.code === 1 && !local.timedOut && local.err.trim() === "";
    if (local.code !== 0 && !missing) continue;
    const remote = await run(["git", "-C", cwd, "ls-remote", "--heads", "origin", `refs/heads/${b}`], { timeoutMs: GIT_TIMEOUT_MS });
    if (remote.code !== 0) continue;
    out[b] = { local: local.code === 0, remote: remote.out.trim() !== "" };
  }
  return out;
};

export type GitFactsInput = {
  readonly key: string;
  /** The lane's cwd when it exists on this host; its toplevel/origin/branch are read there and it is the first root. */
  readonly cwd?: string;
  readonly roots?: readonly string[];
  readonly branches?: readonly string[];
  readonly exists?: (path: string) => boolean;
};

/** The `git` section of a `q.lane.inspect` answer. */
export const gitFacts = async (run: Runner, input: GitFactsInput): Promise<NonNullable<LaneInspection["git"]>> => {
  const exists = input.exists ?? existsSync;
  const roots = [...(input.cwd ? [input.cwd] : []), ...(input.roots ?? [])];
  const listed = await discoverWorktrees(run, input.key, roots);
  const worktrees: WorktreeFacts[] = [];
  for (const wt of listed) worktrees.push(await worktreeState(run, wt, exists));
  const cwd = input.cwd;
  const toplevel = cwd ? await gitLine(run, cwd, ["rev-parse", "--show-toplevel"]) : undefined;
  const origin = cwd ? await gitLine(run, cwd, ["remote", "get-url", "origin"]) : undefined;
  const branch = cwd ? await gitLine(run, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]) : undefined;
  const where = cwd ?? input.roots?.[0];
  const branches = input.branches?.length && where ? await branchPresence(run, where, input.branches) : undefined;
  return {
    ...(toplevel ? { toplevel } : {}), ...(origin ? { origin } : {}), ...(branch ? { branch } : {}),
    worktrees, ...(branches ? { branches } : {}),
  };
};

/** A `lane.git` body the runner cannot run as given. */
export class LaneGitError extends Error {
  constructor(detail: string) {
    super(`RUNNER_LANE_GIT_INVALID ${detail}`);
    this.name = "LaneGitError";
  }
}

type GitBody = Omit<SupervisorCommandBodies["lane.git"], "cmdId">;

/** A full commit id (SHA-1 or SHA-256 hex). */
const fullSha = (sha: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha);

/**
 * The argv of one `lane.git` op, run in `root`. Throws `LaneGitError` for a missing or option-like field. A branch
 * delete with `sha` is branch-cleanup.ts's compare-and-delete: `update-ref -d refs/heads/<branch> <sha>` locally and
 * `push --force-with-lease=refs/heads/<branch>:<sha> <remote> :refs/heads/<branch>` remotely, so a branch that moved
 * off `sha` is kept; without `sha` the delete is unconditional.
 */
export const gitOpArgv = (body: GitBody): string[] => {
  const sha = (): string | undefined => {
    if (body.sha === undefined) return undefined;
    if (!fullSha(body.sha)) throw new LaneGitError(`sha ${JSON.stringify(body.sha)} is not a full commit id`);
    return body.sha;
  };
  const need = (field: "path" | "branch" | "remote" | "ref"): string => {
    const value = body[field];
    if (!value) throw new LaneGitError(`${body.op} needs ${field}`);
    if (value.startsWith("-")) throw new LaneGitError(`${field} ${JSON.stringify(value)} looks like an option`);
    if (field !== "path" && !plainRef(value)) throw new LaneGitError(`${field} ${JSON.stringify(value)} is not a plain name`);
    return value;
  };
  switch (body.op) {
    case "fetch-branch": {
      const remote = need("remote");
      const branch = need("branch");
      return ["git", "-C", body.root, "fetch", "--end-of-options", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`];
    }
    case "worktree-add": return ["git", "-C", body.root, "worktree", "add", "--detach", need("path"), need("ref")];
    case "worktree-remove": return ["git", "-C", body.root, "worktree", "remove", need("path")];
    case "branch-delete": {
      const branch = need("branch");
      const at = sha();
      return at ? ["git", "-C", body.root, "update-ref", "-d", `refs/heads/${branch}`, at] : ["git", "-C", body.root, "branch", "-D", branch];
    }
    case "remote-branch-delete": {
      const branch = need("branch");
      const remote = need("remote");
      const at = sha();
      const ref = `refs/heads/${branch}`;
      return at
        ? ["git", "-C", body.root, "push", `--force-with-lease=${ref}:${at}`, remote, `:${ref}`]
        : ["git", "-C", body.root, "push", remote, `:${ref}`];
    }
  }
};

/** The refusal prefix of a branch delete the runner did not run (the branch is checked out, or that cannot be read). */
export const LANE_GIT_REFUSED = "RUNNER_LANE_GIT_REFUSED";

/**
 * Why a branch delete must not run, or undefined: the branch is checked out in any worktree of `root`'s repository (the
 * main checkout and unrelated worktrees included, not only the lane's), or that list cannot be read.
 */
const branchHeld = async (run: Runner, root: string, branch: string): Promise<string | undefined> => {
  const listed = await listWorktrees(run, root);
  if (!listed) return `${LANE_GIT_REFUSED} cannot read the worktree list of ${root}`;
  const holder = listed.find((wt) => wt.branch === branch);
  return holder ? `${LANE_GIT_REFUSED} branch ${branch} is checked out in ${holder.path}` : undefined;
};

/**
 * Runs one `lane.git` op and returns its exit code and capped output as data: a git that refuses (a dirty worktree,
 * an unknown branch) is `code != 0`, not a throw, so the supervisor's read-back decides. Only an unusable body throws.
 * A branch delete (local or remote) first reads the repository's complete worktree list and is refused, as data, while
 * the branch is checked out anywhere or the list is unreadable.
 */
export const laneGit = async (run: Runner, body: GitBody): Promise<CommandResults["lane.git"]> => {
  const argv = gitOpArgv(body);
  if ((body.op === "branch-delete" || body.op === "remote-branch-delete") && body.branch) {
    const held = await branchHeld(run, body.root, body.branch);
    if (held) return { code: 1, out: "", err: capOutput(held) };
  }
  const r = await run(argv, { timeoutMs: body.op === "remote-branch-delete" ? GIT_PUSH_TIMEOUT_MS : GIT_TIMEOUT_MS });
  return { code: r.code, out: capOutput(r.out), err: capOutput(r.err) };
};

/** The `lane.git` effect output: the detail line for the command record, with the structured result. */
export const laneGitEffect = async (run: Runner, body: GitBody): Promise<{ readonly detail: string; readonly result: CommandResults["lane.git"] }> => {
  const result = await laneGit(run, body);
  const target = body.op === "worktree-remove" ? body.path : body.branch;
  return { detail: `git ${body.op} ${target ?? ""} exit ${result.code}`.replace(/\s+/g, " "), result };
};
