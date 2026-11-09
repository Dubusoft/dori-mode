import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { hasLocalRunnerState, planRemove, removeRunner, removeScript, windowsRemoveScript } from "../src/runner/remove.ts";
import { forgetRunner, HUB_FILE } from "../src/runner/hub.ts";
import { encodedPowerShell } from "../src/remote-guard.ts";
import type { Ran, RunOptions } from "../src/run.ts";
import { readRunnerEndpoints, removeRunnerEndpoint, writeRunnerEndpoint } from "../src/runner/endpoints.ts";
import { readRunnerMachines, removeRunnerMachine, writeRunnerMachine } from "../src/runner/machines.ts";

const machine = { label: "worker-a", target: "dori@worker-a" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

type Call = { argv: readonly string[]; opts?: RunOptions };
const fakeRun = (result: Partial<Ran> = {}) => {
  const calls: Call[] = [];
  const run = async (argv: readonly string[], opts?: RunOptions): Promise<Ran> => {
    calls.push({ argv, ...(opts ? { opts } : {}) });
    return { code: 0, out: "DORI_REMOVED\n", err: "", ...result } as Ran;
  };
  return { run, calls };
};
const posixKind = async () => ({ ok: true as const, kind: "posix" as const });
const windowsKind = async () => ({ ok: true as const, kind: "windows" as const });
/** Every call that could stop or restart a running herdr. */
const HERDR_DISRUPTION = /systemctl --user (restart|stop|kill|try-restart|reload-or-restart|disable --now)[^\n]*herdr-server|launchctl (bootout|kickstart|kill|stop)[^\n]*com\.dori\.herdr|herdr server stop/;

test("on a POSIX worker the uninstall goes on stdin to the fixed command sh -s and never stops herdr", async () => {
  const { run, calls } = fakeRun();
  expect(await removeRunner({ run, kind: posixKind }, { machine, label: "worker-a" })).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.argv).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "dori@worker-a", "sh -s"]);
  const script = calls[0]!.opts?.stdin ?? "";
  expect(script).toBe(removeScript());
  expect(script).toContain("systemctl --user disable --now dori-runner.service");
  expect(script).toContain("systemctl --user disable herdr-server.service");
  expect(script).toContain('rm -rf "$HOME/.dori/runner"');
  expect(script).toContain('launchctl bootout "$D/com.dori.runner"');
  expect(script).not.toContain("stop herdr-server");
  expect(script).not.toContain("restart herdr");
  expect(script).not.toMatch(/bootout[^\n]*com\.dori\.herdr/);
  expect(script).not.toMatch(HERDR_DISRUPTION);
});

test("on a Windows worker the uninstall is an encoded PowerShell command that purges the runner directory", async () => {
  const { run, calls } = fakeRun();
  expect(await removeRunner({ run, kind: windowsKind }, { machine, label: "worker-a" })).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.argv.at(-1)).toBe(encodedPowerShell(windowsRemoveScript()));
  expect(calls[0]!.opts?.stdin).toBeUndefined();
  const ps = windowsRemoveScript();
  expect(ps).toContain("Unregister-ScheduledTask -TaskPath '\\dori\\' -TaskName 'dori-runner' -Confirm:$false");
  expect(ps).toContain("taskkill.exe");
  expect(ps).toContain("Remove-Item -LiteralPath $R -Recurse -Force");
});

test("ssh failures, timeouts and script failures map to their result codes", async () => {
  const cases: [Partial<Ran>, string, string][] = [
    [{ code: 255, err: "ssh: connect to host worker-a port 22: Connection refused" }, "RUNNER_REMOVE_UNREACHABLE", "ssh: connect to host worker-a port 22: Connection refused"],
    [{ code: 124, timedOut: true }, "RUNNER_REMOVE_UNREACHABLE", "exit 124"],
    [{ code: 1, err: "noise\nrm: cannot remove '/home/dori/.dori/runner': Permission denied" }, "RUNNER_REMOVE_FAILED", "rm: cannot remove '/home/dori/.dori/runner': Permission denied"],
    [{ code: 3 }, "RUNNER_REMOVE_FAILED", "exit 3"],
  ];
  for (const [ran, code, detail] of cases) {
    const { run } = fakeRun(ran);
    expect(await removeRunner({ run, kind: posixKind }, { machine, label: "worker-a" })).toEqual({ ok: false, code: code as "RUNNER_REMOVE_FAILED", detail });
  }
});

