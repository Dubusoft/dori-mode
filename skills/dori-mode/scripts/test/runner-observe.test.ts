import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Proc } from "../src/lane-memory.ts";
import type { Ran } from "../src/run.ts";
import { briefLane, observeHost, turnStop } from "../src/runner/observe.ts";
import { RunnerClient, yieldTurn } from "../src/runner/client.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { serveRunner, STARTUP_GRACE_MS, type ObservedLane } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import { fakeClock } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = (): string => { const d = mkdtempSync(join(tmpdir(), "runner-observe-")); dirs.push(d); return d; };

const REPORT_A = "[REPORT] lane-a | milestone | PR #12 open, CI green";
const REPORT_B_OLD = "[REPORT] lane-b | question | which base branch?";
const REPORT_B = "[REPORT] lane-b | milestone | tests pass";

const panes = [
  { pane_id: "p1", workspace_id: "w", tab_id: "t1", agent: "omo", agent_status: "working" },
  { pane_id: "p2", workspace_id: "w", tab_id: "t2", agent: "omo", agent_status: "idle" },
  { pane_id: "p3", workspace_id: "w", tab_id: "t3" },
];
const screens: Record<string, string> = {
  p1: `some output\n${REPORT_A}\nmore output`,
  p2: `${REPORT_B_OLD}\nwork\n${REPORT_B}`,
  p3: "$ ls\n",
};
const info: Record<string, object> = {
  p1: { shell_pid: 100, foreground_processes: [{ pid: 101 }] },
  p2: { shell_pid: 200, foreground_processes: [{ pid: 201 }] },
  p3: { shell_pid: 300, foreground_processes: [] },
};
// The agents (101, 201) carry DORI_LANE_KEY; their shells (100, 200) and the plain pane's shell (300) carry none.
const procs: Proc[] = [
  { pid: 100, ppid: 1, rssKb: 1, comm: "sh" },
  { pid: 101, ppid: 100, rssKb: 1, comm: "omo", lane: "lane-a" },
  { pid: 200, ppid: 1, rssKb: 1, comm: "sh" },
  { pid: 201, ppid: 200, rssKb: 1, comm: "omo", lane: "lane-b" },
  { pid: 300, ppid: 1, rssKb: 1, comm: "sh" },
];
const ok = (out: string): Ran => ({ code: 0, out, err: "" } as Ran);
const herdrCalls: string[][] = [];
const herdrWith = (list: readonly object[]) => async (argv: readonly string[]): Promise<Ran> => {
  herdrCalls.push([...argv]);
  const [, noun, verb, ...rest] = argv;
  if (noun === "pane" && verb === "list") return ok(JSON.stringify({ result: { panes: list } }));
  if (noun === "pane" && verb === "process-info") return ok(JSON.stringify({ result: { process_info: info[rest[1] as string] } }));
  if (noun === "pane" && verb === "read") return ok(screens[rest[0] as string] ?? "");
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` } as Ran;
};
const fakeHerdr = herdrWith(panes);

test("observeHost finds lanes by DORI_LANE_KEY without a registry and never reads a pane's screen for a report", async () => {
  herdrCalls.length = 0;
  const observed = await observeHost({ run: fakeHerdr, procs: async () => procs });
  expect(observed).toEqual([
    { key: "lane-a", pane: "p1", tab: "t1", status: "working" },
    { key: "lane-b", pane: "p2", tab: "t2", status: "idle" },
  ]);
  expect(herdrCalls.filter((argv) => argv[1] === "pane" && argv[2] === "read")).toEqual([]);
});

const withInfo = (override: Record<string, object>) => async (argv: readonly string[]): Promise<Ran> => {
  if (argv[1] === "pane" && argv[2] === "process-info") return ok(JSON.stringify({ result: { process_info: override[argv[4] as string] } }));
  return fakeHerdr(argv);
};
const agentArgv = (path: string): string[] => ["omo", `Read and execute the lane brief at ${path} in full. You are the lane; report as usual.`];
const argvInfo = (path: string): Record<string, object> => ({ p1: { shell_pid: 100, foreground_processes: [{ pid: 101, name: "omo", argv: agentArgv(path) }] } });

test("observeHost attributes a pane from the brief path in the agent argv when no process environment is readable", async () => {
  const observed = await observeHost({ run: withInfo(argvInfo("/tmp/dori-brief-mac-lane.md")), procs: async () => [] });
  expect(observed.map((l) => [l.key, l.pane])).toEqual([["mac-lane", "p1"]]);
});

test("observeHost attributes a pane from the runner's own briefs/<key>.md path in the agent argv", async () => {
  const observed = await observeHost({ run: withInfo(argvInfo("/Users/x/.dori/runner/briefs/mac-lane.md")), procs: async () => [] });
  expect(observed.map((l) => [l.key, l.pane])).toEqual([["mac-lane", "p1"]]);
});

test("observeHost observes the runner's owned panes with no process environment, a shell-only one as dead", async () => {
  // macOS: no environment is readable and no argv names a brief; p3's agent exited and left only its shell.
  const run = withInfo({ p1: { shell_pid: 100, foreground_processes: [{ pid: 101, argv: ["omo"] }] }, p3: { shell_pid: 300, foreground_processes: [] } });
  const owned = async () => new Map([["p1", "own-a"], ["p3", "own-b"]]);
  const observed = await observeHost({ run, procs: async () => [], owned });
  expect(observed.map((l) => [l.key, l.pane, l.status])).toEqual([["own-a", "p1", "working"], ["own-b", "p3", "dead"]]);
});

test("observeHost attributes a Windows-style brief path in the agent argv", async () => {
  const observed = await observeHost({ run: withInfo(argvInfo(String.raw`C:\Users\x\AppData\Local\Temp\dori-brief-win-lane.md`)), procs: async () => [] });
  expect(observed.map((l) => l.key)).toEqual(["win-lane"]);
});

test("observeHost does not observe a pane whose argv names no dori-brief path", async () => {
  const run = withInfo({ p1: { shell_pid: 100, foreground_processes: [{ pid: 101, argv: ["vim", "/tmp/notes.md", "/tmp/dori-brief-x.txt"] }] } });
  expect(await observeHost({ run, procs: async () => [] })).toEqual([]);
  expect(briefLane(undefined)).toBeUndefined();
  expect(briefLane(["/tmp/dori-brief-Bad_Key.md"])).toBeUndefined();
});

test("observeHost prefers the environment attribution over a different key in the argv", async () => {
  const observed = await observeHost({ run: withInfo(argvInfo("/tmp/dori-brief-other-lane.md")), procs: async () => procs });
  expect(observed.map((l) => l.key)).toEqual(["lane-a"]);
});

test("observeHost reports a lane whose agent_status is not alive as dead", async () => {
  const unknown = panes.map((p) => (p.pane_id === "p1" ? { ...p, agent_status: "unknown" } : p));
  const observed = await observeHost({ run: herdrWith(unknown), procs: async () => procs });
  expect(observed.map((l) => [l.key, l.status])).toEqual([["lane-a", "dead"], ["lane-b", "idle"]]);
});

test("serveRunner publishes lane.state on a status change once, and no lane.progress", async () => {
  const dir = stateDir();
  const clock = fakeClock(1_000);
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  const client = new RunnerClient({ label: "worker-a", hostId: "h" }, { connect: async () => { throw new Error("offline"); }, outbox, state, clock });
  let view: ObservedLane[] = [{ key: "lane-a", pane: "p1", tab: "t1", status: "working" }];
  let observeTick: (() => void) | undefined;
  const abort = new AbortController();
  const serving = serveRunner({
    client, latest: () => undefined, clock, heartbeatMs: 15_000, observeMs: 30_000, log: () => {},
    every: (ms, tick) => { if (ms === 30_000) observeTick = tick; return () => {}; },
    observe: async () => view,
  }, abort.signal);
  await yieldTurn();
  observeTick?.();
  await yieldTurn();
  view = [{ key: "lane-a", pane: "p1", tab: "t1", status: "working" }];
  observeTick?.();
  await yieldTurn();
  abort.abort();
  await serving;
  expect(outbox.unacked(0).map((r) => [r.type, r.body])).toEqual([
    ["lane.state", { key: "lane-a", status: "working", pane: "p1" }],
  ]);
  outbox.close();
  state.close();
});

test("serveRunner holds back dead for a starting lane until its agent was seen alive or the startup grace ends", async () => {
  const dir = stateDir();
  const clock = fakeClock(1_000);
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  const client = new RunnerClient({ label: "worker-a", hostId: "h" }, { connect: async () => { throw new Error("offline"); }, outbox, state, clock });
  // lane-a: herdr names its fresh agent unknown (dead), then working, then the agent really stops.
  // lane-b: its agent never comes up.
  const steps: { readonly at: number; readonly view: ObservedLane[] }[] = [
    { at: 1_000, view: [{ key: "lane-a", pane: "p1", tab: "t1", status: "dead" }, { key: "lane-b", pane: "p2", tab: "t2", status: "dead" }] },
    { at: 31_000, view: [{ key: "lane-a", pane: "p1", tab: "t1", status: "working" }, { key: "lane-b", pane: "p2", tab: "t2", status: "dead" }] },
    { at: 61_000, view: [{ key: "lane-a", pane: "p1", tab: "t1", status: "dead" }, { key: "lane-b", pane: "p2", tab: "t2", status: "dead" }] },
    { at: 1_000 + STARTUP_GRACE_MS, view: [{ key: "lane-a", pane: "p1", tab: "t1", status: "dead" }, { key: "lane-b", pane: "p2", tab: "t2", status: "dead" }] },
  ];
  let step = 0;
  let observeTick: (() => void) | undefined;
  const abort = new AbortController();
  const serving = serveRunner({
    client, latest: () => undefined, clock, heartbeatMs: 15_000, observeMs: 30_000, log: () => {},
    every: (ms, tick) => { if (ms === 30_000) observeTick = tick; return () => {}; },
    observe: async () => steps[step]?.view ?? [],
  }, abort.signal);
  await yieldTurn();
  const published = (): unknown[] => outbox.unacked(0).map((r) => r.body);
  expect(published()).toEqual([]);
  for (step = 1; step < steps.length; step++) { clock.at = steps[step]?.at ?? 0; observeTick?.(); await yieldTurn(); }
  abort.abort();
  await serving;
  expect(published()).toEqual([
    { key: "lane-a", status: "working", pane: "p1" },
    { key: "lane-a", status: "dead", pane: "p1" },
    { key: "lane-b", status: "dead", pane: "p2" },
  ]);
  outbox.close();
  state.close();
});

test("serveRunner republishes lane.state on a pane change and after a lane was gone and came back", async () => {
  const dir = stateDir();
  const clock = fakeClock(1_000);
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  const client = new RunnerClient({ label: "worker-a", hostId: "h" }, { connect: async () => { throw new Error("offline"); }, outbox, state, clock });
  const views: ObservedLane[][] = [
    [{ key: "lane-a", pane: "p1", tab: "t1", status: "idle" }],
    [{ key: "lane-a", pane: "p7", tab: "t1", status: "idle" }],
    [],
    [{ key: "lane-a", pane: "p7", tab: "t1", status: "idle" }],
  ];
  let view = 0;
  let observeTick: (() => void) | undefined;
  const abort = new AbortController();
  const serving = serveRunner({
    client, latest: () => undefined, clock, heartbeatMs: 15_000, observeMs: 30_000, log: () => {},
    every: (ms, tick) => { if (ms === 30_000) observeTick = tick; return () => {}; },
    observe: async () => views[Math.min(view++, views.length - 1)] ?? [],
  }, abort.signal);
  await yieldTurn();
  for (let i = 1; i < views.length; i++) { observeTick?.(); await yieldTurn(); }
  abort.abort();
  await serving;
  expect(outbox.unacked(0).map((r) => [r.type, r.body])).toEqual([
    ["lane.state", { key: "lane-a", status: "idle", pane: "p1" }],
    ["lane.state", { key: "lane-a", status: "idle", pane: "p7" }],
    ["lane.state", { key: "lane-a", status: "idle", pane: "p7" }],
  ]);
  outbox.close();
  state.close();
});

/** An omo screen: the chat's last lines, the input box, then the footer (`status`, the goal/monitor line). */
const omoScreen = (chat: readonly string[], status: string): string =>
  [...chat, "", "─".repeat(40), "", "─".repeat(40), "~/repo • main • 74K/1M (7.4%)          (anthropic@login) claude-opus-5-5", `(😺 OmO) ${status}`, ""].join("\n");

test("turnStop names how the last turn ended, what holds the lane, and whether a continuation is pending", () => {
  const work = ["● Editing src/a.ts", "  applied 2 edits"];
  expect(turnStop(omoScreen([...work, "", "Operation aborted"], "Pursuing goal (4m)"), false)).toEqual({ cause: "aborted", hold: "none", continuation: false });
  expect(turnStop(omoScreen([...work, "System operation aborted"], "Pursuing goal (4m)"), false)).toMatchObject({ cause: "system-aborted" });
  expect(turnStop(omoScreen([...work, "Provider retry failed after 3 attempts"], "Goal stopped: no progress (send a message or /goal resume)"), false))
    .toEqual({ cause: "provider-failed", hold: "goal-stopped", continuation: false });
  // A user abort the goal resumes by itself, and a finished turn waiting on a watch, both continue on their own.
  expect(turnStop(omoScreen([...work, "Operation aborted"], "Pursuing goal (4m) ▰▰▱▱ goal resumes in 30s"), false)).toEqual({ cause: "aborted", hold: "none", continuation: true });
  expect(turnStop(omoScreen([...work, "Waiting on CI."], "Pursuing goal (4m) ◉ watching ci checks (3m)"), false)).toEqual({ cause: "finished", hold: "none", continuation: true });
  // omo marks a watch with either glyph (the lead pane's footer: `mem:… just now (+3) ◎ watching dori lead events (1m)`).
  expect(turnStop(omoScreen(["Idle."], "mem:dori-b116e8a6 just now (+3) ◎ watching dori lead events (1m)"), false)).toEqual({ cause: "finished", hold: "no-goal", continuation: true });
  expect(turnStop(omoScreen(["Paused."], "Goal paused (/goal resume)"), false)).toMatchObject({ hold: "goal-paused" });
  expect(turnStop(omoScreen(["Done."], "ship it · Goal achieved (9m)"), false)).toMatchObject({ cause: "finished", hold: "goal-complete" });
  expect(turnStop(omoScreen(["Done."], "mem:src-1 1m ago"), true)).toMatchObject({ hold: "question" });
  expect(turnStop(omoScreen(["Done."], "mem:src-1 1m ago"), false)).toMatchObject({ hold: "no-goal" });
});

test("turnStop reads only the last turn's end: an older abort further up, or one quoted in output, is a finished turn", () => {
  const older = ["Operation aborted", "> continue", ...Array.from({ length: 8 }, (_, i) => `● step ${i}`), "All checks pass."];
  expect(turnStop(omoScreen(older, "Pursuing goal (9m)"), false)).toMatchObject({ cause: "finished" });
  expect(turnStop(omoScreen(["the log says: Operation aborted"], "Pursuing goal (9m)"), false)).toMatchObject({ cause: "finished" });
});

test("turnStop reads a real omo pane whose tool call the user stopped: the footer names the abort and omo's session pause", () => {
  const screen = readFileSync(join(import.meta.dir, "fixtures", "omo-aborted-turn.txt"), "utf8");
  expect(turnStop(screen, false)).toEqual({ cause: "aborted", hold: "session-paused", continuation: false });
});
