import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { newToken, tokenHash } from '../api/_lib/compute/tokens.ts';
import { handoverKey, HANDOVER_MS } from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';

function step(team: ReturnType<typeof C.mkTeam>, next: ReturnType<typeof C.generateKeys>) {
  const event = (seq: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(team.f, {
    v: C.PROTOCOL_VERSION, team: team.team, id: `${team.f.nodeId}:${seq}`, origin: team.f.nodeId, seq,
    ts: C.T0 + seq, author: { handle: 'alex', node: team.f.nodeId }, kind, body });
  const transfer = C.transfer(team.f, team.team, 4, next);
  return { transfer, events: [event(2, 'team.member', { login: `direct:${next.nodeId}`, handle: 'next', role: 'owner' }),
    event(3, 'team.node', { node_id: next.nodeId, login: `direct:${next.nodeId}`, hostname: 'next', pubkey: next.pubkey, ip: '127.0.0.1' }),
    transfer.event] };
}

async function legacy(w: ReturnType<typeof C.world>, team: ReturnType<typeof C.mkTeam>) {
  const token = newToken(), account = 'ca_0123456789abcdef';
  await w.store.tx(async tx => {
    await tx.insertAccount({ id: account, team_id: team.team, token_hash: tokenHash(token),
      authority: team.f.pubkey, owner_key: team.f.pubkey, classification: 'customer', status: 'active',
      review: null, created_at: C.T0 });
    await tx.addLedger({ account_id: account, kind: 'purchase', amount_micros: 50_000_000,
      idem_key: `rent16-missing-${team.team}`, created_at: C.T0 });
  });
  return { token, account };
}

test('P15-6 account creation holds missing enrollment for named operator approval', async () => {
  const w = C.world(), team = C.mkTeam('rent16-missing-account'), next = C.generateKeys();
  const old = await legacy(w, team), s = step(team, next);
  const moved = await C.createAccount(w.d, team.team, C.proof(next, team.team, w.clock.now,
    team.genesis, [s.transfer], { roster_events: s.events }));
  expect(moved.handover_pending).toBeDefined();
  expect((await w.store.tx(tx => tx.enrollment(team.team)))?.key).toBe(team.f.pubkey);
  expect((await w.store.tx(tx => tx.control(handoverKey(team.team))) as { proposed_key?: string })?.proposed_key).toBe(next.pubkey);
  expect(await C.err(C.createAccount(w.d, team.team,
    C.proof(team.f, team.team, w.clock.now, team.genesis)))).toBe('team_ownership_required');
  expect((await w.store.tx(tx => tx.accountByTokenHash(tokenHash(old.token))))?.id).toBe(old.account);
  const chain = teamAuthority(team.team, { genesis: team.genesis, authority_chain: [s.transfer], roster_events: s.events })!;
  const secret = ("0123456789abcdef01" + "23456789abcdef-test");
  const operator = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d,
    stripe: () => null } as any);
  w.clock.now += HANDOVER_MS;
  expect((await operator(new Request('https://site.test/api/compute/handover', { method: 'POST',
    headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ team_id: team.team,
      action: 'complete', chain_id: chain.chainId, proposed_key: next.pubkey }) }))).status).toBe(200);
  expect((await w.store.tx(tx => tx.enrollment(team.team)))?.key).toBe(next.pubkey);
});

test('P15-6 license bind holds funded missing enrollment without changing Stripe', async () => {
  const w = C.world(), team = C.mkTeam('rent16-missing-bind'), next = C.generateKeys();
  await legacy(w, team);
  const s = step(team, next), lic = ("sub_" + 'RENT16MISSING');
  const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
  stripe.subs.set(lic, C.LH.subscription({ id: lic, metadata: {} }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
    expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const bind = C.makeBind({ ...C.LH.deps(stripe, { ...C.LH.fullEnv(signer.pem), COMPUTE_ENABLED: '1' }),
    computeStore: () => w.store });
  const exp = C.LH.NOW + 240_000;
  const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST',
    body: JSON.stringify({ code, team_id: team.team, proof: { genesis: team.genesis,
      authority_chain: [s.transfer], roster_events: s.events, expires_at: exp,
      bind_signature: next.sign(C.bindMessage(team.team, lic, exp)) } }) }));
  expect(response.status).toBe(403);
  expect(stripe.subs.get(lic)!.metadata).toEqual({});
  expect((await w.store.tx(tx => tx.control(handoverKey(team.team))) as { proposed_key?: string })?.proposed_key).toBe(next.pubkey);
});
