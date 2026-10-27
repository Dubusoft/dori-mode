import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { JsonLaneMessages, LANE_MESSAGES_FILE, type LaneMessageStore, queueLaneMessage, SqliteLaneMessages, updateLaneMessage } from "../src/lane-messages.ts";
import { JsonLaneReports, LANE_REPORTS_FILE, type LaneReportStore, openLaneReports, SqliteLaneReports } from "../src/lane-reports.ts";
import { SQLITE_FILE } from "../src/store.ts";
import { EXPORTED_SQLITE_FILE, exportStore } from "../src/store-export.ts";
import { importStore } from "../src/store-import.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const T0 = 1_800_000_000_000;

const stateDir = (): string => {
  const state = withState();
  cleanups.push(state.done);
  return state.dir;
};

/** Two lanes' reports, one routed and two pending, and three messages: queued, delivered (escalated), acked. */
const seed = (reports: LaneReportStore, messages: LaneMessageStore): void => {
  reports.append({ lane: "lane-a", generation: 0, kind: "progress", text: "step 1", at: T0 });
  reports.append({ lane: "lane-b", generation: 0, kind: "question", text: "which base?", evidence: "PR #4", at: T0 + 1 });
  reports.append({ lane: "lane-a", generation: 0, kind: "blocked", text: "CI down", at: T0 + 2 });
  reports.consume("lane-a:0:1", T0 + 3, "thread");
  queueLaneMessage(messages, T0, { id: "m-queued", lane: "lane-a", subject: "o/r#1@abc", text: "rebase" });
  const delivered = queueLaneMessage(messages, T0 + 1, { id: "m-delivered", lane: "lane-b", subject: "o/r#2@def", text: "checks red" });
  updateLaneMessage(messages, delivered, { state: "delivered", deliveredAt: T0 + 2, escalatedAt: T0 + 5, blocked: "busy" }, T0 + 5);
  const acked = queueLaneMessage(messages, T0 + 2, { id: "m-acked", lane: "lane-a", subject: "o/r#3@123", text: "merged" });
  updateLaneMessage(messages, acked, { state: "acked", deliveredAt: T0 + 3, ackedAt: T0 + 4 }, T0 + 4);
};

const rows = (reports: LaneReportStore, messages: LaneMessageStore) => {
  try {
    return { reports: reports.list(), pending: reports.pending().map((r) => r.id), messages: messages.list() };
  } finally { reports.close(); messages.close(); }
};

const json = (dir: string) => rows(new JsonLaneReports(dir), new JsonLaneMessages(dir));
const sqlite = (dir: string) => rows(new SqliteLaneReports(join(dir, SQLITE_FILE)), new SqliteLaneMessages(join(dir, SQLITE_FILE)));

/** A sqlite state dir with nothing in it but an empty journal. */
const sqliteDir = (): string => {
  const dir = stateDir();
  writeFileSync(join(dir, "supervisor.json"), JSON.stringify({ events: [] }));
  importStore(dir, T0);
  return dir;
};

test("the import carries every lane report and lane message, pending and consumed, and retires the json files", () => {
  // Given a json state dir with routed and pending lane reports and lane messages in every state.
  const dir = stateDir();
  writeFileSync(join(dir, "supervisor.json"), JSON.stringify({ events: [] }));
  seed(new JsonLaneReports(dir), new JsonLaneMessages(dir));
  const before = json(dir);
  expect(before.pending).toEqual(["lane-b:0:1", "lane-a:0:2"]);
  // When it is imported.
  importStore(dir, T0 + 10);
  // Then the sqlite store holds the same rows, ids, routes and states, and the json files are kept read-only for audit.
  expect(sqlite(dir)).toEqual(before);
  for (const file of [LANE_REPORTS_FILE, LANE_MESSAGES_FILE]) {
    expect(existsSync(join(dir, file))).toBe(false);
    expect(statSync(join(dir, `${file}.pre-sqlite`)).mode & 0o777).toBe(0o400);
  }
  // And a lane writing next through the sqlite store continues its own seq.
  const store = openLaneReports({ stateDir: dir, store: "sqlite" });
  expect(store.append({ lane: "lane-a", generation: 0, kind: "milestone", text: "tests green", at: T0 + 20 }).id).toBe("lane-a:0:3");
  store.close();
});

