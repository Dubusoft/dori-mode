import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { footer, footerDoneRules, LaunchError, launchLane, LEGACY_LANE_MCP, STARTUP_POLL_MS, STARTUP_POLLS } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
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

/** deps whose herdr answers pane get / process-info for `w:p3` (a shell pane in `wt`), plus whatever `world.panes` lists. */
const deps = (spec: PaneSpec | null = {}) => {
  const base = depsFor(world, fakeClock(T0), state.dir);
  world.panes = [{ pane_id: "w:p3", workspace_id: spec?.workspace ?? "w", ...(spec?.agent ? { agent: spec.agent, agent_status: "idle" } : {}) }];
  return {
    ...base,
    run: async (argv: readonly string[]) => {
      const [cmd, a1, a2, a3] = argv;
      if (cmd === "herdr" && a1 === "pane" && a2 === "get") {
        if (!spec || a3 !== "w:p3") { world.calls.push([...argv]); return { code: 1, out: "", err: "pane not found" }; }
        world.calls.push([...argv]);
        const pane = { pane_id: "w:p3", workspace_id: spec.workspace ?? "w", tab_id: "w:t7", cwd: wt, foreground_cwd: wt, ...(spec.agent ? { agent: spec.agent } : {}) };
        return { code: 0, out: JSON.stringify({ result: { pane } }), err: "" };
      }
      if (cmd === "herdr" && a1 === "pane" && a2 === "process-info") {
        world.calls.push([...argv]);
        return { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 100, foreground_process_group_id: spec?.fgPgid ?? 100 } } }), err: "" };
      }
      return base.run(argv);
    },
  };
};

const input = (extra: Record<string, string> = {}) => ({ key: "pane-lane", title: "t", brief: join(state.dir, "brief.md"), done: "closed acme/app#3", ...extra });
const writeBrief = () => Bun.write(join(state.dir, "brief.md"), "goal: do it\n");
const herdr = (sub: string, action: string) => world.calls.filter((c) => c[0] === "herdr" && c[1] === sub && c[2] === action);

test("a lane is never launched on a lead-only emergency model, given or as the default", async () => {
  const d = deps();
  const config = { ...d.config, leadEmergencyModels: ["og/anthropic/claude-opus-5-5"] };
  await expectRefused({ ...d, config }, { model: "og/anthropic/claude-opus-5-5" }, /lead-only emergency model/);
  await expectRefused({ ...d, config: { ...config, defaultModel: "og/anthropic/claude-opus-5-5:max" } }, {}, /lead-only emergency model/);
});

const expectRefused = async (d: ReturnType<typeof deps>, extra: Record<string, string>, message: RegExp) => {
  await writeBrief();
  const before = await Bun.file(join(state.dir, "brief.md")).text();
  await expect(launchLane(d, input(extra))).rejects.toThrow(LaunchError);
  await expect(launchLane(d, input(extra))).rejects.toThrow(message);
  expect(await Bun.file(join(state.dir, "brief.md")).text()).toBe(before);
  expect(await d.registry.read("pane-lane")).toBeNull();
  expect(herdr("pane", "run")).toEqual([]);
  expect(herdr("tab", "create")).toEqual([]);
};

test("--pane runs the lane command in that pane, creates no tab, and registers pane and tab", async () => {
  await writeBrief();
  world.panes = [];
  const d = deps({});
  const r = await launchLane(d, input({ pane: "w:p3" }));
  expect(herdr("tab", "create")).toEqual([]);
  const run = herdr("pane", "run");
  expect(run).toHaveLength(1);
  expect(run[0]?.[3]).toBe("w:p3");
  expect(run[0]?.[4]).toContain("ulw set goal and work");
  expect(run[0]?.[4]).toContain(join(state.dir, "brief.md"));
  expect(r.lane.pane).toBe("w:p3");
  expect(r.lane.tab).toBe("w:t7");
  expect((await d.registry.read("pane-lane"))?.pane).toBe("w:p3");
  expect(await Bun.file(join(state.dir, "brief.md")).text()).toContain("## Lane footer (written by dori launch)");
  expect(r.startup).toStartWith("STARTUP_");
});

test("leadModel and leadThinking leave a lane on defaultModel and agentCommand's --thinking", async () => {
  await writeBrief();
  world.panes = [];
  const base = deps({});
  const config = {
    ...base.config, agentCommand: ["omo", "--model", "{model}", "--thinking", "medium", "{prompt}"],
    defaultModel: "test/lane-default", leadModel: "test/lead", leadThinking: "high",
  };
  await launchLane({ ...base, config }, input({ pane: "w:p3" }));
  const command = herdr("pane", "run")[0]?.[4] ?? "";
  expect(command).toContain("--model test/lane-default --thinking medium ");
  expect(command).not.toContain("test/lead");
  expect(command).not.toContain("--thinking high");
});

test("cwd comes from the pane unless --cwd is given", async () => {
  await writeBrief();
  const d = deps({});
  await Bun.write(join(wt, ".omo", "mcp.json"), LEGACY_LANE_MCP);
  const r = await launchLane(d, input({ pane: "w:p3" }));
  expect(r.lane.cwd).toBe(wt);
  await d.registry.write({ ...r.lane, closedAt: new Date(T0).toISOString() });
  expect(await Bun.file(join(wt, ".omo", "mcp.json")).exists()).toBe(false);
  expect(herdr("pane", "run").flat().join(" ")).not.toContain("--approve");
  const other = join(state.dir, "other");
  mkdirSync(other);
  const r2 = await launchLane(deps({}), input({ key: "pane-lane-2", pane: "w:p3", cwd: other }));
  expect(r2.lane.cwd).toBe(other);
});

