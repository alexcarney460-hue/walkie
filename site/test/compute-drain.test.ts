// Go-live fix round, lane A (REVIEW-opus.md P1-2 / PROBE-1): the rollback lever. With COMPUTE_ENABLED unset but the
// private config and the store still present, compute drains: state, stop, heartbeat, the lease read, the tick's
// metering, stops and cleanup, the Stripe webhook and the watchdog heartbeat keep working; quotes are unavailable and
// rent, start and credit refuse. Running machines are never stranded.
import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import { codes, configJson, createAccount, fixtureTeam, fund, idem, MIN, world, type World } from './compute-helpers.ts';
import { rent } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { computeFromEnv, type HandlerDeps } from '../api/_lib/compute/handler.ts';
import type { CreditStripe } from '../api/_lib/compute/credit.ts';
import type { Rental } from '../api/_lib/compute/store.ts';
import { makeCredit } from '../api/compute/credit.ts';
import { makeHeartbeat } from '../api/compute/heartbeat.ts';
import { makeLease } from '../api/compute/lease.ts';
import { makeQuotes } from '../api/compute/quotes.ts';
import { makeRent } from '../api/compute/rent.ts';
import { makeStart } from '../api/compute/start.ts';
import { makeState } from '../api/compute/state.ts';
import { makeStop } from '../api/compute/stop.ts';
import { makeTick } from '../api/compute/tick.ts';
import { makeWatchdogHeartbeat } from '../api/compute/watchdog-heartbeat.ts';
import { makeComputeWebhook } from '../api/compute/webhook.ts';
import { RENTED_MACHINE_RELEASES } from '../api/_lib/compute/releases.ts';

const RELEASE = RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]!;

const CRON = 'cron-drain-test-secret-value';
const WH = 'whsec_compute_drain_test';
const HMAC = 'watchdog-drain-test-secret';

