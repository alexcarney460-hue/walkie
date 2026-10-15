// Lane C round 14 (REVIEW-r13-opus P3 1 to 3, REVIEW-r13-codex P3 1): concurrent pruning attempts never raise a false
// overflow (compare-and-set on the stored position), pruning makes progress when Stripe is slow (the reads that finished
// before the deadline count), and the gaps Opus's mutants found: N08, N28, N20 and N16. MemoryStore + MockStripe.
import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { BACKFILL_KEY, backfillLicenceBindings, bindingsKey, recordLicenceBindings } from '../api/_lib/compute/licence-records.ts';
import { makeLicenceBackfill } from '../api/compute/licence-backfill.ts';
import type { SubscriptionLite } from '../api/_lib/stripe.ts';

type Keys = ReturnType<typeof C.generateKeys>;
type Move = { transfer: { key: string; event: unknown }; events: unknown[] };
const secret = ['0123456789', 'abcdef'].join('').repeat(2); // built at runtime: no key-shaped literal (scripts/public-gitleaks.toml)

function world(name: string, opts: { backfilled?: boolean } = {}) {
  const w = C.world(), t = C.mkTeam(name), stripe = new C.LH.MockStripe(), signer = C.LH.testKeypair();
  const reads = { byId: 0, stripe: 0 };
  let delay = 0, search: readonly SubscriptionLite[] = [], during: ((n: number) => Promise<void>) | null = null;
  const get = stripe.getSubscription.bind(stripe);
  stripe.getSubscription = async (...a: Parameters<typeof get>) => { reads.stripe++; return get(...a); };
  w.d.verifyLicense = C.licenseVerifier(stripe);
  w.d.teamLicences = async () => search;
  w.d.licenceById = async (lic: string) => {
    const n = ++reads.byId;
    if (delay) await Bun.sleep(delay);
    if (during) await during(n);
    return stripe.getSubscription(lic);
  };
  if (opts.backfilled !== false) void w.store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 }));
  const subs = (prefix: string, n: number, status = 'active', metadata: { [k: string]: string } = {}) =>
    Array.from({ length: n }, (_, i) => {
      const id = `sub_${prefix}${String(i).padStart(4, '0')}`;
      stripe.subs.set(id, C.LH.subscription({ id, status, metadata: { walkie_team: t.team, ...metadata } }));
      return id;
    });
  const ids = async () => ((await w.store.tx(x => x.control(bindingsKey(t.team)))) as { subscriptions: string[] } | undefined)?.subscriptions ?? [];
  const setRecord = (list: readonly string[]) => w.store.tx(x => x.setControl(bindingsKey(t.team), { subscriptions: [...list].sort() }));
  const attempt = (keys: Keys = t.f, moves: Move[] = [], extra: object = {}, d: typeof w.d = w.d) => C.err(C.createAccount(d, t.team,
    C.proof(keys, t.team, w.clock.now, t.genesis, moves.map(m => m.transfer), { roster_events: moves.flatMap(m => m.events), ...extra })));
  const enrolled = async () => (await w.store.tx(x => x.enrollment(t.team)))?.key;
  const move = (by: Keys, to: Keys): Move => {
    const ev = (n: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(by, { v: C.PROTOCOL_VERSION,
      team: t.team, id: `${by.nodeId}:${n}`, origin: by.nodeId, seq: n, ts: C.T0 + n, author: { handle: 'alex', node: by.nodeId }, kind, body });
    const transfer = C.transfer(by, t.team, 6, to);
    return { transfer, events: [ev(4, 'team.member', { login: `direct:${to.nodeId}`, handle: 'h4', role: 'owner' }),
      ev(5, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'm4', pubkey: to.pubkey, ip: '127.0.0.1' }),
      transfer.event] };
  };
  const post = async (handler: (req: Request) => Promise<Response>) => {
    const res = await handler(new Request('https://site.test/api/compute/licence-backfill', { method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'x-real-ip': '203.0.113.14' }, body: '{}' }));
    return { status: res.status, body: await res.json() as { error?: string; complete?: boolean } };
  };
  const route = () => makeLicenceBackfill({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d,
    stripe: () => null, licenseStripe: () => stripe } as never);
  return { w, t, stripe, signer, reads, subs, ids, setRecord, attempt, enrolled, move, post, route,
    setDelay: (ms: number) => { delay = ms; }, setSearch: (found: readonly SubscriptionLite[]) => { search = found; },
    setDuring: (fn: ((n: number) => Promise<void>) | null) => { during = fn; } };
}
const alerts = (logs: readonly string[], kind: string) => logs.filter(event => event === `alert_${kind}`).length;

