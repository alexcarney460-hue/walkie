// Go-live builder G round 4 (REVIEW-fixdiff-opus.md P2-3): a miner run inside a seat task makes an honest guest report
// agent work, so the idle-pegged `cpu_pegged` never sees it. The long-run variant `cpu_pegged_long` pages once a rental
// has stayed at or above 90% CPU for 60 minutes WHATEVER its agent work, at most once every 6 hours per rental. Alert
// only: the machine keeps running and nothing is billed differently. The 10-minute idle-pegged rule is unchanged.
import { describe, expect, test } from 'bun:test';
import { codes, createAccount, fixtureTeam, fund, idem, MIN, world } from './compute-helpers.ts';
import { heartbeat, rent, state } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { RENTED_MACHINE_RELEASES } from '../api/_lib/compute/releases.ts';
import type { Rental } from '../api/_lib/compute/store.ts';

const RELEASE = RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]!;
const HOUR = 60 * MIN;

async function running() {
  const w = world();
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 500_000_000);
  const r = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }], codes: codes(1, w.d.now()),
    walkie_version: RELEASE, idle_minutes: 1440 });
  const id = r.rentals[0]!.id;
  // The heartbeat token is readable only until the launch is confirmed (the first tick).
  const token = (await w.store.tx(t => t.rental(id)))!.safety!.heartbeat_token!;
  await tick(w.d);
  const beat = (cpu: number, busy = 1) => heartbeat(w.d, { rental_id: id, token, busy_seats: busy, pool_jobs: 0, cpu_pct: cpu, egress_bytes: 0 });
  return { w, account: a.account_id, id, beat };
}
const kind = (w: ReturnType<typeof world>, event: string) => w.logs.filter(l => l.event === `alert_${event}`);

describe('Opus P2-3: cpu_pegged_long sees a pegged CPU even while a seat task runs', () => {
  test('busy at 100%: none at 59 minutes, one at 60, the next only 6 hours later; the machine keeps running', async () => {
    const { w, account, id, beat } = await running();
    await beat(100);
    for (let m = 1; m <= 59; m++) { w.advance(MIN); await beat(m % 2 ? 90 : 100); await tick(w.d); }
    expect(kind(w, 'cpu_pegged_long')).toHaveLength(0);
    w.advance(MIN);
    await beat(100);
    expect(kind(w, 'cpu_pegged_long')).toHaveLength(1);
    expect(kind(w, 'cpu_pegged_long')[0]!.fields).toEqual({ rental: id, team: fixtureTeam, account });
    // 6 hours after that alert, minus a minute: nothing more.
    for (let m = 61; m < 60 + 6 * 60; m++) { w.advance(MIN); await beat(100); await tick(w.d); }
    expect(kind(w, 'cpu_pegged_long')).toHaveLength(1);
    w.advance(MIN);
    await beat(100);
    await tick(w.d);
    expect(kind(w, 'cpu_pegged_long')).toHaveLength(2);
    // Busy throughout: the idle-pegged rule never fired, and nothing stopped or changed the account.
    expect(kind(w, 'cpu_pegged')).toHaveLength(0);
    const r = await w.store.tx(t => t.rental(id)) as Rental;
    expect(r.state).toBe('running');
    expect(r.end_reason).toBeNull();
    expect((await state(w.d, account)).status).toBe('active');
    expect((await w.store.tx(t => t.lockAccount(account)))!.review).toBeNull();
  });

  test('a heartbeat below 90% restarts the 60 minutes', async () => {
    const { w, beat } = await running();
    for (let m = 0; m < 59; m++) { await beat(100); w.advance(MIN); }
    await beat(89);
    // A new run starts at the next heartbeat: 60 minutes after it, not after the first run began.
    for (let m = 0; m < 60; m++) { w.advance(MIN); await beat(100); }
    expect(kind(w, 'cpu_pegged_long')).toHaveLength(0);
    w.advance(MIN);
    await beat(100);
    expect(kind(w, 'cpu_pegged_long')).toHaveLength(1);
  });

  test('the 10-minute idle-pegged rule is unchanged, and a busy heartbeat does not restart the long window', async () => {
    const { w, beat } = await running();
    for (let m = 0; m < 10; m++) { await beat(100, 0); w.advance(MIN); }
    await beat(100, 0);
    expect(kind(w, 'cpu_pegged')).toHaveLength(1);
    // Agent work starts: the idle rule restarts, the long window does not.
    for (let m = 0; m < 49; m++) { w.advance(MIN); await beat(100, 1); }
    expect(kind(w, 'cpu_pegged_long')).toHaveLength(0);
    w.advance(MIN);
    await beat(100, 1);
    expect(kind(w, 'cpu_pegged_long')).toHaveLength(1);
    expect(kind(w, 'cpu_pegged')).toHaveLength(1);
  });
});
