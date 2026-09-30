import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { acknowledgeHandover, ackMessage, objectHandover, objectionMessage, statusMessage } from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { makeState } from '../api/compute/state.ts';
import { makeAccount } from '../api/compute/account.ts';
import { verifyHandoverNotice } from '../../src/daemon/compute/handover-notice.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { TEAM_META, AUTHORITY_META, AUTHORITY_CHAIN_META, AUTHORITY_DEPTH_META } from '../api/_lib/metadata.ts';

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

test('F7b an unseen predecessor fork cannot take over paid accounts', async () => {
  const w = C.world(), t = C.mkTeam('rent8-f7b'), successor = C.generateKeys(), forger = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  const legitimate = step(t.f, successor, t.team, 2);
  const fork = step(t.f, forger, t.team, 7);
  expect(legitimate.transfer.event.id).not.toBe(fork.transfer.event.id);
  const outcome = await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis,
    [fork.transfer], { roster_events: fork.events }));
  expect(outcome.handover_pending?.accounts).toEqual([live.a.account_id]);
  expect(outcome.handover_pending?.completes_at).toBe(w.clock.now + 72 * 3_600_000);
  expect(await accountForToken(w.d, outcome.token)).toBeNull();
  expect((await accountForToken(w.d, live.a.token))?.id).toBe(live.a.account_id);
  expect(await C.err(C.rent(w.d, live.a.account_id, C.rreq(t.f, t.team, w.clock.now)))).toBe('team_ownership_required');
  expect((await C.state(w.d, live.a.account_id)).rentals[0]?.id).toBe(live.rid);
  const expires_at = w.clock.now + 240_000;
  const held = await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`) as Promise<any>);
  const chain = held.proposed_chain.chainId;
  expect(await C.err(objectHandover(w.d, t.team, { key: successor.pubkey, chain_id: chain, expires_at,
    roster: { genesis: t.genesis, authority_chain: [legitimate.transfer], roster_events: legitimate.events },
    signature: successor.sign(objectionMessage(t.team, chain, expires_at)) })))
    .toBe('invalid_handover_objection');
  await objectHandover(w.d, t.team, { key: t.f.pubkey, chain_id: chain, expires_at,
    roster: { genesis: t.genesis },
    signature: t.f.sign(objectionMessage(t.team, chain, expires_at)) });
  const pending = await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`) as Promise<any>);
  expect(pending.objected_by).toBe(t.f.pubkey);
  expect(await C.err(C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis,
    [fork.transfer], { roster_events: fork.events })))).toBe('team_ownership_required');
  const charged = (await C.row(w, live.rid)).charged_micros;
  w.clock.now += 120_000;
  await C.beat(w, live);
  await C.tick(w.d);
  expect(await accountForToken(w.d, outcome.token)).toBeNull();
  expect((await C.row(w, live.rid)).state).toBe('running');
  expect((await C.row(w, live.rid)).charged_micros).toBeGreaterThan(charged);
  expect(w.cloud.terminations).toHaveLength(0);
});

