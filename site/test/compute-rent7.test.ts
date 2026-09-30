import { test, expect } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { rosterProof } from '../../src/daemon/compute/team-proof.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { tokenHash } from '../api/_lib/compute/tokens.ts';
import { acknowledgeHandover, ackMessage } from '../api/_lib/compute/handover.ts';
import { createHmac } from 'node:crypto';
import { makeWatchdogHeartbeat } from '../api/compute/watchdog-heartbeat.ts';
import type { Core } from '../../src/daemon/core.ts';

const step = (from: ReturnType<typeof C.generateKeys>, to: ReturnType<typeof C.generateKeys>, team: string, seq = 2) => {
  const member = C.signEvent(from, { v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq,
    ts: C.T0 + seq, author: { handle: 'alex', node: from.nodeId }, kind: 'team.member',
    body: { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' } });
  const node = C.signEvent(from, { v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq + 1}`, origin: from.nodeId, seq: seq + 1,
    ts: C.T0 + seq + 1, author: { handle: 'alex', node: from.nodeId }, kind: 'team.node',
    body: { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' } });
  const transfer = C.transfer(from, team, seq + 2, to);
  return { transfer, events: [member, node, transfer.event] };
};

test('F5 same-id different-content transfer freezes enrollment without rotating the paid token', async () => {
  const w = C.world(), t = C.mkTeam('rent7-f5'), a = C.generateKeys();
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const good = step(t.f, a, t.team);
  const saved = await C.createAccount(w.d, t.team, C.proof(a, t.team, w.clock.now, t.genesis, [good.transfer], { roster_events: good.events }));
  const x = C.generateKeys(), y = C.generateKeys(), bad1 = step(t.f, x, t.team), bad2 = step(x, y, t.team);
  expect(bad1.transfer.event.id).toBe(good.transfer.event.id);
  expect(await C.err(C.createAccount(w.d, t.team, C.proof(y, t.team, w.clock.now, t.genesis,
    [bad1.transfer, bad2.transfer], { roster_events: [...bad1.events, ...bad2.events] })))).toBe('team_ownership_required');
  expect(await w.store.tx((tx: any) => tx.control(`enrollment-fork:${t.team}`) as Promise<unknown>)).toBe(w.clock.now);
  expect((await accountForToken(w.d, saved.token))?.id).toBe(saved.account_id);
});

test('F6 same-id different-content transfer cannot rebind a license', async () => {
  const t = C.mkTeam('rent7-f6'), a = C.generateKeys(), good = step(t.f, a, t.team), w = C.world();
  const signing = C.LH.testKeypair(), env = { ...C.LH.fullEnv(signing.pem), COMPUTE_ENABLED: '1' }, stripe = new C.LH.MockStripe();
  stripe.subs.set('sub_RENT7', C.LH.subscription({ id: 'sub_RENT7' }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: 'sub_RENT7', plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW, expires_at: C.LH.NOW + 30 * 86_400_000 },
    C.signingKeyFromPem(signing.pem));
  const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => w.store });
  const request = (key: ReturnType<typeof C.generateKeys>, steps: ReturnType<typeof step>[]) => {
    const expires_at = C.LH.NOW + 240_000;
    return new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: t.team,
      proof: { genesis: t.genesis, authority_chain: steps.map(s => s.transfer), roster_events: steps.flatMap(s => s.events),
        expires_at, bind_signature: key.sign(C.bindMessage(t.team, 'sub_RENT7', expires_at)) } }) });
  };
  expect((await bind(request(a, [good]))).status).toBe(200);
  const x = C.generateKeys(), y = C.generateKeys();
  expect((await bind(request(y, [step(t.f, x, t.team), step(x, y, t.team)]))).status).toBe(403);
  expect(stripe.subs.get('sub_RENT7')?.metadata.walkie_authority).toBe(a.pubkey);
  expect(await w.store.tx((tx: any) => tx.control(`enrollment-fork:${t.team}`))).toBeDefined();
});

test('K1 slow watchdog clock accepts a just renewed deadline', async () => {
  const siteNow = 1_790_000_000, invalid: number[] = [], deleted: number[] = [];
  await C.sweep({ list: async () => ({ next: false, droplets: [{ id: 7, tags: ['walkie-managed', `wk-paid-until-${siteNow + 3600}`],
    created_at: new Date((siteNow - 7200) * 1000).toISOString() }] }), delete: async id => { deleted.push(id); } },
  siteNow - 25, true, { invalidTag: id => invalid.push(id) });
  expect(invalid).toEqual([]);
  expect(deleted).toEqual([]);
});

test('K4 bind fails closed when its configured compute store is unavailable', async () => {
  const t = C.mkTeam('rent7-k4'), signing = C.LH.testKeypair(), env = { ...C.LH.fullEnv(signing.pem), COMPUTE_ENABLED: '0' };
  const stripe = new C.LH.MockStripe(); stripe.subs.set('sub_RENT7', C.LH.subscription({ id: 'sub_RENT7' }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: 'sub_RENT7', plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW, expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signing.pem));
  const expires_at = C.LH.NOW + 240_000;
  const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => { throw new Error('compute down'); } });
  const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: t.team,
    proof: { genesis: t.genesis, authority_chain: [], roster_events: [], expires_at,
      bind_signature: t.f.sign(C.bindMessage(t.team, 'sub_RENT7', expires_at)) } }) }));
  expect(response.status).toBe(502);
});

test('F8 a 1000-member, 10-transfer proof is compact and in applied chain order', () => {
  const t = C.mkTeam('rent7-large'), entries: any[] = [];
  let owner = t.f;
  for (let handoff = 0; handoff < 10; handoff++) {
    let seq = 2;
    for (let member = 0; member < 100; member++) {
      entries.push(C.signEvent(owner, { v: C.PROTOCOL_VERSION, team: t.team, id: `${owner.nodeId}:${seq}`, origin: owner.nodeId,
        seq, ts: C.T0 + seq, author: { handle: 'alex', node: owner.nodeId }, kind: 'team.member',
        body: { login: `direct:member-${handoff}-${member}`, handle: 'member', role: 'member' } }));
      seq++;
    }
    const next = C.generateKeys(), admission = step(owner, next, t.team, seq);
    entries.push(...admission.events);
    owner = next;
  }
  const core = { store: { teamCreate: () => t.genesis }, rosterEntries: () => entries } as unknown as Core;
  const exported = rosterProof(core);
  expect(entries).toHaveLength(1030);
  expect(exported.roster_events).toHaveLength(30);
  expect(JSON.stringify(exported).length).toBeLessThan(32 * 1024);
  expect(teamAuthority(t.team, exported)?.key).toBe(owner.pubkey);
});

test('a bind paused at Stripe cannot roll a successor enrollment chain back', async () => {
  const t = C.mkTeam('rent7-race'), a = C.generateKeys(), w = C.world();
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const signing = C.LH.testKeypair(), env = { ...C.LH.fullEnv(signing.pem), COMPUTE_ENABLED: '1' };
  const stripe = new C.LH.MockStripe(); stripe.subs.set('sub_RENT7', C.LH.subscription({ id: 'sub_RENT7' }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: 'sub_RENT7', plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW, expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signing.pem));
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const get = stripe.getSubscription.bind(stripe);
  stripe.getSubscription = async id => { entered(); await paused; return get(id); };
  const expires_at = C.LH.NOW + 240_000;
  const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => w.store });
  const request = new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: t.team,
    proof: { genesis: t.genesis, authority_chain: [], roster_events: [], expires_at,
      bind_signature: t.f.sign(C.bindMessage(t.team, 'sub_RENT7', expires_at)) } }) });
  const stale = bind(request);
  await waiting;
  const good = step(t.f, a, t.team);
  await C.createAccount(w.d, t.team, C.proof(a, t.team, w.clock.now, t.genesis, [good.transfer], { roster_events: good.events }));
  const latest = await w.store.tx((tx: any) => tx.control(`enrollment-chain:${t.team}`) as Promise<any>);
  expect(latest.version).toBe(2);
  release();
  expect((await stale).status).toBe(403);
  expect(await w.store.tx((tx: any) => tx.control(`enrollment-chain:${t.team}`) as Promise<unknown>)).toEqual(latest);
});

test('a transfer leaves every account token intact without an independent acknowledgment', async () => {
  const w = C.world(), t = C.mkTeam('rent7-accounts'), a = C.generateKeys();
  const first = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const secondToken = 'A'.repeat(43), secondId = 'ca_1234567890abcdef';
  await w.store.tx(async (tx: any) => {
    await tx.insertAccount({ id: secondId, team_id: t.team, owner_key: t.f.pubkey, authority: t.f.pubkey,
      token_hash: tokenHash(secondToken), classification: 'customer', status: 'active', review: null, created_at: w.clock.now + 1 });
    await tx.addLedger({ account_id: secondId, kind: 'purchase', amount_micros: 5_000_000, idem_key: 'rent7-credit', created_at: w.clock.now });
  });
  const good = step(t.f, a, t.team);
  const result = await C.createAccount(w.d, t.team, C.proof(a, t.team, w.clock.now, t.genesis, [good.transfer], { roster_events: good.events }));
  expect(result.adopted_accounts).toHaveLength(2);
  expect(result.handover_pending?.accounts).toEqual([secondId]);
  expect((await accountForToken(w.d, first.token))?.id).toBe(first.account_id);
  expect((await accountForToken(w.d, secondToken))?.id).toBe(secondId);
  const pending = await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`)) as any;
  const expires_at = w.clock.now + 240_000;
  expect(await C.err(acknowledgeHandover(w.d, t.team, { key: t.f.pubkey, chain_id: pending.proposed_chain.chainId, expires_at,
    roster: { genesis: t.genesis, authority_chain: [good.transfer], roster_events: good.events },
    signature: t.f.sign(ackMessage(t.team, pending.proposed_chain.chainId, expires_at, '', '')) }))).toBe('invalid_handover_ack');
  w.clock.now += 86_400_000;
  await C.tick(w.d);
  expect((await w.store.tx((tx: any) => tx.accountsByTeam(t.team) as Promise<any[]>)).map(x => [x.id, x.owner_key]).sort())
    .toEqual([[first.account_id, t.f.pubkey], [secondId, t.f.pubkey]].sort());
  expect((await w.store.tx((tx: any) => tx.accountsByTeam(t.team) as Promise<any[]>)).map(x => x.id).sort())
    .toEqual([first.account_id, secondId].sort());
  expect((await accountForToken(w.d, first.token))?.id).toBe(first.account_id);
  expect((await accountForToken(w.d, secondToken))?.id).toBe(secondId);
  expect(await accountForToken(w.d, result.adopted_accounts![1]!.token)).toBeNull();
  expect(await w.store.tx((tx: any) => tx.balance(secondId) as Promise<unknown>)).toBe(5_000_000);
});

test('K2 signed watchdog status alerts for invalid tags, failed deletes, persistence, and clock skew', async () => {
  const w = C.world(), secret = 'fixture-watchdog-secret';
  const handler = makeWatchdogHeartbeat({ env: { COMPUTE_WATCHDOG_HMAC_SECRET: secret, COMPUTE_ENABLED: '1' }, compute: () => w.d,
    stripe: () => null });
  const ts = Date.now() - 61_000;
  const send = (offset: number) => {
    const body = JSON.stringify({ ts: ts + offset, failed_delete_ids: [9], invalid_tag_ids: [7], deleted: [] });
    return handler(new Request('https://site.test/api/compute/watchdog-heartbeat', { method: 'POST',
      headers: { 'x-walkie-signature': createHmac('sha256', secret).update(body).digest('hex') }, body }));
  };
  expect((await send(0)).status).toBe(200);
  expect((await send(1)).status).toBe(200);
  expect((await send(2)).status).toBe(200);
  expect(w.logs).toContain('alert_watchdog_clock_skew');
  expect(w.logs).toContain('alert_watchdog_invalid_tag');
  expect(w.logs).toContain('alert_watchdog_delete_failed');
  expect(w.logs).toContain('alert_watchdog_delete_persistent');
});

test('sustained tag failure marks risk, then watchdog deletion caps billing at deletion time', async () => {
  const w = C.world(), t = C.mkTeam('rent7-tags'), live = await C.runningRental(w, t.f, t.team, t.genesis);
  await w.store.tx(async (tx: any) => {
    const r = await tx.rental(live.rid);
    await tx.updateRental(live.rid, { safety: { ...r.safety, tag_paid_until: w.clock.now + 10 * 60_000 } });
  });
  w.cloud.setPaidUntil = async () => { throw new Error('fixture tag failure'); };
  w.clock.now += 60_000;
  await C.beat(w, live); await C.tick(w.d);
  expect((await C.row(w, live.rid)).safety.alert).toBe('tag_expiry_risk');
  expect(w.logs).toContain('alert_tag_expiry_risk');
  const deletionAt = w.clock.now + 2 * 60_000;
  // FakeCloud uses nonnumeric IDs; model the provider's numeric ID for this signed report.
  await w.store.tx((tx: any) => tx.updateRental(live.rid, { instance_id: '7' }));
  await w.store.tx((tx: any) => tx.setControl('watchdog_deletions', { '7': deletionAt }));
  w.clock.now += 20 * 60_000;
  await C.tick(w.d);
  const ended = await C.row(w, live.rid);
  expect(ended.state).toBe('ended');
  expect(ended.ended_at).toBe(deletionAt);
  const charged = ended.charged_micros;
  w.clock.now += 60_000; await C.tick(w.d);
  expect((await C.row(w, live.rid)).charged_micros).toBe(charged);
});

test('signed watchdog deletion ends a running rental at the reported delete time', async () => {
  const w = C.world(), t = C.mkTeam('rent7-deleted'), live = await C.runningRental(w, t.f, t.team, t.genesis);
  const secret = 'fixture-watchdog-secret', ts = Date.now() - 1_000;
  await w.store.tx((tx: any) => tx.updateRental(live.rid, { instance_id: '7', started_at: ts - 120_000 }));
  const handler = makeWatchdogHeartbeat({ env: { COMPUTE_WATCHDOG_HMAC_SECRET: secret, COMPUTE_ENABLED: '1' }, compute: () => w.d, stripe: () => null });
  const body = JSON.stringify({ ts, failed_delete_ids: [], invalid_tag_ids: [], deleted: [{ id: 7, at: ts }] });
  const response = await handler(new Request('https://site.test/api/compute/watchdog-heartbeat', { method: 'POST',
    headers: { 'x-walkie-signature': createHmac('sha256', secret).update(body).digest('hex') }, body }));
  expect(response.status).toBe(200);
  expect((await C.row(w, live.rid)).state).toBe('ended');
  expect((await C.row(w, live.rid)).ended_at).toBe(ts);
});
