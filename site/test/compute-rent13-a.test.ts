import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as C from './rent6-fixtures.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import * as HO from '../api/_lib/compute/handover.ts';
import { makeAccount } from '../api/compute/account.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { canonicalJson } from '../../src/protocol/canonical.ts';
import { handoverNoticeText } from '../../src/daemon/compute/handover-notice.ts';
// ROUND 11 PoC A: the authority key (stolen F) rewrites the STORED roster through a same-chain ("equal")
// createAccount, which never opens a hold, then proposes F -> forger. The "stored pre-hold roster" is
// attacker-chosen, so a decoy owner acknowledges and the real owners cannot object.

const ev = (from: any, team: string, seq: number, kind: Parameters<typeof C.signEvent>[1]['kind'], body: any) => C.signEvent(from, { v: C.PROTOCOL_VERSION, team,
  id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq, ts: C.T0 + seq, author: { handle: 'alex', node: from.nodeId }, kind, body });
const grant = (from: any, to: any, team: string, seq: number) => [
  ev(from, team, seq, 'team.member', { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' }),
  ev(from, team, seq + 1, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' }),
];
const pend = (w: any, team: string) => w.store.tx((tx: any) => tx.control(`compute-handover:${team}`));
const alerts = (w: any) => w.logs.filter((l: string) => l.startsWith('alert'));

async function setup(name: string) {
  const w = C.world(), t = C.mkTeam(name), bea = C.generateKeys(), decoy = C.generateKeys(), forger = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  // Legitimate history: F admits a real second owner bea and the site stores it (the builder's own pattern).
  const beaGrant = grant(t.f, bea, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis, [], { roster_events: beaGrant }));
  const storedBefore = await w.store.tx((tx: any) => tx.control(`enrollment-owners:${t.team}`)) as string[];
  return { w, t, bea, decoy, forger, live, beaGrant, storedBefore };
}

test('A1: same-chain roster poison cannot erase objectors or authorize a decoy acknowledgment', async () => {
  const { w, t, bea, decoy, forger, live, storedBefore } = await setup('poc-a1');
  const name = (k: string) => k === t.f.pubkey ? 'F' : k === bea.pubkey ? 'bea' : k === decoy.pubkey ? 'decoy' : k === forger.pubkey ? 'forger' : k.slice(0, 6);
  console.log('A1 stored owners before attack:', JSON.stringify(storedBefore.map(name)));
  // Step 1 (no hold, no notice, no alert): equal-relation proof, same authority chain, attacker-chosen roster.
  const poison = [...grant(t.f, decoy, t.team, 10),
    ev(t.f, t.team, 12, 'team.member', { login: 'direct:alex', handle: 'alex', role: 'member' })]; // demote F's own login
  const logsBefore = w.logs.length;
  const step1 = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis, [], { roster_events: poison }));
  const storedAfter = await w.store.tx((tx: any) => tx.control(`enrollment-owners:${t.team}`)) as string[];
  console.log('A1 step1 same-chain createAccount ok:', !!step1.account_id, '| handover_pending:', !!step1.handover_pending,
    '| stored owners now:', JSON.stringify(storedAfter.map(name)), '| new log lines:', JSON.stringify(w.logs.slice(logsBefore)));
  // Step 2: the proposal F -> forger.
  const fork = C.transfer(t.f, t.team, 22, forger);
  const roster = { genesis: t.genesis, authority_chain: [fork],
    roster_events: [...poison, ...grant(t.f, forger, t.team, 20), fork.event] };
  const hij = await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis, [fork], { roster_events: roster.roster_events }));
  const p0 = await pend(w, t.team);
  console.log('A1 hold opened:', !!hij.handover_pending, '| eligible_owners:', JSON.stringify(p0.eligible_owners.map(name)),
    '| alerts so far:', JSON.stringify(alerts(w)));
  const exp = w.clock.now + 240_000;
  // The real owners try to object (bea with the legit roster; F's legit daemon with the genesis roster).
  const beaRoster = { genesis: t.genesis, roster_events: grant(t.f, bea, t.team, 2) };
  const beaObj = await C.err(HO.objectHandover(w.d, t.team, { key: bea.pubkey, chain_id: p0.proposed_chain.chainId, expires_at: exp,
    roster: beaRoster, signature: bea.sign(HO.objectionMessage(t.team, p0.proposed_chain.chainId, exp)) }));
  const fObj = await C.err(HO.objectHandover(w.d, t.team, { key: t.f.pubkey, chain_id: p0.proposed_chain.chainId, expires_at: exp,
    roster: { genesis: t.genesis }, signature: t.f.sign(HO.objectionMessage(t.team, p0.proposed_chain.chainId, exp)) }));
  const beaStatus = await C.err(HO.statusHandover(w.d, t.team, { key: bea.pubkey, expires_at: exp, roster: beaRoster,
    signature: bea.sign(HO.statusMessage(t.team, exp)) }));
  console.log('A1 real owner bea objection:', beaObj, '| F objection:', fObj, '| bea status:', beaStatus);
  // The forger's node posts the notice; the decoy (attacker-held) acknowledges it.
  const noticeText = handoverNoticeText({ v: 1, team: t.team, proposed_by: forger.pubkey, old_chain: p0.old_chain.chainId,
    proposed_chain: p0.proposed_chain.chainId, accounts: [...p0.accounts], proposed_at: p0.proposed_at, completes_at: null, objected: false });
  const notice = C.signEvent(forger, { v: C.PROTOCOL_VERSION, team: t.team, id: `${forger.nodeId}:1`, origin: forger.nodeId, seq: 1,
    ts: w.clock.now + 20, author: { handle: 'alex', node: forger.nodeId }, kind: 'msg.post', channel: 'general', body: { text: noticeText } });
  const hash = createHash('sha256').update(canonicalJson(notice)).digest('hex');
  const ack = await C.err(HO.acknowledgeHandover(w.d, t.team, { key: decoy.pubkey, chain_id: p0.proposed_chain.chainId, expires_at: exp,
    roster, notice_event: notice, notice_event_id: notice.id, notice_event_hash: hash,
    signature: decoy.sign(HO.ackMessage(t.team, p0.proposed_chain.chainId, exp, notice.id, hash)) }));
  const p1 = await pend(w, t.team);
  expect(ack).toBe('invalid_handover_ack');
  expect(beaObj).toBe('ok');
  expect(alerts(w)).toContain('alert_enrollment_owners_changed');
  console.log('A1 decoy ack:', ack, '| acknowledged_by decoy:', p1.acknowledged_by === decoy.pubkey, '| completes_at set:', p1.completes_at !== null);
  w.clock.now += HO.HANDOVER_MS;
  await C.tick(w.d);
  const adopted = hij.adopted_accounts?.find((a: any) => a.account_id === live.a.account_id);
  const forgerOwns = adopted ? (await accountForToken(w.d, adopted.token))?.id === live.a.account_id : false;
  const oldTok = (await accountForToken(w.d, live.a.token))?.id ?? null;
  const bal = await w.store.tx((tx: any) => tx.balance(live.a.account_id));
  const acct = await w.store.tx((tx: any) => tx.lockAccount(live.a.account_id)) as { owner_key?: string } | null;
  console.log('A1 after 24h: forger token owns the funded account:', forgerOwns, '| legit token now:', oldTok,
    '| account owner_key == forger:', acct?.owner_key === forger.pubkey, '| balance micros:', bal, '| all alerts:', JSON.stringify(alerts(w)));
  expect(forgerOwns).toBe(false);
});

