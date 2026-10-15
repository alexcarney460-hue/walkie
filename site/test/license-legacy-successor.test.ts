// Lane C round 2 (review REVIEW-C-opus finding 1): a lock-era licence (walkie_team + walkie_renew_hash only) on a team
// with compute state must keep renewing after a routine roster authority move, and when a former authority enrolled
// first with a truncated chain. The verified successor of the recorded chain renews; a held handover, a flagged fork,
// a rejected chain, an older chain, a conflicting branch and a rogue key do not. MemoryStore + MockStripe only.
import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { RENEW_HASH_META, renewHash, TEAM_META } from '../api/_lib/metadata.ts';
import { makeRenew } from '../api/license/renew.ts';
import { rejectHandover, handoverKey } from '../api/_lib/compute/handover.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { HANDOVER_MS } from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { BACKFILL_KEY } from '../api/_lib/compute/licence-records.ts';

const renewMessage = (team: string, license: string, expires: number): string =>
  `walkie-license-renew-v1\n${team}\n${license}\n${expires}`;
type Keys = ReturnType<typeof C.generateKeys>;

function world(name: string) {
  const w = C.world(), t = C.mkTeam(name), stripe = new C.LH.MockStripe();
  const id = `sub_${name.replace(/[^A-Za-z0-9]/g, '')}`, token = Buffer.alloc(32, 5).toString('base64url');
  stripe.subs.set(id, C.LH.subscription({ id, metadata: { [TEAM_META]: t.team, [RENEW_HASH_META]: renewHash(token) } }));
  w.d.verifyLicense = C.licenseVerifier(stripe);
  const env = C.LH.fullEnv(C.LH.testKeypair().pem);
  const renewReply = async (proof?: object) => makeRenew({ ...C.LH.deps(stripe, env), now: () => w.clock.now,
    computeStore: () => w.store })(new Request('https://site.test/api/license/renew', { method: 'POST',
    body: JSON.stringify({ lic_id: id, renewal_token: token, ...(proof ? { proof } : {}) }) }));
  const renew = async (proof?: object): Promise<number> => (await renewReply(proof)).status;
  const secret = ['0123456789', 'abcdef'].join('').repeat(2); // built at runtime: no key-shaped literal (scripts/public-gitleaks.toml)
  const operator = async (action: string, chain_id?: string, proposed_key?: string) => (await makeHandover({
    env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d, stripe: () => null } as never)(
    new Request('https://site.test/api/compute/handover', { method: 'POST', headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ team_id: t.team, action, chain_id, proposed_key }) }))).status;
  let seq = 1;
  const next = (by: Keys) => (seq += 3, seq);
  // `by` (the current authority) admits `to` as an owner machine and transfers the roster authority to it.
  const move = (by: Keys, to: Keys) => {
    const at = next(by);
    const member = C.signEvent(by, { v: C.PROTOCOL_VERSION, team: t.team, id: `${by.nodeId}:${at}`, origin: by.nodeId, seq: at,
      ts: C.T0 + at, author: { handle: 'alex', node: by.nodeId }, kind: 'team.member',
      body: { login: `direct:${to.nodeId}`, handle: `h${at}`, role: 'owner' } });
    const node = C.signEvent(by, { v: C.PROTOCOL_VERSION, team: t.team, id: `${by.nodeId}:${at + 1}`, origin: by.nodeId,
      seq: at + 1, ts: C.T0 + at + 1, author: { handle: 'alex', node: by.nodeId }, kind: 'team.node',
      body: { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: `m${at}`, pubkey: to.pubkey, ip: '127.0.0.1' } });
    const transfer = C.transfer(by, t.team, at + 2, to);
    return { transfer, events: [member, node, transfer.event] };
  };
  // A roster proof for `keys` along the given moves (empty = the founder's genesis-only chain).
  const roster = (moves: ReturnType<typeof move>[]) => ({ genesis: t.genesis,
    authority_chain: moves.map(m => m.transfer), roster_events: moves.flatMap(m => m.events) });
  const renewProof = (keys: Keys, moves: ReturnType<typeof move>[] = []) => {
    const expires_at = w.clock.now + 240_000;
    return { ...roster(moves), expires_at, renew_signature: keys.sign(renewMessage(t.team, id, expires_at)) };
  };
  const account = (keys: Keys, moves: ReturnType<typeof move>[] = [], licence = false) =>
    C.createAccount(w.d, t.team, C.proof(keys, t.team, w.clock.now, t.genesis, moves.map(m => m.transfer),
      { roster_events: moves.flatMap(m => m.events), ...(licence ? { lic_id: id, renewal_token: token } : {}) }));
  const chainOf = (moves: ReturnType<typeof move>[]) => teamAuthority(t.team, roster(moves) as never)!;
  /** The deployed first-enrollment reads, with the one-time licence backfill done (lane C rounds 7 and 10). */
  const deployedReads = async () => {
    w.d.teamLicences = async (team: string) => stripe.listSubscriptionsByTeam(team);
    w.d.licenceById = async (lic: string) => stripe.getSubscription(lic);
    await w.store.tx(x => x.setControl(BACKFILL_KEY, { complete_at: C.T0 }));
  };
  return { w, t, stripe, id, renew, renewReply, move, renewProof, account, operator, chainOf, deployedReads };
}

