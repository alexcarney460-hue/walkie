// Lane H round 4 on a real Postgres (REVIEW-pre17c-codex.md P2-1, REVIEW-pre17c-opus.md P3-2, P3-3, P3-5;
// COMPUTE_TEST_DATABASE_URL: a throwaway database, schema reset per test; skipped with a message without it).
// - A row held through lease expiry and into the launch pass: every pass waits at most its bound, the expired lease is
//   deferred, last_tick is written and the other team's machine launches; released, the lease is stopped.
// - A row taken after its account's billing pass: the queue waits at most its bound and skips it; the other team's
//   queued machine moves on.
// - state() reads one snapshot: a billing write committed between its reads never tears balance against spent.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import { LEASE_MS } from '../api/_lib/compute/lease.ts';
import { rent as serviceRent, state, stop } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import type { Rental } from '../api/_lib/compute/store.ts';
import { createAccount, fixtureTeam, T0, world } from './compute-helpers.ts';
import { agentReq, hooked, MIN, secondTeam } from './compute-credit-expiry-helpers.ts';

const url = process.env.COMPUTE_TEST_DATABASE_URL ?? null;
let sql: postgres.Sql | null = null;
beforeAll(() => { if (url) sql = postgres(url, { max: 20, onnotice: () => {} }); });
afterAll(async () => { await sql?.end({ timeout: 5 }); });

async function pg(): Promise<PgStore | null> {
  if (!sql) {
    process.stderr.write('compute-credit-expiry-r4-pg: COMPUTE_TEST_DATABASE_URL unset; skipped\n');
    return null;
  }
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  const store = new PgStore(sql);
  await store.migrate();
  return store;
}
const sleep = (ms: number) => new Promise<'hung'>(r => setTimeout(() => r('hung'), ms));
const BUDGET = { total: 12_000, cleanup: 4_000, call: 1_000 };

/** Holds a FOR UPDATE on one account row from another session until `release()`. */
async function hold(account: string): Promise<{ release(): Promise<void> }> {
  let locked!: () => void, free!: () => void;
  const isLocked = new Promise<void>(r => { locked = r; });
  const freed = new Promise<void>(r => { free = r; });
  const holder = sql!.begin(async tx => {
    const s = tx as unknown as postgres.Sql;
    await s`SELECT id FROM compute_accounts WHERE id = ${account} FOR UPDATE`;
    locked();
    await freed;
  });
  await isLocked;
  return { release: async () => { free(); await holder; } };
}

/** Team A and team B each run one machine; `cpu` is the shared quota. */
async function teams(store: PgStore, cpu = 8) {
  const w = world({ store, quotas: { cpu, gpu: 16 } });
  await store.tx(t => t.setControl('last_tick', T0));
  const a = (await createAccount(w.d, fixtureTeam)).account_id;
  await store.tx(t => t.addLedger({ account_id: a, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'r4-a', created_at: w.d.now() }));
  const b = await secondTeam(w.d, 'r4-b');
  await store.tx(t => t.addLedger({ account_id: b.id, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'r4-b', created_at: w.d.now() }));
  const aRunning = (await serviceRent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id;
  const bRunning = (await serviceRent(w.d, b.id, { ...agentReq(w.d.now()), codes: [b.code()] })).rentals[0]!.id;
  await tick(w.d);
  const rental = (id: string) => store.tx(async t => (await t.rental(id)) as Rental);
  const beat = async (...ids: string[]) => { for (const id of ids)
    await store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() })); };
  await beat(aRunning, bRunning);
  return { w, a, b, aRunning, bRunning, rental, beat };
}

