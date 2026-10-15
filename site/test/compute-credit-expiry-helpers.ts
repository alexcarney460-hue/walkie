// Lane H (credit expiry, Alex 2026-10-09: non-refundable, expires 60 days after purchase): shared fixtures for the
// expiry tests. Lots are written straight to the ledger at a chosen credited time, as the webhook writes a purchase.
import { expect } from 'bun:test';
import { codes, createAccount, fixtureTeam, idem, MIN, rent, T0, world, type World } from './compute-helpers.ts';
import { generateKeys, signEvent } from '../../src/daemon/keys.ts';
import { createInvite } from '../../src/daemon/invite.ts';
import { deriveTeamId } from '../../src/protocol/ids.ts';
import { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
import { createAccount as enrollAccount } from '../api/_lib/compute/service.ts';
import { ownershipMessage } from '../api/_lib/compute/ownership.ts';
import type { ComputeDeps } from '../api/_lib/compute/deps.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import type { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import type { ComputeStore, LedgerEntry, Rental, Tx } from '../api/_lib/compute/store.ts';

export const DAY = 24 * 60 * MIN;
export const AGENT = 750_000; // the agent tier's price per hour

export async function account(w: World): Promise<string> {
  return (await createAccount(w.d, fixtureTeam)).account_id;
}

/** A credit lot: a purchase (or an operator adjustment) credited at `at`. Returns its id (the ledger idem_key). */
export async function buy(w: World, accountId: string, micros: number,
    opts: { at?: number; live?: boolean; kind?: 'purchase' | 'adjustment'; key?: string } = {}): Promise<string> {
  const key = opts.key ?? `test:${idem()}`;
  await w.store.tx(t => t.addLedger({ account_id: accountId, kind: opts.kind ?? 'purchase', amount_micros: micros, idem_key: key,
    live: opts.live, created_at: opts.at ?? w.d.now() }));
  return key;
}

export const ledger = (w: World, accountId?: string): readonly LedgerEntry[] =>
  (w.store as MemoryStore).ledger().filter(e => accountId === undefined || e.account_id === accountId);
export const sum = (es: readonly LedgerEntry[]): number => es.reduce((n, e) => n + e.amount_micros, 0);
export const expiries = (w: World, accountId: string) => ledger(w, accountId).filter(e => e.kind === 'expire');
/** What is left in a lot: its amount plus every row attributed to it (burns, refunds, expiries). */
export function lotLeft(w: World, lot: string): number {
  const own = ledger(w).find(e => e.idem_key === lot)!;
  return own.amount_micros + sum(ledger(w).filter(e => e.lot === lot));
}
export const rental = (w: World, id: string) => w.store.tx(async t => (await t.rental(id)) as Rental);

/** One agent machine, launched by the tick and reported running (idle stop far away). */
export async function runAgent(w: World, accountId: string): Promise<string> {
  const r = await rent(w.d, accountId, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }],
    codes: codes(1, w.d.now()), walkie_version: 'v0.2.0-pre.17', idle_minutes: 1440 });
  const id = r.rentals[0]!.id;
  await tick(w.d);
  await alive(w, id);
  return id;
}
export async function alive(w: World, id: string): Promise<void> {
  const r = await rental(w, id);
  if (r.state === 'starting' || r.state === 'running')
    await w.store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
}
/** `n` minute ticks, each after a heartbeat from every live machine in `ids`. */
export async function minutes(w: World, n: number, ids: readonly string[] = []): Promise<void> {
  for (let i = 0; i < n; i++) {
    for (const id of ids) await alive(w, id);
    w.advance(MIN);
    await tick(w.d);
  }
}
/** The tick has run recently (rent and start need a fresh tick). */
export async function jump(w: World, ms: number): Promise<void> {
  w.advance(ms);
  await tick(w.d);
}

/** Every lot's amount plus its attributed rows equals what it has left; the buckets add up to the ledger balance. */
export function expectReconciles(w: World, accountId: string, balance: number): void {
  const rows = ledger(w, accountId);
  const byKind = (k: LedgerEntry['kind']) => sum(rows.filter(e => e.kind === k));
  expect(byKind('purchase') + byKind('adjustment') + byKind('refund') + byKind('burn') + byKind('expire')).toBe(balance);
  for (const b of [true, false]) expect(sum(rows.filter(e => (e.live === true) === b))).toBeGreaterThanOrEqual(0);
}

export const agentReq = (now: number, count = 1) => ({ idempotency_key: idem(), machines: [{ tier: 'agent' as const, count }],
  codes: codes(count, now), walkie_version: 'v0.2.0-pre.17', idle_minutes: 1440 });

/**
 * The store, with `after(method, args)` run right after each Tx call returns: lets a test move the clock where a real
 * tick or request spends time (between a billing pass and the sweep, or in a lock wait). Round 2 (pre.17 reviews).
 */
export function hooked(store: ComputeStore, after: (method: string, args: readonly unknown[]) => void | Promise<void>): ComputeStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'tx') return <T,>(fn: (t: Tx) => Promise<T>, opts?: unknown) => (target.tx as (f: typeof fn, o?: unknown) => Promise<T>)(
        (t: Tx) => fn(new Proxy(t, { get(inner, p) {
          const v = (inner as unknown as Record<string | symbol, unknown>)[p];
          if (typeof v !== 'function') return v;
          return async (...args: unknown[]) => {
            const out = await (v as (...a: unknown[]) => unknown).apply(inner, args);
            await after(String(p), args); // a hook may wait (round 4: take a lock from another session mid-tick)
            return out;
          };
        } })), opts);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** A second team with its own founder, compute account and join codes (Opus's pre.17 probes). Round 3. */
export async function secondTeam(d: ComputeDeps, name = 'expiry-b'): Promise<{ id: string; code: () => string }> {
  const founder = generateKeys();
  const team = deriveTeamId(founder.pubkey, name, T0);
  const genesis = signEvent(founder, { v: PROTOCOL_VERSION, team, id: `${founder.nodeId}:1`, origin: founder.nodeId, seq: 1, ts: T0,
    author: { handle: 'bob', node: founder.nodeId }, kind: 'team.create', body: { name, owner_login: 'direct:bob', owner_handle: 'bob',
      node_hostname: 'b', node_pubkey: founder.pubkey, node_ip: '127.0.0.1' } });
  const expires = d.now() + 240_000;
  const acct = await enrollAccount(d, team, { key: founder.pubkey, expires_at: expires, signature: founder.sign(ownershipMessage(team, expires)), genesis });
  const code = () => createInvite(founder, { team, authority: founder.pubkey, handle: 'bob', role: 'member', now: d.now(), pos: 1, ttlMs: 3_600_000 }).code;
  return { id: acct.account_id, code };
}

/**
 * The store, except that locking an account `isHeld` names fails as a Postgres lock wait past its lock_timeout does
 * (55P03): a busy account, without real locks (round 3; shared since round 4).
 */
export function busyFor(store: ComputeStore, isHeld: (account: string) => boolean): ComputeStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'tx') return <R,>(fn: (t: Tx) => Promise<R>, opts?: unknown) => (target.tx as (f: typeof fn, o?: unknown) => Promise<R>)(
        (t: Tx) => fn(new Proxy(t, { get(inner, p) {
          const v = (inner as unknown as Record<string | symbol, unknown>)[p];
          if (p === 'lockAccount') return async (id: string) => {
            if (isHeld(id)) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
            return (v as (id: string) => unknown).call(inner, id);
          };
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(inner) : v;
        } })), opts);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export { world, MIN, idem, codes, tick };
