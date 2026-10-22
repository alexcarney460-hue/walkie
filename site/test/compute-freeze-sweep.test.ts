// Go-live lane F (lane B review, Opus P3-4; spec in lanes/A-FINAL.md "Needs from other lanes (round 2)"): a freeze whose
// charge Stripe could not resolve when the event was delivered is held (compute-freeze-hold:<charge>, state pending) and
// refused so Stripe redelivers it, but Stripe stops after about 3 days in live mode. The minute tick now retries the
// charge lookup for pending holds through lane B's own freeze path (applyCreditEvent), bounded by count and time, in
// drain too, and does nothing at all without a compute Stripe key.
import { describe, expect, test } from 'bun:test';
import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import { applyCreditEvent, FreezeUnresolved, type ChargeLookup, type StripeEvent } from '../api/_lib/compute/credit.ts';
import { computeFromEnv, type HandlerDeps } from '../api/_lib/compute/handler.ts';
import type { ComputeDeps } from '../api/_lib/compute/deps.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { RENTED_MACHINE_RELEASES } from '../api/_lib/compute/releases.ts';
import { state } from '../api/_lib/compute/service.ts';
import type { ComputeStore, Tx } from '../api/_lib/compute/store.ts';
// A namespace import, so the tests also load (and fail one by one) against a tick without the sweep.
import * as ticker from '../api/_lib/compute/tick.ts';
import { makeComputeWebhook } from '../api/compute/webhook.ts';
import { makeTick } from '../api/compute/tick.ts';
import { codes, configJson, createAccount, fixtureTeam, idem, MIN, rent, T0, world, type World } from './compute-helpers.ts';

const { EMPTY_REPORT, tick } = ticker;
/** tick.ts FREEZE_SWEEP_MAX: Stripe reads per tick. */
const SWEEP_MAX = 5;
const RELEASE = RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]!;
const EFW = 'radar.early_fraud_warning.created';
const DISPUTE = 'charge.dispute.created';
const WH = 'whsec_' + 'lane_f_fixture_secret';
const CRON = 'cron-' + 'lane-f-fixture';
const TG = { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixt' + 'ure-bot', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture-chat' };
const HANDOVER = 'rent-fixture-handover-key-32-bytes';
const hex = () => randomBytes(8).toString('hex');

// Stripe's event envelope and objects (lane B's fixtures, trimmed to the fields the compute webhook reads).
const envelope = (id: string, type: string, object: Record<string, unknown>): StripeEvent =>
  ({ id, object: 'event', api_version: '2026-08-26.dahlia', created: 1_790_000_000, livemode: true, type, data: { object } } as StripeEvent);
const checkout = (account: string, pi: string) => envelope(`evt_${hex()}`, 'checkout.session.completed', {
  id: `cs_live_${hex()}`, object: 'checkout.session', amount_total: 5000, client_reference_id: account, currency: 'usd',
  livemode: true, mode: 'payment', payment_intent: pi, payment_status: 'paid', status: 'complete',
  metadata: { walkie_compute_account: account, walkie_credit_usd: '50' } });
/** An early fraud warning without its optional payment_intent: lane B must resolve it through the charge. */
const warning = (eventId: string, charge: string) => envelope(eventId, EFW, { id: `issfr_${hex()}`,
  object: 'radar.early_fraud_warning', actionable: true, charge, fraud_type: 'made_with_stolen_card', livemode: true });
/** A dispute whose payload omits payment_intent (looked up through the charge, like the warning). */
const dispute = (eventId: string, charge: string) => envelope(eventId, DISPUTE, { id: `du_${hex()}`, object: 'dispute',
  amount: 5000, charge, currency: 'usd', livemode: true, reason: 'fraudulent', status: 'warning_needs_response' });

