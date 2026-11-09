import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { acceptLaneEvent, type LaneHubDeps } from "../src/runner/lanes-hub.ts";
import type { LaneBriefFiles } from "../src/runner/protocol.ts";
import { launchLane } from "../src/launch.ts";

import { recoverLanes, RECOVERY_LIMIT, type RecoveryLane, resumeCommand, STARTUP_GRACE_MS, withRecoveryLock } from "../src/recover.ts";
import { freshnessTick } from "../src/freshness.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { type LaneOps, LaneOpsError } from "../src/lane-ops.ts";
import type { StartupVerdict, TurnEvidence } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, sent, withState, withSqliteStore, type World } from "./fakes.ts";
import { markHerdr } from "./herdr-world.ts";
import { tryStateLock } from "../src/state-lock.ts";
import { eventClass } from "../src/event-policy.ts";

type Deps = ReturnType<typeof depsFor>;

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); withSqliteStore(state.dir); });
afterEach(() => state.done());

const fixture = async () => {
  const world = newWorld();
  world.prState = "OPEN";
  const clock = fakeClock(0);
  const d = depsFor(world, clock, state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "Execute the task.");
  const lane: Lane = { key: "recover-lane", title: "lane", thread: "chat:1", brief, cwd: state.dir, model: "provider/expected", pane: "old:p1", tab: "old:t1", done: "merged a/b#1", openedAt: new Date(-STARTUP_GRACE_MS).toISOString() };
  const control = {
    argv: ["omo", "--model", "provider/expected"], fail: false, listFails: false, next: 0, attempted: 0,
    startup: { verdict: "ok", detail: "ready" } as StartupVerdict,
    duringCreate: undefined as undefined | (() => Promise<void>), onProcessInfo: undefined as undefined | (() => Promise<void>),
    live: (on: boolean) => { world.panes = on ? [{ pane_id: "old:p1", tab_id: "old:t1", workspace_id: "w", agent: "omo", agent_status: "working" }] : []; },
  };
  /** The runner's relaunch (lane.recover or lane.start): a new working pane new:p<n>, or a failure when control.fail. */
  const relaunch = async (): Promise<{ pane: string; tab: string }> => {
    control.attempted = (await d.registry.read(lane.key))?.recoveryAttempts ?? 0;
    await control.duringCreate?.();
    control.next++;
    if (control.fail) throw new LaneOpsError("LANE_OP_FAILED", "local", "lane.recover herdr tab create failed");
    const pane = `new:p${control.next}`;
    world.panes.push({ pane_id: pane, tab_id: `new:t${control.next}`, workspace_id: "w", agent: "omo", agent_status: "working" });
    return { pane, tab: `new:t${control.next}` };
  };
  const ops: LaneOps = {
    ...d.ops,
    panes: async (machine) => {
      if (control.listFails) { world.ops.push({ op: "panes", args: { machine } }); throw new LaneOpsError("LANE_OP_FAILED", "local", "herdr pane list failed"); }
      return d.ops.panes(machine);
    },
    processInfo: async (ref) => {
      world.ops.push({ op: "processInfo", args: { ...ref } });
      const out = { code: 0, out: JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 42, argv: control.argv }] } } }), err: "" };
      await control.onProcessInfo?.();
      return out;
    },
    recover: async (l, opts) => {
      world.ops.push({ op: "recover", key: l.key, args: { runner: l.runner, ...(opts ? { opts } : {}) } });
      const made = await relaunch();
      return { ...made, relaunched: true, resumed: opts?.session !== undefined, startup: control.startup };
    },
    start: async (input) => {
      world.ops.push({ op: "start", key: input.key, args: input });
      return { ...(await relaunch()), startup: control.startup };
    },
  };
  const deps: typeof d = { ...d, ops };
  await deps.registry.write(lane);
  return { deps, world, lane, control, clock };
};

const opsOf = (world: World, ...names: string[]) => world.ops.filter((e) => names.includes(e.op));
const SKIP = "SANDBOX_SKIPPED recover-lane: relaunch of a lane recorded without a sandbox";

test.each(["recover", "start"])("a timed-out %s proposal is retired by its failed result so the next sweep retries", async (kind) => {
  const { deps, lane, clock, world } = await fixture();
  const active = { id: "00000000-0000-4000-8000-000000000001", requiredReport: false };
  await deps.registry.patch(lane.key, { runner: "local", fileRun: active, recoveryAfter: 2, recoveryPreviousPane: "prior" });
  let cmdId = "";
  const timeout = new LaneOpsError("RUNNER_UNAVAILABLE", "local", "timeout");
  const ops: LaneOps = { ...deps.ops,
    recover: async (_lane, opts) => {
      cmdId = opts!.cmdId!;
      if (kind === "start") throw new LaneOpsError("LANE_OP_FAILED", "local", "RUNNER_LANE_UNKNOWN recover-lane");
      throw timeout;
    },
    start: async (input) => { cmdId = input.cmdId!; throw timeout; },
  };
  expect((await recoverLanes({ ...deps, ops }, lane.key))[0]).toContain(kind === "recover" ? "LANE_RECOVERY_HELD" : "LANE_RECOVERY_ERROR");
  const pending = (await deps.registry.read(lane.key)) as RecoveryLane;
  expect(pending.pendingFileRun).toBeDefined();
  expect(pending.fileProposal?.cmdId).toBe(cmdId);
  expect(await recoverLanes(deps, lane.key)).toEqual([]);
  const hub: LaneHubDeps = { stateDir: state.dir, registry: deps.registry, reports: () => undefined,
    now: clock.now, emit: () => {}, prepareRecovery: async () => ({ cmdId: "unused", notes: [] }), recover: () => undefined };
  await acceptLaneEvent(hub, "local", { v: 1, runner: "local", gen: 1, epoch: 1, seq: 1, type: "cmd.result",
    body: { cmdId, cmdSeq: 1, state: "failed", detail: "RUNNER_CMD_FAILED not started" } }, 3);
  expect(await deps.registry.read(lane.key)).toMatchObject({ fileRun: active, recoveryAfter: 2, recoveryPreviousPane: "prior" });
  expect((await deps.registry.read(lane.key))?.pendingFileRun).toBeUndefined();
  clock.at += 1;
  expect((await recoverLanes(deps, lane.key))[0]).toStartWith("LANE_RECOVERED");
  expect(opsOf(world, "recover")).toHaveLength(1);
});

