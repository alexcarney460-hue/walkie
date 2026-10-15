// Lane C round 13 (REVIEW-r12-codex P2-1; REVIEW-r12-opus P3 1, 3 and 6): ended licences no longer lock a team out of its
// first enrollment (search results already ended are skipped; recorded ones are pruned in bounded, resumable batches
// under the team lock, and only on a direct read showing a final status), busy backfill answers cost the operator
// nothing, and the lease and gate edges Opus found untested. MemoryStore + MockStripe; no network.
import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { BACKFILL_KEY, backfillLicenceBindings, bindingsKey, recordLicenceBindings } from '../api/_lib/compute/licence-records.ts';
import { makeLicenceBackfill } from '../api/compute/licence-backfill.ts';
import type { ComputeStore, Tx } from '../api/_lib/compute/store.ts';
import type { SubscriptionLite } from '../api/_lib/stripe.ts';

type Keys = ReturnType<typeof C.generateKeys>;
type BindingRecord = { subscriptions: string[]; overflow?: boolean };
const secret = ['0123456789', 'abcdef'].join('').repeat(2); // built at runtime: no key-shaped literal (scripts/public-gitleaks.toml)
const PAST_ANY_LEASE = 60_000;

function world(name: string, opts: { backfilled?: boolean } = {}) {
  const w = C.world(), t = C.mkTeam(name), stripe = new C.LH.MockStripe(), signer = C.LH.testKeypair();
  const reads = { byId: 0, batches: [] as number[] };
  let inAttempt = 0, search: readonly SubscriptionLite[] = [];
  w.d.verifyLicense = C.licenseVerifier(stripe);
  w.d.teamLicences = async () => search;
  w.d.licenceById = async (lic: string) => { reads.byId++; inAttempt++; return stripe.getSubscription(lic); };
  if (opts.backfilled !== false) void w.store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 }));
  const subs = (prefix: string, n: number, status = 'active', metadata: { [k: string]: string } = {}) =>
    Array.from({ length: n }, (_, i) => {
      const id = `sub_${prefix}${String(i).padStart(4, '0')}`;
      stripe.subs.set(id, C.LH.subscription({ id, status, metadata: { walkie_team: t.team, ...metadata } }));
      return id;
    });
  const record = async () => (await w.store.tx(x => x.control(bindingsKey(t.team)))) as BindingRecord | undefined;
  const setRecord = (ids: readonly string[]) => w.store.tx(x => x.setControl(bindingsKey(t.team), { subscriptions: [...ids].sort() }));
  /** One first-enrollment attempt by `keys` (the founder by default, no credentials); counts its by-id reads. */
  const attempt = async (keys: Keys = t.f, moves: { transfer: { key: string; event: unknown }; events: unknown[] }[] = [],
    extra: object = {}) => {
    inAttempt = 0;
    const answer = await C.err(C.createAccount(w.d, t.team, C.proof(keys, t.team, w.clock.now, t.genesis,
      moves.map(m => m.transfer), { roster_events: moves.flatMap(m => m.events), ...extra })));
    reads.batches.push(inAttempt);
    return answer;
  };
  const enrolled = async () => (await w.store.tx(x => x.enrollment(t.team)))?.key;
  const move = (by: Keys, to: Keys) => {
    const ev = (n: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(by, { v: C.PROTOCOL_VERSION, team: t.team,
      id: `${by.nodeId}:${n}`, origin: by.nodeId, seq: n, ts: C.T0 + n, author: { handle: 'alex', node: by.nodeId }, kind, body });
    const transfer = C.transfer(by, t.team, 6, to);
    return { transfer, events: [ev(4, 'team.member', { login: `direct:${to.nodeId}`, handle: 'h4', role: 'owner' }),
      ev(5, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'm4', pubkey: to.pubkey, ip: '127.0.0.1' }),
      transfer.event] };
  };
  const route = (stripeFor: () => unknown) => makeLicenceBackfill({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret },
    compute: () => w.d, stripe: () => null, licenseStripe: stripeFor } as never);
  const post = async (handler: (req: Request) => Promise<Response>) => {
    const res = await handler(new Request('https://site.test/api/compute/licence-backfill', { method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'x-real-ip': '203.0.113.13' }, body: '{}' }));
    return { status: res.status, body: await res.json() as { error?: string; complete?: boolean } };
  };
  return { w, t, stripe, signer, reads, subs, record, setRecord, attempt, enrolled, move, route, post,
    setSearch: (found: readonly SubscriptionLite[]) => { search = found; } };
}
const alerts = (logs: readonly string[], kind: string) => logs.filter(event => event === `alert_${kind}`).length;

