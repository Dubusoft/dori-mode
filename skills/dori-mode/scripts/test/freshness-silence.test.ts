import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DECISIONS_FILE, type OwnerDecision } from "../src/decision-store.ts";
import { freshnessTick, sweepActLine } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
// A live omo pane with an in-progress Todo item: it must no longer be relayed to the thread.
const WITH_TODO = readFileSync(new URL("./fixtures/omo-working-todo.txt", import.meta.url), "utf8");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const lane: Lane = { key: "busy-lane", title: "busy", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const deps = (ms: number, hooks = true) => depsFor(world, fakeClock(ms), state.dir, hooks ? { hooks: { threadReply: ["notify", "{thread}", "{text}"] } } : {});
const posts = () => world.calls.filter((c) => c[0] === "notify").map((c) => c[2] ?? "");

for (const [name, screen, hooks] of [
  ["a pane with a Todo item", WITH_TODO, true],
  ["a pane without a Todo item", "thinking hard\n❯ ", true],
  ["no threadReply hook", WITH_TODO, false],
] as const) {
  test(`a working silent lane (${name}) gets no-progress once per silence, never a thread post or a nudge`, async () => {
    await deps(T0).registry.write(lane);
    world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
    world.screen = screen;
    expect(await freshnessTick(deps(T0 + 10 * MIN, hooks))).toEqual([]);
    expect((await freshnessTick(deps(T0 + 16 * MIN, hooks))).map((a) => a.kind)).toEqual(["no-progress"]);
    expect(await freshnessTick(deps(T0 + 17 * MIN, hooks))).toEqual([]);
    expect(await freshnessTick(deps(T0 + 40 * MIN, hooks))).toEqual([]);
    expect(posts()).toEqual([]);
    expect(sent(world)).toEqual([]);
  });
}

test("a done-claimed lane idle and silent while its PR waits for the supervisor's merge is never nudged, flagged or escalated", async () => {
  const at = new Date(T0).toISOString();
  await deps(T0).registry.write({ ...lane, status: "done-claimed", claim: { at, evidence: "PR green", emitted: true, pulls: [] } });
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "idle" }];
  for (const min of [16, 50, 120, 300]) expect(await freshnessTick(deps(T0 + min * MIN))).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect(posts()).toEqual([]);
});

test("an idle silent lane is still nudged, and nothing is posted from its pane", async () => {
  await deps(T0).registry.write(lane);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "idle" }];
  world.screen = WITH_TODO;
  expect((await freshnessTick(deps(T0 + 16 * MIN))).map((a) => a.kind)).toEqual(["nudged"]);
  expect(sent(world)).toHaveLength(1);
  expect(posts()).toEqual([]);
});

test("a lane whose status read throws is one warning, and the lanes after it are still nudged", async () => {
  const broken: Lane = { ...lane, key: "broken-lane", pane: "w:p6" };
  await deps(T0).registry.write(broken);
  await deps(T0).registry.write(lane);
  world.panes = ["w:p6", "w:p7"].map((pane_id) => ({ pane_id, workspace_id: "w", agent: "omo", agent_status: "idle" }));
  const base = deps(T0 + 16 * MIN);
  // The lane the tick reads first throws, so the other one comes after it.
  const [first, after] = await base.registry.open();
  const ops: typeof base.ops = { ...base.ops, status: async (ref) => {
    if (ref.pane === first?.pane) throw new Error("runner read failed");
    return base.ops.status(ref);
  } };
  const acts = await freshnessTick({ ...base, ops });
  expect(acts.map(sweepActLine)).toEqual([`SWEEP_WARN freshness ${first?.key} runner read failed`, expect.stringMatching(new RegExp(`^NUDGED ${after?.key} 16 min silent`))]);
  expect(sent(world)).toHaveLength(1);
});

