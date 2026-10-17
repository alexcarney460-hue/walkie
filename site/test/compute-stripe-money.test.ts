// Stripe money events in the shapes Stripe actually sends (go-live fix round, lane B).
// C P1-1: radar.early_fraud_warning.created carries `charge` and only optionally `payment_intent`; Stripe's own API
// reference examples of a Dispute and a Charge carry `payment_intent: null`. Each must still freeze the purchase it is
// about, resolved through the charge. One that cannot be resolved yet is held durably, alerted and answered non-2xx so
// Stripe retries the delivery.
// O P2: a PAID compute checkout that fails validation is held for the operator and alerted, never acknowledged
// silently. Sessions are created with Adaptive Pricing off, and the compute client pins its Stripe API version.
import { describe, expect, test } from 'bun:test';
import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import {
  applyCreditEvent, COMPUTE_STRIPE_API_VERSION, computeStripeConfig, creditSessionParams, FreezeUnresolved, realCreditStripe, type StripeEvent,
} from '../api/_lib/compute/credit.ts';
import { makeComputeWebhook } from '../api/compute/webhook.ts';
import { makeTick } from '../api/compute/tick.ts';
import { rent, state } from '../api/_lib/compute/service.ts';
import type { HandlerDeps } from '../api/_lib/compute/handler.ts';
import { codes, createAccount, fixtureTeam, idem, world } from './compute-helpers.ts';
import { alertFromLog, sendAlert } from '../api/_lib/compute/alerts.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';

const WH = 'whsec_' + 'lane_b_fixture_secret';
const CRON = 'cron-' + 'lane-b-fixture';
const TG = { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixt' + 'ure-bot', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture-chat' };
const CREATED = 1_790_000_000;
const hex = () => randomBytes(12).toString('hex');

// The event envelope and objects as Stripe's API reference shows them (fields Stripe always sends; nothing synthetic).
const envelope = (type: string, object: Record<string, unknown>): StripeEvent => ({
  id: `evt_${hex()}`, object: 'event', api_version: '2026-08-26.dahlia', created: CREATED, livemode: true,
  pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object },
} as StripeEvent);
const earlyFraudWarning = (charge: string, pi?: string) => ({
  id: `issfr_${hex()}`, object: 'radar.early_fraud_warning', actionable: true, charge, created: CREATED,
  fraud_type: 'made_with_stolen_card', livemode: true, ...(pi ? { payment_intent: pi } : {}),
});
const dispute = (charge: string, pi: string | null) => ({
  id: `du_${hex()}`, object: 'dispute', amount: 5000, balance_transactions: [], charge, created: CREATED, currency: 'usd',
  evidence_details: { due_by: CREATED + 864_000, has_evidence: false, past_due: false, submission_count: 0 },
  is_charge_refundable: true, livemode: true, metadata: {}, payment_intent: pi, reason: 'fraudulent', status: 'warning_needs_response',
});
const refundedCharge = (id: string, pi: string | null) => ({
  id, object: 'charge', amount: 5000, amount_captured: 5000, amount_refunded: 5000, captured: true, created: CREATED,
  currency: 'usd', disputed: false, livemode: true, metadata: {}, paid: true, payment_intent: pi, refunded: true, status: 'succeeded',
});
const session = (account: string, pi: string | null, over: Record<string, unknown> = {}) => ({
  id: `cs_live_${hex()}`, object: 'checkout.session', adaptive_pricing: { enabled: false }, amount_subtotal: 5000,
  amount_total: 5000, client_reference_id: account, created: CREATED, currency: 'usd', livemode: true, mode: 'payment',
  payment_intent: pi, payment_status: 'paid', status: 'complete',
  metadata: { walkie_compute_account: account, walkie_credit_usd: '50' }, ...over,
});

