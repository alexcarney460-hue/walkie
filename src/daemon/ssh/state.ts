import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { auditPath } from "../admin/audit.ts";
import { readPrivate, writePrivate } from "../provision/files.ts";
import { readGrant } from "../provision/grant.ts";

const gatePath = (home: string): string => join(home, "owner-ssh-gate.json");
const revocationPath = (home: string): string => join(home, "owner-ssh-revocation.json");
const revocationAuditPath = (home: string): string => join(home, "owner-ssh-revocations.jsonl");
export type SshGate = "pending" | "denied" | "open";
const denied = new Set<string>();
const unsaved = new Set<string>();
const auditRevocations = new Map<string, boolean>();

/** What a person is told when a revocation could be neither saved on this machine nor delivered to the team's authority. */
export const REVOCATION_UNSAVED_MESSAGE =
  "the revocation was not saved; SSH stays closed until restart; run it again once the disk is writable";

/** Memory only, by necessity: the disk that would hold this fact is the one that failed. A restart forgets it. */
export function markSshRevocationUnsaved(home: string): void { unsaved.add(home); }
export function clearSshRevocationUnsaved(home: string): void { unsaved.delete(home); }
export function sshRevocationUnsaved(home: string): boolean { return unsaved.has(home); }

/** Tests restart daemons in one Bun process; a real process restart has the same empty memory. */
export function beginSshDaemon(home: string): void {
  denied.delete(home);
  unsaved.delete(home);
  for (const key of auditRevocations.keys()) if (key.startsWith(`${home}:`)) auditRevocations.delete(key);
}

interface Revocation { grant_created_at: number; failures: string[] }

/** Append-only revocation evidence is separate from the rotating admin audit. */
export function appendSshRevocationAudit(home: string, grantCreatedAt: number): void {
  const path = revocationAuditPath(home);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("SSH revocation audit is not a file");
    fchmodSync(fd, 0o600);
    const line = Buffer.from(`${JSON.stringify({ grant_created_at: grantCreatedAt })}\n`);
    for (let at = 0; at < line.length;) {
      const written = writeSync(fd, line, at, line.length - at);
      if (written <= 0) throw new Error("SSH revocation audit write made no progress");
      at += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** A pinned intent prevents audit rotation from erasing an unfinished revocation. */
export function recordSshRevocation(home: string, grantCreatedAt: number, failures: string[],
  write: typeof writePrivate = writePrivate): void {
  const path = revocationPath(home);
  const record: Revocation = { grant_created_at: grantCreatedAt, failures };
  try { write(path, record); }
  catch (err) {
    let committed = false;
    try {
      const raw = readPrivate(path);
      committed = raw !== null && JSON.stringify(JSON.parse(raw)) === JSON.stringify(record);
    } catch { /* An unreadable record cannot establish a committed outcome. */ }
    if (!committed) throw err;
    console.warn(`SSH revocation record committed; durability warning: ${(err as Error).message}`);
  }
}

function auditRecordsRevocation(home: string, createdAt: number): boolean {
  const dedicated = readPrivate(revocationAuditPath(home));
  if (dedicated?.split("\n").some((line) => {
    try { return (JSON.parse(line) as { grant_created_at?: unknown }).grant_created_at === createdAt; }
    catch { return false; }
  })) return true;
  const expected = `SSH revocation requested grant_created_at=${createdAt}`;
  for (const path of [`${auditPath(home)}.1`, auditPath(home)]) {
    const raw = readPrivate(path);
    if (raw?.split("\n").some((line) => {
      try { return (JSON.parse(line) as { action?: unknown }).action === expected; }
      catch { return false; }
    })) return true;
  }
  return false;
}

export function sshRevocationProblem(home: string): string | null {
  const grant = readGrant(home);
  if (!grant?.owner_ssh) return null;
  const raw = readPrivate(revocationPath(home));
  if (raw !== null) {
    const value = JSON.parse(raw) as Revocation;
    if (!Number.isSafeInteger(value.grant_created_at) || !Array.isArray(value.failures) ||
      value.failures.some((item) => typeof item !== "string")) throw new Error("SSH revocation record invalid");
    if (value.grant_created_at === grant.created_at) return value.failures.length ? value.failures.join(", ") : "revoked";
  }
  const cacheKey = `${home}:${grant.created_at}`;
  let audited = auditRevocations.get(cacheKey);
  if (audited === undefined) {
    audited = auditRecordsRevocation(home, grant.created_at);
    auditRevocations.set(cacheKey, audited);
  }
  if (audited) return "revocation intent recorded in audit";
  return grant.revoked_at || grant.ssh_state === "denied" ? "revoked" : null;
}

/** Refuse immediately, including if subsequent disk writes fail. */
export function denySshInMemory(home: string): void {
  denied.add(home);
}

/** The armed bit is committed with the gate, so a fresh daemon can recover it. */
export function setSshGate(home: string, state: SshGate): void {
  writePrivate(gatePath(home), { state, armed: state === "open" });
}

export function sshGateProblem(home: string): string | null {
  if (denied.has(home)) return "ssh_denied";
  try {
    if (sshRevocationProblem(home)) return "ssh_denied";
    const raw = readPrivate(gatePath(home));
    if (raw === null) return "ssh_gate_invalid";
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && "state" in value) {
      if (value.state === "pending") return "ssh_pending";
      if (value.state === "denied") return "ssh_denied";
      if (value.state === "open") return "armed" in value && value.armed === true ? null : "ssh_gate_invalid";
    }
  } catch { /* An unreadable gate must refuse access. */ }
  return "ssh_gate_invalid";
}

export function clearSshGate(home: string): void {
  setSshGate(home, "open");
  denied.delete(home);
}
