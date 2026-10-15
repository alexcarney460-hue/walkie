// Go-live fix round, lane A (REVIEW-codex.md P2-6): the DigitalOcean listing either returns every managed droplet or
// fails. A partial snapshot is never returned, because the tick's reconcile treats a recorded instance missing from
// the listing as vanished (and ends its rental) and cannot see orphans on pages it never read.
import { expect, test } from 'bun:test';
import { DigitalOceanDriver, type Fetch } from '../api/_lib/compute/digitalocean.ts';
import { DriverError } from '../api/_lib/compute/driver.ts';
import { createAccount, codes, fixtureTeam, fund, idem, MIN, world } from './compute-helpers.ts';
import { rent } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';

const TOKEN = 'dop_v1_' + '0'.repeat(64);
type Page = { droplets?: unknown; links?: unknown; meta?: unknown };
function pages(answer: (page: number) => Page): { fetch: Fetch; seen: number[] } {
  const seen: number[] = [];
  const fetch: Fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    seen.push(page);
    return Response.json(answer(page));
  };
  return { fetch, seen };
}
const droplet = (id: number) => ({ id, status: 'active', tags: ['walkie-managed', `walkie-rental:r_${id.toString(16).padStart(16, '0')}`] });
const next = (page: number) => ({ pages: { next: `https://api.digitalocean.com/v2/droplets?page=${page + 1}` } });

test('listing follows every page until DigitalOcean reports no next page', async () => {
  const { fetch, seen } = pages(page => page < 3
    ? { droplets: [droplet(page * 10), droplet(page * 10 + 1)], links: next(page), meta: { total: 5 } }
    : { droplets: [droplet(30)], links: {}, meta: { total: 5 } });
  const listed = await new DigitalOceanDriver(TOKEN, fetch).list();
  expect(listed.map(i => i.instance_id)).toEqual(['10', '11', '20', '21', '30']);
  expect(seen).toEqual([1, 2, 3]);
});

test('a listing that still has a next page at the page bound is rejected, not returned partially', async () => {
  const { fetch } = pages(page => ({ droplets: [droplet(page)], links: next(page), meta: { total: 1000 } }));
  const result = await new DigitalOceanDriver(TOKEN, fetch).list().then(() => 'returned', (err: unknown) => err);
  expect(result).toBeInstanceOf(DriverError);
  expect((result as DriverError).retryable).toBe(true);
});

test('a listing whose count disagrees with the reported total is rejected', async () => {
  const { fetch } = pages(() => ({ droplets: [droplet(1), droplet(2)], links: {}, meta: { total: 3 } }));
  await expect(new DigitalOceanDriver(TOKEN, fetch).list()).rejects.toBeInstanceOf(DriverError);
});

test('an empty page that still points to a next page is rejected', async () => {
  const { fetch } = pages(page => page === 1 ? { droplets: [droplet(1)], links: next(1), meta: { total: 2 } }
    : { droplets: [], links: next(page), meta: { total: 2 } });
  await expect(new DigitalOceanDriver(TOKEN, fetch).list()).rejects.toBeInstanceOf(DriverError);
});

test('a 200 answer without a droplets array is rejected instead of read as an empty account', async () => {
  const { fetch } = pages(() => ({ links: {}, meta: { total: 0 } }));
  await expect(new DigitalOceanDriver(TOKEN, fetch).list()).rejects.toBeInstanceOf(DriverError);
});

test('a rejected listing makes no absence inference: the running rental is kept', async () => {
  const w = world();
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 50_000_000);
  const r = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }],
    codes: codes(1, w.d.now()), walkie_version: 'v0.2.0-pre.17', idle_minutes: 1440 });
  await tick(w.d);
  const id = r.rentals[0]!.id;
  w.cloud.list = async () => { throw new DriverError('DigitalOcean listing incomplete', true); };
  for (let i = 0; i < 5; i++) {
    w.advance(MIN);
    await w.store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
    await tick(w.d);
  }
  const kept = (await w.store.tx(t => t.rental(id)))!;
  expect(kept.state).toBe('running');
  expect(kept.end_reason).toBeNull();
  expect(w.logs.some(x => x.event === 'alert_provider_unavailable')).toBe(true);
  expect(w.logs.some(x => x.event === 'alert_instance_vanished')).toBe(false);
});