test.each(["autoClose: lead\nissue: changed/repo#2", "autoClose: invalid\nissue: invalid"])("relaunch retains stored policy despite edited declarations: %s", async (body) => {
  const { deps, lane } = await fixture();
  const existing = { ...lane, runner: "local", autoClose: "machine" as const, ghIssue: "a/b#1" };
  await deps.registry.write(existing);
  await Bun.write(lane.brief, `${body}\ndeliverable: report`);
  const result = await launchLane(deps, { key: lane.key, title: lane.title, brief: lane.brief, done: lane.done, cwd: lane.cwd }, existing);
  expect(result.lane).toMatchObject({ autoClose: "machine", ghIssue: "a/b#1", fileRun: { requiredReport: true } });
  expect(await Bun.file(lane.brief).text()).toContain("- autoClose: machine.");
});

test("recovers a missing pane through its runner with persisted attempt and original launch metadata", async () => {
  const { deps, world, lane, control } = await fixture();
  const events = await recoverLanes(deps, lane.key);
  expect(events).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane", "STARTUP_OK recover-lane new:p1"]);
  expect(control.attempted).toBe(1);
  expect(opsOf(world, "recover", "start", "close").map((e) => e.op)).toEqual(["recover"]);
  expect(await deps.registry.read(lane.key)).toMatchObject({ pane: "new:p1", tab: "new:t1", model: lane.model, brief: lane.brief, cwd: lane.cwd, openedAt: lane.openedAt, recoveryAttempts: 1, lastRecoveryAt: 0 });
  expect(world.calls.filter((call) => call[0] === "notify")).toHaveLength(1);
});

test("a lane its runner does not know is started again from its brief", async () => {
  const { deps, world, lane } = await fixture();
  const ops: LaneOps = { ...deps.ops, recover: async () => { throw new LaneOpsError("LANE_OP_FAILED", "local", "lane.recover RUNNER_LANE_UNKNOWN recover-lane"); } };
  // The fixture lane is recorded without a sandbox: its relaunch runs unsandboxed and says so (SKIP below).
  expect(await recoverLanes({ ...deps, ops }, lane.key)).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane", "STARTUP_OK recover-lane new:p1", SKIP]);
  const start = opsOf(world, "start")[0]?.args as { briefText: string } | undefined;
  expect(start).toMatchObject({ key: "recover-lane", cwd: lane.cwd, model: lane.model });
  // A lane on the old footer moves onto the dori report one when it is started again.
  expect(start?.briefText).toStartWith("Execute the task.\n\n## Lane footer (written by dori launch)");
});

test("ordinary recovery rereads changed attachments and installs its fresh proposal before dispatch", async () => {
  const { deps, lane } = await fixture();
  mkdirSync(join(state.dir, "briefs"));
  const source = join(state.dir, "briefs", "input");
  await Bun.write(source, "new bytes"); await Bun.write(lane.brief, source);
  let files: LaneBriefFiles | undefined;
  const ops: LaneOps = { ...deps.ops, recover: async (current, opts) => {
    files = opts!.files;
    expect((await deps.registry.read(lane.key))?.pendingFileRun).toEqual(files!.run);
    expect(Buffer.from(files!.tree.files[0]!.base64, "base64").toString()).toBe("new bytes");
    return deps.ops.recover(current, opts);
  } };
  await recoverLanes({ ...deps, ops }, lane.key);
  expect((await deps.registry.read(lane.key))?.fileRun).toEqual(files!.run);
  expect((await deps.registry.read(lane.key))?.pendingFileRun).toBeUndefined();
});

test("input refusal precedes attempt accounting and intentional old-pane close", async () => {
  const { deps, lane, world, control } = await fixture();
  control.live(true); control.argv = ["omo", "--model", "wrong"];
  await Bun.write(lane.brief, "deliverable: invalid");
  expect((await recoverLanes(deps, lane.key))[0]).toContain("LANE_DELIVERABLE_INVALID");
  expect(opsOf(world, "recover", "start", "close")).toEqual([]);
  expect((await deps.registry.read(lane.key))?.recoveryAttempts).toBeUndefined();
});

