// Issuing side of the license format (format.ts): used by scripts/issue-license.ts and by tests.
// The site's billing functions carry their own copy (site/lib/license.ts) because Vercel deploys
// site/ on its own; test/unit/license.test.ts proves both produce keys the daemon verifies.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { LicensePayload, type LicensePayload as Payload } from "./format.ts";

/** Signs a payload with an ed25519 private key (KeyObject or PKCS8 PEM). Validates the payload first. */
export function signLicense(payload: Payload, privateKey: KeyObject | string): string {
  const p = LicensePayload.parse(payload);
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const segment = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  const sig = sign(null, Buffer.from(segment, "utf8"), key).toString("base64url");
  return `${segment}.${sig}`;
}
