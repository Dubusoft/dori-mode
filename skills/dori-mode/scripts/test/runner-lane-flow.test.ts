import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openLaneReports, routeReports } from "../src/lane-reports.ts";
import type { Lane } from "../src/registry.ts";
import type { Ran } from "../src/run.ts";
import { acceptLaneEvent, type LaneHubDeps } from "../src/runner/lanes-hub.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import type { AnyRunnerEvent, RunnerEventType } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const setup = async () => {
  const s = withState();
  cleanups.push(s.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, s.dir);
  const lane = { key: "lane-a", title: "lane a", thread: "none", brief: join(s.dir, "brief.md"), done: "command [\"true\"]", openedAt: new Date(T0).toISOString(), machine: "worker-a", runner: "worker-a", status: "working" } as unknown as Lane;
  await deps.registry.write(lane);
  const store = openLaneReports(deps.config);
  cleanups.push(() => { store.close(); });
  const emitted: [string, string][] = [];
  const hub: LaneHubDeps = { registry: deps.registry, reports: () => store, now: clock.now, emit: (id, line) => { emitted.push([id, line]); }, recover: () => undefined, shadow: () => false };
  let seq = 0;
  const event = (type: RunnerEventType, body: object): AnyRunnerEvent => ({ v: 1, runner: "worker-a", gen: 1, epoch: 1, seq: ++seq, type, body }) as unknown as AnyRunnerEvent;
  const journal: string[] = [];
  const route = () => routeReports(deps, store, (id) => { journal.push(id); });
  return { s, deps, store, hub, emitted, event, journal, route };
};

test("lane.start on the runner, its lane.started, then a done report make exactly one claim", async () => {
  const t = await setup();
  const runnerDir = join(t.s.dir, "runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  const published: [string, unknown][] = [];
  const herdr: [string, ...string[]][] = [];
  const lanes = new RunnerLanes({
    runnerDir, clock: fakeClock(T0), token: () => "lane-token-1",
    policy: { agents: { omo: ["omo", "--model", "{model}", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow" },
    publish: (type, body) => { published.push([type, body]); },
    run: async (argv) => {
      herdr.push(argv as [string, ...string[]]);
      if (argv.slice(0, 3).join(" ") === "herdr tab create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t7", root_pane: { pane_id: "p7", tab_id: "t7" } } }), err: "" } as Ran;
      return { code: 0, out: "", err: "" } as Ran;
    },
  });
  await lanes.start({ cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0 });
  const run = herdr.find((a) => a[2] === "run");
  expect(run?.[4]).toStartWith("DORI_LANE_KEY=lane-a DORI_LANE_TOKEN=lane-token-1 omo --model m1 ");
  expect(lanes.tokenFor("lane-a", "lane-token-1")).toBe(true);
  expect(lanes.tokenFor("lane-a", "other")).toBe(false);
  const [type, started] = published[0] as [RunnerEventType, object];
  await acceptLaneEvent(t.hub, "worker-a", t.event(type, started));
  expect((await t.deps.registry.read("lane-a"))?.pane).toBe("p7");

  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.report", { key: "lane-a", kind: "done", text: "merged", evidence: "abc123 merged" }));
  expect(await t.route()).toEqual([expect.stringMatching(/^LANE_REPORT_ROUTED lane-a:\d+:1 done claim$/)]);
  const claimed = await t.deps.registry.read("lane-a");
  expect(claimed?.status).toBe("done-claimed");

  // The same done again (a resend after a reconnect, or the lane reporting twice) keeps the one claim and its one event.
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.report", { key: "lane-a", kind: "done", text: "merged", evidence: "abc123 merged" }));
  await t.route();
  const again = await t.deps.registry.read("lane-a");
  expect(again?.claim?.at).toBe(claimed?.claim?.at);
  const rows = t.store.list({ lane: "lane-a" });
  expect(rows.map((r) => r.eventId)).toEqual([`done-claim:lane-a:${claimed?.claim?.at}`, `done-claim:lane-a:${claimed?.claim?.at}`]);
  expect(t.journal).toEqual([]);
  expect(t.emitted).toEqual([]);
});

test("the same milestone text twice is two report rows and two journal events", async () => {
  const t = await setup();
  for (let i = 0; i < 2; i++) await acceptLaneEvent(t.hub, "worker-a", t.event("lane.report", { key: "lane-a", kind: "milestone", text: "PR #5 open, CI green" }));
  await t.route();
  const rows = t.store.list({ lane: "lane-a" });
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  expect(t.journal).toEqual(rows.map((r) => `lane-report:${r.id}`));
});

test("one runner event stored twice (an evacuate import of an event that already arrived) is one row", async () => {
  const t = await setup();
  const frame = t.event("lane.report", { key: "lane-a", kind: "milestone", text: "half way" });
  await acceptLaneEvent(t.hub, "worker-a", frame);
  await acceptLaneEvent(t.hub, "worker-a", frame);
  expect(t.store.list({ lane: "lane-a" })).toHaveLength(1);
});
