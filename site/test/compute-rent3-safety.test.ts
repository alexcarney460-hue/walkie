import { test, expect } from 'bun:test';
import { fixtureTeam, createAccount, world, codes, idem, configJson, proof, fixtureKeys, T0 } from './compute-helpers.ts';
import { createAccount as openAccount, rent, start, stop, state, heartbeat } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { parsePrivateConfig } from '../api/_lib/compute/private-config.ts';
import { applyCreditEvent } from '../api/_lib/compute/credit.ts';
import { createInvite } from '../../src/daemon/invite.ts';
import { generateKeys } from '../../src/daemon/keys.ts';
import type { ComputeDeps } from '../api/_lib/compute/deps.ts';
import type { TierId } from '../api/_lib/compute/types.ts';

const TEAM = fixtureTeam;
const req = (tier: TierId = 'agent', count = 1) => ({ idempotency_key: idem(), machines: [{ tier, count }], codes: codes(count), walkie_version: 'v0.2.0-pre.7' });
async function setup(real = true, extra: Record<string, unknown> = {}) {
  const w = world();
  const d: ComputeDeps = { ...w.d, config: parsePrivateConfig(configJson({ cpu: 100, gpu: 100 }, extra, real ? 'digitalocean' : 'fake')), driver: () => w.cloud };
  const a = await createAccount(d, TEAM);
  await w.store.tx(t => t.addLedger({ account_id: a.account_id, kind: 'purchase', live: true, amount_micros: 50_000_000, idem_key: idem(), created_at: T0 }));
  return { ...w, d, a, id: a.account_id };
}
const token = (w: Awaited<ReturnType<typeof setup>>) => /printf '%s' '([A-Za-z0-9_-]{43})'/.exec(w.cloud.provisions[0]!.user_data)![1]!;