test("unknown-runner fallback rescans with a new persisted run and converges with an early started event", async () => {
  const { deps, lane } = await fixture();
  mkdirSync(join(state.dir, "briefs"));
  const source = join(state.dir, "briefs", "input");
  await Bun.write(source, "before"); await Bun.write(lane.brief, source);
  let failedRun: LaneBriefFiles["run"] | undefined, startRun: LaneBriefFiles["run"] | undefined;
  const hub: LaneHubDeps = { stateDir: state.dir, registry: deps.registry, reports: () => undefined,
    now: deps.clock.now, emit: () => {}, prepareRecovery: async () => ({ cmdId: "unused", notes: [] }), recover: () => undefined };
  const ops: LaneOps = { ...deps.ops,
    recover: async (_current, opts) => {
      failedRun = opts!.files!.run;
      await Bun.write(source, "after");
      throw new LaneOpsError("LANE_OP_FAILED", "local", "lane.recover RUNNER_LANE_UNKNOWN recover-lane");
    },
    start: async (input) => {
      startRun = input.files!.run;
      expect(startRun.id).not.toBe(failedRun!.id);
      expect((await deps.registry.read(lane.key))?.pendingFileRun).toEqual(startRun);
      expect(Buffer.from(input.files!.tree.files[0]!.base64, "base64").toString()).toBe("after");
      await acceptLaneEvent(hub, "local", { v: 1, runner: "local", gen: 1, epoch: 1, seq: 1, type: "lane.started",
        body: { key: lane.key, pane: "event:pane", tab: "event:tab", session: "", fileRun: startRun } }, 1);
      return deps.ops.start(input);
    },
  };
  await recoverLanes({ ...deps, ops }, lane.key);
  expect(await deps.registry.read(lane.key)).toMatchObject({ pane: "event:pane", fileRun: startRun });
  expect((await deps.registry.read(lane.key))?.pendingFileRun).toBeUndefined();
  await acceptLaneEvent(hub, "local", { v: 1, runner: "local", gen: 1, epoch: 1, seq: 2, type: "lane.started",
    body: { key: lane.key, pane: "event:pane", tab: "stale", session: "", fileRun: failedRun! } }, 2);
  expect((await deps.registry.read(lane.key))?.tab).toBe("event:tab");
});

test("a definite fallback refusal retires only its own proposal and preserves newer fields", async () => {
  const { deps, lane } = await fixture();
  const newer = { id: "00000000-0000-4000-8000-000000000099", requiredReport: false };
  const ops: LaneOps = { ...deps.ops,
    recover: async () => { throw new LaneOpsError("LANE_OP_FAILED", "local", "lane.recover RUNNER_LANE_UNKNOWN recover-lane"); },
    start: async () => {
      await deps.registry.patch(lane.key, { pendingFileRun: newer, title: "new writer" });
      throw new LaneOpsError("LANE_OP_FAILED", "local", "LANE_FILES_INPUT_REQUIRED recover-lane: fresh input required");
    },
  };
  expect((await recoverLanes({ ...deps, ops }, lane.key))[0]).toContain("LANE_FILES_INPUT_REQUIRED");
  expect(await deps.registry.read(lane.key)).toMatchObject({ title: "new writer", pendingFileRun: newer });
});

test("a lane whose close is running is not relaunched when its pane is gone", async () => {
  const { deps, world, lane } = await fixture();
  const release = tryStateLock(join(deps.registry.dir, `${lane.key}.close.lock.sqlite`));
  try {
    expect(await recoverLanes(deps, lane.key)).toEqual([]);
  } finally { release?.(); }
  expect(opsOf(world, "recover", "start")).toEqual([]);
  expect((await deps.registry.read(lane.key))?.recoveryAttempts).toBeUndefined();
});

test.each([
  { argv: ["omo"], reason: "missing-model" },
  { argv: ["bun", "/bin/omo", "--model", "provider/wrong"], reason: "model-mismatch" },
  { argv: ["omo", "--model=provider/wrong"], reason: "model-mismatch" },
  { argv: ["bun", "/agent/senpi/dist/bundle/cli.js"], reason: "missing-model" },
])("replaces a live pane on argv $argv using the registry model: the runner closes the lane, then starts it again", async ({ argv, reason }) => {
  const { deps, world, control } = await fixture();
  control.live(true);
  control.argv = [...argv];
  const events = await recoverLanes(deps);
  expect(events[0]).toBe(`LANE_RECOVERED recover-lane new:p1 ${reason}`);
  expect((await deps.registry.read("recover-lane"))?.model).toBe("provider/expected");
  expect(opsOf(world, "recover", "start", "close").map((e) => e.op)).toEqual(["close", "start"]);
  expect(opsOf(world, "start")[0]?.args).toMatchObject({ model: "provider/expected" });
  expect(world.panes.some((p) => p.pane_id === "old:p1")).toBe(false);
  // The unsandboxed relaunch's sandbox notice, then LANE_RECOVERED.
  expect(events.at(-1)).toBe(SKIP);
  expect(world.calls.filter((call) => call[0] === "notify").map((call) => call[2])).toEqual([`[sandbox] ${SKIP}`, "LANE_RECOVERED recover-lane new:p1 " + reason]);
});

/** The lane's pane with only its shell left: herdr names no agent, process-info shows no omo. */
const shellOnly = (world: World, control: { argv: string[] }): void => {
  world.panes = [{ pane_id: "old:p1", tab_id: "old:t1", workspace_id: "w" }];
  control.argv = ["bash"];
};

test("a lane whose agent is gone and left only its shell is recovered through its runner", async () => {
  const { deps, world, lane, control } = await fixture();
  await deps.registry.write({ ...lane, openedAt: new Date(-3 * STARTUP_GRACE_MS).toISOString() });
  shellOnly(world, control);
  // The runner's lane.recover closes the dead pane's tab before it opens the new one.
  control.duringCreate = async () => { world.panes = world.panes.filter((p) => p.pane_id !== "old:p1"); };
  expect(await recoverLanes(deps)).toEqual(["LANE_RECOVERED recover-lane new:p1 agent-gone", "STARTUP_OK recover-lane new:p1"]);
  expect(opsOf(world, "recover", "start", "close").map((e) => e.op)).toEqual(["recover"]);
  expect(await deps.registry.read(lane.key)).toMatchObject({ pane: "new:p1", recoveryAttempts: 1 });
});

test("a shell-only pane still in the runner's startup window, or one running another agent, is left alone", async () => {
  const { deps, world, lane, control } = await fixture();
  shellOnly(world, control);
  expect(await recoverLanes(deps)).toEqual([]);
  await deps.registry.write({ ...lane, openedAt: new Date(-3 * STARTUP_GRACE_MS).toISOString() });
  world.panes = [{ pane_id: "old:p1", tab_id: "old:t1", workspace_id: "w", agent: "claude", agent_status: "working" }];
  expect(await recoverLanes(deps)).toEqual([]);
  expect(opsOf(world, "recover", "start", "close")).toEqual([]);
});

