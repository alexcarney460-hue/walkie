import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import type { ComputeStore } from '../api/_lib/compute/store.ts';
import { renewHash } from '../api/_lib/metadata.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { HANDOVER_MS } from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { makeRenew } from '../api/license/renew.ts';
import { openBindClaim, sealBindClaim } from '../api/_lib/compute/bind-claim.ts';

async function claimScenario(store: ComputeStore, id: string, computeLive = true, signed = false): Promise<void> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
    const first = C.mkTeam('rent23-claim-first'), other = C.mkTeam('rent23-claim-other');
    const env = { ...C.LH.fullEnv(signer.pem), ...(computeLive ? { COMPUTE_ENABLED: '1' } : {}) };
    stripe.subs.set(id, C.LH.subscription({ id }));
    const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7,
      email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
      expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
    const expires_at = C.LH.NOW + 240_000;
    const proof = { genesis: first.genesis, authority_chain: [], roster_events: [], expires_at,
      bind_signature: first.f.sign(C.bindMessage(first.team, id, expires_at)) };
    const request = (team: string, withProof = true) => new Request('https://site.test/api/license/bind', {
      method: 'POST', body: JSON.stringify({ code, team_id: team,
        ...(signed && team === first.team && withProof ? { proof } : {}) }),
    });
    const realWrite = stripe.setSubscriptionMetadata.bind(stripe);
    let lateWrite: (() => Promise<void>) | undefined;
    let firstWrite = true;
    let replayAvailable = false;
    const results = new Map<string, string>();
    const idempotentWrite = async (subscription: string, metadata: Record<string, string>,
      options?: { idempotencyKey?: string; timeout?: number; maxNetworkRetries?: number }) => {
      const key = options?.idempotencyKey;
      expect(key).toMatch(/^walkie-db-bind-v2-[0-9a-f]{32}$/);
      const params = JSON.stringify({ subscription, metadata: Object.fromEntries(Object.entries(metadata).sort()) });
      const prior = results.get(key!);
      if (prior && prior !== params) throw Error('idempotency_error');
      if (!prior) { await realWrite(subscription, metadata, options); results.set(key!, params); }
    };
    stripe.setSubscriptionMetadata = async (subscription, metadata, options) => {
      expect(options?.maxNetworkRetries).toBe(0);
      if (firstWrite) {
        firstWrite = false;
        lateWrite = () => idempotentWrite(subscription, metadata, options);
        throw Error('client timeout; remote write still pending');
      }
      if (!replayAvailable) throw Error('Stripe replay temporarily unavailable');
      await idempotentWrite(subscription, metadata, options);
    };
    const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const failed = await bind(request(first.team));
    expect(failed.status).toBe(503);
    const claim = await store.bindClaim?.(id);
    expect(claim?.team).toBe(first.team);
    expect(claim?.write?.key).toMatch(/^walkie-db-bind-v2-[0-9a-f]{32}$/);
    expect(claim?.write?.metadata.walkie_renew_hash).toBe(claim?.hash);
    expect(lateWrite).toBeDefined();
    expect((await bind(request(other.team))).status).toBe(503);
    await lateWrite!();
    replayAvailable = true;
    expect(stripe.calls.metadata).toHaveLength(1);
    const blocked = await bind(request(other.team));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: 'license_bound_elsewhere' });
    if (signed && computeLive) {
      const w = C.world();
      w.d.store = store;
      await C.createAccount(w.d, first.team, C.proof(first.f, first.team, w.clock.now, first.genesis));
    }
    if (signed) expect((await bind(request(first.team, false))).status).toBe(403);
    const recovered = await bind(request(first.team));
    const body = await recovered.json() as { renewal_token?: string };
    expect(recovered.status).toBe(200);
    expect(typeof body.renewal_token).toBe('string');
    expect(JSON.stringify(claim)).not.toContain(body.renewal_token!);
    expect(stripe.subs.get(id)!.metadata.walkie_renew_hash).toBe(renewHash(body.renewal_token!));
    expect(await store.bindClaim?.(id)).toBeNull();
    if (!computeLive) expect(await store.tx(t => t.control(`enrollment-chain:${first.team}`))).toBeUndefined();
  } finally { globalThis.fetch = previousFetch; }
}