test("the export carries every lane report and lane message back into the json files", () => {
  // Given a sqlite state dir with routed and pending lane reports and lane messages in every state.
  const dir = sqliteDir();
  seed(new SqliteLaneReports(join(dir, SQLITE_FILE)), new SqliteLaneMessages(join(dir, SQLITE_FILE)));
  const before = sqlite(dir);
  // When it is exported.
  exportStore(dir, T0 + 10);
  // Then the json files hold the same rows, ids, routes and states, and a lane's next report continues its seq.
  expect(existsSync(join(dir, EXPORTED_SQLITE_FILE))).toBe(true);
  expect(json(dir)).toEqual(before);
  expect(new JsonLaneReports(dir).append({ lane: "lane-b", generation: 0, kind: "done", text: "merged", at: T0 + 20 }).id).toBe("lane-b:0:2");
});

test("json to sqlite to json returns the lane files' rows unchanged", () => {
  const dir = stateDir();
  writeFileSync(join(dir, "supervisor.json"), JSON.stringify({ events: [] }));
  seed(new JsonLaneReports(dir), new JsonLaneMessages(dir));
  const before = json(dir);
  importStore(dir, T0 + 10);
  exportStore(dir, T0 + 11);
  expect(json(dir)).toEqual(before);
});

test("the export refuses a lane file that holds rows the store lacks or holds differently, and changes nothing", () => {
  // Given a sqlite store with rows, and a stale lane-reports.json whose lane-a:0:1 says something else.
  const dir = sqliteDir();
  seed(new SqliteLaneReports(join(dir, SQLITE_FILE)), new SqliteLaneMessages(join(dir, SQLITE_FILE)));
  const stale = JSON.stringify({ reports: [{ id: "lane-a:0:1", lane: "lane-a", generation: 0, seq: 1, kind: "progress", text: "old", at: T0 - 5 }] });
  writeFileSync(join(dir, LANE_REPORTS_FILE), stale);
  const stored = sqlite(dir);
  // When it is exported, then it refuses and the state dir stays a sqlite state dir.
  expect(() => exportStore(dir, T0 + 10)).toThrow("STORE_EXPORT_CONFLICT");
  expect(readFileSync(join(dir, LANE_REPORTS_FILE), "utf8")).toBe(stale);
  expect(sqlite(dir)).toEqual(stored);
  for (const file of ["supervisor.json", LANE_MESSAGES_FILE, EXPORTED_SQLITE_FILE]) expect(existsSync(join(dir, file))).toBe(false);
  // A lane file holding only rows equal to the store's is no conflict: it is completed.
  const subset = new SqliteLaneMessages(join(dir, SQLITE_FILE));
  writeFileSync(join(dir, LANE_MESSAGES_FILE), JSON.stringify({ messages: { "m-queued": subset.get("m-queued") } }));
  subset.close();
  writeFileSync(join(dir, LANE_REPORTS_FILE), JSON.stringify({ reports: [] }));
  const before = sqlite(dir);
  exportStore(dir, T0 + 10);
  expect(json(dir)).toEqual(before);
});

test("the import refuses a lane file whose retired copy is already there, and changes nothing", () => {
  const dir = stateDir();
  writeFileSync(join(dir, "supervisor.json"), JSON.stringify({ events: [] }));
  seed(new JsonLaneReports(dir), new JsonLaneMessages(dir));
  writeFileSync(join(dir, `${LANE_MESSAGES_FILE}.pre-sqlite`), JSON.stringify({ messages: {} }));
  const before = json(dir);
  expect(() => importStore(dir, T0)).toThrow("STORE_EXISTS");
  expect(existsSync(join(dir, SQLITE_FILE))).toBe(false);
  expect(existsSync(join(dir, "supervisor.json"))).toBe(true);
  expect(json(dir)).toEqual(before);
});
