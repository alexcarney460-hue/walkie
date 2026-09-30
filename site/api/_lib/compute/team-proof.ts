import { deriveTeamId, nodeIdFromPubkey } from '../protocol/ids.js';
import { Event } from '../protocol/schemas.js';
import { verifyEvent, verifyHeader, isValidPubkey } from '../protocol/keys.js';
import { eventHeader } from '../protocol/header.js';
import { canonicalJson } from '../protocol/canonical.js';
import { createHash } from 'node:crypto';

export interface TeamProof { readonly genesis: unknown; readonly authority_chain?: unknown; readonly roster_events?: unknown }
export type StoredChain = { depth: number; chainId: string; chain?: string[] };
const eventDigest = (ev: Event): string => createHash('sha256').update(canonicalJson(ev)).digest('hex');
export function chainRelation(old: StoredChain, next: { chain: string[] }): 'equal' | 'extends' | 'older' | 'conflict' {
  const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!Number.isSafeInteger(old.depth) || old.depth < 0 || !Array.isArray(old.chain) ||
      old.chain.length !== old.depth + 1 || !old.chain.every(digest) || !digest(old.chainId) ||
      old.chain[old.depth] !== old.chainId || !Array.isArray(next.chain) || !next.chain.length ||
      !next.chain.every(digest)) return 'conflict';
  if (old.chain.slice(0, next.chain.length).some((hash, i) => next.chain[i] !== hash)) return 'conflict';
  if (next.chain.length < old.chain.length) return 'older';
  return next.chain.length === old.chain.length ? 'equal' : 'extends';
}

/** Validate the signed genesis and each authority handoff using the predecessor's key. */
export function teamAuthority(team: string, proof: TeamProof): { key: string; chainId: string; depth: number; chain: string[]; owners: string[] } | null {
  const parsed = Event.safeParse(proof.genesis);
  if (!parsed.success || parsed.data.kind !== 'team.create') return null;
  const genesis = parsed.data;
  const body = genesis.body;
  const founder = body.node_pubkey;
  if (typeof founder !== 'string' || !isValidPubkey(founder) || typeof body.name !== 'string' ||
      genesis.team !== team || team !== deriveTeamId(founder, body.name, genesis.ts) ||
      genesis.seq !== 1 || genesis.origin !== nodeIdFromPubkey(founder) || genesis.id !== `${genesis.origin}:1` ||
      genesis.author.node !== genesis.origin || genesis.author.handle !== body.owner_handle ||
      !verifyEvent(genesis, founder) || !verifyHeader(eventHeader(genesis), genesis.hsig, founder)) return null;
  const chain = proof.authority_chain ?? [];
  if (!Array.isArray(chain) || chain.length > 100) return null;
  const roster = proof.roster_events ?? [];
  if (!Array.isArray(roster) || roster.length > 500) return null;
  let key = founder;
  let last = eventDigest(genesis);
  const seen = new Set([genesis.id]);
  const seqs = new Map<string, number>([[genesis.origin, 1]]);
  const ids = [last];
  const members = new Map<string, string>([[body.owner_login as string, 'owner']]);
  const nodes = new Map<string, { login: string; key: string; revoked: boolean }>([[genesis.origin, { login: body.owner_login as string, key: founder, revoked: false }]]);
  const events: Event[] = [];
  for (const raw of roster) { const item = Event.safeParse(raw); if (!item.success) return null; events.push(item.data); }
  let at = 0;
  const accept = (ev: typeof genesis): boolean => {
    if (ev.team !== team || ev.origin !== nodeIdFromPubkey(key) || ev.seq <= (seqs.get(ev.origin) ?? 0) ||
        ev.id !== `${ev.origin}:${ev.seq}` ||
        ev.author.node !== ev.origin || seen.has(ev.id) || !verifyEvent(ev, key) ||
        !verifyHeader(eventHeader(ev), ev.hsig, key)) return false;
    seen.add(ev.id);
    seqs.set(ev.origin, ev.seq);
    if (ev.kind === 'team.member') {
      const b = ev.body as { login: string; role: string };
      members.set(b.login, b.role);
    } else if (ev.kind === 'team.node') {
      const b = ev.body as { node_id: string; login: string; pubkey: string; revoked?: boolean };
      if (b.node_id !== nodeIdFromPubkey(b.pubkey) || !isValidPubkey(b.pubkey) || !members.has(b.login)) return false;
      nodes.set(b.node_id, { login: b.login, key: b.pubkey, revoked: b.revoked === true });
    }
    else return false;
    return true;
  };
  for (const raw of chain) {
    while (at < events.length && events[at]!.kind !== 'team.authority') {
      if (!accept(events[at]!)) return null;
      at++;
    }
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as { event?: unknown; key?: unknown };
    const item = Event.safeParse(candidate.event);
    const next = candidate.key;
    if (!item.success || item.data.kind !== 'team.authority' || typeof next !== 'string' || !isValidPubkey(next)) return null;
    const ev = item.data;
    if (at >= events.length || events[at]!.id !== ev.id) return null;
    const node = ev.body.node_id as string;
    const target = nodes.get(node);
    if (!target || target.revoked || target.key !== next || members.get(target.login) !== 'owner' ||
        node === ev.origin || ev.team !== team || ev.origin !== nodeIdFromPubkey(key) ||
        ev.seq <= (seqs.get(ev.origin) ?? 0) || ev.id !== `${ev.origin}:${ev.seq}` ||
        ev.author.node !== ev.origin || node !== nodeIdFromPubkey(next) || seen.has(ev.id) ||
        !verifyEvent(ev, key) || !verifyHeader(eventHeader(ev), ev.hsig, key)) return null;
    key = next;
    last = eventDigest(ev);
    seen.add(ev.id);
    seqs.set(ev.origin, ev.seq);
    ids.push(last);
    at++;
  }
  while (at < events.length) { if (!accept(events[at]!)) return null; at++; }
  const owners = [...nodes.values()].filter(n => !n.revoked && members.get(n.login) === 'owner').map(n => n.key);
  return { key, chainId: last, depth: chain.length, chain: ids, owners: [...new Set(owners)] };
}
