import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { eventClass } from "../src/event-policy.ts";
import { INLINE_REPORT_MAX, JsonLaneReports, type LaneReportStore, openLaneReports, POISON_ALERT_AFTER, routeReports, SqliteLaneReports } from "../src/lane-reports.ts";
import { launchLane } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { depsFor, fakeClock, newWorld, withSqliteStore, withState } from "./fakes.ts";

setDefaultTimeout(30_000);

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const stateDir = (): string => {
  const state = withState();
  cleanups.push(state.done);
  return state.dir;
};

const STORES: readonly (readonly [string, (dir: string) => LaneReportStore])[] = [
  ["json", (dir) => new JsonLaneReports(dir)],
  ["sqlite", (dir) => {
    new SqliteStore(join(dir, SQLITE_FILE), { create: true }).close();
    return new SqliteLaneReports(join(dir, SQLITE_FILE));
  }],
];

const lane = (dir: string, patch: Partial<Lane> = {}): Lane => ({
  key: "local-lane", title: "t", thread: "discord:1/2", pane: "w:p7", brief: join(dir, "brief.md"), done: "closed acme/app#3",
  openedAt: new Date(T0).toISOString(), ...patch,
});

test.each(STORES)("%s store: a consumed row records the event it became, the done claim's id included", async (_name, open) => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir));
  await deps.registry.write(lane(dir, { key: "gone-lane", closedAt: new Date(T0).toISOString() }));
  const store = open(dir);
  cleanups.push(() => { store.close(); });
  store.append({ lane: "local-lane", generation: 0, kind: "question", text: "which base?", at: T0 });
  store.append({ lane: "gone-lane", generation: 0, kind: "blocked", text: "late", at: T0 });
  store.append({ lane: "local-lane", generation: 0, kind: "done", text: "merged", evidence: "merged acme/app#3", at: T0 + 1 });
  await routeReports(deps, store, () => {});
  const claim = (await deps.registry.read("local-lane"))?.claim;
  expect(claim).toBeDefined();
  expect(store.list().map((r) => [r.id, r.route, r.eventId])).toEqual([
    ["gone-lane:0:1", "late", "lane-report-late:gone-lane:0:1"],
    ["local-lane:0:1", "journal", "lane-report:local-lane:0:1"],
    ["local-lane:0:2", "claim", `done-claim:local-lane:${claim?.at}`],
  ]);
});

test("sqlite: a lane_reports table made before event_id existed still loads, and gains the column", () => {
  const dir = stateDir();
  new SqliteStore(join(dir, SQLITE_FILE), { create: true }).close();
  const db = new Database(join(dir, SQLITE_FILE));
  db.exec(`CREATE TABLE lane_reports (id TEXT PRIMARY KEY, lane TEXT NOT NULL, generation INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
    text TEXT NOT NULL, evidence TEXT, at INTEGER NOT NULL, consumed_at INTEGER, route TEXT, UNIQUE (lane, seq))`);
  db.query("INSERT INTO lane_reports (id, lane, generation, seq, kind, text, at, consumed_at, route) VALUES ('a:0:1', 'a', 0, 1, 'progress', 'old', ?, ?, 'thread')").run(T0, T0 + 1);
  db.close();
  const store = new SqliteLaneReports(join(dir, SQLITE_FILE));
  cleanups.push(() => { store.close(); });
  expect(store.list()).toEqual([{ id: "a:0:1", lane: "a", generation: 0, seq: 1, kind: "progress", text: "old", at: T0, consumedAt: T0 + 1, route: "thread" }]);
  store.append({ lane: "a", generation: 0, kind: "question", text: "new", at: T0 + 2 });
  store.consume("a:0:2", T0 + 3, "journal", "lane-report:a:0:2");
  expect(store.list({ lane: "a" })[1]?.eventId).toBe("lane-report:a:0:2");
});

test("a long or many-line report is saved to a file and its event carries a cut summary and the path; a short one stays inline", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir));
  const store = new JsonLaneReports(dir);
  const long = `${"x".repeat(INLINE_REPORT_MAX + 50)} tail`;
  store.append({ lane: "local-lane", generation: 0, kind: "question", text: long, at: T0 });
  store.append({ lane: "local-lane", generation: 0, kind: "blocked", text: "line 1\nline 2\nline 3\nline 4", at: T0 + 1 });
  store.append({ lane: "local-lane", generation: 0, kind: "question", text: "short?", at: T0 + 2 });
  const journal: string[] = [];
  await routeReports(deps, store, (_id, line) => { journal.push(line); });
  const first = join(dir, "reports", "local-lane_0_1.txt");
  const second = join(dir, "reports", "local-lane_0_2.txt");
  expect(journal).toEqual([
    `LANE_REPORT local-lane question ${"x".repeat(INLINE_REPORT_MAX)}... (full report: ${first})`,
    `LANE_REPORT local-lane blocked line 1 line 2 line 3 line 4 (full report: ${second})`,
    "LANE_REPORT local-lane question short?",
  ]);
  expect(readFileSync(first, "utf8")).toContain(long);
  expect(readFileSync(second, "utf8")).toContain("line 1\nline 2\nline 3\nline 4");
  expect(eventClass(journal[1] ?? "", deps.tunables.eventPolicy)).toBe("lead-urgent");
});

