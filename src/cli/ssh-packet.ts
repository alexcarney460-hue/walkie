// The owner SSH packet an add-machine link carries (`--owner-ssh <packet>` in the command, `&ssh=` in the link).
// The installer reads it BEFORE the person's one consent is shown: a packet that is damaged, expired or not for this
// invite and machine is dropped, so the consent never promises SSH the daemon would refuse, and SSH is never reported
// ready for a packet that was not carried. The signature is the daemon's to check (it holds the owner's roster key);
// everything here is what the invite the person holds can already prove. The packet is never printed or logged.
import { WalkieError, type WalkieClient } from "../client/index.ts";
import { decodeOwnerSshGrant, type OwnerSshGrant } from "../daemon/ssh/grant.ts";

export type OwnerSsh =
  | { state: "absent" }
  | { state: "carried"; packet: OwnerSshGrant }
  | { state: "damaged" };

/** Said plainly, before the consent, when a link's SSH authorization can't be used. */
export const OWNER_SSH_DAMAGED = "This link can't turn on owner SSH: its SSH authorization is damaged, expired or not for this machine. "
  + "Ask the owner for a new add-machine link. The consent below leaves SSH out.";

/** What the invite and the roster say about this enrollment. `inviteId` is null when the invite could not be decoded. */
export interface OwnerSshExpectation {
  teamId: string;
  /** The machine person's own handle. */
  handle: string;
  /** The invite's issuer node: the owner machine that signed both the invite and the packet. */
  ownerNode: string;
  ownerHandle: string;
  inviteId: string | null;
  now: number;
}

export function readOwnerSsh(encoded: string | undefined, want: OwnerSshExpectation): OwnerSsh {
  if (encoded === undefined) return { state: "absent" };
  let packet: OwnerSshGrant;
  try { packet = decodeOwnerSshGrant(encoded); } catch { return { state: "damaged" }; }
  const forThisEnrollment = packet.team_id === want.teamId && packet.owner_node === want.ownerNode
    && packet.owner_handle === want.ownerHandle && packet.recipient === want.handle
    && (want.inviteId === null || packet.invite_id === want.inviteId) && packet.expires_at > want.now;
  return forThisEnrollment ? { state: "carried", packet } : { state: "damaged" };
}

/** What a refused grant says about the SSH part, in words a person can act on. Null: not an SSH refusal. */
export function ownerSshRefusal(code: string): string | null {
  switch (code) {
    case "owner_ssh_invalid": return "its signature or expiry did not verify";
    case "owner_ssh_mismatch": return "it is for another enrollment";
    case "owner_ssh_invite": return "it was not issued for the invite that admitted this machine";
    case "owner_ssh_spent": return "it was already used";
    case "owner_required": return "the owner who made it is no longer an owner of the team";
    case "owner_ssh_record": return "its use could not be recorded on this machine";
    case "owner_key_install_failed": return "the owner's key could not be installed";
    default: return null;
  }
}

/** The refusals that are THIS machine's to fix: nothing was spent, so after the fix the very same link works. */
const FIX_AND_RETRY = new Set(["owner_ssh_record", "owner_key_install_failed"]);
/** The root marker's two problems. The daemon's own message already says what to do, so it is shown as it is. */
const MARKER = new Set(["root_marker_required", "root_marker_invalid"]);

/** Whether a refusal is a problem on THIS machine (fix it and run the same command again) rather than one with the link. */
export function isLocalRefusal(code: string): boolean {
  return FIX_AND_RETRY.has(code) || MARKER.has(code);
}

/**
 * A refusal (of the grant, or of the check before it) as a whole sentence that is true. A link the owner must replace says
 * so; a machine that already joined with another link is told the owner must remove it and add it again (a new link can
 * never work there); a failure on this machine names the problem and says to fix it and repeat (`again` names what is
 * repeated). Null when the code is not about the owner's SSH authorization at all.
 */
export function ownerSshRefusalLine(code: string, daemonMessage: string, again = "run the same command again"): string | null {
  if (code === "owner_ssh_invite") return "this machine already joined with another link; the owner must remove it from the team and add it again.";
  if (FIX_AND_RETRY.has(code)) return `${daemonMessage.replace(/[.\s]+$/, "")}. Fix that, then ${again}: the same link still works.`;
  const why = ownerSshRefusal(code);
  return why ? `the daemon refused the owner's SSH authorization in this link (${why}). Ask the owner for a new add-machine link.` : null;
}

/** Any refusal of the grant a person can act on: the owner SSH ones above, and the root marker's own two. Null for everything else. */
export function grantRefusalLine(code: string, daemonMessage: string, again?: string): string | null {
  return MARKER.has(code) ? daemonMessage : ownerSshRefusalLine(code, daemonMessage, again);
}

/**
 * Asks this machine's daemon whether it would accept the packet, WITHOUT spending it: signature, team, owner, person,
 * expiry, the invite that admitted this machine, and not already used. Null: it would. Otherwise the sentence to show, and
 * the caller stops: no question, no administrator step, nothing recorded. An unanswerable check is a refusal too, because
 * nothing should run for a packet nobody vetted. The packet is never put in the sentence.
 */
export async function checkOwnerSsh(client: Pick<WalkieClient, "provisionCheck">, packet: OwnerSshGrant): Promise<string | null> {
  try {
    await client.provisionCheck({ owner_ssh: packet });
    return null;
  } catch (error) {
    if (error instanceof WalkieError) {
      const line = ownerSshRefusalLine(error.code, error.message);
      if (line) return line;
    }
    return `this machine's Walkie could not check the owner's SSH authorization (${error instanceof Error ? error.message : String(error)}). Run walkie doctor, then run the same command again.`;
  }
}