test('a row held through lease expiry and into the launch pass: bounded, the lease deferred, last_tick written, B launches', async () => {
  const store = await pg();
  if (!store) return;
  const s = await teams(store);
  // A also has a machine being deleted (the provider refused the first try): the cleanup pass must still delete it.
  const aStopping = (await serviceRent(s.w.d, s.a, agentReq(s.w.d.now()))).rentals[0]!.id;
  await tick(s.w.d);
  await s.beat(s.aRunning, s.bRunning, aStopping);
  const terminate = s.w.cloud.terminate.bind(s.w.cloud);
  let refusals = 1;
  s.w.cloud.terminate = async (instance: string) => { if (refusals-- > 0) throw new Error('provider busy'); return terminate(instance); };
  await stop(s.w.d, s.a, { rental_id: aStopping });
  const stoppingInstance = (await s.rental(aStopping)).instance_id!;
  expect([(await s.rental(aStopping)).state, s.w.cloud.state(stoppingInstance)]).toEqual(['stopping', 'running']);
  const bPending = (await serviceRent(s.w.d, s.b.id, { ...agentReq(s.w.d.now()), codes: [s.b.code()] })).rentals[0]!.id;
  const aPending = (await serviceRent(s.w.d, s.a, agentReq(s.w.d.now()))).rentals[0]!.id;
  // A's lease has lapsed (its billing was skipped while busy); B's is current.
  s.w.advance(LEASE_MS + MIN);
  await s.beat(s.bRunning);
  const br = await s.rental(s.bRunning);
  await store.tx(t => t.updateRental(s.bRunning, { safety: { ...br.safety!, lease_until: s.w.d.now() + LEASE_MS } }));
  await store.tx(t => t.setControl('last_tick', s.w.d.now() - 1_000));
  const held = await hold(s.a);
  const started = Date.now();
  const run = tick(s.w.d, BUDGET);
  const outcome = await Promise.race([run.then(() => 'done' as const), sleep(15_000)]);
  const took = Date.now() - started;
  const lastTick = await store.tx(t => t.control('last_tick'));
  const bLaunched = (await s.rental(bPending)).instance_id;
  const aAfter = await s.rental(s.aRunning), aPend = await s.rental(aPending);
  await held.release();
  if (outcome === 'hung') await run.catch(() => undefined);
  expect(outcome).toBe('done');
  expect(took).toBeLessThan(9_000);
  expect(lastTick).toBe(s.w.d.now());
  expect(bLaunched).not.toBeNull();
  expect([aAfter.state, aAfter.end_reason]).toEqual(['running', null]);
  expect([aPend.state, aPend.instance_id, aPend.safety?.claim]).toEqual(['starting', null, 'pending']);
  expect(s.w.logs.filter(l => l.event === 'lease_expiry_deferred').map(l => l.fields.rental)).toEqual([s.aRunning]);
  // The busy account's machine was still deleted at the provider; only its record waited.
  expect(s.w.cloud.state(stoppingInstance)).toBe('terminated');
  // Released: the next pass stops A's lapsed lease, billed to the lease's end only.
  s.w.advance(MIN);
  await tick(s.w.d);
  const stopped = await s.rental(s.aRunning);
  expect(stopped.end_reason).toBe('heartbeat_lost');
  expect(stopped.safety!.billing_until).toBe(aAfter.safety!.lease_until);
  expect((await s.rental(aStopping)).state).toBe('ended');
}, 60_000);

test('a row taken right before its own launch: the launch waits at most its bound and is left for the next pass; B launches', async () => {
  const store = await pg();
  if (!store) return;
  const s = await teams(store);
  const aPending = (await serviceRent(s.w.d, s.a, agentReq(s.w.d.now()))).rentals[0]!.id;
  const bPending = (await serviceRent(s.w.d, s.b.id, { ...agentReq(s.w.d.now()), codes: [s.b.code()] })).rentals[0]!.id;
  const teamA = (await s.rental(aPending)).team_id;
  let billedBoth = 0, held: { release(): Promise<void> } | null = null;
  // After both billing passes, A's row is taken when the launch pass checks A's team (launchFrozen), just before its create.
  const store2 = hooked(store, async (m, args) => {
    if (m === 'setControl' && args[0] === 'billing_cursor') billedBoth++;
    if (!held && billedBoth >= 2 && m === 'control' && args[0] === `enrollment-fork:${teamA}`) held = await hold(s.a);
  });
  s.w.advance(MIN);
  await s.beat(s.aRunning, s.bRunning);
  const run = tick({ ...s.w.d, store: store2 }, BUDGET);
  const outcome = await Promise.race([run.then(() => 'done' as const), sleep(15_000)]);
  const after = { a: await s.rental(aPending), b: await s.rental(bPending), last: await store.tx(t => t.control('last_tick')) };
  await (held as { release(): Promise<void> } | null)?.release();
  if (outcome === 'hung') await run.catch(() => undefined);
  expect(held).not.toBeNull();
  expect(outcome).toBe('done');
  expect([after.a.state, after.a.instance_id, after.a.safety?.claim]).toEqual(['starting', null, 'pending']);
  expect(after.last).toBe(s.w.d.now());
  // Released: the next pass launches A's machine.
  s.w.advance(MIN);
  await tick(s.w.d);
  expect((await s.rental(aPending)).instance_id).not.toBeNull();
  expect(after.b.instance_id).not.toBeNull();
}, 60_000);