test("generation fence: a row stamped before the lane's last relaunch is late, never the lane's; unfenced and current rows route", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0 + 10 * MIN), dir);
  const relaunchedAt = T0 + 5 * MIN;
  await deps.registry.write(lane(dir, { lastRecoveryAt: relaunchedAt }));
  const store = new JsonLaneReports(dir);
  store.append({ lane: "local-lane", generation: T0, kind: "done", text: "old session done", evidence: "abc", at: T0 + 6 * MIN });
  store.append({ lane: "local-lane", generation: 0, kind: "question", text: "unfenced", at: T0 + 7 * MIN });
  store.append({ lane: "local-lane", generation: relaunchedAt, kind: "question", text: "current", at: T0 + 8 * MIN });
  const journal: [string, string][] = [];
  expect(await routeReports(deps, store, (id, line) => { journal.push([id, line]); })).toEqual([
    `LANE_REPORT_ROUTED local-lane:${T0}:1 done late`, "LANE_REPORT_ROUTED local-lane:0:2 question journal",
    `LANE_REPORT_ROUTED local-lane:${relaunchedAt}:3 question journal`,
  ]);
  expect(journal[0]).toEqual([`lane-report-late:local-lane:${T0}:1`, "LANE_REPORT_LATE local-lane done old session done (evidence: abc) (from a replaced session)"]);
  // The replaced session's done row did not claim for the lane.
  expect((await deps.registry.read("local-lane"))?.claim).toBeUndefined();
});

test("a poison row raises one urgent REPORT_STUCK event after POISON_ALERT_AFTER failed passes, stays pending, and routes once the fault clears", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  let broken = true;
  const realRead = deps.registry.read.bind(deps.registry);
  deps.registry.read = async (key: string) => {
    if (broken) throw new Error("registry unreadable");
    return realRead(key);
  };
  await deps.registry.write(lane(dir));
  const store = new JsonLaneReports(dir);
  store.append({ lane: "local-lane", generation: 0, kind: "question", text: "q", at: T0 });
  const journal: [string, string][] = [];
  const realError = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < POISON_ALERT_AFTER + 2; i++) expect(await routeReports(deps, store, (id, line) => { journal.push([id, line]); })).toEqual([]);
  } finally { console.error = realError; }
  expect(journal).toEqual([[
    "lane-report-stuck:local-lane:0:1",
    `LANE_REPORT local-lane blocked REPORT_STUCK local-lane:0:1 (question) failed to route ${POISON_ALERT_AFTER} times: registry unreadable; it stays pending and is retried every pass`,
  ]]);
  expect(eventClass(journal[0]?.[1] ?? "", deps.tunables.eventPolicy)).toBe("lead-urgent");
  expect(store.pending().map((r) => r.id)).toEqual(["local-lane:0:1"]);
  broken = false;
  expect(await routeReports(deps, store, (id, line) => { journal.push([id, line]); })).toEqual(["LANE_REPORT_ROUTED local-lane:0:1 question journal"]);
});

test("a dead lane pane leaves one synthetic blocked row under the lane's key; a pane of no lane leaves none", async () => {
  const dir = stateDir();
  withSqliteStore(dir);
  const world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w" }, { pane_id: "w:p9", workspace_id: "w" }];
  world.screen = "omo has stopped\n$ ";
  const deps = depsFor(world, fakeClock(T0), dir);
  const lanes = [lane(dir)];
  const seen = new Set<string>();
  const st = newDeadPaneState();
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T12", st, lanes, undefined, () => T0)).toEqual([]);
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T12", st, lanes, undefined, () => T0)).toEqual(["DEAD_PANE w:p7", "DEAD_PANE w:p9"]);
  // Announced again the next hour, but the row is written once.
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T13", st, lanes, undefined, () => T0 + 60 * MIN)).toEqual(["DEAD_PANE w:p7", "DEAD_PANE w:p9"]);
  const store = openLaneReports(deps.config);
  cleanups.push(() => { store.close(); });
  const rows = store.list();
  expect(rows.map((r) => [r.lane, r.kind, r.at])).toEqual([["local-lane", "blocked", T0]]);
  expect(rows[0]?.text).toContain("pane w:p7 stopped");
  expect(eventClass(`LANE_REPORT local-lane blocked ${rows[0]?.text}`, deps.tunables.eventPolicy)).toBe("lead-urgent");
});

test("a lane registered on the old [REPORT] footer moves onto dori report when it is relaunched", async () => {
  const dir = stateDir();
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0), dir, { leadPane: "w:lead" });
  const brief = join(dir, "old-lane.md");
  const old = lane(dir, { key: "old-lane", brief, pane: "w:p3" });
  expect(old.reportVia).toBeUndefined();
  // The brief as an older dori wrote it: its footer told the lane to type [REPORT] lines into the lead's pane.
  await Bun.write(brief, "do the thing\n\n## Lane footer (written by dori launch)\n- Report: print one line [REPORT] old-lane | <milestone|blocker|question|done> | <what, with links>, sent to pane w:lead as an argv array\n");
  await deps.registry.write(old);
  const { lane: relaunched } = await launchLane(deps, { key: "old-lane", title: "t", brief, done: old.done, thread: old.thread, cwd: join(dir, "nogit") }, old);
  expect(relaunched.reportVia).toBe("cli");
  const text = await Bun.file(brief).text();
  expect(text).toContain("dori report old-lane <milestone|progress|question|blocked>");
  expect(text).not.toContain("sent to pane w:lead");
  expect(text).toStartWith("do the thing\n");
  expect(text.split("## Lane footer (written by dori launch)")).toHaveLength(2);
});