test.each(["working", "paused", "closed", "done-claimed"] as const)("leaves %s live lanes untouched when matching or inactive", async (status) => {
  const { deps, world, lane, control } = await fixture();
  control.live(true);
  if (status !== "working") control.argv = ["omo"];
  await deps.registry.write({ ...lane, status });
  const events = await recoverLanes(deps);
  expect(events).toEqual([]);
  expect(opsOf(world, "recover", "start", "close")).toEqual([]);
});

test.each(["paused", "closed", "done-claimed"] as const)("does not recover a missing %s lane", async (status) => {
  const { deps, lane } = await fixture();
  await deps.registry.write({ ...lane, status });
  const events = await recoverLanes(deps);
  expect(events).toEqual([]);
});

test("a remote lane whose pane is unknown is recovered by its own runner, never started here", async () => {
  const { deps, world, lane } = await fixture();
  await deps.registry.write({ ...lane, pane: undefined, tab: undefined, machine: "worker-a", runner: "worker-a", cwd: undefined, remoteCwd: "/w/app" });
  expect(await recoverLanes(deps, lane.key)).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane", "STARTUP_OK recover-lane new:p1"]);
  expect(opsOf(world, "recover", "start").map((e) => [e.op, (e.args as { runner?: string }).runner])).toEqual([["recover", "worker-a"]]);
  expect((await deps.registry.read(lane.key))?.recoveryAttempts).toBe(1);
});

test.each(["down", "hung"] as const)("while a machine's herdr is %s its lanes are held without spending attempts, and recovered once herdr is back", async (state) => {
  const { deps, world, lane } = await fixture();
  await deps.registry.write({ ...lane, pane: undefined, tab: undefined, machine: "worker-a", runner: "worker-a", cwd: undefined, remoteCwd: "/w/app" });
  // A local lane (no machine, the local runner) on a host whose herdr is fine is recovered as usual meanwhile.
  await deps.registry.write({ ...lane, key: "local-lane" });
  markHerdr(deps.config.stateDir, "worker-a", state, 0);
  for (let round = 0; round < RECOVERY_LIMIT + 1; round++) {
    expect((await recoverLanes(deps)).filter((l) => l.includes(lane.key))).toEqual([]);
  }
  expect(opsOf(world, "recover", "start").map((e) => e.key)).toEqual(["local-lane"]);
  expect((await deps.registry.read(lane.key))?.recoveryAttempts).toBeUndefined();
  expect((await deps.registry.read(lane.key))?.recoveryPending).toBeUndefined();
  // Asked for by key, the hold says so.
  expect(await recoverLanes(deps, lane.key)).toEqual(["LANE_RECOVERY_HELD recover-lane herdr is down on machine=worker-a; recovery resumes once it reads again"]);

  markHerdr(deps.config.stateDir, "worker-a", "up", 1);
  expect(await recoverLanes(deps, lane.key)).toEqual(["LANE_RECOVERED recover-lane new:p2 missing-pane", "STARTUP_OK recover-lane new:p2"]);
  expect((await deps.registry.read(lane.key))?.recoveryAttempts).toBe(1);
});

test("before its runner's hello a lane is held without an error or a spent attempt, and recovered after it", async () => {
  const { deps, world, lane } = await fixture();
  // Right after a supervisor restart: the local runner has not said hello yet (the sweep's pane view may still answer).
  let hello = false;
  const restarted = { ...deps, ops: { ...deps.ops, connected: () => hello } };
  for (let round = 0; round < RECOVERY_LIMIT + 1; round++) expect(await recoverLanes(restarted)).toEqual([]);
  expect(opsOf(world, "recover", "start")).toEqual([]);
  expect((await deps.registry.read(lane.key))?.recoveryAttempts).toBeUndefined();
  expect(await recoverLanes(restarted, lane.key)).toEqual(["LANE_RECOVERY_HELD recover-lane runner=local is not connected; recovery resumes once it says hello"]);
  hello = true;
  expect(await recoverLanes(restarted)).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane", "STARTUP_OK recover-lane new:p1"]);
});

test("a runner that drops in the middle of a recovery holds the lane instead of raising LANE_RECOVERY_ERROR", async () => {
  const { deps, lane } = await fixture();
  const dropping = { ...deps, ops: { ...deps.ops, recover: async () => { throw new LaneOpsError("RUNNER_UNAVAILABLE", "local", "disconnected: connection lost before cmd.result"); } } };
  expect(await recoverLanes(dropping)).toEqual([]);
  expect(await recoverLanes(dropping, lane.key)).toEqual(["LANE_RECOVERY_HELD recover-lane runner=local is not connected; recovery resumes once it says hello"]);
  // Any other failure is still reported.
  const failing = { ...deps, ops: { ...deps.ops, recover: async () => { throw new LaneOpsError("LANE_OP_FAILED", "local", "herdr tab create failed"); } } };
  expect((await recoverLanes(failing))[0]).toStartWith("LANE_RECOVERY_ERROR recover-lane ");
});

test("a held lane resumes its own session when herdr is back", async () => {
  const { deps, world, lane } = await fixture();
  await deps.registry.write({ ...lane, pane: undefined, tab: undefined, machine: "worker-a", runner: "worker-a", cwd: undefined, remoteCwd: "/w/app", session: "ses_1" });
  markHerdr(deps.config.stateDir, "worker-a", "down", 0);
  expect(await recoverLanes(deps)).toEqual([]);
  markHerdr(deps.config.stateDir, "worker-a", "up", 1);
  expect(await recoverLanes(deps)).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane session-resumed", "STARTUP_OK recover-lane new:p1"]);
  expect(opsOf(world, "recover").map((e) => (e.args as { opts?: { session?: string } }).opts?.session)).toEqual(["ses_1"]);
});

