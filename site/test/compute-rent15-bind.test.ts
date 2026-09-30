import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import * as M from '../api/_lib/metadata.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { newToken, tokenHash } from '../api/_lib/compute/tokens.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { makeHandover } from '../api/compute/handover.ts';

const move = (team: ReturnType<typeof C.mkTeam>, next: ReturnType<typeof C.generateKeys>) => {
  const event = (seq: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(team.f, {
    v: C.PROTOCOL_VERSION, team: team.team, id: `${team.f.nodeId}:${seq}`, origin: team.f.nodeId, seq,
    ts: C.T0 + seq, author: { handle: 'alex', node: team.f.nodeId }, kind, body });
  const transfer = C.transfer(team.f, team.team, 4, next);
  return { transfer, events: [event(2, 'team.member', { login: `direct:${next.nodeId}`, handle: 'next', role: 'owner' }),
    event(3, 'team.node', { node_id: next.nodeId, login: `direct:${next.nodeId}`, hostname: 'next', pubkey: next.pubkey, ip: '127.0.0.1' }),
    transfer.event] };
};

function licenseFixture(w: ReturnType<typeof C.world>, team: ReturnType<typeof C.mkTeam>, enabled: boolean,
  boundTeam = team.team) {
  const lic = ("sub_" + 'RENT15BIND'), signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
  const root = teamAuthority(team.team, { genesis: team.genesis })!;
  stripe.subs.set(lic, C.LH.subscription({ id: lic, metadata: { [M.TEAM_META]: boundTeam,
    [M.AUTHORITY_META]: team.f.pubkey, [M.AUTHORITY_CHAIN_META]: root.chainId,
    [M.AUTHORITY_DEPTH_META]: '0', ...M.authorityPathMetadata(root.chain) } }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
    expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const env = { ...C.LH.fullEnv(signer.pem), ...(enabled ? { COMPUTE_ENABLED: '1' } : {}) };
  const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => w.store });
  return {
    authority: () => stripe.subs.get(lic)!.metadata[M.AUTHORITY_META],
    submit: async (next: ReturnType<typeof C.generateKeys>) => {
      const s = move(team, next), exp = C.LH.NOW + 240_000;
      return (await bind(new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({
        code, team_id: team.team, proof: { genesis: team.genesis, authority_chain: [s.transfer], roster_events: s.events,
          expires_at: exp, bind_signature: next.sign(C.bindMessage(team.team, lic, exp)) },
      }) }))).status;
    },
  };
}

test('bind refuses funded legacy authority without seeding a missing compute chain', async () => {
  const w = C.world(), team = C.mkTeam('rent15-bind-legacy'), next = C.generateKeys(), token = newToken();
  await w.store.tx(async tx => {
    await tx.setEnrollment({ team_id: team.team, key: team.f.pubkey, source: 'roster', updated_at: C.T0 });
    await tx.insertAccount({ id: 'ca_0123456789abcdef', team_id: team.team, token_hash: tokenHash(token),
      authority: team.f.pubkey, owner_key: team.f.pubkey, classification: 'customer', status: 'active', review: null, created_at: C.T0 });
    await tx.addLedger({ account_id: 'ca_0123456789abcdef', kind: 'purchase', live: true,
      amount_micros: 50_000_000, idem_key: ("rent15-le" + "gacy-paid"), created_at: C.T0 });
  });
  const license = licenseFixture(w, team, true);
  expect(await license.submit(next)).toBe(403);
  expect(license.authority()).toBe(team.f.pubkey);
  expect(await w.store.tx(tx => tx.control(`enrollment-chain:${team.team}`))).toBeUndefined();
});

