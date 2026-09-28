// The site's signer, its verifier and the metadata helpers. The daemon's verifier (src/license/format.ts)
// is the judge: whatever the site issues must pass it.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { makeVerifier } from "../../src/license/format.ts";
import { signLicense as daemonSign } from "../../src/license/sign.ts";
import {
  expiryFromPeriodEnd, LicenseError, peekPayload, signLicense, signingKeyFromPem, verifySigned, type LicensePayload,
} from "../api/_lib/license.ts";
import { clearLicenseMetadata, renewHash, renewTokenMatches } from "../api/_lib/metadata.ts";
import { NOW, testKeypair } from "./helpers.ts";

const TEAM = "0123456789abcdef";
const base: LicensePayload = {
  v: 2, kind: "license", lic_id: "sub_ABC123", plan: "team", seats: 7, email: "lead@kestrel.test",
  interval: "month", issued_at: NOW, expires_at: NOW + 35 * 86_400_000, team: TEAM,
};
const { team: _t, ...codeBase } = { ...base, kind: "activation" as const };

describe("site signer", () => {
  test("licenses and activation codes verify with the daemon's verifier and decode to the same payload", () => {
    const kp = testKeypair();
    const key = signLicense(base, signingKeyFromPem(kp.pem));
    expect(makeVerifier(kp.publicB64)(key)).toEqual({ ok: true, payload: base });
    const code = signLicense(codeBase, signingKeyFromPem(kp.pem));
    expect(makeVerifier(kp.publicB64)(code)).toEqual({ ok: true, payload: codeBase });
  });

  test("the site and the daemon's issuing script produce byte-identical keys", () => {
    const kp = testKeypair();
    expect(signLicense(base, signingKeyFromPem(kp.pem))).toBe(daemonSign(base, kp.pem));
    expect(signLicense(codeBase, signingKeyFromPem(kp.pem))).toBe(daemonSign(codeBase, kp.pem));
  });

  test("another key's signature is rejected", () => {
    const a = testKeypair(), b = testKeypair();
    expect(makeVerifier(b.publicB64)(signLicense(base, signingKeyFromPem(a.pem)))).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("invalid payloads are refused before signing: a license needs a team, a code must have none", () => {
    const key = signingKeyFromPem(testKeypair().pem);
    const bad: Partial<LicensePayload>[] = [
      { seats: 0 }, { seats: 1.5 }, { plan: "free" as never }, { interval: "week" as never }, { lic_id: "" },
      { email: "x" }, { expires_at: NOW }, { v: 1 as never }, { team: undefined }, { team: "ACME" }, { kind: "gift" as never },
      { kind: "activation" },
    ];
    for (const b of bad) expect(() => signLicense({ ...base, ...b }, key)).toThrow(LicenseError);
  });

  test("verifySigned: our own keys only, canonical spelling only", () => {
    const kp = testKeypair(), other = testKeypair();
    const sk = signingKeyFromPem(kp.pem);
    const code = signLicense(codeBase, sk);
    expect(verifySigned(code, sk)).toEqual(codeBase);
    expect(verifySigned(signLicense(codeBase, signingKeyFromPem(other.pem)), sk)).toBeNull();
    expect(verifySigned(`${code}=`, sk)).toBeNull();
    expect(verifySigned(` ${code}`, sk)).toBeNull();
    expect(verifySigned("x".repeat(5000), sk)).toBeNull();
    const [seg, sig] = code.split(".") as [string, string];
    const bumped = Buffer.from(JSON.stringify({ ...codeBase, seats: 900 })).toString("base64url");
    expect(verifySigned(`${bumped}.${sig}`, sk)).toBeNull();
    expect(verifySigned(`${seg}.${sig}`, sk)).not.toBeNull();
  });

  test("a PEM with escaped newlines (as env vars often carry it) is accepted; junk and non-ed25519 are not", () => {
    const kp = testKeypair();
    const escaped = kp.pem.replace(/\n/g, "\\n");
    expect(makeVerifier(kp.publicB64)(signLicense(base, signingKeyFromPem(escaped))).ok).toBe(true);
    expect(() => signingKeyFromPem("not a key")).toThrow("WALKIE_LICENSE_SIGNING_KEY is not a valid PEM private key");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => signingKeyFromPem(privateKey.export({ format: "pem", type: "pkcs8" }) as string)).toThrow("must be an ed25519 key");
  });

  test("peekPayload reads a key back; period end + 5 days in ms", () => {
    const kp = testKeypair();
    expect(peekPayload(signLicense(base, signingKeyFromPem(kp.pem)))).toEqual(base);
    expect(peekPayload("garbage")).toBeNull();
    expect(expiryFromPeriodEnd(1_000)).toBe(1_000_000 + 5 * 86_400_000);
  });
});

describe("metadata", () => {
  test("legacy license chunks are cleared and nothing else", () => {
    const old = { walkie_license: "a".repeat(500), walkie_license_1: "b".repeat(500), walkie_license_2: "c", walkie_plan: "team", walkie_team: TEAM };
    expect(clearLicenseMetadata(old)).toEqual({ walkie_license: "", walkie_license_1: "", walkie_license_2: "" });
    expect(clearLicenseMetadata({ walkie_plan: "team" })).toEqual({});
  });

  test("renewal token hash: sha256 hex, constant-time match, junk never matches", () => {
    const token = "A".repeat(43);
    const h = renewHash(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(renewTokenMatches(token, h)).toBe(true);
    expect(renewTokenMatches("B".repeat(43), h)).toBe(false);
    expect(renewTokenMatches(token, undefined)).toBe(false);
    expect(renewTokenMatches(token, "zz")).toBe(false);
    expect(renewTokenMatches(token, h.toUpperCase())).toBe(false);
  });
});
