import { createHash, createPublicKey, verify } from 'node:crypto';
import type { ComputeDeps } from './deps.js';
import type { Account, Tx } from './store.js';
import { ComputeError } from './service.js';
import { teamAuthority, chainRelation, type StoredChain, type TeamProof } from './team-proof.js';
import { refusedFork } from './fork-rejection.js';
import { handoverKey, rejectedHandover, rejectedHandoverDigest } from './handover.js';
import { AUTHORITY_META, TEAM_META } from '../metadata.js';
import { ENDED_STATUSES, LICENCE_READ_MS } from './license-proof.js';
import { backfillComplete, dropEndedBindings, licenceRecord, type LicenceRecord } from './licence-records.js';
import type { SubscriptionLite } from '../stripe.js';

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
  // The credential check cannot run (no licence key) or did not answer: fail closed and tell the operator, instead of a
  // silent refusal (lane C round 11).
  const unavailable = (reason: string): ComputeError => {
    d.log('licence_read_failed_reason', { team, reason });
    d.log('alert_licence_read_failed', { team });
    return new ComputeError(503, 'license_verification_unavailable');
  };
  if (!d.verifyLicense) throw unavailable('licence_verifier_unconfigured');
  let valid = false;
  try { valid = await d.verifyLicense(team, p.lic_id, p.renewal_token, p.key) === true; }
  catch (err) { throw unavailable(err instanceof Error ? err.message.slice(0, 80) : 'error'); }
  if (!valid) throw new ComputeError(403, 'team_ownership_required');
  return true;
}

type VerifiedChain = { key: string; chainId: string; depth: number; chain: string[] };

/**
 * `next`'s verified chain cut where `key` first held the authority, or null when `key` is not an earlier link of it.
 * `proof` is the roster proof teamAuthority verified into `next`: the founder, then each transfer's key.
 */
export function earlierLink(proof: TeamProof, next: VerifiedChain, key: string): StoredChain | null {
  const genesis = proof.genesis as { body?: { node_pubkey?: unknown } } | undefined;
  const transfers = Array.isArray(proof.authority_chain) ? proof.authority_chain as { key?: unknown }[] : [];
  const depth = [genesis?.body?.node_pubkey, ...transfers.map(item => item.key)].indexOf(key);
  return depth >= 0 && depth < next.depth
    ? { depth, chainId: next.chain[depth]!, chain: next.chain.slice(0, depth + 1) } : null;
}

/** An unresolved fork: no successor may move the enrollment or open a hold until the operator resolves it. */
export async function forkOpen(t: Tx, team: string): Promise<boolean> {
  return await t.control(`enrollment-fork:${team}`) != null;
}

/** A move from `from` to `next` is never taken while a handover is held, a fork is flagged, or it was rejected or expired. */
export async function movable(t: Tx, team: string, from: StoredChain, next: VerifiedChain): Promise<boolean> {
  if (await t.control(handoverKey(team)) != null || await forkOpen(t, team)) return false;
  return !await rejectedHandover(t, team, from, next, next.key);
}

/**
 * A licence re-bind recorded `next`'s verified chain while the enrollment still names `enrolledKey`, an earlier link
 * of it (the roster authority moved on a team without compute credit). Only the head of that recorded chain may take
 * the enrollment over, the normal way: fresh tokens, or the funded hold (lane C round 5).
 */
export async function recordedHead(t: Tx, team: string, enrolledKey: string | undefined, recorded: StoredChain | undefined,
  next: VerifiedChain, proof: TeamProof): Promise<boolean> {
  if (!enrolledKey || !recorded || next.key === enrolledKey || chainRelation(recorded, next) !== 'equal') return false;
  const from = earlierLink(proof, next, enrolledKey);
  return !!from && await movable(t, team, from, next);
}

/** What the reads before the team lock found for a team's first enrollment (see firstEnrollmentRefusal). */
export type FirstEnrollmentGate =
  | { readonly kind: 'enrolled' }
  | { readonly kind: 'unchecked' }
  | { readonly kind: 'gate'; readonly recorded: ReadonlySet<string>; readonly live: ReadonlyMap<string, string | null> };

/** At most this many licences are read by id for one first enrollment, GATE_READ_CONCURRENCY at a time (round 12). */
export const MAX_GATE_READS = 50;
export const GATE_READ_CONCURRENCY = 10;
const TOO_MANY = new Error('licence_record_too_large');

/**
 * Before any Stripe read, the credential check included (lane C round 12): the first enrollments the store alone already
 * refuses. The backfill has not completed, or the team's record overflowed. Null when the team is enrolled, when the
 * store allows a decision, and for test fixtures without licence reads.
 */
