import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GuardThresholds } from "../src/config.ts";
import {
  clearShellModes,
  GUARD_AGENT_TEMPLATE,
  type GuardMachine,
  type MachineGuardState,
  type MachineSample,
  guardAgentVersion,
  installGuardAgent,
  listGuardMachines,
  loadMachineGuardState,
  machineBackoffMs,
  machineDue,
  machineGuardTick,
  parseAgentSample,
  parseMachineList,
  readGuardMachines,
  refreshGuardAgents,
  saveMachineGuardState,
  sampleMachine,
  sshArgv,
} from "../src/remote-guard.ts";
import type { Ran, RunOptions, Runner } from "../src/run.ts";

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
const sampleLine = (v: string, extra = "load1=1.5 mem_free_pct=40 swap_free_gb=2.0 disk_free_gb=100") => `DORI_GUARD_SAMPLE version=${v} os=darwin ${extra}`;
const mac: GuardMachine = { label: "mac mini", target: "me@mac" };
const T: GuardThresholds = { loadAlert: 10, loadOk: 4, memFreeMinPct: 10, diskFreeMinGb: 20, panesMax: 5, memFreeCritPct: 5, swapFreeCritPct: 5 };
const healthy: MachineSample = { version: "v1", os: "darwin", load1: 1, memFreePct: 50, swapFreeGb: 2, swapTotalGb: 4, diskFreeGb: 100 };
const settled = { notInstalled: false, unsupported: false, failures: 0, nextAttemptAt: 0 };

test("template path and version", () => {
  expect(GUARD_AGENT_TEMPLATE.endsWith("/templates/guard-agent.sh")).toBe(true);
  expect(guardAgentVersion("abc")).toBe("ba7816bf8f01");
});

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

test("parseAgentSample reads the sample line, keeps -1 values, rejects junk", () => {
  expect(parseAgentSample(`motd\n${sampleLine("abc", "load1=-1 mem_free_pct=-1 swap_free_gb=-1 disk_free_gb=12.5")}\n`)).toEqual({
    version: "abc", os: "darwin", load1: -1, memFreePct: -1, swapFreeGb: -1, swapTotalGb: -1, diskFreeGb: 12.5,
  });
  expect(parseAgentSample(sampleLine("abc", "load1=1 mem_free_pct=1 swap_free_gb=1 swap_total_gb=4.5 disk_free_gb=1"))?.swapTotalGb).toBe(4.5);
  expect(parseAgentSample(sampleLine("abc", "load1=1 mem_free_pct=1 swap_free_gb=1 swap_total_gb=junk disk_free_gb=1"))?.swapTotalGb).toBe(-1);
  expect(parseAgentSample("nothing")).toBeUndefined();
  expect(parseAgentSample(sampleLine("abc", "load1=x mem_free_pct=1 swap_free_gb=1 disk_free_gb=1"))).toBeUndefined();
  expect(parseAgentSample(sampleLine("abc", "load1=1 mem_free_pct=1 swap_free_gb=1"))).toBeUndefined();
});

test("sampleMachine runs the agent over ssh and maps failures", async () => {
  const good = fake(() => ok(sampleLine("v1")));
  expect(await sampleMachine(good.run, mac)).toEqual({ ok: true, sample: { version: "v1", os: "darwin", load1: 1.5, memFreePct: 40, swapFreeGb: 2, swapTotalGb: -1, diskFreeGb: 100 } });
  expect(await sampleMachine(fake(() => ({ ...ok(sampleLine("v1")), err: "bash: /x: No such file or directory" })).run, mac))
    .toEqual({ ok: true, sample: { version: "v1", os: "darwin", load1: 1.5, memFreePct: 40, swapFreeGb: 2, swapTotalGb: -1, diskFreeGb: 100 } });
  expect(good.calls[1]).toEqual({ argv: sshArgv("me@mac", 'sh "$HOME/.dori/guard-agent.sh" sample'), opts: { timeoutMs: 20_000 } });
  expect(sshArgv("t", "c")).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "t", "c"]);
  // A target that looks like an option stays a target.
  expect(sshArgv("-oProxyCommand=x", "c").slice(-3)).toEqual(["--", "-oProxyCommand=x", "c"]);

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

