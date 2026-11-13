import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { eventClass } from "../src/event-policy.ts";
import { freshnessTick } from "../src/freshness.ts";
import { acquireSlot, releaseSlot } from "../src/heavy-slot.ts";
import { guardTick } from "../src/host-guard.ts";
import { adoptLane, launchLane, LaunchError } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { resolveSession } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const working: Lane = { key: "quiet-lane", title: "quiet", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };

test("a lane silent past the nudge time is nudged once, and a [REPORT] line on its screen is never posted for it", async () => {
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screen = "noise\n[REPORT] quiet-lane | milestone | tests green on /home/test/repo, PR open\n❯ ";
  expect(await freshnessTick(deps(T0 + 10 * MIN))).toEqual([]);
  expect((await freshnessTick(deps(T0 + 16 * MIN))).map((a) => a.kind)).toEqual(["nudged"]);
  expect((await freshnessTick(deps(T0 + 17 * MIN))).map((a) => a.kind)).toEqual([]);
  expect(await freshnessTick(deps(T0 + 21 * MIN))).toEqual([]);
  expect(await freshnessTick(deps(T0 + 26 * MIN))).toEqual([]);
  expect(world.calls.find((c) => c[0] === "notify")).toBeUndefined();
  expect(sent(world)).toHaveLength(1);
});

test("a stopped agent pane is reported once per hour and the lead pane is never reported", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }, { pane_id: "lead:p1", workspace_id: "lead" }];
  world.screen = "omo has stopped\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const seen = new Set<string>();
  const st = newDeadPaneState();
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T12", st)).toEqual(["DEAD_PANE w:p1"]);
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T13", st)).toEqual(["DEAD_PANE w:p1"]);
});

test("a reworded stop message is not dead: with no alive status it is unrecognised, and repeated reads raise one alert", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screen = "the agent process went away\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const seen = new Set<string>();
  const st = newDeadPaneState();
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T12", st)).toEqual(["UNRECOGNISED_PANE w:p1 unregistered dead-panes: no alive status and no dead marker for 3 ticks"]);
  expect(await deadPaneTick(deps.ops, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
});

test("a pane no lane owns raises one digest line, even after an alive status starts its count over", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screen = "ubuntu@host:~$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st, [working]);
  const lines: string[] = [];
  for (let i = 0; i < 3; i++) lines.push(...await tick());
  world.panes[0] = { pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" };
  lines.push(...await tick());
  world.panes[0] = { pane_id: "w:p1", workspace_id: "w" };
  for (let i = 0; i < 6; i++) lines.push(...await tick());
  expect(lines).toEqual(["UNRECOGNISED_PANE w:p1 unregistered dead-panes: no alive status and no dead marker for 3 ticks"]);
  expect(eventClass(lines[0] as string)).toBe("lead-digest");
});

test("a lane pane's count starts over on each report, claim or status change, and a silent lane pane is named with its key", async () => {
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", tab_id: "w:t2" }];
  world.screen = "something else\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  let lane: Lane = working;
  const tick = () => deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st, [lane]);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
  lane = { ...lane, lastReplyAt: T0 + MIN };
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
  lane = { ...lane, claim: { at: new Date(T0 + 2 * MIN).toISOString(), evidence: "pr" } };
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
  lane = { ...lane, history: [{ at: new Date(T0 + 3 * MIN).toISOString(), status: "working", note: "resumed" }] };
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
  const line = "UNRECOGNISED_PANE w:p7 lane=quiet-lane dead-panes: no alive status and no dead marker for 3 ticks";
  expect(await tick()).toEqual([line]);
  expect(eventClass(line)).toBe("lead-urgent");
});

const agentOf = (key: string) => ({ shell_pid: 10, foreground_processes: [{ pid: 11, name: "omo", argv: ["omo", `Read and execute the lane brief at /home/u/.dori/runner/briefs/${key}.md in full.`] }] });

test("a lane pane herdr misses while its lane agent process still runs raises nothing; once only the shell is left it is dead", async () => {
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", tab_id: "w:t2", agent_status: "unknown" }];
  world.screen = "omo has stopped\n$ ";
  // The agent's argv names the lane's brief (every OS); herdr's agent detection lost it.
  world.inspection = { process: agentOf("quiet-lane") };
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st, [working]);
  for (let i = 0; i < 4; i++) expect(await tick()).toEqual([]);
  // Another lane's agent in the pane is not this lane's.
  world.inspection = { process: agentOf("other-lane") };
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual(["DEAD_PANE w:p7"]);
});

