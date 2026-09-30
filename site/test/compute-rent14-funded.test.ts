import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { newToken, tokenHash } from '../api/_lib/compute/tokens.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { ACK_EXPIRY_MS, HANDOVER_MS, handoverKey } from '../api/_lib/compute/handover.ts';
import { makeCredit } from '../api/compute/credit.ts';
import { makeHandover } from '../api/compute/handover.ts';
import * as M from '../api/_lib/metadata.ts';

// A funded account can change authority only through an operator-approved hold. These fixtures cover the other
// writers of account tokens and enrollment: createAccount adoption for teams whose enrollment predates the
// stored authority chain (legacy trust-on-first-use), and a chain record that a license bind already advanced.
const ID = 'ca_0123456789abcdef';
async function legacyTeam(name: string, funded: boolean, chainRecord?: 'proposer') {
  const w = C.world(), t = C.mkTeam(name), squatter = C.generateKeys(), token = newToken();
  await w.store.tx(async tx => {
    await tx.setEnrollment({ team_id: t.team, key: squatter.pubkey, source: 'tofu', updated_at: C.T0 - 1 });
    await tx.insertAccount({ id: ID, team_id: t.team, token_hash: tokenHash(token), authority: squatter.pubkey,
      owner_key: squatter.pubkey, classification: 'customer', status: 'active', review: null, created_at: C.T0 });
    if (funded) await tx.addLedger({ account_id: ID, kind: 'purchase', live: true, amount_micros: 50_000_000,
      idem_key: `seed-${name}`, created_at: C.T0 });
    if (chainRecord) {
      const chain = teamAuthority(t.team, C.proof(t.f, t.team, C.T0, t.genesis))!;
      await tx.setControl(`enrollment-chain:${t.team}`, { depth: chain.depth, chainId: chain.chainId, chain: chain.chain, version: 1 });
    }
  });
  const enrollmentKey = async () => (await w.store.tx(tx => tx.enrollment(t.team)))?.key;
  return { w, t, squatter, token, enrollmentKey };
}

test('a funded legacy enrollment cannot be replaced by a roster proof without an operator pin', async () => {
  for (const chainRecord of [undefined, 'proposer' as const]) {
    const { w, t, squatter, token, enrollmentKey } = await legacyTeam(`rent14-legacy-${chainRecord ?? 'none'}`, true, chainRecord);
    expect(await C.err(C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis)))).toBe('team_ownership_required');
    expect(await enrollmentKey()).toBe(squatter.pubkey);
    expect((await accountForToken(w.d, token))?.id).toBe(ID);
    expect((await w.store.tx(tx => tx.lockAccount(ID)))?.owner_key).toBe(squatter.pubkey);
    expect(w.logs).toContain('alert_handover_operator_review');
  }
});

test('a pin opens a funded legacy hold and only a named operator approval moves its tokens', async () => {
  const { w, t, token, enrollmentKey } = await legacyTeam('rent14-legacy-pin', true);
  w.d.config = { ...w.d.config, team_authorities: { [t.team]: t.f.pubkey } };
  const moved = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const pending = await w.store.tx(tx => tx.control(handoverKey(t.team))) as { proposed_chain: { chainId: string }; encrypted_tokens?: string };
  expect(moved.handover_pending).toBeDefined();
  expect(pending).toBeTruthy();
  expect(pending.encrypted_tokens).toBeTruthy();
  expect(JSON.stringify(pending)).not.toContain(moved.token);
  const retried = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  expect(retried.token).toBe(moved.token);
  expect(await enrollmentKey()).not.toBe(t.f.pubkey);
  expect((await accountForToken(w.d, token))?.id).toBe(ID);
  expect(await accountForToken(w.d, moved.token)).toBeNull();
  w.clock.now += HANDOVER_MS;
  const originalTx = w.store.tx.bind(w.store);
  let inTransaction = false, searched = false;
  w.store.tx = async fn => originalTx(async tx => {
    inTransaction = true;
    try { return await fn(tx); } finally { inTransaction = false; }
  });
  const operator = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: ("0123456789abcdef01" + "23456789abcdef-test") },
    compute: () => w.d, stripe: () => null,
    licenseStripe: () => ({ listSubscriptionsByTeam: async () => {
      expect(inTransaction).toBe(false);
      searched = true;
      return [];
    } }) } as any);
  const response = await operator(new Request('https://site.test/api/compute/handover', { method: 'POST',
    headers: { authorization: ("Bearer 0123456789abcdef01" + "23456789abcdef-test") },
    body: JSON.stringify({ team_id: t.team, action: 'complete', chain_id: pending.proposed_chain.chainId, proposed_key: t.f.pubkey }) }));
  expect(response.status).toBe(200);
  expect(searched).toBe(true);
  expect(await enrollmentKey()).toBe(t.f.pubkey);
  expect(await accountForToken(w.d, token)).toBeNull();
  expect((await accountForToken(w.d, moved.token))?.id).toBe(ID);
});