// ---- 1. Codex P2-1 / Opus P3 1: ended licences do not lock a team out ------------------------------------------------

test('more than 50 ended recorded licences and no live one: pruned in bounded batches, then the team enrolls', async () => {
  const s = world('r13-prune');
  await s.setRecord([...s.subs('EA', 80, 'canceled'), ...s.subs('EB', 70, 'incomplete_expired')]);
  const answers: string[] = [];
  for (let i = 0; i < 6 && answers.at(-1) !== 'ok'; i++) answers.push(await s.attempt());
  expect(answers).toEqual(['licence_record_pruning', 'licence_record_pruning', 'ok']);
  expect(s.reads.batches.every(n => n <= 50)).toBe(true);
  expect((await s.record())?.subscriptions.length).toBeLessThanOrEqual(50);
  expect(await s.enrolled()).toBe(s.t.f.pubkey);
  expect(alerts(s.w.logs, 'licence_bindings_overflow')).toBe(0);
});

test('a live licence among 60 ended ones is never dropped, and it decides', async () => {
  const s = world('r13-live'), n = C.generateKeys();
  const [live] = s.subs('LV', 1, 'active', { walkie_authority: n.pubkey });
  await s.setRecord([live!, ...s.subs('EN', 60, 'canceled')]);
  const answers: string[] = [];
  for (let i = 0; i < 6 && answers.at(-1) !== 'team_ownership_required'; i++) {
    answers.push(await s.attempt());
    expect((await s.record())?.subscriptions).toContain(live!);
  }
  expect(answers).toEqual(['licence_record_pruning', 'team_ownership_required']); // the founder: the live licence names N
  expect(await s.enrolled()).toBeUndefined();
  expect(await s.attempt(n, [s.move(s.t.f, n)])).toBe('ok'); // N, the authority the live licence names
  expect(await s.enrolled()).toBe(n.pubkey);
});

test('only a direct read showing a final status drops an id: live, past-due, paused and not-found ids are kept', async () => {
  const s = world('r13-final');
  const ended = s.subs('FE', 10, 'canceled');
  const kept = [...s.subs('FA', 10, 'past_due'), ...s.subs('FB', 10, 'unpaid'), ...s.subs('FC', 10, 'paused'),
    ...s.subs('FD', 10, 'trialing'), ...s.subs('FF', 5, 'incomplete')];
  const missing = Array.from({ length: 5 }, (_, i) => `sub_FG${i}`); // never in Stripe: not found, not final
  await s.setRecord([...ended, ...kept, ...missing]);
  expect(await s.attempt()).toBe('licence_record_pruning');
  const left = (await s.record())!.subscriptions;
  expect(ended.some(id => left.includes(id))).toBe(false);
  expect([...kept, ...missing].every(id => left.includes(id))).toBe(true);
});

test('a failed read during pruning drops nothing and answers the retryable read failure', async () => {
  const s = world('r13-readfail');
  const ids = s.subs('RF', 60, 'canceled');
  await s.setRecord(ids);
  let calls = 0;
  const read = s.w.d.licenceById!;
  s.w.d.licenceById = async (lic: string, o: { timeout: number }) => { if (++calls === 7) throw Error('stripe 500'); return read(lic, o); };
  expect(await s.attempt()).toBe('license_verification_unavailable');
  expect((await s.record())!.subscriptions).toHaveLength(60);
  expect(alerts(s.w.logs, 'licence_read_failed')).toBe(1);
});

