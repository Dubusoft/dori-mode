import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Ran, run as realRun, type Runner } from "../src/run.ts";
import {
  branchPresence, capOutput, discoverWorktrees, GIT_OUTPUT_CAP, gitFacts, gitOpArgv, LaneGitError, laneGit, laneGitEffect, listWorktrees,
} from "../src/runner/lane-git.ts";

type Script = (argv: readonly string[]) => Ran | undefined;
const ok = (out = ""): Ran => ({ code: 0, out, err: "" });

const recording = (script: Script): { run: Runner; calls: string[][] } => {
  const calls: string[][] = [];
  return { calls, run: async (argv) => { calls.push([...argv]); return script(argv) ?? { code: 1, out: "", err: `unexpected ${argv.join(" ")}` }; } };
};

const PORCELAIN = [
  "worktree /repo", "HEAD 1111", "branch refs/heads/main", "",
  "worktree /repo/.wt/demo-lane", "HEAD 2222", "branch refs/heads/demo-lane", "",
  "worktree /repo/.wt/demo-lane-2", "HEAD 3333", "branch refs/heads/feature/demo-lane-2", "",
  "worktree /repo/.wt/other", "HEAD 4444", "branch refs/heads/other", "",
  "worktree /repo/.wt/detached", "HEAD 5555", "detached", "",
].join("\n");

const repo: Script = (argv) => {
  const a = argv.join(" ");
  if (a === "git -C /repo worktree list --porcelain") return ok(PORCELAIN);
  if (a.startsWith("git -C /repo/.wt/demo-lane status")) return ok(" M file.ts\n");
  if (a.startsWith("git -C /repo/.wt/demo-lane rev-list")) return ok("2\n");
  if (a.startsWith("git -C /repo/.wt/demo-lane-2 status")) return ok("");
  if (a.startsWith("git -C /repo/.wt/demo-lane-2 rev-list")) return { code: 128, out: "", err: "fatal: bad HEAD" };
  if (a === "git -C /repo rev-parse --show-toplevel") return ok("/repo\n");
  if (a === "git -C /repo remote get-url origin") return ok("git@github.com:o/r.git\n");
  if (a === "git -C /repo symbolic-ref --quiet --short HEAD") return ok("main\n");
  if (a === "git -C /repo rev-parse --verify --quiet refs/heads/demo-lane") return ok("2222\n");
  if (a === "git -C /repo rev-parse --verify --quiet refs/heads/gone") return { code: 1, out: "", err: "" };
  if (a === "git -C /repo ls-remote --heads origin refs/heads/demo-lane") return ok("2222\trefs/heads/demo-lane\n");
  if (a === "git -C /repo ls-remote --heads origin refs/heads/gone") return ok("");
  return undefined;
};

test("listWorktrees parses path, HEAD and branch", async () => {
  const { run } = recording(repo);
  const list = await listWorktrees(run, "/repo");
  expect(list?.[1]).toEqual({ path: "/repo/.wt/demo-lane", head: "2222", branch: "demo-lane" });
  expect(list?.[4]).toEqual({ path: "/repo/.wt/detached", head: "5555" });
  expect(await listWorktrees(recording(() => undefined).run, "/nope")).toBeUndefined();
});

test("discoverWorktrees finds the key's worktrees by branch or directory, never the root or others", async () => {
  const { run } = recording(repo);
  const found = await discoverWorktrees(run, "demo-lane", ["/repo", "/repo", "/unreadable"]);
  expect(found.map((w) => w.path)).toEqual(["/repo/.wt/demo-lane", "/repo/.wt/demo-lane-2"]);
});