const without = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
/** A charge lookup like the real one: known charges answer, an unknown one is Stripe being unreachable. */
const lookup = (known: Record<string, string | null>, calls: string[] = []) => ({
  async paymentIntentOfCharge(charge: string) {
    calls.push(charge);
    if (!(charge in known)) throw new Error('stripe unreachable');
    return known[charge] ?? null;
  },
});
const freezeHold = (w: ReturnType<typeof world>, charge: string) => w.store.tx(t => t.control(`compute-freeze-hold:${charge}`));
const creditHold = (w: ReturnType<typeof world>, id: string) => w.store.tx(t => t.control(`compute-credit-hold:${id}`));
const alerts = (w: ReturnType<typeof world>, event: string) => w.logs.filter(l => l.event === `alert_${event}`);

async function funded() {
  const w = world();
  const a = await createAccount(w.d, fixtureTeam);
  const pi = `pi_${hex()}`, charge = `ch_${hex()}`;
  expect(await applyCreditEvent(w.d, envelope('checkout.session.completed', session(a.account_id, pi)))).toBe('credited');
  return { w, account: a.account_id, token: a.token, pi, charge };
}

async function signed(event: unknown): Promise<Request> {
  const payload = JSON.stringify(event);
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: WH });
  return new Request('https://site.test/api/compute/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': header } });
}

describe('C P1-1: fraud warnings, disputes and refunds resolve through the charge', () => {
  test('an early fraud warning without payment_intent freezes the purchase on its charge', async () => {
    const f = await funded(), calls: string[] = [];
    const ev = envelope('radar.early_fraud_warning.created', earlyFraudWarning(f.charge));
    expect(await applyCreditEvent(f.w.d, ev, lookup({ [f.charge]: f.pi }, calls))).toBe('frozen');
    expect(calls).toEqual([f.charge]);
    expect((await state(f.w.d, f.account)).status).toBe('frozen');
  });

  test('a dispute and a refund whose payload omits payment_intent freeze through the charge', async () => {
    for (const make of [(c: string) => envelope('charge.dispute.created', without(dispute(c, null), 'payment_intent')),
      (c: string) => envelope('charge.refunded', without(refundedCharge(c, null), 'payment_intent'))]) {
      const f = await funded(), calls: string[] = [];
      expect(await applyCreditEvent(f.w.d, make(f.charge), lookup({ [f.charge]: f.pi }, calls))).toBe('frozen');
      expect(calls).toEqual([f.charge]);
      expect((await state(f.w.d, f.account)).status).toBe('frozen');
    }
  });

  test('events that already carry payment_intent freeze without calling Stripe', async () => {
    for (const make of [(c: string, pi: string) => envelope('radar.early_fraud_warning.created', earlyFraudWarning(c, pi)),
      (c: string, pi: string) => envelope('charge.dispute.created', dispute(c, pi)),
      (c: string, pi: string) => envelope('charge.refunded', refundedCharge(c, pi))]) {
      const f = await funded(), calls: string[] = [];
      expect(await applyCreditEvent(f.w.d, make(f.charge, f.pi), lookup({}, calls))).toBe('frozen');
      expect(calls).toEqual([]);
      expect((await state(f.w.d, f.account)).status).toBe('frozen');
    }
  });

  test('a charge-only warning that arrives before the purchase still freezes the later credit', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    const pi = `pi_${hex()}`, charge = `ch_${hex()}`;
    expect(await applyCreditEvent(w.d, envelope('radar.early_fraud_warning.created', earlyFraudWarning(charge)),
      lookup({ [charge]: pi }))).toBe('frozen');
    await applyCreditEvent(w.d, envelope('checkout.session.completed', session(a.account_id, pi)));
    expect((await state(w.d, a.account_id)).status).toBe('frozen');
  });

  test('an unresolvable warning is held durably, alerted and refused so Stripe retries; the retry freezes', async () => {
    for (const unavailable of [undefined, null, lookup({})]) {
      const f = await funded();
      const ev = envelope('radar.early_fraud_warning.created', earlyFraudWarning(f.charge));
      await expect(applyCreditEvent(f.w.d, ev, unavailable)).rejects.toThrow();
      expect(await freezeHold(f.w, f.charge)).toMatchObject({ charge: f.charge, state: 'pending', event: ev.type, event_id: ev.id });
      expect(alerts(f.w, 'freeze_unresolved').map(l => l.fields)).toEqual([
        { event: ev.type, charge: f.charge, reason: 'lookup_failed' }]);
      expect((await state(f.w.d, f.account)).status).toBe('active');
      expect(await applyCreditEvent(f.w.d, ev, lookup({ [f.charge]: f.pi }))).toBe('frozen');
      expect(await freezeHold(f.w, f.charge)).toMatchObject({ state: 'resolved', payment_intent: f.pi });
      expect((await state(f.w.d, f.account)).status).toBe('frozen');
    }
  });

  test('a charge Stripe reports without a PaymentIntent is held as unmatched and acknowledged', async () => {
    const f = await funded();
    const ev = envelope('radar.early_fraud_warning.created', earlyFraudWarning(f.charge));
    expect(await applyCreditEvent(f.w.d, ev, lookup({ [f.charge]: null }))).toBe('unmatched');
    expect(await freezeHold(f.w, f.charge)).toMatchObject({ charge: f.charge, state: 'unmatched' });
    expect(alerts(f.w, 'freeze_unresolved').map(l => l.fields.reason)).toEqual(['no_payment_intent']);
    expect((await state(f.w.d, f.account)).status).toBe('active');
  });

  test('over HTTP: a signed charge-only warning answers 503 and pages the operator, the retry freezes and the tick stops machines', async () => {
    const f = await funded();
    await rent(f.w.d, f.account, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }], codes: codes(1), walkie_version: 'v0.2.0-pre.7' });
    const sent: string[] = [];
    const base = { env: { ...TG, COMPUTE_ENABLED: '1', COMPUTE_STRIPE_WEBHOOK_SECRET: WH, CRON_SECRET: CRON }, compute: () => f.w.d,
      alertFetch: async (_: string, init?: RequestInit) => { sent.push(String(init?.body)); return Response.json({ ok: true }); } };
    const offline: HandlerDeps = { ...base, stripe: () => ({ createCreditCheckout: async () => ({ url: null }), ...lookup({}) }) };
    const online: HandlerDeps = { ...base, stripe: () => ({ createCreditCheckout: async () => ({ url: null }), ...lookup({ [f.charge]: f.pi }) }) };
    const ev = envelope('radar.early_fraud_warning.created', earlyFraudWarning(f.charge));
    const first = await makeComputeWebhook(offline)(await signed(ev));
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'freeze_unresolved' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('freeze_unresolved');
    expect(sent[0]).toContain(f.charge);
    const retry = await makeComputeWebhook(online)(await signed(ev));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ received: true, outcome: 'frozen' });
    const tick = await makeTick(online)(new Request('https://site.test/api/compute/tick', { headers: { authorization: `Bearer ${CRON}` } }));
    expect(await tick.json()).toMatchObject({ stopped: { frozen: 1 } });
  });
});

