import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { AUTHORITY_CHAIN_META, AUTHORITY_META, RENEW_AUTHORITY_META, RENEW_CHAIN_META,
  RENEW_HASH_META, renewHash, TEAM_META } from '../api/_lib/metadata.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { makeRenew } from '../api/license/renew.ts';

test('current signed authority replaces a pre-RENT-25 token through bind', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const team = C.mkTeam('rent26-legacy-replacement');
    const authority = teamAuthority(team.team, { genesis: team.genesis })!;
    const store = new MemoryStore(), stripe = new C.LH.MockStripe();
    const id = ("sub_" + 'RENT26LEGACY'), oldToken = Buffer.alloc(32, 9).toString('base64url');
    stripe.subs.set(id, C.LH.subscription({ id, metadata: {
      [TEAM_META]: team.team, [RENEW_HASH_META]: renewHash(oldToken),
      [AUTHORITY_META]: authority.key, [AUTHORITY_CHAIN_META]: authority.chainId,
    } }));
    // A licensed team may have a current signed chain without a compute enrollment.
    await store.tx(t => t.setControl(`enrollment-chain:${team.team}`, authority));
    const signer = C.LH.testKeypair(), env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1' });
    const renew = makeRenew({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const renewWith = (token: string) => new Request('https://site.test/api/license/renew', {
      method: 'POST', body: JSON.stringify({ lic_id: id, renewal_token: token }),
    });
    expect((await renew(renewWith(oldToken))).status).toBe(403);
    const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7,
      email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
      expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
    const expires_at = C.LH.NOW + 240_000;
    const proof = { genesis: team.genesis, authority_chain: [], roster_events: [], expires_at,
      bind_signature: team.f.sign(C.bindMessage(team.team, id, expires_at)) };
    const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const request = () => new Request('https://site.test/api/license/bind', { method: 'POST',
      body: JSON.stringify({ code, team_id: team.team, proof }) });
    const replaced = await bind(request());
    expect(replaced.status).toBe(200);
    const body = await replaced.json() as { renewal_token?: string };
    expect(body.renewal_token).toBeString();
    expect(body.renewal_token).not.toBe(oldToken);
    const metadata = stripe.subs.get(id)!.metadata;
    expect(metadata[RENEW_HASH_META]).toBe(renewHash(body.renewal_token!));
    expect(metadata[RENEW_AUTHORITY_META]).toBe(authority.key);
    expect(metadata[RENEW_CHAIN_META]).toBe(authority.chainId);
    expect((await renew(renewWith(oldToken))).status).toBe(403);
    expect((await renew(renewWith(body.renewal_token!))).status).toBe(200);
    expect((await bind(request()).then(r => r.json()) as { renewal_token?: string }).renewal_token).toBeUndefined();
    await store.tx(t => t.setControl(`enrollment-chain:${team.team}`, null));
    stripe.subs.get(id)!.metadata[RENEW_HASH_META] = renewHash(oldToken);
    delete stripe.subs.get(id)!.metadata[RENEW_AUTHORITY_META];
    delete stripe.subs.get(id)!.metadata[RENEW_CHAIN_META];
    const unverifiable = await bind(request());
    expect(unverifiable.status).toBe(403);
    expect(await unverifiable.json()).toEqual({ error: 'team_ownership_required' });
  } finally { globalThis.fetch = previousFetch; }
});

test('superseded authority cannot replace or renew a pre-RENT-25 token', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const team = C.mkTeam('rent26-superseded'), next = C.generateKeys();
    const old = teamAuthority(team.team, { genesis: team.genesis })!;
    const store = new MemoryStore(), stripe = new C.LH.MockStripe();
    const id = ("sub_" + 'RENT26SUPERSEDED'), oldToken = Buffer.alloc(32, 10).toString('base64url');
    stripe.subs.set(id, C.LH.subscription({ id, metadata: {
      [TEAM_META]: team.team, [RENEW_HASH_META]: renewHash(oldToken),
      [AUTHORITY_META]: old.key, [AUTHORITY_CHAIN_META]: old.chainId,
    } }));
    await store.tx(async t => {
      await t.setEnrollment({ team_id: team.team, key: next.pubkey, source: 'roster', updated_at: C.T0 });
      await t.setControl(`enrollment-chain:${team.team}`, {
        depth: 1, chainId: 'f'.repeat(64), chain: [old.chainId, 'f'.repeat(64)],
      });
    });
    const signer = C.LH.testKeypair(), env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1' });
    const renew = makeRenew({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const renewal = await renew(new Request('https://site.test/api/license/renew', { method: 'POST',
      body: JSON.stringify({ lic_id: id, renewal_token: oldToken }) }));
    expect([renewal.status, await renewal.json()]).toEqual([403, { error: 'invalid_renewal' }]);
    const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7,
      email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
      expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
    const expires_at = C.LH.NOW + 240_000;
    const proof = { genesis: team.genesis, authority_chain: [], roster_events: [], expires_at,
      bind_signature: team.f.sign(C.bindMessage(team.team, id, expires_at)) };
    const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST',
      body: JSON.stringify({ code, team_id: team.team, proof }) }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'team_ownership_required' });
    expect(stripe.subs.get(id)!.metadata[RENEW_HASH_META]).toBe(renewHash(oldToken));
    expect(stripe.calls.metadata).toHaveLength(0);
    // Enrollment can advance before a lagging chain read. That split state is
    // not evidence that the old signer still owns this renewal token.
    await store.tx(t => t.setControl(`enrollment-chain:${team.team}`, old));
    const lagging = await bind(new Request('https://site.test/api/license/bind', { method: 'POST',
      body: JSON.stringify({ code, team_id: team.team, proof }) }));
    expect(lagging.status).toBe(403);
    expect(await lagging.json()).toEqual({ error: 'team_ownership_required' });
    expect(stripe.calls.metadata).toHaveLength(0);
  } finally { globalThis.fetch = previousFetch; }
});
