// Lane C round 12 (REVIEW-r11-opus P2 1, P3 1a, 2, 3, 5 and 7; REVIEW-r11-codex P2-1): the backfill's lease, reads
// bounded before the team lock, the overflow count, an unmigrated store refused, a hung store refused in time, and the
// surviving mutants N25b, N32 and N34. MemoryStore + MockStripe (and one local TCP listener); no network.
import { expect, test } from 'bun:test';
import net from 'node:net';
import * as C from './rent6-fixtures.ts';
import { BACKFILL_KEY, backfillLicenceBindings, bindingsKey } from '../api/_lib/compute/licence-records.ts';
import { firstEnrollmentRefusal } from '../api/_lib/compute/ownership.ts';
import { makeLicenceBackfill } from '../api/compute/licence-backfill.ts';
import { alertPriority, sendAlert } from '../api/_lib/compute/alerts.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { LATEST_MIGRATION } from '../api/_lib/compute/migrations.ts';
import type { ComputeStore } from '../api/_lib/compute/store.ts';
import type { SubscriptionLite } from '../api/_lib/stripe.ts';

type Keys = ReturnType<typeof C.generateKeys>;
const secret = ['0123456789', 'abcdef'].join('').repeat(2); // built at runtime: no key-shaped literal (scripts/public-gitleaks.toml)
/** Well past any backfill lease (the code holds it for seconds, not a minute). */
const PAST_ANY_LEASE = 60_000;

async function stderrOf(run: () => Promise<unknown>): Promise<string[]> {
  const write = process.stderr.write.bind(process.stderr), lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await run(); } finally { process.stderr.write = write; }
  return lines;
}

function world(name: string, opts: { backfilled?: boolean } = {}) {
  const w = C.world(), t = C.mkTeam(name), stripe = new C.LH.MockStripe(), signer = C.LH.testKeypair();
  const env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1' });
  const id = `sub_${name.replace(/[^A-Za-z0-9]/g, '')}`;
  stripe.subs.set(id, C.LH.subscription({ id }));
  // Every Stripe read the control plane makes: by id (credentials and the gate) and the search.
  const reads = { stripe: 0, byId: 0, inFlight: 0, peak: 0 };
  let readDelay = 0;
  const get = stripe.getSubscription.bind(stripe);
  stripe.getSubscription = async (...a: Parameters<typeof get>) => { reads.stripe++; return get(...a); };
  w.d.verifyLicense = C.licenseVerifier(stripe);
  w.d.teamLicences = async () => { reads.stripe++; return [] as SubscriptionLite[]; }; // the search index lags
  w.d.licenceById = async (lic: string) => {
    reads.byId++; reads.inFlight++; reads.peak = Math.max(reads.peak, reads.inFlight);
    try { if (readDelay) await Bun.sleep(readDelay); return await stripe.getSubscription(lic); } finally { reads.inFlight--; }
  };
  if (opts.backfilled !== false) void w.store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7, email: 'lead@kestrel.test',
    interval: 'month', issued_at: C.T0, expires_at: C.T0 + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const bind = async (o: { store?: () => ComputeStore | null; env?: typeof env } = {}) => {
    const res = await C.makeBind({ ...C.LH.deps(stripe, o.env ?? env), computeStore: o.store ?? (() => w.store), now: () => w.clock.now })(
      new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: t.team }) }));
    return { status: res.status, body: await res.json() as { renewal_token?: string; error?: string } };
  };
  const account = (keys: Keys, extra: object = {}) => C.createAccount(w.d, t.team, C.proof(keys, t.team, w.clock.now, t.genesis, [], extra));
  const route = (stripeFor: () => unknown) => makeLicenceBackfill({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret },
    compute: () => w.d, stripe: () => null, licenseStripe: stripeFor } as never);
  const post = (handler: (req: Request) => Promise<Response>, body: object = {}) => handler(new Request('https://site.test/api/compute/licence-backfill', {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'x-real-ip': '203.0.113.9' }, body: JSON.stringify(body) }));
  const marker = () => w.store.tx(x => x.control(BACKFILL_KEY)) as Promise<Record<string, unknown> | undefined>;
  const bindings = () => w.store.tx(x => x.control(bindingsKey(t.team))) as Promise<{ subscriptions: string[]; overflow?: boolean } | undefined>;
  const enrolled = async () => (await w.store.tx(x => x.enrollment(t.team)))?.key;
  const teamSubs = (prefix: string, n: number, status = 'active') => Array.from({ length: n }, (_, i) => {
    const sub = `sub_${prefix}${String(i).padStart(4, '0')}`;
    stripe.subs.set(sub, C.LH.subscription({ id: sub, status, metadata: { walkie_team: t.team } }));
    return sub;
  });
  return { w, t, stripe, id, env, reads, bind, account, route, post, marker, bindings, enrolled, teamSubs,
    setReadDelay: (ms: number) => { readDelay = ms; } };
}
const outcome = (r: { busy?: boolean; superseded?: boolean; complete: boolean }) =>
  r.busy ? 'busy' : r.superseded ? 'superseded' : r.complete ? 'complete' : 'progress';

