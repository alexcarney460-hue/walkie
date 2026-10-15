// Lane C round 7 (REVIEW-merged-codex P1): a licence bound while compute was locked (pre.16 and earlier: the site kept
// no store, so nothing recorded the binding authority's chain) must still decide who may take a team's FIRST compute
// enrollment. The enrolling machine presents that licence's credentials, or its verified chain head is the key a licence
// names; otherwise it is refused before any token and flagged for the operator. The Stripe read is read-only, bounded
// and fails closed. Free teams (no live licence) keep the first-presenter rule. MemoryStore + MockStripe only.
import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { computeFromEnv } from '../api/_lib/compute/handler.ts';
import { makeAccount } from '../api/compute/account.ts';
import { makeCredit } from '../api/compute/credit.ts';
import { makeRent } from '../api/compute/rent.ts';
import { configJson } from './compute-helpers.ts';
import type { SubscriptionLite } from '../api/_lib/stripe.ts';
import { BACKFILL_KEY } from '../api/_lib/compute/licence-records.ts';
import { RENTED_MACHINE_RELEASES } from '../api/_lib/compute/releases.ts';

// The newest rentable release (a rent through the handlers must name a listed tag).
const RELEASE = RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]!;

type Keys = ReturnType<typeof C.generateKeys>;
type Move = { transfer: { key: string; event: unknown }; events: unknown[] };