const offline: ChargeLookup = { paymentIntentOfCharge: async () => { throw new Error('stripe unreachable'); } };
/** A charge lookup like the real one: known charges answer, any other is Stripe being unreachable. */
const lookup = (known: Record<string, string | null>, calls: string[] = []): ChargeLookup => ({
  async paymentIntentOfCharge(charge: string) {
    calls.push(charge);
    if (!(charge in known)) throw new Error('stripe unreachable');
    return known[charge] ?? null;
  },
});
const holdKey = (subject: string) => `compute-freeze-hold:${subject}`;
const hold = (w: World, subject: string) => w.store.tx(t => t.control(holdKey(subject))) as Promise<Record<string, unknown> | undefined>;
const marker = (w: World, pi: string) => w.store.tx(t => t.control(`payment:${pi}`));
const status = async (w: World, account: string) => (await state(w.d, account)).status;
const logged = (w: World, event: string, from = 0) => w.logs.slice(from).filter(l => l.event === event);
const nonBurn = (store: ComputeStore) => (store as MemoryStore).ledger().filter(e => e.kind !== 'burn');
const cron = () => new Request('https://site.test/api/compute/tick', { headers: { authorization: `Bearer ${CRON}` } });
async function signed(event: unknown): Promise<Request> {
  const payload = JSON.stringify(event);
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: WH });
  return new Request('https://site.test/api/compute/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': header } });
}

interface Held { readonly w: World; readonly account: string; readonly pi: string; readonly charge: string; readonly eventId: string }

/**
 * A funded account (a live purchase with ref pi) with a running machine, and a fraud warning on that purchase that
 * Stripe could not resolve when it was delivered: the real pending hold lane B's webhook path writes (attempts 1,
 * updated_at T0). Stripe's redelivery has not arrived.
 */
async function held(opts: { machine?: boolean; store?: ComputeStore; id?: string } = {}): Promise<Held> {
  const w = world(opts.store ? { store: opts.store } : {});
  const a = await createAccount(w.d, fixtureTeam);
  const id = opts.id ?? hex();
  const pi = `pi_${id}`, charge = `ch_${id}`, eventId = `evt_${id}`;
  expect(await applyCreditEvent(w.d, checkout(a.account_id, pi))).toBe('credited');
  if (opts.machine !== false) {
    const r = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }],
      codes: codes(1), walkie_version: RELEASE });
    await w.store.tx(t => t.updateRental(r.rentals[0]!.id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
  }
  await expect(applyCreditEvent(w.d, warning(eventId, charge), offline)).rejects.toBeInstanceOf(FreezeUnresolved);
  expect(await hold(w, charge)).toMatchObject({ charge, state: 'pending', reason: 'lookup_failed', event: EFW,
    event_id: eventId, attempts: 1, updated_at: T0 });
  return { w, account: a.account_id, pi, charge, eventId };
}
const withCharges = (w: World, charges: ChargeLookup, over: Partial<ComputeDeps> = {}): ComputeDeps => ({ ...w.d, charges, ...over });