// ---- 1. Opus P2 1: one backfill at a time; overlapping loops never take the run from each other -----------------------

test('two overlapping backfill loops both finish: the running call holds a lease, the other answers busy and never takes over', async () => {
  const s = world('r12-loops', { backfilled: false });
  s.stripe.subs.clear();
  s.teamSubs('LP', 12);
  s.stripe.pageSize = 1;
  const slow = { listSubscriptionsPage: async (after?: string) => { await Bun.sleep(15); return s.stripe.listSubscriptionsPage(after); } };
  const answers: string[] = [];
  const loop = async (name: string) => { // a persistent caller: calls again on anything short of completion
    for (let calls = 1; calls <= 40; calls++) {
      const r = await backfillLicenceBindings(s.w.store, slow, { now: () => s.w.clock.now, budgetMs: 40 });
      answers.push(`${name}:${outcome(r)}`);
      if (r.complete) return calls;
      await Bun.sleep(5);
    }
    return -1;
  };
  const [a, b] = await Promise.all([loop('A'), Bun.sleep(3).then(() => loop('B'))]);
  expect(answers.filter(x => x.endsWith(':superseded'))).toEqual([]);
  expect(answers.filter(x => x.endsWith(':busy')).length).toBeGreaterThan(0);
  expect([a > 0, b > 0]).toEqual([true, true]);
  expect(await s.marker()).toHaveProperty('complete_at');
  expect((await s.bindings())?.subscriptions).toHaveLength(12);
});

test('through the route, a second loop gets 409 licence_backfill_busy while the first runs, and the quota is not spent', async () => {
  const s = world('r12-route', { backfilled: false });
  s.stripe.subs.clear();
  s.teamSubs('RT', 8);
  s.stripe.pageSize = 1;
  const slow = { listSubscriptionsPage: async (after?: string) => { await Bun.sleep(25); return s.stripe.listSubscriptionsPage(after); } };
  const handler = s.route(() => slow);
  const codes: string[] = [];
  const loop = async (name: string) => {
    for (let calls = 1; calls <= 30; calls++) {
      const res = await s.post(handler);
      const body = await res.json() as { complete?: boolean; superseded?: boolean; error?: string };
      codes.push(`${name}:${res.status}:${body.error ?? (body.superseded ? 'superseded' : body.complete ? 'complete' : 'progress')}`);
      if (body.complete) return calls;
      await Bun.sleep(20);
    }
    return -1;
  };
  const [a, b] = await Promise.all([loop('A'), Bun.sleep(10).then(() => loop('B'))]);
  expect(codes.filter(c => c.endsWith(':superseded'))).toEqual([]);
  expect(codes).toContain('B:409:licence_backfill_busy');
  expect([a, b > 0]).toEqual([1, true]); // the first call did the whole scan
  expect(codes.length).toBeLessThan(30); // nowhere near the 60-per-hour operator quota
});

