// Lane H on a real Postgres (COMPUTE_TEST_DATABASE_URL: a throwaway database, schema reset per test; skipped with a
// message without it). Migration 7 adds the `lot` column and the `expire` kind; Tx.creditLots, rentalLotCharges and
// dueLotAccounts list exactly what MemoryStore lists; and the expiry flow (two ticks at once included) writes one expiry
// and hides expired credit on PgStore.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import { CREDIT_LIFETIME_MS } from '../api/_lib/compute/lots.ts';
import { state } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import type { ComputeStore, LedgerEntry } from '../api/_lib/compute/store.ts';
import { createAccount, fixtureTeam, fund, MIN, T0, world } from './compute-helpers.ts';

const url = process.env.COMPUTE_TEST_DATABASE_URL ?? null;
let sql: postgres.Sql | null = null;
beforeAll(() => { if (url) sql = postgres(url, { max: 10, onnotice: () => {} }); });
afterAll(async () => { await sql?.end({ timeout: 5 }); });

async function pg(): Promise<PgStore | null> {
  if (!sql) {
    process.stderr.write('compute-credit-expiry-pg: COMPUTE_TEST_DATABASE_URL unset; skipped\n');
    return null;
  }
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  const store = new PgStore(sql);
  await store.migrate();
  return store;
}

const A = 'ca_00000000000000a1', B = 'ca_00000000000000b2', C = 'ca_00000000000000c3';
const DAY = 24 * 60 * MIN;
const row = (account: string, kind: LedgerEntry['kind'], amount: number, key: string, created: number,
    extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ account_id: account, kind, amount_micros: amount, idem_key: key, created_at: created, ...extra });
const ROWS: readonly LedgerEntry[] = [
  row(A, 'purchase', 50_000_000, 'a-lot-1', T0, { ref: 'pi_a1', live: true }),
  row(A, 'adjustment', 20_000_000, 'a-lot-2', T0 - 5 * DAY),
  row(A, 'adjustment', -3_000_000, 'a-debit', T0 + 1),           // not a lot: a negative adjustment
  row(A, 'purchase', 10_000_000, 'a-lot-3', T0 - 70 * DAY),
  row(A, 'burn', -1_000_000, 'burn:r1:1', T0 + MIN, { rental_id: 'r1', lot: 'a-lot-1', live: true }),
  row(A, 'burn', -400_000, 'burn:r1:2', T0 + 2 * MIN, { rental_id: 'r1', lot: 'a-lot-1', live: true }),
  row(A, 'burn', -200_000, 'burn:r1:2:other', T0 + 2 * MIN, { rental_id: 'r1', lot: 'a-lot-2' }),
  row(A, 'refund', 300_000, 'refund:r1:paid', T0 + 3 * MIN, { rental_id: 'r1', lot: 'a-lot-1', live: true }),
  row(A, 'burn', -50_000, 'burn:r1:3', T0 + 4 * MIN, { rental_id: 'r1', live: true }),   // from no lot
  row(A, 'burn', -70_000, 'burn:r2:1', T0 + MIN, { rental_id: 'r2', lot: 'a-lot-2' }),
  row(A, 'expire', -10_000_000, 'expire:a-lot-3:1', T0 - 10 * DAY, { lot: 'a-lot-3' }),
  row(B, 'purchase', 200_000_000, 'b-lot-1', T0 - 61 * DAY),
  row(B, 'purchase', 50_000_000, 'b-lot-2', T0 - 61 * DAY),
  row(C, 'purchase', 50_000_000, 'c-lot-1', T0 - 65 * DAY),
  row(C, 'expire', 0, 'expire:c-lot-1:1', T0 - 5 * DAY, { lot: 'c-lot-1' }),
  row(C, 'adjustment', 5_000_000, 'c-lot-2', T0 - 62 * DAY),
];

