// Lane H, property test: random purchases (both buckets, some credited in the past), rents, heartbeats (some machines
// never boot), stops, early provider deletions (watchdog refunds), minute ticks and multi-day jumps over simulated
// months, on fixed seeds. After every step: no bucket below zero (no debt); every burn drew on a lot that was unexpired
// at the burn's time; every lot holds between 0 and its amount, and the lots together hold exactly the ledger balance
// (cent-exact reconciliation); after a tick every expired lot is written off; the state shows only unexpired credit;
// each rental's ledger rows equal its charged amount.
import { describe, expect, test } from 'bun:test';
import { CREDIT_LIFETIME_MS } from '../api/_lib/compute/lots.ts';
import { rent as serviceRent, start as serviceStart, state, stop } from '../api/_lib/compute/service.ts';
import type { LedgerEntry, Rental } from '../api/_lib/compute/store.ts';
import { account, buy, codes, DAY, idem, ledger, MIN, sum, tick, world } from './compute-credit-expiry-helpers.ts';

/** mulberry32: a small seeded PRNG, so a failing seed replays exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const isLot = (e: LedgerEntry) => (e.kind === 'purchase' || e.kind === 'adjustment') && e.amount_micros > 0;
type W = ReturnType<typeof world>;
/** What the seeds exercised together (the last test checks each happened). */
const seen = { burns: 0, crossings: 0, refunds: 0, expiries: 0, refundWriteOffs: 0 };

async function check(w: W, a: string, ids: readonly string[], ticked: boolean, where: string): Promise<void> {
  const rows = ledger(w, a), now = w.d.now();
  const lots = new Map(rows.filter(isLot).map(l => [l.idem_key, l]));
  for (const live of [true, false]) expect(sum(rows.filter(e => (e.live === true) === live)), `${where}: bucket live=${live}`).toBeGreaterThanOrEqual(0);
  for (const e of rows) {
    if (isLot(e)) continue;
    const l = lots.get(e.lot ?? '');
    expect(l, `${where}: ${e.idem_key} names a lot`).toBeDefined();
    expect(l!.live === true, `${where}: ${e.idem_key} in its lot's bucket`).toBe(e.live === true);
    if (e.kind === 'burn') expect(e.created_at, `${where}: ${e.idem_key} spent unexpired credit`).toBeLessThan(l!.created_at + CREDIT_LIFETIME_MS);
    if (e.kind === 'expire') expect(e.amount_micros).toBeLessThanOrEqual(0);
  }
  let held = 0, usable = 0;
  for (const l of lots.values()) {
    const left = l.amount_micros + sum(rows.filter(e => e.lot === l.idem_key));
    expect(left, `${where}: lot ${l.idem_key}`).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(l.amount_micros);
    if (ticked && l.created_at + CREDIT_LIFETIME_MS <= now) expect(left, `${where}: expired lot ${l.idem_key} written off`).toBe(0);
    held += left;
    if (l.created_at + CREDIT_LIFETIME_MS > now) usable += left;
  }
  expect(held, `${where}: lots hold the balance`).toBe(sum(rows));
  const s = await state(w.d, a);
  expect(s.balance_micros, `${where}: state shows usable credit only`).toBe(usable);
  expect(s.credit_lots!.reduce((n, l) => n + l.remaining_micros, 0)).toBe(usable);
  expect(s.credit_lots!.every(l => l.expires_at > now && l.remaining_micros > 0)).toBe(true);
  for (const id of ids) {
    const r = (await w.store.tx(t => t.rental(id))) as Rental;
    expect(0 - sum(rows.filter(e => e.rental_id === id)), `${where}: rental ${id} rows = charged`).toBe(r.charged_micros);
    expect(r.safety?.unpaid_micros ?? 0).toBeGreaterThanOrEqual(0);
  }
}