describe('the tick retries held freezes through lane B\'s freeze path', () => {
  test('a pending hold whose charge now resolves is frozen once; the next tick stops the machine', async () => {
    const s = await held();
    const calls: string[] = [];
    const d = withCharges(s.w, lookup({ [s.charge]: s.pi }, calls));
    const ledger = nonBurn(s.w.store);
    const logsBefore = s.w.logs.length;
    s.w.advance(MIN);
    const first = await tick(d);
    expect(calls).toEqual([s.charge]);
    expect(await hold(s.w, s.charge)).toMatchObject({ charge: s.charge, state: 'resolved', payment_intent: s.pi,
      event: EFW, event_id: s.eventId, attempts: 1, first_at: T0, updated_at: T0 + MIN });
    expect(await marker(s.w, s.pi)).toEqual({ frozen: true, event: EFW });
    expect(await status(s.w, s.account)).toBe('frozen');
    // The account was still active when this tick billed it: the stop is the next tick's (as after a webhook freeze).
    expect(first.stopped.frozen).toBeUndefined();
    expect(await s.w.store.tx(t => t.control('last_tick'))).toBe(T0 + MIN);
    s.w.advance(MIN);
    expect((await tick(d)).stopped).toEqual({ frozen: 1 });
    s.w.advance(MIN);
    await tick(d);
    // Resolved holds are never looked up again; the freeze wrote no ledger row and paged once.
    expect(calls).toEqual([s.charge]);
    expect(nonBurn(s.w.store)).toEqual(ledger);
    expect(logged(s.w, 'account_frozen', logsBefore).map(l => l.fields)).toEqual([{ account: s.account, event: EFW }]);
    expect(logged(s.w, 'alert_freeze_unresolved', logsBefore)).toEqual([]);
  });

  test('the resolved hold, the payment marker and the account end exactly as Stripe\'s redelivery leaves them', async () => {
    const viaSweep = await held({ id: 'SameEnd1' });
    const viaStripe = await held({ id: 'SameEnd1' });
    viaSweep.w.advance(MIN);
    viaStripe.w.advance(MIN);
    await tick(withCharges(viaSweep.w, lookup({ ch_SameEnd1: 'pi_SameEnd1' })));
    expect(await applyCreditEvent(viaStripe.w.d, warning('evt_SameEnd1', 'ch_SameEnd1'), lookup({ ch_SameEnd1: 'pi_SameEnd1' })))
      .toBe('frozen');
    expect(await hold(viaSweep.w, 'ch_SameEnd1')).toEqual((await hold(viaStripe.w, 'ch_SameEnd1'))!);
    expect(await marker(viaSweep.w, 'pi_SameEnd1')).toEqual(await marker(viaStripe.w, 'pi_SameEnd1'));
    expect(await status(viaSweep.w, viaSweep.account)).toBe('frozen');
    expect(await status(viaStripe.w, viaStripe.account)).toBe('frozen');
  });

  test('a lookup that still fails leaves the hold pending with attempts and updated_at bumped; the tick records its health', async () => {
    const s = await held();
    const calls: string[] = [];
    const logsBefore = s.w.logs.length;
    s.w.advance(MIN);
    await tick(withCharges(s.w, lookup({}, calls)));
    expect(calls).toEqual([s.charge]);
    expect(await hold(s.w, s.charge)).toMatchObject({ state: 'pending', reason: 'lookup_failed', attempts: 2, first_at: T0,
      updated_at: T0 + MIN, event_id: s.eventId });
    expect(await status(s.w, s.account)).toBe('active');
    expect(await s.w.store.tx(t => t.control('last_tick'))).toBe(T0 + MIN);
    // Lane B's own alert (deduplicated per charge for 30 minutes by sendAlert); no other freeze log.
    expect(logged(s.w, 'alert_freeze_unresolved', logsBefore).map(l => l.fields)).toEqual([
      { event: EFW, charge: s.charge, reason: 'lookup_failed' }]);
    expect(logged(s.w, 'freeze_retry_failed', logsBefore)).toEqual([]);
  });

  test('a charge Stripe now reports without a PaymentIntent becomes unmatched and is not retried', async () => {
    const s = await held();
    const calls: string[] = [];
    const d = withCharges(s.w, lookup({ [s.charge]: null }, calls));
    s.w.advance(MIN);
    await tick(d);
    expect(await hold(s.w, s.charge)).toMatchObject({ state: 'unmatched', reason: 'no_payment_intent' });
    s.w.advance(MIN);
    await tick(d);
    expect(calls).toEqual([s.charge]);
    expect(await status(s.w, s.account)).toBe('active');
  });

  test(`one tick reads at most ${SWEEP_MAX} charges, oldest attempt first, and every hold gets its turn`, async () => {
    expect((ticker as { FREEZE_SWEEP_MAX?: number }).FREEZE_SWEEP_MAX).toBe(SWEEP_MAX);
    const s = await held();
    const template = (await hold(s.w, s.charge))!;
    // Eleven more pending holds, written in shuffled order: ch_ageNN was last tried NN minutes before T0.
    const ages = [7, 2, 11, 5, 9, 1, 10, 3, 8, 6, 4];
    const name = (age: number) => `ch_age${String(age).padStart(2, '0')}`;
    await s.w.store.tx(async t => {
      for (const age of ages) await t.setControl(holdKey(name(age)), { ...template, charge: name(age),
        event_id: `evt_age${age}`, first_at: T0 - age * MIN, updated_at: T0 - age * MIN });
    });
    const calls: string[] = [];
    const d = withCharges(s.w, lookup({}, calls));
    s.w.advance(MIN);
    await tick(d);
    expect(calls).toEqual([11, 10, 9, 8, 7].map(name));
    s.w.advance(MIN);
    await tick(d);
    expect(calls.slice(5)).toEqual([6, 5, 4, 3, 2].map(name));
    s.w.advance(MIN);
    await tick(d);
    // Then the remaining two, then the holds retried first (tied on updated_at, so in key order).
    expect(calls.slice(10)).toEqual([name(1), s.charge, name(7), name(8), name(9)]);
    expect(new Set(calls).size).toBe(12);
    expect(await hold(s.w, name(11))).toMatchObject({ state: 'pending', attempts: 2, updated_at: T0 + MIN });
  });

  test('holds keyed by event id (nothing to look up) are not listed, so they cannot take the sweep\'s slots', async () => {
    const s = await held();
    const noReference = (i: number) => ({ state: 'pending', reason: 'no_reference', event: EFW, event_id: `evt_noref${i}`,
      livemode: true, first_at: T0 - (20 + i) * MIN, updated_at: T0 - (20 + i) * MIN, attempts: 3 });
    await s.w.store.tx(async t => {
      for (let i = 0; i < SWEEP_MAX + 1; i++) await t.setControl(holdKey(`evt_noref${i}`), noReference(i));
    });
    const calls: string[] = [];
    s.w.advance(MIN);
    await tick(withCharges(s.w, lookup({ [s.charge]: s.pi }, calls)));
    expect(calls).toEqual([s.charge]);
    expect(await status(s.w, s.account)).toBe('frozen');
    for (let i = 0; i < SWEEP_MAX + 1; i++) expect(await hold(s.w, `evt_noref${i}`)).toEqual(noReference(i));
  });

  test('a lookup that never answers cannot hold the tick past its budget; the hold stays pending for the next tick', async () => {
    const s = await held();
    const template = (await hold(s.w, s.charge))!;
    await s.w.store.tx(async t => {
      for (const c of ['ch_hangA', 'ch_hangB']) await t.setControl(holdKey(c), { ...template, charge: c, updated_at: T0 - MIN });
    });
    const calls: string[] = [];
    const hang: ChargeLookup = { paymentIntentOfCharge: (charge: string) => { calls.push(charge); return new Promise<string | null>(() => {}); } };
    const budget = { total: 900, cleanup: 200, call: 100 };
    const logsBefore = s.w.logs.length;
    s.w.advance(MIN);
    const started = Date.now();
    await tick(withCharges(s.w, hang), budget);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(budget.total + 600);
    // The whole sweep has one call budget: the first hanging read uses it (a timer firing a millisecond early may let a
    // second read start, never a third).
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(calls[0]).toBe('ch_hangA');
    expect(logged(s.w, 'freeze_retry_failed', logsBefore).map(l => l.fields)).toEqual(calls.map(charge => ({ charge, reason: 'deadline' })));
    for (const c of ['ch_hangA', 'ch_hangB', s.charge]) expect(await hold(s.w, c)).toMatchObject({ state: 'pending', attempts: 1 });
    expect(await s.w.store.tx(t => t.control('last_tick'))).toBe(T0 + MIN);
  });

  test('a store failure while listing holds is logged and the tick still reconciles', async () => {
    const inner = new MemoryStore();
    const store: ComputeStore = { tx: <T>(fn: (t: Tx) => Promise<T>) => inner.tx(t => fn({ ...t,
      pendingFreezeHolds: async () => { throw new Error('store unavailable'); } })) };
    const s = await held({ store });
    let lists = 0;
    const list = s.w.cloud.list.bind(s.w.cloud);
    s.w.cloud.list = async () => { lists++; return list(); };
    const logsBefore = s.w.logs.length;
    s.w.advance(MIN);
    await tick(withCharges(s.w, lookup({ [s.charge]: s.pi })));
    expect(logged(s.w, 'freeze_retry_failed', logsBefore).map(l => l.fields)).toEqual([{ reason: 'error' }]);
    expect(lists).toBe(1);
    expect(await s.w.store.tx(t => t.control('last_tick'))).toBe(T0 + MIN);
    expect(await hold(s.w, s.charge)).toMatchObject({ state: 'pending', attempts: 1 });
  });

  test('without a compute Stripe key the sweep reads nothing and logs nothing, every tick, enabled or drained', async () => {
    let listings = 0;
    const inner = new MemoryStore();
    const store: ComputeStore = { tx: <T>(fn: (t: Tx) => Promise<T>) => inner.tx(t => fn({ ...t,
      pendingFreezeHolds: async (limit: number) => { listings++; return t.pendingFreezeHolds(limit); } })) };
    const s = await held({ store });
    const before = await hold(s.w, s.charge);
    const logsBefore = s.w.logs.length;
    for (const enabled of [true, true, false]) {
      s.w.advance(MIN);
      await tick({ ...s.w.d, enabled });
    }
    expect(s.w.d.charges).toBeUndefined();
    expect(listings).toBe(0);
    expect(await hold(s.w, s.charge)).toEqual(before!);
    expect(s.w.logs.slice(logsBefore).filter(l => /freeze|frozen/.test(l.event))).toEqual([]);
    expect(await status(s.w, s.account)).toBe('active');
  });
});

