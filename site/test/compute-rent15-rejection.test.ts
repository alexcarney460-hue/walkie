import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { ACK_EXPIRY_MS, HANDOVER_MS, handoverKey } from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { makeCredit } from '../api/compute/credit.ts';

function step(from: ReturnType<typeof C.generateKeys>, to: ReturnType<typeof C.generateKeys>, team: string, seq: number) {
  const event = (n: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(from, {
    v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${n}`, origin: from.nodeId, seq: n,
    ts: C.T0 + n, author: { handle: 'alex', node: from.nodeId }, kind, body });
  const transfer = C.transfer(from, team, seq + 2, to);
  return { transfer, events: [event(seq, 'team.member', { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' }),
    event(seq + 1, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' }),
    transfer.event] };
}

test('expired proposal rejects its branch while clear permits two later rotations', async () => {
  const w = C.world(), team = C.mkTeam('rent15-rejection'), bad = C.generateKeys(),
    g = C.generateKeys(), h = C.generateKeys();
  const account = await C.createAccount(w.d, team.team, C.proof(team.f, team.team, w.clock.now, team.genesis));
  await C.applyCreditEvent(w.d, C.purchase(account.account_id, 50));
  const badStep = step(team.f, bad, team.team, 2);
  await C.createAccount(w.d, team.team, C.proof(bad, team.team, w.clock.now, team.genesis,
    [badStep.transfer], { roster_events: badStep.events }));
  w.clock.now += ACK_EXPIRY_MS;
  await C.tick(w.d);
  expect(await w.store.tx(tx => tx.control(handoverKey(team.team)))).toBeNull();
  const secret = ("0123456789abcdef01" + "23456789abcdef-test");
  const operator = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d,
    stripe: () => null } as any);
  const call = async (action: string, chainId: string, key: string) => (await operator(new Request('https://site.test/api/compute/handover', {
    method: 'POST', headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify({ team_id: team.team, action, chain_id: chainId, proposed_key: key }),
  }))).status;
  const gStep = step(team.f, g, team.team, 10);
  const gRoster = { genesis: team.genesis, authority_chain: [gStep.transfer], roster_events: gStep.events };
  const gChain = teamAuthority(team.team, gRoster)!;
  expect(await call('clear_rejection', gChain.chainId, g.pubkey)).toBe(200);
  const gAccount = await C.createAccount(w.d, team.team, C.proof(g, team.team, w.clock.now,
    team.genesis, [gStep.transfer], { roster_events: gStep.events }));
  expect(gAccount.handover_pending).toBeDefined();
  w.clock.now += HANDOVER_MS;
  expect(await call('complete', gChain.chainId, g.pubkey)).toBe(200);
  expect((await accountForToken(w.d, gAccount.token))?.id).toBe(account.account_id);
  const hStep = step(g, h, team.team, 2);
  const hAccount = await C.createAccount(w.d, team.team, C.proof(h, team.team, w.clock.now,
    team.genesis, [gStep.transfer, hStep.transfer], { roster_events: [...gStep.events, ...hStep.events] }));
  expect(hAccount.handover_pending).toBeDefined();
  expect(await w.store.tx(tx => tx.control(handoverKey(team.team)))).toBeTruthy();
});

test('tick reminds the operator daily while an acknowledged hold stays open', async () => {
  const w = C.world(), team = C.mkTeam('rent15-remind'), next = C.generateKeys();
  const account = await C.createAccount(w.d, team.team, C.proof(team.f, team.team, w.clock.now, team.genesis));
  await C.applyCreditEvent(w.d, C.purchase(account.account_id, 50));
  const s = step(team.f, next, team.team, 2);
  await C.createAccount(w.d, team.team, C.proof(next, team.team, w.clock.now, team.genesis,
    [s.transfer], { roster_events: s.events }));
  const key = handoverKey(team.team);
  await w.store.tx(async tx => {
    const p = await tx.control(key) as Record<string, unknown>;
    await tx.setControl(key, { ...p, acknowledged_at: w.clock.now, acknowledged_by: team.f.pubkey });
  });
  const alerts = () => w.logs.filter(log => log === 'alert_handover_operator_review').length;
  const initial = alerts();
  w.clock.now += HANDOVER_MS;
  await C.tick(w.d);
  expect(alerts()).toBe(initial + 1);
  expect(await w.store.tx(tx => tx.control(key))).toBeTruthy();
  await C.tick(w.d);
  expect(alerts()).toBe(initial + 1);
  w.clock.now += HANDOVER_MS;
  await C.tick(w.d);
  expect(alerts()).toBe(initial + 2);
});

test('expired checkout-only proposal does not block a later unfunded second rotation', async () => {
  const w = C.world(), team = C.mkTeam('rent15-checkout-rejection'), bad = C.generateKeys(),
    g = C.generateKeys(), h = C.generateKeys();
  const original = await C.createAccount(w.d, team.team, C.proof(team.f, team.team, w.clock.now, team.genesis));
  const credit = makeCredit({ env: { COMPUTE_ENABLED: '1' }, compute: () => w.d,
    stripe: () => ({ createCreditCheckout: async () => ({ url: 'https://checkout.test/x' }) }) } as any);
  expect((await credit(new Request('https://site.test/api/compute/credit', { method: 'POST',
    headers: { authorization: `Bearer ${original.token}` }, body: JSON.stringify({ block: 50 }) }))).status).toBe(200);
  const badStep = step(team.f, bad, team.team, 2);
  await C.createAccount(w.d, team.team, C.proof(bad, team.team, w.clock.now, team.genesis,
    [badStep.transfer], { roster_events: badStep.events }));
  w.clock.now += ACK_EXPIRY_MS;
  await C.tick(w.d);
  const gStep = step(team.f, g, team.team, 10);
  const gChain = teamAuthority(team.team, { genesis: team.genesis,
    authority_chain: [gStep.transfer], roster_events: gStep.events })!;
  const secret = ("0123456789abcdef01" + "23456789abcdef-test");
  const operator = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d,
    stripe: () => null } as any);
  expect((await operator(new Request('https://site.test/api/compute/handover', { method: 'POST',
    headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ team_id: team.team,
      action: 'clear_rejection', chain_id: gChain.chainId, proposed_key: g.pubkey }) }))).status).toBe(200);
  const gAccount = await C.createAccount(w.d, team.team, C.proof(g, team.team, w.clock.now,
    team.genesis, [gStep.transfer], { roster_events: gStep.events }));
  expect((await accountForToken(w.d, gAccount.token))?.id).toBe(original.account_id);
  const hStep = step(g, h, team.team, 2);
  const hAccount = await C.createAccount(w.d, team.team, C.proof(h, team.team, w.clock.now,
    team.genesis, [gStep.transfer, hStep.transfer], { roster_events: [...gStep.events, ...hStep.events] }));
  expect((await accountForToken(w.d, hAccount.token))?.id).toBe(original.account_id);
});
