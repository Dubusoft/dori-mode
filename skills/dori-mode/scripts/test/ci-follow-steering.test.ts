import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ATTEMPT_IN_FLIGHT_MS, deliverLaneMessages, queueSteering } from "../src/ci-follow.ts";
import { claimDone, type FlowDeps, objectDone } from "../src/done-flow.ts";
import { laneOps } from "../src/lane-ops.ts";
import { ackLaneMessage, openLaneMessages } from "../src/lane-messages.ts";
import { openOperations, operationId, plan, settleOperation } from "../src/operations.ts";
import { decisionTargetOf, DECISIONS_FILE, readDecisions } from "../src/decision-store.ts";
import { relayDecisionClose, relayLine, retryDecisionRelays } from "../src/decision-relay.ts";
import { sendToLane } from "../src/lane-send.ts";
import { answeredLine, ownerDecisionTick, type TickDeps } from "../src/owner-decisions.ts";
import { sendVerified } from "../src/panes.ts";
import type { Lane } from "../src/registry.ts";
import type { RunnerCall } from "../src/runner/call.ts";
import { DEFAULT_POLICY } from "../src/runner/policy.ts";
import type { RunnerEventBodies } from "../src/runner/protocol.ts";
import { commandDispatcher } from "../src/runner/serve.ts";
import type { CommandRecord, RunnerState } from "../src/runner/state.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

// Lead steering messages (done-claim notice, objection) through the durable lane message queue, with the REAL
// commandDispatcher and laneOps between the queue and a scripted runner effect.

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "demo-lane", title: "demo", thread: "discord:111/222", pane: "hc:t1", brief: "/b.md", done: "x", cwd: "/repo", openedAt: new Date(T0).toISOString() };
const idle = { pane_id: "hc:t1", workspace_id: "w", agent: "omo", agent_status: "idle" };
const REFUSAL = "pane hc:t1 input line holds other text (or shows no prompt)";
const ID = "not-done-demo-lane-1";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

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

/**
 * The pane as the runner's send sees it: `refuse` throws as runner/lanes.ts does for a pane that did not take the text;
 * `asking` shows a question prompt (runner/lanes.ts refuses a send with refuseWhileAsking and types any other);
 * `unconfirmed` takes the text without the pane confirming it.
 */
type Pane = "refuse" | "take" | "down" | "asking" | "unconfirmed";

const setup = async () => {
  const s = withState();
  cleanups.push(s.done);
  const world = newWorld();
  world.panes = [{ ...idle }];
  const clock = fakeClock(T0);
  const base = depsFor(world, clock, s.dir, {});
  await base.registry.update(lane.key, () => lane);
  const control: { pane: Pane } = { pane: "refuse" };
  const typed: string[] = [];
  const cmdIds: string[] = [];
  const labels: string[] = [];
  const waiting = new Map<string, (body: RunnerEventBodies["cmd.result"]) => void>();
  const dispatch = commandDispatcher({
    state: memoryState(), policy: DEFAULT_POLICY, realpath: (p) => p, log: () => {},
    publish: (body) => { waiting.get(body.cmdId)?.(body); },
    effects: {
      "lane.send": async (command) => {
        cmdIds.push(command.body.cmdId);
        if (control.pane === "refuse") throw new Error(`RUNNER_LANE_SEND_FAILED ${lane.key}: ${REFUSAL}`);
        if (control.pane === "asking" && command.body.refuseWhileAsking) {
          return { detail: "refused asking", result: { delivery: "failed", refusal: `RUNNER_LANE_ASKING ${command.body.key} shows a question prompt; not typed` } };
        }
        typed.push(command.body.text);
        return { detail: "typed", result: { delivery: control.pane === "unconfirmed" ? "unconfirmed" : "delivered" } };
      },
    },
  });
  let cmdSeq = 0;
  const call: RunnerCall = {
    connected: () => control.pane !== "down",
    query: async () => { throw new Error("no query in this test"); },
    call: async (label, type, body, opts) => {
      labels.push(label);
      if (control.pane === "down") throw Object.assign(new Error("RUNNER_UNAVAILABLE runner=local disconnected"), { code: "RUNNER_UNAVAILABLE", label: "local", why: "disconnected" });
      const cmdId = opts?.cmdId ?? `auto:${++cmdSeq}`;
      const answered = new Promise<RunnerEventBodies["cmd.result"]>((resolve) => { waiting.set(cmdId, resolve); });
      dispatch({ v: 1, runner: "local", gen: 1, epoch: 1, cmdSeq: ++cmdSeq, type, body: { cmdId, ...body } });
      const r = await answered;
      return (r.state === "verified" ? r : { cmdId, state: r.state, detail: r.detail }) as never;
    },
  };
  const deps: FlowDeps = { ...base, ops: { ...base.ops, send: laneOps(call, { now: clock.now }).send } };
  const ops = openOperations(deps.config);
  const messages = openLaneMessages(deps.config);
  cleanups.push(() => { ops.close(); messages.close(); });
  const events: string[] = [];
  const pass = (): Promise<void> => deliverLaneMessages(deps, ops, messages, (_id, line) => { events.push(line); });
  return { world, clock, deps, ops, messages, control, typed, cmdIds, labels, events, pass };
};

