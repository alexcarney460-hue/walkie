// Go-live builder G on a real Postgres (COMPUTE_TEST_DATABASE_URL: a throwaway database; skipped with a message without
// it). Tx.heldCreditHolds must list exactly what MemoryStore lists (held, numeric first_at at or before the cutoff, not
// marked alerted_at, oldest first, ties in key order, at most `limit`), and the confirmed-alert outbox must carry a
// failed money alert to delivery through the tick on PgStore, then mark the held checkout as alerted.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import Stripe from 'stripe';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import type { ComputeStore } from '../api/_lib/compute/store.ts';
import { makeComputeWebhook } from '../api/compute/webhook.ts';
import { makeTick } from '../api/compute/tick.ts';
import type { HandlerDeps } from '../api/_lib/compute/handler.ts';
import { createAccount, fixtureTeam, MIN, T0, world } from './compute-helpers.ts';

const url = process.env.COMPUTE_TEST_DATABASE_URL ?? null;
let sql: postgres.Sql | null = null;
beforeAll(() => { if (url) sql = postgres(url, { max: 10, onnotice: () => {} }); });
afterAll(async () => { await sql?.end({ timeout: 5 }); });

async function pg(): Promise<PgStore | null> {
  if (!sql) {
    process.stderr.write('compute-golive-g-pg: COMPUTE_TEST_DATABASE_URL unset; skipped\n');
    return null;
  }
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  const store = new PgStore(sql);
  await store.migrate();
  return store;
}

const ROWS: readonly [string, unknown][] = [
  ['compute-credit-hold:b', { state: 'held', first_at: T0 - 40 * MIN }],
  ['compute-credit-hold:a', { state: 'held', first_at: T0 - 40 * MIN }],
  ['compute-credit-hold:c', { state: 'held', first_at: T0 - 50 * MIN }],
  ['compute-credit-hold:d', { state: 'held', first_at: T0 - 10 * MIN }],
  ['compute-credit-hold:e', { state: 'refunded', first_at: T0 - 60 * MIN }],
  ['compute-credit-hold:f', { state: 'held', first_at: T0 - 60 * MIN, alerted_at: T0 - 59 * MIN }],
  ['compute-credit-hold:g', { state: 'held', first_at: 'not a number' }],
  ['compute-credit-hold:h', 'held'],
  ['compute-credit-hold:i', { state: 'held' }],
  ['compute-freeze-hold:z', { state: 'held', first_at: T0 - 60 * MIN }],
];

async function listed(store: ComputeStore, limit: number): Promise<string[]> {
  return (await store.tx(t => t.heldCreditHolds(T0 - 30 * MIN, limit))).map(r => r.key);
}

test('heldCreditHolds: PgStore lists exactly what MemoryStore lists', async () => {
  const store = await pg();
  if (!store) return;
  const memory = new MemoryStore();
  for (const s of [store, memory] as ComputeStore[]) await s.tx(async t => { for (const [k, v] of ROWS) await t.setControl(k, v); });
  const expected = ['compute-credit-hold:c', 'compute-credit-hold:a', 'compute-credit-hold:b'];
  expect(await listed(memory, 10)).toEqual(expected);
  expect(await listed(store, 10)).toEqual(expected);
  expect(await listed(store, 2)).toEqual(expected.slice(0, 2));
  expect(await listed(memory, 2)).toEqual(expected.slice(0, 2));
});

// Round 5 order: lowest numeric priority first (a row without one last), then oldest numeric first_at (a row without
// one last), then key; the due filter is next_at <= now.
const QUEUED: readonly [string, unknown][] = [
  ['alert:b', { pending: 1, event: 'authority_fork', fields: {}, first_at: 5, attempts: 1, next_at: T0 - 5 * MIN, priority: 1 }],
  ['alert:a', { pending: 1, event: 'authority_fork', fields: {}, first_at: 5, attempts: 1, next_at: T0 - 5 * MIN, priority: 1 }],
  ['alert:c', { pending: 1, event: 'credit_ignored', fields: {}, first_at: 9, attempts: 3, next_at: T0 - MIN, priority: 0 }],
  ['alert:j', { pending: 1, event: 'handover_expired', fields: {}, first_at: 2, attempts: 1, next_at: T0 - MIN, priority: 1 }],
  ['alert:k', { pending: 1, event: 'operator_funded', fields: {}, first_at: 1, attempts: 1, next_at: T0 - 9 * MIN }],
  ['alert:l', { pending: 1, event: 'operator_funded', fields: {}, attempts: 1, next_at: T0 - 9 * MIN, priority: 0 }],
  ['alert:m', { pending: 1, event: 'operator_funded', fields: {}, first_at: 3, attempts: 1, next_at: T0 - 9 * MIN, priority: 'high' }],
  ['alert:d', { pending: 1, event: 'credit_ignored', fields: {}, first_at: 1, attempts: 1, next_at: T0 + MIN, priority: 0 }],
  ['alert:e', T0 - 60 * MIN],
  ['alert:f', { pending: 1, event: 'credit_ignored', fields: {}, first_at: 1, attempts: 1, next_at: 'soon', priority: 0 }],
  ['alert:g', [{ next_at: 1 }]],
  ['alertx:h', { pending: 1, event: 'credit_ignored', fields: {}, first_at: 1, attempts: 1, next_at: 1, priority: 0 }],
  ['compute-credit-hold:i', { next_at: 1 }],
];

