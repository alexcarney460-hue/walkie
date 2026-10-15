// Lane C round 12 on a real Postgres (COMPUTE_TEST_DATABASE_URL: a throwaway local database; skipped with a message
// without it). REVIEW-r11-codex P2-3: bind, backfill and a first enrollment are forced through both orderings of the
// team lock (the waiting side is seen waiting in pg_locks before the holder goes on), and the final binding record and
// the enrollment decision are checked. Also: two backfill loops on two pools (REVIEW-r11-opus P2 1), the operator's
// locked SQL trim in both orderings against a bind (P3 3), and a bind against an unmigrated database (P3 1a).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import * as C from './rent6-fixtures.ts';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import type { ComputeStore, Tx } from '../api/_lib/compute/store.ts';
import { BACKFILL_KEY, backfillLicenceBindings, bindingsKey } from '../api/_lib/compute/licence-records.ts';
import type { SubscriptionLite } from '../api/_lib/stripe.ts';

const url = process.env.COMPUTE_TEST_DATABASE_URL ?? null;
let sql: postgres.Sql | null = null;
const pools: PgStore[] = [];
beforeAll(() => {
  if (!url) return;
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw Error('test database must be local');
  sql = postgres(url, { max: 4, onnotice: () => {} });
});
afterAll(async () => {
  for (const pool of pools) await pool.end();
  await sql?.end({ timeout: 5 });
});
/** A connection pool of its own: another serverless instance. */
const pool = (): PgStore => {
  const store = new PgStore(postgres(url!, { max: 3, prepare: false, onnotice: () => {} }));
  pools.push(store);
  return store;
};
if (!url) process.stderr.write('compute-licence-records-pg: COMPUTE_TEST_DATABASE_URL unset; skipped\n');
const pgTest = url ? test : test.skip;
let migrated: Promise<void> | null = null;
async function ready(): Promise<void> {
  migrated ??= (async () => { await pool().migrate(); })();
  await migrated;
}

const gate = () => { let open!: () => void; const opened = new Promise<void>(r => { open = r; }); return { opened, open }; };
/** Resolves once `count` sessions wait for an advisory lock: the others really are blocked behind the holder. */
async function someoneWaits(count = 1): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [row] = await sql!`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
    if ((row?.n ?? 0) >= count) return;
    await Bun.sleep(10);
  }
  throw Error(`fewer than ${count} sessions wait for the team lock`);
}
/** `store`, but the first time its transaction takes `key` (the team lock) it calls `before`, then `after` while holding it. */
function hooked(store: PgStore, key: string, hooks: { before?: () => Promise<void>; after?: () => Promise<void> }): ComputeStore {
  let fired = false;
  const around = async (k: string, take: () => Promise<void>) => {
    const mine = k === key && !fired;
    if (mine) { fired = true; await hooks.before?.(); }
    await take();
    if (mine) await hooks.after?.();
  };
  const wrap = (t: Tx): Tx => ({ ...t, lockControl: k => around(k, () => t.lockControl(k)),
    lockTeamBind: k => around(k, () => t.lockTeamBind(k)) });
  return new Proxy(store, { get(target, prop) {
    if (prop === 'tx') return <T>(fn: (t: Tx) => Promise<T>) => target.tx(t => fn(wrap(t)));
    const value = Reflect.get(target, prop) as unknown;
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  } }) as ComputeStore;
}

/** One team: its founder F presents first; licences live in a MockStripe whose search lags (finds nothing). */
function scene(name: string, enrollStore: ComputeStore) {
  const w = C.world(), t = C.mkTeam(`${name}-${Math.random().toString(36).slice(2, 8)}`), stripe = new C.LH.MockStripe();
  const signer = C.LH.testKeypair(), env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1' });
  w.d.store = enrollStore;
  w.d.verifyLicense = C.licenseVerifier(stripe);
  w.d.teamLicences = async () => [] as SubscriptionLite[];
  w.d.licenceById = async (lic: string) => stripe.getSubscription(lic);
  const tag = t.team.slice(0, 8);
  const lic = (n: string, bound = false) => {
    const id = `sub_${n}${tag}`;
    stripe.subs.set(id, C.LH.subscription({ id, metadata: bound ? { walkie_team: t.team } : {} }));
    return id;
  };
  const bind = async (id: string, store: ComputeStore, bindEnv: typeof env = env) => {
    const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7, email: 'lead@kestrel.test',
      interval: 'month', issued_at: C.T0, expires_at: C.T0 + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
    const res = await C.makeBind({ ...C.LH.deps(stripe, bindEnv), computeStore: () => store, now: () => w.clock.now })(
      new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: t.team }) }));
    return { status: res.status, body: await res.json() as { renewal_token?: string; error?: string } };
  };
  const firstEnrollment = (extra: object = {}) => C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis, [], extra))
    .then(() => 'ok', (e: { code?: string; message: string }) => e.code ?? e.message);
  const backfill = (store: ComputeStore) => backfillLicenceBindings(store, stripe, { now: () => w.clock.now, budgetMs: 10_000, restart: true });
  const record = async () => ((await enrollStore.tx(x => x.control(bindingsKey(t.team)))) ?? undefined) as
    { subscriptions: string[]; overflow?: boolean } | undefined;
  const enrolled = async () => (await enrollStore.tx(x => x.enrollment(t.team)))?.key;
  const { COMPUTE_ENABLED: _on, ...drained } = env;
  return { w, t, stripe, env, drained, lic, bind, firstEnrollment, backfill, record, enrolled, lock: `enrollment-chain:${t.team}` };
}
const markerSet = (store: ComputeStore) => store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 }));

pgTest('a bind against an unmigrated database is refused before Stripe: 503 licence_store_required', async () => {
  await sql!`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql!`CREATE SCHEMA public`;
  const empty = pool(), s = scene('pg-v0', empty), id = s.lic('V');
  for (const bindEnv of [s.drained, s.env]) {
    const res = await s.bind(id, empty, bindEnv);
    expect([res.status, res.body.error]).toEqual([503, 'licence_store_required']);
  }
  expect(s.stripe.calls.metadata).toEqual([]);
  await ready();
}, 30_000);

