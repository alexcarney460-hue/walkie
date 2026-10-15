// Go-live fix round, lane A (REVIEW-codex.md P1-2, P2-7; REVIEW-opus.md P3-14/PROBE-3): metering continues until the
// provider confirms deletion, a balance never goes below zero, and provider time the customer does not pay for is
// booked on the rental as operator-funded instead of disappearing.
import { expect, test } from 'bun:test';
import { createAccount, codes, fixtureTeam, fund, idem, MIN, T0, world, type World } from './compute-helpers.ts';
import { heartbeat, rent, stop } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { priceOfMinutes, startedMinutes } from '../api/_lib/compute/money.ts';
import { EGRESS_PRICE_PER_GIB_MICROS, GIB } from '../api/_lib/compute/catalog.ts';
import type { Rental } from '../api/_lib/compute/store.ts';

const PRICE = 750_000; // the agent tier, per hour

async function launched(w: World, credit: number) {
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, credit);
  const r = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }],
    codes: codes(1, w.d.now()), walkie_version: 'v0.2.0-pre.17', idle_minutes: 1440 });
  const id = r.rentals[0]!.id;
  const token = (await w.store.tx(t => t.rental(id)))!.safety!.heartbeat_token!;
  await tick(w.d);
  await w.store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
  return { account: a.account_id, id, token };
}
const rental = (w: World, id: string) => w.store.tx(async t => (await t.rental(id)) as Rental);
const balance = (w: World, account: string) => w.store.tx(t => t.balance(account));
/** Provider deletion fails until `ok()` is called. */
function delayDeletion(w: World): { ok(): void } {
  const terminate = w.cloud.terminate.bind(w.cloud);
  let failing = true;
  w.cloud.terminate = async (instance: string) => { if (failing) throw new Error('provider still deleting'); return terminate(instance); };
  return { ok: () => { failing = false; } };
}
async function tickUntilEnded(w: World, id: string, limit = 40): Promise<Rental> {
  for (let i = 0; i < limit && (await rental(w, id)).state !== 'ended'; i++) { w.advance(MIN); await tick(w.d); }
  return rental(w, id);
}

test('a lease that expired unrenewed meters provider time until confirmed deletion and books it as operator-funded', async () => {
  const w = world();
  const { account, id } = await launched(w, 50_000_000);
  const deletion = delayDeletion(w);
  // The minute tick is down for 20 minutes: the 15-minute paid lease expires unrenewed.
  w.advance(20 * MIN);
  await tick(w.d);
  const expired = await rental(w, id);
  expect(expired.state).toBe('stopping');
  expect(expired.end_reason).toBe('heartbeat_lost');
  // The provider keeps the machine for ten more minutes before it confirms the deletion.
  for (let i = 0; i < 10; i++) { w.advance(MIN); await tick(w.d); }
  deletion.ok();
  const ended = await tickUntilEnded(w, id);
  expect(ended.state).toBe('ended');
  // Metering runs to the confirmed deletion; the customer pays only the leased fifteen minutes.
  expect(ended.billed_minutes).toBe(startedMinutes(T0, ended.ended_at!));
  expect(ended.billed_minutes).toBeGreaterThan(30);
  expect(ended.charged_micros).toBe(priceOfMinutes(PRICE, 15));
  expect(ended.safety!.unpaid_micros).toBe(priceOfMinutes(PRICE, ended.billed_minutes) - priceOfMinutes(PRICE, 15));
  expect(await balance(w, account)).toBe(50_000_000 - priceOfMinutes(PRICE, 15));
  const booked = w.logs.find(x => x.event === 'alert_operator_funded' && x.fields.rental === id);
  // Round 2 (REVIEW-A-codex.md P3): the alert names the team, account and rental, the provider and our cost only.
  expect(booked?.fields).toEqual({ team: fixtureTeam, account, rental: id, provider: 'fake', cost_usd: expect.any(Number) });
  expect(booked!.fields.cost_usd).toBeGreaterThan(0);
});

