import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { ComputeDeps } from './deps.js';
import { chainRelation, teamAuthority, type StoredChain, type TeamProof } from './team-proof.js';
import type { BindClaim, Tx } from './store.js';
import { newToken, tokenHash } from './tokens.js';
import { ComputeError } from './service.js';
import { canonicalJson } from '../protocol/canonical.js';
import { Event } from '../protocol/schemas.js';
import { verifyEvent } from '../protocol/keys.js';
import { nodeIdFromPubkey } from '../protocol/ids.js';
import { handoverNoticeText } from '../protocol/handover-notice.js';
import { firstFunded, noteFirstFunded, observeOwners, ownerHistory, REMOVED_OWNER_MS } from './roster-history.js';
import type { SubscriptionLite } from '../stripe.js';
import { AUTHORITY_CHAIN_META, AUTHORITY_META, TEAM_META } from '../metadata.js';
import { optionalEnv, type Env } from '../env.js';

export const HANDOVER_MS = 24 * 60 * 60_000;
export const ACK_EXPIRY_MS = 72 * 60 * 60_000;
export interface PendingHandover {
  readonly old_chain: StoredChain;
  readonly proposed_chain: StoredChain;
  readonly proposed_key: string;
  readonly accounts: readonly string[];
  readonly owners: readonly string[];
  readonly eligible_owners: readonly string[];
  readonly eligible_acknowledgers?: readonly string[];
  readonly proposed_roster: TeamProof;
  readonly proposed_at: number;
  readonly expires_at: number;
  readonly acknowledged_at?: number;
  readonly acknowledged_by?: string;
  readonly completes_at: number | null;
  /** Legacy rows may contain plaintext tokens; new rows store only encrypted_tokens. */
  readonly tokens?: readonly { account_id: string; token: string }[];
  readonly encrypted_tokens?: string;
  readonly token_hashes: Readonly<Record<string, string>>;
  readonly objected_by?: string;
  readonly notice_event_id?: string;
  readonly last_alert_at?: number;
}
export const handoverKey = (team: string): string => `compute-handover:${team}`;
export const licenseTransitionKey = (team: string): string => `compute-license-transition:${team}`;
const expiredKey = (team: string): string => `compute-handover-expired:${team}`;
const liftedKey = (team: string): string => `compute-handover-expired-lift:${team}`;
type ExpiredLift = { chainId: string; proposedKey: string; state: 'available' | 'pending' | 'used' };
const matchesLift = (lift: ExpiredLift | undefined, chainId: string, key: string): boolean =>
  lift?.chainId === chainId && lift.proposedKey === key && lift.state !== 'used';
export interface LicenseTransition {
  readonly chainId: string;
  readonly key: string;
  readonly subscriptions: Readonly<Record<string, { readonly oldKey?: string; readonly oldChainId?: string;
    readonly fulfilled: boolean; readonly renewalRequired?: boolean }>>;
}
export async function rejectedHandoverDigest(t: Tx, team: string, proposed: StoredChain,
  from = 0, proposedKey?: string): Promise<string | null> {
  const lift = await t.control(liftedKey(team)) as ExpiredLift | undefined;
  const lifted = Boolean(proposedKey && matchesLift(lift, proposed.chainId, proposedKey));
  const recorded = await t.control(`compute-handover-rejected-digests:${team}`) as string[] | undefined;
  const legacy = await t.control(`compute-handover-rejected:${team}`) as string[] | undefined;
  const explicit = await t.control(`compute-handover-explicit-rejected-digests:${team}`) as string[] | undefined;
  const explicitPairs = await t.control(`compute-handover-explicit-rejected:${team}`) as string[] | undefined;
  const explicitDigests = new Set([...(explicit ?? []), ...(explicitPairs ?? [])
    .map(item => item.split(':')[0]!).filter(digest => recorded?.includes(digest))]);
  const anchors = new Set(legacy?.filter(item => item.includes(':')).map(item => item.split(':')[0]!) ?? []);
  const rejected = new Set([...(recorded ?? []), ...explicitDigests, ...(legacy ?? []).filter(item =>
    /^[0-9a-f]{64}$/.test(item) && !anchors.has(item))]);
  return proposed.chain?.slice(from).find(digest => rejected.has(digest) &&
    !(lifted && digest === proposed.chainId && !explicitDigests.has(digest))) ?? null;
}
export async function rejectedHandover(t: Tx, team: string, old: StoredChain, proposed: StoredChain,
  proposedKey: string): Promise<boolean> {
  const lift = await t.control(liftedKey(team)) as ExpiredLift | undefined;
  if (await rejectedHandoverDigest(t, team, proposed, old.depth + 1, proposedKey)) return true;
  if (matchesLift(lift, proposed.chainId, proposedKey)) return false;
  const rejected = await t.control(`compute-handover-rejected:${team}`) as string[] | undefined;
  if (!rejected?.length) return false;
  // A rejected or expired transfer digest stays blocked, including every descendant. Approval never erases it.
  if (rejected.includes(proposed.chainId) ||
      proposed.chain?.slice(old.depth + 1).some(chainId => rejected.includes(chainId))) return true;
  // The proposer's key and the old chain stay blocked until the operator approves this exact chain and key.
  const approved = await t.control(`compute-handover-approved:${team}`) as string[] | undefined;
  if (approved?.includes(`${proposed.chainId}:${proposedKey}`)) return false;
  return rejected.includes(old.chainId) || rejected.includes(`${old.chainId}:${proposedKey}`);
}
export const objectionMessage = (team: string, chainId: string, expires: number): string =>
  `walkie-compute-handover-object-v1\n${team}\n${chainId}\n${expires}`;
