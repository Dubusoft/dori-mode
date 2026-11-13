import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autopilotLocalStateKey, candidatesJson, DEFAULT_AUTOPILOT, formatCandidates, type JudgeContext, judge, judgeAll, ledgerRows, ledgerState,
  parseAutopilotConfig, reservedTaskOf, type ToodoTask,
} from "../src/autopilot.ts";
import { JsonOperations, type Operation, type OperationState } from "../src/operations.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const HOUR = 3_600_000;
const WS = 7;

let dir: string;
let store: JsonOperations;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-autopilot-"));
  store = new JsonOperations(dir);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** A planned task marked for autopilot with an owner ref and one criterion: it launches unless a case changes it. */
const task = (id: number, over: Partial<ToodoTask> = {}): ToodoTask => ({
  id, workspaceId: WS, title: `task ${id}`, description: `do ${id}`, status: "planned", resolution: null, dependsOn: [],
  refs: ["owner:discord:c/m"], criteria: [{ text: "tests pass", kind: "manual" }], wait: null, autopilot: true, dueDate: null, ...over,
});
const merged = (id: number, over: Partial<ToodoTask> = {}): ToodoTask => task(id, { status: "done", resolution: "merged", ...over });

const ctx = (tasks: readonly ToodoTask[], over: Partial<JudgeContext> = {}): JudgeContext => ({
  tasks: new Map(tasks.map((t) => [t.id, t])), ledger: [], openLanes: new Set(), quota: { readable: true, accounts: [{ name: "default", maxUsedPct: 10 }] },
  host: { ok: true }, config: DEFAULT_AUTOPILOT, ...over,
});

const attempt = (taskId: number, n: number, state: OperationState, laneKey = `lane-${taskId}-${n}`): Operation => ({
  id: `toodo:${taskId}/autopilot-launch/${n}`, lane: `toodo:${taskId}`, action: "autopilot-launch", target: String(n), state,
  detail: state, data: JSON.stringify({ laneKey }), attempts: 1, at: T0, updatedAt: T0,
});

const outcome = (c: JudgeContext, taskId: number) => {
  const v = judge({ ...c, taskId });
  return [v.verdict, v.reasons];
};

// Flag, owner ref, criteria

test("a marked planned task with an owner ref, a criterion and a merged or completed prerequisite launches", () => {
  const t = task(13, { dependsOn: [5] });
  expect(outcome(ctx([merged(5), t]), 13)).toEqual(["LAUNCH", []]);
  expect(outcome(ctx([merged(5, { resolution: "completed" }), t]), 13)).toEqual(["LAUNCH", []]);
});

test("a task not marked for autopilot refuses not-flagged", () => {
  expect(outcome(ctx([task(12, { autopilot: false })]), 12)).toEqual(["REFUSE", ["not-flagged"]]);
});

test("a marked task without an owner: ref refuses owner-ref-missing; other refs or a bare prefix do not count", () => {
  expect(outcome(ctx([task(12, { refs: [] })]), 12)).toEqual(["REFUSE", ["owner-ref-missing"]]);
  expect(outcome(ctx([task(12, { refs: ["discord:c/m", "lane:x", "owner:"] })]), 12)).toEqual(["REFUSE", ["owner-ref-missing"]]);
  expect(outcome(ctx([task(12, { refs: ["lane:x", "owner:discord:c/m"] })]), 12)).toEqual(["LAUNCH", []]);
});

test("a marked task without criteria refuses criteria-missing", () => {
  expect(outcome(ctx([task(12, { criteria: [] })]), 12)).toEqual(["REFUSE", ["criteria-missing"]]);
});

// Dependencies

test("an unfinished prerequisite refuses prerequisite-open, whatever its status", () => {
  for (const status of ["planned", "in_progress", "in_review"] as const) {
    expect(outcome(ctx([task(5, { status }), task(13, { dependsOn: [5] })]), 13)).toEqual(["REFUSE", ["prerequisite-open"]]);
  }
});

test("a missing prerequisite refuses prerequisite-missing; a not_adopted one prerequisite-not-adopted", () => {
  const t = task(13, { dependsOn: [5] });
  expect(outcome(ctx([t]), 13)).toEqual(["REFUSE", ["prerequisite-missing"]]);
  expect(outcome(ctx([t, merged(5, { resolution: "not_adopted" })]), 13)).toEqual(["REFUSE", ["prerequisite-not-adopted"]]);
});

