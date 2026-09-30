import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';

const step = (from: any, to: any, team: string, seq: number) => {
  const member = C.signEvent(from, { v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq,
    ts: C.T0 + seq, author: { handle: 'alex', node: from.nodeId }, kind: 'team.member',
    body: { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' } });
  const node = C.signEvent(from, { v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq + 1}`, origin: from.nodeId, seq: seq + 1,
    ts: C.T0 + seq + 1, author: { handle: 'alex', node: from.nodeId }, kind: 'team.node',
    body: { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' } });
  const transfer = C.transfer(from, team, seq + 2, to);
  return { transfer, events: [member, node, transfer.event] };
};

test('V3: operator reject blocks identical and equivalent resubmissions', async () => {
  const w = C.world(), t = C.mkTeam('v3'), forger = C.generateKeys();
  await C.runningRental(w, t.f, t.team, t.genesis);
  const fork = step(t.f, forger, t.team, 7);
  const forgedProof = C.proof(forger, t.team, w.clock.now, t.genesis, [fork.transfer], { roster_events: fork.events });
  await C.createAccount(w.d, t.team, forgedProof);
  const pending = await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`)) as any;
  const h = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: ("0123456789abcdef" + "0123456789abcdef") }, compute: () => w.d, stripe: () => null } as any);
  const submit = (chain_id?: string, proposed_key?: string) => h(new Request('https://site.test/api/compute/handover', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: ("Bearer 0123456789abcdef" + "0123456789abcdef") },
    body: JSON.stringify({ team_id: t.team, action: 'reject', chain_id, proposed_key }) }));
  expect((await submit()).status).toBe(400);
  expect((await submit(pending.proposed_chain.chainId, t.f.pubkey)).status).toBe(409);
  expect(await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`))).toBeTruthy();
  const rejectRes = await submit(pending.proposed_chain.chainId, forger.pubkey);
  const pendingAfterReject = await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`));
  expect(rejectRes.status).toBe(200);
  expect(pendingAfterReject).toBeNull();
  // The exact same forged proof, resubmitted immediately after the operator's reject:
  const retry = await C.err(C.createAccount(w.d, t.team, forgedProof));
  const pendingAfterRetry = await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`));
  expect(retry).toBe('team_ownership_required');
  expect(pendingAfterRetry).toBeNull();
  const equivalent = step(t.f, forger, t.team, 12);
  expect(await C.err(C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis,
    [equivalent.transfer], { roster_events: equivalent.events })))).toBe('team_ownership_required');
});

test('operator can explicitly approve a hold that has no independent owner', async () => {
  const w = C.world(), t = C.mkTeam('v3-approve'), next = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  const move = step(t.f, next, t.team, 7);
  const candidate = await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [move.transfer], { roster_events: move.events }));
  const p = await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`)) as any;
  expect(p.acknowledged_at).toBeUndefined();
  const handler = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: ("0123456789abcdef" + "0123456789abcdef") }, compute: () => w.d, stripe: () => null } as any);
  w.clock.now += 86_400_000;
  const response = await handler(new Request('https://site.test/api/compute/handover', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: ("Bearer 0123456789abcdef" + "0123456789abcdef") },
    body: JSON.stringify({ team_id: t.team, action: 'complete', chain_id: p.proposed_chain.chainId, proposed_key: next.pubkey }) }));
  expect(response.status).toBe(200);
  expect((await accountForToken(w.d, candidate.token))?.id).toBe(live.a.account_id);
});
