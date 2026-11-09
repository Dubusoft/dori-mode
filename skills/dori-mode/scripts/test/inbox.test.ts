import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { defaultConfig, deliveryConfigError, loadConfig } from "../src/config.ts";
import { checklistLine, EVENT_LOG, InboxError, readCarried, readCursorFile, take, takeCursor, takeOutput, takesDir, unreadAfterAck, writeCursorFile } from "../src/inbox.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { Supervisor } from "../src/supervise.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const state = (cursor: number | null = 0): string => {
  const s = withState();
  cleanups.push(s.done);
  if (cursor !== null) writeCursorFile(s.dir, cursor);
  return s.dir;
};
const line = (id: string, text: string): string => `${JSON.stringify({ id, line: text })}\n`;
const log = (dir: string, text: string): void => { appendFileSync(join(dir, EVENT_LOG), text); };
const receipts = (dir: string): string[] => (existsSync(takesDir(dir)) ? readdirSync(takesDir(dir)) : []);
const NOW = 1_800_000_000_000;

test("take prints from the cursor to the last complete line and its receipt covers exactly that; a second take is empty", () => {
  const dir = state();
  log(dir, line("a", "WAIT_DONE one") + line("b", "LANE_REPORT k question why?") + '{"id":"c","li');
  const first = take(dir, { maxBytes: 16_384, now: NOW });
  expect(takeOutput(first)).toEqual(["a\tWAIT_DONE one", "b\tLANE_REPORT k question why?"]);
  expect(first.offset).toBe(Buffer.byteLength(line("a", "WAIT_DONE one") + line("b", "LANE_REPORT k question why?")));
  expect(receipts(dir)).toHaveLength(1);
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW }))).toEqual(["INBOX_EMPTY"]);
  expect(receipts(dir)).toHaveLength(1);
  // The partial line completes: the next take prints it alone.
  log(dir, 'ne":"WAIT_DONE three"}\n');
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW }))).toEqual(["c\tWAIT_DONE three"]);
});

test("a backlog past --max-bytes prints whole lines then INBOX_MORE, the receipt covers only those, and one oversized line goes alone", () => {
  const dir = state();
  const lines = [line("a", "x".repeat(40)), line("b", "y".repeat(40)), line("c", "z".repeat(40))];
  log(dir, lines.join(""));
  const size = Buffer.byteLength(lines[0] ?? "");
  const first = take(dir, { maxBytes: size + 10, now: NOW });
  expect(takeOutput(first)).toEqual([`a\t${"x".repeat(40)}`, `INBOX_MORE 2 ${2 * size}`]);
  expect(first.offset).toBe(size);
  expect(takeOutput(take(dir, { maxBytes: 5, now: NOW }))).toEqual([`b\t${"y".repeat(40)}`, `INBOX_MORE 1 ${size}`]);
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW }))).toEqual([`c\t${"z".repeat(40)}`]);
});

test("--peek prints without a receipt, and without a published cursor take refuses instead of printing the whole log", () => {
  const dir = state();
  log(dir, line("a", "WAIT_DONE one"));
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW, peek: true }))).toEqual(["a\tWAIT_DONE one"]);
  expect(receipts(dir)).toEqual([]);
  const bare = state(null);
  log(bare, line("a", "WAIT_DONE one"));
  expect(() => take(bare, { maxBytes: 16_384, now: NOW })).toThrow(InboxError);
});

test("the take cursor is the max over the cursor file and every receipt, so a crash in the consume order never reprints", () => {
  const dir = state(100);
  mkdirSync(takesDir(dir), { recursive: true });
  // Crash after the store moved but before the cursor file: the receipts still carry the offset.
  writeFileSync(join(takesDir(dir), `${NOW}-b.json`), JSON.stringify({ offset: 150, at: NOW }));
  writeFileSync(join(takesDir(dir), `${NOW + 1}-a.json`), JSON.stringify({ offset: 120, at: NOW + 1 }));
  expect(takeCursor(dir)).toBe(150);
  // Crash after the cursor file but before the receipts were dropped.
  writeCursorFile(dir, 150);
  expect(takeCursor(dir)).toBe(150);
});