test("a holder that died keeps the lease only until it expires; then a call takes over and the late write is superseded", async () => {
  const s = world('r12-dead', { backfilled: false });
  s.stripe.subs.clear();
  s.teamSubs('DH', 3);
  s.stripe.pageSize = 1;
  let release!: () => void;
  const hung = new Promise<void>(r => { release = r; });
  const dead = { listSubscriptionsPage: async (after?: string) => { await hung; return s.stripe.listSubscriptionsPage(after); } };
  const call = () => backfillLicenceBindings(s.w.store, s.stripe, { now: () => s.w.clock.now, budgetMs: 10_000 });
  const holder = backfillLicenceBindings(s.w.store, dead, { now: () => s.w.clock.now, budgetMs: 10_000 });
  await Bun.sleep(5);
  expect(await call()).toMatchObject({ busy: true, complete: false, pages: 0 });
  s.w.clock.now += 1_000;
  expect(await call()).toMatchObject({ busy: true, pages: 0 });
  expect(await backfillLicenceBindings(s.w.store, s.stripe, { now: () => s.w.clock.now, budgetMs: 10_000, restart: true }))
    .toMatchObject({ busy: true, pages: 0 }); // a restart does not take a live lease either
  expect(s.stripe.pages).toBe(0); // a busy answer reads nothing
  s.w.clock.now += PAST_ANY_LEASE;
  expect(await call()).toMatchObject({ complete: true, pages: 3 });
  const settled = await s.marker();
  release();
  expect(await holder).toMatchObject({ superseded: true, complete: true });
  expect(await s.marker()).toEqual(settled);
});

test('a call superseded during a restart re-scan answers complete: false', async () => {
  const s = world('r12-rescan', { backfilled: false });
  s.stripe.subs.clear();
  s.teamSubs('RS', 3);
  s.stripe.pageSize = 1;
  const run = (o: { restart?: boolean; budgetMs?: number; stripe?: { listSubscriptionsPage: typeof s.stripe.listSubscriptionsPage } } = {}) =>
    backfillLicenceBindings(s.w.store, o.stripe ?? s.stripe, { now: () => s.w.clock.now, budgetMs: o.budgetMs ?? 10_000, restart: o.restart });
  expect(await run()).toMatchObject({ complete: true });
  let release!: () => void;
  const hung = new Promise<void>(r => { release = r; });
  const dead = { listSubscriptionsPage: async (after?: string) => { await hung; return s.stripe.listSubscriptionsPage(after); } };
  const holder = run({ restart: true, stripe: dead });
  await Bun.sleep(5);
  s.w.clock.now += PAST_ANY_LEASE;
  expect(await run({ budgetMs: 0 })).toMatchObject({ complete: false, pages: 1 }); // takes the re-scan over, one page
  release();
  expect(await holder).toMatchObject({ superseded: true, complete: false }); // the re-scan is not finished
  expect(await s.marker()).toHaveProperty('complete_at'); // and the gate stays open throughout
});

test('a call that ends releases its lease at once: after its budget, or after a Stripe error', async () => {
  const s = world('r12-release', { backfilled: false });
  s.stripe.subs.clear();
  s.teamSubs('RL', 3);
  s.stripe.pageSize = 1;
  const call = (stripe: { listSubscriptionsPage: typeof s.stripe.listSubscriptionsPage } = s.stripe) =>
    backfillLicenceBindings(s.w.store, stripe, { now: () => s.w.clock.now, budgetMs: 0 });
  expect(await call()).toMatchObject({ complete: false, pages: 1 });
  expect(await call()).toMatchObject({ complete: false, pages: 1 }); // the clock has not moved: not busy
  await expect(call({ listSubscriptionsPage: async () => { throw Error('stripe 500'); } })).rejects.toThrow('stripe 500');
  expect(await call()).toMatchObject({ complete: true, pages: 1 });
});

