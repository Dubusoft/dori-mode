import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { fakeClock } from "./fakes.ts";
import { hcAnswer, launchLines, newHcWorld } from "./runner-hc-world.ts";

const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = { cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0, files: FILES };

/** A RunnerLanes over a scripted hc. */
const setup = (agent = ["omo", "--model", "{model}", "{prompt}"]) => {
  const runnerDir = join(mkdtempSync(join(tmpdir(), "hc-launch-")), "runner");
  dirs.push(join(runnerDir, ".."));
  mkdirSync(runnerDir, { mode: 0o700 });
  const calls: string[][] = [];
  const world = newHcWorld();
  const lanes = new RunnerLanes({
    runnerDir, clock: fakeClock(1_800_000_000_000), token: () => "tok", realpath: (p: string) => p,
    legacyMcp: async () => false, startup: async () => ({ verdict: "ok", detail: "ready" }),
    policy: { agents: { omo: agent }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] },
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

