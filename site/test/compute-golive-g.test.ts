// Go-live builder G (REVIEW-merged-opus.md 3, 4, 8, 9 and 11; REVIEW-merged-codex.md 3 and 4):
// - the customer's spent_micros is what the ledger took from its credit, not egress it never paid;
// - an idle drained tick still finds and deletes a stray droplet;
// - a frozen account cannot open a credit checkout;
// - a DELETE that answers 404 is only taken as deleted once a GET also answers 404;
// - a CPU pegged for 10 minutes pages the operator (alert only: nothing stops, nothing is billed differently).
import { describe, expect, test } from 'bun:test';
import { codes, createAccount, fixtureTeam, fund, idem, MIN, world } from './compute-helpers.ts';
import { heartbeat, rent, state } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { GIB } from '../api/_lib/compute/catalog.ts';
import { DigitalOceanDriver } from '../api/_lib/compute/digitalocean.ts';
import { DriverError, TAG_ACCOUNT, TAG_MANAGED, TAG_RENTAL, TAG_TEAM } from '../api/_lib/compute/driver.ts';
import type { LedgerEntry, Rental } from '../api/_lib/compute/store.ts';
import { makeCredit } from '../api/compute/credit.ts';
import { RENTED_MACHINE_RELEASES } from '../api/_lib/compute/releases.ts';

const RELEASE = RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]!;
const ledger = (w: ReturnType<typeof world>) => (w.store as unknown as { state: { ledger: LedgerEntry[] } }).state.ledger;
/** What the ledger took from the customer's credit for one rental (burns net of refunds). */
const ledgerNet = (w: ReturnType<typeof world>, id: string) =>
  -ledger(w).filter(e => e.rental_id === id && (e.kind === 'burn' || e.kind === 'refund')).reduce((n, e) => n + e.amount_micros, 0);

async function running(fundMicros: number) {
  const w = world();
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, fundMicros);
  const r = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }], codes: codes(1, w.d.now()),
    walkie_version: RELEASE, idle_minutes: 1440 });
  const id = r.rentals[0]!.id;
  // The heartbeat token is readable only until the launch is confirmed (the first tick).
  const token = (await w.store.tx(t => t.rental(id)))!.safety!.heartbeat_token!;
  await tick(w.d);
  return { w, account: a.account_id, id, token };
}
const rental = (w: ReturnType<typeof world>, id: string) => w.store.tx(t => t.rental(id)) as Promise<Rental>;

describe('O3 / C3: spent_micros is what the credit paid', () => {
  test('after credit reaches zero on heavy egress, the view equals the ledger (PROBE A: was 4,012,500 vs 1,000,000)', async () => {
    const { w, account, id, token } = await running(1_000_000);
    await tick(w.d);
    w.advance(MIN);
    await heartbeat(w.d, { rental_id: id, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 50, egress_bytes: 200 * GIB });
    await tick(w.d);
    const s = await state(w.d, account);
    const row = await rental(w, id);
    expect(s.balance_micros).toBe(0);
    expect(row.safety?.unpaid_egress_micros ?? 0).toBeGreaterThan(0);
    expect(s.rentals.find(x => x.id === id)!.spent_micros).toBe(ledgerNet(w, id));
    expect(ledgerNet(w, id)).toBe(1_000_000);
  });

  test('with credit to spare the view still equals the ledger (minutes plus paid egress)', async () => {
    const { w, account, id, token } = await running(50_000_000);
    await tick(w.d);
    for (let i = 0; i < 3; i++) {
      w.advance(MIN);
      await heartbeat(w.d, { rental_id: id, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 50, egress_bytes: 3 * GIB * (i + 1) });
      await tick(w.d);
    }
    const s = await state(w.d, account);
    expect((await rental(w, id)).safety?.unpaid_egress_micros ?? 0).toBe(0);
    expect(s.rentals.find(x => x.id === id)!.spent_micros).toBe(ledgerNet(w, id));
  });
});

describe('O8: an idle drained tick reconciles stray droplets', () => {
  test('an orphan of a provider we rented on is deleted while drained and idle (PROBE B)', async () => {
    const w = world();
    const drained = { ...w.d, enabled: false };
    const orphan = w.cloud.plantOrphan({ [TAG_MANAGED]: '1', [TAG_RENTAL]: 'r_0000000000000000', [TAG_TEAM]: fixtureTeam, [TAG_ACCOUNT]: 'ca_0000000000000000' });
    await w.store.tx(t => t.setControl('providers', ['fake']));
    for (let i = 0; i < 5; i++) { w.advance(MIN); await tick(drained); }
    expect(w.cloud.state(orphan)).toBe('terminated');
    expect(await w.store.tx(t => t.control('last_tick'))).toBe(w.d.now());
    expect(w.cloud.provisions).toHaveLength(0);
  });
});

describe('O9: a frozen account cannot buy credit', () => {
  test('the credit route refuses with 403 account_frozen before any Stripe call (PROBE C)', async () => {
    const w = world();
    const a = await createAccount(w.d, fixtureTeam);
    await w.store.tx(t => t.setAccount(a.account_id, { status: 'frozen' }));
    const created: unknown[] = [];
    const handler = makeCredit({ env: { COMPUTE_ENABLED: '1' }, compute: () => w.d,
      stripe: () => ({ createCreditCheckout: async (p) => { created.push(p); return { url: 'https://checkout.stripe.test/x' }; } }) });
    const res = await handler(new Request('https://site.test/api/compute/credit', { method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ block: 50 }) }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_frozen' });
    expect(created).toHaveLength(0);
  });
});