// ---- 1. Opus r13 P3 1 / Codex r13 P3 1: concurrent attempts never raise a false overflow -----------------------------

test('two concurrent pruning attempts read the same batch: no false overflow, no page, and the team enrolls', async () => {
  const s = world('r14-conc');
  // 50 live licences naming the founder (sorted first), then 50 canceled.
  await s.setRecord([...s.subs('CA', 50, 'active', { walkie_authority: s.t.f.pubkey }), ...s.subs('CB', 50, 'canceled')]);
  s.setDelay(5);
  const answers = [...await Promise.all([s.attempt(), s.attempt()])]; // both read the first 50 before either writes
  for (let i = 0; i < 4 && answers.at(-1) !== 'ok'; i++) answers.push(await s.attempt());
  expect(answers).not.toContain('licence_bindings_overflow');
  expect(alerts(s.w.logs, 'licence_bindings_overflow')).toBe(0);
  expect(answers.at(-1)).toBe('ok');
  expect(await s.enrolled()).toBe(s.t.f.pubkey);
});

test('a stale attempt (another moved the position first) still drops the ended ids it read', async () => {
  const s = world('r14-stale');
  const ids = s.subs('SE', 60, 'canceled');
  await s.setRecord(ids);
  const read = s.w.d.licenceById!;
  const slow = (ms: number) => async (lic: string, o: { timeout: number }) => { await Bun.sleep(ms); return read(lic, o); };
  // S reads its whole batch (5 rounds of 100 ms); W, with a 1 + 250 ms deadline, finishes 2 rounds and writes first.
  const [w1, s1] = await Promise.all([s.attempt(s.t.f, [], {}, { ...s.w.d, licenceById: slow(100), licenceReadMs: 1 }),
    s.attempt(s.t.f, [], {}, { ...s.w.d, licenceById: slow(100) })]);
  expect([w1, s1]).toEqual(['licence_record_pruning', 'licence_record_pruning']);
  expect(await s.ids()).toEqual(ids.slice(50)); // W dropped 20, then S, stale, the other 30 of the batch
});

// ---- 2. Opus r13 P3 2: slow Stripe reads still make progress ------------------------------------------------------

test('at 700 ms a read, pruning keeps the reads that finished before the deadline and the team enrolls', async () => {
  const s = world('r14-slow');
  await s.setRecord(s.subs('SL', 60, 'canceled'));
  s.setDelay(700); // the real deadline: LICENCE_READ_MS + 250 = 3.25 s, so 4 of the 5 rounds of 10 reads finish
  expect(await s.attempt()).toBe('licence_record_pruning');
  expect((await s.ids()).length).toBeLessThan(60); // ended ids found before the deadline were dropped
  expect(alerts(s.w.logs, 'licence_read_failed')).toBe(0); // slow but working: progress, not a failure page
  const answers: string[] = [];
  for (let i = 0; i < 3 && answers.at(-1) !== 'ok'; i++) answers.push(await s.attempt());
  expect(answers.at(-1)).toBe('ok');
}, 30_000);

test('a deadline whose first read has not finished still drops the ended ids found, and keeps its position', async () => {
  const s = world('r14-headslow');
  const ids = s.subs('HS', 60, 'canceled');
  await s.setRecord(ids);
  const read = s.w.d.licenceById!;
  s.w.d.licenceById = async (lic: string, o: { timeout: number }) => { if (lic === ids[0]) await Bun.sleep(4_000); return read(lic, o); };
  expect(await s.attempt()).toBe('licence_record_pruning');
  const left = await s.ids();
  expect(left).toContain(ids[0]!); // not read: kept, and read again later
  expect(left).toHaveLength(11); // the other 49 of the batch were read and dropped
  s.w.d.licenceById = read;
  expect(await s.attempt()).toBe('ok');
}, 30_000);

test('after a deadline the position moves only over the reads that finished, so no id is skipped', async () => {
  const s = world('r14-skip');
  const head = s.subs('KA', 40, 'active', { walkie_authority: s.t.f.pubkey }), ended = s.subs('KB', 10, 'canceled');
  const tail = s.subs('KC', 10, 'active', { walkie_authority: s.t.f.pubkey });
  await s.setRecord([...head, ...ended, ...tail]);
  s.setDelay(80);
  s.w.d.licenceReadMs = 100; // a 350 ms deadline: 4 rounds of 10 reads finish, the 5th (the 10 ended) does not
  expect(await s.attempt()).toBe('licence_record_pruning');
  expect(await s.attempt()).toBe('licence_record_pruning'); // not an overflow: the 10 ended had not been read yet
  expect(await s.ids()).toEqual([...head, ...tail].sort());
});

