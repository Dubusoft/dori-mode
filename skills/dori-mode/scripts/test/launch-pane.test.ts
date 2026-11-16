import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { footer, footerDoneRules, LaunchError, launchLane, parseLaneTask, SandboxRefusal, STARTUP_POLL_MS, STARTUP_POLLS, startupLine, validateLaunch } from "../src/launch.ts";
import { LaneOpsError, laneOps, type StartInput } from "../src/lane-ops.ts";
import type { Lane } from "../src/registry.ts";
import type { RunnerCall } from "../src/runner/call.ts";
import type { LaneInspection } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
let wt: string;
beforeEach(() => {
  state = withState();
  world = newWorld();
  wt = join(state.dir, "worktree");
  mkdirSync(wt);
});
afterEach(() => state.done());

type PaneSpec = { agent?: string; fgPgid?: number; workspace?: string };

/** deps whose runner lists `w:p3` (a shell pane in `wt`, tab `w:t7`), answers its process info, and starts lanes in it. */
const deps = (spec: PaneSpec | null = {}) => {
  const base = depsFor(world, fakeClock(T0), state.dir);
  world.panes = spec ? [{ pane_id: "w:p3", workspace_id: spec.workspace ?? "w", tab_id: "w:t7", cwd: wt, ...(spec.agent ? { agent: spec.agent, agent_status: "idle" } : {}) }] : [];
  // The directories here are outside git: the placement check has nothing to compare.
  world.inspection = { process: { shell_pid: 100, foreground_process_group_id: spec?.fgPgid ?? 100 }, git: undefined } as Partial<LaneInspection>;
  world.startResult = { pane: "w:p3", tab: "w:t7", startup: { verdict: "ok", detail: "ready" } };
  return base;
};

const input = (extra: Record<string, string> = {}) => ({ key: "pane-lane", title: "t", brief: join(state.dir, "brief.md"), done: "closed acme/app#3", ...extra });
const writeBrief = () => Bun.write(join(state.dir, "brief.md"), "goal: do it\n");
const starts = (): StartInput[] => world.ops.filter((e) => e.op === "start").map((e) => e.args as StartInput);

const expectRefused = async (d: ReturnType<typeof deps>, extra: Record<string, string>, message: RegExp) => {
  await writeBrief();
  const brief = await Bun.file(join(state.dir, "brief.md")).text();
  const attempt = launchLane(d, input(extra));
  await expect(attempt).rejects.toBeInstanceOf(LaunchError);
  await expect(attempt).rejects.toThrow(message);
  expect(await d.registry.read("pane-lane")).toBeNull();
  expect(starts()).toEqual([]);
  expect(await Bun.file(join(state.dir, "brief.md")).text()).toBe(brief);
};

test("--pane starts the lane through its runner in that pane and registers the pane and tab it returns", async () => {
  await writeBrief();
  const d = deps({});
  const r = await launchLane(d, input({ pane: "w:p3" }));
  expect(starts()).toHaveLength(1);
  const start = starts()[0]!;
  expect(start).toMatchObject({ key: "pane-lane", target: { pane: "w:p3" }, keywords: "ulw set goal and work", sandbox: true, cwd: wt, done: "closed acme/app#3" });
  expect(start.machine).toBeUndefined();
  expect(start.briefText).toContain("## Lane footer (written by dori launch)");
  expect(r.lane).toMatchObject({ pane: "w:p3", tab: "w:t7", runner: "local", reportVia: "cli" });
  expect(await d.registry.read("pane-lane")).toMatchObject({ pane: "w:p3", tab: "w:t7", runner: "local" });
  expect((await d.registry.read("pane-lane"))?.launchReservation).toBeUndefined();
  expect(await Bun.file(join(state.dir, "brief.md")).text()).toContain("## Lane footer (written by dori launch)");
  expect(r.startup).toBe("STARTUP_OK pane-lane w:p3");
});

