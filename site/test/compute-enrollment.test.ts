import { test, expect } from 'bun:test';
import { generateKeys, signEvent } from '../../src/daemon/keys.ts';
import { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
import { world, configJson, T0, fixtureKeys, fixtureTeam, fixtureGenesis, codes, idem } from './compute-helpers.ts';
import { parsePrivateConfig } from '../api/_lib/compute/private-config.ts';
import { createAccount, accountForToken, rent } from '../api/_lib/compute/service.ts';
import { ownershipMessage } from '../api/_lib/compute/ownership.ts';

const team = fixtureTeam;
const signed = (keys = fixtureKeys, authority_chain: unknown[] = [], roster_events: unknown[] = []) => ({ key: keys.pubkey, expires_at: T0 + 240_000,
  signature: keys.sign(ownershipMessage(team, T0 + 240_000)), genesis: fixtureGenesis, authority_chain, roster_events });
const setup = (internal = false) => world({ config: parsePrivateConfig(configJson(undefined,
  { team_authorities: {}, customer_teams: [], internal_teams: internal ? [team] : [] }, 'digitalocean')) });
const transfer = (from: typeof fixtureKeys, to: typeof fixtureKeys, seq: number) => ({ key: to.pubkey,
  event: signEvent(from, { v: PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq, ts: T0 + seq,
    author: { handle: 'alex', node: from.nodeId }, kind: 'team.authority', body: { node_id: to.nodeId } }) });
const admit = (from: typeof fixtureKeys, to: typeof fixtureKeys, seq: number) => [
  signEvent(from, { v: PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq, ts: T0 + seq,
    author: { handle: 'alex', node: from.nodeId }, kind: 'team.member', body: { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' } }),
  signEvent(from, { v: PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq + 1}`, origin: from.nodeId, seq: seq + 1, ts: T0 + seq + 1,
    author: { handle: 'alex', node: from.nodeId }, kind: 'team.node', body: { node_id: to.nodeId, login: `direct:${to.nodeId}`,
      hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' } }),
];

test('signed roster genesis enrolls and classifies a customer', async () => {
  const w = setup();
  const a = await createAccount(w.d, team, signed());
  expect((await accountForToken(w.d, a.token))?.classification).toBe('customer');
  expect(await w.store.tx(t => t.enrollment(team))).toMatchObject({ key: fixtureKeys.pubkey, source: 'roster' });
});

test('missing, forged, expired, and self-signed team claims cannot enroll', async () => {
  const w = setup(); const rogue = generateKeys();
  for (const p of [undefined, { ...signed(), signature: 'forged' }, { ...signed(), expires_at: T0 - 1 },
    { ...signed(rogue), genesis: undefined }, { ...signed(rogue) }])
    await expect(createAccount(w.d, team, p)).rejects.toThrow('team_ownership_required');
  expect(await w.store.tx(t => t.enrollment(team))).toBeNull();
});

test('a signed authority chain rotates enrollment; old chain cannot roll it back', async () => {
  const w = setup(); const next = generateKeys();
  await createAccount(w.d, team, signed());
  const chain = [transfer(fixtureKeys, next, 4)];
  await createAccount(w.d, team, signed(next, chain, [...admit(fixtureKeys, next, 2), chain[0]!.event]));
  expect((await w.store.tx(t => t.enrollment(team)))?.key).toBe(next.pubkey);
  await expect(createAccount(w.d, team, signed())).rejects.toThrow('team_ownership_required');
  await expect(createAccount(w.d, team, signed(generateKeys(), chain))).rejects.toThrow('team_ownership_required');
  const forged = [transfer(generateKeys(), generateKeys(), 2)];
  await expect(createAccount(w.d, team, signed(next, forged))).rejects.toThrow('team_ownership_required');
});

test('a longer conflicting authority branch cannot replace the accepted team chain', async () => {
  const w = setup();
  const next = generateKeys(), rogue = generateKeys(), rogue2 = generateKeys();
  await createAccount(w.d, team, signed());
  const legit = transfer(fixtureKeys, next, 4);
  await createAccount(w.d, team, signed(next, [legit], [...admit(fixtureKeys, next, 2), legit.event]));
  const first = transfer(fixtureKeys, rogue, 5), second = transfer(rogue, rogue2, 4);
  await expect(createAccount(w.d, team, signed(rogue2, [first, second],
    [...admit(fixtureKeys, rogue, 2), first.event, ...admit(rogue, rogue2, 2), second.event])))
    .rejects.toThrow('team_ownership_required');
  expect((await w.store.tx(t => t.enrollment(team)))?.key).toBe(next.pubkey);
});

test('an unadmitted target cannot receive authority', async () => {
  const w = setup(), rogue = generateKeys();
  await expect(createAccount(w.d, team, signed(rogue, [transfer(fixtureKeys, rogue, 2)])))
    .rejects.toThrow('team_ownership_required');
});

test('E2: a valid genesis recovers an old TOFU squat', async () => {
  const w = setup(); const rogue = generateKeys();
  await w.store.tx(t => t.setEnrollment({ team_id: team, key: rogue.pubkey, source: 'tofu', updated_at: T0 - 1 }));
  await createAccount(w.d, team, signed());
  expect(await w.store.tx(t => t.enrollment(team))).toMatchObject({ key: fixtureKeys.pubkey, source: 'roster' });
});

test('license claim cannot replace roster proof; verifier outage leaves enrollment intact', async () => {
  const w = setup(); const rogue = generateKeys();
  await createAccount(w.d, team, signed());
  await expect(createAccount({ ...w.d, verifyLicense: async () => true }, team,
    { ...signed(rogue), lic_id: 'sub_fixture', renewal_token: 'R'.repeat(43) })).rejects.toThrow('team_ownership_required');
  await expect(createAccount({ ...w.d, verifyLicense: async () => { throw new Error('network'); } }, team,
    { ...signed(), lic_id: 'sub_fixture', renewal_token: 'R'.repeat(43) })).rejects.toThrow('license_verification_unavailable');
  expect((await w.store.tx(t => t.enrollment(team)))?.key).toBe(fixtureKeys.pubkey);
});

test('license recovery requires an active subscription bound to the same authority', async () => {
  const { licenseVerifier } = await import('../api/_lib/compute/license-proof.ts');
  const { renewHash } = await import('../api/_lib/metadata.ts');
  const token = 'R'.repeat(43);
  const sub = { id: 'sub_fixture', status: 'active', customer: 'cus_fixture', items: { data: [] },
    metadata: { walkie_team: team, walkie_authority: fixtureKeys.pubkey, walkie_renew_hash: renewHash(token) } };
  const verify = licenseVerifier({ getSubscription: async () => sub });
  expect(await verify(team, sub.id, token, fixtureKeys.pubkey)).toBe(true);
  expect(await verify(team, sub.id, token, generateKeys().pubkey)).toBe(false);
  sub.status = 'canceled';
  expect(await verify(team, sub.id, token, fixtureKeys.pubkey)).toBe(false);
});

test('internal classification and paid credit remain admission gates', async () => {
  const internal = setup(true); const a = await createAccount(internal.d, team, signed());
  expect((await accountForToken(internal.d, a.token))?.classification).toBe('internal');
  const w = setup(); const customer = await createAccount(w.d, team, signed());
  const req = () => ({ idempotency_key: idem(), machines: [{ tier: 'agent' as const, count: 1 }], codes: codes(1), walkie_version: 'v0.2.0-pre.5' });
  await w.store.tx(t => t.addLedger({ account_id: customer.account_id, kind: 'adjustment', amount_micros: 50_000_000, idem_key: idem(), created_at: T0 }));
  await expect(rent(w.d, customer.account_id, req())).rejects.toThrow('insufficient_credit');
  await w.store.tx(t => t.addLedger({ account_id: customer.account_id, kind: 'purchase', live: true, amount_micros: 50_000_000, idem_key: idem(), created_at: T0 }));
  expect((await rent(w.d, customer.account_id, req())).started).toBe(1);
});
