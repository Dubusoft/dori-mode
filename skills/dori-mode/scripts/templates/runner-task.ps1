# dori runner task wrapper: the Windows counterpart of the systemd unit's Restart=always, RestartSec=5.
# The scheduled task \dori\dori-runner runs it at logon. Each round starts the runner hidden, appends its stdout and
# stderr to logs\runner.log, records the child's pid in runner-task.pid (service control kills that tree), waits for
# it to exit, and starts it again 5 s later. The log is rotated by size before each start. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(Mandatory = $true)][string]$Connect
)

$ErrorActionPreference = 'Continue'
$Bin = $PSScriptRoot
$R = Split-Path -Parent $Bin
$Logs = Join-Path $R 'logs'
$Log = Join-Path $Logs 'runner.log'
$PidFile = Join-Path $R 'runner-task.pid'
$MaxLogBytes = 10MB
$KeepLogs = 3
$BasePath = $env:PATH

function Write-DoriLog([string]$Line) {
  try { [IO.File]::AppendAllText($Log, (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + ' runner-task: ' + $Line + "`n") } catch { }
}

function Step-DoriLog {
  if (-not (Test-Path -LiteralPath $Log)) { return }
  if ((Get-Item -LiteralPath $Log).Length -lt $MaxLogBytes) { return }
  for ($i = $KeepLogs - 1; $i -ge 1; $i--) {
    $Old = $Log + '.' + $i
    if (Test-Path -LiteralPath $Old) { Move-Item -LiteralPath $Old -Destination ($Log + '.' + ($i + 1)) -Force }
  }
  Move-Item -LiteralPath $Log -Destination ($Log + '.1') -Force
}

[void][IO.Directory]::CreateDirectory($Logs)
while ($true) {
  try {
    Step-DoriLog
    $Version = ([IO.File]::ReadAllText((Join-Path $Bin 'bun.txt'))).Trim()
    $BunDir = Join-Path $R ('bun\' + $Version)
    $Bun = Join-Path $BunDir 'bun.exe'
    $env:PATH = $Bin + ';' + $BunDir + ';' + $BasePath
    $Line = '"' + $Bun + '" "' + (Join-Path $Bin 'dori.js') + '" runner serve --label ' + $Label + ' --connect ' + $Connect + ' >> "' + $Log + '" 2>&1'
    $Child = Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /s /c "' + $Line + '"') -WorkingDirectory $R -NoNewWindow -PassThru
    $null = $Child.Handle
    [IO.File]::WriteAllText($PidFile, [string]$Child.Id)
    $Child.WaitForExit()
    Write-DoriLog ('runner exited with ' + $Child.ExitCode + '; restarting in 5 s')
  } catch {
    Write-DoriLog ('start failed: ' + $_.Exception.Message + '; retrying in 5 s')
  }
  Start-Sleep -Seconds 5
}
