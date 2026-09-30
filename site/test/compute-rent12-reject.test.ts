import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { handoverKey, rejectedHandover, type PendingHandover } from '../api/_lib/compute/handover.ts';

const step = (from: ReturnType<typeof C.generateKeys>, to: ReturnType<typeof C.generateKeys>, team: string, seq: number) => {
  const member = C.signEvent(from, { v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq,
    ts: C.T0 + seq, author: { handle: 'alex', node: from.nodeId }, kind: 'team.member',
    body: { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' } });
  const node = C.signEvent(from, { v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq + 1}`, origin: from.nodeId, seq: seq + 1,
    ts: C.T0 + seq + 1, author: { handle: 'alex', node: from.nodeId }, kind: 'team.node',
    body: { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' } });
  const transfer = C.transfer(from, team, seq + 2, to);
  return { transfer, events: [member, node, transfer.event] };
};

test('operator rejection blocks fresh keys and chains containing the rejected transfer until cleared', async () => {
  const w = C.world(), t = C.mkTeam('rent12-reject'), firstKey = C.generateKeys(), fresh = C.generateKeys(), next = C.generateKeys();
  await C.runningRental(w, t.f, t.team, t.genesis);
  const first = step(t.f, firstKey, t.team, 7);
  const initial = await C.createAccount(w.d, t.team, C.proof(firstKey, t.team, w.clock.now, t.genesis,
    [first.transfer], { roster_events: first.events }));
  expect(initial.handover_pending).toBeDefined();
  const firstHold = await w.store.tx(tx => tx.control(handoverKey(t.team))) as PendingHandover;
  const handler = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: ("0123456789abcdef" + "0123456789abcdef") },
    compute: () => w.d, stripe: () => null } as any);
  const action = (name: string, secret = ("0123456789abcdef" + "0123456789abcdef"), chain_id?: string, proposed_key?: string) => handler(new Request('https://site.test/api/compute/handover', {
    method: 'POST', headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify({ team_id: t.team, action: name, chain_id, proposed_key }) }));
  expect((await action('reject', undefined, firstHold.proposed_chain.chainId, firstHold.proposed_key)).status).toBe(200);
  expect(await w.store.tx(tx => tx.control(handoverKey(t.team)))).toBeNull();

  const freshFork = step(t.f, fresh, t.team, 20);
  const freshProof = C.proof(fresh, t.team, w.clock.now, t.genesis,
    [freshFork.transfer], { roster_events: freshFork.events });
  expect(await C.err(C.createAccount(w.d, t.team, freshProof))).toBe('team_ownership_required');
  const second = step(firstKey, next, t.team, 1);
  const longerProof = C.proof(next, t.team, w.clock.now, t.genesis,
    [first.transfer, second.transfer], { roster_events: [...first.events, ...second.events] });
  expect(await C.err(C.createAccount(w.d, t.team, longerProof))).toBe('team_ownership_required');
  expect(await w.store.tx(tx => rejectedHandover(tx, t.team,
    { depth: 2, chainId: 'other-stored-tip' },
    { depth: 3, chainId: 'longer-tip', chain: [...firstHold.proposed_chain.chain!, 'other-stored-tip', 'longer-tip'] },
    next.pubkey))).toBe(false);
  expect(await w.store.tx(tx => tx.control(handoverKey(t.team)))).toBeNull();

  expect((await action('clear_rejection', 'wrong')).status).toBe(401);
  expect(await C.err(C.createAccount(w.d, t.team, freshProof))).toBe('team_ownership_required');
  const { teamAuthority } = await import('../api/_lib/compute/team-proof.ts');
  const approved = teamAuthority(t.team, { genesis: t.genesis, authority_chain: [freshFork.transfer], roster_events: freshFork.events })!;
  expect((await action('clear_rejection', ("0123456789abcdef" + "0123456789abcdef"), approved.chainId, fresh.pubkey)).status).toBe(200);
  expect(await C.err(C.createAccount(w.d, t.team, C.proof(firstKey, t.team, w.clock.now, t.genesis, [first.transfer], { roster_events: first.events })))).toBe('team_ownership_required');
  expect((await C.createAccount(w.d, t.team, freshProof)).handover_pending).toBeDefined();
});

test('selective approval works when the funded authority chain already has a transfer', async () => {
  const w = C.world(), t = C.mkTeam('rent13-depth'), incumbent = C.generateKeys(), bad = C.generateKeys(), good = C.generateKeys();
  const first = step(t.f, incumbent, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const current = await C.createAccount(w.d, t.team, C.proof(incumbent, t.team, w.clock.now, t.genesis,
    [first.transfer], { roster_events: first.events }));
  await C.applyCreditEvent(w.d, C.purchase(current.account_id, 50));
  const rejected = step(incumbent, bad, t.team, 1);
  await C.createAccount(w.d, t.team, C.proof(bad, t.team, w.clock.now, t.genesis,
    [first.transfer, rejected.transfer], { roster_events: [...first.events, ...rejected.events] }));
  const pending = await w.store.tx(tx => tx.control(handoverKey(t.team))) as PendingHandover;
  const handler = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: ("0123456789abcdef" + "0123456789abcdef") },
    compute: () => w.d, stripe: () => null } as any);
  const request = (action: string, chain_id?: string, proposed_key?: string) => handler(new Request('https://site.test/api/compute/handover', {
    method: 'POST', headers: { authorization: ("Bearer 0123456789abcdef" + "0123456789abcdef") },
    body: JSON.stringify({ team_id: t.team, action, chain_id, proposed_key }) }));
  expect((await request('reject', pending.proposed_chain.chainId, pending.proposed_key)).status).toBe(200);
  const approved = step(incumbent, good, t.team, 10);
  const roster_events = [...first.events, ...approved.events];
  const chain = [first.transfer, approved.transfer];
  const chosen = (await import('../api/_lib/compute/team-proof.ts')).teamAuthority(t.team,
    { genesis: t.genesis, authority_chain: chain, roster_events })!;
  expect((await request('clear_rejection', chosen.chainId, good.pubkey)).status).toBe(200);
  expect((await C.createAccount(w.d, t.team, C.proof(good, t.team, w.clock.now, t.genesis,
    chain, { roster_events }))).handover_pending).toBeDefined();
});
