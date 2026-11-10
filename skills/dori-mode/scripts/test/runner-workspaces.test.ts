import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { readRunnerRows, RunnerHub } from "../src/runner/hub.ts";
import { localPolicy, localRunnerPolicy } from "../src/runner/local-policy.ts";
import { effectiveWorktreeRoot, parsePolicy, POLICY_FILE } from "../src/runner/policy.ts";
import { PROTO, runnerControl, validateFrame } from "../src/runner/protocol.ts";
import { discoverRepos, repoFromRemote, type ScanFs, workspaceReport } from "../src/runner/workspaces.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "runner-workspaces-")));
  dirs.push(dir);
  return dir;
};
const checkout = (path: string, origin?: string): string => {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "config"), `[core]\n\tbare = false\n${origin ? `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ""}`);
  return path;
};

test("parsePolicy reads workspaces as owner/repo -> absolute path, expanding ~, and refuses anything else", () => {
  const p = parsePolicy({ workspaces: { "acme/app": "~/work/repos/app", "acme/lib": "/srv/lib" }, detectWorkspaces: false }, "/Users/me");
  expect(p.workspaces).toEqual({ "acme/app": "/Users/me/work/repos/app", "acme/lib": "/srv/lib" });
  expect(p.detectWorkspaces).toBe(false);
  expect(parsePolicy({})).not.toHaveProperty("workspaces");
  expect(() => parsePolicy({ workspaces: { app: "/srv/app" } })).toThrow("workspaces key app must be owner/repo");
  expect(() => parsePolicy({ workspaces: { "acme/app": "relative/app" } })).toThrow("workspaces.acme/app must be an absolute path");
  expect(() => parsePolicy({ workspaces: ["acme/app"] })).toThrow("workspaces must be an object");
  expect(() => parsePolicy({ detectWorkspaces: "no" })).toThrow("detectWorkspaces must be true|false");
});

test("repoFromRemote reads ssh, https and ssh:// remotes", () => {
  expect(repoFromRemote("git@github.com:acme/app.git")).toBe("acme/app");
  expect(repoFromRemote("https://github.com/acme/app")).toBe("acme/app");
  expect(repoFromRemote("https://x-token@github.com/acme/my.repo.git/")).toBe("acme/my.repo");
  expect(repoFromRemote("ssh://git@host:22/acme/app.git")).toBe("acme/app");
  expect(repoFromRemote("app")).toBeUndefined();
});

test("workspaceReport declares paths under allowedRoots, skips the rest, and detects only undeclared checkouts", () => {
  const root = scratch();
  const outside = scratch();
  checkout(join(root, "repos", "app"), "git@github.com:acme/app.git");
  checkout(join(root, "repos", "lib"), "https://github.com/acme/lib");
  checkout(join(root, "repos", "lib", "nested"), "git@github.com:acme/nested.git");
  checkout(join(root, "repos", "noorigin"));
  checkout(join(root, ".hidden", "secret"), "git@github.com:acme/secret.git");
  checkout(join(root, "a", "b", "c", "deep"), "git@github.com:acme/deep.git");
  // A worktree has a .git file, not a directory: not a checkout of its own.
  mkdirSync(join(root, "wt"), { recursive: true });
  writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere\n");
  const logs: string[] = [];
  const policy = parsePolicy({
    allowedRoots: [root],
    workspaces: { "ACME/App": join(root, "repos", "app"), "acme/gone": join(root, "repos", "gone"), "acme/out": outside },
  });
  const report = workspaceReport(policy, { realpath: realpathSync, log: (l) => { logs.push(l); }, os: "linux" });
  expect(report.workspaces).toEqual([{ repo: "ACME/App", path: join(root, "repos", "app") }]);
  expect(logs).toEqual([
    `RUNNER_WORKSPACE_SKIPPED acme/gone cwd-missing ${join(root, "repos", "gone")}`,
    `RUNNER_WORKSPACE_SKIPPED acme/out cwd-outside-roots ${outside}`,
  ]);
  expect(report.detected).toEqual([{ repo: "acme/lib", path: join(root, "repos", "lib") }]);
  expect(workspaceReport({ ...policy, detectWorkspaces: false }, { realpath: realpathSync, log: () => {}, os: "linux" }).detected).toEqual([]);
});

test("a local runner-config.json with only placement keys layers them on the derived local policy; any other key wins whole", () => {
  const dir = scratch();
  const cfg = { ...defaultConfig("/home/u"), defaultCwd: "/data/dori" };
  const env = { home: "/home/u", tmp: "/tmp" };
  writeFileSync(join(dir, POLICY_FILE), JSON.stringify({ workspaces: { "acme/app": "~/repos/app" }, detectWorkspaces: false }));
  expect(localRunnerPolicy(dir, cfg, env)).toEqual({ ...localPolicy(cfg, env), workspaces: { "acme/app": "/home/u/repos/app" }, detectWorkspaces: false });
  writeFileSync(join(dir, POLICY_FILE), JSON.stringify({ allowedRoots: ["/srv"], workspaces: { "acme/app": "/srv/app" } }));
  const whole = localRunnerPolicy(dir, cfg, env);
  expect(whole.agents).toEqual({});
  expect(whole.allowedRoots).toEqual(["/srv"]);
});

test("the hub stores a hello's workspaces and keeps them across a hello that carries none", () => {
  const dir = scratch();
  const hub = new RunnerHub({ stateDir: dir, commit: () => true, now: () => 1000, monotonic: () => 1000, epoch: 1 });
  const head = { runner: "mini", gen: 1, epoch: 0 };
  const body = { proto: PROTO, gen: 1, label: "mini", hostId: "h", cmdAck: 0 };
  const hello = runnerControl(head, "hello", { ...body, workspaces: [{ repo: "acme/app", path: "/w/app" }], detected: [{ repo: "acme/lib", path: "/w/lib" }] });
  expect(validateFrame(JSON.parse(JSON.stringify(hello)), "runner").type).toBe("hello");
  expect(hub.hello(hello).ok).toBe(true);
  const want = { declared: [{ repo: "acme/app", path: "/w/app" }], detected: [{ repo: "acme/lib", path: "/w/lib" }] };
  expect(hub.runner("mini")?.workspaces).toEqual(want);
  expect(hub.hello(runnerControl({ ...head, gen: 2 }, "hello", { ...body, gen: 2 })).ok).toBe(true);
  expect(hub.runner("mini")?.workspaces).toEqual(want);
  hub.close();
  expect(readRunnerRows(dir).find((r) => r.label === "mini")?.workspaces).toEqual(want);
});

test("parsePolicy reads reposRoot and worktreeRoot as absolute paths, expanding ~; effectiveWorktreeRoot defaults under reposRoot", () => {
  const p = parsePolicy({ reposRoot: "~/repos", worktreeRoot: "/srv/wt" }, "/Users/me");
  expect(p).toMatchObject({ reposRoot: "/Users/me/repos", worktreeRoot: "/srv/wt" });
  expect(parsePolicy({})).not.toHaveProperty("reposRoot");
  expect(parsePolicy({})).not.toHaveProperty("worktreeRoot");
  for (const key of ["reposRoot", "worktreeRoot"]) {
    for (const bad of ["repos", "~user/repos", 3]) expect(() => parsePolicy({ [key]: bad }, "/Users/me")).toThrow(`runner-config: ${key} must be an absolute path or start with ~/`);
  }
  expect(effectiveWorktreeRoot(p)).toBe("/srv/wt");
  expect(effectiveWorktreeRoot({ reposRoot: "/data/repos" })).toBe("/data/repos/worktrees");
  expect(effectiveWorktreeRoot({})).toBeUndefined();
});

test("discoverRepos keys each checkout directly under reposRoot by origin, skipping worktrees, the worktree root, dot folders and repeats", () => {
  const origin = (url: string) => `[remote "origin"]\n\turl = ${url}\n`;
  const tree: Record<string, { dirs: string[]; files?: string[]; config?: string }> = {
    "/r": { dirs: ["zz-dup", "app", "wt", "worktrees", ".hidden", "noorigin", "plain"], files: ["notes.txt"] },
    "/r/app/.git": { dirs: [], config: origin("git@github.com:acme/app.git") },
    "/r/zz-dup/.git": { dirs: [], config: origin("https://github.com/ACME/App") },
    "/r/worktrees/.git": { dirs: [], config: origin("git@github.com:acme/wt.git") },
    "/r/.hidden/.git": { dirs: [], config: origin("git@github.com:acme/hidden.git") },
    "/r/noorigin/.git": { dirs: [], config: "[core]\n" },
  };
  const fs: ScanFs = {
    readdir: (dir) => {
      const node = tree[dir];
      if (!node) throw new Error(`ENOENT ${dir}`);
      return [...node.dirs.map((name) => ({ name, dir: true })), ...(node.files ?? []).map((name) => ({ name, dir: false }))];
    },
    // /r/wt holds a .git file (a linked worktree), so its .git is not a directory.
    isDir: (path) => path in tree,
    readFile: (path) => { const c = tree[path.replace(/\/config$/, "")]?.config; if (c === undefined) throw new Error(`ENOENT ${path}`); return c; },
  };
  expect(discoverRepos("/r", "/r/worktrees", fs)).toEqual({
    repos: [{ repo: "acme/app", path: "/r/app" }],
    duplicates: [{ repo: "ACME/App", kept: "/r/app", skipped: "/r/zz-dup" }],
  });
  expect(discoverRepos("/r", undefined, fs).repos).toEqual([{ repo: "acme/app", path: "/r/app" }, { repo: "acme/wt", path: "/r/worktrees" }]);
  expect(discoverRepos("/missing", undefined, fs)).toEqual({ repos: [], duplicates: [] });
});

test("workspaceReport declares discovered repos, lets a workspaces override win, and detects neither declared repos nor worktree-root checkouts", () => {
  const root = scratch();
  const repos = join(root, "repos");
  checkout(join(repos, "app"), "git@github.com:acme/app.git");
  checkout(join(repos, "app-copy"), "git@github.com:acme/app.git");
  checkout(join(repos, "lib"), "git@github.com:acme/lib.git");
  checkout(join(root, "other", "lib"), "git@github.com:acme/lib.git");
  checkout(join(root, "other", "extra"), "git@github.com:acme/extra.git");
  checkout(join(repos, "worktrees", "wtrepo"), "git@github.com:acme/wtrepo.git");
  mkdirSync(join(repos, "wt"), { recursive: true });
  writeFileSync(join(repos, "wt", ".git"), "gitdir: /elsewhere\n");
  const logs: string[] = [];
  const policy = parsePolicy({ allowedRoots: [root], reposRoot: repos, workspaces: { "ACME/Lib": join(root, "other", "lib") } });
  const report = workspaceReport(policy, { realpath: realpathSync, log: (l) => { logs.push(l); }, os: "linux" });
  expect(report.workspaces).toEqual([{ repo: "acme/app", path: join(repos, "app") }, { repo: "ACME/Lib", path: join(root, "other", "lib") }]);
  expect(logs).toEqual([`RUNNER_WORKSPACE_DUPLICATE acme/app ${join(repos, "app")} ${join(repos, "app-copy")}`]);
  expect(report.detected).toEqual([{ repo: "acme/extra", path: join(root, "other", "extra") }]);
  expect(report.worktreeRoot).toBe(join(repos, "worktrees"));
  // A discovered path outside allowedRoots is skipped like a declared one; no reposRoot and no worktreeRoot: no worktreeRoot field.
  const narrow = workspaceReport({ ...policy, allowedRoots: [join(root, "other")] }, { realpath: realpathSync, log: (l) => { logs.push(l); }, os: "linux" });
  expect(narrow.workspaces).toEqual([{ repo: "ACME/Lib", path: join(root, "other", "lib") }]);
  expect(logs).toContain(`RUNNER_WORKSPACE_SKIPPED acme/app cwd-outside-roots ${join(repos, "app")}`);
  expect(workspaceReport(parsePolicy({ allowedRoots: [root] }), { realpath: realpathSync, log: () => {}, os: "linux" })).not.toHaveProperty("worktreeRoot");
});
