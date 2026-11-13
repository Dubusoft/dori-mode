import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { loadConfig } from "../src/config.ts";
import { eventClass } from "../src/event-policy.ts";
import { JsonLaneReports, type LaneReportStore, putReportRows, readReportRows, routeReports, SqliteLaneReports } from "../src/lane-reports.ts";
import { footer, launchLane } from "../src/launch.ts";
import { watchTick } from "../src/done-flow.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { fakeLaneSocket } from "./fake-lane-socket.ts";
import { BUILT_IN } from "../src/tunables.ts";
import { openedLine, type OpenResult, type OwnerDecision } from "../src/owner-decisions.ts";
import { parseDecisionText, serializeDecisionText } from "../src/runner/decision-text.ts";

// The CLI cases spawn `bun src/cli.ts`; a loaded full run on a small host needs more than bun's default 5 s per test.
setDefaultTimeout(30_000);

const T0 = Date.parse("2026-01-01T12:00:00Z");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const stateDir = (): string => {
  const state = withState();
  cleanups.push(state.done);
  return state.dir;
};

/** Both stores, whichever store the suite runs on: rows must behave the same on each. */
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

test.each(STORES)("%s store: seq counts up per lane, ids carry (lane, generation, seq), and a consumed row leaves pending", (_name, open) => {
  const store = open(stateDir());
  cleanups.push(() => { store.close(); });
  const a1 = store.append({ lane: "lane-a", generation: 0, kind: "progress", text: "step 1", at: T0 });
  const b1 = store.append({ lane: "lane-b", generation: 0, kind: "question", text: "which base?", evidence: "PR #4", at: T0 + 1 });
  const a2 = store.append({ lane: "lane-a", generation: 0, kind: "blocked", text: "CI down", at: T0 + 2 });
  expect([a1.seq, b1.seq, a2.seq]).toEqual([1, 1, 2]);
  expect([a1.id, b1.id, a2.id]).toEqual(["lane-a:0:1", "lane-b:0:1", "lane-a:0:2"]);
  expect(store.pending().map((r) => r.id)).toEqual(["lane-a:0:1", "lane-b:0:1", "lane-a:0:2"]);
  store.consume("lane-a:0:1", T0 + 3, "thread");
  // A second consume of the same row keeps the first route.
  store.consume("lane-a:0:1", T0 + 4, "journal");
  expect(store.pending().map((r) => r.id)).toEqual(["lane-b:0:1", "lane-a:0:2"]);
  expect(store.list({ lane: "lane-a" })).toEqual([
    { id: "lane-a:0:1", lane: "lane-a", generation: 0, seq: 1, kind: "progress", text: "step 1", at: T0, consumedAt: T0 + 3, route: "thread" },
    { id: "lane-a:0:2", lane: "lane-a", generation: 0, seq: 2, kind: "blocked", text: "CI down", at: T0 + 2 },
  ]);
  expect(store.list({ lane: "lane-b" })[0]?.evidence).toBe("PR #4");
});

test.each(STORES)("%s store preserves receipts across reopen and SQLite export/import without storing file bytes", (_name, open) => {
  const dir = stateDir(), store = open(dir);
  const fileReceipt = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: true }, revision: 3, sha256: "a".repeat(64) };
  const row = store.append({ lane: "lane-a", generation: 0, kind: "done", text: "done", at: T0, fileReceipt });
  store.close();
  const reopened = _name === "json" ? new JsonLaneReports(dir) : new SqliteLaneReports(join(dir, SQLITE_FILE));
  cleanups.push(() => reopened.close());
  expect(reopened.pending()[0]).toEqual(row);
  expect(Object.keys(row.fileReceipt!)).toEqual(["run", "revision", "sha256"]);
  const db = new Database(":memory:");
  try {
    putReportRows(db, reopened.list());
    expect(readReportRows(db)).toEqual([row]);
    expect((db.query("SELECT file_receipt FROM lane_reports").get() as { file_receipt: string }).file_receipt).toBe(JSON.stringify(fileReceipt));
  } finally { db.close(); }
});

