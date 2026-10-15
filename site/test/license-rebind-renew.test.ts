// Lane C rounds 3-5: an authority-bound licence that the new roster authority N re-activates (signed bind) on a team
// enrolled in compute under the old authority F. Round 5 (design i): the re-bind records N's verified chain, so a
// branch conflicting with it (a superseded authority signing F -> X) is refused and flagged as a fork before any token,
// checkout or rental. N renews with its signed proof (the recorded chain is its chain, F an earlier link), and its
// "Add compute" moves the enrollment to the head of the recorded chain: fresh tokens when unfunded, the normal hold
// when funded. MemoryStore + MockStripe only.
import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { AUTHORITY_META } from '../api/_lib/metadata.ts';
import { makeRenew } from '../api/license/renew.ts';
import { ACK_EXPIRY_MS, handoverKey, HANDOVER_MS } from '../api/_lib/compute/handover.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { makeAccount } from '../api/compute/account.ts';
import { makeCredit } from '../api/compute/credit.ts';
import { makeRent } from '../api/compute/rent.ts';
import { authorityPathMetadata } from '../api/_lib/metadata.ts';
import { RENTED_MACHINE_RELEASES } from '../api/_lib/compute/releases.ts';

// The newest rentable release (a rent through the handlers must name a listed tag).
const RELEASE = RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]!;

const renewMessage = (team: string, license: string, expires: number): string =>
  `walkie-license-renew-v1\n${team}\n${license}\n${expires}`;
const operatorSecret = ['0123456789', 'abcdef'].join('').repeat(2); // built at runtime: no key-shaped literal (scripts/public-gitleaks.toml)
type Keys = ReturnType<typeof C.generateKeys>;
type Move = { transfer: { key: string; event: unknown }; events: unknown[] };

