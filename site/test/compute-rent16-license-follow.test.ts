import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import * as M from '../api/_lib/metadata.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import { HANDOVER_MS } from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';

test('P15-4 approved funded handover permits one exact license transition', async () => {
  const w = C.world(), team = C.mkTeam('rent16-license-follow'), g = C.generateKeys(), h = C.generateKeys();
  const original = await C.createAccount(w.d, team.team, C.proof(team.f, team.team, w.clock.now, team.genesis));
  await C.applyCreditEvent(w.d, C.purchase(original.account_id, 50));
  const root = teamAuthority(team.team, { genesis: team.genesis })!;
  const lic = ("sub_" + 'RENT16FOLLOW'), second = ("sub_" + 'RENT16SECOND');
  const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
  for (const id of [lic, second]) stripe.subs.set(id, C.LH.subscription({ id, metadata: { [M.TEAM_META]: team.team,
    [M.AUTHORITY_META]: team.f.pubkey, [M.AUTHORITY_CHAIN_META]: root.chainId,
    [M.AUTHORITY_DEPTH_META]: '0', ...M.authorityPathMetadata(root.chain) } }));
  const wrongBranch = ("sub_" + 'RENT16WRONGBRANCH');
  stripe.subs.set(wrongBranch, C.LH.subscription({ id: wrongBranch, metadata: { [M.TEAM_META]: team.team,
    [M.AUTHORITY_META]: team.f.pubkey, [M.AUTHORITY_CHAIN_META]: 'f'.repeat(64),
    [M.AUTHORITY_DEPTH_META]: '0' } }));
  const codeFor = (id: string) => C.signLicense({ v: 2, kind: 'activation', lic_id: id, plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
    expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const bind = C.makeBind({ ...C.LH.deps(stripe, { ...C.LH.fullEnv(signer.pem), COMPUTE_ENABLED: '1' }),
    computeStore: () => w.store });
  const step = (from: ReturnType<typeof C.generateKeys>, to: ReturnType<typeof C.generateKeys>, seq: number) => {
    const event = (n: number, kind: 'team.member' | 'team.node', body: Record<string, unknown>) => C.signEvent(from, {
      v: C.PROTOCOL_VERSION, team: team.team, id: `${from.nodeId}:${n}`, origin: from.nodeId, seq: n,
      ts: C.T0 + n, author: { handle: 'alex', node: from.nodeId }, kind, body });
    const transfer = C.transfer(from, team.team, seq + 2, to);
    return { transfer, events: [event(seq, 'team.member', { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' }),
      event(seq + 1, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' }),
      transfer.event] };
  };
  const gStep = step(team.f, g, 2);
  const gRoster = { genesis: team.genesis, authority_chain: [gStep.transfer], roster_events: gStep.events };
  const gChain = teamAuthority(team.team, gRoster)!;
  const gAccount = await C.createAccount(w.d, team.team,
    C.proof(g, team.team, w.clock.now, team.genesis, [gStep.transfer], { roster_events: gStep.events }));
  expect(gAccount.handover_pending).toBeDefined();
  const secret = ("0123456789abcdef01" + "23456789abcdef-test");
  const operator = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: secret }, compute: () => w.d,
    stripe: () => null, licenseStripe: () => stripe } as any);
  w.clock.now += HANDOVER_MS;
  const complete = await operator(new Request('https://site.test/api/compute/handover', { method: 'POST',
    headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ team_id: team.team,
      action: 'complete', chain_id: gChain.chainId, proposed_key: g.pubkey }) }));
  expect(complete.status).toBe(200);
  const late = ("sub_" + 'RENT16LATE');
  stripe.subs.set(late, C.LH.subscription({ id: late, metadata: { [M.TEAM_META]: team.team,
    [M.AUTHORITY_META]: team.f.pubkey, [M.AUTHORITY_CHAIN_META]: root.chainId,
    [M.AUTHORITY_DEPTH_META]: '0', ...M.authorityPathMetadata(root.chain) } }));
  const submit = async (id: string, key: ReturnType<typeof C.generateKeys>, steps: ReturnType<typeof step>[]) => {
    const exp = C.LH.NOW + 240_000;
    return (await bind(new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({
      code: codeFor(id), team_id: team.team, proof: { genesis: team.genesis, authority_chain: steps.map(s => s.transfer),
        roster_events: steps.flatMap(s => s.events), expires_at: exp,
        bind_signature: key.sign(C.bindMessage(team.team, id, exp)) },
    }) }))).status;
  };
  expect(await submit(lic, g, [gStep])).toBe(200);
  expect(stripe.subs.get(lic)!.metadata[M.AUTHORITY_META]).toBe(g.pubkey);
  expect(await w.store.tx(tx => tx.control(`compute-license-transition:${team.team}`))).not.toBeNull();
  expect(await submit(late, g, [gStep])).toBe(403);
  expect(await submit(wrongBranch, g, [gStep])).toBe(403);
  expect(await submit(second, g, [gStep])).toBe(200);
  expect(stripe.subs.get(second)!.metadata[M.AUTHORITY_META]).toBe(g.pubkey);
  expect(await w.store.tx(tx => tx.control(`compute-license-transition:${team.team}`))).toBeNull();
  expect(await submit(lic, team.f, [])).toBe(403);
  const hStep = step(g, h, 2);
  expect(await submit(lic, h, [gStep, hStep])).toBe(403);
  expect(stripe.subs.get(lic)!.metadata[M.AUTHORITY_META]).toBe(g.pubkey);
});
