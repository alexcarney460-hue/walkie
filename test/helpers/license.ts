// A throwaway license vendor for tests: its own ed25519 keypair, a verifier bound to it, and an issuer.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { makeVerifier, type LicensePayload, type LicenseVerifier } from "../../src/license/format.ts";
import { signLicense } from "../../src/license/sign.ts";
import { DAY_MS } from "../../src/license/plans.ts";
import { now } from "./events.ts";

/** The team a license names when a test doesn't say (a key for no real team: every chain rejects it). */
export const NO_TEAM = "0000000000000000";

export interface TestVendor {
  readonly publicKeyB64: string;
  readonly privateKey: KeyObject;
  readonly verify: LicenseVerifier;
  /** Signs a team-bound license; defaults: Team, 10 seats, issued at the simulated clock, 35 days, team NO_TEAM. */
  issue(p?: Partial<LicensePayload>): string;
  /** Signs an activation code (no team); same defaults. */
  code(p?: Partial<LicensePayload>): string;
}

let serial = 0;

export function testVendor(): TestVendor {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const publicKeyB64 = Buffer.from(x, "base64url").toString("base64");
  const base = (p: Partial<LicensePayload>): LicensePayload => {
    const issued = p.issued_at ?? now();
    return {
      v: 2, kind: "license", lic_id: `sub_test${++serial}`, plan: "team", seats: 10, email: "billing@example.com", interval: "month",
      issued_at: issued, expires_at: issued + 35 * DAY_MS, ...p,
    };
  };
  return {
    publicKeyB64, privateKey, verify: makeVerifier(publicKeyB64),
    issue(p = {}) { return signLicense({ team: NO_TEAM, ...base(p) }, privateKey); },
    code(p = {}) {
      const { team: _t, ...rest } = base({ ...p, kind: "activation" });
      return signLicense(rest, privateKey);
    },
  };
}
