import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { encodedPowerShell, machineKind, sshArgv, type GuardMachine, type KindResult } from "../remote-guard.ts";
import { RUN_TIMEOUT_CODE, type Ran, type Runner } from "../run.ts";
import { RUNNER_LAUNCHD_LABEL } from "./install.ts";
import { readRunnerEndpoints } from "./endpoints.ts";
import { HUB_FILE, readRunnerRows } from "./hub.ts";
import { readRunnerMachines } from "./machines.ts";
import { RUNNER_UNIT, WIN_KILL_RUNNER, WIN_TASK_NAME, WIN_TASK_PATH } from "./service.ts";
import { stepper, type Progress } from "./steps.ts";

/**
 * `dori runner remove LABEL`'s remote half, the inverse of installRunner: stops and deletes the runner on a worker over
 * ssh. POSIX workers get `removeScript` on the stdin of the fixed command `sh -s`; Windows workers get
 * `windowsRemoveScript` as an encoded PowerShell command. hc's core and its autostart unit or agent are left alone
 * (stopping the core would end every lane on the host). `~/.dori/runner`
 * goes, keys included, so a later install enrolls fresh; `~/.dori` itself stays.
 */

export const REMOVE_TIMEOUT_MS = 60_000;

export type RemoveFailure = "RUNNER_REMOVE_UNREACHABLE" | "RUNNER_REMOVE_UNSUPPORTED" | "RUNNER_REMOVE_FAILED";
export type RemoveResult = { readonly ok: true } | { readonly ok: false; readonly code: RemoveFailure; readonly detail: string };

export type RemoveDeps = {
  readonly run: Runner;
  /** How the machine runs commands; defaults to `machineKind`. */
  readonly kind?: (run: Runner, machine: GuardMachine) => Promise<KindResult>;
  /** Receives a `RUNNER_STEP` line as each step starts, finishes or fails. */
  readonly progress?: Progress;
};

export type RemoveRequest = { readonly machine: GuardMachine; readonly label: string };

/** The POSIX sh uninstall, branching on `uname -s`; prints DORI_REMOVED and exits 0. */
export const removeScript = (): string => [
  "set -u",
  "OS=$(uname -s)",
  'if [ "$OS" = Linux ]; then',
  `  systemctl --user disable --now ${RUNNER_UNIT} >/dev/null 2>&1 || :`,
  `  rm -f "$HOME/.config/systemd/user/${RUNNER_UNIT}" || exit 1`,
  "  systemctl --user daemon-reload >/dev/null 2>&1 || :",
  'elif [ "$OS" = Darwin ]; then',
  '  D=$(cat "$HOME/.dori/runner/launchd-domain" 2>/dev/null || echo "gui/$(id -u)")',
  `  launchctl bootout "$D/${RUNNER_LAUNCHD_LABEL}" >/dev/null 2>&1 || :`,
  `  rm -f "$HOME/Library/LaunchAgents/${RUNNER_LAUNCHD_LABEL}.plist" || exit 1`,
  "fi",
  'rm -rf "$HOME/.dori/runner" || exit 1',
  "printf 'DORI_REMOVED\\n'",
  "exit 0",
  "",
].join("\n");

const TASK = `-TaskPath '${WIN_TASK_PATH}' -TaskName '${WIN_TASK_NAME}'`;

/** The Windows uninstall, as templates/uninstall.ps1 -Purge does it. */
export const windowsRemoveScript = (): string => [
  "$ErrorActionPreference = 'Continue'",
  `if (Get-ScheduledTask ${TASK} -ErrorAction SilentlyContinue) {`,
  `  Stop-ScheduledTask ${TASK} -ErrorAction SilentlyContinue`,
  `  Unregister-ScheduledTask ${TASK} -Confirm:$false`,
  "}",
  WIN_KILL_RUNNER,
  "$R = Join-Path $env:USERPROFILE '.dori\\runner'",
  "if (Test-Path -LiteralPath $R) { Remove-Item -LiteralPath $R -Recurse -Force }",
  "if (Test-Path -LiteralPath $R) { [Console]::Error.WriteLine('could not delete ' + $R); exit 1 }",
  "Write-Output 'DORI_REMOVED'",
  "exit 0",
].join("\n");

const removeResult = (r: Ran): RemoveResult => {
  if (r.code === 0) return { ok: true };
  const detail = (r.err.trim().split("\n").at(-1) ?? "") || `exit ${r.code}`;
  if (r.timedOut || r.code === RUN_TIMEOUT_CODE || r.code === 255) return { ok: false, code: "RUNNER_REMOVE_UNREACHABLE", detail };
  return { ok: false, code: "RUNNER_REMOVE_FAILED", detail };
};

/** How `dori runner remove` proceeds: uninstall over ssh, clean up local state only, or fail as unknown. */
export type RemovePlan =
  | { readonly kind: "remote"; readonly machine: GuardMachine }
  | { readonly kind: "local" }
  | { readonly kind: "unknown" };

/** A label among `machines` is uninstalled over ssh; any other is cleaned up locally when it has local state, else unknown. */
export const planRemove = (machines: readonly GuardMachine[], label: string, hasLocalState: boolean): RemovePlan => {
  const machine = machines.find((m) => m.label === label);
  if (machine) return { kind: "remote", machine };
  return hasLocalState ? { kind: "local" } : { kind: "unknown" };
};

/** Whether the supervisor holds anything for `label`: a `runners` or `runner_keys` row, an endpoint, or a machine. */
export const hasLocalRunnerState = (stateDir: string, label: string): boolean => {
  if (readRunnerRows(stateDir).some((r) => r.label === label)) return true;
  if (label in readRunnerEndpoints(stateDir) || label in readRunnerMachines(stateDir)) return true;
  const path = join(stateDir, HUB_FILE);
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT 1 FROM runner_keys WHERE label = ?").get(label) !== null;
  } catch {
    return false;
  } finally {
    db.close();
  }
};

export const removeRunner = async (deps: RemoveDeps, req: RemoveRequest): Promise<RemoveResult> => {
  const step = stepper(deps.progress, req.label);
  step("connect", "start", req.machine.target);
  const k = await (deps.kind ?? machineKind)(deps.run, req.machine);
  if (!k.ok) {
    const code = k.unsupported ? "RUNNER_REMOVE_UNSUPPORTED" : "RUNNER_REMOVE_UNREACHABLE";
    step("connect", "failed", `${code} ${k.detail}`);
    return { ok: false, code, detail: k.detail };
  }
  step("connect", "done", k.kind);
  step("uninstall", "start", k.kind === "windows" ? "stop and unregister the scheduled task, delete ~/.dori/runner" : "stop and delete the runner service, delete ~/.dori/runner");
  const r = k.kind === "windows"
    ? await deps.run(sshArgv(req.machine.target, encodedPowerShell(windowsRemoveScript())), { timeoutMs: REMOVE_TIMEOUT_MS })
    : await deps.run(sshArgv(req.machine.target, "sh -s"), { stdin: removeScript(), timeoutMs: REMOVE_TIMEOUT_MS });
  const result = removeResult(r);
  if (result.ok) step("uninstall", "done");
  else step("uninstall", "failed", `${result.code} ${result.detail}`);
  return result;
};
