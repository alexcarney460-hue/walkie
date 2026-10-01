import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitJoin, advanceJournal, assertExistingUbuntuTeam, inviteMetadata, mergeIni, manifestHash, p256DerToP1363, parsePackageVersions, taskXml } from "../../scripts/windows/model.ts";
import { windowsCommand } from "../../scripts/windows/command.ts";
import { inviteFromStdin } from "../../src/cli/commands/team.ts";
import { wslKeepaliveChecks } from "../../src/daemon/seats/wsl-keepalive.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";

const windows = join(import.meta.dir, "../../scripts/windows");

describe("Windows enrollment policy", () => {
  test("ECDSA DER signatures convert to Windows CNG form", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const bytes = Buffer.from("version v0.2.0-pre.9\n");
    const der = sign("sha256", bytes, { key: privateKey, dsaEncoding: "der" });
    expect(verify("sha256", bytes, { key: publicKey, dsaEncoding: "ieee-p1363" }, p256DerToP1363(der))).toBe(true);
    expect(() => p256DerToP1363(der.subarray(0, der.length - 1))).toThrow();
  });
  test("signed manifest requires one exact release and asset", () => {
    const sums = "version v0.2.0-pre.9\n" + "a".repeat(64) + "  walkie-windows-bootstrap.ps1\n";
    expect(manifestHash(sums, "v0.2.0-pre.9", "walkie-windows-bootstrap.ps1")).toBe("a".repeat(64));
    expect(() => manifestHash(sums, "v0.2.0-pre.8", "walkie-windows-bootstrap.ps1")).toThrow();
    expect(() => manifestHash(`${sums}version v0.2.0-pre.9\n`, "v0.2.0-pre.9", "walkie-windows-bootstrap.ps1")).toThrow();
    expect(() => manifestHash(`${sums}${"b".repeat(64)}  walkie-windows-bootstrap.ps1\n`, "v0.2.0-pre.9", "walkie-windows-bootstrap.ps1")).toThrow();
  });

  test("merges only named INI key, preserving other WSL settings", () => {
    const old = "[wsl2]\r\nnetworkingMode=mirrored\r\nvmIdleTimeout=5000\r\nmemory=12GB\r\n[experimental]\r\nautoMemoryReclaim=gradual\r\n";
    const merged = mergeIni(old, "wsl2", "vmIdleTimeout", "-1");
    expect(merged).toContain("networkingMode=mirrored");
    expect(merged).toContain("memory=12GB");
    expect(merged).toContain("autoMemoryReclaim=gradual");
    expect(merged.match(/vmIdleTimeout/g)).toHaveLength(1);
    expect(mergeIni(merged, "wsl2", "vmIdleTimeout", "-1")).toBe(merged);
    expect(mergeIni("", "boot", "systemd", "true")).toContain("[boot]\nsystemd=true");
  });

  test("task template has persistent logon behavior", () => {
    const xml = taskXml("Ubuntu", "alex");
    const bootstrap = readFileSync(join(windows, "bootstrap.ps1"), "utf8");
    const template = /\$xml = @"\n([\s\S]*?)\n"@/.exec(bootstrap)?.[1];
    expect(template?.replaceAll("$sid", "S-1-5-21-1").replaceAll("$user", "alex")).toBe(xml);
    expect(xml).toContain("PT5M");
    expect(xml).toContain("PT0S");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("-d Ubuntu -u alex -- sleep infinity");
    expect(() => taskXml("Ubuntu;evil", "alex")).toThrow();
  });

  test("journal resumes only same release/team and before expiry", () => {
    const j = { phase: "await-reboot" as const, attempts: 1, release: "v0.2.0-pre.9", team: "0123456789abcdef", expiresAt: 2_000_000 };
    expect(advanceJournal(j, "v0.2.0-pre.9", j.team, 1_000_000)).toEqual({ ...j, phase: "installing", attempts: 2 });
    expect(advanceJournal({ ...j, phase: "installing", uacEntered: true }, j.release, j.team, 1_000_000).attempts).toBe(2);
    expect(() => advanceJournal(j, "v0.2.0-pre.8", j.team, 1_000_000)).toThrow();
    expect(() => advanceJournal(j, j.release, "ffffffffffffffff", 1_000_000)).toThrow();
    expect(() => advanceJournal(j, j.release, j.team, 2_000_000)).toThrow();
    expect(() => advanceJournal({ ...j, attempts: 3 }, j.release, j.team, 1_000_000)).toThrow();
  });

  test("admission removes the invite before seat setup and permits code-free resume", () => {
    const j = { phase: "installing" as const, attempts: 1, release: "v0.2.0-pre.9", team: "0123456789abcdef", expiresAt: 2_000_000,
      code: "protected-invite", joinStarted: true, joinAdmitted: false, uacEntered: true };
    const admitted = admitJoin(j, j.team);
    expect(admitted).toEqual({ ...j, code: null, joinAdmitted: true });
    expect(j.code).toBe("protected-invite");
    expect(advanceJournal(admitted, j.release, j.team, 3_000_000)).toEqual({ ...admitted, attempts: 2 });
    expect(() => admitJoin(j, "ffffffffffffffff")).toThrow();
    const bootstrap = readFileSync(join(windows, "bootstrap.ps1"), "utf8");
    const admission = bootstrap.indexOf("$journal.joinAdmitted = $true");
    const seats = bootstrap.indexOf("$seatCommand =");
    expect(admission).toBeGreaterThan(-1);
    expect(bootstrap.slice(admission, seats)).toMatch(/\$journal\.code = \$null; Save-Journal \$journal/);
    expect(bootstrap.slice(admission, seats)).toContain("$code = $null");
  });

  test("interrupted join resumes with no team but refuses a different team", () => {
    const pending = { phase: "await-reboot" as const, attempts: 1, release: "v0.2.0-pre.9", team: "0123456789abcdef",
      expiresAt: 2_000_000, code: "protected-invite", joinStarted: true, joinAdmitted: false, uacEntered: true };
    const resumed = advanceJournal(pending, pending.release, pending.team, 1_000_000);
    expect(() => assertExistingUbuntuTeam(resumed, null)).not.toThrow();
    expect(() => assertExistingUbuntuTeam(resumed, resumed.team)).not.toThrow();
    expect(() => assertExistingUbuntuTeam(resumed, "ffffffffffffffff")).toThrow();
    expect(resumed).toEqual({ ...pending, phase: "installing", attempts: 2 });
    const admitted = admitJoin(resumed, resumed.team);
    expect(admitted).toEqual({ ...resumed, code: null, joinAdmitted: true });
    expect(() => assertExistingUbuntuTeam(admitted, admitted.team)).not.toThrow();
    expect(() => assertExistingUbuntuTeam({ ...resumed, joinStarted: false }, null)).toThrow();
    expect(() => assertExistingUbuntuTeam({ ...resumed, code: null }, null)).toThrow();
    expect(() => assertExistingUbuntuTeam(admitted, null)).toThrow();

    const bootstrap = readFileSync(join(windows, "bootstrap.ps1"), "utf8");
    const guard = /function Assert-ExistingUbuntuTeam\(\$journal\) \{([\s\S]*?)\n\}/.exec(bootstrap)?.[1] ?? "";
    expect(guard).toMatch(/if \(-not \$observed\.me\.team\) \{[\s\S]*?\$journal\.joinAdmitted -eq \$true[\s\S]*?-not \$journal\.code[\s\S]*?return[\s\S]*?\}/);
    expect(guard).toContain("$observed.me.team.id -cne $journal.team");
  });

  test("existing Ubuntu and Walkie state are refused before host mutations", () => {
    const bootstrap = readFileSync(join(windows, "bootstrap.ps1"), "utf8");
    const preflight = bootstrap.indexOf("Assert-ExistingUbuntuTeam $journal");
    expect(preflight).toBeGreaterThan(-1);
    for (const mutation of ["Register-Resume }", "Enable-WindowsOptionalFeature -Online", "install -y -qq curl openssl ca-certificates python3", "& $wsl --shutdown", "Register-KeepAlive $user", "powercfg /change"]) {
      expect(preflight).toBeLessThan(bootstrap.lastIndexOf(mutation));
    }
    const guard = /function Assert-ExistingUbuntuTeam\(\$journal\) \{([\s\S]*?)\n\}/.exec(bootstrap)?.[1] ?? "";
    expect(guard).toContain("walkie.db");
    expect(guard).toContain("$observed.me.team.id -cne $journal.team");
    expect(guard).toContain("already contains Walkie state");
  });

  test("standard Windows accounts stop before consent and journal creation", () => {
    const bootstrap = readFileSync(join(windows, "bootstrap.ps1"), "utf8");
    const guard = /function Assert-CanSelfElevate \{([\s\S]*?)\n\}/.exec(bootstrap)?.[1] ?? "";
    expect(guard).toContain("BuiltinAdministratorsSid");
    expect(guard).toContain("Sign in to a Windows administrator account");
    const call = bootstrap.indexOf("Assert-CanSelfElevate");
    const consent = bootstrap.indexOf("Read-Host 'Type ALLOW to consent'");
    const journal = bootstrap.indexOf("Save-Journal $journal", consent);
    expect(bootstrap.lastIndexOf("Assert-CanSelfElevate", consent)).toBeGreaterThan(call);
    expect(bootstrap.lastIndexOf("Assert-CanSelfElevate", consent)).toBeLessThan(consent);
    expect(consent).toBeLessThan(journal);
  });

  test("Ubuntu packages are fixed by signed bootstrap and versioned in journal and receipt", () => {
    const output = "apt output\nWALKIE_PACKAGES_BEGIN\ncurl\t8.5.0-2ubuntu10\nopenssl\t3.0.13-0ubuntu3\nca-certificates\t20240203\npython3\t3.12.3-0ubuntu1\nWALKIE_PACKAGES_END\n";
    expect(parsePackageVersions(output)).toEqual({ curl: "8.5.0-2ubuntu10", openssl: "3.0.13-0ubuntu3", "ca-certificates": "20240203", python3: "3.12.3-0ubuntu1" });
    expect(() => parsePackageVersions(output.replace("python3\t3.12.3-0ubuntu1\n", ""))).toThrow();
    expect(() => parsePackageVersions(output.replace("python3\t3.12.3-0ubuntu1", "evil\t1"))).toThrow();
    const bootstrap = readFileSync(join(windows, "bootstrap.ps1"), "utf8");
    expect(bootstrap).toMatch(/apt-get .* install -y -qq curl openssl ca-certificates python3/);
    expect(bootstrap).toContain("$journal.packageVersions = $packageVersions; Save-Journal $journal");
    expect(bootstrap).toContain("Write-PackageReceipt $journal");
    expect(bootstrap).toContain("WalkieEnroll\\receipts");
    expect(bootstrap).toContain("'packages.json'");
    expect(bootstrap).not.toContain("$handoff.packages");
  });

  test("APT source guard accepts official candidates and rejects third-party package sources", () => {
    const bootstrap = readFileSync(join(windows, "bootstrap.ps1"), "utf8");
    const guard = /# WALKIE_APT_SOURCE_GUARD_BEGIN\n([\s\S]*?)# WALKIE_APT_SOURCE_GUARD_END/.exec(bootstrap)?.[1];
    expect(guard).toBeTruthy();
    const policy = (sources: string, candidate = "8.5.0-2ubuntu10.6") => `curl:\n  Installed: (none)\n  Candidate: ${candidate}\n  Version table:\n     8.5.0-2ubuntu10.6 500\n${sources}`;
    const official = "        500 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages\n        500 http://security.ubuntu.com/ubuntu noble-security/main amd64 Packages\n";
    const run = (fixture: string) => spawnSync("/bin/sh", ["-c", `${guard}\nubuntu_codename=noble\napt_cache_policy() { cat; }\nassert_package_sources curl`], { input: fixture, encoding: "utf8" });
    expect(run(policy(official)).status).toBe(0);
    expect(run(policy(`${official}        500 https://packages.example.test/ubuntu noble/main amd64 Packages\n`)).status).not.toBe(0);
    expect(run(policy(`${official}         -1 https://packages.example.test/ubuntu noble/main amd64 Packages\n`)).status).not.toBe(0);
    expect(run(policy(`${official}        500 file:/var/local/apt noble/main amd64 Packages\n`)).status).not.toBe(0);
    expect(run(policy("        500 https://packages.example.test/ubuntu noble/main amd64 Packages\n")).status).not.toBe(0);
    expect(run(policy(official, "9.0-from-other-repo")).status).not.toBe(0);
    expect(run(policy("        500 http://archive.ubuntu.com/ubuntu other-updates/main amd64 Packages\n")).status).not.toBe(0);
    expect(bootstrap.indexOf("assert_package_sources \"$package\"")).toBeLessThan(bootstrap.indexOf("ubuntu_apt -o APT::Get::AllowUnauthenticated=false install"));
    expect(bootstrap).toContain("install --reinstall -y -qq curl openssl ca-certificates python3");
    expect(bootstrap).toContain("[signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg]");
    expect(bootstrap).toContain("Dir::Etc::sourceparts=-");
    expect(bootstrap).toContain("Dir::State::lists=\"$apt_dir/lists\"");
    expect(bootstrap).toContain("Read-Host 'To use the configured APT sources and keys anyway, type ALLOW-EXTRA-APT-SOURCES'");
    const rootScript = /\$rootScript = @'\n([\s\S]*?)\n'@/.exec(bootstrap)?.[1];
    expect(rootScript).toBeTruthy();
    expect(spawnSync("/bin/sh", ["-n"], { input: rootScript, encoding: "utf8" }).status).toBe(0);
  });

  test("Ubuntu APT update and install ignore an expired configured third-party source", () => {
    const bootstrap = readFileSync(join(windows, "bootstrap.ps1"), "utf8");
    const rootScript = /\$rootScript = @'\n([\s\S]*?)\n'@/.exec(bootstrap)?.[1] ?? "";
    const aptBlock = rootScript.slice(rootScript.indexOf('if [ "${2:-}" = allow-extra ]; then'), rootScript.indexOf('\nid -u "$u"'));
    const fixture = mkdtempSync(join(tmpdir(), "walkie-apt-fixture-"));
    try {
      const keyring = join(fixture, "ubuntu-keyring.gpg");
      const calls = join(fixture, "apt-calls");
      writeFileSync(keyring, "fixture");
      const mock = (name: string, body: string) => {
        const path = join(fixture, name);
        writeFileSync(path, `#!/bin/sh\n${body}\n`);
        chmodSync(path, 0o755);
      };
      mock("dpkg", "printf 'amd64\\n'");
      mock("chown", ":");
      mock("apt-cache", `
  case " $* " in
    *" Dir::State::lists="*) printf '%s\\n' "$MOCK_POLICY" ;;
    *) printf '%s\\n' "$MOCK_CONFIGURED_POLICY" ;;
  esac
`);
      mock("apt-get", `
  printf '%s\\n' "$*" >> "$MOCK_APT_CALLS"
  list=
  for arg do
    case "$arg" in Dir::Etc::sourcelist=*) list=\${arg#Dir::Etc::sourcelist=} ;; esac
  done
  if [ -z "$list" ]; then
    printf '%s' "$MOCK_CONFIGURED_SOURCES" | grep -q 'packages.example.test' && exit 100
    exit 0
  fi
  [ -n "$list" ] && [ -f "$list" ] || exit 100
  if grep -q 'packages.example.test' "$list"; then exit 100; fi
`);
      const script = `set -eu
ubuntu_codename=noble
${aptBlock.replaceAll("/usr/share/keyrings/ubuntu-archive-keyring.gpg", keyring)}
`;
      const sources = "deb http://archive.ubuntu.com/ubuntu noble main\ndeb https://packages.example.test/expired noble main\n";
      const policy = "curl:\n  Installed: (none)\n  Candidate: 8.5.0-2ubuntu10.6\n  Version table:\n     8.5.0-2ubuntu10.6 500\n        500 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages\n";
      const env = { ...process.env, PATH: `${fixture}:${process.env.PATH}`, MOCK_CONFIGURED_SOURCES: sources, MOCK_CONFIGURED_POLICY: "curl:\n  Installed: (none)\n  Candidate: (none)\n  Version table:\n", MOCK_POLICY: policy, MOCK_APT_CALLS: calls };
      const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env });
      expect(result.status, result.stderr).toBe(0);
      const aptCalls = readFileSync(calls, "utf8").trim().split("\n");
      expect(aptCalls).toHaveLength(2);
      expect(aptCalls[0]).toContain("update -qq");
      expect(aptCalls[1]).toContain("install --reinstall");
      expect(aptCalls.every((call) => call.includes("Dir::Etc::sourceparts=-"))).toBe(true);
      const extra = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { ...env, MOCK_CONFIGURED_POLICY: `${env.MOCK_CONFIGURED_POLICY}     8.5.0-2ubuntu10.6 -1\n        -1 https://packages.example.test/ubuntu noble/main amd64 Packages\n` } });
      expect(extra.status).not.toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);

  test("invite preflight extracts fixed team and expiry without claiming admission", () => {
    const bytes = Buffer.alloc(76 + 64);
    bytes[0] = 1;
    Buffer.from("0123456789abcdef", "hex").copy(bytes, 1);
    bytes.writeUInt32BE(1_800_000_000, 65);
    bytes[74] = 0;
    const code = `wk1${bytes.toString("base64url")}`;
    expect(inviteMetadata(code)).toEqual({ team: "0123456789abcdef", expiresAt: 1_800_000_000_000 });
    expect(() => inviteMetadata("wk1bad")).toThrow();
  });

  test("private CLI handoff accepts one bounded code via stdin", async () => {
    expect(parseArgs(["--invite-stdin"], CLI_BOOLEANS).flags.get("invite-stdin")).toBe(true);
    const code = `wk1${"a".repeat(70)}`;
    const stream = (text: string) => new Response(text).body as ReadableStream<Uint8Array>;
    expect(await inviteFromStdin(stream(`${code}\n`))).toBe(code);
    expect(inviteFromStdin(stream("bad\n"))).rejects.toThrow();
    expect(inviteFromStdin(stream(`wk1${"a".repeat(400)}`))).rejects.toThrow();
  });

  test("doctor reports each WSL persistence boundary and fails closed without interop", async () => {
    const base = { wsl: async () => true, conf: async () => "[boot]\nsystemd=true\n[user]\ndefault=alex\n", loginctl: async () => "yes\n" };
    const packages = { curl: "8.5.0-2ubuntu10", openssl: "3.0.13-0ubuntu3", "ca-certificates": "20240203", python3: "3.12.3-0ubuntu1" };
    const ready = await wslKeepaliveChecks({ ...base, windows: async () => JSON.stringify({ idle: true, task: true, battery: true, restart: true, logon: true, repeat: true, packages }) });
    expect(ready).toHaveLength(5);
    expect(ready.every((check) => check.ok === true)).toBe(true);
    const missing = await wslKeepaliveChecks({ ...base, windows: async () => null });
    expect(missing.map((check) => check.ok)).toEqual([true, true, false, false, false]);
    expect(await wslKeepaliveChecks({ wsl: async () => false })).toEqual([]);
    const withReceipt = await wslKeepaliveChecks({ ...base, windows: async () => JSON.stringify({ idle: true, task: true, battery: true, restart: true, logon: true, repeat: true, packages }) });
    expect(withReceipt.at(-1)).toEqual({ ok: true, what: expect.stringContaining("curl=8.5.0-2ubuntu10") });
  });

  test("script has strict handling and no unverified download execution", () => {
    const stage = readFileSync(join(windows, "stage0.ps1"), "utf8");
    const bootstrap = readFileSync(join(windows, "bootstrap.ps1"), "utf8");
    expect(stage).toContain("Set-StrictMode -Version Latest");
    expect(stage).toContain("Verify-ReleaseSignature");
    expect(stage.indexOf("  Verify-ReleaseSignature $manifestBytes")).toBeLessThan(stage.indexOf("& $bootstrapPath"));
    expect(stage).toContain("'walkie-windows-stage0.ps1'");
    expect(bootstrap).toContain('"-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"');
    expect(bootstrap).not.toContain("-File \"' + (Join-Path $stateDir 'bootstrap.ps1')");
    expect(stage).not.toMatch(/Invoke-Expression|\biex\b/i);
    expect(bootstrap).toContain("Set-StrictMode -Version Latest");
    expect(bootstrap).not.toMatch(/Invoke-Expression|\biex\b/i);
    expect(bootstrap).toContain("Protect-Data");
    expect(bootstrap).toContain("Unprotect-Data");
    const command = windowsCommand(stage);
    expect(command).toStartWith("powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ");
    expect(Buffer.from(command.split(" ").at(-1) as string, "base64").toString("utf16le")).toBe(stage);
    expect(command).not.toContain("wk1");
    expect(command.length).toBeLessThan(32767);
    const release = readFileSync(join(windows, "../release.sh"), "utf8");
    expect(release).toContain("cp scripts/windows/bootstrap.ps1 dist/walkie-windows-bootstrap.ps1");
    expect(release).toContain("cp scripts/windows/stage0.ps1 dist/walkie-windows-stage0.ps1");
    expect(release).toContain("cp scripts/install.sh dist/install.sh");
  });

  test("stage zero terminal exits clean journal and task for every pre-bootstrap failure", () => {
    const stage = readFileSync(join(windows, "stage0.ps1"), "utf8");
    const cleanup = /function Invoke-TerminalCleanup \{([\s\S]*?)\n\}/.exec(stage)?.[1] ?? "";
    expect(cleanup).toContain("WalkieEnroll\\active");
    expect(cleanup).toContain("Remove-Item -LiteralPath $stateDir -Recurse");
    expect(cleanup).toContain("Unregister-ScheduledTask -TaskName 'WalkieEnrollResume'");
    expect(cleanup).toContain("Remove-Item -LiteralPath $handoff -Force");
    const start = stage.indexOf("try {\n$journalPath");
    const end = stage.lastIndexOf("} catch {\n  [Console]::Error.WriteLine");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const protectedBody = stage.slice(start, end);
    const exits = [
      ["missing/corrupt journal", "Get-Content -LiteralPath $journalPath"],
      ["missing/corrupt handoff", "Get-Content -LiteralPath $handoffPath"],
      ["invalid phase", "Unexpected enrollment journal phase"],
      ["invalid release", "Invalid release in private handoff"],
      ["working directory", "New-Item -ItemType Directory -Path $work"],
      ["download", "Invoke-WebRequest"],
      ["signature", "Verify-ReleaseSignature"],
      ["signed manifest", "Get-SignedHash"],
      ["asset hash", "Get-FileHash"],
      ["bootstrap error", "& $bootstrapPath"],
    ] as const;
    for (const [failure, boundary] of exits) expect(protectedBody.includes(boundary)).toBe(true);
    expect(stage.slice(end)).toMatch(/Invoke-TerminalCleanup\n  throw\n\} finally \{/);
  });
});
