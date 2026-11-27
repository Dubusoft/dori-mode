import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { GuardThresholds } from "../src/config.ts";
import {
  type GuardMachine,
  type MachineGuardState,
  type MachineSample,
  listGuardMachines,
  loadMachineGuardState,
  machineBackoffMs,
  machineGuardTick,
  saveMachineGuardState,
  sshArgv,
} from "../src/remote-guard.ts";
import { writeRunnerMachine } from "../src/runner/machines.ts";

const mac: GuardMachine = { label: "mac mini", target: "me@mac" };
const T: GuardThresholds = { loadAlert: 10, loadOk: 4, memFreeMinPct: 10, diskFreeMinGb: 20, panesMax: 5, memFreeCritPct: 5, swapFreeCritPct: 5 };
const healthy: MachineSample = { os: "darwin", load1: 1, memFreePct: 50, swapFreeGb: 2, swapTotalGb: 4, diskFreeGb: 100 };

test("listGuardMachines merges config overrides and sorts by label", () => {
  expect(listGuardMachines({ z: "z1", a: "a2", m: "m1" })).toEqual([
    { label: "a", target: "a2" },
    { label: "m", target: "m1" },
    { label: "z", target: "z1" },
  ]);
  expect(listGuardMachines({})).toEqual([]);
});

test("listGuardMachines reads the runner-machines state file at the lowest precedence: overrides replace it by label", () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-rm-"));
  try {
    writeRunnerMachine(dir, "w1", "me@100.64.1.2");
    writeRunnerMachine(dir, "b", "state-b");
    expect(listGuardMachines({ b: "override-b", a: "a1" }, dir)).toEqual([
      { label: "a", target: "a1" }, { label: "b", target: "override-b" }, { label: "w1", target: "me@100.64.1.2" },
    ]);
    // Without a stateDir the state file is not read.
    expect(listGuardMachines({})).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sshArgv keeps the target after --", () => {
  expect(sshArgv("t", "c")).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "t", "c"]);
  // A target that looks like an option stays a target.
  expect(sshArgv("-oProxyCommand=x", "c").slice(-3)).toEqual(["--", "-oProxyCommand=x", "c"]);
});

test("machineBackoffMs: 2 min, doubling, at most 30 min", () => {
  expect([1, 2, 3, 4, 5, 6, 9].map(machineBackoffMs)).toEqual([2, 4, 8, 16, 30, 30, 30].map((m) => m * 60_000));
});

test("machineGuardTick: first sight reports only an ALERT", () => {
  const state: MachineGuardState = new Map();
  const ms = (label: string) => ({ label, target: label });
  const lines = machineGuardTick([
    { machine: ms("fine"), sample: healthy },
    { machine: ms("hot box"), sample: { ...healthy, load1: 12, diskFreeGb: 5 } },
  ], T, state);
  expect(lines).toEqual(["HOST_GUARD ALERT machine=hot_box load 12 > 10 | disk free 5 GB < 20 GB"]);
  expect(state.get("fine")).toEqual({ alerting: false });
  expect(state.get("hot box")).toEqual({ alerting: true });
});

test("machine guard state survives a save and load; an old file loads, a missing or corrupt one is empty state", () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-mguard-"));
  try {
    const path = join(dir, "sub", "machine-guard.json");
    expect(loadMachineGuardState(path).size).toBe(0);
    const state: MachineGuardState = new Map();
    machineGuardTick([{ machine: mac, sample: { ...healthy, memFreePct: 5 } }], T, state);
    saveMachineGuardState(path, state);
    expect(readdirSync(dirname(path))).toEqual(["machine-guard.json"]);
    const loaded = loadMachineGuardState(path);
    expect(loaded).toEqual(state);
    // Reloaded state does not report the ALERT again.
    expect(machineGuardTick([{ machine: mac, sample: { ...healthy, memFreePct: 5 } }], T, loaded)).toEqual([]);
    // A file written before the agent was removed keeps its alert state; the old fields are ignored.
    writeFileSync(path, JSON.stringify({ "mac mini": { alerting: true, offline: true, outdated: true, notInstalled: false, unsupported: false, failures: 3, nextAttemptAt: 9 } }));
    expect(loadMachineGuardState(path)).toEqual(new Map([["mac mini", { alerting: true }]]));
    writeFileSync(path, "{not json");
    expect(loadMachineGuardState(path).size).toBe(0);
    writeFileSync(path, "[1]");
    expect(loadMachineGuardState(path).size).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("machineGuardTick: an ALERT carries the machine's detail after '; ', a CLEAR none", () => {
  const state: MachineGuardState = new Map();
  const detail = (m: { label: string }) => (m.label === "mac mini" ? "lanes on this machine: app-1" : undefined);
  const tick = (s: MachineSample) => machineGuardTick([{ machine: mac, sample: s }], T, state, detail);
  expect(tick({ ...healthy, memFreePct: 5 })).toEqual(["HOST_GUARD ALERT machine=mac_mini memory free 5% < 10%; lanes on this machine: app-1"]);
  expect(tick(healthy)).toEqual(["HOST_GUARD CLEAR machine=mac_mini load 1, memory free 50%, disk free 100 GB, swap free 2.0 GB"]);
});

test("machineGuardTick: unknown (-1) metrics never alert", () => {
  const state: MachineGuardState = new Map();
  const unknown = { ...healthy, load1: -1, memFreePct: -1, swapFreeGb: -1, diskFreeGb: -1 };
  expect(machineGuardTick([{ machine: mac, sample: unknown }], T, state)).toEqual([]);
});

test("machineGuardTick: alert -> clear, emitting only on change; machines absent from a tick keep their state", () => {
  const state: MachineGuardState = new Map();
  const tick = (s: MachineSample) => machineGuardTick([{ machine: mac, sample: s }], T, state);
  expect(tick({ ...healthy, memFreePct: 5 })).toEqual(["HOST_GUARD ALERT machine=mac_mini memory free 5% < 10%"]);
  expect(tick({ ...healthy, memFreePct: 4 })).toEqual([]);
  expect(machineGuardTick([], T, state)).toEqual([]);
  expect(state.get("mac mini")).toEqual({ alerting: true });
  expect(tick({ ...healthy, swapFreeGb: 1.25 })).toEqual(["HOST_GUARD CLEAR machine=mac_mini load 1, memory free 50%, disk free 100 GB, swap free 1.3 GB"]);
  expect(tick(healthy)).toEqual([]);
});