test("a sandboxed local lane reaches the runner as lane.start with agentProfile sandboxed, and the returned pane is recorded", async () => {
  await writeBrief();
  const base = deps({});
  const calls: { label: string; type: string; body: Record<string, unknown> }[] = [];
  const call: RunnerCall = {
    call: async (label, type, body) => {
      calls.push({ label, type, body: body as Record<string, unknown> });
      return { cmdId: "c1", state: "verified", detail: "started", result: { pane: "w:p9", tab: "w:t9", startup: { verdict: "ok", detail: "ready" } } } as never;
    },
    query: async (_label, type, body) => {
      if (type !== "q.lane.inspect") throw new Error(`no ${type} expected`);
      return { status: "missing", cwd: (body as { cwd?: string }).cwd ?? "", cwdExists: true } as never;
    },
    connected: () => true,
  };
  const ops = laneOps(call, { now: () => T0 });
  const config = { ...base.config, laneSandbox: { command: ["lane-sandbox"] } };
  const r = await launchLane({ ...base, ops, config, which: () => "/usr/local/bin/lane-sandbox" }, input({ cwd: wt }));
  expect(calls.map((c) => [c.label, c.type])).toEqual([["local", "lane.start"]]);
  expect(calls[0]?.body).toMatchObject({ key: "pane-lane", agentProfile: "sandboxed", sandbox: true, cwd: wt, mode: "ulw", heavySlots: config.heavySlots, heavyMaxLoad: config.heavyMaxLoad });
  expect(r.lane).toMatchObject({ pane: "w:p9", tab: "w:t9", sandbox: true });
  const stored = await base.registry.read("pane-lane");
  expect(stored).toMatchObject({ pane: "w:p9", tab: "w:t9" });
  expect(stored?.status).toBeUndefined();
  expect(stored?.launchReservation).toBeUndefined();
  expect(calls[0]?.body.files).toEqual({ run: stored!.fileRun, tree: { directories: [], files: [] }, references: [] });
});

test("--mode mass-ulw opens with massLaunchKeywords and records the mode; the default is ulw", async () => {
  await writeBrief();
  const d = deps({});
  const mass = await launchLane(d, { ...input({ pane: "w:p3" }), mode: "mass-ulw" });
  expect(starts()[0]).toMatchObject({ keywords: "/mass-ulw set goal and work", mode: "mass-ulw" });
  expect(mass.lane.mode).toBe("mass-ulw");
  expect((await d.registry.read("pane-lane"))?.mode).toBe("mass-ulw");
  await d.registry.write({ ...mass.lane, closedAt: new Date(T0).toISOString() });
  const plain = await launchLane(deps({}), input({ key: "pane-lane-2", pane: "w:p3" }));
  expect(starts()[1]).toMatchObject({ keywords: "ulw set goal and work", mode: "ulw" });
  expect(plain.lane.mode).toBe("ulw");
});

test("--task records the Toodo task id on the lane; a launch without it records none", async () => {
  await writeBrief();
  const d = deps({});
  const linked = await launchLane(d, { ...input({ pane: "w:p3" }), task: 949 });
  expect(linked.lane.task).toBe(949);
  expect((await d.registry.read("pane-lane"))?.task).toBe(949);
  await d.registry.write({ ...linked.lane, closedAt: new Date(T0).toISOString() });
  await launchLane(deps({}), input({ key: "pane-lane-2", pane: "w:p3" }));
  expect(await d.registry.read("pane-lane-2")).not.toHaveProperty("task");
});

test("--task takes only a positive decimal integer, and launch refuses any other task id before registering", async () => {
  expect(parseLaneTask("949")).toBe(949);
  for (const bad of ["0", "-1", "abc", "1.5", "0x10", "1e3", "", "9007199254740993"]) expect(parseLaneTask(bad)).toBeUndefined();
  await writeBrief();
  for (const task of [0, -3, 1.5]) {
    await expect(launchLane(deps({}), { ...input({ pane: "w:p3" }), task })).rejects.toThrow(/--task must be a positive integer/);
  }
  expect(starts()).toEqual([]);
});

test("the lane's model reaches the runner: defaultModel unless the launch names one; leadModel never does", async () => {
  await writeBrief();
  const base = deps({});
  await launchLane({ ...base, config: { ...base.config, defaultModel: "test/lane-default", leadModel: "test/lead" } }, input({ pane: "w:p3" }));
  expect(starts()[0]?.model).toBe("test/lane-default");
  await launchLane(base, input({ key: "pane-lane-2", cwd: wt, model: "test/picked" }));
  expect(starts()[1]?.model).toBe("test/picked");
});

