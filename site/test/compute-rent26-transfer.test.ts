import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { authorityPathMetadata, AUTHORITY_CHAIN_META, AUTHORITY_META, RENEW_AUTHORITY_META,
  RENEW_CHAIN_META, RENEW_HASH_META, renewHash, TEAM_META } from '../api/_lib/metadata.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { makeRenew } from '../api/license/renew.ts';

test('unfunded signed authority transfer issues an idempotently stored replacement token', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const team = C.mkTeam('rent26-unfunded-transfer'), next = C.generateKeys();
    const old = teamAuthority(team.team, { genesis: team.genesis })!;
    const event = (seq: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) =>
      C.signEvent(team.f, { v: C.PROTOCOL_VERSION, team: team.team, id: `${team.f.nodeId}:${seq}`,
        origin: team.f.nodeId, seq, ts: C.T0 + seq,
        author: { handle: 'alex', node: team.f.nodeId }, kind, body });
    const transfer = C.transfer(team.f, team.team, 4, next);
    const roster = { genesis: team.genesis, authority_chain: [transfer], roster_events: [
      event(2, 'team.member', { login: `direct:${next.nodeId}`, handle: 'next', role: 'owner' }),
      event(3, 'team.node', { node_id: next.nodeId, login: `direct:${next.nodeId}`,
        hostname: 'next', pubkey: next.pubkey, ip: '127.0.0.1' }), transfer.event,
    ] };
    const current = teamAuthority(team.team, roster)!;
    const store = new MemoryStore(), stripe = new C.LH.MockStripe();
    const id = ("sub_" + 'RENT26TRANSFER'), oldToken = Buffer.alloc(32, 11).toString('base64url');
    stripe.subs.set(id, C.LH.subscription({ id, metadata: {
      [TEAM_META]: team.team, [RENEW_HASH_META]: renewHash(oldToken),
      [RENEW_AUTHORITY_META]: old.key, [RENEW_CHAIN_META]: old.chainId,
      [AUTHORITY_META]: old.key, [AUTHORITY_CHAIN_META]: old.chainId,
      ...authorityPathMetadata(old.chain),
    } }));
    await store.tx(async t => {
      await t.setEnrollment({ team_id: team.team, key: next.pubkey, source: 'roster', updated_at: C.T0 });
      await t.setControl(`enrollment-chain:${team.team}`, old);
    });
    const originalWrite = stripe.setSubscriptionMetadata.bind(stripe);
    let writeCount = 0;
    stripe.setSubscriptionMetadata = async (subscription, metadata, options) => {
      writeCount++;
      expect(subscription).toBe(id);
      expect(options?.idempotencyKey).toMatch(/^walkie-db-bind-v2-[0-9a-f]{32}$/);
      expect(options?.maxNetworkRetries).toBe(0);
      const claim = await store.bindClaim(id);
      expect(claim?.write?.key).toBe(options?.idempotencyKey);
      expect(claim?.write?.metadata).toEqual(metadata);
      expect(claim?.hash).toBe(metadata[RENEW_HASH_META]);
      await originalWrite(subscription, metadata, options);
    };
    const signer = C.LH.testKeypair(), env = C.LH.fullEnv(signer.pem, { COMPUTE_ENABLED: '1' });
    const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7,
      email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
      expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
    const expires_at = C.LH.NOW + 240_000;
    const proof = { ...roster, expires_at,
      bind_signature: next.sign(C.bindMessage(team.team, id, expires_at)) };
    const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const request = () => new Request('https://site.test/api/license/bind', { method: 'POST',
      body: JSON.stringify({ code, team_id: team.team, proof }) });
    const response = await bind(request());
    expect(response.status).toBe(200);
    const body = await response.json() as { renewal_token?: string };
    expect(body.renewal_token).toBeString();
    expect(body.renewal_token).not.toBe(oldToken);
    expect(writeCount).toBe(1);
    const metadata = stripe.subs.get(id)!.metadata;
    expect(metadata[RENEW_HASH_META]).toBe(renewHash(body.renewal_token!));
    expect(metadata[RENEW_AUTHORITY_META]).toBe(current.key);
    expect(metadata[RENEW_CHAIN_META]).toBe(current.chainId);
    expect((await store.bindClaim(id))).toBeNull();
    const renew = makeRenew({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const renewal = (token: string) => new Request('https://site.test/api/license/renew', { method: 'POST',
      body: JSON.stringify({ lic_id: id, renewal_token: token }) });
    expect((await renew(renewal(oldToken))).status).toBe(403);
    expect((await renew(renewal(body.renewal_token!))).status).toBe(200);
    const repeated = await bind(request());
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as { renewal_token?: string }).renewal_token).toBeUndefined();
    expect(writeCount).toBe(1);
  } finally { globalThis.fetch = previousFetch; }
});
