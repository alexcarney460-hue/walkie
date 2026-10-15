// Lane H (Alex 2026-10-09): prepaid compute credit is NON-REFUNDABLE and EXPIRES 60 DAYS AFTER PURCHASE. Each credited
// purchase (and each operator adjustment) is a lot; spending takes the soonest-expiring lot first; at a lot's expiry its
// unspent remainder is written off with one idempotent `expire` ledger row; reads never show expired credit as usable
// even when the tick is late; a machine whose usable credit runs out through expiry stops exactly as for no credit.
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { applyCreditEvent, creditSessionParams } from '../api/_lib/compute/credit.ts';
import { CREDIT_LIFETIME_MS, EXPIRING_SOON_MS } from '../api/_lib/compute/lots.ts';
import { creditHoursLeft as siteHoursLeft, priceOfMinutes, startedMinutes, HOUR_MS } from '../api/_lib/compute/money.ts';
import { MAX_CREDIT_LOTS_SHOWN } from '../api/_lib/compute/views.ts';
import { CREDIT_LIFETIME_DAYS, MAX_CREDIT_LOTS } from '../../src/protocol/compute.ts';
import { rent as serviceRent, start, state, stop } from '../api/_lib/compute/service.ts';
import { DigitalOceanDriver, type Fetch } from '../api/_lib/compute/digitalocean.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { parsePrivateConfig } from '../api/_lib/compute/private-config.ts';
import type { ComputeDeps } from '../api/_lib/compute/deps.ts';
import { configJson, createAccount, fixtureTeam, rent, T0 } from './compute-helpers.ts';
import {
  account, AGENT, alive, buy, codes, DAY, expectReconciles, expiries, idem, jump, ledger, lotLeft, MIN, minutes, rental, runAgent,
  sum, tick, world,
} from './compute-credit-expiry-helpers.ts';

const hex = () => randomBytes(8).toString('hex');
const balance = (w: ReturnType<typeof world>, a: string) => w.store.tx(t => t.balance(a));
const purchase = (accountId: string, block: number, session: string, livemode = false) => ({
  id: `evt_${hex()}`, type: 'checkout.session.completed', livemode,
  data: { object: { id: session, mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: block * 100,
    payment_intent: `pi_${session.slice(3)}`, metadata: { walkie_compute_account: accountId, walkie_credit_usd: String(block) } } },
});
const agentReq = (now: number, count = 1) => ({ idempotency_key: idem(), machines: [{ tier: 'agent' as const, count }],
  codes: codes(count, now), walkie_version: 'v0.2.0-pre.17', idle_minutes: 1440 });