test('more than 50 live recorded licences: after one full pass with nothing to drop, licence_bindings_overflow and the alert', async () => {
  const s = world('r13-alllive');
  const ids = s.subs('AL', 60, 'active');
  await s.setRecord(ids);
  expect(await s.attempt()).toBe('licence_record_pruning'); // 50 read, all kept: the pass is not finished
  // A bind between the attempts keeps the pruning position (the new id is not in Stripe here: read as not found, kept).
  await s.w.store.tx(x => recordLicenceBindings(x, s.t.team, ['sub_ZZBIND']));
  expect(await s.attempt()).toBe('licence_bindings_overflow'); // every id read since the last drop, still more than 50
  expect(alerts(s.w.logs, 'licence_bindings_overflow')).toBe(1);
  expect((await s.record())!.subscriptions).toHaveLength(61);
});

test('60 live and 60 ended recorded: the batches rotate, the ended are dropped, and only then the overflow', async () => {
  const s = world('r13-mixed');
  const live = s.subs('LA', 60, 'active'), ended = s.subs('LB', 60, 'canceled');
  await s.setRecord([...live, ...ended]);
  const answers: string[] = [];
  for (let i = 0; i < 6 && answers.at(-1) !== 'licence_bindings_overflow'; i++) answers.push(await s.attempt());
  // 50 live kept; 10 live + 40 ended (40 dropped); 20 ended + 30 live (20 dropped); 30 + 20 live: every live one read
  // since the last drop.
  expect(answers).toEqual(['licence_record_pruning', 'licence_record_pruning', 'licence_record_pruning', 'licence_bindings_overflow']);
  expect((await s.record())!.subscriptions).toEqual([...live].sort());
});

test('pruning drops ids under the team lock', async () => {
  const s = world('r13-lock');
  await s.setRecord(s.subs('PL', 60, 'canceled'));
  const base = s.w.store, calls: string[] = [];
  s.w.d.store = new Proxy(base, { get(target, prop) {
    if (prop === 'tx') return <T>(fn: (t: Tx) => Promise<T>) => target.tx(t => fn({ ...t,
      lockControl: async (key: string) => { calls.push(`lock ${key}`); await t.lockControl(key); },
      setControl: async (key: string, value: unknown) => { calls.push(`set ${key}`); await t.setControl(key, value); } }));
    const value = Reflect.get(target, prop) as unknown;
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  } }) as ComputeStore;
  expect(await s.attempt()).toBe('licence_record_pruning');
  const write = calls.indexOf(`set ${bindingsKey(s.t.team)}`);
  expect(write).toBeGreaterThan(0);
  expect(calls[write - 1]).toBe(`lock enrollment-chain:${s.t.team}`);
});

test('more than 50 canceled subscriptions in the search history: skipped without a read, and the team enrolls', async () => {
  const s = world('r13-search');
  s.setSearch(s.subs('SC', 60, 'canceled').map(id => s.stripe.subs.get(id)!));
  expect(await s.attempt()).toBe('ok');
  expect(s.reads.byId).toBe(0);
});

test('a search reporting more than 50 live-looking subscriptions still answers licence_bindings_overflow, with the alert (O11)', async () => {
  const s = world('r13-search-live');
  s.setSearch(s.subs('SL', 60, 'active').map(id => s.stripe.subs.get(id)!));
  expect(await s.attempt()).toBe('licence_bindings_overflow');
  expect(s.reads.byId).toBe(0);
  expect(alerts(s.w.logs, 'licence_bindings_overflow')).toBe(1);
});

