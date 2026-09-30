import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { handoverKey, ACK_EXPIRY_MS } from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';

const secret = ("0123456789abcdef" + "0123456789abcdef");
const step = (from: ReturnType<typeof C.generateKeys>, to: ReturnType<typeof C.generateKeys>, team: string, seq: number) => {
  const event = (number: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(from, {
    v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${number}`, origin: from.nodeId, seq: number,
    ts: C.T0 + number, author: { handle: 'alex', node: from.nodeId }, kind, body });
  const transfer = C.transfer(from, team, seq + 2, to);
  return { transfer, events: [event(seq, 'team.member', { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' }),
    event(seq + 1, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' }), transfer.event] };
};

test('expired unacknowledged proposal cannot reopen, even from late approval, until operator allows new attempt', async () => {
  const w = C.world(), t = C.mkTeam('rent14-expiry'), next = C.generateKeys();
  await C.runningRental(w, t.f, t.team, t.genesis);
  const first = step(t.f, next, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [first.transfer], { roster_events: first.events }));
  const p = await w.store.tx(tx => tx.control(handoverKey(t.team))) as any;
  const action = (name: string, chain_id?: string, proposed_key?: string) => makeHandover({
    env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d, stripe: () => null } as any)(
      new Request('https://site.test/api/compute/handover', { method: 'POST', headers: { authorization: `Bearer ${secret}` },
        body: JSON.stringify({ team_id: t.team, action: name, chain_id, proposed_key }) }));
  w.clock.now += ACK_EXPIRY_MS;
  expect((await action('complete', p.proposed_chain.chainId, next.pubkey)).status).toBe(409);
  expect(await w.store.tx(tx => tx.control(handoverKey(t.team)))).toBeNull();
  expect(w.logs).toContain('alert_handover_expired');
  const recorded = await w.store.tx(tx => tx.control(`compute-handover-rejected:${t.team}`)) as string[];
  expect(recorded).toContain(p.proposed_chain.chainId);
  expect(recorded).toContain(`${p.old_chain.chainId}:${next.pubkey}`);
  expect(await C.err(C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [first.transfer], { roster_events: first.events })))).toBe('team_ownership_required');
  const second = step(t.f, next, t.team, 10);
  expect(await C.err(C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [second.transfer], { roster_events: second.events })))).toBe('team_ownership_required');
  const { teamAuthority } = await import('../api/_lib/compute/team-proof.ts');
  const alternate = teamAuthority(t.team, { genesis: t.genesis, authority_chain: [second.transfer], roster_events: second.events })!;
  expect((await action('clear_rejection', alternate.chainId, next.pubkey)).status).toBe(200);
  expect((await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [second.transfer], { roster_events: second.events }))).handover_pending).toBeDefined();
});

test('the minute tick expires an unacknowledged proposal once, and a resubmitted proof stays refused', async () => {
  const w = C.world(), t = C.mkTeam('rent14-expiry-tick'), next = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  const move = step(t.f, next, t.team, 2);
  const proof = () => C.proof(next, t.team, w.clock.now, t.genesis, [move.transfer], { roster_events: move.events });
  await C.createAccount(w.d, t.team, proof());
  w.clock.now += ACK_EXPIRY_MS - 1;
  await C.tick(w.d);
  expect(await w.store.tx(tx => tx.control(handoverKey(t.team)))).not.toBeNull();
  w.clock.now += 1;
  await C.tick(w.d);
  await C.tick(w.d);
  expect(await w.store.tx(tx => tx.control(handoverKey(t.team)))).toBeNull();
  expect(w.logs.filter(event => event === 'alert_handover_expired')).toHaveLength(1);
  for (let attempt = 0; attempt < 3; attempt++)
    expect(await C.err(C.createAccount(w.d, t.team, proof()))).toBe('team_ownership_required');
  expect(await w.store.tx(tx => tx.control(handoverKey(t.team)))).toBeNull();
  expect((await accountForToken(w.d, live.a.token))?.id).toBe(live.a.account_id);
});

test('operator lifts only the named expired proposal for one new review', async () => {
  const w = C.world(), t = C.mkTeam('rent17-lift-expired'), next = C.generateKeys();
  await C.runningRental(w, t.f, t.team, t.genesis);
  const move = step(t.f, next, t.team, 2);
  const proof = () => C.proof(next, t.team, w.clock.now, t.genesis,
    [move.transfer], { roster_events: move.events });
  await C.createAccount(w.d, t.team, proof());
  const pending = await w.store.tx(tx => tx.control(handoverKey(t.team))) as any;
  w.clock.now += ACK_EXPIRY_MS;
  await C.tick(w.d);
  const handler = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret },
    compute: () => w.d, stripe: () => null } as any);
  const action = (chain: string, key: string) => handler(new Request('https://site.test/api/compute/handover', {
    method: 'POST', headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify({ team_id: t.team, action: 'lift_expired', chain_id: chain, proposed_key: key }) }));
  expect((await action('0'.repeat(64), next.pubkey)).status).toBe(409);
  expect((await action(pending.proposed_chain.chainId, next.pubkey)).status).toBe(200);
  expect(w.logs).toContain('alert_handover_expired_lift');
  expect((await C.createAccount(w.d, t.team, proof())).handover_pending).toBeDefined();
  expect((await action(pending.proposed_chain.chainId, next.pubkey)).status).toBe(409);
  const resumed = await w.store.tx(tx => tx.control(handoverKey(t.team))) as any;
  expect(resumed.proposed_chain.chainId).toBe(pending.proposed_chain.chainId);
});

test('operator cannot lift a rejected proposal', async () => {
  const w = C.world(), t = C.mkTeam('rent17-rejected-not-expired'), next = C.generateKeys();
  await C.runningRental(w, t.f, t.team, t.genesis);
  const move = step(t.f, next, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [move.transfer], { roster_events: move.events }));
  const pending = await w.store.tx(tx => tx.control(handoverKey(t.team))) as any;
  const handler = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret },
    compute: () => w.d, stripe: () => null } as any);
  const action = (name: string) => handler(new Request('https://site.test/api/compute/handover', {
    method: 'POST', headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify({ team_id: t.team, action: name,
      chain_id: pending.proposed_chain.chainId, proposed_key: next.pubkey }) }));
  expect((await action('reject')).status).toBe(200);
  expect(await w.store.tx(tx => tx.control(`compute-handover-explicit-rejected-digests:${t.team}`)))
    .toContain(pending.proposed_chain.chainId);
  expect((await action('lift_expired')).status).toBe(409);
});
