import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastReportLine } from "../src/freshness.ts";
import type { Proc } from "../src/lane-memory.ts";
import type { Lane } from "../src/registry.ts";
import type { Ran } from "../src/run.ts";
import { HUB_FILE } from "../src/runner/hub.ts";
import { observeHost } from "../src/runner/observe.ts";
import type { AnyRunnerEvent } from "../src/runner/protocol.ts";
import { RunnerClient, yieldTurn } from "../src/runner/client.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { ShadowObserver, serveRunner, type ObservedLane } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import { fakeClock } from "./fakes.ts";
import { valueHash } from "../src/runner/shadow.ts";
import { recordDiffLines, renderShadowReport, shadowReport } from "../src/runner/shadow-store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = (): string => { const d = mkdtempSync(join(tmpdir(), "runner-remote-shadow-")); dirs.push(d); return d; };

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
const fakeHerdr = async (argv: readonly string[]): Promise<Ran> => {
  const [, noun, verb, ...rest] = argv;
  if (noun === "pane" && verb === "list") return ok(JSON.stringify({ result: { panes } }));
  if (noun === "pane" && verb === "process-info") return ok(JSON.stringify({ result: { process_info: info[rest[1] as string] } }));
  if (noun === "pane" && verb === "read") return ok(screens[rest[0] as string] ?? "");
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` } as Ran;
};

const lane = (key: string, pane: string, lastRemoteReport?: string): Lane =>
  ({ key, title: key, thread: "none", brief: "b", done: [], openedAt: "2026-11-05T00:00:00Z", machine: "worker-a", pane, ...(lastRemoteReport ? { lastRemoteReport } : {}) }) as unknown as Lane;
const event = (type: string, body: object): AnyRunnerEvent => ({ v: 1, runner: "worker-a", gen: 1, epoch: 1, seq: 1, type, body }) as unknown as AnyRunnerEvent;

const feed = (observer: ShadowObserver, observed: Awaited<ReturnType<typeof observeHost>>): void => {
  observer.hello("worker-a", observed.map(({ key, pane, tab }) => ({ key, pane, tab })));
  for (const l of observed) {
    observer.event("worker-a", event("lane.state", { key: l.key, status: l.status }));
    if (l.reportHash) observer.event("worker-a", event("lane.progress", { key: l.key, reportHash: l.reportHash }));
  }
};

test("observeHost finds lanes by DORI_LANE_KEY without a registry and hashes the newest [REPORT] line", async () => {
  const observed = await observeHost({ run: fakeHerdr, procs: async () => procs });
  expect(observed).toEqual([
    { key: "lane-a", pane: "p1", tab: "t1", status: "working", reportHash: valueHash(REPORT_A) },
    { key: "lane-b", pane: "p2", tab: "t2", status: "idle", reportHash: valueHash(REPORT_B) },
  ]);
  expect(lastReportLine(screens.p2 as string, "lane-b")).toBe(REPORT_B);
});

test("matching legacy and runner views record no failures", async () => {
  const dir = stateDir();
  const observer = new ShadowObserver();
  feed(observer, await observeHost({ run: fakeHerdr, procs: async () => procs }));
  const lanes = [lane("lane-a", "p1", REPORT_A), lane("lane-b", "p2", REPORT_B)];
  const lines = [...observer.cycle("worker-a", lanes), ...observer.cycle("worker-a", lanes)];
  expect(lines).toEqual([]);
  expect(recordDiffLines(dir, lines, 1)).toBe(0);
  expect(shadowReport(dir)).toEqual([]);
});

test("a lane the runner does not see, and a different newest report, count as failures; a passing gap is timing", async () => {
  const dir = stateDir();
  const observer = new ShadowObserver();
  const observed = await observeHost({ run: fakeHerdr, procs: async () => procs.filter((p) => p.lane !== "lane-b") });
  feed(observer, observed);
  const lanes = [lane("lane-a", "p1", REPORT_A), lane("lane-b", "p2", REPORT_B), lane("lane-c", "p9", REPORT_A)];
  let at = 1;
  const cycle = (): string[] => { const lines = observer.cycle("worker-a", lanes); recordDiffLines(dir, lines, at++); return lines; };
  expect(cycle()).toEqual([]);
  const settled = cycle();
  expect(settled.every((l) => l.includes("class=missing-in-runner"))).toBe(true);
  expect(settled.some((l) => l.includes("lane=lane-b kind=") || l.includes("kind=inventory.pane lane=lane-b"))).toBe(true);

  // lane-a's legacy view moves on to a report the runner has not read yet; the runner catches up one cycle later.
  lanes[0] = lane("lane-a", "p1", "[REPORT] lane-a | done | merged");
  expect(cycle()).toEqual([]);
  observer.event("worker-a", event("lane.progress", { key: "lane-a", reportHash: valueHash("[REPORT] lane-a | done | merged") }));
  const caughtUp = cycle();
  expect(caughtUp.some((l) => l.includes("class=timing") && l.includes("lane=lane-a"))).toBe(true);

  const [row] = shadowReport(dir, { runner: "worker-a" });
  expect(row?.counts.timing).toBeGreaterThanOrEqual(1);
  expect(row?.counts["missing-in-runner"]).toBeGreaterThanOrEqual(2);
  expect(row?.failures).toBe((row?.counts["missing-in-runner"] ?? 0) + (row?.counts["missing-in-legacy"] ?? 0) + (row?.counts["value-differs"] ?? 0));
  expect(renderShadowReport(shadowReport(dir))).toMatch(/^RUNNER_SHADOW_REPORT runner=worker-a failures=\d+ missing-in-runner=\d+ missing-in-legacy=\d+ value-differs=\d+ timing=\d+$/);
  expect(statSync(join(dir, HUB_FILE)).mode & 0o777).toBe(0o600);
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
    ["lane.state", { key: "lane-a", status: "working" }],
    ["lane.progress", { key: "lane-a", reportHash: "h1" }],
    ["lane.progress", { key: "lane-a", reportHash: "h2" }],
  ]);
  outbox.close();
  state.close();
});

test("a newest report that stays different is value-differs", async () => {
  const dir = stateDir();
  const observer = new ShadowObserver();
  feed(observer, await observeHost({ run: fakeHerdr, procs: async () => procs }));
  const lanes = [lane("lane-a", "p1", REPORT_A), lane("lane-b", "p2", REPORT_B_OLD)];
  observer.cycle("worker-a", lanes);
  const lines = observer.cycle("worker-a", lanes);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("class=value-differs kind=lane.report lane=lane-b");
  recordDiffLines(dir, lines, 1);
  expect(shadowReport(dir)[0]?.failures).toBe(1);
});