export const statusMessage = (team: string, expires: number): string =>
  `walkie-compute-handover-status-v1\n${team}\n${expires}`;
export const ackMessage = (team: string, chainId: string, expires: number, eventId: string, eventHash: string): string =>
  `walkie-compute-handover-ack-v2\n${team}\n${chainId}\n${eventId}\n${eventHash}\n${expires}`;

function validOwnerSignature(key: string, message: string, signature: string): boolean {
  try {
    const raw = Buffer.from(key, 'base64'), sig = Buffer.from(signature, 'base64');
    if (raw.length !== 32 || raw.toString('base64') !== key || sig.length !== 64 || sig.toString('base64') !== signature) return false;
    return verify(null, Buffer.from(message), createPublicKey({ format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') } }), sig);
  } catch { return false; }
}

type SignedRoster = { key?: unknown; expires_at?: unknown; signature?: unknown; roster?: TeamProof; chain_id?: unknown;
  notice_event?: unknown; notice_event_id?: unknown; notice_event_hash?: unknown };
function signedInput(d: ComputeDeps, team: string, input: unknown, kind: 'status' | 'object' | 'ack'): SignedRoster {
  const v = input as SignedRoster | null;
  const message = kind === 'status' ? statusMessage(team, v?.expires_at as number) :
    kind === 'ack' ? ackMessage(team, v?.chain_id as string, v?.expires_at as number,
      v?.notice_event_id as string, v?.notice_event_hash as string) :
    objectionMessage(team, v?.chain_id as string, v?.expires_at as number);
  if (!/^[0-9a-f]{16}$/.test(team) || !v || typeof v.key !== 'string' || typeof v.signature !== 'string' ||
      !Number.isSafeInteger(v.expires_at) || (v.expires_at as number) <= d.now() ||
      (v.expires_at as number) > d.now() + 300_000 ||
      (kind !== 'status' && typeof v.chain_id !== 'string') ||
      !validOwnerSignature(v.key, message, v.signature))
    throw new ComputeError(403, `invalid_handover_${kind === 'object' ? 'objection' : kind}`);
  return v;
}
function laterRoster(p: PendingHandover, v: SignedRoster): boolean {
  const submitted = v.roster?.roster_events;
  const proposed = p.proposed_roster.roster_events;
  return Array.isArray(submitted) && Array.isArray(proposed) && submitted.length > proposed.length &&
    proposed.every((event, i) => canonicalJson(event) === canonicalJson(submitted[i]));
}
async function refreshRoster(t: Tx, team: string, p: PendingHandover, v: SignedRoster): Promise<PendingHandover> {
  if (!v.roster || !laterRoster(p, v)) return p;
  const latest = teamAuthority(team, v.roster);
  if (!latest || chainRelation(p.proposed_chain, latest) !== 'equal') return p;
  const updated = { ...p, owners: [...latest.owners], proposed_roster: v.roster };
  await t.setControl(handoverKey(team), updated);
  return updated;
}
function currentOwner(team: string, p: PendingHandover, v: SignedRoster, kind: 'object' | 'ack' = 'object'): boolean {
  if (typeof v.key !== 'string' || !(kind === 'ack' ? p.eligible_acknowledgers : p.eligible_owners)?.includes(v.key) || !v.roster) return false;
  const roster = teamAuthority(team, v.roster);
  if (!roster || (kind === 'ack' && !roster.owners.includes(v.key)) ||
      !['equal', 'extends'].includes(chainRelation(p.old_chain, roster))) return false;
  return true;
}

export async function statusHandover(d: ComputeDeps, team: string, input: unknown): Promise<PendingHandover> {
  const v = signedInput(d, team, input, 'status');
  const pending = await d.store.tx(async t => {
    await t.lockControl(`enrollment-chain:${team}`);
    const p = await t.control(handoverKey(team)) as PendingHandover | undefined;
    return p && currentOwner(team, p, v) ? refreshRoster(t, team, p, v) : undefined;
  });
  if (!pending || !currentOwner(team, pending, v)) throw new ComputeError(404, 'handover_not_found');
  return pending;
}

export async function heldAccounts(t: Tx, team: string, now?: number): Promise<string[]> {
  const held: string[] = [];
  for (const a of await t.accountsByTeam(team)) {
    const checkouts = await t.control(`compute-open-checkouts:${a.id}`) as { expires_at: number }[] | undefined;
    if (a.first_funded_at != null || await t.balance(a.id) > 0 || (now !== undefined && checkouts?.some(c => c.expires_at > now)) || (await t.rentals(a.id, 0)).some(r =>
      ['queued', 'needs_code', 'starting', 'running', 'stopping'].includes(r.state) ||
      (r.safety?.reserved ?? 0) > r.charged_micros)) held.push(a.id);
  }
  return held;
}

/** Anchor a missing legacy enrollment to the key already recorded on every held account. */
export async function seedLegacyEnrollment(t: Tx, team: string, roster: TeamProof,
  stored: StoredChain | undefined, held: readonly string[], now: number): Promise<StoredChain | null> {
  if (!held.length || await t.enrollment(team)) return null;
  const accounts = await t.accountsByTeam(team);
  const oldKey = accounts[0]?.owner_key;
  if (!oldKey || accounts.some(a => a.owner_key !== oldKey)) return null;
  const root = teamAuthority(team, { genesis: roster.genesis });
  if (!root || !stored && root.key !== oldKey || stored && stored.chain?.[0] !== root.chainId) return null;
  const transfers = Array.isArray(roster.authority_chain) ? roster.authority_chain as { key?: unknown }[] : [];
  const storedKey = stored?.depth ? transfers[stored.depth - 1]?.key : root.key;
  if (storedKey !== oldKey) return null;
  await t.setEnrollment({ team_id: team, key: oldKey, source: 'roster', updated_at: now });
  if (!stored) await t.setControl(`enrollment-chain:${team}`, { ...root, version: 1 });
  return stored ?? root;
}

type HandoverToken = { account_id: string; token: string };
export function requireHandoverTokenKey(env: Env): string {
  const key = optionalEnv(env, 'COMPUTE_HANDOVER_TOKEN_KEY');
  if (!key || key.length < 32) throw new ComputeError(503, 'handover_token_key_unavailable');
  return key;
}
export function tokenCipherKey(secret: string | undefined): Buffer {
  if (!secret || secret.length < 32) throw new ComputeError(503, 'handover_token_key_unavailable');
  return createHash('sha256').update(secret).digest();
}
function sealTokens(secret: string | undefined, team: string, chain: string, tokens: HandoverToken[]): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenCipherKey(secret), nonce);
  cipher.setAAD(Buffer.from(`${team}:${chain}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function openTokens(secret: string | undefined, team: string, chain: string, sealed: string): HandoverToken[] {
  try {
    const data = Buffer.from(sealed, 'base64url');
    if (data.length < 29 || data.toString('base64url') !== sealed) throw Error('bad envelope');
    const decipher = createDecipheriv('aes-256-gcm', tokenCipherKey(secret), data.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${team}:${chain}`));
    decipher.setAuthTag(data.subarray(12, 28));
    const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
    if (!Array.isArray(parsed) || !parsed.every(item => item && typeof item.account_id === 'string' &&
        /^ca_[0-9a-f]{16}$/.test(item.account_id) && typeof item.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(item.token)))
      throw Error('bad token shape');
    return parsed as HandoverToken[];
  } catch { throw new ComputeError(503, 'handover_token_unavailable'); }
}