// ---- 3. Opus P3 2 and 3: answer from the record before any Stripe read; reads bounded; overflowed counts teams --------

test('an overflowed team answers licence_bindings_overflow before any Stripe read, with or without credentials', async () => {
  const s = world('r12-over');
  const bound = await s.bind();
  expect(bound.status).toBe(200);
  const ids = [s.id, ...s.teamSubs('OV', 199)].sort();
  await s.w.store.tx(x => x.setControl(bindingsKey(s.t.team), { subscriptions: ids, overflow: true }));
  const before = s.reads.stripe;
  expect(await C.err(s.account(s.t.f))).toBe('licence_bindings_overflow');
  expect(await C.err(s.account(s.t.f, { lic_id: s.id, renewal_token: bound.body.renewal_token }))).toBe('licence_bindings_overflow');
  expect(s.reads.stripe - before).toBe(0);
  expect(s.w.logs.filter(e => e === 'alert_licence_read_failed')).toEqual([]);
  expect(s.w.logs.filter(e => e === 'alert_licence_bindings_overflow')).toHaveLength(2);
  expect(await s.enrolled()).toBeUndefined();
});

test('under the lock an overflow mark refuses a credentialed presenter too (N34)', async () => {
  const w = C.world(), t = C.mkTeam('r12-n34'), owner = C.proof(t.f, t.team, w.clock.now, t.genesis) as never;
  await w.store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 }));
  await w.store.tx(x => x.setControl(bindingsKey(t.team), { subscriptions: ['sub_N34'], overflow: true }));
  const gate = { kind: 'gate' as const, recorded: new Set(['sub_N34']), live: new Map<string, string | null>() };
  expect(await w.store.tx(x => firstEnrollmentRefusal(x, t.team, gate, owner, true))).toBe('bindings_overflow');
});

// Round 13: such a record is pruned in batches (compute-licence-records-r13) instead of refused outright.
test('a record too large to read in one go answers a presenter without credentials after one bounded batch; the holder is admitted', async () => {
  const s = world('r12-large');
  const bound = await s.bind();
  const ended = s.teamSubs('EN', 60, 'canceled');
  await s.w.store.tx(x => x.setControl(bindingsKey(s.t.team), { subscriptions: [s.id, ...ended].sort() }));
  const before = s.reads.stripe;
  expect(await C.err(s.account(s.t.f))).toBe('licence_record_pruning');
  expect(s.reads.stripe - before).toBe(50);
  expect(s.w.logs.filter(e => e === 'alert_licence_read_failed')).toEqual([]);
  await s.account(s.t.f, { lic_id: s.id, renewal_token: bound.body.renewal_token });
  expect(await s.enrolled()).toBe(s.t.f.pubkey);
});

test('the gate reads at most 10 licences at a time', async () => {
  const s = world('r12-peak');
  const ids = s.teamSubs('PK', 30, 'canceled');
  await s.w.store.tx(x => x.setControl(bindingsKey(s.t.team), { subscriptions: ids }));
  s.setReadDelay(5);
  await s.account(s.t.f); // every recorded licence has ended: a Free team, first presenter
  expect(s.reads.byId).toBe(30);
  expect(s.reads.peak).toBeLessThanOrEqual(10);
  expect(await s.enrolled()).toBe(s.t.f.pubkey);
});

