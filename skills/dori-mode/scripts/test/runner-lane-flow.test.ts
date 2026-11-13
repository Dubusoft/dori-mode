import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { treeDigest } from "../src/lane-files.ts";
import { join } from "node:path";
import { openLaneReports, routeReports } from "../src/lane-reports.ts";
import type { Lane } from "../src/registry.ts";
import type { Ran } from "../src/run.ts";
import { Database } from "bun:sqlite";
import { eventLine, HUB_FILE } from "../src/runner/hub.ts";
import { acceptLaneEvent, laneEventsAfter, type LaneHubDeps } from "../src/runner/lanes-hub.ts";
import { RunnerLanes } from "../src/runner/lanes.ts";
import { runnerEffects } from "../src/runner/main.ts";
import { DEFAULT_POLICY, parsePolicy } from "../src/runner/policy.ts";
import { commandDispatcher } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import type { AnyRunnerEvent, RunnerEventBodies, RunnerEventType } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };

const T0 = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const setup = async () => {
  const s = withState();
  cleanups.push(s.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, join(s.dir, "state"));
  const lane = { key: "lane-a", title: "lane a", thread: "none", brief: join(s.dir, "brief.md"), done: "command [\"true\"]", openedAt: new Date(T0).toISOString(), machine: "worker-a", runner: "worker-a", status: "working" } as unknown as Lane;
  await deps.registry.write(lane);
  const store = openLaneReports(deps.config);
  cleanups.push(() => { store.close(); });
  const emitted: [string, string][] = [];
  const hub: LaneHubDeps = { stateDir: deps.config.stateDir, registry: deps.registry, reports: () => store, now: clock.now, emit: (id, line) => { emitted.push([id, line]); },
    prepareRecovery: async (_label, key) => ({ cmdId: `recover:${key}:${clock.now()}`, notes: [] }), recover: () => undefined };
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
    policy: { agents: { omo: ["omo", "--model", "{model}", "{prompt}"] }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] },
    publish: (type, body) => { published.push([type, body]); },
    run: async (argv) => {
      herdr.push(argv as [string, ...string[]]);
      if (argv[0] === "lane-sandbox") return { code: 0, out: "DORI_LANE_FILES=1\n", err: "" } as Ran;
      if (argv.slice(0, 3).join(" ") === "herdr tab create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t7", root_pane: { pane_id: "p7", tab_id: "t7" } } }), err: "" } as Ran;
      return { code: 0, out: "", err: "" } as Ran;
    },
  });
  await t.deps.registry.patch("lane-a", { fileRun: FILES.run });
  await lanes.start({ cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0, files: FILES });
  const run = herdr.find((a) => a[2] === "run");
  expect(run?.[4]).toStartWith(`DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=${lanes.tokenPath("lane-a")} DORI_LANE_OUT=${join(runnerDir, "briefs", "lane-a.out")} omo --model m1 `);
  expect(lanes.tokenFor("lane-a", "lane-token-1")).toBe(true);
  expect(lanes.tokenFor("lane-a", "other")).toBe(false);
  const [type, started] = published[0] as [RunnerEventType, object];
  await acceptLaneEvent(t.hub, "worker-a", t.event(type, started));
  expect((await t.deps.registry.read("lane-a"))?.pane).toBe("p7");

  const binary = Buffer.from([0, 255, 128, 1]);
  writeFileSync(join(runnerDir, "briefs/lane-a.out/report.bin"), binary);
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.report", { key: "lane-a", kind: "done", text: "merged", evidence: "abc123 merged", files: lanes.reportFiles("lane-a") }));
  expect(readFileSync(join(t.s.dir, "research/lane-a/report.bin"))).toEqual(binary);
  expect((await t.deps.registry.read("lane-a"))?.claim).toBeUndefined();
  expect(await t.route()).toEqual([expect.stringMatching(/^LANE_REPORT_ROUTED lane-a:\d+:1 done claim$/)]);
  const claimed = await t.deps.registry.read("lane-a");
  expect(claimed?.status).toBe("done-claimed");

  // The same done again (a resend after a reconnect, or the lane reporting twice) keeps the one claim and its one event.
  await acceptLaneEvent(t.hub, "worker-a", t.event("lane.report", { key: "lane-a", kind: "done", text: "merged", evidence: "abc123 merged", files: lanes.reportFiles("lane-a") }));
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

