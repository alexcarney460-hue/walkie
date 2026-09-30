import { test, expect } from 'bun:test';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { sendAlert, alertFromLog } from '../api/_lib/compute/alerts.ts';
const env = { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixture-bot', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture-chat' };

test('durable rolling dedupe agrees across senders, allows a different key and expiry', async () => {
  const store = new MemoryStore(), calls: RequestInit[] = [];
  const fake = async (_: string, init?: RequestInit) => { calls.push(init!); return Response.json({ ok: true }); };
  let now = 100;
  const d = () => ({ store, env, now: () => now, fetch: fake, log: () => {} });
  await Promise.all(Array.from({ length: 8 }, () => sendAlert(d(), 'tick_stale', {})));
  expect(calls).toHaveLength(1);
  now += 1_799_999;
  await sendAlert(d(), 'tick_stale', {});
  expect(calls).toHaveLength(1);
  await sendAlert(d(), 'tick_recovered', {});
  now++;
  await sendAlert(d(), 'tick_stale', {});
  expect(calls).toHaveLength(3);
  expect(calls[0]?.redirect).toBe('error');
  expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
});
test('missing env logs only; network, API and store errors never escape', async () => {
  const store = new MemoryStore(); let calls = 0;
  const fake = async () => { calls++; throw new Error('fixture secret'); };
  const base = { store, now: () => 100, fetch: fake, log: () => {} };
  await sendAlert({ ...base, env: {} }, 'tick_stale', {});
  expect(calls).toBe(0);
  await expect(sendAlert({ ...base, env }, 'tick_stale', {})).resolves.toBeUndefined();
  await expect(sendAlert({ ...base, env, store: { tx: async () => { throw new Error('db'); } } }, 'tick_stale', {})).resolves.toBeUndefined();
  await expect(sendAlert({ ...base, env, log: () => { throw new Error('logger'); } }, 'tick_recovered', {})).resolves.toBeUndefined();
});
test('alerts allow only validated operational fields and fixed event names', async () => {
  const sent: string[] = [];
  await sendAlert({ store: new MemoryStore(), env, now: () => 1, log: () => {}, fetch: async (_, i) => {
    sent.push(i!.body as string); return Response.json({ ok: true });
  } }, 'launch_uncertain', { rental: 'r_0123456789abcdef', team: '0123456789abcdef', token: 'secret', reason: 'secret', instance: 'secret', cost_usd: 55 });
  expect(sent[0]).toContain('r_0123456789abcdef');
  expect(sent[0]).not.toContain('secret');
  expect(alertFromLog('stop', { reason: 'mining' })).toBe('mining_stop');
  expect(alertFromLog('stop', { reason: 'egress_cap' })).toBe('egress_cap_stop');
  expect(alertFromLog('credit_purchased', {})).toBeNull();
});
test('three-second timeout aborts a stalled fetch', async () => {
  let aborted = false;
  const started = Date.now();
  await sendAlert({ store: new MemoryStore(), env, now: () => 1, log: () => {}, fetch: async (_, init) =>
    new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('timeout')); }))
  }, 'tick_stale', {});
  expect(aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(4000);
}, 4500);