test("the supervisor consumes take receipts in every mode: cursor file first, then the receipts are dropped", async () => {
  const s = withState();
  cleanups.push(s.done);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "w", agent: "omo", agent_status: "working" });
  const supervisor = new Supervisor(depsFor(world, fakeClock(NOW), s.dir));
  cleanups.push(() => { supervisor.close(); });
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await supervisor.flush();
  expect(readCursorFile(s.dir)).toBe(0);
  const taken = take(s.dir, { maxBytes: 16_384, now: NOW });
  supervisor.ackTick(60_000);
  expect(readCursorFile(s.dir)).toBe(taken.offset);
  expect(receipts(s.dir)).toEqual([]);
});

test("delivery config: the defaults are safe, unsafe timings are refused, and a delivery key in the file is ignored", async () => {
  const base = defaultConfig().delivery;
  expect("mode" in base).toBe(false);
  expect(deliveryConfigError(base)).toBeUndefined();
  expect(deliveryConfigError({ ...base, push: { ...base.push, ackSec: 5 } })).toContain("ackSec");
  expect(deliveryConfigError({ ...base, push: { ...base.push, escalateMin: 1, ackSec: 45, retries: 2 } })).toContain("escalateMin");
  expect(deliveryConfigError({ ...base, restartMaxPerHour: 0 })).toContain("restartMaxPerHour");
  const dir = state();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ delivery: { mode: "shadow", push: { ackSec: 60, debounceMs: 2000 } } }));
  const loaded = await loadConfig(path, dir);
  expect(loaded.delivery).toEqual(base);
});

test("the sqlite store keeps inbox and forcedRestarts, and a version 3 database is migrated to hold them", () => {
  const dir = state();
  const path = join(dir, SQLITE_FILE);
  const created = new SqliteStore(path, { create: true });
  const db = new Database(path);
  db.exec("ALTER TABLE lead_state DROP COLUMN inbox; ALTER TABLE lead_state DROP COLUMN forced_restarts; UPDATE meta SET value = '3' WHERE key = 'schema_version'");
  db.close();
  created.close();
  const journal = {
    events: [],
    inbox: { takenOffset: 42, mode: "push+tail", sessionSince: NOW, push: { at: NOW, upto: 84, attempts: 2, batch: "b1", first: NOW - 1 } },
    forcedRestarts: [{ at: NOW, cause: "forced" }],
  };
  const store = new SqliteStore(path);
  store.save(journal, "full");
  store.close();
  const reread = new SqliteStore(path);
  const back = reread.read(false);
  reread.close();
  expect({ inbox: back.inbox, forcedRestarts: back.forcedRestarts }).toEqual({ inbox: journal.inbox, forcedRestarts: journal.forcedRestarts });
});

const metaLine = (id: string, text: string, meta: object): string => `${JSON.stringify({ id, line: text, meta })}\n`;

test("take groups lines under lane headers in first-seen order, lines without meta go last under ## other, and everything printed is receipted", () => {
  const dir = state();
  log(dir, metaLine("a", "LANE_REPORT alpha question one?", { lane: "alpha", thread: "discord:1/2", cwd: "/repo/a" })
    + line("n", "WAIT_DONE no meta")
    + metaLine("b", "LANE_REPORT beta blocked stuck", { lane: "beta", cwd: "/repo/b" })
    + metaLine("c", "LANE_REPORT_LATE alpha milestone two", { lane: "alpha", thread: "discord:1/2", cwd: "/repo/a" })
    + metaLine("d", "WAIT_DONE gamma ok", { lane: "gamma" })
    + line("m", "WAIT_DONE also none"));
  const result = take(dir, { maxBytes: 16_384, now: NOW });
  expect(takeOutput(result)).toEqual([
    "## lane alpha  thread discord:1/2  cwd /repo/a",
    "a\tLANE_REPORT alpha question one?",
    "c\tLANE_REPORT_LATE alpha milestone two",
    "## lane beta  cwd /repo/b",
    "b\tLANE_REPORT beta blocked stuck",
    "## lane gamma",
    "d\tWAIT_DONE gamma ok",
    "## other",
    "n\tWAIT_DONE no meta",
    "m\tWAIT_DONE also none",
  ]);
  // Grouping is output only: the receipt covers every printed line in log order, and the cursor moves past all of them.
  expect(result.events.map((e) => e.id)).toEqual(["a", "n", "b", "c", "d", "m"]);
  expect(receipts(dir)).toHaveLength(1);
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW }))).toEqual(["INBOX_EMPTY"]);
});