export async function holdHandover(d: Pick<ComputeDeps, 'now' | 'log' | 'handoverTokenKey'>, t: Tx, team: string, old: StoredChain,
  proposed: StoredChain, proposedKey: string, owners: readonly string[], roster: TeamProof, accounts: readonly string[]): Promise<{
    pending: PendingHandover; tokens: { account_id: string; token: string }[]
  }> {
  const prior = await t.control(handoverKey(team)) as PendingHandover | undefined;
  if (await rejectedHandover(t, team, old, proposed, proposedKey)) {
    d.log('alert_handover_rejected_refusal', { team, old_chain: old.chainId, chain: proposed.chainId });
    throw new ComputeError(403, 'team_ownership_required');
  }
  if (prior && (prior.proposed_chain.chainId !== proposed.chainId || prior.objected_by))
    throw new ComputeError(403, 'team_ownership_required');
  if (prior) {
    const tokens = prior.encrypted_tokens
      ? openTokens(d.handoverTokenKey, team, prior.proposed_chain.chainId, prior.encrypted_tokens)
      : [...(prior.tokens ?? [])];
    if (!prior.encrypted_tokens && tokens.length) {
      const upgraded = { ...prior, tokens: [], encrypted_tokens: sealTokens(d.handoverTokenKey, team, prior.proposed_chain.chainId, tokens) };
      await t.setControl(handoverKey(team), upgraded);
      return { pending: upgraded, tokens };
    }
    return { pending: prior, tokens };
  }
  const lift = await t.control(liftedKey(team)) as ExpiredLift | undefined;
  if (matchesLift(lift, proposed.chainId, proposedKey))
    await t.setControl(liftedKey(team), { ...lift, state: 'pending' });
  const tokens = (await t.accountsByTeam(team)).map(a => ({ account_id: a.id, token: newToken() }));
  let history = await ownerHistory(t, team);
  const storedOwners = await t.control(`enrollment-owners:${team}`) as string[] | undefined;
  if (!Object.keys(history).length && Array.isArray(storedOwners)) history = await observeOwners(t, team, storedOwners, d.now());
  const fundedAt = await firstFunded(t, team);
  if (fundedAt === undefined) await noteFirstFunded(t, team, d.now());
  const eligibleOwners = Object.entries(history).filter(([, h]) => h.removed_at === undefined || d.now() - h.removed_at <= REMOVED_OWNER_MS).map(([key]) => key);
  const eligibleAcknowledgers = Object.entries(history).filter(([, h]) =>
    h.removed_at === undefined && h.admitted_at <= d.now() - HANDOVER_MS && h.admitted_at < (fundedAt ?? d.now())).map(([key]) => key);
  const pending: PendingHandover = {
    old_chain: old, proposed_chain: proposed, proposed_key: proposedKey,
    accounts: [...accounts], owners: [...owners], eligible_owners: [...eligibleOwners], eligible_acknowledgers: eligibleAcknowledgers,
    proposed_roster: roster, proposed_at: d.now(), last_alert_at: d.now(),
    expires_at: d.now() + ACK_EXPIRY_MS, completes_at: null,
    encrypted_tokens: sealTokens(d.handoverTokenKey, team, proposed.chainId, tokens),
    token_hashes: Object.fromEntries(tokens.map(a => [a.account_id, tokenHash(a.token)])),
  };
  await t.setControl(handoverKey(team), pending);
  d.log('alert_handover_operator_review', { team, old_chain: old.chainId, chain: proposed.chainId,
    eligible_owners: eligibleOwners.join(','), acknowledged_by: '', objected_by: '' });
  const branchKeys = new Set([proposedKey]);
  const genesis = Event.safeParse(roster.genesis);
  if (genesis.success) branchKeys.add(String(genesis.data.body.node_pubkey));
  for (const item of Array.isArray(roster.authority_chain) ? roster.authority_chain : []) {
    const key = item && typeof item === 'object' ? (item as { key?: unknown }).key : undefined;
    if (typeof key === 'string') branchKeys.add(key);
  }
  if (!eligibleAcknowledgers.some(key => !branchKeys.has(key))) d.log('alert_handover_no_independent_owner', { team });
  if (!prior) {
    await t.lockControl('compute-handover-teams');
    const index = await t.control('compute-handover-teams') as string[] | undefined;
    await t.setControl('compute-handover-teams', [...new Set([...(index ?? []), team])]);
  }
  return { pending, tokens };
}

