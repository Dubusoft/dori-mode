import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { askingLine } from "../src/ask-user.ts";
import { eventClass } from "../src/event-policy.ts";
import { openLaneReports } from "../src/lane-reports.ts";
import type { RecoveryLane } from "../src/recover.ts";
import type { Lane } from "../src/registry.ts";
import { queueLaneMessage, openLaneMessages } from "../src/lane-messages.ts";
import { acceptLaneEvent, type LaneHubDeps, reconcileInventory } from "../src/runner/lanes-hub.ts";
import type { AnyRunnerEvent, RunnerEventType } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const setup = async (extra: Partial<Lane> = {}) => {
  const s = withState();
  cleanups.push(s.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, s.dir);
  const lane = {
    key: "lane-a", title: "lane a", thread: "none", brief: join(s.dir, "brief.md"), done: "command [\"true\"]",
    openedAt: new Date(T0).toISOString(), machine: "worker-a", runner: "worker-a", status: "working", pane: "p1", tab: "t1", ...extra,
  } as unknown as Lane;
  await deps.registry.write(lane);
  const store = openLaneReports(deps.config);
  cleanups.push(() => { store.close(); });
  const emitted: [string, string][] = [];
  const recovers: string[] = [];
  const hub: LaneHubDeps = {
    registry: deps.registry, reports: () => store, now: clock.now,
    emit: (id, line) => { emitted.push([id, line]); }, recover: (label, key) => { recovers.push(`${label}/${key}`); return 1; },
  };
  let seq = 0;
  const event = (type: RunnerEventType, body: object): AnyRunnerEvent => ({ v: 1, runner: "worker-a", gen: 1, epoch: 1, seq: ++seq, type, body }) as unknown as AnyRunnerEvent;
  const read = async () => (await deps.registry.read("lane-a")) as RecoveryLane | undefined;
  return { deps, hub, emitted, recovers, event, read };
};

test("P1: the owner's lane.started after a hello recovery clears recoveryPending", async () => {
  const t = await setup({ recoveryPreviousPane: "p0", recoveryExhausted: true } as Partial<Lane>);
  await reconcileInventory(t.hub, "worker-a", []);
  expect(t.recovers).toEqual(["worker-a/lane-a"]);
  expect((await t.read())?.recoveryPending).toBe(true);
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.started", { key: "lane-a", pane: "p2", tab: "t2", session: "" }));
  const lane = await t.read();
  expect(lane?.pane).toBe("p2");
  expect(lane?.tab).toBe("t2");
  expect(lane?.recoveryPending).toBeUndefined();
  expect(lane?.recoveryPreviousPane).toBeUndefined();
  expect(lane?.recoveryExhausted).toBeUndefined();
});

test("P3: a lane with no pane yet (its lane.start still queued) is not recovered by the hello", async () => {
  const t = await setup({ pane: undefined, tab: undefined });
  await reconcileInventory(t.hub, "worker-a", []);
  expect(t.recovers).toEqual([]);
  expect((await t.read())?.recoveryPending).toBeUndefined();
  expect(t.emitted).toEqual([]);
});

test("P2: the owner's lane.state dead raises one urgent RUNNER_LANE_DEAD; working and idle raise nothing", async () => {
  const t = await setup();
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.state", { key: "lane-a", status: "working", pane: "p1" }));
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.state", { key: "lane-a", status: "idle", pane: "p1" }));
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.state", { key: "lane-a", status: "dead", pane: "p1" }));
  expect(t.emitted).toEqual([["runner-lane-dead:worker-a:3", expect.stringMatching(/^RUNNER_LANE_DEAD lane-a runner=worker-a pane=p1 .*dori close lane-a/)]]);
  expect(eventClass(t.emitted[0]?.[1] ?? "")).toBe("lead-urgent");
});

test("the owner's lane.state dead carries the runner's reason into RUNNER_LANE_DEAD", async () => {
  const t = await setup();
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.state", { key: "lane-a", status: "dead", pane: "p1", reason: "pane-missing" }));
  expect(t.emitted[0]?.[1]).toStartWith("RUNNER_LANE_DEAD lane-a runner=worker-a pane=p1 reason=pane-missing ");
});