describe('a Stripe redelivery racing the sweep', () => {
  test('both in flight at once: one frozen account, the same final rows, no ledger change and one operator alert', async () => {
    const s = await held();
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const sweepCalls: string[] = [];
    const slow: ChargeLookup = { async paymentIntentOfCharge(charge: string) {
      sweepCalls.push(charge); entered(); await gate; return charge === s.charge ? s.pi : null; } };
    const sent: string[] = [];
    const deps: HandlerDeps = { env: { ...TG, COMPUTE_ENABLED: '1', COMPUTE_STRIPE_WEBHOOK_SECRET: WH, CRON_SECRET: CRON },
      compute: () => withCharges(s.w, slow),
      stripe: () => ({ createCreditCheckout: async () => ({ url: null }), ...lookup({ [s.charge]: s.pi }) }),
      alertFetch: async (_: string, init?: RequestInit) => { sent.push(String(init?.body)); return Response.json({ ok: true }); } };
    const ledger = nonBurn(s.w.store);
    s.w.advance(MIN);
    const ticking = makeTick(deps)(cron());
    await inside;
    const redelivered = await makeComputeWebhook(deps)(await signed(warning(s.eventId, s.charge)));
    expect(redelivered.status).toBe(200);
    expect(await redelivered.json()).toEqual({ received: true, outcome: 'frozen' });
    const afterStripe = await hold(s.w, s.charge);
    expect(afterStripe).toMatchObject({ state: 'resolved', payment_intent: s.pi, attempts: 1 });
    release();
    expect((await ticking).status).toBe(200);
    expect(sweepCalls).toEqual([s.charge]);
    expect(await hold(s.w, s.charge)).toEqual(afterStripe!);
    expect(await marker(s.w, s.pi)).toEqual({ frozen: true, event: EFW });
    expect(await status(s.w, s.account)).toBe('frozen');
    expect(nonBurn(s.w.store)).toEqual(ledger);
    expect(sent.filter(body => body.includes('account_frozen'))).toHaveLength(1);
    s.w.advance(MIN);
    expect(await (await makeTick(deps)(cron())).json()).toMatchObject({ stopped: { frozen: 1 } });
    expect(sweepCalls).toEqual([s.charge]);
  });

  test('a hold Stripe resolved after the sweep listed it is skipped, not applied a second time', async () => {
    const s = await held();
    // A second purchase on the same account, disputed a minute later and held too: the sweep reaches it second.
    const pi2 = `pi_${hex()}`, charge2 = `ch_${hex()}`, evt2 = `evt_${hex()}`;
    expect(await applyCreditEvent(s.w.d, checkout(s.account, pi2))).toBe('credited');
    s.w.advance(MIN);
    await expect(applyCreditEvent(s.w.d, dispute(evt2, charge2), offline)).rejects.toBeInstanceOf(FreezeUnresolved);
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const sweepCalls: string[] = [];
    const slow: ChargeLookup = { async paymentIntentOfCharge(charge: string) {
      sweepCalls.push(charge); entered(); await gate; return charge === s.charge ? s.pi : null; } };
    const logsBefore = s.w.logs.length;
    s.w.advance(MIN);
    const ticking = tick(withCharges(s.w, slow));
    await inside;
    expect(await applyCreditEvent(s.w.d, dispute(evt2, charge2), lookup({ [charge2]: pi2 }))).toBe('frozen');
    release();
    await ticking;
    expect(sweepCalls).toEqual([s.charge]);
    expect(await hold(s.w, charge2)).toMatchObject({ state: 'resolved', payment_intent: pi2, attempts: 1 });
    // Stripe's redelivery froze for the dispute, the sweep for the warning; the dispute was not applied again.
    expect(logged(s.w, 'account_frozen', logsBefore).map(l => l.fields.event)).toEqual([DISPUTE, EFW]);
  });
});