describe('O P2: paid compute checkouts that fail validation are held and alerted', () => {
  test('a paid checkout charged in another currency (Adaptive Pricing) is held for the operator, not credited', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    const pi = `pi_${hex()}`;
    const s = session(a.account_id, pi, { currency: 'eur', amount_total: 4_600, amount_subtotal: 4_600,
      currency_conversion: { amount_subtotal: 5_000, amount_total: 5_000, fx_rate: '0.92', source_currency: 'usd' } });
    const ev = envelope('checkout.session.completed', s);
    expect(await applyCreditEvent(w.d, ev)).toBe('ignored');
    expect(await w.store.tx(t => t.balance(a.account_id))).toBe(0);
    expect(await creditHold(w, s.id)).toMatchObject({ session: s.id, event_id: ev.id, reason: 'currency', account: a.account_id,
      payment_intent: pi, currency: 'eur', amount_total: 4_600, livemode: true });
    expect(alerts(w, 'credit_ignored').map(l => l.fields)).toEqual([{ account: a.account_id, session: s.id, reason: 'currency' }]);
  });

  test('every paid-but-invalid compute checkout is held with its reason', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    const cases: [Record<string, unknown>, string][] = [
      [session(a.account_id, `pi_${hex()}`, { amount_total: 100 }), 'amount'],
      [session('ca_ffffffffffffffff', `pi_${hex()}`, { metadata: { walkie_compute_account: 'ca_ffffffffffffffff', walkie_credit_usd: '50' } }), 'unknown_account'],
      [session(a.account_id, `pi_${hex()}`, { metadata: { walkie_compute_account: a.account_id, walkie_credit_usd: '75' } }), 'metadata'],
      [session(a.account_id, null), 'no_payment_intent'],
    ];
    for (const [s, reason] of cases) {
      expect(await applyCreditEvent(w.d, envelope('checkout.session.completed', s))).toBe('ignored');
      expect(await creditHold(w, s.id as string)).toMatchObject({ session: s.id, reason });
    }
    expect(alerts(w, 'credit_ignored').map(l => l.fields.reason)).toEqual(['amount', 'unknown_account', 'metadata', 'no_payment_intent']);
    expect(await w.store.tx(t => t.balance(a.account_id))).toBe(0);
  });

  test('license and other non-compute checkouts, and unpaid async ones, stay silent', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    const license = { id: `cs_live_${hex()}`, object: 'checkout.session', amount_total: 900, currency: 'usd', livemode: true,
      mode: 'subscription', payment_status: 'paid', status: 'complete', subscription: `sub_${hex()}`, metadata: { walkie_team: fixtureTeam } };
    expect(await applyCreditEvent(w.d, envelope('checkout.session.completed', license))).toBe('ignored');
    expect(await creditHold(w, license.id)).toBeUndefined();
    const pi = `pi_${hex()}`;
    const pending = session(a.account_id, pi, { payment_status: 'unpaid' });
    expect(await applyCreditEvent(w.d, envelope('checkout.session.completed', pending))).toBe('ignored');
    expect(await creditHold(w, pending.id)).toBeUndefined();
    expect(alerts(w, 'credit_ignored')).toEqual([]);
    expect(await applyCreditEvent(w.d, envelope('checkout.session.async_payment_succeeded', { ...pending, payment_status: 'paid' }))).toBe('credited');
    expect(await w.store.tx(t => t.balance(a.account_id))).toBe(50_000_000);
  });

  test('a held paid checkout reaches the operator over Telegram through the webhook', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    const s = session(a.account_id, `pi_${hex()}`, { currency: 'eur', amount_total: 4_600 });
    const sent: string[] = [];
    const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', COMPUTE_STRIPE_WEBHOOK_SECRET: WH }, compute: () => w.d, stripe: () => null,
      alertFetch: async (_, init) => { sent.push(String(init?.body)); return Response.json({ ok: true }); } };
    const res = await makeComputeWebhook(deps)(await signed(envelope('checkout.session.completed', s)));
    expect(await res.json()).toEqual({ received: true, outcome: 'ignored' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('credit_ignored');
    expect(sent[0]).toContain(s.id);
    expect(sent[0]).toContain('currency');
  });

  test('money alerts still reach the operator when compute runs without COMPUTE_ENABLED=1 (drain)', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    const sent: string[] = [];
    const deps: HandlerDeps = { env: { ...TG, COMPUTE_STRIPE_WEBHOOK_SECRET: WH }, compute: () => ({ ...w.d, enabled: false }),
      stripe: () => null, alertFetch: async (_, init) => { sent.push(String(init?.body)); return Response.json({ ok: true }); } };
    const s = session(a.account_id, `pi_${hex()}`, { amount_total: 100 });
    expect((await makeComputeWebhook(deps)(await signed(envelope('checkout.session.completed', s)))).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('credit_ignored');
  });

  test('credit sessions are created with Adaptive Pricing off', () => {
    const p = creditSessionParams({ accountId: 'ca_0123456789abcdef', block: 50, successUrl: 'https://site.test/ok', cancelUrl: 'https://site.test/no' });
    expect(p.adaptive_pricing).toEqual({ enabled: false });
    expect(p.line_items?.[0]?.price_data?.currency).toBe('usd');
    // Lane H: the page states the credit terms before payment (full pin in compute-credit-expiry.test.ts).
    expect(p.line_items?.[0]?.price_data?.product_data?.description).toContain('Non-refundable. Expires 60 days after purchase.');
    expect((p.custom_text?.submit as { message?: string } | undefined)?.message).toContain('unused credit expires 60 days after purchase');
  });
});

