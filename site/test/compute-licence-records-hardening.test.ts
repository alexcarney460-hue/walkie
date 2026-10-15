// Lane C round 11 (REVIEW-final-codex P1-1, P1-2, P2-3..5; REVIEW-final-opus P2 1, P2 2, P3): hardening the site's
// licence record and its backfill. Several tests are the reviewers' probes (zz-final-*) turned into assertions.
// MemoryStore + MockStripe; no network.
import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { BACKFILL_KEY, backfillLicenceBindings, bindingsKey, recordLicenceBindings } from '../api/_lib/compute/licence-records.ts';
import { firstEnrollmentGate, firstEnrollmentRefusal } from '../api/_lib/compute/ownership.ts';
import { makeLicenceBackfill } from '../api/compute/licence-backfill.ts';
import { makeRenew, renewMessage } from '../api/license/renew.ts';
import { renewHash } from '../api/_lib/metadata.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { searchAllPages, type SubscriptionLite } from '../api/_lib/stripe.ts';
import type { ComputeStore, Tx } from '../api/_lib/compute/store.ts';
import { COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION } from '../api/_lib/compute/release-gate.ts';
import { computeFromEnv } from '../api/_lib/compute/handler.ts';
import { configJson } from './compute-helpers.ts';

type Keys = ReturnType<typeof C.generateKeys>;
type Move = { transfer: { key: string; event: unknown }; events: unknown[] };
const secret = ['0123456789', 'abcdef'].join('').repeat(2); // built at runtime: no key-shaped literal (scripts/public-gitleaks.toml)

/** Captures stderr lines (where store-less alerts and the site's operational log go) while `run` runs. */
async function stderrOf(run: () => Promise<unknown>): Promise<string[]> {
  const write = process.stderr.write.bind(process.stderr), lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await run(); } finally { process.stderr.write = write; }
  return lines;
}

