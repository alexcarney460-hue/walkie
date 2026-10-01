import { expect, test } from "bun:test";
import { generateKeys } from "../../src/daemon/keys.ts";
import { mintOwnerSshGrant, verifyOwnerSshGrant, encodeOwnerSshGrant, decodeOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { ownerPublicKey, ownerPrivateKeyPath } from "../../src/daemon/ssh/owner-key.ts";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function sshKey(): string {
  const name = Buffer.from("ssh-ed25519");
  const a = Buffer.alloc(4); a.writeUInt32BE(name.length);
  const b = Buffer.alloc(4); b.writeUInt32BE(32);
  return `ssh-ed25519 ${Buffer.concat([a, name, b, Buffer.alloc(32, 2)]).toString("base64")}`;
}

test("owner node signs recipient, invite, key and expiry", () => {
  const keys = generateKeys();
  const grant = mintOwnerSshGrant(keys, { team_id: "1234567890abcdef", owner_handle: "alex", recipient: "kira",
    invite_id: "a".repeat(32), public_key: sshKey(), expires_at: 2000 });
  expect(verifyOwnerSshGrant(decodeOwnerSshGrant(encodeOwnerSshGrant(grant)), keys.pubkey, 1000)).toEqual(grant);
  expect(() => verifyOwnerSshGrant({ ...grant, recipient: "other" }, keys.pubkey, 1000)).toThrow();
  expect(() => verifyOwnerSshGrant(grant, keys.pubkey, 2000)).toThrow();
});

test("owner SSH key is created only in a scratch Walkie home with mode 0600", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-owner-key-"));
  try {
    const first = ownerPublicKey(home, true);
    expect(first?.startsWith("ssh-ed25519 ")).toBe(true);
    expect(ownerPublicKey(home, true)).toBe(first);
    expect(statSync(ownerPrivateKeyPath(home)).mode & 0o777).toBe(0o600);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