test('a stop near zero credit with a slow provider never drives the ledger below zero', async () => {
  const w = world();
  const credit = 760_000; // the first hour (750,000) plus a little
  const { account, id } = await launched(w, credit);
  const deletion = delayDeletion(w);
  await stop(w.d, account, { all: true });
  expect((await rental(w, id)).state).toBe('stopping');
  let lowest = await balance(w, account);
  for (let i = 0; i < 70; i++) {
    w.advance(MIN);
    await tick(w.d);
    lowest = Math.min(lowest, await balance(w, account));
  }
  expect(lowest).toBeGreaterThanOrEqual(0);
  deletion.ok();
  const ended = await tickUntilEnded(w, id);
  expect(ended.state).toBe('ended');
  expect(ended.billed_minutes).toBe(startedMinutes(T0, ended.ended_at!));
  // The customer pays every minute their credit covers; the rest is booked as operator-funded.
  expect(ended.charged_micros).toBe(credit);
  expect(ended.charged_micros + ended.safety!.unpaid_micros!).toBe(priceOfMinutes(PRICE, ended.billed_minutes));
  expect(await balance(w, account)).toBe(0);
});

test('a watchdog deletion reconciles operator-funded minutes metered after the machine was gone', async () => {
  const w = world();
  const credit = 760_000;
  const { account, id } = await launched(w, credit);
  const deletion = delayDeletion(w);
  await stop(w.d, account, { all: true });
  for (let i = 0; i < 70; i++) { w.advance(MIN); await tick(w.d); }
  const metered = await rental(w, id);
  expect(metered.billed_minutes).toBeGreaterThan(65);
  // The independent watchdog deleted the droplet at minute 65 and reports it.
  const at = T0 + 65 * MIN;
  deletion.ok();
  await w.cloud.terminate(metered.instance_id!);
  await w.store.tx(t => t.setControl('watchdog_deletions', { [metered.instance_id!]: at }));
  w.advance(MIN);
  await tick(w.d);
  const ended = await rental(w, id);
  expect(ended.state).toBe('ended');
  expect(ended.end_reason).toBe('watchdog_expired');
  expect(ended.ended_at).toBe(at);
  expect(ended.billed_minutes).toBe(65);
  expect(ended.charged_micros).toBe(credit);
  expect(ended.safety!.unpaid_micros).toBe(priceOfMinutes(PRICE, 65) - credit);
  expect(await balance(w, account)).toBe(0);
});

test("one heartbeat's self-reported egress cannot drive the balance below zero (Opus PROBE-3)", async () => {
  const w = world();
  const { account, id, token } = await launched(w, 1_000_000);
  w.advance(MIN);
  await heartbeat(w.d, { rental_id: id, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 50, egress_bytes: 200 * GIB });
  const before = await balance(w, account);
  await tick(w.d);
  expect(await balance(w, account)).toBe(0);
  const r = await rental(w, id);
  expect(r.egress_billed_gib).toBe(200);
  expect(r.safety!.unpaid_egress_micros).toBe(200 * EGRESS_PRICE_PER_GIB_MICROS - before);
  // At $0 every machine of the account stops.
  expect(['stopping', 'ended']).toContain(r.state);
  expect(r.end_reason).toBe('no_credit');
});

