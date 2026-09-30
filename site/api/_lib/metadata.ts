// What the site keeps in a Stripe subscription's metadata (Stripe is the only store; LICENSE-FIX-1):
//   walkie_code_revealed_at  unix ms when the welcome page showed the activation code (shown once)
//   walkie_code_reveal_nonce the reveal that won: written with revealed_at, read back before the code
//                            is shown, so of two racing reveals only the one whose write stuck answers
//   walkie_team              the team id the subscription is bound to (set at the first bind)
//   walkie_renew_hash        hex sha256 of the renewal token (the token itself is never stored)
// Keys from before LICENSE-FIX-1 (walkie_license, walkie_license_1, …: a whole license key split
// into 500-character values) are no longer written; the webhook clears them when it sees them.
// Stripe deletes a metadata key when it is set to "".
import { createHash, timingSafeEqual } from "node:crypto";

export const REVEALED_META = "walkie_code_revealed_at";
export const REVEAL_NONCE_META = "walkie_code_reveal_nonce";
/** Unix ms when a reveal COMPLETED (the code left the function). Set after the read-back (FINAL Fable 3). */
export const SHOWN_META = "walkie_code_shown_at";
export const TEAM_META = "walkie_team";
export const AUTHORITY_META = "walkie_authority";
export const AUTHORITY_DEPTH_META = 'walkie_authority_depth';
export const AUTHORITY_CHAIN_META = 'walkie_authority_chain';
export const AUTHORITY_PATH_META = 'walkie_authority_path_';
const AUTHORITY_PATH_CHUNKS = 17; // 100 SHA-256 digests plus separators fit in 6,800 chars.
export function authorityPathMetadata(chain: readonly string[]): Record<string, string> {
  const text = chain.join(',');
  if (text.length > AUTHORITY_PATH_CHUNKS * 400) throw new RangeError('authority_chain_metadata_limit');
  return Object.fromEntries(Array.from({ length: AUTHORITY_PATH_CHUNKS }, (_, i) =>
    [`${AUTHORITY_PATH_META}${i}`, text.slice(i * 400, (i + 1) * 400)]));
}
export function readAuthorityPath(meta: Readonly<Record<string, string>>): string[] | undefined {
  const first = meta[`${AUTHORITY_PATH_META}0`];
  if (!first) return undefined;
  return Array.from({ length: AUTHORITY_PATH_CHUNKS }, (_, i) => meta[`${AUTHORITY_PATH_META}${i}`] ?? '').join('').split(',');
}
export const RENEW_HASH_META = "walkie_renew_hash";
/** Authority that received the token. These move only when a new renewal hash is issued. */
export const RENEW_AUTHORITY_META = 'walkie_renew_authority';
export const RENEW_CHAIN_META = 'walkie_renew_chain';
/** Unix ms of the last seat/price change the webhook saw: the daemon's daily status check-in compares it (FINAL Codex 4). */
export const REFRESH_META = "walkie_refresh_at";
const LEGACY_LICENSE_META = "walkie_license";

export type Metadata = Readonly<Record<string, string>>;

/** Legacy license chunk keys (walkie_license and walkie_license_<n>) in the metadata. */
function legacyChunkKeys(meta: Metadata): string[] {
  return Object.keys(meta).filter((k) => k === LEGACY_LICENSE_META || /^walkie_license_[0-9]+$/.test(k));
}

/** The metadata update that removes every legacy license chunk ({} when there are none). */
export function clearLicenseMetadata(existing: Metadata): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of legacyChunkKeys(existing)) out[k] = "";
  return out;
}

/** Hex sha256 of a renewal token (what walkie_renew_hash holds). */
export function renewHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time check of a presented renewal token against the stored hash. */
export function renewTokenMatches(token: string, storedHash: string | undefined): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(renewHash(token), "hex"), Buffer.from(storedHash, "hex"));
}