function world(name: string) {
  const w = C.world(), t = C.mkTeam(name), stripe = new C.LH.MockStripe(), signer = C.LH.testKeypair();
  const id = `sub_${name.replace(/[^A-Za-z0-9]/g, '')}`;
  stripe.subs.set(id, C.LH.subscription({ id }));
  let reads = 0;
  w.d.verifyLicense = C.licenseVerifier(stripe);
  w.d.teamLicences = async (team: string) => { reads++; return stripe.listSubscriptionsByTeam(team); };
  w.d.licenceById = async (lic: string) => { reads++; return stripe.getSubscription(lic); };
  void w.store.tx(t => t.setControl(BACKFILL_KEY, { complete_at: C.T0 })); // the one-time backfill has run (round 10)
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
  /**
   * `locked`: the released site (pre.16: no store, the daemon's roster proof ignored), which wrote only walkie_team +
   * walkie_renew_hash (C.LH.releasedBind). Otherwise a signed bind through the lock-ON site, which needs a store (lane C
   * round 11): a separate one, so this world's store has no record of the binding and only Stripe names its authority.
   */
  const bind = async (keys: Keys, moves: Move[], locked: boolean) => {
    if (locked) return C.LH.releasedBind(stripe, id, t.team);
    const expires_at = w.clock.now + 240_000, siteStore = C.world().store;
    const site = { ...C.LH.deps(stripe, C.LH.fullEnv(signer.pem)), computeStore: () => siteStore, now: () => w.clock.now };
    const proof = { ...roster(moves), expires_at, bind_signature: keys.sign(C.bindMessage(t.team, id, expires_at)) };
    const res = await C.makeBind(site)(new Request('https://site.test/api/license/bind', {
      method: 'POST', body: JSON.stringify({ code, team_id: t.team, proof }) }));
    return { status: res.status, body: await res.json() as { renewal_token?: string } };
  };
  const account = (keys: Keys, moves: Move[] = [], extra: object = {}) => C.createAccount(w.d, t.team,
    C.proof(keys, t.team, w.clock.now, t.genesis, moves.map(m => m.transfer), { roster_events: moves.flatMap(m => m.events), ...extra }));
  const handlerDeps = { env: { COMPUTE_ENABLED: '1' }, compute: () => w.d,
    stripe: () => ({ createCreditCheckout: async () => ({ url: 'https://checkout.test/x' }) }) } as never;
  const post = (path: string, body: object, token?: string) => new Request(`https://site.test${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const enrolled = async () => (await w.store.tx(x => x.enrollment(t.team)))?.key;
  return { w, t, stripe, id, move, bind, account, handlerDeps, post, enrolled, reads: () => reads };
}

test('a licence bound under the lock keeps a superseded branch from the first enrollment; X gets no token, checkout or rent', async () => {
  const s = world('first-locked'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  const fToN = s.move(f, n);
  const bound = await s.bind(n, [fToN], true); // N activates the code while compute is locked
  expect(bound.status).toBe(200);
  expect(Object.keys(s.stripe.subs.get(s.id)!.metadata).sort()).toEqual(['walkie_renew_hash', 'walkie_team']);
  const fToX = s.move(f, x); // the lock flips; the former authority F signs a second transfer, to X
  expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required');
  expect(s.w.logs).toContain('alert_enrollment_licence_refused');
  expect(await s.w.store.tx(t => t.control(`enrollment-licence-refused:${s.t.team}`))).toMatchObject({ key: x.pubkey });
  expect(await s.enrolled()).toBeUndefined();
  expect(await s.w.store.tx(t => t.accountsByTeam(s.t.team))).toEqual([]);
  // X through the HTTP handlers: no token comes back, so checkout and rent are refused with anything X could hold.
  const xAccount = await makeAccount(s.handlerDeps)(s.post('/api/compute/account', { team_id: s.t.team,
    proof: C.proof(x, s.t.team, s.w.clock.now, s.t.genesis, [fToX.transfer], { roster_events: fToX.events }) }));
  const xBody = await xAccount.json() as { token?: string; error?: string };
  expect([xAccount.status, xBody.error, xBody.token]).toEqual([403, 'team_ownership_required', undefined]);
  for (const token of [xBody.token, Buffer.alloc(32, 9).toString('base64url')]) {
    const credit = await makeCredit(s.handlerDeps)(s.post('/api/compute/credit', { block: 50 }, token));
    const rent = await makeRent(s.handlerDeps)(s.post('/api/compute/rent', { idempotency_key: C.idem(),
      machines: [{ tier: 'agent', count: 1 }], codes: [], walkie_version: RELEASE }, token));
    expect([credit.status, rent.status]).toEqual([401, 401]);
  }
  expect(await C.err(s.account(f))).toBe('team_ownership_required'); // F itself holds no credentials either
  // N, the licence's holder, enrolls with its credentials; X's branch is then a fork, as before.
  const nAccount = await s.account(n, [fToN], { lic_id: s.id, renewal_token: bound.body.renewal_token });
  expect(await s.enrolled()).toBe(n.pubkey);
  expect((await accountForToken(s.w.d, nAccount.token))?.team_id).toBe(s.t.team);
  expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required');
  expect(await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBeNumber();
  expect(s.stripe.calls.metadata).toEqual([]); // the released bind is set directly; enrollment reads Stripe only
});

test('a licence naming an authority admits its chain head without credentials and refuses anyone else', async () => {
  const s = world('first-authority'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  const fToN = s.move(f, n);
  expect((await s.bind(n, [fToN], false)).status).toBe(200);
  expect(s.stripe.subs.get(s.id)!.metadata.walkie_authority).toBe(n.pubkey);
  expect(await C.err(s.account(x, [s.move(f, x)]))).toBe('team_ownership_required');
  await s.account(n, [fToN]);
  expect(await s.enrolled()).toBe(n.pubkey);
});

test('a Free team (no live licence) keeps the first-presenter enrollment', async () => {
  const s = world('first-free'), x = C.generateKeys();
  s.stripe.subs.clear();
  await s.account(x, [s.move(s.t.f, x)]);
  expect(await s.enrolled()).toBe(x.pubkey);
  const lapsed = world('first-lapsed'), y = C.generateKeys();
  const bound = await lapsed.bind(lapsed.t.f, [], true);
  expect(bound.status).toBe(200);
  lapsed.stripe.subs.set(lapsed.id, { ...lapsed.stripe.subs.get(lapsed.id)!, status: 'canceled' });
  await lapsed.account(y, [lapsed.move(lapsed.t.f, y)]);
  expect(await lapsed.enrolled()).toBe(y.pubkey);
});

test('a failed or slow licence read refuses with a retryable error and enrolls nobody', async () => {
  const s = world('first-unreadable'), n = C.generateKeys(), fToN = s.move(s.t.f, n);
  s.w.d.teamLicences = async () => { throw Error('stripe down'); };
  expect(await C.err(s.account(n, [fToN]))).toBe('license_verification_unavailable');
  s.w.d.teamLicences = () => new Promise<readonly SubscriptionLite[]>(() => undefined);
  s.w.d.licenceReadMs = 20;
  expect(await C.err(s.account(n, [fToN]))).toBe('license_verification_unavailable');
  const res = await makeAccount(s.handlerDeps)(s.post('/api/compute/account', { team_id: s.t.team,
    proof: C.proof(n, s.t.team, s.w.clock.now, s.t.genesis, [fToN.transfer], { roster_events: fToN.events }) }));
  expect([res.status, (await res.json() as { error: string }).error]).toEqual([503, 'license_verification_unavailable']);
  expect(await s.enrolled()).toBeUndefined();
});

test('an enrolled team does not read the licence again', async () => {
  const s = world('first-enrolled'), n = C.generateKeys(), fToN = s.move(s.t.f, n);
  const bound = await s.bind(n, [fToN], true);
  await s.account(n, [fToN], { lic_id: s.id, renewal_token: bound.body.renewal_token });
  const reads = s.reads();
  s.w.d.teamLicences = async () => { throw Error('stripe down'); };
  await s.account(n, [fToN], { lic_id: s.id, renewal_token: bound.body.renewal_token });
  expect(s.reads()).toBe(reads);
});

test('the deployed control plane always reads licences, and fails closed without the licence Stripe key', async () => {
  const env = { COMPUTE_PRIVATE_CONFIG: configJson(), COMPUTE_ENABLED: '1', COMPUTE_HANDOVER_TOKEN_KEY: 'rent-fixture-handover-key-32-bytes' };
  const unkeyed = await computeFromEnv(env, C.world().store);
  expect(unkeyed?.teamLicences).toBeFunction();
  await expect(unkeyed!.teamLicences!('0123456789abcdef', { timeout: 1 })).rejects.toThrow();
  await expect(unkeyed!.licenceById!('sub_ANY', { timeout: 1 })).rejects.toThrow();
  expect((await computeFromEnv({ ...env, STRIPE_SECRET_KEY: 'sk_test_unused' }, C.world().store))?.teamLicences).toBeFunction();
});
