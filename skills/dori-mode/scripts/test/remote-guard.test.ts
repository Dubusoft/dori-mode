import { expect, test } from "bun:test";

import type { GuardThresholds } from "../src/config.ts";
import {
  GUARD_AGENT_TEMPLATE,
  type GuardMachine,
  type MachineGuardState,
  type MachineSample,
  guardAgentVersion,
  installGuardAgent,
  listGuardMachines,
  machineGuardTick,
  parseAgentSample,
  parseMachineList,
  refreshGuardAgents,
  sampleMachine,
  sshArgv,
} from "../src/remote-guard.ts";
import type { Ran, RunOptions, Runner } from "../src/run.ts";

type Call = { argv: string[]; opts: RunOptions | undefined };

/** A Runner answering each call from `answer`, recording argv and options. */
const fake = (answer: (argv: readonly string[], n: number) => Ran): { run: Runner; calls: Call[] } => {
  const calls: Call[] = [];
  const run: Runner = async (argv, opts) => {
    calls.push({ argv: [...argv], opts });
    return answer(argv, calls.length - 1);
  };
  return { run, calls };
};

const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
const sampleLine = (v: string, extra = "load1=1.5 mem_free_pct=40 swap_free_gb=2.0 disk_free_gb=100") => `DORI_GUARD_SAMPLE version=${v} os=darwin ${extra}`;
const mac: GuardMachine = { label: "mac mini", target: "me@mac" };
const T: GuardThresholds = { loadAlert: 10, loadOk: 4, memFreeMinPct: 10, diskFreeMinGb: 20, panesMax: 5 };
const healthy: MachineSample = { version: "v1", os: "darwin", load1: 1, memFreePct: 50, swapFreeGb: 2, diskFreeGb: 100 };

test("template path and version", () => {
  expect(GUARD_AGENT_TEMPLATE.endsWith("/templates/guard-agent.sh")).toBe(true);
  expect(guardAgentVersion("abc")).toBe("ba7816bf8f01");
});

test("parseMachineList accepts the known shapes", () => {
  expect(parseMachineList(JSON.stringify([{ label: "a", ssh_target: "u@a" }, { id: "b" }]))).toEqual([
    { label: "a", target: "u@a" },
    { label: "b", target: "b" },
  ]);
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

test("parseAgentSample reads the sample line, keeps -1 values, rejects junk", () => {
  expect(parseAgentSample(`motd\n${sampleLine("abc", "load1=-1 mem_free_pct=-1 swap_free_gb=-1 disk_free_gb=12.5")}\n`)).toEqual({
    version: "abc", os: "darwin", load1: -1, memFreePct: -1, swapFreeGb: -1, diskFreeGb: 12.5,
  });
  expect(parseAgentSample("nothing")).toBeUndefined();
  expect(parseAgentSample(sampleLine("abc", "load1=x mem_free_pct=1 swap_free_gb=1 disk_free_gb=1"))).toBeUndefined();
  expect(parseAgentSample(sampleLine("abc", "load1=1 mem_free_pct=1 swap_free_gb=1"))).toBeUndefined();
});

test("sampleMachine runs the agent over ssh and maps failures", async () => {
  const good = fake(() => ok(sampleLine("v1")));
  expect(await sampleMachine(good.run, mac)).toEqual({ ok: true, sample: { version: "v1", os: "darwin", load1: 1.5, memFreePct: 40, swapFreeGb: 2, diskFreeGb: 100 } });
  expect(await sampleMachine(fake(() => ({ ...ok(sampleLine("v1")), err: "bash: /x: No such file or directory" })).run, mac))
    .toEqual({ ok: true, sample: { version: "v1", os: "darwin", load1: 1.5, memFreePct: 40, swapFreeGb: 2, diskFreeGb: 100 } });
  expect(good.calls[0]).toEqual({ argv: sshArgv("me@mac", 'sh "$HOME/.dori/guard-agent.sh" sample'), opts: { timeoutMs: 20_000 } });
  expect(sshArgv("t", "c")).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "t", "c"]);

  const detail = async (r: Ran) => {
    const res = await sampleMachine(fake(() => r).run, mac);
    return res.ok ? "ok" : res.detail;
  };
  expect(await detail({ code: 255, out: "", err: "ssh: connect to host mac port 22: No route to host\nmore" }))
    .toBe("unreachable: ssh: connect to host mac port 22: No route to host");
  expect(await detail({ code: 124, out: "", err: "timed out after 20000 ms", timedOut: true })).toBe("unreachable: timed out after 20000 ms");
  expect(await detail({ code: 127, out: "", err: "sh: not found" })).toBe("guard agent not installed; run dori guard install --machine mac mini");
  expect(await detail({ code: 2, out: "", err: "sh: 0: Can't open /home/me/.dori/guard-agent.sh" })).toBe("guard agent not installed; run dori guard install --machine mac mini");
  expect(await detail(ok("garbage"))).toBe("bad sample: garbage");
});

