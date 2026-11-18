import { expect, test } from "bun:test";

import type { Lane, LaneStatus } from "../src/registry.ts";
import { threadBlockers, threadIdOf } from "../src/thread-finality.ts";

const THREAD = "discord:100/200";
const lane = (key: string, status: LaneStatus, thread = THREAD): Lane => ({
  key, title: key, thread, brief: "b", done: "d", openedAt: "2026-11-04T00:00:00Z",
  ...(status === "closed" ? { closedAt: "2026-11-04T01:00:00Z" } : { status }),
});
const none = { thread: "200", lanes: [], open: [], unreported: [], waits: [], decisions: [] };

test("threadIdOf reads a thread ref, a bare ref and a bare id", () => {
  expect([threadIdOf("discord:100/200"), threadIdOf("discord:200"), threadIdOf("200")]).toEqual(["200", "200", "200"]);
});

test("a thread whose lanes are all closed and reported may be closed", () => {
  expect(threadBlockers({ ...none, lanes: ["a"], open: [lane("a", "closed")] })).toEqual([]);
});

test("a lane on the thread short of closed holds it open, done-claimed included; one elsewhere does not", () => {
  const open = [lane("a", "done-claimed"), lane("b", "working"), lane("c", "working", "discord:100/300"), lane("d", "working", "none")];
  expect(threadBlockers({ ...none, lanes: ["a"], open })).toEqual([
    "lane a is still open on this thread (done-claimed)",
    "lane b is still open on this thread (working)",
  ]);
});

test("an unreported lane holds it open", () => {
  expect(threadBlockers({ ...none, unreported: ["a"] })).toEqual(["lane a is not reported"]);
});

test("a wait on the thread holds it open, by ref or bare id; a wait without a thread does not", () => {
  const waits = [{ key: "w1", thread: THREAD }, { key: "w2", thread: "200" }, { key: "w3" }, { key: "w4", thread: "discord:100/300" }];
  expect(threadBlockers({ ...none, waits })).toEqual(["wait w1 is registered on this thread", "wait w2 is registered on this thread"]);
});

test("an open decision for a lane of the thread holds it open; one for another lane does not", () => {
  const decisions = [
    { id: "e1", line: "LANE_REPORT a question which one?" },
    { id: "e2", lane: "b" },
    { id: "e3", line: "LANE_REPORT x blocked elsewhere" },
    { id: "e4" },
  ];
  expect(threadBlockers({ ...none, lanes: ["a"], unreported: ["b"], decisions })).toEqual([
    "lane b is not reported",
    "decision e1 for lane a is unresolved",
    "decision e2 for lane b is unresolved",
  ]);
});
