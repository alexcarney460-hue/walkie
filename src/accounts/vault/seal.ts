// Vault cryptography (ACCOUNTS-2).
//   at rest:  AES-256-GCM, a fresh 12-byte IV per seal, AAD binds the ciphertext to vault|account|provider, so a row
//             copied onto another account (or another vault) does not open. Blob = 0x01 | iv(12) | tag(16) | ct.
//   hand-out: a lease reply (phase 3) is sealed to the requester's ephemeral X25519 key: the owner makes its own
//             ephemeral key, HKDF-SHA256(ECDH, salt = nonce, info = "walkie-vault-lease|" + context) → AES-256-GCM
//             with the context as AAD. The transport is already WireGuard; this keeps the token out of anything
//             that logs or proxies a request body.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";

const VERSION = 1;
const IV = 12;
const TAG = 16;

export function sealAtRest(key: Buffer, plaintext: string, aad: string): Buffer {
  if (key.length !== 32) throw new Error("vault key must be 32 bytes");
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]);
}

/** Throws on a wrong key, a changed AAD or any tampering (GCM authentication). */
export function openAtRest(key: Buffer, blob: Uint8Array, aad: string): string {
  const b = Buffer.from(blob);
  if (b.length < 1 + IV + TAG + 1 || b[0] !== VERSION) throw new Error("vault entry is not a sealed secret");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(1, 1 + IV));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(b.subarray(1 + IV, 1 + IV + TAG));
  return Buffer.concat([d.update(b.subarray(1 + IV + TAG)), d.final()]).toString("utf8");
}

export function aadFor(vaultId: string, accountId: string, provider: string): string {
  return `walkie-vault-v1|${vaultId}|${accountId}|${provider}`;
}

// ---- lease sealing (X25519 + HKDF + AES-GCM) ---------------------------------------

// Raw 32-byte X25519 keys wrapped in the fixed SPKI / PKCS8 DER prefixes.
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export interface EphemeralKey { publicKey: string; privateKey: KeyObject }

/** A fresh X25519 key pair; `publicKey` is the raw key, base64url. */
export function ephemeralKey(): EphemeralKey {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(SPKI_PREFIX.length);
  return { publicKey: Buffer.from(raw).toString("base64url"), privateKey };
}

function publicFromRaw(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64url");
  if (raw.length !== 32) throw new Error("invalid X25519 public key");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Exported for tests: a private key from its raw 32 bytes. */
export function privateFromRaw(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

function leaseKey(priv: KeyObject, peerPub: string, nonce: string, context: string): Buffer {
  const shared = diffieHellman({ privateKey: priv, publicKey: publicFromRaw(peerPub) });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(nonce, "utf8"), Buffer.from(`walkie-vault-lease|${context}`, "utf8"), 32));
}

export interface SealedLease { epk: string; box: string }

/** Owner side: seals `secret` to the requester's ephemeral key. */
export function sealLease(secret: string, requesterPub: string, nonce: string, context: string): SealedLease {
  const mine = ephemeralKey();
  const key = leaseKey(mine.privateKey, requesterPub, nonce, context);
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return { epk: mine.publicKey, box: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url") };
}

/** Requester side: opens a lease reply with its ephemeral private key. Throws when anything does not match. */
export function openLease(sealed: SealedLease, mine: KeyObject, nonce: string, context: string): string {
  const key = leaseKey(mine, sealed.epk, nonce, context);
  const b = Buffer.from(sealed.box, "base64url");
  if (b.length < IV + TAG + 1) throw new Error("lease reply is not sealed");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, IV));
  d.setAAD(Buffer.from(context, "utf8"));
  d.setAuthTag(b.subarray(IV, IV + TAG));
  return Buffer.concat([d.update(b.subarray(IV + TAG)), d.final()]).toString("utf8");
}