test('A2: adding a decoy on a funded team alerts and cannot make it an acknowledger', async () => {
  const { w, t, bea, decoy, forger, live, beaGrant } = await setup('poc-a2');
  const poison = [...beaGrant, ...grant(t.f, decoy, t.team, 10)];
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis, [], { roster_events: poison }));
  const fork = C.transfer(t.f, t.team, 22, forger);
  const roster = { genesis: t.genesis, authority_chain: [fork], roster_events: [...poison, ...grant(t.f, forger, t.team, 20), fork.event] };
  const hij = await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis, [fork], { roster_events: roster.roster_events }));
  const p0 = await pend(w, t.team);
  const exp = w.clock.now + 240_000;
  const noticeText = handoverNoticeText({ v: 1, team: t.team, proposed_by: forger.pubkey, old_chain: p0.old_chain.chainId,
    proposed_chain: p0.proposed_chain.chainId, accounts: [...p0.accounts], proposed_at: p0.proposed_at, completes_at: null, objected: false });
  const notice = C.signEvent(forger, { v: C.PROTOCOL_VERSION, team: t.team, id: `${forger.nodeId}:1`, origin: forger.nodeId, seq: 1,
    ts: w.clock.now + 20, author: { handle: 'alex', node: forger.nodeId }, kind: 'msg.post', channel: 'general', body: { text: noticeText } });
  const hash = createHash('sha256').update(canonicalJson(notice)).digest('hex');
  const ack = await C.err(HO.acknowledgeHandover(w.d, t.team, { key: decoy.pubkey, chain_id: p0.proposed_chain.chainId, expires_at: exp,
    roster, notice_event: notice, notice_event_id: notice.id, notice_event_hash: hash,
    signature: decoy.sign(HO.ackMessage(t.team, p0.proposed_chain.chainId, exp, notice.id, hash)) }));
  w.clock.now += HO.HANDOVER_MS;
  await C.tick(w.d);
  const adopted = hij.adopted_accounts?.find((a: any) => a.account_id === live.a.account_id);
  const forgerOwns = adopted ? (await accountForToken(w.d, adopted.token))?.id === live.a.account_id : false;
  expect(ack).toBe('invalid_handover_ack');
  expect(alerts(w)).toContain('alert_enrollment_owners_changed');
  console.log('A2 decoy ack:', ack, '| eligible includes bea (could object if she noticed):', p0.eligible_owners.includes(bea.pubkey),
    '| forger owns funded account after 24h:', forgerOwns, '| alerts:', JSON.stringify(alerts(w)));
  expect(forgerOwns).toBe(false);
});

