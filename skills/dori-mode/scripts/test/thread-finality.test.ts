import { expect, test } from "bun:test";

import type { Lane, LaneStatus } from "../src/registry.ts";
import { finalityBlockers, threadIdOf } from "../src/thread-finality.ts";

const THREAD = "discord:100/200";
const lane = (key: string, status: LaneStatus, thread = THREAD): Lane => ({
  key, title: key, thread, brief: "b", done: "d", openedAt: "2026-11-04T00:00:00Z",
  ...(status === "closed" ? { closedAt: "2026-11-04T01:00:00Z" } : { status }),
});
const none = { open: [], waits: [], decisions: [] };

test("threadIdOf reads a thread ref, a bare ref and a bare id", () => {
  expect([threadIdOf("discord:100/200"), threadIdOf("discord:200"), threadIdOf("200")]).toEqual(["200", "200", "200"]);
});

test("a finished lane alone on its thread may carry the button", () => {
  for (const status of ["done-claimed", "verified-done", "closed"] as const) {
    expect(finalityBlockers({ ...none, lane: lane("a", status), thread: "200", open: [lane("a", status)] })).toEqual([]);
  }
});

test("the reported lane still working, paused or not-done withholds it", () => {
  for (const status of ["working", "paused", "not-done"] as const) {
    expect(finalityBlockers({ ...none, lane: lane("a", status), thread: "200" })).toEqual([`lane a is ${status}`]);
  }
});

test("another open lane on the thread withholds it; one elsewhere does not", () => {
  const open = [lane("a", "done-claimed"), lane("b", "working"), lane("c", "working", "discord:100/300"), lane("d", "working", "none")];
  expect(finalityBlockers({ ...none, lane: open[0] as Lane, thread: "200", open })).toEqual(["lane b is still open on this thread (working)"]);
});

test("a wait on the thread withholds it, by ref or bare id; a wait without a thread does not", () => {
  const waits = [{ key: "w1", thread: THREAD }, { key: "w2", thread: "200" }, { key: "w3" }, { key: "w4", thread: "discord:100/300" }];
  expect(finalityBlockers({ ...none, lane: lane("a", "done-claimed"), thread: "200", waits }))
    .toEqual(["wait w1 is registered on this thread", "wait w2 is registered on this thread"]);
});

test("an open decision for the reported lane or another lane on the thread withholds it", () => {
  const open = [lane("a", "done-claimed"), lane("b", "working")];
  const decisions = [
    { id: "e1", line: "LANE_REPORT a question which one?" },
    { id: "e2", line: "LANE_ASKING b waits on an on-screen question" },
    { id: "e3", line: "LANE_REPORT x blocked elsewhere" },
    { id: "e4" },
  ];
  expect(finalityBlockers({ ...none, lane: open[0] as Lane, thread: "200", open, decisions })).toEqual([
    "lane b is still open on this thread (working)",
    "decision e1 for lane a is unresolved",
    "decision e2 for lane b is unresolved",
  ]);
});
