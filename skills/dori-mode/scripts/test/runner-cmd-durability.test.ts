import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { COMMAND_RETENTION_MS, type Observation, pruneCommandRecords, resolveInterrupted, settleAttempted } from "../src/runner/durability.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { DEFAULT_POLICY } from "../src/runner/policy.ts";
import type { CommandStatusState, RunnerEventBodies } from "../src/runner/protocol.ts";
import { commandDispatcher } from "../src/runner/serve.ts";
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
  const lanes = new RunnerLanes({ instance: async () => "server-1", runnerDir: dir, run: herdr.run, clock, publish: () => {}, policy: { agents: { default: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" } });
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

test("a resent final cmdId is answered again with its stored structured result, also after a runner restart, and its effect runs once", async () => {
  const dir = runnerDir();
  const clock = fakeClock(1_000);
  const published: RunnerEventBodies["cmd.result"][] = [];
  const logs: string[] = [];
  let closes = 0;
  let settled: () => void = () => {};
  const dispatcherFor = (state: RunnerState) => commandDispatcher({
    state, policy: DEFAULT_POLICY, realpath: (p) => p, log: (l) => { logs.push(l); },
    publish: (body) => { published.push(body); settled(); },
    effects: { "lane.close": async () => { closes += 1; return { detail: "closed tab t1", result: { closed: "tab", gone: true } }; } },
  });
  const close = (cmdSeq: number) => ({ v: 1, runner: "local", gen: 1, epoch: 1, cmdSeq, type: "lane.close", body: { cmdId: "op:close-1", key: "lane-a", worktreeChecks: false } });

  const before = new RunnerState(dir, { now: clock.now });
  before.boot();
  const first = new Promise<void>((resolve) => { settled = resolve; });
  dispatcherFor(before)(close(1));
  await first;
  const answer: RunnerEventBodies["cmd.result"] = { cmdId: "op:close-1", cmdSeq: 1, state: "verified", detail: "closed tab t1", result: { closed: "tab", gone: true } };
  expect(published).toEqual([answer]);
  expect(before.command("op:close-1")).toMatchObject({ state: "verified", result: "closed tab t1", resultValue: { closed: "tab", gone: true } });

  // The supervisor resends the operation (its call timed out, or it restarted): the stored answer goes out again.
  dispatcherFor(before)(close(2));
  expect(published).toEqual([answer, answer]);
  before.close();

  // A restarted runner reads the stored result back from state.sqlite.
  const after = new RunnerState(dir, { now: clock.now });
  after.boot();
  dispatcherFor(after)(close(3));
  expect(published).toEqual([answer, answer, answer]);
  expect(closes).toBe(1);
  expect(logs.filter((l) => l.startsWith("RUNNER_CMD_REPLAYED"))).toEqual([
    "RUNNER_CMD_REPLAYED cmdId=op:close-1 type=lane.close state=verified",
    "RUNNER_CMD_REPLAYED cmdId=op:close-1 type=lane.close state=verified",
  ]);
  after.close();
});

test("a resent cmdId still at intent is left alone, and a string effect still answers without a result", async () => {
  const dir = runnerDir();
  const state = new RunnerState(dir, { now: () => 1_000 });
  state.boot();
  const published: RunnerEventBodies["cmd.result"][] = [];
  let release: (detail: string) => void = () => {};
  let settled: () => void = () => {};
  let runs = 0;
  const dispatch = commandDispatcher({
    state, policy: DEFAULT_POLICY, realpath: (p) => p, log: () => {},
    publish: (body) => { published.push(body); settled(); },
    effects: { "lane.observe": () => { runs += 1; return new Promise<string>((resolve) => { release = resolve; }); } },
  });
  const observe = (cmdSeq: number) => ({ v: 1, runner: "local", gen: 1, epoch: 1, cmdSeq, type: "lane.observe", body: { cmdId: "obs-1", key: "lane-a" } });
  dispatch(observe(1));
  dispatch(observe(2));
  expect(published).toEqual([]);
  expect(runs).toBe(1);
  const done = new Promise<void>((resolve) => { settled = resolve; });
  release("present");
  await done;
  expect(published).toEqual([{ cmdId: "obs-1", cmdSeq: 1, state: "verified", detail: "present" }]);
  expect(state.command("obs-1")?.resultValue).toBeUndefined();
  state.close();
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
