import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openLaneReports, routeReports } from "../src/lane-reports.ts";
import type { Lane } from "../src/registry.ts";
import type { Ran } from "../src/run.ts";
import { Database } from "bun:sqlite";
import { eventLine, HUB_FILE } from "../src/runner/hub.ts";
import { acceptLaneEvent, laneEventsAfter, type LaneHubDeps } from "../src/runner/lanes-hub.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { runnerEffects } from "../src/runner/main.ts";
import { DEFAULT_POLICY } from "../src/runner/policy.ts";
import { commandDispatcher } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import type { AnyRunnerEvent, RunnerEventBodies, RunnerEventType } from "../src/runner/protocol.ts";
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
  const hub: LaneHubDeps = { registry: deps.registry, reports: () => store, now: clock.now, emit: (id, line) => { emitted.push([id, line]); }, recover: () => undefined };
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
    instance: async () => "server-1",
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
  expect(run?.[4]).toStartWith(`DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=${lanes.tokenPath("lane-a")} omo --model m1 `);
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

test("a lane.start the runner refused, read back from the hub journal, raises one RUNNER_LAUNCH_FAILED; other results raise nothing", async () => {
  const t = await setup();
  const db = new Database(join(t.s.dir, HUB_FILE), { create: true });
  db.run("CREATE TABLE runner_events (id TEXT PRIMARY KEY, line TEXT NOT NULL, at INTEGER NOT NULL)");
  const results = [
    { cmdId: "lane-start:lane-a:1", cmdSeq: 1, state: "failed", detail: "RUNNER_CMD_REJECTED agent-profile" },
    { cmdId: "lane-start:lane-a:2", cmdSeq: 2, state: "verified", detail: "started" },
    { cmdId: "lane-stop:lane-a:3", cmdSeq: 3, state: "failed", detail: "gone" },
  ];
  for (const body of results) { const e = t.event("cmd.result", body); db.query("INSERT INTO runner_events VALUES (?, ?, ?)").run(`runner:worker-a:${e.seq}`, eventLine(e), T0); }
  db.close();
  for (const e of laneEventsAfter(t.s.dir, 0)) await acceptLaneEvent(t.hub, e.label, e.frame);
  expect(t.emitted).toEqual([["runner-launch-failed:worker-a:1", expect.stringMatching(/^RUNNER_LAUNCH_FAILED lane-a runner=worker-a RUNNER_CMD_REJECTED agent-profile; /)]]);
  // Once the lane has a pane, a late failure for an older start says nothing.
  await t.deps.registry.update("lane-a", (l) => (l ? { ...l, pane: "p7" } : undefined));
  await acceptLaneEvent(t.hub, "worker-a", t.event("cmd.result", results[0] as object));
  expect(t.emitted).toHaveLength(1);
});

test("one runner event stored twice (an evacuate import of an event that already arrived) is one row", async () => {
  const t = await setup();
  const frame = t.event("lane.report", { key: "lane-a", kind: "milestone", text: "half way" });
  await acceptLaneEvent(t.hub, "worker-a", frame);
  await acceptLaneEvent(t.hub, "worker-a", frame);
  expect(t.store.list({ lane: "lane-a" })).toHaveLength(1);
});

