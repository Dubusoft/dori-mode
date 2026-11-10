import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTOPILOT_LANE, type CandidatesReport, SHADOW_ACTION, type Verdict } from "../src/autopilot.ts";
import { AUTOPILOT_KICK_MIN_MS, AUTOPILOT_RENOTIFY_MS, AUTOPILOT_TICK_MS, AutopilotTick } from "../src/autopilot-tick.ts";
import { JsonOperations } from "../src/operations.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

let dir: string;
let store: JsonOperations;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-autopilot-tick-"));
  store = new JsonOperations(dir);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const launch = (taskId: number): Verdict => ({ taskId, verdict: "LAUNCH", reasons: [] });
const hold = (taskId: number): Verdict => ({ taskId, verdict: "HOLD", reasons: ["no-slot"] });
const report = (verdicts: readonly Verdict[], slots: number | null = 1): CandidatesReport => ({ mode: "shadow", slots, verdicts });

/** A tick over a settable clock and report; `lines` are the journaled events, `judged` counts judgments. */
const harness = (initial: CandidatesReport | Error) => {
  let now = T0;
  let next: CandidatesReport | Error = initial;
  const lines: string[] = [];
  const logs: string[] = [];
  let judged = 0;
  const tick = new AutopilotTick({
    judge: async () => { judged++; if (next instanceof Error) throw next; return next; },
    store, enqueue: (_id, line) => { lines.push(line); }, now: () => now, log: (line) => { logs.push(line); },
  });
  return {
    tick, lines, logs, judged: () => judged,
    at: async (ms: number) => { now = T0 + ms; await tick.tick(); },
    set: (r: CandidatesReport | Error) => { next = r; },
  };
};

test("a LAUNCH set is announced once, a changed set again, and an unchanged set only after 30 minutes", async () => {
  const h = harness(report([launch(15), launch(12), hold(13)]));
  await h.at(0);
  expect(h.lines).toEqual(["AUTOPILOT_READY #12,#15 slots=1"]);
  await h.at(AUTOPILOT_TICK_MS);
  await h.at(2 * AUTOPILOT_TICK_MS);
  expect(h.lines).toHaveLength(1);
  h.set(report([launch(12), launch(15)], 2));
  await h.at(3 * AUTOPILOT_TICK_MS);
  expect(h.lines.at(-1)).toBe("AUTOPILOT_READY #12,#15 slots=2");
  const announced = 3 * AUTOPILOT_TICK_MS;
  for (let ms = announced + AUTOPILOT_TICK_MS; ms < announced + AUTOPILOT_RENOTIFY_MS; ms += AUTOPILOT_TICK_MS) await h.at(ms);
  expect(h.lines).toHaveLength(2);
  await h.at(announced + AUTOPILOT_RENOTIFY_MS);
  expect(h.lines.at(-1)).toBe("AUTOPILOT_READY #12,#15 slots=2 again");
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

test("a pass before the tick is due judges nothing; a kick brings it forward, at most once per AUTOPILOT_KICK_MIN_MS", async () => {
  const h = harness(report([]));
  await h.at(0);
  await h.at(60_000);
  expect(h.judged()).toBe(1);
  h.tick.kick();
  await h.at(60_000);
  expect(h.judged()).toBe(2);
  h.tick.kick();
  await h.at(60_000 + AUTOPILOT_KICK_MIN_MS - 1);
  expect(h.judged()).toBe(2);
  await h.at(60_000 + AUTOPILOT_KICK_MIN_MS);
  expect(h.judged()).toBe(3);
  await h.at(60_000 + AUTOPILOT_KICK_MIN_MS + 1_000);
  expect(h.judged()).toBe(3);
});

test("each tick writes the hour's shadow rows; an unreadable toodo is logged once and keeps the announced set", async () => {
  const h = harness(report([launch(12), hold(13)]));
  await h.at(0);
  const shadows = () => store.list({ lane: AUTOPILOT_LANE }).filter((op) => op.action === SHADOW_ACTION).map((op) => [op.target, op.detail]);
  expect(shadows()).toEqual([["12@2026-01-01T12:00:00.000Z", "LAUNCH"], ["13@2026-01-01T12:00:00.000Z", "HOLD no-slot"]]);
  h.set(new Error("toodo-server list_tasks answered HTTP 401"));
  await h.at(AUTOPILOT_TICK_MS);
  await h.at(2 * AUTOPILOT_TICK_MS);
  expect(h.logs).toEqual(["AUTOPILOT_TICK_ERROR toodo-server list_tasks answered HTTP 401"]);
  h.set(report([launch(12), hold(13)]));
  await h.at(3 * AUTOPILOT_TICK_MS);
  expect(h.logs.at(-1)).toBe("AUTOPILOT_TICK_OK");
  expect(h.lines).toEqual(["AUTOPILOT_READY #12 slots=1"]);
});
