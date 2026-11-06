import { afterEach, expect, test } from "bun:test";

import { deliverLaneMessages } from "../src/ci-follow.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { laneOps } from "../src/lane-ops.ts";
import { openLaneMessages, queueLaneMessage } from "../src/lane-messages.ts";
import { openOperations } from "../src/operations.ts";
import type { Lane } from "../src/registry.ts";
import { RunnerCalls, type RunnerCall } from "../src/runner/call.ts";
import { DEFAULT_POLICY } from "../src/runner/policy.ts";
import type { RunnerEventBodies } from "../src/runner/protocol.ts";
import { commandDispatcher } from "../src/runner/serve.ts";
import type { CommandRecord, RunnerState } from "../src/runner/state.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

// B6: deliverLaneMessages through the REAL commandDispatcher. The runner stores a failed cmdId and replays it, so a
// retry of a definitively failed send needs a new attempt id (op:<operationId>:<attempt>) to reach the effect again.

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = { key: "demo-lane", title: "demo", thread: "discord:111/222", pane: "w:p1", brief: "/b.md", done: "x", cwd: "/repo", openedAt: new Date(T0).toISOString() };
const idle = { pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "idle" };

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

/** The dispatcher's command table in memory: the same recordIntent / recordResult contract as RunnerState. */
const memoryState = (): RunnerState => {
  const rows = new Map<string, CommandRecord>();
  return {
    recordIntent: (intent: Pick<CommandRecord, "cmdId" | "cmdSeq" | "type" | "key" | "epoch">) => {
      const existing = rows.get(intent.cmdId);
      if (existing) return { fresh: false as const, existing };
      rows.set(intent.cmdId, { ...intent, state: "intent", at: T0, updatedAt: T0 });
      return { fresh: true as const };
    },
    recordResult: (cmdId: string, state: "verified" | "failed" | "ambiguous", result: string, value?: CommandRecord["resultValue"]) => {
      const row = rows.get(cmdId);
      if (!row) throw new Error(`no intent for ${cmdId}`);
      rows.set(cmdId, { ...row, state, result, ...(value !== undefined ? { resultValue: value } : {}) });
    },
    observeEpoch: () => {},
    maxEpoch: () => 1,
  } as unknown as RunnerState;
};

type Refuse = "throw" | "verdict";

const setup = async (refuse: Refuse) => {
  const s = withState();
  cleanups.push(s.done);
  const world = newWorld();
  world.panes = [{ ...idle }];
  const base = depsFor(world, fakeClock(T0), s.dir, {});
  await base.registry.update(lane.key, () => lane);

  const effectCmdIds: string[] = [];
  const effectTexts: string[] = [];
  const control = { busy: true };
  const published: RunnerEventBodies["cmd.result"][] = [];
  const waiting = new Map<string, (body: RunnerEventBodies["cmd.result"]) => void>();
  const dispatch = commandDispatcher({
    state: memoryState(), policy: DEFAULT_POLICY, realpath: (p) => p, log: () => {},
    publish: (body) => { published.push(body); waiting.get(body.cmdId)?.(body); },
    effects: {
      "lane.send": async (command) => {
        effectCmdIds.push(command.body.cmdId);
        effectTexts.push(command.body.text);
        if (control.busy && refuse === "throw") throw new Error("input line busy");
        if (control.busy) return { detail: "refused", result: { delivery: "failed", refusal: "input line busy" } };
        return { detail: "typed", result: { delivery: "delivered" } };
      },
    },
  });
  let cmdSeq = 0;
  const call: RunnerCall = {
    connected: () => true,
    query: async () => { throw new Error("no query in this test"); },
    call: async (_label, type, body, opts) => {
      const cmdId = opts?.cmdId ?? `auto:${++cmdSeq}`;
      const answered = new Promise<RunnerEventBodies["cmd.result"]>((resolve) => { waiting.set(cmdId, resolve); });
      dispatch({ v: 1, runner: "local", gen: 1, epoch: 1, cmdSeq: ++cmdSeq, type, body: { cmdId, ...body } });
      const r = await answered;
      return (r.state === "verified" ? r : { cmdId, state: r.state, detail: r.detail }) as never;
    },
  };
  const deps: FlowDeps = { ...base, ops: { ...base.ops, send: laneOps(call, { now: () => T0 }).send } };
  const ops = openOperations(deps.config);
  const messages = openLaneMessages(deps.config);
  cleanups.push(() => { ops.close(); messages.close(); });
  queueLaneMessage(messages, T0, { id: "ci-acme-app-7-abcdef1", lane: lane.key, subject: "acme/app#7@abcdef1", text: "[LEAD] CI is failing" });
  return { deps, ops, messages, control, effectCmdIds, effectTexts, published };
};