test('funded handover does not start its clock from a predecessor acknowledgment', async () => {
  const w = C.world(), t = C.mkTeam('rent8-f7b-funded'), successor = C.generateKeys();
  const original = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(original.account_id, 50));
  const next = step(t.f, successor, t.team, 2);
  const proposed = await C.createAccount(w.d, t.team, C.proof(successor, t.team, w.clock.now, t.genesis,
    [next.transfer], { roster_events: next.events }));
  expect(proposed.handover_pending).toBeDefined();
  const held = await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`) as Promise<any>);
  const chain = held.proposed_chain.chainId;
  const expires_at = w.clock.now + 240_000;
  expect(await C.err(acknowledgeHandover(w.d, t.team, { key: t.f.pubkey, chain_id: chain, expires_at,
    roster: { genesis: t.genesis, authority_chain: [next.transfer], roster_events: next.events },
    signature: t.f.sign(ackMessage(t.team, chain, expires_at, '', '')) }))).toBe('invalid_handover_ack');
  w.clock.now += 86_400_000 - 1;
  await C.tick(w.d);
  expect((await accountForToken(w.d, original.token))?.id).toBe(original.account_id);
  w.clock.now++;
  await C.tick(w.d);
  expect((await accountForToken(w.d, original.token))?.id).toBe(original.account_id);
  expect(await accountForToken(w.d, proposed.token)).toBeNull();
});

test('the current bearer can stop a rental during a pending handover', async () => {
  const w = C.world(), t = C.mkTeam('rent8-f7b-stop'), next = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  const moved = step(t.f, next, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [moved.transfer], { roster_events: moved.events }));
  expect((await accountForToken(w.d, live.a.token))?.id).toBe(live.a.account_id);
  const stopped = await C.stop(w.d, live.a.account_id, { rental_id: live.rid });
  expect(stopped.stopped).toBe(1);
  expect((await C.row(w, live.rid)).state).toBe('ended');
});

test('unfunded handover remains immediate', async () => {
  const w = C.world(), t = C.mkTeam('rent8-f7b-empty'), successor = C.generateKeys();
  const original = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const next = step(t.f, successor, t.team, 2);
  const accepted = await C.createAccount(w.d, t.team, C.proof(successor, t.team, w.clock.now, t.genesis,
    [next.transfer], { roster_events: next.events }));
  expect(accepted.handover_pending).toBeUndefined();
  expect(await accountForToken(w.d, original.token)).toBeNull();
  expect((await accountForToken(w.d, accepted.token))?.id).toBe(original.account_id);
});

test('handover endpoint accepts only a current owner objection and requires operator secret to resolve it', async () => {
  const w = C.world(), t = C.mkTeam('rent8-f7b-object'), next = C.generateKeys(), outsider = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const moved = step(t.f, next, t.team, 2);
  const candidate = await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [moved.transfer], { roster_events: moved.events }));
  const alerts: unknown[] = [];
  const deps: any = { env: { COMPUTE_HANDOVER_OPERATOR_SECRET: ("0123456789abcdef" + "0123456789abcdef"),
    COMPUTE_ENABLED: '1', COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixture', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture' }, compute: () => w.d,
    stripe: () => null, alertFetch: async (_url: string, init: RequestInit) => {
      alerts.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    } };
  const handler = makeHandover(deps);
  const send = (action: string, proof: unknown, authorization?: string) => handler(new Request('https://site.test/api/compute/handover',
    { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ team_id: t.team, action, proof }) }));
  const held = await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`) as Promise<any>);
  const chain = held.proposed_chain.chainId;
  const expires_at = w.clock.now + 240_000;
  const roster = { genesis: t.genesis, authority_chain: [moved.transfer], roster_events: moved.events };
  const statusProof = (key: typeof t.f) => ({ key: key.pubkey, expires_at, roster,
    signature: key.sign(statusMessage(t.team, expires_at)) });
  expect((await send('status', statusProof(outsider))).status).toBe(404);
  const status = await (await send('status', statusProof(t.f))).json() as { chain_id: string };
  expect(status.chain_id).toBe(chain);
  const proof = (key: typeof t.f) => ({ key: key.pubkey, chain_id: chain, expires_at, roster,
    signature: key.sign(objectionMessage(t.team, chain, expires_at)) });
  expect((await send('object', proof(outsider))).status).toBe(403);
  expect((await send('object', proof(t.f))).status).toBe(200);
  expect(w.logs).toContain('alert_handover_objection');
  expect(alerts).toHaveLength(1);
  expect((alerts[0] as { text: string }).text).toContain('handover_objection');
  expect((await send('complete', {}, 'Bearer wrong')).status).toBe(401);
  expect((await send('ack', { key: t.f.pubkey, chain_id: chain, expires_at, roster,
    signature: t.f.sign(ackMessage(t.team, chain, expires_at, '', '')) })).status).toBe(403);
  w.clock.now += 86_400_000;
  await C.tick(w.d);
  expect((await accountForToken(w.d, a.token))?.id).toBe(a.account_id);
  expect((await send('complete', {}, 'Bearer wrong')).status).toBe(401);
  expect((await handler(new Request('https://site.test/api/compute/handover', { method: 'POST',
    headers: { authorization: ("Bearer 0123456789abcdef" + "0123456789abcdef") },
    body: JSON.stringify({ team_id: t.team, action: 'reject', chain_id: chain, proposed_key: held.proposed_key }) }))).status).toBe(200);
  expect((await accountForToken(w.d, a.token))?.id).toBe(a.account_id);
  expect(await accountForToken(w.d, candidate.token)).toBeNull();
});

