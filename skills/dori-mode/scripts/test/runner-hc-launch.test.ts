import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { fakeClock } from "./fakes.ts";
import { closes, hcAnswer, launchLines, newHcWorld } from "./runner-hc-world.ts";

const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = { cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0, files: FILES };

/** A RunnerLanes over a scripted hc. */
const setup = (agent = ["omo", "--model", "{model}", "{prompt}"], platform: NodeJS.Platform = "linux") => {
  const runnerDir = join(mkdtempSync(join(tmpdir(), "hc-launch-")), "runner");
  dirs.push(join(runnerDir, ".."));
  mkdirSync(runnerDir, { mode: 0o700 });
  const calls: string[][] = [];
  const world = newHcWorld();
  const lanes = new RunnerLanes({
    runnerDir, clock: fakeClock(1_800_000_000_000), token: () => "tok", realpath: (p: string) => p, platform,
    legacyMcp: async () => false, startup: async () => ({ verdict: "ok", detail: "ready" }),
    policy: { agents: { omo: agent, review: agent }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] },
    publish: () => {},
    run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "lane-sandbox" && argv.includes("--check")) return { code: 0, out: "DORI_LANE_FILES=1\n", err: "" } as Ran;
      return hcAnswer(world, argv) ?? ({ code: 0, out: "", err: "" } as Ran);
    },
  });
  return { lanes, calls, world };
};

const typed = (calls: string[][]): string => launchLines(calls)[0] ?? "";

test("the lane record stores the terminal's shell pid", async () => {
  const t = setup();
  t.world.panes = [{ pane_id: "hc:t1", shellPid: 4242 }];
  await t.lanes.start(START);
  expect(t.lanes.records()["lane-a"]?.shellPid).toBe(4242);
});

test("the hc launch line preserves spaces, quotes and literal dollar signs in agent arguments", async () => {
  const t = setup(["omo", "a b", "x'y", 'say "hi"', "$HOME", "{prompt}"]);
  await t.lanes.start(START);
  expect(typed(t.calls)).toContain(`; omo 'a b' 'x'\\''y' 'say "hi"' '$HOME' `);
});

test("a POSIX terminal exports its environment and pulls secrets", async () => {
  const posix = setup();
  await posix.lanes.start(START);
  expect(typed(posix.calls)).toStartWith("export DO_NOT_TRACK=1 DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=");
  expect(typed(posix.calls)).toContain(" secret env)\"; omo --model m1 ");
});

const decode = (line: string): string => {
  const m = /^powershell -NoLogo -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(line);
  expect(m).not.toBeNull();
  return Buffer.from(m?.[1] ?? "", "base64").toString("utf16le");
};

test("a Windows runner types a nested Windows PowerShell command with the lane env, its cwd and the argv in order", async () => {
  const t = setup(["omo", "--model", "{model}", "x'y", "{prompt}"], "win32");
  await t.lanes.start({ ...START, heavySlots: 2 });
  const tokenFile = t.lanes.tokenPath("lane-a").replace(/'/g, "''");
  const script = decode(typed(t.calls));
  expect(script).toStartWith(`$env:DO_NOT_TRACK='1'; $env:DORI_LANE_KEY='lane-a'; $env:DORI_LANE_TOKEN_FILE='${tokenFile}'; $env:DORI_LANE_OUT='`);
  expect(script).toContain("; $env:DORI_HEAVY_SLOTS='2'; $env:PSExecutionPolicyPreference='Bypass'; Set-Location -LiteralPath '/repo'; & 'omo' '--model' 'm1' 'x''y' '");
  expect(script).toEndWith("'; exit $LASTEXITCODE");
  expect(script).not.toContain("secret env");
  expect(t.lanes.records()["lane-a"]?.pane).toBe("hc:t1");
});

test("a Windows runner refuses a double quote in argv and a review lane: the terminal is closed and no lane is recorded", async () => {
  const quoted = setup(["omo", 'say "hi"', "{prompt}"], "win32");
  await expect(quoted.lanes.start(START)).rejects.toThrow("RUNNER_LANE_ARGV_UNSAFE");
  expect(typed(quoted.calls)).toBe("");
  expect(closes(quoted.calls)).toEqual(["hc:t1"]);
  expect(quoted.lanes.records()["lane-a"]).toBeUndefined();

  const review = setup(undefined, "win32");
  await expect(review.lanes.start({ ...START, agentProfile: "review" })).rejects.toThrow("RUNNER_LANE_REVIEW_UNSANDBOXED");
  expect(typed(review.calls)).toBe("");
  expect(review.lanes.records()["lane-a"]).toBeUndefined();
});

