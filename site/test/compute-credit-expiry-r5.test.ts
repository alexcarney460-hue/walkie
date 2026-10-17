// Lane H round 5 (REVIEW-pre17d-opus.md P2-1): a paid lease that lapsed unrenewed (a tick outage, or a busy account
// whose expiry pass was deferred) bills the customer only to the lease's end, whichever path ends the rental. The
// provider time after it is booked operator-funded and alerted when the rental ends. MemoryStore, one test per capped
// path, plus the unchanged rule that a customer's own stop while its lease is current pays its deletion tail.
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { makeWatchdogHeartbeat } from '../api/compute/watchdog-heartbeat.ts';
import { LEASE_MS } from '../api/_lib/compute/lease.ts';
import { priceOfMinutes, startedMinutes } from '../api/_lib/compute/money.ts';
import { stop } from '../api/_lib/compute/service.ts';
import { T0 } from './compute-helpers.ts';
import { account, AGENT, buy, MIN, rental, runAgent, tick, world } from './compute-credit-expiry-helpers.ts';

/** One agent machine, launched at T0 and billed through its first minutes; its lease then lapses unrenewed. */
async function lapsedLease() {
  const w = world();
  const a = await account(w);
  await buy(w, a, 50_000_000, { at: T0 });
  const id = await runAgent(w, a);
  const leaseEnd = (await rental(w, id)).safety!.lease_until!;
  expect(leaseEnd).toBe(T0 + LEASE_MS);
  return { w, a, id, leaseEnd };
}
const funded = (w: ReturnType<typeof world>, id: string) => w.logs.filter(l => l.event === 'alert_operator_funded' && l.fields.rental === id);

