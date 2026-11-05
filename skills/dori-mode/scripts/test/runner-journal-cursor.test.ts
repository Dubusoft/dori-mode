import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLaneReports, type NewReport } from "../src/lane-reports.ts";
import type { Lane } from "../src/registry.ts";
import { eventLine, HUB_FILE, RunnerHub } from "../src/runner/hub.ts";
import { laneEventsAfter, type LaneHubDeps, reconcileInventory } from "../src/runner/lanes-hub.ts";
import { runnerControl, runnerEvent } from "../src/runner/protocol.ts";
import { openRunnerJournal, RUNNER_JOURNAL_RETENTION_MS } from "../src/runner/serve.ts";
import { laneEventReader, RUNNER_LANE_CURSOR_FILE } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });
const head = { runner: "worker-a", gen: 1, epoch: 1 };
const started = (seq: number, pane = `pane-${seq}`) => runnerEvent(head, seq, "lane.started", { key: "lane-a", pane, tab: "tab-a", session: "session-a" });
const report = (seq: number) => runnerEvent(head, seq, "lane.report", { key: "lane-a", kind: "milestone", text: "ready" });

const fixture = async () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(1_800_000_000_000);
  const flow = depsFor(newWorld(), clock, state.dir);
  await flow.registry.write({
    key: "lane-a", title: "lane a", thread: "none", brief: "/brief.md", done: "command [\"true\"]",
    openedAt: new Date(clock.now()).toISOString(), runner: head.runner, status: "working",
  } satisfies Lane);
  const store = openLaneReports(flow.config);
  cleanups.push(() => store.close());
  const journal = openRunnerJournal(state.dir, clock.now);
  cleanups.push(() => journal.close());
  const deps: LaneHubDeps = { registry: flow.registry, reports: () => store, now: clock.now, emit: () => {}, recover: () => undefined };
  const commit = (frame: ReturnType<typeof started> | ReturnType<typeof report>) => journal.commit(`runner:${head.runner}:${frame.seq}`, eventLine(frame));
  const cursor = join(state.dir, RUNNER_LANE_CURSOR_FILE);
  return { state, clock, flow, store, journal, deps, commit, cursor };
};

test("P4 positions are never reused after prune empties the journal", async () => {
  const f = await fixture();
  for (let seq = 1; seq <= 5; seq++) f.commit(started(seq));
  const last = laneEventsAfter(f.state.dir, 0).at(-1)!.rowid;
  f.clock.at += RUNNER_JOURNAL_RETENTION_MS + 1;
  expect(f.journal.prune(f.clock.now())).toBe(5);
  f.commit(started(6));
  const fresh = laneEventsAfter(f.state.dir, last);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]!.rowid).toBeGreaterThan(last);
  expect(fresh[0]!.frame.seq).toBe(6);
  expect(f.commit(started(6))).toBe(false);
});

test("legacy journal migrates in rowid order preserving positions, rows and deduplication", () => {
  const state = withState();
  cleanups.push(state.done);
  const db = new Database(join(state.dir, HUB_FILE), { create: true });
  db.run("CREATE TABLE runner_events (id TEXT PRIMARY KEY, line TEXT NOT NULL, at INTEGER NOT NULL)");
  for (const seq of [2, 7]) db.query("INSERT INTO runner_events (rowid, id, line, at) VALUES (?, ?, ?, ?)").run(seq, `runner:worker-a:${seq}`, eventLine(started(seq)), 1);
  db.close();
  const journal = openRunnerJournal(state.dir, () => 2);
  try {
    expect(laneEventsAfter(state.dir, 0).map((event) => [event.rowid, event.frame.seq])).toEqual([[2, 2], [7, 7]]);
    expect(journal.commit("runner:worker-a:7", eventLine(started(7)))).toBe(false);
    journal.commit("runner:worker-a:8", eventLine(started(8)));
    expect(laneEventsAfter(state.dir, 7)[0]!.rowid).toBeGreaterThan(7);
    const migrated = new Database(join(state.dir, HUB_FILE), { readonly: true });
    try {
      expect((migrated.query("SELECT sql FROM sqlite_master WHERE name = 'runner_events'").get() as { sql: string }).sql).toContain("AUTOINCREMENT");
    } finally { migrated.close(); }
  } finally { journal.close(); }
});

test("failed accept stops in order and is retried on the next tick", async () => {
  const f = await fixture();
  f.commit(started(1));
  f.commit(report(2));
  f.commit(started(3));
  let available = false;
  const tick = laneEventReader(f.state.dir, { ...f.deps, reports: () => available ? f.store : undefined });
  await expect(tick()).rejects.toThrow("RUNNER_REPORT_UNSTORED");
  expect(JSON.parse(readFileSync(f.cursor, "utf8"))).toBe(1);
  expect((await f.flow.registry.read("lane-a"))!.pane).toBe("pane-1");
  // pane-3 is a restart after a lost pane: a lane.started with another pane applies only while a recovery is outstanding.
  await f.flow.registry.update("lane-a", (lane) => (lane ? { ...lane, recoveryPending: true } : undefined));
  available = true;
  await tick();
  expect(f.store.list()).toHaveLength(1);
  expect((await f.flow.registry.read("lane-a"))!.pane).toBe("pane-3");
  expect(JSON.parse(readFileSync(f.cursor, "utf8"))).toBe(3);
});

