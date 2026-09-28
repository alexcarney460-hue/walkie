// Release signing (FINAL Fable 7; FINAL-2 Fable 1 + Codex 5). `SHA256SUMS` of every release is signed with
// the vendor's RELEASE key (ECDSA P-256 with SHA-256; a different key from the license-signing key) and
// published next to it as `SHA256SUMS.sig`: the DER-encoded signature over the file's exact bytes.
// P-256 rather than ed25519 because the installer must verify on a stock machine: macOS ships LibreSSL as
// /usr/bin/openssl, which has no ed25519 `pkeyutl -rawin`, while `openssl dgst -sha256 -verify` works on
// LibreSSL and on OpenSSL 1.0+. `walkie update` verifies with the public key embedded here.
//
// The file carries a signed `version <tag>` line (Codex 5): the installer and the updater require it to
// match the release they asked for, so a signed older release can't be served back as a newer one.
//
// The private key lives only in ~/keys/walkie-release-signing-p256.pem (PKCS8 PEM, mode 0600) and in the
// release workflow's WALKIE_RELEASE_SIGNING_KEY secret. It is never in the repo. The retired ed25519 key
// file (~/keys/walkie-release-signing.key) signs nothing any more.
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/** The release-signing PUBLIC key (EC P-256, SPKI PEM). Replaced only by a new release that rotates it. */
export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgkx2EdLfMqWSGF8WsQZH3Gtu2spE
oaH2+rvI0pAS8YP+YMv/PtLnx0Vuuqvl1DA5gIeotdirB6ixuE90qd3lfw==
-----END PUBLIC KEY-----
`;

/** A DER-encoded ECDSA P-256 signature is 70–72 bytes; anything else is refused before any parsing. */
const MIN_SIG = 64;
const MAX_SIG = 80;

function requireP256(key: KeyObject, what: string): void {
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error(`${what} must be an EC P-256 (prime256v1) key`);
  }
}

/** Signs `bytes` (a SHA256SUMS file) with a PKCS8 PEM private key; returns the DER signature (SHA-256). */
export function signRelease(bytes: Uint8Array, privateKeyPem: string): Uint8Array {
  const key = createPrivateKey(privateKeyPem);
  requireP256(key, "the release signing key");
  return new Uint8Array(sign("sha256", bytes, { key, dsaEncoding: "der" }));
}

/** True when `sig` is the release key's ECDSA signature over `bytes`. Never throws. */
export function verifyRelease(bytes: Uint8Array, sig: Uint8Array, publicKeyPem = RELEASE_PUBLIC_KEY_PEM): boolean {
  if (sig.byteLength < MIN_SIG || sig.byteLength > MAX_SIG) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    requireP256(key, "the release public key");
    return verify("sha256", bytes, { key, dsaEncoding: "der" }, sig);
  } catch {
    return false;
  }
}

const VERSION_LINE = /^version (v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const TAG = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The one `version <tag>` line of a SHA256SUMS file, or null when it is missing, malformed or repeated. */
export function signedVersion(sums: string): string | null {
  const found = sums.split("\n").map((l) => VERSION_LINE.exec(l.trim())?.[1]).filter((v): v is string => !!v);
  return found.length === 1 ? (found[0] as string) : null;
}

/** `sums` with exactly one `version <tag>` line (added at the top if missing); throws if it names another tag. */
export function withVersionLine(sums: string, tag: string): string {
  if (!TAG.test(tag)) throw new Error(`not a release tag: ${tag} (expected vX.Y.Z)`);
  const present = sums.split("\n").filter((l) => /^version /.test(l.trim()));
  if (present.length > 1) throw new Error("SHA256SUMS has more than one version line");
  const existing = present.length ? VERSION_LINE.exec((present[0] as string).trim())?.[1] : undefined;
  if (present.length && existing !== tag) throw new Error(`SHA256SUMS names version ${(present[0] as string).trim().replace(/^version /, "")}, not ${tag}`);
  return existing ? sums : `version ${tag}\n${sums}`;
}
