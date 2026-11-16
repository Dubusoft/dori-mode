import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GuardThresholds } from "../src/config.ts";
import {
  clearShellModes,
  type GuardMachine,
  type MachineGuardState,
  type MachineSample,
  listGuardMachines,
  loadMachineGuardState,
  machineBackoffMs,
  machineGuardTick,
  parseMachineList,
  readGuardMachines,
  removeGuardAgents,
  saveMachineGuardState,
  sshArgv,
} from "../src/remote-guard.ts";
import type { Ran, RunOptions, Runner } from "../src/run.ts";
import { writeRunnerMachine } from "../src/runner/machines.ts";

type Call = { argv: string[]; opts: RunOptions | undefined };

/** A Runner answering each call from `answer`, recording argv and options; a fresh fake forgets every machine's shell mode and its login shell answers the POSIX probe. */
const fake = (answer: (argv: readonly string[], n: number) => Ran): { run: Runner; calls: Call[] } => {
  clearShellModes();
  const calls: Call[] = [];
  const run: Runner = async (argv, opts) => {
    calls.push({ argv: [...argv], opts });
    if (argv.at(-1)?.startsWith("x=6;")) return ok("DORI_POSIX_42");
    return answer(argv, calls.length - 1);
  };
  return { run, calls };
};

const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
const mac: GuardMachine = { label: "mac mini", target: "me@mac" };
const T: GuardThresholds = { loadAlert: 10, loadOk: 4, memFreeMinPct: 10, diskFreeMinGb: 20, panesMax: 5, memFreeCritPct: 5, swapFreeCritPct: 5 };
const healthy: MachineSample = { os: "darwin", load1: 1, memFreePct: 50, swapFreeGb: 2, swapTotalGb: 4, diskFreeGb: 100 };

test("parseMachineList accepts the known shapes", () => {
  expect(parseMachineList(JSON.stringify([{ label: "a", ssh_target: "u@a" }, { id: "b" }]))).toEqual([
    { label: "a", target: "u@a" },
    { label: "b", target: "b", id: "b" },
  ]);
  expect(parseMachineList(JSON.stringify([{ id: "m-7", label: "mac", ssh_target: "u@m" }]))).toEqual([{ label: "mac", target: "u@m", id: "m-7" }]);
  expect(parseMachineList(JSON.stringify({ machines: [{ label: "a", target: "t" }] }))).toEqual([{ label: "a", target: "t" }]);
  expect(parseMachineList(JSON.stringify({ result: { machines: [{ label: "a", ssh: "s" }] } }))).toEqual([{ label: "a", target: "s" }]);
  expect(parseMachineList(JSON.stringify({ profiles: [{ label: "a", host: "h" }, { label: "off", enabled: false }, { nothing: 1 }] })))
    .toEqual([{ label: "a", target: "h" }]);
  expect(parseMachineList(JSON.stringify({ other: 1 }))).toEqual([]);
});

test("listGuardMachines merges overrides and sorts; herdr failure yields only overrides", async () => {
  const good = fake(() => ok(JSON.stringify({ machines: [{ label: "z", target: "z1" }, { label: "a", target: "a1" }] })));
  expect(await listGuardMachines(good.run, { a: "a2", m: "m1" })).toEqual([
    { label: "a", target: "a2" },
    { label: "m", target: "m1" },
    { label: "z", target: "z1" },
  ]);
  expect(good.calls[0]!.argv).toEqual(["herdr", "machine", "list", "--json"]);
  expect(await listGuardMachines(fake(() => ({ code: 1, out: "", err: "no" })).run, { x: "x1" })).toEqual([{ label: "x", target: "x1" }]);
  expect(await listGuardMachines(fake(() => ok("not json")).run, {})).toEqual([]);
});

test("readGuardMachines reports a herdr failure or invalid JSON as not ok, with only the overrides; an override keeps the id", async () => {
  expect(await readGuardMachines(fake(() => ({ code: 1, out: "", err: "herdr: down\nmore" })).run, { x: "x1" }))
    .toEqual({ ok: false, detail: "herdr: down", machines: [{ label: "x", target: "x1" }] });
  const bad = await readGuardMachines(fake(() => ok("not json")).run, {});
  expect(bad.ok).toBe(false);
  expect(bad.ok ? "" : bad.detail).toStartWith("invalid JSON: ");
  expect(await readGuardMachines(fake(() => ok(JSON.stringify([{ id: "m1", label: "a", target: "a1" }]))).run, { a: "a2" }))
    .toEqual({ ok: true, machines: [{ label: "a", target: "a2", id: "m1" }] });
});

