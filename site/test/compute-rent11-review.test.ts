import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import * as HO from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/protocol/canonical.ts';
import { handoverNoticeText } from '../../src/daemon/compute/handover-notice.ts';

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
const revoke = (by: any, victimNodeId: string, team: string, seq: number) => C.signEvent(by, {
  v: C.PROTOCOL_VERSION, team, id: `${by.nodeId}:${seq}`, origin: by.nodeId, seq,
  ts: C.T0 + seq, author: { handle: 'alex', node: by.nodeId }, kind: 'team.member',
  body: { login: `direct:${victimNodeId}`, handle: 'next', role: 'removed' } });
const pend = (w: any, team: string) => w.store.tx((tx: any) => tx.control(`compute-handover:${team}`));
const objProof = (k: any, team: string, chain: string, exp: number, roster: any) =>
  ({ key: k.pubkey, chain_id: chain, expires_at: exp, roster, signature: k.sign(HO.objectionMessage(team, chain, exp)) });
const stProof = (k: any, team: string, exp: number, roster: any) =>
  ({ key: k.pubkey, expires_at: exp, roster, signature: k.sign(HO.statusMessage(team, exp)) });

test('V1: a proposed authority cannot erase a stored objection through status', async () => {
  const w = C.world(), t = C.mkTeam('v1'), bea = C.generateKeys(), forger = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  const beaGrant = step(t.f, bea, t.team, 2); // bea becomes co-owner at seq 2/3, transfer digest unused
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis, [],
    { roster_events: beaGrant.events.slice(0, 2) }));
  const fork = step(t.f, forger, t.team, 7); // F -> forger transfer at seq 7/8/9
  // forger's proof HONESTLY includes bea's pre-existing owner grant (realistic: forger's own daemon
  // relays real prior history) plus the fork transfer.
  const forgerRoster = { genesis: t.genesis, authority_chain: [fork.transfer],
    roster_events: [beaGrant.events[0], beaGrant.events[1], ...fork.events] };
  const hij = await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis,
    [fork.transfer], { roster_events: forgerRoster.roster_events }));
  const p0 = await pend(w, t.team);
  expect(p0.owners).toContain(bea.pubkey);
  const exp = w.clock.now + 240_000;
  // bea objects using the identical roster forger already submitted (she is a stored owner).
  await HO.objectHandover(w.d, t.team, objProof(bea, t.team, p0.proposed_chain.chainId, exp, forgerRoster));
  const p1 = await pend(w, t.team);
  expect(p1.objected_by).toBe(bea.pubkey);
  // forger appends a self-signed revoke-bea event (signed as X, the authority per the exhausted chain)
  // and submits it to the *status* endpoint using forger's own key (a call that should be read-only).
  const revokeBea = revoke(forger, bea.nodeId, t.team, 1);
  const extendedRoster = { genesis: t.genesis, authority_chain: [fork.transfer],
    roster_events: [...forgerRoster.roster_events, revokeBea] };
  const exp2 = w.clock.now + 240_000;
  const statusOutcome = await C.err(HO.statusHandover(w.d, t.team, stProof(forger, t.team, exp2, extendedRoster)));
  const p2 = await pend(w, t.team);
  expect(statusOutcome).toBe('handover_not_found');
  expect(p2.objected_by).toBe(bea.pubkey);
  expect(p2.owners).toContain(bea.pubkey);
  await HO.statusHandover(w.d, t.team, stProof(t.f, t.team, exp2, extendedRoster));
  expect((await pend(w, t.team)).objected_by).toBe(bea.pubkey);
  w.clock.now += 240_000; // fresh signature window
  const exp3 = w.clock.now + 240_000;
  expect(await C.err(HO.acknowledgeHandover(w.d, t.team, { key: t.f.pubkey, chain_id: p2.proposed_chain.chainId, expires_at: exp3,
    roster: forgerRoster, signature: t.f.sign(HO.ackMessage(t.team, p2.proposed_chain.chainId, exp3, '', '')) })))
    .toBe('invalid_handover_ack');
  w.clock.now += 86_400_000;
  await C.tick(w.d);
  const xTok = (await accountForToken(w.d, hij.token))?.id ?? null;
  const oldTok = (await accountForToken(w.d, live.a.token))?.id ?? null;
  expect(xTok).toBeNull();
  expect(oldTok).toBe(live.a.account_id);
  w.clock.now += HO.ACK_EXPIRY_MS;
  await C.tick(w.d);
  expect((await pend(w, t.team)).objected_by).toBe(bea.pubkey);
});