test("does not interpret list failure as a missing pane", async () => {
  const { deps, control } = await fixture();
  control.listFails = true;
  const events = await recoverLanes(deps);
  expect(events[0]?.startsWith("LANE_RECOVERY_ERROR recover-lane ")).toBe(true);
  expect(control.next).toBe(0);
  expect((await deps.registry.read("recover-lane"))?.recoveryAttempts).toBeUndefined();
});

test("failed attempts exhaust the persisted recovery budget", async () => {
  const { deps, control, lane } = await fixture();
  control.fail = true;
  await deps.registry.write({ ...lane, recoveryAttempts: RECOVERY_LIMIT - 1 });
  const first = await recoverLanes(deps);
  const second = await recoverLanes(deps);
  const third = await recoverLanes(deps);
  expect(first[0]?.startsWith("LANE_RECOVERY_ERROR recover-lane ")).toBe(true);
  expect(second).toEqual([`LANE_RECOVERY_EXHAUSTED recover-lane old:p1 missing-pane after ${RECOVERY_LIMIT} recovery attempts; lane is not relaunched or nudged again, inspect it or dori close recover-lane`]);
  expect(third).toEqual([]);
  expect((await deps.registry.read("recover-lane")) as RecoveryLane | null).toMatchObject({ recoveryPending: true, recoveryExhausted: true });
  expect(control.next).toBe(1);
  expect((await deps.registry.read("recover-lane"))?.recoveryAttempts).toBe(RECOVERY_LIMIT);
});

test.each(["exhausted"] as const)(
  "retries the %s notice when enqueue fails before acceptance", async () => {
    const { deps, lane } = await fixture();
    await deps.registry.patch(lane.key, { recoveryAttempts: RECOVERY_LIMIT });
    const d = deps;
    const ids: string[] = [];
    const enqueue = async (_line: string, id: string) => {
      ids.push(id);
      if (ids.length === 1) throw new Error("crash before enqueue");
    };
    await recoverLanes(d, undefined, enqueue);
    expect((await deps.registry.read(lane.key)) as RecoveryLane).not.toMatchObject(
      { recoveryExhausted: true });
    await recoverLanes({ ...d, registry: new Registry(state.dir) }, undefined, enqueue);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBeTruthy();
    await recoverLanes({ ...d, registry: new Registry(state.dir) }, undefined, enqueue);
    expect(ids).toHaveLength(2);
  },
);

test.each(["exhausted"] as const)(
  "deduplicates the %s notice after enqueue but before flag persistence", async () => {
    const { deps, lane } = await fixture();
    await deps.registry.patch(lane.key, { recoveryAttempts: RECOVERY_LIMIT });
    const d = deps;
    const journal = new Map<string, string>();
    const ids: string[] = [];
    const enqueue = async (line: string, id: string) => { ids.push(id); journal.set(id, line); };
    const patch = deps.registry.patch.bind(deps.registry);
    deps.registry.patch = async () => { throw new Error("crash before flag persistence"); };
    await recoverLanes(d, undefined, enqueue);
    expect(journal.size).toBe(1);
    deps.registry.patch = patch;
    await recoverLanes(d, undefined, enqueue);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(journal.size).toBe(1);
    await recoverLanes(d, undefined, enqueue);
    expect(ids).toHaveLength(2);
  },
);

test("a concurrent recovery owner excludes another registry instance", async () => {
  const { deps, control } = await fixture();
  const events = await withRecoveryLock(deps, "recover-lane", () => recoverLanes({ ...deps, registry: new Registry(state.dir) }));
  expect(events).toEqual([]);
  expect(control.next).toBe(0);
});

test("a pause during process inspection prevents recovery admission", async () => {
  const { deps, lane, control, world } = await fixture();
  control.live(true);
  control.argv = ["omo"];
  control.onProcessInfo = async () => { await deps.registry.write({ ...lane, status: "paused" }); };
  expect(await recoverLanes(deps)).toEqual([]);
  expect((await deps.registry.read(lane.key))?.status).toBe("paused");
  expect(opsOf(world, "recover", "start", "close")).toEqual([]);
});

test("a capped wrong-model pane is never fed a freshness nudge", async () => {
  const { deps, lane, control, world } = await fixture();
  control.live(true);
  control.argv = ["omo"];
  await deps.registry.write({ ...lane, recoveryAttempts: RECOVERY_LIMIT });
  await recoverLanes(deps);
  expect((await deps.registry.read(lane.key))?.recoveryPending).toBe(true);
  expect(await freshnessTick({ ...deps, clock: fakeClock(30 * 60_000) })).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect(opsOf(world, "recover", "start")).toEqual([]);
});

test("failed process inspection never turns a live lane into a missing lane", async () => {
  const { deps, control } = await fixture();
  control.live(true);
  const ops: LaneOps = { ...deps.ops, processInfo: async () => ({ code: 1, out: "", err: "unavailable" }) };
  const events = await recoverLanes({ ...deps, ops });
  expect(events[0]?.startsWith("LANE_RECOVERY_ERROR recover-lane ")).toBe(true);
  expect(control.next).toBe(0);
  expect((await deps.registry.read("recover-lane"))?.recoveryAttempts).toBeUndefined();
});

test("a recovered agent that later confirms clears the freshness hold", async () => {
  const { deps, lane, control } = await fixture();
  control.live(true);
  await deps.registry.write({ ...lane, recoveryPending: true });
  expect(await recoverLanes(deps)).toEqual(["LANE_RECOVERED recover-lane old:p1 startup-confirmed"]);
  expect((await deps.registry.read(lane.key))?.recoveryPending).toBeUndefined();
});