test("readGuardMachines adds the runner-machines state file at the lowest precedence: herdr and overrides replace it by label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-rm-"));
  try {
    writeRunnerMachine(dir, "w1", "me@100.64.1.2");
    writeRunnerMachine(dir, "a", "state-a");
    writeRunnerMachine(dir, "b", "state-b");
    const herdr = fake(() => ok(JSON.stringify([{ id: "m1", label: "a", target: "herdr-a" }])));
    expect((await readGuardMachines(herdr.run, { b: "override-b" }, dir)).machines).toEqual([
      { label: "a", target: "herdr-a", id: "m1" }, { label: "b", target: "override-b" }, { label: "w1", target: "me@100.64.1.2" },
    ]);
    // A herdr failure still lists the state machines; without a stateDir they are not read.
    expect(await listGuardMachines(fake(() => ({ code: 1, out: "", err: "down" })).run, {}, dir)).toHaveLength(3);
    expect(await listGuardMachines(fake(() => ok("[]")).run, {})).toEqual([]);
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
    expect(existsSync(`${path}.tmp.${process.pid}`)).toBe(false);
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

const POSIX_RM = (argv: readonly string[]): boolean => (argv.at(-1) ?? "").includes("guard-agent.version") && !(argv.at(-1) ?? "").startsWith("powershell");

test("removeGuardAgents: removed, nothing there, unreachable and failed POSIX machines", async () => {
  const machines: GuardMachine[] = [
    { label: "old", target: "o" }, { label: "clean", target: "c" }, { label: "down", target: "d" }, { label: "odd", target: "x" },
  ];
  const f = fake((argv) => {
    const target = argv[6];
    if (target === "d") return { code: 255, out: "", err: "ssh: connect to host d port 22: Connection timed out" };
    if (argv.at(-1) === "uname -s") return ok("Linux");
    if (!POSIX_RM(argv)) return { code: 9, out: "", err: `unexpected ${argv.at(-1)}` };
    if (target === "o") return ok("motd\nguard-agent.sh\nguard-agent.version\n");
    if (target === "x") return { code: 1, out: "", err: "rm: cannot remove: Permission denied" };
    return ok("");
  });
  const logs: string[] = [];
  expect(await removeGuardAgents(f.run, machines, (l) => logs.push(l))).toBe(2);
  expect(logs.sort()).toEqual([
    "GUARD_AGENT_FAILED odd remove failed (exit 1): rm: cannot remove: Permission denied",
    "GUARD_AGENT_REMOVED old guard-agent.sh,guard-agent.version",
    "GUARD_AGENT_UNREACHABLE down ssh: connect to host d port 22: Connection timed out",
  ]);
  const rm = f.calls.find((c) => c.argv[6] === "o" && POSIX_RM(c.argv))!;
  expect(rm.argv.slice(0, 7)).toEqual(sshArgv("o", "").slice(0, 7));
  for (const name of ["guard-agent.sh", "guard-agent.ps1", "guard-agent.version"]) expect(rm.argv[7]).toContain(name);
  expect(rm.argv[7]).toContain('"$HOME/.dori/$f"');
});

test("removeGuardAgents: a Windows machine removes under %USERPROFILE%\\.dori; one with no usable shell is skipped, not failed", async () => {
  clearShellModes();
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    const [target, cmd] = [argv[6], argv.at(-1) ?? ""];
    if (cmd.startsWith("x=6;")) return { code: 1, out: "", err: "'x' is not recognized as an internal or external command," };
    if (target === "win" && cmd.startsWith("powershell")) {
      const snippet = Buffer.from(cmd.split(" ").at(-1)!, "base64").toString("utf16le");
      if (snippet.includes("DORI_PS_")) return ok("DORI_PS_42\r\n");
      expect(snippet).toContain("Join-Path $env:USERPROFILE '.dori'");
      expect(snippet).toContain("'guard-agent.sh', 'guard-agent.ps1', 'guard-agent.version'");
      return ok("guard-agent.ps1\r\nguard-agent.version\r\n");
    }
    return { code: 1, out: "", err: "nope" };
  };
  const logs: string[] = [];
  expect(await removeGuardAgents(run, [{ label: "win", target: "win" }, { label: "box", target: "box" }], (l) => logs.push(l))).toBe(0);
  expect(logs.sort()).toEqual([
    "GUARD_AGENT_REMOVED win guard-agent.ps1,guard-agent.version",
    "GUARD_AGENT_SKIPPED box unsupported remote shell (no POSIX sh or PowerShell): 'x' is not recognized as an internal or external command,",
  ]);
  // The skipped machine only got the two shell probes.
  expect(calls.filter((c) => c[6] === "box")).toHaveLength(2);
});
