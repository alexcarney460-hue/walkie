import { test, expect } from 'bun:test';
import { fixtureTeam, world, createAccount, fund, codes, idem, MIN } from './compute-helpers.ts';
import { rent, heartbeat, stop } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { refundBoot } from '../api/_lib/compute/billing.ts';
import { makeTick } from '../api/compute/tick.ts';

async function setup(count = 1) {
  const w = world();
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 100_000_000);
  const result = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count }], codes: codes(count), walkie_version: 'v0.2.0-pre.7' });
  const id = result.rentals[0]!.id;
  const pending = (await w.store.tx(t => t.rental(id)))!;
  await tick(w.d);
  return { ...w, account: a.account_id, id, token: pending.safety!.heartbeat_token! };
}

test('ready rentals reject boot failure transitions without changing billing state', async () => {
  const w = await setup();
  await w.store.tx(t => t.updateRental(w.id, { state: 'running', last_heartbeat_at: w.d.now(), node_id: '1111111111111111' }));
  const before = await w.store.tx(t => t.rental(w.id));
  expect(await heartbeat(w.d, { rental_id: w.id, token: w.token, bootstrap_failed: true, busy_seats: 0, pool_jobs: 0, cpu_pct: 0, egress_bytes: 0 })).toEqual({ state: 'running' });
  expect(await w.store.tx(t => t.rental(w.id))).toEqual(before);
  expect(w.logs.some(x => x.event === 'alert_bootstrap_failure_ignored')).toBe(true);
});

test('boot refund is limited to the boot window and never refunds ready rentals', async () => {
  const w = await setup();
  await w.store.tx(async t => {
    const r = (await t.rental(w.id))!;
    await t.addLedger({ account_id: w.account, rental_id: r.id, kind: 'burn', amount_micros: -1_000_000, idem_key: idem(), created_at: w.d.now() + 20 * MIN });
    const before = await t.balance(w.account);
    await refundBoot(t, { ...r, last_heartbeat_at: w.d.now(), node_id: '1111111111111111' }, w.d.now() + 20 * MIN);
    expect(await t.balance(w.account)).toBe(before);
    await refundBoot(t, r, w.d.now() + 20 * MIN);
    expect(await t.balance(w.account)).toBeLessThanOrEqual(before + 15 * r.price_per_hour_micros / 60);
  });
});

test('stale provider listing cannot change a terminal rental or charge it again', async () => {
  const w = await setup();
  const snapshot = await w.cloud.list();
  await stop(w.d, w.account, { all: true });
  const before = await w.store.tx(t => t.rental(w.id));
  const balance = await w.store.tx(t => t.balance(w.account));
  w.cloud.list = async () => snapshot;
  w.advance(5 * MIN);
  await tick(w.d);
  expect(await w.store.tx(t => t.rental(w.id))).toEqual(before);
  expect(await w.store.tx(t => t.balance(w.account))).toBe(balance);
});

test('duplicate cleanup keeps the canonical machine and does not charge the rental', async () => {
  const w = await setup();
  const original = (await w.cloud.list())[0]!;
  const duplicate = w.cloud.plantOrphan({ ...original.tags });
  const before = await w.store.tx(t => t.balance(w.account));
  await tick(w.d);
  expect(w.cloud.state(original.instance_id)).toBe('running');
  expect(w.cloud.state(duplicate)).toBe('terminated');
  expect(await w.store.tx(t => t.balance(w.account))).toBe(before);
});

test('disabled idle tick does no provider work and leaves last_tick unchanged', async () => {
  const w = world();
  const before = await w.store.tx(t => t.control('last_tick'));
  let lists = 0; w.cloud.list = async () => { lists++; return []; };
  w.advance(5 * MIN);
  await tick({ ...w.d, enabled: false });
  expect(lists).toBe(0);
  expect(await w.store.tx(t => t.control('last_tick'))).toBe(before);
  expect(w.logs).toEqual([]);
});

test('unconfigured cron is a successful no-op', async () => {
  const h = makeTick({ env: { CRON_SECRET: 'test-cron' }, compute: () => null, stripe: () => null });
  expect((await h(new Request('https://site.test/api/compute/tick', { headers: { authorization: 'Bearer test-cron' } }))).status).toBe(200);
});