describe('the compute Stripe client', () => {
  /** Stripe's own fetch HTTP client over a recorded fake: no network. */
  function recorded(reply: (url: string) => Response) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return reply(String(url));
    }) as unknown as typeof fetch;
    return { calls, client: Stripe.createFetchHttpClient(fetchFn) };
  }

  test('pins its Stripe API version on every request', async () => {
    expect(COMPUTE_STRIPE_API_VERSION).toBe('2026-08-26.dahlia');
    expect(computeStripeConfig().apiVersion).toBe(COMPUTE_STRIPE_API_VERSION);
    const r = recorded(() => Response.json({ id: 'ch_1', object: 'charge', payment_intent: 'pi_1' }));
    await realCreditStripe('sk_test_' + 'fixture', r.client).paymentIntentOfCharge!('ch_1');
    expect(r.calls[0]?.headers['stripe-version']).toBe(COMPUTE_STRIPE_API_VERSION);
  });

  test('looks a charge up once: its PaymentIntent, null only when Stripe says it has none, an error otherwise', async () => {
    const answers: Record<string, () => Response> = {
      ch_pi: () => Response.json({ id: 'ch_pi', object: 'charge', payment_intent: 'pi_found' }),
      ch_expanded: () => Response.json({ id: 'ch_expanded', object: 'charge', payment_intent: { id: 'pi_expanded', object: 'payment_intent' } }),
      ch_none: () => Response.json({ id: 'ch_none', object: 'charge', payment_intent: null }),
      ch_gone: () => Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such charge' } }, { status: 404 }),
      ch_down: () => Response.json({ error: { type: 'api_error', message: 'fixture outage' } }, { status: 500 }),
    };
    const r = recorded(url => answers[/\/v1\/charges\/([A-Za-z_]+)/.exec(url)![1]!]!());
    const s = realCreditStripe('sk_test_' + 'fixture', r.client);
    expect(await s.paymentIntentOfCharge!('ch_pi')).toBe('pi_found');
    expect(await s.paymentIntentOfCharge!('ch_expanded')).toBe('pi_expanded');
    expect(await s.paymentIntentOfCharge!('ch_none')).toBeNull();
    // No such charge means a key/mode mismatch, never a definitive answer: the event stays held and Stripe retries.
    await expect(s.paymentIntentOfCharge!('ch_gone')).rejects.toThrow();
    await expect(s.paymentIntentOfCharge!('ch_down')).rejects.toThrow();
    expect(r.calls.map(c => c.url.replace(/^https:\/\/api\.stripe\.com/, ''))).toEqual(
      ['/v1/charges/ch_pi', '/v1/charges/ch_expanded', '/v1/charges/ch_none', '/v1/charges/ch_gone', '/v1/charges/ch_down']);
  });
});