test("installGuardAgent writes both files in one heredoc call, then checks the version", async () => {
  const script = "#!/bin/sh\necho hi\n";
  const v = guardAgentVersion(script);
  const f = fake((_argv, n) => (n === 0 ? ok() : ok(sampleLine(v))));
  expect(await installGuardAgent(f.run, mac, script)).toEqual({ ok: true, version: v });
  expect(f.calls).toHaveLength(2);
  const [first, second] = f.calls;
  expect(first!.opts).toEqual({ timeoutMs: 30_000 });
  expect(second!.opts).toEqual({ timeoutMs: 30_000 });
  expect(first!.argv.slice(0, 6)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "me@mac"]);
  expect(first!.argv[6]).toBe([
    "umask 077",
    'mkdir -p "$HOME/.dori" || exit 1',
    `cat > "$HOME/.dori/guard-agent.sh" <<'DORI_GUARD_EOF' || exit 1`,
    "#!/bin/sh",
    "echo hi",
    "DORI_GUARD_EOF",
    `printf '%s\\n' '${v}' > "$HOME/.dori/guard-agent.version" || exit 1`,
  ].join("\n"));
  expect(second!.argv.at(-1)).toBe('sh "$HOME/.dori/guard-agent.sh" sample');

  const mismatch = await installGuardAgent(fake((_a, n) => (n === 0 ? ok() : ok(sampleLine("old")))).run, mac, script);
  expect(mismatch).toEqual({ ok: false, detail: `version check failed: have=old want=${v}` });
  const down = await installGuardAgent(fake(() => ({ code: 255, out: "", err: "Connection refused" })).run, mac, script);
  expect(down).toEqual({ ok: false, detail: "unreachable: Connection refused" });
  await expect(installGuardAgent(f.run, mac, "a\nDORI_GUARD_EOF\nb")).rejects.toThrow("heredoc delimiter");
});

test("machineGuardTick: first sight reports only problems", () => {
  const state: MachineGuardState = new Map();
  const ms = (label: string) => ({ label, target: label });
  const lines = machineGuardTick([
    { machine: ms("fine"), result: { ok: true, sample: healthy } },
    { machine: ms("hot box"), result: { ok: true, sample: { ...healthy, load1: 12, diskFreeGb: 5 } } },
    { machine: ms("old"), result: { ok: true, sample: { ...healthy, version: "v0" } } },
    { machine: ms("gone"), result: { ok: false, detail: "unreachable: no route\nsecond" } },
  ], T, "v1", state);
  expect(lines).toEqual([
    "HOST_GUARD ALERT machine=hot_box load 12 > 10 | disk free 5 GB < 20 GB",
    "HOST_GUARD OUTDATED machine=old have=v0 want=v1; run dori update or dori guard install --machine old",
    "HOST_GUARD OFFLINE machine=gone unreachable: no route second",
  ]);
  expect(state.get("fine")).toEqual({ alerting: false, offline: false, outdated: false });
});

test("machineGuardTick: an ALERT carries the machine's detail after '; ', a CLEAR none", () => {
  const state: MachineGuardState = new Map();
  const detail = (m: { label: string }) => (m.label === "mac mini" ? "lanes on this machine: app-1" : undefined);
  const tick = (s: MachineSample) => machineGuardTick([{ machine: mac, result: { ok: true, sample: s } }], T, "v1", state, detail);
  expect(tick({ ...healthy, memFreePct: 5 })).toEqual(["HOST_GUARD ALERT machine=mac_mini memory free 5% < 10%; lanes on this machine: app-1"]);
  expect(tick(healthy)).toEqual(["HOST_GUARD CLEAR machine=mac_mini load 1, memory free 50%, disk free 100 GB, swap free 2.0 GB"]);
});

test("machineGuardTick: unknown (-1) metrics never alert", () => {
  const state: MachineGuardState = new Map();
  const unknown = { ...healthy, load1: -1, memFreePct: -1, swapFreeGb: -1, diskFreeGb: -1 };
  expect(machineGuardTick([{ machine: mac, result: { ok: true, sample: unknown } }], T, "v1", state)).toEqual([]);
});

