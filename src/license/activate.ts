// `walkie license activate <key|code>` (local API POST /v1/license), the renewal loop and roster
// requests all end here. A key is checked with the core's verifier before anything is signed; the chain
// checks it again. Only a license bound to THIS team is activatable (audit H3): an activation code is
// first exchanged online for one (bind.ts), and another team's key is refused.
import { z } from "zod";
import type { Event } from "../protocol/schemas.ts";
import type { Core } from "../daemon/core.ts";
import { HttpError } from "../daemon/http.ts";
import { MAX_LICENSE_KEY_CHARS, type LicensePayload } from "./format.ts";
import { GRACE_MS } from "./plans.ts";

export const ActivateReq = z.object({ key: z.string().trim().min(1).max(MAX_LICENSE_KEY_CHARS) });

const REJECTION_TEXT: Record<string, string> = {
  malformed: "that is not a license key or activation code (expected <payload>.<signature>)",
  bad_payload: "the license payload is not valid",
  wrong_version: "this key is for another version of the license format; get a fresh one from the billing portal",
  bad_seats: "the license must have at least one seat",
  bad_signature: "the license signature does not verify (not issued by the vendor, or altered)",
};

/** Verifies a signed key or code; throws 400 `invalid_license`. */
export function verifiedPayload(core: Pick<Core, "licenseVerifier">, key: string): LicensePayload {
  const res = core.licenseVerifier(key);
  if (!res.ok) throw new HttpError(400, "invalid_license", REJECTION_TEXT[res.reason] ?? "invalid license key");
  return res.payload;
}

/**
 * Verifies a license for activation on this team; throws 400 `invalid_license`, `activation_code`
 * (a code must be exchanged on the roster authority first), `wrong_team` or `license_expired`.
 * `now` is floored by the core's persisted plan clock (audit M4).
 */
export function checkActivatable(core: Pick<Core, "licenseVerifier" | "planNow" | "teamId">, key: string, now = core.planNow()): LicensePayload {
  const p = verifiedPayload(core, key);
  if (p.kind === "activation") {
    throw new HttpError(400, "activation_code",
      "this is an activation code: run `walkie license activate <code>` on the team's roster authority, which exchanges it for the team's license");
  }
  if (!core.teamId || p.team !== core.teamId) throw new HttpError(400, "wrong_team", "this license key belongs to another team");
  if (Math.max(now, core.planNow()) > p.expires_at + GRACE_MS) {
    throw new HttpError(400, "license_expired", "this license key expired more than 14 days ago; get a fresh one from the billing portal");
  }
  return p;
}

/** True when the chain already holds exactly this key (activation is then a no-op). */
export function alreadyActive(core: Pick<Core, "roster">, key: string): boolean {
  return core.roster.license?.key === key.trim();
}

/** On the authority: records the key on the chain (`team.license`). Returns null if it is already there. */
export function activateOnAuthority(core: Core, key: string, now = core.planNow()): Event | null {
  const k = key.trim();
  checkActivatable(core, k, now);
  if (alreadyActive(core, k)) return null;
  return core.emit("team.license", { key: k });
}
