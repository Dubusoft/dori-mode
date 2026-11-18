import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LANE_MESSAGES_FILE, type LaneMessageStore, queueLaneMessage, SqliteLaneMessages, updateLaneMessage } from "../src/lane-messages.ts";
import { LANE_REPORTS_FILE, type LaneReportStore, openLaneReports, SqliteLaneReports } from "../src/lane-report-store.ts";
import { SQLITE_FILE } from "../src/store.ts";
import { convertJsonStore } from "../src/store-import.ts";
import { storePath, withState } from "./fakes.ts";

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

const sqlite = (dir: string) => rows(new SqliteLaneReports(join(dir, SQLITE_FILE)), new SqliteLaneMessages(join(dir, SQLITE_FILE)));

/** A json state dir as an older release left it: an empty journal, and lane-reports.json and lane-messages.json holding the seeded rows. */
const jsonDir = (): { dir: string; before: ReturnType<typeof sqlite> } => {
  const scratch = stateDir();
  seed(new SqliteLaneReports(storePath(scratch)), new SqliteLaneMessages(storePath(scratch)));
  const before = sqlite(scratch);
  const dir = stateDir();
  writeFileSync(join(dir, "supervisor.json"), JSON.stringify({ events: [] }));
  writeFileSync(join(dir, LANE_REPORTS_FILE), JSON.stringify({ reports: before.reports }));
  writeFileSync(join(dir, LANE_MESSAGES_FILE), JSON.stringify({ messages: Object.fromEntries(before.messages.map((m) => [m.id, m])) }));
  return { dir, before };
};

test("the conversion carries every lane report and lane message, pending and consumed, and retires the json files", () => {
  // Given a json state dir with routed and pending lane reports and lane messages in every state.
  const { dir, before } = jsonDir();
  expect(before.pending).toEqual(["lane-b:0:1", "lane-a:0:2"]);
  // When it is converted.
  expect(convertJsonStore(dir, T0 + 10)).toBe(true);
  // Then the sqlite store holds the same rows, ids, routes and states, and the json files are kept read-only for audit.
  expect(sqlite(dir)).toEqual(before);
  for (const file of [LANE_REPORTS_FILE, LANE_MESSAGES_FILE]) {
    expect(existsSync(join(dir, file))).toBe(false);
    expect(statSync(join(dir, `${file}.pre-sqlite`)).mode & 0o777).toBe(0o400);
  }
  // And a lane writing next through the sqlite store continues its own seq.
  const store = openLaneReports({ stateDir: dir });
  expect(store.append({ lane: "lane-a", generation: 0, kind: "milestone", text: "tests green", at: T0 + 20 }).id).toBe("lane-a:0:3");
  store.close();
});

test("the conversion refuses a lane file whose retired copy is already there, and changes nothing", () => {
  const { dir } = jsonDir();
  writeFileSync(join(dir, `${LANE_MESSAGES_FILE}.pre-sqlite`), JSON.stringify({ messages: {} }));
  const files = [LANE_REPORTS_FILE, LANE_MESSAGES_FILE, "supervisor.json"].map((file) => readFileSync(join(dir, file), "utf8"));
  expect(() => convertJsonStore(dir, T0)).toThrow("STORE_EXISTS");
  expect(existsSync(join(dir, SQLITE_FILE))).toBe(false);
  expect([LANE_REPORTS_FILE, LANE_MESSAGES_FILE, "supervisor.json"].map((file) => readFileSync(join(dir, file), "utf8"))).toEqual(files);
});