describe('a credit lot', () => {
  test('a block bought through Stripe expires exactly 60 x 24 h after it was credited; reads hide it at once, before any tick', async () => {
    expect(CREDIT_LIFETIME_MS).toBe(60 * 24 * HOUR_MS);
    const w = world();
    const a = await account(w);
    w.advance(5 * MIN);
    const session = `cs_test_${hex()}`;
    expect(await applyCreditEvent(w.d, purchase(a, 50, session))).toBe('credited');
    const credited = w.d.now(), end = credited + CREDIT_LIFETIME_MS;
    const s = await state(w.d, a);
    expect(s.credit_lots).toEqual([{ purchased_micros: 50_000_000, remaining_micros: 50_000_000, purchased_at: credited,
      expires_at: end, expiring_soon: false }]);
    expect(s.next_expiry_at).toBe(end);

    w.clock.now = end - 1;
    expect((await state(w.d, a)).balance_micros).toBe(50_000_000);
    w.clock.now = end;
    // The minute tick has not run since: a fresh health row only, so rent's freshness check passes.
    await w.store.tx(t => t.setControl('last_tick', w.d.now()));
    const at = await state(w.d, a);
    expect(at.balance_micros).toBe(0);
    expect(at.credit_lots).toEqual([]);
    expect(at.next_expiry_at).toBeNull();
    expect(await serviceRent(w.d, a, agentReq(w.d.now())).catch(e => e.code)).toBe('insufficient_credit');
    expect(expiries(w, a)).toEqual([]);

    await tick(w.d);
    expect(expiries(w, a).map(e => [e.idem_key, e.amount_micros, e.lot, e.created_at]))
      .toEqual([[`expire:stripe:${session}:1`, -50_000_000, `stripe:${session}`, end]]);
    expect(await balance(w, a)).toBe(0);
    expectReconciles(w, a, 0);
  });

  test('start refuses a machine whose first hour only expired credit covers, before the tick has run', async () => {
    const w = world({ quotas: { cpu: 1, gpu: 16 } });
    const a = await account(w);
    await buy(w, a, 50_000_000, { at: T0 });
    const end = T0 + CREDIT_LIFETIME_MS;
    // Round 2: a first hour must be covered by credit that lasts through it, so the rents happen 3 hours before the expiry.
    await jump(w, CREDIT_LIFETIME_MS - 3 * HOUR_MS);
    const first = await runAgent(w, a);
    const queued = (await serviceRent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id;
    await stop(w.d, a, { rental_id: first });
    await jump(w, MIN); // the quota frees: the queued machine waits for its code
    expect((await rental(w, queued)).state).toBe('needs_code');
    w.clock.now = end + 1;
    await w.store.tx(t => t.setControl('last_tick', w.d.now()));
    expect(await start(w.d, a, queued, codes(1, w.d.now())[0]!).catch(e => e.code)).toBe('insufficient_credit');
  });

  test('spending takes the soonest-expiring lot first and continues into the next one across a lot boundary', async () => {
    const w = world();
    const a = await account(w);
    const later = await buy(w, a, 200_000_000, { at: T0 });
    // Added after `later` but credited earlier (an operator adjustment): it expires first, so it is spent first.
    const sooner = await buy(w, a, 1_005_000, { at: T0 - 10 * DAY, kind: 'adjustment' });
    const id = await runAgent(w, a);
    await minutes(w, 5, [id]);
    expect((await state(w.d, a)).credit_lots!.map(l => l.expires_at)).toEqual([T0 - 10 * DAY + CREDIT_LIFETIME_MS, T0 + CREDIT_LIFETIME_MS]);
    await minutes(w, 115, [id]);
    await stop(w.d, a, { rental_id: id });
    const r = await rental(w, id);
    expect(lotLeft(w, sooner)).toBe(0);
    expect(lotLeft(w, later)).toBe(200_000_000 - (r.charged_micros - 1_005_000));
    const burns = ledger(w, a).filter(e => e.kind === 'burn');
    const crossing = burns.find(e => e.lot === later && burns.some(x => x.lot === sooner && `${x.idem_key}:2` === e.idem_key));
    expect(crossing).toBeDefined();
    expect(burns.every(e => e.lot === sooner || e.lot === later)).toBe(true);
    // Never a burn from `later` while `sooner` still had credit.
    const firstLater = burns.findIndex(e => e.lot === later);
    expect(burns.slice(firstLater).every(e => e.lot === later)).toBe(true);
    expect(await balance(w, a)).toBe(201_005_000 - r.charged_micros);
    expectReconciles(w, a, await balance(w, a));
  });

  test('operator-funded credit (an adjustment) follows the same 60-day rule', async () => {
    const w = world();
    const a = await account(w);
    const lot = await buy(w, a, 20_000_000, { at: T0, kind: 'adjustment' });
    await jump(w, CREDIT_LIFETIME_MS);
    expect(expiries(w, a).map(e => [e.lot, e.amount_micros])).toEqual([[lot, -20_000_000]]);
    expect(await balance(w, a)).toBe(0);
  });
});

describe('expiry and running machines', () => {
  test('expiry during a running rental stops it as out of credit: minutes before it are paid from the lot, later ones booked unpaid', async () => {
    const w = world();
    const a = await account(w);
    const lot = await buy(w, a, 50_000_000, { at: T0 });
    const end = T0 + CREDIT_LIFETIME_MS;
    // Round 2: rented 61.5 minutes before the expiry (a first hour must be covered by credit that lasts through it).
    await jump(w, CREDIT_LIFETIME_MS - 61 * MIN - 30_000);
    const id = await runAgent(w, a);
    const started = (await rental(w, id)).started_at!;
    // The provider refuses the first two deletions (retried a minute, then two, later): those minutes are metered too.
    const terminate = w.cloud.terminate.bind(w.cloud);
    let deleting = 0;
    w.cloud.terminate = async (instance: string) => {
      if (++deleting <= 2) throw new Error('provider still deleting');
      return terminate(instance);
    };
    let lowest = Infinity;
    for (let i = 0; i < 90 && (await rental(w, id)).state !== 'ended'; i++) {
      await minutes(w, 1, [id]);
      lowest = Math.min(lowest, await balance(w, a));
    }
    const r = await rental(w, id);
    expect(r.end_reason).toBe('no_credit');
    expect(r.state).toBe('ended');
    expect(r.ended_at! - end).toBeGreaterThanOrEqual(3 * MIN);
    expect(lowest).toBeGreaterThanOrEqual(0);
    // Every minute started before the expiry was paid from the lot (the tick bills up to the expiry first)...
    expect(r.charged_micros).toBe(priceOfMinutes(AGENT, startedMinutes(started, end)));
    const burns = ledger(w, a).filter(e => e.kind === 'burn');
    expect(burns.every(e => e.lot === lot && e.created_at < end)).toBe(true);
    // ...and what ran after it is operator-funded (the no-debt policy), never a negative balance.
    expect(r.safety!.unpaid_micros).toBeGreaterThan(0);
    expect(r.safety!.unpaid_micros).toBe(priceOfMinutes(AGENT, r.billed_minutes) - r.charged_micros);
    expect(expiries(w, a).map(e => e.amount_micros)).toEqual([-(50_000_000 - r.charged_micros)]);
    expect(lotLeft(w, lot)).toBe(0);
    expect(await balance(w, a)).toBe(0);
    expectReconciles(w, a, 0);
  });

  test('a real-provider machine on paid credit stops when its paid lot expires', async () => {
    let next = 1000;
    const fetchFn: Fetch = async (_url, init) => init.method === 'POST'
      ? new Response(JSON.stringify({ droplet: { id: next++ } }), { status: 202 })
      : new Response(JSON.stringify({ droplets: [], links: {}, meta: { total: 0 } }), { status: 200 });
    const driver = new DigitalOceanDriver('dop_v1_' + '0'.repeat(64), fetchFn);
    const clock = { now: T0 };
    const store = new MemoryStore();
    await store.tx(t => t.setControl('last_tick', T0));
    const d: ComputeDeps = { store, config: parsePrivateConfig(configJson({ cpu: 1, gpu: 16 }, {}, 'digitalocean')),
      driver: p => (p === 'digitalocean' ? driver : null), now: () => clock.now, siteOrigin: 'https://site.test', log: () => {} };
    const a = (await createAccount(d, fixtureTeam)).account_id;
    await store.tx(t => t.addLedger({ account_id: a, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'stripe:cs_live_x',
      ref: 'pi_live_x', live: true, created_at: T0 }));
    clock.now = T0 + CREDIT_LIFETIME_MS - 61 * MIN; // round 2: the first hour must be covered by credit lasting through it
    await tick(d);
    const id = (await rent(d, a, agentReq(clock.now))).rentals[0]!.id;
    await tick(d);
    for (let i = 0; i < 63; i++) {
      const r = (await store.tx(t => t.rental(id)))!;
      if (r.state === 'starting' || r.state === 'running')
        await store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: clock.now, last_busy_at: clock.now }));
      clock.now += MIN;
      await tick(d);
    }
    const r = (await store.tx(t => t.rental(id)))!;
    expect(r.end_reason).toBe('no_credit');
    expect(await store.tx(t => t.paidBalance(a))).toBe(0);
    expect((store as MemoryStore).ledger().filter(e => e.kind === 'burn').every(e => e.live && e.created_at < T0 + CREDIT_LIFETIME_MS)).toBe(true);
  });

  test('an open reservation never outlives its lot: the queued machine ends once its first hour would outlast the lot, the running one at the expiry', async () => {
    const w = world({ quotas: { cpu: 1, gpu: 16 } });
    const a = await account(w);
    await buy(w, a, 50_000_000, { at: T0 });
    const end = T0 + CREDIT_LIFETIME_MS;
    await jump(w, CREDIT_LIFETIME_MS - 65 * MIN);
    const r = await rent(w.d, a, agentReq(w.d.now(), 2));
    const [first, queued] = r.rentals.map(x => x.id) as [string, string];
    expect((await rental(w, queued)).state).toBe('queued');
    await minutes(w, 5, [first]); // the lot now expires within the queued machine's first hour
    const q = await rental(w, queued);
    expect([q.state, q.end_reason, q.started_at, q.ended_at]).toEqual(['ended', 'no_credit', null, end - 60 * MIN]);
    expect((await rental(w, first)).state).toBe('running');
    await minutes(w, 61, [first]);
    const f = await rental(w, first);
    expect([f.end_reason, f.ended_at]).toEqual(['no_credit', end]);
    expect(w.cloud.provisions).toHaveLength(1);
  });

  test('an expiry that leaves too little for a queued machine\'s first hour ends that one; a covered one keeps its place', async () => {
    const w = world({ quotas: { cpu: 1, gpu: 16 } });
    const a = await account(w);
    await buy(w, a, 50_000_000, { at: T0 });
    // After the expiry this covers the running machine's reservation (its first hour less 5 minutes charged) and one more
    // first hour, not two.
    await buy(w, a, 1_600_000, { at: T0 + DAY });
    await jump(w, CREDIT_LIFETIME_MS - 65 * MIN); // round 2: rents need credit that lasts through the first hour
    const r = await rent(w.d, a, agentReq(w.d.now(), 3));
    const [first, covered, uncovered] = r.rentals.map(x => x.id) as [string, string, string];
    expect([(await rental(w, covered)).state, (await rental(w, uncovered)).state]).toEqual(['queued', 'queued']);
    await minutes(w, 64, [first]);
    // Until the expiry the old lot backs the running machine's reservation, so the lasting lot covers both waiting ones.
    expect([(await rental(w, covered)).state, (await rental(w, uncovered)).state]).toEqual(['queued', 'queued']);
    await minutes(w, 3, [first]);
    expect((await rental(w, first)).state).toBe('running');
    expect((await rental(w, covered)).state).toBe('queued');
    const u = await rental(w, uncovered);
    expect([u.state, u.end_reason]).toEqual(['ended', 'no_credit']);
  });

  test('another lot covers the reservation: the machine keeps running on it and the queued one keeps its place', async () => {
    const w = world({ quotas: { cpu: 1, gpu: 16 } });
    const a = await account(w);
    const old = await buy(w, a, 50_000_000, { at: T0 });
    const fresh = await buy(w, a, 5_000_000, { at: T0 + DAY });
    await jump(w, CREDIT_LIFETIME_MS - 5 * MIN);
    const r = await rent(w.d, a, agentReq(w.d.now(), 2));
    const [first, queued] = r.rentals.map(x => x.id) as [string, string];
    await minutes(w, 10, [first]);
    expect((await rental(w, first)).state).toBe('running');
    expect((await rental(w, queued)).state).toBe('queued');
    expect(lotLeft(w, old)).toBe(0);
    const after = ledger(w, a).filter(e => e.kind === 'burn' && e.created_at >= T0 + CREDIT_LIFETIME_MS);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every(e => e.lot === fresh)).toBe(true);
    const s = await state(w.d, a);
    expect(s.balance_micros).toBe(lotLeft(w, fresh));
    expect(s.credit_lots!.map(l => l.remaining_micros)).toEqual([lotLeft(w, fresh)]);
  });
});

