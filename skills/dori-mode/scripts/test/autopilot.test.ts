import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Bundle, buildBundle, bundleOpId, candidatesJson, DEFAULT_AUTOPILOT, formatCandidates, type JudgeContext, judge, judgeAll,
  ledgerRows, ledgerState, listBundles, memberHash, parseAutopilotConfig, recordShadow, revokeBundle, saveBundle, type ToodoTask,
  wipInUse,
} from "../src/autopilot.ts";
import { JsonOperations, type Operation, type OperationState } from "../src/operations.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WS = 7;

let dir: string;
let store: JsonOperations;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-autopilot-"));
  store = new JsonOperations(dir);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const task = (id: number, over: Partial<ToodoTask> = {}): ToodoTask => ({
  id, workspaceId: WS, title: `task ${id}`, description: `do ${id}`, status: "planned", resolution: null, dependsOn: [], refs: [],
  criteria: [{ text: "tests pass", kind: "manual" }], wait: null, ...over,
});
const merged = (id: number, over: Partial<ToodoTask> = {}): ToodoTask => task(id, { status: "done", resolution: "merged", ...over });

const approve = (tasks: readonly ToodoTask[], over: Partial<Parameters<typeof buildBundle>[0]> = {}): Bundle =>
  buildBundle({ bundleId: "b1", ownerRef: "discord:c/m", now: T0, tasks, expiresDays: 7, attemptBudget: 2, ...over });

const ctx = (tasks: readonly ToodoTask[] | null, bundles: readonly Bundle[], over: Partial<JudgeContext> = {}): JudgeContext => ({
  tasks: tasks === null ? null : new Map(tasks.map((t) => [t.id, t])),
  bundles, ledger: [], openLanes: new Set(), quota: { readable: true, maxUsedPct: 10 }, host: { ok: true },
  config: { ...DEFAULT_AUTOPILOT, workspaces: [WS] }, now: T0 + HOUR, ...over,
});

const attempt = (taskId: number, n: number, state: OperationState, laneKey = `lane-${taskId}-${n}`): Operation => ({
  id: `toodo:${taskId}/autopilot-launch/${n}`, lane: `toodo:${taskId}`, action: "autopilot-launch", target: String(n), state,
  detail: state, data: JSON.stringify({ bundleId: "b1", bundleVersion: T0, laneKey }), attempts: 1, at: T0, updatedAt: T0,
});

const outcome = (c: JudgeContext, taskId: number) => {
  const v = judge({ ...c, taskId });
  return [v.verdict, v.reasons];
};

// Required cases (spec 5, 1-8)

test("1. a waiting planned task holds: waiting", () => {
  const t = task(12, { wait: { until: T0 / 1000 + 3600, status: "planned" } });
  expect(outcome(ctx([t], [approve([t])]), 12)).toEqual(["HOLD", ["waiting"]]);
});

test("2. an in-progress task put on wait with a live lane ref holds: waiting, lane-live", () => {
  const t = task(12, { status: "planned", wait: { until: T0 / 1000 + 3600, status: "in_progress" }, refs: ["lane:fix-12"] });
  expect(outcome(ctx([t], [approve([t])], { openLanes: new Set(["fix-12"]) }), 12)).toEqual(["HOLD", ["waiting", "lane-live"]]);
});

test("3. an archived prerequisite refuses prerequisite-missing; a present not_adopted one refuses prerequisite-not-adopted", () => {
  const dep = merged(5);
  const t = task(13, { dependsOn: [5] });
  const b = approve([t]);
  expect(outcome(ctx([t], [b]), 13)).toEqual(["REFUSE", ["prerequisite-missing"]]);
  expect(outcome(ctx([t, { ...dep, resolution: "not_adopted" }], [b]), 13)).toEqual(["REFUSE", ["prerequisite-not-adopted"]]);
});

test("4. a bulk-deleted candidate refuses task-missing", () => {
  const b = approve([task(12)]);
  expect(outcome(ctx([], [b]), 12)).toEqual(["REFUSE", ["task-missing"]]);
});

test("5. a title edit after approval refuses hash-changed", () => {
  const b = approve([task(12)]);
  expect(outcome(ctx([task(12, { title: "edited" })], [b]), 12)).toEqual(["REFUSE", ["hash-changed"]]);
});