test('a bind-created hold returns the installed tokens on retry and refuses a broken seal at approval', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const w = C.world(), t = C.mkTeam(("rent23-b" + "ind-hold")), next = C.generateKeys();
    const original = { account_id: ID, token: newToken() };
    await w.store.tx(async tx => {
      await tx.insertAccount({ id: ID, team_id: t.team, token_hash: tokenHash(original.token),
        authority: t.f.pubkey, owner_key: t.f.pubkey, status: 'active', review: null, created_at: C.T0 });
      await tx.addLedger({ account_id: ID, kind: 'purchase', amount_micros: 50_000_000,
        idem_key: ("rent23-b" + "ind-hold"), live: true, created_at: C.T0 });
    });
    const bind = bindFixture(w, t, ("sub_" + 'RENT23_HOLD'));
    const fork = move(t.f, next, t.team, 7);
    expect(await bind.submit(next, fork)).toBe(403);
    const pending = await w.store.tx(tx => tx.control(handoverKey(t.team))) as { proposed_chain: { chainId: string }; encrypted_tokens: string };
    expect(pending.encrypted_tokens).toBeTruthy();
    const proposed = C.proof(next, t.team, w.clock.now, t.genesis, [fork.transfer], { roster_events: fork.events });
    const retry = await C.createAccount(w.d, t.team, proposed);
    const second = await C.createAccount(w.d, t.team, proposed);
    expect(second.token).toBe(retry.token);
    expect(await accountForToken(w.d, retry.token)).toBeNull();
    w.clock.now += HANDOVER_MS;
    const operatorSecret = ("0123456789abcdef01" + "23456789abcdef-test");
    const operator = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: operatorSecret }, compute: () => w.d,
      stripe: () => null, licenseStripe: () => ({ listSubscriptionsByTeam: async () => [] }) } as any);
    const approve = () => operator(new Request('https://site.test/api/compute/handover', { method: 'POST',
      headers: { authorization: `Bearer ${operatorSecret}` }, body: JSON.stringify({ team_id: t.team,
        action: 'complete', chain_id: pending.proposed_chain.chainId, proposed_key: next.pubkey }) }));
    w.d.handoverTokenKey = 'a-different-32-byte-handover-key!!';
    expect((await approve()).status).toBe(503);
    expect(await accountForToken(w.d, original.token)).not.toBeNull();
    w.d.handoverTokenKey = 'rent-fixture-handover-key-32-bytes';
    expect((await approve()).status).toBe(200);
    expect((await accountForToken(w.d, retry.token))?.id).toBe(original.account_id);
    expect(await accountForToken(w.d, original.token)).toBeNull();
  } finally { globalThis.fetch = previousFetch; }
});

test('an unfunded legacy squat is still recovered automatically', async () => {
  const { w, t, token, enrollmentKey } = await legacyTeam('rent14-legacy-empty', false);
  const moved = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  expect(await enrollmentKey()).toBe(t.f.pubkey);
  expect(await accountForToken(w.d, token)).toBeNull();
  expect((await accountForToken(w.d, moved.token))?.id).toBe(ID);
});

