import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import * as M from '../api/_lib/metadata.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import type { ComputeStore } from '../api/_lib/compute/store.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';

function fixture(options: { enabled?: boolean; enabledValue?: string; store?: ComputeStore | null;
  missingTables?: boolean; privateConfig?: boolean }) {
  const w = C.world(), team = C.mkTeam('rent16-bind-state'), next = C.generateKeys();
  const root = teamAuthority(team.team, { genesis: team.genesis })!;
  const lic = ("sub_" + 'RENT16STATE'), signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
  stripe.subs.set(lic, C.LH.subscription({ id: lic, metadata: {
    [M.TEAM_META]: team.team, [M.AUTHORITY_META]: team.f.pubkey,
    [M.AUTHORITY_CHAIN_META]: root.chainId, [M.AUTHORITY_DEPTH_META]: '0',
    ...M.authorityPathMetadata(root.chain),
  } }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
    expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const env = { ...C.LH.fullEnv(signer.pem),
    ...(options.enabled || options.enabledValue !== undefined
      ? { COMPUTE_ENABLED: options.enabledValue ?? '1' } : {}),
    ...(options.privateConfig ? { COMPUTE_PRIVATE_CONFIG: '{}' } : {}) };
  const missing = { tx: async () => { throw Object.assign(new Error('missing table'), { code: '42P01' }); } } as unknown as ComputeStore;
  const selected = options.missingTables ? missing : options.store;
  const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => selected ?? null });
  const transfer = C.transfer(team.f, team.team, 4, next);
  const event = (seq: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(team.f, {
    v: C.PROTOCOL_VERSION, team: team.team, id: `${team.f.nodeId}:${seq}`, origin: team.f.nodeId, seq,
    ts: C.T0 + seq, author: { handle: 'alex', node: team.f.nodeId }, kind, body });
  const roster_events = [event(2, 'team.member', { login: `direct:${next.nodeId}`, handle: 'next', role: 'owner' }),
    event(3, 'team.node', { node_id: next.nodeId, login: `direct:${next.nodeId}`, hostname: 'next', pubkey: next.pubkey, ip: '127.0.0.1' }),
    transfer.event];
  return { w, team, next, stripe, lic, root,
    nextChain: teamAuthority(team.team, { genesis: team.genesis, authority_chain: [transfer], roster_events })!,
    authority: () => stripe.subs.get(lic)!.metadata[M.AUTHORITY_META],
    submitLegacy: async () => {
      const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST',
        body: JSON.stringify({ code, team_id: team.team }) }));
      return { status: response.status, body: await response.json() as { key?: string; renewal_token?: string; error?: string } };
    },
    submit: async () => {
      const exp = C.LH.NOW + 240_000;
      const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({
        code, team_id: team.team, proof: { genesis: team.genesis, authority_chain: [transfer], roster_events,
          expires_at: exp, bind_signature: next.sign(C.bindMessage(team.team, lic, exp)) },
      }) }));
      return { status: response.status, body: await response.json() as { error?: string } };
    } };
}

test('pre.9 request keeps pre-RENT first and repeated bind semantics without compute state', async () => {
  for (const options of [{ privateConfig: true }, { store: C.world().store }]) {
    const f = fixture(options);
    f.stripe.subs.set(f.lic, C.LH.subscription({ id: f.lic }));
    const first = await f.submitLegacy();
    expect(first.status).toBe(200);
    expect(first.body.key).toBeString();
    expect(first.body.renewal_token).toBeString();
    expect(f.stripe.subs.get(f.lic)!.metadata[M.AUTHORITY_META]).toBeUndefined();
    const again = await f.submitLegacy();
    expect(again.status).toBe(200);
    expect(again.body.renewal_token).toBeUndefined();
  }
});

