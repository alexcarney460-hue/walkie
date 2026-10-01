import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Core } from "../core.ts";
import { readPrivate, writePrivate } from "../provision/files.ts";
import type { OwnerSshGrant } from "./grant.ts";

/** The private record of SSH authorizations this machine has spent (named in messages so a failure can be fixed). */
export const sshPacketRecordPath = (home: string): string => join(home, "owner-ssh-packets-used.json");
const usedPath = sshPacketRecordPath;

/** A spent invite in the roster is insufficient: it must be the admission of this exact node. */
export function admittedBySshInvite(core: Core, inviteId: string): boolean {
  return core.rosterEntries().some((event) => event.kind === "team.node" &&
    event.body.node_id === core.nodeId && event.body.invite === inviteId);
}

function usedFingerprints(home: string): Set<string> {
  const raw = readPrivate(usedPath(home));
  const parsed: unknown = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error("SSH packet consumption record is invalid");
  }
  return new Set<string>(parsed);
}

const fingerprintOf = (packet: OwnerSshGrant): string => createHash("sha256").update(packet.signature).digest("hex");

/** Whether this packet was already spent on this machine: read-only, for the check that runs before anything is spent. */
export function isSshPacketSpent(home: string, packet: OwnerSshGrant): boolean {
  return usedFingerprints(home).has(fingerprintOf(packet));
}

/**
 * Persist consumption before the owner key is written. A failure here burns no access. The grant route spends the packet
 * only after every check that can fail before the key is written has passed, and gives it back (releaseSshPacket) if an
 * install that never reached the key, or rolled back completely, still fails.
 */
export function consumeSshPacket(home: string, packet: OwnerSshGrant): boolean {
  const used = usedFingerprints(home);
  const fingerprint = fingerprintOf(packet);
  if (used.has(fingerprint)) return false;
  if (used.size >= 10_000) throw new Error("SSH packet consumption record is full");
  writePrivate(usedPath(home), [...used, fingerprint]);
  return true;
}

/**
 * Takes a packet back out of the consumption record: for an install that failed before any owner key was left in
 * authorized_keys, so the same link can be tried again. Returns whether it was recorded as spent.
 */
export function releaseSshPacket(home: string, packet: OwnerSshGrant): boolean {
  const used = usedFingerprints(home);
  if (!used.delete(fingerprintOf(packet))) return false;
  writePrivate(usedPath(home), [...used]);
  return true;
}
