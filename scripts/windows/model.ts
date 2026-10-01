import { createHash } from "node:crypto";

/** Pure enrollment policy mirrored by bootstrap.ps1; no Windows host access here. */
/** DER ECDSA/P-256 signature to the 64-byte CNG r||s form used by PowerShell. */
export function p256DerToP1363(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error("invalid DER sequence");
  let offset = 2;
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[offset] !== 2) throw new Error("invalid DER integer");
    const length = der[offset + 1] as number;
    offset += 2;
    if (length < 1 || length > 33 || offset + length > der.length) throw new Error("invalid DER length");
    let value = der.subarray(offset, offset + length);
    if (length === 33) {
      if (value[0] !== 0) throw new Error("invalid DER padding");
      value = value.subarray(1);
    }
    out.set(value, part * 32 + 32 - value.length);
    offset += length;
  }
  if (offset !== der.length) throw new Error("trailing DER bytes");
  return out;
}

export function manifestHash(sums: string, release: string, asset: string): string {
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]{1,40})?$/.test(release)) throw new Error("invalid release");
  if (!/^[A-Za-z0-9._-]+$/.test(asset)) throw new Error("invalid asset");
  const versions = sums.split(/\r?\n/).filter((line) => line.startsWith("version "));
  if (versions.length !== 1 || versions[0] !== `version ${release}`) throw new Error("unexpected signed release");
  const rows = sums.split(/\r?\n/).filter((line) => line.endsWith(`  ${asset}`));
  if (rows.length !== 1) throw new Error("asset is absent or duplicated");
  const match = /^([a-fA-F0-9]{64})  [A-Za-z0-9._-]+$/.exec(rows[0] as string);
  if (!match) throw new Error("invalid asset hash");
  return (match[1] as string).toLowerCase();
}

export function mergeIni(input: string, section: string, key: string, value: string): string {
  if (![section, key].every((part) => /^[A-Za-z][A-Za-z0-9]*$/.test(part)) || /[\r\n]/.test(value)) throw new Error("invalid INI field");
  const eol = input.includes("\r\n") ? "\r\n" : "\n";
  const lines = input ? input.split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  let start = lines.findIndex((line) => line.trim().toLowerCase() === `[${section.toLowerCase()}]`);
  if (start < 0) { lines.push(`[${section}]`, `${key}=${value}`); return `${lines.join(eol)}${eol}`; }
  let end = lines.findIndex((line, i) => i > start && /^\s*\[.*\]\s*$/.test(line));
  if (end < 0) end = lines.length;
  const matches: number[] = [];
  for (let i = start + 1; i < end; i++) {
    if (new RegExp(`^\\s*${key}\\s*=`, "i").test(lines[i] as string)) matches.push(i);
  }
  for (const i of matches.slice(1).reverse()) lines.splice(i, 1);
  if (matches.length) lines[matches[0] as number] = `${key}=${value}`;
  else lines.splice(start + 1, 0, `${key}=${value}`);
  return `${lines.join(eol)}${eol}`;
}

export function taskXml(distro: string, user: string, sid = "S-1-5-21-1"): string {
  if (![distro, user].every((part) => /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(part)) || !/^S-1-(?:\d+-)+\d+$/.test(sid)) throw new Error("invalid WSL task identity");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>C:\\Windows\\System32\\wsl.exe</Command><Arguments>-d ${distro} -u ${user} -- sleep infinity</Arguments></Exec></Actions>
</Task>`;
}

export interface Journal {
  phase: "await-reboot" | "installing" | "complete";
  attempts: number;
  release: string;
  team: string;
  expiresAt: number;
  uacEntered?: boolean;
  code?: string | null;
  joinStarted?: boolean;
  joinAdmitted?: boolean;
}

export function advanceJournal(j: Journal, release: string, team: string, now: number): Journal {
  if (j.release !== release || j.team !== team || (!j.joinAdmitted && now >= j.expiresAt)) throw new Error("enrollment identity changed or invite expired");
  if (j.joinAdmitted && (!j.joinStarted || j.code !== null)) throw new Error("admitted journal retains invite");
  if (!(j.phase === "await-reboot" || (j.phase === "installing" && j.uacEntered)) || j.attempts >= 3) throw new Error("resume not permitted");
  return { ...j, phase: "installing", attempts: j.attempts + 1 };
}

export function assertExistingUbuntuTeam(j: Journal, observedTeam: string | null): void {
  if (!j.joinStarted) throw new Error("Ubuntu already contains Walkie state");
  if (observedTeam === null) {
    if (j.joinAdmitted || typeof j.code !== "string" || !j.code) throw new Error("join admission is unconfirmed and invite is missing");
    return;
  }
  if (observedTeam !== j.team) throw new Error("Ubuntu is joined to another team");
}

export function admitJoin(j: Journal, observedTeam: string): Journal {
  if (!j.joinStarted || observedTeam !== j.team) throw new Error("joined team differs from enrollment");
  return { ...j, code: null, joinAdmitted: true };
}

export const WINDOWS_PACKAGES = ["curl", "openssl", "ca-certificates", "python3"] as const;

export function parsePackageVersions(output: string): Record<string, string> {
  const match = /(?:^|\n)WALKIE_PACKAGES_BEGIN\r?\n([\s\S]*?)\r?\nWALKIE_PACKAGES_END(?:\r?\n|$)/.exec(output);
  if (!match) throw new Error("package version receipt missing");
  const entries = (match[1] as string).split(/\r?\n/).map((line) => /^([a-z0-9-]+)\t([A-Za-z0-9.+:~_-]{1,100})$/.exec(line));
  if (entries.length !== WINDOWS_PACKAGES.length || entries.some((entry) => !entry)) throw new Error("invalid package version receipt");
  const versions = Object.fromEntries(entries.map((entry) => [entry?.[1], entry?.[2]]));
  if (WINDOWS_PACKAGES.some((name) => !versions[name]) || Object.keys(versions).length !== WINDOWS_PACKAGES.length) throw new Error("unexpected package version receipt");
  return versions as Record<string, string>;
}

/** Advisory preflight only. The roster authority must verify the invite signature and admit it. */
export function inviteMetadata(code: string): { team: string; expiresAt: number } {
  if (!/^wk1[A-Za-z0-9_-]{38,297}$/.test(code)) throw new Error("invalid invite shape");
  const bytes = Buffer.from(code.slice(3), "base64url");
  if (bytes.length < 140 || bytes[0] !== 1) throw new Error("invalid invite body");
  return { team: bytes.subarray(1, 9).toString("hex"), expiresAt: bytes.readUInt32BE(65) * 1000 };
}

/** The optional `ownerSsh` of the private handoff, as bootstrap.ps1 judges it before the consent: absent, a well-formed base64url packet of at most 1200 characters, or damaged (dropped, said plainly, never carried). */
export function ownerSshHandoff(value: unknown): { state: "absent" } | { state: "carried"; packet: string } | { state: "damaged" } {
  if (value === undefined || value === null || value === "") return { state: "absent" };
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,1200}$/.test(value) ? { state: "carried", packet: value } : { state: "damaged" };
}

/** What Get-InviteFacts reads besides the team: the issuing owner node (bytes 41..48) and the invite id, sha256 of the one-use secret (bytes 49..64), first 32 hex. */
export function inviteBinding(code: string): { issuer: string; inviteId: string } {
  inviteMetadata(code);
  const bytes = Buffer.from(code.slice(3), "base64url");
  return { issuer: bytes.subarray(41, 49).toString("hex"), inviteId: createHash("sha256").update(bytes.subarray(49, 65)).digest("hex").slice(0, 32) };
}