test("a lane pane its runner already reported dead (deadAlertPane) raises no DEAD_PANE or UNRECOGNISED_PANE of its own", async () => {
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", tab_id: "w:t2" }];
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const alerted: Lane = { ...working, deadAlertPane: "w:p7" };
  world.screen = "omo has stopped\n$ ";
  const st = newDeadPaneState();
  for (let i = 0; i < 4; i++) expect(await deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st, [alerted])).toEqual([]);
  world.screen = "something else\n$ ";
  const st2 = newDeadPaneState();
  for (let i = 0; i < 4; i++) expect(await deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st2, [alerted])).toEqual([]);
  // The same lane on another pane is news.
  const moved: Lane = { ...alerted, deadAlertPane: "w:p3" };
  const st3 = newDeadPaneState();
  const lines: string[] = [];
  for (let i = 0; i < 3; i++) lines.push(...await deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st3, [moved]));
  expect(lines).toEqual(["UNRECOGNISED_PANE w:p7 lane=quiet-lane dead-panes: no alive status and no dead marker for 3 ticks"]);
});

test("a DAG viewer pane in a registered lane's tab is part of that lane and never raises UNRECOGNISED_PANE", async () => {
  world.panes = [
    { pane_id: "w:p7", workspace_id: "w", tab_id: "w:t2", agent: "pi", agent_status: "working" },
    { pane_id: "w:p8", workspace_id: "w", tab_id: "w:t2", agent_status: "unknown", terminal_title: "OmO DAG" },
  ];
  world.screen = "wave 2/3 running\n";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  for (let i = 0; i < 5; i++) expect(await deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st, [working])).toEqual([]);
});

test("a DAG viewer pane outside every lane's tab, and any other unknown pane in a lane's tab, still raise UNRECOGNISED_PANE", async () => {
  world.panes = [
    { pane_id: "w:p7", workspace_id: "w", tab_id: "w:t2", agent: "pi", agent_status: "working" },
    { pane_id: "w:p8", workspace_id: "w", tab_id: "w:t2", agent_status: "unknown", terminal_title: "ubuntu@host:~" },
    { pane_id: "w:p9", workspace_id: "w", tab_id: "w:t3", agent_status: "unknown", terminal_title: "OmO DAG" },
  ];
  world.screen = "wave 2/3 running\n";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st, [working]);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([
    "UNRECOGNISED_PANE w:p8 lane=quiet-lane dead-panes: no alive status and no dead marker for 3 ticks",
    "UNRECOGNISED_PANE w:p9 unregistered dead-panes: no alive status and no dead marker for 3 ticks",
  ]);
});

test("a pane whose agent status says it is alive is never reported dead, whatever the screen shows", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  world.screen = "grep output: has stopped\n❯ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  expect(await deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st)).toEqual([]);
});

test("a dead marker that does not hold to the next tick is never dead", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screens = ["omo has stopped\n$ ", "redrawing\n", "omo has stopped\n$ ", "redrawing\n"];
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  for (let i = 0; i < 4; i++) expect(await deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st)).toEqual([]);
});

test("an alive status resets the unrecognised count, so two unknown ticks on each side of it raise no alert", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screen = "something else\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.ops, deps.config, new Set(), "2026-01-01T12", st);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
  world.panes[0] = { pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" };
  expect(await tick()).toEqual([]);
  world.panes[0] = { pane_id: "w:p1", workspace_id: "w" };
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
});

test("launch reports the runner's startup verdict for the lane's pane: STARTUP_OK, STARTUP_ERROR or STARTUP_UNCONFIRMED with its detail", async () => {
  // The screen scan and status polls run in the runner (lane.start, runner/lane-control.ts); launch formats its verdict.
  const brief = join(state.dir, "brief.md");
  const run = async (verdict: "ok" | "error" | "unconfirmed", detail: string, key: string) => {
    writeFileSync(brief, "# brief\n");
    world = newWorld();
    world.startResult = { pane: "w:p9", tab: "w:t9", startup: { verdict, detail } };
    // Each launch in its own registry: the fake runner reports every cwd as one checkout, which a second open lane may not share.
    const own = withState();
    try { return (await launchLane(depsFor(world, fakeClock(T0), own.dir), { key, title: "t", brief, done: "closed acme/app#3", cwd: state.dir })).startup; }
    finally { own.done(); }
  };
  expect(await run("ok", "", "ok-lane")).toBe("STARTUP_OK ok-lane w:p9");
  expect(await run("error", "No API key", "err-lane")).toBe("STARTUP_ERROR err-lane w:p9: No API key");
  expect(await run("unconfirmed", "no ready agent status (idle)", "blank-lane")).toBe("STARTUP_UNCONFIRMED blank-lane w:p9: no ready agent status (idle)");
});

