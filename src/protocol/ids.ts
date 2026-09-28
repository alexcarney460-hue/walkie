// Deterministic identifiers derived from key material (PROTOCOL §1).
import { createHash } from "node:crypto";

/** node_id = hex(sha256(raw 32-byte ed25519 public key))[0:16]. */
export function nodeIdFromPubkey(pubkeyB64: string): string {
  const raw = Buffer.from(pubkeyB64, "base64");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * team id = hex(sha256("walkie-team-v1\n" + founder_pubkey_b64 + "\n" + name + "\n" + ts))[0:16].
 * Binding the id to the founding key stops anyone from minting a competing
 * team.create for an existing team id (second preimage on 64 bits).
 */
export function deriveTeamId(founderPubkeyB64: string, name: string, ts: number): string {
  return createHash("sha256")
    .update(`walkie-team-v1\n${founderPubkeyB64}\n${name}\n${ts}`)
    .digest("hex")
    .slice(0, 16);
}

export function eventId(origin: string, seq: number): string {
  return `${origin}:${seq}`;
}
