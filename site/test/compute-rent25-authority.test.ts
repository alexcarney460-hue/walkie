import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { authorityPathMetadata, AUTHORITY_CHAIN_META, AUTHORITY_META, RENEW_CHAIN_META, RENEW_AUTHORITY_META,
  RENEW_HASH_META, renewHash, TEAM_META } from '../api/_lib/metadata.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { sealBindClaim } from '../api/_lib/compute/bind-claim.ts';
import { makeRenew } from '../api/license/renew.ts';
import { makeBind, bindMessage } from '../api/license/bind.ts';
import { handoverKey } from '../api/_lib/compute/handover.ts';

test('database-backed renewal rejects a token issued to a superseded authority', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const store = new MemoryStore(), stripe = new C.LH.MockStripe();
    const team = C.mkTeam('rent25-renew-authority'), next = C.generateKeys();
    const old = teamAuthority(team.team, { genesis: team.genesis })!;
    const token = Buffer.alloc(32, 7).toString('base64url'), id = ("sub_" + 'RENT25AUTHORITY');
    stripe.subs.set(id, C.LH.subscription({ id, metadata: {
      [TEAM_META]: team.team, [RENEW_HASH_META]: renewHash(token),
      [AUTHORITY_META]: team.f.pubkey, [AUTHORITY_CHAIN_META]: old.chainId,
      [RENEW_AUTHORITY_META]: team.f.pubkey, [RENEW_CHAIN_META]: old.chainId,
      ...authorityPathMetadata(old.chain),
    } }));
    const signer = C.LH.testKeypair(), env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1' });
    const renew = makeRenew({ ...C.LH.deps(stripe, env), computeStore: () => store });
    await store.tx(async t => {
      await t.setEnrollment({ team_id: team.team, key: team.f.pubkey, source: 'roster', updated_at: C.T0 });
      await t.setControl(`enrollment-chain:${team.team}`, old);
    });
    const valid = await renew(new Request('https://site.test/api/license/renew', { method: 'POST',
      body: JSON.stringify({ lic_id: id, renewal_token: token }) }));
    expect(valid.status).toBe(200);
    await store.tx(async t => {
      await t.setEnrollment({ team_id: team.team, key: next.pubkey, source: 'roster', updated_at: C.T0 });
      await t.setControl(`enrollment-chain:${team.team}`, { chainId: 'f'.repeat(64), depth: 1 });
    });
    const response = await renew(new Request('https://site.test/api/license/renew', { method: 'POST',
      body: JSON.stringify({ lic_id: id, renewal_token: token }) }));
    expect([response.status, await response.json()]).toEqual([403, { error: 'invalid_renewal' }]);
    stripe.subs.get(id)!.metadata[AUTHORITY_META] = next.pubkey;
    stripe.subs.get(id)!.metadata[AUTHORITY_CHAIN_META] = 'f'.repeat(64);
    const reused = await renew(new Request('https://site.test/api/license/renew', { method: 'POST',
      body: JSON.stringify({ lic_id: id, renewal_token: token }) }));
    expect([reused.status, await reused.json()]).toEqual([403, { error: 'invalid_renewal' }]);
  } finally { globalThis.fetch = fetchBefore; }
});

test('old-authority retry retains its claim during a pending handover', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const store = new MemoryStore(), stripe = new C.LH.MockStripe();
    const team = C.mkTeam('rent25-pending-claim');
    const old = teamAuthority(team.team, { genesis: team.genesis })!;
    const id = ("sub_" + 'RENT25PENDING'), token = Buffer.alloc(32, 8).toString('base64url');
    stripe.subs.set(id, C.LH.subscription({ id, metadata: {
      [TEAM_META]: team.team, [RENEW_HASH_META]: renewHash(token),
      [AUTHORITY_META]: team.f.pubkey, [AUTHORITY_CHAIN_META]: old.chainId,
      ...authorityPathMetadata(old.chain),
    } }));
    const signer = C.LH.testKeypair(), env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1' });
    const metadata = { ...stripe.subs.get(id)!.metadata };
    const claim = { ...sealBindClaim(env.COMPUTE_HANDOVER_TOKEN_KEY!, id, team.team, token, team.f.pubkey, old.chainId),
      write: { key: `walkie-db-bind-v2-${'a'.repeat(32)}`, metadata } };
    expect(await store.saveBindClaim(id, claim)).toBe(true);
    await store.tx(async t => {
      await t.setEnrollment({ team_id: team.team, key: team.f.pubkey, source: 'roster', updated_at: C.T0 });
      await t.setControl(`enrollment-chain:${team.team}`, old);
      await t.setControl(handoverKey(team.team), { proposal: 'pending' });
    });
    const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7,
      email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
      expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
    const expires_at = C.LH.NOW + 240_000;
    const proof = { genesis: team.genesis, authority_chain: [], roster_events: [], expires_at,
      bind_signature: team.f.sign(bindMessage(team.team, id, expires_at)) };
    const bind = makeBind({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST',
      body: JSON.stringify({ code, team_id: team.team, proof }) }));
    expect(response.status).toBe(403);
    expect((await store.bindClaim(id))?.hash).toBe(claim.hash);
  } finally { globalThis.fetch = fetchBefore; }
});