async function clearHandover(t: Tx, team: string): Promise<void> {
  await t.setControl(handoverKey(team), null);
  await t.lockControl('compute-handover-teams');
  const index = await t.control('compute-handover-teams') as string[] | undefined;
  await t.setControl('compute-handover-teams', (index ?? []).filter(id => id !== team));
}

async function recordRejectedHandover(t: Tx, team: string, pending: PendingHandover): Promise<void> {
  const key = `compute-handover-rejected:${team}`;
  const rejected = await t.control(key) as string[] | undefined;
  await t.setControl(key, [...new Set([...(rejected ?? []), pending.old_chain.chainId, pending.proposed_chain.chainId,
    `${pending.old_chain.chainId}:${pending.proposed_key}`])]);
  if (pending.proposed_chain.chainId !== pending.old_chain.chainId) {
    const digestKey = `compute-handover-rejected-digests:${team}`;
    const digests = await t.control(digestKey) as string[] | undefined;
    await t.setControl(digestKey, [...new Set([...(digests ?? []), pending.proposed_chain.chainId])]);
  }
}

export async function rejectHandover(d: ComputeDeps, t: Tx, team: string,
  chainId: string, proposedKey: string): Promise<boolean> {
  await t.lockControl(`enrollment-chain:${team}`);
  const pending = await t.control(handoverKey(team)) as PendingHandover | undefined;
  if (!pending || pending.proposed_chain.chainId !== chainId || pending.proposed_key !== proposedKey) return false;
  const explicit = await t.control(`compute-handover-explicit-rejected:${team}`) as string[] | undefined;
  await t.setControl(`compute-handover-explicit-rejected:${team}`,
    [...new Set([...(explicit ?? []), `${chainId}:${proposedKey}`])]);
  if (pending.proposed_chain.chainId !== pending.old_chain.chainId) {
    const key = `compute-handover-explicit-rejected-digests:${team}`;
    const digests = await t.control(key) as string[] | undefined;
    await t.setControl(key, [...new Set([...(digests ?? []), pending.proposed_chain.chainId])]);
  }
  await t.setControl(liftedKey(team), null);
  await recordRejectedHandover(t, team, pending);
  await clearHandover(t, team);
  d.log('compute_handover_rejected', { team, old_chain: pending.old_chain.chainId, chain: pending.proposed_chain.chainId });
  return true;
}