test("every local lane, --pane too, runs in laneSandbox once its --check passes, and records it; --sandbox changes nothing", async () => {
  const base = deps({});
  let n = 0;
  const launch = async (target: Record<string, string>, sandbox?: true) => {
    await writeBrief();
    world.panes = [{ pane_id: "w:p3", workspace_id: target.workspace ?? "w", tab_id: "w:t7", cwd: wt }];
    const key = `sandbox-lane-${++n}`;
    const r = await launchLane(base, { ...input({ key, ...target }), ...(sandbox ? { sandbox } : {}) });
    await base.registry.update(key, (lane) => ({ ...lane!, status: "closed", pane: undefined }));
    return { start: starts().at(-1)!, lane: r.lane, notes: r.notes };
  };
  for (const run of [await launch({ workspace: "w" }), await launch({ pane: "w:p3" }), await launch({ pane: "w:p3" }, true)]) {
    expect(run.start.sandbox).toBe(true);
    expect(run.lane.sandbox).toBe(true);
    expect(run.notes.filter((note) => note.startsWith("SANDBOX_SKIPPED"))).toEqual([]);
  }
  expect(world.calls.filter((c) => c[0] === "lane-sandbox")).toEqual([["lane-sandbox", "--check"], ["lane-sandbox", "--check"], ["lane-sandbox", "--check"]]);
});

test("a local lane whose wrapper is missing (SANDBOX_MISSING) or whose --check fails (SANDBOX_BROKEN) is refused before anything is written", async () => {
  const base = deps({});
  await expectRefused({ ...base, which: () => null }, { pane: "w:p3" }, /^SANDBOX_MISSING pane-lane: lane-sandbox is not on PATH; install scripts\/templates\/lane-sandbox\.sh as lane-sandbox or set laneSandbox\.command/);
  await expect(launchLane({ ...base, which: () => null }, input({ cwd: wt }))).rejects.toMatchObject({ code: "SANDBOX_MISSING" });
  world.sandboxCheck = { code: 3, out: "", err: "lane-sandbox: bwrap cannot create a user namespace\n" };
  await expectRefused(base, { pane: "w:p3" }, /^SANDBOX_BROKEN pane-lane: lane-sandbox --check failed \(exit 3\): lane-sandbox: bwrap cannot create a user namespace;/);
  const broken = launchLane(base, input({ cwd: wt }));
  await expect(broken).rejects.toBeInstanceOf(SandboxRefusal);
  await expect(broken).rejects.toMatchObject({ code: "SANDBOX_BROKEN" });
});

test("a remote lane is sandboxed by default; a machine opted in with runners.<label>.allowUnsandboxed runs without one and says so", async () => {
  await writeBrief();
  const base = deps({});
  const remote = await launchLane(base, { ...input({ machine: "m1", cwd: "/home/u/app" }), sandbox: true });
  expect(starts()[0]).toMatchObject({ machine: "m1", sandbox: true });
  expect(remote.lane.sandbox).toBe(true);
  expect(remote.notes.filter((note) => note.startsWith("SANDBOX_SKIPPED"))).toEqual([]);
  // The remote runner checks its own sandbox; the lead's wrapper is neither looked up nor run.
  expect(world.calls.filter((c) => c[0] === "lane-sandbox")).toEqual([]);
  const opted = { ...base, which: () => null, config: { ...base.config, runners: { m2: { allowUnsandboxed: true } } } };
  const r = await launchLane(opted, input({ key: "pane-lane-2", machine: "m2", cwd: "/home/u/app" }));
  expect(starts()[1]).toMatchObject({ machine: "m2", sandbox: false });
  expect(r.lane.sandbox).toBeUndefined();
  expect(r.notes).toContain("SANDBOX_SKIPPED pane-lane-2: machine m2 is opted in with runners.m2.allowUnsandboxed; this lane runs WITHOUT a sandbox");
  // The footer tells each lane which permissions it got: the sandbox's table, or none.
  expect(starts()[0]!.briefText).toContain("- Sandbox permissions: writable = ");
  expect(starts()[1]!.briefText).toContain("- Sandbox permissions: none.");
  expect(starts()[1]!.briefText).not.toContain("- Sandbox permissions: writable = ");
});