test('a read that finished out of order does not count as kept until the position passes it', async () => {
  const s = world('r14-order');
  const live = s.subs('OA', 60, 'active'), ended = s.subs('OB', 10, 'canceled');
  await s.setRecord([...live, ...ended]);
  const read = s.w.d.licenceById!;
  // The 6th read misses the deadline; the 44 after it finish, out of order. Only the first 5 count as read and kept.
  s.w.d.licenceById = async (lic: string, o: { timeout: number }) => { if (lic === live[5]) await Bun.sleep(4_000); return read(lic, o); };
  expect(await s.attempt()).toBe('licence_record_pruning');
  s.w.d.licenceById = read;
  const answers: string[] = [];
  for (let i = 0; i < 6 && answers.at(-1) !== 'licence_bindings_overflow'; i++) answers.push(await s.attempt());
  expect(answers[0]).toBe('licence_record_pruning'); // 55 counted, not 99: the 10 ended are still unread
  expect(answers.at(-1)).toBe('licence_bindings_overflow'); // 60 live: rightly, once every id has been read
  expect(await s.ids()).toEqual([...live].sort()); // and the 10 ended were dropped before that answer
}, 30_000);

test('a deadline with no read finished is still the retryable read failure, and drops nothing', async () => {
  const s = world('r14-stuck');
  await s.setRecord(s.subs('ST', 60, 'canceled'));
  s.setDelay(4_000);
  expect(await s.attempt()).toBe('license_verification_unavailable');
  expect((await s.ids()).length).toBe(60);
  expect(alerts(s.w.logs, 'licence_read_failed')).toBe(1);
}, 30_000);

// ---- 3. Opus r13 P3 3: the mutants that survived -----------------------------------------------------------------

test('a bind recorded while a pruning batch is being read keeps its id, and that licence decides (N08)', async () => {
  const s = world('r14-mid'), n = C.generateKeys();
  await s.setRecord(s.subs('MD', 60, 'canceled'));
  const [mid] = s.subs('NMID', 1, 'active', { walkie_authority: n.pubkey });
  // A licence naming N is bound (recorded under the team lock) while the batch's reads are in flight.
  s.setDuring(async (count) => { if (count === 20) await s.w.store.tx(x => recordLicenceBindings(x, s.t.team, [mid!])); });
  expect(await s.attempt()).toBe('licence_record_pruning');
  s.setDuring(null);
  expect(await s.ids()).toContain(mid!);
  const answers: string[] = [];
  for (let i = 0; i < 4 && answers.at(-1) !== 'team_ownership_required'; i++) answers.push(await s.attempt());
  expect(answers.at(-1)).toBe('team_ownership_required'); // the founder: the live licence names N
  expect(await s.attempt(n, [s.move(s.t.f, n)])).toBe('ok');
});

test("the route's busy check honours lease expiry: after a cut-off call's lease runs out, the backfill resumes (N28)", async () => {
  const s = world('r14-lease', { backfilled: false });
  s.stripe.subs.clear();
  s.subs('LE', 2);
  s.stripe.pageSize = 1;
  const holder = backfillLicenceBindings(s.w.store, { listSubscriptionsPage: () => new Promise(() => undefined) },
    { now: () => s.w.clock.now, budgetMs: 10_000 }); // cut off on its first page: it never writes again
  void holder;
  await Bun.sleep(5);
  const handler = s.route();
  expect((await s.post(handler)).status).toBe(409);
  s.w.clock.now += 2_000;
  expect((await s.post(handler)).status).toBe(409);
  s.w.clock.now += 14_000; // 16 s after the lease was taken
  expect(await s.post(handler)).toMatchObject({ status: 200, body: { complete: true } });
});

test('a search-only past-due licence still counts: it refuses the founder and admits the authority it names (N20)', async () => {
  const s = world('r14-pastdue'), n = C.generateKeys();
  const [due] = s.subs('PD', 1, 'past_due', { walkie_authority: n.pubkey });
  s.setSearch([s.stripe.subs.get(due!)!]);
  expect(await s.attempt()).toBe('team_ownership_required');
  expect(await s.attempt(n, [s.move(s.t.f, n)])).toBe('ok');
});

test('a credentialed presenter skips pruning: 60 ended recorded, admitted with no read by id (N16)', async () => {
  const s = world('r14-cred');
  const [lic] = s.subs('CR', 1);
  const token = C.LH.releasedBind(s.stripe, lic!, s.t.team).body.renewal_token;
  await s.setRecord([lic!, ...s.subs('CE', 60, 'canceled')]);
  expect(await s.attempt(s.t.f, [], { lic_id: lic, renewal_token: token })).toBe('ok');
  expect(s.reads.byId).toBe(0);
  expect((await s.ids()).length).toBe(61); // nothing pruned: no read was needed
});
