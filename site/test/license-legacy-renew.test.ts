// Lane C (go-live review O P1-3): licences bound by the released, compute-locked bind (pre.10 to pre.16) carry only
// walkie_team + walkie_renew_hash. Once the site lock flips with a store configured, they must keep renewing, and the
// authority checks for licences bound with a recorded authority must not weaken. MemoryStore + MockStripe only.
import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { authorityPathMetadata, AUTHORITY_CHAIN_META, AUTHORITY_META, RENEW_AUTHORITY_META, RENEW_CHAIN_META,
  RENEW_HASH_META, renewHash, TEAM_META } from '../api/_lib/metadata.ts';
import { makeRenew } from '../api/license/renew.ts';
import { makeBind, bindMessage } from '../api/license/bind.ts';
import { licenseVerifier } from '../api/_lib/compute/license-proof.ts';
import { signingKeyFromPem, verifySigned } from '../api/_lib/license.ts';
import { COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION } from '../api/_lib/compute/release-gate.ts';

const renewMessage = (team: string, license: string, expires: number): string =>
  `walkie-license-renew-v1\n${team}\n${license}\n${expires}`;
const NOW = C.LH.NOW;

function world(name: string) {
  const team = C.mkTeam(name);
  const signer = C.LH.testKeypair();
  const env = C.LH.fullEnv(signer.pem, { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/unused' });
  const stripe = new C.LH.MockStripe();
  const store = new MemoryStore();
  const id = `sub_${name.replace(/[^A-Za-z0-9]/g, '')}`;
  const token = Buffer.alloc(32, name.length).toString('base64url');
  const chain = teamAuthority(team.team, { genesis: team.genesis })!;
  const renew = (body: Record<string, unknown>, preview = true) => makeRenew({ ...C.LH.deps(stripe, env),
    previewCompute: preview, computeStore: () => store })(new Request('https://site.test/api/license/renew',
    { method: 'POST', body: JSON.stringify(body) }));
  const proof = (keys = team.f, over: { license?: string; expires?: number; message?: string } = {}) => {
    const expires_at = over.expires ?? NOW + 240_000;
    return { genesis: team.genesis, authority_chain: [], roster_events: [], expires_at,
      renew_signature: keys.sign(over.message ?? renewMessage(team.team, over.license ?? id, expires_at)) };
  };
  const enroll = (key = team.f.pubkey, stored: object = chain) => store.tx(async t => {
    await t.setEnrollment({ team_id: team.team, key, source: 'roster', updated_at: C.T0 });
    await t.setControl(`enrollment-chain:${team.team}`, stored);
  });
  return { team, signer, env, stripe, store, id, token, chain, renew, proof, enroll };
}

const lockEra = (team: string, token: string) => ({ [TEAM_META]: team, [RENEW_HASH_META]: renewHash(token) });
const storeLegacy = (team: string, token: string) => ({ ...lockEra(team, token),
  [RENEW_AUTHORITY_META]: 'legacy', [RENEW_CHAIN_META]: 'legacy' });
const status = async (res: Response) => [res.status, await res.json()];

// The released site (pre.10 to pre.16 lock): no database, and the daemon's roster proof is ignored. This is the code
// the deployed handler runs while the lock is on; C.LH.releasedBind sets the same two keys for lock-independent tests.
test.skipIf(COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION)('the released compute-locked bind writes only walkie_team and walkie_renew_hash', async () => {
  const w = world('legacy-locked-bind');
  w.stripe.subs.set(w.id, C.LH.subscription({ id: w.id }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: w.id, plan: 'team', seats: 7, email: 'lead@kestrel.test',
    interval: 'month', issued_at: NOW, expires_at: NOW + 30 * 86_400_000 }, signingKeyFromPem(w.signer.pem));
  let databaseCalls = 0;
  const bound = await makeBind({ ...C.LH.deps(w.stripe, w.env), previewCompute: false,
    computeStore: () => { databaseCalls++; throw Error('database touched'); } })(new Request(
    'https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: w.team.team, proof: w.proof() }) }));
  expect(bound.status).toBe(200);
  const { renewal_token: token } = await bound.json() as { renewal_token: string };
  expect(w.stripe.subs.get(w.id)!.metadata).toEqual(lockEra(w.team.team, token));
  expect(databaseCalls).toBe(0);
});

test('a licence bound by the released compute-locked bind renews after the flip with a store configured', async () => {
  const w = world('legacy-flip');
  w.stripe.subs.set(w.id, C.LH.subscription({ id: w.id }));
  const { body: { renewal_token: token } } = C.LH.releasedBind(w.stripe, w.id, w.team.team);
  expect(Object.keys(w.stripe.subs.get(w.id)!.metadata).sort()).toEqual(['walkie_renew_hash', 'walkie_team']);
  const writes = w.stripe.calls.metadata.length;
  const res = await w.renew({ lic_id: w.id, renewal_token: token });
  expect(res.status).toBe(200);
  const key = (await res.json() as { key: string }).key;
  expect(verifySigned(key, signingKeyFromPem(w.signer.pem))).toMatchObject({ kind: 'license', team: w.team.team, lic_id: w.id });
  expect(w.stripe.calls.metadata).toHaveLength(writes); // renew stays read-only
});

test('store-era legacy markers still renew while the team has no compute state', async () => {
  const w = world('legacy-markers');
  w.stripe.subs.set(w.id, C.LH.subscription({ id: w.id, metadata: storeLegacy(w.team.team, w.token) }));
  expect((await w.renew({ lic_id: w.id, renewal_token: w.token })).status).toBe(200);
  expect(await status(await w.renew({ lic_id: w.id, renewal_token: 'A'.repeat(43) }))).toEqual([403, { error: 'invalid_renewal' }]);
});

for (const [shape, metadata] of [['lock-era', lockEra], ['store-era legacy', storeLegacy]] as const) {
  test(`${shape} licence on an enrolled team renews only with the enrolled authority's signed proof`, async () => {
    const w = world(`enrolled-${shape}`);
    w.stripe.subs.set(w.id, C.LH.subscription({ id: w.id, metadata: metadata(w.team.team, w.token) }));
    await w.enroll();
    const before = structuredClone(w.stripe.subs.get(w.id)!.metadata);
    expect(await status(await w.renew({ lic_id: w.id, renewal_token: w.token }))).toEqual([403, { error: 'invalid_renewal' }]);
    const ok = await w.renew({ lic_id: w.id, renewal_token: w.token, proof: w.proof() });
    expect(ok.status).toBe(200);
    expect(verifySigned((await ok.json() as { key: string }).key, signingKeyFromPem(w.signer.pem)))
      .toMatchObject({ kind: 'license', team: w.team.team, lic_id: w.id });
    expect(w.stripe.subs.get(w.id)!.metadata).toEqual(before);
    expect(w.stripe.calls.metadata).toEqual([]);
  });
}

test('a legacy token on a team with compute state refuses every proof but a fresh one from the exact enrolled authority', async () => {
  const w = world('legacy-refusals');
  w.stripe.subs.set(w.id, C.LH.subscription({ id: w.id, metadata: lockEra(w.team.team, w.token) }));
  const refused = async (body: Record<string, unknown>) =>
    expect(await status(await w.renew({ lic_id: w.id, renewal_token: w.token, ...body }))).toEqual([403, { error: 'invalid_renewal' }]);
  await w.enroll();
  await refused({ proof: w.proof(w.team.f, { expires: NOW }) });
  await refused({ proof: w.proof(w.team.f, { expires: NOW + 300_001 }) });
  await refused({ proof: w.proof(w.team.f, { message: bindMessage(w.team.team, w.id, NOW + 240_000) }) });
  await refused({ proof: w.proof(w.team.f, { license: 'sub_another' }) });
  await refused({ proof: { ...w.proof(), renew_signature: undefined } });
  await refused({ proof: { ...w.proof(), genesis: C.mkTeam('someone-else').genesis } });
  await refused({ proof: [w.proof()] });
  await refused({ proof: w.proof(C.generateKeys()) });
  expect(await status(await w.renew({ lic_id: w.id, renewal_token: 'A'.repeat(43), proof: w.proof() })))
    .toEqual([403, { error: 'invalid_renewal' }]);
  // The authority moved on (a completed handover): the former authority's valid proof no longer renews.
  await w.enroll(C.generateKeys().pubkey);
  await refused({ proof: w.proof() });
  // A recorded chain that is not the presented one refuses too, with or without an enrollment row.
  const other = world('legacy-chain-only');
  other.stripe.subs.set(other.id, C.LH.subscription({ id: other.id, metadata: lockEra(other.team.team, other.token) }));
  await other.store.tx(t => t.setControl(`enrollment-chain:${other.team.team}`, { ...other.chain, chainId: 'f'.repeat(64) }));
  expect((await other.renew({ lic_id: other.id, renewal_token: other.token, proof: other.proof() })).status).toBe(403);
  // That conflict flags a fork for the operator (round 10, as enroll() does); the operator's resolution clears it.
  expect(await other.store.tx(t => t.control(`enrollment-fork:${other.team.team}`))).toBeNumber();
  await other.store.tx(t => t.setControl(`enrollment-fork:${other.team.team}`, null));
  await other.store.tx(t => t.setControl(`enrollment-chain:${other.team.team}`, other.chain));
  expect((await other.renew({ lic_id: other.id, renewal_token: other.token, proof: other.proof() })).status).toBe(200);
});

test('licences bound to an authority keep the RENT-25 checks; a proof never revives a superseded token', async () => {
  const w = world('bound-authority');
  w.stripe.subs.set(w.id, C.LH.subscription({ id: w.id, metadata: { [TEAM_META]: w.team.team,
    [RENEW_HASH_META]: renewHash(w.token), [AUTHORITY_META]: w.team.f.pubkey, [AUTHORITY_CHAIN_META]: w.chain.chainId,
    [RENEW_AUTHORITY_META]: w.team.f.pubkey, [RENEW_CHAIN_META]: w.chain.chainId, ...authorityPathMetadata(w.chain.chain) } }));
  await w.enroll();
  expect((await w.renew({ lic_id: w.id, renewal_token: w.token })).status).toBe(200);
  await w.enroll(C.generateKeys().pubkey, { ...w.chain, chainId: 'f'.repeat(64) });
  expect(await status(await w.renew({ lic_id: w.id, renewal_token: w.token, proof: w.proof() })))
    .toEqual([403, { error: 'invalid_renewal' }]);
});

test('an operator-reset licence (authority cleared, renew markers kept) stays refused', async () => {
  const w = world('operator-reset');
  const former = C.generateKeys();
  w.stripe.subs.set(w.id, C.LH.subscription({ id: w.id, metadata: { ...lockEra(w.team.team, w.token),
    [RENEW_AUTHORITY_META]: former.pubkey, [RENEW_CHAIN_META]: 'e'.repeat(64) } }));
  await w.enroll();
  expect((await w.renew({ lic_id: w.id, renewal_token: w.token, proof: w.proof() })).status).toBe(403);
  const lone = world('lone-marker');
  lone.stripe.subs.set(lone.id, C.LH.subscription({ id: lone.id, metadata: { ...lockEra(lone.team.team, lone.token),
    [RENEW_AUTHORITY_META]: 'legacy' } }));
  expect((await lone.renew({ lic_id: lone.id, renewal_token: lone.token })).status).toBe(403);
});

test('a renewal proof may exceed the proofless 8 KiB body limit', async () => {
  const w = world('large-proof');
  w.stripe.subs.set(w.id, C.LH.subscription({ id: w.id, metadata: lockEra(w.team.team, w.token) }));
  await w.enroll();
  const padded = { ...w.proof(), padding: 'x'.repeat(20_000) };
  expect((await w.renew({ lic_id: w.id, renewal_token: w.token, proof: padded })).status).toBe(200);
  expect(await status(await w.renew({ lic_id: w.id, renewal_token: w.token, padding: 'x'.repeat(20_000) })))
    .toEqual([413, { error: 'too_large' }]);
});

// Only meaningful while the release lock is on: the deployed handler keeps the released semantics.
test.skipIf(COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION)('the locked handler keeps its 8 KiB limit and never opens the database for a proof', async () => {
  const w = world('locked-proof');
  w.stripe.subs.set(w.id, C.LH.subscription({ id: w.id, metadata: lockEra(w.team.team, w.token) }));
  const padded = { ...w.proof(), padding: 'x'.repeat(20_000) };
  let databaseCalls = 0;
  const locked = (body: Record<string, unknown>) => makeRenew({ ...C.LH.deps(w.stripe, w.env), previewCompute: false,
    computeStore: () => { databaseCalls++; throw Error('database touched'); } })(new Request('https://site.test/api/license/renew',
    { method: 'POST', body: JSON.stringify(body) }));
  expect((await locked({ lic_id: w.id, renewal_token: w.token, proof: padded })).status).toBe(413);
  expect((await locked({ lic_id: w.id, renewal_token: w.token, proof: w.proof() })).status).toBe(200);
  expect(databaseCalls).toBe(0);
});

test('a licensed team bound under the lock can create its compute account and keep renewing', async () => {
  const w = C.world(), t = C.mkTeam('legacy-account');
  const stripe = new C.LH.MockStripe(), store = w.store;
  const id = ['sub', 'LEGACYACCOUNT'].join('_'), token = Buffer.alloc(32, 3).toString('base64url');
  stripe.subs.set(id, C.LH.subscription({ id, metadata: lockEra(t.team, token) }));
  w.d.verifyLicense = licenseVerifier(stripe);
  // The authority daemon attaches its licence (lic_id + renewal token) to the account request.
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis, [], { lic_id: id, renewal_token: token }));
  expect(await store.tx(x => x.enrollment(t.team))).toMatchObject({ key: t.f.pubkey, source: 'license' });
  const signer = C.LH.testKeypair(), env = C.LH.fullEnv(signer.pem);
  const renew = (body: Record<string, unknown>) => makeRenew({ ...C.LH.deps(stripe, env), now: () => w.clock.now,
    computeStore: () => store })(new Request('https://site.test/api/license/renew', { method: 'POST', body: JSON.stringify(body) }));
  expect((await renew({ lic_id: id, renewal_token: token })).status).toBe(403);
  const expires_at = w.clock.now + 240_000;
  const proof = { genesis: t.genesis, authority_chain: [], roster_events: [], expires_at,
    renew_signature: t.f.sign(renewMessage(t.team, id, expires_at)) };
  expect((await renew({ lic_id: id, renewal_token: token, proof })).status).toBe(200);
});

test('the licence claim verifier accepts an unbound-authority licence only for its own team, token and active status', async () => {
  const t = C.mkTeam('verifier'), token = 'R'.repeat(43);
  const sub = C.LH.subscription({ id: 'sub_VERIFIER', metadata: lockEra(t.team, token) });
  const verify = licenseVerifier({ getSubscription: async () => structuredClone(sub) });
  expect(await verify(t.team, sub.id, token, t.f.pubkey)).toBe(true);
  sub.metadata = storeLegacy(t.team, token);
  expect(await verify(t.team, sub.id, token, t.f.pubkey)).toBe(true);
  expect(await verify(t.team, sub.id, 'S'.repeat(43), t.f.pubkey)).toBe(false);
  expect(await verify(C.mkTeam('other').team, sub.id, token, t.f.pubkey)).toBe(false);
  sub.metadata = { ...lockEra(t.team, token), [RENEW_AUTHORITY_META]: C.generateKeys().pubkey, [RENEW_CHAIN_META]: 'e'.repeat(64) };
  expect(await verify(t.team, sub.id, token, t.f.pubkey)).toBe(false);
  sub.metadata = { ...lockEra(t.team, token), [AUTHORITY_META]: C.generateKeys().pubkey };
  expect(await verify(t.team, sub.id, token, t.f.pubkey)).toBe(false);
  sub.metadata = lockEra(t.team, token);
  for (const status of ['past_due', 'unpaid', 'incomplete', 'paused', 'trialing']) { // still the holder's (round 10)
    sub.status = status;
    expect(await verify(t.team, sub.id, token, t.f.pubkey)).toBe(true);
  }
  for (const status of ['canceled', 'incomplete_expired']) {
    sub.status = status;
    expect(await verify(t.team, sub.id, token, t.f.pubkey)).toBe(false);
  }
});