test("a field changed while the relaunch runs survives the relaunch's registry write", async () => {
  const { deps, lane, control } = await fixture();
  control.duringCreate = async () => { await deps.registry.patch(lane.key, { title: "renamed mid-launch" }); };
  expect(await recoverLanes(deps)).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane", "STARTUP_OK recover-lane new:p1"]);
  expect(await deps.registry.read(lane.key)).toMatchObject({ title: "renamed mid-launch", pane: "new:p1" });
});

test("item 7: a recovered lane resumes its registered session instead of restarting from the brief", async () => {
  const { deps, world, lane } = await fixture();
  await deps.registry.write({ ...lane, session: "0b1c2d3e-aaaa-bbbb-cccc-123456789abc", sessionVia: "argv" });
  expect(await recoverLanes(deps)).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane session-resumed", "STARTUP_OK recover-lane new:p1"]);
  expect(opsOf(world, "recover")[0]?.args).toMatchObject({ opts: { session: "0b1c2d3e-aaaa-bbbb-cccc-123456789abc" } });
  expect(await deps.registry.read(lane.key)).toMatchObject({ session: "0b1c2d3e-aaaa-bbbb-cccc-123456789abc", pane: "new:p1" });
});

test("a sandboxed lane replaced on the wrong model is started sandboxed again, resumed session included", async () => {
  const { deps, world, lane, control, clock } = await fixture();
  clock.at = STARTUP_GRACE_MS;
  control.live(true);
  control.argv = ["omo"];
  await deps.registry.write({ ...lane, sandbox: true, session: "0b1c2d3e-aaaa-bbbb-cccc-123456789abc", sessionVia: "argv" });
  const wrapped = { ...deps, config: { ...deps.config, laneSandbox: { command: ["lane-sandbox"] } } };
  expect(await recoverLanes(wrapped)).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-model session-resumed", "STARTUP_OK recover-lane new:p1"]);
  expect(opsOf(world, "start")[0]?.args).toMatchObject({ sandbox: true, session: "0b1c2d3e-aaaa-bbbb-cccc-123456789abc" });
  expect((await deps.registry.read(lane.key))?.sandbox).toBe(true);
});

test.each([
  { name: "missing", setup: (d: Deps) => ({ ...d, which: () => null }), event: "LANE_RECOVERY_ERROR recover-lane sandbox-missing: SANDBOX_MISSING recover-lane: " },
  { name: "broken", setup: (d: Deps, w: World) => { w.sandboxCheck = { code: 3, out: "", err: "lane-sandbox: bwrap not found" }; return d; }, event: "LANE_RECOVERY_ERROR recover-lane sandbox-broken: SANDBOX_BROKEN recover-lane: " },
])("a sandboxed lane whose sandbox is $name is not relaunched: an urgent LANE_RECOVERY_ERROR and a notice in its thread", async ({ setup, event }) => {
  const { deps, world, lane, control, clock } = await fixture();
  clock.at = STARTUP_GRACE_MS;
  control.live(true);
  control.argv = ["omo"];
  await deps.registry.write({ ...lane, sandbox: true });
  const events = await recoverLanes(setup(deps, world));
  expect(events).toHaveLength(1);
  expect(events[0]).toStartWith(event);
  expect(eventClass(events[0]!)).toBe("lead-urgent");
  expect(opsOf(world, "start")).toEqual([]);
  const notices = world.calls.filter((call) => call[0] === "notify");
  expect(notices).toHaveLength(1);
  expect(notices[0]?.[1]).toBe("chat:1");
  expect(notices[0]?.[2]).toStartWith(`[sandbox] ${event.split(": ")[1]}`);
});

test("item 7: a resume that does not start falls back to the brief on the next attempt", async () => {
  const { deps, world, lane, control, clock } = await fixture();
  await deps.registry.write({ ...lane, session: "gone-session" });
  control.startup = { verdict: "error", detail: "Session crashed" };
  const first = await recoverLanes(deps);
  expect(first).toEqual(["STARTUP_ERROR recover-lane new:p1: Session crashed", "LANE_RECOVERY_ERROR recover-lane replacement-unconfirmed; session gone-session not resumed, the next attempt starts from the brief"]);
  expect(await deps.registry.read(lane.key)).toMatchObject({ recoveryResumeFailed: "gone-session" });
  expect((await deps.registry.read(lane.key))?.session).toBeUndefined();
  control.argv = ["omo"];
  control.startup = { verdict: "ok", detail: "ready" };
  clock.at = STARTUP_GRACE_MS;
  await recoverLanes(deps);
  const relaunches = opsOf(world, "recover", "start");
  expect(relaunches).toHaveLength(2);
  expect(relaunches[0]?.args).toMatchObject({ opts: { session: "gone-session" } });
  expect((relaunches[1]?.args as { session?: string }).session).toBeUndefined();
});

test("item 7: resumeCommand puts --session before the prompt, and declines when it cannot resume", () => {
  expect(resumeCommand(["omo", "--model", "{model}", "{prompt}"], "abc")).toEqual(["omo", "--model", "{model}", "--session", "abc", "{prompt}"]);
  expect(resumeCommand(["omo", "--model", "{model}", "{prompt}"], undefined)).toBeUndefined();
  expect(resumeCommand(["omo", "--continue", "{prompt}"], "abc")).toBeUndefined();
  expect(resumeCommand(["omo", "--model", "{model}"], "abc")).toBeUndefined();
  expect(resumeCommand(["omo", "{prompt}"], "--evil")).toBeUndefined();
  expect(resumeCommand(["omo", "{prompt}"], "a b")).toBeUndefined();
});

