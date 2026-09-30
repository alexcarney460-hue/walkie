import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';
import { acknowledgeHandover, ackMessage, objectHandover, objectionMessage, statusHandover, statusMessage } from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { makeTick } from '../api/compute/tick.ts';
import { makeAccount } from '../api/compute/account.ts';
import { ComputeService } from '../../src/daemon/compute/service.ts';
import { ComputeSite } from '../../src/daemon/compute/site.ts';
import { rosterProof } from '../../src/daemon/compute/team-proof.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { makeCore, feed, settle } from '../../test/helpers/core.ts';
import * as E from '../../test/helpers/events.ts';

const pending = (w: ReturnType<typeof C.world>, team: string) => w.store.tx((t: any) => t.control(`compute-handover:${team}`)) as Promise<any>;
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
const signed = (key: ReturnType<typeof C.generateKeys>, team: string, chain: string, now: number, roster: object, kind: 'ack' | 'object') => {
  const expires_at = now + 240_000;
  return { key: key.pubkey, chain_id: chain, expires_at, roster,
    signature: key.sign(kind === 'ack' ? ackMessage(team, chain, expires_at, '', '') : objectionMessage(team, chain, expires_at)) };
};

test('F7b unseen successor cannot object; stored predecessor can freeze the funded hold', async () => {
  const w = C.world(), t = C.mkTeam('rent10-f7b'), real = C.generateKeys(), forger = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  const fork = step(t.f, forger, t.team, 7), legit = step(t.f, real, t.team, 2);
  const forged = await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis,
    [fork.transfer], { roster_events: fork.events }));
  const p = await pending(w, t.team);
  expect(await C.err(acknowledgeHandover(w.d, t.team, signed(t.f, t.team, p.proposed_chain.chainId, w.clock.now,
    { genesis: t.genesis, authority_chain: [fork.transfer], roster_events: fork.events }, 'ack')))).toBe('invalid_handover_ack');
  expect(await C.err(objectHandover(w.d, t.team, signed(real, t.team, p.proposed_chain.chainId, w.clock.now,
    { genesis: t.genesis, authority_chain: [legit.transfer], roster_events: legit.events }, 'object'))))
    .toBe('invalid_handover_objection');
  await objectHandover(w.d, t.team, signed(t.f, t.team, p.proposed_chain.chainId, w.clock.now,
    { genesis: t.genesis }, 'object'));
  expect((await pending(w, t.team)).objected_by).toBe(t.f.pubkey);
  expect(w.logs).toContain('alert_handover_objection');
  const co = C.generateKeys(), added = step(forger, co, t.team, 1);
  const expires_at = w.clock.now + 240_000;
  expect(await C.err(statusHandover(w.d, t.team, { key: co.pubkey, expires_at,
    roster: { genesis: t.genesis, authority_chain: [fork.transfer],
      roster_events: [...fork.events, ...added.events.slice(0, 2)] },
    signature: co.sign(statusMessage(t.team, expires_at)) }))).toBe('handover_not_found');
  expect((await pending(w, t.team)).objected_by).toBe(t.f.pubkey);
  w.clock.now += 86_400_000;
  await C.tick(w.d);
  expect((await pending(w, t.team)).objected_by).toBe(t.f.pubkey);
  expect(await accountForToken(w.d, forged.token)).toBeNull();
  expect((await accountForToken(w.d, live.a.token))?.id).toBe(live.a.account_id);
});

test('F7b proposal waits when only its predecessor offers acknowledgment', async () => {
  const w = C.world(), t = C.mkTeam('rent10-f7b-residual'), forger = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const fork = step(t.f, forger, t.team, 7);
  const candidate = await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis,
    [fork.transfer], { roster_events: fork.events }));
  const p = await pending(w, t.team);
  expect(await C.err(acknowledgeHandover(w.d, t.team, signed(t.f, t.team, p.proposed_chain.chainId, w.clock.now,
    { genesis: t.genesis, authority_chain: [fork.transfer], roster_events: fork.events }, 'ack')))).toBe('invalid_handover_ack');
  w.clock.now += 86_400_000;
  await C.tick(w.d);
  expect(await accountForToken(w.d, candidate.token)).toBeNull();
  expect((await accountForToken(w.d, a.token))?.id).toBe(a.account_id);
});

