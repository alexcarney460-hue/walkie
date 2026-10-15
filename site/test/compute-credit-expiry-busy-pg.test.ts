// Lane H round 2 on a real Postgres (REVIEW-pre17-codex.md P2-4; COMPUTE_TEST_DATABASE_URL: a throwaway database, schema
// reset per test; skipped with a message without it). PgStore.tx bounds a transaction's lock waits and statements
// (SET LOCAL), and the minute tick runs every transaction under those bounds: an account whose row another session holds
// costs the tick its lock bound per pass, not its deadline. The busy account is skipped by the billing pass, the expiry
// sweep and reconcile, and the tick still bills the others, renews their paid tags and retries their deletions.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import { parsePrivateConfig } from '../api/_lib/compute/private-config.ts';
import { CREDIT_LIFETIME_MS } from '../api/_lib/compute/lots.ts';
import { rentalTags } from '../api/_lib/compute/driver.ts';
import { stop } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { isBusy, type Rental } from '../api/_lib/compute/store.ts';
import { configJson, createAccount, fixtureTeam, rent, T0, world } from './compute-helpers.ts';
import { agentReq, MIN } from './compute-credit-expiry-helpers.ts';

const url = process.env.COMPUTE_TEST_DATABASE_URL ?? null;
let sql: postgres.Sql | null = null;
beforeAll(() => { if (url) sql = postgres(url, { max: 10, onnotice: () => {} }); });
afterAll(async () => { await sql?.end({ timeout: 5 }); });

async function pg(): Promise<PgStore | null> {
  if (!sql) {
    process.stderr.write('compute-credit-expiry-busy-pg: COMPUTE_TEST_DATABASE_URL unset; skipped\n');
    return null;
  }
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  const store = new PgStore(sql);
  await store.migrate();
  return store;
}

/** Holds a FOR UPDATE lock on one account row from another session until `release()`. */
async function holdAccount(id: string): Promise<{ release(): Promise<void> }> {
  let locked!: () => void, free!: () => void;
  const isLocked = new Promise<void>(r => { locked = r; });
  const freed = new Promise<void>(r => { free = r; });
  const holder = sql!.begin(async tx => {
    const s = tx as unknown as postgres.Sql; // the transaction's own connection (pg-store.ts casts it the same way)
    await s`SELECT id FROM compute_accounts WHERE id = ${id} FOR UPDATE`;
    locked();
    await freed;
  });
  await isLocked;
  return { release: async () => { free(); await holder; } };
}
const sleep = (ms: number) => new Promise<'hung'>(r => setTimeout(() => r('hung'), ms));
const A = 'ca_00000000000000a1';

test('PgStore.tx bounds lock waits per transaction: a held row fails fast as busy; without bounds nothing changes', async () => {
  const store = await pg();
  if (!store) return;
  await store.tx(t => t.insertAccount({ id: A, team_id: '00000000000000aa', token_hash: 'a'.repeat(64), status: 'active', review: null, created_at: T0 }));
  const held = await holdAccount(A);
  let waited: Promise<string | undefined> | null = null;
  try {
    const started = Date.now();
    const err = await store.tx(t => t.lockAccount(A), { lockTimeoutMs: 300, statementTimeoutMs: 5_000 }).catch((e: unknown) => e);
    expect(isBusy(err)).toBe(true);
    expect((err as { code?: string }).code).toBe('55P03');
    expect(Date.now() - started).toBeLessThan(3_000);
    // Without bounds a transaction still waits for the lock, as before.
    waited = store.tx(async t => (await t.lockAccount(A))?.id);
    expect(await Promise.race([waited, sleep(1_000)])).toBe('hung');
  } finally { await held.release(); }
  expect(await waited).toBe(A);
});