describe('refunds keep their lot', () => {
  test('a refund after a partial spend goes back to the lot it came from, with that lot\'s expiry', async () => {
    const w = world();
    const a = await account(w);
    const sooner = await buy(w, a, 50_000_000, { at: T0 });
    const later = await buy(w, a, 200_000_000, { at: T0 + DAY });
    const id = await runAgent(w, a);
    await minutes(w, 30, [id]);
    const before = await rental(w, id);
    // The watchdog deleted the droplet ten minutes ago: those minutes are refunded.
    await w.store.tx(t => t.setControl('watchdog_deletions', { [before.instance_id!]: w.d.now() - 10 * MIN }));
    await tick(w.d);
    const refunds = ledger(w, a).filter(e => e.kind === 'refund');
    expect(refunds.length).toBeGreaterThan(0);
    expect(refunds.every(e => e.lot === sooner)).toBe(true);
    const r = await rental(w, id);
    expect(r.state).toBe('ended');
    expect(lotLeft(w, sooner)).toBe(50_000_000 - r.charged_micros);
    expect(lotLeft(w, later)).toBe(200_000_000);
    expectReconciles(w, a, await balance(w, a));
  });

  test('a refund into a lot that has expired since is written off at once: it never becomes usable credit', async () => {
    const w = world();
    const a = await account(w);
    const sooner = await buy(w, a, 50_000_000, { at: T0 });
    const later = await buy(w, a, 200_000_000, { at: T0 + DAY });
    const end = T0 + CREDIT_LIFETIME_MS;
    await jump(w, CREDIT_LIFETIME_MS - 20 * MIN);
    const id = await runAgent(w, a);
    const started = (await rental(w, id)).started_at!;
    await minutes(w, 25, [id]);
    expect(expiries(w, a).map(e => e.lot)).toEqual([sooner]);
    // The droplet was gone since ten minutes after it started: everything later is refunded to its own lots.
    await w.store.tx(async t => t.setControl('watchdog_deletions', { [(await t.rental(id))!.instance_id!]: started + 10 * MIN }));
    await tick(w.d);
    const r = await rental(w, id);
    expect(r.charged_micros).toBe(priceOfMinutes(AGENT, 10));
    const toSooner = sum(ledger(w, a).filter(e => e.kind === 'refund' && e.lot === sooner));
    expect(toSooner).toBe(priceOfMinutes(AGENT, startedMinutes(started, end)) - priceOfMinutes(AGENT, 10));
    expect(expiries(w, a).map(e => [e.idem_key, e.amount_micros])).toEqual([
      [`expire:${sooner}:1`, expect.any(Number)], [`expire:${sooner}:2`, -toSooner]]);
    expect(lotLeft(w, sooner)).toBe(0);
    expect(lotLeft(w, later)).toBe(200_000_000);
    const s = await state(w.d, a);
    expect(s.balance_micros).toBe(200_000_000);
    expect(await balance(w, a)).toBe(200_000_000);
    expectReconciles(w, a, 200_000_000);
  });

  test('boot-failure refund credit goes back to the lot the boot was paid from', async () => {
    const w = world();
    const a = await account(w);
    const sooner = await buy(w, a, 50_000_000, { at: T0 });
    const later = await buy(w, a, 200_000_000, { at: T0 + DAY });
    const r0 = await rent(w.d, a, agentReq(w.d.now()));
    const id = r0.rentals[0]!.id;
    await tick(w.d);
    // No heartbeat ever: boot_timeout after 15 minutes, then the refund.
    for (let i = 0; i < 17; i++) { w.advance(MIN); await tick(w.d); }
    const r = await rental(w, id);
    expect([r.state, r.end_reason]).toEqual(['ended', 'boot_timeout']);
    const refunds = ledger(w, a).filter(e => e.kind === 'refund');
    expect(sum(refunds)).toBe(priceOfMinutes(AGENT, 15));
    expect(refunds.every(e => e.lot === sooner)).toBe(true);
    expect(lotLeft(w, sooner)).toBe(50_000_000 - r.charged_micros);
    expect(lotLeft(w, later)).toBe(200_000_000);
  });
});

