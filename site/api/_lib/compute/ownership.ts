import { createHash, createPublicKey, verify } from 'node:crypto';
import type { ComputeDeps } from './deps.js';
import type { Account, Tx } from './store.js';
import { ComputeError } from './service.js';
import { teamAuthority, chainRelation, type StoredChain, type TeamProof } from './team-proof.js';
import { refusedFork } from './fork-rejection.js';
import { rejectedHandoverDigest } from './handover.js';

export interface OwnershipProof extends TeamProof { key: string; expires_at: number; signature: string; lic_id?: string; renewal_token?: string }
export const ownershipMessage = (team: string, expiry: number): string => `walkie-compute-account-v1\n${team}\n${expiry}`;
function signature(key: string, message: string, sig: string): boolean {
  try {
    const raw = Buffer.from(key, 'base64');
    if (raw.length !== 32 || raw.toString('base64') !== key) return false;
    return verify(null, Buffer.from(message), createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') } }), Buffer.from(sig, 'base64'));
  } catch { return false; }
}
/** A fresh self-signature proves possession; enrollment decides whether that key owns this team. */
export function checkOwnership(d: ComputeDeps, team: string, proof: unknown): OwnershipProof {
  const p = proof as OwnershipProof | null;
  if (!/^[0-9a-f]{16}$/.test(team) || !p || typeof p.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(p.key) ||
      typeof p.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(p.signature) || !Number.isSafeInteger(p.expires_at) ||
      p.expires_at <= d.now() || p.expires_at > d.now() + 300_000 ||
      !signature(p.key, ownershipMessage(team, p.expires_at), p.signature) || teamAuthority(team, p)?.key !== p.key) throw new ComputeError(403, 'team_ownership_required');
  return p;
}
/** Check the license before taking a database lock. No token is persisted or logged. */
export async function licenseOwnership(d: ComputeDeps, team: string, p: OwnershipProof): Promise<boolean> {
  if (p.lic_id === undefined && p.renewal_token === undefined) return false;
  if (typeof p.lic_id !== 'string' || !/^sub_[A-Za-z0-9]{1,200}$/.test(p.lic_id) ||
      typeof p.renewal_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(p.renewal_token)) throw new ComputeError(403, 'team_ownership_required');
  let valid = false;
  try { valid = await d.verifyLicense?.(team, p.lic_id, p.renewal_token, p.key) === true; }
  catch { throw new ComputeError(503, 'license_verification_unavailable'); }
  if (!valid) throw new ComputeError(403, 'team_ownership_required');
  return true;
}

/** Serialize first use and rotation, including the absent-row case, across serverless instances. */
export async function enroll(d: ComputeDeps, t: Tx, team: string, p: OwnershipProof, licensed: boolean): Promise<'ok' | 'conflict'> {
  await t.lockControl(`enrollment-chain:${team}`);
  if (p.expires_at <= d.now()) throw new ComputeError(403, 'team_ownership_required');
  const prior = await t.enrollment(team);
  const authority = teamAuthority(team, p);
  if (!authority || authority.key !== p.key) throw new ComputeError(403, 'team_ownership_required');
  const chainKey = `enrollment-chain:${team}`;
  const oldChain = await t.control(chainKey) as StoredChain | undefined;
  const relation = oldChain ? chainRelation(oldChain, authority) : 'extends';
  if (relation === 'conflict') {
    const rejectedDigest = await rejectedHandoverDigest(t, team, authority, 0, authority.key);
    if (rejectedDigest) {
      d.log('alert_handover_rejected_refusal', { team, chain: rejectedDigest });
      return 'conflict';
    }
    const refused = await refusedFork(t, team, oldChain!, authority, p);
    if (refused) {
      const key = `enrollment-fork-refusal-alerted:${team}`;
      const alerted = await t.control(key) as string[] | undefined;
      if (!alerted?.includes(refused)) {
        await t.setControl(key, [...(alerted ?? []), refused]);
        d.log('alert_authority_fork_rejected', { team, chain: refused });
      }
      return 'conflict';
    }
    await t.setControl(`enrollment-fork:${team}`, d.now());
    await t.setControl(`enrollment-fork-candidate:${team}`, { chain: authority, roster: p });
    d.log('alert_authority_fork', { team });
    return 'conflict';
  }
  if (relation === 'older') throw new ComputeError(403, 'team_ownership_required');
  const pinned = d.config.team_authorities[team];
  const oldKey = pinned ?? prior?.key;
  if ((pinned && !oldChain && pinned !== p.key) ||
      (oldKey && oldKey !== p.key && prior?.source !== 'tofu' && authority.depth <= (oldChain?.depth ?? 0))) {
    throw new ComputeError(403, 'team_ownership_required');
  }
  await t.setEnrollment({ team_id: team, key: p.key, source: licensed ? 'license' : 'roster', updated_at: d.now() });
  if (!oldChain || relation === 'extends') await t.setControl(chainKey,
    { depth: authority.depth, chainId: authority.chainId, chain: authority.chain, version: ((oldChain as StoredChain & { version?: number } | undefined)?.version ?? 0) + 1 });
  return 'ok';
}
/** Verify the existing wk1 wire format; bind its signed secret id to exactly one account/rental. */
export async function bindInvite(t: Tx, a: Account, code: string, rental: string, now: number): Promise<void> {
  const raw = Buffer.from(code.slice(3), 'base64url');
  const bad = () => { throw new ComputeError(400, 'invalid_rental_invite'); };
  if (!code.startsWith('wk1') || raw.length < 140 || raw.toString('base64url') !== code.slice(3) || raw[0] !== 1 || !a.owner_key) return bad();
  const team = raw.subarray(1, 9).toString('hex');
  const authority = raw.subarray(9, 41).toString('base64');
  const issuer = raw.subarray(41, 49).toString('hex');
  const expiry = raw.readUInt32BE(65) * 1000;
  const hlen = raw[74]!;
  const rlen = raw[75 + hlen];
  if (raw.length !== 76 + hlen + (rlen ?? -1000) + 64 || raw[73]! > 2 ||
      team !== a.team_id || authority !== a.authority || issuer !== createHash('sha256').update(Buffer.from(a.owner_key, 'base64')).digest('hex').slice(0, 16) ||
      expiry <= now || expiry > now + 3_600_000 ||
      !signature(a.owner_key, 'walkie-invite-v1\n' + raw.subarray(0, -64).toString('base64url'), raw.subarray(-64).toString('base64'))) return bad();
  const key = `invite:${createHash('sha256').update(raw.subarray(49, 65)).digest('hex')}`;
  await t.lockControl(key);
  const prior = await t.control(key);
  const binding = `${a.id}:${rental}`;
  if (prior && prior !== binding) return bad();
  await t.setControl(key, binding);
}
