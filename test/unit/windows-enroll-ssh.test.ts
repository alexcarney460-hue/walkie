// WALK-67 lane 8, WSL: the owner SSH packet through the Windows bootstrap. No Windows host and no PowerShell here, so
// like the rest of the bootstrap's tests this pins the script's structure and the policy it mirrors (scripts/windows/
// model.ts): a damaged packet is dropped before the consent and said plainly, a carried one is described in the same
// consent, held DPAPI-protected and removed after use, the SSH service is installed inside the one elevation as WSL root
// with no sudo and no second prompt, the consent is recorded with the packet in one stdin request, and SSH is reported
// ready only from `walkie ssh status`. A real Windows + Ubuntu run remains unverified.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInvite, decodeInvite } from "../../src/daemon/invite.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { inviteBinding, ownerSshHandoff } from "../../scripts/windows/model.ts";
import { SSH_INSTALL_EXIT } from "../../src/cli/root-batch.ts";

const windows = join(import.meta.dir, "../../scripts/windows");
const bootstrap = readFileSync(join(windows, "bootstrap.ps1"), "utf8");
const readme = readFileSync(join(windows, "README.md"), "utf8");
const lines = bootstrap.split("\n");
const at = (needle: string, from = 0): number => { const i = bootstrap.indexOf(needle, from); expect(i, needle).toBeGreaterThan(-1); return i; };
/** The body of a top-level PowerShell function. */
const fn = (name: string): string => new RegExp(`function ${name}\\b[\\s\\S]*?\\n\\}\\n`).exec(bootstrap)?.[0] ?? "";

describe("the handoff's optional owner SSH packet", () => {
  test("absent, well-formed base64url up to 1200 characters, or damaged: the policy bootstrap.ps1 mirrors", () => {
    expect(ownerSshHandoff(undefined)).toEqual({ state: "absent" });
    expect(ownerSshHandoff(null)).toEqual({ state: "absent" });
    expect(ownerSshHandoff("")).toEqual({ state: "absent" });
    expect(ownerSshHandoff("abc_DEF-123")).toEqual({ state: "carried", packet: "abc_DEF-123" });
    expect(ownerSshHandoff("A".repeat(1200)).state).toBe("carried");
    for (const bad of ["A".repeat(1201), "a b", "a+b", "a=", "a/b", 7, {}, ["x"], "x\n"]) expect(ownerSshHandoff(bad).state).toBe("damaged");
    expect(bootstrap).toContain("'^[A-Za-z0-9_-]{1,1200}$'");
  });
  test("the bootstrap drops a damaged one before the consent, says so plainly, and a carried one is described in the same consent", () => {
    const consent = at("Read-Host 'Type ALLOW to consent'");
    expect(at("This link can't turn on owner SSH: its SSH authorization is damaged. Ask the owner for a new link. Enrollment continues without SSH.")).toBeLessThan(consent);
    const described = at("may also sign in to this Ubuntu over SSH as your user $user, through Walkie");
    expect(described).toBeLessThan(consent);
    expect(bootstrap.slice(described, consent)).toContain("Revoke with walkie ssh revoke, walkie admin remote off, or by leaving the team.");
    // Item 8: the same words the other platforms' consent uses for the service, and no stale "loopback-only ... in Ubuntu" wording.
    expect(bootstrap.slice(described, consent)).toContain("a Walkie SSH service that listens only on this machine and accepts only key logins");
    expect(bootstrap.slice(described, consent)).not.toContain("loopback-only SSH service in Ubuntu");
    expect(bootstrap.slice(described - 200, described)).toContain("if ($ownerSsh) {");
    // One consent: the same single ALLOW prompt, no second Read-Host about SSH.
    expect(bootstrap.match(/Read-Host 'Type ALLOW to consent'/g)).toHaveLength(1);
    expect(bootstrap.slice(described, consent)).not.toContain("Read-Host");
  });
  test("a carried packet is held DPAPI-protected in the journal like the code, only after the consent, and removed after use", () => {
    const consent = at("Read-Host 'Type ALLOW to consent'");
    const journal = at("ownerSsh=$(if ($ownerSsh) { Protect-Data $ownerSsh } else { $null })");
    expect(journal).toBeGreaterThan(consent);
    expect(bootstrap).toContain("ownerNode=$facts.issuer; inviteId=$facts.inviteId;");
    const cleared = at("$journal.ownerSsh = $null; Save-Journal $journal");
    expect(cleared).toBeGreaterThan(at("$sshSummary = Enable-OwnerSsh $user $walkie $journal $packet"));
    expect(bootstrap).toContain("$packet = Unprotect-Data ([string]$journal.ownerSsh)");
    expect(bootstrap).toContain("$packet = $null");
    expect(bootstrap).toMatch(/Finish-Enrollment[\s\S]*Remove-Item -LiteralPath \$stateDir -Recurse/); // the journal (and so the protected packet) goes with the rest
  });
  test("the packet is never printed, logged, put in a URL, a command line or an argument", () => {
    const mentions = lines.filter((l) => /\$packet\b|\$ownerSsh\b|\.ownerSsh\b|\$sshField\b/.test(l));
    expect(mentions.length).toBeGreaterThan(0);
    for (const l of mentions) {
      expect(l, l).not.toMatch(/Write-Host|Write-Output|Write-Error|Write-Warning|Write-Verbose|Out-File|Add-Content|Set-Content|\[Console\]|Start-Process|ArgumentList|\$psi\.Arguments|Invoke-WebRequest|\$args/);
    }
    const body = fn("Enable-OwnerSsh");
    // The packet reaches WSL only as a field of the JSON that Invoke-WslInput sends on stdin.
    expect(body.match(/\$packet/g)).toHaveLength(2); // the parameter and the JSON field
    expect(body).toContain("owner_ssh = $packet } | ConvertTo-Json -Compress");
    expect(body).toContain('Invoke-WslInput $user "$walkie provision grant-bootstrap" $grant | Out-Null');
    for (const call of body.match(/Invoke-WslInput [^\n]*/g) ?? []) expect(call).not.toMatch(/\$packet|owner_ssh/);
  });
});

