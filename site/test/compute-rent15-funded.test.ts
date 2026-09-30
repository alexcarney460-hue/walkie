import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { handoverKey } from '../api/_lib/compute/handover.ts';

test('spent purchase remains funded and opens a hold before token rotation', async () => {
  const w = C.world(), team = C.mkTeam('rent15-spent'), next = C.generateKeys();
  const original = await C.createAccount(w.d, team.team, C.proof(team.f, team.team, w.clock.now, team.genesis));
  await C.applyCreditEvent(w.d, C.purchase(original.account_id, 50));
  await w.store.tx(async tx => {
    expect((await tx.lockAccount(original.account_id))?.first_funded_at).toBe(w.clock.now);
    await tx.setAccount(original.account_id, { first_funded_at: null });
    expect((await tx.lockAccount(original.account_id))?.first_funded_at).toBe(w.clock.now);
    await tx.addLedger({ account_id: original.account_id, kind: 'burn', amount_micros: -50_000_000,
      live: true, idem_key: 'rent15-spent', created_at: w.clock.now + 1 });
    expect(await tx.balance(original.account_id)).toBe(0);
  });
  const transfer = C.transfer(team.f, team.team, 4, next);
  const event = (seq: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(team.f, {
    v: C.PROTOCOL_VERSION, team: team.team, id: `${team.f.nodeId}:${seq}`, origin: team.f.nodeId, seq,
    ts: C.T0 + seq, author: { handle: 'alex', node: team.f.nodeId }, kind, body });
  const roster_events = [
    event(2, 'team.member', { login: `direct:${next.nodeId}`, handle: 'next', role: 'owner' }),
    event(3, 'team.node', { node_id: next.nodeId, login: `direct:${next.nodeId}`, hostname: 'next', pubkey: next.pubkey, ip: '127.0.0.1' }),
    transfer.event,
  ];
  const moved = await C.createAccount(w.d, team.team,
    C.proof(next, team.team, w.clock.now, team.genesis, [transfer], { roster_events }));
  expect(moved.handover_pending).toBeDefined();
  expect(await w.store.tx(tx => tx.control(handoverKey(team.team)))).toBeTruthy();
  expect((await accountForToken(w.d, original.token))?.id).toBe(original.account_id);
  expect(await accountForToken(w.d, moved.token)).toBeNull();
});