test('A3: HTTP account and handover routes refuse the decoy acknowledgment', async () => {
  const { w, t, bea, decoy, forger, live } = await setup('poc-a3');
  const acct = makeAccount({ env: {}, compute: () => w.d, stripe: () => null } as any);
  const ho = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: ("0123456789abcdef" + "0123456789abcdef") }, compute: () => w.d, stripe: () => null } as any);
  const post = (h: any, url: string, body: any, headers: any = {}) => h(new Request(`https://site.test${url}`, { method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.9', ...headers }, body: JSON.stringify(body) }));
  const poison = [...grant(t.f, decoy, t.team, 10)];
  const r1 = await post(acct, '/api/compute/account', { team_id: t.team, proof: C.proof(t.f, t.team, w.clock.now, t.genesis, [], { roster_events: poison }) });
  const fork = C.transfer(t.f, t.team, 22, forger);
  const roster = { genesis: t.genesis, authority_chain: [fork], roster_events: [...poison, ...grant(t.f, forger, t.team, 20), fork.event] };
  const r2 = await post(acct, '/api/compute/account', { team_id: t.team, proof: C.proof(forger, t.team, w.clock.now, t.genesis, [fork], { roster_events: roster.roster_events }) },
    { 'x-walkie-handover-notice': '1' });
  const hij = await r2.json();
  const p0 = await pend(w, t.team);
  const exp = w.clock.now + 240_000;
  const noticeText = handoverNoticeText({ v: 1, team: t.team, proposed_by: forger.pubkey, old_chain: p0.old_chain.chainId,
    proposed_chain: p0.proposed_chain.chainId, accounts: [...p0.accounts], proposed_at: p0.proposed_at, completes_at: null, objected: false });
  const notice = C.signEvent(forger, { v: C.PROTOCOL_VERSION, team: t.team, id: `${forger.nodeId}:1`, origin: forger.nodeId, seq: 1,
    ts: w.clock.now + 20, author: { handle: 'alex', node: forger.nodeId }, kind: 'msg.post', channel: 'general', body: { text: noticeText } });
  const hash = createHash('sha256').update(canonicalJson(notice)).digest('hex');
  const r3 = await post(ho, '/api/compute/handover', { team_id: t.team, action: 'ack', proof: { key: decoy.pubkey, chain_id: p0.proposed_chain.chainId,
    expires_at: exp, roster, notice_event: notice, notice_event_id: notice.id, notice_event_hash: hash,
    signature: decoy.sign(HO.ackMessage(t.team, p0.proposed_chain.chainId, exp, notice.id, hash)) } });
  w.clock.now += HO.HANDOVER_MS;
  await C.tick(w.d);
  const adopted = hij.adopted_accounts?.find((a: any) => a.account_id === live.a.account_id);
  const forgerOwns = adopted ? (await accountForToken(w.d, adopted.token))?.id === live.a.account_id : false;
  expect(r3.status).toBe(403);
  console.log('A3 HTTP statuses: poison', r1.status, '| propose', r2.status, '| decoy ack', r3.status, JSON.stringify(await r3.json()),
    '| forger owns funded account after 24h:', forgerOwns, '| bea eligible:', p0.eligible_owners.includes(bea.pubkey));
  expect(forgerOwns).toBe(false);
});