test('memory store retains timed-out claim until the late Stripe write', async () => {
  await claimScenario(new MemoryStore(), ("sub_" + 'RENT23_CLAIM_MEMORY'));
  await claimScenario(new MemoryStore(), ("sub_" + 'RENT23_CLAIM_SIGNED'), true, true);
});

async function authorityChangeRetainsClaims(store: ComputeStore, suffix: string): Promise<void> {
  const team = C.mkTeam(`rent24-void-${suffix}`);
  const chain = teamAuthority(team.team, { genesis: team.genesis })!.chainId;
  const seal = () => sealBindClaim('rent-fixture-handover-key-32-bytes', `sub_RENT24${suffix}`,
    team.team, Buffer.alloc(32, 7).toString('base64url'), team.f.pubkey, chain);
  const id = `sub_RENT24${suffix}`;
  expect(await store.saveBindClaim?.(id, seal())).toBe(true);
  await store.tx(t => t.setEnrollment({ team_id: team.team, key: C.generateKeys().pubkey,
    source: 'roster', updated_at: C.T0 }));
  expect((await store.bindClaim?.(id))?.hash).toBe(seal().hash);
  await store.tx(t => t.setControl(`enrollment-chain:${team.team}`, { depth: 1,
    chainId: 'f'.repeat(64), chain: [chain, 'f'.repeat(64)] }));
  expect((await store.bindClaim?.(id))?.hash).toBe(seal().hash);
}

test('authority writes retain unresolved claims in the same memory transaction', async () => {
  await authorityChangeRetainsClaims(new MemoryStore(), 'MEMORY');
});