async function seed(store: ComputeStore): Promise<void> {
  await store.tx(async t => {
    for (const [i, id] of [A, B, C].entries())
      await t.insertAccount({ id, team_id: '0123456789abcdef', token_hash: String(i).repeat(64), status: 'active', review: null, created_at: T0 });
    for (const e of ROWS) expect(await t.addLedger(e)).toBe(true);
  });
}
async function listings(store: ComputeStore) {
  return store.tx(async t => ({
    lots: await Promise.all([A, B, C].map(id => t.creditLots(id))),
    r1: [...await t.rentalLotCharges('r1', T0 + 3 * MIN)].sort((x, y) => `${x.live}${x.lot}`.localeCompare(`${y.live}${y.lot}`)),
    r1all: [...await t.rentalLotCharges('r1', Number.MAX_SAFE_INTEGER)].sort((x, y) => `${x.live}${x.lot}`.localeCompare(`${y.live}${y.lot}`)),
    due: await t.dueLotAccounts(T0 - CREDIT_LIFETIME_MS, 10),
    dueOne: await t.dueLotAccounts(T0 - CREDIT_LIFETIME_MS, 1),
    dueLater: await t.dueLotAccounts(T0, 10),
    balances: await Promise.all([A, B, C].map(async id => [await t.balance(id), await t.paidBalance(id)])),
  }));
}

test('migration 7: the lot column and the expire kind; an unknown kind is still refused', async () => {
  const store = await pg();
  if (!store) return;
  const cols = await sql!`SELECT column_name FROM information_schema.columns WHERE table_name = 'compute_ledger' AND column_name = 'lot'`;
  expect(cols).toHaveLength(1);
  await seed(store);
  const bad = await sql!`INSERT INTO compute_ledger (account_id, kind, amount_micros, idem_key, created_at)
    VALUES (${A}, 'gift', 1, 'bad-kind', 1)`.then(() => 'inserted', (e: { code?: string }) => e.code);
  expect(bad).toBe('23514');
  const indexes = (await sql!`SELECT indexname FROM pg_indexes WHERE tablename = 'compute_ledger'`).map(r => String(r.indexname));
  expect(indexes).toEqual(expect.arrayContaining(['compute_ledger_lots', 'compute_ledger_lot_expiries']));
});

test('creditLots, rentalLotCharges and dueLotAccounts: PgStore lists exactly what MemoryStore lists', async () => {
  const store = await pg();
  if (!store) return;
  const memory = new MemoryStore();
  await seed(memory);
  await seed(store);
  const expected = await listings(memory);
  expect(await listings(store)).toEqual(expected);
  // The fixture means something: attributed sums and expire counts, net charges per lot, and the sweep's order.
  expect(expected.lots[0]!.map(l => [l.id, l.attributed_micros, l.expire_rows])).toEqual([
    ['a-lot-1', -1_100_000, 0], ['a-lot-2', -270_000, 0], ['a-lot-3', -10_000_000, 1]]);
  expect(expected.r1).toEqual([{ lot: 'a-lot-2', live: false, charged: 200_000 }, { lot: 'a-lot-1', live: true, charged: 1_100_000 }]);
  expect(expected.r1all).toContainEqual({ lot: null, live: true, charged: 50_000 });
  // C's oldest unsettled lot (c-lot-2, 62 days) is older than B's (61 days); A's lot 3 is settled already.
  expect(expected.due).toEqual([C, B]);
  expect(expected.dueOne).toEqual([C]);
  expect(expected.dueLater).toEqual([C, B, A]);
});

test('the expiry flow on Postgres: two ticks at once write one expiry; state hides the expired lot', async () => {
  const store = await pg();
  if (!store) return;
  const w = world({ store });
  await store.tx(t => t.setControl('last_tick', T0));
  const a = (await createAccount(w.d, fixtureTeam)).account_id;
  await fund(store, a, 50_000_000, 'pg-lot');
  w.clock.now = T0 + CREDIT_LIFETIME_MS + MIN;
  await Promise.all([tick(w.d), tick(w.d)]);
  await tick(w.d);
  const rows = await sql!`SELECT idem_key, amount_micros, lot FROM compute_ledger WHERE kind = 'expire'`;
  expect(rows.map(r => [String(r.idem_key), Number(r.amount_micros), String(r.lot)])).toEqual([['expire:test:pg-lot:1', -50_000_000, 'test:pg-lot']]);
  const s = await state(w.d, a);
  expect([s.balance_micros, s.credit_lots, s.next_expiry_at]).toEqual([0, [], null]);
  expect(await store.tx(t => t.dueLotAccounts(w.d.now(), 10))).toEqual([]);
});