pgTest('bind against first enrollment, both lock orderings: whoever holds the team lock decides, nothing is lost', async () => {
  await ready();
  // Bind first: X (the founder, no credentials) read an empty record, then waits behind the bind of L.
  const a = scene('pg-bind-first', pool()), l = a.lic('L'), held = gate(), locked = gate();
  await markerSet(a.w.d.store);
  const bound = a.bind(l, hooked(pool(), a.lock, { after: async () => { locked.open(); await held.opened; } }));
  await locked.opened;
  const x = a.firstEnrollment();
  await someoneWaits();
  held.open();
  expect((await bound).status).toBe(200);
  expect(await x).toBe('team_ownership_required'); // a licence was recorded after X's reads: only its holder may enroll
  expect((await a.record())?.subscriptions).toEqual([l]);
  expect(a.stripe.subs.get(l)!.metadata.walkie_team).toBe(a.t.team);
  expect(await a.enrolled()).toBeUndefined();
  // Enrollment first: X holds the team lock with no licence known, and the released daemon's bind of L waits.
  const b = scene('pg-enroll-first', pool()), l2 = b.lic('L'), held2 = gate(), locked2 = gate();
  b.w.d.store = hooked(pool(), b.lock, { after: async () => { locked2.open(); await held2.opened; } });
  const x2 = b.firstEnrollment();
  await locked2.opened;
  const bound2 = b.bind(l2, pool());
  await someoneWaits();
  held2.open();
  expect(await x2).toBe('ok'); // a Free team at its decision: the first presenter
  expect(await bound2).toEqual({ status: 409, body: { error: 'update_walkie_to_bind_license' } });
  expect(b.stripe.subs.get(l2)!.metadata.walkie_team).toBeUndefined(); // never bound to the enrolled team
  expect((await b.record())?.subscriptions).toEqual([l2]); // recorded as an id that tried (harmless: not bound)
}, 30_000);

