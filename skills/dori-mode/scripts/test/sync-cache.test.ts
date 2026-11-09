import { afterEach, beforeEach, expect, test } from "bun:test";

import type { LaneOps } from "../src/lane-ops.ts";
import type { Runner } from "../src/run.ts";
import { resolveSession } from "../src/session-id.ts";
import { syncRegistry } from "../src/sync.ts";
import { depsFor, fakeClock, fakeLaneOps, newWorld, withSqliteStore, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const A = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
const B = "01a22550-ee81-7f90-b2ed-dcc7d51a0adf";
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => { state = withState(); withSqliteStore(state.dir); world = newWorld(); });
afterEach(() => state.done());

const ok = (out: string) => ({ code: 0, out, err: "" });

const syncDeps = (paneIds: readonly string[], inspect?: LaneOps["inspect"]) => {
  const base = depsFor(world, fakeClock(T0), state.dir, { sessionsDir: "/sessions", workspaces: ["w"] });
  world.panes = paneIds.map((pane_id) => ({ pane_id, workspace_id: "w", agent: "pi", cwd: "/repo", title: pane_id }));
  const ops = fakeLaneOps(world);
  return { ...base, ops: inspect ? { ...ops, inspect } : ops };
};
const addLane = (deps: ReturnType<typeof syncDeps>, key: string, pane: string, extra: object = {}) =>
  deps.registry.write({ key, title: key, thread: "none", pane, brief: "/b.md", cwd: "/repo", done: "closed acme/app#1", openedAt: new Date(T0).toISOString(), ...extra });
const inspections = (): string[] => world.ops.filter((e) => e.op === "inspect").map((e) => e.key ?? "");

test("sync lists panes through the facade and never reaches a session for an unregistered pane", async () => {
  const deps = syncDeps(["w:p1", "w:p2"]);
  const result = await syncRegistry(deps, false);
  expect(result.unregistered.map((r) => r.pane)).toEqual(["w:p1", "w:p2"]);
  expect(world.ops.filter((e) => e.op === "panes")).toHaveLength(1);
  expect(inspections()).toEqual([]);
  expect(world.calls).toEqual([]);
});

test("a registered lane's session id comes from ops.inspect with session and sessionsDir, and --write stores it", async () => {
  const wants: unknown[] = [];
  const deps = syncDeps(["w:p1", "w:p2"], async (_lane, want) => {
    wants.push(want);
    return { status: "working", cwd: "/repo", cwdExists: true, session: { id: A, via: "start-time" } };
  });
  await addLane(deps, "lane", "w:p1");
  const first = await syncRegistry(deps, true);
  expect(first.rows[0]?.session).toBe(`${A} (start-time)`);
  expect(first.unregistered.map((r) => r.pane)).toEqual(["w:p2"]);
  expect(wants).toEqual([{ session: true, sessionsDir: "/sessions" }]);
  expect((await deps.registry.read("lane"))?.session).toBe(A);
});

test("a session that differs from the registry is drift; an inspection that fails is drift and keeps the registry's session", async () => {
  const deps = syncDeps(["w:p1", "w:p2"], async (lane) => {
    if (lane.key === "bad") throw new Error("RUNNER_UNAVAILABLE runner=local timeout");
    return { status: "working", cwd: "/repo", cwdExists: true, session: { id: B, via: "child-env" } };
  });
  await addLane(deps, "moved", "w:p1", { session: A });
  await addLane(deps, "bad", "w:p2", { session: A });
  const result = await syncRegistry(deps, false);
  expect(result.drift).toContain(`moved: pane now runs session ${B} (registry has ${A})`);
  expect(result.drift.some((d) => d.startsWith("bad: session lookup failed"))).toBe(true);
  expect(result.rows.find((r) => r.key === "bad")?.session).toBe(A);
});

test("a remote lane's inventory comes from its machine's runner, once per machine; a lookup failure is drift", async () => {
  const deps = syncDeps(["w:p1"]);
  const ops: LaneOps = { ...deps.ops, panes: async (machine) => {
    world.ops.push({ op: "panes", args: { machine } });
    if (machine === "gone") throw new Error("RUNNER_UNAVAILABLE runner=gone disconnected");
    return machine ? [{ pane_id: "r:p1", workspace_id: "r", agent: "pi" }] : world.panes;
  } };
  const d = { ...deps, ops };
  await addLane(d, "r1", "r:p1", { machine: "box" });
  await addLane(d, "r2", "r:p1", { machine: "box" });
  await addLane(d, "r3", "x:p1", { machine: "gone" });
  const result = await syncRegistry(d, false);
  expect(world.ops.filter((e) => e.op === "panes").map((e) => (e.args as { machine?: string }).machine).sort()).toEqual(["box", "gone", undefined]);
  expect(result.drift.some((x) => x.startsWith("r3: machine gone lookup failed"))).toBe(true);
  expect(result.drift.some((x) => x.startsWith("r1:") || x.startsWith("r2:"))).toBe(false);
});

test("sync inspects lanes concurrently but never more than four at once, keeping the registry's row order", async () => {
  const paneIds = ["w:p1", "w:p2", "w:p3", "w:p4", "w:p5", "w:p6"];
  let inFlight = 0;
  let started = 0;
  let peak = 0;
  let waiting: (() => void)[] = [];
  const gate: LaneOps["inspect"] = async () => {
    inFlight++;
    started++;
    peak = Math.max(peak, inFlight);
    // Hold each call until the cap is reached (or nothing more can start), so overlap is forced, not timed.
    const held = new Promise<void>((resolve) => waiting.push(resolve));
    if (inFlight === 4 || started === paneIds.length) { const release = waiting; waiting = []; for (const r of release) r(); }
    await held;
    inFlight--;
    return { status: "working", cwd: "/repo", cwdExists: true, session: { id: "", via: "none" } };
  };
  const deps = syncDeps(paneIds, gate);
  for (const [i, p] of paneIds.entries()) await addLane(deps, `lane-${i}`, p);
  const result = await syncRegistry(deps, false);
  expect(peak).toBe(4);
  expect(result.rows.map((r) => r.pane)).toEqual((await deps.registry.open()).map((l) => l.pane ?? "-"));
  expect(result.rows).toHaveLength(paneIds.length);
});

test("one batched ps eww attributes the session to the first child in tree order", async () => {
  const table = [{ pid: 11, ppid: 10, cmd: "omo" }, { pid: 13, ppid: 11, cmd: "bun b" }, { pid: 14, ppid: 11, cmd: "bun c" }];
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "herdr") return ok(JSON.stringify({ result: { process_info: { shell_pid: 10 } } }));
    return { code: 1, out: `14 bun c PI_SESSION_ID=${B}\n13 bun b PI_SESSION_ID=${A}\n`, err: "" };
  };
  expect(await resolveSession("w:p1", "/repo", table, { run, sessionsDir: "/s" })).toEqual({ id: A, via: "child-env", pid: 11 });
  expect(calls.filter((argv) => argv[0] === "ps")).toEqual([["ps", "eww", "-o", "pid=,command=", "-p", "13,14"]]);
});