test("a prerequisite in another workspace refuses cross-workspace-prerequisite", () => {
  expect(outcome(ctx([merged(5, { workspaceId: 8 }), task(13, { dependsOn: [5] })]), 13)).toEqual(["REFUSE", ["cross-workspace-prerequisite"]]);
});

test("a task in any workspace is judged: no workspace allow list", () => {
  expect(outcome(ctx([task(12, { workspaceId: 99 })]), 12)).toEqual(["LAUNCH", []]);
});

// Status, ledger, quota, host

test("a missing task refuses task-missing; a task neither planned nor waiting refuses not-planned", () => {
  expect(outcome(ctx([]), 12)).toEqual(["REFUSE", ["task-missing"]]);
  expect(outcome(ctx([task(12, { status: "in_review" })]), 12)).toEqual(["REFUSE", ["not-planned"]]);
});

test("a waiting task holds waiting; with a live lane ref also lane-live", () => {
  const wait = { until: T0 / 1000 + 3600, status: "in_progress" };
  expect(outcome(ctx([task(12, { wait })]), 12)).toEqual(["HOLD", ["waiting"]]);
  expect(outcome(ctx([task(12, { wait, refs: ["owner:discord:c/m", "lane:fix-12"] })], { openLanes: new Set(["fix-12"]) }), 12))
    .toEqual(["HOLD", ["waiting", "lane-live"]]);
});

test("any earlier attempt refuses already-attempted: no automatic retry", () => {
  for (const state of ["failed", "verified"] as const) {
    expect(outcome(ctx([task(12)], { ledger: [attempt(12, 1, state)] }), 12)).toEqual(["REFUSE", ["already-attempted"]]);
  }
});

test("a live attempt holds lane-live instead; an ambiguous row refuses ledger-ambiguous", () => {
  const live = [attempt(12, 1, "verified", "lane-12")];
  expect(outcome(ctx([task(12)], { ledger: live, openLanes: new Set(["lane-12"]) }), 12)).toEqual(["HOLD", ["lane-live"]]);
  expect(outcome(ctx([task(12)], { ledger: [attempt(12, 1, "attempted")] }), 12)).toEqual(["HOLD", ["lane-live"]]);
  expect(ledgerState(live, 12, new Set(["lane-12"]))).toEqual({ attempts: 1, ambiguous: false, live: true });
  expect(outcome(ctx([task(12)], { ledger: [attempt(12, 1, "ambiguous")] }), 12)).toEqual(["REFUSE", ["already-attempted", "ledger-ambiguous"]]);
});

test("another task's live lane never holds this one: no autopilot WIP cap", () => {
  const ledger = [attempt(40, 1, "attempted"), attempt(41, 1, "attempted")];
  expect(outcome(ctx([task(12)], { ledger }), 12)).toEqual(["LAUNCH", []]);
});

test("one account with room launches; every account spent holds quota-over-threshold; none readable holds quota-unreadable", () => {
  const spent = { name: "default", maxUsedPct: 100 };
  expect(outcome(ctx([task(12)], { quota: { readable: true, accounts: [spent, { name: "account-2", maxUsedPct: 99 }] } }), 12)).toEqual(["LAUNCH", []]);
  expect(outcome(ctx([task(12)], { quota: { readable: true, accounts: [spent, { name: "account-2", maxUsedPct: 100 }] } }), 12))
    .toEqual(["HOLD", ["quota-over-threshold"]]);
  expect(outcome(ctx([task(12)], { quota: { readable: false, skipped: ["default (token-expired)"] } }), 12)).toEqual(["HOLD", ["quota-unreadable"]]);
});

test("a host HOLD holds host-hold", () => {
  expect(outcome(ctx([task(12)], { host: { ok: false, reason: "load high" } }), 12)).toEqual(["HOLD", ["host-hold"]]);
});

test("every failing reason is collected, refusals first", () => {
  const t = task(12, { autopilot: false, refs: [], criteria: [], wait: { until: 1, status: "planned" }, dependsOn: [5] });
  expect(outcome(ctx([t, task(5)], { quota: { readable: false }, host: { ok: false } }), 12))
    .toEqual(["REFUSE", ["not-flagged", "owner-ref-missing", "criteria-missing", "prerequisite-open", "waiting", "quota-unreadable", "host-hold"]]);
});

