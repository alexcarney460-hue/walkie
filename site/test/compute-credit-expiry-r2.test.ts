// Lane H round 2 (pre.17 candidate reviews: REVIEW-pre17-opus.md, REVIEW-pre17-codex.md).
// - Waiting rentals (queued, needs_code) are reconciled against credit on every safety pass, so an expiry the sweep
//   settled (the clock crossed it between the account's billing pass and the sweep) cannot leave one holding a
//   reservation and a queue slot no credit backs (Opus P2-1, Codex P2-2).
// - Admission re-checks credit with a fresh clock after its locks: a lock wait that crosses an expiry gives 402 and
//   inserts nothing (Codex P2-3).
// - A machine's first hour must be covered by credit that stays unexpired through that hour (Opus P3-1).
// - hours_left is forecast from every lot, not the 100 listed (Codex P3-8).
import { describe, expect, test } from 'bun:test';
import { CREDIT_LIFETIME_MS } from '../api/_lib/compute/lots.ts';
import { HOUR_MS } from '../api/_lib/compute/money.ts';
import { reservation } from '../api/_lib/compute/safety.ts';
import { rent as serviceRent, start, state, stop } from '../api/_lib/compute/service.ts';
import { settleExpiries, SETTLE_BATCH } from '../api/_lib/compute/lots.ts';
import { rent, T0 } from './compute-helpers.ts';
import {
  account, agentReq, alive, buy, codes, hooked, jump, ledger, MIN, minutes, rental, runAgent, tick, world,
} from './compute-credit-expiry-helpers.ts';

const T = T0 + CREDIT_LIFETIME_MS;
type W = ReturnType<typeof world>;
const insertedFor = (w: W, a: string) => w.store.tx(t => t.rentals(a, 50));

/**
 * Account `a` runs `first` on lot `old` (expires at T) and waits with `waiting` (queued, or needs_code after a second
 * machine stops); `lasting` (bought early, expires much later) backs `waiting`'s first hour, but only while `old` still
 * backs `first`'s reservation: once `old` expires, `lasting` must back both. Ticks every minute to T - 1 min.
 */
async function waitingAcrossExpiry(waiting: 'queued' | 'needs_code', lasting: number) {
  const w = world({ quotas: { cpu: waiting === 'queued' ? 1 : 2, gpu: 16 } });
  const a = await account(w);
  await buy(w, a, 50_000_000, { at: T0 });
  await jump(w, CREDIT_LIFETIME_MS - 70 * MIN);
  const lot = await buy(w, a, lasting);
  const ids = (await rent(w.d, a, agentReq(w.d.now(), waiting === 'queued' ? 2 : 3))).rentals.map(r => r.id);
  const [first, second, third] = ids as [string, string, string?];
  const live = waiting === 'queued' ? [first] : [first, second];
  await minutes(w, 59, live);
  if (waiting === 'needs_code') {
    await stop(w.d, a, { rental_id: second });
    await minutes(w, 1, [first]); // the slot frees: the queued machine waits for its code
  }
  const wait = (waiting === 'queued' ? second : third)!;
  for (let i = 0; w.d.now() < T - MIN; i++) await minutes(w, 1, [first]);
  expect((await rental(w, wait)).state).toBe(waiting);
  await alive(w, first);
  return { w, a, first, wait, lot };
}

/** One tick that starts 1 ms before T; the clock passes T after `a`'s billing pass, before the end-of-tick sweep. */
async function crossingTick(w: W, a: string): Promise<void> {
  w.clock.now = T - 1;
  let moved = false;
  const store = hooked(w.store, (m, args) => {
    if (!moved && m === 'setControl' && args[0] === 'billing_cursor' && args[1] === a) { w.clock.now = T + 1; moved = true; }
  });
  await tick({ ...w.d, store });
  expect(moved).toBe(true);
}
async function remainder(w: W, a: string, first: string): Promise<number> {
  const r = await rental(w, first);
  return (await state(w.d, a)).balance_micros - reservation(r);
}