async function approvedHandoverVoidsClaim(store: ComputeStore, lateAfterApproval = false,
  cleanupFailure = false, normalBind = false): Promise<void> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const w = C.world(), team = C.mkTeam('rent24-old-claim'), next = C.generateKeys();
    w.d.store = store;
    const account = await C.createAccount(w.d, team.team, C.proof(team.f, team.team, w.clock.now, team.genesis));
    await C.applyCreditEvent(w.d, C.purchase(account.account_id, 50));
    const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe(), id = ("sub_" + 'RENT24OLDCLAIM');
    const env = { ...C.LH.fullEnv(signer.pem), COMPUTE_ENABLED: '1' };
    stripe.subs.set(id, C.LH.subscription({ id }));
    const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7,
      email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
      expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
    const expires_at = C.LH.NOW + 240_000;
    const proof = { genesis: team.genesis, authority_chain: [], roster_events: [], expires_at,
      bind_signature: team.f.sign(C.bindMessage(team.team, id, expires_at)) };
    const request = () => new Request('https://site.test/api/license/bind', { method: 'POST',
      body: JSON.stringify({ code, team_id: team.team, proof }) });
    const write = stripe.setSubscriptionMetadata.bind(stripe);
    let lateWrite: (() => Promise<void>) | undefined;
    const idempotent = new Map<string, string>();
    let firstWrite = true, replayAvailable = false;
    const idemWrite = async (subscription: string, metadata: Record<string, string>,
      options?: { idempotencyKey?: string; timeout?: number; maxNetworkRetries?: number }) => {
      const key = options?.idempotencyKey;
      expect(key).toBeString();
      const params = JSON.stringify({ subscription, metadata });
      const prior = idempotent.get(key!);
      if (prior && prior !== params) throw Error('idempotency_error');
      if (!prior) { await write(subscription, metadata, options); idempotent.set(key!, params); }
    };
    if (!cleanupFailure && !normalBind) stripe.setSubscriptionMetadata = async (subscription, metadata, options) => {
      if (firstWrite) {
        firstWrite = false;
        lateWrite = () => lateAfterApproval ? idemWrite(subscription, metadata, options) : write(subscription, metadata, options);
        throw Error('client timeout; remote write still pending');
      }
      if (!replayAvailable) throw Error('Stripe replay temporarily unavailable');
      await idemWrite(subscription, metadata, options);
    };
    if (cleanupFailure) {
      const clear = store.clearBindClaim!.bind(store);
      let firstClear = true;
      store.clearBindClaim = async (subscription, hash) => {
        if (firstClear) { firstClear = false; throw Error('claim cleanup failed'); }
        await clear(subscription, hash);
      };
    }
    const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const first = await bind(request());
    expect(first.status).toBe(cleanupFailure || normalBind ? 200 : 503);
    const saved = await store.bindClaim?.(id);
    if (normalBind) expect(saved).toBeNull();
    else expect(saved?.authority).toBe(team.f.pubkey);
    const oldToken = normalBind ? (await first.json() as { renewal_token: string }).renewal_token :
      openBindClaim(C.LH.fullEnv(signer.pem).COMPUTE_HANDOVER_TOKEN_KEY!, id, saved!);
    if (!lateAfterApproval && !cleanupFailure && !normalBind) {
      stripe.setSubscriptionMetadata = write;
      await lateWrite!();
    }
    const renew = makeRenew({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const renewal = () => new Request('https://site.test/api/license/renew', { method: 'POST',
      body: JSON.stringify({ lic_id: id, renewal_token: oldToken }) });
    expect((await renew(renewal())).status).toBe(lateAfterApproval ? 403 : 200);

    const event = (seq: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) =>
      C.signEvent(team.f, { v: C.PROTOCOL_VERSION, team: team.team, id: `${team.f.nodeId}:${seq}`,
        origin: team.f.nodeId, seq, ts: C.T0 + seq, author: { handle: 'alex', node: team.f.nodeId }, kind, body });
    const transfer = C.transfer(team.f, team.team, 4, next);
    const events = [event(2, 'team.member', { login: `direct:${next.nodeId}`, handle: 'next', role: 'owner' }),
      event(3, 'team.node', { node_id: next.nodeId, login: `direct:${next.nodeId}`,
        hostname: 'next', pubkey: next.pubkey, ip: '127.0.0.1' }), transfer.event];
    const roster = { genesis: team.genesis, authority_chain: [transfer], roster_events: events };
    const pending = await C.createAccount(w.d, team.team,
      C.proof(next, team.team, w.clock.now, team.genesis, [transfer], { roster_events: events }));
    expect(pending.handover_pending).toBeDefined();
    if (cleanupFailure) {
      expect((await bind(request())).status).toBe(403);
      expect((await store.bindClaim?.(id))?.hash).toBe(saved!.hash);
    }
    w.clock.now += HANDOVER_MS;
    const secret = ("0123456789abcdef01" + "23456789abcdef-test");
    const operator = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d,
      stripe: () => null, licenseStripe: () => stripe } as any);
    const approvalRequest = () => new Request('https://site.test/api/compute/handover', { method: 'POST',
      headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ team_id: team.team,
        action: 'complete', chain_id: teamAuthority(team.team, roster)!.chainId, proposed_key: next.pubkey }) });
    if (lateAfterApproval) {
      replayAvailable = true;
    } else if (!cleanupFailure && !normalBind) {
      stripe.setSubscriptionMetadata = async (subscription, metadata, options) => {
        if (metadata.walkie_renew_hash === '') throw Error('Stripe clear unavailable');
        await write(subscription, metadata, options);
      };
      expect((await operator(approvalRequest())).status).toBe(503);
      expect((await store.bindClaim?.(id))?.hash).toBe(saved!.hash);
      expect((await store.tx(t => t.enrollment(team.team)))?.key).toBe(team.f.pubkey);
      expect((await renew(renewal())).status).toBe(200);
      stripe.setSubscriptionMetadata = write;
    }
    const approved = await operator(approvalRequest());
    expect(approved.status).toBe(200);
    expect(await store.bindClaim?.(id)).toBeNull();
    if (saved) expect(stripe.subs.get(id)!.metadata.walkie_renew_hash).not.toBe(saved.hash);
    const retry = await bind(request());
    expect(retry.status).toBe(403);
    expect((await retry.json() as { renewal_token?: string }).renewal_token).toBeUndefined();
    const forbidden = await renew(renewal());
    expect(forbidden.status).toBe(403);
    const nextProof = { ...roster, expires_at,
      bind_signature: next.sign(C.bindMessage(team.team, id, expires_at)) };
    const rebound = await bind(new Request('https://site.test/api/license/bind', { method: 'POST',
      body: JSON.stringify({ code, team_id: team.team, proof: nextProof }) }));
    const reboundBody = await rebound.json() as { renewal_token?: string };
    expect(rebound.status).toBe(200);
    expect(typeof reboundBody.renewal_token).toBe('string');
    expect(stripe.subs.get(id)!.metadata.walkie_renew_hash).toBe(renewHash(reboundBody.renewal_token!));
    expect((await renew(new Request('https://site.test/api/license/renew', { method: 'POST',
      body: JSON.stringify({ lic_id: id, renewal_token: reboundBody.renewal_token }) }))).status).toBe(200);
    if (lateAfterApproval) {
      const reboundHash = stripe.subs.get(id)!.metadata.walkie_renew_hash;
      await lateWrite!();
      expect(stripe.subs.get(id)!.metadata.walkie_renew_hash).toBe(reboundHash);
      expect(stripe.subs.get(id)!.metadata.walkie_authority).toBe(next.pubkey);
      expect((await renew(renewal())).status).toBe(403);
    }
  } finally { globalThis.fetch = previousFetch; }
}