test("the backfill's overflowed count counts teams once each and names them, also on a re-scan", async () => {
  const s = world('r12-count', { backfilled: false });
  s.stripe.subs.clear();
  s.teamSubs('CT', 201);
  s.stripe.pageSize = 50;
  const alerts: string[] = [];
  const run = (restart = false) => backfillLicenceBindings(s.w.store, s.stripe, { now: () => s.w.clock.now, budgetMs: 10_000, restart,
    log: (event, fields) => alerts.push(`${event}:${fields.team}`) });
  expect(await run()).toMatchObject({ complete: true, overflowed: 1, overflowed_teams: [s.t.team] });
  expect(alerts).toEqual([`licence_bindings_overflow:${s.t.team}`]);
  expect(await run(true)).toMatchObject({ complete: true, overflowed: 1, overflowed_teams: [s.t.team] }); // 5 pages meet it
  expect(alerts).toHaveLength(2);
  // One re-scan spread over five calls (one page each) still counts and alerts the team once.
  let last = await backfillLicenceBindings(s.w.store, s.stripe, { now: () => s.w.clock.now, budgetMs: 0, restart: true,
    log: (event, fields) => alerts.push(`${event}:${fields.team}`) });
  for (let i = 0; i < 6 && !last.complete; i++) last = await backfillLicenceBindings(s.w.store, s.stripe, { now: () => s.w.clock.now,
    budgetMs: 0, log: (event, fields) => alerts.push(`${event}:${fields.team}`) });
  expect(last).toMatchObject({ complete: true, overflowed: 1, overflowed_teams: [s.t.team] });
  expect(alerts).toHaveLength(3);
});

test('until the backfill completes, a first enrollment answers licence_backfill_pending before any Stripe read', async () => {
  const s = world('r12-pending', { backfilled: false });
  const bound = await s.bind();
  const before = s.reads.stripe;
  expect(await C.err(s.account(s.t.f))).toBe('licence_backfill_pending');
  expect(await C.err(s.account(s.t.f, { lic_id: s.id, renewal_token: bound.body.renewal_token }))).toBe('licence_backfill_pending');
  expect(s.reads.stripe - before).toBe(0);
});

test('an enrolled team is not held back by its licence record: a later account still works with the record overflowed', async () => {
  const s = world('r12-enrolled');
  await s.account(s.t.f);
  await s.w.store.tx(x => x.setControl(bindingsKey(s.t.team), { subscriptions: ['sub_X1'], overflow: true }));
  await s.w.store.tx(x => x.setControl(BACKFILL_KEY, null)); // and even with the marker gone
  expect(await C.err(s.account(s.t.f))).toBe('ok');
});

test('a search that reports more licences than can be read answers licence_bindings_overflow, without reading them', async () => {
  const s = world('r12-search-many');
  const claimed = s.teamSubs('SR', 60).map(id => s.stripe.subs.get(id)!);
  s.w.d.teamLicences = async () => claimed;
  expect(await C.err(s.account(s.t.f))).toBe('licence_bindings_overflow');
  expect(s.reads.byId).toBe(0);
  expect(s.w.logs.filter(e => e === 'alert_licence_read_failed')).toEqual([]);
});

test("no licence read starts after the gate's deadline", async () => {
  const s = world('r12-deadline');
  const ids = s.teamSubs('DL', 40, 'canceled');
  await s.w.store.tx(x => x.setControl(bindingsKey(s.t.team), { subscriptions: ids }));
  s.setReadDelay(100); // four waves of 10: 400 ms
  s.w.d.licenceReadMs = 1; // the deadline (1 + 250 ms) passes during the third wave
  expect(await C.err(s.account(s.t.f))).toBe('license_verification_unavailable');
  const atAnswer = s.reads.byId;
  await Bun.sleep(300);
  expect(s.reads.byId).toBe(atAnswer);
  expect(atAnswer).toBeLessThan(40);
});

// ---- 4. Opus P3 1a: the lock-ON bind refuses an unmigrated store ------------------------------------------------------