export async function liftExpiredHandover(d: ComputeDeps, t: Tx, team: string,
  chainId: string, proposedKey: string): Promise<boolean> {
  await t.lockControl(`enrollment-chain:${team}`);
  const proposal = `${chainId}:${proposedKey}`;
  const expired = await t.control(expiredKey(team)) as string[] | undefined;
  const explicit = await t.control(`compute-handover-explicit-rejected:${team}`) as string[] | undefined;
  const lift = await t.control(liftedKey(team)) as ExpiredLift | undefined;
  if (!expired?.includes(proposal) || explicit?.includes(proposal) ||
      await t.control(handoverKey(team)) || lift?.state === 'available' || lift?.state === 'pending' ||
      (lift?.chainId === chainId && lift.proposedKey === proposedKey)) return false;
  await t.setControl(liftedKey(team), { chainId, proposedKey, state: 'available' } satisfies ExpiredLift);
  d.log('alert_handover_expired_lift', { team, chain: chainId });
  return true;
}

/** Acknowledged or objected holds remain open until a named operator decision. */
export async function remindHandover(d: ComputeDeps, t: Tx, team: string): Promise<void> {
  await t.lockControl(`enrollment-chain:${team}`);
  const pending = await t.control(handoverKey(team)) as PendingHandover | undefined;
  if (!pending || (!pending.acknowledged_at && !pending.objected_by) ||
      d.now() - (pending.last_alert_at ?? pending.proposed_at) < HANDOVER_MS) return;
  await t.setControl(handoverKey(team), { ...pending, last_alert_at: d.now() });
  d.log('alert_handover_operator_review', { team, old_chain: pending.old_chain.chainId,
    chain: pending.proposed_chain.chainId, eligible_owners: pending.eligible_owners.join(','),
    acknowledged_by: pending.acknowledged_by ?? '', objected_by: pending.objected_by ?? '' });
}

