import { test, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { makeWatchdogHeartbeat } from '../api/compute/watchdog-heartbeat.ts';
import { world, MIN } from './compute-helpers.ts';
import { tick } from '../api/_lib/compute/tick.ts';

test('watchdog heartbeat accepts only a fresh signed timestamp and stores the latest', async () => {
  const store = new MemoryStore(), now = Date.now(), secret = 'fixture-secret';
  const handler = makeWatchdogHeartbeat({ env: { COMPUTE_WATCHDOG_HMAC_SECRET: secret, COMPUTE_ENABLED: '1' }, compute: () => null,
    alertStore: () => store, stripe: () => null });
  const body = JSON.stringify({ ts: now });
  const req = (signature: string, payload = body) => new Request('https://site.test/api/compute/watchdog-heartbeat',
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-walkie-signature': signature }, body: payload });
  expect((await handler(req('a'.repeat(64)))).status).toBe(403);
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  expect((await handler(req(sig))).status).toBe(200);
  expect(await store.tx(t => t.control('last_watchdog_heartbeat'))).toBe(now);
  const stale = JSON.stringify({ ts: now - 30 * 60_000 });
  expect((await handler(req(createHmac('sha256', secret).update(stale).digest('hex'), stale))).status).toBe(403);
});

test('tick alerts when the host watchdog heartbeat is over twenty minutes old', async () => {
  const w = world();
  await w.store.tx(t => t.setControl('last_watchdog_heartbeat', w.clock.now - 21 * MIN));
  await tick(w.d);
  expect(w.logs.some(x => x.event === 'alert_watchdog_stale')).toBe(true);
});