test('lease expiry terminates before listing or launching; heartbeat cannot renew it', async () => {
  const w = await setup();
  const initial = (await w.store.tx(t => t.rental(w.id)))!.safety!.lease_until!;
  expect(initial).toBe(w.d.now() + 15 * MIN);
  w.advance(MIN);
  await heartbeat(w.d, { rental_id: w.id, token: w.token, busy_seats: 1, pool_jobs: 0, cpu_pct: 1, egress_bytes: 0 });
  expect((await w.store.tx(t => t.rental(w.id)))!.safety!.lease_until).toBe(initial);
  const events: string[] = [];
  const terminate = w.cloud.terminate.bind(w.cloud), list = w.cloud.list.bind(w.cloud);
  w.cloud.terminate = async id => { events.push('terminate'); await terminate(id); };
  w.cloud.list = async () => { events.push('list'); return list(); };
  w.advance(15 * MIN);
  await tick(w.d);
  expect(events[0]).toBe('terminate');
  expect((await w.store.tx(t => t.rental(w.id)))!.state).toBe('ended');
  expect(w.logs.some(x => x.event === 'alert_lease_expired')).toBe(true);
});

test('successful billing renews a funded lease, failed billing does not', async () => {
  const w = await setup();
  const initial = (await w.store.tx(t => t.rental(w.id)))!.safety!.lease_until!;
  w.advance(MIN); await tick(w.d);
  expect((await w.store.tx(t => t.rental(w.id)))!.safety!.lease_until).toBe(initial + MIN);
  const original = w.store.tx.bind(w.store);
  const failing = { ...w.d, store: { tx: (<T>(fn: Parameters<typeof w.store.tx<T>>[0]) => original(t => fn({ ...t, addLedger: async () => { throw new Error('billing unavailable'); } }))) } };
  w.advance(MIN);
  await expect(tick(failing)).rejects.toThrow('billing unavailable');
  expect((await w.store.tx(t => t.rental(w.id)))!.safety!.lease_until).toBe(initial + MIN);
});

test('an expired lease read does not scan or clean unrelated rentals', async () => {
  const { makeLease } = await import('../api/compute/lease.ts');
  const w = await setup();
  w.advance(16 * MIN);
  const h = makeLease({ env: {}, compute: () => w.d, stripe: () => null });
  const response = await h(new Request('https://site.test/api/compute/lease', { method: 'POST', headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ rental_id: w.id }) }));
  expect(response.status).toBe(200);
  expect(w.cloud.terminations).toHaveLength(0);
  expect((await w.store.tx(t => t.rental(w.id)))!.state).toBe('starting');
});

test('cleanup concurrency is bounded and persisted jobs resume fairly after a budget cutoff', async () => {
  const { markStopped } = await import('../api/_lib/compute/service.ts');
  const { drainCleanup, hasCleanup } = await import('../api/_lib/compute/cleanup.ts');
  const w = await setup(10);
  await w.store.tx(async t => { await markStopped(t, await t.activeRentals(), 'user', w.d.now()); });
  let active = 0, peak = 0, elapsed = 0;
  const calls: string[] = [], original = w.cloud.terminate.bind(w.cloud), realNow = Date.now;
  w.cloud.terminate = async id => {
    active++; peak = Math.max(peak, active); calls.push(id);
    await Promise.resolve(); elapsed += 10;
    active--; throw new Error('pending');
  };
  Date.now = () => elapsed;
  try { await drainCleanup(w.d, 10); } finally { Date.now = realNow; }
  expect(peak).toBeLessThanOrEqual(4);
  expect(calls.length).toBe(4);
  expect(await hasCleanup(w.d)).toBe(true);
  const first = [...calls]; calls.length = 0;
  w.cloud.terminate = async id => { calls.push(id); await original(id); };
  w.advance(MIN);
  await drainCleanup(w.d, Date.now() + 1000);
  expect(first.includes(calls[0]!)).toBe(false);
  expect(await hasCleanup(w.d)).toBe(false);
});

test('per-call deadline aborts a stuck deletion and keeps its durable retry', async () => {
  const { markStopped, terminate } = await import('../api/_lib/compute/service.ts');
  const { hasCleanup } = await import('../api/_lib/compute/cleanup.ts');
  const w = await setup();
  const rows = await w.store.tx(t => markStopped(t, [], 'user', w.d.now()));
  expect(rows).toEqual([]);
  const r = await w.store.tx(async t => (await markStopped(t, await t.activeRentals(), 'user', w.d.now()))[0]!);
  let aborted = false;
  const driver = { ...w.cloud, name: 'fake', provision: w.cloud.provision.bind(w.cloud), list: w.cloud.list.bind(w.cloud),
    setPaidUntil: w.cloud.setPaidUntil.bind(w.cloud), terminate: async (_id: string, signal?: AbortSignal) => new Promise<void>(() => { signal!.addEventListener('abort', () => { aborted = true; }); }) };
  expect(await terminate({ ...w.d, driver: () => driver }, r, 10)).toBe(false);
  expect(aborted).toBe(true);
  expect(await hasCleanup(w.d)).toBe(true);
  expect((await w.store.tx(t => t.rental(w.id)))!.state).toBe('stopping');
});