export async function clearRejectedHandover(d: ComputeDeps, t: Tx, team: string, chainId: string, proposedKey: string): Promise<boolean> {
  await t.lockControl(`enrollment-chain:${team}`);
  const key = `compute-handover-rejected:${team}`;
  const rejected = await t.control(key) as string[] | undefined;
  if (!rejected?.length) return false;
  if (rejected.includes(chainId)) {
    d.log('alert_handover_rejected_refusal', { team, chain: chainId });
    return false;
  }
  const approvedKey = `compute-handover-approved:${team}`;
  const approved = await t.control(approvedKey) as string[] | undefined;
  await t.setControl(approvedKey, [...new Set([...(approved ?? []), `${chainId}:${proposedKey}`])]);
  d.log('alert_handover_clear', { team, chain: chainId });
  return true;
}

export async function resolveFork(d: ComputeDeps, t: Tx, team: string, keepChainId: string): Promise<boolean> {
  await t.lockControl(`enrollment-chain:${team}`);
  if (typeof await t.control(`enrollment-fork:${team}`) !== 'number') return false;
  const current = await t.control(`enrollment-chain:${team}`) as StoredChain | undefined;
  const candidate = await t.control(`enrollment-fork-candidate:${team}`) as
    { chain: StoredChain & { key: string; owners: string[] }; roster: TeamProof } | undefined;
  if (!current || !candidate) return false;
  if (keepChainId !== current.chainId && keepChainId !== candidate.chain.chainId) return false;
  const losing = keepChainId === current.chainId ? candidate.chain : current;
  const losingKey = keepChainId === current.chainId ? candidate.chain.key : (await t.enrollment(team))?.key;
  const rejectedKey = `enrollment-fork-rejected:${team}`;
  const rejected = await t.control(rejectedKey) as { digest: string; predecessor_key: string }[] | undefined;
  const common = current.chain?.findIndex((digest, i) => candidate.chain.chain?.[i] !== digest) ?? -1;
  if (keepChainId === candidate.chain.chainId) {
    const refused = await rejectedHandoverDigest(t, team, candidate.chain, Math.max(0, common), candidate.chain.key);
    if (refused) {
      await t.setControl(`enrollment-fork:${team}`, null);
      await t.setControl(`enrollment-fork-candidate:${team}`, null);
      d.log('alert_handover_rejected_refusal', { team, chain: refused });
      return false;
    }
  }
  const predecessorKey = common <= 1 ?
    (Event.safeParse(candidate.roster.genesis).success ? (candidate.roster.genesis as { body: { node_pubkey: string } }).body.node_pubkey : losingKey) :
    (candidate.roster.authority_chain as { key: string }[] | undefined)?.[common - 2]?.key;
  await t.setControl(rejectedKey, [...(rejected ?? []).filter(item => item.digest !== losing.chainId),
    { digest: losing.chainId, predecessor_key: predecessorKey ?? losingKey ?? '' }]);
  if (keepChainId === candidate.chain.chainId) {
    const accounts = (await t.accountsByTeam(team)).map(a => a.id);
    await holdHandover(d, t, team, current, candidate.chain, candidate.chain.key,
      candidate.chain.owners, candidate.roster, accounts);
  }
  await t.setControl(`enrollment-fork:${team}`, null);
  await t.setControl(`enrollment-fork-candidate:${team}`, null);
  d.log('alert_authority_fork_resolved', { team, chain: keepChainId });
  return true;
}