export async function firstEnrollmentPrecheck(d: ComputeDeps, team: string): Promise<'backfill_pending' | 'bindings_overflow' | null> {
  if (!d.teamLicences) return null;
  return d.store.tx(async t => {
    if (await t.enrollment(team)) return null;
    if (!await backfillComplete(t)) return 'backfill_pending';
    return (await licenceRecord(t, team)).overflow ? 'bindings_overflow' : null;
  });
}

/** A record the gate cannot read inside its deadline is treated like an overflowed one: fail closed, page the operator. */
function recordTooLarge(d: ComputeDeps, team: string): ComputeError {
  d.log('alert_licence_bindings_overflow', { team });
  return new ComputeError(503, 'licence_bindings_overflow');
}
/** A licence read that failed or ran out of time: raise licence_read_failed and refuse with a retryable 503. */
function readFailed(d: ComputeDeps, team: string, err: unknown): ComputeError {
  d.log('licence_read_failed_reason', { team, reason: err instanceof Error ? err.message.slice(0, 80) : 'error' });
  d.log('alert_licence_read_failed', { team });
  return new ComputeError(503, 'license_verification_unavailable');
}

/** Reads `ids` by id, at most GATE_READ_CONCURRENCY at a time; no read starts once `stop.stopped` is set. */
async function readEach<T>(ids: readonly string[], read: (id: string) => Promise<T>, stop: { stopped: boolean },
  out: T[] = []): Promise<T[]> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length && !stop.stopped) {
      const i = next++;
      out[i] = await read(ids[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(GATE_READ_CONCURRENCY, ids.length) }, worker));
  return out;
}

const DEADLINE = new Error('licence_read_timeout');
/** Runs `reads` under one deadline (`ms` + 250, then it rejects with DEADLINE); once it has passed no read starts. */
async function underDeadline<T>(ms: number, reads: (stop: { stopped: boolean }) => Promise<T>): Promise<T> {
  const stop = { stopped: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([reads(stop), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(DEADLINE), ms + 250);
    })]);
  } finally {
    clearTimeout(timer);
    stop.stopped = true;
  }
}

const readById = (d: ComputeDeps, ms: number) => (id: string) =>
  d.licenceById ? d.licenceById(id, { timeout: ms }) : Promise.reject(new Error('licence_reads_unconfigured'));

/** The next pruning batch: up to MAX_GATE_READS ids after `cursor` in id order, wrapping to the start. */
export function pruneBatch(ids: readonly string[], cursor?: string): string[] {
  const sorted = [...ids].sort();
  const after = cursor === undefined ? sorted : sorted.filter(id => id > cursor);
  const head = after.slice(0, MAX_GATE_READS);
  return [...head, ...sorted.filter(id => !head.includes(id)).slice(0, MAX_GATE_READS - head.length)];
}

/**
 * A team's record holds more ids than one first enrollment may read (lane C round 13). One attempt reads one batch of
 * at most MAX_GATE_READS ids by id, from where the last attempt stopped, and drops, under the team lock, the ids whose
 * direct read shows a final status (ENDED_STATUSES); nothing else is ever dropped, so a live licence always stays.
 * While more than MAX_GATE_READS ids remain the answer is a retryable 503 licence_record_pruning (the next attempt goes
 * on, and once the record fits, the normal reads decide). If every remaining id has been read since the last drop and
 * more than MAX_GATE_READS are still live, not final or not found, the answer is licence_bindings_overflow with the alert.
 */
async function pruneRecordedLicences(d: ComputeDeps, team: string, record: LicenceRecord): Promise<never> {
  const batch = pruneBatch(record.ids, record.prune?.cursor);
  const ms = d.licenceReadMs ?? LICENCE_READ_MS, read = readById(d, ms);
  const subs: (SubscriptionLite | null)[] = [];
  try { await underDeadline(ms, stop => readEach(batch, read, stop, subs)); }
  catch (err) {
    // Slow, not failing (round 14): at the deadline the reads that finished still count. A read that failed, or a
    // deadline with nothing read, is the usual retryable read failure.
    if (err !== DEADLINE || !subs.some(sub => sub !== undefined)) throw readFailed(d, team, err);
  }
  const finished = [...subs]; // reads still in flight after the deadline are not used
  let prefix = 0;
  while (prefix < batch.length && finished[prefix] !== undefined) prefix++;
  // Every finished read showing a final status is dropped; the position only moves over the leading run of finished
  // reads, so an id not yet read is read by a later attempt.
  const ended = batch.filter((_, i) => { const sub = finished[i]; return sub != null && ENDED_STATUSES.has(sub.status); });
  const keptReads = batch.slice(0, prefix).filter((_, i) => !ended.includes(batch[i]!)).length;
  const after = await d.store.tx(async t => {
    await t.lockControl(`enrollment-chain:${team}`);
    return dropEndedBindings(t, team, ended, record.prune?.cursor, prefix > 0 ? batch[prefix - 1]! : record.prune?.cursor, keptReads);
  });
  d.log('licence_record_pruned', { team, read: prefix, dropped: ended.length, remaining: after.remaining });
  if (after.remaining > MAX_GATE_READS && after.kept >= after.remaining) throw recordTooLarge(d, team);
  throw new ComputeError(503, 'licence_record_pruning');
}