test.each([{ live: false, reason: "missing-pane" }, { live: true, reason: "missing-model" }])("never relaunches a lane whose PR is merged ($reason); the lane is closed instead", async ({ live, reason }) => {
  const { deps, world, lane, control } = await fixture();
  world.prState = "MERGED";
  if (live) { control.live(true); control.argv = ["omo"]; }
  const events = await recoverLanes(deps, lane.key);
  expect(events).toHaveLength(1);
  expect(events[0]).toStartWith(`LANE_RECOVERY_SKIPPED recover-lane old:p1 ${reason}: every Done signal holds`);
  expect(control.next).toBe(0);
  expect((await deps.registry.read(lane.key))?.recoveryAttempts).toBeUndefined();
  expect(opsOf(world, "recover", "start")).toEqual([]);
  expect(events[0]).toContain("lane closed");
  expect((await deps.registry.read(lane.key))?.status).toBe("closed");
});

test("the supervisor journals a skipped recovery under one id per lane, generation and reason", async () => {
  const { deps, world, lane } = await fixture();
  world.prState = "MERGED";
  const enqueued: [string, string][] = [];
  const enqueue = async (line: string, id: string): Promise<void> => { enqueued.push([id, line]); };
  // The lane is still open on the next sweep (as when its close was refused): the same observation, the same id.
  expect(await recoverLanes(deps, undefined, enqueue)).toEqual([]);
  await deps.registry.write(lane);
  expect(await recoverLanes(deps, undefined, enqueue)).toEqual([]);
  expect(enqueued).toHaveLength(2);
  expect(enqueued[0]?.[1]).toStartWith("LANE_RECOVERY_SKIPPED recover-lane old:p1 missing-pane: every Done signal holds");
  expect(enqueued[1]?.[0]).toBe(enqueued[0]?.[0]);
  // Another generation of the lane is a new observation.
  await deps.registry.write({ ...lane, lastRecoveryAt: 5 } as RecoveryLane);
  await recoverLanes(deps, undefined, enqueue);
  expect(new Set(enqueued.map(([id]) => id)).size).toBe(2);
});

// Captured 10-23 from live omo 5.1.44 panes (herdr process-info argv and the status bar's last lines).
const SONNET = "anthropic-subscription/claude-sonnet-5-5";
const OMO = "/home/dev/.omo/binary-runtime/5.1.44/omo";
const MCP_CHILD = [OMO, "/home/dev/.omo/binary-runtime/5.1.44/plugin/runtime/ast-grep-mcp/cli.js", "mcp"];
const BAR_TAGGED = "/tmp/tmp.isIeWh971Y • CH98.8% • … • 39K/1M (3.9%) (auto)      (anthropic-subscription@default) claude-sonnet-5-5:medium\n(😺 OmO Native by Q Kim)\n";
const BAR_BARE = "…-228 • fix/recovery-never-respawn-a-lane-whose-pr • CH97.5% • 121K/1M (12.1%) (auto) claude-sonnet-5-5:medium\n(😺 OmO Native by Q Kim)\n";
const BAR_EFFORT = "/work/app • CH99.2% • $0.000 • 99K/1M (9.9%) (auto)      (anthropic-subscription@login-2) claude-sonnet-5-5 • effort low (shift+tab)\n(😺 OmO Native by Q Kim) mem:dori-b116e8a6 1m ago\n";

test.each([
  { name: "omo's MCP child listed before the agent", procs: [MCP_CHILD, [OMO, "--model", SONNET, "--thinking", "medium", "prompt"]], screen: "❯ " },
  { name: "a bare --model name", procs: [["omo", "--model", "claude-sonnet-5-5", "prompt"]], screen: "❯ " },
  { name: "restored argv, bar with provider tag", procs: [["omo"], MCP_CHILD], screen: BAR_TAGGED },
  { name: "restored argv, bar without provider tag", procs: [["omo"]], screen: BAR_BARE },
  { name: "restored argv, bar with effort", procs: [["omo"]], screen: BAR_EFFORT },
])("a sonnet lane running its model is left alone: $name", async ({ procs, screen }) => {
  const { deps, world, lane, control } = await fixture();
  await deps.registry.write({ ...lane, model: SONNET });
  control.live(true);
  world.screen = screen;
  const ops: LaneOps = { ...deps.ops, processInfo: async () => ({ code: 0, out: JSON.stringify({ result: { process_info: { foreground_processes: procs.map((p, i) => ({ pid: 40 + i, argv: p })) } } }), err: "" }) };
  expect(await recoverLanes({ ...deps, ops })).toEqual([]);
  expect(opsOf(world, "recover", "start", "close")).toEqual([]);
});

test("a pane whose model is not readable yet is not judged missing-model until the startup grace ends", async () => {
  const { deps, world, lane, control, clock } = await fixture();
  clock.at = 1_000_000;
  await deps.registry.write({ ...lane, openedAt: new Date(clock.at - 15_000).toISOString() });
  control.live(true);
  control.argv = ["omo"];
  expect(await recoverLanes(deps)).toEqual([]);
  expect(opsOf(world, "recover", "start")).toEqual([]);
  clock.at += STARTUP_GRACE_MS;
  expect((await recoverLanes(deps))[0]).toBe("LANE_RECOVERED recover-lane new:p1 missing-model");
});