test('proof-less rebind preserves authority and rejects existing compute state', async () => {
  const f = fixture({ store: C.world().store });
  const priorAuthority = f.authority(), writes = f.stripe.calls.metadata.length;
  const rebound = await f.submitLegacy();
  expect(rebound.status).toBe(200);
  expect(rebound.body.key).toBeString();
  expect(rebound.body.renewal_token).toBeUndefined();
  expect(f.authority()).toBe(priorAuthority);
  expect(f.stripe.calls.metadata).toHaveLength(writes);
  const store = new MemoryStore();
  const g = fixture({ store });
  g.stripe.subs.set(g.lic, C.LH.subscription({ id: g.lic }));
  await store.tx(tx => tx.setEnrollment({ team_id: g.team.team, key: g.team.f.pubkey,
    source: 'roster', updated_at: C.T0 }));
  expect(await g.submitLegacy()).toEqual({ status: 409, body: { error: 'update_walkie_to_bind_license' } });
});

test('live compute requires a working store before license authority changes', async () => {
  for (const options of [{ enabled: true }, { enabled: true, missingTables: true }]) {
    const f = fixture(options);
    expect(await f.submit()).toEqual({ status: 503, body: { error: 'compute_state_unavailable' } });
    expect(f.authority()).toBe(f.team.f.pubkey);
  }
});

test('disabled compute with no store or a working empty store retains legacy bind behavior', async () => {
  for (const options of [{ store: C.world().store }, { privateConfig: true },
    { enabledValue: '0' }, { enabledValue: '' }]) {
    const f = fixture(options);
    expect((await f.submit()).status).toBe(200);
    expect(f.authority()).toBe(f.next.pubkey);
  }
});

test('missing compute tables without an empty-store proof fail closed', async () => {
  const f = fixture({ missingTables: true });
  expect((await f.submit()).status).toBe(503);
  expect(f.authority()).toBe(f.team.f.pubkey);
});

test('trimmed COMPUTE_ENABLED=1 requires a store for bind', async () => {
  const f = fixture({ enabledValue: '1\n' });
  expect((await f.submit()).status).toBe(503);
  expect(f.authority()).toBe(f.team.f.pubkey);
});

test('disabled compute checks an ever-funded configured store', async () => {
  const w = C.world();
  const f = fixture({ store: w.store });
  await w.store.tx(async tx => {
    await tx.insertAccount({ id: 'ca_0123456789abcdef', team_id: f.team.team, token_hash: 'a'.repeat(64),
      authority: f.team.f.pubkey, owner_key: f.team.f.pubkey, classification: 'customer', status: 'active',
      review: null, created_at: C.T0 });
    await tx.addLedger({ account_id: 'ca_0123456789abcdef', kind: 'purchase', amount_micros: 50_000_000,
      idem_key: 'rent16-state', created_at: C.T0 });
  });
  expect((await f.submit()).status).toBe(403);
  expect(f.authority()).toBe(f.team.f.pubkey);
});

test('disabled compute cannot consume a staged approved license transition', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const store = new MemoryStore(), f = fixture({ store });
    await store.tx(async tx => {
      await tx.insertAccount({ id: 'ca_0123456789abcdef', team_id: f.team.team, token_hash: 'a'.repeat(64),
        owner_key: f.team.f.pubkey, status: 'active', review: null, created_at: C.T0,
        first_funded_at: C.T0 });
      await tx.setEnrollment({ team_id: f.team.team, key: f.next.pubkey,
        source: 'roster', updated_at: C.T0 });
      await tx.setControl(`enrollment-chain:${f.team.team}`, f.nextChain);
      await tx.setControl(`compute-license-transition:${f.team.team}`, {
        chainId: f.nextChain.chainId, key: f.next.pubkey,
        subscriptions: { [f.lic]: { oldKey: f.team.f.pubkey, oldChainId: f.root.chainId, fulfilled: false } },
      });
    });
    expect((await f.submit()).status).toBe(403);
    expect(f.authority()).toBe(f.team.f.pubkey);
    expect(f.stripe.calls.metadata).toHaveLength(0);
  } finally { globalThis.fetch = previous; }
});
