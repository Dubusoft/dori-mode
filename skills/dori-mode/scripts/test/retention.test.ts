import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GitHubEvents, PRE_SQLITE_GITHUB_FILE } from "../src/github-events.ts";
import type { Runner } from "../src/run.ts";
import { RETENTION, SCHEMA_VERSION, SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { importStore } from "../src/store-import.ts";
import { ACK_KEEP_MS, Supervisor } from "../src/supervise.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A busy lead pane (every due event is appended to the log without a restart), a fake gh, and the sqlite store. */
const fixture = (gh?: Runner, root?: string) => {
  const state = withState(root);
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const run: Runner = async (argv, opts) => {
    if (argv[0] === "herdr" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: world.panes } }), err: "" };
    if (argv[0] === "herdr" && argv[2] === "read") return { code: 0, out: "working", err: "" };
    if (argv[0] === "gh" && gh) return gh(argv, opts);
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  const deps = (store: "json" | "sqlite" = "sqlite") => ({ ...depsFor(world, clock, state.dir, { store }), run });
  const open = (store: "json" | "sqlite" = "sqlite") => {
    const supervisor = new Supervisor(deps(store));
    cleanups.unshift(() => supervisor.close());
    return supervisor;
  };
  const db = () => {
    const store = new SqliteStore(join(state.dir, SQLITE_FILE));
    cleanups.unshift(() => store.close());
    return store;
  };
  const logIds = (): string[] => readFileSync(join(state.dir, "lead-events.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).id);
  /** What `dori ack` and `dori handled --reply` leave for the supervisor (without their fsyncs, which only cost time here). */
  const receipt = (message: number, at: number, reply: boolean) => {
    mkdirSync(join(state.dir, "acks"), { recursive: true });
    writeFileSync(join(state.dir, "acks", `11-${message}.json`), JSON.stringify({ channel: "11", message: String(message), at, ...(reply ? { reply } : {}) }));
  };
  const acked = (message: number, at: number) => receipt(message, at, false);
  const handled = (message: number, at: number) => receipt(message, at, true);
  return { state, clock, deps, open, db, logIds, acked, handled };
};

test("a delivered event body leaves after 7 days for a tombstone that dedupes it until day 90; unresolved events stay", async () => {
  const f = fixture();
  const supervisor = f.open();
  // Given a delivered lane report, a delivered owner message the lead read but never handled, and a report it never got.
  supervisor.enqueue("report:a", "LANE_REPORT alpha milestone");
  supervisor.enqueue("discord:11:1", "INBOUND 11 1 owner hello");
  await supervisor.flush();
  f.acked(1, f.clock.now());
  supervisor.ackTick(60_000);
  supervisor.enqueue("report:b", "LANE_REPORT beta question");
  // When 7 days pass and the loop runs retention.
  f.clock.at += RETENTION.eventBodyMs + HOUR;
  supervisor.ackTick(60_000);
  // Then only the delivered, unneeded body is gone, leaving its tombstone; its delivery row goes with it.
  const store = f.db();
  const ids = store.read(false).events.map((event) => event.id);
  expect(ids).not.toContain("report:a");
  expect(ids).toEqual(expect.arrayContaining(["discord:11:1", "report:b"]));
  expect(store.tombstoned("report:a")).toBe(true);
  expect(store.deliveredIds().has("report:a")).toBe(false);
  store.close();
  // And a replay of its source, before and after a restart, adds nothing and delivers nothing twice.
  supervisor.enqueue("report:a", "LANE_REPORT alpha milestone");
  await supervisor.flush();
  supervisor.close();
  const after = f.open();
  after.enqueue("report:a", "LANE_REPORT alpha milestone");
  await after.flush();
  expect(f.logIds().filter((id) => id === "report:a")).toHaveLength(1);
  // And once its tombstone expires at day 90, the same id is a new event again.
  f.clock.at += RETENTION.tombstoneMs;
  after.ackTick(60_000);
  after.enqueue("report:a", "LANE_REPORT alpha again");
  expect(f.db().read(false).events.map((event) => event.line)).toContain("LANE_REPORT alpha again");
});

test("the json journal keeps every event body", async () => {
  const f = fixture();
  const supervisor = f.open("json");
  supervisor.enqueue("report:a", "LANE_REPORT alpha milestone");
  await supervisor.flush();
  f.clock.at += RETENTION.tombstoneMs + DAY;
  supervisor.ackTick(60_000);
  supervisor.close();
  expect(JSON.parse(readFileSync(join(f.state.dir, "supervisor.json"), "utf8")).events.map((event: { id: string }) => event.id)).toContain("report:a");
});

test("a handled owner message's tombstone outlives its body and expires at day 90", async () => {
  const f = fixture();
  const supervisor = f.open();
  // Given an owner message the lead handled.
  supervisor.enqueue("discord:11:5", "INBOUND 11 5 owner please");
  await supervisor.flush();
  f.handled(5, f.clock.now());
  supervisor.ackTick(60_000);
  // When its tracking is compacted after a day and its body pruned after 7.
  f.clock.at += ACK_KEEP_MS + HOUR;
  supervisor.ackTick(60_000);
  f.clock.at += RETENTION.eventBodyMs;
  supervisor.ackTick(60_000);
  // Then only the tombstones remain, and a replayed copy of the message is not tracked again.
  let journal = f.db().read(false);
  expect(journal.closedOwners).toEqual(["discord:11:5"]);
  expect(journal.events.map((event) => event.id)).not.toContain("discord:11:5");
  supervisor.enqueue("discord:11:5", "INBOUND 11 5 owner please");
  expect(f.db().read(false).awaitingAck).toEqual([]);
  // And at day 90 the owner tombstone expires too.
  f.clock.at += RETENTION.tombstoneMs;
  supervisor.ackTick(60_000);
  journal = f.db().read(false);
  expect(journal.closedOwners).toEqual([]);
});

test("a version 1 database migrates to the current version and keeps its journal", () => {
  const f = fixture();
  const path = join(f.state.dir, SQLITE_FILE);
  // Given a database written by the version 1 code (no tombstone or GitHub tables).
  const v1 = new SqliteStore(path, { create: true });
  v1.save({ events: [{ id: "report:a", line: "LANE_REPORT alpha", at: T0 }] }, "full");
  v1.close();
  const raw = new Database(path);
  raw.exec("DROP TABLE event_tombstones; DROP TABLE gh_repos; DROP TABLE gh_prs; DROP TABLE gh_issues; DROP TABLE gh_cache; DROP TABLE lead_wakes");
  raw.query("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  raw.close();
  // When the current code opens it.
  const store = f.db();
  // Then it is at the current version with every table, and the journal is unchanged.
  expect(SCHEMA_VERSION).toBe(9);
  expect(store.meta("schema_version")).toBe("9");
  expect(Object.keys(store.counts())).toEqual(expect.arrayContaining(["event_tombstones", "gh_repos", "gh_prs", "gh_issues", "gh_cache", "lead_wakes"]));
  expect(store.read(false).events).toEqual([{ id: "report:a", line: "LANE_REPORT alpha", at: T0 }]);
});

test("dori store import also moves github-events.json into the database", () => {
  const f = fixture();
  // Given a state dir with both json files.
  writeFileSync(join(f.state.dir, "supervisor.json"), JSON.stringify({ events: [] }));
  const github = {
    repos: { "acme/app": {
      cache: { user: { etag: '"u"', body: { login: "owner", bio: "x".repeat(500) } } },
      pulls: { 7: { number: 7, state: "merged", sha: "abc", branch: "lane", updated: "2026-10-20T00:00:00Z", url: "https://github.com/acme/app/pull/7", conflicting: false, checks: "green", activity: ["issues/7/comments:1::"] } },
      issues: { 3: { state: "open", reopens: 1 } },
    } },
    failures: {}, polledAt: T0,
  };
  writeFileSync(join(f.state.dir, "github-events.json"), JSON.stringify(github));
  // When it is imported.
  const report = importStore(f.state.dir, T0 + 1);
  // Then the GitHub rows are in the database and the file is kept read-only beside it.
  expect(report.counts).toMatchObject({ gh_repos: 1, gh_prs: 1, gh_issues: 1, gh_cache: 1 });
  expect(existsSync(join(f.state.dir, "github-events.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.state.dir, PRE_SQLITE_GITHUB_FILE), "utf8"))).toEqual(github);
  const poller = new GitHubEvents(f.state.dir, "sqlite", f.clock.now);
  cleanups.unshift(() => poller.close());
  const db = new Database(join(f.state.dir, SQLITE_FILE), { readonly: true });
  expect(db.query("SELECT body, used_at FROM gh_cache").get()).toEqual({ body: JSON.stringify({ login: "owner" }), used_at: T0 + 1 });
  expect(db.query("SELECT activity FROM gh_prs").get()).toEqual({ activity: JSON.stringify(["issues/7/comments:1::"]) });
  db.close();
});