test.each([
  { name: "argv names another model, even inside the startup grace", argv: [OMO, "--model", "anthropic-subscription/claude-opus-5-5", "prompt"], screen: BAR_TAGGED, fresh: true, reason: "model-mismatch" },
  { name: "argv names the model under another provider", argv: ["omo", "--model", "openai/claude-sonnet-5-5"], screen: "❯ ", fresh: false, reason: "model-mismatch" },
  { name: "restored argv and a bar tagged with another provider", argv: ["omo"], screen: BAR_TAGGED.replace("anthropic-subscription@default", "openai@default"), fresh: false, reason: "missing-model" },
  { name: "restored argv and a bar showing another model", argv: ["omo"], screen: BAR_TAGGED.replace("claude-sonnet-5-5", "claude-opus-5-5"), fresh: false, reason: "missing-model" },
])("a truly different model is still replaced: $name", async ({ argv, screen, fresh, reason }) => {
  const { deps, world, lane, control, clock } = await fixture();
  clock.at = 1_000_000;
  await deps.registry.write({ ...lane, model: SONNET, ...(fresh ? { openedAt: new Date(clock.at - 5_000).toISOString() } : {}) });
  control.live(true);
  control.argv = [...argv];
  world.screen = screen;
  expect((await recoverLanes(deps))[0]).toBe(`LANE_RECOVERED recover-lane new:p1 ${reason}`);
  expect(opsOf(world, "close", "start").map((e) => [e.op, e.key])).toEqual([["close", "recover-lane"], ["start", "recover-lane"]]);
});

const stopped = (world: World, status = "idle"): void => {
  world.panes = [{ pane_id: "old:p1", tab_id: "old:t1", workspace_id: "w", agent: "omo", agent_status: status }];
};
const turn = (over: Partial<TurnEvidence> = {}): TurnEvidence => ({ gen: 1, stop: 1, at: 0, cause: "aborted", hold: "none", continuation: false, ...over });

test("a live agent whose turn was aborted is reported once per stop and never relaunched or retried", async () => {
  const { deps, world, lane } = await fixture();
  stopped(world);
  world.turn = turn();
  const events = await recoverLanes(deps);
  expect(events).toEqual([expect.stringMatching(/^LANE_TURN_INTERRUPTED recover-lane old:p1 gen=1 stop=1 cause=aborted hold=none /)]);
  // The same stopped stretch is not read again; the next turn's stop is, and the same stop is never reported twice.
  expect(await recoverLanes(deps)).toEqual([]);
  stopped(world, "working");
  expect(await recoverLanes(deps)).toEqual([]);
  stopped(world);
  expect(await recoverLanes(deps)).toEqual([]);
  stopped(world, "working");
  await recoverLanes(deps);
  stopped(world);
  world.turn = turn({ stop: 2, cause: "provider-failed", hold: "goal-stopped" });
  expect(await recoverLanes(deps)).toEqual([expect.stringMatching(/^LANE_TURN_INTERRUPTED recover-lane old:p1 gen=1 stop=2 cause=provider-failed hold=goal-stopped /)]);
  expect(opsOf(world, "turn")).toHaveLength(3);
  expect(opsOf(world, "recover", "start", "close", "send", "resume", "pause")).toEqual([]);
  expect(await deps.registry.read(lane.key)).toMatchObject({ pane: "old:p1", turnStopRead: "1:2" });
});

test("a supervisor with enqueue journals the interrupted turn under a stable id before saving the read", async () => {
  const { deps, world } = await fixture();
  stopped(world);
  world.turn = turn();
  const queued: [string, string][] = [];
  expect(await recoverLanes(deps, undefined, async (line, id) => { queued.push([line, id]); })).toEqual([]);
  expect(queued).toEqual([[expect.stringMatching(/^LANE_TURN_INTERRUPTED recover-lane /), expect.stringMatching(/^turn:.*"1:1"/)]]);
});

test.each([
  ["a finished turn", turn({ cause: "finished" })],
  ["an abort the goal resumes by itself", turn({ continuation: true })],
  ["an explicit goal pause", turn({ hold: "goal-paused" })],
  ["a question prompt", turn({ hold: "question" })],
  ["a runner that records no turns", undefined],
])("normal idle says nothing: %s", async (_name, evidence) => {
  const { deps, world } = await fixture();
  stopped(world);
  world.turn = evidence;
  expect(await recoverLanes(deps)).toEqual([]);
  expect(await recoverLanes(deps)).toEqual([]);
  expect(opsOf(world, "turn")).toHaveLength(1);
  expect(opsOf(world, "recover", "start", "close", "send", "resume")).toEqual([]);
});

test("an owner-paused lane with an aborted turn is neither read, reported nor resumed", async () => {
  const { deps, world, lane } = await fixture();
  await deps.registry.write({ ...lane, status: "paused" });
  stopped(world);
  world.turn = turn();
  expect(await recoverLanes(deps)).toEqual([]);
  expect(opsOf(world, "turn", "resume", "send", "recover", "start")).toEqual([]);
});

test("a dead agent is still relaunched through its runner without reading a turn", async () => {
  const { deps, world, lane, control } = await fixture();
  await deps.registry.write({ ...lane, openedAt: new Date(-3 * STARTUP_GRACE_MS).toISOString() });
  shellOnly(world, control);
  world.turn = turn();
  control.duringCreate = async () => { world.panes = world.panes.filter((p) => p.pane_id !== "old:p1"); };
  expect(await recoverLanes(deps)).toEqual(["LANE_RECOVERED recover-lane new:p1 agent-gone", "STARTUP_OK recover-lane new:p1"]);
  expect(opsOf(world, "turn")).toEqual([]);
});

test("a lane the runner cannot observe has no turn to read and gets no recovery error", async () => {
  const { deps, world } = await fixture();
  stopped(world);
  const ops: LaneOps = { ...deps.ops, turn: async () => { world.ops.push({ op: "turn", args: {} }); throw new LaneOpsError("LANE_OP_FAILED", "local", "RUNNER_LANE_UNKNOWN recover-lane"); } };
  expect(await recoverLanes({ ...deps, ops })).toEqual([]);
  expect(await recoverLanes({ ...deps, ops })).toEqual([]);
  expect(opsOf(world, "turn")).toHaveLength(1);
});
