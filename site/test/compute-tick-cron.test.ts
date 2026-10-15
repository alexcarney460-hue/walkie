// Go-live fix round, lane A: the tick is registered as a Vercel minute cron with a function limit that fits its
// internal budget (REVIEW-opus.md P1-1, REVIEW-codex.md P1-3), and it finishes inside that budget with several slow
// cleanup jobs due.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createAccount, codes, fixtureTeam, fund, idem, MIN, world } from './compute-helpers.ts';
import { markStopped, rent } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { ALERT_MS, CALL_MS, TICK_BUDGET, TICK_MAX_DURATION_S, TICK_MS } from '../api/_lib/compute/budget.ts';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  crons?: { path: string; schedule: string }[]; functions: Record<string, { maxDuration?: number }>;
};

test('vercel.json runs /api/compute/tick every minute with a dedicated limit that fits the tick budget', () => {
  expect(vercel.crons).toEqual([{ path: '/api/compute/tick', schedule: '* * * * *' }]);
  const keys = Object.keys(vercel.functions);
  // The specific entry precedes the catch-all glob (as in 8ea93e43), which keeps every other function at 10 s.
  expect(keys.indexOf('api/compute/tick.ts')).toBeGreaterThanOrEqual(0);
  expect(keys.indexOf('api/compute/tick.ts')).toBeLessThan(keys.indexOf('api/**/*.ts'));
  expect(vercel.functions['api/**/*.ts']!.maxDuration).toBe(10);
  // Round 2 (lane B handoff): the compute webhook resolves charges through Stripe, so it gets 15 s, also ahead of the
  // glob (Vercel applies the first matching key: vercel CLI getFunction uses keys.find).
  expect(vercel.functions['api/compute/webhook.ts']!.maxDuration).toBe(15);
  expect(keys.indexOf('api/compute/webhook.ts')).toBeGreaterThanOrEqual(0);
  expect(keys.indexOf('api/compute/webhook.ts')).toBeLessThan(keys.indexOf('api/**/*.ts'));
  expect(vercel.functions['api/compute/tick.ts']!.maxDuration).toBe(TICK_MAX_DURATION_S);
  // Work budget, then alert delivery, plus one provider call of slack for store latency, all inside the limit.
  expect(TICK_BUDGET.total).toBe(TICK_MS);
  expect(TICK_MS + ALERT_MS + CALL_MS).toBeLessThanOrEqual(TICK_MAX_DURATION_S * 1000);
  // Both cleanup drains and the tag sync fit in the work budget, so billing and the health record are always reached.
  expect(TICK_BUDGET.cleanup * 2 + TICK_BUDGET.call).toBeLessThanOrEqual(TICK_MS);
});

test('several slow due cleanup jobs cannot push the tick past its budget or skip billing and health', async () => {
  const w = world();
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 100_000_000);
  const r = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 7 }],
    codes: codes(7, w.d.now()), walkie_version: 'v0.2.0-pre.17', idle_minutes: 1440 });
  await tick(w.d);
  const ids = r.rentals.map(x => x.id);
  for (const id of ids) await w.store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
  // Six machines are stopping (six due cleanup jobs); the provider hangs on every delete until the budget aborts it.
  await w.store.tx(async t => {
    await t.lockAccount(a.account_id);
    const stopping = [];
    for (const id of ids.slice(1)) stopping.push((await t.rental(id))!);
    await markStopped(t, stopping, 'user', w.d.now());
  });
  w.cloud.terminate = () => new Promise<void>(() => {});
  w.advance(2 * MIN);
  const budget = { total: 900, cleanup: 200, call: 100 };
  const started = Date.now();
  const report = await tick(w.d, budget);
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(budget.total + 600);
  expect(report.terminated).toBe(0);
  // The safety pass still ran: the healthy machine was billed and the tick recorded its health.
  expect((await w.store.tx(t => t.rental(ids[0]!)))!.billed_minutes).toBe(2);
  expect(await w.store.tx(t => t.control('last_tick'))).toBe(w.d.now());
  // Nothing was lost: every stop is still pending and will be retried.
  for (const id of ids.slice(1)) expect((await w.store.tx(t => t.rental(id)))!.state).toBe('stopping');
  expect(((await w.store.tx(t => t.control('cleanup_jobs'))) as unknown[]).length).toBe(6);
});