test("a steering message refused while the lane's input line is busy stays queued and is typed once it clears; the ack closes it", async () => {
  const t = await setup();
  queueSteering(t.messages, T0, lane, { id: ID, subject: "demo-lane done status", text: "[LEAD] not done: read dori lane status demo-lane" });
  await t.pass();
  expect(t.messages.get(ID)).toMatchObject({ state: "queued", blocked: `send failed (pane hc:t1 idle): RUNNER_CMD_FAILED RUNNER_LANE_SEND_FAILED demo-lane: ${REFUSAL}` });
  expect(t.typed).toEqual([]);

  t.control.pane = "take";
  t.clock.at += MIN;
  await t.pass();
  expect(t.messages.get(ID)?.state).toBe("delivered");
  expect(t.typed).toEqual([`[LEAD] not done: read dori lane status demo-lane. Confirm you got this message: dori report ack ${ID}`]);

  ackLaneMessage(t.messages, lane.key, ID, t.clock.now());
  t.clock.at += 30 * MIN;
  await t.pass();
  expect(t.typed).toHaveLength(1);
  expect(t.events).toEqual([]);
});

test("a steering message sent while the lane's runner is disconnected is typed after it reconnects, under a new attempt id", async () => {
  const t = await setup();
  t.control.pane = "down";
  queueSteering(t.messages, T0, lane, { id: ID, subject: "demo-lane done status", text: "[LEAD] not done" });
  await t.pass();
  expect(t.messages.get(ID)?.state).toBe("queued");
  expect(t.messages.get(ID)?.blocked).toContain("RUNNER_UNAVAILABLE");

  t.control.pane = "take";
  t.clock.at += MIN;
  await t.pass();
  expect(t.messages.get(ID)?.state).toBe("delivered");
  expect(t.typed).toHaveLength(1);
  expect(t.cmdIds).toEqual([`op:demo-lane/lane-message/${ID}:2`]);
});

test("a send that may have been typed before a crash is never typed again: left alone while in flight, ambiguous once stale", async () => {
  const t = await setup();
  t.control.pane = "take";
  queueSteering(t.messages, T0, lane, { id: ID, subject: "demo-lane done status", text: "[LEAD] not done" });
  const opId = operationId({ lane: lane.key, action: "lane-message", target: ID });
  plan(t.ops, T0, { lane: lane.key, action: "lane-message", target: ID });
  settleOperation(t.ops, T0, opId, "attempted", "attempted");

  // Another process's attempt still within ATTEMPT_IN_FLIGHT_MS: not reconciled under it, nothing typed.
  await t.pass();
  expect(t.ops.get(opId)?.state).toBe("attempted");
  expect(t.cmdIds).toEqual([]);

  // Past it the attempt was interrupted: its read-back cannot tell, so the message is never retyped.
  t.clock.at += ATTEMPT_IN_FLIGHT_MS;
  await t.pass();
  expect(t.ops.get(opId)?.state).toBe("ambiguous");
  expect(t.messages.get(ID)).toMatchObject({ state: "queued", blocked: "an interrupted delivery may or may not have been typed; not retyped" });
  t.clock.at += 30 * MIN;
  await t.pass();
  expect(t.cmdIds).toEqual([]);
  expect(t.typed).toEqual([]);
  expect(t.events).toEqual([`LANE_MESSAGE_UNCONFIRMED demo-lane ${ID} not delivered: an interrupted delivery may or may not have been typed; not retyped after 20 min; about demo-lane done status`]);
});