test("machineGuardTick: alert -> clear, emitting only on change", () => {
  const state: MachineGuardState = new Map();
  const tick = (s: MachineSample) => machineGuardTick([{ machine: mac, result: { ok: true, sample: s } }], T, "v1", state);
  expect(tick({ ...healthy, memFreePct: 5 })).toEqual(["HOST_GUARD ALERT machine=mac_mini memory free 5% < 10%"]);
  expect(tick({ ...healthy, memFreePct: 4 })).toEqual([]);
  expect(tick({ ...healthy, swapFreeGb: 1.25 })).toEqual(["HOST_GUARD CLEAR machine=mac_mini load 1, memory free 50%, disk free 100 GB, swap free 1.3 GB"]);
  expect(tick(healthy)).toEqual([]);
});

test("machineGuardTick: offline keeps alert and outdated state; online resumes", () => {
  const state: MachineGuardState = new Map();
  const tick = (result: Parameters<typeof machineGuardTick>[0][number]["result"]) => machineGuardTick([{ machine: mac, result }], T, "v1", state);
  expect(tick({ ok: true, sample: { ...healthy, version: "v0", load1: 20 } })).toEqual([
    "HOST_GUARD ALERT machine=mac_mini load 20 > 10",
    "HOST_GUARD OUTDATED machine=mac_mini have=v0 want=v1; run dori update or dori guard install --machine mac mini",
  ]);
  expect(tick({ ok: false, detail: "unreachable: timeout" })).toEqual(["HOST_GUARD OFFLINE machine=mac_mini unreachable: timeout"]);
  expect(tick({ ok: false, detail: "unreachable: still" })).toEqual([]);
  expect(state.get("mac mini")).toEqual({ alerting: true, offline: true, outdated: true });
  // Back with the same problems: only ONLINE.
  expect(tick({ ok: true, sample: { ...healthy, version: "v0", load1: 20 } })).toEqual(["HOST_GUARD ONLINE machine=mac_mini"]);
  // Updated and healthy: CLEAR; becoming current emits nothing itself.
  expect(tick({ ok: true, sample: healthy })).toEqual(["HOST_GUARD CLEAR machine=mac_mini load 1, memory free 50%, disk free 100 GB, swap free 2.0 GB"]);
  expect(state.get("mac mini")).toEqual({ alerting: false, offline: false, outdated: false });
  // Outdated again later is reported again.
  expect(tick({ ok: true, sample: { ...healthy, version: "v2" } })).toEqual([
    "HOST_GUARD OUTDATED machine=mac_mini have=v2 want=v1; run dori update or dori guard install --machine mac mini",
  ]);
});

test("machineGuardTick: first sight offline, then online with an alert", () => {
  const state: MachineGuardState = new Map();
  const tick = (result: Parameters<typeof machineGuardTick>[0][number]["result"]) => machineGuardTick([{ machine: mac, result }], T, "v1", state);
  expect(tick({ ok: false, detail: "guard agent not installed" })).toEqual(["HOST_GUARD OFFLINE machine=mac_mini guard agent not installed"]);
  expect(tick({ ok: true, sample: { ...healthy, diskFreeGb: 3 } })).toEqual([
    "HOST_GUARD ONLINE machine=mac_mini",
    "HOST_GUARD ALERT machine=mac_mini disk free 3 GB < 20 GB",
  ]);
});

test("refreshGuardAgents: current, updated, failed", async () => {
  const script = "#!/bin/sh\n";
  const v = guardAgentVersion(script);
  const machines: GuardMachine[] = [{ label: "cur", target: "c" }, { label: "old", target: "o" }, { label: "new", target: "n" }, { label: "down", target: "d" }];
  const f = fake((argv) => {
    const [target, cmd] = [argv[5], argv[6] ?? ""];
    if (target === "d") return { code: 255, out: "", err: "Connection timed out" };
    if (cmd.startsWith("cat ")) return target === "c" ? ok(v) : target === "o" ? ok("aaaaaaaaaaaa") : { code: 1, out: "", err: "No such file" };
    if (cmd.endsWith(" sample")) return ok(sampleLine(v));
    return ok();
  });
  const logs: string[] = [];
  expect(await refreshGuardAgents(f.run, machines, script, (l) => logs.push(l))).toBe(1);
  expect(logs.sort()).toEqual([
    `GUARD_AGENT_CURRENT cur ${v}`,
    "GUARD_AGENT_FAILED down unreachable: Connection timed out",
    `GUARD_AGENT_UPDATED new none..${v}`,
    `GUARD_AGENT_UPDATED old aaaaaaaaaaaa..${v}`,
  ]);
  expect(f.calls.find((c) => c.argv[5] === "c")!.argv[6]).toBe('cat "$HOME/.dori/guard-agent.version"');
  expect(f.calls.filter((c) => c.argv[5] === "c")).toHaveLength(1);
});
