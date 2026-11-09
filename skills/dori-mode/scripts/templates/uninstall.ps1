# Removes the dori runner from this Windows user: unregisters the \dori\dori-runner task, ends the runner tree, and
# deletes bin, bun, logs and runner-task.pid. -Purge also deletes keys, state, outbox and everything else in the
# runner directory. Run dori runner evacuate from the supervisor first, so unacknowledged events are exported. ASCII only.
param([switch]$Purge)

$ErrorActionPreference = 'Continue'
$R = Split-Path -Parent $PSScriptRoot
$TaskPath = '\dori\'
$TaskName = 'dori-runner'

if (Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false
}

$PidFile = Join-Path $R 'runner-task.pid'
if (Test-Path -LiteralPath $PidFile) {
  $Id = ([IO.File]::ReadAllText($PidFile)).Trim()
  if ($Id -match '^\d+$') {
    $Proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Id) -ErrorAction SilentlyContinue
    if ($Proc -and $Proc.CommandLine -like '*dori.js*') { & taskkill.exe /PID $Id /T /F | Out-Null }
  }
}

if ($Purge) {
  Remove-Item -LiteralPath $R -Recurse -Force
} else {
  foreach ($Name in 'bin', 'bun', 'logs', 'runner-task.pid') {
    $Path = Join-Path $R $Name
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
  }
}