test("the owner's lane.ack acks the addressed lane message; a wrong lane's or unknown id is LANE_ACK_FAILED; a forged ack changes nothing", async () => {
  const t = await setup();
  const messages = openLaneMessages(t.deps.config);
  cleanups.push(() => { messages.close(); });
  queueLaneMessage(messages, T0, { id: "m1", lane: "lane-a", subject: "s", text: "t" });
  queueLaneMessage(messages, T0, { id: "m2", lane: "lane-b", subject: "s", text: "t" });
  const hub = { ...t.hub, messages: () => messages };
  await acceptLaneEvent(hub, "worker-a", t.event("lane.ack", { key: "lane-a", id: "m1" }));
  expect(messages.get("m1")?.state).toBe("acked");
  await acceptLaneEvent(hub, "worker-a", t.event("lane.ack", { key: "lane-a", id: "m2" }));
  await acceptLaneEvent(hub, "worker-a", t.event("lane.ack", { key: "lane-a", id: "nope" }));
  expect(messages.get("m2")?.state).toBe("queued");
  expect(t.emitted.map(([id]) => id)).toEqual(["lane-ack-failed:worker-a:2", "lane-ack-failed:worker-a:3"]);
  expect(t.emitted[0]?.[1]).toStartWith("LANE_ACK_FAILED lane-a m2 ");
  await acceptLaneEvent(hub, "worker-b", t.event("lane.ack", { key: "lane-a", id: "m1" }));
  expect(t.emitted[2]?.[1]).toStartWith("RUNNER_FORGED_EVENT runner=worker-b key=lane-a type=lane.ack");
});

test("the hello calls LaneHubDeps.notify for every lane the runner owns, and only those", async () => {
  const t = await setup();
  const notified: [string, string][] = [];
  await reconcileInventory({ ...t.hub, notify: (label, lane) => { notified.push([label, lane.key]); } }, "worker-a", [{ key: "lane-a", pane: "pa", tab: "ta" }]);
  expect(notified).toEqual([["worker-a", "lane-a"]]);
});

test("P2: the owner's lane.asking raises urgent LANE_ASKING, as a local lane's question does", async () => {
  const t = await setup();
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.asking", { key: "lane-a", text: "Proceed with\nthe migration? [y/n]" }));
  // What the runner actually sends (lanes.ts): its own askingLine, which keeps one prefix, not two.
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.asking", { key: "lane-a", text: askingLine("lane-a", { question: "Pick a region", options: ["seoul", "tokyo"], pending: 1 }) }));
  expect(t.emitted).toEqual([
    ["runner-lane-asking:worker-a:1", "LANE_ASKING lane-a waits on an on-screen question, not dori report: Proceed with the migration? [y/n]"],
    ["runner-lane-asking:worker-a:2", "LANE_ASKING lane-a waits on an on-screen question, not dori report: Pick a region | options: seoul / tokyo"],
  ]);
  expect(eventClass(t.emitted[0]?.[1] ?? "")).toBe("lead-urgent");
});

test("P7: a failed lane.recover result raises one urgent RUNNER_RECOVER_FAILED; a verified one raises nothing", async () => {
  const t = await setup();
  await acceptLaneEvent(t.hub, "worker-a", t.event("cmd.result", { cmdId: "recover:lane-a:5", cmdSeq: 2, state: "verified", detail: "recovered" }));
  await acceptLaneEvent(t.hub, "worker-a", t.event("cmd.result", { cmdId: "recover:lane-a:6", cmdSeq: 3, state: "failed", detail: "RUNNER_LANE_UNKNOWN\nlane-a" }));
  expect(t.emitted).toEqual([["runner-recover-failed:worker-a:2", expect.stringMatching(/^RUNNER_RECOVER_FAILED lane-a runner=worker-a RUNNER_LANE_UNKNOWN lane-a; /)]]);
  expect(eventClass(t.emitted[0]?.[1] ?? "")).toBe("lead-urgent");
});

test("P8: a replayed old lane.started does not overwrite the pane a newer inventory set", async () => {
  const t = await setup();
  await reconcileInventory(t.hub, "worker-a", [{ key: "lane-a", pane: "p9", tab: "t9" }]);
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.started", { key: "lane-a", pane: "p1", tab: "t1", session: "" }));
  expect((await t.read())?.pane).toBe("p9");
  expect((await t.read())?.tab).toBe("t9");
  expect(t.emitted).toEqual([]);
});

