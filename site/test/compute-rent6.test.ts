import { test, expect } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { accountForToken } from '../api/_lib/compute/service.ts';

const admission = (from: ReturnType<typeof C.generateKeys>, to: ReturnType<typeof C.generateKeys>, team: string, seq = 2) => [
  C.signEvent(from, { v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq, ts: C.T0 + seq,
    author: { handle: 'alex', node: from.nodeId }, kind: 'team.member',
    body: { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' } }),
  C.signEvent(from, { v: C.PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq + 1}`, origin: from.nodeId, seq: seq + 1, ts: C.T0 + seq + 1,
    author: { handle: 'alex', node: from.nodeId }, kind: 'team.node',
    body: { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' } }),
];
const chain = (from: ReturnType<typeof C.generateKeys>, to: ReturnType<typeof C.generateKeys>, team: string) => {
  const step = C.transfer(from, team, 4, to);
  return { authority_chain: [step], roster_events: [...admission(from, to, team), step.event] };
};

test('F1: a funded extension holds control while credit and a running rental stay intact', async () => {
  const w = C.world(), team = C.mkTeam('rent6-team');
  const live = await C.runningRental(w, team.f, team.team, team.genesis);
  const credit = await w.store.tx((t: any) => t.paidBalance(live.a.account_id));
  const next = C.generateKeys(), good = chain(team.f, next, team.team);
  const rotated = await C.createAccount(w.d, team.team, C.proof(next, team.team, w.clock.now, team.genesis,
    good.authority_chain, { roster_events: good.roster_events }));
  expect(rotated.account_id).toBe(live.a.account_id);
  expect(rotated.handover_pending?.accounts).toEqual([live.a.account_id]);
  expect((await accountForToken(w.d, live.a.token))?.id).toBe(live.a.account_id);
  expect(await accountForToken(w.d, rotated.token)).toBeNull();
  expect(await w.store.tx((t: any) => t.paidBalance(rotated.account_id) as Promise<unknown>)).toBe(credit);
  expect(await C.err(C.rent(w.d, live.a.account_id, C.rreq(team.f, team.team, w.clock.now)))).toBe('team_ownership_required');
  w.clock.now += 60_000; await C.beat(w, live); await C.tick(w.d);
  expect((await C.row(w, live.rid)).state).toBe('running');
});

test('F2: a longer fork freezes new launches while the funded successor keeps running', async () => {
  const w = C.world(), team = C.mkTeam('rent6-fork'), next = C.generateKeys();
  const first = await C.createAccount(w.d, team.team, C.proof(team.f, team.team, w.clock.now, team.genesis));
  const good = chain(team.f, next, team.team);
  const rotated = await C.createAccount(w.d, team.team, C.proof(next, team.team, w.clock.now, team.genesis,
    good.authority_chain, { roster_events: good.roster_events }));
  expect(await accountForToken(w.d, first.token)).toBeNull();
  await C.applyCreditEvent(w.d, C.purchase(rotated.account_id, 50));
  const started = await C.rent(w.d, rotated.account_id, C.rreq(next, team.team, w.clock.now));
  await C.tick(w.d);
  const rid = started.rentals[0]!.id;
  const tok = C.tokOf(w.cloud.provisions[w.cloud.provisions.length - 1]!.user_data);
  await C.heartbeat(w.d, { rental_id: rid, token: tok, busy_seats: 1, pool_jobs: 0, cpu_pct: 50, egress_bytes: 0 });
  const queued = await C.rent(w.d, rotated.account_id, C.rreq(next, team.team, w.clock.now));
  const rogue = C.generateKeys(), rogue2 = C.generateKeys();
  const fork1 = C.transfer(team.f, team.team, 5, rogue), fork2 = C.transfer(rogue, team.team, 4, rogue2);
  const fork = [fork1, fork2], events = [...admission(team.f, rogue, team.team), fork1.event,
    ...admission(rogue, rogue2, team.team), fork2.event];
  expect(await C.err(C.createAccount(w.d, team.team, C.proof(rogue2, team.team, w.clock.now, team.genesis, fork,
    { roster_events: events })))).toBe('team_ownership_required');
  expect(await w.store.tx((t: any) => t.control(`enrollment-fork:${team.team}`) as Promise<unknown>)).toBe(w.clock.now);
  w.clock.now += 60_000;
  await C.heartbeat(w.d, { rental_id: rid, token: tok, busy_seats: 1, pool_jobs: 0, cpu_pct: 50, egress_bytes: 0 });
  await C.tick(w.d);
  expect((await C.row(w, rid)).state).toBe('running');
  expect((await C.row(w, queued.rentals[0]!.id)).state).toBe('starting');
  expect((await C.row(w, queued.rentals[0]!.id)).instance_id).toBeNull();
  expect(await C.err(C.rent(w.d, rotated.account_id, C.rreq(next, team.team, w.clock.now)))).toBe('team_ownership_required');
});

test('F3: license bind rejects a longer branch from a former authority', async () => {
  const team = C.mkTeam('license-fork'), next = C.generateKeys(), good = chain(team.f, next, team.team);
  const w = C.world();
  const signing = C.LH.testKeypair(), env = { ...C.LH.fullEnv(signing.pem), COMPUTE_ENABLED: '1' }, stripe = new C.LH.MockStripe();
  stripe.subs.set('sub_RENT6', C.LH.subscription({ id: 'sub_RENT6' }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: 'sub_RENT6', plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW, expires_at: C.LH.NOW + 30 * 86_400_000 },
    C.signingKeyFromPem(signing.pem));
  const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => w.store });
  const request = (key: ReturnType<typeof C.generateKeys>, authority_chain: unknown[], roster_events: unknown[]) => {
    const expires_at = C.LH.NOW + 240_000;
    return new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: team.team,
      proof: { genesis: team.genesis, authority_chain, roster_events, expires_at,
        bind_signature: key.sign(C.bindMessage(team.team, 'sub_RENT6', expires_at)) } }) });
  };
  expect((await bind(request(next, good.authority_chain, good.roster_events))).status).toBe(200);
  const rogue = C.generateKeys(), rogue2 = C.generateKeys();
  const first = C.transfer(team.f, team.team, 5, rogue), second = C.transfer(rogue, team.team, 4, rogue2);
  const forkEvents = [...admission(team.f, rogue, team.team), first.event,
    ...admission(rogue, rogue2, team.team), second.event];
  expect((await bind(request(rogue2, [first, second], forkEvents))).status).toBe(403);
  expect(stripe.subs.get('sub_RENT6')?.metadata.walkie_authority).toBe(next.pubkey);
  expect(await C.err(C.createAccount(w.d, team.team, C.proof(rogue2, team.team, w.clock.now, team.genesis,
    [first, second], { roster_events: forkEvents })))).toBe('team_ownership_required');
});

test('C2: another customer launches while a delete keeps failing', async () => {
  const w = C.world(), a = C.mkTeam('a'), b = C.mkTeam('b');
  const first = await C.runningRental(w, a.f, a.team, a.genesis);
  const stuck = (await C.row(w, first.rid)).instance_id;
  const terminate = w.cloud.terminate.bind(w.cloud);
  w.cloud.terminate = async (id: string) => { if (id === stuck) throw new Error('fixture delete failure'); return terminate(id); };
  await C.stop(w.d, first.a.account_id, { rental_id: first.rid });
  const account = await C.createAccount(w.d, b.team, C.proof(b.f, b.team, w.clock.now, b.genesis));
  await C.applyCreditEvent(w.d, C.purchase(account.account_id, 50));
  const rental = await C.rent(w.d, account.account_id, C.rreq(b.f, b.team, w.clock.now));
  await C.tick(w.d);
  expect((await C.row(w, rental.rentals[0]!.id)).instance_id).not.toBeNull();
});

test('W1/W3: stale tag retries, healthy tags renew coarsely, and vanished instances stop billing', async () => {
  const w = C.world(), team = C.mkTeam('watchdog');
  const live = await C.runningRental(w, team.f, team.team, team.genesis);
  const original = w.cloud.setPaidUntil.bind(w.cloud);
  let calls = 0;
  w.cloud.setPaidUntil = async (id: string, until: number) => { calls++; return original(id, until); };
  for (let minute = 1; minute <= 35; minute++) { w.clock.now += 60_000; await C.beat(w, live); await C.tick(w.d); }
  expect(calls).toBeLessThanOrEqual(2);
  const droplets = (await w.cloud.list()).map((i: any) => ({ id: Number(i.instance_id.replace('fake-', '0x')),
    tags: ['walkie-managed', `wk-paid-until-${i.tags['walkie:paid_until']}`], created_at: new Date(C.T0).toISOString() }));
  expect(await C.sweep({ list: async () => ({ droplets, next: false }), delete: async () => {} }, Math.floor(w.clock.now / 1000))).toEqual([]);
  const instance = (await C.row(w, live.rid)).instance_id;
  await w.cloud.terminate(instance);
  const before = (await C.row(w, live.rid)).charged_micros;
  w.clock.now += 60_000;
  await C.tick(w.d);
  expect((await C.row(w, live.rid)).state).toBe('ended');
  const atEnd = (await C.row(w, live.rid)).charged_micros;
  w.clock.now += 60_000; await C.tick(w.d);
  expect(atEnd).toBeGreaterThanOrEqual(before);
  expect((await C.row(w, live.rid)).charged_micros).toBe(atEnd);
});

test('W1: failed oldest tag gets a durable retry while another rental renews', async () => {
  const w = C.world(), a = C.mkTeam('tag-a'), b = C.mkTeam('tag-b');
  const first = await C.runningRental(w, a.f, a.team, a.genesis);
  const second = await C.runningRental(w, b.f, b.team, b.genesis);
  for (const live of [first, second]) await w.store.tx(async (t: any) => {
    const r = await t.rental(live.rid);
    await t.updateRental(live.rid, { safety: { ...r.safety, tag_paid_until: w.clock.now + 5 * 60_000 } });
  });
  const firstId = (await C.row(w, first.rid)).instance_id;
  const original = w.cloud.setPaidUntil.bind(w.cloud);
  w.cloud.setPaidUntil = async (id: string, until: number) => {
    if (id === firstId) throw new Error('fixture tag failure');
    return original(id, until);
  };
  w.clock.now += 60_000;
  await C.beat(w, first); await C.beat(w, second); await C.tick(w.d);
  expect((await C.row(w, first.rid)).safety.tag_retry_at).toBe(w.clock.now + 5 * 60_000);
  expect((await C.row(w, second.rid)).safety.tag_paid_until).toBe(w.clock.now + 60 * 60_000);
});
