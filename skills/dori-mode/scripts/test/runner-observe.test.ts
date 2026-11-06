import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastReportLine } from "../src/freshness.ts";
import type { Proc } from "../src/lane-memory.ts";
import type { Ran } from "../src/run.ts";
import { briefLane, observeHost, valueHash } from "../src/runner/observe.ts";
import { RunnerClient, yieldTurn } from "../src/runner/client.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { serveRunner, STARTUP_GRACE_MS, type ObservedLane } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import { fakeClock } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = (): string => { const d = mkdtempSync(join(tmpdir(), "runner-observe-")); dirs.push(d); return d; };

const REPORT_A = "[REPORT] lane-a | milestone | PR #12 open, CI green";
const REPORT_B_OLD = "[REPORT] lane-b | question | which base branch?";
const REPORT_B = "[REPORT] lane-b | milestone | tests pass";

const panes = [
  { pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "working" },
  { pane_id: "p2", workspace_id: "w", tab_id: "t2", agent: "omo", agent_status: "idle" },
  { pane_id: "p3", workspace_id: "w", tab_id: "t3" },
];
const screens: Record<string, string> = {
  p1: `some output\n${REPORT_A}\nmore output`,
  p2: `${REPORT_B_OLD}\nwork\n${REPORT_B}`,
  p3: "$ ls\n",
};
const info: Record<string, object> = {
  p1: { shell_pid: 100, foreground_processes: [{ pid: 101 }] },
  p2: { shell_pid: 200, foreground_processes: [{ pid: 201 }] },
  p3: { shell_pid: 300, foreground_processes: [] },
};
// The agents (101, 201) carry DORI_LANE_KEY; their shells (100, 200) and the plain pane's shell (300) carry none.
const procs: Proc[] = [
  { pid: 100, ppid: 1, rssKb: 1, comm: "sh" },
  { pid: 101, ppid: 100, rssKb: 1, comm: "omo", lane: "lane-a" },
  { pid: 200, ppid: 1, rssKb: 1, comm: "sh" },
  { pid: 201, ppid: 200, rssKb: 1, comm: "omo", lane: "lane-b" },
  { pid: 300, ppid: 1, rssKb: 1, comm: "sh" },
];
const ok = (out: string): Ran => ({ code: 0, out, err: "" } as Ran);
const herdrWith = (list: readonly object[]) => async (argv: readonly string[]): Promise<Ran> => {
  const [, noun, verb, ...rest] = argv;
  if (noun === "pane" && verb === "list") return ok(JSON.stringify({ result: { panes: list } }));
  if (noun === "pane" && verb === "process-info") return ok(JSON.stringify({ result: { process_info: info[rest[1] as string] } }));
  if (noun === "pane" && verb === "read") return ok(screens[rest[0] as string] ?? "");
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` } as Ran;
};
const fakeHerdr = herdrWith(panes);

test("observeHost finds lanes by DORI_LANE_KEY without a registry and hashes the newest [REPORT] line", async () => {
  const observed = await observeHost({ run: fakeHerdr, procs: async () => procs });
  expect(observed).toEqual([
    { key: "lane-a", pane: "p1", tab: "t1", status: "working", reportHash: valueHash(REPORT_A) },
    { key: "lane-b", pane: "p2", tab: "t2", status: "idle", reportHash: valueHash(REPORT_B) },
  ]);
  expect(lastReportLine(screens.p2 as string, "lane-b")).toBe(REPORT_B);
});

const withInfo = (override: Record<string, object>) => async (argv: readonly string[]): Promise<Ran> => {
  if (argv[1] === "pane" && argv[2] === "process-info") return ok(JSON.stringify({ result: { process_info: override[argv[4] as string] } }));
  return fakeHerdr(argv);
};
const agentArgv = (path: string): string[] => ["omo", `Read and execute the lane brief at ${path} in full. You are the lane; report as usual.`];
const argvInfo = (path: string): Record<string, object> => ({ p1: { shell_pid: 100, foreground_processes: [{ pid: 101, name: "omo", argv: agentArgv(path) }] } });

test("observeHost attributes a pane from the brief path in the agent argv when no process environment is readable", async () => {
  const observed = await observeHost({ run: withInfo(argvInfo("/tmp/dori-brief-mac-lane.md")), procs: async () => [] });
  expect(observed.map((l) => [l.key, l.pane])).toEqual([["mac-lane", "p1"]]);
});

test("observeHost attributes a Windows-style brief path in the agent argv", async () => {
  const observed = await observeHost({ run: withInfo(argvInfo(String.raw`C:\Users\x\AppData\Local\Temp\dori-brief-win-lane.md`)), procs: async () => [] });
  expect(observed.map((l) => l.key)).toEqual(["win-lane"]);
});

test("observeHost does not observe a pane whose argv names no dori-brief path", async () => {
  const run = withInfo({ p1: { shell_pid: 100, foreground_processes: [{ pid: 101, argv: ["vim", "/tmp/notes.md", "/tmp/dori-brief-x.txt"] }] } });
  expect(await observeHost({ run, procs: async () => [] })).toEqual([]);
  expect(briefLane(undefined)).toBeUndefined();
  expect(briefLane(["/tmp/dori-brief-Bad_Key.md"])).toBeUndefined();
});

test("observeHost prefers the environment attribution over a different key in the argv", async () => {
  const observed = await observeHost({ run: withInfo(argvInfo("/tmp/dori-brief-other-lane.md")), procs: async () => procs });
  expect(observed.map((l) => l.key)).toEqual(["lane-a"]);
});

test("observeHost reports a lane whose agent_status is not alive as dead", async () => {
  const unknown = panes.map((p) => (p.pane_id === "p1" ? { ...p, agent_status: "unknown" } : p));
  const observed = await observeHost({ run: herdrWith(unknown), procs: async () => procs });
  expect(observed.map((l) => [l.key, l.status])).toEqual([["lane-a", "dead"], ["lane-b", "idle"]]);
});

test("serveRunner publishes lane.state on a status change and lane.progress on a new report hash, once each", async () => {
  const dir = stateDir();
  const clock = fakeClock(1_000);
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  const client = new RunnerClient({ label: "worker-a", hostId: "h" }, { connect: async () => { throw new Error("offline"); }, outbox, state, clock });
  let view: ObservedLane[] = [{ key: "lane-a", pane: "p1", tab: "t1", status: "working", reportHash: "h1" }];
  let observeTick: (() => void) | undefined;
  const abort = new AbortController();
  const serving = serveRunner({
    client, latest: () => undefined, clock, heartbeatMs: 15_000, observeMs: 30_000, log: () => {},
    every: (ms, tick) => { if (ms === 30_000) observeTick = tick; return () => {}; },
    observe: async () => view,
  }, abort.signal);
  await yieldTurn();
  observeTick?.();
  await yieldTurn();
  view = [{ key: "lane-a", pane: "p1", tab: "t1", status: "working", reportHash: "h2" }];
  observeTick?.();
  await yieldTurn();
  abort.abort();
  await serving;
  expect(outbox.unacked(0).map((r) => [r.type, r.body])).toEqual([
    ["lane.state", { key: "lane-a", status: "working", pane: "p1" }],
    ["lane.progress", { key: "lane-a", reportHash: "h1" }],
    ["lane.progress", { key: "lane-a", reportHash: "h2" }],
  ]);
  outbox.close();
  state.close();
});

test("serveRunner holds back dead for a starting lane until its agent was seen alive or the startup grace ends", async () => {
  const dir = stateDir();
  const clock = fakeClock(1_000);
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  const client = new RunnerClient({ label: "worker-a", hostId: "h" }, { connect: async () => { throw new Error("offline"); }, outbox, state, clock });
  // lane-a: herdr names its fresh agent unknown (dead), then working, then the agent really stops.
  // lane-b: its agent never comes up.
  const steps: { readonly at: number; readonly view: ObservedLane[] }[] = [
    { at: 1_000, view: [{ key: "lane-a", pane: "p1", tab: "t1", status: "dead" }, { key: "lane-b", pane: "p2", tab: "t2", status: "dead" }] },
    { at: 31_000, view: [{ key: "lane-a", pane: "p1", tab: "t1", status: "working" }, { key: "lane-b", pane: "p2", tab: "t2", status: "dead" }] },
    { at: 61_000, view: [{ key: "lane-a", pane: "p1", tab: "t1", status: "dead" }, { key: "lane-b", pane: "p2", tab: "t2", status: "dead" }] },
    { at: 1_000 + STARTUP_GRACE_MS, view: [{ key: "lane-a", pane: "p1", tab: "t1", status: "dead" }, { key: "lane-b", pane: "p2", tab: "t2", status: "dead" }] },
  ];
  let step = 0;
  let observeTick: (() => void) | undefined;
  const abort = new AbortController();
  const serving = serveRunner({
    client, latest: () => undefined, clock, heartbeatMs: 15_000, observeMs: 30_000, log: () => {},
    every: (ms, tick) => { if (ms === 30_000) observeTick = tick; return () => {}; },
    observe: async () => steps[step]?.view ?? [],
  }, abort.signal);
  await yieldTurn();
  const published = (): unknown[] => outbox.unacked(0).map((r) => r.body);
  expect(published()).toEqual([]);
  for (step = 1; step < steps.length; step++) { clock.at = steps[step]?.at ?? 0; observeTick?.(); await yieldTurn(); }
  abort.abort();
  await serving;
  expect(published()).toEqual([
    { key: "lane-a", status: "working", pane: "p1" },
    { key: "lane-a", status: "dead", pane: "p1" },
    { key: "lane-b", status: "dead", pane: "p2" },
  ]);
  outbox.close();
  state.close();
});

test("serveRunner republishes lane.state on a pane change and after a lane was gone and came back", async () => {
  const dir = stateDir();
  const clock = fakeClock(1_000);
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  const client = new RunnerClient({ label: "worker-a", hostId: "h" }, { connect: async () => { throw new Error("offline"); }, outbox, state, clock });
  const views: ObservedLane[][] = [
    [{ key: "lane-a", pane: "p1", tab: "t1", status: "idle" }],
    [{ key: "lane-a", pane: "p7", tab: "t1", status: "idle" }],
    [],
    [{ key: "lane-a", pane: "p7", tab: "t1", status: "idle" }],
  ];
  let view = 0;
  let observeTick: (() => void) | undefined;
  const abort = new AbortController();
  const serving = serveRunner({
    client, latest: () => undefined, clock, heartbeatMs: 15_000, observeMs: 30_000, log: () => {},
    every: (ms, tick) => { if (ms === 30_000) observeTick = tick; return () => {}; },
    observe: async () => views[Math.min(view++, views.length - 1)] ?? [],
  }, abort.signal);
  await yieldTurn();
  for (let i = 1; i < views.length; i++) { observeTick?.(); await yieldTurn(); }
  abort.abort();
  await serving;
  expect(outbox.unacked(0).map((r) => [r.type, r.body])).toEqual([
    ["lane.state", { key: "lane-a", status: "idle", pane: "p1" }],
    ["lane.state", { key: "lane-a", status: "idle", pane: "p7" }],
    ["lane.state", { key: "lane-a", status: "idle", pane: "p7" }],
  ]);
  outbox.close();
  state.close();
});
