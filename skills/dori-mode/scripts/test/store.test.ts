import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { recordHandled } from "../src/ack.ts";
import { readCarried, takeAwaitingReminders, writeCarried } from "../src/inbox.ts";
import type { Runner } from "../src/run.ts";
import { PRE_SQLITE_FILE, SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { convertJsonStore } from "../src/store-import.ts";
import { Supervisor } from "../src/supervise.ts";
import { acquireSupervisor } from "../src/state-lock.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = 1_800_000_000_000;

test.each([false, true])("sqlite save retries after a failed commit with an existing baseline=%s", (existing) => {
  const state = withState();
  cleanups.push(state.done);
  const store = new SqliteStore(join(state.dir, SQLITE_FILE), { create: true });
  cleanups.unshift(() => store.close());
  const journal = { events: [{ id: "retry", line: "HOOK retry", at: T0 }] };
  if (existing) {
    journal.events.length = 0;
    store.save(journal, "full");
    journal.events.push({ id: "retry", line: "HOOK retry", at: T0 });
  }
  // A deferred constraint fails at COMMIT, after every save operation has run.
  const db = store["db"];
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE commit_parent (id TEXT PRIMARY KEY);
    CREATE TABLE commit_child (id TEXT REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_commit AFTER INSERT ON events BEGIN INSERT INTO commit_child VALUES (NEW.id); END;`);
  expect(() => store.save(journal, "full")).toThrow();
  expect(store.counts().events).toBe(0);
  if (!existing) expect(db.query("SELECT value FROM meta WHERE key = 'journal'").get()).toBeNull();
  db.exec("DROP TRIGGER fail_commit");
  store.save(journal, "full");
  store.close();
  const restarted = new SqliteStore(join(state.dir, SQLITE_FILE));
  try {
    expect(restarted.load()?.events).toEqual(journal.events);
    expect(restarted.counts().events).toBe(1);
  } finally { restarted.close(); }
});

/** A lead pane that is busy, so every due event is appended to the log without a restart. */
const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const run: Runner = async (argv) => {
    if (argv[0] === "herdr" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: world.panes } }), err: "" };
    if (argv[0] === "herdr" && argv[2] === "read") return { code: 0, out: "working", err: "" };
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  const deps = () => ({ ...depsFor(world, clock, state.dir), run });
  const log = (): { id: string; line: string }[] =>
    readFileSync(join(state.dir, "lead-events.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const open = () => {
    const supervisor = new Supervisor(deps());
    cleanups.unshift(() => supervisor.close());
    return supervisor;
  };
  return { state, clock, log, open };
};

/** What the conversion recorded in the database: table counts and its import record. */
const converted = (dir: string): { counts: Record<string, number>; sources: { log: { lines: number } } } => {
  const store = new SqliteStore(join(dir, SQLITE_FILE));
  try { return { counts: store.counts(), sources: JSON.parse(store.meta("import") ?? "{}").sources }; } finally { store.close(); }
};

test("a restart after the conversion delivers nothing twice and still delivers what was pending", async () => {
  const f = fixture();
  // Given what a json supervisor left after delivering two events with a third still queued.
  const pending = [["discord:11:1", "INBOUND 11 1 owner hello"], ["report:a", "LANE_REPORT alpha milestone"], ["report:b", "LANE_REPORT beta question"]];
  writeFileSync(join(f.state.dir, "supervisor.json"), JSON.stringify({ events: pending.map(([id, line]) => ({ id, line, at: T0 })), awaitingAck: [{ id: "discord:11:1", since: T0 }] }));
  writeFileSync(join(f.state.dir, "lead-events.log"), pending.slice(0, 2).map(([id, line]) => `${JSON.stringify({ id, line })}\n`).join(""));
  const journal = readFileSync(join(f.state.dir, "supervisor.json"));
  // When it is converted under the barrier and the supervisor restarts on the store, twice.
  expect(convertJsonStore(f.state.dir, f.clock.now())).toBe(true);
  const report = converted(f.state.dir);
  expect(report.sources.log.lines).toBe(2);
  expect(report.counts.events).toBe(3);
  expect(report.counts.deliveries).toBe(2);
  for (let restart = 0; restart < 2; restart++) {
    const after = f.open();
    after.enqueue("discord:11:1", "INBOUND 11 1 owner hello");
    after.enqueue("report:a", "LANE_REPORT alpha milestone");
    await after.flush();
    after.close();
  }
  // Then only the queued event was appended, once, and the source journal is kept read-only for audit.
  expect(f.log().map((event) => event.id)).toEqual(["discord:11:1", "report:a", "report:b"]);
  expect(existsSync(join(f.state.dir, "supervisor.json"))).toBe(false);
  expect(readFileSync(join(f.state.dir, PRE_SQLITE_FILE))).toEqual(journal);
  expect(statSync(join(f.state.dir, PRE_SQLITE_FILE)).mode & 0o777).toBe(0o400);
});

test("a delivery whose store row was lost is recovered from the log tail, not appended again", async () => {
  const f = fixture();
  const supervisor = f.open();
  supervisor.enqueue("report:a", "LANE_REPORT alpha question which base?");
  await supervisor.flush();
  supervisor.close();
  // Given a crash after the log append but before the delivery row: the row and cursor are gone.
  const db = new SqliteStore(join(f.state.dir, SQLITE_FILE));
  db.transaction("full", () => { db.setMeta("log_offset", "0"); });
  db.close();
  const raw = new (await import("bun:sqlite")).Database(join(f.state.dir, SQLITE_FILE));
  raw.exec("DELETE FROM deliveries");
  raw.close();
  // When the supervisor restarts and flushes.
  const after = f.open();
  await after.flush();
  after.close();
  // Then the event is known delivered from the log and is not appended a second time.
  expect(f.log().map((event) => event.id)).toEqual(["report:a"]);
  const check = new SqliteStore(join(f.state.dir, SQLITE_FILE));
  expect(check.deliveredIds()).toEqual(new Set(["report:a"]));
  expect(check.logCursor()).toBe(statSync(join(f.state.dir, "lead-events.log")).size);
  check.close();
});

test("the conversion carries every journal field and reads it back unchanged", () => {
  const state = withState();
  cleanups.push(state.done);
  // Given a journal with every mapped field set, and one event from before enqueue times existed.
  const journal = {
    events: [{ id: "old", line: "LANE_REPORT old" }, { id: "discord:11:2", line: "INBOUND 11 2 hi", at: T0 }, { id: "discord:11:2:edit:9", line: "INBOUND_EDIT 11 2 hi again", at: T0 + 1 }],
    awaitingAck: [
      { id: "discord:11:2", since: T0, reminded: true, noticed: true, ackedAt: T0 + 5, tasks: 2, lanes: ["alpha"], reply: false, handlingSince: T0 + 6, unhandledRemindedAt: T0 + 7, revision: "discord:11:2:edit:9", revisions: ["discord:11:2:edit:9"] },
      { id: "discord:11:3", handledAt: T0 + 9, deleted: true, revisions: ["discord:11:3:delete"] },
    ],
    notifications: { "delay:discord:11:2": { attempts: 1 }, "ack:discord:11:2": { attempts: 3, sent: true } },
    noticed: ["discord:11:2"],
    closedOwners: ["discord:11:0", "discord:11:0:edit:1"],
    outbox: [{ id: "lead-model:s", text: "switched", attempts: 2, retryAt: T0 + 60_000 }],
    restart: { session: "s-1", events: [{ id: "old", line: "LANE_REPORT old" }], offset: 12, phase: "submitted", strikes: 1, unconfirmed: 2, reason: "stuck", request: { id: "r", at: T0, models: [{ model: "a/b" }] }, force: true },
    models: [{ model: "a/b", thinking: "high" }], leadBusySince: T0 + 2, leadScreen: { hash: "ab", since: T0 },
  };
  writeFileSync(join(state.dir, "supervisor.json"), JSON.stringify(journal));
  writeFileSync(join(state.dir, "lead-events.log"), `${JSON.stringify({ id: "old", line: "LANE_REPORT old" })}\n{"id":"partial`);
  // When it is converted.
  expect(convertJsonStore(state.dir, T0 + 100)).toBe(true);
  // Then the read-back equals the source, the stamped time is flagged, and readers outside the supervisor see the store.
  const store = new SqliteStore(join(state.dir, SQLITE_FILE));
  expect(store.read(true)).toEqual(journal as never);
  expect(store.read(false).events[0]).toEqual({ id: "old", line: "LANE_REPORT old", at: T0 + 100 });
  expect(store.deliveredIds()).toEqual(new Set(["old"]));
  expect(store.database.query("SELECT id FROM events WHERE at_synthetic = 1").all()).toEqual([{ id: "old" }]);
  store.close();
  expect(converted(state.dir).sources.log.lines).toBe(1);
});

test("the conversion refuses while a supervisor runs, or a journal field it cannot map, and changes nothing; it runs once", () => {
  const state = withState();
  cleanups.push(state.done);
  writeFileSync(join(state.dir, "supervisor.json"), JSON.stringify({ events: [], futureField: 1 }));
  const release = acquireSupervisor(state.dir);
  try {
    expect(() => convertJsonStore(state.dir, T0)).toThrow("STORE_SUPERVISOR_RUNNING");
  } finally { release(); }
  expect(() => convertJsonStore(state.dir, T0)).toThrow("STORE_IMPORT_UNKNOWN_FIELD");
  expect(existsSync(join(state.dir, "supervisor.json"))).toBe(true);
  expect(existsSync(join(state.dir, SQLITE_FILE))).toBe(false);
  writeFileSync(join(state.dir, "supervisor.json"), JSON.stringify({ events: [] }));
  expect(convertJsonStore(state.dir, T0)).toBe(true);
  expect(convertJsonStore(state.dir, T0)).toBe(false);
});

test("a supervisor refuses a state dir whose supervisor.json is not converted yet, and starts once it is", () => {
  const f = fixture();
  writeFileSync(join(f.state.dir, "supervisor.json"), JSON.stringify({ events: [] }));
  expect(() => f.open()).toThrow("STORE_IMPORT_PENDING");
  convertJsonStore(f.state.dir, T0);
  f.open();
});

test("a version 8 database (no awaiting columns) is read by take and handled before the supervisor migrates it, then migrated keeping its rows", async () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, SQLITE_FILE);
  // Given a version 8 database holding one acked owner message, and its carried UNFINISHED reminder.
  new SqliteStore(path, { create: true }).close();
  const raw = new (await import("bun:sqlite")).Database(path);
  raw.exec(`ALTER TABLE owner_messages DROP COLUMN awaiting_owner_at; ALTER TABLE owner_messages DROP COLUMN awaiting_note;
    UPDATE meta SET value = '8' WHERE key = 'schema_version';
    INSERT INTO meta (key, value) VALUES ('journal', '1');
    INSERT INTO owner_messages (id, pos, lead, generation, state, acked_at, tasks) VALUES ('discord:11:22', 1, 'dori', 0, 'acked', ${T0}, 1);`);
  raw.close();
  writeCarried(state.dir, [{ kind: "owner", id: "discord:11:22", line: "INBOUND 11 22 hi" }]);
  // When the CLI paths read it unmigrated, then this code opens it.
  expect(takeAwaitingReminders(state.dir)).toEqual([]);
  recordHandled(state.dir, "11", "22", T0 + 1, { reply: true });
  expect(readCarried(state.dir)).toEqual([]);
  const store = new SqliteStore(path);
  try {
    // Then it is at version 9 and the row reads back with nothing parked.
    expect(store.meta("schema_version")).toBe("9");
    expect(store.read(false).awaitingAck).toEqual([{ id: "discord:11:22", ackedAt: T0, tasks: 1 }]);
  } finally { store.close(); }
});

test("a version 5 database is migrated to 6: old events read without meta, new ones keep it, deliveries record their take", async () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, SQLITE_FILE);
  // Given a version 5 database (no events.meta, no deliveries.taken_*) holding one delivered event.
  new SqliteStore(path, { create: true }).close();
  const raw = new (await import("bun:sqlite")).Database(path);
  raw.exec(`ALTER TABLE events DROP COLUMN meta; ALTER TABLE deliveries DROP COLUMN taken_at; ALTER TABLE deliveries DROP COLUMN taken_session;
    UPDATE meta SET value = '5' WHERE key = 'schema_version';
    INSERT INTO meta (key, value) VALUES ('journal', '1');
    INSERT INTO events (id, kind, lead, line, at) VALUES ('old', 'LANE_REPORT', 'dori', 'LANE_REPORT old', ${T0});
    INSERT INTO deliveries (event_id, lead, generation, delivered_at) VALUES ('old', 'dori', 0, ${T0 + 1});`);
  raw.close();
  // When this code opens it, saves an event with meta and records a take of both.
  const store = new SqliteStore(path);
  const journal = store.load();
  expect(store.meta("schema_version")).toBe("9");
  expect(journal?.events).toEqual([{ id: "old", line: "LANE_REPORT old", at: T0 }]);
  const meta = { lane: "alpha", thread: "discord:42", cwd: "/repo" };
  store.save({ events: [...(journal?.events ?? []), { id: "new", line: "LANE_REPORT new", at: T0 + 2, meta }] }, "full");
  store.recordTakes(["old", "new"], T0 + 3, "sess-1");
  store.close();
  // Then the old event still has no meta, the new one keeps it, and both deliveries carry the take.
  const reread = new SqliteStore(path);
  try {
    expect(reread.read(false).events).toEqual([{ id: "old", line: "LANE_REPORT old", at: T0 }, { id: "new", line: "LANE_REPORT new", at: T0 + 2, meta }]);
    expect(reread.database.query("SELECT event_id, delivered_at, taken_at, taken_session FROM deliveries ORDER BY event_id").all()).toEqual([
      { event_id: "new", delivered_at: T0 + 3, taken_at: T0 + 3, taken_session: "sess-1" },
      { event_id: "old", delivered_at: T0 + 1, taken_at: T0 + 3, taken_session: "sess-1" },
    ]);
  } finally { reread.close(); }
});

test("extra columns from an older database do not affect load and save", () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, SQLITE_FILE);
  const store = new SqliteStore(path, { create: true });
  const journal = { events: [{ id: "old", line: "HOOK old", at: T0 }], models: [{ model: "a/one" }], leadBusySince: T0 };
  store.save(journal, "full");
  const baseline = store.read(false);
  store.database.exec("ALTER TABLE lead_state ADD COLUMN quota_exhausted TEXT; ALTER TABLE lead_state ADD COLUMN quota_stall_since INTEGER; ALTER TABLE lead_state ADD COLUMN primary_retry_at INTEGER; UPDATE lead_state SET quota_exhausted = '{}', quota_stall_since = 1, primary_retry_at = 1");
  store.close();
  const reopened = new SqliteStore(path);
  try {
    expect(reopened.load()).toEqual(baseline);
    reopened.save({ ...journal, leadBusySince: T0 + 1 }, "full");
    expect(reopened.load()).toEqual({ ...baseline, leadBusySince: T0 + 1 });
  } finally { reopened.close(); }
});
