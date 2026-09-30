// Site-owned verifier from src/daemon/keys.ts. No private-key or filesystem code is needed here.
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import type { EventHeader, UnsignedEvent } from './schemas.js';

const pubCache = new Map<string, KeyObject>();

function publicKeyObject(pubkeyB64: string): KeyObject | null {
  const cached = pubCache.get(pubkeyB64);
  if (cached) return cached;
  const raw = Buffer.from(pubkeyB64, 'base64');
  if (raw.length !== 32) return null;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    if (pubCache.size > 1000) pubCache.clear();
    pubCache.set(pubkeyB64, key);
    return key;
  } catch {
    return null;
  }
}

export function verifySig(pubkeyB64: string, data: string, sigB64: string): boolean {
  const key = publicKeyObject(pubkeyB64);
  if (!key) return false;
  const sig = Buffer.from(sigB64, 'base64');
  if (sig.length !== 64 || sig.toString('base64') !== sigB64) return false;
  try {
    return verify(null, Buffer.from(data, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

export function isValidPubkey(pubkeyB64: string): boolean {
  return publicKeyObject(pubkeyB64) !== null;
}

export function verifyEvent(ev: UnsignedEvent & { sig: string }, pubkeyB64: string): boolean {
  const { sig, ...unsigned } = ev;
  return verifySig(pubkeyB64, canonicalJson(unsigned), sig);
}

export function verifyHeader(header: EventHeader, hsig: string | undefined, pubkeyB64: string): boolean {
  return typeof hsig === 'string' && verifySig(pubkeyB64, canonicalJson(header), hsig);
}
