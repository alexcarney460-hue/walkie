// License keys and activation codes (docs/BUSINESS.md "How licensing works"): `payload.signature`, where
//   payload   = base64url(JSON of LicensePayload), unpadded
//   signature = base64url(ed25519_sign(vendor_key, utf8(payload))), unpadded, 64 bytes
// The signature covers the payload SEGMENT exactly as written, so a key has one valid spelling:
// both segments must be canonical base64url (re-encoding the decoded bytes gives the same text).
// All times are unix milliseconds. Two kinds share the format (LICENSE-FIX-1, audit H3):
//   kind "activation": what a customer buys; no team. It is exchanged ONLINE, once, for a license
//                      bound to one team (`walkie license activate <code>` → /api/license/bind).
//   kind "license":    carries `team` (the team id); the only kind the chain accepts, and only on that team.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { VENDOR_PUBLIC_KEY_B64 } from "./vendor-key.ts";

export const LICENSE_VERSION = 2;
/** Longest license key accepted anywhere (CLI, local API, chain body). */
export const MAX_LICENSE_KEY_CHARS = 4_096;

export const LicensePlan = z.enum(["team", "business"]);
export type LicensePlan = z.infer<typeof LicensePlan>;
export const LicenseInterval = z.enum(["month", "year"]);
export type LicenseInterval = z.infer<typeof LicenseInterval>;
export const LicenseKind = z.enum(["license", "activation"]);
export type LicenseKind = z.infer<typeof LicenseKind>;
/** A team id (PROTOCOL §1): 16 lowercase hex characters. */
export const TEAM_ID = /^[0-9a-f]{16}$/;

export const LicensePayload = z.object({
  v: z.literal(LICENSE_VERSION),
  kind: LicenseKind,
  lic_id: z.string().min(1).max(200),
  plan: LicensePlan,
  seats: z.number().int().min(1).max(100_000),
  email: z.string().min(3).max(320),
  interval: LicenseInterval,
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  /** The team a license is bound to; required for kind "license", absent on an activation code. */
  team: z.string().regex(TEAM_ID).optional(),
  /** WALKIE-PROJECTS-1: extra boards bought (each board past BOARDS_INCLUDED in a project uses one); absent = 0. */
  extra_boards: z.number().int().min(0).max(100_000).optional(),
}).refine((p) => p.expires_at > p.issued_at, { message: "expires_at must be after issued_at" })
  .refine((p) => (p.kind === "license") === (p.team !== undefined), { message: "a license names its team; an activation code names none" });
export type LicensePayload = z.infer<typeof LicensePayload>;

/** True when a verified payload is a license bound to `teamId` (the only thing a chain accepts). */
export function licenseForTeam(p: LicensePayload, teamId: string | null | undefined): boolean {
  return p.kind === "license" && !!teamId && p.team === teamId;
}

export type LicenseCheck =
  | { readonly ok: true; readonly payload: LicensePayload }
  | { readonly ok: false; readonly reason: LicenseRejection };
export type LicenseRejection = "malformed" | "bad_payload" | "wrong_version" | "bad_seats" | "bad_signature";

/** Verifies a license key; production code uses `verifyLicense` (bound to the embedded vendor key). */
export type LicenseVerifier = (key: string) => LicenseCheck;

const B64URL = /^[A-Za-z0-9_-]+$/;

function canonicalB64url(s: string): Buffer | null {
  if (!B64URL.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

/** Splits and decodes a key WITHOUT checking the signature (display only; never for entitlements). */
export function decodeLicense(key: string): { payload: LicensePayload; segment: string; sig: Buffer } | { error: LicenseRejection } {
  // No trimming: a key has exactly one valid spelling, so the chain can't hold two texts for one grant.
  if (typeof key !== "string" || key.length > MAX_LICENSE_KEY_CHARS) return { error: "malformed" };
  const parts = key.split(".");
  if (parts.length !== 2) return { error: "malformed" };
  const [segment, sigText] = parts as [string, string];
  const raw = canonicalB64url(segment);
  const sig = canonicalB64url(sigText);
  if (!raw || !sig || sig.length !== 64) return { error: "malformed" };
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return { error: "bad_payload" };
  }
  const v = (json as { v?: unknown } | null)?.v;
  if (v !== LICENSE_VERSION) return { error: "wrong_version" };
  const seats = (json as { seats?: unknown }).seats;
  if (typeof seats === "number" && seats < 1) return { error: "bad_seats" };
  const parsed = LicensePayload.safeParse(json);
  if (!parsed.success) return { error: "bad_payload" };
  return { payload: parsed.data, segment, sig };
}

function publicKey(rawB64: string): KeyObject {
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) throw new Error("license public key must be 32 raw bytes");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

/** A verifier bound to one public key (raw ed25519, base64). Tests build one for a throwaway key. */
export function makeVerifier(publicKeyB64: string): LicenseVerifier {
  const key = publicKey(publicKeyB64);
  return (licenseKey: string): LicenseCheck => {
    const d = decodeLicense(licenseKey);
    if ("error" in d) return { ok: false, reason: d.error };
    let good = false;
    try {
      good = verify(null, Buffer.from(d.segment, "utf8"), key, d.sig);
    } catch {
      good = false;
    }
    return good ? { ok: true, payload: d.payload } : { ok: false, reason: "bad_signature" };
  };
}

/** The production verifier: the embedded vendor key, no override. */
export const verifyLicense: LicenseVerifier = makeVerifier(VENDOR_PUBLIC_KEY_B64);
