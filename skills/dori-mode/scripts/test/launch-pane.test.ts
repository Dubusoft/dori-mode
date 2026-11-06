import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { footer, footerDoneRules, LaunchError, launchLane, STARTUP_POLL_MS, STARTUP_POLLS, startupLine, validateLaunch } from "../src/launch.ts";
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
  expect(start).toMatchObject({ key: "pane-lane", target: { pane: "w:p3" }, keywords: "ulw set goal and work", sandbox: false, cwd: wt, done: "closed acme/app#3" });
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

test("the lane's model reaches the runner: defaultModel unless the launch names one; leadModel never does", async () => {
  await writeBrief();
  const base = deps({});
  await launchLane({ ...base, config: { ...base.config, defaultModel: "test/lane-default", leadModel: "test/lead" } }, input({ pane: "w:p3" }));
  expect(starts()[0]?.model).toBe("test/lane-default");
  await launchLane(base, input({ key: "pane-lane-2", cwd: wt, model: "test/picked" }));
  expect(starts()[1]?.model).toBe("test/picked");
});

test("laneSandbox wraps every local lane, passes a --pane lane through unless --sandbox, and records it", async () => {
  const base = deps({});
  const laneSandbox = { command: ["lane-sandbox"] };
  let n = 0;
  const launch = async (config: typeof base.config, target: Record<string, string>, sandbox?: true, which: (cmd: string) => string | null = () => null) => {
    await writeBrief();
    world.panes = [{ pane_id: "w:p3", workspace_id: target.workspace ?? "w", tab_id: "w:t7", cwd: wt }];
    const key = `sandbox-lane-${++n}`;
    const r = await launchLane({ ...base, config, which }, { ...input({ key, ...target }), ...(sandbox ? { sandbox } : {}) });
    await base.registry.update(key, (lane) => ({ ...lane!, status: "closed", pane: undefined }));
    return { start: starts().at(-1)!, lane: r.lane, notes: r.notes };
  };
  const onPath = (cmd: string) => (cmd === "lane-sandbox" ? "/usr/local/bin/lane-sandbox" : null);
  // No flag and no setting: a lane in a workspace pane is wrapped.
  const always = await launch({ ...base.config, laneSandbox }, { workspace: "w" }, undefined, onPath);
  expect(always.start.sandbox).toBe(true);
  expect(always.lane.sandbox).toBe(true);
  expect(always.notes.filter((note) => note.startsWith("SANDBOX_SKIPPED"))).toEqual([]);
  const forced = await launch({ ...base.config, laneSandbox }, { pane: "w:p3" }, true);
  expect(forced.start.sandbox).toBe(true);
  expect(forced.lane.sandbox).toBe(true);
  // A --pane lane runs unwrapped and says why.
  const reused = await launch({ ...base.config, laneSandbox }, { pane: "w:p3" }, undefined, onPath);
  expect(reused.start.sandbox).toBe(false);
  expect(reused.lane.sandbox).toBeUndefined();
  expect(reused.notes).toContainEqual(expect.stringMatching(/^SANDBOX_SKIPPED sandbox-lane-3: --pane w:p3 /));
  // A wrapper missing from PATH passes through and says why.
  const missing = await launch({ ...base.config, laneSandbox }, { workspace: "w" });
  expect(missing.start.sandbox).toBe(false);
  expect(missing.notes).toContainEqual(expect.stringMatching(/^SANDBOX_SKIPPED sandbox-lane-4: lane-sandbox is not on PATH/));
  expect((await launch(base.config, { pane: "w:p3" })).start.sandbox).toBe(false);
});

test("--sandbox is refused without laneSandbox and for a remote lane, before anything is written", async () => {
  await writeBrief();
  const base = deps({});
  await expect(launchLane(base, { ...input({ pane: "w:p3" }), sandbox: true })).rejects.toThrow(/needs laneSandbox/);
  const remote = launchLane({ ...base, config: { ...base.config, laneSandbox: { command: ["lane-sandbox"] } } }, { ...input({ machine: "m1" }), sandbox: true });
  await expect(remote).rejects.toThrow(/local lanes only/);
  expect(await base.registry.read("pane-lane")).toBeNull();
  expect(starts()).toEqual([]);
});

test("a remote lane goes to its machine's runner with its remote directory and no heavy-slot settings; without a directory it is refused", async () => {
  await writeBrief();
  const d = deps({});
  await expect(launchLane(d, input({ machine: "m1" }))).rejects.toThrow("a lane on machine m1 needs --cwd");
  expect(starts()).toEqual([]);
  expect(await d.registry.read("pane-lane")).toBeNull();
  const r = await launchLane(d, input({ machine: "m1", cwd: "/home/u/app" }));
  const start = starts()[0]!;
  expect(start).toMatchObject({ machine: "m1", cwd: "/home/u/app", sandbox: false });
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
    expect(rules, name).toContain("no owner quotes");
    expect(rules, name).toContain("not done");
    expect(rules, name).toContain("Keep decisions and conversations out of the repo");
    expect(rules, name).toContain("never ask only through an on-screen ask-user prompt");
    expect(rules, name).toContain("run the dori report question command below");
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

test("only a lane whose Done names a merged PR is told to claim without waiting for the merge", () => {
  const line = "claim done without waiting for the merge";
  expect(footerDoneRules(footerLane({ done: "merged acme/app#1; closed acme/app#3" }))).toContain(line);
  expect(footerDoneRules(footerLane())).not.toContain(line);
});

test("a mass-ulw launch refuses keywords or a brief path that omo would not bind", async () => {
  await writeBrief();
  const base = deps({});
  const mass = (massLaunchKeywords: string, extra: Record<string, string> = {}) =>
    validateLaunch({ ...base, config: { ...base.config, massLaunchKeywords } }, { ...input({ pane: "w:p3", ...extra }), mode: "mass-ulw" });
  await expect(mass("mass-ulw set goal and work")).rejects.toThrow(LaunchError);
  await expect(mass("/mass-ulw set goal and work?")).rejects.toThrow(LaunchError);
  await expect(mass("/mass-ulw set goal and work", { brief: join(state.dir, "what?.md") })).rejects.toThrow(LaunchError);
  await mass("/mass-ulw set goal and work");
});