test("a pane that never shows a prompt gets one LANE_MESSAGE_UNCONFIRMED naming the message, the pane and the refusal; the message stays queued", async () => {
  const t = await setup();
  queueSteering(t.messages, T0, lane, { id: ID, subject: "demo-lane done status", text: "[LEAD] not done" });
  for (let i = 0; i < 6; i++) {
    await t.pass();
    t.clock.at += 10 * MIN;
  }
  expect(t.typed).toEqual([]);
  expect(t.cmdIds.length).toBeGreaterThan(1);
  expect(t.events).toEqual([
    `LANE_MESSAGE_UNCONFIRMED demo-lane ${ID} not delivered: send failed (pane hc:t1 idle): RUNNER_CMD_FAILED RUNNER_LANE_SEND_FAILED demo-lane: ${REFUSAL} after 20 min; about demo-lane done status`,
  ]);
  expect(t.messages.get(ID)).toMatchObject({ state: "queued", escalatedAt: expect.any(Number) });
  expect(t.ops.get(operationId({ lane: lane.key, action: "lane-message", target: ID }))?.state).toBe("failed");
});

test("an objection refused by the pane is kept and delivered by a later pass; it replaces the claim notice still open", async () => {
  const t = await setup();
  await claimDone(t.deps, lane, "merged acme/app#1");
  const notice = `claim-demo-lane-${T0}`;
  expect(t.messages.get(notice)).toMatchObject({ state: "queued", whileWorking: true });

  t.clock.at += MIN;
  await objectDone(t.deps, (await t.deps.registry.read(lane.key)) ?? lane, ["tests red"]);
  const objection = `not-done-demo-lane-${T0 + MIN}`;
  expect(t.messages.get(notice)).toMatchObject({ state: "superseded", blocked: `replaced by ${objection}` });
  expect(t.messages.get(objection)?.state).toBe("queued");
  expect(t.typed).toEqual([]);

  t.control.pane = "take";
  t.clock.at += MIN;
  await t.pass();
  expect(t.messages.get(objection)?.state).toBe("delivered");
  expect(t.typed).toHaveLength(1);
  expect(t.typed[0]).toStartWith("[LEAD] not done: the Done check of demo-lane did not pass.");
});

test("sendVerified names why a pane did not take the text: other text in its input line, or no prompt", async () => {
  const t = await setup();
  for (const screen of ["\u276f the owner's half-typed line", "vim: some file"]) {
    t.world.screen = screen;
    const why: string[] = [];
    expect(await sendVerified(t.deps.run, t.clock, "hc:t1", "[LEAD] hello", true, (w) => { why.push(w); })).toBe("failed");
    expect(why).toEqual([REFUSAL]);
  }
  expect(t.world.calls.filter((c) => c[2] === "send-text")).toEqual([]);
});

/** decisions.json holding lane decision d1 of `key`, closed by the lead with choice 2, and an optional direct answer r1. */
const closedDecision = (stateDir: string, key: string, extra: Record<string, unknown> = {}): void => {
  writeFileSync(join(stateDir, DECISIONS_FILE), JSON.stringify({ nextSeq: 2, decisions: [{
    id: "d1", state: "closed", source: "lane", lane: key, channel: "555", thread: "1000", question: "Which store?", options: ["sqlite", "json"], recommend: 1,
    reason: "r", waiting: "w", blocking: true, openedAt: T0, closedAt: T0, choice: 2, closeText: "Use json; keep the old file", ...extra,
  }] }));
};

const tickDeps = (t: Awaited<ReturnType<typeof setup>>, enqueued: string[]): TickDeps => ({
  config: t.deps.config, now: t.clock.now, home: "/home/x", enqueue: (_id, line) => { enqueued.push(line); },
  transport: new Proxy({}, { get: () => { throw new Error("no Discord in this test"); } }) as TickDeps["transport"],
});

test("closing a lane's decision types the close text into that lane once and prints DECISION_RELAYED", async () => {
  const t = await setup();
  t.control.pane = "take";
  closedDecision(t.deps.config.stateDir, lane.key);
  const d = await relayDecisionClose(t.deps, readDecisions(t.deps.config.stateDir).decisions[0] as never);
  expect(t.typed).toEqual(["[LEAD] Answer to your question d1 (Which store?). Choice 2. json. Use json; keep the old file. Confirm you got this message: dori report ack decision-close-d1"]);
  expect(t.labels).toEqual(["local"]);
  expect(relayLine(d)).toStartWith("DECISION_RELAYED demo-lane d1 decision-close-d1");
  expect(await relayDecisionClose(t.deps, d)).toBe(d);
  expect(t.typed).toHaveLength(1);
});