describe("inside the one elevation: no sudo, no second prompt", () => {
  const body = fn("Enable-OwnerSsh");
  test("the root helper runs as WSL root inside the already elevated process, with the SSH service in the same call", () => {
    expect(body).not.toMatch(/\bsudo\b/);
    expect(body).not.toMatch(/Start-Process|Read-Host|RunAs|Get-Credential/);
    const rootCalls = body.match(/Invoke-WslInput 'root'[^\n]*/g) ?? [];
    expect(rootCalls).toHaveLength(2); // the user id lookup, then the one batch
    expect(rootCalls[1]).toBe("Invoke-WslInput 'root' \"/usr/bin/env SUDO_UID=$uid $walkie provision root-marker install /home/$user/.walkie ssh-linux\" '' | Out-Null");
    expect(bootstrap.match(/ssh-linux/g)).toHaveLength(1); // the one call, nowhere else
    expect(readFileSync(join(import.meta.dir, "../../src/cli/main.ts"), "utf8")).toContain('rest[3] === "ssh-linux"');
    expect(SSH_INSTALL_EXIT).toBe(5); // the literal the bootstrap tests for
  });
  test("order: the marker and SSH service, then the one consent request, then the status that decides ready", () => {
    const marker = body.indexOf("provision root-marker install");
    const grant = body.indexOf("provision grant-bootstrap");
    const status = body.indexOf("ssh status --wait --json");
    expect(marker).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(marker);
    expect(status).toBeGreaterThan(grant);
  });
  test("ready is said only when walkie ssh status says ready; everything else says why and what fixes it", () => {
    expect(body).toContain("if ($verdict.state -eq 'ready') { return 'Owner SSH is ready:");
    expect(body.match(/Owner SSH is ready/g)).toHaveLength(1);
    expect(body).toContain('return "Owner SSH is NOT ready ($($verdict.code)): $($verdict.why). What fixes it: $($verdict.fix)$installNote"');
    expect(body).toMatch(/catch \{ return "Owner SSH was not enabled: /); // a failure here is reported, never thrown into the teardown
    // Exit 5 (marker in place, only the SSH service install stopped) still records the consent and says why; any other root failure stops the step.
    expect(body).toContain("if ($_.Exception.Message -notlike 'WSL command failed (5)*') { throw }");
    expect(body).toContain('What fixes it: $($verdict.fix)$installNote"');
    expect(body).not.toMatch(/\bthrow\b[^\n]*\n[^\n]*catch/);
  });
  test("when the WSL step left SSH out, its own sentence is the summary, not a status fix that sends the person for a new link (final review C, F4; static: no PowerShell here)", () => {
    // Invoke-WslInput keeps what a command that SUCCEEDED said on stderr: reset on every call, set only after the exit-code check, and
    // initialized at script scope first because the script runs under Set-StrictMode -Version Latest (reading an unset variable throws).
    const invoke = fn("Invoke-WslInput");
    expect(bootstrap).toContain("Set-StrictMode -Version Latest");
    expect(at("$script:WslStderr = ''")).toBeLessThan(at("function Invoke-WslInput"));
    expect(invoke.match(/\$script:WslStderr = ''/g)).toHaveLength(1);
    const keep = "$script:WslStderr = if ($sensitive) { '' } else { $err }"; // a sensitive call (the invite) keeps nothing
    expect(invoke).toContain(keep);
    expect(invoke.indexOf(keep)).toBeGreaterThan(invoke.indexOf("if ($proc.ExitCode -ne 0) {"));
    expect(invoke.indexOf(keep)).toBeLessThan(invoke.indexOf("return $out"));
    expect(invoke).not.toContain("$script:WslStderr = $err");
    // Read straight after the grant call, before the status call resets it; used only after the ready check, only when the status says
    // no authorization is recorded, and followed by the installer's own note.
    const grant = body.indexOf('Invoke-WslInput $user "$walkie provision grant-bootstrap" $grant | Out-Null');
    const kept = body.indexOf("$leftOut = $script:WslStderr.Trim()");
    const status = body.indexOf("ssh status --wait --json");
    expect(grant).toBeGreaterThan(-1);
    expect(kept).toBeGreaterThan(grant);
    expect(kept).toBeLessThan(status);
    const left = body.indexOf("if ($verdict.code -eq 'grant_absent' -and $leftOut) { return \"Owner SSH was left out of the consent recorded: ");
    expect(left).toBeGreaterThan(body.indexOf("if ($verdict.state -eq 'ready')"));
    expect(body.slice(left).split("\n")[0]).toContain('$installNote"');
    // The packet is not in it: the line names none, and the CLI never prints one (provision-bootstrap.test.ts).
    expect(body.slice(kept, body.indexOf("What fixes it"))).not.toMatch(/\$packet|owner_ssh/);
    expect(readme).toContain("prints the WSL step's own sentence");
  });
  test("the step sits after join admission and before seats, and its summary is printed after the join message", () => {
    const admitted = at("$journal.joinAdmitted = $true; $journal.code = $null; Save-Journal $journal");
    const step = at("$sshSummary = Enable-OwnerSsh $user $walkie $journal $packet");
    const seats = at("$seatCommand =");
    expect(admitted).toBeLessThan(step);
    expect(step).toBeLessThan(seats);
    expect(at("if ($sshSummary) { Write-Host $sshSummary }")).toBeGreaterThan(at("Write-Host 'Walkie joined."));
    expect(bootstrap).toContain("if ($null -ne $journal.ownerSsh) {"); // a link without a packet runs none of it
  });
  test("the JSON handed to grant-bootstrap names exactly the fields its schema takes", () => {
    const fields = [...(/\$grant = \[ordered\]@\{ ([^}]*) \}/.exec(body)?.[1] ?? "").matchAll(/(\w+) =/g)].map((m) => m[1] as string).sort();
    expect(fields).toEqual(["invite_id", "launchers", "owner_handle", "owner_node", "owner_ssh", "profile", "seat_cap"]);
    const cli = readFileSync(join(import.meta.dir, "../../src/cli/commands/provision-bootstrap.ts"), "utf8");
    for (const f of fields) expect(cli).toContain(f);
  });
});

describe("what the bootstrap reads from the invite to bind the packet", () => {
  test("the issuer node and the invite id are the daemon's: bytes 41..48 and sha256 of the secret, 16 bytes in hex", () => {
    const keys = generateKeys();
    const invite = createInvite(keys, { team: "0123456789abcdef", authority: keys.pubkey, handle: "arvid", role: "member", now: Date.now(), pos: 3 });
    const decoded = decodeInvite(invite.code);
    if ("error" in decoded) throw new Error("fixture invite is malformed");
    expect(inviteBinding(invite.code)).toEqual({ issuer: decoded.issuer, inviteId: decoded.id });
    expect(inviteBinding(invite.code).issuer).toBe(keys.nodeId);
    expect(bootstrap).toContain("[BitConverter]::ToString($bytes, 41, 8)");
    expect(bootstrap).toContain("$sha.ComputeHash([byte[]]$bytes[49..64])");
    expect(bootstrap).toContain(".Substring(0, 32)");
  });
});

test("the handoff contract documents ownerSsh, its exposure rules and the commands the bootstrap runs", () => {
  expect(readme).toContain('"ownerSsh"');
  expect(readme).toContain("never a URL query, a PowerShell argument or a log");
  expect(readme).toContain("walkie provision root-marker install /home/<user>/.walkie ssh-linux");
  expect(readme).toContain("walkie provision grant-bootstrap");
  expect(readme).toContain("walkie ssh status --wait --json");
  expect(readme).toContain("A link without `ownerSsh` behaves exactly as before");
});
