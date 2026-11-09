import { encodedPowerShell, type MachineKind } from "../remote-guard.ts";

export const RUNNER_UNIT = "dori-runner.service";
export const LAUNCHD_LABEL = "com.dori.runner";
/** The Windows runner's scheduled task: `\dori\dori-runner`. */
export const WIN_TASK_PATH = "\\dori\\";
export const WIN_TASK_NAME = "dori-runner";
const WIN_TASK = `-TaskPath '${WIN_TASK_PATH}' -TaskName '${WIN_TASK_NAME}'`;

/**
 * PowerShell that ends the task wrapper `runner-task.ps1` recorded in `runner-task-wrapper.pid`, then the runner tree it
 * recorded in `runner-task.pid` (`taskkill /T /F` each), each only while that pid still is what it was (its command
 * line names runner-task.ps1, or dori.js), so a reused pid is never killed. The task runs the wrapper under
 * `conhost --headless`, and stopping the task ends only that conhost, so the wrapper goes first: it would otherwise
 * start the runner again 5 s later.
 */
export const WIN_KILL_RUNNER = [
  "$DoriWrapperPid = Join-Path $env:USERPROFILE '.dori\\runner\\runner-task-wrapper.pid'",
  "if (Test-Path -LiteralPath $DoriWrapperPid) {",
  "  $DoriId = ([IO.File]::ReadAllText($DoriWrapperPid)).Trim()",
  "  if ($DoriId -match '^\\d+$') {",
  "    $DoriProc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $DoriId) -ErrorAction SilentlyContinue",
  "    if ($DoriProc -and $DoriProc.CommandLine -like '*runner-task.ps1*') { & taskkill.exe /PID $DoriId /T /F | Out-Null }",
  "  }",
  "  Remove-Item -LiteralPath $DoriWrapperPid -Force -ErrorAction SilentlyContinue",
  "}",
  "$DoriPid = Join-Path $env:USERPROFILE '.dori\\runner\\runner-task.pid'",
  "if (Test-Path -LiteralPath $DoriPid) {",
  "  $DoriId = ([IO.File]::ReadAllText($DoriPid)).Trim()",
  "  if ($DoriId -match '^\\d+$') {",
  "    $DoriProc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $DoriId) -ErrorAction SilentlyContinue",
  "    if ($DoriProc -and $DoriProc.CommandLine -like '*dori.js*') { & taskkill.exe /PID $DoriId /T /F | Out-Null }",
  "  }",
  "  Remove-Item -LiteralPath $DoriPid -Force -ErrorAction SilentlyContinue",
  "}",
].join("\n");

/**
 * The runner CLI on a worker. POSIX: the install wrapper when present, else the bundle run with the bun the login would
 * find. Windows: the installed `dori.ps1` shim through an encoded PowerShell command, with its exit status.
 */
export const remoteRunnerCli = (args: string, kind: MachineKind = "posix"): string =>
  kind === "windows"
    ? encodedPowerShell(`& "$env:USERPROFILE\\.dori\\runner\\bin\\dori.ps1" ${args}; exit $LASTEXITCODE`)
    : `if [ -x "$HOME/.dori/runner/bin/dori" ]; then "$HOME/.dori/runner/bin/dori" ${args}; else PATH="$HOME/.bun/bin:$PATH" bun "$HOME/.dori/runner/bin/dori.js" ${args}; fi`;

/**
 * Restarts or stops the runner's service on a worker. POSIX: launchd on Darwin and systemd elsewhere; the exit status is
 * the service manager's. Windows: restart stops the scheduled task, ends the runner tree and starts the task; stop
 * disables and stops the task and ends the tree; any scheduler error exits 1.
 */
export const remoteRunnerService = (action: "restart" | "stop", kind: MachineKind = "posix"): string => {
  if (kind === "windows") {
    const steps = action === "restart"
      ? [`Stop-ScheduledTask ${WIN_TASK}`, WIN_KILL_RUNNER, `Start-ScheduledTask ${WIN_TASK}`]
      : [`Disable-ScheduledTask ${WIN_TASK} | Out-Null`, `Stop-ScheduledTask ${WIN_TASK}`, WIN_KILL_RUNNER];
    return encodedPowerShell([
      "$ErrorActionPreference = 'Stop'",
      "try {",
      ...steps,
      "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
      "exit 0",
    ].join("\n"));
  }
  const darwin = action === "restart"
    ? `launchctl kickstart -k "$D/${LAUNCHD_LABEL}"`
    : `launchctl disable "$D/${LAUNCHD_LABEL}" && launchctl bootout "$D/${LAUNCHD_LABEL}"`;
  return `if [ "$(uname -s)" = Darwin ]; then D=$(cat "$HOME/.dori/runner/launchd-domain" 2>/dev/null || echo "gui/$(id -u)"); ${darwin}; else systemctl --user ${action} ${RUNNER_UNIT}; fi`;
};