test("a remote lane gets the close text through its machine's runner, with the runner's dori in the ack line", async () => {
  const t = await setup();
  t.control.pane = "take";
  const remote: Lane = { ...lane, key: "mac-lane", machine: "mac-mini" };
  await t.deps.registry.update(remote.key, () => remote);
  closedDecision(t.deps.config.stateDir, remote.key, { kind: "request", options: [], choice: undefined, closeText: "The code is in ~/in/code.txt" });
  const d = await relayDecisionClose(t.deps, readDecisions(t.deps.config.stateDir).decisions[0] as never);
  expect(t.labels).toEqual(["mac-mini"]);
  expect(t.typed).toEqual(["[LEAD] Answer to your request d1 (Which store?). The code is in ~/in/code.txt. Confirm you got this message: ~/.dori/runner/bin/dori report ack decision-close-d1"]);
  expect(d.relay?.state).toBe("relayed");
});

test("dori lane send types the lead's text once into a local and a remote lane through their runners and prints LANE_SEND_DELIVERED", async () => {
  const t = await setup();
  t.control.pane = "take";
  const local = await sendToLane(t.deps, lane, "rebase onto dev,\n then push");
  const id = `lane-send-demo-lane-${T0}`;
  expect(local).toEqual({ ok: true, line: `LANE_SEND_DELIVERED demo-lane ${id}: the lane confirms with dori report ack ${id}` });
  expect(t.messages.get(id)).toMatchObject({ state: "delivered", refuseWhileAsking: true });

  const remote: Lane = { ...lane, key: "mac-lane", machine: "mac-mini" };
  await t.deps.registry.update(remote.key, () => remote);
  t.clock.at += MIN;
  expect((await sendToLane(t.deps, remote, "[LEAD] stop and wait")).line).toStartWith("LANE_SEND_DELIVERED mac-lane");
  expect(t.labels).toEqual(["local", "mac-mini"]);
  expect(t.typed).toEqual([
    `[LEAD] rebase onto dev, then push. Confirm you got this message: dori report ack ${id}`,
    `[LEAD] stop and wait. Confirm you got this message: ~/.dori/runner/bin/dori report ack lane-send-mac-lane-${T0 + MIN}`,
  ]);
});

test("dori lane send to a lane showing a question prompt is refused, types nothing and is never typed by a later pass; other steering still is", async () => {
  const t = await setup();
  t.control.pane = "asking";
  const sent = await sendToLane(t.deps, lane, "hello");
  const id = `lane-send-demo-lane-${T0}`;
  expect(sent.ok).toBe(false);
  expect(sent.line).toStartWith(`LANE_SEND_REFUSED demo-lane ${id}: send failed (pane hc:t1 idle): `);
  expect(sent.line).toContain("RUNNER_LANE_ASKING demo-lane shows a question prompt");
  expect(t.messages.get(id)?.state).toBe("superseded");
  queueSteering(t.messages, T0, lane, { id: ID, subject: "demo-lane done status", text: "[LEAD] not done" });
  t.control.pane = "take";
  t.clock.at += 30 * MIN;
  await t.pass();
  expect(t.typed).toEqual([`[LEAD] not done. Confirm you got this message: dori report ack ${ID}`]);
});

test("dori lane send prints LANE_SEND_UNCONFIRMED when the pane does not confirm it took the text, and LANE_SEND_FAILED when the runner is away", async () => {
  const t = await setup();
  t.control.pane = "unconfirmed";
  expect((await sendToLane(t.deps, lane, "hi")).line).toStartWith(`LANE_SEND_UNCONFIRMED demo-lane lane-send-demo-lane-${T0}: typed`);
  t.control.pane = "down";
  t.clock.at += MIN;
  const failed = await sendToLane(t.deps, lane, "hi");
  expect(failed.ok).toBe(false);
  expect(failed.line).toStartWith(`LANE_SEND_FAILED demo-lane lane-send-demo-lane-${T0 + MIN}: `);
  expect(t.typed).toHaveLength(1);
});

