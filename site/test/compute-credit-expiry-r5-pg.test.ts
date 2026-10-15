// Lane H round 5 on a real Postgres (REVIEW-pre17d-opus.md P2-1, probe zz-heldlease; COMPUTE_TEST_DATABASE_URL: a
// throwaway database, schema reset per test; skipped with a message without it). Another session holds A's account row
// through A's lease end (minute 17), so the tick defers A's expiry. Whichever path then ends A (the owner's stop after
// the release, before the next tick; or a watchdog deletion recorded during the hold), A is billed only to the lease's
// end: 17 minutes = 212,500 micros (Opus measured 287,500 and 250,000 before the fix), the rest booked operator-funded
// with the alert.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import { rent as serviceRent, stop } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import type { Rental } from '../api/_lib/compute/store.ts';
import { createAccount, fixtureTeam, T0, world } from './compute-helpers.ts';
import { agentReq, MIN, secondTeam } from './compute-credit-expiry-helpers.ts';

const url = process.env.COMPUTE_TEST_DATABASE_URL ?? null;
let sql: postgres.Sql | null = null;
beforeAll(() => { if (url) sql = postgres(url, { max: 20, onnotice: () => {} }); });
afterAll(async () => { await sql?.end({ timeout: 5 }); });

async function pg(): Promise<PgStore | null> {
  if (!sql) {
    process.stderr.write('compute-credit-expiry-r5-pg: COMPUTE_TEST_DATABASE_URL unset; skipped\n');
    return null;
  }
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  const store = new PgStore(sql);
  await store.migrate();
  return store;
}
const BUDGET = { total: 12_000, cleanup: 4_000, call: 1_000 };

/** Holds a FOR UPDATE on one account row from another session until `release()`. */
async function hold(account: string): Promise<{ release(): Promise<void> }> {
  let locked!: () => void, free!: () => void;
  const isLocked = new Promise<void>(r => { locked = r; });
  const freed = new Promise<void>(r => { free = r; });
  const holder = sql!.begin(async tx => {
    const s = tx as unknown as postgres.Sql;
    await s`SELECT id FROM compute_accounts WHERE id = ${account} FOR UPDATE`;
    locked();
    await freed;
  });
  await isLocked;
  return { release: async () => { free(); await holder; } };
}

/** A and B each run one agent machine from minute 0; ticks at minutes 0-2 renew both leases (A's ends at minute 17). */
async function setup(store: PgStore) {
  const w = world({ store, quotas: { cpu: 8, gpu: 16 } });
  await store.tx(t => t.setControl('last_tick', T0));
  const a = (await createAccount(w.d, fixtureTeam)).account_id;
  await store.tx(t => t.addLedger({ account_id: a, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'r5-a', created_at: w.d.now() }));
  const b = await secondTeam(w.d, 'r5-b');
  await store.tx(t => t.addLedger({ account_id: b.id, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'r5-b', created_at: w.d.now() }));
  const ra = (await serviceRent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id;
  const rb = (await serviceRent(w.d, b.id, { ...agentReq(w.d.now()), codes: [b.code()] })).rentals[0]!.id;
  const rental = (id: string) => store.tx(async t => (await t.rental(id)) as Rental);
  const beat = async () => { for (const id of [ra, rb]) {
    const r = await rental(id);
    if (['starting', 'running'].includes(r.state))
      await store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
  } };
  await tick(w.d, BUDGET);
  await beat();
  for (let i = 0; i < 2; i++) { w.advance(MIN); await beat(); await tick(w.d, BUDGET); }
  expect((await rental(ra)).safety!.lease_until).toBe(T0 + 17 * MIN);
  return { w, a, ra, rental, beat };
}
const funded = (w: ReturnType<typeof world>, id: string) => w.logs.filter(l => l.event === 'alert_operator_funded' && l.fields.rental === id);

test('held through the lease end, then the owner stops A after the release (before the next tick): 212,500, not 287,500', async () => {
  const store = await pg();
  if (!store) return;
  const s = await setup(store);
  const held = await hold(s.a);
  for (let m = 18; m <= 22; m++) { s.w.clock.now = T0 + m * MIN; await s.beat(); await tick(s.w.d, BUDGET); }
  await held.release();
  expect(s.w.logs.filter(l => l.event === 'lease_expiry_deferred').length).toBeGreaterThan(0);
  s.w.advance(30_000); // half a minute after the release, before the next tick
  await stop(s.w.d, s.a, { rental_id: s.ra });
  const r = await s.rental(s.ra);
  expect([r.state, r.end_reason]).toEqual(['ended', 'user']);
  expect(r.charged_micros).toBe(212_500);
  expect(r.safety!.billing_until).toBe(T0 + 17 * MIN);
  expect(r.safety!.unpaid_micros).toBe(287_500 - 212_500);
  expect(funded(s.w, s.ra)).toHaveLength(1);
}, 60_000);

test('held through the lease end, a watchdog deletion recorded at minute 20 during the hold: 212,500, not 250,000', async () => {
  const store = await pg();
  if (!store) return;
  const s = await setup(store);
  const held = await hold(s.a);
  for (let m = 18; m <= 21; m++) {
    s.w.clock.now = T0 + m * MIN;
    if (m === 20) {
      // The independent watchdog deleted A's droplet now (its paid tag lapsed): the heartbeat route records it.
      const inst = (await s.rental(s.ra)).instance_id!;
      await store.tx(t => t.setControl('watchdog_deletions', { [inst]: s.w.d.now() }));
      await s.w.cloud.terminate(inst);
    }
    await s.beat();
    await tick(s.w.d, BUDGET);
  }
  await held.release();
  s.w.advance(MIN);
  await tick(s.w.d, BUDGET);
  const r = await s.rental(s.ra);
  expect([r.state, r.end_reason]).toEqual(['ended', 'watchdog_expired']);
  expect(r.charged_micros).toBe(212_500);
  expect(r.safety!.unpaid_micros).toBe(250_000 - 212_500);
  expect(funded(s.w, s.ra)).toHaveLength(1);
}, 60_000);
