import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ledgerRows, ledgerState } from "../src/autopilot.ts";
import { closeLane } from "../src/done-flow.ts";
import { LAUNCH_ACTION, type Observed, openOperations, type OperationStore, OPERATIONS_FILE, perform, REARM_ACTION } from "../src/operations.ts";
import type { Lane } from "../src/registry.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { convertJsonStore } from "../src/store-import.ts";
import { depsFor, fakeClock, newWorld, withSqliteStore, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

// Every test opens a fresh state dir and a journal store (sqlite create/WAL, fsync'd writes, import/export file moves). On a
// CI runner shared with `bun test --parallel` workers that disk I/O can stall past 5 s; there is no event to wait on, so the
// budget only bounds a hang, it does not pace the test.
setDefaultTimeout(30_000);
const spec = { lane: "demo-lane", action: "pane-close", target: "w:p1" };

let state: ReturnType<typeof withState>;
let store: OperationStore;
let ran: number;
let world: Observed;
const now = () => T0;
const effect = async () => { ran++; world = "done"; return { ok: true, detail: "" }; };
const readBack = async () => world;

beforeEach(() => {
  state = withState();
  withSqliteStore(state.dir);
  store = openOperations({ stateDir: state.dir });
  ran = 0;
  world = "not-done";
});
afterEach(() => { store.close(); state.done(); });

test("a verified operation never runs its effect again", async () => {
  expect((await perform(store, now, spec, effect, readBack)).op.state).toBe("verified");
  world = "not-done";
  const again = await perform(store, now, spec, effect, readBack);
  expect({ state: again.op.state, ran: again.ran, effects: ran }).toEqual({ state: "verified", ran: false, effects: 1 });
});

test("operation retention removes only verified rows older than 30 days", () => {
  const dir = withState();
  new SqliteStore(join(dir.dir, SQLITE_FILE), { create: true }).close();
  const history = openOperations({ stateDir: dir.dir });
  try {
    const cutoff = T0 - 30 * 24 * 60 * 60_000;
    for (const state of ["verified", "planned", "attempted", "failed", "ambiguous"] as const) {
      history.put({ id: state, ...spec, state, detail: state, attempts: 1, at: cutoff - 1, updatedAt: cutoff - 1 });
    }
    history.put({ id: "recent", ...spec, state: "verified", detail: "", attempts: 1, at: cutoff, updatedAt: cutoff });
    history.prune(T0);
    expect(history.list().map((op) => op.id).sort()).toEqual(["ambiguous", "attempted", "failed", "planned", "recent"]);
    history.prune(T0);
    expect(history.get("recent")?.state).toBe("verified");
  } finally { history.close(); dir.done(); }
});

test("operation retention keeps the autopilot ledger, so an old launch still refuses a relaunch", () => {
  const dir = withState();
  new SqliteStore(join(dir.dir, SQLITE_FILE), { create: true }).close();
  const history = openOperations({ stateDir: dir.dir });
  try {
    const old = T0 - 31 * 24 * 60 * 60_000;
    const row = { lane: "toodo:7", state: "verified" as const, detail: "", attempts: 1, at: old, updatedAt: old };
    history.put({ id: "launch", ...row, action: LAUNCH_ACTION, target: "1", data: JSON.stringify({ laneKey: "ap-7-1" }) });
    history.put({ id: "rearm", ...row, lane: "toodo:8", action: REARM_ACTION, target: "1" });
    history.put({ id: "other", ...row, ...spec });
    history.prune(T0);
    expect(history.list().map((op) => op.id).sort()).toEqual(["launch", "rearm"]);
    const rows = ledgerRows(history);
    expect(ledgerState(rows, 7, new Set()).attempts).toBe(1);
    expect(ledgerState(rows, 8, new Set()).through).toBe(1);
  } finally { history.close(); dir.done(); }
});

test("an attempted row left by a crash is reconciled by read-back: done verifies, not done retries once, unknown is ambiguous", async () => {
  const attempted = { id: "demo-lane/pane-close/w:p1", ...spec, state: "attempted" as const, detail: "attempted", attempts: 1, at: T0, updatedAt: T0 };
  store.put(attempted);
  world = "done";
  expect(await perform(store, now, spec, effect, readBack)).toMatchObject({ op: { state: "verified", attempts: 1 }, ran: false });

  store.put(attempted);
  world = "not-done";
  expect(await perform(store, now, spec, effect, readBack)).toMatchObject({ op: { state: "verified", attempts: 2 }, ran: true });
  expect(ran).toBe(1);

  store.put(attempted);
  world = "unknown";
  expect(await perform(store, now, spec, effect, async () => "unknown")).toMatchObject({ op: { state: "ambiguous" }, ran: false });
  expect(await perform(store, now, spec, effect, async () => "done")).toMatchObject({ op: { state: "ambiguous" }, ran: false });
  expect(ran).toBe(1);
});

test("an effect that fails while the read-back shows it not done is failed, and a later call may retry it", async () => {
  const failing = async () => { ran++; return { ok: false, detail: "pane busy" }; };
  expect((await perform(store, now, spec, failing, readBack)).op).toMatchObject({ state: "failed", detail: "read back not-done: pane busy" });
  expect((await perform(store, now, spec, effect, readBack)).op.state).toBe("verified");
  expect(ran).toBe(2);
});

test("an unknown read-back is ambiguous whatever the effect reported, and is never retried", async () => {
  const cases: [string, () => Promise<{ ok: boolean; detail: string }>][] = [
    ["throws", async () => { ran++; throw new Error("boom"); }],
    ["fails", async () => { ran++; return { ok: false, detail: "refused" }; }],
    ["succeeds", async () => { ran++; return { ok: true, detail: "" }; }],
  ];
  for (const [i, [what, fx]] of cases.entries()) {
    const s = { ...spec, target: `t${i}` };
    const first = await perform(store, now, s, fx, async () => "unknown");
    expect({ what, state: first.op.state, ran: first.ran }).toEqual({ what, state: "ambiguous", ran: true });
    expect(first.op.detail).toContain("read-back cannot tell");
    expect((await perform(store, now, s, fx, async () => "not-done")).ran).toBe(false);
  }
  expect(ran).toBe(3);
});

test("an effect that throws after a side effect with an unknown read-back runs once and stays ambiguous", async () => {
  let counter = 0;
  const throwing = async () => { counter++; throw new Error("died after the side effect"); };
  const unknown = async (): Promise<Observed> => "unknown";
  const first = await perform(store, now, spec, throwing, unknown);
  const second = await perform(store, now, spec, throwing, unknown);
  expect({ first: first.op.state, second: second.op.state, ran: second.ran, counter }).toEqual({ first: "ambiguous", second: "ambiguous", ran: false, counter: 1 });
  expect(second.op.detail).toContain("effect threw");
});

test("a read-back proving absence after a throwing effect is failed and may retry", async () => {
  const throwing = async () => { ran++; throw new Error("boom"); };
  expect((await perform(store, now, spec, throwing, readBack)).op.state).toBe("failed");
  expect((await perform(store, now, spec, effect, readBack)).op.state).toBe("verified");
  expect(ran).toBe(2);
});

test("operations survive the json conversion with their states", async () => {
  await perform(store, now, spec, effect, readBack);
  await perform(store, now, { ...spec, action: "pane-close", target: "w:p2" }, effect, async () => "unknown");
  const before = store.list();
  // Given the operations.json a json store kept with these rows.
  const legacy = withState();
  try {
    writeFileSync(join(legacy.dir, OPERATIONS_FILE), JSON.stringify({ ops: Object.fromEntries(before.map((op) => [op.id, op])) }));
    expect(convertJsonStore(legacy.dir, T0, () => () => {})).toBe(true);
    expect(existsSync(join(legacy.dir, OPERATIONS_FILE))).toBe(false);
    const converted = openOperations({ stateDir: legacy.dir });
    try { expect(converted.list()).toEqual(before); } finally { converted.close(); }
  } finally { legacy.done(); }
});

test("a close records its effects and a second close of the same lane repeats none of them", async () => {
  const w: World = newWorld();
  w.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  const deps = depsFor(w, fakeClock(T0), state.dir);
  const lane: Lane = { key: "demo-lane", title: "demo", thread: "discord:111/222", pane: "w:p1", brief: "/b.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0).toISOString() };
  await deps.registry.write(lane);
  const first = await closeLane(deps, lane, "manual");
  expect(first.closed).toBe(true);
  // The pane close (lane.close) through the lane's runner; the worktree is only queued for the watcher.
  const effects = () => w.ops.filter((e) => e.op === "git" || e.op === "close").length;
  expect(effects()).toBe(1);
  expect(store.list().map((op) => `${op.action} ${op.state}`).sort()).toEqual(["close verified", "pane-close verified"]);
  const second = await closeLane(deps, lane, "manual");
  expect(second).toEqual({ closed: true, lines: ["CLOSED demo-lane already closed"] });
  expect(effects()).toBe(1);
});

