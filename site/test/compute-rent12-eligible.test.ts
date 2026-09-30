import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as C from './rent6-fixtures.ts';
import * as HO from '../api/_lib/compute/handover.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { canonicalJson } from '../../src/protocol/canonical.ts';
import { handoverNoticeText } from '../../src/daemon/compute/handover-notice.ts';

const grant = (from: ReturnType<typeof C.generateKeys>, to: ReturnType<typeof C.generateKeys>, team: string, seq: number) => [
  C.signEvent(from, { v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq,
    ts: C.T0 + seq, author: { handle: 'alex', node: from.nodeId }, kind: 'team.member',
    body: { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' } }),
  C.signEvent(from, { v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq + 1}`, origin: from.nodeId, seq: seq + 1,
    ts: C.T0 + seq + 1, author: { handle: 'alex', node: from.nodeId }, kind: 'team.node',
    body: { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' } }),
];

test('a proposal-bundle owner cannot acknowledge a handover or start its clock', async () => {
  const w = C.world(), t = C.mkTeam('rent12-decoy'), decoy = C.generateKeys(), forger = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  const decoyGrant = grant(t.f, decoy, t.team, 2);
  const forkGrant = grant(t.f, forger, t.team, 7);
  const fork = C.transfer(t.f, t.team, 9, forger);
  const roster = { genesis: t.genesis, authority_chain: [fork],
    roster_events: [...decoyGrant, ...forkGrant, fork.event] };
  const candidate = await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis,
    [fork], { roster_events: roster.roster_events }));
  const p = await w.store.tx(tx => tx.control(HO.handoverKey(t.team))) as HO.PendingHandover;
  expect(p.owners).toContain(decoy.pubkey);
  expect(p.eligible_owners).not.toContain(decoy.pubkey);
  expect(w.logs).toContain('alert_handover_no_independent_owner');
  const expires = w.clock.now + 240_000;
  expect(await C.err(HO.objectHandover(w.d, t.team, { key: decoy.pubkey,
    chain_id: p.proposed_chain.chainId, expires_at: expires, roster,
    signature: decoy.sign(HO.objectionMessage(t.team, p.proposed_chain.chainId, expires)) })))
    .toBe('invalid_handover_objection');

  const noticeText = handoverNoticeText({ v: 1, team: t.team, proposed_by: forger.pubkey,
    old_chain: p.old_chain.chainId, proposed_chain: p.proposed_chain.chainId,
    accounts: [...p.accounts], proposed_at: p.proposed_at, completes_at: null, objected: false });
  const notice = C.signEvent(forger, { v: C.PROTOCOL_VERSION, team: t.team, id: `${forger.nodeId}:1`,
    origin: forger.nodeId, seq: 1, ts: w.clock.now + 20, author: { handle: 'alex', node: forger.nodeId },
    kind: 'msg.post', channel: 'general', body: { text: noticeText } });
  const hash = createHash('sha256').update(canonicalJson(notice)).digest('hex');
  expect(await C.err(HO.acknowledgeHandover(w.d, t.team, { key: decoy.pubkey,
    chain_id: p.proposed_chain.chainId, expires_at: expires, roster, notice_event: notice,
    notice_event_id: notice.id, notice_event_hash: hash,
    signature: decoy.sign(HO.ackMessage(t.team, p.proposed_chain.chainId, expires, notice.id, hash)) })))
    .toBe('invalid_handover_ack');
  const after = await w.store.tx(tx => tx.control(HO.handoverKey(t.team))) as HO.PendingHandover;
  expect(after.acknowledged_at).toBeUndefined();
  expect(after.completes_at).toBeNull();
  w.clock.now += HO.HANDOVER_MS;
  await C.tick(w.d);
  expect(await accountForToken(w.d, candidate.token)).toBeNull();
  expect((await accountForToken(w.d, live.a.token))?.id).toBe(live.a.account_id);
});