test("an effect's {detail, result} goes out in cmd.result.result and the lanes hub takes the result like a detail-only one", async () => {
  const t = await setup();
  const runnerDir = join(t.s.dir, "runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  const state = new RunnerState(runnerDir, { now: () => T0 });
  cleanups.push(() => { state.close(); });
  const published: RunnerEventBodies["cmd.result"][] = [];
  let settled: () => void = () => {};
  const dispatch = commandDispatcher({
    state, policy: { ...DEFAULT_POLICY, agents: { default: ["omo"] }, allowedRoots: ["/repo"] }, realpath: (p) => p, log: () => {},
    publish: (body) => { published.push(body); settled(); },
    effects: {
      "lane.start": async () => ({ detail: "started lane-a pane=p7", result: { pane: "p7", tab: "t7", startup: { verdict: "ok", detail: "working" } } }),
      "lane.stop": async () => "closed",
    },
  });
  const sent = (n: number) => new Promise<void>((resolve) => { settled = () => { if (published.length >= n) resolve(); }; });
  const first = sent(1);
  dispatch({ v: 1, runner: "worker-a", gen: 1, epoch: 1, cmdSeq: 1, type: "lane.start", body: {
    cmdId: "lane-start:lane-a:1", key: "lane-a", briefText: "# b\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "default", mode: "ulw", model: "m", sandbox: false, expectedLaneGen: 0,
  } });
  await first;
  const second = sent(2);
  dispatch({ v: 1, runner: "worker-a", gen: 1, epoch: 1, cmdSeq: 2, type: "lane.stop", body: { cmdId: "lane-stop:lane-a:2", key: "lane-a" } });
  await second;
  expect(published).toEqual([
    { cmdId: "lane-start:lane-a:1", cmdSeq: 1, state: "verified", detail: "started lane-a pane=p7", result: { pane: "p7", tab: "t7", startup: { verdict: "ok", detail: "working" } } },
    { cmdId: "lane-stop:lane-a:2", cmdSeq: 2, state: "verified", detail: "closed" },
  ]);
  for (const body of published) await acceptLaneEvent(t.hub, "worker-a", t.event("cmd.result", body));
  expect(t.emitted).toEqual([]);
});

test("the runner's effects table answers lane.start, lane.notify, lane.observe and guard.kill with their structured results", async () => {
  const t = await setup();
  const runnerDir = join(t.s.dir, "runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  const state = new RunnerState(runnerDir, { now: () => T0 });
  cleanups.push(() => { state.close(); });
  const policy = { ...DEFAULT_POLICY, agents: { sandboxed: ["lane-sandbox", "omo", "{prompt}"] }, allowedRoots: ["/repo"] };
  const herdr = async (argv: readonly string[]): Promise<Ran> => {
    if (argv.slice(0, 3).join(" ") === "herdr tab create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t7", root_pane: { pane_id: "p7", tab_id: "t7" } } }), err: "" } as Ran;
    if (argv.slice(0, 3).join(" ") === "herdr pane list") return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "p7", workspace_id: "w", tab_id: "t7", agent: "omo", agent_status: "working" }] } }), err: "" } as Ran;
    return { code: 0, out: "", err: "" } as Ran;
  };
  const lanes = new RunnerLanes({ instance: async () => "server-1", runnerDir, run: herdr, clock: fakeClock(T0), policy, publish: () => {}, token: () => "tok", startup: async () => ({ verdict: "ok", detail: "ready" }) });
  const published: RunnerEventBodies["cmd.result"][] = [];
  let waiting: { n: number; resolve: () => void } | undefined;
  const dispatch = commandDispatcher({
    state, policy, realpath: (p) => p, log: () => {},
    publish: (body) => { published.push(body); if (waiting && published.length >= waiting.n) waiting.resolve(); },
    effects: runnerEffects({ lanes, guard: { killLanes: async (keys) => keys.map((k, i) => ({ pid: 40 + i, lane: k, comm: "qemu", rssKb: 9 })) }, run: herdr }),
  });
  const send = async (cmdSeq: number, type: string, body: object): Promise<void> => {
    const done = new Promise<void>((resolve) => { waiting = { n: cmdSeq, resolve }; });
    dispatch({ v: 1, runner: "local", gen: 1, epoch: 1, cmdSeq, type, body });
    await done;
  };
  await send(1, "lane.start", { cmdId: "lane-start:lane-a:1", key: "lane-a", briefText: "# b\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "sandboxed", mode: "ulw", model: "m", sandbox: true, expectedLaneGen: 0 });
  await send(2, "lane.notify", { cmdId: "lane.notify:lane-a:2:1", key: "lane-a", status: "done-claimed", claim: { at: "2026-11-06T00:00:00Z", evidence: "abc" } });
  await send(3, "lane.observe", { cmdId: "lane.observe:lane-a:3:1", key: "lane-a" });
  await send(4, "guard.kill", { cmdId: "guard.kill:-:4:1", keys: ["lane-a"] });
  expect(published.map(({ state: s, detail, result }) => ({ s, detail, result }))).toEqual([
    { s: "verified", detail: "started pane=p7 tab=t7", result: { pane: "p7", tab: "t7", startup: { verdict: "ok", detail: "ready" } } },
    { s: "verified", detail: "noted done-claimed", result: {} },
    { s: "verified", detail: "observed working", result: { status: "working" } },
    { s: "verified", detail: "killed 1", result: { killed: [{ pid: 40, comm: "qemu", rssKb: 9, lane: "lane-a" }] } },
  ]);
  expect(lanes.notice("lane-a")).toEqual({ status: "done-claimed", claim: { at: "2026-11-06T00:00:00Z", evidence: "abc" } });
});