function world(name: string, opts: { backfilled?: boolean; store?: ComputeStore } = {}) {
  const w = C.world(), t = C.mkTeam(name), stripe = new C.LH.MockStripe(), signer = C.LH.testKeypair();
  const env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1' });
  const id = `sub_${name.replace(/[^A-Za-z0-9]/g, '')}`;
  stripe.subs.set(id, C.LH.subscription({ id }));
  let search: (team: string) => Promise<readonly SubscriptionLite[]> = async () => []; // the index lags
  w.d.verifyLicense = C.licenseVerifier(stripe);
  w.d.teamLicences = async (team: string) => search(team);
  w.d.licenceById = async (lic: string) => stripe.getSubscription(lic);
  if (opts.backfilled !== false) void w.store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 }));
  const codeFor = (lic: string) => C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7,
    email: 'lead@kestrel.test', interval: 'month', issued_at: C.T0, expires_at: C.T0 + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  let seq = 1;
  const move = (by: Keys, to: Keys): Move => {
    const at = (seq += 3);
    const ev = (n: number, kind: string, body: object) => C.signEvent(by, { v: C.PROTOCOL_VERSION, team: t.team,
      id: `${by.nodeId}:${n}`, origin: by.nodeId, seq: n, ts: C.T0 + n, author: { handle: 'alex', node: by.nodeId }, kind, body });
    const transfer = C.transfer(by, t.team, at + 2, to);
    return { transfer, events: [ev(at, 'team.member', { login: `direct:${to.nodeId}`, handle: `h${at}`, role: 'owner' }),
      ev(at + 1, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: `m${at}`, pubkey: to.pubkey,
        ip: '127.0.0.1' }), transfer.event] };
  };
  const roster = (moves: Move[]) => ({ genesis: t.genesis, authority_chain: moves.map(m => m.transfer),
    roster_events: moves.flatMap(m => m.events) });
  const bind = async (o: { keys?: Keys; moves?: Move[]; team?: string; lic?: string; store?: () => ComputeStore | null;
    env?: Record<string, string> } = {}) => {
    const lic = o.lic ?? id, team = o.team ?? t.team, expires_at = w.clock.now + 240_000;
    const site = { ...C.LH.deps(stripe, o.env ?? env), computeStore: o.store ?? (() => opts.store ?? w.store) };
    const proof = o.keys ? { ...roster(o.moves ?? []), expires_at, bind_signature: o.keys.sign(C.bindMessage(team, lic, expires_at)) } : undefined;
    const res = await C.makeBind({ ...site, now: () => w.clock.now })(new Request('https://site.test/api/license/bind', {
      method: 'POST', body: JSON.stringify({ code: codeFor(lic), team_id: team, ...(proof ? { proof } : {}) }) }));
    return { status: res.status, body: await res.json() as { renewal_token?: string; key?: string; error?: string } };
  };
  const account = (keys: Keys, moves: Move[] = [], extra: object = {}, team = t) => C.createAccount(w.d, team.team,
    C.proof(keys, team.team, w.clock.now, team.genesis, moves.map(m => m.transfer), { roster_events: moves.flatMap(m => m.events), ...extra }));
  const backfill = async (body: object = {}, auth = `Bearer ${secret}`, ip = '203.0.113.7') => {
    const res = await makeLicenceBackfill({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d, stripe: () => null,
      licenseStripe: () => stripe } as never)(new Request('https://site.test/api/compute/licence-backfill', { method: 'POST',
      headers: { authorization: auth, 'x-real-ip': ip }, body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const marker = () => w.store.tx(x => x.control(BACKFILL_KEY)) as Promise<Record<string, unknown> | undefined>;
  const bindings = (team = t.team) => w.store.tx(x => x.control(bindingsKey(team))) as Promise<{ subscriptions: string[]; overflow?: boolean } | undefined>;
  const enrolled = async (team = t.team) => (await w.store.tx(x => x.enrollment(team)))?.key;
  return { w, t, stripe, id, env, move, roster, bind, account, backfill, marker, bindings, enrolled, codeFor,
    setSearch: (fn: typeof search) => { search = fn; } };
}

// ---- 1. Codex P1-1 / Opus P3 R3: the 200-id limit must never wedge the backfill --------------------------------------

test('one team with 230 ended subscriptions: the backfill skips them, completes, and other teams enroll', async () => {
  const s = world('hard-wedge', { backfilled: false });
  s.stripe.subs.clear();
  const big = C.mkTeam('hard-wedge-big').team, a = C.mkTeam('hard-wedge-a').team;
  for (let i = 0; i < 230; i++) {
    const sub = `sub_W${String(i).padStart(4, '0')}`;
    s.stripe.subs.set(sub, C.LH.subscription({ id: sub, status: i % 2 ? 'canceled' : 'incomplete_expired', metadata: { walkie_team: big } }));
  }
  for (const sub of ['sub_A1', 'sub_A2']) s.stripe.subs.set(sub, C.LH.subscription({ id: sub, metadata: { walkie_team: a } }));
  let last = { status: 0, body: {} as Record<string, unknown> };
  for (let i = 0; i < 6 && last.body.complete !== true; i++) last = await s.backfill();
  expect(last).toMatchObject({ status: 200, body: { complete: true } });
  expect(await s.bindings(big)).toBeUndefined(); // ended subscriptions are not recorded
  expect((await s.bindings(a))?.subscriptions).toEqual(['sub_A1', 'sub_A2']);
  const free = C.mkTeam('hard-wedge-free');
  await s.account(free.f, [], {}, free);
  expect(await s.enrolled(free.team)).toBe(free.f.pubkey);
});

test('a team over the limit with live subscriptions is marked overflowed: its first enrollment fails closed, the rest proceed', async () => {
  const s = world('hard-overflow', { backfilled: false });
  s.stripe.subs.clear();
  const bigTeam = C.mkTeam('hard-overflow-big');
  for (let i = 0; i < 201; i++) {
    const sub = `sub_L${String(i).padStart(4, '0')}`;
    s.stripe.subs.set(sub, C.LH.subscription({ id: sub, metadata: { walkie_team: bigTeam.team } }));
  }
  let last = { status: 0, body: {} as Record<string, unknown> };
  for (let i = 0; i < 6 && last.body.complete !== true; i++) last = await s.backfill();
  expect(last).toMatchObject({ status: 200, body: { complete: true } });
  expect((await s.bindings(bigTeam.team))?.overflow).toBe(true);
  const overflowAlerts = () => s.w.logs.filter(event => event === 'alert_licence_bindings_overflow').length;
  // Raised by the backfill. Through the HTTP handler a known alert event also leaves sendAlert's delivery line
  // (alerts.ts), so one raise can show as two lines once licence_bindings_overflow is an alert event (integration).
  const afterBackfill = overflowAlerts();
  expect(afterBackfill).toBeGreaterThanOrEqual(1);
  expect(await C.err(s.account(bigTeam.f, [], {}, bigTeam))).toBe('licence_bindings_overflow');
  expect(overflowAlerts()).toBe(afterBackfill + 1); // and once more by the refused first enrollment
  const free = C.mkTeam('hard-overflow-free');
  await s.account(free.f, [], {}, free);
  expect(await s.enrolled(free.team)).toBe(free.f.pubkey);
});

test('a bind that would push a team over the limit still binds and marks the team overflowed', async () => {
  const s = world('hard-overflow-bind');
  await s.w.store.tx(x => x.setControl(bindingsKey(s.t.team),
    { subscriptions: Array.from({ length: 200 }, (_, i) => `sub_P${String(i).padStart(4, '0')}`) }));
  expect((await s.bind()).status).toBe(200);
  expect((await s.bindings())?.overflow).toBe(true);
  expect(await C.err(s.account(s.t.f))).toBe('licence_bindings_overflow');
});

test('an overflowed record stays overflowed when a later bind adds an id that fits', async () => {
  const w = C.world(), team = C.mkTeam('hard-overflow-sticky').team;
  const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `sub_${prefix}${String(i).padStart(4, '0')}`);
  expect(await w.store.tx(t => recordLicenceBindings(t, team, ids(150, 'A')))).toBe('recorded');
  expect(await w.store.tx(t => recordLicenceBindings(t, team, ids(60, 'B')))).toBe('overflow'); // 210: keeps the 150, marked
  expect(await w.store.tx(t => recordLicenceBindings(t, team, ['sub_C0001']))).toBe('overflow'); // 151 fits, still marked
  expect(await w.store.tx(t => t.control(bindingsKey(team)))).toMatchObject({ overflow: true });
  expect(((await w.store.tx(t => t.control(bindingsKey(team)))) as { subscriptions: string[] }).subscriptions).toHaveLength(151);
});

// ---- 2. Codex P1-2: once the compute-capable code runs, bind requires the store ----------------------------------------

test('a bind with no store answers 503 licence_store_required, writes nothing and raises the alert; a drained bind still records', async () => {
  const s = world('hard-nostore');
  const { DATABASE_URL: _db, ...noDatabase } = s.env;
  let res = { status: 0, body: {} as Record<string, unknown> };
  const lines = await stderrOf(async () => { res = await s.bind({ store: () => null, env: noDatabase }); });
  expect([res.status, res.body.error]).toEqual([503, 'licence_store_required']);
  expect(s.stripe.calls.metadata).toEqual([]);
  expect(s.stripe.subs.get(s.id)!.metadata.walkie_team).toBeUndefined();
  expect(lines.filter(line => line.startsWith('compute alert_licence_store_missing '))).toHaveLength(1);
  const { COMPUTE_ENABLED: _on, ...drained } = s.env;
  expect((await s.bind({ env: drained })).status).toBe(200); // drained, store configured
  expect((await s.bindings())?.subscriptions).toEqual([s.id]);
});

test.skipIf(COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION)('the deployed locked build keeps the released bind without a store', async () => {
  const s = world('hard-nostore-locked');
  const res = await C.makeBind({ ...C.LH.deps(s.stripe, C.LH.fullEnv(C.LH.testKeypair().pem)), previewCompute: false,
    computeStore: () => { throw Error('database touched'); } })(new Request('https://site.test/api/license/bind', {
    method: 'POST', body: JSON.stringify({ code: 'invalid', team_id: s.t.team }) }));
  expect(res.status).toBe(400); // the released path, untouched (validates the code without any store)
});

// ---- 3. Opus P2 1: every recovery path records the binding -----------------------------------------------------------

test('PROBE R4c: a transient Stripe read error after the bind write: the token is recovered and the binding recorded', async () => {
  const s = world('hard-recover');
  const realGet = s.stripe.getSubscription.bind(s.stripe), realWrite = s.stripe.setSubscriptionMetadata.bind(s.stripe);
  let failNextRead = false, armed = true;
  s.stripe.setSubscriptionMetadata = async (...a: Parameters<typeof realWrite>) => { await realWrite(...a); if (armed) { failNextRead = true; armed = false; } };
  s.stripe.getSubscription = async (lic: string) => {
    if (failNextRead) { failNextRead = false; throw Object.assign(Error('stripe 500'), { statusCode: 500 }); }
    return realGet(lic);
  };
  const bound = await s.bind();
  expect([bound.status, typeof bound.body.renewal_token]).toEqual([200, 'string']);
  expect((await s.bindings())?.subscriptions).toEqual([s.id]);
  const x = C.generateKeys();
  expect(await C.err(s.account(x, [s.move(s.t.f, x)]))).toBe('team_ownership_required');
});

test('the holder retrying after a timed-out bind write (the stored claim) records the binding', async () => {
  const s = world('hard-claim');
  const realWrite = s.stripe.setSubscriptionMetadata.bind(s.stripe), realGet = s.stripe.getSubscription.bind(s.stripe);
  let timeouts = 1, readsDown = false;
  s.stripe.setSubscriptionMetadata = async (...a: Parameters<typeof realWrite>) => {
    await realWrite(...a); // the write lands at Stripe, but the response is lost
    if (timeouts-- > 0) { readsDown = true; throw Object.assign(Error('timeout'), { type: 'StripeConnectionError' }); }
  };
  s.stripe.getSubscription = async (lic: string) => {
    if (readsDown) throw Object.assign(Error('stripe 500'), { statusCode: 500 }); // the same request cannot recover
    return realGet(lic);
  };
  const first = await s.bind();
  expect(first.status).toBe(503);
  readsDown = false; // the holder's daemon retries activation later
  await s.w.store.tx(x => x.setControl(bindingsKey(s.t.team), null)); // whatever the failed attempt left
  const again = await s.bind();
  expect([again.status, typeof again.body.renewal_token]).toEqual([200, 'string']);
  expect((await s.bindings())?.subscriptions).toEqual([s.id]);
});

// ---- 4. Opus P2 2: the completion marker is monotonic; overlapping calls are serialized -------------------------------

test('PROBE R1: a restart that meets a Stripe error keeps the completion marker', async () => {
  const s = world('hard-restart', { backfilled: false });
  s.stripe.pageSize = 1;
  for (const sub of ['sub_R1', 'sub_R2', 'sub_R3']) s.stripe.subs.set(sub, C.LH.subscription({ id: sub }));
  expect(await s.backfill()).toMatchObject({ status: 200, body: { complete: true } });
  const real = s.stripe.listSubscriptionsPage.bind(s.stripe);
  let calls = 0;
  s.stripe.listSubscriptionsPage = async (after?: string) => { if (++calls === 2) throw Error('stripe 500'); return real(after); };
  expect((await s.backfill({ restart: true })).status).toBe(503);
  expect(await s.marker()).toHaveProperty('complete_at');
  const free = C.mkTeam('hard-restart-free');
  await s.account(free.f, [], {}, free);
  expect(await s.enrolled(free.team)).toBe(free.f.pubkey);
});

test('PROBE R2: two overlapping backfill calls: the lagging one cannot erase the marker the other wrote', async () => {
  const s = world('hard-overlap', { backfilled: false });
  s.stripe.subs.clear();
  for (const sub of ['sub_C1', 'sub_C2', 'sub_C3', 'sub_C4']) s.stripe.subs.set(sub, C.LH.subscription({ id: sub }));
  s.stripe.pageSize = 2;
  let release!: () => void;
  const lag = new Promise<void>(r => { release = r; });
  const slow = { listSubscriptionsPage: async (after?: string) => { await lag; return s.stripe.listSubscriptionsPage(after); } };
  const b = backfillLicenceBindings(s.w.store, slow, { now: () => C.T0, budgetMs: 0 }); // B starts first; its read lags
  await Bun.sleep(5);
  // Round 12: B holds the lease, so A is busy until B's lease has expired; then A takes the run over and completes.
  expect(await backfillLicenceBindings(s.w.store, s.stripe, { now: () => C.T0, budgetMs: 10_000 })).toMatchObject({ busy: true });
  expect(await backfillLicenceBindings(s.w.store, s.stripe, { now: () => C.T0 + 60_000, budgetMs: 10_000 })).toMatchObject({ complete: true });
  const settled = await s.marker();
  release();
  expect(await b).toMatchObject({ superseded: true }); // serialized: the call that was taken over stops
  expect(await s.marker()).toEqual(settled); // and wrote no progress of its own
  expect(await s.marker()).toHaveProperty('complete_at');
  const free = C.mkTeam('hard-overlap-free');
  await s.account(free.f, [], {}, free);
  expect(await s.enrolled(free.team)).toBe(free.f.pubkey);
});

test('a restart re-scans across later calls until it completes, and the marker stays set throughout', async () => {
  const s = world('hard-rescan', { backfilled: false });
  s.stripe.subs.clear();
  s.stripe.pageSize = 1;
  for (const sub of ['sub_Q1', 'sub_Q2']) s.stripe.subs.set(sub, C.LH.subscription({ id: sub, metadata: { walkie_team: s.t.team } }));
  const call = (restart = false) => backfillLicenceBindings(s.w.store, s.stripe, { now: () => C.T0, budgetMs: 0, restart });
  for (let i = 0; i < 3 && (await call()).complete !== true; i++);
  expect(await s.marker()).toHaveProperty('complete_at');
  s.stripe.subs.set('sub_Q3', C.LH.subscription({ id: 'sub_Q3', metadata: { walkie_team: s.t.team } })); // never recorded
  expect(await call(true)).toMatchObject({ complete: false, pages: 1 });
  expect(await call()).toMatchObject({ complete: false, pages: 1 }); // a later plain call continues the re-scan
  expect(await s.marker()).toHaveProperty('complete_at');
  expect(await call()).toMatchObject({ complete: true, pages: 1 });
  expect((await s.bindings())?.subscriptions).toEqual(['sub_Q1', 'sub_Q2', 'sub_Q3']);
  expect(await call()).toMatchObject({ complete: true, pages: 0 }); // done: no-op again
});

// ---- 5. Codex P2-3 / Opus P3 S1: direct reads decide; search-only ids are verified; the search is bounded as a whole ----

test('PROBE S1: a stale search result cannot override the direct read of a recorded licence', async () => {
  const w = C.world(), t = C.mkTeam('hard-stale');
  await w.store.tx(x => x.setControl(bindingsKey(t.team), { subscriptions: ['sub_S1'] }));
  const fresh = C.LH.subscription({ id: 'sub_S1', metadata: { walkie_team: t.team, walkie_authority: 'N_KEY_FRESH' } });
  const stale = C.LH.subscription({ id: 'sub_S1', metadata: { walkie_team: t.team, walkie_authority: 'F_KEY_STALE' } });
  w.d.licenceById = async () => fresh;
  w.d.teamLicences = async () => [stale];
  const gate = await firstEnrollmentGate(w.d, t.team, false);
  expect(gate.kind === 'gate' ? [...gate.live] : gate).toEqual([['sub_S1', 'N_KEY_FRESH']]);
});

test('a search-only licence counts only after a direct read confirms it', async () => {
  const w = C.world(), t = C.mkTeam('hard-search-only');
  const claimed = C.LH.subscription({ id: 'sub_GHOST', metadata: { walkie_team: t.team, walkie_authority: 'F_KEY' } });
  const reads: string[] = [];
  w.d.teamLicences = async () => [claimed];
  w.d.licenceById = async (lic: string) => { reads.push(lic); return C.LH.subscription({ id: lic, status: 'canceled', metadata: {} }); };
  const gate = await firstEnrollmentGate(w.d, t.team, false);
  expect(reads).toEqual(['sub_GHOST']);
  expect(gate.kind === 'gate' ? [...gate.live] : gate).toEqual([]);
});

test('the whole multi-page search is bounded by one deadline, and no page is requested after it', async () => {
  const requested: { page: string | undefined; timeout: number }[] = [];
  const pages = ['p1', 'p2', 'p3', 'p4'];
  const fetchPage = async (page: string | undefined, timeout: number) => {
    requested.push({ page, timeout });
    await Bun.sleep(30);
    const i = page ? pages.indexOf(page) + 1 : 0;
    return { data: [] as SubscriptionLite[], nextPage: i < pages.length ? pages[i]! : null };
  };
  const started = Date.now();
  await expect(searchAllPages(fetchPage, 70)).rejects.toThrow('licence_search_deadline');
  expect(Date.now() - started).toBeLessThan(120);
  expect(requested.length).toBeLessThanOrEqual(3);
  expect(requested.every((r, i) => i === 0 ? r.timeout === 70 : r.timeout < 70)).toBe(true);
  await Bun.sleep(60);
  expect(requested.length).toBeLessThanOrEqual(3); // nothing more after the deadline
  // A page that ignores its timeout is still cut at the deadline.
  const hung = Date.now();
  // (Raced against the test's own 500 ms, so a regression fails here instead of hanging the suite: Opus N18.)
  await expect(Promise.race([searchAllPages(() => new Promise(() => undefined), 40),
    Bun.sleep(500).then(() => { throw Error('search never gave up'); })])).rejects.toThrow('licence_search_deadline');
  expect(Date.now() - hung).toBeLessThan(100);
  // A page that answers only after the deadline (here it blocks the event loop past it): no further page is requested.
  let overshoots = 0;
  await expect(searchAllPages(async () => {
    const until = Date.now() + 60;
    while (Date.now() < until) { /* overshoot the 40 ms deadline */ }
    return { data: [], nextPage: ++overshoots < 2 ? 'p1' : null };
  }, 40)).rejects.toThrow('licence_search_deadline');
  expect(overshoots).toBe(1);
  const all = await searchAllPages(async (page) => ({ data: [C.LH.subscription({ id: `sub_${page ?? 'p0'}` })],
    nextPage: page === undefined ? 'p1' : page === 'p1' ? 'p2' : null }), 1_000);
  expect(all.map(sub => sub.id)).toEqual(['sub_p0', 'sub_p1', 'sub_p2']);
});

// ---- 6. Codex P2-4: the credential path fails closed and alerts ------------------------------------------------------

test('a credentialed presenter with no licence key, or a timed-out credential check, gets 503 and the alert', async () => {
  const s = world('hard-credential'), n = C.generateKeys(), fToN = s.move(s.t.f, n);
  const bound = await s.bind();
  const creds = { lic_id: s.id, renewal_token: bound.body.renewal_token };
  const alerts = () => s.w.logs.filter(event => event === 'alert_licence_read_failed').length;
  const reasons: unknown[] = [], log = s.w.d.log;
  s.w.d.log = (event: string, fields: unknown) => { if (event === 'licence_read_failed_reason') reasons.push(fields); log(event, fields); };
  // The deployed wiring without STRIPE_SECRET_KEY has no verifier:
  const unkeyed = await computeFromEnv({ COMPUTE_PRIVATE_CONFIG: configJson(), COMPUTE_ENABLED: '1',
    COMPUTE_HANDOVER_TOKEN_KEY: 'rent-fixture-handover-key-32-bytes' }, C.world().store);
  expect(unkeyed?.verifyLicense).toBeUndefined();
  s.w.d.verifyLicense = undefined;
  expect(await C.err(s.account(n, [fToN], creds))).toBe('license_verification_unavailable');
  expect(alerts()).toBe(1);
  expect(reasons).toEqual([{ team: s.t.team, reason: 'licence_verifier_unconfigured' }]);
  s.w.d.verifyLicense = async () => { throw Error('request timed out'); };
  expect(await C.err(s.account(n, [fToN], creds))).toBe('license_verification_unavailable');
  expect(alerts()).toBe(2);
  expect(await s.enrolled()).toBeUndefined();
});

// ---- 7. Codex P2-5: authenticate before charging the operator's rate limit ---------------------------------------------

test('unauthenticated backfill calls do not exhaust the operator quota; the operator quota still applies', async () => {
  const s = world('hard-quota', { backfilled: false });
  const wrong: number[] = [];
  for (let i = 0; i < 70; i++) wrong.push((await s.backfill({}, 'Bearer wrong')).status);
  expect([wrong.filter(code => code === 401).length, wrong.filter(code => code === 429).length]).toEqual([60, 10]);
  expect((await s.backfill()).status).toBe(200);
  let limited = 0;
  for (let i = 0; i < 61; i++) if ((await s.backfill()).status === 429) limited++;
  expect(limited).toBeGreaterThan(0); // the operator's own per-IP limit (60 an hour) still holds
});

// ---- 8. Opus P3 3: mutations that survived -----------------------------------------------------------------------------

test('a signed bind on the lock-ON site records the binding (M10)', async () => {
  const s = world('hard-signed'), n = C.generateKeys(), fToN = s.move(s.t.f, n);
  expect((await s.bind({ keys: n, moves: [fToN] })).status).toBe(200);
  expect((await s.bindings())?.subscriptions).toEqual([s.id]);
});

test('under the lock a credentialed presenter is admitted even when a binding appeared since the reads (M35)', async () => {
  const w = C.world(), t = C.mkTeam('hard-m35'), owner = C.proof(t.f, t.team, w.clock.now, t.genesis) as never;
  await w.store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 }));
  await w.store.tx(x => x.setControl(bindingsKey(t.team), { subscriptions: ['sub_SINCE'] }));
  const gate = { kind: 'gate' as const, recorded: new Set<string>(), live: new Map<string, string | null>() };
  expect(await w.store.tx(x => firstEnrollmentRefusal(x, t.team, gate, owner, true))).toBeNull();
  expect(await w.store.tx(x => firstEnrollmentRefusal(x, t.team, gate, owner, false))).toBe('not_licence_authority');
});