function world(name: string) {
  const w = C.world(), t = C.mkTeam(name), stripe = new C.LH.MockStripe(), signer = C.LH.testKeypair();
  const env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1' });
  const id = `sub_${name.replace(/[^A-Za-z0-9]/g, '')}`;
  stripe.subs.set(id, C.LH.subscription({ id }));
  w.d.verifyLicense = C.licenseVerifier(stripe);
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7, email: 'lead@kestrel.test',
    interval: 'month', issued_at: C.T0, expires_at: C.T0 + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const deps = { ...C.LH.deps(stripe, env), now: () => w.clock.now, computeStore: () => w.store };
  const roster = (moves: Move[]) => ({ genesis: t.genesis, authority_chain: moves.map(m => m.transfer),
    roster_events: moves.flatMap(m => m.events) });
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
  const { COMPUTE_ENABLED: _enabled, ...drained } = env; // rolled back: COMPUTE_ENABLED unset, the store still configured
  const bind = async (keys: Keys, moves: Move[] = [], enabled = true) => {
    const expires_at = w.clock.now + 240_000;
    const res = await C.makeBind(enabled ? deps : { ...deps, env: drained })(new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({
      code, team_id: t.team, proof: { ...roster(moves), expires_at, bind_signature: keys.sign(C.bindMessage(t.team, id, expires_at)) } }) }));
    return { status: res.status, body: await res.json() as { renewal_token?: string } };
  };
  const renewProof = (keys: Keys, moves: Move[] = []) => {
    const expires_at = w.clock.now + 240_000;
    return { ...roster(moves), expires_at, renew_signature: keys.sign(renewMessage(t.team, id, expires_at)) };
  };
  const renew = async (token: string, proof?: object): Promise<number> => (await makeRenew(deps)(new Request(
    'https://site.test/api/license/renew', { method: 'POST',
      body: JSON.stringify({ lic_id: id, renewal_token: token, ...(proof ? { proof } : {}) }) }))).status;
  const account = (keys: Keys, moves: Move[] = [], extra: object = {}) => C.createAccount(w.d, t.team,
    C.proof(keys, t.team, w.clock.now, t.genesis, moves.map(m => m.transfer), { roster_events: moves.flatMap(m => m.events), ...extra }));
  // The compute HTTP handlers, as the daemon reaches them.
  const handlerDeps = { env, compute: () => w.d, stripe: () => ({ createCreditCheckout: async () => ({ url: 'https://checkout.test/x' }) }) } as never;
  const post = (path: string, body: object, token?: string) => new Request(`https://site.test${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const operator = async (action: string, chain_id?: string, proposed_key?: string) => (await makeHandover({
    env: { COMPUTE_HANDOVER_OPERATOR_SECRET: operatorSecret }, compute: () => w.d, stripe: () => null } as never)(
    new Request('https://site.test/api/compute/handover', { method: 'POST', headers: { authorization: `Bearer ${operatorSecret}` },
      body: JSON.stringify({ team_id: t.team, action, chain_id, proposed_key }) }))).status;
  const chainOf = (moves: Move[]) => teamAuthority(t.team, roster(moves) as never)!;
  const stored = () => w.store.tx(x => x.control(`enrollment-chain:${t.team}`)) as Promise<{ chainId: string; depth: number } | undefined>;
  const enrolled = async () => (await w.store.tx(x => x.enrollment(t.team)))?.key;
  return { w, t, stripe, id, move, bind, renew, renewProof, account, operator, chainOf, stored, enrolled, handlerDeps, post };
}

/**
 * F binds the licence and creates its compute account (no credit); the roster authority moves F -> N and N
 * re-activates the code. With `depth1`, the founder first handed the authority to F, so F's recorded chain has a
 * transfer a former authority could fork.
 */
async function reactivated(name: string, depth1 = false, enabled = true) {
  const s = world(name), founder = s.t.f, n = C.generateKeys();
  const f = depth1 ? C.generateKeys() : founder;
  const base = depth1 ? [s.move(founder, f)] : [];
  const first = await s.bind(f, base);
  expect(first.status).toBe(200);
  const fAccount = await s.account(f, base);
  const fToN = s.move(f, n), toN = [...base, fToN];
  const again = await s.bind(n, toN, enabled);
  expect(again.status).toBe(200);
  expect(s.stripe.subs.get(s.id)!.metadata[AUTHORITY_META]).toBe(n.pubkey);
  return { ...s, founder, f, n, base, toN, fAccount, oldToken: first.body.renewal_token!, token: again.body.renewal_token! };
}

test('a team with no compute enrollment keeps the re-bind behaviour: the recorded chain moves to the new authority', async () => {
  const s = world('rebind-unenrolled'), f = s.t.f, n = C.generateKeys();
  const first = await s.bind(f);
  expect([first.status, (await s.stored())?.chainId]).toEqual([200, s.chainOf([]).chainId]);
  const fToN = s.move(f, n);
  const again = await s.bind(n, [fToN]);
  const toN = s.chainOf([fToN]);
  expect(again.status).toBe(200);
  expect(await s.stored()).toEqual({ depth: toN.depth, chainId: toN.chainId, chain: toN.chain, version: 2 });
  expect(await s.renew(again.body.renewal_token!)).toBe(200);
  expect(await s.renew(first.body.renewal_token!)).toBe(403);
});

test('on an enrolled team the re-bind records the new authority chain and leaves the enrollment to compute', async () => {
  const s = await reactivated('rebind-records');
  expect(await s.stored()).toMatchObject({ depth: 1, chainId: s.chainOf(s.toN).chainId });
  expect(await s.enrolled()).toBe(s.f.pubkey);
});

test('a superseded authority cannot enroll a conflicting branch after the re-bind; the fork goes to the operator', async () => {
  for (const funded of [false, true]) {
    const s = await reactivated(`rebind-takeover-${funded}`);
    if (funded) await C.applyCreditEvent(s.w.d, C.purchase(s.fAccount.account_id, 50));
    const x = C.generateKeys(), fToX = s.move(s.f, x); // F signs a second transfer, to X
    const before = await s.w.store.tx(t => t.accountsByTeam(s.t.team));
    expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required');
    expect(await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBeNumber();
    expect(s.w.logs).toContain('alert_authority_fork');
    expect(await s.w.store.tx(t => t.control(handoverKey(s.t.team)))).toBeFalsy(); // refused, not held
    // Nothing moved: no token for X, F's account token and the enrollment unchanged, so no checkout or rent for X.
    expect(await s.enrolled()).toBe(s.f.pubkey);
    expect(await s.w.store.tx(t => t.accountsByTeam(s.t.team))).toEqual(before);
    expect((await accountForToken(s.w.d, s.fAccount.token))?.id).toBe(s.fAccount.account_id);
    expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required');
    // X's own requests through the HTTP handlers: no account token comes back, so checkout and rent are refused.
    const xAccount = await makeAccount(s.handlerDeps)(s.post('/api/compute/account', { team_id: s.t.team,
      proof: C.proof(x, s.t.team, s.w.clock.now, s.t.genesis, [fToX.transfer], { roster_events: fToX.events }) }));
    const xBody = await xAccount.json() as { token?: string; error?: string };
    expect([xAccount.status, xBody.error, xBody.token]).toEqual([403, 'team_ownership_required', undefined]);
    const forged = Buffer.alloc(32, 9).toString('base64url');
    for (const token of [xBody.token, forged]) {
      const credit = await makeCredit(s.handlerDeps)(s.post('/api/compute/credit', { block: 50 }, token));
      const rent = await makeRent(s.handlerDeps)(s.post('/api/compute/rent', { idempotency_key: C.idem(),
        machines: [{ tier: 'agent', count: 1 }], codes: [], walkie_version: RELEASE }, token));
      expect([credit.status, rent.status]).toEqual([401, 401]);
    }
    // The licence stays N's; while the fork is open N renews only after the operator resolves it.
    expect((await s.bind(x, [fToX])).status).toBe(403);
    expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(409); // paused for the fork (authority_fork_open, round 8)
    if (!funded) expect(await C.err(s.account(s.n, s.toN))).toBe('team_ownership_required'); // not while the fork is open
    expect(await s.operator('resolve_fork', s.chainOf(s.toN).chainId)).toBe(200);
    expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(200);
    if (!funded) {
      await s.account(s.n, s.toN);
      expect(await s.enrolled()).toBe(s.n.pubkey);
    } else expect((await s.account(s.n, s.toN)).handover_pending).toBeDefined();
    expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required');
  }
});

test('the re-activating authority renews with its signed proof through the chain-extension rule', async () => {
  const s = await reactivated('rebind-renew');
  const writes = s.stripe.calls.metadata.length;
  expect(await s.renew(s.token)).toBe(403); // the daemon's first, proofless call; its signed retry follows
  expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(200);
  expect(await s.renew(s.oldToken, s.renewProof(s.f))).toBe(403); // the re-bind replaced F's token
  expect(s.stripe.calls.metadata).toHaveLength(writes);
});

test('Add compute from the new authority moves an unfunded enrollment with fresh tokens; the old authority is refused', async () => {
  const s = await reactivated('rebind-unfunded');
  const nAccount = await s.account(s.n, s.toN);
  expect(nAccount.account_id).toBe(s.fAccount.account_id); // the existing account is adopted
  expect(await s.enrolled()).toBe(s.n.pubkey);
  expect((await s.stored())?.chainId).toBe(s.chainOf(s.toN).chainId);
  expect(await accountForToken(s.w.d, s.fAccount.token)).toBeNull();
  expect((await accountForToken(s.w.d, nAccount.token))?.id).toBe(s.fAccount.account_id);
  expect(await s.renew(s.token)).toBe(200); // the normal path again: no proof needed
  expect(await s.renew(s.oldToken)).toBe(403);
  expect(await s.renew(s.oldToken, s.renewProof(s.f))).toBe(403);
});

test('a team funded after the re-bind goes through the normal hold, and renews again once the operator completes it', async () => {
  const s = await reactivated('rebind-funded');
  await C.applyCreditEvent(s.w.d, C.purchase(s.fAccount.account_id, 50));
  const held = await s.account(s.n, s.toN);
  expect(held.handover_pending).toBeDefined();
  expect(await s.enrolled()).toBe(s.f.pubkey);
  expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(403); // held for review
  const proposed = s.chainOf(s.toN);
  expect(await s.operator('complete', proposed.chainId, s.n.pubkey)).toBe(409); // not yet 24 hours
  s.w.clock.now += HANDOVER_MS;
  expect(await s.operator('complete', proposed.chainId, s.n.pubkey)).toBe(200);
  expect(await s.enrolled()).toBe(s.n.pubkey);
  expect(await accountForToken(s.w.d, s.fAccount.token)).toBeNull();
  expect(await s.renew(s.token)).toBe(200);
  expect(await s.renew(s.oldToken, s.renewProof(s.f))).toBe(403);
});

test('a rogue key, a conflicting branch and the former authority are refused with the new token', async () => {
  const s = await reactivated('rebind-refusals');
  const rogue = C.generateKeys(), x = C.generateKeys();
  expect(await s.renew(s.token, { ...s.renewProof(s.n, s.toN), renew_signature: s.renewProof(rogue).renew_signature })).toBe(403);
  expect(await s.renew(s.token, s.renewProof(rogue))).toBe(403);
  const fToX = s.move(s.f, x); // the former authority signs a second, conflicting transfer
  expect(await s.renew(s.token, s.renewProof(x, [fToX]))).toBe(403);
  expect(await s.renew(s.token, s.renewProof(s.f))).toBe(403);
  expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(200);
});

test('an open fork refuses a deeper successor until the operator resolves it; then it moves normally', async () => {
  for (const funded of [false, true]) {
    const s = await reactivated(`rebind-deeper-${funded}`);
    if (funded) await C.applyCreditEvent(s.w.d, C.purchase(s.fAccount.account_id, 50));
    const x = C.generateKeys(), fToX = s.move(s.f, x);
    expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required'); // flags the fork
    const p = C.generateKeys(), toP = [...s.toN, s.move(s.n, p)];
    const before = await s.w.store.tx(t => t.accountsByTeam(s.t.team));
    expect(await C.err(s.account(p, toP))).toBe('team_ownership_required');
    expect(await s.w.store.tx(t => t.accountsByTeam(s.t.team))).toEqual(before); // no token rotation
    expect(await s.w.store.tx(t => t.control(handoverKey(s.t.team)))).toBeFalsy(); // no hold
    expect(await s.enrolled()).toBe(s.f.pubkey);
    expect(await s.operator('resolve_fork', s.chainOf(s.toN).chainId)).toBe(200);
    const moved = await s.account(p, toP);
    if (funded) expect(moved.handover_pending).toBeDefined();
    else {
      expect(await s.enrolled()).toBe(p.pubkey);
      expect(await accountForToken(s.w.d, s.fAccount.token)).toBeNull();
    }
  }
});

test('a re-bind while compute is rolled back (store configured) records the new chain as when enabled', async () => {
  const s = await reactivated('rebind-drained', false, false);
  expect(await s.stored()).toMatchObject({ depth: 1, chainId: s.chainOf(s.toN).chainId });
  expect(await s.enrolled()).toBe(s.f.pubkey);
  const x = C.generateKeys(), fToX = s.move(s.f, x); // compute re-enabled; F tries the takeover
  expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required');
  expect(await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBeNumber();
  expect(await s.enrolled()).toBe(s.f.pubkey);
});

test('a flagged fork refuses the re-activating authority', async () => {
  const s = await reactivated('rebind-fork', true);
  const x = C.generateKeys(), foundToX = s.move(s.founder, x); // the founder forks the F transfer
  await s.account(x, [foundToX]).catch(() => undefined);
  expect(await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBeNumber();
  expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(409); // paused for the fork (authority_fork_open, round 8)
});

test('a real hold rejected by the operator keeps refusing the re-activating authority', async () => {
  const s = await reactivated('rebind-rejected');
  await C.applyCreditEvent(s.w.d, C.purchase(s.fAccount.account_id, 50));
  expect((await s.account(s.n, s.toN)).handover_pending).toBeDefined();
  expect(await s.operator('reject', s.chainOf(s.toN).chainId, s.n.pubkey)).toBe(200);
  expect(await s.w.store.tx(t => t.control(handoverKey(s.t.team)))).toBeFalsy();
  expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(403);
  expect(await C.err(s.account(s.n, s.toN))).toBe('team_ownership_required');
  expect(await s.operator('clear_rejection', s.chainOf(s.toN).chainId, s.n.pubkey)).toBe(409); // the rejected chain stays rejected
});

/** After the rejection: the operator's Stripe reset of the licence's authority metadata (COMPUTE-HANDOVER.md). */
const resetAuthority = (s: Awaited<ReturnType<typeof reactivated>>) => s.stripe.setSubscriptionMetadata(s.id, Object.fromEntries(
  ['walkie_authority', 'walkie_authority_depth', 'walkie_authority_chain', ...Object.keys(authorityPathMetadata(['x']))]
    .map(key => [key, ''])));

for (const line of ['a successor of the rejected chain, approved with clear_rejection', 'a branch from the enrolled authority, kept with resolve_fork'] as const) {
  test(`after a rejection, ${line}, completes the hold and re-binds after the Stripe reset`, async () => {
    const s = await reactivated(`rebind-recover-${line.length}`);
    await C.applyCreditEvent(s.w.d, C.purchase(s.fAccount.account_id, 50));
    expect((await s.account(s.n, s.toN)).handover_pending).toBeDefined();
    expect(await s.operator('reject', s.chainOf(s.toN).chainId, s.n.pubkey)).toBe(200);
    const q = C.generateKeys();
    const toQ = line.startsWith('a successor') ? [...s.toN, s.move(s.n, q)] : [s.move(s.f, q)];
    const qChain = s.chainOf(toQ);
    const copiedToken = { lic_id: s.id, renewal_token: s.token }; // N's license-renew-token file copied to Q
    if (line.startsWith('a successor')) {
      expect(await C.err(s.account(q, toQ))).toBe('team_ownership_required'); // the rejected chain blocks descendants
      expect(await s.operator('clear_rejection', qChain.chainId, q.pubkey)).toBe(200);
      expect(await C.err(s.account(q, toQ, copiedToken))).toBe('team_ownership_required'); // the licence names N
      expect(await s.w.store.tx(t => t.control(handoverKey(s.t.team)))).toBeFalsy();
    } else {
      expect(await C.err(s.account(q, toQ, copiedToken))).toBe('team_ownership_required'); // refused before any fork check
      expect(await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBeFalsy();
      expect(await C.err(s.account(q, toQ))).toBe('team_ownership_required'); // conflicts with the recorded chain
      expect(await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBeNumber();
      expect(await s.operator('resolve_fork', qChain.chainId)).toBe(403); // the rejected old chain blocks every proposal
      expect(await s.operator('clear_rejection', qChain.chainId, q.pubkey)).toBe(200); // approve this exact candidate
      expect(await s.operator('resolve_fork', qChain.chainId)).toBe(200);
    }
    if (line.startsWith('a successor')) expect((await s.account(q, toQ)).handover_pending).toBeDefined();
    expect(await s.w.store.tx(t => t.control(handoverKey(s.t.team)))).toMatchObject({ proposed_key: q.pubkey });
    s.w.clock.now += HANDOVER_MS;
    expect(await s.operator('complete', qChain.chainId, q.pubkey)).toBe(200);
    expect(await s.enrolled()).toBe(q.pubkey);
    expect((await s.bind(q, toQ)).status).toBe(403); // the licence still names the rejected authority
    await resetAuthority(s);
    const rebound = await s.bind(q, toQ);
    expect(rebound.status).toBe(200);
    expect(await s.renew(rebound.body.renewal_token!)).toBe(200);
    expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(403);
    expect(await s.renew(s.oldToken, s.renewProof(s.f))).toBe(403);
  });
}

test('an approved candidate hold left past 72 hours expires; lift_expired reopens it for a new hold', async () => {
  const s = await reactivated('rebind-expired');
  await C.applyCreditEvent(s.w.d, C.purchase(s.fAccount.account_id, 50));
  expect((await s.account(s.n, s.toN)).handover_pending).toBeDefined();
  expect(await s.operator('reject', s.chainOf(s.toN).chainId, s.n.pubkey)).toBe(200);
  const q = C.generateKeys(), toQ = [...s.toN, s.move(s.n, q)], qChain = s.chainOf(toQ);
  expect(await s.operator('clear_rejection', qChain.chainId, q.pubkey)).toBe(200);
  expect((await s.account(q, toQ)).handover_pending).toBeDefined();
  s.w.clock.now += ACK_EXPIRY_MS + 1; // no owner acknowledged the hold
  expect(await s.operator('complete', qChain.chainId, q.pubkey)).toBe(409);
  expect(await s.enrolled()).toBe(s.f.pubkey);
  expect(await C.err(s.account(q, toQ))).toBe('team_ownership_required');
  expect(await s.operator('lift_expired', qChain.chainId, q.pubkey)).toBe(200);
  expect((await s.account(q, toQ)).handover_pending).toBeDefined();
  s.w.clock.now += HANDOVER_MS;
  expect(await s.operator('complete', qChain.chainId, q.pubkey)).toBe(200);
  expect(await s.enrolled()).toBe(q.pubkey);
});

test('the enrolled key must be an earlier link of the recorded licence chain', async () => {
  const s = await reactivated('rebind-unlinked');
  await s.w.store.tx(t => t.setEnrollment({ team_id: s.t.team, key: C.generateKeys().pubkey, source: 'roster', updated_at: C.T0 }));
  expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(403);
  expect(await C.err(s.account(s.n, s.toN))).toBe('team_ownership_required');
});

// Round 4's route: records written while round 4's bind left the chain at F (never deployed).
test('round-4 data: the recorded chain lags the licence chain and the licence authority is its successor', async () => {
  const s = await reactivated('rebind-lagging');
  const atF = s.chainOf([]);
  await s.w.store.tx(t => t.setControl(`enrollment-chain:${s.t.team}`, { depth: atF.depth, chainId: atF.chainId, chain: atF.chain, version: 1 }));
  expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(200);
});

test('a recorded chain on another branch refuses the licence even when the enrolled key is an earlier link', async () => {
  const s = await reactivated('rebind-branch');
  const x = C.generateKeys(), branch = s.chainOf([s.move(s.f, x)]); // written directly: an inconsistent record
  await s.w.store.tx(t => t.setControl(`enrollment-chain:${s.t.team}`, { depth: branch.depth, chainId: branch.chainId,
    chain: branch.chain, version: 2 }));
  expect(await s.renew(s.token, s.renewProof(s.n, s.toN))).toBe(403);
});
