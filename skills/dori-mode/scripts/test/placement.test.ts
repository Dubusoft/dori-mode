import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, type GuardThresholds, type PlacementConfig } from "../src/config.ts";
import type { HostSample } from "../src/host-guard.ts";
import { type LaneOps, LaneOpsError } from "../src/lane-ops.ts";
import type { Pane } from "../src/panes.ts";
import {
  checkMachine, LOCAL_MACHINE, machineVerdict, placementLine, placementTable, planLaunch, resolvePlacement, type RunnerPlacement,
  runnerPlacements, verdictLine,
} from "../src/placement.ts";
import type { MachineSample, SampleResult } from "../src/remote-guard.ts";
import { readRunnerRows, RunnerHub, runnerWorktreeRoot } from "../src/runner/hub.ts";
import { type MachineObservation, PROTO, runnerControl, validateFrame } from "../src/runner/protocol.ts";

const config = (p: Partial<PlacementConfig> = {}): PlacementConfig => ({ defaultMachine: "local", fallback: [], ...p });
const RESEARCH = "report posted in the thread";
const T: GuardThresholds = defaultConfig("/home/test").guard;

test("an explicit --machine wins over every workspace rule and is not movable", () => {
  const p = resolvePlacement({ machine: "mini", cwd: "/data/repos/app", done: "merged acme/app#1" }, config({ defaultMachine: "big" }));
  expect(p).toEqual({ machine: "mini", source: "flag", movable: false });
});

test("a blank --machine is ignored", () => {
  expect(resolvePlacement({ machine: "  ", done: RESEARCH }, config({ defaultMachine: "big" }))).toEqual({ machine: "big", source: "default", movable: true });
});

test("while no runner declares a repo, every workspace task (--cwd, --pane, --workspace, a Done repo) runs locally, not on defaultMachine", () => {
  const c = config({ defaultMachine: "big" });
  for (const input of [{ cwd: "/data/repos/app", done: RESEARCH }, { pane: "w:p1", done: RESEARCH }, { workspace: "w", done: RESEARCH }, { done: "closed acme/app#9" }]) {
    expect(resolvePlacement(input, c)).toEqual({ machine: LOCAL_MACHINE, source: "workspace", movable: false });
  }
});

test("a workspace-less launch goes to defaultMachine and may fall back", () => {
  expect(resolvePlacement({ done: RESEARCH }, config())).toEqual({ machine: "local", source: "default", movable: true });
  expect(resolvePlacement({ done: RESEARCH }, config({ defaultMachine: "big" }))).toEqual({ machine: "big", source: "default", movable: true });
});

const sample = (s: Partial<MachineSample> = {}): SampleResult => ({ ok: true, sample: { os: "linux", load1: 999, memFreePct: 60, swapFreeGb: 4, swapTotalGb: 8, diskFreeGb: 200, ...s } });

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

const runner = (machine: string, declared: [string, string][], opts: { online?: boolean; detected?: [string, string][] } = {}): RunnerPlacement => ({
  machine, online: opts.online ?? true,
  declared: declared.map(([repo, path]) => ({ repo, path })), detected: (opts.detected ?? []).map(([repo, path]) => ({ repo, path })),
});
const REPORTS = [
  runner("local", [["acme/dori", "/data/repos/dori"]]),
  runner("mini", [["acme/blog", "/Users/me/work/repos/blog"]], { detected: [["acme/dori", "/Users/me/work/repos/dori"], ["acme/extra", "/Users/me/work/repos/extra"]] }),
];

test("a declared repo goes to the runner declaring it, by Done repo or by a --cwd under its path, with that path as cwd", () => {
  const c = config({ defaultMachine: "mini" });
  expect(resolvePlacement({ done: "merged ACME/blog#1" }, c, REPORTS))
    .toEqual({ machine: "mini", source: "runner", rule: "acme/blog", movable: false, cwd: "/Users/me/work/repos/blog", online: true });
  expect(resolvePlacement({ cwd: "/data/repos/dori/sub", done: RESEARCH }, c, REPORTS)).toMatchObject({ machine: "local", rule: "acme/dori" });
  expect(resolvePlacement({ cwd: "/data/repos/dori-old", done: RESEARCH }, c, REPORTS)).toEqual({ machine: "mini", source: "default", movable: true });
  // --machine still wins.
  expect(resolvePlacement({ machine: "local", done: "merged acme/blog#1" }, c, REPORTS).machine).toBe("local");
});

