# Signed Windows enrollment payload. First entry is from stage0 after signature/hash verification.
# Resume entry verifies the persisted signed manifest before reading the protected code.
param(
  [Parameter(Mandatory = $true)][string] $HandoffPath,
  [Parameter(Mandatory = $true)][string] $InstallerPath,
  [Parameter(Mandatory = $true)][string] $Stage0Path,
  [Parameter(Mandatory = $true)][string] $Release,
  [Parameter(Mandatory = $true)][string] $ManifestPath,
  [Parameter(Mandatory = $true)][string] $SignaturePath,
  [switch] $Elevated,
  [switch] $Resume
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$wsl = Join-Path $env:WINDIR 'System32\wsl.exe'
$stateDir = Join-Path $env:LOCALAPPDATA 'WalkieEnroll\active'
$journalPath = Join-Path $stateDir 'journal.json'
$resumeName = 'WalkieEnrollResume'
$keepAliveName = 'WalkieWSLKeepAlive'
# What the last WSL command that SUCCEEDED said on its standard error (Invoke-WslInput sets it on every call).
$script:WslStderr = ''

function Assert-Name([string] $value) {
  if ($value -cnotmatch '^[A-Za-z][A-Za-z0-9_-]{0,31}$') { throw 'Invalid WSL distro or user name' }
}
function Assert-Hex([string] $value) {
  if ($value -cnotmatch '^[0-9a-f]{16}$') { throw 'Invalid team identifier' }
}
function Assert-CanSelfElevate {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $adminSid = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  if (-not @($identity.Groups | Where-Object { $_.Equals($adminSid) }).Count) {
    throw 'Sign in to a Windows administrator account and run the installer there; another administrator entering credentials cannot resume this enrollment'
  }
}
function Get-InviteFacts([string] $code) {
  if ($code -cnotmatch '^wk1[A-Za-z0-9_-]{38,297}$') { throw 'Invalid invite shape' }
  $b64 = $code.Substring(3).Replace('-', '+').Replace('_', '/')
  $b64 = $b64.PadRight($b64.Length + ((4 - $b64.Length % 4) % 4), '=')
  $bytes = [Convert]::FromBase64String($b64)
  if ($bytes.Length -lt 140 -or $bytes[0] -ne 1) { throw 'Invalid invite body' }
  $team = [BitConverter]::ToString($bytes, 1, 8).Replace('-', '').ToLowerInvariant()
  $expires = (([uint64]$bytes[65] -shl 24) -bor ([uint64]$bytes[66] -shl 16) -bor ([uint64]$bytes[67] -shl 8) -bor [uint64]$bytes[68])
  # The owner node that signed the invite (bytes 41..48) and the invite's id, sha256 of its one-use secret (bytes 49..64),
  # first 32 hex: what an owner SSH packet in the same link must name. Neither is a secret and neither admits anything.
  $issuer = [BitConverter]::ToString($bytes, 41, 8).Replace('-', '').ToLowerInvariant()
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = $sha.ComputeHash([byte[]]$bytes[49..64]) } finally { $sha.Dispose() }
  $inviteId = ([BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()).Substring(0, 32)
  return @{ team = $team; expiresAt = [long]$expires * 1000; issuer = $issuer; inviteId = $inviteId }
}
function Protect-Data([string] $value) {
  $secure = ConvertTo-SecureString -String $value -AsPlainText -Force
  return ConvertFrom-SecureString -SecureString $secure
}
function Unprotect-Data([string] $cipher) {
  $secure = ConvertTo-SecureString -String $cipher
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Save-Journal($journal) {
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  $tmp = "$journalPath.tmp"
  [IO.File]::WriteAllText($tmp, ($journal | ConvertTo-Json -Depth 5), [Text.Encoding]::UTF8)
  Move-Item -LiteralPath $tmp -Destination $journalPath -Force
}
function Read-Journal {
  if (-not (Test-Path -LiteralPath $journalPath)) { throw 'Enrollment journal missing' }
  return Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
}
function Assert-Journal($journal) {
  if ($journal.release -cne $Release -or $journal.phase -notin @('await-reboot', 'installing') -or [int]$journal.attempts -ge 3) { throw 'Unexpected enrollment release or exhausted resume' }
  if ($journal.joinAdmitted -eq $true) {
    if ($journal.joinStarted -ne $true -or $null -ne $journal.code) { throw 'Admitted journal retains invite' }
    return $null
  }
  $code = Unprotect-Data ([string]$journal.code)
  $facts = Get-InviteFacts $code
  if ($facts.team -cne $journal.team -or $facts.expiresAt -ne [long]$journal.expiresAt -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $facts.expiresAt) { throw 'Invite expired or enrollment team changed' }
  return $code
}
function Convert-DerSignature([byte[]] $der) {
  if ($der.Length -lt 8 -or $der[0] -ne 0x30 -or $der[1] -ne $der.Length - 2) { throw 'Invalid release signature encoding' }
  $offset = 2; $out = New-Object byte[] 64
  foreach ($part in 0, 1) {
    if ($der[$offset] -ne 2) { throw 'Invalid release signature integer' }
    $length = [int]$der[$offset + 1]; $offset += 2
    if ($length -lt 1 -or $length -gt 33 -or $offset + $length -gt $der.Length) { throw 'Invalid release signature length' }
    $value = [byte[]]$der[$offset..($offset + $length - 1)]
    if ($length -eq 33) { if ($value[0] -ne 0) { throw 'Invalid release signature padding' }; $value = [byte[]]$value[1..32] }
    [Array]::Copy($value, 0, $out, $part * 32 + 32 - $value.Length, $value.Length); $offset += $length
  }
  if ($offset -ne $der.Length) { throw 'Trailing release signature data' }
  return ,$out
}
function Assert-SignedFiles {
  $bytes = [IO.File]::ReadAllBytes($ManifestPath)
  $spki = [Convert]::FromBase64String('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgkx2EdLfMqWSGF8WsQZH3Gtu2spEoaH2+rvI0pAS8YP+YMv/PtLnx0Vuuqvl1DA5gIeotdirB6ixuE90qd3lfw==')
  if ($spki.Length -ne 91 -or $spki[26] -ne 4) { throw 'Invalid pinned key' }
  $blob = New-Object byte[] 72
  [Array]::Copy([byte[]](0x45,0x43,0x53,0x31,0x20,0,0,0), $blob, 8)
  [Array]::Copy($spki, 27, $blob, 8, 64)
  $key = [Security.Cryptography.CngKey]::Import($blob, [Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
  $verifier = [Security.Cryptography.ECDsaCng]::new($key)
  try {
    $verifier.HashAlgorithm = [Security.Cryptography.CngAlgorithm]::Sha256
    $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    if (-not $verifier.VerifyHash($digest, (Convert-DerSignature ([IO.File]::ReadAllBytes($SignaturePath))))) { throw 'Release signature failed' }
  } finally { $verifier.Dispose(); $key.Dispose() }
  $lines = [Text.Encoding]::UTF8.GetString($bytes) -split "`r?`n"
  $versions = @($lines | Where-Object { $_ -match '^version ' })
  if ($versions.Count -ne 1 -or $versions[0] -cne "version $Release") { throw 'Unexpected signed release' }
  foreach ($asset in @('walkie-windows-bootstrap.ps1', 'walkie-windows-stage0.ps1', 'install.sh')) {
    $rows = @($lines | Where-Object { $_ -match "^[0-9a-fA-F]{64}  $([regex]::Escape($asset))$" })
    if ($rows.Count -ne 1) { throw "Missing or duplicated $asset" }
    $path = if ($asset -eq 'install.sh') { $InstallerPath } elseif ($asset -eq 'walkie-windows-stage0.ps1') { $Stage0Path } else { $PSCommandPath }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -cne $rows[0].Substring(0,64).ToLowerInvariant()) { throw "Signed hash mismatch for $asset" }
  }
}
function Merge-Ini([string] $path, [string] $section, [string] $key, [string] $value) {
  $text = if (Test-Path -LiteralPath $path) { [IO.File]::ReadAllText($path) } else { '' }
  $eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines = [Collections.Generic.List[string]]::new()
  if ($text) { foreach ($line in ($text -split "`r?`n")) { $lines.Add($line) }; if ($lines.Count -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) } }
  $start = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].Trim() -ieq "[$section]") { $start = $i; break } }
  if ($start -lt 0) { $lines.Add("[$section]"); $lines.Add("$key=$value") }
  else {
    $end = $lines.Count
    for ($i = $start + 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*\[.*\]\s*$') { $end = $i; break } }
    $matches = @()
    for ($i = $start + 1; $i -lt $end; $i++) { if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") { $matches += $i } }
    for ($i = $matches.Count - 1; $i -ge 1; $i--) { $lines.RemoveAt($matches[$i]) }
    if ($matches.Count) { $lines[$matches[0]] = "$key=$value" }
    else { $lines.Insert($start + 1, "$key=$value") }
  }
  [IO.File]::WriteAllText($path, (($lines -join $eol) + $eol), [Text.Encoding]::UTF8)
}
function Invoke-WslInput([string] $user, [string] $command, [string] $inputText, [bool] $sensitive = $false) {
  Assert-Name $user
  $script:WslStderr = ''
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $wsl
  $psi.Arguments = "-d Ubuntu -u $user -- $command"
  $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = [Diagnostics.Process]::Start($psi)
  try {
    $proc.StandardInput.Write($inputText); $proc.StandardInput.Close()
    $outTask = $proc.StandardOutput.ReadToEndAsync(); $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(600000)) { $proc.Kill(); throw 'WSL command timed out' }
    $out = $outTask.Result; $err = $errTask.Result
    if ($proc.ExitCode -ne 0) {
      if ($sensitive) { throw "WSL private handoff failed ($($proc.ExitCode))" }
      throw "WSL command failed ($($proc.ExitCode)): $($err.Substring(0, [Math]::Min(300, $err.Length)))"
    }
    $script:WslStderr = if ($sensitive) { '' } else { $err }
    return $out
  } finally { $proc.Dispose() }
}
# Owner SSH (a link that carried the owner's signed SSH authorization). The one root batch is this elevated process: WSL
# runs the root helper as root, so there is no sudo and no second prompt. The helper installs the root-owned marker and the
# loopback-only SSH service (embedded in the walkie binary), then the consent is recorded with the packet in the same
# request, then SSH is judged ONLY by `walkie ssh status`. Returns one plain sentence; a failure here never tears down the
# rest of the enrollment, and the packet is never printed, logged or placed in a command line. When the WSL step left SSH out of the
# consent it recorded (an SSH server that is not Walkie's already answers in this Ubuntu, or the authorization does not fit this
# enrollment) it says why on its standard error; the status can then only say that no authorization is recorded, so that sentence is
# the summary instead of the status's fix (a new add-machine link would meet the same server). Static: untested without pwsh.
function Enable-OwnerSsh([string] $user, [string] $walkie, $journal, [string] $packet) {
  Assert-Name $user
  try {
    $uid = (Invoke-WslInput 'root' "/usr/bin/id -u $user" '').Trim()
    if ($uid -cnotmatch '^[0-9]{1,10}$') { throw 'Could not read the Ubuntu user id' }
    $installNote = ''
    try {
      Invoke-WslInput 'root' "/usr/bin/env SUDO_UID=$uid $walkie provision root-marker install /home/$user/.walkie ssh-linux" '' | Out-Null
    } catch {
      # Exit 5: the marker is in place and only the SSH service install stopped (an SSH server is already configured, or a package step failed). The consent is still recorded; the status below says whether SSH is ready.
      if ($_.Exception.Message -notlike 'WSL command failed (5)*') { throw }
      $installNote = ' The SSH service install stopped: ' + ($_.Exception.Message -replace '^WSL command failed \(5\): ', '')
    }
    $grant = [ordered]@{ owner_node = [string]$journal.ownerNode; owner_handle = [string]$journal.owner; launchers = @($journal.launchers); seat_cap = [int]$journal.maxSeats; profile = [string]$journal.profile; invite_id = [string]$journal.inviteId; owner_ssh = $packet } | ConvertTo-Json -Compress
    Invoke-WslInput $user "$walkie provision grant-bootstrap" $grant | Out-Null
    $leftOut = $script:WslStderr.Trim()
    $verdict = (Invoke-WslInput $user "$walkie ssh status --wait --json" '') | ConvertFrom-Json
    if ($verdict.state -eq 'ready') { return 'Owner SSH is ready: the server answers on 127.0.0.1, the owner key is installed and the tunnel is open.' }
    if ($verdict.code -eq 'grant_absent' -and $leftOut) { return "Owner SSH was left out of the consent recorded: $($leftOut.Substring(0, [Math]::Min(400, $leftOut.Length)))$installNote" }
    return "Owner SSH is NOT ready ($($verdict.code)): $($verdict.why). What fixes it: $($verdict.fix)$installNote"
  } catch { return "Owner SSH was not enabled: $($_.Exception.Message)" }
}
function Test-UbuntuPresent {
  $registered = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue |
    ForEach-Object { (Get-ItemProperty -LiteralPath $_.PSPath).DistributionName })
  $distros = @(& $wsl --list --quiet 2>$null | ForEach-Object { $_.Replace([char]0, '').Trim() })
  if ($LASTEXITCODE -ne 0) {
    if ($registered -contains 'Ubuntu') { throw 'Existing Ubuntu cannot be inspected before enrollment' }
    return $false
  }
  return $distros -contains 'Ubuntu'
}
function Assert-ExistingUbuntuTeam($journal) {
  if (-not (Test-UbuntuPresent)) { return }
  $probe = @'
set -eu
for p in /home/*/.walkie /root/.walkie; do
  if [ -e "$p/walkie.db" ] || [ -e "$p/node.key" ]; then printf '%s\n' "$p"; fi
done
'@
  $homes = @((Invoke-WslInput 'root' '/bin/sh -s' $probe).Trim() -split "`n" | Where-Object { $_ })
  if (-not $homes.Count) { return }
  $user = [string]$journal.user
  if ($homes.Count -ne 1 -or $homes[0] -cne "/home/$user/.walkie" -or $journal.joinStarted -ne $true) {
    throw 'Ubuntu already contains Walkie state; use a fresh Ubuntu instance'
  }
  $walkie = "/home/$user/.local/bin/walkie"
  $observed = (Invoke-WslInput $user "$walkie daemon status --json" '') | ConvertFrom-Json
  if (-not $observed.me.team) {
    if ($journal.joinAdmitted -eq $true -or -not $journal.code) { throw 'Join admission is unconfirmed and invite is missing' }
    return
  }
  if ($observed.me.team.id -cne $journal.team) { throw 'This Ubuntu is already joined to another team' }
}
function Register-Resume {
  # The task embeds the fixed, code-free verifier, not a user-writable payload path.
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([IO.File]::ReadAllText($Stage0Path)))
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ("-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded")
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $resumeName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
}
function Register-KeepAlive([string] $user) {
  Assert-Name $user
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$sid</UserId><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>C:\Windows\System32\wsl.exe</Command><Arguments>-d Ubuntu -u $user -- sleep infinity</Arguments></Exec></Actions>
</Task>
"@
  Register-ScheduledTask -TaskName $keepAliveName -Xml $xml -Force | Out-Null
  Start-ScheduledTask -TaskName $keepAliveName
}
function Finish-Enrollment {
  Unregister-ScheduledTask -TaskName $resumeName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $HandoffPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
}
function Write-PackageReceipt($journal) {
  $receiptDir = Join-Path $env:LOCALAPPDATA 'WalkieEnroll\receipts'
  $receiptPath = Join-Path $receiptDir 'packages.json'
  New-Item -ItemType Directory -Path $receiptDir -Force | Out-Null
  $receipt = @{ release=$journal.release; team=$journal.team; packages=$journal.packageVersions; recordedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $tmp = "$receiptPath.tmp"
  [IO.File]::WriteAllText($tmp, ($receipt | ConvertTo-Json -Depth 5), [Text.Encoding]::UTF8)
  Move-Item -LiteralPath $tmp -Destination $receiptPath -Force
}
function Request-Reboot($journal) {
  $journal.phase = 'await-reboot'; Save-Journal $journal
  Register-Resume
  if (-not $Resume) { Read-Host 'Windows needs a restart. Press Enter to restart now' | Out-Null }
  Restart-Computer
}

try {
  if (-not $Resume) {
    if ($Release -cnotmatch '^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]{1,40})?$') { throw 'Invalid release' }
    Assert-SignedFiles
  }
  if (-not $Elevated -and -not $Resume) {
    Assert-CanSelfElevate
    $handoff = Get-Content -LiteralPath $HandoffPath -Raw | ConvertFrom-Json
    $code = [string]$handoff.code
    $facts = Get-InviteFacts $code
    $team = [string]$handoff.team; Assert-Hex $team
    $user = [string]$handoff.user; Assert-Name $user
    if ($team -cne $facts.team -or $Release -cne [string]$handoff.release -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $facts.expiresAt) { throw 'Private handoff expired or mismatched' }
    if ([string]$handoff.distro -cne 'Ubuntu' -or [int]$handoff.maxSeats -lt 1 -or [int]$handoff.maxSeats -gt 64) { throw 'Unsupported distro or seat cap' }
    if ([string]$handoff.owner -cnotmatch '^[a-z][a-z0-9-]{0,23}$') { throw 'Invalid owner' }
    if ([string]$handoff.profile -cnotin @('developer-worker', 'freight-worker')) { throw 'Unsupported provisioning profile' }
    $launchers = @($handoff.launchers)
    if ($launchers.Count -gt 20 -or @($launchers | Where-Object { $_ -cnotmatch '^@[a-z][a-z0-9-]{0,23}(?:/[A-Za-z0-9._-]{1,80}/[A-Za-z0-9._-]{1,80})?$' }).Count) { throw 'Invalid launchers' }
    $namedLaunchers = if ($launchers.Count) { $launchers -join ', ' } else { "the team's owners" }
    $ownerSsh = $null
    $sshField = $handoff.PSObject.Properties['ownerSsh']
    if ($sshField -and -not [string]::IsNullOrEmpty([string]$sshField.Value)) {
      if ([string]$sshField.Value -cmatch '^[A-Za-z0-9_-]{1,1200}$') { $ownerSsh = [string]$sshField.Value }
      else { Write-Host "This link can't turn on owner SSH: its SSH authorization is damaged. Ask the owner for a new link. Enrollment continues without SSH." }
    }
    Write-Host "Allow $($handoff.owner) and $namedLaunchers to provision this company machine and run agents as your Windows-WSL user $user?"
    Write-Host 'Owners can use allow-listed remote admin commands. Launched agents can run arbitrary code, read/change your files and keys, and use your Walkie daemon as you.'
    Write-Host 'Owner-provided subscription logins may be leased for a run. Walkie records who provisioned and launched.'
    Write-Host "Seat cap: $($handoff.maxSeats). Profile: $($handoff.profile). Walkie permanently keeps Ubuntu running after logon, including on battery."
    Write-Host 'WSL will shut down once to activate systemd; running WSL sessions will stop.'
    if ($handoff.acSleepNever -eq $true) { Write-Host 'AC sleep will be set to never.' }
    if ($ownerSsh) {
      Write-Host "$($handoff.owner), their everyday agents and WalkieTalkie may also sign in to this Ubuntu over SSH as your user $user, through Walkie. Walkie records the caller, source machine, session time and duration, but not session content, and posts one summary to you."
      Write-Host 'This uses a Walkie SSH service that listens only on this machine and accepts only key logins; Walkie installs it in Ubuntu in the same elevation. Revoke with walkie ssh revoke, walkie admin remote off, or by leaving the team.'
    }
    Write-Host 'Stop seats: walkie seats deny. Stop remote setup: walkie admin remote off and walkie agents admin off. You can leave the team.'
    if ((Read-Host 'Type ALLOW to consent') -cne 'ALLOW') { throw 'Consent declined' }
    $journal = @{ phase='installing'; attempts=0; release=$Release; team=$team; expiresAt=$facts.expiresAt; code=(Protect-Data $code); user=$user; owner=$handoff.owner; launchers=$launchers; maxSeats=[int]$handoff.maxSeats; profile=[string]$handoff.profile; acSleepNever=($handoff.acSleepNever -eq $true); ownerNode=$facts.issuer; inviteId=$facts.inviteId; ownerSsh=$(if ($ownerSsh) { Protect-Data $ownerSsh } else { $null }); joinStarted=$false; joinAdmitted=$false; uacEntered=$false; packageVersions=@{} }
    Save-Journal $journal
    Remove-Item -LiteralPath $HandoffPath -Force
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([IO.File]::ReadAllText($Stage0Path)))
    $args = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $child = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $args -Verb RunAs -Wait -PassThru
    if ($child.ExitCode -ne 0) { throw "Elevated enrollment failed ($($child.ExitCode))" }
    return
  }
  Assert-SignedFiles
  $journal = Read-Journal
  $code = Assert-Journal $journal
  if ($Resume) { $journal.attempts = [int]$journal.attempts + 1; $journal.phase = 'installing'; Save-Journal $journal }
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not ($Elevated -or $Resume) -or -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Root work requires one UAC elevation' }
  $user = [string]$journal.user; Assert-Name $user
  Assert-ExistingUbuntuTeam $journal
  $journal.uacEntered = $true; Save-Journal $journal
  if (-not (Get-ScheduledTask -TaskName $resumeName -ErrorAction SilentlyContinue)) { Register-Resume }
  foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
    $state = (Get-WindowsOptionalFeature -Online -FeatureName $feature).State
    if ($state -ne 'Enabled') {
      Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart | Out-Null
      $journal.phase = 'await-reboot'; Save-Journal $journal
    }
  }
  if ($journal.phase -eq 'await-reboot') {
    Request-Reboot $journal
    return
  }
  if (-not (Test-UbuntuPresent)) {
    & $wsl --install -d Ubuntu --no-launch
    $installExit = $LASTEXITCODE
    if ($installExit -notin @(0, 3010)) { throw 'Ubuntu installation failed' }
    if ($installExit -eq 3010 -or -not (Test-UbuntuPresent)) { Request-Reboot $journal; return }
  }
  $rootScript = @'
set -eu
u="$1"
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
if [ "${ID:-}" != ubuntu ] || ! printf '%s' "${VERSION_CODENAME:-}" | grep -Eq '^[a-z]+$'; then
  echo 'WSL must use a supported Ubuntu release for package installation' >&2; exit 1
fi
ubuntu_codename="$VERSION_CODENAME"
if [ "${2:-}" = allow-extra ]; then
  apt-get -o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false update -qq
  apt-get -o APT::Get::AllowUnauthenticated=false install -y -qq curl openssl ca-certificates python3
else
  if [ ! -f /usr/share/keyrings/ubuntu-archive-keyring.gpg ]; then
    echo 'Ubuntu archive keyring is missing; package installation stopped' >&2; exit 1
  fi
  case "$(dpkg --print-architecture)" in
    amd64|i386) archive=http://archive.ubuntu.com/ubuntu; security=http://security.ubuntu.com/ubuntu ;;
    arm64|armhf|ppc64el|s390x) archive=http://ports.ubuntu.com/ubuntu-ports; security="$archive" ;;
    *) echo 'Unsupported Ubuntu architecture for package installation' >&2; exit 1 ;;
  esac
  apt_dir=$(mktemp -d)
  trap 'rm -rf "$apt_dir"' EXIT
  mkdir -p "$apt_dir/lists/partial"
  chmod 755 "$apt_dir" "$apt_dir/lists"
  chown _apt:root "$apt_dir/lists/partial"
  printf 'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] %s %s main restricted universe multiverse\n' "$archive" "$ubuntu_codename" "$archive" "$ubuntu_codename-updates" "$security" "$ubuntu_codename-security" > "$apt_dir/sources.list"
  ubuntu_apt() {
    apt-get -o Dir::Etc::sourcelist="$apt_dir/sources.list" -o Dir::Etc::sourceparts=- -o Dir::State::lists="$apt_dir/lists" -o Dir::Etc::Trusted=/usr/share/keyrings/ubuntu-archive-keyring.gpg -o Dir::Etc::TrustedParts=- "$@"
  }
  ubuntu_apt -o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false update -qq
  # WALKIE_APT_SOURCE_GUARD_BEGIN
  apt_cache_policy() {
    apt-cache -o Dir::Etc::sourcelist="$apt_dir/sources.list" -o Dir::Etc::sourceparts=- -o Dir::State::lists="$apt_dir/lists" policy "$1"
    apt-cache policy "$1" | sed -n '/^[[:space:]]*Version table:/,$p'
  }
  assert_package_sources() {
    apt_cache_policy "$1" | awk -v distro="$ubuntu_codename" '
      $1 == "Candidate:" { candidate = $2; next }
      $1 == "***" && $3 ~ /^-?[0-9]+$/ { version = $2; next }
      $2 ~ /^-?[0-9]+$/ && $1 !~ /^-?[0-9]+$/ { version = $1; next }
      $1 ~ /^-?[0-9]+$/ && $2 !~ /^-?[0-9]+$/ && $2 != "/var/lib/dpkg/status" {
        source = 1
        suite = $3; sub(/\/.*/, "", suite)
        official = $2 ~ /^https?:\/\/(archive\.ubuntu\.com\/ubuntu|security\.ubuntu\.com\/ubuntu|ports\.ubuntu\.com\/ubuntu-ports)\/?$/
        official = official && (suite == distro || suite == distro "-updates" || suite == distro "-security" || suite == distro "-backports")
        if (!official) bad = 1
        if (official && version == candidate) candidate_official = 1
      }
      END { if (!source || bad || !candidate_official || candidate == "(none)") exit 1 }
    ' || { echo "WALKIE_APT_SOURCES_BLOCKED: $1 has a non-Ubuntu source or no official candidate" >&2; return 1; }
  }
  # WALKIE_APT_SOURCE_GUARD_END
  for package in curl openssl ca-certificates python3; do assert_package_sources "$package"; done
  ubuntu_apt -o APT::Get::AllowUnauthenticated=false install --reinstall -y -qq curl openssl ca-certificates python3
