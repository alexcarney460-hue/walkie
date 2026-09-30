import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { renewHash } from '../metadata.js';
import { ComputeError } from './service.js';
import { tokenCipherKey } from './handover.js';
import type { BindClaim } from './store.js';

const aad = (subscription: string, team: string, hash: string, authority?: string, chain?: string) =>
  Buffer.from(`walkie-bind-claim-v1:${subscription}:${team}:${hash}:${authority ?? ''}:${chain ?? ''}`);

export function sealBindClaim(secret: string, subscription: string, team: string, token: string,
  authority?: string, chain?: string): BindClaim {
  if (Boolean(authority) !== Boolean(chain)) throw new ComputeError(503, 'bind_claim_unavailable');
  const hash = renewHash(token), nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenCipherKey(secret), nonce);
  cipher.setAAD(aad(subscription, team, hash, authority, chain));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { team, hash, sealed_token: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url'),
    ...(authority && chain ? { authority, chain } : {}) };
}

export function openBindClaim(secret: string, subscription: string, claim: BindClaim): string {
  try {
    if (!/^[0-9a-f]{16}$/.test(claim.team) || !/^[0-9a-f]{64}$/.test(claim.hash) ||
        Boolean(claim.authority) !== Boolean(claim.chain)) throw Error('bad claim');
    const data = Buffer.from(claim.sealed_token, 'base64url');
    if (data.length < 29 || data.toString('base64url') !== claim.sealed_token) throw Error('bad envelope');
    const decipher = createDecipheriv('aes-256-gcm', tokenCipherKey(secret), data.subarray(0, 12));
    decipher.setAAD(aad(subscription, claim.team, claim.hash, claim.authority, claim.chain));
    decipher.setAuthTag(data.subarray(12, 28));
    const token = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || renewHash(token) !== claim.hash) throw Error('bad token');
    return token;
  } catch { throw new ComputeError(503, 'bind_claim_unavailable'); }
}