describe('credit expiry property', () => {
  for (const seed of [11, 23, 37, 41, 59, 73]) {
    test(`seed ${seed}: no debt, no spend of expired credit, cent-exact lots over simulated months`, async () => {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      const w = world({ quotas: { cpu: 4, gpu: 16 } });
      const a = await account(w);
      const ids: string[] = [];
      const silent = new Set<string>(); // never heartbeat: boot timeouts and their refunds
      const start = w.d.now();
      for (let step = 0; step < 500; step++) {
        const p = r();
        let ticked = false;
        if (p < 0.07) {
          const amount = pick([50_000_000, 200_000_000, 1_000_000_000, 1_005_000, 3_333_333, 250_001, 777_777]);
          const past = r() < 0.15 ? Math.floor(r() * 70 * DAY) : 0;
          await buy(w, a, amount, { live: r() < 0.5, kind: r() < 0.25 ? 'adjustment' : 'purchase', at: w.d.now() - past });
        } else if (p < 0.15) {
          const n = 1 + Math.floor(r() * 2);
          try {
            const res = await serviceRent(w.d, a, { idempotency_key: idem(), machines: [{ tier: 'agent', count: n }],
              codes: codes(n, w.d.now()), walkie_version: 'v0.2.0-pre.17', idle_minutes: 1440 });
            for (const x of res.rentals) { ids.push(x.id); if (r() < 0.2) silent.add(x.id); }
          } catch { /* 402 / 503: refused, nothing written */ }
        } else if (p < 0.17 && ids.length) {
          await stop(w.d, a, { rental_id: pick(ids) }).catch(() => undefined);
        } else if (p < 0.19 && ids.length) {
          const victim = (await w.store.tx(t => t.rental(pick(ids))))!;
          if (victim.instance_id && ['starting', 'running', 'stopping'].includes(victim.state)) {
            const prior = (await w.store.tx(t => t.control('watchdog_deletions')) ?? {}) as Record<string, number>;
            const at = Math.max(victim.started_at ?? 0, w.d.now() - Math.floor(r() * 20 * MIN));
            await w.store.tx(t => t.setControl('watchdog_deletions', { ...prior, [victim.instance_id!]: at }));
          }
        } else {
          const jump = p < 0.23 ? (1 + Math.floor(r() * 20)) * DAY : p < 0.27 ? (5 + Math.floor(r() * 15)) * MIN : MIN;
          for (const id of ids) {
            const x = (await w.store.tx(t => t.rental(id)))!;
            if (!silent.has(id) && (x.state === 'starting' || x.state === 'running') && r() < 0.95)
              await w.store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
            // The owner's daemon hands a queued machine its fresh code once the tick moved it forward.
            if (x.state === 'needs_code') await serviceStart(w.d, a, id, codes(1, w.d.now())[0]!).catch(() => undefined);
          }
          w.advance(jump);
          await tick(w.d);
          ticked = true;
        }
        await check(w, a, ids, ticked, `seed ${seed} step ${step}`);
      }
      // The run covered months.
      expect(w.d.now() - start).toBeGreaterThan(90 * DAY);
      const rows = ledger(w, a);
      seen.burns += rows.filter(e => e.kind === 'burn').length;
      seen.crossings += rows.filter(e => e.kind === 'burn' && /:\d+$/.test(e.idem_key.replace(/^burn:r_[0-9a-f]{16}:\d+/, ''))).length;
      seen.refunds += rows.filter(e => e.kind === 'refund').length;
      seen.expiries += rows.filter(e => e.kind === 'expire' && e.amount_micros < 0).length;
      seen.refundWriteOffs += rows.filter(e => e.kind === 'expire' && !e.idem_key.endsWith(':1')).length;
    }, 120_000);
  }
  test('together the seeds spent across lot boundaries, refunded, and wrote expiries', () => {
    expect(seen.burns).toBeGreaterThan(500);
    expect(seen.crossings).toBeGreaterThan(0);
    expect(seen.refunds).toBeGreaterThan(0);
    expect(seen.expiries).toBeGreaterThan(5);
    process.stderr.write(`credit-expiry property: ${JSON.stringify(seen)}\n`);
  });
});
