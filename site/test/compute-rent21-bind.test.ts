import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { renewHash } from '../api/_lib/metadata.ts';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import postgres from 'postgres';

const signer = C.LH.testKeypair();
const env = C.LH.fullEnv(signer.pem);
const first = C.mkTeam('rent21-first');
const second = C.mkTeam('rent21-second');
const lic = 'sub_RENT21';
const codeFor = (subscription: string) => C.signLicense({ v: 2, kind: 'activation', lic_id: subscription, plan: 'team', seats: 7,
  email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
  expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));

const request = (team: string, subscription = lic) => new Request('https://site.test/api/license/bind', {
  method: 'POST', body: JSON.stringify({ code: codeFor(subscription), team_id: team }),
});

test('signed bind refuses expired and far-future proof claims before Stripe mutation', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    for (const expires_at of [C.LH.NOW, C.LH.NOW + 300_001]) {
      const stripe = new C.LH.MockStripe();
      stripe.subs.set(lic, C.LH.subscription({ id: lic }));
      const proof = { genesis: first.genesis, authority_chain: [], roster_events: [], expires_at,
        bind_signature: first.f.sign(C.bindMessage(first.team, lic, expires_at)) };
      const bind = C.makeBind(C.LH.deps(stripe, env));
      const response = await bind(new Request('https://site.test/api/license/bind', {
        method: 'POST', body: JSON.stringify({ code: codeFor(lic), team_id: first.team, proof }),
      }));
      expect([response.status, await response.json()]).toEqual([403, { error: 'team_ownership_required' }]);
      expect(stripe.calls.metadata).toHaveLength(0);
    }
  } finally { globalThis.fetch = previous; }
});

test('no-store first claim writes only main metadata and rebind makes no write', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const stripe = new C.LH.MockStripe();
    stripe.subs.set(lic, C.LH.subscription({ id: lic }));
    const write = stripe.setSubscriptionMetadata.bind(stripe);
    let writes = 0;
    const idempotencyKeys: string[] = [];
    stripe.setSubscriptionMetadata = async (id, metadata, options) => {
      if (options?.idempotencyKey) idempotencyKeys.push(options.idempotencyKey);
      if (++writes === 2) await Bun.sleep(40);
      await write(id, metadata);
    };
    const bind = C.makeBind(C.LH.deps(stripe, env));
    const firstResponse = await bind(request(first.team));
    const secondResponse = await bind(request(second.team));
    const responses = [firstResponse, secondResponse];
    const bodies = await Promise.all(responses.map(r => r.json() as Promise<{ renewal_token?: string; error?: string }>));
    expect(responses.map(r => r.status)).toEqual([200, 409]);
    expect(bodies[1]).toEqual({ error: 'license_bound_elsewhere' });
    expect(typeof bodies[0]?.renewal_token).toBe('string');
    const bound = stripe.subs.get(lic)!.metadata;
    expect(bound.walkie_team).toBe(first.team);
    expect(bound.walkie_renew_hash).toBe(renewHash(bodies[0]!.renewal_token!));
    expect(bound.walkie_bind_nonce).toBeUndefined();
    expect(idempotencyKeys).toEqual([]);
    const rebind = await bind(request(first.team));
    expect([rebind.status, Object.keys(await rebind.json())]).toEqual([200, ['key']]);
    expect(stripe.subs.get(lic)!.metadata.walkie_team).toBe(first.team);
    const sameLic = 'sub_RENT21_LOCAL_SAME';
    stripe.subs.set(sameLic, C.LH.subscription({ id: sameLic }));
    const same = [await bind(request(first.team, sameLic)), await bind(request(first.team, sameLic))];
    expect(same.map(r => r.status)).toEqual([200, 200]);
    const sameBodies = await Promise.all(same.map(r => r.json() as Promise<{ renewal_token?: string }>));
    expect(sameBodies.filter(body => body.renewal_token)).toHaveLength(1);
    expect(stripe.subs.get(sameLic)!.metadata.walkie_renew_hash)
      .toBe(renewHash(sameBodies.find(body => body.renewal_token)!.renewal_token!));
  } finally { globalThis.fetch = previous; }
});

test('no-store Stripe write failure matches main and permits retry', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const stripe = new C.LH.MockStripe();
    stripe.subs.set(lic, C.LH.subscription({ id: lic }));
    const write = stripe.setSubscriptionMetadata.bind(stripe);
    let attempts = 0;
    stripe.setSubscriptionMetadata = async (id, metadata, options) => {
      expect(options).toBeUndefined();
      if (++attempts === 1) throw Error('injected 500');
      await write(id, metadata);
    };
    const bind = C.makeBind(C.LH.deps(stripe, env));
    const failed = await bind(request(first.team));
    expect([failed.status, await failed.json()]).toEqual([502, { error: 'stripe_unavailable' }]);
    const retry = await bind(request(first.team));
    expect(retry.status).toBe(200);
    expect(typeof (await retry.json() as { renewal_token?: string }).renewal_token).toBe('string');
    stripe.subs.get(lic)!.metadata.walkie_team = '';
    stripe.subs.get(lic)!.metadata.walkie_renew_hash = '';
    const reset = await bind(request(second.team));
    expect(reset.status).toBe(200);
    expect(attempts).toBe(3);
  } finally { globalThis.fetch = previous; }
});