/** The deployment after the rollback: COMPUTE_ENABLED removed, everything else still configured. */
function drained(w: World): { env: Record<string, string>; deps: HandlerDeps; checkouts: unknown[] } {
  const env = { COMPUTE_PRIVATE_CONFIG: configJson({ cpu: 2, gpu: 16 }), DATABASE_URL: 'postgres://127.0.0.1:1/unused',
    COMPUTE_HANDOVER_TOKEN_KEY: 'rent-fixture-handover-key-32-bytes', CRON_SECRET: CRON,
    COMPUTE_STRIPE_WEBHOOK_SECRET: WH, COMPUTE_WATCHDOG_HMAC_SECRET: HMAC, SITE_URL: 'https://site.test' };
  const checkouts: unknown[] = [];
  const stripe: CreditStripe = { createCreditCheckout: async (p) => { checkouts.push(p); return { url: 'https://checkout.stripe.test/x' }; } };
  // computeFromEnv decides the mode; the world supplies its clock, FakeCloud and log.
  const deps: HandlerDeps = { env, stripe: () => stripe, alertStore: () => w.store, alertFetch: async () => Response.json({ ok: true }),
    compute: async () => { const base = await computeFromEnv(env, w.store); return base && { ...base, driver: w.d.driver, now: w.d.now, log: w.d.log }; } };
  return { env, deps, checkouts };
}
const req = (path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) =>
  new Request(`https://site.test${path}`, { method: body === undefined ? 'GET' : 'POST',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.7', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const rental = (w: World, id: string) => w.store.tx(async t => (await t.rental(id)) as Rental);

test('unsetting COMPUTE_ENABLED drains instead of stranding running machines', async () => {
  const w = world({ quotas: { cpu: 2, gpu: 16 } });
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 50_000_000);
  // Enabled: two machines start, a third waits in the queue for quota.
  const r = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 3 }],
    codes: codes(3, w.d.now()), walkie_version: RELEASE });
  const [first, second, third] = r.rentals.map(x => x.id) as [string, string, string];
  const token = (await w.store.tx(t => t.rental(second)))!.safety!.heartbeat_token!;
  await tick(w.d);
  for (const id of [first, second]) await w.store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
  expect((await rental(w, third)).state).toBe('queued');

  const { env, deps, checkouts } = drained(w);
  expect((await computeFromEnv(env, w.store))?.enabled).toBe(false);

  // Admissions refuse and write nothing.
  const rentals = (await w.store.tx(t => t.rentals(a.account_id))).length;
  const rentRes = await makeRent(deps)(req('/api/compute/rent', { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }],
    codes: codes(1, w.d.now()), walkie_version: RELEASE }, a.token));
  expect(rentRes.status).toBe(503);
  expect((await w.store.tx(t => t.rentals(a.account_id))).length).toBe(rentals);
  expect((await makeStart(deps)(req('/api/compute/start', { rental_id: third, code: codes(1, w.d.now())[0] }, a.token))).status).toBe(503);
  expect((await makeCredit(deps)(req('/api/compute/credit', { block: 50 }, a.token))).status).toBe(503);
  expect(checkouts).toEqual([]);
  expect((await (await makeQuotes(deps)(req('/api/compute/quotes'))).json() as { available: boolean }).available).toBe(false);

  // State and stop keep working: the customer can always stop what they pay for.
  const stateRes = await makeState(deps)(req('/api/compute/state', undefined, a.token));
  expect(stateRes.status).toBe(200);
  expect(((await stateRes.json()) as { rentals: unknown[] }).rentals).toHaveLength(3);
  const instance = (await rental(w, first)).instance_id!;
  const stopRes = await makeStop(deps)(req('/api/compute/stop', { rental_id: first }, a.token));
  expect(stopRes.status).toBe(200);
  expect((await rental(w, first)).state).toBe('ended');
  expect(w.cloud.state(instance)).toBe('terminated');

  // The machine heartbeats and reads its lease; the cron tick meters it and stops it when idle.
  const lease = await makeLease(deps)(req('/api/compute/lease', { rental_id: second }, token));
  expect(lease.status).toBe(200);
  const tickReq = () => new Request('https://site.test/api/compute/tick', { headers: { authorization: `Bearer ${CRON}` } });
  for (let i = 0; i < 31 && (await rental(w, second)).state === 'running'; i++) {
    w.advance(MIN);
    const hb = await makeHeartbeat(deps)(req('/api/compute/heartbeat', { rental_id: second, busy_seats: 0, pool_jobs: 0, cpu_pct: 3, egress_bytes: 0 }, token));
    expect(hb.status).toBe(200);
    expect((await makeTick(deps)(tickReq())).status).toBe(200);
  }
  const idle = await rental(w, second);
  expect(idle.state).toBe('ended');
  expect(idle.end_reason).toBe('idle');
  expect(idle.billed_minutes).toBeGreaterThanOrEqual(30);
  expect(w.cloud.state(idle.instance_id!)).toBe('terminated');
  // Quota freed, but nothing new launches while drained.
  expect((await rental(w, third)).state).toBe('queued');
  expect(w.cloud.provisions).toHaveLength(2);

  // Money events and the independent watchdog still land.
  const payload = JSON.stringify({ id: `evt_${idem()}`, type: 'checkout.session.completed', data: { object: { id: 'cs_test_drain',
    mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: 5000, payment_intent: 'pi_drain',
    metadata: { walkie_compute_account: a.account_id, walkie_credit_usd: '50' } } } });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: WH });
  const credited = await makeComputeWebhook(deps)(new Request('https://site.test/api/compute/webhook',
    { method: 'POST', body: payload, headers: { 'stripe-signature': signature } }));
  expect(credited.status).toBe(200);
  expect(((await credited.json()) as { outcome: string }).outcome).toBe('credited');
  const dispute = JSON.stringify({ id: `evt_${idem()}`, type: 'charge.dispute.created', data: { object: { id: 'dp_drain',
    charge: 'ch_drain', payment_intent: 'pi_drain' } } });
  const frozen = await makeComputeWebhook(deps)(new Request('https://site.test/api/compute/webhook', { method: 'POST', body: dispute,
    headers: { 'stripe-signature': await Stripe.webhooks.generateTestHeaderStringAsync({ payload: dispute, secret: WH }) } }));
  expect(frozen.status).toBe(200);
  expect(((await frozen.json()) as { outcome: string }).outcome).toBe('frozen');
  expect((await w.store.tx(t => t.lockAccount(a.account_id)))!.status).toBe('frozen');
  const ts = Date.now(), body = JSON.stringify({ ts });
  const watchdog = await makeWatchdogHeartbeat(deps)(new Request('https://site.test/api/compute/watchdog-heartbeat', { method: 'POST',
    body, headers: { 'content-type': 'application/json', 'x-walkie-signature': createHmac('sha256', HMAC).update(body).digest('hex') } }));
  expect(watchdog.status).toBe(200);
  expect(await w.store.tx(t => t.control('last_watchdog_heartbeat'))).toBe(ts);
});

// Round 2 (REVIEW-A-opus.md P2-1): an idle drain (nothing active, no cleanup) still records the tick's health, so /state
// shows no false tick_stale and no false Telegram alert fires between the lock flip and COMPUTE_ENABLED=1.
test('an idle drained tick records its health: state shows no tick_stale', async () => {
  const w = world();
  const a = await createAccount(w.d, fixtureTeam);
  const { deps } = drained(w);
  for (let i = 0; i < 10; i++) {
    w.advance(MIN);
    const res = await makeTick(deps)(new Request('https://site.test/api/compute/tick', { headers: { authorization: `Bearer ${CRON}` } }));
    expect(res.status).toBe(200);
  }
  expect(await w.store.tx(t => t.control('last_tick'))).toBe(w.d.now());
  const stateRes = await makeState(deps)(req('/api/compute/state', undefined, a.token));
  expect(stateRes.status).toBe(200);
  expect(((await stateRes.json()) as { alerts?: string[] }).alerts ?? []).not.toContain('tick_stale');
  expect(w.logs.some(x => x.event === 'alert_tick_stale')).toBe(false);
  // Still no provider work while idle and drained.
  expect(w.cloud.provisions).toHaveLength(0);
});
