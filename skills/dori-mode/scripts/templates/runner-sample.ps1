# dori runner sampler (Windows PowerShell 5.1 / PowerShell 7): prints one JSON object with host metrics and the process table.
# usage: runner-sample.ps1 [DISK_PATH]
# Output: {"load1":n,"memFreePct":n,"swapFreeKb":n,"swapTotalKb":n,"diskFreeKb":n,"procs":[{"pid","ppid","rss","name","cmd","created"}]}
# rss is the working set in KB, created the process creation time in ms since the Unix epoch (0 when unknown).
# A metric that cannot be read is -1. The CIM reads are ported from guard-agent.ps1. ASCII only (PS 5.1 reads BOM-less files as ANSI).

$ErrorActionPreference = 'Continue'
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Get-DoriHome {
  if ($env:USERPROFILE) { return $env:USERPROFILE }
  return $HOME
}

# CIM first; Get-WmiObject only when Get-CimInstance is unavailable (very old hosts).
function Get-DoriCim([string]$Class) {
  if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
    return Get-CimInstance -ClassName $Class -ErrorAction Stop
  }
  if (Get-Command Get-WmiObject -ErrorAction SilentlyContinue) {
    return Get-WmiObject -Class $Class -ErrorAction Stop
  }
  throw "no CIM/WMI provider"
}

# float with 2 decimals (invariant culture), or -1 when not a usable number
function Format-Num2($v) {
  if ($null -eq $v) { return '-1' }
  $d = [double]$v
  if ([double]::IsNaN($d) -or [double]::IsInfinity($d) -or $d -lt 0) { return '-1' }
  return $d.ToString('0.00', $Inv)
}

function Get-DoriLoad1 {
  try {
    $loads = @(Get-DoriCim 'Win32_Processor' | ForEach-Object { $_.LoadPercentage } | Where-Object { $null -ne $_ })
    if ($loads.Count -eq 0) { throw "no LoadPercentage" }
    $sum = 0.0
    foreach ($l in $loads) { $sum += [double]$l }
    $avg = $sum / $loads.Count
    return [double]::Parse((Format-Num2 (($avg / 100.0) * [Environment]::ProcessorCount)), $Inv)
  } catch { return -1 }
}

function Get-DoriMemFreePct {
  try {
    $os = @(Get-DoriCim 'Win32_OperatingSystem')[0]
    $total = [double]$os.TotalVisibleMemorySize
    $free = [double]$os.FreePhysicalMemory
    if ($total -gt 0) { return [int][math]::Floor($free / $total * 100.0 + 0.5) }
  } catch { }
  return -1
}

# page file sizes are in MB; returned in KB as [free, total]
function Get-DoriSwapKb {
  try {
    $alloc = 0.0; $used = 0.0
    foreach ($pf in @(Get-DoriCim 'Win32_PageFileUsage')) {
      if ($null -ne $pf) {
        $alloc += [double]$pf.AllocatedBaseSize
        $used += [double]$pf.CurrentUsage
      }
    }
    $freeMb = $alloc - $used
    if ($freeMb -lt 0) { $freeMb = 0.0 }
    return @([int64]($freeMb * 1024), [int64]($alloc * 1024))
  } catch { return @(-1, -1) }
}

function Get-DoriDiskFreeKb([string]$DiskPath) {
  if (-not $DiskPath) { $DiskPath = Get-DoriHome }
  try {
    $full = [System.IO.Path]::GetFullPath($DiskPath)
    $root = [System.IO.Path]::GetPathRoot($full)
    $drive = New-Object System.IO.DriveInfo($root)
    return [int64][math]::Floor([double]$drive.AvailableFreeSpace / 1024.0)
  } catch { return -1 }
}

# CIM returns a DateTime, WMI a DMTF string; both become ms since the Unix epoch, 0 when missing.
function Get-DoriEpochMs($v) {
  if ($null -eq $v) { return 0 }
  try {
    $dt = $v
    if (-not ($dt -is [datetime])) { $dt = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$v) }
    $epoch = New-Object DateTime(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    return [int64][math]::Floor(($dt.ToUniversalTime() - $epoch).TotalMilliseconds)
  } catch { return 0 }
}

function Get-DoriProcs {
  $out = New-Object System.Collections.ArrayList
  try {
    foreach ($p in @(Get-DoriCim 'Win32_Process')) {
      if ($null -eq $p) { continue }
      $cmd = ''
      if ($null -ne $p.CommandLine) { $cmd = [string]$p.CommandLine }
      [void]$out.Add([ordered]@{
        pid = [int64]$p.ProcessId
        ppid = [int64]$p.ParentProcessId
        rss = [int64][math]::Floor([double]$p.WorkingSetSize / 1024.0)
        name = [string]$p.Name
        cmd = $cmd
        created = Get-DoriEpochMs $p.CreationDate
      })
    }
  } catch { }
  return ,$out.ToArray()
}

$diskPath = ''
if ($args.Count -gt 0) { $diskPath = [string]$args[0] }
$swapKb = Get-DoriSwapKb
$sample = [ordered]@{
  load1 = Get-DoriLoad1
  memFreePct = Get-DoriMemFreePct
  swapFreeKb = $swapKb[0]
  swapTotalKb = $swapKb[1]
  diskFreeKb = Get-DoriDiskFreeKb $diskPath
  procs = Get-DoriProcs
}
Write-Output (ConvertTo-Json -InputObject $sample -Compress -Depth 4)
exit 0
