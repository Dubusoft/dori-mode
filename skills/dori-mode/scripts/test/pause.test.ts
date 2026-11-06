import { afterEach, beforeEach, expect, test } from "bun:test";

import { freshnessTick } from "../src/freshness.ts";
import { CONFIRM_BACKOFF_MS, sendGuarded, sendVerified } from "../src/panes.ts";
import { passthroughView } from "../src/sweep-view.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import type { LaneRef } from "../src/lane-ops.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, sent, withState, type World } from "./fakes.ts";

// Issue #11: telling Dori to wait must stick. One paused state silences the freshness sweep and pauses the goal,
// and the lane is marked paused only once the pane shows the goal paused.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  // Escape stops a running turn, unless a test says otherwise.
  world.onEscapeStatus = "idle";
});
afterEach(() => state.done());

const working: Lane = { key: "waiting-lane", title: "wait", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
const stored = async (): Promise<Lane | null> => deps(T0).registry.read(working.key);
const paneStatus = (status: string) => {
  for (const pane of world.panes) pane.agent_status = status;
};
/** The runner steps pause/resume asked for, in order (the goal command and the Escape read-back run runner-side). */
const pauseSteps = () => world.ops.filter((e) => e.op === "pause").map((e) => (e.args as { step?: string }).step);
const escapes = () => pauseSteps().filter((s) => s === "stop");
const goalOps = () => world.ops.filter((e) => e.op === "pause" || e.op === "resume").map((e) => (e.op === "resume" ? "resume" : `pause:${(e.args as { step?: string }).step}`));
/** One freshness sweep at `ms`, over the World's runner. */
const tick = (ms: number) => { const d = deps(ms); return freshnessTick(d, "/home/test", passthroughView(d.ops)); };
/** A sweep tick that finds the paused lane woken (a monitor event, a background result) and working. */
const wokenTick = async (at: number) => {
  paneStatus("working");
  return tick(T0 + at * MIN);
};

test("a paused lane silent past the nudge and post times is neither nudged nor posted", async () => {
  await deps(T0).registry.write({ ...working, status: "paused" });
  world.screen = "[REPORT] waiting-lane | milestone | halfway\n❯ ";
  for (const at of [16, 21, 26, 120]) expect(await tick(T0 + at * MIN)).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect(world.calls.find((c) => c[0] === "notify")).toBeUndefined();
});

test("pause marks the lane paused only once the pane shows the goal paused, then stops the running turn", async () => {
  paneStatus("working");
  await deps(T0).registry.write(working);

  const r = await pauseLane(deps(T0 + MIN), working, "owner said wait");

  expect(r.code).toBe(0);
  expect(r.lines[0]).toBe("PAUSED waiting-lane goal paused, running turn interrupted");
  const lane = await stored();
  expect(lane && statusOf(lane)).toBe("paused");
  expect(lane?.history?.at(-1)).toMatchObject({ status: "paused", note: "owner said wait" });
  // The goal is paused before the turn is stopped, and the runner is told the new status once it is committed.
  expect(world.ops.map((e) => e.op)).toEqual(["pause", "status", "pause", "notify"]);
  expect(goalOps()).toEqual(["pause:goal", "pause:stop"]);
  expect(world.ops.at(-1)).toMatchObject({ op: "notify", key: "waiting-lane", args: { status: "paused" } });
  expect((await pauseLane(deps(T0 + 2 * MIN), lane as Lane, "again")).lines[0]).toBe("PAUSED waiting-lane already");
  expect(goalOps()).toEqual(["pause:goal", "pause:stop"]);
});

test("an unconfirmed goal pause leaves the lane working, interrupts nothing, and exits 3", async () => {
  paneStatus("working");
  await deps(T0).registry.write(working);
  world.pauseResult = { goal: "unconfirmed" };

  const r = await pauseLane(deps(T0 + MIN), working, "owner said wait");

  expect(r.code).toBe(3);
  expect(r.lines[0]).toBe("PAUSE_UNVERIFIED waiting-lane /goal pause unconfirmed; lane left working");
  expect(statusOf((await stored()) as Lane)).toBe("working");
  expect(escapes()).toEqual([]);
});

test("a lane with no goal pauses: nothing can auto-continue, and an idle pane gets no Escape", async () => {
  await deps(T0).registry.write(working);

  const r = await pauseLane(deps(T0 + MIN), working, "owner said wait");

  expect(r).toMatchObject({ code: 0, lines: ["PAUSED waiting-lane goal paused"] });
  expect(escapes()).toEqual([]);
});

test("a resume the runner cannot confirm leaves the lane paused, and an unreachable runner confirms neither pause nor resume (issue #23)", async () => {
  await deps(T0).registry.write(working);
  const paused = await pauseLane(deps(T0 + MIN), working, "owner said wait");
  expect(paused).toMatchObject({ code: 0, lines: ["PAUSED waiting-lane goal paused"] });

  const d = deps(T0 + 2 * MIN);
  const refusing = { ...d, ops: { ...d.ops, resume: async () => ({ goal: "unconfirmed" as const }) } };
  expect(await resumeLane(refusing, paused.lane, "go")).toMatchObject({ code: 3, lines: ["RESUME_UNVERIFIED waiting-lane /goal resume unconfirmed; lane left paused"] });
  expect(statusOf((await stored()) as Lane)).toBe("paused");
  expect((await stored() as Lane & { resuming?: string }).resuming).toBeUndefined();

  world.runnerDown = true;
  expect(await resumeLane(deps(T0 + 3 * MIN), (await stored()) as Lane, "go")).toMatchObject({ code: 3, lines: ["RESUME_UNVERIFIED waiting-lane /goal resume failed; lane left paused"] });
  world.pauseResult = undefined;
  const fresh: Lane = { ...working, key: "other-lane" };
  await deps(T0).registry.write(fresh);
  expect(await pauseLane(deps(T0 + 4 * MIN), fresh, "wait")).toMatchObject({ code: 3, lines: ["PAUSE_UNVERIFIED other-lane /goal pause failed; lane left working"] });
});

test("a not-done lane can be paused, and resume restores not-done and restarts the quiet clock", async () => {
  const notDone: Lane = { ...working, status: "not-done" };
  await deps(T0).registry.write(notDone);
  const paused = (await pauseLane(deps(T0 + MIN), notDone, "wait")).lane;
  expect(statusOf(paused)).toBe("paused");

  const r = await resumeLane(deps(T0 + 90 * MIN), paused, "owner said go");

  expect(r).toMatchObject({ code: 0, lines: ["RESUMED waiting-lane as not-done, goal resumed"] });
  const lane = await stored();
  expect(lane && statusOf(lane)).toBe("not-done");
  expect(lane?.lastReplyAt).toBe(T0 + 90 * MIN);
  expect(goalOps()).toEqual(["pause:goal", "resume"]);
  expect(world.ops.filter((e) => e.op === "notify").map((e) => (e.args as { status: string }).status)).toEqual(["paused", "not-done"]);
});

test("an owner pause during a resume's goal command is not blocked by the lane lock: it wins and the goal is paused again", async () => {
  await deps(T0).registry.write({ ...working, status: "paused", history: [{ at: new Date(T0).toISOString(), status: "paused", note: "wait" }] });
  const d = deps(T0 + MIN);
  let owner: Awaited<ReturnType<typeof pauseLane>> | undefined;
  // The owner's pause lands while the resume's goal command is in flight on the runner.
  const racing = { ...d, ops: { ...d.ops, resume: async (l: LaneRef) => {
    const result = await d.ops.resume(l);
    owner = await pauseLane(d, (await stored()) as Lane, "owner said wait");
    return result;
  } } };
  const r = await resumeLane(racing, (await stored()) as Lane, "go");
  expect(owner?.code).toBe(0);
  expect(r.code).toBe(2);
  const lane = await stored();
  expect(lane && statusOf(lane)).toBe("paused");
  expect(lane?.history?.at(-1)?.note).toBe("owner said wait");
  // The owner's pause stops the goal itself, and the resumer pauses it again on its commit.
  expect(owner?.lines).toEqual(["PAUSED waiting-lane already; a resume in flight was stopped, goal paused"]);
  expect(goalOps()).toEqual(["resume", "pause:goal", "pause:goal"]);
});

test("an owner pause after a resumer died between /goal resume and its commit pauses the goal itself", async () => {
  // The crashed resume left its claim; its /goal resume already ran, so the goal is active while the lane reads paused.
  await deps(T0).registry.write({ ...working, status: "paused", resuming: "crashed-resume", history: [{ at: new Date(T0).toISOString(), status: "paused", note: "wait" }] } as Lane);
  const r = await pauseLane(deps(T0 + MIN), (await stored()) as Lane, "owner said wait");
  expect(r).toMatchObject({ code: 0, lines: ["PAUSED waiting-lane already; a resume in flight was stopped, goal paused"] });
  expect(goalOps()).toEqual(["pause:goal"]);
  const lane = await stored();
  expect(lane && statusOf(lane)).toBe("paused");
  expect((lane as Lane & { resuming?: string }).resuming).toBeUndefined();
  // A plain repeat pause with no resume in flight stays a no-op on the pane.
  expect((await pauseLane(deps(T0 + 2 * MIN), lane as Lane, "again")).lines).toEqual(["PAUSED waiting-lane already"]);
  expect(goalOps()).toEqual(["pause:goal"]);
});

test("resume of a working lane restarts the quiet clock: no nudge until nudgeAfterMin after the resume", async () => {
  const paused: Lane = { ...working, status: "paused", history: [{ at: new Date(T0).toISOString(), status: "paused", note: "wait" }] };
  await deps(T0).registry.write(paused);
  await resumeLane(deps(T0 + 90 * MIN), paused, "go");
  expect(statusOf((await stored()) as Lane)).toBe("working");
  expect(await tick(T0 + 95 * MIN)).toEqual([]);
  expect((await tick(T0 + 106 * MIN)).map((a) => a.kind)).toEqual(["nudged"]);
});

test("a lane paused mid-turn (Escape) and then woken stays paused: resume is dori resume only, whatever the screen shows", async () => {
  paneStatus("working");
  await deps(T0).registry.write(working);
  await pauseLane(deps(T0 + MIN), working, "owner said wait");
  expect(escapes()).toHaveLength(1);
  // Woken afterwards (a background result), still running on two ticks, even with a screen that reads active.
  world.screen = "Goal active\nworking on the background result\n";
  expect(await wokenTick(5)).toEqual([]);
  const second = await wokenTick(10);
  expect(second.map((a) => a.kind)).toEqual(["working-while-paused"]);
  expect(await tick(T0 + 15 * MIN)).toEqual([]);
  expect(await tick(T0 + 60 * MIN)).toEqual([]);
  const lane = await stored();
  expect(lane && statusOf(lane)).toBe("paused");
  expect(sent(world).filter((text) => text.startsWith("[LEAD]"))).toEqual([]);
});

test("one working tick between idle ones does not count as a resume", async () => {
  await deps(T0).registry.write({ ...working, status: "paused" });
  paneStatus("working");
  await tick(T0 + 5 * MIN);
  paneStatus("idle");
  await tick(T0 + 10 * MIN);
  paneStatus("working");
  expect(await tick(T0 + 15 * MIN)).toEqual([]);
  expect(statusOf((await stored()) as Lane)).toBe("paused");
});

test("pause and resume refuse lanes in other states with exit 2, and a lane with no pane is unverified", async () => {
  const claimed: Lane = { ...working, status: "done-claimed" };
  expect(await pauseLane(deps(T0), claimed, "wait")).toMatchObject({ code: 2, lines: ["NOT_PAUSED waiting-lane is done-claimed, not working"] });
  expect(await resumeLane(deps(T0), working, "go")).toMatchObject({ code: 2, lines: ["NOT_RESUMED waiting-lane is working, not paused"] });
  const paneless: Lane = { ...working, pane: undefined };
  expect((await pauseLane(deps(T0), paneless, "wait")).code).toBe(3);
  expect(sent(world)).toEqual([]);
});

test("every wake of a paused lane is reported, across a resume and a second pause", async () => {
  await deps(T0).registry.write(working);
  let lane = (await pauseLane(deps(T0 + MIN), working, "wait")).lane;
  await wokenTick(5);
  expect((await wokenTick(10)).map((a) => a.kind)).toEqual(["working-while-paused"]);
  paneStatus("idle");
  lane = (await resumeLane(deps(T0 + 11 * MIN), (await stored()) as Lane, "go")).lane;
  await pauseLane(deps(T0 + 12 * MIN), lane, "wait again");
  await wokenTick(15);
  expect((await wokenTick(20)).map((a) => a.kind)).toEqual(["working-while-paused"]);
});

test("a paused lane that goes idle and is woken again is reported again", async () => {
  await deps(T0).registry.write({ ...working, status: "paused" });
  // Escape does not stop it here, so it reads working on every tick: reported once per working stretch.
  world.onEscapeStatus = undefined;
  world.pauseResult = { goal: "confirmed", stopped: false };
  paneStatus("working");
  expect((await tick(T0 + 5 * MIN)).map((a) => a.kind)).toEqual(["working-while-paused"]);
  expect(await tick(T0 + 10 * MIN)).toEqual([]);
  paneStatus("idle");
  await tick(T0 + 20 * MIN);
  paneStatus("working");
  expect((await tick(T0 + 25 * MIN)).map((a) => a.kind)).toEqual(["working-while-paused"]);
  expect(statusOf((await stored()) as Lane)).toBe("paused");
});


// Issue #232: a paused lane woken by a monitor it armed before the pause merged a PR while the sweep only reported it.
test("a paused lane woken by a background event is interrupted on every sweep and stays idle until resume", async () => {
  paneStatus("working");
  await deps(T0).registry.write(working);
  expect((await pauseLane(deps(T0 + MIN), working, "owner said wait")).lines).toEqual(["PAUSED waiting-lane goal paused, running turn interrupted"]);
  // A monitor event wakes the idle session: the next sweep stops the turn at once, without waiting for a second tick.
  expect(await wokenTick(3)).toEqual([]);
  expect(escapes()).toHaveLength(2);
  for (const at of [4, 5, 6]) {
    expect(await tick(T0 + at * MIN)).toEqual([]);
    expect(world.panes[0]?.agent_status).toBe("idle");
  }
  // Woken again on the next tick as well: interrupted again and escalated to the lead.
  await wokenTick(7);
  const again = await wokenTick(8);
  expect(again).toEqual([{ kind: "working-while-paused", lane: "waiting-lane", detail: "paused lane was woken and is working; re-interrupted, its turn stopped; left paused (resume is dori resume only)" }]);
  expect(escapes()).toHaveLength(4);
  expect(world.panes[0]?.agent_status).toBe("idle");
  expect(statusOf((await stored()) as Lane)).toBe("paused");
  expect(goalOps().filter((o) => o === "pause:goal")).toEqual(["pause:goal"]);
});

test("a paused lane whose turn Escape cannot stop is escalated on the first tick as PAUSE_UNVERIFIED", async () => {
  await deps(T0).registry.write({ ...working, status: "paused" });
  world.onEscapeStatus = undefined;
  world.pauseResult = { goal: "confirmed", stopped: false };
  paneStatus("working");
  expect(await tick(T0 + 5 * MIN)).toEqual([{ kind: "working-while-paused", lane: "waiting-lane", detail: "paused lane was woken and is working; PAUSE_UNVERIFIED: Escape did not stop its turn; left paused (resume is dori resume only)" }]);
  expect(statusOf((await stored()) as Lane)).toBe("paused");
});

test("pause is unverified (exit 3) when Escape does not stop the running turn; the paused goal keeps the lane paused", async () => {
  world.onEscapeStatus = undefined;
  world.pauseResult = { goal: "confirmed", stopped: false };
  paneStatus("working");
  await deps(T0).registry.write(working);
  const r = await pauseLane(deps(T0 + MIN), working, "owner said wait");
  expect(r).toMatchObject({ code: 3, lines: ["PAUSE_UNVERIFIED waiting-lane goal paused, but its running turn did not stop after Escape; lane left paused"] });
  expect(statusOf((await stored()) as Lane)).toBe("paused");
  // A retry stops the turn once Escape takes.
  world.onEscapeStatus = "idle";
  world.pauseResult = { goal: "confirmed", stopped: true };
  expect(await pauseLane(deps(T0 + 2 * MIN), (await stored()) as Lane, "again")).toMatchObject({ code: 0, lines: ["PAUSED waiting-lane already; its running turn was interrupted again"] });
  expect(world.panes[0]?.agent_status).toBe("idle");
  expect(goalOps().filter((o) => o === "pause:goal")).toEqual(["pause:goal"]);
});

/** A runner whose pane turns "working" on the n-th status lookup after Enter (never, when n is undefined). */
const workingOnLookup = (n: number | undefined): Runner => {
  const base = fakeRunner(world);
  let entered = false;
  let lookups = 0;
  return async (argv) => {
    if (argv[2] === "send-keys" && argv[4] === "enter") entered = true;
    if (entered && argv[2] === "list" && ++lookups === n) paneStatus("working");
    return base(argv);
  };
};
const sleepLog = () => {
  const sleeps: number[] = [];
  return { sleeps, clock: { ...fakeClock(T0), sleep: async (ms: number) => void sleeps.push(ms) } };
};

test("sendVerified confirms with escalating backoff, and the first lookup after Enter has no wait", async () => {
  const { sleeps, clock } = sleepLog();
  expect(await sendVerified(workingOnLookup(1), clock, "w:p7", "hello")).toBe("delivered");
  expect(sleeps).toEqual([]);
  paneStatus("idle");
  const third = sleepLog();
  expect(await sendVerified(workingOnLookup(3), third.clock, "w:p7", "hello")).toBe("delivered");
  expect(third.sleeps).toEqual([150, 300]);
});

test("sendVerified backs off 150ms growing to 1000ms and reports unconfirmed when the pane never works", async () => {
  const { sleeps, clock } = sleepLog();
  expect(await sendVerified(workingOnLookup(undefined), clock, "w:p7", "hello")).toBe("unconfirmed");
  expect(sleeps).toEqual([150, 300, 600, 900, 1000, 1000, 1000]);
  expect(sleeps).toEqual([...CONFIRM_BACKOFF_MS]);
  expect(sent(world)).toEqual(["hello"]);
});

test("sendGuarded types without waiting, and refuses a pane with no running agent", async () => {
  expect(await sendGuarded(fakeRunner(world), "w:p7", "hi")).toBe("sent");
  expect(sent(world)).toEqual(["hi"]);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w" }];
  expect(await sendGuarded(fakeRunner(world), "w:p7", "rm -rf x")).toBe("failed");
  expect(await sendGuarded(fakeRunner(world), "w:missing", "hi")).toBe("failed");
  expect(sent(world)).toEqual(["hi"]);
});
