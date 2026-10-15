// Lane H round 3 on a real Postgres (REVIEW-pre17b-opus.md P2-1, REVIEW-pre17b-codex.md P2-1; COMPUTE_TEST_DATABASE_URL:
// a throwaway database, schema reset per test; skipped with a message without it). One customer must not be able to
// pause every team's launches or hold last_tick back:
// - an account whose row another session holds waits alone: the tick records last_tick and launches another team's
//   machine in the same tick, and the held account's own launch waits for the next one;
// - state() takes no row lock (a consistent read-only snapshot), so status requests cannot make an account busy;
// - Opus's flood probe (zz-busy-flood): concurrent state() loops while a tick runs leave the account not busy;
// - rent's wait for the shared capacity lock is bounded and answers a retryable 429 compute_busy, inserting nothing.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import { rent as serviceRent, state } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import type { Rental } from '../api/_lib/compute/store.ts';
import { createAccount, fixtureTeam, T0, world } from './compute-helpers.ts';
import { agentReq, codes, MIN, secondTeam } from './compute-credit-expiry-helpers.ts';

const url = process.env.COMPUTE_TEST_DATABASE_URL ?? null;
let sql: postgres.Sql | null = null;
beforeAll(() => { if (url) sql = postgres(url, { max: 60, onnotice: () => {} }); });
afterAll(async () => { await sql?.end({ timeout: 5 }); });

async function pg(): Promise<PgStore | null> {
  if (!sql) {
    process.stderr.write('compute-busy-flood-pg: COMPUTE_TEST_DATABASE_URL unset; skipped\n');
    return null;
  }
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  const store = new PgStore(sql);
  await store.migrate();
  return store;
}
const sleep = (ms: number) => new Promise<'hung'>(r => setTimeout(() => r('hung'), ms));
const CAPACITY_LOCK = 7_318_004_211; // pg-store.ts

/** Holds, from another session, a FOR UPDATE on an account row or the capacity advisory lock, until `release()`. */
async function hold(what: { account: string } | 'capacity'): Promise<{ release(): Promise<void> }> {
  let locked!: () => void, free!: () => void;
  const isLocked = new Promise<void>(r => { locked = r; });
  const freed = new Promise<void>(r => { free = r; });
  const holder = sql!.begin(async tx => {
    const s = tx as unknown as postgres.Sql;
    if (what === 'capacity') await s`SELECT pg_advisory_xact_lock(${CAPACITY_LOCK})`;
    else await s`SELECT id FROM compute_accounts WHERE id = ${what.account} FOR UPDATE`;
    locked();
    await freed;
  });
  await isLocked;
  return { release: async () => { free(); await holder; } };
}

/** Team A runs a machine and has a second one waiting to launch; team B has one waiting to launch. */
async function twoTeams(store: PgStore) {
  const w = world({ store, quotas: { cpu: 8, gpu: 16 } });
  await store.tx(t => t.setControl('last_tick', T0));
  const a = (await createAccount(w.d, fixtureTeam)).account_id;
  await store.tx(t => t.addLedger({ account_id: a, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'flood-a', created_at: w.d.now() }));
  const running = (await serviceRent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id;
  await tick(w.d);
  await store.tx(t => t.updateRental(running, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
  const b = await secondTeam(w.d, 'flood-b');
  await store.tx(t => t.addLedger({ account_id: b.id, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'flood-b', created_at: w.d.now() }));
  w.advance(61_000);
  await store.tx(t => t.setControl('last_tick', w.d.now() - 1_000));
  const aPending = (await serviceRent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id;
  const bPending = (await serviceRent(w.d, b.id, { ...agentReq(w.d.now()), codes: [b.code()] })).rentals[0]!.id;
  const rental = (id: string) => store.tx(async t => (await t.rental(id)) as Rental);
  return { w, a, b: b.id, running, aPending, bPending, rental };
}

test('an account whose row another session holds waits alone: last_tick is written and the other team launches', async () => {
  const store = await pg();
  if (!store) return;
  const s = await twoTeams(store);
  s.w.advance(MIN);
  const held = await hold({ account: s.a });
  const run = tick(s.w.d, { total: 12_000, cleanup: 4_000, call: 1_000 });
  const outcome = await Promise.race([run.then(() => 'done' as const), sleep(15_000)]);
  const lastTick = await store.tx(t => t.control('last_tick'));
  const bAfter = await s.rental(s.bPending), aAfter = await s.rental(s.aPending);
  await held.release();
  if (outcome === 'hung') await run.catch(() => undefined);
  expect(outcome).toBe('done');
  expect(lastTick).toBe(s.w.d.now());
  expect(bAfter.instance_id).not.toBeNull();
  expect([aAfter.instance_id, aAfter.safety?.claim]).toEqual([null, 'pending']);
  expect(s.w.logs.filter(l => l.event === 'compute_account_busy').map(l => l.fields.account)).toContain(s.a);
  // Released: the next tick launches A's machine too.
  s.w.advance(MIN);
  await tick(s.w.d);
  expect((await s.rental(s.aPending)).instance_id).not.toBeNull();
}, 60_000);

test('state() takes no row lock: it answers while another session holds the account row', async () => {
  const store = await pg();
  if (!store) return;
  const s = await twoTeams(store);
  const held = await hold({ account: s.a });
  try {
    const started = Date.now();
    const answer = await Promise.race([state(s.w.d, s.a), sleep(3_000)]);
    expect(answer).not.toBe('hung');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(answer !== 'hung' && answer.account_id).toBe(s.a);
  } finally { await held.release(); }
}, 60_000);

test('the flood probe: 50 concurrent state() loops during a tick leave the account not busy; the other team launches', async () => {
  const store = await pg();
  if (!store) return;
  const s = await twoTeams(store);
  let stop = false, calls = 0;
  const worker = async () => { while (!stop) { await state(s.w.d, s.a); calls++; } };
  const workers = Array.from({ length: 50 }, worker);
  await new Promise(r => setTimeout(r, 300));
  const before = s.w.logs.length;
  s.w.advance(MIN);
  await tick(s.w.d);
  stop = true;
  await Promise.all(workers);
  expect(calls).toBeGreaterThan(50);
  expect(s.w.logs.slice(before).filter(l => l.event === 'compute_account_busy')).toEqual([]);
  expect(await store.tx(t => t.control('last_tick'))).toBe(s.w.d.now());
  expect((await s.rental(s.bPending)).instance_id).not.toBeNull();
  expect((await s.rental(s.aPending)).instance_id).not.toBeNull();
}, 60_000);

test('rent waiting on a held capacity lock answers a retryable 429 compute_busy within its bound and inserts nothing', async () => {
  const store = await pg();
  if (!store) return;
  const s = await twoTeams(store);
  const req = { ...agentReq(s.w.d.now()), codes: codes(1, s.w.d.now()) };
  const held = await hold('capacity');
  let outcome: unknown;
  const started = Date.now();
  const run = serviceRent(s.w.d, s.a, req).catch((e: unknown) => e);
  try { outcome = await Promise.race([run, sleep(10_000)]); }
  finally { await held.release(); }
  if (outcome === 'hung') await run;
  // Round 4 (pre.17c review P2-1): a 429, so a client drops the refused request instead of resending it later.
  expect(outcome).toMatchObject({ status: 429, code: 'compute_busy', extra: { retry_after_s: 5 } });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(await store.tx(t => t.rentRequest(s.a, req.idempotency_key))).toBeNull();
  // Retried with the same key once the lock is free: accepted.
  expect((await serviceRent(s.w.d, s.a, req)).rentals).toHaveLength(1);
}, 60_000);