describe('freezes, drain and idempotency', () => {
  test('a Stripe dispute freezes the account as before, and the frozen lot still expires on schedule', async () => {
    const w = world();
    const a = await account(w);
    const session = `cs_live_${hex()}`;
    expect(await applyCreditEvent(w.d, purchase(a, 50, session, true))).toBe('credited');
    const id = await runAgent(w, a);
    const dispute = { id: `evt_${hex()}`, type: 'charge.dispute.created', livemode: true,
      data: { object: { id: `dp_${hex()}`, charge: `ch_${hex()}`, payment_intent: `pi_${session.slice(3)}` } } };
    expect(await applyCreditEvent(w.d, dispute)).toBe('frozen');
    await minutes(w, 1, [id]);
    expect((await rental(w, id)).end_reason).toBe('frozen');
    const frozen = await state(w.d, a);
    expect(frozen.status).toBe('frozen');
    expect(frozen.credit_lots).toHaveLength(1);
    w.clock.now = T0 + CREDIT_LIFETIME_MS;
    await tick(w.d);
    expect(expiries(w, a).map(e => e.lot)).toEqual([`stripe:${session}`]);
    expect(await balance(w, a)).toBe(0);
    expect((await state(w.d, a)).status).toBe('frozen');
  });

  test('drain mode (COMPUTE_ENABLED unset) still applies expiries, idle and with a machine running', async () => {
    const w = world();
    const idle = await account(w);
    await buy(w, idle, 50_000_000, { at: T0 });
    const drained = { ...w.d, enabled: false };
    w.clock.now = T0 + CREDIT_LIFETIME_MS;
    await tick(drained);
    expect(expiries(w, idle).map(e => e.amount_micros)).toEqual([-50_000_000]);

    const w2 = world();
    const busy = await account(w2);
    await buy(w2, busy, 50_000_000, { at: T0 });
    await jump(w2, CREDIT_LIFETIME_MS - 61 * MIN); // round 2: the first hour must be covered by credit lasting through it
    const id = await runAgent(w2, busy);
    const drained2 = { ...w2.d, enabled: false };
    for (let i = 0; i < 63; i++) { await alive(w2, id); w2.advance(MIN); await tick(drained2); }
    expect((await rental(w2, id)).end_reason).toBe('no_credit');
    expect(expiries(w2, busy)).toHaveLength(1);
    expect(await balance(w2, busy)).toBe(0);
  });

  test('a tick that runs twice (or twice at once) writes one expiry; a spent-out lot gets one zero marker', async () => {
    const w = world();
    const a = await account(w);
    const lot = await buy(w, a, 30_000_000, { at: T0 });
    const spent = await buy(w, a, 1_000_000, { at: T0 - DAY });
    await w.store.tx(t => t.addLedger({ account_id: a, kind: 'burn', amount_micros: -1_000_000, idem_key: 'manual-spend', lot: spent,
      created_at: T0 }));
    w.clock.now = T0 + CREDIT_LIFETIME_MS + MIN;
    await Promise.all([tick(w.d), tick(w.d)]);
    await tick(w.d);
    w.advance(10 * MIN);
    await tick(w.d);
    expect(expiries(w, a).map(e => [e.idem_key, e.amount_micros]).sort()).toEqual([
      [`expire:${lot}:1`, -30_000_000], [`expire:${spent}:1`, 0]].sort());
    expect(await balance(w, a)).toBe(0);
  });
});