test("a close text the pane keeps refusing is retried, never typed by the general pass, and wakes the lead once after the last attempt", async () => {
  const t = await setup();
  closedDecision(t.deps.config.stateDir, lane.key);
  const d = await relayDecisionClose(t.deps, readDecisions(t.deps.config.stateDir).decisions[0] as never);
  expect(t.typed).toEqual([]);
  expect(relayLine(d)).toStartWith(`DECISION_RELAY_RETRYING demo-lane d1: send failed (pane hc:t1 idle): RUNNER_CMD_FAILED RUNNER_LANE_SEND_FAILED demo-lane: ${REFUSAL}; the supervisor tries again (attempt 1 of 3)`);
  expect(t.messages.get("decision-close-d1")?.state).toBe("superseded");
  const enqueued: string[] = [];
  await ownerDecisionTick(tickDeps(t, enqueued));
  expect(enqueued).toEqual([]);
  // Between attempts the message stays superseded, so the lane message pass does not type it on its own.
  t.control.pane = "take";
  t.clock.at += 30 * MIN;
  await t.pass();
  expect(t.typed).toEqual([]);

  t.control.pane = "refuse";
  const sends = t.cmdIds.length;
  expect(await retryDecisionRelays(t.deps)).toHaveLength(1);
  expect(await retryDecisionRelays(t.deps)).toEqual([]);
  t.clock.at += MIN;
  const [last] = await retryDecisionRelays(t.deps);
  expect(last?.relay).toMatchObject({ state: "failed", attempts: 3 });
  expect(t.cmdIds.length - sends).toBe(2);
  t.clock.at += 30 * MIN;
  expect(await retryDecisionRelays(t.deps)).toEqual([]);
  await ownerDecisionTick(tickDeps(t, enqueued));
  await ownerDecisionTick(tickDeps(t, enqueued));
  expect(enqueued).toEqual([String(relayLine(last as never))]);
  expect(enqueued[0]).toStartWith("DECISION_RELAY_FAILED demo-lane d1: send failed");
  expect(enqueued[0]).toContain("after 3 attempts");
  expect(t.typed).toEqual([]);
});

test("a close text the pane refused once is typed once by the supervisor's retry, and no DECISION_RELAY_FAILED is raised", async () => {
  const t = await setup();
  closedDecision(t.deps.config.stateDir, lane.key);
  await relayDecisionClose(t.deps, readDecisions(t.deps.config.stateDir).decisions[0] as never);
  t.control.pane = "take";
  t.clock.at += MIN;
  const [d] = await retryDecisionRelays(t.deps);
  expect(d?.relay).toMatchObject({ state: "relayed", attempts: 2, message: "decision-close-d1" });
  expect(relayLine(d as never)).toStartWith("DECISION_RELAYED demo-lane d1 decision-close-d1");
  expect(t.messages.get("decision-close-d1")?.state).toBe("delivered");
  t.clock.at += 30 * MIN;
  expect(await retryDecisionRelays(t.deps)).toEqual([]);
  await t.pass();
  const enqueued: string[] = [];
  await ownerDecisionTick(tickDeps(t, enqueued));
  expect(enqueued.filter((line) => line.startsWith("DECISION_RELAY"))).toEqual([]);
  expect(t.typed).toEqual(["[LEAD] Answer to your question d1 (Which store?). Choice 2. json. Use json; keep the old file. Confirm you got this message: dori report ack decision-close-d1"]);
});