test('rent only enqueues; concurrent ticks launch each durable claim once', async () => {
  const w = await setup();
  await rent(w.d, w.id, req('gpu-80', 5));
  expect(w.cloud.provisions.length).toBe(0);
  await Promise.all([tick(w.d), tick(w.d), tick(w.d)]);
  expect(w.cloud.provisions.length).toBe(5);
  const rs = await w.store.tx(t => t.activeRentals());
  expect(rs.every(r => r.safety?.claim === 'confirmed' && r.safety.provider === 'digitalocean')).toBe(true);
  expect(rs.every(r => !r.safety?.code && !r.safety?.heartbeat_token)).toBe(true);
});
test('reservations protect parallel start and queue promotion against a concurrent rent', async () => {
  const w = await setup();
  const r = await rent(w.d, w.id, req('gpu-80', 5));
  await w.store.tx(async t => { for (const item of r.rentals) await t.updateRental(item.id, { state: 'needs_code' }); });
  const attempts = await Promise.allSettled([
    start(w.d, w.id, r.rentals[0]!.id, codes(1)[0]!),
    start(w.d, w.id, r.rentals[0]!.id, codes(1)[0]!),
    rent(w.d, w.id, req('gpu-80')),
  ]);
  expect(attempts.filter(x => x.status === 'fulfilled').length).toBe(1);
  await w.store.tx(async t => { for (const item of r.rentals.slice(1)) await t.updateRental(item.id, { state: 'queued' }); });
  await Promise.all([tick(w.d), tick(w.d)]);
  expect((await w.store.tx(t => t.activeRentals())).filter(r => r.state === 'needs_code').length).toBe(4);
});
test('cancel or freeze before claim prevents provisioning', async () => {
  for (const freeze of [false, true]) {
    const w = await setup();
    const r = await rent(w.d, w.id, req());
    if (freeze) await w.store.tx(t => t.setAccount(w.id, { status: 'frozen' }));
    else await stop(w.d, w.id, { rental_id: r.rentals[0]!.id });
    await tick(w.d);
    expect(w.cloud.provisions.length).toBe(0);
  }
});
test('late create result for a cancelled claim is terminated immediately', async () => {
  const w = await setup();
  const r = await rent(w.d, w.id, req());
  const original = w.cloud.provision.bind(w.cloud);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  w.cloud.provision = async p => { entered(); await gate; return original(p); };
  const work = tick(w.d);
  await started;
  await stop(w.d, w.id, { rental_id: r.rentals[0]!.id });
  release(); await work;
  expect(w.cloud.terminations.length).toBe(1);
  expect((await state(w.d, w.id)).rentals[0]!.state).toBe('ended');
});
test('uncertain create is adopted using recorded provider even after config changes', async () => {
  const w = await setup();
  const r = await rent(w.d, w.id, req());
  const original = w.cloud.provision.bind(w.cloud);
  w.cloud.provision = async p => { await original(p); throw new Error('lost response'); };
  await tick(w.d);
  const changed = { ...w.d, config: parsePrivateConfig(configJson()) };
  await tick(changed);
  expect((await w.store.tx(t => t.rental(r.rentals[0]!.id)))?.instance_id).toBe('fake-00000001');
  await stop(changed, w.id, { all: true });
  expect(w.cloud.terminations.length).toBe(1);
  expect(w.cloud.provisions.length).toBe(1);
});
test('orphan grace and per-machine failure isolation', async () => {
  const w = await setup();
  const a = w.cloud.plantOrphan({}), b = w.cloud.plantOrphan({});
  const original = w.cloud.terminate.bind(w.cloud);
  w.cloud.terminate = async id => { if (id === a) throw new Error('pending'); await original(id); };
  await tick(w.d); expect(w.cloud.terminations.length).toBe(0);
  w.advance(120_000); await tick(w.d);
  expect(w.cloud.state(b)).toBe('terminated');
  expect(w.logs.some(l => l.event === 'alert_orphan_termination_failed')).toBe(true);
});
test('failed deletion continues billing, backs off, and surfaces escalation', async () => {
  const w = await setup();
  const r = await rent(w.d, w.id, req()); await tick(w.d);
  const original = w.cloud.terminate.bind(w.cloud); let calls = 0;
  w.cloud.terminate = async () => { calls++; throw new Error('pending'); };
  await stop(w.d, w.id, { all: true });
  const first = (await state(w.d, w.id)).rentals[0]!.spent_micros;
  await tick(w.d); expect(calls).toBe(1);
  w.advance(60_000); await tick(w.d);
  w.advance(120_000); await tick(w.d);
  const s = await state(w.d, w.id);
  expect(s.rentals[0]!.spent_micros).toBeGreaterThan(first);
  expect(s.rentals[0]!.state).toBe('stopping');
  expect(s.alerts).toContain('termination_delayed');
  w.cloud.terminate = original; w.advance(240_000); await tick(w.d);
  expect((await w.store.tx(t => t.rental(r.rentals[0]!.id)))?.state).toBe('ended');
});
test('stale tick blocks rent and start with owner-visible alert', async () => {
  const w = await setup();
  const r = await rent(w.d, w.id, req());
  await w.store.tx(t => t.updateRental(r.rentals[0]!.id, { state: 'needs_code' }));
  w.advance(180_001);
  expect(await rent(w.d, w.id, req()).catch(e => e.code)).toBe('compute_tick_stale');
  expect(await start(w.d, w.id, r.rentals[0]!.id, codes(1)[0]!).catch(e => e.code)).toBe('compute_tick_stale');
  expect((await state(w.d, w.id)).alerts).toContain('tick_stale');
  expect(w.logs.some(l => l.event === 'alert_tick_stale')).toBe(true);
});
test('internal teams cannot launch despite live credit', async () => {
  for (const extra of [{ internal_teams: [TEAM] }]) {
    const w = await setup(true, extra);
    expect(await rent(w.d, w.id, req()).catch(e => e.code)).toBe('team_ineligible');
    expect(w.cloud.provisions.length).toBe(0);
  }
  const w = await setup();
  await rent(w.d, w.id, req());
  await tick({ ...w.d, config: parsePrivateConfig(configJson({ cpu: 100, gpu: 100 }, { internal_teams: [TEAM] }, 'digitalocean')) });
  expect(w.cloud.provisions.length).toBe(0);
});
test('refund/dispute arriving before purchase durably freezes later credit', async () => {
  const w = await setup();
  for (const type of ['charge.refunded', 'charge.dispute.created', 'radar.early_fraud_warning.created']) {
    const pi = idem();
    expect(await applyCreditEvent(w.d, { id: idem(), type, data: { object: { payment_intent: pi } } })).toBe('frozen');
    await applyCreditEvent(w.d, { id: idem(), type: 'checkout.session.completed', livemode: true, data: { object: {
      id: idem(), mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: 5000, payment_intent: pi,
      metadata: { walkie_compute_account: w.id, walkie_credit_usd: '50' },
    } } });
    expect((await state(w.d, w.id)).status).toBe('frozen');
  }
});
test('account requires proof by the enrolled authority and validates expiry', async () => {
  const w = world();
  expect(await openAccount(w.d, TEAM).catch(e => e.code)).toBe('team_ownership_required');
  expect(await openAccount(w.d, TEAM, { ...proof(), key: generateKeys().pubkey }).catch(e => e.code)).toBe('team_ownership_required');
  expect(await openAccount(w.d, TEAM, proof(T0 - 300_000)).catch(e => e.code)).toBe('team_ownership_required');
});
test('signed invites enforce team, authority, one-hour expiry, signer and one-rental binding', async () => {
  const w = await setup();
  const make = (over = {}, keys = fixtureKeys) => createInvite(keys, { team: TEAM, authority: fixtureKeys.pubkey, handle: 'alex', role: 'member', now: T0, pos: 1, ttlMs: 3_600_000, ...over }).code;
  for (const code of [make({ team: '1111111111111111' }), make({ authority: generateKeys().pubkey }), make({ ttlMs: 3_601_000 }), make({ now: T0 - 3_600_001 }), make({}, generateKeys())]) {
    expect(await rent(w.d, w.id, { ...req(), codes: [code] }).catch(e => e.code)).toBe('invalid_rental_invite');
  }
  const code = make();
  await rent(w.d, w.id, { ...req(), codes: [code] });
  expect(await rent(w.d, w.id, { ...req(), codes: [code] }).catch(e => e.code)).toBe('invalid_rental_invite');
});
test('heartbeat cannot mark an unrecorded instance running; bootstrap failure cancels it', async () => {
  const w = await setup();
  const r = await rent(w.d, w.id, req());
  const stored = await w.store.tx(t => t.rental(r.rentals[0]!.id));
  const hb = { rental_id: r.rentals[0]!.id, token: stored!.safety!.heartbeat_token!, busy_seats: 1, pool_jobs: 0, cpu_pct: 1, egress_bytes: 0 };
  expect((await heartbeat(w.d, hb)).state).toBe('starting');
  await heartbeat(w.d, { ...hb, bootstrap_failed: true });
  await tick(w.d);
  expect(w.cloud.provisions.length).toBe(0);
});
test('FakeCloud spends other credit without depleting paid eligibility', async () => {
  const w = await setup(false);
  await w.store.tx(t => t.addLedger({ account_id: w.id, kind: 'adjustment', amount_micros: 50_000_000, idem_key: idem(), created_at: T0 }));
  const r = await rent(w.d, w.id, req()); await tick(w.d);
  w.advance(60_000);
  await heartbeat(w.d, { rental_id: r.rentals[0]!.id, token: token(w), busy_seats: 1, pool_jobs: 0, cpu_pct: 1, egress_bytes: 0 });
  await tick(w.d);
  expect(await w.store.tx(t => t.paidBalance(w.id))).toBe(50_000_000);
});
test('boot-failure refund preserves paid eligibility and waits for confirmed deletion', async () => {
  const w = await setup(false);
  await rent(w.d, w.id, req()); await tick(w.d);
  const original = w.cloud.terminate.bind(w.cloud);
  w.cloud.terminate = async () => { throw new Error('pending deletion'); };
  for (let minute = 0; minute < 15; minute++) { w.advance(60_000); await tick(w.d); }
  expect((await state(w.d, w.id)).balance_micros).toBeLessThan(50_000_000);
  w.cloud.terminate = original;
  w.advance(60_000); await tick(w.d);
  // Only the 15-minute boot window is refundable; delayed deletion costs one minute.
  expect(await w.store.tx(t => t.paidBalance(w.id))).toBe(50_000_000 - 12_500);
  expect((await state(w.d, w.id)).balance_micros).toBe(50_000_000 - 12_500);
});
test('tick launch budget defers excess work without losing reservations', async () => {
  const w = await setup();
  await rent(w.d, w.id, req('agent', 5));
  const now = Date.now;
  let elapsed = 0;
  const original = w.cloud.provision.bind(w.cloud);
  w.cloud.provision = async p => { elapsed += 20_000; return original(p); };
  Date.now = () => elapsed;
  try { await tick(w.d); } finally { Date.now = now; }
  expect(w.cloud.provisions.length).toBe(2);
  expect((await w.store.tx(t => t.activeRentals())).filter(r => r.safety?.claim === 'pending').length).toBe(3);
  w.cloud.provision = original; await tick(w.d);
  expect(w.cloud.provisions.length).toBe(5);
});
test('idempotent recovery still works after freezing and disabling new launches', async () => {
  const w = await setup(); const request = req();
  const first = await rent(w.d, w.id, request);
  await w.store.tx(t => t.setAccount(w.id, { status: 'frozen' }));
  const replay = await rent({ ...w.d, enabled: false }, w.id, request);
  expect(replay.replay).toBe(true);
  expect(replay.code_index).toEqual(first.code_index);
  expect(w.cloud.provisions.length).toBe(0);
});
