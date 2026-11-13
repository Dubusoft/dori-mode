import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import type { Ran } from "../src/run.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { localPolicy, localRunnerPolicy } from "../src/runner/local-policy.ts";
import { checkCommand, POLICY_FILE } from "../src/runner/policy.ts";
import { workspaceReport } from "../src/runner/workspaces.ts";
import { fakeClock } from "./fakes.ts";

const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "runner-local-policy-")));
  dirs.push(dir);
  return dir;
};

test("localPolicy derives default and sandboxed profiles from agentCommand, laneThinking and laneSandbox", () => {
  const cfg = { ...defaultConfig("/home/u"), leadCwd: "/data/repos/app", worktreeRoot: "/data/repos/worktrees", laneThinking: "high", laneSandbox: { command: ["lane-sandbox", "--strict"] } };
  const policy = localPolicy(cfg, { home: "/home/u", tmp: "/tmp" });
  expect(policy.agents.default).toEqual(["omo", "--model", "{model}", "--thinking", "high", "{prompt}"]);
  expect(policy.agents.sandboxed).toEqual(["lane-sandbox", "--strict", "omo", "--model", "{model}", "--thinking", "high", "{prompt}"]);
  expect(policy.allowedRoots).toEqual(["/home/u", "/tmp", "/data/repos", "/data/repos/worktrees"]);
  expect(policy).toMatchObject({ sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--strict", "--check"], worktreeRoot: "/data/repos/worktrees" });
  expect(policy.guard).toBeUndefined();
  expect(policy.heavyKill).toBeUndefined();
});

test("localPolicy: no laneSandbox uses lane-sandbox; a template without --model/--thinking keeps its argv; roots are not repeated", () => {
  const cfg = { ...defaultConfig("/home/u"), agentCommand: ["claude", "{prompt}"], leadCwd: "/home/u/repo", worktreeRoot: "", laneSandbox: undefined };
  const policy = localPolicy(cfg, { home: "/home/u", tmp: "/home/u" });
  expect(policy.agents.default).toEqual(["claude", "{prompt}"]);
  expect(policy.agents.sandboxed).toEqual(["lane-sandbox", "claude", "{prompt}"]);
  expect(policy.allowedRoots).toEqual(["/home/u"]);
  expect(policy).not.toHaveProperty("worktreeRoot");
});

test("the local runner's hello reports config.worktreeRoot as its worktree root", () => {
  const home = scratch();
  const report = workspaceReport(localPolicy({ ...defaultConfig(home), leadCwd: join(home, "dori"), worktreeRoot: join(home, "wt") }, { home, tmp: home }), { realpath: realpathSync, log: () => {}, os: "linux" });
  expect(report.worktreeRoot).toBe(join(home, "wt"));
  expect(workspaceReport(localPolicy({ ...defaultConfig(home), leadCwd: join(home, "dori"), worktreeRoot: "" }, { home, tmp: home }), { realpath: realpathSync, log: () => {}, os: "linux" }))
    .not.toHaveProperty("worktreeRoot");
});

test("acceptance: a local RunnerLanes over localPolicy(cfg) starts a lane with the sandboxed profile; the policy admits the cwd and refuses one outside the roots", async () => {
  const home = scratch();
  const repo = join(home, "repos", "app");
  mkdirSync(repo, { recursive: true });
  const outside = scratch();
  const cfg = { ...defaultConfig(home), leadCwd: repo, worktreeRoot: "", laneThinking: "medium" };
  const policy = localPolicy(cfg, { home, tmp: home });
  const start = {
    cmdId: "lane-start:lane-a:1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: repo, agentProfile: "sandboxed",
    mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0, files: FILES, keywords: "ulw set goal and work",
  };
  const frame = (body: object) => ({ v: 1, runner: "local", gen: 1, epoch: 1, cmdSeq: 1, type: "lane.start", body });
  expect(checkCommand(policy, frame(start), realpathSync).ok).toBe(true);
  expect(checkCommand(policy, frame({ ...start, cwd: outside }), realpathSync)).toMatchObject({ ok: false, rule: "cwd-outside-roots" });

  const runnerDir = join(home, ".dori", "runner");
  mkdirSync(runnerDir, { recursive: true, mode: 0o700 });
  const calls: string[][] = [];
  const lanes = new RunnerLanes({
    instance: async () => "server-1",
    runnerDir, clock: fakeClock(0), policy, token: () => "tok", publish: () => {}, startup: async () => ({ verdict: "ok", detail: "ready" }),
    run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "lane-sandbox" && argv.includes("--check")) return { code: 0, out: "DORI_LANE_FILES=1\n", err: "" } as Ran;
      if (argv.slice(0, 3).join(" ") === "herdr tab create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }), err: "" } as Ran;
      return { code: 0, out: "", err: "" } as Ran;
    },
  });
  const started = await lanes.start(start);
  expect(started.result).toEqual({ pane: "p1", tab: "t1", startup: { verdict: "ok", detail: "ready" }, cwd: start.cwd });
  const command = calls.find((a) => a[1] === "pane" && a[2] === "run")?.[4] ?? "";
  expect(command).toStartWith(`DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=${lanes.tokenPath("lane-a")} DORI_LANE_OUT=${join(runnerDir, "briefs", "lane-a.out")} lane-sandbox omo --model m1 --thinking medium --permission-preset full-access 'ulw set goal and work. Read and execute the lane brief at `);
  expect(lanes.records()["lane-a"]?.profile).toBe("sandboxed");
  // The wrapper's check ran before anything else of the launch.
  expect(calls[0]).toEqual(["lane-sandbox", "--check"]);
});

test("a sandboxed lane.start whose sandboxCheck fails is refused sandbox-unavailable and starts nothing; an unsandboxed one skips the check", async () => {
  const home = scratch();
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  const runnerDir = join(home, ".dori", "runner");
  mkdirSync(runnerDir, { recursive: true, mode: 0o700 });
  const policy = localPolicy({ ...defaultConfig(home), leadCwd: repo, worktreeRoot: "" }, { home, tmp: home });
  const calls: string[][] = [];
  const published: string[] = [];
  const lanes = new RunnerLanes({
    instance: async () => "server-1",
    runnerDir, clock: fakeClock(0), policy, token: () => "tok", publish: (type) => { published.push(type); }, startup: async () => ({ verdict: "ok", detail: "ready" }),
    run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "lane-sandbox") return { code: 3, out: "", err: "lane-sandbox: bwrap not found on PATH\n" } as Ran;
      if (argv.slice(0, 3).join(" ") === "herdr tab create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }), err: "" } as Ran;
      return { code: 0, out: "", err: "" } as Ran;
    },
  });
  const start = {
    cmdId: "lane-start:lane-a:1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: repo, agentProfile: "sandboxed",
    mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0, files: FILES,
  };
  await expect(lanes.start(start)).rejects.toThrow("RUNNER_CMD_REJECTED sandbox-unavailable lane-sandbox: bwrap not found on PATH");
  expect(calls).toEqual([["lane-sandbox", "--check"]]);
  expect(lanes.records()).toEqual({});
  expect(existsSync(lanes.briefPath("lane-a"))).toBe(false);
  expect(published).toEqual([]);

  calls.length = 0;
  await lanes.start({ ...start, agentProfile: "default", sandbox: false });
  expect(calls.some((a) => a[0] === "lane-sandbox")).toBe(false);
  expect(lanes.records()["lane-a"]?.profile).toBe("default");
});

test("a local runner-config.json with reposRoot/worktreeRoot layers them and adds both roots to allowedRoots without repeats", () => {
  const dir = scratch();
  const cfg = { ...defaultConfig("/home/u"), leadCwd: "/data/dori", worktreeRoot: "/data/wt" };
  const env = { home: "/home/u", tmp: "/tmp" };
  const local = localPolicy(cfg, env);
  writeFileSync(join(dir, POLICY_FILE), JSON.stringify({ reposRoot: "~/src" }));
  expect(localRunnerPolicy(dir, cfg, env)).toEqual({ ...local, reposRoot: "/home/u/src", worktreeRoot: "/home/u/src/worktrees", allowedRoots: [...local.allowedRoots, "/home/u/src", "/home/u/src/worktrees"] });
  writeFileSync(join(dir, POLICY_FILE), JSON.stringify({ reposRoot: "/srv/src", worktreeRoot: "/data/wt" }));
  expect(localRunnerPolicy(dir, cfg, env)).toEqual({ ...local, reposRoot: "/srv/src", worktreeRoot: "/data/wt", allowedRoots: [...local.allowedRoots, "/srv/src"] });
});
