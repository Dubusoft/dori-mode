import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openLaneReports, routeReports } from "../src/lane-reports.ts";
import type { Lane } from "../src/registry.ts";
import { acceptLaneEvent, type LaneHubDeps, reconcileInventory } from "../src/runner/lanes-hub.ts";
import type { AnyRunnerEvent } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const setup = async () => {
  const s = withState();
  cleanups.push(s.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, s.dir);
  const lane = (key: string, extra: object) => ({ key, title: key, thread: "none", brief: join(s.dir, `${key}.md`), done: "x", openedAt: new Date(T0).toISOString(), status: "working", ...extra }) as unknown as Lane;
  await deps.registry.write(lane("lane-a", { machine: "worker-a", runner: "worker-a", pane: "pa", tab: "ta" }));
  await deps.registry.write(lane("lane-b", { machine: "worker-b", runner: "worker-b", pane: "pb", tab: "tb" }));
  await deps.registry.write(lane("legacy-c", { machine: "worker-a", pane: "pc" }));
  await deps.registry.write(lane("local-d", { pane: "pd", tab: "td", status: "paused" }));
  await deps.registry.write(lane("closed-e", { pane: "pe", closedAt: new Date(T0).toISOString() }));
  const store = openLaneReports(deps.config);
  cleanups.push(() => { store.close(); });
  const emitted: [string, string][] = [];
  const recovered: [string, string][] = [];
  const hub: LaneHubDeps = {
    registry: deps.registry, reports: () => store, now: clock.now,
    emit: (id, line) => { emitted.push([id, line]); }, recover: (label, key) => { recovered.push([label, key]); return 1; },
  };
  return { deps, store, hub, emitted, recovered };
};

const event = (runner: string, seq: number, type: string, body: object): AnyRunnerEvent =>
  ({ v: 1, runner, gen: 1, epoch: 1, seq, type, body }) as unknown as AnyRunnerEvent;

const done = (runner: string, seq: number, key: string): AnyRunnerEvent =>
  ({ v: 1, runner, gen: 1, epoch: 1, seq, type: "lane.report", body: { key, kind: "done", text: "merged", evidence: "abc" } }) as unknown as AnyRunnerEvent;

test("runner B reporting done for runner A's lane makes no claim and one RUNNER_FORGED_EVENT", async () => {
  const t = await setup();
  await acceptLaneEvent(t.hub, "worker-b", done("worker-b", 9, "lane-a"));
  await acceptLaneEvent(t.hub, "worker-b", done("worker-b", 9, "lane-a"));
  await routeReports(t.deps, t.store, () => {});
  expect(t.store.list()).toEqual([]);
  expect((await t.deps.registry.read("lane-a"))?.status).toBe("working");
  expect(new Set(t.emitted.map(([id]) => id))).toEqual(new Set(["runner-forged:worker-b:9"]));
  expect(t.emitted[0]?.[1]).toBe("RUNNER_FORGED_EVENT runner=worker-b key=lane-a type=lane.report owner=worker-a");
});

test("a lane no runner owns and a key the registry does not have are not taken from a runner", async () => {
  const t = await setup();
  await acceptLaneEvent(t.hub, "worker-a", done("worker-a", 3, "legacy-c"));
  await acceptLaneEvent(t.hub, "worker-a", done("worker-a", 4, "ghost"));
  expect(t.store.list()).toEqual([]);
  expect(t.emitted.map(([, line]) => line)).toEqual([
    "RUNNER_FORGED_EVENT runner=worker-a key=legacy-c type=lane.report (no such runner lane)",
    "RUNNER_FORGED_EVENT runner=worker-a key=ghost type=lane.report (no such runner lane)",
  ]);
});

