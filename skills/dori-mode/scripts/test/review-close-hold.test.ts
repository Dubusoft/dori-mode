import { afterEach, beforeEach, expect, test } from "bun:test";

import { claimDone, type FlowDeps, watchTick } from "../src/done-flow.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState, type World, withSqliteStore } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const HEAD = "a".repeat(40);
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
/** What the review gate answers for holdsLane, and which lanes it was asked about. */
let held: boolean;
let asked: string[];

/**
 * Deps whose claim binds acme/app#1 at HEAD: the merge wait reads it OPEN, green-pending and mergeable while `pr.state`
 * is OPEN; the Done signal and the merge read-back follow `world.prState` (fakes.ts).
 */
const pr = { state: "OPEN" };
const deps = (ms: number, hold = true): FlowDeps => {
  const base = depsFor(world, fakeClock(ms), state.dir);
  const run = async (argv: readonly string[], opts?: { timeoutMs?: number }) => {
    const fields = argv[argv.indexOf("--json") + 1] ?? "";
    if (argv[0] === "gh" && argv[2] === "view" && fields.includes("headRefOid")) {
      return { code: 0, out: JSON.stringify({ number: 1, state: pr.state, headRefOid: HEAD, headRefName: "feat/x", baseRefName: "dev", isCrossRepository: false, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] }), err: "" };
    }
    return base.run(argv, opts);
  };
  return { ...base, run, ...(hold ? { reviewHold: async (l: Lane) => { asked.push(l.key); return held; } } : {}) };
};
const closedVia = () => world.ops.filter((e) => e.op === "close").map((e) => e.key);
const removals = () => world.ops.filter((e) => e.op === "git" && (e.args as { op: string }).op === "worktree-remove");
const read = async () => (await deps(T0).registry.read(lane.key))!;

beforeEach(() => {
  state = withState();
  withSqliteStore(state.dir);
  world = newWorld();
  world.prState = "OPEN";
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  pr.state = "OPEN";
  held = true;
  asked = [];
});
afterEach(() => state.done());

const claim = async (l: Lane): Promise<void> => {
  await deps(T0).registry.write(l);
  await claimDone(deps(T0), l, "PR acme/app#1 pushed");
  expect((await read()).claim?.pulls).toEqual([{ repo: "acme/app", number: 1, sha: HEAD }]);
  await watchTick(deps(T0));
};

/** Held past closeAfterMin and mergeWaitMaxMin: still claimed, never objected, never closed, no worktree queued or removed. */
const expectHeld = async (): Promise<void> => {
  for (const ms of [T0 + 6 * MIN, T0 + 61 * MIN, T0 + 200 * MIN]) expect(await watchTick(deps(ms))).toEqual([]);
  const after = await read();
  expect(statusOf(after)).toBe("done-claimed");
  expect(after.objection).toBeUndefined();
  expect(after.receipt).toBeUndefined();
  expect(closedVia()).toEqual([]);
  expect(removals()).toEqual([]);
  expect(asked.length).toBeGreaterThan(0);
};

test("a lane whose review is pending stays done-claimed past closeAfterMin and mergeWaitMaxMin: no objection, no close, worktree kept", async () => {
  await claim(lane);
  await expectHeld();
  // Without the hold the same claim is objected to once the merge wait passes mergeWaitMaxMin.
  expect((await watchTick(deps(T0 + 201 * MIN, false)))[0]).toStartWith("LANE_NOT_DONE demo-lane");
});

test("an autoClose: machine lane is held the same way", async () => {
  await claim({ ...lane, autoClose: "machine" });
  await expectHeld();
});

test("once the hold lifts the claim settles as before", async () => {
  await claim(lane);
  await expectHeld();
  held = false;
  expect((await watchTick(deps(T0 + 201 * MIN)))[0]).toStartWith("LANE_NOT_DONE demo-lane");
  expect(statusOf(await read())).toBe("not-done");
});

test("a lifted hold with the PR merged closes the lane normally", async () => {
  await claim(lane);
  await expectHeld();
  held = false;
  world.prState = "MERGED";
  pr.state = "MERGED";
  expect((await watchTick(deps(T0 + 201 * MIN)))[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toEqual(["demo-lane"]);
});

test("every bound PR merged closes the lane even while the review gate still reports a hold (a stale record)", async () => {
  await claim(lane);
  await expectHeld();
  world.prState = "MERGED";
  pr.state = "MERGED";
  expect((await watchTick(deps(T0 + 201 * MIN)))[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(statusOf(await read())).toBe("closed");
  expect(closedVia()).toEqual(["demo-lane"]);
});

test("a held lane's merged PR inside the window also closes it at once", async () => {
  await claim(lane);
  world.prState = "MERGED";
  pr.state = "MERGED";
  expect((await watchTick(deps(T0 + MIN)))[0]).toStartWith("LANE_CLOSED demo-lane");
});

test("a claimed review lane is never announced, settled, objected to or closed by the done watcher", async () => {
  held = false;
  const review: Lane = { ...lane, review: true };
  await deps(T0).registry.write(review);
  await claimDone(deps(T0), review, "file /x/research/demo-lane/review-result.json");
  for (const ms of [T0, T0 + 6 * MIN, T0 + 200 * MIN]) expect(await watchTick(deps(ms, false))).toEqual([]);
  world.prState = "MERGED";
  expect(await watchTick(deps(T0 + 201 * MIN))).toEqual([]);
  const after = await read();
  expect(statusOf(after)).toBe("done-claimed");
  expect(after.claim?.emitted).toBe(false);
  expect(after.objection).toBeUndefined();
  expect(closedVia()).toEqual([]);
  expect(asked).toEqual([]);
});
