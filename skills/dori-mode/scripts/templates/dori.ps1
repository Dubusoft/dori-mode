# dori for PowerShell callers: the runner bundle run by the bun the installer pinned. ASCII only.
$Root = Split-Path -Parent $PSScriptRoot
$Version = ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'bun.txt'))).Trim()
& (Join-Path $Root ('bun\' + $Version + '\bun.exe')) (Join-Path $PSScriptRoot 'dori.js') @args
exit $LASTEXITCODE