test('approved handover voids a timed-out old-authority claim and its Stripe renewal hash', async () => {
  await approvedHandoverVoidsClaim(new MemoryStore());
});

test('approval resolves a never-landed bind before a late original write', async () => {
  await approvedHandoverVoidsClaim(new MemoryStore(), true);
});

test('pending handover retains a cleanup-failed claim until approval', async () => {
  await approvedHandoverVoidsClaim(new MemoryStore(), false, true);
});

test('approved normal handover issues a new authority renewal token', async () => {
  await approvedHandoverVoidsClaim(new MemoryStore(), false, false, true);
});

const pgUrl = process.env.RENT21_TEST_DATABASE_URL;
(pgUrl ? test : test.skip)('real Postgres retains a claim outside the failed bind transaction', async () => {
  const url = new URL(pgUrl!);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('test database must be local');
  const store = PgStore.connect(pgUrl!);
  try {
    await store.migrate();
    await claimScenario(store, ("sub_" + 'RENT23_CLAIM_PG'));
    await claimScenario(store, ("sub_" + 'RENT23_CLAIM_PG_DISABLED'), false);
    await claimScenario(store, ("sub_" + 'RENT23_CLAIM_PG_SIGNED'), true, true);
    await authorityChangeRetainsClaims(store, 'PG');
    await approvedHandoverVoidsClaim(store);
  } finally { await store.end(); }
});

test('live bind without the handover key fails before Stripe or compute writes', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe(), store = new MemoryStore();
    const team = C.mkTeam('rent23-missing-key'), id = ("sub_" + 'RENT23_MISSING_KEY');
    stripe.subs.set(id, C.LH.subscription({ id }));
    const code = C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7,
      email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
      expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
    const env = { ...C.LH.fullEnv(signer.pem), COMPUTE_ENABLED: '1' };
    delete (env as { COMPUTE_HANDOVER_TOKEN_KEY?: string }).COMPUTE_HANDOVER_TOKEN_KEY;
    const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => store });
    const response = await bind(new Request('https://site.test/api/license/bind', {
      method: 'POST', body: JSON.stringify({ code, team_id: team.team }),
    }));
    expect([response.status, await response.json()]).toEqual([503, { error: 'handover_token_key_unavailable' }]);
    expect(stripe.calls.metadata).toHaveLength(0);
    expect(await store.bindClaim(id)).toBeNull();
  } finally { globalThis.fetch = previousFetch; }
});