// Slots

test("judgeAll keeps only host.slots LAUNCH verdicts, due date first then id; the rest hold no-slot", () => {
  const tasks = [task(12), task(13, { dueDate: "2026-02-01" }), task(14), task(15, { dueDate: "2026-01-15" }), task(16, { autopilot: false })];
  const judged = (slots?: number) =>
    judgeAll(ctx(tasks, { host: slots === undefined ? { ok: true } : { ok: true, slots } }), [16, 14, 15, 13, 12]).map((v) => [v.taskId, v.verdict, v.reasons]);
  expect(judged(2)).toEqual([
    [12, "HOLD", ["no-slot"]], [13, "LAUNCH", []], [14, "HOLD", ["no-slot"]], [15, "LAUNCH", []], [16, "REFUSE", ["not-flagged"]],
  ]);
  expect(judged(3).filter((v) => v[1] === "LAUNCH").map((v) => v[0])).toEqual([12, 13, 15]);
  expect(judged(0).filter((v) => v[1] === "LAUNCH")).toEqual([]);
  expect(judged(undefined).filter((v) => v[1] === "LAUNCH").map((v) => v[0])).toEqual([12, 13, 14, 15]);
});

test("a HOLD or REFUSE task takes no slot", () => {
  const tasks = [task(12, { criteria: [] }), task(13, { wait: { until: 1, status: "planned" } }), task(14)];
  expect(judgeAll(ctx(tasks, { host: { ok: true, slots: 1 } }), [12, 13, 14]).map((v) => [v.taskId, v.verdict]))
    .toEqual([[12, "REFUSE"], [13, "HOLD"], [14, "LAUNCH"]]);
});

// Rows and output

/** A judgment row an older dori wrote (shadow mode is gone); autopilot ignores it. */
const oldShadowRow = (taskId: number): Operation => ({
  id: `autopilot/autopilot-shadow/${taskId}@2026-01-01T12:00:00.000Z`, lane: "autopilot", action: "autopilot-shadow",
  target: `${taskId}@2026-01-01T12:00:00.000Z`, state: "verified", detail: "LAUNCH", attempts: 1, at: T0, updatedAt: T0,
});

test("ledgerRows reads only launch-attempt rows", () => {
  store.put(attempt(12, 1, "failed"));
  store.put(oldShadowRow(12));
  expect(ledgerRows(store).map((op) => op.id)).toEqual(["toodo:12/autopilot-launch/1"]);
});

test("reservedTaskOf names the task whose launch attempt reserved the lane key, and none for any other lane", () => {
  store.put(attempt(12, 1, "failed", "ap-12-1"));
  store.put(attempt(949, 1, "planned", "ap-949-1"));
  store.put(oldShadowRow(77));
  expect(reservedTaskOf(ledgerRows(store), "ap-949-1")).toBe(949);
  expect(reservedTaskOf(ledgerRows(store), "ap-12-1")).toBe(12);
  expect(reservedTaskOf(ledgerRows(store), "ap-949-2")).toBeUndefined();
  expect(reservedTaskOf(ledgerRows(store), "ops")).toBeUndefined();
});

test("autopilotLocalStateKey tracks open lanes and open launch rows, ignoring an older dori's shadow rows", () => {
  const empty = autopilotLocalStateKey(store, new Set());
  store.put(oldShadowRow(12));
  expect(autopilotLocalStateKey(store, new Set())).toBe(empty);
  store.put(attempt(12, 1, "planned"));
  const planned = autopilotLocalStateKey(store, new Set());
  expect(planned).not.toBe(empty);
  store.put(attempt(12, 1, "verified"));
  expect(autopilotLocalStateKey(store, new Set())).toBe(empty);
  expect(autopilotLocalStateKey(store, new Set(["lane-a"]))).not.toBe(empty);
});