test("a lane on a Windows runner runs without a sandbox and says so; a runner reporting another OS stays sandboxed", async () => {
  await writeBrief();
  const base = { ...deps({}), runnerOs: (label: string) => (label === "win" ? "win32" : label === "box" ? "linux" : undefined) };
  const win = await launchLane(base, input({ machine: "win", cwd: "C:\\work\\app" }));
  expect(starts()[0]).toMatchObject({ machine: "win", sandbox: false });
  expect(win.lane.sandbox).toBeUndefined();
  expect(win.notes).toContain("SANDBOX_SKIPPED pane-lane: machine win is a Windows runner (Windows has no lane sandbox); this lane runs WITHOUT a sandbox");
  const box = await launchLane(base, input({ key: "pane-lane-2", machine: "box", cwd: "/home/u/app" }));
  expect(starts()[1]).toMatchObject({ machine: "box", sandbox: true });
  expect(box.notes.filter((note) => note.startsWith("SANDBOX_SKIPPED"))).toEqual([]);
});

test("a runner that refuses the sandboxed start is SANDBOX_UNAVAILABLE with the fix, and the reservation is released", async () => {
  await writeBrief();
  const base = deps({});
  // The policy refusals, and the async sandbox check's failure as the runner's lanes.ts reports it.
  for (const detail of ["lane.start RUNNER_CMD_REJECTED agent-profile sandboxed", "lane.start RUNNER_CMD_REJECTED sandbox-required sandbox:false", "lane.start RUNNER_CMD_FAILED RUNNER_CMD_REJECTED sandbox-unavailable lane-sandbox: bwrap is not installed"]) {
    const refusing = { ...base.ops, start: async () => { throw new LaneOpsError("LANE_OP_FAILED", "m1", detail); } };
    const attempt = launchLane({ ...base, ops: refusing }, input({ machine: "m1", cwd: "/home/u/app" }));
    await expect(attempt).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
    await expect(attempt).rejects.toThrow(`SANDBOX_UNAVAILABLE pane-lane: machine m1 refused the sandboxed start (${detail}); install lane-sandbox on that runner (dori runner install), or opt the machine in with runners.m1.allowUnsandboxed`);
    expect(await base.registry.read("pane-lane")).toBeNull();
  }
});

test("a relaunch keeps the recorded choice: a sandboxed record is checked again, one recorded without a sandbox starts unsandboxed with a note", async () => {
  await writeBrief();
  const base = deps({});
  const record = (patch: Partial<Lane>): Lane => ({ key: "pane-lane", title: "t", thread: "none", brief: join(state.dir, "brief.md"), done: "closed acme/app#3", openedAt: "x", cwd: wt, reportVia: "cli", runner: "local", ...patch });
  const plain = record({});
  await base.registry.write(plain);
  const r = await launchLane(base, input({ cwd: wt }), plain);
  expect(starts()[0]?.sandbox).toBe(false);
  expect(r.notes).toContain("SANDBOX_SKIPPED pane-lane: relaunch of a lane recorded without a sandbox");
  expect(world.calls.filter((c) => c[0] === "lane-sandbox")).toEqual([]);
  const boxed = { ...r.lane, sandbox: true as const };
  await base.registry.write(boxed);
  await expect(launchLane({ ...base, which: () => null }, { ...input({ cwd: wt }), sandbox: true }, boxed)).rejects.toMatchObject({ code: "SANDBOX_MISSING" });
  const again = await launchLane(base, { ...input({ cwd: wt }), sandbox: true }, boxed);
  expect(starts().at(-1)?.sandbox).toBe(true);
  expect(again.notes.filter((note) => note.startsWith("SANDBOX_SKIPPED"))).toEqual([]);
});

test("a remote lane without --cwd sends no cwd (its runner uses its defaultCwd) and records the directory the runner reports", async () => {
  await writeBrief();
  const d = deps({});
  world.startResult = { pane: "w:p3", tab: "w:t7", startup: { verdict: "ok", detail: "ready" }, cwd: "/Users/u/work" };
  const r = await launchLane(d, input({ machine: "m1" }));
  expect(starts()[0]).toMatchObject({ machine: "m1", sandbox: true });
  expect(starts()[0]).not.toHaveProperty("cwd");
  expect(r.lane).toMatchObject({ machine: "m1", runner: "m1", remoteCwd: "/Users/u/work" });
  expect(r.lane.cwd).toBeUndefined();
});

