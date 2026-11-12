import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { treeDigest } from "../src/lane-files.ts";
import { openLaneReports, routeReports } from "../src/lane-reports.ts";
import type { Lane } from "../src/registry.ts";
import { evacuate } from "../src/runner/evacuate.ts";
import { acceptLaneEvent, type LaneHubDeps } from "../src/runner/lanes-hub.ts";
import { journalId, type AnyRunnerEvent } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const setup = async () => {
  const s = withState();
  cleanups.push(s.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, join(s.dir, "state"), {});
  await deps.registry.write({ key: "lane-a", title: "a", thread: "none", brief: join(s.dir, "a.md"), done: "x", openedAt: new Date(T0).toISOString(), status: "working", machine: "worker-a", runner: "worker-a", pane: "pa" } as unknown as Lane);
  const store = openLaneReports(deps.config);
  cleanups.push(() => { store.close(); });
  const hub: LaneHubDeps = { stateDir: deps.config.stateDir, registry: deps.registry, reports: () => store, now: clock.now, emit: () => {},
    prepareRecovery: async (_label, key) => ({ cmdId: `recover:${key}:${clock.now()}`, notes: [] }), recover: () => undefined };
  return { deps, store, hub };
};
const report = (seq: number, kind: string, text: string, evidence?: string): AnyRunnerEvent =>
  ({ v: 1, runner: "worker-a", gen: 1, epoch: 1, seq, type: "lane.report", body: { key: "lane-a", kind, text, ...(evidence ? { evidence } : {}) } }) as unknown as AnyRunnerEvent;

test("a done from a lane the runner owns arrives as a claim", async () => {
  const t = await setup();
  await acceptLaneEvent(t.hub, "worker-a", report(1, "done", "merged", "abc123"));
  expect(await routeReports(t.deps, t.store, () => {})).toEqual([expect.stringMatching(/ done claim$/)]);
  expect((await t.deps.registry.read("lane-a"))?.status).toBe("done-claimed");
});

test("evacuation imports managed snapshots using the configured central collection context", async () => {
  const t = await setup(), run = { id: "00000000-0000-4000-8000-000000000001", requiredReport: false };
  await t.deps.registry.patch("lane-a", { fileRun: run });
  const tree = { directories: [], files: [] }, files = { run, revision: 1, tree, sha256: treeDigest(tree) };
  const frame = { ...report(1, "done", "done", "saved"), body: { key: "lane-a", kind: "done" as const, text: "done", evidence: "saved", files } } as AnyRunnerEvent;
  await evacuate({ hub: t.hub, exportOutbox: async () => [frame], tellLane: async () => true, stopRunner: async () => ({ ok: true, detail: "stopped" }) }, "worker-a");
  expect(JSON.parse(readFileSync(join(t.deps.config.stateDir, "..", "research", "lane-a", ".dori-lane-files.json"), "utf8"))).toMatchObject({ key: "lane-a", run });
  await routeReports(t.deps, t.store, () => {});
  expect((await t.deps.registry.read("lane-a"))?.status).toBe("done-claimed");
});

test("evacuate imports the runner's three unacked reports under their own ids, tells the lane through its runner before the stop, keeps Lane.runner and stops the runner", async () => {
  const t = await setup();
  // One of the three already reached the supervisor before the runner became unusable.
  const unacked = [report(4, "milestone", "tests pass"), report(5, "question", "which base?"), report(6, "milestone", "PR open")];
  await acceptLaneEvent(t.hub, "worker-a", unacked[0] as AnyRunnerEvent);
  const told: string[] = [];
  const order: string[] = [];
  const lines = await evacuate({
    hub: t.hub, exportOutbox: async () => unacked,
    tellLane: async (lane, text) => { told.push(`${lane.key}: ${text}`); order.push(`tell ${lane.key}`); return true; },
    stopRunner: async (label) => { order.push(`stop ${label}`); return { ok: true, detail: "stopped" }; },
  }, "worker-a");
  const rows = t.store.list({ lane: "lane-a" });
  expect(rows.map((r) => r.source)).toEqual([journalId("worker-a", 4), journalId("worker-a", 5), journalId("worker-a", 6)]);
  expect(rows.map((r) => r.text)).toEqual(["tests pass", "which base?", "PR open"]);
  const lane = await t.deps.registry.read("lane-a");
  expect(lane?.runner).toBe("worker-a");
  expect(lane?.status).toBe("working");
  expect(told).toHaveLength(1);
  expect(told[0]).toContain("lane-a: [LEAD] the runner on worker-a is being stopped");
  expect(told[0]).not.toContain("[REPORT]");
  expect(order).toEqual(["tell lane-a", "stop worker-a"]);
  expect(lines).toEqual(["RUNNER_EVACUATE_IMPORTED runner=worker-a events=3", "RUNNER_EVACUATE_LANE lane-a told", "RUNNER_EVACUATE_STOPPED runner=worker-a"]);
});

test("evacuate names a lane the runner could not tell, and still stops the runner", async () => {
  const t = await setup();
  const lines = await evacuate({
    hub: t.hub, exportOutbox: async () => [],
    tellLane: async () => false,
    stopRunner: async () => ({ ok: true, detail: "stopped" }),
  }, "worker-a");
  expect(lines).toEqual([
    "RUNNER_EVACUATE_IMPORTED runner=worker-a events=0",
    "RUNNER_EVACUATE_LANE lane-a not told: the notice could not be sent through the runner, tell the lane by hand",
    "RUNNER_EVACUATE_STOPPED runner=worker-a",
  ]);
  expect((await t.deps.registry.read("lane-a"))?.runner).toBe("worker-a");
});