test("formatCandidates prints the header and one line per verdict; none prints AUTOPILOT_NO_CANDIDATES", () => {
  const report = {
    paused: false, slots: 1,
    verdicts: [
      { taskId: 12, verdict: "LAUNCH" as const, reasons: [] },
      { taskId: 13, verdict: "HOLD" as const, reasons: ["no-slot" as const] },
      { taskId: 30, verdict: "REFUSE" as const, reasons: ["not-flagged" as const, "criteria-missing" as const] },
    ],
  };
  expect(formatCandidates(report)).toEqual([
    "AUTOPILOT slots=1 candidates=3",
    "AUTOPILOT_CANDIDATE #12 LAUNCH would-launch",
    "AUTOPILOT_CANDIDATE #13 HOLD no-slot",
    "AUTOPILOT_CANDIDATE #30 REFUSE not-flagged, criteria-missing",
  ]);
  expect(formatCandidates({ ...report, slots: null })[0]).toBe("AUTOPILOT slots=unlimited candidates=3");
  expect(formatCandidates({ ...report, verdicts: [] })).toEqual(["AUTOPILOT_NO_CANDIDATES"]);
  // Autopilot is always on: only a pause keeps it from launching.
  expect(formatCandidates({ ...report, paused: true })[0]).toBe("AUTOPILOT paused: nothing launches slots=1 candidates=3");
  expect(candidatesJson(report)).toEqual({
    paused: false, slots: 1,
    candidates: [
      { taskId: 12, verdict: "LAUNCH", reasons: [] },
      { taskId: 13, verdict: "HOLD", reasons: ["no-slot"] },
      { taskId: 30, verdict: "REFUSE", reasons: ["not-flagged", "criteria-missing"] },
    ],
  });
});

// Config

test("parseAutopilotConfig defaults every key", () => {
  expect(parseAutopilotConfig(undefined)).toEqual(DEFAULT_AUTOPILOT);
  expect(parseAutopilotConfig({})).toEqual(DEFAULT_AUTOPILOT);
  expect(parseAutopilotConfig({ mergeBase: "develop" })).toEqual({ ...DEFAULT_AUTOPILOT, mergeBase: "develop" });
  expect(DEFAULT_AUTOPILOT.tickSec).toBe(300);
  expect(parseAutopilotConfig({ tickSec: 30 }).tickSec).toBe(30);
  expect(parseAutopilotConfig({ tickSec: 3600 }).tickSec).toBe(3600);
});

test("parseAutopilotConfig ignores the removed bundle keys, quotaMaxUsedPct and mode (any value) with one warning", () => {
  const warnings: string[] = [];
  expect(parseAutopilotConfig({ workspaces: [7], wip: 5, attemptCap: 3, quotaMaxUsedPct: 90 }, (line) => warnings.push(line)))
    .toEqual(DEFAULT_AUTOPILOT);
  expect(warnings).toEqual(["autopilot.workspaces, autopilot.wip, autopilot.attemptCap, autopilot.quotaMaxUsedPct no longer apply and are ignored"]);
  for (const mode of ["off", "shadow", "on", "live", 7]) {
    const seen: string[] = [];
    expect(parseAutopilotConfig({ mode }, (line) => seen.push(line))).toEqual(DEFAULT_AUTOPILOT);
    expect(seen).toEqual(["autopilot.mode no longer apply and are ignored"]);
  }
});

test("parseAutopilotConfig throws TypeError naming the key on an invalid value or an unknown key", () => {
  const cases: [unknown, RegExp][] = [
    [[], /^autopilot must be an object/],
    [{ quotaUnreadable: "launch" }, /^autopilot\.quotaUnreadable /],
    [{ mergeBase: "" }, /^autopilot\.mergeBase /],
    [{ crossWorkspacePrereqs: "allow" }, /^autopilot\.crossWorkspacePrereqs /],
    [{ tickSec: 29 }, /^autopilot\.tickSec /],
    [{ tickSec: 3601 }, /^autopilot\.tickSec /],
    [{ tickSec: 60.5 }, /^autopilot\.tickSec /],
    [{ tickSec: "300" }, /^autopilot\.tickSec /],
    [{ wipcap: 2 }, /^autopilot\.wipcap is not a known key/],
  ];
  for (const [raw, message] of cases) {
    expect(() => parseAutopilotConfig(raw)).toThrow(TypeError);
    expect(() => parseAutopilotConfig(raw)).toThrow(message);
  }
});
