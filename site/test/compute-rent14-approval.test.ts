import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { ackMessage, acknowledgeHandover, handoverKey, HANDOVER_MS, objectionMessage, objectHandover } from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { handoverNoticeText } from '../../src/daemon/compute/handover-notice.ts';
import { canonicalJson } from '../../src/protocol/canonical.ts';
import { createHash } from 'node:crypto';

const secret = ("0123456789abcdef" + "0123456789abcdef");
const action = (w: ReturnType<typeof C.world>, team: string, name: string, chain_id?: string, proposed_key?: string) =>
  makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d, stripe: () => null } as any)(
    new Request('https://site.test/api/compute/handover', { method: 'POST', headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ team_id: team, action: name, chain_id, proposed_key }) }));
const step = (from: ReturnType<typeof C.generateKeys>, to: ReturnType<typeof C.generateKeys>, team: string) => {
  const event = (seq: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(from, { v: C.PROTOCOL_VERSION, team,
    id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq, ts: C.T0 + seq,
    author: { handle: 'alex', node: from.nodeId }, kind, body });
  const transfer = C.transfer(from, team, 4, to);
  return { transfer, events: [event(2, 'team.member', { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' }),
    event(3, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' }), transfer.event] };
};

test('funded hold needs named operator approval after 24 hours; objection needs explicit override', async () => {
  const w = C.world(), t = C.mkTeam('rent14-approve'), next = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  const move = step(t.f, next, t.team);
  const candidate = await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [move.transfer], { roster_events: move.events }));
  const p = await w.store.tx(tx => tx.control(handoverKey(t.team))) as any;
  expect(w.logs).toContain('alert_handover_operator_review');
  expect((await action(w, t.team, 'complete', p.proposed_chain.chainId, next.pubkey)).status).toBe(409);
  w.clock.now += HANDOVER_MS;
  await C.tick(w.d);
  expect((await accountForToken(w.d, live.a.token))?.id).toBe(live.a.account_id);
  expect(await accountForToken(w.d, candidate.token)).toBeNull();
  expect((await action(w, t.team, 'complete')).status).toBe(400);
  expect((await action(w, t.team, 'complete', '0'.repeat(64), next.pubkey)).status).toBe(409);
  const expires_at = w.clock.now + 240_000;
  await objectHandover(w.d, t.team, { key: t.f.pubkey, chain_id: p.proposed_chain.chainId, expires_at,
    roster: { genesis: t.genesis }, signature: t.f.sign(objectionMessage(t.team, p.proposed_chain.chainId, expires_at)) });
  expect((await action(w, t.team, 'complete', p.proposed_chain.chainId, next.pubkey)).status).toBe(409);
  expect((await action(w, t.team, 'override_objection', p.proposed_chain.chainId, next.pubkey)).status).toBe(200);
  expect(w.logs).toContain('alert_handover_objection_overridden');
  expect((await accountForToken(w.d, candidate.token))?.id).toBe(live.a.account_id);
});

test('pre-aged decoy acknowledgement is advisory after first payment', async () => {
  const w = C.world(), t = C.mkTeam('rent14-decoy'), decoy = C.generateKeys(), forger = C.generateKeys();
  const original = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const decoyGrant = step(t.f, decoy, t.team).events.slice(0, 2);
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis, [], { roster_events: decoyGrant }));
  w.clock.now += HANDOVER_MS + 1;
  await C.applyCreditEvent(w.d, C.purchase(original.account_id, 50));
  w.clock.now += HANDOVER_MS + 1;
  const event = (seq: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(t.f, { v: C.PROTOCOL_VERSION,
    team: t.team, id: `${t.f.nodeId}:${seq}`, origin: t.f.nodeId, seq, ts: C.T0 + seq,
    author: { handle: 'alex', node: t.f.nodeId }, kind, body });
  const transfer = C.transfer(t.f, t.team, 12, forger);
  const roster_events = [...decoyGrant,
    event(10, 'team.member', { login: `direct:${forger.nodeId}`, handle: 'forger', role: 'owner' }),
    event(11, 'team.node', { node_id: forger.nodeId, login: `direct:${forger.nodeId}`, hostname: 'forger', pubkey: forger.pubkey, ip: '127.0.0.1' }),
    transfer.event];
  const proposal = await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis,
    [transfer], { roster_events }));
  const p = await w.store.tx(tx => tx.control(handoverKey(t.team))) as any;
  expect(p.eligible_acknowledgers).toContain(decoy.pubkey);
  const noticeText = handoverNoticeText({ v: 1, team: t.team, proposed_by: forger.pubkey,
    old_chain: p.old_chain.chainId, proposed_chain: p.proposed_chain.chainId, accounts: [...p.accounts],
    proposed_at: p.proposed_at, completes_at: null, objected: false });
  const notice = C.signEvent(forger, { v: C.PROTOCOL_VERSION, team: t.team, id: `${forger.nodeId}:1`,
    origin: forger.nodeId, seq: 1, ts: w.clock.now + 20, author: { handle: 'alex', node: forger.nodeId },
    kind: 'msg.post', channel: 'general', body: { text: noticeText } });
  const hash = createHash('sha256').update(canonicalJson(notice)).digest('hex');
  const expires_at = w.clock.now + 240_000;
  await acknowledgeHandover(w.d, t.team, { key: decoy.pubkey, chain_id: p.proposed_chain.chainId,
    expires_at, roster: { genesis: t.genesis, authority_chain: [transfer], roster_events },
    notice_event: notice, notice_event_id: notice.id, notice_event_hash: hash,
    signature: decoy.sign(ackMessage(t.team, p.proposed_chain.chainId, expires_at, notice.id, hash)) });
  expect((await w.store.tx(tx => tx.control(handoverKey(t.team))) as any).acknowledged_by).toBe(decoy.pubkey);
  w.clock.now += HANDOVER_MS;
  await C.tick(w.d);
  expect((await accountForToken(w.d, original.token))?.id).toBe(original.account_id);
  expect(await accountForToken(w.d, proposal.token)).toBeNull();
});