test("installGuardAgent writes both files to temp files and moves them into place in one call, then checks the version", async () => {
  const script = "#!/bin/sh\necho hi\n";
  const v = guardAgentVersion(script);
  const f = fake((_argv, n) => (n === 1 ? ok() : ok(sampleLine(v))));
  expect(await installGuardAgent(f.run, mac, { sh: script, ps: "" })).toEqual({ ok: true, version: v });
  expect(f.calls).toHaveLength(3);
  const [, first, second] = f.calls;
  expect(first!.opts).toEqual({ timeoutMs: 30_000 });
  expect(second!.opts).toEqual({ timeoutMs: 30_000 });
  expect(first!.argv.slice(0, 7)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "me@mac"]);
  expect(first!.argv[7]).toBe([
    "umask 077",
    'mkdir -p "$HOME/.dori" || exit 1',
    `cat > "$HOME/.dori/guard-agent.sh.tmp.$$" <<'DORI_GUARD_EOF' || exit 1`,
    "#!/bin/sh",
    "echo hi",
    "DORI_GUARD_EOF",
    `printf '%s\\n' '${v}' > "$HOME/.dori/guard-agent.version.tmp.$$" || exit 1`,
    'mv -f "$HOME/.dori/guard-agent.sh.tmp.$$" "$HOME/.dori/guard-agent.sh" || exit 1',
    'mv -f "$HOME/.dori/guard-agent.version.tmp.$$" "$HOME/.dori/guard-agent.version" || exit 1',
  ].join("\n"));
  expect(second!.argv.at(-1)).toBe('sh "$HOME/.dori/guard-agent.sh" sample');

  const mismatch = await installGuardAgent(fake((_a, n) => (n === 1 ? ok() : ok(sampleLine("old")))).run, mac, { sh: script, ps: "" });
  expect(mismatch).toEqual({ ok: false, detail: `version check failed: have=old want=${v}` });
  const down = await installGuardAgent(fake(() => ({ code: 255, out: "", err: "Connection refused" })).run, mac, { sh: script, ps: "" });
  expect(down).toEqual({ ok: false, detail: "unreachable: Connection refused" });
  await expect(installGuardAgent(f.run, mac, { sh: "a\nDORI_GUARD_EOF\nb", ps: "" })).rejects.toThrow("heredoc delimiter");
});

test("machineGuardTick: first sight reports only problems", () => {
  const state: MachineGuardState = new Map();
  const ms = (label: string) => ({ label, target: label });
  const lines = machineGuardTick([
    { machine: ms("fine"), result: { ok: true, sample: healthy } },
    { machine: ms("hot box"), result: { ok: true, sample: { ...healthy, load1: 12, diskFreeGb: 5 } } },
    { machine: ms("old"), result: { ok: true, sample: { ...healthy, version: "v0" } } },
    { machine: ms("gone"), result: { ok: false, detail: "unreachable: no route\nsecond" } },
    { machine: ms("bare"), result: { ok: false, detail: "guard agent not installed; run dori guard install --machine bare" } },
  ], T, "v1", state);
  expect(lines).toEqual([
    "HOST_GUARD ALERT machine=hot_box load 12 > 10 | disk free 5 GB < 20 GB",
    "HOST_GUARD OUTDATED machine=old have=v0 want=v1; run dori update or dori guard install --machine old",
    "HOST_GUARD NOT_INSTALLED machine=bare guard agent not installed; run dori guard install --machine bare",
  ]);
  expect(state.get("fine")).toEqual({ alerting: false, offline: false, outdated: false, ...settled });
  // The first failure only counts; the second in a row is OFFLINE.
  expect(state.get("gone")).toMatchObject({ offline: false, failures: 1 });
  expect(machineGuardTick([{ machine: ms("gone"), result: { ok: false, detail: "unreachable: no route" } }], T, "v1", state))
    .toEqual(["HOST_GUARD OFFLINE machine=gone unreachable: no route"]);
});

test("machineGuardTick: a failed machine backs off 2 min, doubling to 30 min; a success samples every round again", () => {
  const state: MachineGuardState = new Map();
  const fail = (now: number) => machineGuardTick([{ machine: mac, result: { ok: false, detail: "unreachable: timeout" } }], T, "v1", state, undefined, now);
  expect([1, 2, 3, 4, 5, 6, 9].map(machineBackoffMs)).toEqual([2, 4, 8, 16, 30, 30, 30].map((m) => m * 60_000));
  expect(machineDue(state, "mac mini", 0)).toBe(true);
  fail(1_000);
  expect(state.get("mac mini")).toMatchObject({ failures: 1, nextAttemptAt: 1_000 + 120_000 });
  expect(machineDue(state, "mac mini", 1_000 + 119_999)).toBe(false);
  expect(machineDue(state, "mac mini", 1_000 + 120_000)).toBe(true);
  fail(200_000);
  expect(state.get("mac mini")).toMatchObject({ failures: 2, offline: true, nextAttemptAt: 200_000 + 240_000 });
  machineGuardTick([{ machine: mac, result: { ok: true, sample: healthy } }], T, "v1", state, undefined, 500_000);
  expect(state.get("mac mini")).toMatchObject({ failures: 0, nextAttemptAt: 0, offline: false });
  expect(machineDue(state, "mac mini", 500_001)).toBe(true);
});

