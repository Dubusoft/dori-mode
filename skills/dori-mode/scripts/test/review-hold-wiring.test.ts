import { afterEach, beforeEach, expect, test } from "bun:test";

import { claimDone, type FlowDeps, watchTick } from "../src/done-flow.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { type PrInfo, ReviewGate } from "../src/review-gate.ts";
import { supervisorSweeps, withReviewHold } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState, type World, withSqliteStore } from "./fakes.ts";

/**
 * D11 wiring: the supervisor's watch sweep gets its deps through withReviewHold, so a real ReviewGate's holdsLane keeps a
 * claimed lane whose PR is still open without a reviewer pass from being objected to or closed.
 */

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const HEAD = "a".repeat(40);
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
/** What the gate's GitHub read says about acme/app#1. */
let pr: PrInfo;

/** Deps whose merge wait reads acme/app#1 OPEN at HEAD, green-pending and mergeable (as review-close-hold.test.ts). */
const deps = (ms: number): FlowDeps => {
  const base = depsFor(world, fakeClock(ms), state.dir);
  const run = async (argv: readonly string[], opts?: { timeoutMs?: number }) => {
    const fields = argv[argv.indexOf("--json") + 1] ?? "";
    if (argv[0] === "gh" && argv[2] === "view" && fields.includes("headRefOid")) {
      return { code: 0, out: JSON.stringify({ number: 1, state: pr.state, headRefOid: HEAD, headRefName: "feat/x", baseRefName: "dev", isCrossRepository: false, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] }), err: "" };
    }
    return base.run(argv, opts);
  };
  return { ...base, run };
};

/** One pass of the supervisor's watch sweep over `d`; returns what it emitted. */
const watch = async (d: FlowDeps): Promise<string[]> => {
  const step = supervisorSweeps(d, state.dir).find(([name]) => name === "watch")![1];
  const lines: string[] = [];
  await step(async (line) => { lines.push(line); });
  return lines;
};

beforeEach(() => {
  state = withState();
  withSqliteStore(state.dir);
  world = newWorld();
  world.prState = "OPEN";
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  pr = { state: "OPEN", baseRef: deps(T0).config.ciMergeBase, headSha: HEAD, title: "t", body: "", checks: "pending" };
});
afterEach(() => state.done());

test("withReviewHold answers reviewHold from the gate's holdsLane", async () => {
  const asked: string[] = [];
  const d = withReviewHold(deps(T0), { holdsLane: async (l) => { asked.push(l.key); return true; } });
  expect(await d.reviewHold?.(lane)).toBe(true);
  expect(asked).toEqual(["demo-lane"]);
});

test("the supervisor's watch sweep holds a claimed lane whose PR waits for review; without the gate it is objected to", async () => {
  await deps(T0).registry.write(lane);
  await claimDone(deps(T0), lane, "PR acme/app#1 pushed");
  expect((await deps(T0).registry.read(lane.key))?.claim?.pulls).toEqual([{ repo: "acme/app", number: 1, sha: HEAD }]);
  await watchTick(deps(T0));
  const gate = (ms: number): ReviewGate => new ReviewGate(deps(ms), { prInfo: async () => pr });
  // Past closeAfterMin and mergeWaitMaxMin, the wired sweep emits nothing and the lane stays claimed.
  for (const ms of [T0 + 6 * MIN, T0 + 61 * MIN, T0 + 200 * MIN]) expect(await watch(withReviewHold(deps(ms), gate(ms)))).toEqual([]);
  const held = (await deps(T0).registry.read(lane.key))!;
  expect(statusOf(held)).toBe("done-claimed");
  expect(held.objection).toBeUndefined();
  // The PR closed: the gate releases and the same wired sweep objects as before.
  pr = { ...pr, state: "CLOSED" };
  expect((await watch(withReviewHold(deps(T0 + 201 * MIN), gate(T0 + 201 * MIN))))[0]).toStartWith("LANE_NOT_DONE demo-lane");
});

test("an unwired sweep (no reviewHold) objects to the same lane: the hold comes only from the wiring", async () => {
  await deps(T0).registry.write(lane);
  await claimDone(deps(T0), lane, "PR acme/app#1 pushed");
  await watchTick(deps(T0));
  expect((await watch(deps(T0 + 200 * MIN)))[0]).toStartWith("LANE_NOT_DONE demo-lane");
});
