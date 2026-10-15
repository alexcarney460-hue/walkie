// Go-live fix round, lane A (REVIEW-opus.md P2-9, coordinator follow-up): a failed boot is refunded, but a team cannot
// farm free droplet time by making boots fail on purpose (revoking or expiring the join code, turning the authority
// machine off). After BOOT_REFUNDS_PER_DAY refunded boot failures in 24 hours, a team's further boot failures are
// charged as metered, and the operator is alerted.
import { expect, test } from 'bun:test';
import { codes, createAccount, fixtureTeam, fund, idem, MIN, world, type World } from './compute-helpers.ts';
import { heartbeat, rent } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { BOOT_REFUNDS_PER_DAY } from '../api/_lib/compute/billing.ts';
import type { Rental } from '../api/_lib/compute/store.ts';

async function failedBoot(w: World, account: string): Promise<Rental> {
  const r = await rent(w.d, account, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }],
    codes: codes(1, w.d.now()), walkie_version: 'v0.2.0-pre.17' });
  const id = r.rentals[0]!.id;
  const token = (await w.store.tx(t => t.rental(id)))!.safety!.heartbeat_token!;
  await tick(w.d);
  w.advance(4 * MIN);
  await heartbeat(w.d, { rental_id: id, token, bootstrap_failed: true, busy_seats: 0, pool_jobs: 0, cpu_pct: 0, egress_bytes: 0 });
  await tick(w.d);
  return (await w.store.tx(t => t.rental(id)))!;
}

test('boot-failure refunds stop after the daily cap for a team, and the operator is alerted', async () => {
  const w = world();
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 50_000_000);
  const capped = () => w.logs.filter(x => x.event === 'alert_boot_refund_capped');
  const outcomes: Rental[] = [];
  for (let i = 0; i < BOOT_REFUNDS_PER_DAY + 2; i++) outcomes.push(await failedBoot(w, a.account_id));
  for (const r of outcomes) {
    expect(r.state).toBe('ended');
    expect(r.end_reason).toBe('boot_timeout');
  }
  const refunded = outcomes.slice(0, BOOT_REFUNDS_PER_DAY), charged = outcomes.slice(BOOT_REFUNDS_PER_DAY);
  for (const r of refunded) expect(r.charged_micros).toBe(0);
  for (const r of charged) expect(r.charged_micros).toBeGreaterThan(0);
  const spent = charged.reduce((n, r) => n + r.charged_micros, 0);
  expect(await w.store.tx(t => t.balance(a.account_id))).toBe(50_000_000 - spent);
  expect(capped()).toHaveLength(2);
  expect(capped()[0]!.fields).toMatchObject({ team: fixtureTeam, account: a.account_id, rental: charged[0]!.id });

  // The window is a rolling 24 hours: the next day's first failed boot is refunded again.
  w.advance(24 * 60 * MIN);
  await w.store.tx(t => t.setControl('last_tick', w.d.now()));
  const later = await failedBoot(w, a.account_id);
  expect(later.charged_micros).toBe(0);
  expect(capped()).toHaveLength(2);
});
