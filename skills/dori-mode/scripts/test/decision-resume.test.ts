import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { resumeAnsweredGoals } from "../src/decision-resume.ts";
import { DECISIONS_FILE, type OwnerDecision, readDecisions } from "../src/decision-store.ts";
import { ackLaneMessage, openLaneMessages, queueLaneMessage } from "../src/lane-messages.ts";
import type { Lane } from "../src/registry.ts";
import type { TurnEvidence } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const lane: Lane = { key: "ask-lane", title: "ask", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
const target = { lane: "ask-lane", runner: "local", generation: 0 };
const decision = (patch: Partial<OwnerDecision> = {}): OwnerDecision => ({
  id: "d1", state: "open", source: "lane", lane: "ask-lane", blocking: true, channel: "decisions", openedAt: T0 + MIN,
  question: "which way", options: ["a", "b"], recommend: 1, reason: "r", waiting: "the plan", target, ...patch,
} as OwnerDecision);
const decisions = (...list: OwnerDecision[]) => writeFileSync(join(state.dir, DECISIONS_FILE), JSON.stringify({ nextSeq: list.length + 1, decisions: list }));
const relayed = decision({ state: "closed", closedAt: T0 + 30 * MIN, relay: { state: "relayed", lane: "ask-lane", at: T0 + 30 * MIN } });
const answer = (state: "queued" | "acked"): OwnerDecision => decision({
  state: "answered", revisions: [{ rev: 1, channel: "c", message: "m", edit: 0, hash: "h", choice: 1, target, at: T0 + 20 * MIN, delivery: { id: "decision-d1-r1", state, updatedAt: T0 + 20 * MIN } }],
});
const parked = (hold: TurnEvidence["hold"] = "goal-blocked"): TurnEvidence => ({ gen: 1, stop: 2, at: T0, cause: "finished", hold, continuation: false });
const idle = () => { world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "idle" }]; };
const resumes = () => world.ops.filter((o) => o.op === "resume").map((o) => o.key);

for (const [name, answered] of [["its close text was relayed", relayed], ["its direct answer was acked", answer("acked")]] as const) {
  test(`a lane idle on a goal parked for its ask gets /goal resume once ${name}`, async () => {
    await deps(T0).registry.write(lane);
    idle();
    world.turn = parked();
    decisions(answered);
    expect(await resumeAnsweredGoals(deps(T0 + 40 * MIN))).toEqual(["GOAL_RESUMED ask-lane d1 answered: its parked goal is active again"]);
    expect(resumes()).toEqual(["ask-lane"]);
    expect(readDecisions(state.dir).decisions[0]?.goalResume).toEqual({ at: T0 + 40 * MIN, outcome: "resumed" });
    expect(await resumeAnsweredGoals(deps(T0 + 41 * MIN))).toEqual([]);
    expect(resumes()).toEqual(["ask-lane"]);
  });
}

test("nothing is resumed while the ask still waits, its direct answer is only queued, or its close text was not typed in", async () => {
  await deps(T0).registry.write(lane);
  idle();
  world.turn = parked();
  for (const d of [decision(), answer("queued"), decision({ state: "closed", closedAt: T0 + 30 * MIN, relay: { state: "failed", lane: "ask-lane", at: T0 + 30 * MIN } })]) {
    decisions(d);
    expect(await resumeAnsweredGoals(deps(T0 + 40 * MIN))).toEqual([]);
  }
  expect(resumes()).toEqual([]);
});

test("the resume waits for the answer turn to end, and a goal that is not blocked then is left alone", async () => {
  await deps(T0).registry.write(lane);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
  world.turn = parked();
  decisions(relayed);
  expect(await resumeAnsweredGoals(deps(T0 + 31 * MIN))).toEqual([]);
  idle();
  world.turn = parked("none");
  expect(await resumeAnsweredGoals(deps(T0 + 40 * MIN))).toEqual([]);
  expect(readDecisions(state.dir).decisions[0]?.goalResume?.outcome).toBe("not parked (none)");
  world.turn = parked();
  expect(await resumeAnsweredGoals(deps(T0 + 50 * MIN))).toEqual([]);
  expect(resumes()).toEqual([]);
});