describe('drain (COMPUTE_ENABLED unset, deps present): freezes are a safety path', () => {
  test('drained with a running machine: the sweep freezes and the next drained tick stops the machine', async () => {
    const s = await held();
    const d = withCharges(s.w, lookup({ [s.charge]: s.pi }), { enabled: false });
    s.w.advance(MIN);
    await tick(d);
    expect(await hold(s.w, s.charge)).toMatchObject({ state: 'resolved', payment_intent: s.pi });
    expect(await status(s.w, s.account)).toBe('frozen');
    s.w.advance(MIN);
    expect((await tick(d)).stopped).toEqual({ frozen: 1 });
  });

  test('drained and idle: the sweep still freezes, the tick records its health and does no provider work', async () => {
    const s = await held({ machine: false });
    let lists = 0;
    s.w.cloud.list = async () => { lists++; return []; };
    s.w.advance(MIN);
    expect(await tick(withCharges(s.w, lookup({ [s.charge]: s.pi }), { enabled: false }))).toEqual(EMPTY_REPORT);
    expect(await hold(s.w, s.charge)).toMatchObject({ state: 'resolved', payment_intent: s.pi });
    expect(await status(s.w, s.account)).toBe('frozen');
    expect(await s.w.store.tx(t => t.control('last_tick'))).toBe(T0 + MIN);
    expect(lists).toBe(0);
  });

  test('a drained deployment\'s cron tick applies the held freeze and pages the operator once', async () => {
    const s = await held({ machine: false });
    // The rollback: COMPUTE_ENABLED removed, the compute (test) key still set. The charge read is faked: no Stripe call.
    const env = { ...TG, COMPUTE_PRIVATE_CONFIG: configJson(), DATABASE_URL: 'postgres://127.0.0.1:1/unused',
      COMPUTE_HANDOVER_TOKEN_KEY: HANDOVER, CRON_SECRET: CRON, COMPUTE_STRIPE_SECRET_KEY: 'sk_test_' + 'lanefdrain' };
    const sent: string[] = [];
    const deps: HandlerDeps = { env, stripe: () => null,
      alertFetch: async (_: string, init?: RequestInit) => { sent.push(String(init?.body)); return Response.json({ ok: true }); },
      compute: async () => {
        const base = await computeFromEnv(env, s.w.store);
        expect(base?.enabled).toBe(false);
        expect(typeof base?.charges?.paymentIntentOfCharge).toBe('function');
        return base && { ...base, charges: lookup({ [s.charge]: s.pi }), driver: s.w.d.driver, now: s.w.d.now, log: s.w.d.log };
      } };
    for (let i = 0; i < 2; i++) {
      s.w.advance(MIN);
      expect((await makeTick(deps)(cron())).status).toBe(200);
    }
    expect(await hold(s.w, s.charge)).toMatchObject({ state: 'resolved', payment_intent: s.pi });
    expect(await status(s.w, s.account)).toBe('frozen');
    expect(sent.filter(body => body.includes('account_frozen'))).toHaveLength(1);
  });
});