test("pre-feature SQLite report layouts gain a nullable receipt column and preserve legacy rows", () => {
  const path = join(stateDir(), "old.sqlite"), db = new Database(path);
  db.exec("CREATE TABLE lane_reports (id TEXT PRIMARY KEY, lane TEXT, generation INTEGER, seq INTEGER, kind TEXT, text TEXT, evidence TEXT, at INTEGER, consumed_at INTEGER, route TEXT)");
  db.run("INSERT INTO lane_reports VALUES ('old', 'lane-a', 0, 1, 'done', 'old text', NULL, 1, NULL, NULL)");
  db.close();
  const store = new SqliteLaneReports(path);
  try { expect(store.pending()[0]?.fileReceipt).toBeUndefined(); } finally { store.close(); }
  const read = new Database(path);
  try {
    expect((read.query("PRAGMA table_info(lane_reports)").all() as { name: string; notnull: number }[]).find((c) => c.name === "file_receipt")?.notnull).toBe(0);
    expect(readReportRows(read)[0]?.text).toBe("old text");
  } finally { read.close(); }
});

test("managed done rows without receipts are refused once with the leaf line, never retried or queried", async () => {
  const dir = stateDir(), world = newWorld(), deps = depsFor(world, fakeClock(T0), dir);
  const managed = lane(dir, { fileRun: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false } });
  await deps.registry.write(managed);
  const store = new JsonLaneReports(dir); cleanups.push(() => store.close());
  const row = store.append({ lane: managed.key, generation: 0, kind: "done", text: "missing", at: T0 });
  const journal: [string, string][] = [];
  const enqueue = (id: string, line: string) => { journal.push([id, line]); };
  expect(await routeReports(deps, store, enqueue)).toEqual([`LANE_REPORT_ROUTED ${row.id} done journal`]);
  expect(journal).toEqual([[`lane-report-refused:${row.id}`, "LANE_REPORT_FILES_MISSING local-lane: this managed lane's done report has no file snapshot; claim done again through its runner"]]);
  expect(store.pending()).toEqual([]);
  expect(await routeReports(deps, store, enqueue)).toEqual([]);
  expect(world.ops.filter((op) => op.op === "files")).toEqual([]);
  expect((await deps.registry.read(managed.key))?.claim).toBeUndefined();
});

test("a done row for an older lane run is routed late under lane-report-late and consumed", async () => {
  const dir = stateDir(), world = newWorld(), deps = depsFor(world, fakeClock(T0), dir);
  const managed = lane(dir, { fileRun: { id: "00000000-0000-4000-8000-000000000002", requiredReport: false } });
  await deps.registry.write(managed);
  const store = new JsonLaneReports(dir); cleanups.push(() => store.close());
  const fileReceipt = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, revision: 1, sha256: "a".repeat(64) };
  const row = store.append({ lane: managed.key, generation: 0, kind: "done", text: "old run", at: T0, fileReceipt });
  const journal: [string, string][] = [];
  const enqueue = (id: string, line: string) => { journal.push([id, line]); };
  expect(await routeReports(deps, store, enqueue)).toEqual([`LANE_REPORT_ROUTED ${row.id} done late`]);
  expect(journal.map(([id]) => id)).toEqual([`lane-report-late:${row.id}`]);
  expect(journal[0]?.[1]).toContain("(from a replaced session)");
  expect(store.pending()).toEqual([]);
  expect((await deps.registry.read(managed.key))?.claim).toBeUndefined();
});