test('holder receives a signed notice while an older state client receives its original wire shape', async () => {
  const w = C.world(), t = C.mkTeam('rent8-f7b-notice'), next = C.generateKeys(), signer = C.LH.testKeypair();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const moved = step(t.f, next, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [moved.transfer], { roster_events: moved.events }));
  const handler = makeState({ env: { WALKIE_LICENSE_SIGNING_KEY: signer.pem }, compute: () => w.d,
    stripe: () => null } as any);
  const read = async (notice: boolean) => (await handler(new Request('https://site.test/api/compute/state',
    { headers: { authorization: `Bearer ${a.token}`, ...(notice ? { 'x-walkie-handover-notice': '1' } : {}) } }))).json() as Promise<any>;
  const legacy = await read(false);
  expect(legacy.handover_notice).toBeUndefined();
  const modern = await read(true);
  const verified = verifyHandoverNotice(modern.handover_notice, t.team, signer.publicB64);
  expect(verified?.accounts).toEqual([a.account_id]);
  expect(verified?.proposed_by).toBe(next.pubkey);
  expect(verifyHandoverNotice(modern.handover_notice, t.team, C.LH.testKeypair().publicB64)).toBeNull();
});

test('license bind cannot advance the rental enrollment chain around a funded hold', async () => {
  const w = C.world(), t = C.mkTeam('rent8-f7b-bind'), next = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
  const originalAuthority = teamAuthority(t.team, { genesis: t.genesis })!;
  const metadata = { [TEAM_META]: t.team, [AUTHORITY_META]: t.f.pubkey,
    [AUTHORITY_CHAIN_META]: originalAuthority.chainId, [AUTHORITY_DEPTH_META]: '0' };
  stripe.subs.set('sub_F7B', C.LH.subscription({ id: 'sub_F7B', metadata }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: 'sub_F7B', plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
    expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const moved = step(t.f, next, t.team, 2), expires_at = C.LH.NOW + 240_000;
  await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [moved.transfer], { roster_events: moved.events }));
  const hold = await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`)) as any;
  expect(hold).toBeDefined();
  const objectionExpiry = w.clock.now + 240_000;
  await objectHandover(w.d, t.team, { key: t.f.pubkey, chain_id: hold.proposed_chain.chainId,
    expires_at: objectionExpiry, roster: { genesis: t.genesis, authority_chain: [moved.transfer], roster_events: moved.events },
    signature: t.f.sign(objectionMessage(t.team, hold.proposed_chain.chainId, objectionExpiry)) });
  const bind = C.makeBind({ ...C.LH.deps(stripe, { ...C.LH.fullEnv(signer.pem), COMPUTE_ENABLED: '1' }),
    computeStore: () => w.store });
  const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST',
    body: JSON.stringify({ code, team_id: t.team, proof: { genesis: t.genesis,
      authority_chain: [moved.transfer], roster_events: moved.events, expires_at,
      bind_signature: next.sign(C.bindMessage(t.team, 'sub_F7B', expires_at)) } }) }));
  expect(response.status).toBe(403);
  expect(stripe.subs.get('sub_F7B')?.metadata).toEqual(metadata);
  const chain = await w.store.tx((tx: any) => tx.control(`enrollment-chain:${t.team}`) as Promise<any>);
  expect(chain.depth).toBe(0);
  expect((await accountForToken(w.d, a.token))?.id).toBe(a.account_id);
});

test('older account clients cannot open a hold they cannot report', async () => {
  const w = C.world(), t = C.mkTeam('rent8-f7b-legacy'), next = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const moved = step(t.f, next, t.team, 2);
  const handler = makeAccount({ env: {}, compute: () => w.d, stripe: () => null } as any);
  const body = JSON.stringify({ team_id: t.team, proof: C.proof(next, t.team, w.clock.now, t.genesis,
    [moved.transfer], { roster_events: moved.events }) });
  const legacy = await handler(new Request('https://site.test/api/compute/account', { method: 'POST', body }));
  expect(legacy.status).toBe(426);
  expect(await w.store.tx((tx: any) => tx.control(`compute-handover:${t.team}`))).toBeUndefined();
  expect((await accountForToken(w.d, a.token))?.id).toBe(a.account_id);
});
