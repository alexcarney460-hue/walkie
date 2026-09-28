// FINAL Fable 7 / FINAL-2 Fable 1 + Codex 5: SHA256SUMS is signed with the release key (ECDSA P-256, SHA-256,
// DER signature: what stock macOS LibreSSL and OpenSSL both verify with `openssl dgst`), carries a signed
// `version <tag>` line, and `walkie update` and install.sh verify both.
import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_PUBLIC_KEY_PEM, signRelease, signedVersion, verifyRelease, withVersionLine } from "../../src/release/sign.ts";
import { VENDOR_PUBLIC_KEY_B64 } from "../../src/license/vendor-key.ts";

function p256(): { pem: string; pubPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { pem: privateKey.export({ format: "pem", type: "pkcs8" }) as string, pubPem: publicKey.export({ format: "pem", type: "spki" }) as string };
}

const sums = new TextEncoder().encode(`version v0.1.0\n${"a".repeat(64)}  walkie-darwin-arm64\n${"b".repeat(64)}  walkie-linux-x86_64\n`);

describe("release signatures (ECDSA P-256 / SHA-256)", () => {
  test("sign → verify with the matching public key; a changed byte, another key, a truncated or garbage signature fail", () => {
    const k = p256();
    const sig = signRelease(sums, k.pem);
    expect(sig.byteLength).toBeGreaterThanOrEqual(64);
    expect(sig.byteLength).toBeLessThanOrEqual(72); // DER-encoded (r, s)
    expect(verifyRelease(sums, sig, k.pubPem)).toBe(true);
    const tampered = new Uint8Array(sums); tampered[3] = 0x41;
    expect(verifyRelease(tampered, sig, k.pubPem)).toBe(false);
    expect(verifyRelease(sums, sig, p256().pubPem)).toBe(false);
    expect(verifyRelease(sums, sig.slice(0, sig.byteLength - 1), k.pubPem)).toBe(false);
    expect(verifyRelease(sums, new Uint8Array(70), k.pubPem)).toBe(false);
    expect(verifyRelease(sums, sig)).toBe(false); // not the embedded release key
    expect(verifyRelease(sums, new Uint8Array(0), "not a pem")).toBe(false); // never throws
  });

  test("an ed25519 or RSA key is refused for signing (the installer's verifier needs P-256)", () => {
    const ed = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    expect(() => signRelease(sums, ed)).toThrow(/P-256/);
    const other = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    expect(() => signRelease(sums, other)).toThrow(/P-256/);
  });

  test("the embedded release key is an EC P-256 SPKI PEM, separate from the license-signing key", () => {
    const key = createPublicKey(RELEASE_PUBLIC_KEY_PEM);
    expect(key.asymmetricKeyType).toBe("ec");
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(RELEASE_PUBLIC_KEY_PEM).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/);
    expect(RELEASE_PUBLIC_KEY_PEM).not.toContain(VENDOR_PUBLIC_KEY_B64);
  });

  test("install.sh's verifier (`openssl dgst -sha256 -verify`) accepts the signature with the SYSTEM openssl (LibreSSL on macOS) and refuses a tampered file", () => {
    const openssl = existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : Bun.which("openssl");
    if (!openssl) return; // no openssl on this box: the JS path above still proves the format
    const k = p256();
    const dir = mkdtempSync("/tmp/walkie-relsig-");
    try {
      writeFileSync(join(dir, "SHA256SUMS"), sums);
      writeFileSync(join(dir, "SHA256SUMS.sig"), signRelease(sums, k.pem));
      writeFileSync(join(dir, "release.pub"), k.pubPem);
      const verify = () => Bun.spawnSync([openssl, "dgst", "-sha256", "-verify", join(dir, "release.pub"), "-signature", join(dir, "SHA256SUMS.sig"), join(dir, "SHA256SUMS")]);
      const ok = verify();
      expect([ok.exitCode, ok.stdout.toString().trim()]).toEqual([0, "Verified OK"]);
      writeFileSync(join(dir, "SHA256SUMS"), new TextEncoder().encode("version v0.1.0\n" + "x".repeat(64) + "  walkie-darwin-arm64\n"));
      expect(verify().exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the signed version line", () => {
  test("signedVersion reads exactly one `version <tag>` line", () => {
    expect(signedVersion("version v0.1.0\naaaa  walkie-darwin-arm64\n")).toBe("v0.1.0");
    expect(signedVersion("aaaa  walkie-darwin-arm64\nversion v1.2.3\n")).toBe("v1.2.3");
    expect(signedVersion("aaaa  walkie-darwin-arm64\n")).toBeNull();
    expect(signedVersion("version v0.1.0\nversion v0.2.0\n")).toBeNull();
    expect(signedVersion("version 0.1.0\n")).toBeNull(); // tags are vX.Y.Z
    expect(signedVersion("version v0.1.0 extra\n")).toBeNull();
  });

  test("withVersionLine adds the line once, keeps a matching one, refuses a different one", () => {
    const plain = "aaaa  walkie-darwin-arm64\n";
    expect(withVersionLine(plain, "v0.1.0")).toBe("version v0.1.0\naaaa  walkie-darwin-arm64\n");
    expect(withVersionLine("version v0.1.0\n" + plain, "v0.1.0")).toBe("version v0.1.0\n" + plain);
    expect(() => withVersionLine("version v0.0.9\n" + plain, "v0.1.0")).toThrow(/v0.0.9/);
    expect(() => withVersionLine(plain, "0.1.0")).toThrow(/tag/);
  });
});