test('hold waits for another owner machine signed delivery ack and expires unacknowledged at 72h', async () => {
  const w = C.world(), t = C.mkTeam('rent10-ack'), next = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const moved = step(t.f, next, t.team, 2);
  const roster = { genesis: t.genesis, authority_chain: [moved.transfer], roster_events: moved.events };
  const candidate = await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [moved.transfer], { roster_events: moved.events }));
  const p = await pending(w, t.team);
  expect(p.acknowledged_at).toBeUndefined();
  expect(await C.err(acknowledgeHandover(w.d, t.team, signed(next, t.team, p.proposed_chain.chainId, w.clock.now, roster, 'ack')))).toBe('invalid_handover_ack');
  w.clock.now += 30 * 60_000;
  expect(await C.err(acknowledgeHandover(w.d, t.team, signed(t.f, t.team, p.proposed_chain.chainId, w.clock.now, roster, 'ack'))))
    .toBe('invalid_handover_ack');
  expect((await pending(w, t.team)).completes_at).toBeNull();
  w.clock.now += 86_400_000;
  await C.tick(w.d);
  expect(await accountForToken(w.d, candidate.token)).toBeNull();
  const w2 = C.world(), t2 = C.mkTeam('rent10-expiry'), next2 = C.generateKeys();
  const a2 = await C.createAccount(w2.d, t2.team, C.proof(t2.f, t2.team, w2.clock.now, t2.genesis));
  await C.applyCreditEvent(w2.d, C.purchase(a2.account_id, 50));
  const moved2 = step(t2.f, next2, t2.team, 2);
  const c2 = await C.createAccount(w2.d, t2.team, C.proof(next2, t2.team, w2.clock.now, t2.genesis,
    [moved2.transfer], { roster_events: moved2.events }));
  w2.clock.now += 72 * 60 * 60_000;
  const alerts: string[] = [];
  const tick = makeTick({ env: { CRON_SECRET: 'fixture-cron', COMPUTE_ENABLED: '1', COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixture',
    COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture' }, compute: () => w2.d, stripe: () => null,
    alertFetch: async (_url: string, init: RequestInit) => {
      alerts.push(String(init.body));
      return Response.json({ ok: true });
    } } as any);
  expect((await tick(new Request('https://site.test/api/compute/tick',
    { headers: { authorization: 'Bearer fixture-cron' } }))).status).toBe(200);
  expect(await pending(w2, t2.team)).toBeNull();
  expect((await accountForToken(w2.d, a2.token))?.id).toBe(a2.account_id);
  expect(await accountForToken(w2.d, c2.token)).toBeNull();
  expect(w2.logs).toContain('alert_handover_expired');
  expect(alerts.some(body => body.includes('handover_expired'))).toBe(true);
});

test('caller notice header cannot start a funded hold clock', async () => {
  const w = C.world(), t = C.mkTeam('rent10-header'), next = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const moved = step(t.f, next, t.team, 2);
  const handler = makeAccount({ env: {}, compute: () => w.d, stripe: () => null } as any);
  const response = await handler(new Request('https://site.test/api/compute/account', { method: 'POST',
    headers: { 'x-walkie-handover-notice': '1' },
    body: JSON.stringify({ team_id: t.team, proof: C.proof(next, t.team, w.clock.now, t.genesis,
      [moved.transfer], { roster_events: moved.events }) }) }));
  expect(response.status).toBe(201);
  expect((await pending(w, t.team)).completes_at).toBeNull();
  w.clock.now += 86_400_000;
  await C.tick(w.d);
  expect((await accountForToken(w.d, a.token))?.id).toBe(a.account_id);
});

test('retry keeps pending tokens, operator rejection retains previous authority', async () => {
  const w = C.world(), t = C.mkTeam('rent10-retry'), next = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const moved = step(t.f, next, t.team, 2);
  const proof = C.proof(next, t.team, w.clock.now, t.genesis, [moved.transfer], { roster_events: moved.events });
  const first = await C.createAccount(w.d, t.team, proof);
  const retry = await C.createAccount(w.d, t.team, proof);
  expect(retry.token).toBe(first.token);
  const handler = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: ("0123456789abcdef" + "0123456789abcdef") },
    compute: () => w.d, stripe: () => null } as any);
  const held = await pending(w, t.team) as { proposed_chain: { chainId: string }; proposed_key: string };
  const request = (authorization: string) => handler(new Request('https://site.test/api/compute/handover', {
    method: 'POST', headers: { authorization }, body: JSON.stringify({ team_id: t.team, action: 'reject',
      chain_id: held.proposed_chain.chainId, proposed_key: held.proposed_key }) }));
  expect((await request('Bearer wrong')).status).toBe(401);
  expect((await request(("Bearer 0123456789abcdef" + "0123456789abcdef"))).status).toBe(200);
  expect(await pending(w, t.team)).toBeNull();
  expect((await accountForToken(w.d, a.token))?.id).toBe(a.account_id);
  expect(await accountForToken(w.d, first.token)).toBeNull();
});