test("a remote lane goes to its machine's runner with its remote directory and no heavy-slot settings", async () => {
  await writeBrief();
  const d = deps({});
  const r = await launchLane(d, input({ machine: "m1", cwd: "/home/u/app" }));
  const start = starts()[0]!;
  expect(start).toMatchObject({ machine: "m1", cwd: "/home/u/app", sandbox: true });
  expect(start.heavySlots).toBeUndefined();
  expect(start.briefText).toContain("~/.dori/runner/bin/dori report pane-lane done");
  expect(r.lane).toMatchObject({ machine: "m1", runner: "m1", remoteCwd: "/home/u/app", reportVia: "cli" });
  expect(r.lane.cwd).toBeUndefined();
});

test("cwd comes from the pane unless --cwd is given", async () => {
  await writeBrief();
  const d = deps({});
  const r = await launchLane(d, input({ pane: "w:p3" }));
  expect(r.lane.cwd).toBe(wt);
  expect(starts()[0]?.cwd).toBe(wt);
  await d.registry.write({ ...r.lane, closedAt: new Date(T0).toISOString() });
  const other = join(state.dir, "other");
  mkdirSync(other);
  const r2 = await launchLane(deps({}), input({ key: "pane-lane-2", pane: "w:p3", cwd: other }));
  expect(r2.lane.cwd).toBe(other);
  expect(starts()[1]?.cwd).toBe(other);
});

test("--workspace resolves to that workspace's shell pane", async () => {
  await writeBrief();
  const r = await launchLane(deps({}), input({ workspace: "w" }));
  expect(r.lane.pane).toBe("w:p3");
  expect(starts()[0]?.target).toEqual({ pane: "w:p3" });
});

test("a missing pane is refused and writes nothing", async () => {
  await expectRefused(deps(null), { pane: "w:p3" }, /does not exist/);
});

test("a pane running an agent is refused and writes nothing", async () => {
  await expectRefused(deps({ agent: "omo" }), { pane: "w:p3" }, /runs an agent/);
});

test("a pane with another foreground process is refused and writes nothing", async () => {
  await expectRefused(deps({ fgPgid: 555 }), { pane: "w:p3" }, /foreground process/);
});

test("a pane already registered to a lane is refused and writes nothing", async () => {
  const d = deps({});
  const owner: Lane = { key: "other-lane", title: "o", thread: "none", pane: "w:p3", brief: "/b.md", done: "merged a/b#1", openedAt: new Date(T0).toISOString() };
  await d.registry.write(owner);
  await expectRefused(d, { pane: "w:p3" }, /already registered to lane other-lane/);
});

test("--pane and --workspace that disagree are refused and write nothing", async () => {
  await expectRefused(deps({ workspace: "w" }), { pane: "w:p3", workspace: "x" }, /not x/);
});

test("without --pane the runner opens a new tab and the lane records the pane it returns", async () => {
  await writeBrief();
  const d = deps({});
  world.startResult = undefined;
  const r = await launchLane(d, input({ cwd: wt }));
  expect(starts()[0]?.target).toBeUndefined();
  expect(r.lane.pane).toBe("w-pane-lane:p1");
  expect(r.lane.tab).toBe("w-pane-lane:t1");
  expect(world.ops.some((e) => e.op === "processInfo")).toBe(false);
});

test("the runner's startup verdict becomes the STARTUP line; the poll constants stay exported", async () => {
  expect(STARTUP_POLL_MS).toBe(2_000);
  expect(STARTUP_POLLS).toBe(10);
  expect(startupLine("k", "w:p9", { verdict: "ok", detail: "ready" })).toBe("STARTUP_OK k w:p9");
  expect(startupLine("k", "w:p9", { verdict: "error", detail: "No API key" })).toBe("STARTUP_ERROR k w:p9: No API key");
  expect(startupLine("k", "w:p9", { verdict: "unconfirmed", detail: "no ready agent status (idle); last lines: ❯" })).toBe("STARTUP_UNCONFIRMED k w:p9: no ready agent status (idle); last lines: ❯");
  await writeBrief();
  const d = deps({});
  world.startResult = { pane: "w:p3", tab: "w:t7", startup: { verdict: "error", detail: "No API key" } };
  expect((await launchLane(d, input({ pane: "w:p3" }))).startup).toBe("STARTUP_ERROR pane-lane w:p3: No API key");
});

