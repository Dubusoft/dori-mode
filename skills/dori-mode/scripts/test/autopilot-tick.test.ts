import { expect, test } from "bun:test";

import type { CandidatesReport, Verdict } from "../src/autopilot.ts";
import { AUTOPILOT_KICK_MAX_MS, AUTOPILOT_KICK_QUIET_MS, AUTOPILOT_RENOTIFY_MS, AutopilotTick } from "../src/autopilot-tick.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const AUTOPILOT_TICK_MS = 300_000;


const launch = (taskId: number): Verdict => ({ taskId, verdict: "LAUNCH", reasons: [] });
const hold = (taskId: number): Verdict => ({ taskId, verdict: "HOLD", reasons: ["no-slot"] });
const report = (verdicts: readonly Verdict[], slots: number | null = 1, paused = false): CandidatesReport =>
  ({ paused, slots, verdicts });

/** A tick over a settable clock and report; `lines` are the journaled events, `judged` counts judgments. */
const harness = (initial: CandidatesReport | Error, tickMs = AUTOPILOT_TICK_MS, localState?: () => Promise<string>) => {
  let now = T0;
  let next: CandidatesReport | Error = initial;
  const lines: string[] = [];
  const logs: string[] = [];
  let judged = 0;
  const tick = new AutopilotTick({
    tickMs: () => tickMs,
    judge: async () => { judged++; if (next instanceof Error) throw next; return next; },
    localState, enqueue: (_id, line) => { lines.push(line); }, now: () => now, log: (line) => { logs.push(line); },
  });
  return {
    tick, lines, logs, judged: () => judged,
    clock: (ms: number) => { now = T0 + ms; },
    at: async (ms: number) => { now = T0 + ms; await tick.tick(); },
    set: (r: CandidatesReport | Error) => { next = r; },
  };
};

test("a LAUNCH set is announced once, a set with a new id again, and an unchanged set only after 30 minutes", async () => {
  const h = harness(report([launch(15), launch(12), hold(13)]));
  await h.at(0);
  expect(h.lines).toEqual(["AUTOPILOT_READY #12,#15 slots=1"]);
  await h.at(AUTOPILOT_TICK_MS);
  await h.at(2 * AUTOPILOT_TICK_MS);
  expect(h.lines).toHaveLength(1);
  h.set(report([launch(12), launch(15)], 2));
  await h.at(3 * AUTOPILOT_TICK_MS - 1);
  expect(h.lines).toHaveLength(1);
  h.set(report([launch(12), launch(15), launch(16)], 2));
  await h.at(3 * AUTOPILOT_TICK_MS);
  expect(h.lines.at(-1)).toBe("AUTOPILOT_READY #12,#15,#16 slots=2");
  const announced = 3 * AUTOPILOT_TICK_MS;
  for (let ms = announced + AUTOPILOT_TICK_MS; ms < announced + AUTOPILOT_RENOTIFY_MS; ms += AUTOPILOT_TICK_MS) await h.at(ms);
  expect(h.lines).toHaveLength(2);
  await h.at(announced + AUTOPILOT_RENOTIFY_MS);
  expect(h.lines.at(-1)).toBe("AUTOPILOT_READY #12,#15,#16 slots=2 again");
  await h.at(announced + AUTOPILOT_RENOTIFY_MS + AUTOPILOT_TICK_MS);
  expect(h.lines).toHaveLength(3);
});

test("no LAUNCH journals nothing, and a set that comes back after an empty tick is news again", async () => {
  const h = harness(report([hold(12)]));
  await h.at(0);
  expect(h.lines).toEqual([]);
  h.set(report([launch(12)]));
  await h.at(AUTOPILOT_TICK_MS);
  h.set(report([]));
  await h.at(2 * AUTOPILOT_TICK_MS);
  h.set(report([launch(12)]));
  await h.at(3 * AUTOPILOT_TICK_MS);
  expect(h.lines).toEqual(["AUTOPILOT_READY #12 slots=1", "AUTOPILOT_READY #12 slots=1"]);
});

test("a pass before the tick is due judges nothing; a kick brings it forward once kicks are quiet for AUTOPILOT_KICK_QUIET_MS", async () => {
  const h = harness(report([]));
  await h.at(0);
  await h.at(60_000);
  expect(h.judged()).toBe(1);
  h.clock(60_000);
  h.tick.kick();
  await h.at(60_000);
  expect(h.judged()).toBe(1);
  await h.at(60_000 + AUTOPILOT_KICK_QUIET_MS - 1);
  expect(h.judged()).toBe(1);
  await h.at(60_000 + AUTOPILOT_KICK_QUIET_MS);
  expect(h.judged()).toBe(2);
  await h.at(60_000 + AUTOPILOT_KICK_QUIET_MS + 1_000);
  expect(h.judged()).toBe(2);
});