pgTest('backfill against first enrollment during a re-scan, both lock orderings', async () => {
  await ready();
  // The marker is set but the record lacks L (a re-scan after a restore). Backfill first: X read before the backfill
  // recorded L and locks after it: refused.
  const a = scene('pg-backfill-first', pool()), l = a.lic('P', true), before = gate(), reached = gate();
  await markerSet(a.w.d.store);
  a.w.d.store = hooked(pool(), a.lock, { before: async () => { reached.open(); await before.opened; } });
  const x = a.firstEnrollment();
  await reached.opened; // X has read (nothing recorded) and is about to lock
  expect(await a.backfill(pool())).toMatchObject({ complete: true });
  before.open();
  expect(await x).toBe('team_ownership_required');
  expect((await a.record())?.subscriptions).toEqual([l]);
  // Enrollment first: X holds the team lock, the backfill waits to record L. X is decided on the record as it stood
  // (no licence known): the known re-scan exposure (C-FINAL round 12 residuals). The initial backfill cannot meet this
  // ordering, because every first enrollment answers 503 until its marker is set.
  const b = scene('pg-enroll-first-backfill', pool()), l2 = b.lic('P', true), held = gate(), locked = gate();
  await markerSet(b.w.d.store);
  b.w.d.store = hooked(pool(), b.lock, { after: async () => { locked.open(); await held.opened; } });
  const x2 = b.firstEnrollment();
  await locked.opened;
  const filled = b.backfill(pool());
  await someoneWaits();
  held.open();
  expect(await x2).toBe('ok');
  expect(await filled).toMatchObject({ complete: true });
  expect((await b.record())?.subscriptions).toEqual([l2]);
}, 30_000);

pgTest('bind against backfill on one team record, both lock orderings: both ids kept', async () => {
  await ready();
  for (const first of ['bind', 'backfill'] as const) {
    const s = scene(`pg-record-${first}`, pool()), old = s.lic('O', true), fresh = s.lic('N'), held = gate(), locked = gate();
    await markerSet(s.w.d.store);
    const hold = { after: async () => { locked.open(); await held.opened; } };
    const one = first === 'bind' ? s.bind(fresh, hooked(pool(), s.lock, hold)) : s.backfill(hooked(pool(), s.lock, hold));
    await locked.opened;
    const two = first === 'bind' ? s.backfill(pool()) : s.bind(fresh, pool());
    await someoneWaits();
    held.open();
    await Promise.all([one, two]);
    expect({ first, ids: (await s.record())?.subscriptions }).toEqual({ first, ids: [old, fresh].sort() });
  }
}, 30_000);

// Codex r12 P2-3: all three actors against one team at once, on three pools. The holder pauses right after taking the
// team lock; the other two are seen waiting in pg_locks before it goes on. A re-scan (the marker set, the pre-flip
// licence P not yet recorded), so that the first enrollment is decided under the lock rather than refused up front.
pgTest('bind, backfill and first enrollment on one team at once, three pools, each one holding the team lock first', async () => {
  await ready();
  for (const holder of ['enrollment', 'bind', 'backfill'] as const) {
    const s = scene(`pg-three-${holder}`, pool()), p = s.lic('P', true), n = s.lic('N'), held = gate(), locked = gate();
    await markerSet(s.w.d.store);
    const hold = { after: async () => { locked.open(); await held.opened; } };
    if (holder === 'enrollment') s.w.d.store = hooked(pool(), s.lock, hold);
    const bindStore = holder === 'bind' ? hooked(pool(), s.lock, hold) : pool();
    const backfillStore = holder === 'backfill' ? hooked(pool(), s.lock, hold) : pool();
    const runs: Partial<Record<'enrollment' | 'bind' | 'backfill', Promise<unknown>>> = {};
    const start = (who: 'enrollment' | 'bind' | 'backfill') => {
      runs[who] = who === 'enrollment' ? s.firstEnrollment() : who === 'bind' ? s.bind(n, bindStore) : s.backfill(backfillStore);
    };
    start(holder);
    await locked.opened;
    for (const other of (['enrollment', 'bind', 'backfill'] as const).filter(who => who !== holder)) start(other);
    await someoneWaits(2); // both others are blocked behind the holder's team lock
    held.open();
    const [x, bound] = await Promise.all([runs.enrollment, runs.bind, runs.backfill]) as [string, { status: number; body: unknown }, unknown];
    const result = { holder, x, bind: bound.status, record: (await s.record())?.subscriptions, bound: s.stripe.subs.get(n)!.metadata.walkie_team,
      enrolled: await s.enrolled() };
    expect(result).toEqual(holder === 'enrollment'
      // X decided first, on the record as it stood: no licence known (the re-scan exposure). The bind then finds the
      // team enrolled and binds nothing; both ids end up recorded.
      ? { holder, x: 'ok', bind: 409, record: [p, n].sort(), bound: undefined, enrolled: s.t.f.pubkey }
      // A writer first: X's reads predate the licence the writer records, so X is refused under the lock.
      : { holder, x: 'team_ownership_required', bind: 200, record: [p, n].sort(), bound: s.t.team, enrolled: undefined });
  }
}, 60_000);