test("cursor is written only after accept settles successfully", async () => {
  const f = await fixture();
  f.commit(started(1));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const tick = laneEventReader(f.state.dir, {
    ...f.deps, registry: {
      ...f.deps.registry, open: () => f.flow.registry.open(), update: (key, fn) => f.flow.registry.update(key, fn),
      read: async (key) => { entered.resolve(); await release.promise; return f.flow.registry.read(key); },
    },
  });
  const taking = tick();
  await entered.promise;
  expect(existsSync(f.cursor)).toBe(false);
  release.resolve();
  await taking;
  expect(JSON.parse(readFileSync(f.cursor, "utf8"))).toBe(1);
  expect(statSync(f.cursor).mode & 0o777).toBe(0o600);
});

test("P8 persisted cursor prevents restart replay, report restamping and older pane overwrite", async () => {
  const f = await fixture();
  f.commit(started(1, "old-pane"));
  f.commit(report(2));
  await laneEventReader(f.state.dir, f.deps)();
  const firstAt = (await f.flow.registry.read("lane-a"))!.lastRunnerReportAt;
  await f.flow.registry.update("lane-a", (lane) => ({ ...lane!, pane: "new-pane" }));
  f.clock.at += 60_000;
  await laneEventReader(f.state.dir, f.deps)();
  const lane = await f.flow.registry.read("lane-a");
  expect(lane!.pane).toBe("new-pane");
  expect(lane!.lastRunnerReportAt).toBe(firstAt);
  expect(f.store.list()).toHaveLength(1);
});

test("a cursor beyond the replaced journal resets to the beginning", async () => {
  const f = await fixture();
  f.commit(started(1));
  writeFileSync(f.cursor, "100\n");
  await laneEventReader(f.state.dir, f.deps)();
  expect((await f.flow.registry.read("lane-a"))!.pane).toBe("pane-1");
  expect(JSON.parse(readFileSync(f.cursor, "utf8"))).toBe(1);
});

test("P5 hub report text and evidence survive the private journal round trip unredacted", async () => {
  const f = await fixture();
  const hub = new RunnerHub({ stateDir: f.state.dir, commit: f.journal.commit, now: f.clock.now, monotonic: f.clock.now, epoch: 1 });
  try {
    expect(hub.hello(runnerControl(head, "hello", { proto: 1, gen: 1, label: head.runner, hostId: "host-a", cmdAck: 0 })).ok).toBe(true);
    const body = { key: "lane-a", kind: "milestone", text: "api_key=staging12\nexact report", evidence: "a".repeat(43) } as const;
    hub.receive(runnerEvent(head, 1, "lane.report", body));
    expect(laneEventsAfter(f.state.dir, 0)[0]!.frame.body).toEqual(body);
    const appended: NewReport[] = [];
    await laneEventReader(f.state.dir, { ...f.deps, reports: () => ({
      ...f.store, append: (row) => { appended.push(row); return f.store.append(row); },
      pending: () => f.store.pending(), list: () => f.store.list(), consume: (...args) => f.store.consume(...args), close: () => {},
    }) })();
    expect(appended[0]).toMatchObject({ text: body.text, evidence: body.evidence });
    // The same report-store boundary as local reports still applies its usual redaction.
    const local = f.store.append({ lane: "local-a", generation: 0, kind: body.kind, text: body.text, evidence: body.evidence, at: f.clock.now() });
    expect(f.store.list({ lane: "lane-a" })[0]).toMatchObject({ text: local.text, evidence: local.evidence });
    expect(statSync(join(f.state.dir, HUB_FILE)).mode & 0o777).toBe(0o600);
  } finally { hub.close(); }
});

test("a corrupt cursor file is reported and the journal is read from the start instead of failing", async () => {
  const f = await fixture();
  f.commit(started(1));
  writeFileSync(f.cursor, "{not json");
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { await laneEventReader(f.state.dir, f.deps)(); } finally { console.error = original; }
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith(`RUNNER_CURSOR_INVALID ${f.cursor} `);
  expect(lines[0]).toEndWith("; reading the runner journal from the start");
  expect((await f.flow.registry.read("lane-a"))!.pane).toBe("pane-1");
  expect(JSON.parse(readFileSync(f.cursor, "utf8"))).toBe(1);
});

test("B1 a journaled start from before the recovery hello does not complete the recovery; the recovered start does", async () => {
  const f = await fixture();
  await f.flow.registry.update("lane-a", (lane) => lane ? { ...lane, pane: "current-pane", tab: "current-tab" } : undefined);
  f.commit(started(1, "historic-pane"));
  const tick = laneEventReader(f.state.dir, f.deps);
  await reconcileInventory(f.deps, head.runner, []);
  expect((await f.flow.registry.read("lane-a"))?.recoveryPending).toBe(true);
  await tick();
  const replayed = await f.flow.registry.read("lane-a");
  expect(replayed?.pane).toBe("current-pane");
  expect(replayed?.recoveryPending).toBe(true);
  f.commit(started(2, "recovered-pane"));
  await tick();
  const recovered = await f.flow.registry.read("lane-a");
  expect(recovered?.pane).toBe("recovered-pane");
  expect(recovered?.recoveryPending).toBeUndefined();
  expect(recovered?.recoveryAfter).toBeUndefined();
});
