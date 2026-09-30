import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import type { ComputeStore } from '../api/_lib/compute/store.ts';
import { renewHash } from '../api/_lib/metadata.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';

const signer = C.LH.testKeypair();
const env = C.LH.fullEnv(signer.pem);
const team = C.mkTeam('rent19-bind');
const lic = 'sub_RENT19';
const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7,
  email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
  expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
const request = (extra: Record<string, unknown> = {}) => new Request('https://site.test/api/license/bind', {
  method: 'POST', body: JSON.stringify({ code, team_id: team.team, ...extra }),
});
const stripe = () => { const s = new C.LH.MockStripe(); s.subs.set(lic, C.LH.subscription({ id: lic })); return s; };
const call = (s: C.LH.MockStripe, store?: ComputeStore, extra: Record<string, unknown> = {}) =>
  C.makeBind({ ...C.LH.deps(s, env), ...(store ? { computeStore: () => store } : {}) })(request(extra));
const withoutNetwork = async (run: () => Promise<void>): Promise<void> => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try { await run(); } finally { globalThis.fetch = previous; }
};

test('released client rebinds a proof-bound subscription in production without changing authority', () => withoutNetwork(async () => {
  const s = stripe();
  const expires_at = C.LH.NOW + 240_000;
  const proof = { genesis: team.genesis, authority_chain: [], roster_events: [], expires_at,
    bind_signature: team.f.sign(C.bindMessage(team.team, lic, expires_at)) };
  const first = await call(s, undefined, { proof });
  expect(first.status).toBe(200);
  const before = { ...s.subs.get(lic)!.metadata };
  const writes = s.calls.metadata.length;
  const second = await call(s);
  expect([second.status, Object.keys(await second.json())]).toEqual([200, ['key']]);
  expect(s.calls.metadata).toHaveLength(writes);
  expect(s.subs.get(lic)!.metadata).toEqual(before);
}));

test('proofless own-team rebind returns a key despite existing compute state without writing Stripe', () => withoutNetwork(async () => {
  const s = stripe(), w = C.world();
  const expires_at = C.LH.NOW + 240_000;
  const proof = { genesis: team.genesis, authority_chain: [], roster_events: [], expires_at,
    bind_signature: team.f.sign(C.bindMessage(team.team, lic, expires_at)) };
  expect((await call(s, undefined, { proof })).status).toBe(200);
  await w.store.tx(t => t.setControl(`enrollment-chain:${team.team}`, { depth: 0 }));
  const before = { ...s.subs.get(lic)!.metadata };
  const writes = s.calls.metadata.length;
  const response = await call(s, w.store);
  expect([response.status, Object.keys(await response.json())]).toEqual([200, ['key']]);
  expect(s.calls.metadata).toHaveLength(writes);
  expect(s.subs.get(lic)!.metadata).toEqual(before);
}));

test('version-zero emptiness is checked after the bind lock, before any Stripe write', async () => {
  const s = stripe(), w = C.world();
  let checks = 0;
  const store: ComputeStore = { schemaVersion: async () => 0, legacyEmpty: async () => true,
    tx: fn => w.store.tx(t => fn({ ...t, legacyEmpty: async () => { checks++; return false; } })) };
  const response = await call(s, store);
  expect([response.status, await response.json()]).toEqual([503, { error: 'compute_state_unavailable' }]);
  expect(checks).toBe(1);
  expect(s.calls.metadata).toHaveLength(0);
});

test('missing compute table inside the locked transaction fails closed', async () => {
  const s = stripe(), w = C.world();
  const store: ComputeStore = { schemaVersion: async () => 0, legacyEmpty: async () => true,
    tx: fn => w.store.tx(t => fn({ ...t, legacyEmpty: async () => {
      throw Object.assign(Error('table changed'), { code: '42P01' });
    } })) };
  const response = await call(s, store);
  expect([response.status, await response.json()]).toEqual([503, { error: 'compute_state_unavailable' }]);
  expect(s.calls.metadata).toHaveLength(0);
});

