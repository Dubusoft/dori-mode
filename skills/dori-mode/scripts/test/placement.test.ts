import { expect, test } from "bun:test";

import { defaultConfig, type GuardThresholds, type PlacementConfig } from "../src/config.ts";
import type { HostSample } from "../src/host-guard.ts";
import { type LaneOps, LaneOpsError } from "../src/lane-ops.ts";
import type { Pane } from "../src/panes.ts";
import { checkMachine, LOCAL_MACHINE, machineVerdict, placementLine, resolvePlacement, verdictLine } from "../src/placement.ts";
import type { MachineSample, SampleResult } from "../src/remote-guard.ts";
import type { MachineObservation } from "../src/runner/protocol.ts";

const config = (p: Partial<PlacementConfig> = {}): PlacementConfig => ({ defaultMachine: "local", workspaces: {}, fallback: [], ...p });
const RESEARCH = "report posted in the thread";
const T: GuardThresholds = defaultConfig("/home/test").guard;

test("an explicit --machine wins over every workspace rule and is not movable", () => {
  const p = resolvePlacement({ machine: "mini", cwd: "/data/repos/app", done: "merged acme/app#1" }, config({ workspaces: { "/data/repos": "big", "*": "big" } }));
  expect(p).toEqual({ machine: "mini", source: "flag", movable: false });
});

test("a blank --machine is ignored", () => {
  expect(resolvePlacement({ machine: "  ", done: RESEARCH }, config({ defaultMachine: "big" }))).toEqual({ machine: "big", source: "default", movable: true });
});

test("the longest path prefix of --cwd wins, matching only at a path boundary", () => {
  const workspaces = { "/data/repos": "big", "/data/repos/app": "mini", "/data/repos/app-old/": "old", "*": "star" };
  const at = (cwd: string) => resolvePlacement({ cwd, done: RESEARCH }, config({ workspaces }));
  expect(at("/data/repos/app/sub")).toEqual({ machine: "mini", source: "workspace", rule: "/data/repos/app", movable: false });
  expect(at("/data/repos/app")).toMatchObject({ machine: "mini", rule: "/data/repos/app" });
  expect(at("/data/repos/apple")).toMatchObject({ machine: "big", rule: "/data/repos" });
  expect(at("/data/repos/app-old/x")).toMatchObject({ machine: "old", rule: "/data/repos/app-old/" });
  expect(at("/srv/other")).toMatchObject({ machine: "star", rule: "*" });
});

test("a path rule beats a repo rule; the first Done repo that is a key wins, case-insensitively", () => {
  const workspaces = { "/data/repos/app": "mini", "Acme/Lib": "lib-box", "acme/app": "app-box" };
  const done = "merged acme/other#3; merged ACME/lib#1; merged acme/app#2";
  expect(resolvePlacement({ cwd: "/data/repos/app", done }, config({ workspaces }))).toMatchObject({ machine: "mini", rule: "/data/repos/app" });
  expect(resolvePlacement({ cwd: "/elsewhere", done }, config({ workspaces }))).toEqual({ machine: "lib-box", source: "workspace", rule: "Acme/Lib", movable: false });
  expect(resolvePlacement({ done }, config({ workspaces }))).toMatchObject({ machine: "lib-box", rule: "Acme/Lib" });
  expect(resolvePlacement({ done: "pr ACME/app feat/x" }, config({ workspaces }))).toEqual({ machine: "app-box", source: "workspace", rule: "acme/app", movable: false });
});

test("\"*\" catches every other workspace task, including --pane and --workspace launches", () => {
  const c = config({ workspaces: { "*": "big" }, defaultMachine: "mini" });
  expect(resolvePlacement({ pane: "w:p1", done: RESEARCH }, c)).toEqual({ machine: "big", source: "workspace", rule: "*", movable: false });
  expect(resolvePlacement({ workspace: "w", done: RESEARCH }, c)).toMatchObject({ machine: "big", rule: "*" });
  expect(resolvePlacement({ done: "closed acme/app#9" }, c)).toMatchObject({ machine: "big", rule: "*" });
});

test("an unmapped workspace task runs locally, not on defaultMachine", () => {
  expect(resolvePlacement({ cwd: "/data/repos/app", done: RESEARCH }, config({ defaultMachine: "big", workspaces: { "/srv": "mini" } })))
    .toEqual({ machine: LOCAL_MACHINE, source: "workspace", movable: false });
});

