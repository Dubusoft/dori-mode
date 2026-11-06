import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { freshnessTick } from "../src/freshness.ts";
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
    expect(await freshnessTick(deps(T0 + 10 * MIN, hooks), "/home/test")).toEqual([]);
    expect((await freshnessTick(deps(T0 + 16 * MIN, hooks), "/home/test")).map((a) => a.kind)).toEqual(["no-progress"]);
    expect(await freshnessTick(deps(T0 + 17 * MIN, hooks), "/home/test")).toEqual([]);
    expect(await freshnessTick(deps(T0 + 40 * MIN, hooks), "/home/test")).toEqual([]);
    expect(posts()).toEqual([]);
    expect(sent(world)).toEqual([]);
  });
}

test("an idle silent lane is still nudged, and nothing is posted from its pane", async () => {
  await deps(T0).registry.write(lane);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "idle" }];
  world.screen = WITH_TODO;
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect(sent(world)).toHaveLength(1);
  expect(posts()).toEqual([]);
});

test("a registry row with the removed progress fields still loads and does not change the outcome", async () => {
  await deps(T0).registry.write({ ...lane, lastProgressPost: "old todo", lastProgressAt: T0, lastProgressError: "HTTP 503" });
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
  world.screen = WITH_TODO;
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["no-progress"]);
  expect(posts()).toEqual([]);
});