test('a real-provider rental is charged only from paid credit, never below zero, the rest booked unpaid', async () => {
  const { MemoryStore } = await import('../api/_lib/compute/memory-store.ts');
  const { bill } = await import('../api/_lib/compute/billing.ts');
  const store = new MemoryStore();
  const account = 'ca_00000000000000a1';
  const real: Rental = {
    id: 'r_00000000000000a1', account_id: account, team_id: fixtureTeam, tier: 'agent', name: 'rent-agent-a1', state: 'running',
    price_per_hour_micros: PRICE, idle_minutes: 30, created_at: T0, ord: 0, walkie_version: 'v0.2.0-pre.17', needs_code_at: null,
    started_at: T0, ended_at: null, end_reason: null, instance_id: '424242', heartbeat_hash: null, last_heartbeat_at: T0,
    last_busy_at: T0, gpu_hot_since: null, egress_bytes: 0, egress_billed_gib: 0, node_id: null, charged_micros: 0,
    billed_minutes: 0, launch_attempts: 1,
    safety: { provider: 'digitalocean', cost_per_hour_micros: 375_000, reserved: PRICE, claim: 'confirmed', key: 'r_00000000000000a1' },
  };
  await store.tx(async t => {
    await t.insertAccount({ id: account, team_id: fixtureTeam, token_hash: 'x'.repeat(64), status: 'active', review: null, created_at: T0, classification: 'customer' });
    await t.addLedger({ account_id: account, kind: 'purchase', amount_micros: 100_000, live: true, idem_key: 'paid', created_at: T0 });
    await t.addLedger({ account_id: account, kind: 'adjustment', amount_micros: 1_000_000, idem_key: 'free', created_at: T0 });
    await t.insertRental(real);
    const billed = await bill(t, real, T0 + 20 * MIN);
    expect(await t.paidBalance(account)).toBe(0);
    expect(await t.balance(account)).toBe(1_000_000); // free credit never pays a real provider
    expect(billed.billed_minutes).toBe(20);
    expect(billed.charged_micros).toBe(100_000);
    expect(billed.safety!.unpaid_micros).toBe(priceOfMinutes(PRICE, 20) - 100_000);
    // Egress beyond the allowance on an empty paid bucket is booked, not debited.
    const egress = await bill(t, { ...billed, egress_bytes: 10 * GIB }, T0 + 21 * MIN);
    expect(await t.paidBalance(account)).toBe(0);
    expect(egress.egress_billed_gib).toBe(10);
    expect(egress.safety!.unpaid_egress_micros).toBe(10 * EGRESS_PRICE_PER_GIB_MICROS);
  });
});

// Round 2 (REVIEW-A-codex.md P2): the operator's exposure to REPORTED egress. Unpaid egress can only be booked by the
// heartbeat that crosses the covering credit: the same tick stops the machine, and its later heartbeats are refused,
// so nothing more is booked while deletion is pending. (The per-machine egress_cap_gb hard stop is compute-service
// "egress cap per machine". Egress the guest does not report is the documented residual in A-FINAL.)
test('unpaid egress is booked at most once per rental: the crossing tick stops it and later reports are refused', async () => {
  const w = world();
  const { account, id, token } = await launched(w, 1_000_000);
  const deletion = delayDeletion(w);
  w.advance(MIN);
  await heartbeat(w.d, { rental_id: id, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 50, egress_bytes: 200 * GIB });
  await tick(w.d);
  const stopped = await rental(w, id);
  expect(stopped.state).toBe('stopping');
  expect(stopped.end_reason).toBe('no_credit');
  const booked = stopped.safety!.unpaid_egress_micros!;
  expect(booked).toBeGreaterThan(0);
  // The guest keeps sending, but its token was revoked at the stop: nothing more can be reported or booked.
  for (let i = 0; i < 10; i++) {
    w.advance(MIN);
    await expect(heartbeat(w.d, { rental_id: id, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 50, egress_bytes: (300 + i * 50) * GIB }))
      .rejects.toMatchObject({ status: 403, code: 'invalid_heartbeat' });
    await tick(w.d);
  }
  deletion.ok();
  const ended = await tickUntilEnded(w, id);
  expect(ended.state).toBe('ended');
  expect(ended.egress_billed_gib).toBe(200);
  expect(ended.safety!.unpaid_egress_micros).toBe(booked);
  expect(await balance(w, account)).toBe(0);
});