test('version-zero proofless binds never write compute state', async () => {
  const s = stripe(), w = C.world();
  const store: ComputeStore = { schemaVersion: async () => 0,
    bindClaim: id => w.store.bindClaim(id), saveBindClaim: (id, claim) => w.store.saveBindClaim(id, claim),
    clearBindClaim: (id, hash) => w.store.clearBindClaim(id, hash),
    tx: fn => w.store.tx(t => fn({ ...t,
    legacyEmpty: async () => true,
    lockControl: async () => { throw Error('compute write'); },
    setControl: async () => { throw Error('compute write'); },
  })) };
  expect((await call(s, store)).status).toBe(200);
});

test('two same-team first binds with a store return only one live renewal token', async () => {
  const s = stripe(), w = C.world();
  const read = s.getSubscription.bind(s), write = s.setSubscriptionMetadata.bind(s);
  s.getSubscription = async id => { const snapshot = await read(id); await Bun.sleep(15); return snapshot; };
  s.setSubscriptionMetadata = async (id, metadata) => { await write(id, metadata); await Bun.sleep(15); };
  const responses = await Promise.all([call(s, w.store), call(s, w.store)]);
  const bodies = await Promise.all(responses.map(response => response.json() as Promise<{ renewal_token?: string }>));
  const tokens = bodies.flatMap(body => body.renewal_token ? [body.renewal_token] : []);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  expect(tokens).toHaveLength(1);
  expect(renewHash(tokens[0]!)).toBe(s.subs.get(lic)!.metadata.walkie_renew_hash!);
});

test('two proven first binds re-read subscription after their store lock', async () => {
  const s = stripe(), w = C.world();
  const read = s.getSubscription.bind(s), write = s.setSubscriptionMetadata.bind(s);
  s.getSubscription = async id => { const snapshot = await read(id); await Bun.sleep(15); return snapshot; };
  s.setSubscriptionMetadata = async (id, metadata) => { await write(id, metadata); await Bun.sleep(15); };
  const expires_at = C.LH.NOW + 240_000;
  const proof = { genesis: team.genesis, authority_chain: [], roster_events: [], expires_at,
    bind_signature: team.f.sign(C.bindMessage(team.team, lic, expires_at)) };
  const responses = await Promise.all([call(s, w.store, { proof }), call(s, w.store, { proof })]);
  const bodies = await Promise.all(responses.map(response => response.json() as Promise<{ renewal_token?: string }>));
  const tokens = bodies.flatMap(body => body.renewal_token ? [body.renewal_token] : []);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  expect(tokens).toHaveLength(1);
  expect(renewHash(tokens[0]!)).toBe(s.subs.get(lic)!.metadata.walkie_renew_hash!);
});

test('legacy errors are handled with the main statuses and bodies', async () => {
  const cases: { name: string; change: (s: C.LH.MockStripe) => void; status: number; error: string }[] = [
    { name: 'write', change: s => { s.setSubscriptionMetadata = async () => { throw Error('write'); }; }, status: 502, error: 'stripe_unavailable' },
    { name: 'readback', change: s => { const read = s.getSubscription.bind(s); let n = 0;
      s.getSubscription = async id => { if (++n === 2) throw Error('readback'); return read(id); }; }, status: 502, error: 'stripe_unavailable' },
    { name: 'payload', change: s => { s.subs.set(lic, C.LH.subscription({ id: lic, items: { data: [] } })); }, status: 500, error: 'license_unavailable' },
  ];
  for (const testCase of cases) {
    const s = stripe();
    testCase.change(s);
    const response = await call(s);
    expect([response.status, await response.json()]).toEqual([testCase.status, { error: testCase.error }]);
  }
  const changingEnv = { ...env };
  let keyReads = 0;
  Object.defineProperty(changingEnv, 'WALKIE_LICENSE_SIGNING_KEY', {
    get: () => ++keyReads <= 2 ? signer.pem : 'invalid private key',
  });
  const issueResponse = await C.makeBind(C.LH.deps(stripe(), changingEnv))(request());
  expect([issueResponse.status, await issueResponse.json()]).toEqual([500, { error: 'license_unavailable' }]);
});