test('handover actions have separate per-IP limits before proof or operator checks', async () => {
  const w = C.world(), t = C.mkTeam('rent10-rate');
  const handler = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: ("0123456789abcdef" + "0123456789abcdef") },
    compute: () => w.d, stripe: () => null } as any);
  const request = (action: string, ip = '192.0.2.1') => handler(new Request('https://site.test/api/compute/handover', {
    method: 'POST', headers: { 'x-real-ip': ip }, body: JSON.stringify({ team_id: t.team, action, proof: {} }) }));
  for (const action of ['status', 'object', 'ack', 'clear_rejection', 'complete', 'reject', 'resolve_fork']) {
    for (let i = 0; i < 10; i++) expect((await request(action)).status).not.toBe(429);
    const limited = await request(action);
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: string }).error).toBe('rate_limited');
    expect((await request(action, '192.0.2.2')).status).not.toBe(429);
  }
});

test('funded path that leaves and returns to the same key is held', async () => {
  const w = C.world(), t = C.mkTeam('rent10-return'), other = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const out = step(t.f, other, t.team, 2), back = C.transfer(other, t.team, 1, t.f);
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis,
    [out.transfer, back], { roster_events: [...out.events, back.event] }));
  expect(await pending(w, t.team)).toBeDefined();
});

test('daemon compact roster proof carries owner admissions after enrollment', () => {
  const cleanup: (() => void)[] = [];
  try {
    const founder = E.tnode('founder'), co = E.tnode('co');
    const { team, create } = E.createTeam(founder);
    const core = makeCore(E.tnode('observer'), team, cleanup);
    feed(core, [create, E.memberEv(team, founder, co, 'owner'), E.nodeEv(team, founder, co)]);
    expect(teamAuthority(team, rosterProof(core))?.owners).toContain(co.keys.pubkey);
  } finally { while (cleanup.length) cleanup.pop()!(); }
});

test('owner admitted before a hold can object; proposer and outsider cannot', async () => {
  const w = C.world(), t = C.mkTeam('rent10-newowner'), co = C.generateKeys(), next = C.generateKeys(), outsider = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const admission = step(t.f, co, t.team, 2), move = step(t.f, next, t.team, 5);
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis, [],
    { roster_events: admission.events.slice(0, 2) }));
  w.clock.now += 86_400_001;
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const roster = { genesis: t.genesis, authority_chain: [move.transfer],
    roster_events: [...admission.events.slice(0, 2), ...move.events] };
  await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [move.transfer], { roster_events: roster.roster_events }));
  const chain = (await pending(w, t.team)).proposed_chain.chainId;
  expect(await C.err(objectHandover(w.d, t.team, signed(next, t.team, chain, w.clock.now, roster, 'object'))))
    .toBe('invalid_handover_objection');
  expect(await C.err(objectHandover(w.d, t.team, signed(outsider, t.team, chain, w.clock.now, roster, 'object'))))
    .toBe('invalid_handover_objection');
  await objectHandover(w.d, t.team, signed(co, t.team, chain, w.clock.now, roster, 'object'));
  expect((await pending(w, t.team)).objected_by).toBe(co.pubkey);
});

test('a predecessor cannot complete a funded transfer without independent receipt', async () => {
  const w = C.world(), t = C.mkTeam('rent10-revoked'), next = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const first = step(t.f, next, t.team, 2);
  const candidate = await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [first.transfer], { roster_events: first.events }));
  const p = await pending(w, t.team);
  expect(await C.err(acknowledgeHandover(w.d, t.team, signed(t.f, t.team, p.proposed_chain.chainId, w.clock.now,
    { genesis: t.genesis, authority_chain: [first.transfer], roster_events: first.events }, 'ack'))))
    .toBe('invalid_handover_ack');
  w.clock.now += 86_400_000;
  await C.tick(w.d);
  expect((await pending(w, t.team)).acknowledged_at).toBeUndefined();
  expect((await accountForToken(w.d, a.token))?.id).toBe(a.account_id);
  expect(await accountForToken(w.d, candidate.token)).toBeNull();
});

test('a fresher signed roster cannot add objectors during a pending hold', async () => {
  const w = C.world(), t = C.mkTeam('rent10-refresh'), b = C.generateKeys(), co = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
  const move = step(t.f, b, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(b, t.team, w.clock.now, t.genesis,
    [move.transfer], { roster_events: move.events }));
  const chain = (await pending(w, t.team)).proposed_chain.chainId;
  const revoke = C.signEvent(b, { v: C.PROTOCOL_VERSION, team: t.team, id: `${b.nodeId}:1`, origin: b.nodeId, seq: 1,
    ts: C.T0 + 100, author: { handle: 'next', node: b.nodeId }, kind: 'team.member',
    body: { login: 'direct:alex', handle: 'alex', role: 'removed' } });
  const admit = step(b, co, t.team, 2);
  const roster = { genesis: t.genesis, authority_chain: [move.transfer],
    roster_events: [...move.events, revoke, ...admit.events.slice(0, 2)] };
  const expires_at = w.clock.now + 240_000;
  expect(await C.err(statusHandover(w.d, t.team, { key: co.pubkey, expires_at, roster,
    signature: co.sign(statusMessage(t.team, expires_at)) }))).toBe('handover_not_found');
  expect(await C.err(objectHandover(w.d, t.team, signed(co, t.team, chain, w.clock.now, roster, 'object'))))
    .toBe('invalid_handover_objection');
  expect((await pending(w, t.team)).eligible_owners).not.toContain(co.pubkey);
  await objectHandover(w.d, t.team, signed(t.f, t.team, chain, w.clock.now,
    { genesis: t.genesis }, 'object'));
  expect((await pending(w, t.team)).objected_by).toBe(t.f.pubkey);
});

