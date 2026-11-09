import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { readRunnerRows, RunnerHub } from "../src/runner/hub.ts";
import { localPolicy, localRunnerPolicy } from "../src/runner/local-policy.ts";
import { parsePolicy, POLICY_FILE } from "../src/runner/policy.ts";
import { PROTO, runnerControl, validateFrame } from "../src/runner/protocol.ts";
import { repoFromRemote, workspaceReport } from "../src/runner/workspaces.ts";

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
