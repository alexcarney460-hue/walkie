import type { Core } from "../core.ts";
import { HttpError } from "../http.ts";
import { readGrant, setGrantSshState, type Grant } from "../provision/grant.ts";
import { appendAuditStrict } from "../admin/audit.ts";
import { revokeOwnerKeys } from "./authorized-keys.ts";
import { appendSshRevocationAudit, clearSshRevocationUnsaved, denySshInMemory, markSshRevocationUnsaved, recordSshRevocation, REVOCATION_UNSAVED_MESSAGE, setSshGate } from "./state.ts";
import { closeSshTunnels } from "./tunnel.ts";

interface RevocationWrites {
  record: typeof recordSshRevocation;
  audit: typeof appendSshRevocationAudit;
  adminAudit: typeof appendAuditStrict;
  grantState: typeof setGrantSshState;
}
const defaultWrites: RevocationWrites = {
  record: recordSshRevocation, audit: appendSshRevocationAudit,
  adminAudit: appendAuditStrict, grantState: setGrantSshState,
};

/** Nothing durable was written: the revocation lives only in this process's memory. */
export class SshRevocationUnsaved extends Error {}

/**
 * Records what a finished revocation attempt left behind, for doctor until the next attempt or a restart.
 * Returns the plain refusal for a person when it left nothing anywhere: not on this disk (`failure` is the attempt's
 * error, if any) and not as a receipt held by the team. Otherwise the warning is cleared and null returned.
 */
export function noteRevocationOutcome(home: string, failure: unknown, teamHoldsReceipt: boolean): HttpError | null {
  if (failure instanceof SshRevocationUnsaved && !teamHoldsReceipt) {
    markSshRevocationUnsaved(home);
    return new HttpError(503, "ssh_revocation_unsaved", REVOCATION_UNSAVED_MESSAGE);
  }
  clearSshRevocationUnsaved(home);
  return null;
}

/** The grant as it is on disk now: the caller's copy may predate a revocation that finished while it waited. */
function grantOnDisk(home: string, copy: Grant): Grant {
  try { return readGrant(home) ?? copy; } catch { return copy; }
}

/** Close live streams before disk work; a failed write still denies this process. */
export function denyAndCloseSsh(core: Core, writeGate: typeof setSshGate = setSshGate): void {
  denySshInMemory(core.paths.home);
  let closeFailure: unknown;
  try { closeSshTunnels(core); } catch (err) { closeFailure = err; }
  let failure: unknown;
  let persisted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeGate(core.paths.home, "denied"); persisted = true; break; }
    catch (err) { failure = err; }
  }
  if (!persisted) throw new Error(`SSH denial persistence failed: ${(failure as Error).message}`);
  if (closeFailure) throw closeFailure;
}

export function revokeSshAccess(core: Core, grant: Grant,
  removeKeys: typeof revokeOwnerKeys = revokeOwnerKeys,
  writeGate: typeof setSshGate = setSshGate,
  writes: RevocationWrites = defaultWrites): number {
  if (!grant.owner_ssh) throw new Error("owner SSH grant absent");
  denySshInMemory(core.paths.home);
  const failures: string[] = [];
  let intentRecorded = false;
  try { writes.record(core.paths.home, grant.created_at, ["operation interrupted"]); intentRecorded = true; }
  catch { failures.push("revocation record write"); }
  try { writes.audit(core.paths.home, grant.created_at); intentRecorded = true; }
  catch { failures.push("revocation audit write"); }
  try {
    writes.adminAudit(core, { actor: `@${grant.recipient}`, action: `SSH revocation requested grant_created_at=${grant.created_at}`,
      machine: core.hostname, via: "local" });
    intentRecorded = true;
  } catch { failures.push("audit write"); }
  try { closeSshTunnels(core); } catch { failures.push("tunnel close"); }
  let gateWritten = false;
  let gateError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeGate(core.paths.home, "denied"); gateWritten = true; break; } catch (err) { gateError = err; }
  }
  if (!gateWritten) failures.push(`gate write: ${(gateError as Error).message}`);
  let removed = 0;
  let keysRemoved = false;
  try { removed = removeKeys(core.sshUserHome, grant.team_id, grant.owner_ssh.owner_handle); keysRemoved = true; }
  catch (err) { failures.push(`key removal: ${(err as Error).message}`); }
  // Judge by the disk, not the caller's copy: a grant a concurrent revoke already denied or revoked needs no write
  // (and a write would fail, though the state is what this revocation wants).
  const onDisk = grantOnDisk(core.paths.home, grant);
  let grantDenied = !!(grant.revoked_at ?? onDisk.revoked_at) || onDisk.ssh_state === "denied";
  if (!grantDenied) {
    try { writes.grantState(core.paths.home, "denied"); grantDenied = true; } catch { failures.push("grant state write"); }
  }
  if (intentRecorded) {
    try { writes.record(core.paths.home, grant.created_at, failures); }
    catch { failures.push("revocation outcome write"); }
  }
  if (failures.length) {
    const incomplete = `SSH revocation incomplete: ${failures.join(", ")}`;
    // Any one of these is found again after a restart; with none of them only this process's memory refuses.
    throw intentRecorded || gateWritten || keysRemoved || grantDenied ? new Error(incomplete) : new SshRevocationUnsaved(incomplete);
  }
  return removed;
}