test("machineGuardTick: NOT_INSTALLED once per transition, then ONLINE when the agent answers", () => {
  const state: MachineGuardState = new Map();
  const tick = (result: Parameters<typeof machineGuardTick>[0][number]["result"]) => machineGuardTick([{ machine: mac, result }], T, "v1", state);
  const missing = { ok: false as const, detail: "guard agent not installed; run dori guard install --machine mac mini" };
  expect(tick(missing)).toEqual(["HOST_GUARD NOT_INSTALLED machine=mac_mini guard agent not installed; run dori guard install --machine mac mini"]);
  expect(tick(missing)).toEqual([]);
  expect(state.get("mac mini")).toMatchObject({ notInstalled: true, offline: false, failures: 2 });
  expect(tick({ ok: true, sample: healthy })).toEqual(["HOST_GUARD ONLINE machine=mac_mini"]);
  expect(tick(missing)).toEqual(["HOST_GUARD NOT_INSTALLED machine=mac_mini guard agent not installed; run dori guard install --machine mac mini"]);
});

test("machine guard state survives a save and load; a missing or corrupt file is empty state", () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-mguard-"));
  try {
    const path = join(dir, "sub", "machine-guard.json");
    expect(loadMachineGuardState(path).size).toBe(0);
    const state: MachineGuardState = new Map();
    machineGuardTick([{ machine: mac, result: { ok: false, detail: "unreachable: x" } }], T, "v1", state, undefined, 10);
    machineGuardTick([{ machine: mac, result: { ok: false, detail: "unreachable: x" } }], T, "v1", state, undefined, 20);
    saveMachineGuardState(path, state);
    expect(existsSync(`${path}.tmp.${process.pid}`)).toBe(false);
    const loaded = loadMachineGuardState(path);
    expect(loaded).toEqual(state);
    // Reloaded state does not report the machine OFFLINE again.
    expect(machineGuardTick([{ machine: mac, result: { ok: false, detail: "unreachable: x" } }], T, "v1", loaded, undefined, 30)).toEqual([]);
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
  expect(tick({ ok: false, detail: "unreachable: timeout" })).toEqual([]);
  expect(tick({ ok: false, detail: "unreachable: timeout" })).toEqual(["HOST_GUARD OFFLINE machine=mac_mini unreachable: timeout"]);
  expect(tick({ ok: false, detail: "unreachable: still" })).toEqual([]);
  expect(state.get("mac mini")).toEqual({ alerting: true, offline: true, outdated: true, notInstalled: false, unsupported: false, failures: 3, nextAttemptAt: 8 * 60_000 });
  // Back with the same problems: only ONLINE.
  expect(tick({ ok: true, sample: { ...healthy, version: "v0", load1: 20 } })).toEqual(["HOST_GUARD ONLINE machine=mac_mini"]);
  // Updated and healthy: CLEAR, and CURRENT for the version.
  expect(tick({ ok: true, sample: healthy })).toEqual([
    "HOST_GUARD CLEAR machine=mac_mini load 1, memory free 50%, disk free 100 GB, swap free 2.0 GB",
    "HOST_GUARD CURRENT machine=mac_mini v1",
  ]);
  expect(state.get("mac mini")).toEqual({ alerting: false, offline: false, outdated: false, ...settled });
  expect(tick({ ok: true, sample: healthy })).toEqual([]);
  // Outdated again later is reported again.
  expect(tick({ ok: true, sample: { ...healthy, version: "v2" } })).toEqual([
    "HOST_GUARD OUTDATED machine=mac_mini have=v2 want=v1; run dori update or dori guard install --machine mac mini",
  ]);
});

test("machineGuardTick: first sight offline, then online with an alert", () => {
  const state: MachineGuardState = new Map();
  const tick = (result: Parameters<typeof machineGuardTick>[0][number]["result"]) => machineGuardTick([{ machine: mac, result }], T, "v1", state);
  expect(tick({ ok: false, detail: "sample failed (exit 3): boom" })).toEqual([]);
  expect(tick({ ok: false, detail: "sample failed (exit 3): boom" })).toEqual(["HOST_GUARD OFFLINE machine=mac_mini sample failed (exit 3): boom"]);
  expect(tick({ ok: true, sample: { ...healthy, diskFreeGb: 3 } })).toEqual([
    "HOST_GUARD ONLINE machine=mac_mini",
    "HOST_GUARD ALERT machine=mac_mini disk free 3 GB < 20 GB",
  ]);
});

