# Copy this first stage as the one PowerShell paste. It carries no invite.
# It verifies the signed release manifest and both downloaded scripts before invoking either.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Convert-DerSignature([byte[]] $der) {
  if ($der.Length -lt 8 -or $der[0] -ne 0x30 -or $der[1] -ne $der.Length - 2) { throw 'Invalid release signature encoding' }
  $offset = 2
  $out = New-Object byte[] 64
  foreach ($part in 0, 1) {
    if ($der[$offset] -ne 0x02) { throw 'Invalid release signature integer' }
    $length = [int] $der[$offset + 1]
    $offset += 2
    if ($length -lt 1 -or $length -gt 33 -or $offset + $length -gt $der.Length) { throw 'Invalid release signature length' }
    $value = [byte[]] $der[$offset..($offset + $length - 1)]
    if ($length -eq 33) {
      if ($value[0] -ne 0) { throw 'Invalid release signature padding' }
      $value = [byte[]] $value[1..32]
    }
    [Array]::Copy($value, 0, $out, $part * 32 + 32 - $value.Length, $value.Length)
    $offset += $length
  }
  if ($offset -ne $der.Length) { throw 'Trailing release signature data' }
  return ,$out
}

function Verify-ReleaseSignature([byte[]] $manifest, [byte[]] $signature) {
  # Pinned Walkie release P-256 SPKI; also embedded in scripts/install.sh.
  $spki = [Convert]::FromBase64String('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgkx2EdLfMqWSGF8WsQZH3Gtu2spEoaH2+rvI0pAS8YP+YMv/PtLnx0Vuuqvl1DA5gIeotdirB6ixuE90qd3lfw==')
  if ($spki.Length -ne 91 -or $spki[26] -ne 0x04) { throw 'Invalid pinned release key' }
  $blob = New-Object byte[] 72
  [Array]::Copy([byte[]](0x45, 0x43, 0x53, 0x31, 0x20, 0, 0, 0), $blob, 8)
  [Array]::Copy($spki, 27, $blob, 8, 64)
  $key = [System.Security.Cryptography.CngKey]::Import($blob, [System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
  $verifier = [System.Security.Cryptography.ECDsaCng]::new($key)
  try {
    $verifier.HashAlgorithm = [System.Security.Cryptography.CngAlgorithm]::Sha256
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($manifest)
    if (-not $verifier.VerifyHash($hash, (Convert-DerSignature $signature))) { throw 'Release signature verification failed' }
  } finally { $verifier.Dispose(); $key.Dispose() }
}

function Get-SignedHash([string] $manifest, [string] $release, [string] $asset) {
  $lines = $manifest -split "`r?`n"
  $versions = @($lines | Where-Object { $_ -match '^version ' })
  if ($versions.Count -ne 1 -or $versions[0] -cne "version $release") { throw 'Unexpected signed release' }
  $matches = @($lines | Where-Object { $_ -match "^[0-9a-fA-F]{64}  $([regex]::Escape($asset))$" })
  if ($matches.Count -ne 1) { throw "Missing or duplicated signed asset $asset" }
  return $matches[0].Substring(0, 64).ToLowerInvariant()
}

function Invoke-TerminalCleanup {
  $stateDir = Join-Path $env:LOCALAPPDATA 'WalkieEnroll\active'
  $handoff = Join-Path $env:USERPROFILE 'Downloads\walkie-enroll.json'
  $failures = [Collections.Generic.List[string]]::new()
  try { Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction Stop }
  catch { if (Test-Path -LiteralPath $stateDir) { $failures.Add('journal removal failed') } }
  if (Test-Path -LiteralPath $stateDir) { $failures.Add('journal remains') }
  try {
    $task = Get-ScheduledTask -TaskName 'WalkieEnrollResume' -ErrorAction SilentlyContinue
    if ($task) { Unregister-ScheduledTask -TaskName 'WalkieEnrollResume' -Confirm:$false -ErrorAction Stop }
    if (Get-ScheduledTask -TaskName 'WalkieEnrollResume' -ErrorAction SilentlyContinue) { $failures.Add('resume task removal failed') }
  } catch { $failures.Add('resume task removal failed') }
  try { Remove-Item -LiteralPath $handoff -Force -ErrorAction Stop }
  catch { if (Test-Path -LiteralPath $handoff) { $failures.Add('private handoff removal failed') } }
  if (Test-Path -LiteralPath $handoff) { $failures.Add('private handoff remains') }
  if ($failures.Count) { throw ('Enrollment cleanup incomplete: ' + ($failures -join ', ')) }
}

$handoffPath = Join-Path $env:USERPROFILE 'Downloads\walkie-enroll.json'
try {
$journalPath = Join-Path $env:LOCALAPPDATA 'WalkieEnroll\active\journal.json'
$fromJournal = -not (Test-Path -LiteralPath $handoffPath)
$resuming = $false; $elevated = $false
if ($fromJournal) {
  if (-not (Test-Path -LiteralPath $journalPath)) { throw 'Private enrollment handoff and resume journal are missing' }
  $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
  $release = [string]$journal.release
  $resuming = $journal.phase -eq 'await-reboot' -or ($journal.phase -eq 'installing' -and $journal.uacEntered -eq $true)
  $elevated = $journal.phase -eq 'installing' -and $journal.uacEntered -ne $true
  if (-not $resuming -and -not $elevated) { throw 'Unexpected enrollment journal phase' }
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Enrollment is already running or awaiting elevated resume' }
} else {
  if ((Get-Item -LiteralPath $handoffPath).Length -gt 8192) { throw 'Private enrollment handoff is too large' }
  $release = [string]((Get-Content -LiteralPath $handoffPath -Raw | ConvertFrom-Json).release)
}
if ($release -cnotmatch '^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]{1,40})?$') { throw 'Invalid release in private handoff' }
$base = "https://github.com/alexcarney460-hue/walkie-releases/releases/download/$release"
$work = Join-Path $env:LOCALAPPDATA ('WalkieEnroll\' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  foreach ($asset in @('SHA256SUMS', 'SHA256SUMS.sig', 'walkie-windows-bootstrap.ps1', 'walkie-windows-stage0.ps1', 'install.sh')) {
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $work $asset)
  }
  $manifestBytes = [IO.File]::ReadAllBytes((Join-Path $work 'SHA256SUMS'))
  Verify-ReleaseSignature $manifestBytes ([IO.File]::ReadAllBytes((Join-Path $work 'SHA256SUMS.sig')))
  $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes)
  foreach ($asset in @('walkie-windows-bootstrap.ps1', 'walkie-windows-stage0.ps1', 'install.sh')) {
    $want = Get-SignedHash $manifest $release $asset
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $work $asset)).Hash.ToLowerInvariant()
    if ($got -cne $want) { throw "Signed hash mismatch for $asset" }
  }
  $bootstrapPath = Join-Path $work 'walkie-windows-bootstrap.ps1'
  & $bootstrapPath -HandoffPath $handoffPath -InstallerPath (Join-Path $work 'install.sh') -Stage0Path (Join-Path $work 'walkie-windows-stage0.ps1') -Release $release -ManifestPath (Join-Path $work 'SHA256SUMS') -SignaturePath (Join-Path $work 'SHA256SUMS.sig') -Resume:$resuming -Elevated:$elevated
} finally {
  # The resume task embeds this code-free verifier and fetches signed bytes again at sign-in.
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
} catch {
  [Console]::Error.WriteLine('Windows enrollment stopped: ' + $_.Exception.Message)
  Invoke-TerminalCleanup
  throw
} finally {
  Remove-Item -LiteralPath $handoffPath -Force -ErrorAction SilentlyContinue
}