test("--workspace resolves to that workspace's shell pane", async () => {
  await writeBrief();
  const r = await launchLane(deps({}), input({ workspace: "w" }));
  expect(r.lane.pane).toBe("w:p3");
  expect(herdr("tab", "create")).toEqual([]);
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

test("without --pane the lane still gets a new tab", async () => {
  await writeBrief();
  const base = depsFor(world, fakeClock(T0), state.dir);
  const d = { ...base, run: async (argv: readonly string[]) => (argv[1] === "tab" ? (world.calls.push([...argv]), { code: 0, out: JSON.stringify({ result: { tab_id: "w:t9", root_pane: { pane_id: "w:p9" } } }), err: "" }) : base.run(argv)) };
  const r = await launchLane(d, input({ cwd: wt }));
  expect(herdr("tab", "create")).toHaveLength(1);
  expect(r.lane.pane).toBe("w:p9");
  expect(r.lane.tab).toBe("w:t9");
  expect(herdr("pane", "get")).toEqual([]);
});

/** Launch into a new tab whose pane reports `statuses` on successive status lookups (the last repeats); every sleep is recorded, none waits. */
const startup = async (statuses: (string | undefined)[], screen: string) => {
  const key = "poll-lane";
  state.done();
  state = withState();
  wt = join(state.dir, "worktree");
  mkdirSync(wt);
  await writeBrief();
  world = newWorld();
  world.screen = screen;
  const waited: number[] = [];
  const clock = { ...fakeClock(T0), sleep: async (ms: number) => { waited.push(ms); } };
  const base = depsFor(world, clock, state.dir);
  let reads = 0;
  const d = { ...base, run: async (argv: readonly string[]) => {
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { tab_id: "w:t9", root_pane: { pane_id: "w:p9" } } }), err: "" };
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list") {
      const status = statuses[Math.min(reads++, statuses.length - 1)];
      return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "w:p9", workspace_id: "w", ...(status ? { agent: "pi", agent_status: status } : {}) }] } }), err: "" };
    }
    return base.run(argv);
  } };
  const r = await launchLane(d, input({ key, cwd: wt }));
  return { startup: r.startup, waited };
};

test("startup needs two consecutive ready reads, polled every 2 s", async () => {
  expect(STARTUP_POLL_MS).toBe(2_000);
  expect(await startup(["idle", "idle"], "❯ ")).toEqual({ startup: "STARTUP_OK poll-lane w:p9", waited: [2_000, 2_000] });
  // A blip in between restarts the count.
  expect((await startup(["idle", "blocked", "idle", "working"], "❯ ")).waited).toEqual([2_000, 2_000, 2_000, 2_000]);
  expect((await startup(["working", "working"], "❯ ")).startup).toBe("STARTUP_OK poll-lane w:p9");
});

test("a lane never ready is unconfirmed after exactly 10 polls", async () => {
  const r = await startup(["idle", "blocked"], "❯ ");
  expect(STARTUP_POLLS).toBe(10);
  expect(r.startup).toStartWith("STARTUP_UNCONFIRMED poll-lane w:p9");
  expect(r.waited).toHaveLength(10);
});

test("startup keeps the scan-before-idle rule: an idle prompt over a known failure is an error on the first poll", async () => {
  const r = await startup(["idle"], "No API key found\n❯ ");
  expect(r).toEqual({ startup: "STARTUP_ERROR poll-lane w:p9: No API key", waited: [2_000] });
  // A working agent is not scanned.
  expect((await startup(["working", "working"], "No API key found\n❯ ")).startup).toBe("STARTUP_OK poll-lane w:p9");
});

const footerLane = (patch: Partial<Lane> = {}): Lane => ({ key: "k-1", title: "t", thread: "th-9", brief: "/b.md", done: "closed acme/app#3", openedAt: "x", ...patch });

test("footer puts the shared done rules first and every lane value after '### This lane'", () => {
  const variants: [string, Lane][] = [
    ["pane report", footerLane()],
    ["cli", footerLane({ reportVia: "cli" })],
    ["remote", footerLane({ machine: "m1" })],
    ["autoClose", footerLane({ reportVia: "cli", autoClose: "machine" })],
  ];
  for (const [name, lane] of variants) {
    const text = footer(lane, "w:lead", "Korean");
    const rules = footerDoneRules(lane, "Korean");
    const at = text.indexOf("### This lane");
    expect(at, name).toBeGreaterThan(text.indexOf(rules));
    expect(text.indexOf(rules), name).toBeGreaterThanOrEqual(0);
    for (const v of ["k-1", "th-9", "closed acme/app#3", ...(name === "pane report" ? ["w:lead"] : [])]) {
      expect(rules, `${name} ${v}`).not.toContain(v);
      expect(text.indexOf(v), `${name} ${v}`).toBeGreaterThan(at);
    }
    expect(rules, name).toContain("no owner quotes");
    expect(rules, name).toContain("not done");
  }
  expect(footer(footerLane(), "w:lead")).toContain('dori claim-done k-1 --evidence "<merge SHA, closed issue, version>"');
  expect(footer(footerLane({ reportVia: "cli" }), "w:lead")).toContain('dori report k-1 done --text "<one line>"');
  expect(footer(footerLane({ machine: "m1" }), "w:lead")).not.toContain("claim-done k-1");
  expect(footerDoneRules(footerLane({ reportVia: "cli", autoClose: "machine" }))).toContain("autoClose: machine");
});