test('zero-credit stops precede provider listing and launch work', async () => {
  const w = await setup();
  await w.store.tx(async t => { await t.addLedger({ account_id: w.account, kind: 'adjustment', amount_micros: -100_000_000, idem_key: idem(), created_at: w.d.now() }); });
  const events: string[] = [], terminate = w.cloud.terminate.bind(w.cloud), list = w.cloud.list.bind(w.cloud);
  w.cloud.terminate = async id => { events.push('terminate'); await terminate(id); };
  w.cloud.list = async () => { events.push('list'); return list(); };
  await tick(w.d);
  expect(events[0]).toBe('terminate');
  expect((await w.store.tx(t => t.rental(w.id)))!.end_reason).toBe('no_credit');
});

test('duplicate deletion retries survive later listings omitting the surplus instance', async () => {
  const w = await setup();
  const canonical = (await w.cloud.list())[0]!;
  const duplicate = w.cloud.plantOrphan({ ...canonical.tags });
  const terminate = w.cloud.terminate.bind(w.cloud);
  w.cloud.terminate = async id => { if (id === duplicate) throw new Error('pending'); await terminate(id); };
  await tick(w.d);
  w.cloud.list = async () => [canonical];
  w.cloud.terminate = terminate;
  w.advance(MIN); await tick(w.d);
  expect(w.cloud.state(duplicate)).toBe('terminated');
  expect(w.cloud.state(canonical.instance_id)).toBe('running');
});

test('an expired lease with unconfirmed deletion only closes its own lease', async () => {
  const { makeLease } = await import('../api/compute/lease.ts');
  const w = await setup();
  w.cloud.terminate = async () => { throw new Error('pending'); };
  w.advance(16 * MIN);
  const h = makeLease({ env: {}, compute: () => w.d, stripe: () => null });
  const response = await h(new Request('https://site.test/api/compute/lease', { method: 'POST', headers: { authorization: `Bearer ${w.token}` }, body: JSON.stringify({ rental_id: w.id }) }));
  expect(response.status).toBe(200);
  await tick(w.d);
  expect((await w.store.tx(t => t.rental(w.id)))!.state).toBe('stopping');
  expect(w.cloud.provisions).toHaveLength(1);
});

test('missing recorded provider alerts without stalling healthy provider cleanup', async () => {
  const w = await setup();
  await w.store.tx(t => t.setControl('providers', ['missing', 'fake']));
  w.advance(MIN); await tick(w.d);
  expect(w.logs.some(x => x.event === 'alert_provider_unavailable')).toBe(true);
  expect(await w.store.tx(t => t.control('last_tick'))).toBe(w.d.now());
});

test('unconfirmed expiry allows renewal of other leases in the next tick', async () => {
  const w = await setup(2);
  const rs = await w.store.tx(t => t.activeRentals());
  const healthy = rs[1]!;
  await w.store.tx(t => t.updateRental(healthy.id, { safety: { ...healthy.safety!, lease_until: w.d.now() + 25 * MIN } }));
  w.cloud.terminate = async () => { throw new Error('pending'); };
  w.advance(16 * MIN);
  await w.store.tx(t => t.updateRental(healthy.id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
  await tick(w.d);
  expect((await w.store.tx(t => t.rental(healthy.id)))!.safety!.lease_until).toBe(w.d.now() + 15 * MIN);
  expect((await w.store.tx(t => t.rental(w.id)))!.state).toBe('stopping');
});

test('stop requests remain recordable while unrelated cleanup is pending', async () => {
  const { makeStop } = await import('../api/compute/stop.ts');
  const { enqueueCleanup } = await import('../api/_lib/compute/cleanup.ts');
  const w = world(), a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 10_000_000);
  const r = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }], codes: codes(1), walkie_version: 'v0.2.0-pre.7' });
  await w.store.tx(t => enqueueCleanup(t, 'missing', 'surplus'));
  const h = makeStop({ env: {}, compute: () => w.d, stripe: () => null });
  const response = await h(new Request('https://site.test/api/compute/stop', { method: 'POST', headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ all: true }) }));
  expect(response.status).toBe(200);
  expect((await w.store.tx(t => t.rental(r.rentals[0]!.id)))!.state).toBe('ended');
});