describe('waiting rentals are reconciled on every safety pass (the clock crosses an expiry inside the tick)', () => {
  for (const waiting of ['queued', 'needs_code'] as const) {
    test(`${waiting}: the sweep settles the expiry and cancels the uncovered rental in the same tick (675,000 left against 750,000)`, async () => {
      const s = await waitingAcrossExpiry(waiting, 862_500);
      await crossingTick(s.w, s.a);
      expect(await remainder(s.w, s.a, s.first)).toBe(675_000);
      const r = await rental(s.w, s.wait);
      expect([r.state, r.end_reason, r.started_at]).toEqual(['ended', 'no_credit', null]);
      expect((await rental(s.w, s.first)).state).toBe('running');
    }, 30_000);
  }

  test('queued: an expiry written off by anything else is still caught by the next billing pass', async () => {
    const s = await waitingAcrossExpiry('queued', 862_500);
    s.w.clock.now = T + 1;
    // Written off out of band (an earlier sweep, a refund path): this tick's own settle writes nothing.
    await s.w.store.tx(async t => { await t.lockAccount(s.a); await settleExpiries(t, s.a, T + 1); });
    await jump(s.w, MIN - 1);
    const r = await rental(s.w, s.wait);
    expect([r.state, r.end_reason]).toEqual(['ended', 'no_credit']);
  }, 30_000);

  test('control: enough lasting credit keeps the waiting rental queued across the expiry', async () => {
    const s = await waitingAcrossExpiry('queued', 2_000_000);
    await crossingTick(s.w, s.a);
    await minutes(s.w, 3, [s.first]);
    expect((await rental(s.w, s.wait)).state).toBe('queued');
  }, 30_000);
});

describe('admission checks credit with a fresh clock after its locks', () => {
  /** `first` runs on `old` (expires at T); `lasting` backs one more first hour only while `old` backs first's reservation. */
  async function setup() {
    const w = world({ quotas: { cpu: 4, gpu: 16 } });
    const a = await account(w);
    await buy(w, a, 50_000_000, { at: T0 });
    await jump(w, CREDIT_LIFETIME_MS - 70 * MIN);
    const first = await runAgent(w, a);
    for (let i = 0; w.d.now() < T - MIN; i++) await minutes(w, 1, [first]);
    const held = reservation(await rental(w, first));
    await buy(w, a, held + 700_000);
    w.clock.now = T - 30_000;
    return { w, a, first };
  }
  test('control: a rent 30 s before the expiry is accepted', async () => {
    const { w, a } = await setup();
    expect((await serviceRent(w.d, a, agentReq(w.d.now()))).rentals).toHaveLength(1);
  }, 30_000);
  for (const lock of ['lockAccount', 'lockCapacity'] as const) {
    test(`a wait on ${lock} that crosses the expiry: 402 insufficient_credit, nothing inserted`, async () => {
      const { w, a, first } = await setup();
      let moved = false;
      const store = hooked(w.store, m => { if (!moved && m === lock) { w.clock.now = T + 1; moved = true; } });
      const req = agentReq(w.d.now());
      const err = await serviceRent({ ...w.d, store }, a, req).catch(e => e);
      expect(moved).toBe(true);
      expect([err.status, err.code]).toEqual([402, 'insufficient_credit']);
      expect((await insertedFor(w, a)).map(r => r.id)).toEqual([first]);
      expect(await w.store.tx(t => t.rentRequest(a, req.idempotency_key))).toBeNull();
    }, 30_000);
  }
});