test("the host guard alerts on low disk, clears when it recovers, and flips compute readiness on load", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, memFreeCritPct: 5, swapFreeCritPct: 5, diskFreeMinGb: 50, panesMax: 20 };
  const st = { alerting: false } as { alerting: boolean; computeReady?: boolean };
  const healthy = { load1: 40, memFreePct: 50, diskFreeGb: 200, swapFreeGb: 4, swapTotalGb: 8, panes: 5 };
  expect(guardTick(healthy, t, st)).toEqual(["HOST_GUARD COMPUTE_READY load 40 < 80"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual(["HOST_GUARD ALERT disk free 12 GB < 50 GB"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual([]);
  const recovered = guardTick({ ...healthy, load1: 120 }, t, st);
  expect(recovered[0]).toStartWith("HOST_GUARD CLEAR");
  expect(recovered.slice(1)).toEqual(["HOST_GUARD COMPUTE_BUSY load 120"]);
});

test("a heavy slot waits for load to drop, and a slot held by a dead process is taken over", async () => {
  const dir = join(state.dir, "heavy");
  const clock = fakeClock(T0);
  let loads = [120, 95, 40];
  const base = { dir, slots: 1, maxLoad: 80, clock, pid: 4242, load: async () => loads.shift() ?? 40 };
  const slot = await acquireSlot({ ...base, alive: () => true }, "build");
  expect(loads).toEqual([]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(slot, "owner"), "999999 other 2026-01-01T00:00:00Z");
  loads = [10];
  let polls = 0;
  const stolen = await acquireSlot({ ...base, alive: (pid) => pid !== 999999, clock: { ...clock, sleep: async () => { polls++; } } }, "test");
  expect(stolen).toBe(slot);
  expect(polls).toBe(0);
  releaseSlot(stolen);
});

test("a slot whose owner is alive is not taken", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), "1 busy now");
  utimesSync(join(dir, "slot.1"), new Date(), new Date());
  let polls = 0;
  const clock = { now: () => Date.now(), sleep: async () => { polls++; if (polls > 2) throw new Error("stop"); } };
  await expect(acquireSlot({ dir, slots: 1, maxLoad: 80, clock, pid: 7, load: async () => 10, alive: () => true }, "x", 1)).rejects.toThrow("stop");
});

test("adopting a lane refuses a Done line the watcher could never check", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await expect(adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "two clean QA passes", pane: "w:p2" })).rejects.toBeInstanceOf(LaunchError);
  const ok = await adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" });
  expect(ok.thread).toBe("none");
  await expect(adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" })).rejects.toThrow("already registered");
});

test("the session id is read from --session, then a child's environment, then the session file made at start", async () => {
  const info = JSON.stringify({ result: { process_info: { shell_pid: 10 } } });
  const fake = (extra: Record<string, string>) => async (argv: readonly string[]) => {
    const line = argv.join(" ");
    if (line.startsWith("herdr pane process-info")) return { code: 0, out: info, err: "" };
    const hit = Object.entries(extra).find(([k]) => line.startsWith(k));
    return { code: hit ? 0 : 1, out: hit?.[1] ?? "", err: "" };
  };
  const table = [{ pid: 10, ppid: 1, cmd: "zsh" }, { pid: 11, ppid: 10, cmd: "/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin" }, { pid: 12, ppid: 11, cmd: "bun /x/mcp/cli.js mcp" }];
  const flagged = [{ pid: 10, ppid: 1, cmd: "zsh" }, { pid: 11, ppid: 10, cmd: "omo --session 01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b" }];
  expect((await resolveSession("w:p1", "/repo", flagged, { run: fake({}), sessionsDir: "/s" })).via).toBe("argv");
  expect((await resolveSession("w:p1", "/repo", table, { run: fake({ "ps eww -o pid=,command= -p 12": "12 bun mcp PI_SESSION_ID=01a11440-ee81-7f90-b2ed-dcc7d51a0adf X=1" }), sessionsDir: "/s" })).id).toBe("01a11440-ee81-7f90-b2ed-dcc7d51a0adf");
  const listDir = () => ["2026-01-01T09-00-00-000Z_01a10000-0000-7000-8000-000000000000.jsonl", "2026-01-01T12-00-02-113Z_01a11440-ee81-7f90-b2ed-dcc7d51a0adf.jsonl"];
  const byStart = await resolveSession("w:p1", "/repo", table, { run: fake({ "ps eww": "bun mcp X=1", "ps -o lstart=": "Thu Jan  1 12:00:01 2026 GMT" }), sessionsDir: "/s", listDir });
  expect(byStart).toEqual({ id: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf", via: "start-time", pid: 11 });
});