test("gitFacts: dirty/ahead per worktree, an unreadable one carries error, a missing one exists:false", async () => {
  const { run } = recording(repo);
  const facts = await gitFacts(run, { key: "demo-lane", cwd: "/repo", branches: ["demo-lane", "gone"], exists: (p) => p !== "/repo/.wt/demo-lane-missing" });
  expect(facts).toEqual({
    toplevel: "/repo", origin: "git@github.com:o/r.git", branch: "main",
    worktrees: [
      { path: "/repo/.wt/demo-lane", branch: "demo-lane", head: "2222", exists: true, dirty: true, ahead: 2 },
      { path: "/repo/.wt/demo-lane-2", branch: "feature/demo-lane-2", head: "3333", exists: true, error: "fatal: bad HEAD" },
    ],
    branches: { "demo-lane": { local: true, remote: true }, gone: { local: false, remote: false } },
  });
  const gone = await gitFacts(run, { key: "demo-lane", roots: ["/repo"], exists: () => false });
  expect(gone.worktrees.every((w) => !w.exists && w.dirty === undefined)).toBe(true);
  expect(gone.toplevel).toBeUndefined();
});

test("branchPresence reads an option-like name as absent without running git", async () => {
  const { run, calls } = recording(repo);
  expect(await branchPresence(run, "/repo", ["--all"])).toEqual({ "--all": { local: false, remote: false } });
  expect(calls).toEqual([]);
});

test("gitOpArgv builds each op and refuses missing or option-like fields", () => {
  expect(gitOpArgv({ key: "k", op: "worktree-remove", root: "/repo", path: "/repo/.wt/k" })).toEqual(["git", "-C", "/repo", "worktree", "remove", "/repo/.wt/k"]);
  expect(gitOpArgv({ key: "k", op: "branch-delete", root: "/repo", branch: "k" })).toEqual(["git", "-C", "/repo", "branch", "-D", "k"]);
  expect(gitOpArgv({ key: "k", op: "remote-branch-delete", root: "/repo", branch: "k", remote: "origin" })).toEqual(["git", "-C", "/repo", "push", "origin", ":refs/heads/k"]);
  expect(() => gitOpArgv({ key: "k", op: "worktree-remove", root: "/repo" })).toThrow(LaneGitError);
  expect(() => gitOpArgv({ key: "k", op: "branch-delete", root: "/repo", branch: "--force" })).toThrow("looks like an option");
  expect(() => gitOpArgv({ key: "k", op: "remote-branch-delete", root: "/repo", branch: "k" })).toThrow("needs remote");
  expect(() => gitOpArgv({ key: "k", op: "branch-delete", root: "/repo", branch: "a..b" })).toThrow("not a plain name");
});

test("branch deletes with a sha compare and delete like branch-cleanup.ts; without one they stay unconditional", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  expect(gitOpArgv({ key: "k", op: "branch-delete", root: "/repo", branch: "k-fix", sha }))
    .toEqual(["git", "-C", "/repo", "update-ref", "-d", "refs/heads/k-fix", sha]);
  expect(gitOpArgv({ key: "k", op: "remote-branch-delete", root: "/repo", branch: "k-fix", remote: "origin", sha }))
    .toEqual(["git", "-C", "/repo", "push", `--force-with-lease=refs/heads/k-fix:${sha}`, "origin", ":refs/heads/k-fix"]);
  expect(gitOpArgv({ key: "k", op: "branch-delete", root: "/repo", branch: "k-fix" })).toEqual(["git", "-C", "/repo", "branch", "-D", "k-fix"]);
  expect(gitOpArgv({ key: "k", op: "remote-branch-delete", root: "/repo", branch: "k-fix", remote: "origin" }))
    .toEqual(["git", "-C", "/repo", "push", "origin", ":refs/heads/k-fix"]);
  // A short, option-like or non-hex sha is refused before git runs.
  for (const bad of ["0123abc", `--${sha}`, "z".repeat(40)]) {
    expect(() => gitOpArgv({ key: "k", op: "branch-delete", root: "/repo", branch: "k-fix", sha: bad })).toThrow("not a full commit id");
  }
  // A branch that moved off the sha: git refuses the compare-and-delete, which comes back as data for the read-back.
  const { run, calls } = recording((argv) => argv.includes("worktree")
    ? ok("worktree /repo\nHEAD 1111\nbranch refs/heads/main\n")
    : { code: 1, out: "", err: `error: cannot lock ref 'refs/heads/k-fix': is at 89ab but expected ${sha}` });
  const moved = await laneGit(run, { key: "k", op: "branch-delete", root: "/repo", branch: "k-fix", sha });
  expect(moved.code).toBe(1);
  expect(moved.err).toContain("expected");
  expect(calls).toEqual([["git", "-C", "/repo", "worktree", "list", "--porcelain"], ["git", "-C", "/repo", "update-ref", "-d", "refs/heads/k-fix", sha]]);
});