test("a workspace-less launch goes to defaultMachine and may fall back", () => {
  expect(resolvePlacement({ done: RESEARCH }, config())).toEqual({ machine: "local", source: "default", movable: true });
  expect(resolvePlacement({ done: RESEARCH }, config({ defaultMachine: "big", workspaces: { "*": "mini" } }))).toEqual({ machine: "big", source: "default", movable: true });
});

const sample = (s: Partial<MachineSample> = {}): SampleResult => ({ ok: true, sample: { version: "v", os: "linux", load1: 999, memFreePct: 60, swapFreeGb: 4, swapTotalGb: 8, diskFreeGb: 200, ...s } });

test("machineVerdict: offline is one unreachable reason", () => {
  expect(machineVerdict({ ok: false, detail: "unreachable: timeout" }, 3, T, "big")).toEqual({ ok: false, reasons: ["machine big unreachable: unreachable: timeout"] });
});

test("machineVerdict: unreadable (-1) memory and disk never hold, CPU load never holds", () => {
  expect(machineVerdict(sample({ memFreePct: -1, diskFreeGb: -1 }), 3, T, "big")).toEqual({ ok: true, reasons: [] });
});

test("machineVerdict: an unreadable pane count holds", () => {
  expect(machineVerdict(sample(), -1, T, "big")).toEqual({ ok: false, reasons: ["pane count unreadable"] });
});

test("machineVerdict: memory, disk and pane thresholds use canLaunch's reasons", () => {
  expect(machineVerdict(sample({ memFreePct: 10, diskFreeGb: 20 }), T.panesMax, T, "big").reasons)
    .toEqual([`memory free 10% < ${T.memFreeMinPct}%`, `disk free 20 GB < ${T.diskFreeMinGb} GB`, `panes ${T.panesMax} >= ${T.panesMax}`]);
  expect(machineVerdict(sample(), T.panesMax - 1, T, "big")).toEqual({ ok: true, reasons: [] });
});

const host = (s: Partial<HostSample> = {}): HostSample => ({ load1: 500, memFreePct: 60, diskFreeGb: 200, swapFreeGb: 4, swapTotalGb: 8, panes: 2, ...s });
const listed = (n: number): Pane[] => Array.from({ length: n }, (_, i) => ({ pane_id: `p${i}`, workspace_id: "w" }));

/** A facade whose runners answer `observeMachine` from `answer` (by machine; undefined = the local runner); every machine asked is recorded. */
const observing = (answer: (machine: string | undefined) => MachineObservation, asked: (string | undefined)[] = []): LaneOps =>
  ({ observeMachine: async (machine?: string) => { asked.push(machine); return answer(machine); } }) as unknown as LaneOps;
const cfg = { ...defaultConfig("/home/test"), stateDir: "/state" };

test("checkMachine local asks the local runner and applies canLaunch to its sample", async () => {
  const asked: (string | undefined)[] = [];
  const c = await checkMachine(observing(() => ({ os: "linux", sampledAt: 0, sample: host({ memFreePct: 50, diskFreeGb: 100, panes: T.panesMax }), panes: listed(T.panesMax) }), asked), cfg, "local");
  expect(asked).toEqual([undefined]);
  expect(c).toEqual({ machine: "local", verdict: { ok: false, reasons: [`panes ${T.panesMax} >= ${T.panesMax}`] }, summary: `memory free 50%, disk free 100 GB, panes ${T.panesMax}` });
});

test("checkMachine remote asks that machine's runner and counts the panes it lists", async () => {
  const asked: (string | undefined)[] = [];
  const c = await checkMachine(observing(() => ({ os: "linux", sampledAt: 0, sample: host(), panes: listed(2) }), asked), cfg, "big");
  expect(asked).toEqual(["big"]);
  expect(c).toEqual({ machine: "big", verdict: { ok: true, reasons: [] }, summary: "memory free 60%, disk free 200 GB, panes 2" });
});

test("checkMachine remote: unreadable memory and disk never hold, CPU load never holds, a pane list the runner could not read holds", async () => {
  const unreadable = await checkMachine(observing(() => ({ os: "linux", sampledAt: 0, sample: host({ memFreePct: -1, diskFreeGb: -1 }), panes: listed(1) })), cfg, "big");
  expect(unreadable.verdict).toEqual({ ok: true, reasons: [] });
  const noList = await checkMachine(observing(() => ({ os: "linux", sampledAt: 0, sample: host({ panes: -1 }), panes: [] })), cfg, "big");
  expect(noList.verdict).toEqual({ ok: false, reasons: ["pane count unreadable"] });
});