test('queuedAlerts: PgStore lists exactly what MemoryStore lists (objects only, due; priority, then oldest, then key)', async () => {
  const store = await pg();
  if (!store) return;
  const memory = new MemoryStore();
  for (const s of [store, memory] as ComputeStore[]) await s.tx(async t => { for (const [k, v] of QUEUED) await t.setControl(k, v); });
  // c: money (0), newest; l: money, no first_at. Then team-waiting (1) oldest first: j, then a/b tied (key order).
  // Then rows with no numeric priority (k, m: first_at 1 then 3).
  const expected = ['alert:c', 'alert:l', 'alert:j', 'alert:a', 'alert:b', 'alert:k', 'alert:m'];
  for (const s of [memory, store] as ComputeStore[]) {
    expect((await s.tx(t => t.queuedAlerts(T0, 10))).map(r => r.key)).toEqual(expected);
    expect((await s.tx(t => t.queuedAlerts(T0, 2))).map(r => r.key)).toEqual(expected.slice(0, 2));
    // d (money, first_at 1) becomes due and goes first: it is the oldest money alert.
    expect((await s.tx(t => t.queuedAlerts(T0 + 2 * MIN, 10))).map(r => r.key)).toEqual(['alert:d', ...expected]);
    // Round 6 minPriority band (alert-retry.ts's reserved slots): priority at least 1, or none; same order.
    expect((await s.tx(t => t.queuedAlerts(T0 + 2 * MIN, 10, 1))).map(r => r.key)).toEqual(['alert:j', 'alert:a', 'alert:b', 'alert:k', 'alert:m']);
    expect((await s.tx(t => t.queuedAlerts(T0, 3, 1))).map(r => r.key)).toEqual(['alert:j', 'alert:a', 'alert:b']);
  }
});

test('on PgStore: a held checkout alert that failed is delivered by the tick, and the hold is marked alerted', async () => {
  const store = await pg();
  if (!store) return;
  const WH = 'whsec_' + 'builder_g_pg_fixture', CRON = 'cron-' + 'builder-g-pg';
  const w = world({ store });
  await store.tx(t => t.setControl('last_tick', T0));
  const a = await createAccount(w.d, fixtureTeam);
  const tg = { up: false, delivered: [] as string[] };
  const deps: HandlerDeps = { env: { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixt' + 'ure-bot', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture-chat',
    COMPUTE_ENABLED: '1', COMPUTE_STRIPE_WEBHOOK_SECRET: WH, CRON_SECRET: CRON }, compute: () => w.d, stripe: () => null,
    alertFetch: async (_, init) => {
      if (!tg.up) return new Response('down', { status: 502 });
      tg.delivered.push(String(init?.body));
      return Response.json({ ok: true });
    } };
  const session = `cs_live_builderGpg${Date.now()}`;
  const event = { id: 'evt_builderGpg', object: 'event', type: 'checkout.session.completed', livemode: true, data: { object: {
    id: session, object: 'checkout.session', amount_total: 4_600, currency: 'eur', mode: 'payment', payment_status: 'paid',
    payment_intent: 'pi_builderGpg', client_reference_id: a.account_id, metadata: { walkie_compute_account: a.account_id, walkie_credit_usd: '50' } } } };
  const payload = JSON.stringify(event);
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: WH });
  const res = await makeComputeWebhook(deps)(new Request('https://site.test/api/compute/webhook', { method: 'POST', body: payload,
    headers: { 'stripe-signature': header } }));
  expect(res.status).toBe(200);
  const queued = await store.tx(t => t.queuedAlerts(w.d.now() + 86_400_000, 10));
  expect(queued.map(r => [(r.value as { event: string }).event, (r.value as { attempts: number }).attempts])).toEqual([['credit_ignored', 1]]);
  tg.up = true;
  const tickReq = () => new Request('https://site.test/api/compute/tick', { headers: { authorization: `Bearer ${CRON}` } });
  for (let i = 0; i < 3; i++) { w.advance(MIN); await makeTick(deps)(tickReq()); }
  const ignored = tg.delivered.filter(b => b.includes('credit_ignored'));
  expect(ignored).toHaveLength(1);
  expect(ignored[0]).toContain(session);
  expect(await store.tx(t => t.queuedAlerts(w.d.now() + 86_400_000, 10))).toEqual([]);
  for (let i = 0; i < 30; i++) { w.advance(MIN); await makeTick(deps)(tickReq()); }
  expect(tg.delivered.filter(b => b.includes('credit_ignored'))).toHaveLength(1);
  const hold = await store.tx(t => t.control(`compute-credit-hold:${session}`)) as { state: string; alerted_at?: number };
  expect(hold.state).toBe('held');
  expect(typeof hold.alerted_at).toBe('number');
  expect(await store.tx(t => t.heldCreditHolds(w.d.now(), 10))).toEqual([]);
}, 60_000);