test('a row taken right after its billing pass: the queue waits at most its bound and skips it; B\'s queued machine moves', async () => {
  const store = await pg();
  if (!store) return;
  // Quota 2, both slots B's; A only has a queued machine (so no earlier pass of the tick touches A's row), older than B's.
  const w = world({ store, quotas: { cpu: 2, gpu: 16 } });
  await store.tx(t => t.setControl('last_tick', T0));
  const a = (await createAccount(w.d, fixtureTeam)).account_id;
  await store.tx(t => t.addLedger({ account_id: a, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'r4q-a', created_at: w.d.now() }));
  const b = await secondTeam(w.d, 'r4q-b');
  await store.tx(t => t.addLedger({ account_id: b.id, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'r4q-b', created_at: w.d.now() }));
  const [b1, b2] = (await serviceRent(w.d, b.id, { ...agentReq(w.d.now(), 2), codes: [b.code(), b.code()] })).rentals.map(r => r.id) as [string, string];
  await tick(w.d);
  const rental = (id: string) => store.tx(async t => (await t.rental(id)) as Rental);
  const beat = async (...ids: string[]) => { for (const id of ids)
    await store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() })); };
  await beat(b1, b2);
  w.advance(1);
  const aQueued = (await serviceRent(w.d, a, agentReq(w.d.now()))).rentals[0]!.id;
  w.advance(1);
  const bQueued = (await serviceRent(w.d, b.id, { ...agentReq(w.d.now()), codes: [b.code()] })).rentals[0]!.id;
  expect([(await rental(aQueued)).state, (await rental(bQueued)).state]).toEqual(['queued', 'queued']);
  // B's second machine ends, freeing one slot: on the next tick A's queued machine (older) would take it.
  await w.cloud.terminate((await rental(b2)).instance_id!);
  await store.tx(t => t.updateRental(b2, { state: 'ended', ended_at: w.d.now(), end_reason: 'user' }));
  let held: { release(): Promise<void> } | null = null;
  const store2 = hooked(store, async (m, args) => {
    if (!held && m === 'setControl' && args[0] === 'billing_cursor' && args[1] === a) held = await hold(a);
  });
  w.advance(MIN);
  await beat(b1);
  const run = tick({ ...w.d, store: store2 }, BUDGET);
  const outcome = await Promise.race([run.then(() => 'done' as const), sleep(15_000)]);
  const states = [(await rental(aQueued)).state, (await rental(bQueued)).state];
  await (held as { release(): Promise<void> } | null)?.release();
  if (outcome === 'hung') await run.catch(() => undefined);
  expect(held).not.toBeNull();
  expect(outcome).toBe('done');
  // A waits (its row is held); B's machine, behind it in the queue, is not held back by it.
  expect(states).toEqual(['queued', 'needs_code']);
  expect(w.logs.filter(l => l.event === 'compute_account_busy').map(l => l.fields.account)).toEqual([a]);
}, 60_000);

test('state() reads one snapshot: a billing write committed between its reads never tears balance against spent', async () => {
  const store = await pg();
  if (!store) return;
  const s = await teams(store);
  s.w.advance(MIN);
  await s.beat(s.aRunning);
  await tick(s.w.d);
  const before = await state(s.w.d, s.a);
  const lot = (await store.tx(t => t.creditLots(s.a)))[0]!.id;
  let armed = true;
  // Right after state() read the rentals, a billing write for one more minute commits on another connection.
  const store2 = hooked(store, async (m) => {
    if (!armed || m !== 'rentals') return;
    armed = false;
    await store.tx(async t => {
      await t.lockAccount(s.a);
      const r = (await t.rental(s.aRunning))!;
      await t.addLedger({ account_id: s.a, kind: 'burn', amount_micros: -12_500, idem_key: 'r4-torn', rental_id: r.id, lot,
        created_at: s.w.d.now() });
      await t.updateRental(r.id, { charged_micros: r.charged_micros + 12_500, billed_minutes: r.billed_minutes + 1 });
    });
  });
  const seen = await state({ ...s.w.d, store: store2 }, s.a);
  expect(armed).toBe(false);
  const sum = (v: typeof seen) => v.balance_micros + v.rentals.reduce((n, r) => n + r.spent_micros, 0);
  expect(sum(seen)).toBe(sum(before));
  expect(sum(await state(s.w.d, s.a))).toBe(sum(before)); // the write itself kept the invariant
  expect(sum(before)).toBe(50_000_000);
}, 60_000);