test('bind refuses a funded account even when its legacy enrollment row is missing', async () => {
  const w = C.world(), team = C.mkTeam('rent15-bind-no-enrollment'), next = C.generateKeys();
  await w.store.tx(async tx => {
    await tx.insertAccount({ id: 'ca_0123456789abcdef', team_id: team.team, token_hash: tokenHash(newToken()),
      authority: team.f.pubkey, owner_key: team.f.pubkey, classification: 'customer', status: 'active', review: null, created_at: C.T0 });
    await tx.addLedger({ account_id: 'ca_0123456789abcdef', kind: 'purchase', live: true,
      amount_micros: 50_000_000, idem_key: ("rent15-no-en" + "rollment-paid"), created_at: C.T0 });
  });
  const license = licenseFixture(w, team, true);
  expect(await license.submit(next)).toBe(403);
  expect(license.authority()).toBe(team.f.pubkey);
  const root = teamAuthority(team.team, { genesis: team.genesis })!;
  expect((await w.store.tx(tx => tx.control(`enrollment-chain:${team.team}`)) as { chainId: string }).chainId).toBe(root.chainId);
  expect((await w.store.tx(tx => tx.enrollment(team.team)))?.key).toBe(team.f.pubkey);
  expect((await w.store.tx(tx => tx.control(`compute-handover:${team.team}`)) as { proposed_key: string }).proposed_key).toBe(next.pubkey);
});

test('resolved ancestor fork cannot freeze compute through account or bind, including a foreign license', async () => {
  const w = C.world(), team = C.mkTeam('rent15-fresh-fork'), kept = C.generateKeys(),
    first = C.generateKeys(), fresh = C.generateKeys();
  await C.createAccount(w.d, team.team, C.proof(team.f, team.team, w.clock.now, team.genesis));
  const keptStep = move(team, kept);
  const keptAccount = await C.createAccount(w.d, team.team, C.proof(kept, team.team, w.clock.now,
    team.genesis, [keptStep.transfer], { roster_events: keptStep.events }));
  await C.applyCreditEvent(w.d, C.purchase(keptAccount.account_id, 50));
  const firstStep = move(team, first);
  expect(await C.err(C.createAccount(w.d, team.team, C.proof(first, team.team, w.clock.now,
    team.genesis, [firstStep.transfer], { roster_events: firstStep.events })))).toBe('team_ownership_required');
  const keptChain = teamAuthority(team.team, { genesis: team.genesis, authority_chain: [keptStep.transfer],
    roster_events: keptStep.events })!;
  const secret = ("0123456789abcdef01" + "23456789abcdef-test");
  const operator = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d,
    stripe: () => null } as any);
  const resolved = await operator(new Request('https://site.test/api/compute/handover', { method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify({ team_id: team.team, action: 'resolve_fork', chain_id: keptChain.chainId }) }));
  expect(resolved.status).toBe(200);
  const freshStep = move(team, fresh);
  expect(await C.err(C.createAccount(w.d, team.team, C.proof(fresh, team.team, w.clock.now,
    team.genesis, [freshStep.transfer], { roster_events: freshStep.events })))).toBe('team_ownership_required');
  expect(await w.store.tx(tx => tx.control(`enrollment-fork:${team.team}`))).toBeNull();
  expect(await licenseFixture(w, team, true).submit(first)).toBe(403);
  expect(await w.store.tx(tx => tx.control(`enrollment-fork:${team.team}`))).toBeNull();
  expect(await licenseFixture(w, team, true, 'ffffffffffffffff').submit(fresh)).toBe(409);
  expect(await w.store.tx(tx => tx.control(`enrollment-fork:${team.team}`))).toBeNull();
  expect((await accountForToken(w.d, keptAccount.token))?.id).toBe(keptAccount.account_id);
});

test('bind checks configured compute store when compute is disabled without mutating it', async () => {
  const w = C.world(), team = C.mkTeam('rent15-bind-disabled'), next = C.generateKeys();
  await C.runningRental(w, team.f, team.team, team.genesis);
  const license = licenseFixture(w, team, false);
  const before = await w.store.tx(tx => tx.control(`enrollment-chain:${team.team}`));
  expect(await license.submit(next)).toBe(403);
  expect(license.authority()).toBe(team.f.pubkey);
  expect(await w.store.tx(tx => tx.control(`enrollment-chain:${team.team}`))).toEqual(before);
});