test.each(STORES)("%s report retention removes old consumed rows while keeping pending, recent, and latest rows and sequence continuity", (_name, open) => {
  const store = open(stateDir());
  cleanups.push(() => { store.close(); });
  const cutoff = T0 - 30 * 24 * 60 * 60_000;
  const append = (lane: string) => store.append({ lane, generation: 0, kind: "progress", text: "progress", at: cutoff - 2 });
  const old = append("lane-a");
  const pending = append("lane-a");
  const recent = append("lane-a");
  const latest = append("lane-a");
  const single = append("lane-b");
  store.consume(old.id, cutoff - 1, "journal");
  store.consume(recent.id, cutoff, "journal");
  store.consume(latest.id, cutoff - 1, "journal");
  store.consume(single.id, cutoff - 1, "journal");
  store.prune(T0);
  expect(store.list().map((row) => row.id).sort()).toEqual([pending.id, recent.id, latest.id, single.id].sort());
  expect(store.pending().map((row) => row.id)).toEqual([pending.id]);
  expect(append("lane-a").seq).toBe(5);
  expect(append("lane-b").seq).toBe(2);
});

test.each(STORES)("%s store: rows written by another connection (a lane's CLI) are read by the supervisor's", (_name, open) => {
  const dir = stateDir();
  const supervisor = open(dir);
  const cli = open(dir);
  cleanups.push(() => { supervisor.close(); cli.close(); });
  cli.append({ lane: "lane-a", generation: 0, kind: "question", text: "q1", at: T0 });
  cli.append({ lane: "lane-a", generation: 0, kind: "question", text: "q2", at: T0 });
  expect(supervisor.pending().map((r) => r.seq)).toEqual([1, 2]);
});

test("routing: progress posts to the lane's thread, done is the lane's claim, a closed lane's row is a late journal event; each row once", async () => {
  const dir = stateDir();
  const world = newWorld();
  const posts: (readonly string[])[] = [];
  const base = depsFor(world, fakeClock(T0), dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  const deps = { ...base, run: async (argv: readonly string[]) => { if (argv[0] === "notify") posts.push(argv); return base.run(argv); } };
  await deps.registry.write(lane(dir));
  await deps.registry.write(lane(dir, { key: "gone-lane", closedAt: new Date(T0).toISOString() }));
  const store = new JsonLaneReports(dir);
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "tests green in /home/test/repo", at: T0 });
  store.append({ lane: "gone-lane", generation: 0, kind: "question", text: "still there?", at: T0 });
  store.append({ lane: "local-lane", generation: 0, kind: "done", text: "merged", evidence: "merged acme/app#3 abc123", at: T0 + 1 });
  const journal: [string, string][] = [];
  const enqueue = (id: string, line: string) => { journal.push([id, line]); };
  expect(await routeReports(deps, store, enqueue, "/home/test")).toEqual([
    "LANE_REPORT_ROUTED gone-lane:0:1 question late",
    "LANE_REPORT_ROUTED local-lane:0:1 progress thread",
    "LANE_REPORT_ROUTED local-lane:0:2 done claim",
  ]);
  // Posted as a [System] relay, never as the lane (or the lead) speaking to the owner.
  expect(posts).toEqual([["notify", "discord:1/2", "[System] 레인 local-lane 전달: tests green in ~/repo"]]);
  expect(journal).toEqual([["lane-report-late:gone-lane:0:1", "LANE_REPORT_LATE gone-lane question still there?"]]);
  expect(store.list({ lane: "gone-lane" })[0]?.route).toBe("late");
  const claimed = await deps.registry.read("local-lane");
  expect(claimed && statusOf(claimed)).toBe("done-claimed");
  expect(claimed?.claim?.evidence).toBe("merged acme/app#3 abc123");
  expect(await routeReports(deps, store, enqueue, "/home/test")).toEqual([]);
  expect(posts).toHaveLength(1);
});