// Round 2 (REVIEW-A-codex.md P1): a repeated page, a listing with no completion metadata, and an absence that only the
// listing claims.
test('a listing that repeats droplets across pages is rejected even when the count matches the total', async () => {
  const { fetch } = pages(page => page === 1
    ? { droplets: [droplet(1), droplet(2)], links: next(1), meta: { total: 4 } }
    : { droplets: [droplet(1), droplet(2)], links: {}, meta: { total: 4 } });
  await expect(new DigitalOceanDriver(TOKEN, fetch).list()).rejects.toBeInstanceOf(DriverError);
});

test('a listing without completion metadata (no links, no meta.total) is rejected', async () => {
  for (const page of [{ droplets: [droplet(1)] }, { droplets: [droplet(1)], links: {} }, { droplets: [droplet(1)], meta: { total: 1 } },
      { droplets: [droplet(1)], links: {}, meta: { total: '1' } }, { droplets: [{ id: 'x', tags: [] }], links: {}, meta: { total: 1 } }]) {
    const { fetch } = pages(() => page);
    await expect(new DigitalOceanDriver(TOKEN, fetch).list()).rejects.toBeInstanceOf(DriverError);
  }
});

test('the provider answers gone only with a definite 404 for that droplet', async () => {
  const answer = (status: number): Fetch => async (url) => {
    expect(url).toBe('https://api.digitalocean.com/v2/droplets/4242');
    return status === 200 ? Response.json({ droplet: { id: 4242, status: 'active' } }) : new Response(null, { status });
  };
  expect(await new DigitalOceanDriver(TOKEN, answer(404)).instanceGone('4242')).toBe(true);
  expect(await new DigitalOceanDriver(TOKEN, answer(200)).instanceGone('4242')).toBe(false);
  await expect(new DigitalOceanDriver(TOKEN, answer(500)).instanceGone('4242')).rejects.toBeInstanceOf(DriverError);
  await expect(new DigitalOceanDriver(TOKEN, answer(404)).instanceGone('42; rm')).rejects.toBeInstanceOf(DriverError);
});

async function launchedRental() {
  const w = world();
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 50_000_000);
  const r = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }],
    codes: codes(1, w.d.now()), walkie_version: 'v0.2.0-pre.17', idle_minutes: 1440 });
  await tick(w.d);
  const id = r.rentals[0]!.id;
  const keepAlive = () => w.store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
  await keepAlive();
  return { w, id, keepAlive };
}

test('a rental the listing omits but the provider still returns is kept, and the operator is alerted', async () => {
  const { w, id, keepAlive } = await launchedRental();
  w.cloud.list = async () => [];
  for (let i = 0; i < 4; i++) { w.advance(MIN); await keepAlive(); await tick(w.d); }
  const kept = (await w.store.tx(t => t.rental(id)))!;
  expect(kept.state).toBe('running');
  expect(kept.end_reason).toBeNull();
  expect(w.logs.some(x => x.event === 'alert_instance_vanished')).toBe(false);
  expect(w.logs.some(x => x.event === 'alert_provider_unavailable' && x.fields.rental === id)).toBe(true);
});

test('a rental whose droplet the provider confirms gone still ends as vanished', async () => {
  const { w, id, keepAlive } = await launchedRental();
  const instance = (await w.store.tx(t => t.rental(id)))!.instance_id!;
  await w.cloud.terminate(instance);
  for (let i = 0; i < 4; i++) { w.advance(MIN); await keepAlive(); await tick(w.d); }
  const ended = (await w.store.tx(t => t.rental(id)))!;
  expect(ended.state).toBe('ended');
  expect(ended.end_reason).toBe('launch_failed');
  expect(w.logs.some(x => x.event === 'alert_instance_vanished' && x.fields.rental === id)).toBe(true);
});