describe('O11: a DELETE 4xx is confirmed with a GET', () => {
  const driver = (deleteStatus: number, getStatus: number) => {
    const calls: string[] = [];
    const d = new DigitalOceanDriver('x'.repeat(32), async (_url, init) => {
      calls.push(init.method ?? 'GET');
      if (init.method === 'DELETE') return deleteStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ id: 'x', message: 'm' }, { status: deleteStatus });
      return getStatus === 200 ? Response.json({ droplet: { id: 1, status: 'active' } }) : Response.json({ id: 'not_found' }, { status: getStatus });
    });
    return { d, calls };
  };

  test('DELETE 404 then GET 404: gone', async () => {
    const { d, calls } = driver(404, 404);
    await d.terminate('1');
    expect(calls).toEqual(['DELETE', 'GET']);
  });

  test('DELETE 404 while GET still finds the droplet: not confirmed, retried', async () => {
    const { d, calls } = driver(404, 200);
    const err = await d.terminate('1').catch(x => x);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.retryable).toBe(true);
    expect(calls).toEqual(['DELETE', 'GET']);
  });

  test('round 2: a repeat DELETE answering 422 whose GET says 404 is gone (billing stops at once)', async () => {
    const { d, calls } = driver(422, 404);
    await d.terminate('1');
    expect(calls).toEqual(['DELETE', 'GET']);
  });

  test('round 2: a DELETE 4xx whose GET still finds the droplet keeps today\'s retry (the DELETE\'s own error)', async () => {
    for (const status of [409, 422, 429]) {
      const { d, calls } = driver(status, 200);
      const err = await d.terminate('1').catch(x => x);
      expect(err).toBeInstanceOf(DriverError);
      expect(String(err.message)).toContain(`DigitalOcean ${status}`);
      expect(calls).toEqual(['DELETE', 'GET']);
    }
  });

  test('round 2: a DELETE 5xx keeps today\'s retry with no GET', async () => {
    const { d, calls } = driver(503, 404);
    const err = await d.terminate('1').catch(x => x);
    expect(err).toMatchObject({ retryable: true });
    expect(calls).toEqual(['DELETE']);
  });
});

describe('O4 / C4: a CPU pegged for 10 minutes pages the operator (alert only)', () => {
  const pegged = (w: ReturnType<typeof world>) => w.logs.filter(l => l.event === 'alert_cpu_pegged');

  test('an idle but pegged rental: once at the threshold, not before, again only after 30 minutes; it keeps running', async () => {
    const { w, account, id, token } = await running(500_000_000);
    await tick(w.d);
    const beat = (cpu: number) => heartbeat(w.d, { rental_id: id, token, busy_seats: 0, pool_jobs: 0, cpu_pct: cpu, egress_bytes: 0 });
    await beat(95);
    for (let i = 1; i < 10; i++) { w.advance(MIN); await beat(i % 2 ? 90 : 100); await tick(w.d); }
    expect(pegged(w)).toHaveLength(0);
    w.advance(MIN);
    await beat(97);
    expect(pegged(w)).toHaveLength(1);
    expect(pegged(w)[0]!.fields).toEqual({ rental: id, team: fixtureTeam, account });
    for (let i = 0; i < 29; i++) { w.advance(MIN); await beat(99); await tick(w.d); }
    expect(pegged(w)).toHaveLength(1);
    w.advance(MIN);
    await beat(99);
    await tick(w.d);
    expect(pegged(w)).toHaveLength(2);
    const r = await rental(w, id);
    expect(r.state).toBe('running');
    expect(r.end_reason).toBeNull();
    const s = await state(w.d, account);
    expect(s.status).toBe('active');
    expect((await w.store.tx(t => t.lockAccount(account)))!.review).toBeNull();
  });

  test('round 2: a busy rental pinned at 100% never alerts (Walkie agent work in the window)', async () => {
    const { w, id, token } = await running(500_000_000);
    await tick(w.d);
    for (let i = 0; i < 90; i++) {
      await heartbeat(w.d, { rental_id: id, token, busy_seats: i % 3 === 0 ? 1 : 0, pool_jobs: i % 3 === 1 ? 2 : 0, cpu_pct: 100, egress_bytes: 0 });
      // Every third heartbeat reports neither: still busy within the window, so the run never reaches 10 idle minutes.
      w.advance(MIN);
      await tick(w.d);
    }
    expect(pegged(w)).toHaveLength(0);
    expect((await rental(w, id)).state).toBe('running');
  });

  test('round 2: agent work inside the window restarts the 10 minutes', async () => {
    const { w, id, token } = await running(500_000_000);
    await tick(w.d);
    const beat = (busy: number) => heartbeat(w.d, { rental_id: id, token, busy_seats: busy, pool_jobs: 0, cpu_pct: 100, egress_bytes: 0 });
    for (let i = 0; i < 9; i++) { await beat(0); w.advance(MIN); }
    await beat(1);
    for (let i = 0; i < 10; i++) { w.advance(MIN); await beat(0); }
    expect(pegged(w)).toHaveLength(0);
    w.advance(MIN);
    await beat(0);
    expect(pegged(w)).toHaveLength(1);
  });

  test('a heartbeat below 90% restarts the 10 minutes', async () => {
    const { w, id, token } = await running(500_000_000);
    await tick(w.d);
    const beat = (cpu: number) => heartbeat(w.d, { rental_id: id, token, busy_seats: 0, pool_jobs: 0, cpu_pct: cpu, egress_bytes: 0 });
    for (let i = 0; i < 9; i++) { await beat(96); w.advance(MIN); }
    await beat(89);
    // A new run starts at the next heartbeat: 10 minutes after it, not after the first run began.
    for (let i = 0; i < 10; i++) { w.advance(MIN); await beat(96); }
    expect(pegged(w)).toHaveLength(0);
    w.advance(MIN);
    await beat(96);
    expect(pegged(w)).toHaveLength(1);
  });
});