test("once a runner declares, an undeclared or only-detected repo follows defaultMachine", () => {
  const c = config({ defaultMachine: "mini" });
  for (const done of ["merged acme/extra#1", "merged acme/unknown#1"]) expect(resolvePlacement({ done }, c, REPORTS)).toEqual({ machine: "mini", source: "default", movable: true });
});

test("a repo only detected while no runner declares any runs locally", () => {
  const undeclared = [runner("mini", [], { detected: [["acme/app", "/w/app"]] })];
  expect(resolvePlacement({ done: "merged acme/app#1" }, config({ defaultMachine: "mini" }), undeclared)).toEqual({ machine: LOCAL_MACHINE, source: "workspace", movable: false });
});

test("every runner declaring the same repo is a candidate, in fallback then label order; the preferred online one is placed", () => {
  const both = [...REPORTS, runner("big", [["Acme/Blog", "/srv/blog"]]), runner("spare", [["acme/blog", "/s/blog"]], { online: false })];
  const candidates = [{ machine: "spare", cwd: "/s/blog", online: false }, { machine: "big", cwd: "/srv/blog", online: true }, { machine: "mini", cwd: "/Users/me/work/repos/blog", online: true }];
  expect(resolvePlacement({ done: "merged acme/blog#1" }, config({ fallback: ["spare"] }), both))
    .toEqual({ machine: "big", source: "runner", rule: "acme/blog", movable: false, cwd: "/srv/blog", online: true, candidates });
  expect(resolvePlacement({ done: "merged acme/blog#1" }, config({ defaultMachine: "mini", fallback: ["spare"] }), both)).toMatchObject({ machine: "mini", cwd: "/Users/me/work/repos/blog" });
  // An offline defaultMachine is not preferred while another candidate is online; all offline holds on the preferred one.
  expect(resolvePlacement({ done: "merged acme/blog#1" }, config({ defaultMachine: "spare", fallback: ["spare"] }), both)).toMatchObject({ machine: "big", online: true });
  const away = both.map((r) => ({ ...r, online: false }));
  expect(resolvePlacement({ done: "merged acme/blog#1" }, config({ defaultMachine: "mini" }), away)).toMatchObject({ machine: "mini", online: false });
  // A --cwd under one runner's declared path narrows to that runner alone: no candidates.
  expect(resolvePlacement({ cwd: "/srv/blog/sub", done: "merged acme/blog#1" }, config(), both))
    .toEqual({ machine: "big", source: "runner", rule: "Acme/Blog", movable: false, cwd: "/srv/blog", online: true });
  expect(resolvePlacement({ machine: "spare", done: "merged acme/blog#1" }, config(), both)).toEqual({ machine: "spare", source: "flag", movable: false });
});

test("planLaunch holds a launch for its offline owning runner without checking or falling back", async () => {
  const asked: string[] = [];
  const reports = [runner("mini", [["acme/blog", "/w/blog"]], { online: false })];
  const plan = await planLaunch({ done: "merged acme/blog#1" }, config({ fallback: ["local"] }), async (machine) => {
    asked.push(machine);
    return { machine, verdict: { ok: true, reasons: [] }, summary: "" };
  }, reports);
  expect(asked).toEqual([]);
  expect(plan.lines).toEqual(["PLACEMENT machine=mini source=runner rule=acme/blog cwd=/w/blog"]);
  expect(plan.check).toEqual({ machine: "mini", verdict: { ok: false, reasons: ["runner mini that owns acme/blog is offline; the launch waits for it"] }, summary: "" });
  expect(verdictLine(plan.check.machine, plan.check.verdict)).toBe("HOLD machine=mini runner mini that owns acme/blog is offline; the launch waits for it");
});

test("placementTable lists declared repos per runner, only-detected repos and the default", () => {
  const rows = [...REPORTS.map((r) => (r.machine === "mini" ? { ...r, online: false } : r)), runner("big", [["acme/twice", "/a"]]), runner("spare", [["acme/twice", "/b"]])];
  expect(placementTable(rows, config({ defaultMachine: "mini", fallback: ["local"] }))).toEqual([
    "WORKSPACE repo=acme/blog machine=mini path=/Users/me/work/repos/blog runner=offline",
    "WORKSPACE repo=acme/dori machine=local path=/data/repos/dori runner=online",
    "WORKSPACE repo=acme/twice machine=big path=/a runner=online",
    "WORKSPACE repo=acme/twice machine=spare path=/b runner=online",
    "DETECTED repo=acme/extra machine=mini path=/Users/me/work/repos/extra (no runner declares it)",
    "DEFAULT machine=mini fallback=local",
  ]);
  expect(placementTable([], config())).toEqual(["DEFAULT machine=local fallback=-"]);
});