describe('the first hour must be covered by credit that lasts through it', () => {
  test('a rent whose only credit expires within the hour: 402 with the expiring amount; a lasting lot, or an earlier rent, is accepted', async () => {
    const w = world();
    const a = await account(w);
    await buy(w, a, 50_000_000, { at: T0 });
    await jump(w, CREDIT_LIFETIME_MS - 2 * MIN);
    const req = agentReq(w.d.now());
    const err = await serviceRent(w.d, a, req).catch(e => e);
    expect([err.status, err.code]).toEqual([402, 'insufficient_credit']);
    expect(err.extra).toEqual({ needed_micros: 750_000, balance_micros: 0, expiring_micros: 50_000_000 });
    expect(await insertedFor(w, a)).toEqual([]);
    expect(await w.store.tx(t => t.rentRequest(a, req.idempotency_key))).toBeNull();
    await buy(w, a, 1_000_000);
    expect((await serviceRent(w.d, a, agentReq(w.d.now()))).rentals).toHaveLength(1);

    const early = world();
    const b = await account(early);
    await buy(early, b, 50_000_000, { at: T0 });
    await jump(early, CREDIT_LIFETIME_MS - HOUR_MS - MIN);
    expect((await serviceRent(early.d, b, agentReq(early.d.now()))).rentals).toHaveLength(1);
  });

  test('start refuses a first hour that only credit expiring within it covers, even before any tick', async () => {
    const w = world({ quotas: { cpu: 1, gpu: 16 } });
    const a = await account(w);
    await buy(w, a, 50_000_000, { at: T0 });
    await jump(w, CREDIT_LIFETIME_MS - 3 * HOUR_MS);
    const first = await runAgent(w, a);
    const queued = (await serviceRent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id;
    await stop(w.d, a, { rental_id: first });
    await jump(w, MIN);
    expect((await rental(w, queued)).state).toBe('needs_code');
    w.clock.now = T - 30 * MIN;
    await w.store.tx(t => t.setControl('last_tick', w.d.now()));
    const err = await start(w.d, a, queued, codes(1, w.d.now())[0]!).catch(e => e);
    expect([err.status, err.code, err.extra.expiring_micros > 0]).toEqual([402, 'insufficient_credit', true]);
  });

  test('a queued rental whose only cover expires within its first hour is cancelled then, not left holding a slot', async () => {
    const w = world({ quotas: { cpu: 1, gpu: 16 } });
    const a = await account(w);
    await buy(w, a, 50_000_000, { at: T0 });
    await jump(w, CREDIT_LIFETIME_MS - 65 * MIN);
    const [first, queued] = (await rent(w.d, a, agentReq(w.d.now(), 2))).rentals.map(r => r.id) as [string, string];
    await minutes(w, 4, [first]);
    expect((await rental(w, queued)).state).toBe('queued');
    await minutes(w, 2, [first]); // T is now within the queued machine's first hour
    const q = await rental(w, queued);
    expect([q.state, q.end_reason]).toEqual(['ended', 'no_credit']);
    expect((await rental(w, first)).state).toBe('running'); // a running machine keeps its lease until the expiry
  }, 30_000);
});

describe('hours_left is forecast from every lot, not the 100 listed', () => {
  test('101 $50 lots expiring in one hour at $0.75/h: 1 hour left (all of it expires), 100 lots listed', async () => {
    const w = world();
    const a = await account(w);
    for (let i = 0; i < 101; i++) await buy(w, a, 50_000_000, { at: T0 + 62 * MIN - CREDIT_LIFETIME_MS });
    const id = await runAgent(w, a);
    await minutes(w, 2, [id]);
    expect(w.d.now()).toBe(T0 + 2 * MIN);
    const s = await state(w.d, a);
    expect(s.credit_lots).toHaveLength(100);
    expect(s.balance_micros).toBeGreaterThan(100 * 50_000_000);
    // Independently: every lot expires 60 minutes from now and one machine spends $0.75 of it in that hour, so the
    // credit lasts exactly the hour (truncated to the 100 listed lots, the forecast read about 67.66 hours).
    expect(s.hours_left).toBe(1);
  });
});

describe('settlement is batched', () => {
  test(`an account with ${SETTLE_BATCH + 10} expired lots: one pass writes off ${SETTLE_BATCH}, the next the rest; none is usable meanwhile`, async () => {
    const w = world();
    const a = await account(w);
    for (let i = 0; i < SETTLE_BATCH + 10; i++) await buy(w, a, 1_000_000, { at: T0 + i });
    await buy(w, a, 2_000_000, { at: T });
    await jump(w, CREDIT_LIFETIME_MS + MIN);
    const written = () => ledger(w, a).filter(e => e.kind === 'expire').length;
    expect(written()).toBe(SETTLE_BATCH);
    expect((await state(w.d, a)).balance_micros).toBe(2_000_000);
    await jump(w, MIN);
    expect(written()).toBe(SETTLE_BATCH + 10);
    expect((await state(w.d, a)).balance_micros).toBe(2_000_000);
  });
});
