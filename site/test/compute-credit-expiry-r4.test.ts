// Lane H round 4 (REVIEW-pre17c-opus.md P2-1, P3-1, P3-2, P3-4, P3-5; REVIEW-pre17c-codex.md P2-1), MemoryStore with a
// simulated busy account (its lockAccount fails as Postgres does past lock_timeout). The real lock waits are in
// compute-credit-expiry-r4-pg.test.ts.
// - compute_busy is a 429: refused before anything was recorded, so a client drops the request (no duplicate rental).
// - The rent's lock bound stays below the tick's, so one rent cannot make its own account busy.
// - Every account-row pass of the tick waits alone on a busy account: lease expiry (deferred), launches and the queue.
// - Every active account busy (two or more: only a site-wide lock does that) records no healthy tick; one busy account
//   alone does (it waits alone and alerts, as round 3).
// - The busy count drops an account that left the active set.
import { describe, expect, test } from 'bun:test';
import { TICK_LOCK_MS } from '../api/_lib/compute/tick-pass.ts';
import { RENT_LOCK_MS, rent as serviceRent } from '../api/_lib/compute/service.ts';
import { LEASE_MS } from '../api/_lib/compute/lease.ts';
import { account, agentReq, alive, buy, busyFor, hooked, MIN, rental, runAgent, secondTeam, tick, world } from './compute-credit-expiry-helpers.ts';