test("a runner's lane.state and lane.progress about an open unowned lane on its machine are not forged, whatever its mode", async () => {
  const t = await setup();
  await acceptLaneEvent(t.hub, "local", event("local", 1, "lane.state", { key: "local-d", status: "idle" }));
  await acceptLaneEvent(t.hub, "worker-a", event("worker-a", 2, "lane.state", { key: "legacy-c", status: "working" }));
  await acceptLaneEvent(t.hub, "worker-a", event("worker-a", 3, "lane.progress", { key: "legacy-c", reportHash: "abc" }));
  expect(t.emitted).toEqual([]);
  expect(t.store.list()).toEqual([]);
  const d = await t.deps.registry.read("local-d");
  expect([d?.status, d?.pane, d?.runner]).toEqual(["paused", "pd", undefined]);
});

test("control events about an unowned lane, other runners' lanes, closed, unknown or other-machine lanes stay forged", async () => {
  const t = await setup();
  await acceptLaneEvent(t.hub, "local", done("local", 1, "local-d"));
  await acceptLaneEvent(t.hub, "local", event("local", 2, "lane.started", { key: "local-d", pane: "px", tab: "tx", session: "s" }));
  await acceptLaneEvent(t.hub, "local", event("local", 3, "lane.asking", { key: "local-d", text: "?" }));
  await acceptLaneEvent(t.hub, "worker-b", event("worker-b", 4, "lane.state", { key: "lane-a", status: "dead" }));
  await acceptLaneEvent(t.hub, "local", event("local", 5, "lane.state", { key: "ghost", status: "idle" }));
  await acceptLaneEvent(t.hub, "local", event("local", 6, "lane.state", { key: "closed-e", status: "idle" }));
  await acceptLaneEvent(t.hub, "worker-b", event("worker-b", 7, "lane.state", { key: "legacy-c", status: "idle" }));
  expect(t.emitted.map(([, line]) => line)).toEqual([
    "RUNNER_FORGED_EVENT runner=local key=local-d type=lane.report (no such runner lane)",
    "RUNNER_FORGED_EVENT runner=local key=local-d type=lane.started (no such runner lane)",
    "RUNNER_FORGED_EVENT runner=local key=local-d type=lane.asking (no such runner lane)",
    "RUNNER_FORGED_EVENT runner=worker-b key=lane-a type=lane.state owner=worker-a",
    "RUNNER_FORGED_EVENT runner=local key=ghost type=lane.state (no such runner lane)",
    "RUNNER_FORGED_EVENT runner=local key=closed-e type=lane.state (no such runner lane)",
    "RUNNER_FORGED_EVENT runner=worker-b key=legacy-c type=lane.state (no such runner lane)",
  ]);
  expect(t.store.list()).toEqual([]);
  expect((await t.deps.registry.read("local-d"))?.pane).toBe("pd");
});

test("the hello inventory: an unknown key is LANE_ORPHAN with no registry entry; a missing owned lane is recovered; a moved pane is patched", async () => {
  const t = await setup();
  await reconcileInventory(t.hub, "worker-a", [
    { key: "stray", pane: "p9", tab: "t9" },
    { key: "legacy-c", pane: "pc", tab: "" },
  ]);
  expect(await t.deps.registry.read("stray")).toBeNull();
  expect(t.emitted.map(([id]) => id)).toEqual(["lane-orphan:worker-a:stray"]);
  expect(t.emitted[0]?.[1]).toStartWith("LANE_ORPHAN stray runner=worker-a");
  expect(t.recovered).toEqual([["worker-a", "lane-a"]]);
  expect((await t.deps.registry.read("lane-a"))?.recoveryPending).toBe(true);

  await reconcileInventory(t.hub, "worker-a", [{ key: "lane-a", pane: "pa2", tab: "ta2" }]);
  const moved = await t.deps.registry.read("lane-a");
  expect([moved?.pane, moved?.tab, moved?.status]).toEqual(["pa2", "ta2", "working"]);
  expect((await t.deps.registry.read("lane-b"))?.pane).toBe("pb");
});