describe('computeFromEnv gives the tick a charge lookup only for an allowed compute Stripe key', () => {
  test('test key: yes; live key: only with COMPUTE_STRIPE_LIVE=1; no key: none; enabled or drained alike', async () => {
    const base = { COMPUTE_PRIVATE_CONFIG: configJson(), COMPUTE_HANDOVER_TOKEN_KEY: HANDOVER };
    const charges = async (env: Record<string, string>) => (await computeFromEnv({ ...base, ...env }, new MemoryStore()))?.charges;
    const modes: Record<string, string>[] = [{}, { COMPUTE_ENABLED: '1' }];
    for (const enabled of modes) {
      expect(await charges(enabled)).toBeUndefined();
      expect(typeof (await charges({ ...enabled, COMPUTE_STRIPE_SECRET_KEY: 'sk_test_' + 'lanef' }))?.paymentIntentOfCharge).toBe('function');
      expect(typeof (await charges({ ...enabled, COMPUTE_STRIPE_SECRET_KEY: 'rk_test_' + 'lanef' }))?.paymentIntentOfCharge).toBe('function');
      expect(await charges({ ...enabled, COMPUTE_STRIPE_SECRET_KEY: 'sk_live_' + 'lanef' })).toBeUndefined();
      expect(typeof (await charges({ ...enabled, COMPUTE_STRIPE_SECRET_KEY: 'sk_live_' + 'lanef', COMPUTE_STRIPE_LIVE: '1' }))
        ?.paymentIntentOfCharge).toBe('function');
    }
  });
});