test("checkMachine remote holds at the panesMax its runner reports, over the supervisor's config.guard", async () => {
  const wide = { ...cfg, guard: { ...cfg.guard, panesMax: 20 } };
  const seen = (guard?: MachineObservation["guard"]): MachineObservation => ({ os: "darwin", sampledAt: 0, sample: host({ panes: 6 }), panes: listed(6), ...(guard ? { guard } : {}) });
  const own = await checkMachine(observing(() => seen({ panesMax: 6 })), wide, "mini");
  expect(own.verdict).toEqual({ ok: false, reasons: ["panes 6 >= 6"] });
  expect(verdictLine("mini", own.verdict)).toBe("HOLD machine=mini panes 6 >= 6");
  // A runner that reports no thresholds (or an older one) is judged at config.guard.
  expect((await checkMachine(observing(() => seen()), wide, "mini")).verdict).toEqual({ ok: true, reasons: [] });
  expect((await checkMachine(observing(() => seen()), { ...cfg, guard: { ...cfg.guard, panesMax: 6 } }, "mini")).verdict.reasons).toEqual(["panes 6 >= 6"]);
  // Only the reported keys win; the local machine ignores a reported guard.
  expect((await checkMachine(observing(() => seen({ diskFreeMinGb: 500 })), wide, "mini")).verdict.reasons).toEqual(["disk free 200 GB < 500 GB"]);
  expect((await checkMachine(observing(() => seen({ panesMax: 6 })), wide, "local")).verdict).toEqual({ ok: true, reasons: [] });
});

test("checkMachine holds with no runner when the machine's runner is unavailable", async () => {
  const down = { observeMachine: async (machine?: string) => { throw new LaneOpsError("RUNNER_UNAVAILABLE", machine ?? "local", "disconnected: no admitted connection"); } } as unknown as LaneOps;
  const remote = await checkMachine(down, cfg, "ghost");
  expect(remote).toEqual({ machine: "ghost", verdict: { ok: false, reasons: ["no runner (dori runner install --machine ghost)"] }, summary: "" });
  expect(verdictLine("ghost", remote.verdict)).toBe("HOLD machine=ghost no runner (dori runner install --machine ghost)");
  const local = await checkMachine(down, cfg, "local");
  expect(local.verdict.ok).toBe(false);
  expect(local.verdict.reasons[0]).toStartWith("no runner (the supervisor runs the local runner");
});

test("checkMachine holds with the runner's error when the observation fails otherwise", async () => {
  const failing = { observeMachine: async () => { throw new LaneOpsError("LANE_OP_FAILED", "big", "RUNNER_QUERY_FAILED q.machine.observe df failed"); } } as unknown as LaneOps;
  const c = await checkMachine(failing, cfg, "big");
  expect(c.summary).toBe("");
  expect(c.verdict).toEqual({ ok: false, reasons: ["machine big unreachable: LANE_OP_FAILED runner=big RUNNER_QUERY_FAILED q.machine.observe df failed"] });
});

test("verdictLine keeps the legacy local text and tags remote machines", () => {
  const hold = { ok: false, reasons: ["memory free 10% < 20%", "panes 20 >= 20"] };
  expect(verdictLine("local", { ok: true, reasons: [] })).toBe("CAN_LAUNCH");
  expect(verdictLine("local", hold)).toBe("HOLD memory free 10% < 20% | panes 20 >= 20");
  expect(verdictLine("big", { ok: true, reasons: [] })).toBe("CAN_LAUNCH machine=big");
  expect(verdictLine("big", hold)).toBe("HOLD machine=big memory free 10% < 20% | panes 20 >= 20");
});

test("placementLine names the machine, source and matched rule", () => {
  expect(placementLine({ machine: "local", source: "default", movable: true })).toBe("PLACEMENT machine=local source=default");
  expect(placementLine({ machine: "big", source: "workspace", rule: "*", movable: false })).toBe("PLACEMENT machine=big source=workspace rule=*");
  expect(placementLine({ machine: "mini", source: "flag", movable: false })).toBe("PLACEMENT machine=mini source=flag");
});