test("when no line has meta the take output is byte-identical to the ungrouped form, and malformed meta counts as none", () => {
  const dir = state();
  log(dir, line("a", "WAIT_DONE one") + `${JSON.stringify({ id: "b", line: "WAIT_DONE two", meta: { lane: 5, thread: "" } })}\n` + JSON.stringify({ id: "c", line: "x", meta: "bad" }) + "\n");
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW, peek: true })).join("\n")).toBe("a\tWAIT_DONE one\nb\tWAIT_DONE two\nc\tx");
});

test("checklistLine: owner chat plus an outcome event puts one checklist line first, deduping lane keys", () => {
  expect(checklistLine(["e1\tINBOUND discord 1 hi", "e2\tLANE_DONE_CLAIMED alpha ok", "e3\tVISITOR x hello", "e4\tLANE_CLOSED alpha", "e5\tCI_MERGED pr=1 lane=beta"]))
    .toBe("checklist:e1\tCHECKLIST this batch owes: reply to 2 owner message(s); report lane alpha, beta (dori reported <key> --text ...)");
});

test("checklistLine: owner-only and outcome-only batches get none", () => {
  expect(checklistLine(["e1\tINBOUND discord 1 hi", "e2\tWAIT_DONE x"])).toBeUndefined();
  expect(checklistLine(["e1\tLANE_CLOSED alpha", "unreported:beta\tUNREPORTED beta since now: run it"])).toBeUndefined();
  expect(checklistLine([])).toBeUndefined();
});

test("checklistLine: an UNREPORTED reminder plus owner chat gives the checklist", () => {
  expect(checklistLine(["e9\tINBOUND discord 2 yo", "unreported:gamma\tUNREPORTED gamma since 2026: run dori reported gamma --text TEXT"]))
    .toBe("checklist:e9\tCHECKLIST this batch owes: reply to 1 owner message(s); report lane gamma (dori reported <key> --text ...)");
});

test("take prints owner messages and edits first, before lane groups and ## other, without changing the receipt order", () => {
  const dir = state();
  log(dir, metaLine("a", "LANE_REPORT alpha question one?", { lane: "alpha", cwd: "/repo/a" })
    + line("n", "WAIT_DONE no meta")
    + line("discord:1:2", "INBOUND discord 1 hello")
    + line("discord:1:2:edit:x", "INBOUND_EDIT discord 1 hello there")
    + line("v", "VISITOR someone hi"));
  const result = take(dir, { maxBytes: 16_384, now: NOW });
  expect(takeOutput(result)).toEqual([
    "## owner",
    "discord:1:2\tINBOUND discord 1 hello",
    "discord:1:2:edit:x\tINBOUND_EDIT discord 1 hello there",
    "v\tVISITOR someone hi",
    "## lane alpha  cwd /repo/a",
    "a\tLANE_REPORT alpha question one?",
    "## other",
    "n\tWAIT_DONE no meta",
  ]);
  expect(result.events.map((e) => e.id)).toEqual(["a", "n", "discord:1:2", "discord:1:2:edit:x", "v"]);
});

test("without any meta, owner lines still lead the ungrouped output", () => {
  const dir = state();
  log(dir, line("n", "WAIT_DONE x") + line("discord:1:2", "INBOUND discord 1 hi"));
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW, peek: true }))).toEqual(["discord:1:2\tINBOUND discord 1 hi", "n\tWAIT_DONE x"]);
});

test("checklistLine counts INBOUND_EDIT and carried owner notices, once per owner message", () => {
  expect(checklistLine(["e1\tINBOUND_EDIT discord 1 fixed", "e2\tLANE_CLOSED alpha"]))
    .toBe("checklist:e1\tCHECKLIST this batch owes: reply to 1 owner message(s); report lane alpha (dori reported <key> --text ...)");
  expect(checklistLine(["unfinished:discord:1:2\tUNFINISHED discord:1:2 taken and not handled (dori ack it unless acked, then handle it): INBOUND discord 1 hi", "e2\tLANE_CLOSED alpha"]))
    .toBe("checklist:unfinished:discord:1:2\tCHECKLIST this batch owes: reply to 1 owner message(s); report lane alpha (dori reported <key> --text ...)");
  expect(checklistLine(["discord:1:2\tINBOUND discord 1 hi", "unfinished:discord:1:2\tUNFINISHED discord:1:2 taken and not handled (x): INBOUND discord 1 hi", "e2\tLANE_CLOSED alpha"]))
    .toContain("reply to 1 owner message(s)");
});