test('V2: the predecessor key on the proposal cannot acknowledge its own transfer', async () => {
  const w = C.world(), t = C.mkTeam('v2'), forger = C.generateKeys();
  await C.runningRental(w, t.f, t.team, t.genesis);
  const fork = step(t.f, forger, t.team, 7);
  const forgedRoster = { genesis: t.genesis, authority_chain: [fork.transfer], roster_events: fork.events };
  const hij = await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis,
    [fork.transfer], { roster_events: fork.events }));
  const p = await pend(w, t.team);
  expect(w.logs).toContain('alert_handover_no_independent_owner');
  const exp = w.clock.now + 240_000;
  const ackOutcome = await C.err(HO.acknowledgeHandover(w.d, t.team, { key: t.f.pubkey, chain_id: p.proposed_chain.chainId,
    expires_at: exp, roster: forgedRoster, signature: t.f.sign(HO.ackMessage(t.team, p.proposed_chain.chainId, exp, '', '')) }));
  const p2 = await pend(w, t.team);
  expect(ackOutcome).toBe('invalid_handover_ack');
  expect(p2.acknowledged_at).toBeUndefined();
  expect(p2.completes_at).toBeNull();
  w.clock.now += 86_400_000;
  await C.tick(w.d);
  const xTok = (await accountForToken(w.d, hij.token))?.id ?? null;
  expect(xTok).toBeNull();
});

test('an independent current owner acknowledges a signed notice received from a peer', async () => {
  const w = C.world(), t = C.mkTeam('rent11-peer'), bea = C.generateKeys(), next = C.generateKeys();
  const live = { a: await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis)) };
  const grant = step(t.f, bea, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis, [],
    { roster_events: grant.events.slice(0, 2) }));
  w.clock.now += HO.HANDOVER_MS + 1;
  await C.applyCreditEvent(w.d, C.purchase(live.a.account_id, 50));
  const move = step(t.f, next, t.team, 7);
  const roster = { genesis: t.genesis, authority_chain: [move.transfer],
    roster_events: [grant.events[0], grant.events[1], ...move.events] };
  const candidate = await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [move.transfer], { roster_events: roster.roster_events }));
  const p = await pend(w, t.team);
  const notice = handoverNoticeText({ v: 1, team: t.team, proposed_by: next.pubkey,
    old_chain: p.old_chain.chainId, proposed_chain: p.proposed_chain.chainId,
    accounts: p.accounts, proposed_at: p.proposed_at, completes_at: null, objected: false });
  const event = C.signEvent(next, { v: C.PROTOCOL_VERSION, team: t.team, id: `${next.nodeId}:1`,
    origin: next.nodeId, seq: 1, ts: C.T0 + 20, author: { handle: 'alex', node: next.nodeId },
    kind: 'msg.post', channel: 'general', body: { text: notice } });
  const hash = createHash('sha256').update(canonicalJson(event)).digest('hex');
  const expires = w.clock.now + 240_000;
  const wrongHash = '0'.repeat(64);
  expect(await C.err(HO.acknowledgeHandover(w.d, t.team, { key: bea.pubkey, chain_id: p.proposed_chain.chainId,
    expires_at: expires, roster, notice_event: event, notice_event_id: event.id, notice_event_hash: wrongHash,
    signature: bea.sign(HO.ackMessage(t.team, p.proposed_chain.chainId, expires, event.id, wrongHash)) })))
    .toBe('invalid_handover_ack');
  await HO.acknowledgeHandover(w.d, t.team, { key: bea.pubkey, chain_id: p.proposed_chain.chainId,
    expires_at: expires, roster, notice_event: event, notice_event_id: event.id, notice_event_hash: hash,
    signature: bea.sign(HO.ackMessage(t.team, p.proposed_chain.chainId, expires, event.id, hash)) });
  expect((await pend(w, t.team)).acknowledged_by).toBe(bea.pubkey);
  w.clock.now += HO.HANDOVER_MS;
  await C.tick(w.d);
  const adoptedLive = candidate.adopted_accounts?.find(a => a.account_id === live.a.account_id);
  expect(adoptedLive).toBeDefined();
  // The acknowledgement is advisory: a funded account moves only when the operator approves this proposal.
  expect(await accountForToken(w.d, adoptedLive!.token)).toBeNull();
  const secret = ("0123456789abcdef" + "0123456789abcdef");
  const approve = await makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d,
    stripe: () => null } as any)(new Request('https://site.test/api/compute/handover', { method: 'POST',
    headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ team_id: t.team, action: 'complete',
      chain_id: p.proposed_chain.chainId, proposed_key: next.pubkey }) }));
  expect(approve.status).toBe(200);
  expect((await accountForToken(w.d, adoptedLive!.token))?.id).toBe(live.a.account_id);
});