test("a start the runner refuses releases the reservation; one that may have happened keeps it reserved and paused", async () => {
  await writeBrief();
  const base = deps({});
  const refusing = { ...base.ops, start: async () => { throw new LaneOpsError("LANE_OP_FAILED", "local", "lane.start RUNNER_CMD_REJECTED cwd-outside-roots"); } };
  await expect(launchLane({ ...base, ops: refusing }, input({ cwd: wt }))).rejects.toThrow("cwd-outside-roots");
  expect(await base.registry.read("pane-lane")).toBeNull();
  const down = { ...base.ops, start: async () => { throw new LaneOpsError("RUNNER_UNAVAILABLE", "local", "disconnected: no admitted connection"); } };
  await expect(launchLane({ ...base, ops: down }, input({ cwd: wt }))).rejects.toThrow("RUNNER_UNAVAILABLE");
  expect(await base.registry.read("pane-lane")).toBeNull();
  const unsure = { ...base.ops, start: async () => { throw new LaneOpsError("LANE_OP_AMBIGUOUS", "local", "lane.start lost"); } };
  await expect(launchLane({ ...base, ops: unsure }, input({ cwd: wt }))).rejects.toThrow("the start may have happened");
  expect(await base.registry.read("pane-lane")).toMatchObject({ status: "paused", launchReservation: expect.any(String) });
});

const footerLane = (patch: Partial<Lane> = {}): Lane => ({ key: "k-1", title: "t", thread: "th-9", brief: "/b.md", done: "closed acme/app#3", openedAt: "x", ...patch });

test("footer puts the shared done rules first and every lane value after '### This lane'; no lane types into the lead pane", () => {
  const variants: [string, Lane][] = [
    ["local", footerLane()],
    ["cli", footerLane({ reportVia: "cli" })],
    ["remote", footerLane({ machine: "m1", runner: "m1" })],
    ["autoClose", footerLane({ reportVia: "cli", autoClose: "machine" })],
  ];
  for (const [name, lane] of variants) {
    const text = footer(lane, "Korean");
    const rules = footerDoneRules(lane, "Korean");
    const at = text.indexOf("### This lane");
    expect(at, name).toBeGreaterThan(text.indexOf(rules));
    expect(text.indexOf(rules), name).toBeGreaterThanOrEqual(0);
    for (const v of ["k-1", "th-9", "closed acme/app#3"]) {
      expect(rules, `${name} ${v}`).not.toContain(v);
      expect(text.indexOf(v), `${name} ${v}`).toBeGreaterThan(at);
    }
    // Each shared rule is present, whatever its wording: done claim and re-claim, the dirty-worktree refusal, no quotes or
    // ids or usage numbers in repo text, no decision records in the repo, owner decisions only through a question report.
    expect(rules, name).toMatch(/`Done =` signal/);
    expect(rules, name).toContain("[LEAD] not done");
    expect(rules, name).toMatch(/uncommitted or unpushed/);
    expect(rules, name).toMatch(/no owner quotes, chat ids, usage or cost numbers/);
    expect(rules, name).toMatch(/decision logs or chat records/);
    expect(rules, name).toMatch(/Owner decisions go only through the dori report question command/);
    expect(rules, name).toMatch(/on-screen prompts/);
    expect(text, name).not.toContain("[REPORT]");
    expect(text, name).not.toContain("sent to pane");
  }
  expect(footerDoneRules(footerLane())).toContain("only through `dori heavy <label> -- <command>`");
  expect(footerDoneRules(footerLane({ machine: "m1", runner: "m1" }))).toContain("only through `~/.dori/runner/bin/dori heavy <label> -- <command>`");
  // laneRules lines follow the shared rules, in config order, for every lane; none adds nothing.
  for (const [, lane] of variants) {
    const rules = footerDoneRules(lane, "Korean", ["Stop at an open PR with CI green; do not merge.", "CI runs the typecheck only."]);
    expect(rules).toContain("- Stop at an open PR with CI green; do not merge.\n- CI runs the typecheck only.");
    expect(footerDoneRules(lane, "Korean", [])).toBe(footerDoneRules(lane, "Korean"));
  }
  expect(footer(footerLane())).toContain('dori report k-1 done --text "<one line>"');
  expect(footer(footerLane({ machine: "m1", runner: "m1" }))).toContain('~/.dori/runner/bin/dori report k-1 done --text "<one line>"');
  expect(footer(footerLane({ machine: "m1", runner: "m1" }))).not.toContain("claim-done k-1");
  expect(footerDoneRules(footerLane({ reportVia: "cli", autoClose: "machine" }))).toContain("autoClose: machine");
});