test('a blocked account costs the tick its lock bound, not its deadline: the others are billed, tags renewed, deletions retried', async () => {
  const store = await pg();
  if (!store) return;
  // `agent` runs on a real provider (paid tags, paid credit); `agent-xl` on FakeCloud. One FakeCloud plays both.
  const raw = JSON.parse(configJson({ cpu: 4, gpu: 16 }, {}, 'digitalocean')) as { tiers: Record<string, { provider: string }> };
  raw.tiers['agent-xl']!.provider = 'fake';
  const w = world({ store, config: parsePrivateConfig(JSON.stringify(raw)) });
  const d = { ...w.d, driver: (p: string) => (p === 'fake' || p === 'digitalocean' ? w.cloud : null) };
  await store.tx(t => t.setControl('last_tick', T0));
  const b = (await createAccount(d, fixtureTeam)).account_id;
  await store.tx(t => t.addLedger({ account_id: b, kind: 'purchase', amount_micros: 50_000_000, idem_key: 'stripe:cs_live_b',
    ref: 'pi_live_b', live: true, created_at: T0 }));
  const [tagged, deleting] = (await rent(d, b, agentReq(w.d.now(), 2))).rentals.map(r => r.id) as [string, string];
  const rental = (id: string) => store.tx(async t => (await t.rental(id)) as Rental);
  for (const id of [tagged, deleting])
    await store.tx(t => t.updateRental(id, { state: 'running', last_heartbeat_at: w.d.now(), last_busy_at: w.d.now() }));
  const tag = (await rental(tagged)).safety!;
  await store.tx(t => t.updateRental(tagged, { safety: { ...tag, tag_paid_until: w.d.now() + 10 * MIN, tag_retry_at: 0 } }));
  // The provider refuses the first deletion: the stop leaves the machine `stopping`, retried a minute later by the tick.
  const terminate = w.cloud.terminate.bind(w.cloud);
  let refused = 0;
  w.cloud.terminate = async (instance: string) => { if (refused++ === 0) throw new Error('provider busy'); return terminate(instance); };
  await stop(d, b, { rental_id: deleting });
  expect((await rental(deleting)).state).toBe('stopping');

  // Account A: an expired lot (the sweep's work), a running FakeCloud machine (the billing pass's and reconcile's work).
  const now = w.d.now(), rid = 'r_00000000000000a1';
  const { instance_id } = await w.cloud.provision({ idempotency_key: rid, instance_type: 'g-16vcpu-64gb', region: null, image: null,
    user_data: '', name: 'rent-agent-xl-a1', tags: { ...rentalTags(rid, '00000000000000aa', A), 'walkie:provider': 'fake', 'walkie:claim': rid } });
  await store.tx(async t => {
    await t.insertAccount({ id: A, team_id: '00000000000000aa', token_hash: 'a'.repeat(64), status: 'active', review: null, created_at: T0 });
    await t.addLedger({ account_id: A, kind: 'purchase', amount_micros: 10_000_000, idem_key: 'a-expired', created_at: now - CREDIT_LIFETIME_MS - MIN });
    await t.addLedger({ account_id: A, kind: 'purchase', amount_micros: 10_000_000, idem_key: 'a-lasting', created_at: now });
    await t.insertRental({ id: rid, account_id: A, team_id: '00000000000000aa', tier: 'agent-xl', name: 'rent-agent-xl-a1', state: 'running',
      price_per_hour_micros: 1_500_000, idle_minutes: 1440, created_at: now - 5 * MIN, ord: 0, walkie_version: 'v0.2.0-pre.17',
      needs_code_at: null, started_at: now - 5 * MIN, ended_at: null, end_reason: null, instance_id, heartbeat_hash: null,
      last_heartbeat_at: now, last_busy_at: now, gpu_hot_since: null, egress_bytes: 0, egress_billed_gib: 0, node_id: null,
      charged_micros: 0, billed_minutes: 0, launch_attempts: 1,
      safety: { provider: 'fake', reserved: 1_500_000, claim: 'confirmed', key: rid, lease_until: now + 10 * MIN } });
  });

  w.advance(61_000);
  const held = await holdAccount(A);
  const started = Date.now();
  const run = tick(d, { total: 12_000, cleanup: 4_000, call: 1_000 });
  const outcome = await Promise.race([run.then(() => 'done' as const), sleep(15_000)]);
  const took = Date.now() - started;
  await held.release();
  if (outcome === 'hung') await run.catch(() => undefined);
  expect(outcome).toBe('done');
  expect(took).toBeLessThan(9_000);
  // The safety work after the busy account still ran: paid tag renewed, deletion retried and confirmed, B billed.
  expect((await rental(tagged)).safety!.tag_paid_until).toBeGreaterThan(w.d.now() + 30 * MIN);
  expect((await rental(deleting)).state).toBe('ended');
  expect((await rental(tagged)).billed_minutes).toBeGreaterThanOrEqual(2);
  // A was skipped, not half-done: nothing written off, nothing billed, and each pass said so.
  expect(await store.tx(t => t.creditLots(A))).toContainEqual(expect.objectContaining({ id: 'a-expired', expire_rows: 0 }));
  expect((await rental(rid)).billed_minutes).toBe(0);
  // Round 4: one compute_account_busy per account per tick; every later pass of the tick (sweep, reconcile) skips A
  // without waiting again (tick-pass.ts).
  const busy = w.logs.filter(l => l.event === 'compute_account_busy');
  expect(busy.map(l => l.fields.account)).toEqual([A]);

  // Released: the next tick settles and bills A.
  w.advance(MIN);
  await tick(d);
  expect(await store.tx(t => t.creditLots(A))).toContainEqual(expect.objectContaining({ id: 'a-expired', expire_rows: 1 }));
  expect((await rental(rid)).billed_minutes).toBeGreaterThan(0);
}, 60_000);