test('the lock-ON bind refuses a store whose schema is behind LATEST_MIGRATION, drained or enabled: 503 licence_store_required and the alert', async () => {
  for (const version of [0, LATEST_MIGRATION - 1]) {
    for (const enabled of [false, true]) {
      const s = world(`r12-schema-${version}-${enabled}`);
      const base = new MemoryStore();
      const store: ComputeStore = { schemaVersion: async () => version, legacyEmpty: async () => true, tx: fn => base.tx(fn),
        bindClaim: id => base.bindClaim(id), saveBindClaim: (id, claim) => base.saveBindClaim(id, claim),
        clearBindClaim: (id, hash) => base.clearBindClaim(id, hash) };
      const { COMPUTE_ENABLED: _on, ...drained } = s.env;
      let res = { status: 0, body: {} as { error?: string } };
      const lines = await stderrOf(async () => { res = await s.bind({ store: () => store, env: enabled ? s.env : drained }); });
      expect({ version, enabled, status: res.status, error: res.body.error })
        .toEqual({ version, enabled, status: 503, error: 'licence_store_required' });
      expect(s.stripe.calls.metadata).toEqual([]);
      expect(lines.filter(line => line.startsWith('compute alert_licence_store_missing '))).toHaveLength(1);
    }
  }
});

// ---- 5. Opus P3 7: a store host that never answers is given up on well inside the function limit ---------------------

test('a bind against a store host that never answers fails within 4 s, before any Stripe write', async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer(socket => { sockets.push(socket); }); // accepts the connection, never says a word
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const s = world('r12-hung');
    const env = { ...s.env, DATABASE_URL: `postgres://fixture:fixture@127.0.0.1:${(server.address() as net.AddressInfo).port}/hung` };
    const started = Date.now();
    let res = { status: 0, body: {} as { error?: string } };
    await stderrOf(async () => {
      const r = await C.makeBind({ ...C.LH.deps(s.stripe, env), now: () => s.w.clock.now })(new Request('https://site.test/api/license/bind', {
        method: 'POST', body: JSON.stringify({ code: C.signLicense({ v: 2, kind: 'activation', lic_id: s.id, plan: 'team', seats: 7,
          email: 'lead@kestrel.test', interval: 'month', issued_at: C.T0, expires_at: C.T0 + 30 * 86_400_000 },
          C.signingKeyFromPem(String(s.env.WALKIE_LICENSE_SIGNING_KEY))), team_id: s.t.team }) }));
      res = { status: r.status, body: await r.json() as { error?: string } };
    });
    const ms = Date.now() - started;
    expect([res.status, res.body.error]).toEqual([503, 'compute_state_unavailable']);
    expect(ms).toBeLessThan(4_000);
    expect(s.stripe.calls.metadata).toEqual([]);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
}, 20_000);

// ---- 6. Opus P3 5: N25b and N32 (alert retry classes) --------------------------------------------------------------

test('queued licence_read_failed alerts are retried before team-waiting ones, also when their sender died mid-send (N25b, N32)', async () => {
  const store = new MemoryStore();
  let now = 1_790_000_000_000;
  const env = { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixture-bot', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture-chat' };
  const deps = (fetch: (url: string, init?: RequestInit) => Promise<Response>) => ({ store, env, now: () => now, log: () => {}, fetch });
  const failing = async () => new Response('bad gateway', { status: 502 });
  await sendAlert(deps(failing), 'authority_fork', { team: 'aaaaaaaaaaaaaaaa' }); // team-waiting, queued first
  now += 1_000;
  await sendAlert(deps(failing), 'licence_read_failed', { team: 'bbbbbbbbbbbbbbbb' }); // money class, queued later
  now += 1_000;
  // A sender that dies mid-send: its fetch never answers, so only the claim row written before the send remains.
  void sendAlert(deps(() => new Promise<Response>(() => undefined)), 'licence_read_failed', { team: 'cccccccccccccccc' });
  await Bun.sleep(10);
  const due = await store.tx(t => t.queuedAlerts(now + 3_600_000, 10));
  expect(due.map(row => (row.value as { fields: { team: string } }).fields.team))
    .toEqual(['bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'aaaaaaaaaaaaaaaa']);
  expect(alertPriority('licence_read_failed')).toBe(0);
});