test("routing: an unregistered lane's row is a late event too, and one throwing row stays pending while the rest are routed", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir));
  let broken = true;
  const realRead = deps.registry.read.bind(deps.registry);
  deps.registry.read = async (key: string) => {
    if (key === "poison-lane" && broken) throw new Error("registry unreadable");
    return realRead(key);
  };
  const flaky = deps;
  const store = new JsonLaneReports(dir);
  store.append({ lane: "poison-lane", generation: 0, kind: "question", text: "first", at: T0 });
  store.append({ lane: "nobody", generation: 0, kind: "blocked", text: "never registered", at: T0 + 1 });
  store.append({ lane: "local-lane", generation: 0, kind: "question", text: "after the poison", at: T0 + 2 });
  const journal: [string, string][] = [];
  const enqueue = (id: string, line: string) => { journal.push([id, line]); };
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try {
    expect(await routeReports(flaky, store, enqueue)).toEqual([
      "LANE_REPORT_ROUTED nobody:0:1 blocked late", "LANE_REPORT_ROUTED local-lane:0:1 question journal",
    ]);
  } finally { console.error = realError; }
  expect(errors).toEqual(["LANE_REPORT_ERROR poison-lane:0:1 registry unreadable"]);
  expect(journal.map(([id]) => id)).toEqual(["lane-report-late:nobody:0:1", "lane-report:local-lane:0:1"]);
  expect(store.pending().map((r) => r.id)).toEqual(["poison-lane:0:1"]);
  // Once the fault clears the row is routed (late: that lane is not registered).
  broken = false;
  expect(await routeReports(flaky, store, enqueue)).toEqual(["LANE_REPORT_ROUTED poison-lane:0:1 question late"]);
  expect(store.pending()).toEqual([]);
});

test("routing: progress with no thread hook, or a failing one, reaches the lead as a digest LANE_REPORT instead of being lost", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir, { hooks: { threadReply: ["false-hook", "{text}"] } });
  await deps.registry.write(lane(dir));
  const store = new JsonLaneReports(dir);
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "half way", at: T0 });
  const journal: [string, string][] = [];
  await routeReports(deps, store, (id, line) => { journal.push([id, line]); });
  expect(journal).toEqual([["lane-report:local-lane:0:1", "LANE_REPORT local-lane progress half way (thread post failed: unexpected false-hook [System] 레인 local-lane 전달: half way)"]]);
  expect(store.list()[0]?.route).toBe("journal");
});

test("milestone and progress reports are digest, question and blocked stay urgent; a config-file eventPolicy is ignored", async () => {
  const dir = stateDir();
  const file = join(dir, "config.json");
  await Bun.write(file, JSON.stringify({ eventPolicy: { kinds: { "LANE_REPORT * progress": "engine-only" } } }));
  expect("eventPolicy" in await loadConfig(file, "/home/test")).toBe(false);
  const policy = BUILT_IN.eventPolicy;
  expect(eventClass("LANE_REPORT demo milestone tests green", policy)).toBe("lead-digest");
  expect(eventClass("LANE_REPORT demo progress half way", policy)).toBe("lead-digest");
  expect(eventClass("LANE_REPORT demo question which base?", policy)).toBe("lead-urgent");
  expect(eventClass("LANE_REPORT demo blocked CI down", policy)).toBe("lead-urgent");
  expect(eventClass("GH_PR acme/app#7 checks_failing sha=x u", policy)).toBe("lead-digest");
});

const cli = async (dir: string, args: string[], env: Record<string, string> = {}, config: Record<string, unknown> = {}) => {
  await Bun.write(join(dir, "config.json"), JSON.stringify(config));
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "report", ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "config.json"), DORI_STATE_DIR: dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("dori report: a lane sends a report for its own key only, through its runner, and writes no row itself", async () => {
  const dir = stateDir();
  const sock = fakeLaneSocket(dir);
  cleanups.push(sock.close);
  const inLane = { DORI_LANE_KEY: "local-lane", DORI_LANE_TOKEN: "tok" };

  const ok = await cli(dir, ["local-lane", "blocked", "--text", "which base\nbranch?", "--evidence", "PR #4"], inLane);
  expect(ok).toMatchObject({ code: 0, out: "LANE_REPORTED local-lane blocked (through the runner)\n" });
  expect(sock.requests).toEqual([{ kind: "blocked", text: "which base\nbranch?", evidence: "PR #4", key: "local-lane", token: "tok" }]);

  const denied = await cli(dir, ["other-lane", "blocked", "--text", "x"], inLane);
  expect(denied.code).toBe(1);
  expect(denied.err).toContain("LANE_PERMISSION_DENIED lane local-lane may report only for itself, not other-lane");

  const badKind = await cli(dir, ["local-lane", "finished", "--text", "x"], inLane);
  expect(badKind.code).toBe(2);
  expect(badKind.err).toContain("usage: dori report <key> <progress|blocked|milestone|done>");

  expect(sock.requests).toHaveLength(1);
  expect(new JsonLaneReports(dir).list()).toHaveLength(0);
});