const move = (from: ReturnType<typeof C.generateKeys>, to: ReturnType<typeof C.generateKeys>, team: string, seq: number) => {
  const event = (n: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(from, {
    v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${n}`, origin: from.nodeId, seq: n, ts: C.T0 + n,
    author: { handle: 'alex', node: from.nodeId }, kind, body });
  const transfer = C.transfer(from, team, seq + 2, to);
  return { transfer, events: [event(seq, 'team.member', { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' }),
    event(seq + 1, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' }),
    transfer.event] };
};
/** A license already bound to the team's founding authority, and a bind call that submits another authority's chain. */
function bindFixture(w: ReturnType<typeof C.world>, t: ReturnType<typeof C.mkTeam>, lic: string) {
  const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
  const orig = teamAuthority(t.team, { genesis: t.genesis })!;
  stripe.subs.set(lic, C.LH.subscription({ id: lic, metadata: { [M.TEAM_META]: t.team, [M.AUTHORITY_META]: t.f.pubkey,
    [M.AUTHORITY_CHAIN_META]: orig.chainId, [M.AUTHORITY_DEPTH_META]: '0', ...M.authorityPathMetadata(orig.chain) } }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7, email: 'fixture@example.test',
    interval: 'month', issued_at: C.LH.NOW, expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const bind = C.makeBind({ ...C.LH.deps(stripe, { ...C.LH.fullEnv(signer.pem), COMPUTE_ENABLED: '1' }), computeStore: () => w.store });
  return {
    authority: () => stripe.subs.get(lic)!.metadata[M.AUTHORITY_META],
    chain: async () => ((await w.store.tx(tx => tx.control(`enrollment-chain:${t.team}`))) as { chainId: string }).chainId,
    orig,
    submit: async (key: ReturnType<typeof C.generateKeys>, fork: ReturnType<typeof move>) => {
      const exp = C.LH.NOW + 240_000;
      return (await bind(new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: t.team,
        proof: { genesis: t.genesis, authority_chain: [fork.transfer], roster_events: fork.events, expires_at: exp,
          bind_signature: key.sign(C.bindMessage(t.team, lic, exp)) } }) }))).status;
    },
  };
}

test('license bind cannot advance the chain or Stripe authority while a hold is open, nor after it expires', async () => {
  const w = C.world(), t = C.mkTeam('rent14-bind-hold'), forger = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  const b = bindFixture(w, t, 'sub_R14HOLD'), fork = move(t.f, forger, t.team, 7);
  await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis, [fork.transfer], { roster_events: fork.events }));
  expect(await w.store.tx(tx => tx.control(handoverKey(t.team)))).not.toBeNull();
  expect(await b.submit(forger, fork)).toBe(403);
  w.clock.now += ACK_EXPIRY_MS;
  await C.tick(w.d);
  expect(await w.store.tx(tx => tx.control(handoverKey(t.team)))).toBeNull();
  expect(await b.submit(forger, fork)).toBe(403);
  expect(b.authority()).toBe(t.f.pubkey);
  expect(await b.chain()).toBe(b.orig.chainId);
  expect((await accountForToken(w.d, live.a.token))?.id).toBe(live.a.account_id);
});

test('license bind cannot advance the chain while a checkout is open on a $0 account', async () => {
  const w = C.world(), t = C.mkTeam('rent14-bind-checkout'), forger = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const credit = makeCredit({ env: { COMPUTE_ENABLED: '1' }, compute: () => w.d,
    stripe: () => ({ createCreditCheckout: async () => ({ url: 'https://checkout.test/x' }) }) } as any);
  expect((await credit(new Request('https://site.test/api/compute/credit', { method: 'POST',
    headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ block: 200 }) }))).status).toBe(200);
  const b = bindFixture(w, t, ("sub_" + 'R14CHECKOUT')), fork = move(t.f, forger, t.team, 7);
  expect(await b.submit(forger, fork)).toBe(403);
  expect(b.authority()).toBe(t.f.pubkey);
  expect(await b.chain()).toBe(b.orig.chainId);
});

test('control: the same bind succeeds for an unfunded team with nothing open', async () => {
  const w = C.world(), t = C.mkTeam('rent14-bind-control'), next = C.generateKeys();
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const b = bindFixture(w, t, ("sub_" + 'R14CONTROL')), fork = move(t.f, next, t.team, 7);
  expect(await b.submit(next, fork)).toBe(200);
  expect(b.authority()).toBe(next.pubkey);
});