export async function finishHandover(d: ComputeDeps, t: Tx, team: string,
  approval?: { chainId: string; proposedKey: string; overrideObjection: boolean; subscriptions?: readonly SubscriptionLite[];
    reconcileClaim?: (subscription: string, claim: BindClaim) => Promise<void> }): Promise<boolean> {
  await t.lockControl(`enrollment-chain:${team}`);
  const pending = await t.control(handoverKey(team)) as PendingHandover | undefined;
  if (!pending) return false;
  // Expiry is decided first, so a late approval cannot revive a proposal the operator never vetted in time.
  if (d.now() >= pending.expires_at && !pending.acknowledged_at && !pending.objected_by) {
    const expired = await t.control(expiredKey(team)) as string[] | undefined;
    await t.setControl(expiredKey(team), [...new Set([...(expired ?? []),
      `${pending.proposed_chain.chainId}:${pending.proposed_key}`])]);
    await t.setControl(liftedKey(team), null);
    await recordRejectedHandover(t, team, pending);
    await clearHandover(t, team);
    d.log('alert_handover_expired', { team, old_chain: pending.old_chain.chainId, chain: pending.proposed_chain.chainId });
    return false;
  }
  if (!approval || approval.chainId !== pending.proposed_chain.chainId || approval.proposedKey !== pending.proposed_key ||
      d.now() < pending.proposed_at + HANDOVER_MS || (pending.objected_by && !approval.overrideObjection)) return false;
  const current = await t.control(`enrollment-chain:${team}`) as StoredChain | undefined;
  if (current ? current.chainId !== pending.old_chain.chainId : pending.old_chain.depth !== 0) return false;
  const enrollment = await t.enrollment(team);
  const accounts = await t.accountsByTeam(team);
  if (!enrollment || accounts.some(a => !pending.token_hashes[a.id])) return false;
  const delivered = pending.encrypted_tokens
    ? openTokens(d.handoverTokenKey, team, pending.proposed_chain.chainId, pending.encrypted_tokens)
    : pending.tokens ?? [];
  if (delivered.length !== accounts.length || delivered.some(item =>
    pending.token_hashes[item.account_id] !== tokenHash(item.token)) ||
    accounts.some(a => delivered.filter(item => item.account_id === a.id).length !== 1))
    throw new ComputeError(503, 'handover_token_unavailable');
  const claims = await t.bindClaimsByTeam(team);
  if (claims.length && !approval.reconcileClaim) throw new ComputeError(503, 'handover_operator_unavailable');
  for (const claim of claims) {
    await approval.reconcileClaim!(claim.subscription, claim);
    await t.clearBindClaim(claim.subscription, claim.hash);
  }
  for (const a of accounts) {
    const hash = pending.token_hashes[a.id]!;
    await t.setAccount(a.id, { token_hash: hash, owner_key: pending.proposed_key, authority: pending.proposed_key });
  }
  await t.setEnrollment({ ...enrollment, key: pending.proposed_key, updated_at: d.now() });
  await t.setControl(`enrollment-chain:${team}`, { ...pending.proposed_chain,
    version: ((current as StoredChain & { version?: number } | undefined)?.version ?? 0) + 1 });
  await observeOwners(t, team, pending.owners, d.now());
  await t.setControl(`enrollment-owners:${team}`, [...pending.owners]);
  const listed = Object.fromEntries((approval.subscriptions ?? [])
    .filter(sub => sub.metadata[TEAM_META] === team &&
      (!sub.metadata[AUTHORITY_META] || sub.metadata[AUTHORITY_META] === enrollment.key) &&
      (!sub.metadata[AUTHORITY_CHAIN_META] || sub.metadata[AUTHORITY_CHAIN_META] === pending.old_chain.chainId))
    .map(sub => [sub.id, { oldKey: sub.metadata[AUTHORITY_META],
      oldChainId: sub.metadata[AUTHORITY_CHAIN_META], fulfilled: false }]));
  const subscriptions = { ...listed, ...Object.fromEntries(claims
    .filter(claim => claim.authority === enrollment.key && claim.chain === pending.old_chain.chainId)
    .map(claim => [claim.subscription, { oldKey: claim.authority, oldChainId: claim.chain,
      fulfilled: false, renewalRequired: true }])) };
  await t.setControl(licenseTransitionKey(team), Object.keys(subscriptions).length ? {
    chainId: pending.proposed_chain.chainId, key: pending.proposed_key, subscriptions,
  } satisfies LicenseTransition : null);
  await t.setControl(liftedKey(team), null);
  await clearHandover(t, team);
  if (pending.objected_by && approval.overrideObjection) d.log('alert_handover_objection_overridden', {
    team, old_chain: pending.old_chain.chainId, chain: pending.proposed_chain.chainId, objected_by: pending.objected_by });
  d.log('compute_handover_completed', { team });
  return true;
}