test("durable managed binary bytes install before their report row and claim, with no runner query", async () => {
  const t = await setup(), run = { id: "00000000-0000-4000-8000-000000000001", requiredReport: true };
  await t.deps.registry.patch("lane-a", { fileRun: run, pane: "p7" });
  const data = Buffer.from([0, 255, 1, 128]), tree = { directories: ["empty"], files: [
    { path: "report.bin", bytes: data.length, base64: data.toString("base64"), sha256: createHash("sha256").update(data).digest("hex") },
  ] };
  const files = { run, revision: 1, tree, sha256: treeDigest(tree) };
  const event = t.event("lane.report", { key: "lane-a", kind: "done", text: "done", evidence: "binary", files });
  await acceptLaneEvent(t.hub, "worker-a", event);
  expect((await t.deps.registry.read("lane-a"))?.claim).toBeUndefined();
  expect(readFileSync(join(t.s.dir, "research", "lane-a", "report.bin"))).toEqual(data);
  expect(t.store.pending()[0]?.fileReceipt).toEqual({ run, revision: 1, sha256: files.sha256 });
  await t.route(); await acceptLaneEvent(t.hub, "worker-a", event); await t.route();
  expect(t.store.list()).toHaveLength(1);
  expect((await t.deps.registry.read("lane-a"))?.status).toBe("done-claimed");
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
    cmdId: "lane-start:lane-a:1", key: "lane-a", briefText: "# b\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "default", mode: "ulw", model: "m", sandbox: false, expectedLaneGen: 0, files: FILES,
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

test("the runner's effects table answers lane.start, lane.notify, lane.observe, guard.kill and lane.attach with their structured results", async () => {
  const t = await setup();
  const runnerDir = join(t.s.dir, "runner");
  mkdirSync(runnerDir, { mode: 0o700 });
  const state = new RunnerState(runnerDir, { now: () => T0 });
  cleanups.push(() => { state.close(); });
  const policy = { ...DEFAULT_POLICY, sandboxCheck: ["lane-sandbox", "--check"], agents: { sandboxed: ["lane-sandbox", "omo", "{prompt}"] }, allowedRoots: ["/repo"] };
  const herdr = async (argv: readonly string[]): Promise<Ran> => {
    if (argv[0] === "lane-sandbox") return { code: 0, out: "DORI_LANE_FILES=1\n", err: "" } as Ran;
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
  await send(1, "lane.start", { cmdId: "lane-start:lane-a:1", key: "lane-a", briefText: "# b\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "sandboxed", mode: "ulw", model: "m", sandbox: true, expectedLaneGen: 0, files: FILES });
  await send(2, "lane.notify", { cmdId: "lane.notify:lane-a:2:1", key: "lane-a", status: "done-claimed", claim: { at: "2026-11-06T00:00:00Z", evidence: "abc" } });
  await send(3, "lane.observe", { cmdId: "lane.observe:lane-a:3:1", key: "lane-a" });
  await send(4, "guard.kill", { cmdId: "guard.kill:-:4:1", keys: ["lane-a"] });
  const added = Buffer.from("added later");
  await send(5, "lane.attach", { cmdId: "lane.attach:lane-a:5:1", key: "lane-a", tree: { directories: ["r0000"], files: [{ path: "r0000/more.md", bytes: added.length, sha256: createHash("sha256").update(added).digest("hex"), base64: added.toString("base64") }] } });
  expect(published.map(({ state: s, detail, result }) => ({ s, detail, result }))).toEqual([
    { s: "verified", detail: "started pane=p7 tab=t7", result: { pane: "p7", tab: "t7", startup: { verdict: "ok", detail: "ready" }, cwd: "/repo" } },
    { s: "verified", detail: "noted done-claimed", result: {} },
    { s: "verified", detail: "observed working", result: { status: "working" } },
    { s: "verified", detail: "killed 1", result: { killed: [{ pid: 40, comm: "qemu", rssKb: 9, lane: "lane-a" }] } },
    { s: "verified", detail: `attached files=1 dir=${join(runnerDir, "briefs/lane-a.files/a0001")}`, result: { dir: join(runnerDir, "briefs/lane-a.files/a0001") } },
  ]);
  expect(readFileSync(join(runnerDir, "briefs/lane-a.files/a0001/r0000/more.md"), "utf8")).toBe("added later");
  expect(lanes.notice("lane-a")).toEqual({ status: "done-claimed", claim: { at: "2026-11-06T00:00:00Z", evidence: "abc" } });
});

test("a lane.start without cwd creates <runnerDir>/lanes/<key>, opens its tab there and reports that directory", async () => {
  const t = await setup();
  const runnerDir = join(realpathSync(t.s.dir), "runner");
  mkdirSync(join(runnerDir, "lanes"), { recursive: true, mode: 0o700 });
  const state = new RunnerState(runnerDir, { now: () => T0 });
  cleanups.push(() => { state.close(); });
  // A file that still names the retired defaultCwd: ignored, the lanes directory is admitted on its own.
  const policy = parsePolicy({ agents: { default: ["omo", "{prompt}"] }, allowedRoots: ["/repo"], defaultCwd: "/repo/work" }, "/home/u", "/tmp", { runnerDir });
  const laneDir = join(runnerDir, "lanes", "lane-a");
  const calls: string[][] = [];
  const herdr = async (argv: readonly string[]): Promise<Ran> => {
    calls.push([...argv]);
    if (argv.slice(0, 3).join(" ") === "herdr tab create") return { code: 0, out: JSON.stringify({ result: { tab_id: "t7", root_pane: { pane_id: "p7", tab_id: "t7" } } }), err: "" } as Ran;
    return { code: 0, out: "", err: "" } as Ran;
  };
  const lanes = new RunnerLanes({ instance: async () => "server-1", runnerDir, run: herdr, clock: fakeClock(T0), policy, publish: () => {}, token: () => "tok", startup: async () => ({ verdict: "ok", detail: "ready" }) });
  const published: RunnerEventBodies["cmd.result"][] = [];
  const done = new Promise<void>((resolve) => {
    const dispatch = commandDispatcher({ state, policy, realpath: realpathSync, runnerDir, log: () => {}, publish: (body) => { published.push(body); resolve(); }, effects: runnerEffects({ lanes, guard: { killLanes: async () => [] }, run: herdr }) });
    dispatch({ v: 1, runner: "local", gen: 1, epoch: 1, cmdSeq: 1, type: "lane.start", body: { cmdId: "lane-start:lane-a:1", key: "lane-a", briefText: "# b\n", done: "x", thread: "none", agentProfile: "default", mode: "ulw", model: "m", sandbox: false, expectedLaneGen: 0, files: FILES } });
  });
  await done;
  expect(published[0]).toMatchObject({ state: "verified", result: { pane: "p7", cwd: laneDir } });
  expect(statSync(laneDir).isDirectory()).toBe(true);
  expect(statSync(laneDir).mode & 0o777).toBe(0o700);
  expect(calls.find((a) => a.slice(0, 3).join(" ") === "herdr tab create")).toContain(laneDir);
});