// Gate 2 B6-R2: the runner typed the text and recorded it verified, but its cmd.result never reached the supervisor and
// the real RunnerCalls timeout fired. That is an uncertain send, not a refusal: no new attempt id, nothing typed twice.
test("a lane message whose send ran but whose result was lost is never typed again under a new attempt id", async () => {
  const t = await setup("verdict");
  t.control.busy = false;
  let fireTimeout: (() => void) | undefined;
  let dropReply = true;
  const calls: RunnerCalls = new RunnerCalls({
    accept: {
      connected: () => true,
      control: () => true,
      command: (_label: string, type: string, body: unknown) => {
        void dispatch({ v: 1, runner: "local", gen: 1, epoch: 1, cmdSeq: t.published.length + 1, type, body } as never);
        return 1 as never;
      },
    } as never,
    proto: () => undefined,
    now: () => T0,
    timers: { set: (fn) => { fireTimeout = fn; return 1; }, clear: () => {} },
    log: () => {},
  });
  const dispatch = commandDispatcher({
    state: memoryState(), policy: DEFAULT_POLICY, realpath: (p) => p, log: () => {},
    publish: (body) => {
      t.published.push(body);
      if (dropReply) { dropReply = false; fireTimeout?.(); return; }
      calls.onEvent("local", { type: "cmd.result", body } as never);
    },
    effects: {
      "lane.send": async (command) => {
        t.effectCmdIds.push(command.body.cmdId);
        return { detail: "typed", result: { delivery: "delivered" } };
      },
    },
  });
  const deps: FlowDeps = { ...t.deps, ops: { ...t.deps.ops, send: laneOps(calls, { now: () => T0 }).send } };
  const emit = (): void => {};

  await deliverLaneMessages(deps, t.ops, t.messages, emit);
  expect(t.effectCmdIds).toHaveLength(1);
  expect(t.published[0]).toMatchObject({ state: "verified" });
  expect(t.messages.get("ci-acme-app-7-abcdef1")?.blocked ?? "").not.toContain("send failed");

  await deliverLaneMessages(deps, t.ops, t.messages, emit);
  expect(t.effectCmdIds).toHaveLength(1);
});

for (const refuse of ["throw", "verdict"] as const) {
  test(`a lane message refused while the input is busy is delivered on the next pass once it clears (${refuse}), under a new attempt id`, async () => {
    const t = await setup(refuse);
    const emit = (): void => {};
    await deliverLaneMessages(t.deps, t.ops, t.messages, emit);
    expect(t.messages.get("ci-acme-app-7-abcdef1")).toMatchObject({ state: "queued", blocked: expect.stringContaining("send failed") });
    expect(t.effectCmdIds).toHaveLength(1);

    t.control.busy = false;
    await deliverLaneMessages(t.deps, t.ops, t.messages, emit);
    expect(t.effectCmdIds).toHaveLength(2);
    expect(t.effectCmdIds[1]).not.toBe(t.effectCmdIds[0]);
    expect(t.effectCmdIds).toEqual([
      "op:demo-lane/lane-message/ci-acme-app-7-abcdef1:1",
      "op:demo-lane/lane-message/ci-acme-app-7-abcdef1:2",
    ]);
    expect(t.messages.get("ci-acme-app-7-abcdef1")).toMatchObject({ state: "delivered" });

    // Delivered: a further pass types nothing more.
    await deliverLaneMessages(t.deps, t.ops, t.messages, emit);
    expect(t.effectCmdIds).toHaveLength(2);
  });
}