describe('what the customer sees', () => {
  test('state lists each lot (remaining, purchase and expiry), the soonest expiry, flags lots within 7 days, and hours_left stops at expiry', async () => {
    const w = world();
    const a = await account(w);
    await buy(w, a, 200_000_000, { at: T0 });
    await buy(w, a, 50_000_000, { at: T0 - CREDIT_LIFETIME_MS + DAY }); // expires in one day
    await buy(w, a, 20_000_000, { at: T0 - CREDIT_LIFETIME_MS + 8 * DAY }); // in eight days: not flagged
    const id = await runAgent(w, a);
    await minutes(w, 2, [id]);
    const s = await state(w.d, a);
    const now = w.d.now();
    expect(s.credit_lots!.map(l => [l.purchased_micros, l.expires_at, l.expiring_soon])).toEqual([
      [50_000_000, T0 + DAY, true], [20_000_000, T0 + 8 * DAY, false], [200_000_000, T0 + CREDIT_LIFETIME_MS, false]]);
    expect(s.credit_lots!.every(l => l.expiring_soon === (l.expires_at - now <= EXPIRING_SOON_MS))).toBe(true);
    expect(s.next_expiry_at).toBe(T0 + DAY);
    expect(s.credit_lots!.reduce((n, l) => n + l.remaining_micros, 0)).toBe(s.balance_micros);
    // The one-day lot cannot be burned in a day at $0.75/h: what is left of it expires, so hours_left is shorter than
    // balance / burn.
    const [soon, mid, rest] = s.credit_lots!;
    const hours = (soon!.expires_at - now) / HOUR_MS + (mid!.remaining_micros + rest!.remaining_micros) / AGENT;
    expect(s.hours_left!).toBeCloseTo(hours, 1);
    expect(s.hours_left!).toBeLessThan(s.balance_micros / AGENT);
  });

  test('the site and the daemon agree on the lifetime and the lots listed (site/ deploys on its own, so these are copies)', () => {
    expect(CREDIT_LIFETIME_MS).toBe(CREDIT_LIFETIME_DAYS * 24 * HOUR_MS);
    expect(MAX_CREDIT_LOTS_SHOWN).toBe(MAX_CREDIT_LOTS);
    // The forecast itself is the site's only (money.ts creditHoursLeft): 50 h of credit in a lot that expires in 5 h
    // gives 5 h of it, then 20 h from the later lot.
    const now = T0;
    expect(siteHoursLeft(70_000_000, 1_000_000, [{ remaining_micros: 50_000_000, expires_at: now + 5 * HOUR_MS },
      { remaining_micros: 20_000_000, expires_at: now + 30 * DAY }], now)).toBe(25);
    expect(siteHoursLeft(10_000_000, 1_000_000, [], now)).toBe(10);
    expect(siteHoursLeft(10_000_000, 0, [], now)).toBeNull();
  });

  test('the Checkout page says, before payment, that credit is non-refundable and expires 60 days after purchase', () => {
    const p = creditSessionParams({ accountId: 'ca_0123456789abcdef', block: 200, successUrl: 'https://site.test/ok', cancelUrl: 'https://site.test/no' });
    expect(p.line_items?.[0]?.price_data?.product_data).toEqual({ name: 'Sqwakie compute credit ($200)',
      description: 'Prepaid credit for rented machines, used per minute. Non-refundable. Expires 60 days after purchase.' });
    expect(p.custom_text).toEqual({ submit: { message: 'Prepaid credit for Sqwakie rented machines, used per minute. Non-refundable: '
      + 'unused credit expires 60 days after purchase, and the credit that expires soonest is used first. Card statements show WALKIE.' } });
    expect(p.adaptive_pricing).toEqual({ enabled: false });
  });
});