test("6. a revoked bundle refuses bundle-revoked; a revoked member refuses member-revoked while the other member launches", () => {
  saveBundle(store, T0, approve([task(12)]));
  const row = revokeBundle(store, T0 + 1, "b1", undefined, "owner said stop");
  expect(row?.state).toBe("verified");
  expect(row?.detail).toBe("revoked owner said stop");
  expect(outcome(ctx([task(12)], listBundles(store)), 12)).toEqual(["REFUSE", ["bundle-revoked"]]);

  saveBundle(store, T0, approve([task(20), task(21)], { bundleId: "b2" }));
  const member = revokeBundle(store, T0 + 2, "b2", 21);
  expect(member?.state).toBe("planned");
  expect(member?.detail).toBe("member 21 revoked by owner");
  const verdicts = judgeAll(ctx([task(12), task(20), task(21)], listBundles(store)));
  expect(verdicts.map((v) => [v.taskId, v.bundleId, v.verdict, v.reasons])).toEqual([
    [20, "b2", "LAUNCH", []],
    [21, "b2", "REFUSE", ["member-revoked"]],
  ]);
});

test("7. a task created ready without dependency and in no bundle refuses not-a-bundle-member", () => {
  const v = judge({ ...ctx([task(12), task(30)], [approve([task(12)])]), taskId: 30 });
  expect([v.verdict, v.bundleId, v.reasons]).toEqual(["REFUSE", null, ["not-a-bundle-member"]]);
});

test("8. a dependency removed after approval refuses hash-changed", () => {
  const b = approve([task(13, { dependsOn: [5] })]);
  expect(outcome(ctx([merged(5), task(13)], [b]), 13)).toEqual(["REFUSE", ["hash-changed"]]);
});

// Extra cases

test("the all-clear member with a merged prerequisite launches", () => {
  const t = task(13, { dependsOn: [5] });
  expect(outcome(ctx([merged(5), t], [approve([t])]), 13)).toEqual(["LAUNCH", []]);
  expect(outcome(ctx([merged(5, { resolution: "completed" }), t], [approve([t])]), 13)).toEqual(["LAUNCH", []]);
});

test("an open prerequisite holds prerequisite-open; a dependency added after approval also changes the hash", () => {
  const t = task(13, { dependsOn: [5] });
  expect(outcome(ctx([task(5, { status: "in_progress" }), t], [approve([t])]), 13)).toEqual(["HOLD", ["prerequisite-open"]]);
  const b = approve([task(13)]);
  expect(outcome(ctx([task(5), t], [b]), 13)).toEqual(["REFUSE", ["hash-changed", "prerequisite-open"]]);
});

test("a bundle refuses bundle-expired from expiresAt on", () => {
  const b = approve([task(12)]);
  expect(outcome(ctx([task(12)], [b], { now: T0 + 7 * DAY - 1 }), 12)).toEqual(["LAUNCH", []]);
  expect(outcome(ctx([task(12)], [b], { now: T0 + 7 * DAY }), 12)).toEqual(["REFUSE", ["bundle-expired"]]);
});

test("attempts at min(attemptCap, attemptBudget) refuse attempt-cap", () => {
  const ledger = [attempt(12, 1, "failed"), attempt(12, 2, "failed")];
  expect(outcome(ctx([task(12)], [approve([task(12)])], { ledger }), 12)).toEqual(["REFUSE", ["attempt-cap"]]);
  const one = [attempt(12, 1, "failed")];
  expect(outcome(ctx([task(12)], [approve([task(12)])], { ledger: one }), 12)).toEqual(["LAUNCH", []]);
  expect(outcome(ctx([task(12)], [approve([task(12)], { attemptBudget: 1 })], { ledger: one }), 12)).toEqual(["REFUSE", ["attempt-cap"]]);
});

test("an ambiguous ledger row refuses ledger-ambiguous", () => {
  const ledger = [attempt(12, 1, "ambiguous")];
  expect(outcome(ctx([task(12)], [approve([task(12)])], { ledger }), 12)).toEqual(["REFUSE", ["ledger-ambiguous"]]);
});