test("unreadAfterAck lists same-channel owner events past the cursor, leaving out only the acked original, and moves nothing", () => {
  const dir = state();
  log(dir, line("discord:11:20", "INBOUND 11 20 owner earlier, already taken"));
  writeCursorFile(dir, Buffer.byteLength(line("discord:11:20", "INBOUND 11 20 owner earlier, already taken")));
  log(dir, line("discord:11:22", "INBOUND 11 22 owner build the thing")
    + line("discord:11:22:edit:2026-11-05T00:00:00Z", "INBOUND_EDIT 11 22 owner (edited) build the other thing")
    + line("discord:11:23", "INBOUND 11 23 owner   and\n  the docs too")
    + line("discord:11:22:delete", "INBOUND_DELETE 11 22 (deleted)")
    + line("discord:99:5", "INBOUND 99 5 owner another channel")
    + line("discord:11:24", "VISITOR 11 24 guest (not the owner) hi")
    + line("w1", "WAIT_DONE k note"));
  const before = readCursorFile(dir);
  expect(unreadAfterAck(dir, [{ channel: "11", message: "22" }])).toEqual([
    "UNREAD 11 INBOUND_EDIT discord:11:22:edit:2026-11-05T00:00:00Z owner (edited) build the other thing",
    "UNREAD 11 INBOUND discord:11:23 owner and the docs too",
    "UNREAD 11 INBOUND_DELETE discord:11:22:delete (deleted)",
  ]);
  // Read only: no take receipt, no carried owner text, the same cursor; the next take still prints everything.
  expect(receipts(dir)).toEqual([]);
  expect(readCarried(dir)).toEqual([]);
  expect(readCursorFile(dir)).toBe(before);
  expect(take(dir, { maxBytes: 16_384, now: NOW }).events.map((event) => event.id)).toContain("discord:11:22");
});

test("unreadAfterAck caps each channel and counts the overflow, prints each channel once, and says none when nothing waits", () => {
  const dir = state();
  log(dir, Array.from({ length: 7 }, (_, i) => line(`discord:11:${30 + i}`, `INBOUND 11 ${30 + i} owner m${i}`)).join("")
    + line("discord:44:1", "INBOUND 44 1 owner acked one"));
  expect(unreadAfterAck(dir, [{ channel: "11", message: "30" }, { channel: "44", message: "1" }, { channel: "11", message: "31" }], 3)).toEqual([
    "UNREAD 11 INBOUND discord:11:32 owner m2",
    "UNREAD 11 INBOUND discord:11:33 owner m3",
    "UNREAD 11 INBOUND discord:11:34 owner m4",
    "UNREAD_MORE 11 2",
    "UNREAD_NONE 44",
  ]);
});

test("unreadAfterAck keeps the channel name token last, outside the cut preview, and on UNREAD_MORE", () => {
  const dir = state();
  log(dir, line("discord:11:2", `INBOUND 11 2 owner ${"x".repeat(400)} channel=#일반/작업`)
    + line("discord:11:3", "INBOUND 11 3 owner short channel=#일반/작업"));
  const [first, more] = unreadAfterAck(dir, [{ channel: "11", message: "1" }], 1);
  expect(first).toEndWith("x... channel=#일반/작업");
  expect(more).toBe("UNREAD_MORE 11 1 channel=#일반/작업");
});

test("unreadAfterAck cuts a long preview and reports UNREAD_UNAVAILABLE instead of throwing without a cursor or on a read failure", () => {
  const dir = state();
  log(dir, line("discord:11:2", `INBOUND 11 2 owner ${"x".repeat(400)}`));
  const [first] = unreadAfterAck(dir, [{ channel: "11", message: "1" }]);
  expect(first?.endsWith("...")).toBe(true);
  expect(first?.length).toBeLessThan(260);
  expect(unreadAfterAck(state(null), [{ channel: "11", message: "1" }])[0]).toStartWith("UNREAD_UNAVAILABLE ");
  const broken = state();
  mkdirSync(join(broken, EVENT_LOG));
  writeFileSync(join(broken, "inbox-cursor.json"), JSON.stringify({ offset: 0 }));
  expect(unreadAfterAck(broken, [{ channel: "11", message: "1" }])[0]).toStartWith("UNREAD_UNAVAILABLE ");
});