test("a five-task burst straddling a pass boundary yields one AUTOPILOT_READY with all five ids", async () => {
  const h = harness(report([]));
  await h.at(0);
  const ids: Verdict[] = [];
  for (let s = 1; s <= 5; s++) {
    ids.push(launch(s));
    h.set(report(ids, 5));
    h.clock(s * 1_000);
    h.tick.kick();
    await h.at(s * 1_000);
  }
  for (let ms = 6_000; ms <= 5_000 + AUTOPILOT_KICK_QUIET_MS + 5_000; ms += 1_000) await h.at(ms);
  expect(h.judged()).toBe(2);
  expect(h.lines).toEqual(["AUTOPILOT_READY #1,#2,#3,#4,#5 slots=5"]);
});

test("a continuous kick stream every 5 s is judged at most once per AUTOPILOT_KICK_MAX_MS", async () => {
  const h = harness(report([]));
  await h.at(0);
  const stepMs = 5_000;
  for (let ms = stepMs; ms < 5_000 + 2 * AUTOPILOT_KICK_MAX_MS; ms += stepMs) {
    h.clock(ms);
    h.tick.kick();
    await h.at(ms);
  }
  // First kick at 5 s judges at 65 s; the window restarts with the kick at 70 s, so 130 s is not reached.
  expect(h.judged()).toBe(2);
  h.clock(130_000);
  h.tick.kick();
  await h.at(130_000);
  expect(h.judged()).toBe(3);
});

test("a shrinking set or a slots change wakes no one, a new id announces, and the reminder names the current set", async () => {
  const h = harness(report([launch(1), launch(2), launch(3)], 3));
  await h.at(0);
  h.set(report([launch(2), launch(3)], 2));
  await h.at(AUTOPILOT_TICK_MS);
  h.set(report([launch(3)], 1));
  await h.at(2 * AUTOPILOT_TICK_MS);
  expect(h.lines).toEqual(["AUTOPILOT_READY #1,#2,#3 slots=3"]);
  await h.at(AUTOPILOT_RENOTIFY_MS);
  expect(h.lines.at(-1)).toBe("AUTOPILOT_READY #3 slots=1 again");
  h.set(report([launch(3), launch(4)], 1));
  await h.at(AUTOPILOT_RENOTIFY_MS + AUTOPILOT_TICK_MS);
  expect(h.lines.at(-1)).toBe("AUTOPILOT_READY #3,#4 slots=1");
  expect(h.lines).toHaveLength(3);
});

test("localState: the first value never kicks, a change kicks, and a throwing localState is logged once", async () => {
  let key: string | Error = "a";
  const h = harness(report([]), AUTOPILOT_TICK_MS, async () => { if (key instanceof Error) throw key; return key; });
  await h.at(0);
  await h.at(AUTOPILOT_KICK_QUIET_MS + 1_000);
  expect(h.judged()).toBe(1);
  key = "b";
  await h.at(20_000);
  expect(h.judged()).toBe(1);
  await h.at(20_000 + AUTOPILOT_KICK_QUIET_MS);
  expect(h.judged()).toBe(2);
  key = new Error("boom");
  await h.at(40_000);
  await h.at(50_000);
  expect(h.logs).toEqual(["AUTOPILOT_LOCAL_STATE_ERROR boom"]);
  expect(h.judged()).toBe(2);
  await h.at(20_000 + AUTOPILOT_KICK_QUIET_MS + AUTOPILOT_TICK_MS);
  expect(h.judged()).toBe(3);
});

test("an unreadable toodo is logged once and keeps the announced set", async () => {
  const h = harness(report([launch(12), hold(13)]));
  await h.at(0);
  h.set(new Error("toodo-server list_tasks answered HTTP 401"));
  await h.at(AUTOPILOT_TICK_MS);
  await h.at(2 * AUTOPILOT_TICK_MS);
  expect(h.logs).toEqual(["AUTOPILOT_TICK_ERROR toodo-server list_tasks answered HTTP 401"]);
  h.set(report([launch(12), hold(13)]));
  await h.at(3 * AUTOPILOT_TICK_MS);
  expect(h.logs.at(-1)).toBe("AUTOPILOT_TICK_OK");
  expect(h.lines).toEqual(["AUTOPILOT_READY #12 slots=1"]);
});

test("a pause judges but wakes no one, and lifting the pause announces the set", async () => {
  const paused = harness(report([launch(12)], 1, true));
  await paused.at(0);
  await paused.at(AUTOPILOT_RENOTIFY_MS);
  expect([paused.judged(), paused.lines]).toEqual([2, []]);
  paused.set(report([launch(12)]));
  await paused.at(AUTOPILOT_RENOTIFY_MS + AUTOPILOT_TICK_MS);
  expect(paused.lines).toEqual(["AUTOPILOT_READY #12 slots=1"]);
});

test("the tick period is the configured tickMs", async () => {
  const h = harness(report([]), 60_000);
  await h.at(0);
  await h.at(59_999);
  expect(h.judged()).toBe(1);
  await h.at(60_000);
  expect(h.judged()).toBe(2);
});