// Opus r13 P3 1: two first-enrollment attempts on two pools read the same pruning batch before either writes. The
// stored position is compared and set, so the second does not count the batch again: no false overflow, no page.
pgTest('two concurrent pruning attempts on two pools: no false overflow, and the team enrolls', async () => {
  await ready();
  const s = scene('pg-conc', pool());
  await markerSet(s.w.d.store);
  const live = Array.from({ length: 50 }, (_, i) => s.lic(`CA${String(i).padStart(3, '0')}`, true));
  for (const id of live) s.stripe.subs.set(id, { ...s.stripe.subs.get(id)!, metadata: { walkie_team: s.t.team, walkie_authority: s.t.f.pubkey } });
  const ended = Array.from({ length: 50 }, (_, i) => s.lic(`CB${String(i).padStart(3, '0')}`, true));
  for (const id of ended) s.stripe.subs.set(id, { ...s.stripe.subs.get(id)!, status: 'canceled' });
  await s.w.d.store.tx((x: Tx) => x.setControl(bindingsKey(s.t.team), { subscriptions: [...live, ...ended].sort() }));
  const read = s.w.d.licenceById as (id: string) => Promise<SubscriptionLite | null>;
  s.w.d.licenceById = async (id: string) => { await Bun.sleep(10); return read(id); };
  const attempt = (store: ComputeStore) => C.createAccount({ ...s.w.d, store }, s.t.team, C.proof(s.t.f, s.t.team, s.w.clock.now, s.t.genesis))
    .then(() => 'ok', (e: { code?: string; message: string }) => e.code ?? e.message);
  const answers = [...await Promise.all([attempt(pool()), attempt(pool())])];
  for (let i = 0; i < 4 && answers.at(-1) !== 'ok'; i++) answers.push(await attempt(pool()));
  expect(answers).not.toContain('licence_bindings_overflow');
  expect(s.w.logs.filter((e: string) => e === 'alert_licence_bindings_overflow')).toEqual([]);
  expect(answers.at(-1)).toBe('ok');
}, 60_000);

// Opus r13 PG7: the stored-claim recovery bind (a retry after a bind whose Stripe write landed but whose answer was
// lost) takes the team lock too. Both orders against a first enrollment, the waiting side seen in pg_locks.
pgTest('a stored-claim recovery bind against a first enrollment, both lock orderings (PG7)', async () => {
  await ready();
  for (const first of ['enrollment', 'recovery'] as const) {
    const s = scene(`pg-claim-${first}`, pool()), l = s.lic('L'), bindStore = pool();
    await markerSet(s.w.d.store);
    // The first activation: its Stripe write lands, the answer is lost, and the reads that would recover it fail.
    const write = s.stripe.setSubscriptionMetadata.bind(s.stripe), get = s.stripe.getSubscription.bind(s.stripe);
    let lose = true, readsDown = false;
    s.stripe.setSubscriptionMetadata = async (...a: Parameters<typeof write>) => {
      await write(...a);
      if (lose) { lose = false; readsDown = true; throw Object.assign(Error('timeout'), { type: 'StripeConnectionError' }); }
    };
    s.stripe.getSubscription = async (id: string) => {
      if (readsDown) throw Object.assign(Error('stripe 500'), { statusCode: 500 });
      return get(id);
    };
    expect((await s.bind(l, bindStore)).status).toBe(503);
    readsDown = false;
    expect(await bindStore.bindClaim(l)).not.toBeNull(); // the claim the retry recovers
    const held = gate(), locked = gate(), hold = { after: async () => { locked.open(); await held.opened; } };
    let x: Promise<string>, retry: Promise<{ status: number }>;
    if (first === 'enrollment') {
      s.w.d.store = hooked(pool(), s.lock, hold);
      x = s.firstEnrollment();
      await locked.opened;
      retry = s.bind(l, bindStore);
    } else {
      retry = s.bind(l, hooked(bindStore, s.lock, hold));
      await locked.opened;
      x = s.firstEnrollment();
    }
    await someoneWaits();
    held.open();
    const result = { first, x: await x, bind: (await retry).status, record: (await s.record())?.subscriptions };
    expect(result).toEqual(first === 'enrollment'
      ? { first, x: 'ok', bind: 403, record: [l] } // X enrolled first on an empty record; the recovery then refuses
      : { first, x: 'team_ownership_required', bind: 200, record: [l] }); // recovered and recorded before X decided
  }
}, 60_000);