test("branchPresence reports a failed git read as unknown (omitted), never as absent; only rev-parse's silent exit 1 is absent", async () => {
  const denied: Ran = { code: 128, out: "", err: "fatal: permission denied" };
  const { run } = recording((argv) => {
    const a = argv.join(" ");
    if (a.endsWith("refs/heads/gone") && a.includes("rev-parse")) return { code: 1, out: "", err: "" };
    if (a.endsWith("refs/heads/gone")) return ok("");
    if (a.includes("rev-parse") && a.endsWith("refs/heads/local-err")) return denied;
    if (a.includes("rev-parse")) return ok("2222\n");
    if (a.includes("ls-remote") && a.endsWith("refs/heads/remote-err")) return denied;
    if (a.includes("ls-remote") && a.endsWith("refs/heads/remote-timeout")) return { code: 124, out: "", err: "timed out", timedOut: true };
    return ok("2222\trefs/heads/x\n");
  });
  expect(await branchPresence(run, "/repo", ["gone", "local-err", "remote-err", "remote-timeout", "here"])).toEqual({
    gone: { local: false, remote: false },
    here: { local: true, remote: true },
  });
});

const realGit = async (...args: string[]): Promise<string> => {
  const r = await realRun(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out.trim();
};

/** A bare origin holding main and feat-x, and a seed clone that pushed them; `holder` makes `repo` (a checkout with feat-x checked out somewhere). */
const heldBranch = async (holder: (dir: string, origin: string, repo: string) => Promise<string>) => {
  const dir = mkdtempSync(join(tmpdir(), "lane-git-held-"));
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  await realGit("init", "-q", "--bare", "-b", "main", origin);
  await realGit("clone", "-q", origin, seed);
  writeFileSync(join(seed, "a"), "a");
  await realGit("-C", seed, "add", "a");
  await realGit("-C", seed, "commit", "-q", "-m", "a");
  await realGit("-C", seed, "push", "-q", "origin", "HEAD:main", "HEAD:feat-x");
  const sha = await realGit("-C", seed, "rev-parse", "HEAD");
  const repo = join(dir, "repo");
  const at = await holder(dir, origin, repo);
  return { dir, repo, sha, at };
};

for (const [name, holder] of [
  ["the main checkout", async (_dir: string, origin: string, repo: string) => { await realGit("clone", "-q", "-b", "feat-x", origin, repo); return repo; }],
  ["an unrelated worktree", async (dir: string, origin: string, repo: string) => {
    await realGit("clone", "-q", origin, repo);
    await realGit("-C", repo, "branch", "-q", "feat-x", "origin/feat-x");
    const other = join(dir, "unrelated");
    await realGit("-C", repo, "worktree", "add", "-q", other, "feat-x");
    return other;
  }],
] as const) {
  test(`a branch checked out in ${name} is never deleted, locally or on the remote, even at the expected sha`, async () => {
    const { dir, repo, sha, at } = await heldBranch(holder);
    try {
      const local = await laneGit(realRun, { key: "k", op: "branch-delete", root: repo, branch: "feat-x", sha });
      expect(local.code).not.toBe(0);
      expect(local.err).toContain(`RUNNER_LANE_GIT_REFUSED branch feat-x is checked out in ${at}`);
      const remote = await laneGit(realRun, { key: "k", op: "remote-branch-delete", root: repo, branch: "feat-x", remote: "origin", sha });
      expect(remote.code).not.toBe(0);
      expect(remote.err).toContain("RUNNER_LANE_GIT_REFUSED");
      expect(await realGit("-C", repo, "rev-parse", "--verify", "refs/heads/feat-x")).toBe(sha);
      expect(await realGit("-C", repo, "ls-remote", "origin", "refs/heads/feat-x")).toStartWith(sha);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
}

test("a branch delete refuses when the worktree list cannot be read, without running the delete", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const { run, calls } = recording((argv) => argv.includes("worktree") ? { code: 128, out: "", err: "fatal: permission denied" } : ok());
  for (const op of ["branch-delete", "remote-branch-delete"] as const) {
    const r = await laneGit(run, { key: "k", op, root: "/repo", branch: "k-fix", remote: "origin", sha });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("RUNNER_LANE_GIT_REFUSED cannot read the worktree list of /repo");
  }
  expect(calls.every((c) => c.includes("worktree"))).toBe(true);
});

test("laneGit returns a git refusal as data with output capped at 4 KiB", async () => {
  const big = "x".repeat(GIT_OUTPUT_CAP * 2);
  const { run, calls } = recording(() => ({ code: 128, out: big, err: `fatal: contains modified files ${big}` }));
  const r = await laneGit(run, { key: "k", op: "worktree-remove", root: "/repo", path: "/repo/.wt/k" });
  expect(r.code).toBe(128);
  expect(Buffer.byteLength(r.out)).toBe(GIT_OUTPUT_CAP);
  expect(Buffer.byteLength(r.err)).toBeLessThanOrEqual(GIT_OUTPUT_CAP);
  expect(r.err.startsWith("fatal: contains modified files")).toBe(true);
  expect(calls).toEqual([["git", "-C", "/repo", "worktree", "remove", "/repo/.wt/k"]]);
  const effect = await laneGitEffect(recording(() => ok("")).run, { key: "k", op: "branch-delete", root: "/repo", branch: "k" });
  expect(effect).toEqual({ detail: "git branch-delete k exit 0", result: { code: 0, out: "", err: "" } });
});

test("capOutput never cuts inside a multi-byte character", () => {
  const s = "é".repeat(GIT_OUTPUT_CAP);
  const cut = capOutput(s);
  expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(GIT_OUTPUT_CAP);
  expect(cut).toBe("é".repeat(GIT_OUTPUT_CAP / 2));
  expect(capOutput("short")).toBe("short");
});

test("fetch-branch and worktree-add build their argv, refuse option-shaped fields and cap output at 4 KiB", async () => {
  const fetch = { key: "k", op: "fetch-branch" as const, root: "/repo", remote: "origin", branch: "feat/x" };
  const add = { key: "k", op: "worktree-add" as const, root: "/repo", path: "/wt/app/k", ref: "refs/remotes/origin/feat/x" };
  const big = "x".repeat(GIT_OUTPUT_CAP * 2);
  const { run, calls } = recording(() => ({ code: 128, out: big, err: big }));
  const fetched = await laneGit(run, fetch);
  const added = await laneGit(run, add);
  expect(calls).toEqual([
    ["git", "-C", "/repo", "fetch", "--end-of-options", "origin", "+refs/heads/feat/x:refs/remotes/origin/feat/x"],
    ["git", "-C", "/repo", "worktree", "add", "--detach", "/wt/app/k", "refs/remotes/origin/feat/x"],
  ]);
  for (const r of [fetched, added]) {
    expect(r.code).toBe(128);
    expect(Buffer.byteLength(r.out)).toBeLessThanOrEqual(GIT_OUTPUT_CAP);
    expect(Buffer.byteLength(r.err)).toBeLessThanOrEqual(GIT_OUTPUT_CAP);
  }
  expect(() => gitOpArgv({ ...fetch, branch: "--upload-pack=x" })).toThrow("RUNNER_LANE_GIT_INVALID");
  expect(() => gitOpArgv({ ...fetch, remote: "--upload-pack=x" })).toThrow("looks like an option");
  expect(() => gitOpArgv({ ...fetch, remote: undefined })).toThrow("needs remote");
  expect(() => gitOpArgv({ ...add, path: "-f" })).toThrow("looks like an option");
  expect(() => gitOpArgv({ ...add, ref: "--orphan" })).toThrow("looks like an option");
  expect(() => gitOpArgv({ ...add, ref: undefined })).toThrow("needs ref");
});