test('the backfill writes each team record under that team lock (M37)', async () => {
  const base = C.world(), order: string[] = [];
  const store = new Proxy(base.store, { get(target, prop) {
    if (prop === 'tx') return (fn: (t: Tx) => Promise<unknown>) => target.tx(t => fn({ ...t,
      lockControl: async (key: string) => { order.push(`lock ${key}`); return t.lockControl(key); },
      setControl: async (key: string, value: unknown) => { order.push(`set ${key}`); return t.setControl(key, value); } }));
    const v = (target as unknown as Record<string | symbol, unknown>)[prop];
    return typeof v === 'function' ? (v as Function).bind(target) : v;
  } }) as ComputeStore;
  const stripe = new C.LH.MockStripe(), team = C.mkTeam('hard-m37').team;
  stripe.subs.set('sub_M37', C.LH.subscription({ id: 'sub_M37', metadata: { walkie_team: team } }));
  await backfillLicenceBindings(store, stripe, { now: () => C.T0, budgetMs: 1_000 });
  const set = order.indexOf(`set ${bindingsKey(team)}`);
  expect(set).toBeGreaterThan(0);
  expect(order.slice(0, set).includes(`lock enrollment-chain:${team}`)).toBe(true);
});

test("renew's fork flag still refuses a rejected handover digest (M26)", async () => {
  const s = world('hard-m26'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  const token = Buffer.alloc(32, 26).toString('base64url');
  s.stripe.subs.set(s.id, C.LH.subscription({ id: s.id, metadata: { walkie_team: s.t.team, walkie_renew_hash: renewHash(token) } }));
  const fToX = s.move(f, x), fToN = s.move(f, n);
  await s.account(x, [fToX], { lic_id: s.id, renewal_token: token }); // X enrolls first with the shared token
  const nChain = teamAuthority(s.t.team, s.roster([fToN]) as never)!;
  await s.w.store.tx(t => t.setControl(`compute-handover-rejected-digests:${s.t.team}`, [nChain.chainId]));
  const expires_at = s.w.clock.now + 240_000;
  const res = await makeRenew({ ...C.LH.deps(s.stripe, s.env), now: () => s.w.clock.now, computeStore: () => s.w.store })(
    new Request('https://site.test/api/license/renew', { method: 'POST', body: JSON.stringify({ lic_id: s.id, renewal_token: token,
      proof: { ...s.roster([fToN]), expires_at, renew_signature: n.sign(renewMessage(s.t.team, s.id, expires_at)) } }) }));
  expect(res.status).toBe(403);
  expect(await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBeUndefined(); // rejected: no fork
});