fi
id -u "$u" >/dev/null 2>&1 || useradd -m -s /bin/bash "$u"
python3 - "$u" <<'PY'
import pathlib, re, sys
p = pathlib.Path('/etc/wsl.conf')
s = p.read_text() if p.exists() else ''
def merge(s, section, key, value):
    lines = s.splitlines()
    start = next((i for i, line in enumerate(lines) if line.strip().lower() == '[' + section + ']'), None)
    if start is None:
        lines += ['[' + section + ']', key + '=' + value]
    else:
        end = next((i for i in range(start + 1, len(lines)) if re.match(r'^\s*\[.*\]\s*$', lines[i])), len(lines))
        indices = [i for i in range(start + 1, end) if re.match(r'^\s*' + key + r'\s*=', lines[i], re.I)]
        for i in reversed(indices[1:]): del lines[i]
        if indices: lines[indices[0]] = key + '=' + value
        else: lines.insert(start + 1, key + '=' + value)
    return '\n'.join(lines) + '\n'
s = merge(s, 'boot', 'systemd', 'true')
s = merge(s, 'user', 'default', sys.argv[1])
p.write_text(s)
PY
printf 'WALKIE_PACKAGES_BEGIN\n'
dpkg-query -W -f='${Package}\t${Version}\n' -- curl openssl ca-certificates python3
printf 'WALKIE_PACKAGES_END\n'
'@
  try { $rootOutput = Invoke-WslInput 'root' "/bin/sh -s -- $user" $rootScript }
  catch {
    if ($_.Exception.Message -notlike '*WALKIE_APT_SOURCES_BLOCKED*') { throw }
    Write-Host 'Ubuntu has an extra APT source for a Walkie bootstrap package, or no candidate from the official Ubuntu archive.'
    Write-Host 'Using that source may install third-party code. Remove it from Ubuntu to continue with the official archive.'
    if ((Read-Host 'To use the configured APT sources and keys anyway, type ALLOW-EXTRA-APT-SOURCES') -cne 'ALLOW-EXTRA-APT-SOURCES') { throw 'APT source override declined' }
    $rootOutput = Invoke-WslInput 'root' "/bin/sh -s -- $user allow-extra" $rootScript
  }
  $versionRows = [regex]::Match($rootOutput, '(?s)WALKIE_PACKAGES_BEGIN\r?\n(.*?)\r?\nWALKIE_PACKAGES_END')
  if (-not $versionRows.Success) { throw 'Ubuntu package version receipt missing' }
  $packageVersions = @{}
  foreach ($line in ($versionRows.Groups[1].Value -split "`r?`n")) {
    if ($line -cnotmatch '^([a-z0-9-]+)\t([A-Za-z0-9.+:~_-]{1,100})$' -or $packageVersions.ContainsKey($matches[1])) { throw 'Invalid Ubuntu package version receipt' }
    $packageVersions[$matches[1]] = $matches[2]
  }
  if ($packageVersions.Count -ne 4) { throw 'Unexpected Ubuntu package version receipt' }
  foreach ($name in @('curl','openssl','ca-certificates','python3')) {
    if (-not $packageVersions.ContainsKey($name)) { throw 'Unexpected Ubuntu package version receipt' }
  }
  $journal.packageVersions = $packageVersions; Save-Journal $journal
  & $wsl --shutdown
  if ($LASTEXITCODE -ne 0) { throw 'WSL shutdown for systemd failed' }
  Invoke-WslInput 'root' "/usr/bin/loginctl enable-linger $user" '' | Out-Null
  $config = Join-Path $env:USERPROFILE '.wslconfig'
  Merge-Ini $config 'wsl2' 'vmIdleTimeout' '-1'
  Register-KeepAlive $user
  if ($journal.acSleepNever -eq $true) { powercfg /change standby-timeout-ac 0; if ($LASTEXITCODE -ne 0) { throw 'AC sleep policy failed' } }
  $installer = [IO.File]::ReadAllText($InstallerPath)
  Invoke-WslInput $user "/usr/bin/env WALKIE_INSTALL_ONLY=1 WALKIE_VERSION=$Release /bin/sh -s" $installer | Out-Null
  $walkie = "/home/$user/.local/bin/walkie"
  Invoke-WslInput $user "$walkie daemon install" '' | Out-Null
  Invoke-WslInput $user "$walkie daemon start" '' | Out-Null
  $beforeJoin = (Invoke-WslInput $user "$walkie daemon status --json" '') | ConvertFrom-Json
  if ($beforeJoin.me.team -and $beforeJoin.me.team.id -cne $journal.team) { throw 'This Ubuntu is already joined to another team' }
  if ($beforeJoin.me.team -and -not $journal.joinStarted) { throw 'This Ubuntu was already joined before this enrollment' }
  if (-not $beforeJoin.me.team) {
    $journal.joinStarted = $true; Save-Journal $journal
    # This CLI reads the private invite from stdin. It never appears in process arguments or output.
    Invoke-WslInput $user "$walkie join --invite-stdin" "$code`n" $true | Out-Null
  }
  $afterJoin = (Invoke-WslInput $user "$walkie daemon status --json" '') | ConvertFrom-Json
  if (-not $afterJoin.me.team -or $afterJoin.me.team.id -cne $journal.team) { throw 'Joined team differs from private handoff' }
  $journal.joinAdmitted = $true; $journal.code = $null; Save-Journal $journal
  $code = $null
  $sshSummary = $null
  if ($null -ne $journal.ownerSsh) {
    $packet = Unprotect-Data ([string]$journal.ownerSsh)
    $sshSummary = Enable-OwnerSsh $user $walkie $journal $packet
    $packet = $null
    $journal.ownerSsh = $null; Save-Journal $journal
  }
  $launchers = (@($journal.launchers) -join ',')
  $seatCommand = "$walkie seats allow --same-user --max $($journal.maxSeats)"
  if ($launchers) { $seatCommand += " --launchers $launchers" }
  Invoke-WslInput $user '/bin/sh -s' "set -eu`n/usr/bin/script -q -e -c '$seatCommand' /dev/null`n" | Out-Null
  Write-PackageReceipt $journal
  $journal.phase = 'complete'; Save-Journal $journal
  Finish-Enrollment
  Write-Host 'Walkie joined. Seat readiness still depends on owner provisioning and account leases; run walkie seats doctor inside Ubuntu.'
  if ($sshSummary) { Write-Host $sshSummary }
} catch {
  [Console]::Error.WriteLine('Windows enrollment stopped: ' + $_.Exception.Message)
  if (Test-Path -LiteralPath $journalPath) {
    $current = Read-Journal
    if ($current.phase -ne 'await-reboot') {
      Unregister-ScheduledTask -TaskName $keepAliveName -Confirm:$false -ErrorAction SilentlyContinue
      Finish-Enrollment
    }
  } else { Remove-Item -LiteralPath $HandoffPath -Force -ErrorAction SilentlyContinue }
  throw
}
