// Node identity: ed25519 keypair at node.key (0600), node id, sign/verify.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { canonicalJson } from "../protocol/canonical.ts";
import { nodeIdFromPubkey } from "../protocol/ids.ts";
import { eventHeader } from "../protocol/header.ts";
import type { EventHeader, UnsignedEvent } from "../protocol/schemas.ts";

export interface NodeKeys {
  readonly nodeId: string;
  readonly pubkey: string; // base64 raw 32 bytes
  sign(data: string): string;
  /** The raw 32-byte ed25519 seed: Walkie Direct runs its iroh endpoint on the node key (endpoint id = pubkey). */
  secretSeed(): Uint8Array;
}

function rawPubkey(pub: KeyObject): string {
  const jwk = pub.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("ed25519 public key export failed");
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

function fromPrivate(priv: KeyObject): NodeKeys {
  const pubkey = rawPubkey(createPublicKey(priv));
  return {
    nodeId: nodeIdFromPubkey(pubkey),
    pubkey,
    sign: (data: string) => sign(null, Buffer.from(data, "utf8"), priv).toString("base64"),
    secretSeed: () => {
      const d = (priv.export({ format: "jwk" }) as { d?: string }).d;
      if (!d) throw new Error("ed25519 private key export failed");
      return new Uint8Array(Buffer.from(d, "base64url"));
    },
  };
}

/** In-memory keypair (tests, tooling). */
export function generateKeys(): NodeKeys {
  return fromPrivate(generateKeyPairSync("ed25519").privateKey);
}

/** Loads node.key, generating it (0600) on first run; tightens loose permissions. */
export function loadOrCreateKeys(path: string): NodeKeys {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600 });
    chmodSync(path, 0o600);
    return fromPrivate(privateKey);
  }
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) chmodSync(path, 0o600);
  return fromPrivate(createPrivateKey(readFileSync(path, "utf8")));
}

const pubCache = new Map<string, KeyObject>();

function publicKeyObject(pubkeyB64: string): KeyObject | null {
  const cached = pubCache.get(pubkeyB64);
  if (cached) return cached;
  const raw = Buffer.from(pubkeyB64, "base64");
  if (raw.length !== 32) return null;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    if (pubCache.size > 1000) pubCache.clear();
    pubCache.set(pubkeyB64, key);
    return key;
  } catch {
    return null;
  }
}

/**
 * Verifies an ed25519 signature given as CANONICAL base64 (H3/F3): the text must be exactly what
 * re-encoding its decoded bytes gives (padded, standard alphabet, no stray characters), so no event,
 * stub or request has two valid encodings of one signature.
 */
export function verifySig(pubkeyB64: string, data: string, sigB64: string): boolean {
  const key = publicKeyObject(pubkeyB64);
  if (!key) return false;
  const sig = Buffer.from(sigB64, "base64");
  if (sig.length !== 64 || sig.toString("base64") !== sigB64) return false;
  try {
    return verify(null, Buffer.from(data, "utf8"), key, sig);
  } catch {
    return false;
  }
}

export function isValidPubkey(pubkeyB64: string): boolean {
  return publicKeyObject(pubkeyB64) !== null;
}

/** Strips `sig` and verifies it over canonicalJson of the rest. */
export function verifyEvent(ev: UnsignedEvent & { sig: string }, pubkeyB64: string): boolean {
  const { sig, ...unsigned } = ev;
  return verifySig(pubkeyB64, canonicalJson(unsigned), sig);
}

/** Adds the header signature (`hsig`, PROTOCOL §1) and then the full signature, which covers `hsig`. */
export function signEvent<T extends UnsignedEvent>(keys: NodeKeys, ev: T): T & { sig: string; hsig: string } {
  const withHeader = { ...ev, hsig: keys.sign(canonicalJson(eventHeader(ev))) };
  return { ...withHeader, sig: keys.sign(canonicalJson(withHeader)) };
}

/** Verifies a header signature (an event's or a stub's) against the origin's key. */
export function verifyHeader(header: EventHeader, hsig: string | undefined, pubkeyB64: string): boolean {
  return typeof hsig === "string" && verifySig(pubkeyB64, canonicalJson(header), hsig);
}