/** Launches a local lane through the fakes (herdr tab create answers with pane w:p9). */
const launchLocal = async (dir: string, key = "cli-lane") => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0), dir, { leadPane: "w:lead" });
  const brief = join(dir, `${key}.md`);
  await Bun.write(brief, "do the thing\n");
  const { lane: launched } = await launchLane(deps, { key, title: "t", brief, done: "merged acme/app#1", thread: `discord:1/${key}`, cwd: join(dir, "nogit") });
  return { lane: launched, brief: await Bun.file(brief).text() };
};

test("footer: every lane is told to use dori report and never a pane; a remote lane uses its runner's dori", async () => {
  const dir = stateDir();
  const on = await launchLocal(dir);
  expect(on.lane.reportVia).toBe("cli");
  expect(on.brief).toContain('dori report cli-lane <milestone|progress|question|request|blocked> --text "<what, with links>"');
  expect(on.brief).toContain('When done: dori report cli-lane done --text "<one line>" --evidence "<PR link and head SHA, closed issue, version>"');
  expect(on.brief).not.toContain("w:lead");
  expect(on.brief).not.toContain("[REPORT] cli-lane |");
  // Credentials come only through the broker, through the lane's own dori.
  expect(on.brief).toContain("`dori secret exec NAME [NAME...] -- <command>`");
  expect(on.brief).toContain("`dori secret run <op>`");
  // A lane registered by an older dori (no reportVia) is told the same: no footer types into the lead's pane (D4).
  const old = footer({ ...on.lane, key: "old-lane", reportVia: undefined });
  expect(old).toContain('dori report old-lane <milestone|progress|question|request|blocked> --text "<what, with links>"');
  expect(old).not.toContain("[REPORT] old-lane |");
  // A remote lane reports through its runner's own dori.
  const remote = footer({ ...on.lane, machine: "m1", reportVia: undefined });
  expect(remote).toContain('~/.dori/runner/bin/dori report cli-lane done --text "<one line>"');
  expect(remote).not.toContain("[REPORT] cli-lane |");
  expect(remote).toContain("`~/.dori/runner/bin/dori secret run <op>`");
});

test("a dori-report lane's row is routed and counts as hearing from it, and an old-footer remote lane's [REPORT] line is never read", async () => {
  const dir = stateDir();
  const world = newWorld();
  const base = depsFor(world, fakeClock(T0), dir);
  const deps = base;
  await deps.registry.write(lane(dir, { key: "cli-lane", reportVia: "cli" }));
  await deps.registry.write(lane(dir, { key: "old-lane", pane: "w:p8" }));
  await deps.registry.write(lane(dir, { key: "remote-lane", pane: "w:p5", machine: "m1" }));

  // The lane's `dori report` arrives through its runner, and the hub appends it to the store (lanes-hub.ts).
  expect(new JsonLaneReports(dir).append({ lane: "cli-lane", generation: 0, kind: "question", text: "which base?", at: T0 }).id).toBe("cli-lane:0:1");

  // The supervisor routes the row, and the question wakes the lead.
  const journal: [string, string][] = [];
  expect(await routeReports(deps, new JsonLaneReports(dir), (id, line) => { journal.push([id, line]); })).toEqual(["LANE_REPORT_ROUTED cli-lane:0:1 question journal"]);
  expect(journal).toEqual([["lane-report:cli-lane:0:1", "LANE_REPORT cli-lane question which base?"]]);
  expect(eventClass("LANE_REPORT cli-lane question which base?", deps.tunables.eventPolicy)).toBe("lead-urgent");
  // Being routed is being heard: freshness counts from it.
  expect((await deps.registry.read("cli-lane"))?.lastReplyAt).toBe(T0);

  // A pane is never parsed for a report: a remote lane's question printed on its own screen reaches no one.
  world.screen = "[REPORT] remote-lane | question | need the deploy key\n❯ ";
  const pushed: string[] = [];
  await watchTick(deps, async (line) => { pushed.push(line); });
  expect(pushed.filter((line) => line.startsWith("LANE_REPORT"))).toEqual([]);
});