test("footer places the lane's git worktrees under its machine's reported worktree root, and says nothing without one", () => {
  const line = "- Create every git worktree this lane needs under /srv/wt, as /srv/wt/<repo name>-k-1 (<repo name>: the last segment of owner/repo).";
  for (const lane of [footerLane(), footerLane({ machine: "m1", runner: "m1" })]) {
    const text = footer(lane, "Korean", [], "/srv/wt/");
    expect(text).toContain(line);
    expect(text.indexOf(line)).toBeGreaterThan(text.indexOf("### This lane"));
    expect(text.replace(`${line}\n`, "")).toBe(footer(lane, "Korean", []));
    expect(footer(lane, "Korean", [], undefined)).not.toContain("Create every git worktree");
  }
});

test("only a lane whose Done names a merged PR is told to claim while its CI is still running", () => {
  const line = "claim done once the PR is pushed and its CI is running or green";
  expect(footerDoneRules(footerLane({ done: "merged acme/app#1; closed acme/app#3" }))).toContain(line);
  expect(footerDoneRules(footerLane())).not.toContain(line);
});

test("a mass-ulw launch refuses keywords or a brief path that omo would not bind", async () => {
  await writeBrief();
  const base = deps({});
  const mass = (massLaunchKeywords: string, extra: Record<string, string> = {}) =>
    validateLaunch({ ...base, tunables: { ...base.tunables, massLaunchKeywords } }, { ...input({ pane: "w:p3", ...extra }), mode: "mass-ulw" });
  await expect(mass("mass-ulw set goal and work")).rejects.toThrow(LaunchError);
  await expect(mass("/mass-ulw set goal and work?")).rejects.toThrow(LaunchError);
  await expect(mass("/mass-ulw set goal and work", { brief: join(state.dir, "what?.md") })).rejects.toThrow(LaunchError);
  await mass("/mass-ulw set goal and work");
});

test("--grant names travel on the start, the lane record and the footer; an old runner or an unknown name starts nothing and says why", async () => {
  await writeBrief();
  const base = deps({});
  const r = await launchLane(base, { ...input({ machine: "m1", cwd: "/home/u/app" }), grants: ["blog-topic"] });
  expect(starts()[0]).toMatchObject({ machine: "m1", sandbox: true, grants: ["blog-topic"] });
  expect(starts()[0]!.briefText).toContain("- Path grants: blog-topic ");
  expect(r.lane.grants).toEqual(["blog-topic"]);

  const refusals: [string, string][] = [
    ["lane.start RUNNER_CMD_REJECTED unknown-field", "LAUNCH_GRANT_UNSUPPORTED pane-lane-2: machine m1 predates --grant"],
    ["lane.start RUNNER_CMD_REJECTED grant-unknown", "LAUNCH_GRANT_REFUSED pane-lane-2: machine m1 refused --grant blog-topic (RUNNER_CMD_REJECTED grant-unknown)"],
  ];
  for (const [detail, message] of refusals) {
    const refusing = { ...base.ops, start: async () => { throw new LaneOpsError("LANE_OP_FAILED", "m1", detail); } };
    const attempt = launchLane({ ...base, ops: refusing }, { ...input({ key: "pane-lane-2", machine: "m1", cwd: "/home/u/app" }), grants: ["blog-topic"] });
    await expect(attempt).rejects.toBeInstanceOf(LaunchError);
    await expect(attempt).rejects.toThrow(message);
    expect(await base.registry.read("pane-lane-2")).toBeNull();
  }
});
