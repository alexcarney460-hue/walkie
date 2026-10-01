import { createGrant, readGrant, revokeGrant, setGrantSshState, suspendGrant, type Grant } from "../provision/grant.ts";
import { authorizeOwnerKey, hasOwnerKey, restoreOwnerKeys, snapshotOwnerKeys } from "./authorized-keys.ts";
import { clearSshGate, setSshGate } from "./state.ts";

export type InstallStep = "gate_pending" | "grant_pending" | "record_prepared" | "before_rename" | "key_written" |
  "record_finalized" | "gate_open" | "before_grant_active";

/** A failed install whose rollback did not finish (a key, the gate or the grant may still be in place). */
export class SshInstallRollbackError extends Error {}

/** All steps are synchronous: no request can observe an open gate during installation. */
export function installSshGrant(home: string, sshHome: string, input: Grant,
  afterWrite?: (step: InstallStep) => void, revoke: typeof revokeGrant = revokeGrant,
  suspend: typeof suspendGrant = suspendGrant, activate: typeof setGrantSshState = setGrantSshState): Grant {
  if (!input.owner_ssh) throw new Error("owner SSH grant required");
  const snapshot = snapshotOwnerKeys(sshHome);
  setSshGate(home, "pending");
  let created = false;
  try {
    afterWrite?.("gate_pending");
    createGrant(home, { ...input, ssh_state: "pending" });
    created = true;
    afterWrite?.("grant_pending");
    authorizeOwnerKey(sshHome, input.team_id, input.owner_ssh.owner_handle,
      input.owner_ssh.public_key, afterWrite);
    if (!hasOwnerKey(sshHome, input.team_id, input.owner_ssh.owner_handle, input.owner_ssh.public_key)) {
      throw new Error("owner SSH key did not verify after installation");
    }
    clearSshGate(home);
    afterWrite?.("gate_open");
    afterWrite?.("before_grant_active");
    // A directory fsync can report failure after the rename has committed the active grant.
    try { return activate(home, "active"); }
    catch (err) {
      let committed: Grant | null = null;
      try { committed = readGrant(home); } catch { /* Continue with fail-closed cleanup. */ }
      if (committed?.ssh_state === "active" && committed.created_at === input.created_at &&
          hasOwnerKey(sshHome, input.team_id, input.owner_ssh.owner_handle, input.owner_ssh.public_key)) {
        console.warn(`SSH grant activation committed; durability warning: ${(err as Error).message}`);
        return committed;
      }
      throw err;
    }
  } catch (err) {
    const failures: string[] = [];
    try { setSshGate(home, "denied"); } catch (e) { failures.push(`deny persistence: ${(e as Error).message}`); }
    try { restoreOwnerKeys(sshHome, snapshot); } catch (e) { failures.push(`key rollback: ${(e as Error).message}`); }
    if (created) {
      try { revoke(home); }
      catch (e) {
        failures.push(`grant revocation: ${(e as Error).message}`);
        try { suspend(home, input.created_at); }
        catch (suspendError) { failures.push(`grant suspension: ${(suspendError as Error).message}`); }
      }
    }
    if (failures.length) throw new SshInstallRollbackError(`SSH install failed: ${(err as Error).message}; ${failures.join("; ")}`);
    throw err;
  }
}
