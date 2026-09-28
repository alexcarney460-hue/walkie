// Signs a release's SHA256SUMS with the vendor RELEASE key → SHA256SUMS.sig (ECDSA P-256 / SHA-256, DER),
// after binding it to the release: exactly one `version <tag>` line is in the file (added at the top).
//   bun scripts/sign-release.ts dist/SHA256SUMS v0.1.0
// Key: WALKIE_RELEASE_SIGNING_KEY (PKCS8 PEM, `\n`-escaped newlines accepted; CI) or
//      ~/keys/walkie-release-signing-p256.pem (local). The key is never printed. Verifies its own output
//      against the embedded public key so a wrong key fails here, not at the customer.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { signRelease, signedVersion, verifyRelease, withVersionLine } from "../src/release/sign.ts";

const [target, tag] = [process.argv[2], process.argv[3]];
if (!target || !tag) { console.error("usage: bun scripts/sign-release.ts <SHA256SUMS> <vX.Y.Z>"); process.exit(2); }

function loadKey(): string {
  const env = process.env.WALKIE_RELEASE_SIGNING_KEY?.trim();
  if (env) return env.includes("\\n") ? env.replace(/\\n/g, "\n") : env;
  const path = join(homedir(), "keys", "walkie-release-signing-p256.pem");
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) { console.error(`refusing ${path}: mode ${mode.toString(8)} is not 0600`); process.exit(1); }
  return readFileSync(path, "utf8");
}

const text = withVersionLine(readFileSync(target, "utf8"), tag);
writeFileSync(target, text);
const bytes = new Uint8Array(Buffer.from(text, "utf8"));
const sig = signRelease(bytes, loadKey());
if (!verifyRelease(bytes, sig)) { console.error("the signing key does not match the embedded release public key (src/release/sign.ts)"); process.exit(1); }
if (signedVersion(text) !== tag) { console.error(`SHA256SUMS does not carry exactly one 'version ${tag}' line`); process.exit(1); }
writeFileSync(`${target}.sig`, sig);
console.log(`signed ${target} (version ${tag}) → ${target}.sig (${sig.byteLength} bytes, ECDSA P-256/SHA-256)`);