test('a bind recorded while a team is being pruned keeps its id and the pruning position', async () => {
  const s = world('r13-bind-during');
  await s.setRecord(s.subs('BD', 120, 'canceled'));
  expect(await s.attempt()).toBe('licence_record_pruning');
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: 'sub_NEWBIND', plan: 'team', seats: 7, email: 'lead@kestrel.test',
    interval: 'month', issued_at: C.T0, expires_at: C.T0 + 30 * 86_400_000 }, C.signingKeyFromPem(s.signer.pem));
  s.stripe.subs.set('sub_NEWBIND', C.LH.subscription({ id: 'sub_NEWBIND' }));
  const bound = await C.makeBind({ ...C.LH.deps(s.stripe, C.LH.fullEnv(s.signer.pem, { COMPUTE_ENABLED: '1' })),
    computeStore: () => s.w.store, now: () => s.w.clock.now })(new Request('https://site.test/api/license/bind',
    { method: 'POST', body: JSON.stringify({ code, team_id: s.t.team }) }));
  expect(bound.status).toBe(200);
  expect((await s.record())!.subscriptions).toContain('sub_NEWBIND');
  const answers: string[] = [];
  for (let i = 0; i < 4 && !['ok', 'team_ownership_required'].includes(answers.at(-1) ?? ''); i++) answers.push(await s.attempt());
  expect(answers).toEqual(['licence_record_pruning', 'team_ownership_required']); // the new live licence decides
  expect((await s.record())!.subscriptions).toContain('sub_NEWBIND');
});

// ---- 3. Opus P3 3: a busy answer costs the operator nothing ----------------------------------------------------------

test("busy answers do not spend the operator's quota; the wrong bearer is still refused first", async () => {
  const s = world('r13-quota', { backfilled: false });
  s.stripe.subs.clear();
  s.subs('QT', 3);
  s.stripe.pageSize = 1;
  let release!: () => void;
  const hung = new Promise<void>(r => { release = r; });
  const dead = { listSubscriptionsPage: async (after?: string) => { await hung; return s.stripe.listSubscriptionsPage(after); } };
  const holder = backfillLicenceBindings(s.w.store, dead, { now: () => s.w.clock.now, budgetMs: 10_000 });
  await Bun.sleep(5);
  const handler = s.route(() => s.stripe);
  const codes: number[] = [];
  for (let i = 0; i < 70; i++) codes.push((await s.post(handler)).status);
  expect(codes.every(code => code === 409)).toBe(true);
  const wrong = await handler(new Request('https://site.test/api/compute/licence-backfill', { method: 'POST',
    headers: { authorization: 'Bearer wrong', 'x-real-ip': '203.0.113.13' }, body: '{}' }));
  expect(wrong.status).toBe(401);
  release();
  await holder;
  expect(await s.post(handler)).toMatchObject({ status: 200, body: { complete: true } });
});

test('a call that takes the lease just after the busy check still answers 409 licence_backfill_busy', async () => {
  const s = world('r13-race', { backfilled: false });
  s.stripe.subs.clear();
  s.subs('RC', 2);
  let release!: () => void;
  const hung = new Promise<void>(r => { release = r; });
  const holder = backfillLicenceBindings(s.w.store, { listSubscriptionsPage: async (after?: string) => { await hung;
    return s.stripe.listSubscriptionsPage(after); } }, { now: () => s.w.clock.now, budgetMs: 10_000 });
  await Bun.sleep(5);
  // The route's busy check reads the backfill row before the holder's lease is visible to it; the backfill then sees it.
  let first = true;
  const base = s.w.store;
  s.w.d.store = new Proxy(base, { get(target, prop) {
    if (prop === 'tx') return <T>(fn: (t: Tx) => Promise<T>) => target.tx(t => fn({ ...t, control: async (key: string) => {
      if (key === BACKFILL_KEY && first) { first = false; return undefined; }
      return t.control(key);
    } }));
    const value = Reflect.get(target, prop) as unknown;
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  } }) as ComputeStore;
  expect(await s.post(s.route(() => s.stripe))).toEqual({ status: 409, body: { error: 'licence_backfill_busy' } });
  release();
  await holder;
});