test("routing: journal and late events carry the lane's meta (lane, thread, cwd), an unregistered lane only its key", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir, { cwd: "/repo/work" }));
  await deps.registry.write(lane(dir, { key: "gone-lane", closedAt: new Date(T0).toISOString() }));
  const store = new JsonLaneReports(dir);
  store.append({ lane: "local-lane", generation: 0, kind: "question", text: "which base?", at: T0 });
  store.append({ lane: "gone-lane", generation: 0, kind: "question", text: "still there?", at: T0 });
  store.append({ lane: "nowhere", generation: 0, kind: "question", text: "anyone?", at: T0 });
  const metas: [string, unknown][] = [];
  await routeReports(deps, store, (id, _line, meta) => { metas.push([id, meta]); });
  expect(metas).toEqual([
    ["lane-report-late:gone-lane:0:1", { lane: "gone-lane", thread: "discord:1/2" }],
    ["lane-report:local-lane:0:1", { lane: "local-lane", thread: "discord:1/2", cwd: "/repo/work" }],
    ["lane-report-late:nowhere:0:1", { lane: "nowhere" }],
  ]);
});

test("routing: a question with choices opens an owner decision through the opener and is consumed with route decision", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir));
  const store = new JsonLaneReports(dir);
  const choices = { question: "which base?", options: ["main", "develop"], recommend: 1, reason: "main is current", waiting: "the PR", blocking: true };
  const row = store.append({ lane: "local-lane", generation: 0, kind: "question", text: serializeDecisionText(choices), at: T0 });
  const asked: string[] = [];
  const decision: OwnerDecision = { ...choices, id: "d1", state: "open", lane: "local-lane", source: "lane", sourceRef: row.id, channel: "9", thread: "10", openedAt: T0 };
  const opener = async (_lane: Lane, report: { readonly id: string; readonly text: string }): Promise<OpenResult | undefined> => {
    asked.push(report.id);
    return parseDecisionText(report.text) ? { decision, channel: { channel: "9" }, link: { kind: "none" } } : undefined;
  };
  const journal: [string, string][] = [];
  expect(await routeReports(deps, store, (id, line) => { journal.push([id, line]); }, "/home/test", null, opener)).toEqual([`LANE_REPORT_ROUTED ${row.id} question decision`]);
  expect(asked).toEqual([row.id]);
  expect(journal).toEqual([["owner-decision-opened:d1", openedLine(decision)]]);
  expect(journal[0]?.[1]).toStartWith("OWNER_DECISION_OPENED d1 lane local-lane blocking");
  expect(store.list()[0]).toMatchObject({ route: "decision", eventId: "owner-decision-opened:d1" });
});

test("routing: a free-text question the opener declines is journaled as a LANE_REPORT question as before", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir));
  const store = new JsonLaneReports(dir);
  const row = store.append({ lane: "local-lane", generation: 0, kind: "question", text: "which base?", at: T0 });
  const journal: [string, string][] = [];
  expect(await routeReports(deps, store, (id, line) => { journal.push([id, line]); }, "/home/test", null, async () => undefined)).toEqual([`LANE_REPORT_ROUTED ${row.id} question journal`]);
  expect(journal).toEqual([[`lane-report:${row.id}`, "LANE_REPORT local-lane question which base?"]]);
  expect(store.list()[0]?.route).toBe("journal");
});