test("runnerPlacements keeps only rows that reported workspaces", () => {
  const rows = [
    { label: "local", eventAck: 0, cmdSeq: 0, maxGen: 1, cmdAck: 0, workspaces: { declared: [{ repo: "acme/dori", path: "/d" }], detected: [] } },
    { label: "old", eventAck: 0, cmdSeq: 0, maxGen: 1, cmdAck: 0 },
  ];
  expect(runnerPlacements(rows, (row) => row.label === "local")).toEqual([{ machine: "local", online: true, declared: [{ repo: "acme/dori", path: "/d" }], detected: [] }]);
});

test("placementTable prints one WORKTREES line per runner that reported a worktree root, by machine, before DEFAULT", () => {
  const rows = [{ ...runner("mini", [["acme/blog", "/w/blog"]]), worktreeRoot: "/w/worktrees" }, runner("big", []), { ...runner("apple", []), worktreeRoot: "/a/wt" }];
  expect(placementTable(rows, config())).toEqual([
    "WORKSPACE repo=acme/blog machine=mini path=/w/blog runner=online",
    "WORKTREES machine=apple root=/a/wt",
    "WORKTREES machine=mini root=/w/worktrees",
    "DEFAULT machine=local fallback=-",
  ]);
});

test("a hello's worktreeRoot validates, is stored with its workspaces, kept across a bare hello, and read back into placement", () => {
  const dir = mkdtempSync(join(tmpdir(), "placement-hub-"));
  try {
    const hub = new RunnerHub({ stateDir: dir, commit: () => true, now: () => 1000, monotonic: () => 1000, epoch: 1 });
    const head = { runner: "mini", gen: 1, epoch: 0 };
    const body = { proto: PROTO, gen: 1, label: "mini", hostId: "h", cmdAck: 0 };
    const hello = runnerControl(head, "hello", { ...body, workspaces: [{ repo: "acme/app", path: "/w/app" }], worktreeRoot: "/w/worktrees" });
    expect(validateFrame(JSON.parse(JSON.stringify(hello)), "runner").type).toBe("hello");
    expect(() => validateFrame(JSON.parse(JSON.stringify({ ...hello, body: { ...hello.body, worktreeRoot: 7 } })), "runner")).toThrow();
    expect(hub.hello(hello).ok).toBe(true);
    const want = { declared: [{ repo: "acme/app", path: "/w/app" }], detected: [], worktreeRoot: "/w/worktrees" };
    expect(hub.runner("mini")?.workspaces).toEqual(want);
    expect(hub.hello(runnerControl({ ...head, gen: 2 }, "hello", { ...body, gen: 2 })).ok).toBe(true);
    expect(hub.runner("mini")?.workspaces).toEqual(want);
    expect(hub.hello(runnerControl({ ...head, gen: 3 }, "hello", { ...body, gen: 3, worktreeRoot: "/w/other" })).ok).toBe(true);
    expect(hub.runner("mini")?.workspaces).toEqual({ declared: [], detected: [], worktreeRoot: "/w/other" });
    hub.close();
    expect(runnerPlacements(readRunnerRows(dir), () => true)).toEqual([{ machine: "mini", online: true, declared: [], detected: [], worktreeRoot: "/w/other" }]);
    expect(runnerWorktreeRoot(dir, "mini")).toBe("/w/other");
    expect(runnerWorktreeRoot(dir, "local")).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("placementLine names the machine, source and matched rule", () => {
  expect(placementLine({ machine: "local", source: "default", movable: true })).toBe("PLACEMENT machine=local source=default");
  expect(placementLine({ machine: "big", source: "workspace", rule: "*", movable: false })).toBe("PLACEMENT machine=big source=workspace rule=*");
  expect(placementLine({ machine: "mini", source: "flag", movable: false })).toBe("PLACEMENT machine=mini source=flag");
});
