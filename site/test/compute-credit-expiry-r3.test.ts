// Lane H round 3 (REVIEW-pre17b-opus.md P2-1 + P3-1 + P3-3, REVIEW-pre17b-codex.md P2-1).
// - A busy account (its row held past the tick's lock bound) waits alone: the tick still records last_tick and launches
//   every other account's work; the busy account's own launches wait, and a run of busy passes raises an alert.
// - The first-hour rule also holds at the create: a capacity-retried launch whose only credit expires within its first
//   hour is ended unbilled instead of creating a machine (Opus's probe zz-launch-gap).
// - Cancelling waiting rentals checks paid credit for a real-provider rental (Opus mutant M05/S11).
// The busy account is simulated here (its lockAccount fails as Postgres does past lock_timeout, 55P03); the real lock
// waits are in compute-busy-flood-pg.test.ts.
import { describe, expect, test } from 'bun:test';
import { CREDIT_LIFETIME_MS } from '../api/_lib/compute/lots.ts';
import { parsePrivateConfig } from '../api/_lib/compute/private-config.ts';
import { rent as serviceRent } from '../api/_lib/compute/service.ts';
import { configJson, createAccount, fixtureTeam, rent, T0 } from './compute-helpers.ts';
import { account, agentReq, alive, buy, busyFor, MIN, rental, runAgent, secondTeam, tick, world } from './compute-credit-expiry-helpers.ts';

const T = T0 + CREDIT_LIFETIME_MS;