pgTest('two backfill loops on two pools both finish without taking the run from each other', async () => {
  await ready();
  const s = scene('pg-loops', pool());
  await s.w.d.store.tx((x: Tx) => x.setControl(BACKFILL_KEY, null));
  for (let i = 0; i < 10; i++) s.lic(`LP${i}`, true);
  s.stripe.pageSize = 1;
  const slow = { listSubscriptionsPage: async (after?: string) => { await Bun.sleep(30); return s.stripe.listSubscriptionsPage(after); } };
  const answers: string[] = [];
  const loop = async (name: string, store: PgStore) => {
    for (let calls = 1; calls <= 40; calls++) {
      const r = await backfillLicenceBindings(store, slow, { now: () => s.w.clock.now, budgetMs: 80 });
      answers.push(`${name}:${r.busy ? 'busy' : r.superseded ? 'superseded' : r.complete ? 'complete' : 'progress'}`);
      if (r.complete) return calls;
      await Bun.sleep(10);
    }
    return -1;
  };
  const [one, two] = await Promise.all([loop('A', pool()), Bun.sleep(35).then(() => loop('B', pool()))]);
  expect(answers.filter(x => x.endsWith(':superseded'))).toEqual([]);
  expect([one > 0, two > 0]).toEqual([true, true]);
  expect(await s.w.d.store.tx((x: Tx) => x.control(BACKFILL_KEY))).toHaveProperty('complete_at');
  expect((await s.record())?.subscriptions).toHaveLength(10);
}, 60_000);

/**
 * The runbook's trim (C-FINAL round 12, lane E step 7), the two statements the operator runs between BEGIN and COMMIT:
 * take the team lock, then remove the `remove` ids, add the `add` ids and drop the overflow mark, keeping every other id.
 */
const trimStatements = (team: string, remove: readonly string[], add: readonly string[]): [string, string] => {
  const list = (ids: readonly string[]) => `ARRAY[${ids.map(id => `'${id}'`).join(',')}]::text[]`;
  return [`SELECT pg_advisory_xact_lock(hashtextextended('enrollment-chain:${team}', 0))`,
    `UPDATE compute_control SET value = jsonb_build_object('subscriptions', (
  SELECT coalesce(jsonb_agg(DISTINCT id ORDER BY id), '[]'::jsonb) FROM (
    SELECT jsonb_array_elements_text(value->'subscriptions') AS id UNION SELECT unnest(${list(add)})) ids
  WHERE id <> ALL (${list(remove)})))
WHERE key = 'licence-bindings:${team}'`];
};

pgTest("the operator's locked SQL trim keeps a concurrent bind's id in both orderings and clears the mark", async () => {
  await ready();
  for (const first of ['trim', 'bind'] as const) {
    const s = scene(`pg-trim-${first}`, pool()), live = s.lic('A', true), fresh = s.lic('B');
    const ended = ['E1', 'E2', 'E3'].map(n => s.lic(n));
    await markerSet(s.w.d.store);
    await s.w.d.store.tx((x: Tx) => x.setControl(bindingsKey(s.t.team), { subscriptions: [live, ...ended].sort(), overflow: true }));
    const [lock, update] = trimStatements(s.t.team, ended, [live]);
    const held = gate(), locked = gate();
    const operator = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const trim = (wait: boolean) => operator.begin(async tx => {
        await tx.unsafe(lock);
        if (wait) { locked.open(); await held.opened; }
        await tx.unsafe(update);
      });
      const one = first === 'trim' ? trim(true) : s.bind(fresh, hooked(pool(), s.lock, { after: async () => { locked.open(); await held.opened; } }));
      await locked.opened;
      const two = first === 'trim' ? s.bind(fresh, pool()) : trim(false);
      await someoneWaits();
      held.open();
      await Promise.all([one, two]);
      expect({ first, record: await s.record() }).toEqual({ first, record: { subscriptions: [live, fresh].sort() } });
    } finally { await operator.end({ timeout: 5 }); }
  }
}, 30_000);
