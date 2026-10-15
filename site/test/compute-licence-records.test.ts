// Lane C round 10 (REVIEW-fixdiff-codex P1 and P2-4, REVIEW-fixdiff-opus P3): a team's first compute enrollment is
// decided under the team lock from the site's own record of bound licences (licence-records.ts), written by bind and by
// a one-time operator backfill; Stripe's search can only add a licence. MemoryStore + MockStripe; no network.
import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { BACKFILL_KEY, backfillLicenceBindings, bindingsKey, licenceReads } from '../api/_lib/compute/licence-records.ts';
import { makeLicenceBackfill } from '../api/compute/licence-backfill.ts';
import type { ReadOptions, SubscriptionLite } from '../api/_lib/stripe.ts';

type Keys = ReturnType<typeof C.generateKeys>;
type Move = { transfer: { key: string; event: unknown }; events: unknown[] };
const secret = ['0123456789', 'abcdef'].join('').repeat(2); // built at runtime: no key-shaped literal (scripts/public-gitleaks.toml)

function world(name: string, opts: { backfilled?: boolean } = {}) {
  const w = C.world(), t = C.mkTeam(name), stripe = new C.LH.MockStripe(), signer = C.LH.testKeypair();
  const env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1' });
  const id = `sub_${name.replace(/[^A-Za-z0-9]/g, '')}`;
  stripe.subs.set(id, C.LH.subscription({ id }));
  let search: (team: string) => Promise<readonly SubscriptionLite[]> = async () => []; // the index lags: finds nothing
  w.d.verifyLicense = C.licenseVerifier(stripe);
  w.d.teamLicences = async (team: string) => search(team);
  w.d.licenceById = async (lic: string) => stripe.getSubscription(lic);
  if (opts.backfilled !== false) void w.store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7, email: 'lead@kestrel.test',
    interval: 'month', issued_at: C.T0, expires_at: C.T0 + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
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
  /** `released`: the pre-flip site (no store, proof ignored: C.LH.releasedBind). Otherwise the lock-ON site with its store. */
  const bind = async (keys: Keys | null, moves: Move[], released = false) => {
    if (released) return C.LH.releasedBind(stripe, id, t.team);
    const expires_at = w.clock.now + 240_000;
    const site = { ...C.LH.deps(stripe, env), computeStore: () => w.store };
    const proof = keys ? { ...roster(moves), expires_at, bind_signature: keys.sign(C.bindMessage(t.team, id, expires_at)) } : undefined;
    const res = await C.makeBind({ ...site, now: () => w.clock.now })(new Request('https://site.test/api/license/bind', {
      method: 'POST', body: JSON.stringify({ code, team_id: t.team, ...(proof ? { proof } : {}) }) }));
    return { status: res.status, body: await res.json() as { renewal_token?: string } };
  };
  const account = (keys: Keys, moves: Move[] = [], extra: object = {}) => C.createAccount(w.d, t.team,
    C.proof(keys, t.team, w.clock.now, t.genesis, moves.map(m => m.transfer), { roster_events: moves.flatMap(m => m.events), ...extra }));
  const backfill = async (body: object = {}, auth = `Bearer ${secret}`) => {
    const res = await makeLicenceBackfill({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d, stripe: () => null,
      licenseStripe: () => stripe } as never)(new Request('https://site.test/api/compute/licence-backfill', { method: 'POST',
      headers: { authorization: auth }, body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const bindings = () => w.store.tx(x => x.control(bindingsKey(t.team))) as Promise<{ subscriptions: string[] } | undefined>;
  const enrolled = async () => (await w.store.tx(x => x.enrollment(t.team)))?.key;
  return { w, t, stripe, id, move, bind, account, backfill, bindings, enrolled, setSearch: (fn: typeof search) => { search = fn; } };
}

test('a binding the store recorded refuses a presenter although the Stripe search returns nothing', async () => {
  const s = world('records-lag'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  const fToN = s.move(f, n), fToX = s.move(f, x);
  const bound = await s.bind(null, []); // N's daemon activates through the lock-ON site: recorded under the team lock
  expect(bound.status).toBe(200);
  expect((await s.bindings())?.subscriptions).toEqual([s.id]);
  expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required');
  await s.account(n, [fToN], { lic_id: s.id, renewal_token: bound.body.renewal_token });
  expect(await s.enrolled()).toBe(n.pubkey);
});

test('until the backfill completes every first enrollment answers 503; the backfill then records pre-flip licences', async () => {
  const s = world('records-backfill', { backfilled: false }), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  const fToN = s.move(f, n), fToX = s.move(f, x);
  const bound = await s.bind(n, [fToN], true); // bound before the flip: no store, nothing recorded
  expect(await s.bindings()).toBeUndefined();
  expect(await C.err(s.account(x, [fToX]))).toBe('licence_backfill_pending');
  expect(await C.err(s.account(n, [fToN], { lic_id: s.id, renewal_token: bound.body.renewal_token }))).toBe('licence_backfill_pending');
  expect((await s.backfill({}, 'Bearer wrong')).status).toBe(401);
  expect(await s.backfill()).toMatchObject({ status: 200, body: { complete: true, scanned: 1, recorded: 1 } });
  expect((await s.bindings())?.subscriptions).toEqual([s.id]);
  expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required'); // the search still finds nothing
  await s.account(n, [fToN], { lic_id: s.id, renewal_token: bound.body.renewal_token });
  expect(await s.enrolled()).toBe(n.pubkey);
  expect(s.stripe.calls.metadata).toEqual([]); // the released bind is set directly; the backfill only reads
});

test('the backfill pages through the list API to the end, resumes from its cursor and is idempotent', async () => {
  const s = world('records-pages', { backfilled: false });
  const a = C.mkTeam('records-pages-a').team, b = C.mkTeam('records-pages-b').team;
  s.stripe.subs.clear();
  for (const [sub, team] of [['sub_A1', a], ['sub_A2', a], ['sub_A3', a], ['sub_B1', b], ['sub_B2', b], ['sub_U1', ''], ['sub_U2', '']])
    s.stripe.subs.set(sub, C.LH.subscription({ id: sub, metadata: team ? { walkie_team: team } : {} }));
  s.stripe.pageSize = 2; // 7 subscriptions: 4 pages
  const step = () => backfillLicenceBindings(s.w.store, s.stripe, { now: () => C.T0, budgetMs: 0 }); // one page per call
  const results = [await step(), await step(), await step()];
  expect(results.map(r => [r.complete, r.pages, r.cursor])).toEqual([[false, 1, 'sub_A2'], [false, 1, 'sub_B1'], [false, 1, 'sub_U1']]);
  expect(await s.w.store.tx(x => x.control(BACKFILL_KEY))).not.toHaveProperty('complete_at');
  expect(await step()).toMatchObject({ complete: true, pages: 1, scanned: 7, recorded: 5 });
  const recorded = async () => [await s.w.store.tx(x => x.control(bindingsKey(a))), await s.w.store.tx(x => x.control(bindingsKey(b)))];
  expect(await recorded()).toEqual([{ subscriptions: ['sub_A1', 'sub_A2', 'sub_A3'] }, { subscriptions: ['sub_B1', 'sub_B2'] }]);
  expect(s.stripe.pages).toBe(4);
  expect(await s.backfill()).toMatchObject({ status: 200, body: { complete: true, pages: 0 } }); // done: no more pages
  expect(s.stripe.pages).toBe(4);
  expect(await s.backfill({ restart: true })).toMatchObject({ status: 200, body: { complete: true, pages: 4, scanned: 7 } });
  expect(await recorded()).toEqual([{ subscriptions: ['sub_A1', 'sub_A2', 'sub_A3'] }, { subscriptions: ['sub_B1', 'sub_B2'] }]);
  expect(s.stripe.calls.metadata).toEqual([]);
});

test('a bind landing between the reads and the lock is seen under the lock', async () => {
  const s = world('records-race'), f = s.t.f, x = C.generateKeys(), fToX = s.move(f, x);
  // X's reads find nothing; then, before X's transaction takes the team lock, N's activation records the licence.
  s.setSearch(async () => { expect((await s.bind(null, [])).status).toBe(200); return []; });
  expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required');
  expect(await s.enrolled()).toBeUndefined();
});

test('a missing licence key, failing reads and repeated timeouts answer 503 with licence_read_failed', async () => {
  const s = world('records-unreadable'), n = C.generateKeys(), fToN = s.move(s.t.f, n);
  await s.bind(null, []); // recorded: the gate must read this licence's live state
  const failures = () => s.w.logs.filter(event => event === 'alert_licence_read_failed').length;
  const unkeyed = licenceReads(null); // the deployed wiring without STRIPE_SECRET_KEY
  s.w.d.teamLicences = unkeyed.teamLicences; s.w.d.licenceById = unkeyed.licenceById;
  expect(await C.err(s.account(n, [fToN]))).toBe('license_verification_unavailable');
  expect(failures()).toBe(1);
  // Each read is a Stripe request bounded by its own timeout, with no SDK retries; a timed-out read has ended.
  const seen: ReadOptions[] = [];
  let inFlight = 0;
  const slow = <T>(options?: ReadOptions) => new Promise<T>((_, reject) => {
    seen.push(options ?? {}); inFlight++;
    setTimeout(() => { inFlight--; reject(Error('request timed out')); }, options?.timeout ?? 60_000);
  });
  const sdk = { listSubscriptionsByTeam: (_t: string, o?: ReadOptions) => slow<SubscriptionLite[]>(o),
    getSubscription: (_i: string, o?: ReadOptions) => slow<SubscriptionLite | null>(o) };
  const timed = licenceReads(sdk);
  s.w.d.teamLicences = timed.teamLicences; s.w.d.licenceById = timed.licenceById; s.w.d.licenceReadMs = 20;
  for (let i = 0; i < 3; i++) expect(await C.err(s.account(n, [fToN]))).toBe('license_verification_unavailable');
  expect(seen).toHaveLength(6);
  expect(seen.every(o => o.timeout === 20 && o.maxNetworkRetries === 0)).toBe(true);
  await Bun.sleep(40); // past the per-request timeout: every read has ended on its own bound, none is left running
  expect(inFlight).toBe(0);
  expect(failures()).toBe(4);
  expect(await s.enrolled()).toBeUndefined();
});

test('a credentialed holder is admitted without the search, so a search outage does not refuse it', async () => {
  const s = world('records-credentialed'), n = C.generateKeys(), fToN = s.move(s.t.f, n);
  const bound = await s.bind(null, []);
  s.setSearch(async () => { throw Error('search down'); });
  s.w.d.licenceById = async () => { throw Error('stripe down'); };
  await s.account(n, [fToN], { lic_id: s.id, renewal_token: bound.body.renewal_token });
  expect(await s.enrolled()).toBe(n.pubkey);
});

test('a live licence that is not active still admits its authority; an ended one does not count', async () => {
  for (const status of ['past_due', 'unpaid', 'incomplete', 'paused', 'trialing']) {
    const s = world(`records-${status}`), f = s.t.f, n = C.generateKeys(), fToN = s.move(f, n);
    const bound = await s.bind(null, []);
    s.stripe.subs.set(s.id, { ...s.stripe.subs.get(s.id)!, status });
    await s.account(n, [fToN], { lic_id: s.id, renewal_token: bound.body.renewal_token }); // by credentials
    expect(await s.enrolled()).toBe(n.pubkey);
  }
  const head = world('records-head-pastdue'), n = C.generateKeys(), fToN = head.move(head.t.f, n);
  expect((await head.bind(n, [fToN])).status).toBe(200); // a licence naming N's key
  head.stripe.subs.set(head.id, { ...head.stripe.subs.get(head.id)!, status: 'past_due' });
  await head.account(n, [fToN]); // by chain head, no credentials
  expect(await head.enrolled()).toBe(n.pubkey);
  const ended = world('records-canceled'), y = C.generateKeys();
  await ended.bind(null, []);
  ended.stripe.subs.set(ended.id, { ...ended.stripe.subs.get(ended.id)!, status: 'canceled' });
  await ended.account(y, [ended.move(ended.t.f, y)]); // a canceled licence does not bind the team: trust on first use
  expect(await ended.enrolled()).toBe(y.pubkey);
});

test('a refused presenter pages the operator once a day; a different presenter pages again', async () => {
  const s = world('records-page'), f = s.t.f, x = C.generateKeys(), y = C.generateKeys();
  await s.bind(null, []);
  const pages = () => s.w.logs.filter(event => event === 'alert_enrollment_licence_refused').length;
  const fToX = s.move(f, x), fToY = s.move(f, y);
  for (let i = 0; i < 3; i++) expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required');
  expect(pages()).toBe(1);
  expect(await C.err(s.account(y, [fToY]))).toBe('team_ownership_required');
  expect(pages()).toBe(2);
  s.w.clock.now += 24 * 60 * 60_000;
  expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required');
  expect(pages()).toBe(3);
});
