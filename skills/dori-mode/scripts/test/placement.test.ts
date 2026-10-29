import { expect, test } from "bun:test";

import { defaultConfig, type GuardThresholds, type PlacementConfig } from "../src/config.ts";
import type { HostSample } from "../src/host-guard.ts";
import { checkMachine, LOCAL_MACHINE, machineVerdict, placementLine, resolvePlacement, verdictLine } from "../src/placement.ts";
import type { GuardMachine, MachineSample, SampleResult } from "../src/remote-guard.ts";
import type { Ran, Runner } from "../src/run.ts";

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

const ran = (code: number, out = ""): Ran => ({ code, out, err: "" });
const panesJson = (n: number): string => JSON.stringify({ result: { panes: Array.from({ length: n }, (_, i) => ({ pane_id: `p${i}` })) } });

/** A runner answering `herdr --machine <label> pane list` from `panes`; every call is recorded. */
const remoteRunner = (panes: Record<string, Ran>, calls: string[][]): Runner => async (argv) => {
  calls.push([...argv]);
  if (argv[0] === "herdr" && argv[1] === "--machine" && argv[3] === "pane" && argv[4] === "list") return panes[argv[2]!] ?? ran(1);
  return ran(1);
};

const MACHINES: GuardMachine[] = [{ label: "big", target: "ana@big" }];
const deps = (result: SampleResult) => ({ listMachines: async () => MACHINES, sampleMachine: async () => result });
const cfg = { ...defaultConfig("/home/test"), stateDir: "/state" };

test("checkMachine local samples the host on the disk guard path and applies canLaunch", async () => {
  const seen: string[] = [];
  const host: HostSample = { load1: 500, memFreePct: 50, diskFreeGb: 100, swapFreeGb: 1, swapTotalGb: 2, panes: T.panesMax };
  const c = await checkMachine(remoteRunner({}, []), cfg, "local", { sampleHost: async (_run, path) => { seen.push(path); return host; } });
  expect(seen).toEqual(["/state"]);
  expect(c).toEqual({ machine: "local", verdict: { ok: false, reasons: [`panes ${T.panesMax} >= ${T.panesMax}`] }, summary: `memory free 50%, disk free 100 GB, panes ${T.panesMax}` });
});

test("checkMachine remote counts panes from herdr --machine <label> pane list", async () => {
  const calls: string[][] = [];
  const c = await checkMachine(remoteRunner({ big: ran(0, panesJson(2)) }, calls), cfg, "big", deps(sample()));
  expect(c).toEqual({ machine: "big", verdict: { ok: true, reasons: [] }, summary: "memory free 60%, disk free 200 GB, panes 2" });
  expect(calls).toContainEqual(["herdr", "--machine", "big", "pane", "list"]);
});

test("checkMachine remote: a failed or malformed pane list is unreadable and holds", async () => {
  for (const answer of [ran(1), ran(0, "not json"), ran(0, JSON.stringify({ result: {} }))]) {
    const c = await checkMachine(remoteRunner({ big: answer }, []), cfg, "big", deps(sample()));
    expect(c.verdict).toEqual({ ok: false, reasons: ["pane count unreadable"] });
  }
});

test("checkMachine remote: an unreachable machine holds with an empty summary", async () => {
  const c = await checkMachine(remoteRunner({ big: ran(0, panesJson(0)) }, []), cfg, "big", deps({ ok: false, detail: "ssh exit 255" }));
  expect(c).toEqual({ machine: "big", verdict: { ok: false, reasons: ["machine big unreachable: ssh exit 255"] }, summary: "" });
});

test("checkMachine remote: an unknown machine holds without sampling", async () => {
  const calls: string[][] = [];
  let sampled = false;
  const c = await checkMachine(remoteRunner({}, calls), cfg, "ghost", { listMachines: async () => MACHINES, sampleMachine: async () => { sampled = true; return sample(); } });
  expect(c).toEqual({ machine: "ghost", verdict: { ok: false, reasons: ["unknown machine ghost; see dori guard machines"] }, summary: "" });
  expect(sampled).toBe(false);
  expect(calls).toEqual([]);
});

test("checkMachine remote finds the label through the real listing (herdr list merged with guardMachines)", async () => {
  const run: Runner = async (argv) => {
    if (argv.join(" ") === "herdr machine list --json") return ran(0, JSON.stringify([{ label: "big", ssh_target: "ana@big" }]));
    if (argv[1] === "--machine") return ran(0, panesJson(1));
    return ran(1);
  };
  const c = await checkMachine(run, { ...cfg, guardMachines: { extra: "ana@extra" } }, "extra", { sampleMachine: async (_r, m) => { expect(m).toEqual({ label: "extra", target: "ana@extra" }); return sample(); } });
  expect(c.verdict.ok).toBe(true);
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