test('commit failure with no confirmable authority lock withholds the token and alerts', () => withoutNetwork(async () => {
  const s = stripe(), w = C.world();
  const store: ComputeStore = {
    bindClaim: id => w.store.bindClaim(id), saveBindClaim: (id, claim) => w.store.saveBindClaim(id, claim),
    clearBindClaim: (id, hash) => w.store.clearBindClaim(id, hash),
    tx: async fn => { await w.store.tx(fn); throw Error('commit failed'); } };
  const logs: string[] = [], old = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const response = await call(s, store);
    const body = await response.json() as { renewal_token?: string; error?: string };
    expect([response.status, body]).toEqual([503, { error: 'compute_state_unavailable' }]);
    expect(s.subs.get(lic)!.metadata.walkie_renew_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.some(line => line.includes('alert_compute_state_unavailable'))).toBe(true);
  } finally { process.stderr.write = old; }
}));

test('updateChain failure after Stripe readback returns the token and alerts', () => withoutNetwork(async () => {
  const s = stripe(), w = C.world();
  const store: ComputeStore = {
    bindClaim: id => w.store.bindClaim(id), saveBindClaim: (id, claim) => w.store.saveBindClaim(id, claim),
    clearBindClaim: (id, hash) => w.store.clearBindClaim(id, hash),
    tx: fn => w.store.tx(t => fn({ ...t,
    setControl: async (key, value) => {
      if (key === `enrollment-chain:${team.team}`) throw Error('injected chain write failure');
      await t.setControl(key, value);
    },
  })) };
  const expires_at = C.LH.NOW + 240_000;
  const proof = { genesis: team.genesis, authority_chain: [], roster_events: [], expires_at,
    bind_signature: team.f.sign(C.bindMessage(team.team, lic, expires_at)) };
  const logs: string[] = [], previous = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const bind = C.makeBind({ ...C.LH.deps(s, { ...env, COMPUTE_ENABLED: '1' }), computeStore: () => store });
    const response = await bind(request({ proof }));
    const body = await response.json() as { renewal_token?: string };
    expect(response.status).toBe(200);
    expect(typeof body.renewal_token).toBe('string');
    expect(renewHash(body.renewal_token!)).toBe(s.subs.get(lic)!.metadata.walkie_renew_hash!);
    expect(logs.some(line => line.includes('alert_compute_state_unavailable'))).toBe(true);
  } finally { process.stderr.write = previous; }
}));

test('non-Stripe transaction callback errors become 503', async () => {
  const s = stripe(), w = C.world();
  const store: ComputeStore = { tx: fn => w.store.tx(t => fn({ ...t,
    lockTeamBind: async () => { throw Error('db callback'); },
  })) };
  const logs: string[] = [], old = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const response = await call(s, store);
    expect([response.status, await response.json()]).toEqual([503, { error: 'compute_state_unavailable' }]);
    expect(logs.some(line => line.includes('alert_compute_state_unavailable'))).toBe(true);
  } finally { process.stderr.write = old; }
});

test('proofless oversized requests use 8 KiB cap and null proof binds', async () => {
  const s = stripe();
  const response = await call(s, undefined, { pad: 'x'.repeat(9_000) });
  expect([response.status, await response.json()]).toEqual([413, { error: 'too_large' }]);
  expect((await call(s, undefined, { proof: null })).status).toBe(200);
  const expires_at = C.LH.NOW + 240_000;
  const proof = { genesis: team.genesis, authority_chain: [], roster_events: [], expires_at,
    bind_signature: team.f.sign(C.bindMessage(team.team, lic, expires_at)) };
  const largeProof = await call(stripe(), undefined, { proof, pad: 'x'.repeat(9_000) });
  expect(largeProof.status).toBe(200);
});

