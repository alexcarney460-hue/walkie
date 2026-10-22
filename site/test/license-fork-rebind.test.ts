// Lane C round 9 (coordinator decision on the round-8 question): while an authority fork is open, a licence bind that
// would change an already-bound licence's authority or issue it a new token is refused with 409 authority_fork_open,
// so re-activation cannot sidestep the fork. The operator's resolve_fork is the way out. New licences and key-only
// re-binds are unaffected. MemoryStore + MockStripe only; the Telegram call is stubbed.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { makeRenew } from '../api/license/renew.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { BACKFILL_KEY } from '../api/_lib/compute/licence-records.ts';

type Keys = ReturnType<typeof C.generateKeys>;
type Move = { transfer: { key: string; event: unknown }; events: unknown[] };
const renewMessage = (team: string, license: string, expires: number): string =>
  `walkie-license-renew-v1\n${team}\n${license}\n${expires}`;
const secret = ['0123456789', 'abcdef'].join('').repeat(2); // built at runtime: no key-shaped literal (scripts/public-gitleaks.toml)

let sent: { text: string }[] = [];
let previousFetch: typeof fetch;
beforeEach(() => {
  sent = [];
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.telegram.org/')) throw Error('unexpected network request');
    sent.push(JSON.parse(String(init?.body)) as { text: string });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = previousFetch; });

function world(name: string) {
  const w = C.world(), t = C.mkTeam(name), stripe = new C.LH.MockStripe(), signer = C.LH.testKeypair();
  const env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1', COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixt' + 'ure-bot', COMPUTE_ALERT_TELEGRAM_CHAT: '42' });
  w.d.verifyLicense = C.licenseVerifier(stripe);
  w.d.teamLicences = async (team: string) => stripe.listSubscriptionsByTeam(team);
  w.d.licenceById = async (lic: string) => stripe.getSubscription(lic);
  void w.store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 })); // the one-time backfill has run (round 10)
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
  const chainOf = (moves: Move[]) => teamAuthority(t.team, roster(moves) as never)!;
  const licence = (id: string) => {
    stripe.subs.set(id, C.LH.subscription({ id }));
    return C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7, email: 'lead@kestrel.test',
      interval: 'month', issued_at: C.T0, expires_at: C.T0 + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  };
  const id = `sub_${name.replace(/[^A-Za-z0-9]/g, '')}`, code = licence(id);
  /** A bind. `released`: the pre.16 site (no store, proof ignored), so the licence carries only the team and hash
   *  (C.LH.releasedBind: the lock-ON site refuses to bind without its store, lane C round 11). */
  const bind = async (keys: Keys | null, moves: Move[], opts: { released?: boolean; code?: string; lic?: string } = {}) => {
    const expires_at = w.clock.now + 240_000, lic = opts.lic ?? id;
    if (opts.released) return C.LH.releasedBind(stripe, lic, t.team) as { status: number; body: { key?: string; renewal_token?: string; error?: string } };
    const site = { ...C.LH.deps(stripe, env), computeStore: () => w.store };
    const proof = keys ? { ...roster(moves), expires_at, bind_signature: keys.sign(C.bindMessage(t.team, lic, expires_at)) } : undefined;
    const res = await C.makeBind({ ...site, now: () => w.clock.now })(new Request('https://site.test/api/license/bind', {
      method: 'POST', body: JSON.stringify({ code: opts.code ?? code, team_id: t.team, ...(proof ? { proof } : {}) }) }));
    return { status: res.status, body: await res.json() as { key?: string; renewal_token?: string; error?: string } };
  };
  const renew = async (token: string, keys?: Keys, moves: Move[] = []) => {
    const expires_at = w.clock.now + 240_000;
    const proof = keys ? { ...roster(moves), expires_at, renew_signature: keys.sign(renewMessage(t.team, id, expires_at)) } : undefined;
    return (await makeRenew({ ...C.LH.deps(stripe, env), now: () => w.clock.now, computeStore: () => w.store })(new Request(
      'https://site.test/api/license/renew', { method: 'POST',
        body: JSON.stringify({ lic_id: id, renewal_token: token, ...(proof ? { proof } : {}) }) }))).status;
  };
  const account = (keys: Keys, moves: Move[], extra: object = {}) => C.createAccount(w.d, t.team,
    C.proof(keys, t.team, w.clock.now, t.genesis, moves.map(m => m.transfer), { roster_events: moves.flatMap(m => m.events), ...extra }));
  const operator = async (action: string, chain_id?: string, proposed_key?: string) => (await makeHandover({
    env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d, stripe: () => null } as never)(
    new Request('https://site.test/api/compute/handover', { method: 'POST', headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ team_id: t.team, action, chain_id, proposed_key }) }))).status;
  const fork = () => w.store.tx(x => x.control(`enrollment-fork:${t.team}`));
  return { w, t, stripe, id, move, chainOf, licence, bind, renew, account, operator, fork };
}

