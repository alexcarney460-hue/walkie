import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';

test('positive adjustment retains first-funded marker after balance reaches zero', async () => {
  const w = C.world(), team = C.mkTeam('rent16-adjustment'), next = C.generateKeys();
  const original = await C.createAccount(w.d, team.team, C.proof(team.f, team.team, w.clock.now, team.genesis));
  await w.store.tx(async tx => {
    await tx.addLedger({ account_id: original.account_id, kind: 'adjustment', amount_micros: 50_000_000,
      idem_key: 'rent16-adjustment-credit', created_at: w.clock.now });
    await tx.addLedger({ account_id: original.account_id, kind: 'burn', amount_micros: -50_000_000,
      idem_key: 'rent16-adjustment-spend', created_at: w.clock.now + 1 });
  });
  expect((await w.store.tx(tx => tx.lockAccount(original.account_id)))?.first_funded_at).toBe(w.clock.now);
  expect(await w.store.tx(tx => tx.balance(original.account_id))).toBe(0);
  const event = (seq: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(team.f, {
    v: C.PROTOCOL_VERSION, team: team.team, id: `${team.f.nodeId}:${seq}`, origin: team.f.nodeId, seq,
    ts: C.T0 + seq, author: { handle: 'alex', node: team.f.nodeId }, kind, body });
  const transfer = C.transfer(team.f, team.team, 4, next);
  const roster_events = [event(2, 'team.member', { login: `direct:${next.nodeId}`, handle: 'next', role: 'owner' }),
    event(3, 'team.node', { node_id: next.nodeId, login: `direct:${next.nodeId}`, hostname: 'next', pubkey: next.pubkey, ip: '127.0.0.1' }),
    transfer.event];
  const moved = await C.createAccount(w.d, team.team, C.proof(next, team.team, w.clock.now,
    team.genesis, [transfer], { roster_events }));
  expect(moved.handover_pending).toBeDefined();
});