describe('a busy account waits alone', () => {
  /** Team A runs a machine and has just rented a second (claim pending); team B has just rented one (claim pending). */
  async function twoTeams() {
    const w = world({ quotas: { cpu: 8, gpu: 16 } });
    const a = await account(w);
    await buy(w, a, 50_000_000);
    const running = await runAgent(w, a);
    const b = await secondTeam(w.d);
    await buy(w, b.id, 50_000_000);
    w.advance(MIN);
    await w.store.tx(t => t.setControl('last_tick', w.d.now() - 1_000));
    await alive(w, running);
    const aPending = (await serviceRent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id;
    const bPending = (await serviceRent(w.d, b.id, { ...agentReq(w.d.now()), codes: [b.code()] })).rentals[0]!.id;
    return { w, a, b: b.id, running, aPending, bPending };
  }

  test('the tick records last_tick and launches the other team while account A is busy; A\'s own launch waits', async () => {
    const s = await twoTeams();
    let held: string | null = s.a;
    const d = { ...s.w.d, store: busyFor(s.w.store, id => id === held) };
    s.w.advance(MIN);
    const before = await s.w.store.tx(t => t.control('last_tick'));
    await tick(d);
    expect((await rental(s.w, s.bPending)).instance_id).not.toBeNull();
    expect(await s.w.store.tx(t => t.control('last_tick'))).toBe(s.w.d.now());
    expect(before).not.toBe(s.w.d.now());
    const mine = await rental(s.w, s.aPending);
    expect([mine.instance_id, mine.safety?.claim]).toEqual([null, 'pending']);
    expect((await rental(s.w, s.running)).billed_minutes).toBe(1); // A was not billed this pass
    expect(s.w.logs.filter(l => l.event === 'compute_account_busy').map(l => l.fields.account)).toContain(s.a);
    // Free again: the next tick bills A and launches its machine.
    held = null;
    await alive(s.w, s.running);
    s.w.advance(MIN);
    await tick(d);
    expect((await rental(s.w, s.aPending)).instance_id).not.toBeNull();
    expect((await rental(s.w, s.running)).billed_minutes).toBeGreaterThan(1);
  });

  test('busy for 3 passes in a row raises account_busy (its backlog stays visible); a billed pass clears the run', async () => {
    const s = await twoTeams();
    let held: string | null = s.a;
    const d = { ...s.w.d, store: busyFor(s.w.store, id => id === held) };
    const alerts = () => s.w.logs.filter(l => l.event === 'alert_account_busy');
    for (let i = 0; i < 2; i++) { s.w.advance(MIN); await tick(d); }
    expect(alerts()).toHaveLength(0);
    s.w.advance(MIN);
    await tick(d);
    expect(alerts().map(l => l.fields)).toEqual([{ account: s.a, attempts: 3 }]);
    held = null;
    await alive(s.w, s.running);
    s.w.advance(MIN);
    await tick(d);
    held = s.a;
    for (let i = 0; i < 2; i++) { s.w.advance(MIN); await tick(d); }
    expect(alerts()).toHaveLength(1); // the run started again at 1
    s.w.advance(MIN);
    await tick(d);
    // Round 4 (pre.17c review P3-4): the billed pass reset the run, so its third busy pass alerts again.
    expect(alerts().map(l => l.fields)).toEqual([{ account: s.a, attempts: 3 }, { account: s.a, attempts: 3 }]);
  });
});

describe('the first-hour rule at the create', () => {
  test('a launch the provider refused for capacity is not created once its only credit expires within its first hour', async () => {
    const w = world();
    const a = await account(w);
    await buy(w, a, 50_000_000, { at: T0 });
    w.clock.now = T - 61 * MIN;
    await w.store.tx(t => t.setControl('last_tick', w.d.now()));
    const id = (await serviceRent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id; // accepted: the lot lasts through the hour
    let refusals = 4;
    for (let m = 0; m < 75; m++) {
      const r = await rental(w, id);
      if (refusals > 0 && r.safety?.claim === 'pending' && (r.safety.capacity_retry_at ?? 0) <= w.d.now()) { w.cloud.failNext = 'capacity'; refusals--; }
      await tick(w.d);
      if ((await rental(w, id)).instance_id) await alive(w, id);
      if ((await rental(w, id)).state === 'ended') break;
      w.advance(MIN);
    }
    const r = await rental(w, id);
    expect([r.state, r.end_reason, r.instance_id, r.charged_micros]).toEqual(['ended', 'no_credit', null, 0]);
    // Refused at the first retry inside the last hour: one create was sent (refused for capacity), none after.
    expect(r.ended_at!).toBeLessThanOrEqual(T - 59 * MIN);
    expect(w.cloud.provisions.filter(p => p.tags['walkie:rental'] === id)).toHaveLength(1);
  });
});

describe('cancelling waiting rentals checks paid credit', () => {
  test('a queued real-provider rental is cancelled when only other-bucket credit lasts through its first hour', async () => {
    const raw = JSON.parse(configJson({ cpu: 1, gpu: 16 }, {}, 'digitalocean'));
    const w = world({ config: parsePrivateConfig(JSON.stringify(raw)) });
    const d = { ...w.d, driver: (p: string) => (p === 'digitalocean' ? w.cloud : null) };
    const a = (await createAccount(d, fixtureTeam)).account_id;
    await w.store.tx(t => t.addLedger({ account_id: a, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'stripe:cs_live_r3',
      ref: 'pi_live_r3', live: true, created_at: T0 }));
    await buy(w, a, 50_000_000, { at: T0 + 10 * 24 * 60 * MIN, kind: 'adjustment' }); // other bucket: never pays a real machine
    w.clock.now = T - 65 * MIN;
    await w.store.tx(t => t.setControl('last_tick', w.d.now()));
    const [first, queued] = (await rent(d, a, agentReq(w.d.now(), 2))).rentals.map(x => x.id) as [string, string];
    expect((await rental(w, queued)).state).toBe('queued');
    for (let i = 0; i < 6; i++) {
      await alive(w, first);
      w.advance(MIN);
      await tick(d);
    }
    const q = await rental(w, queued);
    expect([q.state, q.end_reason]).toEqual(['ended', 'no_credit']);
    expect((await rental(w, first)).state).toBe('running');
  });
});