test("WIP in use at the limit holds wip-full; a verified row counts only while its lane is open", () => {
  const b = approve([task(12), task(40)]);
  const open = [attempt(40, 1, "attempted")];
  expect(outcome(ctx([task(12), task(40)], [b], { ledger: open }), 12)).toEqual(["HOLD", ["wip-full"]]);
  const done = [attempt(40, 1, "verified", "lane-40")];
  expect(outcome(ctx([task(12), task(40)], [b], { ledger: done }), 12)).toEqual(["LAUNCH", []]);
  expect(outcome(ctx([task(12), task(40)], [b], { ledger: done, openLanes: new Set(["lane-40"]) }), 12)).toEqual(["HOLD", ["wip-full"]]);
  const wide = { ...DEFAULT_AUTOPILOT, workspaces: [WS], wip: 2 };
  expect(outcome(ctx([task(12), task(40)], [b], { ledger: open, config: wide }), 12)).toEqual(["LAUNCH", []]);
});

test("the task's own live row holds lane-live and fills WIP", () => {
  const ledger = [attempt(12, 1, "verified", "lane-12")];
  const c = ctx([task(12)], [approve([task(12)])], { ledger, openLanes: new Set(["lane-12"]) });
  expect(outcome(c, 12)).toEqual(["HOLD", ["lane-live", "wip-full"]]);
  expect(ledgerState(ledger, 12, new Set(["lane-12"]))).toEqual({ attempts: 1, ambiguous: false, live: true });
  expect(wipInUse(ledger, new Set())).toBe(0);
});

test("unreadable quota holds quota-unreadable; a window at the threshold holds quota-over-threshold", () => {
  const b = approve([task(12)]);
  expect(outcome(ctx([task(12)], [b], { quota: { readable: false } }), 12)).toEqual(["HOLD", ["quota-unreadable"]]);
  expect(outcome(ctx([task(12)], [b], { quota: { readable: true, maxUsedPct: 80 } }), 12)).toEqual(["HOLD", ["quota-over-threshold"]]);
  expect(outcome(ctx([task(12)], [b], { quota: { readable: true, maxUsedPct: 79.9 } }), 12)).toEqual(["LAUNCH", []]);
});

test("a host HOLD holds host-hold", () => {
  expect(outcome(ctx([task(12)], [approve([task(12)])], { host: { ok: false, reason: "load high" } }), 12)).toEqual(["HOLD", ["host-hold"]]);
});

test("a prerequisite in another workspace refuses cross-workspace-prerequisite", () => {
  const t = task(13, { dependsOn: [5] });
  expect(outcome(ctx([merged(5, { workspaceId: 8 }), t], [approve([t])]), 13)).toEqual(["REFUSE", ["cross-workspace-prerequisite"]]);
});

test("empty config workspaces refuse workspace-not-allowed", () => {
  const c = ctx([task(12)], [approve([task(12)])], { config: DEFAULT_AUTOPILOT });
  expect(outcome(c, 12)).toEqual(["REFUSE", ["workspace-not-allowed"]]);
});

test("unreadable toodo holds every member with toodo-unreadable alone", () => {
  const b = approve([task(12), task(13)]);
  const verdicts = judgeAll(ctx(null, [b], { quota: { readable: false }, host: { ok: false } }));
  expect(verdicts.map((v) => [v.taskId, v.verdict, v.reasons])).toEqual([[12, "HOLD", ["toodo-unreadable"]], [13, "HOLD", ["toodo-unreadable"]]]);
});

test("a task not planned and not waiting refuses not-planned", () => {
  const b = approve([task(12)]);
  expect(outcome(ctx([task(12, { status: "in_review" })], [b]), 12)).toEqual(["REFUSE", ["not-planned"]]);
});

test("every failing reason is collected, refusals first", () => {
  const b = approve([task(12)]);
  const t = task(12, { title: "edited", wait: { until: 1, status: "planned" } });
  expect(outcome(ctx([t], [b], { quota: { readable: false }, host: { ok: false } }), 12))
    .toEqual(["REFUSE", ["hash-changed", "waiting", "quota-unreadable", "host-hold"]]);
});