test("a registry row with the removed progress fields still loads and does not change the outcome", async () => {
  await deps(T0).registry.write({ ...lane, lastProgressPost: "old todo", lastProgressAt: T0, lastProgressError: "HTTP 503" });
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
  world.screen = WITH_TODO;
  expect((await freshnessTick(deps(T0 + 16 * MIN))).map((a) => a.kind)).toEqual(["no-progress"]);
  expect(posts()).toEqual([]);
});

const decision = (patch: Partial<OwnerDecision> = {}): OwnerDecision => ({
  id: "d1", state: "open", source: "lane", lane: "busy-lane", blocking: true, channel: "decisions", openedAt: T0 + MIN,
  question: "which way", options: ["a", "b"], recommend: 1, reason: "r", ...patch,
} as OwnerDecision);
const decisions = (...list: OwnerDecision[]) => writeFileSync(join(state.dir, DECISIONS_FILE), JSON.stringify({ nextSeq: list.length + 1, decisions: list }));

for (const agent_status of ["idle", "working"] as const) {
  test(`${agent_status === "idle" ? "an" : "a"} ${agent_status} lane waiting on its blocking question is not nudged, flagged or escalated, and its silence counts from the close`, async () => {
    await deps(T0).registry.write(lane);
    world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status }];
    decisions(decision());
    for (const min of [16, 50, 120, 300]) expect(await freshnessTick(deps(T0 + min * MIN))).toEqual([]);
    decisions(decision({ state: "closed", closedAt: T0 + 300 * MIN }));
    expect(await freshnessTick(deps(T0 + 314 * MIN))).toEqual([]);
    expect((await freshnessTick(deps(T0 + 316 * MIN))).map((a) => a.kind)).toEqual([agent_status === "idle" ? "nudged" : "no-progress"]);
    expect(sent(world)).toHaveLength(agent_status === "idle" ? 1 : 0);
  });
}

test("a nonblocking question, another lane's question or one asked before the lane's recovery leaves the nudge as it was", async () => {
  await deps(T0).registry.write({ ...lane, lastRecoveryAt: T0 + 2 * MIN });
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "idle" }];
  decisions(decision({ blocking: false }), decision({ id: "d2", lane: "other-lane" }), decision({ id: "d3" }));
  expect((await freshnessTick(deps(T0 + 16 * MIN))).map((a) => a.kind)).toEqual(["nudged"]);
});

test("a direct answer queued for the lane ends its wait and restarts its silence clock", async () => {
  await deps(T0).registry.write(lane);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "idle" }];
  const delivery = { id: "decision-d1-r1", state: "queued", updatedAt: T0 + 100 * MIN } as const;
  decisions(decision({ state: "answered", revisions: [{ rev: 1, channel: "c", message: "m", edit: 0, hash: "h", choice: 1, target: { lane: "busy-lane", runner: "local", generation: 0 }, at: T0 + 100 * MIN, delivery }] }));
  expect(await freshnessTick(deps(T0 + 114 * MIN))).toEqual([]);
  expect((await freshnessTick(deps(T0 + 116 * MIN))).map((a) => a.kind)).toEqual(["nudged"]);
});

for (const state of ["queued", "acked"] as const) {
  test(`an answer withdrawn after it reached the lane (withdrawal ${state}) keeps the lane waiting`, async () => {
    await deps(T0).registry.write(lane);
    world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "idle" }];
    const target = { lane: "busy-lane", runner: "local", generation: 0 };
    decisions(decision({ state: "answered", revisions: [
      { rev: 1, channel: "c", message: "m", edit: 0, hash: "h1", choice: 1, target, at: T0 + 10 * MIN, delivery: { id: "decision-d1-r1", state: "superseded", updatedAt: T0 + 20 * MIN } },
      { rev: 2, channel: "c", message: "m", edit: 1, hash: "h2", target, at: T0 + 20 * MIN, delivery: { id: "decision-d1-r2", state, updatedAt: T0 + 20 * MIN } },
    ] }));
    for (const min of [16, 40, 120]) expect(await freshnessTick(deps(T0 + min * MIN))).toEqual([]);
    expect(sent(world)).toEqual([]);
  });
}
