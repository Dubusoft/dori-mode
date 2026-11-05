import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openLaneReports, routeReports } from "../src/lane-reports.ts";
import type { Lane } from "../src/registry.ts";
import { evacuate } from "../src/runner/evacuate.ts";
import { launchesThroughRunner } from "../src/runner/launch-via-runner.ts";
import { acceptLaneEvent, type LaneHubDeps } from "../src/runner/lanes-hub.ts";
import { journalId, type AnyRunnerEvent } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const setup = async (mode: "authoritative" | "off") => {
  const s = withState();
  cleanups.push(s.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, s.dir, { runners: { mode: { "worker-a": mode } } });
  await deps.registry.write({ key: "lane-a", title: "a", thread: "none", brief: join(s.dir, "a.md"), done: "x", openedAt: new Date(T0).toISOString(), status: "working", machine: "worker-a", runner: "worker-a", pane: "pa" } as unknown as Lane);
  const store = openLaneReports(deps.config);
  cleanups.push(() => { store.close(); });
  const hub: LaneHubDeps = { registry: deps.registry, reports: () => store, now: clock.now, emit: () => {}, recover: () => undefined };
  return { deps, store, hub };
};
const report = (seq: number, kind: string, text: string, evidence?: string): AnyRunnerEvent =>
  ({ v: 1, runner: "worker-a", gen: 1, epoch: 1, seq, type: "lane.report", body: { key: "lane-a", kind, text, ...(evidence ? { evidence } : {}) } }) as unknown as AnyRunnerEvent;

test("with mode off a runner starts no new lane, and a done from a lane it already owns still arrives as a claim", async () => {
  const t = await setup("off");
  expect(launchesThroughRunner(t.deps.config, "worker-a")).toBe(false);
  expect(launchesThroughRunner({ runners: { mode: { "worker-a": "authoritative" } } }, "worker-a")).toBe(true);
  await acceptLaneEvent(t.hub, "worker-a", report(1, "done", "merged", "abc123"));
  expect(await routeReports(t.deps, t.store, () => {})).toEqual([expect.stringMatching(/ done claim$/)]);
  expect((await t.deps.registry.read("lane-a"))?.status).toBe("done-claimed");
});

test("evacuate imports the runner's three unacked reports under their own ids, tells the lane, clears Lane.runner and stops the runner", async () => {
  const t = await setup("authoritative");
  // One of the three already reached the supervisor before the runner became unusable.
  const unacked = [report(4, "milestone", "tests pass"), report(5, "question", "which base?"), report(6, "milestone", "PR open")];
  await acceptLaneEvent(t.hub, "worker-a", unacked[0] as AnyRunnerEvent);
  const told: string[] = [];
  const stopped: string[] = [];
  const lines = await evacuate({
    hub: t.hub, exportOutbox: async () => unacked,
    tellLane: async (lane, text) => { told.push(`${lane.key}: ${text}`); return true; },
    stopRunner: async (label) => { stopped.push(label); return { ok: true, detail: "stopped" }; },
  }, "worker-a");
  const rows = t.store.list({ lane: "lane-a" });
  expect(rows.map((r) => r.source)).toEqual([journalId("worker-a", 4), journalId("worker-a", 5), journalId("worker-a", 6)]);
  expect(rows.map((r) => r.text)).toEqual(["tests pass", "which base?", "PR open"]);
  const lane = await t.deps.registry.read("lane-a");
  expect(lane?.runner).toBeUndefined();
  expect(lane?.status).toBe("working");
  expect(told).toHaveLength(1);
  expect(told[0]).toContain("[REPORT] lane-a | <milestone|blocker|question|done>");
  expect(stopped).toEqual(["worker-a"]);
  expect(lines).toEqual(["RUNNER_EVACUATE_IMPORTED runner=worker-a events=3", "RUNNER_EVACUATE_LANE lane-a runner cleared", "RUNNER_EVACUATE_STOPPED runner=worker-a"]);
});