test('objected hold keeps billing running rentals and stops them at zero credit', async () => {
  const w = C.world(), t = C.mkTeam('rent10-billing'), next = C.generateKeys();
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  const move = step(t.f, next, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(next, t.team, w.clock.now, t.genesis,
    [move.transfer], { roster_events: move.events }));
  const chain = (await pending(w, t.team)).proposed_chain.chainId;
  await objectHandover(w.d, t.team, signed(t.f, t.team, chain, w.clock.now,
    { genesis: t.genesis, authority_chain: [move.transfer], roster_events: move.events }, 'object'));
  let row = await C.row(w, live.rid);
  for (let i = 0; i < 1000 && row.state === 'running'; i++) {
    w.clock.now += 10 * 60_000;
    await C.beat(w, live).catch(() => undefined);
    await C.tick(w.d);
    row = await C.row(w, live.rid);
  }
  expect(row.state).toBe('ended');
  expect(await w.store.tx((tx: any) => tx.balance(live.a.account_id))).toBeGreaterThanOrEqual(0);
  expect(await pending(w, t.team)).toBeDefined();
});

test('owner daemon posts a notice but does not acknowledge its own post', async () => {
  const cleanup: (() => void)[] = [];
  try {
    const founder = E.tnode('founder'), next = E.tnode('successor');
    const { team, create } = E.createTeam(founder, 'rent10-daemon-ack');
    const w = C.world();
    w.clock.now = E.now();
    const core = makeCore(founder, team, cleanup);
    const member = E.memberEv(team, founder, next, 'owner');
    const node = E.nodeEv(team, founder, next);
    const channel = E.ev(team, founder, 'channel.upsert', { name: 'general', public: true });
    const transfer = E.ev(team, founder, 'team.authority', { node_id: next.keys.nodeId });
    expect(core.ingest(create, 'local').status).toBe('accepted');
    for (const event of [member, node, channel, transfer]) expect(core.ingest(event, 'local').status).toBe('accepted');
    await settle(core);
    expect({ row: core.store.getRow(create.id)?.status, pending: core.store.hasPending(create.id) }).toEqual({ row: 'ok', pending: false });
    const a = await C.createAccount(w.d, team, C.proof(founder.keys, team, w.clock.now, create));
    await C.applyCreditEvent(w.d, C.purchase(a.account_id, 50));
    await C.createAccount(w.d, team, C.proof(next.keys, team, w.clock.now, create,
      [{ event: transfer, key: next.keys.pubkey }], { roster_events: [member, node, transfer] }));
    const signer = C.LH.testKeypair();
    const handler = makeHandover({ env: { WALKIE_LICENSE_SIGNING_KEY: signer.pem }, compute: () => w.d,
      stripe: () => null } as any);
    const site = new ComputeSite({ base: 'https://site.test', fetch: (url, init) =>
      handler(new Request(String(url), init)) });
    const warnings: string[] = [];
    const service = new ComputeService({ core, log: { warn: (code: string) => warnings.push(code), info: () => {} } as any,
      transport: () => undefined } as any, { site, noticePublicKey: signer.publicB64 });
    expect(core.me()?.role).toBe('owner');
    expect({ status: core.store.getRow(channel.id)?.status, reason: core.store.getRow(channel.id)?.reason })
      .toEqual({ status: 'ok', reason: null });
    expect(core.roster.channels.has('general')).toBe(true);
    expect(teamAuthority(team, rosterProof(core))?.key).toBe(next.keys.pubkey);
    const statusExpiry = core.clock() + 240_000;
    const status = await site.handoverStatus(team, { key: founder.keys.pubkey, expires_at: statusExpiry,
      roster: rosterProof(core), signature: founder.keys.sign(statusMessage(team, statusExpiry)) });
    expect(status.notice).toBeTruthy();
    await service.pollOnce();
    expect(warnings).toEqual([]);
    const p = await pending(w, team);
    expect(p.acknowledged_by).toBeUndefined();
    expect(p.completes_at).toBeNull();
    expect(core.store.getMeta(`compute-handover-notice:${p.proposed_chain.chainId}`)).toBe('1');
  } finally { while (cleanup.length) cleanup.pop()!(); }
});