/** Team A runs a machine; team B runs one too; each has just rented another (claim pending). */
async function twoBusyable() {
  const w = world({ quotas: { cpu: 8, gpu: 16 } });
  const a = await account(w);
  await buy(w, a, 50_000_000);
  const aRunning = await runAgent(w, a);
  const b = await secondTeam(w.d);
  await buy(w, b.id, 50_000_000);
  const bRunning = (await serviceRent(w.d, b.id, { ...agentReq(w.d.now()), codes: [b.code()] })).rentals[0]!.id;
  await tick(w.d);
  await alive(w, aRunning);
  await alive(w, bRunning);
  w.advance(MIN);
  await tick(w.d);
  const aPending = (await serviceRent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id;
  const bPending = (await serviceRent(w.d, b.id, { ...agentReq(w.d.now()), codes: [b.code()] })).rentals[0]!.id;
  return { w, a, b: b.id, aRunning, bRunning, aPending, bPending };
}
const events = (w: ReturnType<typeof world>, event: string) => w.logs.filter(l => l.event === event);

describe('compute_busy and the rent lock bound', () => {
  test('a rent whose account row is busy answers 429 compute_busy with retry_after_s and records nothing', async () => {
    const w = world();
    const a = await account(w);
    await buy(w, a, 50_000_000);
    const req = agentReq(w.d.now());
    const err = await serviceRent({ ...w.d, store: busyFor(w.store, id => id === a) }, a, req).catch(e => e);
    expect([err.status, err.code, err.extra]).toEqual([429, 'compute_busy', { retry_after_s: 5 }]);
    expect(await w.store.tx(t => t.rentRequest(a, req.idempotency_key))).toBeNull();
    expect(await w.store.tx(t => t.rentals(a, 50))).toEqual([]);
  });

  test('the rent waits less for a lock than the tick does, so a rent alone cannot make its account busy', () => {
    expect(RENT_LOCK_MS).toBeLessThan(TICK_LOCK_MS);
  });
});

describe('every account-row pass waits alone on a busy account', () => {
  test('an expired lease of a busy account is deferred, not waited on: the tick records last_tick and launches B', async () => {
    const s = await twoBusyable();
    s.w.advance(LEASE_MS + MIN); // nobody renewed A's lease: it has lapsed
    for (const id of [s.bRunning]) await alive(s.w, id);
    await s.w.store.tx(async t => {
      const r = (await t.rental(s.bRunning))!;
      await t.updateRental(s.bRunning, { safety: { ...r.safety!, lease_until: s.w.d.now() + LEASE_MS } });
    });
    await s.w.store.tx(t => t.setControl('last_tick', s.w.d.now() - 1_000));
    const d = { ...s.w.d, store: busyFor(s.w.store, id => id === s.a) };
    await tick(d);
    expect(await s.w.store.tx(t => t.control('last_tick'))).toBe(s.w.d.now());
    expect((await rental(s.w, s.bPending)).instance_id).not.toBeNull();
    const ar = await rental(s.w, s.aRunning);
    expect([ar.state, ar.end_reason]).toEqual(['running', null]); // deferred to the next free pass
    expect(events(s.w, 'lease_expiry_deferred').map(l => [l.fields.account, l.fields.rental])).toEqual([[s.a, s.aRunning]]);
    // Free again: the next pass stops it as an expired lease, billed only to the lease's end.
    s.w.advance(MIN);
    await tick(s.w.d);
    const stopped = await rental(s.w, s.aRunning);
    expect(stopped.end_reason).toBe('heartbeat_lost');
    expect(stopped.safety!.billing_until).toBe(ar.safety!.lease_until);
  });

  test('an account that turns busy after its billing pass: its launch and its queued work wait; B\'s go on', async () => {
    const s = await twoBusyable();
    let heldNow = false;
    // A's row is taken right after A's billing pass (by a request, say) and held for the rest of the tick.
    const d = { ...s.w.d, store: busyFor(hooked(s.w.store, (m, args) => {
      if (m === 'setControl' && args[0] === 'billing_cursor' && args[1] === s.a) heldNow = true;
    }), id => heldNow && id === s.a) };
    await alive(s.w, s.aRunning);
    await alive(s.w, s.bRunning);
    s.w.advance(MIN);
    await tick(d);
    expect((await rental(s.w, s.bPending)).instance_id).not.toBeNull();
    const mine = await rental(s.w, s.aPending);
    expect([mine.instance_id, mine.safety?.claim]).toEqual([null, 'pending']);
    expect(await s.w.store.tx(t => t.control('last_tick'))).toBe(s.w.d.now());
    expect(events(s.w, 'compute_account_busy').map(l => l.fields.account)).toContain(s.a);
  });
});

describe('when every active account is busy', () => {
  test('two or more active accounts, all busy (a site-wide lock): no healthy tick is recorded, and tick_stale follows', async () => {
    const s = await twoBusyable();
    const d = { ...s.w.d, store: busyFor(s.w.store, () => true) };
    const before = await s.w.store.tx(t => t.control('last_tick'));
    for (let i = 0; i < 4; i++) { s.w.advance(MIN); await tick(d); }
    expect(await s.w.store.tx(t => t.control('last_tick'))).toBe(before);
    expect(events(s.w, 'alert_tick_stale').length).toBeGreaterThan(0);
    expect(events(s.w, 'alert_tick_recovered')).toEqual([]);
  });

  test('one active account, busy: it waits alone (its own traffic must not stall other teams) and alerts after 3 passes', async () => {
    const w = world();
    const a = await account(w);
    await buy(w, a, 50_000_000);
    await runAgent(w, a);
    const d = { ...w.d, store: busyFor(w.store, id => id === a) };
    for (let i = 0; i < 3; i++) { w.advance(MIN); await tick(d); }
    expect(await w.store.tx(t => t.control('last_tick'))).toBe(w.d.now());
    expect(events(w, 'alert_account_busy').map(l => l.fields)).toEqual([{ account: a, attempts: 3 }]);
  });
});

describe('the busy count', () => {
  test('an account that leaves the active set while busy loses its count: its next busy run alerts at its third pass', async () => {
    const s = await twoBusyable();
    let held = true;
    const d = { ...s.w.d, store: busyFor(s.w.store, id => held && id === s.a) };
    for (let i = 0; i < 2; i++) { s.w.advance(MIN); await tick(d); }
    // A's machines end while it is busy (a site-side stop recorded elsewhere); A is no longer active.
    for (const id of [s.aRunning, s.aPending])
      await s.w.store.tx(t => t.updateRental(id, { state: 'ended', ended_at: s.w.d.now(), end_reason: 'user' }));
    s.w.advance(MIN);
    await tick(d);
    expect(await s.w.store.tx(t => t.control('compute-busy-accounts'))).toBeFalsy();
    held = false;
    const again = (await serviceRent(s.w.d, s.a, agentReq(s.w.d.now()))).rentals[0]!.id;
    expect(again).toBeTruthy();
    held = true;
    for (let i = 0; i < 3; i++) { s.w.advance(MIN); await tick(d); }
    expect(events(s.w, 'alert_account_busy').map(l => l.fields)).toEqual([{ account: s.a, attempts: 3 }]);
  });
});