test("an answer that already reached the lane directly is not relayed again; a lead decision relays only with --relay-to", async () => {
  const t = await setup();
  t.control.pane = "take";
  const revision = { rev: 1, channel: "1000", message: "m1", edit: 0, hash: "h", choice: 2, target: decisionTargetOf(lane), at: T0, delivery: { id: "decision-d1-r1", state: "queued", updatedAt: T0 } };
  closedDecision(t.deps.config.stateDir, lane.key, { revisions: [revision] });
  t.messages.put({ id: "decision-d1-r1", lane: lane.key, subject: "decision:d1", text: "[dori] Owner answered d1", state: "delivered", at: T0, updatedAt: T0 });
  const d = await relayDecisionClose(t.deps, readDecisions(t.deps.config.stateDir).decisions[0] as never);
  expect(relayLine(d)).toBe("DECISION_RELAY_SKIPPED demo-lane d1: the owner's answer r1 already reached the lane directly");
  expect(t.typed).toEqual([]);

  // The lead settled on another option (a button press it took over): the lane gets that one.
  closedDecision(t.deps.config.stateDir, lane.key, { revisions: [{ ...revision, choice: 1 }] });
  const other = await relayDecisionClose(t.deps, readDecisions(t.deps.config.stateDir).decisions[0] as never);
  expect(other.relay?.state).toBe("relayed");
  expect(t.typed).toEqual(["[LEAD] Answer to your question d1 (Which store?). Choice 2. json. Use json; keep the old file. Confirm you got this message: dori report ack decision-close-d1"]);
  t.typed.length = 0;

  closedDecision(t.deps.config.stateDir, lane.key, { source: "lead" });
  const lead = await relayDecisionClose(t.deps, readDecisions(t.deps.config.stateDir).decisions[0] as never);
  expect(relayLine(lead)).toStartWith("DECISION_RELAY_SKIPPED demo-lane d1: the lead opened this decision without --relay-to");
  expect(t.typed).toEqual([]);

  // Another decision: d1's close message is already delivered, and the same id is never typed again.
  closedDecision(t.deps.config.stateDir, lane.key, { id: "d2", source: "lead", relayTo: lane.key });
  const relayTo = await relayDecisionClose(t.deps, readDecisions(t.deps.config.stateDir).decisions[0] as never);
  expect(relayLine(relayTo)).toStartWith("DECISION_RELAYED demo-lane d2 decision-close-d2");
  expect(t.typed).toEqual(["[LEAD] Answer to your question d2 (Which store?). Choice 2. json. Use json; keep the old file. Confirm you got this message: dori report ack decision-close-d2"]);
});

test("OWNER_DECISION_ANSWERED says the same thing for a lane's decision and request: the close types --text into the lane", () => {
  const base = { id: "d1", state: "answered", source: "lane", lane: "demo-lane", channel: "555", thread: "1000", question: "q", options: ["a", "b"], recommend: 1,
    reason: "r", waiting: "w", blocking: true, openedAt: T0, answers: [{ channel: "1000", message: "m1", at: T0 }] } as const;
  const tail = (line: string): string => line.slice(line.indexOf("; run dori decision close"));
  const decision = answeredLine(base);
  const request = answeredLine({ ...base, kind: "request", options: [] });
  expect(tail(decision)).toBe(tail(request));
  expect(tail(decision)).toContain("types --text into lane demo-lane");
});

/** decisions.json holding lane decision d1 whose answer r1 (decision-d1-r1) is queued for `target`. */
const queuedAnswer = (stateDir: string, target: ReturnType<typeof decisionTargetOf>): void => {
  const revision = { rev: 1, channel: "1000", message: "m1", edit: 0, hash: "h", choice: 1, target, at: T0, delivery: { id: "decision-d1-r1", state: "queued", updatedAt: T0 } };
  writeFileSync(join(stateDir, DECISIONS_FILE), JSON.stringify({ nextSeq: 2, decisions: [{
    id: "d1", state: "open", source: "lane", lane: lane.key, channel: "555", thread: "1000", question: "Which?", options: ["a", "b"], recommend: 1,
    reason: "r", waiting: "w", blocking: true, openedAt: T0, target, revisions: [revision],
  }] }));
};

test("a direct decision answer is typed only into the lane session that asked; a relaunched lane's copy is superseded untyped", async () => {
  const t = await setup();
  t.control.pane = "take";
  queuedAnswer(t.deps.config.stateDir, decisionTargetOf(lane));
  t.messages.put({ id: "decision-d1-r1", lane: lane.key, subject: "decision:d1", text: "[dori] Owner answered d1", state: "queued", at: T0, updatedAt: T0 });
  await t.pass();
  expect(t.messages.get("decision-d1-r1")?.state).toBe("delivered");
  expect(t.typed).toEqual(["[dori] Owner answered d1"]);

  queuedAnswer(t.deps.config.stateDir, { ...decisionTargetOf(lane), generation: 7 });
  t.messages.put({ id: "decision-d1-r1", lane: lane.key, subject: "decision:d1", text: "[dori] Owner answered d1", state: "queued", at: T0, updatedAt: T0 });
  await t.pass();
  expect(t.messages.get("decision-d1-r1")).toMatchObject({ state: "superseded", blocked: "lane demo-lane was relaunched, replaced or moved" });
  expect(t.typed).toHaveLength(1);
});
