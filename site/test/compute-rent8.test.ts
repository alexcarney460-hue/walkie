import { afterEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import * as C from './rent6-fixtures.ts';
import { makeCore, feed } from '../../test/helpers/core.ts';
import * as E from '../../test/helpers/events.ts';
import { rosterProof } from '../../src/daemon/compute/team-proof.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { makeWatchdogHeartbeat } from '../api/compute/watchdog-heartbeat.ts';
import { startedMinutes, priceOfMinutes } from '../api/_lib/compute/money.ts';
import { tierSpec } from '../api/_lib/compute/catalog.ts';
import { bill } from '../api/_lib/compute/billing.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

test('founder transfers authority to a second machine on the same login and back', async () => {
  const founder = E.tnode('founder');
  const laptop = E.tnode('founder', founder.login, 'founder-laptop');
  const { team, create } = E.createTeam(founder);
  const core = makeCore(E.tnode('observer'), team, cleanups);
  const admit = E.nodeEv(team, founder, laptop);
  const transfer = E.ev(team, founder, 'team.authority', { node_id: laptop.keys.nodeId });
  feed(core, [create, admit, transfer]);
  expect(teamAuthority(team, rosterProof(core))?.key).toBe(laptop.keys.pubkey);
  const returning = E.ev(team, laptop, 'team.authority', { node_id: founder.keys.nodeId, after: transfer.id });
  feed(core, [returning]);
  expect(core.store.getRow(returning.id)?.status).toBe('ok');
  expect(teamAuthority(team, rosterProof(core))?.key).toBe(founder.keys.pubkey);
  expect(rosterProof(core).roster_events).toHaveLength(3);
});

test('same-login authority moves enroll compute and bind the license in both directions', async () => {
  const founder = E.tnode('founder');
  const laptop = E.tnode('founder', founder.login, 'founder-laptop');
  const { team, create } = E.createTeam(founder, 'rent8-bind');
  const core = makeCore(E.tnode('observer'), team, cleanups);
  const admit = E.nodeEv(team, founder, laptop);
  const transfer = E.ev(team, founder, 'team.authority', { node_id: laptop.keys.nodeId });
  feed(core, [create, admit, transfer]);
  const w = C.world();
  const signing = C.LH.testKeypair();
  const stripe = new C.LH.MockStripe();
  stripe.subs.set('sub_RENT8', C.LH.subscription({ id: 'sub_RENT8' }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: 'sub_RENT8', plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
    expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signing.pem));
  const bind = C.makeBind({ ...C.LH.deps(stripe, { ...C.LH.fullEnv(signing.pem), COMPUTE_ENABLED: '1' }), computeStore: () => w.store });
  const enroll = async (keys: typeof founder.keys) => {
    const roster = rosterProof(core);
    const account = await C.createAccount(w.d, team, C.proof(keys, team, w.clock.now, create, roster.authority_chain,
      { roster_events: roster.roster_events }));
    const expires_at = C.LH.NOW + 240_000;
    const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({
      code, team_id: team, proof: { ...roster, expires_at,
        bind_signature: keys.sign(C.bindMessage(team, 'sub_RENT8', expires_at)) } }) }));
    expect(response.status).toBe(200);
    return account;
  };
  const first = await enroll(laptop.keys);
  const returning = E.ev(team, laptop, 'team.authority', { node_id: founder.keys.nodeId, after: transfer.id });
  feed(core, [returning]);
  const second = await enroll(founder.keys);
  expect(second.account_id).toBe(first.account_id);
});

test('delayed watchdog deletion refunds minutes already billed after deletion, once', async () => {
  const w = C.world();
  const t = C.mkTeam('rent8-deletion');
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  await w.store.tx((tx: any) => tx.updateRental(live.rid, { instance_id: '7' }));
  const started = Date.now() - 4 * 60_000;
  await w.store.tx((tx: any) => tx.updateRental(live.rid, { started_at: started }));
  const deletedAt = started + 90_000;
  w.clock.now = started + 4 * 60_000;
  await w.store.tx(async (tx: any) => {
    await tx.lockAccount(live.a.account_id);
    await bill(tx, await tx.rental(live.rid), w.clock.now);
  });
  const before = await C.row(w, live.rid);
  const expectedMinutes = Math.max(tierSpec(before.tier).min_minutes, startedMinutes(started, deletedAt));
  const expectedCharge = priceOfMinutes(before.price_per_hour_micros, expectedMinutes);
  expect(before.charged_micros).toBeGreaterThan(expectedCharge);
  const secret = 'fixture-watchdog-secret';
  const send = async (ts: number) => {
    const body = JSON.stringify({ ts, deleted: [{ id: 7, at: deletedAt }] });
    return makeWatchdogHeartbeat({ env: { COMPUTE_WATCHDOG_HMAC_SECRET: secret, COMPUTE_ENABLED: '1' }, compute: () => w.d, stripe: () => null })(
      new Request('https://site.test/api/compute/watchdog-heartbeat', { method: 'POST', body,
        headers: { 'x-walkie-signature': createHmac('sha256', secret).update(body).digest('hex') } }));
  };
  // The site clock validates report timestamps separately from the injected billing clock.
  expect((await send(Date.now())).status).toBe(200);
  expect((await C.row(w, live.rid)).charged_micros).toBe(expectedCharge);
  expect(await w.store.tx((tx: any) => tx.balance(live.a.account_id))).toBeGreaterThan(0);
  expect((await send(Date.now() + 1)).status).toBe(200);
  expect((await C.row(w, live.rid)).charged_micros).toBe(expectedCharge);
});

test('minute tick also refunds a delayed watchdog deletion', async () => {
  const w = C.world(), t = C.mkTeam('rent8-tick-deletion');
  const live = await C.runningRental(w, t.f, t.team, t.genesis);
  await w.store.tx((tx: any) => tx.updateRental(live.rid, { instance_id: '7' }));
  const started = (await C.row(w, live.rid)).started_at as number;
  const deletedAt = started + 90_000;
  w.clock.now = started + 4 * 60_000;
  await w.store.tx(async (tx: any) => { await tx.lockAccount(live.a.account_id); await bill(tx, await tx.rental(live.rid), w.clock.now); });
  const before = await C.row(w, live.rid);
  expect(before.billed_minutes).toBe(4);
  await w.store.tx((tx: any) => tx.setControl('watchdog_deletions', { '7': deletedAt }));
  await C.tick(w.d);
  const after = await C.row(w, live.rid);
  expect(after.state).toBe('ended');
  expect(after.billed_minutes).toBe(2);
  expect(after.charged_micros).toBe(priceOfMinutes(after.price_per_hour_micros, 2));
});