test("a machine whose kind cannot be found is unreachable or unsupported, and ssh is not run", async () => {
  const { run, calls } = fakeRun();
  expect(await removeRunner({ run, kind: async () => ({ ok: false, unsupported: false, detail: "unreachable: timeout" }) }, { machine, label: "worker-a" }))
    .toEqual({ ok: false, code: "RUNNER_REMOVE_UNREACHABLE", detail: "unreachable: timeout" });
  expect(await removeRunner({ run, kind: async () => ({ ok: false, unsupported: true, detail: "no shell" }) }, { machine, label: "worker-a" }))
    .toEqual({ ok: false, code: "RUNNER_REMOVE_UNSUPPORTED", detail: "no shell" });
  expect(calls).toHaveLength(0);
});

test("run by sh on Linux, the script deletes the runner and both unit files, leaves ~/.dori, and only disables herdr", async () => {
  const home = tempDir("runner-remove-home-");
  const bin = join(home, "fakebin");
  mkdirSync(bin);
  const log = join(home, "argv.log");
  for (const [name, body] of [["uname", "echo Linux"], ["systemctl", "exit 0"], ["herdr", "exit 0"]] as const) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${log}'\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const units = join(home, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "dori-runner.service"), "unit\n");
  writeFileSync(join(units, "herdr-server.service"), "unit\n");
  writeFileSync(join(units, "other.service"), "unit\n");
  mkdirSync(join(home, ".dori/runner/keys"), { recursive: true });
  writeFileSync(join(home, ".dori/runner/keys/runner.key"), "secret\n");
  writeFileSync(join(home, ".dori/keep"), "x\n");
  const p = Bun.spawn(["/bin/sh", "-s"], { stdin: new TextEncoder().encode(removeScript()), stdout: "pipe", stderr: "pipe", env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect({ code, out, err }).toEqual({ code: 0, out: "DORI_REMOVED\n", err: "" });
  expect(existsSync(join(home, ".dori/runner"))).toBe(false);
  expect(existsSync(join(home, ".dori/keep"))).toBe(true);
  expect(existsSync(join(units, "dori-runner.service"))).toBe(false);
  expect(existsSync(join(units, "herdr-server.service"))).toBe(false);
  expect(existsSync(join(units, "other.service"))).toBe(true);
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  expect(calls).toEqual([
    "uname -s",
    "systemctl --user disable --now dori-runner.service",
    "systemctl --user disable herdr-server.service",
    "systemctl --user daemon-reload",
  ]);
});

test("removing an endpoint or a machine keeps the other labels, and a missing file is a no-op", () => {
  const stateDir = tempDir("runner-remove-state-");
  removeRunnerEndpoint(stateDir, "worker-a");
  removeRunnerMachine(stateDir, "worker-a");
  expect(existsSync(join(stateDir, "runner-endpoints.json"))).toBe(false);
  expect(existsSync(join(stateDir, "runner-machines.json"))).toBe(false);
  writeRunnerEndpoint(stateDir, "worker-a", "100.101.1.2:7411");
  writeRunnerEndpoint(stateDir, "worker-b", "100.101.1.3:7411");
  writeRunnerMachine(stateDir, "worker-a", "dori@worker-a");
  writeRunnerMachine(stateDir, "worker-b", "dori@worker-b");
  removeRunnerEndpoint(stateDir, "worker-a");
  removeRunnerMachine(stateDir, "worker-a");
  expect(readRunnerEndpoints(stateDir)).toEqual({ "worker-b": "100.101.1.3:7411" });
  expect(readRunnerMachines(stateDir)).toEqual({ "worker-b": "dori@worker-b" });
  removeRunnerEndpoint(stateDir, "worker-c");
  expect(readRunnerEndpoints(stateDir)).toEqual({ "worker-b": "100.101.1.3:7411" });
});

/** A runners.sqlite with the hub's two tables and auth's runner_keys, holding worker-a (revoked) and worker-b. */
const seedHub = (stateDir: string) => {
  const db = new Database(join(stateDir, HUB_FILE), { create: true });
  db.run("CREATE TABLE runners (label TEXT PRIMARY KEY, hostId TEXT, maxGen INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE runner_attempts (cmdId TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL, key TEXT, body TEXT NOT NULL, epoch INTEGER NOT NULL, at INTEGER NOT NULL)");
  db.run("CREATE TABLE runner_keys (label TEXT PRIMARY KEY, hostId TEXT NOT NULL, pubKey TEXT, enrolledAt INTEGER NOT NULL, rotatedAt INTEGER, revokedAt INTEGER)");
  for (const label of ["worker-a", "worker-b"]) {
    db.query("INSERT INTO runners (label, hostId, maxGen) VALUES (?, 'h', 3)").run(label);
    db.query("INSERT INTO runner_attempts VALUES (?, ?, 'run', NULL, '{}', 1, 1)").run(`c-${label}`, label);
  }
  db.run("INSERT INTO runner_keys VALUES ('worker-a', 'h', NULL, 1, NULL, 2)");
  db.close();
};
const labels = (stateDir: string, table: string) => {
  const db = new Database(join(stateDir, HUB_FILE), { readonly: true });
  try { return (db.query(`SELECT label FROM ${table} ORDER BY label`).all() as { label: string }[]).map((r) => r.label); } finally { db.close(); }
};

test("forgetRunner deletes the runners row and attempts, keeps the revoked key, and tolerates a missing file or row", () => {
  const stateDir = tempDir("runner-remove-hub-");
  expect(forgetRunner(stateDir, "worker-a")).toBe(false);
  seedHub(stateDir);
  expect(forgetRunner(stateDir, "worker-a")).toBe(true);
  expect(labels(stateDir, "runners")).toEqual(["worker-b"]);
  expect(labels(stateDir, "runner_attempts")).toEqual(["worker-b"]);
  expect(labels(stateDir, "runner_keys")).toEqual(["worker-a"]);
  expect(forgetRunner(stateDir, "worker-a")).toBe(false);
});

test("an unknown label is local-only with local state, unknown without it, and unknown when the machine list failed", () => {
  const listed = { ok: true, machines: [machine] };
  expect(planRemove(listed, "worker-a", false)).toEqual({ kind: "remote", machine });
  expect(planRemove(listed, "macbook", true)).toEqual({ kind: "local" });
  expect(planRemove(listed, "macbook", false)).toEqual({ kind: "unknown" });
  expect(planRemove({ ok: false, detail: "herdr down", machines: [] }, "macbook", true)).toEqual({ kind: "unknown", detail: "herdr down" });
});

test("local state is a runners or runner_keys row, an endpoint or a recorded machine", () => {
  const stateDir = tempDir("runner-remove-local-");
  expect(hasLocalRunnerState(stateDir, "worker-a")).toBe(false);
  seedHub(stateDir);
  forgetRunner(stateDir, "worker-a");
  expect(hasLocalRunnerState(stateDir, "worker-a")).toBe(true);
  expect(hasLocalRunnerState(stateDir, "worker-b")).toBe(true);
  expect(hasLocalRunnerState(stateDir, "worker-c")).toBe(false);
  writeRunnerEndpoint(stateDir, "worker-c", "100.101.1.4:7411");
  writeRunnerMachine(stateDir, "worker-d", "dori@worker-d");
  expect(hasLocalRunnerState(stateDir, "worker-c")).toBe(true);
  expect(hasLocalRunnerState(stateDir, "worker-d")).toBe(true);
});
