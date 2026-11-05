import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { COMMAND_RETENTION_MS, type Observation, pruneCommandRecords, resolveInterrupted, settleAttempted } from "../src/runner/durability.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import type { CommandStatusState } from "../src/runner/protocol.ts";
import { RunnerState } from "../src/runner/state.ts";
import { fakeClock } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const runnerDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "runner-durability-"));
  dirs.push(root);
  const dir = join(root, "runner");
  mkdirSync(dir, { mode: 0o700 });
  return dir;
};

const START = { cmdId: "lane-start:lane-a:1", key: "lane-a", briefText: "# b\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "default", mode: "ulw", model: "m", sandbox: false, expectedLaneGen: 0 };

const fakeHerdr = () => {
  const tabs: string[] = [];
  const run = async (argv: readonly string[]): Promise<Ran> => {
    if (argv.slice(0, 3).join(" ") === "herdr tab create") {
      tabs.push(`t${tabs.length + 1}`);
      return { code: 0, out: JSON.stringify({ result: { tab_id: tabs.at(-1), root_pane: { pane_id: `p${tabs.length}` } } }), err: "" } as Ran;
    }
    return { code: 0, out: "", err: "" } as Ran;
  };
  return { tabs, run };
};

test("a runner that crashed after lane.start's effect and before its result settles it as verified on restart, with one tab", async () => {
  const dir = runnerDir();
  const herdr = fakeHerdr();
  const clock = fakeClock(1_000);
  const before = new RunnerState(dir, { now: clock.now });
  before.boot();
  expect(before.recordIntent({ cmdId: START.cmdId, cmdSeq: 1, type: "lane.start", epoch: 1, key: "lane-a" }).fresh).toBe(true);
  const lanes = new RunnerLanes({ runnerDir: dir, run: herdr.run, clock, publish: () => {}, policy: { agents: { default: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" } });
  await lanes.start(START);
  before.close();

  const after = new RunnerState(dir, { now: clock.now });
  after.boot();
  const published: unknown[] = [];
  const observeLane = async (key: string): Promise<Observation> => (Object.keys(lanes.records()).includes(key) && herdr.tabs.length ? "present" : "absent");
  const lines = await resolveInterrupted({ state: after, observeLane, publish: (body) => { published.push(body); } });
  expect(herdr.tabs).toEqual(["t1"]);
  expect(after.command(START.cmdId)?.state).toBe("verified");
  expect(after.pendingIntents()).toEqual([]);
  expect(published).toEqual([{ cmdId: START.cmdId, cmdSeq: 1, state: "verified", detail: "interrupted lane.start; observed present" }]);
  expect(lines).toHaveLength(1);
  after.close();
});

test("final command records past the 30-day retention are pruned; intent rows and the command cursor stay", () => {
  const dir = runnerDir();
  const clock = fakeClock(1_000);
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  state.recordIntent({ cmdId: "old-final", cmdSeq: 1, type: "lane.stop", epoch: 1, key: "lane-a" });
  state.recordResult("old-final", "verified", "stopped");
  state.recordIntent({ cmdId: "old-intent", cmdSeq: 2, type: "lane.start", epoch: 1, key: "lane-b" });
  clock.at += COMMAND_RETENTION_MS;
  state.recordIntent({ cmdId: "recent", cmdSeq: 3, type: "lane.send", epoch: 1, key: "lane-c" });
  state.recordResult("recent", "verified", "sent");
  clock.at += 1;
  expect(pruneCommandRecords(state, clock.now())).toBe(1);
  expect(state.command("old-final")).toBeUndefined();
  expect(state.command("old-intent")?.state).toBe("intent");
  expect(state.command("recent")?.state).toBe("verified");
  expect(state.cmdAck()).toBe(1);
  state.close();
});

test("with the runner's command records gone, the supervisor observes instead of resending: present is verified, herdr silent is one OPERATION_AMBIGUOUS", async () => {
  const dir = runnerDir();
  const state = new RunnerState(dir, { now: () => 1_000 });
  state.boot();
  const status = async (cmdId: string): Promise<CommandStatusState> => state.command(cmdId)?.state ?? "unknown";
  let resent = 0;
  const emitted: string[] = [];
  const settle = (observe: () => Promise<Observation>) =>
    settleAttempted({ status, observe, resend: () => { resent += 1; }, emit: (line) => { emitted.push(line); } }, { cmdId: START.cmdId, key: "lane-a", type: "lane.start" });

  expect(await settle(async () => "present")).toBe("verified");
  expect(resent).toBe(0);
  expect(await settle(async () => { throw new Error("herdr: connection refused"); })).toBe("ambiguous");
  expect(resent).toBe(0);
  expect(emitted.filter((l) => l.startsWith("OPERATION_AMBIGUOUS"))).toHaveLength(1);
  expect(await settle(async () => "absent")).toBe("retry");
  expect(resent).toBe(1);
  state.close();
});