describe('a lapsed lease bills only to its end, whichever path ends the rental', () => {
  test('the owner stops it after the lapse (no tick ran meanwhile): billed to the lease end; the tail operator-funded, alerted', async () => {
    const { w, a, id, leaseEnd } = await lapsedLease();
    w.advance(22 * MIN + 30_000); // the lease ended at minute 15; no tick renewed or expired it
    await stop(w.d, a, { rental_id: id });
    const r = await rental(w, id);
    expect(r.state).toBe('ended');
    expect(r.safety!.billing_until).toBe(leaseEnd);
    expect(r.charged_micros).toBe(priceOfMinutes(AGENT, startedMinutes(r.started_at!, leaseEnd)));
    expect(r.safety!.unpaid_micros).toBe(priceOfMinutes(AGENT, r.billed_minutes) - r.charged_micros);
    expect(r.safety!.unpaid_micros).toBeGreaterThan(0);
    expect(funded(w, id)).toHaveLength(1);
  });

  test('the watchdog deleted it after the lapse: billed to the lease end, not to the deletion; the tail operator-funded, alerted', async () => {
    const { w, id, leaseEnd } = await lapsedLease();
    w.advance(20 * MIN);
    const r0 = await rental(w, id);
    await w.store.tx(t => t.setControl('watchdog_deletions', { [r0.instance_id!]: w.d.now() }));
    await w.cloud.terminate(r0.instance_id!);
    w.advance(MIN);
    await tick(w.d);
    const r = await rental(w, id);
    expect([r.state, r.end_reason]).toEqual(['ended', 'watchdog_expired']);
    expect(r.charged_micros).toBe(priceOfMinutes(AGENT, startedMinutes(r.started_at!, leaseEnd)));
    expect(r.safety!.unpaid_micros).toBeGreaterThan(0);
    expect(funded(w, id)).toHaveLength(1);
  });

  test('the watchdog heartbeat route reports the deletion after the lapse: billed to the lease end; the tail operator-funded, alerted', async () => {
    const { w, id, leaseEnd } = await lapsedLease();
    await w.store.tx(t => t.updateRental(id, { instance_id: '7' })); // the route takes the provider's numeric droplet ids
    w.advance(20 * MIN);
    const secret = 'fixt' + 'ure-watchdog-secret';
    const body = JSON.stringify({ ts: Date.now(), deleted: [{ id: 7, at: w.d.now() }] });
    const res = await makeWatchdogHeartbeat({ env: { COMPUTE_WATCHDOG_HMAC_SECRET: secret, COMPUTE_ENABLED: '1' }, compute: () => w.d,
      stripe: () => null })(new Request('https://site.test/api/compute/watchdog-heartbeat', { method: 'POST', body,
      headers: { 'x-walkie-signature': createHmac('sha256', secret).update(body).digest('hex') } }));
    expect(res.status).toBe(200);
    const r = await rental(w, id);
    expect([r.state, r.end_reason]).toEqual(['ended', 'watchdog_expired']);
    expect(r.charged_micros).toBe(priceOfMinutes(AGENT, startedMinutes(r.started_at!, leaseEnd)));
    expect(r.safety!.unpaid_micros).toBe(priceOfMinutes(AGENT, r.billed_minutes) - r.charged_micros);
    expect(r.safety!.unpaid_micros).toBeGreaterThan(0);
    expect(funded(w, id)).toHaveLength(1);
  });

  /** The owner stops while the lease is current (renewed at minute 5, to minute 20); the provider refuses every delete. */
  async function stoppedWhileCurrent() {
    const { w, a, id } = await lapsedLease();
    w.advance(5 * MIN);
    await tick(w.d); // renews the lease to minute 20
    const leaseEnd = (await rental(w, id)).safety!.lease_until!;
    expect(leaseEnd).toBe(T0 + 20 * MIN);
    const terminate = w.cloud.terminate.bind(w.cloud);
    const refusals = { left: Infinity };
    w.cloud.terminate = async (instance: string) => { if (refusals.left-- > 0) throw new Error('provider busy'); return terminate(instance); };
    await stop(w.d, a, { rental_id: id });
    expect((await rental(w, id)).state).toBe('stopping');
    return { w, id, leaseEnd, refusals };
  }

  test('unchanged: stopped while the lease is current, deleted after its end: the deletion tail stays the customer\'s', async () => {
    const { w, id, leaseEnd, refusals } = await stoppedWhileCurrent();
    refusals.left = 5; // retries back off 1, 2, 4, 8, 16 minutes: the delete lands well after the lease's end
    for (let i = 0; i < 45 && (await rental(w, id)).state !== 'ended'; i++) { w.advance(MIN); await tick(w.d); }
    const r = await rental(w, id);
    expect(r.state).toBe('ended');
    expect(r.ended_at!).toBeGreaterThan(leaseEnd + 10 * MIN);
    expect(r.safety!.billing_until).toBeUndefined();
    expect(r.charged_micros).toBe(priceOfMinutes(AGENT, r.billed_minutes));
    expect(r.billed_minutes).toBeGreaterThan(startedMinutes(r.started_at!, leaseEnd));
    expect(funded(w, id)).toEqual([]);
  });

  test('unchanged: stopped while the lease is current, then the watchdog deleted it after the lease end: the customer\'s', async () => {
    const { w, id, leaseEnd } = await stoppedWhileCurrent();
    w.advance(25 * MIN); // to minute 30, ten past the lease end, with no tick: nothing billed the stopping machine meanwhile
    const r0 = await rental(w, id);
    expect(r0.state).toBe('stopping');
    const deletedAt = w.d.now();
    expect(deletedAt).toBeGreaterThan(leaseEnd);
    await w.store.tx(t => t.setControl('watchdog_deletions', { [r0.instance_id!]: deletedAt }));
    w.advance(MIN);
    await tick(w.d);
    const r = await rental(w, id);
    expect([r.state, r.end_reason]).toEqual(['ended', 'watchdog_expired']);
    expect(r.safety!.billing_until).toBeUndefined();
    expect(r.charged_micros).toBe(priceOfMinutes(AGENT, startedMinutes(r.started_at!, deletedAt)));
    expect(funded(w, id)).toEqual([]);
  });
});