test("B1: a registry lane recoveryPending without recoveryAfter (older entry) still clears on its owner's journaled lane.started", async () => {
  const t = await setup({ recoveryPending: true, recoveryPreviousPane: "p0" } as Partial<Lane>);
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.started", { key: "lane-a", pane: "p2", tab: "t2", session: "" }), 1);
  const lane = await t.read();
  expect(lane?.pane).toBe("p2");
  expect(lane?.recoveryPending).toBeUndefined();
  expect(lane?.recoveryPreviousPane).toBeUndefined();
});

test("B1: the hello records the journal head; a start at or before it is stale, a later one completes the recovery", async () => {
  const t = await setup();
  await reconcileInventory({ ...t.hub, journalHead: () => 7 }, "worker-a", []);
  expect((await t.read())?.recoveryAfter).toBe(7);
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.started", { key: "lane-a", pane: "old", tab: "t-old", session: "" }), 7);
  expect((await t.read())?.pane).toBe("p1");
  expect((await t.read())?.recoveryPending).toBe(true);
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.started", { key: "lane-a", pane: "p2", tab: "t2", session: "" }), 8);
  const lane = await t.read();
  expect(lane?.pane).toBe("p2");
  expect(lane?.recoveryPending).toBeUndefined();
  expect(lane?.recoveryAfter).toBeUndefined();
});

test("S-04: a lane.started for a lane closed with no pane is refused, gets lane.close and one LANE_STARTED_AFTER_CLOSE", async () => {
  const closedAt = new Date(T0 + 1_000).toISOString();
  const t = await setup({ pane: undefined, tab: undefined, status: "paused", launchReservation: "tok", closedAt } as Partial<Lane>);
  const closes: string[] = [];
  const hub: LaneHubDeps = { ...t.hub, close: (label, key, cmdId) => { closes.push(`${label}/${key}/${cmdId}`); return 1; } };
  const before = await t.read();
  await acceptLaneEvent(hub, "worker-a", t.event("lane.started", { key: "lane-a", pane: "p9", tab: "t9", session: "" }));
  const after = await t.read();
  expect(after?.pane).toBeUndefined();
  expect(after?.version).toBe(before?.version);
  expect(closes).toEqual(["worker-a/lane-a/late-start-close:lane-a:1"]);
  expect(t.emitted).toHaveLength(1);
  expect(t.emitted[0]?.[1]).toStartWith("LANE_STARTED_AFTER_CLOSE lane-a runner=worker-a pane=p9 ");
});

test("S-04: a replayed lane.started for a lane closed with its pane is ignored, nothing sent", async () => {
  const t = await setup({ closedAt: new Date(T0 + 1_000).toISOString() } as Partial<Lane>);
  const closes: string[] = [];
  const hub: LaneHubDeps = { ...t.hub, close: (_l, key) => { closes.push(key); return 1; } };
  await acceptLaneEvent(hub, "worker-a", t.event("lane.started", { key: "lane-a", pane: "p1", tab: "t1", session: "" }));
  expect(closes).toEqual([]);
  expect(t.emitted).toEqual([]);
});

test("S-04: a lane.started for an unconfirmed launch reservation releases it and the lane works; a confirmed-in-flight one is left to its launch", async () => {
  const t = await setup({ pane: undefined, tab: undefined, status: "paused", launchReservation: "tok", launchUnconfirmed: true } as Partial<Lane>);
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.started", { key: "lane-a", pane: "p2", tab: "t2", session: "" }));
  const lane = await t.read();
  expect(lane).toMatchObject({ pane: "p2", tab: "t2" });
  expect(lane?.status).toBeUndefined();
  expect(lane?.launchReservation).toBeUndefined();
  expect(lane?.launchUnconfirmed).toBeUndefined();
  expect(t.emitted.map(([, line]) => line.split(" ")[0])).toEqual(["LAUNCH_CONFIRMED_LATE"]);
  expect(eventClass(t.emitted[0]?.[1] ?? "")).toBe("lead-digest");

  const u = await setup({ pane: undefined, tab: undefined, status: "paused", launchReservation: "tok" } as Partial<Lane>);
  await acceptLaneEvent(u.hub, "worker-a", u.event("lane.started", { key: "lane-a", pane: "p2", tab: "t2", session: "" }));
  expect(await u.read()).toMatchObject({ pane: "p2", status: "paused", launchReservation: "tok" });
  expect(u.emitted).toEqual([]);
});
