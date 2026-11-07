import { afterEach, expect, test } from "bun:test";
import { clearShellModes, machineKind } from "../src/remote-guard.ts";
import { livenessIo } from "../src/runner/liveness.ts";
import { WIN_KILL_RUNNER, remoteRunnerCli, remoteRunnerService } from "../src/runner/service.ts";
import type { Ran, Runner } from "../src/run.ts";

afterEach(() => { clearShellModes(); });

const decodePs = (command: string): string => {
  const m = /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand (\S+)$/.exec(command);
  if (!m?.[1]) throw new Error(`not an encoded command: ${command}`);
  return Buffer.from(m[1], "base64").toString("utf16le");
};
const TASK = "-TaskPath '\\dori\\' -TaskName 'dori-runner'";

test("the POSIX forms are unchanged and stay the default", () => {
  expect(remoteRunnerCli("runner probe --json", "posix")).toBe(remoteRunnerCli("runner probe --json"));
  expect(remoteRunnerCli("runner probe --json")).toBe(
    `if [ -x "$HOME/.dori/runner/bin/dori" ]; then "$HOME/.dori/runner/bin/dori" runner probe --json; else PATH="$HOME/.bun/bin:$PATH" bun "$HOME/.dori/runner/bin/dori.js" runner probe --json; fi`,
  );
  for (const action of ["restart", "stop"] as const) expect(remoteRunnerService(action, "posix")).toBe(remoteRunnerService(action));
  expect(remoteRunnerService("restart")).toContain("systemctl --user restart dori-runner.service");
});

test("the Windows CLI runs the dori.ps1 shim and passes its exit status on", () => {
  expect(decodePs(remoteRunnerCli("runner export-outbox", "windows"))).toBe('& "$env:USERPROFILE\\.dori\\runner\\bin\\dori.ps1" runner export-outbox; exit $LASTEXITCODE');
});

test("Windows restart stops the task, ends the recorded tree, then starts the task", () => {
  const s = decodePs(remoteRunnerService("restart", "windows"));
  const stop = s.indexOf(`Stop-ScheduledTask ${TASK}`);
  const kill = s.indexOf("& taskkill.exe /PID $DoriId /T /F");
  const start = s.indexOf(`Start-ScheduledTask ${TASK}`);
  expect(stop).toBeGreaterThan(-1);
  expect(kill).toBeGreaterThan(stop);
  expect(start).toBeGreaterThan(kill);
  expect(s).not.toContain("Disable-ScheduledTask");
  expect(s).toContain("$ErrorActionPreference = 'Stop'");
  expect(s).toContain("catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }");
});

test("Windows stop disables and stops the task and ends the tree, without starting it", () => {
  const s = decodePs(remoteRunnerService("stop", "windows"));
  const disable = s.indexOf(`Disable-ScheduledTask ${TASK}`);
  const stop = s.indexOf(`Stop-ScheduledTask ${TASK}`);
  expect(disable).toBeGreaterThan(-1);
  expect(stop).toBeGreaterThan(disable);
  expect(s.indexOf(WIN_KILL_RUNNER)).toBeGreaterThan(stop);
  expect(s).not.toContain("Start-ScheduledTask");
});

test("the tree is killed from runner-task.pid only while that pid still runs dori.js", () => {
  expect(WIN_KILL_RUNNER).toContain("'.dori\\runner\\runner-task.pid'");
  expect(WIN_KILL_RUNNER).toContain("if ($DoriProc -and $DoriProc.CommandLine -like '*dori.js*') { & taskkill.exe /PID $DoriId /T /F | Out-Null }");
});

test("liveness probes and restarts a worker in the form of its kind", async () => {
  const argv: string[][] = [];
  const run: Runner = async (a) => { argv.push([...a]); return { code: 0, out: '{"verdict":"healthy"}', err: "" } as Ran; };
  const machines = async () => [{ label: "win-a", target: "u@win" }, { label: "lin-a", target: "u@lin" }];
  const kinds = new Map([["u@win", "windows"], ["u@lin", "posix"]] as const);
  const io = livenessIo(run, "local", machines, undefined, async (m) => ({ ok: true, kind: kinds.get(m.target as "u@win") ?? "posix" }));
  expect(await io.probe("win-a")).toEqual({ kind: "alive" });
  expect(await io.restart("win-a")).toEqual({ ok: true, detail: "service restart" });
  expect(await io.probe("lin-a")).toEqual({ kind: "alive" });
  expect(await io.restart("lin-a")).toEqual({ ok: true, detail: "service restart" });
  expect(argv.map((a) => a.at(-1))).toEqual([
    remoteRunnerCli("runner probe --json", "windows"), remoteRunnerService("restart", "windows"),
    remoteRunnerCli("runner probe --json"), remoteRunnerService("restart"),
  ]);
  // A kind that cannot be found is unreachable for the probe and a failed restart.
  const lost = livenessIo(run, "local", machines, undefined, async () => ({ ok: false, unsupported: false, detail: "unreachable: timeout" }));
  expect(await lost.probe("win-a")).toEqual({ kind: "unreachable", detail: "unreachable: timeout" });
  expect(await lost.restart("win-a")).toEqual({ ok: false, detail: "unreachable: timeout" });
  expect(argv).toHaveLength(4);
});

test("machineKind maps a POSIX shell with a Windows uname to windows and caches the answer", async () => {
  const commands: string[] = [];
  const answer = (c: string): Partial<Ran> => (c.includes("DORI_POSIX") ? { out: "DORI_POSIX_42\n" } : c === "uname -s" ? { out: "MSYS_NT-10.0-22631\n" } : {});
  const run: Runner = async (a) => { const c = a.at(-1) ?? ""; commands.push(c); return { code: 0, out: "", err: "", ...answer(c) } as Ran; };
  const m = { label: "w", target: "u@w" };
  expect(await machineKind(run, m)).toEqual({ ok: true, kind: "windows" });
  expect(await machineKind(run, m)).toEqual({ ok: true, kind: "windows" });
  expect(commands).toHaveLength(2);
});