// ---- 5. Opus P3 6: the lease and gate edges that were untested -------------------------------------------------------

test('each page write renews the lease: a call running longer than the lease, but writing, is not taken over (L03)', async () => {
  const s = world('r13-renew', { backfilled: false });
  s.stripe.subs.clear();
  s.subs('RN', 4);
  s.stripe.pageSize = 1;
  let release!: () => void;
  const hung = new Promise<void>(r => { release = r; });
  let page = 0;
  const slow = { listSubscriptionsPage: async (after?: string) => {
    s.w.clock.now += 10_000; // every page takes 10 s of the application clock
    if (++page === 3) await hung; // the third page is still running
    return s.stripe.listSubscriptionsPage(after);
  } };
  const holder = backfillLicenceBindings(s.w.store, slow, { now: () => s.w.clock.now, budgetMs: 60_000 });
  await Bun.sleep(5);
  // 30 s after the call started, 10 s after its last page write: still its lease.
  expect(await backfillLicenceBindings(s.w.store, s.stripe, { now: () => s.w.clock.now, budgetMs: 10_000 })).toMatchObject({ busy: true });
  release();
  expect(await holder).toMatchObject({ complete: true });
});

test("a superseded call that then fails does not free the new holder's lease (L06)", async () => {
  const s = world('r13-l06', { backfilled: false });
  s.stripe.subs.clear();
  s.subs('LS', 3);
  s.stripe.pageSize = 1;
  let failA!: () => void, releaseB!: () => void;
  const aHung = new Promise<void>(r => { failA = r; }), bHung = new Promise<void>(r => { releaseB = r; });
  const a = backfillLicenceBindings(s.w.store, { listSubscriptionsPage: async () => { await aHung; throw Error('stripe 500'); } },
    { now: () => s.w.clock.now, budgetMs: 10_000 });
  await Bun.sleep(5);
  s.w.clock.now += PAST_ANY_LEASE; // A's lease expires; B takes the run over and is still on its first page
  const b = backfillLicenceBindings(s.w.store, { listSubscriptionsPage: async (after?: string) => { await bHung;
    return s.stripe.listSubscriptionsPage(after); } }, { now: () => s.w.clock.now, budgetMs: 10_000 });
  await Bun.sleep(5);
  failA();
  await expect(a).rejects.toThrow('stripe 500');
  expect(await backfillLicenceBindings(s.w.store, s.stripe, { now: () => s.w.clock.now, budgetMs: 10_000 })).toMatchObject({ busy: true });
  releaseB();
  expect(await b).toMatchObject({ complete: true });
});

test('the marker is checked again under the team lock: removed after the precheck, the enrollment waits (O13)', async () => {
  const s = world('r13-o13');
  const base = s.w.store, lock = `enrollment-chain:${s.t.team}`;
  let fired = false;
  // The operator's runbook SQL removes complete_at between this caller's precheck and its team lock.
  const store: ComputeStore = new Proxy(base, { get(target, prop) {
    if (prop === 'tx') return <T>(fn: (t: Tx) => Promise<T>) => target.tx(t => fn({ ...t, lockControl: async (key: string) => {
      if (key === lock && !fired) {
        fired = true;
        const { complete_at: _gone, ...rest } = (await t.control(BACKFILL_KEY) ?? {}) as { complete_at?: number };
        await t.setControl(BACKFILL_KEY, rest);
      }
      await t.lockControl(key);
    } }));
    const value = Reflect.get(target, prop) as unknown;
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  } }) as ComputeStore;
  s.w.d.store = store;
  expect(await s.attempt()).toBe('licence_backfill_pending');
  expect(await s.enrolled()).toBeUndefined();
});