test("refreshGuardAgents: current, updated, unreachable, failed", async () => {
  const script = "#!/bin/sh\n";
  const v = guardAgentVersion(script);
  const machines: GuardMachine[] = [
    { label: "cur", target: "c" }, { label: "old", target: "o" }, { label: "new", target: "n" }, { label: "down", target: "d" },
    { label: "slow", target: "s" }, { label: "odd", target: "x" }, { label: "empty", target: "e" },
  ];
  const f = fake((argv) => {
    const [target, cmd] = [argv[6], argv[7] ?? ""];
    if (target === "d") return { code: 255, out: "", err: "Connection timed out" };
    if (target === "s") return { code: 124, out: "", err: "timed out after 20000 ms", timedOut: true };
    if (target === "x" && cmd.startsWith("cat ")) return { code: 2, out: "", err: "Permission denied" };
    if (target === "e" && cmd.startsWith("cat ")) return ok("");
    if (cmd.startsWith("cat ")) return target === "c" ? ok(v) : target === "o" ? ok("aaaaaaaaaaaa") : { code: 1, out: "", err: "No such file" };
    if (cmd.endsWith(" sample")) return ok(sampleLine(v));
    return ok();
  });
  const logs: string[] = [];
  expect(await refreshGuardAgents(f.run, machines, { sh: script, ps: "" }, (l) => logs.push(l))).toBe(3);
  expect(logs.sort()).toEqual([
    `GUARD_AGENT_CURRENT cur ${v}`,
    "GUARD_AGENT_FAILED odd version probe failed (exit 2): Permission denied",
    "GUARD_AGENT_UNREACHABLE down Connection timed out",
    "GUARD_AGENT_UNREACHABLE slow timed out after 20000 ms",
    `GUARD_AGENT_UPDATED empty none..${v}`,
    `GUARD_AGENT_UPDATED new none..${v}`,
    `GUARD_AGENT_UPDATED old aaaaaaaaaaaa..${v}`,
  ]);
  expect(f.calls.filter((c) => c.argv[6] === "c").map((c) => c.argv[7])).toEqual(['x=6; echo "DORI_POSIX_$((x*7))"', 'cat "$HOME/.dori/guard-agent.version"']);
  // Unreachable and failed version probes never attempt an install.
  for (const t of ["d", "s", "x"]) expect(f.calls.filter((c) => c.argv[6] === t)).toHaveLength(2);
});

const sh = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawn(["sh", GUARD_AGENT_TEMPLATE, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });

/** Reads `stream` until it contains `needle`; the surrounding test timeout bounds the wait. */
const readUntil = async (stream: ReadableStream<Uint8Array>, needle: string): Promise<string> => {
  const dec = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += dec.decode(chunk);
    if (text.includes(needle)) return text;
  }
  throw new Error(`stream ended before ${needle}: ${text}`);
};

test("agent script: sample prints swap_total_gb", async () => {
  const p = sh(["sample"]);
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  expect(out).toMatch(/ swap_free_gb=-?[0-9.]+ swap_total_gb=-?[0-9.]+ disk_free_gb=/);
  expect(parseAgentSample(out)).toBeDefined();
});

test("agent script: kill ends only matching processes and reports them", async () => {
  const uniq = `300.${Date.now()}${process.pid}`;
  const victim = Bun.spawn(["sleep", uniq], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  try {
    const p = sh(["kill", `sleep ${uniq}`]);
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines[0]).toMatch(new RegExp(`^DORI_GUARD_KILLED pid=${victim.pid} rss_kb=\\d+ cmd=sleep$`));
    expect(lines.at(-1)).toBe("DORI_GUARD_KILL_DONE count=1");
    expect(lines).toHaveLength(2);
    await victim.exited;
    expect(victim.signalCode).not.toBeNull();

    const none = sh(["kill", `no-such-process-${uniq}`]);
    expect((await new Response(none.stdout).text()).trim()).toBe("DORI_GUARD_KILL_DONE count=0");
  } finally {
    victim.kill("SIGKILL");
  }
});

test("agent script: heavy runs the command, a second one waits for the slot, slot dir is removed", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-heavy-"));
  const env = { HOME: home, DORI_HEAVY_POLL_SEC: "0.1" };
  try {
    const first = sh(["heavy", "first", "--", "sh", "-c", `echo first-started; while [ ! -f "${home}/release" ]; do sleep 0.05; done; exit 3`], env);
    await readUntil(first.stdout, "first-started");
    expect(existsSync(join(home, ".dori", "heavy", "slot.1", "owner"))).toBe(true);

    const second = sh(["heavy", "second", "--", "echo", "second-ran"], env);
    const warned = await readUntil(second.stderr, "DORI_HEAVY_WAITING second slot held by ");
    expect(warned).toMatch(/slot held by \d+ first \d{4}-\d\d-\d\dT/);

    await Bun.write(join(home, "release"), "");
    expect(await first.exited).toBe(3);
    expect(await second.exited).toBe(0);
    expect((await new Response(second.stdout).text()).trim()).toBe("second-ran");
    expect(readdirSync(join(home, ".dori", "heavy"))).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
