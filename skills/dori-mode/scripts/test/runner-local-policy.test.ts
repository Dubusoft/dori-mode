import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import type { Ran } from "../src/run.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { localPolicy } from "../src/runner/local-policy.ts";
import { checkCommand } from "../src/runner/policy.ts";
import { fakeClock } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "runner-local-policy-")));
  dirs.push(dir);
  return dir;
};

test("localPolicy derives default and sandboxed profiles from agentCommand, laneThinking and laneSandbox", () => {
  const cfg = { ...defaultConfig("/home/u"), defaultCwd: "/data/repos/app", worktreeRoot: "/data/repos/worktrees", laneThinking: "high", laneSandbox: { command: ["lane-sandbox", "--strict"] } };
  const policy = localPolicy(cfg, { home: "/home/u", tmp: "/tmp" });
  expect(policy.agents.default).toEqual(["omo", "--model", "{model}", "--thinking", "high", "{prompt}"]);
  expect(policy.agents.sandboxed).toEqual(["lane-sandbox", "--strict", "omo", "--model", "{model}", "--thinking", "high", "{prompt}"]);
  expect(policy.allowedRoots).toEqual(["/home/u", "/tmp", "/data/repos", "/data/repos/worktrees"]);
  expect(policy).toMatchObject({ sandbox: "optional", jobs: "allow" });
  expect(policy.guard).toBeUndefined();
  expect(policy.heavyKill).toBeUndefined();
});

test("localPolicy: no laneSandbox uses lane-sandbox; a template without --model/--thinking keeps its argv; roots are not repeated", () => {
  const cfg = { ...defaultConfig("/home/u"), agentCommand: ["claude", "{prompt}"], defaultCwd: "/home/u/repo", worktreeRoot: "", laneSandbox: undefined };
  const policy = localPolicy(cfg, { home: "/home/u", tmp: "/home/u" });
  expect(policy.agents.default).toEqual(["claude", "{prompt}"]);
  expect(policy.agents.sandboxed).toEqual(["lane-sandbox", "claude", "{prompt}"]);
  expect(policy.allowedRoots).toEqual(["/home/u"]);
});

test("acceptance: a local RunnerLanes over localPolicy(cfg) starts a lane with the sandboxed profile; the policy admits the cwd and refuses one outside the roots", async () => {
  const home = scratch();
  const repo = join(home, "repos", "app");
  mkdirSync(repo, { recursive: true });
  const outside = scratch();
  const cfg = { ...defaultConfig(home), defaultCwd: repo, worktreeRoot: "", laneThinking: "medium" };
  const policy = localPolicy(cfg, { home, tmp: home });
  const start = {
    cmdId: "lane-start:lane-a:1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: repo, agentProfile: "sandboxed",
    mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0, keywords: "ulw set goal and work",
  };
  const frame = (body: object) => ({ v: 1, runner: "local", gen: 1, epoch: 1, cmdSeq: 1, type: "lane.start", body });
  expect(checkCommand(policy, frame(start), realpathSync).ok).toBe(true);
  expect(checkCommand(policy, frame({ ...start, cwd: outside }), realpathSync)).toMatchObject({ ok: false, rule: "cwd-outside-roots" });

  const runnerDir = join(home, ".dori", "runner");
  mkdirSync(runnerDir, { recursive: true, mode: 0o700 });
  const calls: string[][] = [];
  const lanes = new RunnerLanes({
    runnerDir, clock: fakeClock(0), policy, token: () => "tok", publish: () => {}, startup: async () => ({ verdict: "ok", detail: "ready" }),
    run: async (argv) => {
      calls.push([...argv]);
      if (argv.slice(0, 3).join(" ") === "herdr tab create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }), err: "" } as Ran;
      return { code: 0, out: "", err: "" } as Ran;
    },
  });
  const started = await lanes.start(start);
  expect(started.result).toEqual({ pane: "p1", tab: "t1", startup: { verdict: "ok", detail: "ready" } });
  const command = calls.find((a) => a[1] === "pane" && a[2] === "run")?.[4] ?? "";
  expect(command).toStartWith(`DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=${lanes.tokenPath("lane-a")} lane-sandbox omo --model m1 --thinking medium 'ulw set goal and work. Read and execute the lane brief at `);
  expect(lanes.records()["lane-a"]?.profile).toBe("sandboxed");
});