test('request wrapper drains rejected stale admission alerts and dedupes later requests', async () => {
  const { world, createAccount, idem, codes, fixtureTeam } = await import('./compute-helpers.ts');
  const { makeRent } = await import('../api/compute/rent.ts');
  const w = world(), a = await createAccount(w.d, fixtureTeam);
  w.advance(180_001);
  const sent: string[] = [];
  const handler = makeRent({ env: { ...env, COMPUTE_ENABLED: '1' }, compute: () => w.d, stripe: () => null,
    alertFetch: async (_, init) => { sent.push(init!.body as string); return Response.json({ ok: true }); } });
  for (let i = 0; i < 2; i++) {
    const response = await handler(new Request('https://fixture.test', { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }], codes: codes(1), walkie_version: 'v0.2.0-pre.5' }) }));
    expect(response.status).toBe(503);
  }
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('tick_stale');
});
test('config errors alert through a durable store even when compute cannot be constructed', async () => {
  const { makeHeartbeat } = await import('../api/compute/heartbeat.ts');
  const store = new MemoryStore(), sent: string[] = [];
  const handler = makeHeartbeat({ env: { ...env, COMPUTE_ENABLED: '1', CRON_SECRET: 'fixture' }, compute: () => null, alertStore: () => store,
    stripe: () => null, alertFetch: async (_, init) => { sent.push(init!.body as string); return Response.json({ ok: true }); } });
  for (let i = 0; i < 2; i++) expect((await handler(new Request('https://fixture.test', { headers: { authorization: 'Bearer fixture' } }))).status).toBe(503);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('config_invalid');
});
test('all required operational events are routed; non-operational logs are ignored', () => {
  for (const event of ['tick_stale', 'tick_recovered', 'termination_delayed', 'orphan_found', 'orphan_terminated', 'orphan_termination_failed',
    'launch_uncertain', 'account_frozen', 'config_invalid', 'provider_spend'] as const) expect(alertFromLog(event, {})).toBe(event);
  expect(alertFromLog('stop', { reason: 'idle' })).toBeNull();
});
test('UTC spend includes ended and uncertain rentals at stored cost, excludes fake and yesterday', async () => {
  const { world, createAccount, configJson, idem, codes, T0, fixtureTeam } = await import('./compute-helpers.ts');
  const { parsePrivateConfig } = await import('../api/_lib/compute/private-config.ts');
  const { rent } = await import('../api/_lib/compute/service.ts');
  const { checkProviderSpend } = await import('../api/_lib/compute/spend.ts');
  const w = world({ config: parsePrivateConfig(configJson(undefined, {}, 'digitalocean')) });
  const a = await createAccount(w.d, fixtureTeam);
  await w.store.tx(t => t.addLedger({ account_id: a.account_id, kind: 'purchase', live: true, amount_micros: 50_000_000, idem_key: idem(), created_at: T0 }));
  const r = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }], codes: codes(1), walkie_version: 'v0.2.0-pre.5' });
  const stored = (await w.store.tx(t => t.rental(r.rentals[0]!.id)))!;
  const day = Math.floor(T0 / 86_400_000) * 86_400_000;
  w.clock.now = day + 3_600_000;
  await w.store.tx(async t => {
    await t.updateRental(stored.id, { state: 'ended', started_at: day - 3_600_000, ended_at: w.clock.now, safety: { ...stored.safety!, cost_per_hour_micros: 51_000_000 } });
    await t.insertRental({ ...stored, id: 'r_1111111111111111', started_at: day, safety: { ...stored.safety!, claim: 'uncertain', cost_per_hour_micros: 1_000_000 } });
    await t.insertRental({ ...stored, id: 'r_2222222222222222', started_at: day, safety: { ...stored.safety!, provider: 'fake', cost_per_hour_micros: 999_000_000 } });
    await t.insertRental({ ...stored, id: 'r_3333333333333333', state: 'ended', started_at: day - 7_200_000, ended_at: day - 1 });
  });
  await checkProviderSpend(w.d);
  expect(w.logs.find(l => l.event === 'provider_spend')?.fields).toMatchObject({ cost_usd: 52, threshold_usd: 50 });
  w.logs.length = 0;
  await checkProviderSpend({ ...w.d, spendAlertUsdPerDay: 60 });
  expect(w.logs).toHaveLength(0);
});

test('invalid alert threshold reports config error without disabling billing or stop', async () => {
  const { computeFromEnv } = await import('../api/_lib/compute/handler.ts');
  const { configJson } = await import('./compute-helpers.ts');
  const d = await computeFromEnv({ COMPUTE_PRIVATE_CONFIG: configJson(), COMPUTE_ENABLED: '1',
    COMPUTE_HANDOVER_TOKEN_KEY: 'rent-fixture-handover-key-32-bytes', COMPUTE_ALERT_SPEND_USD_PER_DAY: 'invalid' }, new MemoryStore());
  expect(d?.spendAlertUsdPerDay).toBe(50);
  expect(d?.alertConfigInvalid).toBe(true);
});
test('API rejection logs only sanitized failure and remains deduped', async () => {
  const logs: string[] = [], store = new MemoryStore(); let calls = 0;
  const d = { store, env, now: () => 1, log: (event: string) => { logs.push(event); }, fetch: async () => {
    calls++; return Response.json({ ok: false, description: 'fixture-secret' });
  } };
  await sendAlert(d, 'tick_stale', {});
  await sendAlert(d, 'tick_stale', {});
  expect(calls).toBe(1);
  expect(logs).toContain('alert_delivery_failed');
  expect(logs.join(' ')).not.toContain('fixture-secret');
});
