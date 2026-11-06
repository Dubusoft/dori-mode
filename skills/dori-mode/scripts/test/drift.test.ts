import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_DRIFT, defaultConfig, loadConfig } from "../src/config.ts";
import { ciDrift, DRIFT_STATE_FILE, driftTick, type DriftDeps, loadDriftState, milestoneDrift, type PullOwners } from "../src/drift.ts";
import { eventClass } from "../src/event-policy.ts";
import type { OpenPull } from "../src/github-events.ts";
import type { LaneReport, LaneReportStore } from "../src/lane-reports.ts";
import type { Lane } from "../src/registry.ts";
import { supervisorSweeps } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const lane = (key: string, patch: Partial<Lane> = {}): Lane =>
  ({ key, title: key, thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#7", openedAt: new Date(T0).toISOString(), ...patch });
const milestone = (laneKey: string, at: number, seq = 1): LaneReport =>
  ({ id: `${laneKey}:0:${seq}`, lane: laneKey, generation: 0, seq, kind: "milestone", text: "step", at });
const store = (rows: LaneReport[]): LaneReportStore =>
  ({ append: () => { throw new Error("unused"); }, pending: () => [], list: () => rows, consume: () => {}, close: () => {} });
const pull = (sha: string, checks: OpenPull["checks"], number = 7): OpenPull =>
  ({ repo: "acme/app", number, sha, branch: "lane-b", headRepo: "acme/app", url: `https://github.com/acme/app/pull/${number}`, conflicting: false, checks });

/** Runs driftTick at `at` and returns the emitted [line, id] pairs. */
const tick = async (at: number, lanes: Lane[], rows: LaneReport[], pulls: OpenPull[] = [], owners: PullOwners = async () => new Map([["acme/app#7", "lane-a"]]), drift = DEFAULT_DRIFT) => {
  const out: [string, string | undefined][] = [];
  const deps: DriftDeps = { stateDir: state.dir, drift, now: () => at, openLanes: async () => lanes, owners };
  await driftTick(deps, store(rows), pulls, async (line, id) => { out.push([line, id]); });
  return out.map(([line]) => line);
};

test("milestone-overdue fires once per stretch, once more at twice the interval, then stops until a milestone", async () => {
  const lanes = [lane("lane-a")];
  expect(await tick(T0 + 89 * MIN, lanes, [])).toEqual([]);
  expect(await tick(T0 + 90 * MIN, lanes, [])).toEqual(["LANE_DRIFT lane-a milestone-overdue 90min since open"]);
  expect(await tick(T0 + 120 * MIN, lanes, [])).toEqual([]);
  expect(await tick(T0 + 181 * MIN, lanes, [])).toEqual(["LANE_DRIFT lane-a milestone-overdue 181min since open"]);
  expect(await tick(T0 + 400 * MIN, lanes, [])).toEqual([]);
  // A new milestone starts a new stretch, counted from it.
  const rows = [milestone("lane-a", T0 + 400 * MIN)];
  expect(await tick(T0 + 450 * MIN, lanes, rows)).toEqual([]);
  expect(await tick(T0 + 495 * MIN, lanes, rows)).toEqual(["LANE_DRIFT lane-a milestone-overdue 95min since last milestone"]);
});

test("a paused or done-claimed lane gets no milestone drift, and other report kinds do not reset it", async () => {
  const progress: LaneReport = { ...milestone("lane-a", T0 + 60 * MIN), kind: "progress" };
  expect(await tick(T0 + 100 * MIN, [lane("lane-a", { status: "paused" }), lane("lane-b", { status: "done-claimed" })], [progress])).toEqual([]);
  expect(await tick(T0 + 100 * MIN, [lane("lane-a")], [progress])).toEqual(["LANE_DRIFT lane-a milestone-overdue 100min since open"]);
});

test("the persisted state keeps a restarted supervisor from firing the same stretch again", async () => {
  const lanes = [lane("lane-a")];
  expect(await tick(T0 + 95 * MIN, lanes, [])).toHaveLength(1);
  // A new process reads the same state file.
  expect(loadDriftState(state.dir).lanes["lane-a"]).toEqual({ since: T0, fired: 1 });
  expect(await tick(T0 + 96 * MIN, lanes, [])).toEqual([]);
});

test("an unreadable state file starts empty", () => {
  writeFileSync(join(state.dir, DRIFT_STATE_FILE), "{not json");
  expect(loadDriftState(state.dir)).toEqual({ lanes: {}, pulls: {} });
});

test("a closed lane drops out of the state", () => {
  const first = milestoneDrift({}, [lane("lane-a")], [], 90, T0 + 95 * MIN);
  expect(Object.keys(milestoneDrift(first.lanes, [], [], 90, T0 + 96 * MIN).lanes)).toEqual([]);
});

test("ci-failing fires once when the same lane PR fails on ciFailStreak heads in a row", async () => {
  const lanes = [lane("lane-a")];
  expect(await tick(T0, lanes, [], [pull("s1", "failing")])).toEqual([]);
  // The same head polled again is not another failure.
  expect(await tick(T0 + MIN, lanes, [], [pull("s1", "failing")])).toEqual([]);
  expect(await tick(T0 + 2 * MIN, lanes, [], [pull("s2", "pending")])).toEqual([]);
  expect(await tick(T0 + 3 * MIN, lanes, [], [pull("s2", "failing")])).toEqual([]);
  expect(await tick(T0 + 4 * MIN, lanes, [], [pull("s3", "failing")])).toEqual(["LANE_DRIFT lane-a ci-failing 3 consecutive failures https://github.com/acme/app/pull/7"]);
  expect(await tick(T0 + 5 * MIN, lanes, [], [pull("s4", "failing")])).toEqual([]);
  // Green ends the streak; a new one counts from zero.
  expect(await tick(T0 + 6 * MIN, lanes, [], [pull("s5", "green")])).toEqual([]);
  for (const [i, sha] of ["s6", "s7"].entries()) expect(await tick(T0 + (7 + i) * MIN, lanes, [], [pull(sha, "failing")])).toEqual([]);
  expect(await tick(T0 + 9 * MIN, lanes, [], [pull("s8", "failing")])).toEqual(["LANE_DRIFT lane-a ci-failing 3 consecutive failures https://github.com/acme/app/pull/7"]);
});

test("ci-failing ignores PRs no working lane owns, and looks owners up only for a new failing head", async () => {
  let lookups = 0;
  const none: PullOwners = async () => { lookups += 1; return new Map(); };
  for (const sha of ["s1", "s2", "s3"]) expect(await tick(T0, [lane("lane-a")], [], [pull(sha, "failing")], none)).toEqual([]);
  expect(lookups).toBe(3);
  let seen: string[] = [];
  const owners: PullOwners = async (lanes) => { lookups += 1; seen = lanes.map((l) => l.key); return new Map(); };
  const result = await ciDrift({}, [lane("lane-a", { status: "paused" }), lane("lane-b")], [pull("s9", "green")], 3, owners);
  expect(result.out).toEqual([]);
  expect(lookups).toBe(3);
  await ciDrift({}, [lane("lane-a", { status: "paused" }), lane("lane-b")], [pull("s9", "failing")], 3, owners);
  expect(seen).toEqual(["lane-b"]);
});

test("drift.enabled false raises nothing", async () => {
  expect(await tick(T0 + 500 * MIN, [lane("lane-a")], [], [], undefined, { ...DEFAULT_DRIFT, enabled: false })).toEqual([]);
});

test("LANE_DRIFT wakes the lead", () => {
  expect(eventClass("LANE_DRIFT lane-a milestone-overdue 90min since open")).toBe("lead-urgent");
  expect(eventClass("LANE_DRIFT lane-a ci-failing 3 consecutive failures https://github.com/acme/app/pull/7")).toBe("lead-urgent");
});

test("drift config defaults, partial override, and validation", async () => {
  expect(defaultConfig("/home/ana").drift).toEqual({ enabled: true, milestoneOverdueMin: 90, ciFailStreak: 3 });
  const path = join(state.dir, "drift.json");
  await Bun.write(path, JSON.stringify({ drift: { milestoneOverdueMin: 45 } }));
  expect((await loadConfig(path, "/home/ana")).drift).toEqual({ enabled: true, milestoneOverdueMin: 45, ciFailStreak: 3 });
  for (const [drift, message] of [
    ["x", "drift must be an object"], [{ enabled: "yes" }, "drift.enabled must be true or false"],
    [{ milestoneOverdueMin: 0 }, "drift.milestoneOverdueMin must be positive"], [{ ciFailStreak: 1.5 }, "drift.ciFailStreak must be an integer of at least 1"],
  ] as const) {
    await Bun.write(path, JSON.stringify({ drift }));
    await expect(loadConfig(path, "/home/ana")).rejects.toThrow(message);
  }
});

test("the supervisor's drift sweep emits LANE_DRIFT with a stable id from the registry, the report store and the last poll", async () => {
  const clock = fakeClock(T0 + 95 * MIN);
  const deps = depsFor(newWorld(), clock, state.dir);
  await deps.registry.write(lane("lane-a"));
  const pulls = [pull("s1", "failing")];
  const sweep = supervisorSweeps(deps, "/home/test", undefined, () => store([]), undefined, undefined, () => pulls).find(([name]) => name === "drift");
  const out: [string, string | undefined][] = [];
  const run = () => sweep![1](async (line, id) => { out.push([line, id]); });
  await run();
  expect(out).toEqual([["LANE_DRIFT lane-a milestone-overdue 95min since open", `lane-drift:lane-a:milestone:${T0}:1`]]);
  // The lane's Done signal names acme/app#7, so it owns the PR; two more failing heads finish the streak.
  pulls[0] = pull("s2", "failing");
  await run();
  pulls[0] = pull("s3", "failing");
  await run();
  expect(out.slice(1)).toEqual([["LANE_DRIFT lane-a ci-failing 3 consecutive failures https://github.com/acme/app/pull/7", "lane-drift:lane-a:ci:acme/app#7:s3"]]);
});
