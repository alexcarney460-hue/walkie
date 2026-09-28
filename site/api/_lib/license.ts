// License issuing for the billing functions. Same format as the daemon's src/license/format.ts
// (kept as a separate copy because Vercel deploys site/ on its own):
//   key = base64url(JSON payload) + "." + base64url(ed25519 signature over the payload SEGMENT, utf8)
// Two kinds (LICENSE-FIX-1): an activation code (what checkout reveals, no team) and a license bound to
// one team (what /api/license/bind and /api/license/renew return). All times are unix milliseconds.
// site/test/license.test.ts proves the daemon's verifier accepts what is made here.
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const LICENSE_VERSION = 2;
export const GRACE_DAYS_AFTER_PERIOD = 5;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** A team id: 16 lowercase hex characters. */
export const TEAM_ID = /^[0-9a-f]{16}$/;
/** Longest key or code accepted (the daemon's limit). */
export const MAX_KEY_CHARS = 4_096;

export type LicensePlan = "team" | "business";
export type LicenseInterval = "month" | "year";
export type LicenseKind = "license" | "activation";

export interface LicensePayload {
  v: 2;
  kind: LicenseKind;
  lic_id: string;
  plan: LicensePlan;
  seats: number;
  email: string;
  interval: LicenseInterval;
  issued_at: number;
  expires_at: number;
  /** Required on a license, absent on an activation code. */
  team?: string;
}

export class LicenseError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
const isStr = (s: unknown, min: number, max: number): s is string =>
  typeof s === "string" && s.length >= min && s.length <= max;

/** Mirrors the daemon's zod schema (src/license/format.ts). Throws LicenseError on any mismatch. */
export function validatePayload(p: LicensePayload): LicensePayload {
  if (p.v !== LICENSE_VERSION) throw new LicenseError("bad_payload", "wrong license version");
  if (p.kind !== "license" && p.kind !== "activation") throw new LicenseError("bad_payload", "kind must be license or activation");
  if (!isStr(p.lic_id, 1, 200)) throw new LicenseError("bad_payload", "lic_id must be 1..200 chars");
  if (p.plan !== "team" && p.plan !== "business") throw new LicenseError("bad_payload", "plan must be team or business");
  if (!isInt(p.seats, 1, 100_000)) throw new LicenseError("bad_payload", "seats must be an integer 1..100000");
  if (!isStr(p.email, 3, 320)) throw new LicenseError("bad_payload", "email must be 3..320 chars");
  if (p.interval !== "month" && p.interval !== "year") throw new LicenseError("bad_payload", "interval must be month or year");
  if (!isInt(p.issued_at, 0, Number.MAX_SAFE_INTEGER)) throw new LicenseError("bad_payload", "issued_at must be unix ms");
  if (!isInt(p.expires_at, 0, Number.MAX_SAFE_INTEGER)) throw new LicenseError("bad_payload", "expires_at must be unix ms");
  if (p.expires_at <= p.issued_at) throw new LicenseError("bad_payload", "expires_at must be after issued_at");
  if (p.kind === "license" && !(typeof p.team === "string" && TEAM_ID.test(p.team))) throw new LicenseError("bad_payload", "a license names its team");
  if (p.kind === "activation" && p.team !== undefined) throw new LicenseError("bad_payload", "an activation code names no team");
  // Fixed key order (the daemon's schema order), team only when present: stable keys for identical inputs.
  return {
    v: 2, kind: p.kind, lic_id: p.lic_id, plan: p.plan, seats: p.seats, email: p.email,
    interval: p.interval, issued_at: p.issued_at, expires_at: p.expires_at,
    ...(p.team !== undefined ? { team: p.team } : {}),
  };
}

/** Parses the PKCS8 PEM from WALKIE_LICENSE_SIGNING_KEY; the message never includes the key. */
export function signingKeyFromPem(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem);
  } catch {
    throw new LicenseError("bad_signing_key", "WALKIE_LICENSE_SIGNING_KEY is not a valid PEM private key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new LicenseError("bad_signing_key", "WALKIE_LICENSE_SIGNING_KEY must be an ed25519 key");
  return key;
}

export function signLicense(payload: LicensePayload, key: KeyObject): string {
  const p = validatePayload(payload);
  const segment = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  const sig = sign(null, Buffer.from(segment, "utf8"), key).toString("base64url");
  return `${segment}.${sig}`;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
function canonical(s: string): Buffer | null {
  if (!B64URL.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.toString("base64url") === s ? b : null;
}

/**
 * Verifies a key or code against the public half of the signing key (as every daemon does against the
 * embedded vendor key): canonical base64url, a 64-byte signature over the payload segment, a valid
 * payload. Returns the payload, or null.
 */
export function verifySigned(key: string, signingKey: KeyObject): LicensePayload | null {
  if (typeof key !== "string" || key.length > MAX_KEY_CHARS) return null;
  const parts = key.split(".");
  if (parts.length !== 2) return null;
  const [segment, sigText] = parts as [string, string];
  const raw = canonical(segment), sig = canonical(sigText);
  if (!raw || !sig || sig.length !== 64) return null;
  let good = false;
  try {
    good = verify(null, Buffer.from(segment, "utf8"), createPublicKey(signingKey), sig);
  } catch {
    good = false;
  }
  if (!good) return null;
  try {
    return validatePayload(JSON.parse(raw.toString("utf8")) as LicensePayload);
  } catch {
    return null;
  }
}

/** Reads a key's payload WITHOUT verifying it (tests and our own stored data only; never for access). */
export function peekPayload(key: string): LicensePayload | null {
  const segment = key.split(".")[0];
  if (!segment) return null;
  try {
    const p = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as LicensePayload;
    return validatePayload(p);
  } catch {
    return null;
  }
}

/** Stripe period end (unix seconds) → license expiry: the period end plus 5 days, in ms. */
export function expiryFromPeriodEnd(periodEndSeconds: number): number {
  return periodEndSeconds * 1000 + GRACE_DAYS_AFTER_PERIOD * DAY_MS;
}