test('a fork open: the enrolled X re-activating with the code gets 409, no token, the licence unchanged; the operator is told', async () => {
  const s = world('fork-rebind-x'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  const first = await s.bind(f, [], { released: true }); // F activated under the lock: the shared token
  const token = first.body.renewal_token!;
  const fToX = s.move(f, x), fToN = s.move(f, n);
  await s.account(x, [fToX], { lic_id: s.id, renewal_token: token }); // X holds F's copy and enrolls first
  expect(await C.err(s.account(n, [fToN]))).toBe('team_ownership_required'); // N's branch: the fork is flagged
  expect(await s.fork()).toBeNumber();
  const before = structuredClone(s.stripe.subs.get(s.id)!.metadata), writes = s.stripe.calls.metadata.length;
  sent = [];
  const again = await s.bind(x, [fToX]);
  expect([again.status, again.body]).toEqual([409, { error: 'authority_fork_open' }]);
  expect(s.stripe.subs.get(s.id)!.metadata).toEqual(before);
  expect(s.stripe.calls.metadata).toHaveLength(writes);
  // What the operator needs: the team, the branch that tried, and the other side of the open fork.
  const xChain = s.chainOf([fToX]).chainId, nChain = s.chainOf([fToN]).chainId;
  expect(sent.map(m => m.text)).toEqual([`Sqwakie compute: authority_fork\n${JSON.stringify({ team: s.t.team, chain: xChain, old_chain: nChain })}`]);
  expect(await s.w.store.tx(t => t.control(`licence-rebind-refused:${s.t.team}`))).toEqual({ subscription: s.id, key: x.pubkey,
    chain: xChain, licence_authority: null, licence_chain: null, recorded_chain: xChain, candidate_chain: nChain, at: s.w.clock.now });
  expect(await s.renew(token, x, [fToX])).toBe(409); // renewal is paused as well (round 8)
});

test('after resolve_fork keeps N, its re-activation issues a token and renewal works', async () => {
  const s = world('fork-rebind-n'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  const fToN = s.move(f, n), fToX = s.move(f, x);
  const first = await s.bind(n, [fToN], { released: true }); // N activated under the lock
  await s.account(n, [fToN], { lic_id: s.id, renewal_token: first.body.renewal_token });
  expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required'); // a superseded key flags a fork
  expect((await s.bind(n, [fToN])).status).toBe(409); // paused: N waits for the operator
  expect(await s.operator('resolve_fork', s.chainOf([fToN]).chainId)).toBe(200);
  const again = await s.bind(n, [fToN]);
  expect(again.status).toBe(200);
  expect(s.stripe.subs.get(s.id)!.metadata.walkie_authority).toBe(n.pubkey);
  expect(await s.renew(again.body.renewal_token!)).toBe(200);
  expect(await s.renew(first.body.renewal_token!, n, [fToN])).toBe(403); // the shared token was replaced
});

test('new licence binds are unaffected, on an unrelated team and on the forked team', async () => {
  const s = world('fork-rebind-new'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  const fToN = s.move(f, n), fToX = s.move(f, x);
  const first = await s.bind(n, [fToN], { released: true });
  await s.account(n, [fToN], { lic_id: s.id, renewal_token: first.body.renewal_token });
  await s.account(x, [fToX]).catch(() => undefined);
  expect(await s.fork()).toBeNumber();
  const other = world('fork-rebind-other');
  const unrelated = await other.bind(other.t.f, []);
  expect([unrelated.status, typeof unrelated.body.renewal_token]).toEqual([200, 'string']);
  const second = ['sub', 'FORKREBINDSECOND'].join('_');
  const fresh = await s.bind(n, [fToN], { code: s.licence(second), lic: second });
  expect([fresh.status, typeof fresh.body.renewal_token]).toEqual([200, 'string']);
});

test('key-only re-binds are unaffected while a fork is open', async () => {
  const s = world('fork-rebind-keyonly'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  const fToN = s.move(f, n), fToX = s.move(f, x);
  const first = await s.bind(n, [fToN]); // bound to N's authority, with the chain recorded
  expect(first.status).toBe(200);
  await s.account(n, [fToN]);
  await s.account(x, [fToX]).catch(() => undefined);
  expect(await s.fork()).toBeNumber();
  const writes = s.stripe.calls.metadata.length;
  const signed = await s.bind(n, [fToN]);
  expect([signed.status, typeof signed.body.key, signed.body.renewal_token]).toEqual([200, 'string', undefined]);
  const released = await s.bind(null, []); // a released client re-binding without a proof
  expect([released.status, typeof released.body.key, released.body.renewal_token]).toEqual([200, 'string', undefined]);
  expect(s.stripe.calls.metadata).toHaveLength(writes);
  // Every renewal path honours the fork, a token bound to the enrolled key included; resolve_fork restores it.
  expect(await s.renew(first.body.renewal_token!)).toBe(409);
  expect(await s.renew('A'.repeat(43))).toBe(403); // a wrong token learns nothing about the fork
  expect(await s.operator('resolve_fork', s.chainOf([fToN]).chainId)).toBe(200);
  expect(await s.renew(first.body.renewal_token!)).toBe(200);
});
