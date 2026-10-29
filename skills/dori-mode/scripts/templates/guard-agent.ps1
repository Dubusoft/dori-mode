# dori guard agent (Windows PowerShell 5.1 / PowerShell 7): prints one host-metrics line; invoked over ssh, no daemon.
# usage: guard-agent.ps1 sample [DISK_PATH] | version | kill PATTERN... | heavy LABEL -- CMD...
# Port of guard-agent.sh; output line formats are identical. ASCII only (PS 5.1 reads BOM-less files as ANSI).

$ErrorActionPreference = 'Continue'
$Inv = [System.Globalization.CultureInfo]::InvariantCulture

$AgentDir = $PSScriptRoot
if (-not $AgentDir) { $AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Get-DoriHome {
  if ($env:USERPROFILE) { return $env:USERPROFILE }
  return $HOME
}

function Get-DoriVersion {
  $v = ''
  try {
    $f = Join-Path $AgentDir 'guard-agent.version'
    if (Test-Path -LiteralPath $f) {
      $line = Get-Content -LiteralPath $f -TotalCount 1 -ErrorAction Stop
      if ($null -ne $line) { $v = ([string]$line).Trim() }
    }
  } catch { $v = '' }
  if (-not $v) { $v = 'unknown' }
  return $v
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

function Invoke-Sample([string]$DiskPath) {
  if (-not $DiskPath) { $DiskPath = Get-DoriHome }
  $load1 = '-1'; $mem = '-1'; $swap = '-1'; $swapTotal = '-1'; $disk = '-1'

  try {
    $loads = @(Get-DoriCim 'Win32_Processor' | ForEach-Object { $_.LoadPercentage } | Where-Object { $null -ne $_ })
    if ($loads.Count -eq 0) { throw "no LoadPercentage" }
    $sum = 0.0
    foreach ($l in $loads) { $sum += [double]$l }
    $avg = $sum / $loads.Count
    $load1 = Format-Num2 (($avg / 100.0) * [Environment]::ProcessorCount)
  } catch { $load1 = '-1' }

  try {
    $os = @(Get-DoriCim 'Win32_OperatingSystem')[0]
    $total = [double]$os.TotalVisibleMemorySize
    $free = [double]$os.FreePhysicalMemory
    if ($total -gt 0) {
      $mem = ([int][math]::Floor($free / $total * 100.0 + 0.5)).ToString($Inv)
    }
  } catch { $mem = '-1' }

  try {
    $alloc = 0.0; $used = 0.0
    foreach ($pf in @(Get-DoriCim 'Win32_PageFileUsage')) {
      if ($null -ne $pf) {
        $alloc += [double]$pf.AllocatedBaseSize
        $used += [double]$pf.CurrentUsage
      }
    }
    $swapTotal = Format-Num2 ($alloc / 1024.0)
    $freeMb = $alloc - $used
    if ($freeMb -lt 0) { $freeMb = 0.0 }
    $swap = Format-Num2 ($freeMb / 1024.0)
  } catch { $swap = '-1'; $swapTotal = '-1' }

  try {
    $full = [System.IO.Path]::GetFullPath($DiskPath)
    $root = [System.IO.Path]::GetPathRoot($full)
    $drive = New-Object System.IO.DriveInfo($root)
    $disk = Format-Num2 ([double]$drive.AvailableFreeSpace / 1GB)
  } catch { $disk = '-1' }

  Write-Output ('DORI_GUARD_SAMPLE version={0} os=windows load1={1} mem_free_pct={2} swap_free_gb={3} swap_total_gb={4} disk_free_gb={5}' -f (Get-DoriVersion), $load1, $mem, $swap, $swapTotal, $disk)
}

function Test-DoriAlive([int]$ProcId) {
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $false }
  try { if ($p.HasExited) { return $false } } catch { }
  return $true
}

function Get-DoriOwner($Proc) {
  try {
    if (Get-Command Invoke-CimMethod -ErrorAction SilentlyContinue) {
      $o = Invoke-CimMethod -InputObject $Proc -MethodName GetOwner -ErrorAction Stop
    } else {
      $o = $Proc.GetOwner()
    }
    if ($null -eq $o -or $o.ReturnValue -ne 0) { return $null }
    return $o
  } catch { return $null }
}

# kill PATTERN...: end this user's processes whose command line contains any PATTERN (fixed string),
# never this script or its ancestors. Graceful close request, wait up to 5 s, then force.
function Invoke-Kill([string[]]$Patterns) {
  $Patterns = @($Patterns | Where-Object { $_ -ne $null -and $_ -ne '' })
  if ($Patterns.Count -eq 0) {
    [Console]::Error.WriteLine('usage: guard-agent.ps1 kill PATTERN...')
    exit 2
  }
  # list first, then filter: a process started after the snapshot is never touched
  $all = @(Get-DoriCim 'Win32_Process')
  $parent = @{}
  foreach ($p in $all) { $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId }
  $skip = @{}
  $cur = [int]$PID
  $skip[$cur] = $true
  while ($parent.ContainsKey($cur)) {
    $cur = $parent[$cur]
    if ($cur -le 0 -or $skip.ContainsKey($cur)) { break }
    $skip[$cur] = $true
  }
  $meUser = [Environment]::UserName
  $meDomain = [Environment]::UserDomainName

  $found = @()
  foreach ($p in $all) {
    $id = [int]$p.ProcessId
    if ($id -le 4 -or $skip.ContainsKey($id)) { continue }
    $cl = [string]$p.CommandLine
    if (-not $cl) { continue }
    $hit = $false
    foreach ($pat in $Patterns) { if ($cl.Contains($pat)) { $hit = $true; break } }
    if (-not $hit) { continue }
    $o = Get-DoriOwner $p
    if ($null -eq $o) { continue }
    if ([string]$o.User -ne $meUser) { continue }
    if ($o.Domain -and $meDomain -and ([string]$o.Domain -ne $meDomain)) { continue }
    $rss = [int64][math]::Floor([double]$p.WorkingSetSize / 1024.0)
    $name = [string]$p.Name -replace '[^A-Za-z0-9._:+-]', '_'
    if (-not $name) { $name = '_' }
    $found += New-Object PSObject -Property @{ Id = $id; Rss = $rss; Cmd = $name }
  }

  if ($found.Count -eq 0) {
    Write-Output 'DORI_GUARD_KILL_DONE count=0'
    return
  }

  # graceful: ask windowed processes to close; windowless (console) ones cannot be asked and are forced below
  $asked = @()
  foreach ($f in $found) {
    try {
      $proc = [System.Diagnostics.Process]::GetProcessById($f.Id)
      if ($proc.CloseMainWindow()) { $asked += $f.Id }
    } catch { }
  }
  $i = 0
  while ($asked.Count -gt 0 -and $i -lt 25) {
    $any = $false
    foreach ($id in $asked) { if (Test-DoriAlive $id) { $any = $true } }
    if (-not $any) { break }
    Start-Sleep -Milliseconds 200
    $i++
  }
  foreach ($f in $found) {
    if (Test-DoriAlive $f.Id) {
      try { Stop-Process -Id $f.Id -Force -ErrorAction Stop } catch { }
    }
  }
  foreach ($f in $found) {
    Write-Output ('DORI_GUARD_KILLED pid={0} rss_kb={1} cmd={2}' -f $f.Id, $f.Rss.ToString($Inv), $f.Cmd)
  }
  Write-Output ('DORI_GUARD_KILL_DONE count={0}' -f $found.Count)
}

# true when the slot owner line names a live process that started before the slot was taken
function Test-DoriHolderAlive([string]$Holder) {
  if (-not $Holder) { return $true } # owner line not written yet: treat as held
  $parts = $Holder.Trim() -split '\s+'
  $ownerPid = 0
  if (-not [int]::TryParse($parts[0], [ref]$ownerPid)) { return $true }
  $p = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $false }
  # Windows reuses pids quickly: a process started after the slot stamp is not the owner
  try {
    $stamp = [datetime]::ParseExact($parts[$parts.Count - 1], 'yyyy-MM-ddTHH:mm:ssZ', $Inv,
      [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
    if ($p.StartTime.ToUniversalTime() -gt $stamp.AddSeconds(1)) { return $false }
  } catch { }
  return $true
}

# take slot dir $Dir; the owner file is created with CreateNew, which is atomic, so only one taker wins
function Get-DoriSlot([string]$Dir, [string]$Label) {
  try {
    [void][System.IO.Directory]::CreateDirectory($Dir)
    $fs = [System.IO.File]::Open((Join-Path $Dir 'owner'), [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
  } catch { return $false }
  try {
    $line = '{0} {1} {2}' -f $PID, $Label, [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', $Inv)
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($line + "`n")
    $fs.Write($bytes, 0, $bytes.Length)
  } finally { $fs.Close() }
  return $true
}

# heavy LABEL -- CMD...: run CMD while holding one of DORI_HEAVY_SLOTS (default 1) per-machine slots.
function Invoke-Heavy([string[]]$Rest) {
  $Rest = @($Rest)
  if ($Rest.Count -lt 1) {
    [Console]::Error.WriteLine('usage: guard-agent.ps1 heavy LABEL -- CMD...')
    exit 2
  }
  $label = [string]$Rest[0]
  $cmd = @()
  if ($Rest.Count -gt 1) { $cmd = @($Rest[1..($Rest.Count - 1)]) }
  if ($cmd.Count -gt 0 -and $cmd[0] -eq '--') {
    if ($cmd.Count -gt 1) { $cmd = @($cmd[1..($cmd.Count - 1)]) } else { $cmd = @() }
  }
  if ($cmd.Count -eq 0) {
    [Console]::Error.WriteLine('usage: guard-agent.ps1 heavy LABEL -- CMD...')
    exit 2
  }
  $root = Join-Path (Join-Path (Get-DoriHome) '.dori') 'heavy'
  try { [void][System.IO.Directory]::CreateDirectory($root) } catch { exit 1 }
  $slots = 1
  if ($env:DORI_HEAVY_SLOTS) { [void][int]::TryParse($env:DORI_HEAVY_SLOTS, [ref]$slots) }
  if ($slots -lt 1) { $slots = 1 }
  $poll = 15
  if ($env:DORI_HEAVY_POLL_SEC) { [void][int]::TryParse($env:DORI_HEAVY_POLL_SEC, [ref]$poll) }
  if ($poll -lt 1) { $poll = 1 }

  $slot = $null
  $warned = $false
  while ($null -eq $slot) {
    $n = 1
    $holder = ''
    while ($n -le $slots) {
      $d = Join-Path $root ('slot.' + $n)
      if (Get-DoriSlot $d $label) { $slot = $d; break }
      $holder = ''
      try { $holder = [string](Get-Content -LiteralPath (Join-Path $d 'owner') -TotalCount 1 -ErrorAction Stop) } catch { $holder = '' }
      if ($holder -and -not (Test-DoriHolderAlive $holder)) {
        try { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop } catch { } # owner died without releasing
        continue
      }
      $n++
    }
    if ($null -ne $slot) { break }
    if (-not $warned) {
      [Console]::Error.WriteLine("DORI_HEAVY_WAITING $label slot held by $holder")
      $warned = $true
    }
    Start-Sleep -Seconds $poll
  }

  $rc = 1
  try {
    $exe = $cmd[0]
    $cargs = @()
    if ($cmd.Count -gt 1) { $cargs = @($cmd[1..($cmd.Count - 1)]) }
    $global:LASTEXITCODE = 0
    & $exe @cargs
    $ok = $?
    if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) {
      $rc = [int]$global:LASTEXITCODE
    } elseif ($ok) {
      $rc = 0
    } else {
      $rc = 1
    }
  } catch {
    [Console]::Error.WriteLine([string]$_)
    $rc = 1
  } finally {
    # also runs on Ctrl+C / pipeline stop
    try { Remove-Item -LiteralPath $slot -Recurse -Force -ErrorAction Stop } catch { }
  }
  exit $rc
}

$sub = ''
if ($args.Count -gt 0) { $sub = [string]$args[0] }
$restArgs = @()
if ($args.Count -gt 1) { $restArgs = @($args[1..($args.Count - 1)]) }

switch ($sub) {
  'sample' {
    $p = ''
    if ($restArgs.Count -gt 0) { $p = [string]$restArgs[0] }
    Invoke-Sample $p
    exit 0
  }
  'version' { Write-Output (Get-DoriVersion); exit 0 }
  'kill' { Invoke-Kill $restArgs; exit 0 }
  'heavy' { Invoke-Heavy $restArgs }
  default {
    [Console]::Error.WriteLine('usage: guard-agent.ps1 sample [DISK_PATH] | version | kill PATTERN... | heavy LABEL -- CMD...')
    exit 2
  }
}