test("judgeAll skips expired and revoked bundles and takes extra ready ids", () => {
  const expired = approve([task(12)], { bundleId: "old", now: T0 - 8 * DAY });
  const verdicts = judgeAll(ctx([task(12), task(30)], [expired, approve([task(13)])]), [30]);
  expect(verdicts.map((v) => [v.taskId, v.verdict, v.reasons])).toEqual([[13, "REFUSE", ["task-missing"]], [30, "REFUSE", ["not-a-bundle-member"]]]);
  // A task in an expired bundle and an in-force one is judged under the in-force one.
  expect(judge({ ...ctx([task(12)], [expired, approve([task(12)], { bundleId: "new" })]), taskId: 12 }).bundleId).toBe("new");
});

// Member hash

test("memberHash ignores key order, dependency order, criterion check state, refs and status", () => {
  const base = task(12, { dependsOn: [3, 1, 2] });
  const reordered = {
    wait: null, refs: ["lane:x"], criteria: [{ kind: "manual", text: "tests pass", checked: true }], dependsOn: [2, 3, 1],
    status: "in_progress", resolution: null, description: "do 12", title: "task 12", workspaceId: WS, id: 12,
  } as unknown as ToodoTask;
  expect(memberHash(reordered)).toBe(memberHash(base));
  expect(memberHash(task(12, { criteria: [{ text: "a", kind: "url", target: undefined }] })))
    .toBe(memberHash(task(12, { criteria: [{ text: "a", kind: "url" }] })));
  expect(memberHash(base)).toMatch(/^[0-9a-f]{64}$/);
  expect(memberHash(task(12, { description: "other" }))).not.toBe(memberHash(task(12)));
  expect(memberHash(task(12, { criteria: [{ text: "a", kind: "url", target: "http://x" }] })))
    .not.toBe(memberHash(task(12, { criteria: [{ text: "a", kind: "url" }] })));
});

// Bundle rows

test("saveBundle stores one planned row that listBundles reads back; re-approving replaces it", () => {
  const b = approve([task(12, { dependsOn: [9, 4] })]);
  const row = saveBundle(store, T0, b);
  expect([row.id, row.state, row.detail]).toEqual([bundleOpId("b1"), "planned", "approved 1 task(s) by discord:c/m"]);
  expect(listBundles(store)).toEqual([b]);
  expect(b.members["12"]?.dependsOn).toEqual([4, 9]);
  expect(b.expiresAt).toBe(T0 + 7 * DAY);
  revokeBundle(store, T0 + 1, "b1");
  const again = approve([task(12), task(13)], { now: T0 + 2 });
  expect(saveBundle(store, T0 + 2, again).state).toBe("planned");
  expect(listBundles(store)).toEqual([again]);
});

test("revokeBundle returns undefined for an unknown bundle or member", () => {
  saveBundle(store, T0, approve([task(12)]));
  expect(revokeBundle(store, T0, "nope")).toBeUndefined();
  expect(revokeBundle(store, T0, "b1", 99)).toBeUndefined();
});

test("buildBundle rejects a bad id, an empty task list and a bad budget", () => {
  expect(() => approve([task(12)], { bundleId: "B 1" })).toThrow(TypeError);
  expect(() => approve([])).toThrow(TypeError);
  expect(() => approve([task(12)], { attemptBudget: 0 })).toThrow(TypeError);
});

test("ledgerRows reads only launch-attempt rows", () => {
  store.put(attempt(12, 1, "failed"));
  saveBundle(store, T0, approve([task(12)]));
  expect(ledgerRows(store).map((op) => op.id)).toEqual(["toodo:12/autopilot-launch/1"]);
});

// Shadow rows and output

test("recordShadow writes one verified row per task per hour", () => {
  const now = T0 + 25 * 60_000;
  const first = recordShadow(store, now, [{ taskId: 12, bundleId: "b1", verdict: "HOLD", reasons: ["waiting", "prerequisite-open"] }]);
  expect(first.map((op) => [op.id, op.state, op.detail])).toEqual([["autopilot/autopilot-shadow/12@2026-01-01T12:00:00.000Z", "verified", "HOLD waiting, prerequisite-open"]]);
  recordShadow(store, now + 10 * 60_000, [{ taskId: 12, bundleId: "b1", verdict: "LAUNCH", reasons: [] }]);
  recordShadow(store, T0 + HOUR, [{ taskId: 12, bundleId: "b1", verdict: "LAUNCH", reasons: [] }]);
  expect(store.list({ lane: "autopilot" }).map((op) => [op.target, op.detail])).toEqual([
    ["12@2026-01-01T12:00:00.000Z", "HOLD waiting, prerequisite-open"],
    ["12@2026-01-01T13:00:00.000Z", "LAUNCH"],
  ]);
});