describe('round 2 (lane B reviews)', () => {
  test('Codex P2-1: a paid session naming a compute account only in client_reference_id is held and alerted', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    const empty = session(a.account_id, `pi_${hex()}`, { metadata: {} });
    const missing = without(session(a.account_id, `pi_${hex()}`), 'metadata');
    for (const s of [empty, missing]) {
      expect(await applyCreditEvent(w.d, envelope('checkout.session.completed', s))).toBe('ignored');
      expect(await creditHold(w, s.id as string)).toMatchObject({ session: s.id, reason: 'metadata', account: a.account_id,
        client_reference_id: a.account_id, state: 'held' });
    }
    expect(alerts(w, 'credit_ignored').map(l => l.fields)).toEqual([
      { account: a.account_id, session: empty.id, reason: 'metadata' }, { account: a.account_id, session: missing.id, reason: 'metadata' }]);
    // Not a compute reference: a checkout of another product with no compute metadata stays silent.
    const other = without(session(a.account_id, `pi_${hex()}`, { client_reference_id: 'order-1234' }), 'metadata');
    expect(await applyCreditEvent(w.d, envelope('checkout.session.completed', other))).toBe('ignored');
    expect(await creditHold(w, other.id as string)).toBeUndefined();
    expect(await w.store.tx(t => t.balance(a.account_id))).toBe(0);
  });

  test('Codex P2-2: a freeze event with no payment intent and no charge is held by event id and refused, over HTTP and on redelivery', async () => {
    const w = world();
    const sent: string[] = [];
    const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', COMPUTE_STRIPE_WEBHOOK_SECRET: WH }, compute: () => w.d,
      stripe: () => ({ createCreditCheckout: async () => ({ url: null }), ...lookup({}) }),
      alertFetch: async (_, init) => { sent.push(String(init?.body)); return Response.json({ ok: true }); } };
    const ev = envelope('radar.early_fraud_warning.created', { id: `issfr_${hex()}`, object: 'radar.early_fraud_warning', livemode: true });
    await expect(applyCreditEvent(w.d, ev)).rejects.toBeInstanceOf(FreezeUnresolved);
    for (let delivery = 0; delivery < 2; delivery++) {
      const res = await makeComputeWebhook(deps)(await signed(ev));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'freeze_unresolved' });
    }
    expect(await freezeHold(w, ev.id)).toMatchObject({ state: 'pending', reason: 'no_reference', event: ev.type, event_id: ev.id, attempts: 3 });
    // One alert log per delivery (the webhook's sendAlert logs each one a second time through the same logger).
    const logged = alerts(w, 'freeze_unresolved').map(l => l.fields);
    expect(logged.length).toBeGreaterThanOrEqual(3);
    for (const fields of logged) expect(fields).toEqual({ event: ev.type, event_id: ev.id, reason: 'no_reference' });
    expect(sent).toHaveLength(1); // deduped per event for 30 minutes
    expect(sent[0]).toContain(ev.id);
  });

  test('Opus P3-1: a resolved charge is reused, so a later charge-only event never falls back to pending', async () => {
    // Probe 1: resolved after a failed lookup, then a dispute without payment_intent while Stripe is down.
    const f = await funded(), calls: string[] = [];
    const efw = envelope('radar.early_fraud_warning.created', earlyFraudWarning(f.charge));
    await expect(applyCreditEvent(f.w.d, efw, lookup({}))).rejects.toBeInstanceOf(FreezeUnresolved);
    expect(await applyCreditEvent(f.w.d, efw, lookup({ [f.charge]: f.pi }))).toBe('frozen');
    const later = envelope('charge.dispute.created', without(dispute(f.charge, null), 'payment_intent'));
    expect(await applyCreditEvent(f.w.d, later, lookup({}, calls))).toBe('frozen');
    expect(calls).toEqual([]);
    expect(await freezeHold(f.w, f.charge)).toMatchObject({ state: 'resolved', payment_intent: f.pi });
    // Probe 3: a dispute that carries payment_intent first, then a charge-only warning while Stripe is down.
    const g = await funded(), callsG: string[] = [];
    expect(await applyCreditEvent(g.w.d, envelope('charge.dispute.created', dispute(g.charge, g.pi)), lookup({}))).toBe('frozen');
    expect(await applyCreditEvent(g.w.d, envelope('radar.early_fraud_warning.created', earlyFraudWarning(g.charge)), lookup({}, callsG))).toBe('frozen');
    expect(callsG).toEqual([]);
    expect(await freezeHold(g.w, g.charge)).toMatchObject({ state: 'resolved', payment_intent: g.pi });
    expect(alerts(g.w, 'freeze_unresolved')).toEqual([]);
  });

  test('Opus P3-2: an explicit payment_intent null on a Charge or Dispute is unmatched without a Stripe read', async () => {
    for (const make of [(c: string) => envelope('charge.dispute.created', dispute(c, null)),
      (c: string) => envelope('charge.refunded', refundedCharge(c, null))]) {
      const f = await funded(), calls: string[] = [];
      expect(await applyCreditEvent(f.w.d, make(f.charge), lookup({}, calls))).toBe('unmatched');
      expect(calls).toEqual([]);
      expect(await freezeHold(f.w, f.charge)).toMatchObject({ state: 'unmatched', reason: 'no_payment_intent' });
      expect((await state(f.w.d, f.account)).status).toBe('active');
    }
  });

  test('Opus P3-3: refunding a held checkout marks the hold refunded, with no account_frozen alert', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    const pi = `pi_${hex()}`, charge = `ch_${hex()}`;
    const s = session(a.account_id, pi, { currency: 'eur', amount_total: 4_600 });
    await applyCreditEvent(w.d, envelope('checkout.session.completed', s));
    expect(await creditHold(w, s.id)).toMatchObject({ state: 'held' });
    expect(await applyCreditEvent(w.d, envelope('charge.refunded', refundedCharge(charge, pi)))).toBe('frozen');
    expect(await creditHold(w, s.id)).toMatchObject({ state: 'refunded', freeze_event: 'charge.refunded' });
    expect(alerts(w, 'account_frozen')).toEqual([]);
    expect(w.logs.some(l => l.event === 'credit_hold_refunded' && l.fields.session === s.id)).toBe(true);
    // A redelivered checkout event keeps the handled state.
    await applyCreditEvent(w.d, envelope('checkout.session.completed', s));
    expect(await creditHold(w, s.id)).toMatchObject({ state: 'refunded', deliveries: 2 });
    expect((await state(w.d, a.account_id)).status).toBe('active');
  });

  test('Opus P3-5: the alert de-duplication key keeps charges, sessions and events apart', async () => {
    const store = new MemoryStore(), sent: string[] = [];
    const d = { store, env: TG, now: () => 1_000, log: () => {}, fetch: async (_: string, init?: RequestInit) => {
      sent.push(String(init?.body)); return Response.json({ ok: true }); } };
    const efw = 'radar.early_fraud_warning.created';
    for (const charge of ['ch_DedupeA', 'ch_DedupeB', 'ch_DedupeA'])
      await sendAlert(d, 'freeze_unresolved', { event: efw, charge, reason: 'lookup_failed' });
    expect(sent).toHaveLength(2);
    for (const session of ['cs_live_DedupeA', 'cs_live_DedupeB', 'cs_live_DedupeA'])
      await sendAlert(d, 'credit_ignored', { account: 'ca_0123456789abcdef', session, reason: 'currency' });
    expect(sent).toHaveLength(4);
    for (const event_id of ['evt_DedupeA', 'evt_DedupeB', 'evt_DedupeA'])
      await sendAlert(d, 'freeze_unresolved', { event: efw, event_id, reason: 'no_reference' });
    expect(sent).toHaveLength(6);
  });

  test('lane A: operator_funded and boot_refund_capped reach Telegram with their fields', async () => {
    expect(alertFromLog('alert_operator_funded', {})).toBe('operator_funded');
    expect(alertFromLog('alert_boot_refund_capped', {})).toBe('boot_refund_capped');
    const sent: string[] = [];
    const d = { store: new MemoryStore(), env: TG, now: () => 1, log: () => {}, fetch: async (_: string, init?: RequestInit) => {
      sent.push(String(init?.body)); return Response.json({ ok: true }); } };
    const fields = { team: '0123456789abcdef', account: 'ca_0123456789abcdef', rental: 'r_0123456789abcdef', provider: 'digitalocean', cost_usd: 0.12 };
    await sendAlert(d, 'operator_funded', fields);
    await sendAlert(d, 'boot_refund_capped', { team: fields.team, account: fields.account, rental: fields.rental });
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0]!).text).toBe(`Sqwakie compute: operator_funded\n${JSON.stringify(fields)}`);
    expect(sent[1]).toContain('boot_refund_capped');
  });
});