const pgUrl = process.env.RENT21_TEST_DATABASE_URL;
(pgUrl ? test : test.skip)('real Postgres serializes two teams on one subscription', async () => {
  const url = new URL(pgUrl!);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('test database must be local');
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  const one = PgStore.connect(pgUrl!), two = PgStore.connect(pgUrl!);
  try {
    await one.migrate();
    const stripe = new C.LH.MockStripe();
    stripe.subs.set(lic, C.LH.subscription({ id: lic }));
    const write = stripe.setSubscriptionMetadata.bind(stripe);
    let writes = 0;
    const optionsSeen: { idempotencyKey?: string; timeout?: number; maxNetworkRetries?: number }[] = [];
    stripe.setSubscriptionMetadata = async (id, metadata, options) => {
      optionsSeen.push(options ?? {});
      if (++writes === 2) await Bun.sleep(40);
      await write(id, metadata);
    };
    const bindOne = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => one });
    const bindTwo = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => two });
    const responses = await Promise.all([bindOne(request(first.team)), bindTwo(request(second.team))]);
    const bodies = await Promise.all(responses.map(r => r.json() as Promise<{ renewal_token?: string; error?: string }>));
    expect(responses.map(r => r.status)).toEqual([200, 409]);
    expect(bodies[1]).toEqual({ error: 'license_bound_elsewhere' });
    expect(writes).toBe(1);
    expect(typeof optionsSeen[0]?.timeout).toBe('number');
    expect((optionsSeen[0]?.timeout ?? 0) <= 3_000).toBe(true);
    expect(optionsSeen[0]?.maxNetworkRetries).toBe(0);
    expect(optionsSeen[0]?.idempotencyKey).toMatch(/^walkie-db-bind-v2-[0-9a-f]{32}$/);
    expect(stripe.subs.get(lic)!.metadata.walkie_team).toBe(first.team);
    expect(stripe.subs.get(lic)!.metadata.walkie_renew_hash).toBe(renewHash(bodies[0]!.renewal_token!));
    const sameLic = 'sub_RENT21_SAME';
    stripe.subs.set(sameLic, C.LH.subscription({ id: sameLic }));
    const same = await Promise.all([bindOne(request(first.team, sameLic)), bindTwo(request(first.team, sameLic))]);
    expect(same.map(r => r.status)).toEqual([200, 200]);
    const sameBodies = await Promise.all(same.map(r => r.json() as Promise<{ renewal_token?: string }>));
    expect(sameBodies.filter(body => body.renewal_token)).toHaveLength(1);
    expect(stripe.subs.get(sameLic)!.metadata.walkie_renew_hash)
      .toBe(renewHash(sameBodies.find(body => body.renewal_token)!.renewal_token!));
    await one.tx(async t => {
      await t.insertAccount({ id: 'ca_0123456789abcdef', team_id: first.team, token_hash: 'a'.repeat(64),
        owner_key: first.f.pubkey, status: 'active', review: null, created_at: C.LH.NOW });
      await t.addLedger({ account_id: 'ca_0123456789abcdef', kind: 'purchase', amount_micros: 1_000_000,
        idem_key: 'rent21-funded', live: true, created_at: C.LH.NOW });
    });
    const funded = await one.tx(t => t.accountByTeam(first.team, first.f.pubkey));
    expect(funded?.first_funded_at).toBe(C.LH.NOW);
    expect((await bindTwo(request(second.team))).status).toBe(409);
    expect(stripe.subs.get(lic)!.metadata.walkie_team).toBe(first.team);
  } finally {
    await Promise.all([one.end(), two.end()]);
    globalThis.fetch = previous;
  }
});

(pgUrl ? test : test.skip)('real connection loss during Stripe latency preserves the token and process', async () => {
  const url = new URL(pgUrl!);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('test database must be local');
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  const store = PgStore.connect(pgUrl!);
  const admin = postgres(pgUrl!, { max: 1, prepare: false });
  try {
    await store.migrate();
    for (const withProof of [false, true]) {
      const stripe = new C.LH.MockStripe();
      const subscription = withProof ? 'sub_RENT21_DROP_PROOF' : 'sub_RENT21_DROP_LEGACY';
      stripe.subs.set(subscription, C.LH.subscription({ id: subscription }));
      const write = stripe.setSubscriptionMetadata.bind(stripe);
      let disconnect = true;
      stripe.setSubscriptionMetadata = async (id, metadata) => {
        if (disconnect) {
          disconnect = false;
          await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()`;
          await Bun.sleep(100);
        }
        await write(id, metadata);
      };
      const dropTeam = C.mkTeam(withProof ? 'rent21-drop-proof' : 'rent21-drop-legacy');
      const bindEnv = withProof ? { ...env, COMPUTE_ENABLED: '1' } : env;
      const bind = C.makeBind({ ...C.LH.deps(stripe, bindEnv), computeStore: () => store });
      const expires_at = C.LH.NOW + 240_000;
      const proof = withProof ? { genesis: dropTeam.genesis, authority_chain: [], roster_events: [], expires_at,
        bind_signature: dropTeam.f.sign(C.bindMessage(dropTeam.team, subscription, expires_at)) } : undefined;
      const response = await bind(new Request('https://site.test/api/license/bind', {
        method: 'POST', body: JSON.stringify({ code: codeFor(subscription), team_id: dropTeam.team, proof }),
      }));
      const body = await response.json() as { renewal_token?: string };
      expect(response.status).toBe(200);
      expect(typeof body.renewal_token).toBe('string');
      expect(stripe.subs.get(subscription)!.metadata.walkie_renew_hash).toBe(renewHash(body.renewal_token!));
      await Bun.sleep(150);
    }
  } finally {
    await Promise.all([store.end(), admin.end({ timeout: 3 })]);
    globalThis.fetch = previous;
  }
});
