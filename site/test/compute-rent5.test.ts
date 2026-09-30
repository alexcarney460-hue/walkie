import { test, expect } from 'bun:test';
import { generateKeys, signEvent } from '../../src/daemon/keys.ts';
import { deriveTeamId } from '../../src/protocol/ids.ts';
import { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
import { createAccount } from '../api/_lib/compute/service.ts';
import { ownershipMessage } from '../api/_lib/compute/ownership.ts';
import { world, T0, MIN, fund, idem } from './compute-helpers.ts';
import { rent, heartbeat } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { makeLease } from '../api/compute/lease.ts';
import { makeHeartbeat } from '../api/compute/heartbeat.ts';
import { makeQuotes } from '../api/compute/quotes.ts';
import { makeState } from '../api/compute/state.ts';
import { makeComputeWebhook } from '../api/compute/webhook.ts';
import { enqueueCleanup } from '../api/_lib/compute/cleanup.ts';
import { parsePrivateConfig } from '../api/_lib/compute/private-config.ts';
import { configJson } from './compute-helpers.ts';

const founder = generateKeys();
const name = 'rent5-fixture';
const team = deriveTeamId(founder.pubkey, name, T0);
const genesis = signEvent(founder, { v: PROTOCOL_VERSION, team, id: `${founder.nodeId}:1`, origin: founder.nodeId, seq: 1, ts: T0,
  author: { handle: 'alex', node: founder.nodeId }, kind: 'team.create', body: { name, owner_login: 'direct:alex', owner_handle: 'alex', node_hostname: 'founder', node_pubkey: founder.pubkey, node_ip: '127.0.0.1' } });
const proof = (keys = founder, chain: unknown[] = []) => ({ key: keys.pubkey, expires_at: T0 + 240_000,
  signature: keys.sign(ownershipMessage(team, T0 + 240_000)), genesis, authority_chain: chain });

test('E2: self-signed squat is refused; signed genesis enrolls actual team', async () => {
  const w = world();
  const squatter = generateKeys();
  await expect(createAccount(w.d, team, { key: squatter.pubkey, expires_at: T0 + 240_000,
    signature: squatter.sign(ownershipMessage(team, T0 + 240_000)) })).rejects.toThrow('team_ownership_required');
  await createAccount(w.d, team, proof());
  expect((await w.store.tx(t => t.enrollment(team)))?.key).toBe(founder.pubkey);
});

test('E1: license claim cannot replace a genesis-verified authority', async () => {
  const w = world();
  const victim = await createAccount(w.d, team, proof());
  await fund(w.store, victim.account_id, 50_000_000);
  const code = (await import('../../src/daemon/invite.ts')).createInvite(founder, { team, authority: founder.pubkey,
    handle: 'alex', role: 'member', now: T0, pos: 1, ttlMs: 3_600_000 }).code;
  const rental = await rent(w.d, victim.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }],
    codes: [code], walkie_version: 'v0.2.0-pre.7' });
  const id = rental.rentals[0]!.id;
  const token = (await w.store.tx(t => t.rental(id)))!.safety!.heartbeat_token!;
  await tick(w.d);
  await heartbeat(w.d, { rental_id: id, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 30, egress_bytes: 0 });
  const attacker = generateKeys();
  await expect(createAccount({ ...w.d, verifyLicense: async () => true }, team,
    { key: attacker.pubkey, expires_at: T0 + 240_000, signature: attacker.sign(ownershipMessage(team, T0 + 240_000)),
      lic_id: 'sub_attacker', renewal_token: 'R'.repeat(43), genesis })).rejects.toThrow('team_ownership_required');
  expect((await w.store.tx(t => t.enrollment(team)))?.key).toBe(founder.pubkey);
  w.advance(MIN);
  await tick(w.d);
  expect((await w.store.tx(t => t.rental(id)))!.state).toBe('running');
});

test('L1: paid rental survives a fourteen-minute tick gap', async () => {
  const w = world();
  const a = await createAccount(w.d, team, proof());
  await fund(w.store, a.account_id, 50_000_000);
  const code = (await import('../../src/daemon/invite.ts')).createInvite(founder, { team, authority: founder.pubkey, handle: 'alex', role: 'member', now: T0, pos: 1, ttlMs: 3_600_000 }).code;
  const result = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }], codes: [code], walkie_version: 'v0.2.0-pre.7' });
  const id = result.rentals[0]!.id;
  const token = (await w.store.tx(t => t.rental(id)))!.safety!.heartbeat_token!;
  await tick(w.d);
  await heartbeat(w.d, { rental_id: id, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 30, egress_bytes: 0 });
  w.advance(14 * MIN);
  await tick(w.d);
  expect((await w.store.tx(t => t.rental(id)))!.state).toBe('running');
});

test('C1P: another rental cleanup cannot block a paid guest lease', async () => {
  const w = world();
  const a = await createAccount(w.d, team, proof());
  await fund(w.store, a.account_id, 50_000_000);
  const code = (await import('../../src/daemon/invite.ts')).createInvite(founder, { team, authority: founder.pubkey, handle: 'alex', role: 'member', now: T0, pos: 1, ttlMs: 3_600_000 }).code;
  const result = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: 'agent', count: 1 }], codes: [code], walkie_version: 'v0.2.0-pre.7' });
  const id = result.rentals[0]!.id;
  const token = (await w.store.tx(t => t.rental(id)))!.safety!.heartbeat_token!;
  await tick(w.d);
  await w.store.tx(t => enqueueCleanup(t, 'fake', 'fake-stuck', 'other-rental'));
  w.cloud.terminate = async () => { throw new Error('persistent provider outage'); };
  const response = await makeLease({ env: {}, compute: () => w.d, stripe: () => null })(new Request('https://site.test/api/compute/lease', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ rental_id: id }) }));
  expect(response.status).toBe(200);
  const deps = { env: { COMPUTE_STRIPE_WEBHOOK_SECRET: 'whsec_fixture' }, compute: () => w.d, stripe: () => null };
  const beat = await makeHeartbeat(deps)(new Request('https://site.test/api/compute/heartbeat', { method: 'POST',
    body: JSON.stringify({ rental_id: id, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 30, egress_bytes: 0 }) }));
  expect(beat.status).toBe(200);
  expect((await makeQuotes(deps)(new Request('https://site.test/api/compute/quotes'))).status).toBe(200);
  expect((await makeState(deps)(new Request('https://site.test/api/compute/state',
    { headers: { authorization: `Bearer ${a.token}` } }))).status).toBe(200);
  expect((await makeComputeWebhook(deps)(new Request('https://site.test/api/compute/webhook',
    { method: 'POST', body: '{}' }))).status).toBe(400);
});

test('zero real-provider cost is invalid', () => {
  const config = JSON.parse(configJson(undefined, {}, 'digitalocean'));
  config.tiers.agent.cost_per_hour_micros = 0;
  expect(() => parsePrivateConfig(JSON.stringify(config))).toThrow('bad cost');
  config.tiers.agent.cost_per_hour_micros = 1;
  expect(() => parsePrivateConfig(JSON.stringify(config))).toThrow('bad cost');
});