export async function objectHandover(d: ComputeDeps, team: string, input: unknown): Promise<void> {
  const v = signedInput(d, team, input, 'object');
  const objected = await d.store.tx(async t => {
    await t.lockControl(`enrollment-chain:${team}`);
    const prior = await t.control(handoverKey(team)) as PendingHandover | undefined;
    const p = prior ? await refreshRoster(t, team, prior, v) : undefined;
    if (!p || p.proposed_chain.chainId !== v.chain_id || !p.acknowledged_at && d.now() >= p.expires_at ||
        p.completes_at !== null && d.now() >= p.completes_at || !currentOwner(team, p, v))
      throw new ComputeError(403, 'invalid_handover_objection');
    if (p.objected_by) return null;
    await t.setControl(handoverKey(team), { ...p, objected_by: v.key, last_alert_at: d.now() });
    return p;
  });
  if (objected) d.log('alert_handover_objection', { team, old_chain: objected.old_chain.chainId,
    chain: objected.proposed_chain.chainId, eligible_owners: objected.eligible_owners.join(','),
    acknowledged_by: objected.acknowledged_by ?? '', objected_by: v.key as string });
}

export async function acknowledgeHandover(d: ComputeDeps, team: string, input: unknown): Promise<void> {
  const v = signedInput(d, team, input, 'ack');
  await d.store.tx(async t => {
    await t.lockControl(`enrollment-chain:${team}`);
    const prior = await t.control(handoverKey(team)) as PendingHandover | undefined;
    const p = prior ? await refreshRoster(t, team, prior, v) : undefined;
    if (!p) throw new ComputeError(403, 'invalid_handover_ack');
    const event = Event.safeParse(v.notice_event);
    const eventHash = event.success ? createHash('sha256').update(canonicalJson(event.data)).digest('hex') : null;
    const authorityKeys = new Set([p.proposed_key]);
    const genesis = Event.safeParse(p.proposed_roster.genesis);
    if (genesis.success) authorityKeys.add(String(genesis.data.body.node_pubkey));
    for (const item of Array.isArray(p.proposed_roster.authority_chain) ? p.proposed_roster.authority_chain : []) {
      const key = item && typeof item === 'object' ? (item as { key?: unknown }).key : undefined;
      if (typeof key === 'string') authorityKeys.add(key);
    }
    const sender = event.success ? p.owners.find(key => nodeIdFromPubkey(key) === event.data.origin) : undefined;
    const noticeText = handoverNoticeText({ v: 1, team, proposed_by: p.proposed_key,
      old_chain: p.old_chain.chainId, proposed_chain: p.proposed_chain.chainId,
      accounts: [...p.accounts], proposed_at: p.proposed_at, completes_at: null, objected: false });
    if (p.proposed_chain.chainId !== v.chain_id || !currentOwner(team, p, v, 'ack') || d.now() >= p.expires_at ||
        authorityKeys.has(v.key as string) || !event.success || !sender || sender === v.key ||
        event.data.team !== team || event.data.kind !== 'msg.post' || event.data.channel !== 'general' ||
        event.data.id !== v.notice_event_id || eventHash !== v.notice_event_hash ||
        !verifyEvent(event.data, sender) || event.data.body.text !== noticeText)
      throw new ComputeError(403, 'invalid_handover_ack');
    if (p.acknowledged_at) return;
    await t.setControl(handoverKey(team), { ...p, acknowledged_at: d.now(), acknowledged_by: v.key, last_alert_at: d.now(),
      notice_event_id: event.data.id });
    d.log('alert_handover_acknowledged', { team, old_chain: p.old_chain.chainId,
      chain: p.proposed_chain.chainId, eligible_owners: p.eligible_owners.join(','), acknowledged_by: v.key as string,
      objected_by: p.objected_by ?? '' });
  });
}