test("formatCandidates prints the header and one line per verdict; none prints AUTOPILOT_NO_BUNDLES", () => {
  const report = {
    mode: "shadow" as const, wip: { inUse: 0, limit: 1 }, bundles: 1,
    verdicts: [
      { taskId: 12, bundleId: "b1", verdict: "LAUNCH" as const, reasons: [] },
      { taskId: 13, bundleId: "b1", verdict: "HOLD" as const, reasons: ["waiting" as const, "prerequisite-open" as const] },
      { taskId: 30, bundleId: null, verdict: "REFUSE" as const, reasons: ["not-a-bundle-member" as const] },
    ],
  };
  expect(formatCandidates(report)).toEqual([
    "AUTOPILOT mode=shadow record-only: nothing launches wip=0/1 bundles=1",
    "AUTOPILOT_CANDIDATE #12 LAUNCH bundle=b1 would-launch",
    "AUTOPILOT_CANDIDATE #13 HOLD bundle=b1 waiting, prerequisite-open",
    "AUTOPILOT_CANDIDATE #30 REFUSE bundle=- not-a-bundle-member",
  ]);
  expect(formatCandidates({ ...report, bundles: 0, verdicts: [] })).toEqual(["AUTOPILOT_NO_BUNDLES"]);
  expect(candidatesJson(report).candidates[1]).toEqual({ taskId: 13, bundleId: "b1", verdict: "HOLD", reasons: ["waiting", "prerequisite-open"] });
});

// Config

test("parseAutopilotConfig defaults every key and clamps wip to wipCap with a warning", () => {
  expect(parseAutopilotConfig(undefined)).toEqual(DEFAULT_AUTOPILOT);
  expect(parseAutopilotConfig({})).toEqual(DEFAULT_AUTOPILOT);
  expect(DEFAULT_AUTOPILOT.workspaces).toEqual([]);
  const warnings: string[] = [];
  const c = parseAutopilotConfig({ workspaces: [7, 7, 3], wip: 5, attemptCap: 3, quotaMaxUsedPct: 90 }, (line) => warnings.push(line));
  expect([c.workspaces, c.wip, c.wipCap, c.attemptCap, c.quotaMaxUsedPct]).toEqual([[7, 3], 2, 2, 3, 90]);
  expect(warnings).toEqual(["autopilot.wip 5 is above autopilot.wipCap 2; using 2"]);
});

test("parseAutopilotConfig throws TypeError naming the key on an invalid value", () => {
  const cases: [unknown, RegExp][] = [
    [[], /^autopilot must be an object/],
    [{ wip: 0 }, /^autopilot\.wip /],
    [{ wipCap: 1.5 }, /^autopilot\.wipCap /],
    [{ workspaces: ["7"] }, /^autopilot\.workspaces /],
    [{ bundleExpiryDays: -1 }, /^autopilot\.bundleExpiryDays /],
    [{ attemptCap: "2" }, /^autopilot\.attemptCap /],
    [{ quotaMaxUsedPct: 101 }, /^autopilot\.quotaMaxUsedPct /],
    [{ quotaUnreadable: "launch" }, /^autopilot\.quotaUnreadable /],
    [{ mergeBase: "" }, /^autopilot\.mergeBase /],
    [{ onRevoke: "stop-all" }, /^autopilot\.onRevoke /],
    [{ crossWorkspacePrereqs: "allow" }, /^autopilot\.crossWorkspacePrereqs /],
    [{ mode: "live" }, /^autopilot\.mode /],
    [{ wipcap: 2 }, /^autopilot\.wipcap is not a known key/],
  ];
  for (const [raw, message] of cases) {
    expect(() => parseAutopilotConfig(raw)).toThrow(TypeError);
    expect(() => parseAutopilotConfig(raw)).toThrow(message);
  }
});