/**
 * Reads for a team's FIRST compute enrollment (lane C rounds 7 and 10), before the team lock: the recorded licence
 * bindings, each one's live state (by id: strongly consistent), and Stripe's metadata search, which can only add
 * licences, never remove one. `live` maps each live bound licence to the authority it names (null for none). A presenter
 * already proven by a licence's credentials needs no read. Each read has a real per-request timeout and the whole step
 * a deadline; any failure raises licence_read_failed and refuses with a retryable 503. At most MAX_GATE_READS licences
 * are read, GATE_READ_CONCURRENCY at a time (round 12). A larger record is pruned of ended licences first (round 13);
 * search results the search itself reports ended are final and skipped. Test fixtures without licence reads get
 * `unchecked`.
 */
export async function firstEnrollmentGate(d: ComputeDeps, team: string, licensed: boolean): Promise<FirstEnrollmentGate> {
  const record = await d.store.tx(async t => (await t.enrollment(team)) ? null : licenceRecord(t, team));
  if (record === null) return { kind: 'enrolled' };
  const recorded = record.ids;
  if (!d.teamLicences) return { kind: 'unchecked' };
  if (licensed) return { kind: 'gate', recorded: new Set(recorded), live: new Map() };
  if (recorded.length > MAX_GATE_READS) return pruneRecordedLicences(d, team, record);
  const ms = d.licenceReadMs ?? LICENCE_READ_MS, byId = readById(d, ms);
  let direct: readonly (SubscriptionLite | null)[];
  try {
    // The direct reads of recorded ids decide; an id only the search reports counts after its own direct read confirms
    // it (lane C round 11). The search runs under the same deadline as a whole (stripe.ts searchAllPages).
    direct = await underDeadline(ms, async stop => {
      const [bound, searched] = await Promise.all([readEach(recorded, byId, stop), d.teamLicences!(team, { timeout: ms })]);
      const known = new Set(recorded);
      const extra = [...new Set(searched.filter(sub => !ENDED_STATUSES.has(sub.status)).map(sub => sub.id).filter(id => !known.has(id)))];
      if (recorded.length + extra.length > MAX_GATE_READS) throw TOO_MANY;
      return [...bound, ...await readEach(extra, byId, stop)];
    });
  } catch (err) {
    throw err === TOO_MANY ? recordTooLarge(d, team) : readFailed(d, team, err);
  }
  const live = new Map<string, string | null>();
  for (const sub of direct) {
    if (sub && sub.metadata[TEAM_META] === team && !ENDED_STATUSES.has(sub.status))
      live.set(sub.id, sub.metadata[AUTHORITY_META] || null);
  }
  return { kind: 'gate', recorded: new Set(recorded), live };
}

/**
 * Under the team lock: why `owner` may not take the team's first enrollment, or null when it may. Every first enrollment
 * waits for the one-time backfill. A credentialed presenter is admitted. Otherwise, with no live licence (recorded or
 * found) the first valid presenter is admitted (trust on first use); a licence recorded since the reads counts, with no
 * authority known, so only its credentials admit; else the presenter must be an authority a live licence names.
 */
export async function firstEnrollmentRefusal(t: Tx, team: string, gate: FirstEnrollmentGate & { kind: 'gate' },
  owner: OwnershipProof, licensed: boolean): Promise<'backfill_pending' | 'bindings_overflow' | 'not_licence_authority' | null> {
  if (!await backfillComplete(t)) return 'backfill_pending';
  const record = await licenceRecord(t, team);
  if (record.overflow) return 'bindings_overflow'; // the record is incomplete for this team: fail closed
  if (licensed) return null;
  const sinceRead = record.ids.filter(id => !gate.recorded.has(id));
  if (gate.live.size === 0 && sinceRead.length === 0) return null;
  return [...gate.live.values()].includes(owner.key) ? null : 'not_licence_authority';
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
  if ((relation === 'extends' || prior?.key !== p.key) && await forkOpen(t, team))
    throw new ComputeError(403, 'team_ownership_required');
  const pinned = d.config.team_authorities[team];
  const oldKey = pinned ?? prior?.key;
  if ((pinned && !oldChain && pinned !== p.key) ||
      (oldKey && oldKey !== p.key && prior?.source !== 'tofu' && authority.depth <= (oldChain?.depth ?? 0) &&
        (pinned || !await recordedHead(t, team, prior?.key, oldChain, authority, p)))) {
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