test("a lane that parked again on a new ask is not resumed until that one is answered too", async () => {
  await deps(T0).registry.write(lane);
  idle();
  world.turn = parked();
  decisions(relayed, decision({ id: "d2", openedAt: T0 + 35 * MIN }));
  expect(await resumeAnsweredGoals(deps(T0 + 40 * MIN))).toEqual([]);
  decisions(relayed, decision({ id: "d2", openedAt: T0 + 35 * MIN, state: "closed", closedAt: T0 + 50 * MIN, relay: { state: "relayed", lane: "ask-lane", at: T0 + 50 * MIN } }));
  expect(await resumeAnsweredGoals(deps(T0 + 51 * MIN))).toEqual(["GOAL_RESUMED ask-lane d1,d2 answered: its parked goal is active again"]);
});

test("an unconfirmed /goal resume is reported once for the lead", async () => {
  await deps(T0).registry.write(lane);
  idle();
  world.turn = parked();
  world.resumeResult = { goal: "unconfirmed" };
  decisions(relayed);
  const [line] = await resumeAnsweredGoals(deps(T0 + 40 * MIN));
  expect(line).toStartWith("GOAL_RESUME_FAILED ask-lane d1 answered, but /goal resume was unconfirmed");
  expect(await resumeAnsweredGoals(deps(T0 + 41 * MIN))).toEqual([]);
});

/** A `dori lane send` to the lane, acked by it at `at`. */
const laneSend = (text: string, at: number) => {
  const store = openLaneMessages({ stateDir: state.dir });
  try {
    const id = `lane-send-ask-lane-${at}`;
    queueLaneMessage(store, at - MIN, { id, lane: "ask-lane", subject: id, text, whileWorking: true });
    ackLaneMessage(store, "ask-lane", id, at);
  } finally { store.close(); }
};

test("a close whose text is not typed in yet resumes nothing and is not used up; its relay does", async () => {
  await deps(T0).registry.write(lane);
  idle();
  world.turn = parked();
  decisions(decision({ state: "closed", closedAt: T0 + 30 * MIN }));
  expect(await resumeAnsweredGoals(deps(T0 + 30 * MIN))).toEqual([]);
  expect(readDecisions(state.dir).decisions[0]?.goalResume).toBeUndefined();
  decisions(relayed);
  expect(await resumeAnsweredGoals(deps(T0 + 40 * MIN))).toEqual(["GOAL_RESUMED ask-lane d1 answered: its parked goal is active again"]);
  expect(resumes()).toEqual(["ask-lane"]);
});

test("the lead's dori lane send naming the ask resumes it once the lane acks it, for an open ask and after DECISION_RELAY_FAILED", async () => {
  await deps(T0).registry.write(lane);
  idle();
  world.turn = parked();
  decisions(decision());
  laneSend("[LEAD] unrelated steering", T0 + 10 * MIN);
  expect(await resumeAnsweredGoals(deps(T0 + 20 * MIN))).toEqual([]);
  laneSend("[LEAD] answer to d1: take option a", T0 + 25 * MIN);
  expect(await resumeAnsweredGoals(deps(T0 + 30 * MIN))).toEqual(["GOAL_RESUMED ask-lane d1 answered: its parked goal is active again"]);
  decisions(decision({ id: "d2", openedAt: T0 + 40 * MIN, state: "closed", closedAt: T0 + 50 * MIN, relay: { state: "failed", lane: "ask-lane", at: T0 + 52 * MIN, attempts: 3, reportedAt: T0 + 52 * MIN } }));
  expect(await resumeAnsweredGoals(deps(T0 + 55 * MIN))).toEqual([]);
  laneSend("[LEAD] d2: go with b", T0 + 60 * MIN);
  expect(await resumeAnsweredGoals(deps(T0 + 61 * MIN))).toEqual(["GOAL_RESUMED ask-lane d2 answered: its parked goal is active again"]);
  expect(resumes()).toEqual(["ask-lane", "ask-lane"]);
});