test('large non-object JSON and falsey proof values follow the legacy body cap', () => withoutNetwork(async () => {
  const bind = C.makeBind(C.LH.deps(stripe(), env));
  const nonObject = await bind(new Request('https://site.test/api/license/bind', {
    method: 'POST', body: JSON.stringify('x'.repeat(9_000)),
  }));
  expect([nonObject.status, await nonObject.json()]).toEqual([413, { error: 'too_large' }]);
  for (const proof of [false, 0, '']) {
    const s = stripe();
    const large = await call(s, undefined, { proof, pad: 'x'.repeat(9_000) });
    expect([large.status, await large.json()]).toEqual([413, { error: 'too_large' }]);
    const ordinary = await call(s, undefined, { proof });
    expect(ordinary.status).toBe(200);
  }
}));

test('disabled compute on a migrated store uses only the per-team read lock', () => withoutNetwork(async () => {
  const s = stripe(), w = C.world(), locks: string[] = [];
  const store: ComputeStore = { schemaVersion: async () => 6,
    bindClaim: id => w.store.bindClaim(id), saveBindClaim: (id, claim) => w.store.saveBindClaim(id, claim),
    clearBindClaim: (id, hash) => w.store.clearBindClaim(id, hash),
    tx: fn => w.store.tx(t => fn({ ...t,
      lockLegacyBind: async () => { locks.push('migration'); },
      lockTeamBind: async () => { locks.push('team'); },
      lockControl: async () => { locks.push('write'); },
      setControl: async () => { throw Error('disabled compute write'); },
    })) };
  const response = await call(s, store);
  expect(response.status).toBe(200);
  expect(locks).toEqual(['team']);
}));

test('rejected proof logs without an alert row when compute is disabled', () => withoutNetwork(async () => {
  const s = stripe(), w = C.world(), next = C.generateKeys(), alertWrites: string[] = [];
  const member = C.signEvent(team.f, { v: C.PROTOCOL_VERSION, team: team.team,
    id: `${team.f.nodeId}:2`, origin: team.f.nodeId, seq: 2, ts: C.T0 + 2,
    author: { handle: 'alex', node: team.f.nodeId }, kind: 'team.member',
    body: { login: 'direct:next', handle: 'next', role: 'owner' } });
  const node = C.signEvent(team.f, { v: C.PROTOCOL_VERSION, team: team.team,
    id: `${team.f.nodeId}:3`, origin: team.f.nodeId, seq: 3, ts: C.T0 + 3,
    author: { handle: 'alex', node: team.f.nodeId }, kind: 'team.node',
    body: { node_id: next.nodeId, login: 'direct:next', hostname: 'next', pubkey: next.pubkey, ip: '127.0.0.1' } });
  const transfer = C.transfer(team.f, team.team, 4, next);
  const roster = { genesis: team.genesis, authority_chain: [transfer],
    roster_events: [member, node, transfer.event] };
  const root = teamAuthority(team.team, { genesis: team.genesis })!;
  const rejected = teamAuthority(team.team, roster)!;
  await w.store.tx(async t => {
    await t.setControl(`enrollment-chain:${team.team}`, root);
    await t.setControl(`compute-handover-rejected-digests:${team.team}`, [rejected.chainId]);
  });
  const store: ComputeStore = { tx: fn => w.store.tx(t => fn({ ...t,
    setControl: async (key, value) => { if (key.startsWith('alert:')) alertWrites.push(key); await t.setControl(key, value); },
  })) };
  const expires_at = C.LH.NOW + 240_000;
  const proof = { ...roster, expires_at, bind_signature: next.sign(C.bindMessage(team.team, lic, expires_at)) };
  const alertEnv = { ...env, COMPUTE_ALERT_TELEGRAM_TOKEN: 'test-token', COMPUTE_ALERT_TELEGRAM_CHAT: 'test-chat' };
  const bind = C.makeBind({ ...C.LH.deps(s, alertEnv), computeStore: () => store });
  const response = await bind(request({ proof }));
  expect(response.status).toBe(403);
  expect(alertWrites).toEqual([]);
  expect(s.calls.metadata).toHaveLength(0);
}));