test('R1: after the roster authority moves, the new authority (holding the copied token) keeps renewing', async () => {
  const s = world('successor-r1'), f = s.t.f, n = C.generateKeys();
  await s.account(f, [], true); // the team enrolls in compute under F (licence claim included)
  const fToN = s.move(f, n);
  expect(await s.renew()).toBe(403);
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(200);
  expect(await s.renew(s.renewProof(f))).toBe(200); // the enrollment still names F
  // Once N touches compute the enrollment moves forward and the former authority is refused (its chain is older).
  await s.account(n, [fToN]);
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(200);
  expect(await s.renew(s.renewProof(f))).toBe(403);
  expect(s.stripe.calls.metadata).toEqual([]);
});

test('R3: a former authority that enrolled first with a truncated chain does not block the current authority', async () => {
  const s = world('successor-r3'), f = s.t.f, n = C.generateKeys();
  const fToN = s.move(f, n);
  expect(await s.renew()).toBe(200); // no compute state yet: the token alone renews
  await s.account(f); // F omits its transfer to N and enrolls first
  expect(await s.renew()).toBe(403);
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(200);
});

test('a rogue key, a conflicting branch and a flagged fork are refused; a deeper successor is not', async () => {
  const s = world('successor-refusals'), f = s.t.f, n = C.generateKeys(), p = C.generateKeys(), x = C.generateKeys();
  const rogue = C.generateKeys();
  const fToN = s.move(f, n);
  await s.account(n, [fToN]); // stored chain: F -> N
  expect(await s.renew({ ...s.renewProof(n, [fToN]), renew_signature: s.renewProof(rogue, [fToN]).renew_signature })).toBe(403);
  expect(await s.renew(s.renewProof(rogue))).toBe(403);
  const nToP = s.move(n, p);
  expect(await s.renew(s.renewProof(p, [fToN, nToP]))).toBe(200); // N -> P extends the stored chain
  // The former authority F signs a second, conflicting transfer F -> X: that branch never renews.
  const fToX = s.move(f, x);
  expect(await s.renew(s.renewProof(x, [fToX]))).toBe(403);
  // Presenting that branch to compute flags a fork; while it is flagged every signed renewal of the shared token
  // pauses, the exact enrolled authority's too (authority_fork_open, round 8).
  await s.account(x, [fToX]).catch(() => undefined);
  expect(await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBeNumber();
  expect(await s.renew(s.renewProof(p, [fToN, nToP]))).toBe(409);
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(409);
});

test('a held handover and then a rejected one refuse the successor; the enrolled authority still renews', async () => {
  const s = world('successor-held'), f = s.t.f, n = C.generateKeys();
  const funded = await s.account(f, [], true);
  await s.w.store.tx(t => t.addLedger({ account_id: funded.account_id, kind: 'purchase', live: true,
    amount_micros: 50_000_000, idem_key: C.idem(), created_at: C.T0 }));
  const fToN = s.move(f, n);
  expect((await s.account(n, [fToN])).handover_pending).toBeDefined(); // funded: the move is held for review
  expect(await s.w.store.tx(t => t.control(handoverKey(s.t.team)))).toBeTruthy();
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(403);
  expect(await s.renew(s.renewProof(f))).toBe(200);
  const chain = teamAuthority(s.t.team, { genesis: s.t.genesis, authority_chain: [fToN.transfer], roster_events: fToN.events })!;
  expect(await s.w.store.tx(t => rejectHandover(s.w.d, t, s.t.team, chain.chainId, n.pubkey))).toBe(true);
  expect(await s.w.store.tx(t => t.control(handoverKey(s.t.team)))).toBeFalsy();
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(403);
  expect(await s.renew(s.renewProof(f))).toBe(200);
  expect(s.stripe.calls.metadata).toEqual([]);
});

// Lane C round 8 (REVIEW-merged-opus P1(b)): the exactly enrolled signer of a legacy token was not checked for an open fork.
test('an open fork pauses the enrolled authority too (PROBE G); the operator keeping it restores renewal', async () => {
  const s = world('fork-exact'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  await s.deployedReads();
  const fToX = s.move(f, x), fToN = s.move(f, n);
  await s.account(x, [fToX], true); // X holds the shared renewal token (F's copy) and enrolls first
  expect(await s.renew(s.renewProof(x, [fToX]))).toBe(200);
  expect(await C.err(s.account(n, [fToN]))).toBe('team_ownership_required'); // N's branch conflicts: the fork is flagged
  expect(await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBeNumber();
  const paused = await s.renewReply(s.renewProof(x, [fToX]));
  expect([paused.status, await paused.json()]).toEqual([409, { error: 'authority_fork_open' }]);
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(403); // neither enrolled nor a successor
  expect(await s.operator('resolve_fork', s.chainOf([fToX]).chainId)).toBe(200); // the operator keeps X's chain
  expect(await s.renew(s.renewProof(x, [fToX]))).toBe(200);
  expect(s.stripe.calls.metadata).toEqual([]);
});

test('the operator keeping the candidate: hold, completion, then the candidate renews and the old enrollment is refused', async () => {
  const s = world('fork-candidate'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  await s.deployedReads();
  const fToX = s.move(f, x), fToN = s.move(f, n);
  await s.account(x, [fToX], true);
  expect(await C.err(s.account(n, [fToN]))).toBe('team_ownership_required');
  expect(await s.operator('resolve_fork', s.chainOf([fToN]).chainId)).toBe(200); // keeps N: a hold opens
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(403); // held for review
  s.w.clock.now += HANDOVER_MS;
  expect(await s.operator('complete', s.chainOf([fToN]).chainId, n.pubkey)).toBe(200);
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(200);
  expect(await s.renew(s.renewProof(x, [fToX]))).toBe(403);
});

test('a superseded key flagging a fork pauses a legitimately enrolled authority until the operator resolves it', async () => {
  const s = world('fork-legit'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  await s.deployedReads();
  const fToN = s.move(f, n), fToX = s.move(f, x);
  await s.account(n, [fToN], true); // N enrolls with the licence credentials
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(200);
  expect(await C.err(s.account(x, [fToX]))).toBe('team_ownership_required'); // F's branch to X flags a fork
  const paused = await s.renewReply(s.renewProof(n, [fToN]));
  expect([paused.status, await paused.json()]).toEqual([409, { error: 'authority_fork_open' }]);
  const p = C.generateKeys(), toP = [fToN, s.move(n, p)];
  const successor = await s.renewReply(s.renewProof(p, toP));
  expect([successor.status, await successor.json()]).toEqual([409, { error: 'authority_fork_open' }]);
  expect(await s.operator('resolve_fork', s.chainOf([fToN]).chainId)).toBe(200); // keeps N
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(200);
  expect(await s.renew(s.renewProof(p, toP))).toBe(200); // the successor rule applies again
});

// Lane C round 10 (REVIEW-fixdiff-opus P2 2, PROBE G3): X took the first enrollment with F's copy of the shared token.
// N's refused renewal must flag the fork for the operator, as enroll() does, instead of failing silently.
test('PROBE G3: the rightful holder refused by a conflicting recorded chain flags the fork and raises the alert', async () => {
  const s = world('fork-from-renewal'), f = s.t.f, n = C.generateKeys(), x = C.generateKeys();
  await s.deployedReads();
  const fToN = s.move(f, n), fToX = s.move(f, x);
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(200); // no compute state yet
  await s.account(x, [fToX], true); // X presents F's copy of the token and enrolls first
  const write = process.stderr.write.bind(process.stderr), lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    expect(await s.renew(s.renewProof(n, [fToN]))).toBe(403);
  } finally { process.stderr.write = write; }
  expect(await s.w.store.tx(t => t.control(`enrollment-fork:${s.t.team}`))).toBeNumber();
  const candidate = await s.w.store.tx(t => t.control(`enrollment-fork-candidate:${s.t.team}`)) as { chain: { chainId: string; key: string } };
  expect([candidate.chain.chainId, candidate.chain.key]).toEqual([s.chainOf([fToN]).chainId, n.pubkey]);
  expect(lines.filter(line => line.startsWith('compute alert_authority_fork '))).toEqual(
    [`compute alert_authority_fork ${JSON.stringify({ team: s.t.team, chain: s.chainOf([fToN]).chainId })}\n`]);
  expect(await s.renew(s.renewProof(x, [fToX]))).toBe(409); // X's renewals pause with the fork
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(403); // the open fork keeps its candidate
  expect(await s.operator('resolve_fork', s.chainOf([fToN]).chainId)).toBe(200); // the operator keeps N
  s.w.clock.now += HANDOVER_MS;
  expect(await s.operator('complete', s.chainOf([fToN]).chainId, n.pubkey)).toBe(200);
  expect(await s.renew(s.renewProof(n, [fToN]))).toBe(200);
  expect(await s.renew(s.renewProof(x, [fToX]))).toBe(403);
});
