import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { accountForToken, rent } from '../api/_lib/compute/service.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { makeCredit } from '../api/compute/credit.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import * as M from '../api/_lib/metadata.ts';
const OP_SECRET = ("0123456789abcdef" + "0123456789abcdef");

test('operator actions fail closed and alert when the configured secret is short or absent', async () => {
  const w = C.world(), t = C.mkTeam('operator-secret');
  for (const env of [{}, { COMPUTE_HANDOVER_OPERATOR_SECRET: 'short' }]) {
    const handler = makeHandover({ env, compute: () => w.d, stripe: () => null } as any);
    const response = await handler(new Request('https://site.test/api/compute/handover', { method: 'POST',
      headers: { authorization: 'Bearer short' }, body: JSON.stringify({ team_id: t.team, action: 'complete' }) }));
    expect(response.status).toBe(503);
  }
  expect(w.logs).toContain('alert_handover_operator_secret_invalid');
});

const ev = (from: any, team: string, seq: number, kind: Parameters<typeof C.signEvent>[1]['kind'], body: any) => C.signEvent(from, { v: C.PROTOCOL_VERSION, team,
  id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq, ts: C.T0 + seq, author: { handle: 'alex', node: from.nodeId }, kind, body });
const step = (from: any, to: any, team: string, seq: number) => {
  const transfer = C.transfer(from, team, seq + 2, to);
  return { transfer, events: [ev(from, team, seq, 'team.member', { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' }),
    ev(from, team, seq + 1, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' }),
    transfer.event] };
};
const pend = (w: any, team: string) => w.store.tx((tx: any) => tx.control(`compute-handover:${team}`));
const op = (w: any) => {
  const h = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: OP_SECRET }, compute: () => w.d, stripe: () => null } as any);
  return (team: string, action: string, secret = OP_SECRET, chain_id?: string, proposed_key?: string) => h(new Request('https://site.test/api/compute/handover', { method: 'POST',
    headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ team_id: team, action, chain_id, proposed_key }) }));
};

test('B: selective clear approves the real rotation and keeps the rejected digest blocked', async () => {
  const w = C.world(), t = C.mkTeam('poc-b'), x = C.generateKeys(), g = C.generateKeys();
  await C.runningRental(w, t.f, t.team, t.genesis);
  const h1 = step(t.f, x, t.team, 7);
  const h1Proof = () => C.proof(x, t.team, w.clock.now, t.genesis, [h1.transfer], { roster_events: h1.events });
  await C.createAccount(w.d, t.team, h1Proof());
  const call = op(w);
  const firstHold = await pend(w, t.team);
  console.log('B reject H1:', (await call(t.team, 'reject', OP_SECRET, firstHold.proposed_chain.chainId, firstHold.proposed_key)).status);
  const logsBefore = w.logs.length;
  const legit = step(t.f, g, t.team, 30);
  const legitTry = await C.err(C.createAccount(w.d, t.team, C.proof(g, t.team, w.clock.now, t.genesis, [legit.transfer], { roster_events: legit.events })));
  console.log('B legit rotation F->G after rejection:', legitTry, '| log lines emitted:', JSON.stringify(w.logs.slice(logsBefore)));
  const legitChain = teamAuthority(t.team, { genesis: t.genesis, authority_chain: [legit.transfer], roster_events: legit.events })!;
  const rejectedChain = teamAuthority(t.team, { genesis: t.genesis, authority_chain: [h1.transfer], roster_events: h1.events })!;
  expect((await call(t.team, 'clear_rejection', OP_SECRET, rejectedChain.chainId, x.pubkey)).status).toBe(409);
  const clearRes = await call(t.team, 'clear_rejection', OP_SECRET, legitChain.chainId, g.pubkey);
  console.log('B clear_rejection:', clearRes.status, JSON.stringify(await clearRes.json()), '| log lines emitted by clear:', JSON.stringify(w.logs.slice(logsBefore)));
  const again = await C.err(C.createAccount(w.d, t.team, h1Proof()));
  const approved = await C.createAccount(w.d, t.team, C.proof(g, t.team, w.clock.now, t.genesis, [legit.transfer], { roster_events: legit.events }));
  const p = await pend(w, t.team);
  expect(clearRes.status).toBe(200);
  expect(w.logs).toContain('alert_handover_rejected_refusal');
  expect(w.logs).toContain('alert_handover_clear');
  expect(again).toBe('team_ownership_required');
  expect(approved.handover_pending).toBeDefined();
  expect(p.proposed_chain.chainId).toBe(legitChain.chainId);
});

test('C: license bind refuses a funded authority change before any hold', async () => {
  const w = C.world(), t = C.mkTeam('poc-c'), forger = C.generateKeys();
  await C.runningRental(w, t.f, t.team, t.genesis);
  const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
  const orig = teamAuthority(t.team, { genesis: t.genesis })!;
  const renewal = 'A'.repeat(43);
  const metadata = { [M.TEAM_META]: t.team, [M.AUTHORITY_META]: t.f.pubkey, [M.AUTHORITY_CHAIN_META]: orig.chainId,
    [M.AUTHORITY_DEPTH_META]: '0', ...M.authorityPathMetadata(orig.chain), [M.RENEW_HASH_META]: M.renewHash(renewal) };
  stripe.subs.set('sub_POCC', C.LH.subscription({ id: 'sub_POCC', metadata }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: 'sub_POCC', plan: 'team', seats: 7, email: 'fixture@example.test',
    interval: 'month', issued_at: C.LH.NOW, expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const fork = step(t.f, forger, t.team, 7), exp = C.LH.NOW + 240_000;
  const bind = C.makeBind({ ...C.LH.deps(stripe, { ...C.LH.fullEnv(signer.pem), COMPUTE_ENABLED: '1' }), computeStore: () => w.store });
  const res = await bind(new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: t.team,
    proof: { genesis: t.genesis, authority_chain: [fork.transfer], roster_events: fork.events, expires_at: exp,
      bind_signature: forger.sign(C.bindMessage(t.team, 'sub_POCC', exp)) } }) }));
  const body = await res.json();
  const after = stripe.subs.get('sub_POCC')!.metadata;
  console.log('C bind by forger with funded compute + no hold:', res.status, '| license key returned to forger:', typeof body.key === 'string',
    '| Stripe authority now forger:', after[M.AUTHORITY_META] === forger.pubkey, '| compute hold exists:', !!(await pend(w, t.team)));
  // The real F daemon's licensed compute enrollment now fails.
  w.d.verifyLicense = C.licenseVerifier(stripe);
  const fTry = await C.err(C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis, [], { lic_id: 'sub_POCC', renewal_token: renewal })));
  console.log('C legit F licensed createAccount afterwards:', fTry);
  expect(res.status).toBe(403);
  expect(after[M.AUTHORITY_META]).toBe(t.f.pubkey);
});

test('D: a $0 account with an open checkout cannot be adopted without a hold', async () => {
  const w = C.world(), t = C.mkTeam('poc-d'), forger = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  // Legit owner opens checkout (we only check the gate; no real Stripe call).
  const created: any[] = [];
  const credit = makeCredit({ env: { COMPUTE_ENABLED: '1' }, compute: () => w.d, stripe: () => ({ createCreditCheckout: async (p: any) => { created.push(p); return { url: 'https://checkout.test/x' }; } }) } as any);
  const cr = await credit(new Request('https://site.test/api/compute/credit', { method: 'POST', headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ block: 200 }) }));
  console.log('D legit checkout created:', cr.status, '| for account:', created[0]?.accountId === a.account_id);
  const fork = step(t.f, forger, t.team, 7);
  const hij = await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis, [fork.transfer], { roster_events: fork.events }));
  expect(hij.handover_pending).toBeDefined();
  console.log('D forger createAccount: handover_pending:', !!hij.handover_pending, '| adopted accounts:', hij.adopted_accounts?.length ?? (hij.account_id === a.account_id ? 1 : 0));
  // The customer finishes paying; the webhook credits the account the forger now holds.
  await C.applyCreditEvent(w.d, C.purchase(a.account_id, 200));
  const fAcct = await accountForToken(w.d, hij.token);
  const legitAcct = await accountForToken(w.d, a.token);
  const bal = await w.store.tx((tx: any) => tx.balance(a.account_id));
  console.log('D after payment: forger token account:', fAcct?.id === a.account_id, '| legit token:', legitAcct?.id ?? null, '| balance micros:', bal,
    '| handover alerts:', JSON.stringify(w.logs.filter((l: string) => l.includes('handover'))));
  expect(fAcct).toBeNull();
  expect(legitAcct?.id).toBe(a.account_id);
});

test('D2: a paid checkout freezes credit if authority changed after session creation', async () => {
  const w = C.world(), t = C.mkTeam('poc-d2'), other = C.generateKeys();
  const a = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  let attemptId = '';
  const credit = makeCredit({ env: { COMPUTE_ENABLED: '1' }, compute: () => w.d,
    stripe: () => ({ createCreditCheckout: async (p: any) => { attemptId = p.attemptId; return { url: 'https://checkout.test/x' }; } }) } as any);
  expect((await credit(new Request('https://site.test/api/compute/credit', { method: 'POST',
    headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ block: 50 }) }))).status).toBe(200);
  await w.store.tx((tx: any) => tx.setAccount(a.account_id, { owner_key: other.pubkey }));
  const ev = C.purchase(a.account_id, 50);
  (ev.data.object.metadata as any).walkie_checkout_attempt = attemptId;
  expect(await C.applyCreditEvent(w.d, ev)).toBe('frozen');
  expect(((await w.store.tx((tx: any) => tx.lockAccount(a.account_id))) as { status: string }).status).toBe('frozen');
});

test('E: operator resolves an old-key fork and restores the paying team', async () => {
  const w = C.world(), t = C.mkTeam('poc-e'), g = C.generateKeys(), x = C.generateKeys();
  // F -> G while unfunded (no hold), then G funds and runs.
  const moved = step(t.f, g, t.team, 2);
  const first = await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const gAcct = await C.createAccount(w.d, t.team, C.proof(g, t.team, w.clock.now, t.genesis, [moved.transfer], { roster_events: moved.events }));
  await C.applyCreditEvent(w.d, C.purchase(gAcct.account_id, 50));
  // Departed F signs a conflicting fork F -> X.
  const fork = step(t.f, x, t.team, 10);
  const r = await C.err(C.createAccount(w.d, t.team, C.proof(x, t.team, w.clock.now, t.genesis, [fork.transfer], { roster_events: fork.events })));
  const rentTry = await C.err(rent(w.d, gAcct.account_id, C.rreq(g, t.team, w.clock.now)));
  const credit = makeCredit({ env: { COMPUTE_ENABLED: '1' }, compute: () => w.d, stripe: () => ({ createCreditCheckout: async () => ({ url: 'x' }) }) } as any);
  const cr = await credit(new Request('https://site.test/api/compute/credit', { method: 'POST', headers: { authorization: `Bearer ${gAcct.token}` }, body: JSON.stringify({ block: 50 }) }));
  const call = op(w);
  const current = teamAuthority(t.team, { genesis: t.genesis, authority_chain: [moved.transfer], roster_events: moved.events })!;
  expect((await call(t.team, 'resolve_fork', OP_SECRET, '0'.repeat(64))).status).toBe(409);
  const resolved = await call(t.team, 'resolve_fork', OP_SECRET, current.chainId);
  expect(resolved.status).toBe(200);
  expect(w.logs).toContain('alert_authority_fork');
  expect(w.logs).toContain('alert_authority_fork_resolved');
  const rentAfter = await C.err(rent(w.d, gAcct.account_id, C.rreq(g, t.team, w.clock.now)));
  const crAfter = await credit(new Request('https://site.test/api/compute/credit', { method: 'POST',
    headers: { authorization: `Bearer ${gAcct.token}` }, body: JSON.stringify({ block: 50 }) }));
  expect(rentAfter).not.toBe('team_ownership_required');
  expect(crAfter.status).toBe(200);
  expect(await C.err(C.createAccount(w.d, t.team, C.proof(x, t.team, w.clock.now, t.genesis,
    [fork.transfer], { roster_events: fork.events })))).toBe('team_ownership_required');
  expect(await w.store.tx((tx: any) => tx.control(`enrollment-fork:${t.team}`))).toBeNull();
  const rejectedForks = await w.store.tx((tx: any) => tx.control(`enrollment-fork-rejected:${t.team}`)) as any[];
  const losing = teamAuthority(t.team, { genesis: t.genesis, authority_chain: [fork.transfer], roster_events: fork.events })!;
  expect(rejectedForks).toContainEqual({ digest: losing.chainId, predecessor_key: t.f.pubkey });
  expect(w.logs.filter((event: string) => event === 'alert_authority_fork_rejected')).toHaveLength(1);
  await C.err(C.createAccount(w.d, t.team, C.proof(x, t.team, w.clock.now, t.genesis,
    [fork.transfer], { roster_events: fork.events })));
  expect(w.logs.filter((event: string) => event === 'alert_authority_fork_rejected')).toHaveLength(1);
  const descendantKey = C.generateKeys(), descendant = step(x, descendantKey, t.team, 1);
  expect(await C.err(C.createAccount(w.d, t.team, C.proof(descendantKey, t.team, w.clock.now, t.genesis,
    [fork.transfer, descendant.transfer], { roster_events: [...fork.events, ...descendant.events] })))).toBe('team_ownership_required');
  expect(await w.store.tx((tx: any) => tx.control(`enrollment-fork:${t.team}`))).toBeNull();
  console.log('E old-key fork submit:', r, '| G rent:', rentTry, '| G credit checkout:', cr.status, JSON.stringify(await cr.json()),
    '| operator resolve status:', resolved.status, '| G rent after operator attempts:', rentAfter, '| first acct', !!first);
});

test('E2: operator selection of the conflicting branch enters a funded handover', async () => {
  const w = C.world(), t = C.mkTeam('poc-e2'), g = C.generateKeys(), x = C.generateKeys();
  const moved = step(t.f, g, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const gAcct = await C.createAccount(w.d, t.team, C.proof(g, t.team, w.clock.now, t.genesis,
    [moved.transfer], { roster_events: moved.events }));
  await C.applyCreditEvent(w.d, C.purchase(gAcct.account_id, 50));
  const fork = step(t.f, x, t.team, 10);
  expect(await C.err(C.createAccount(w.d, t.team, C.proof(x, t.team, w.clock.now, t.genesis,
    [fork.transfer], { roster_events: fork.events })))).toBe('team_ownership_required');
  const candidate = teamAuthority(t.team, { genesis: t.genesis, authority_chain: [fork.transfer], roster_events: fork.events })!;
  expect((await op(w)(t.team, 'resolve_fork', OP_SECRET, candidate.chainId)).status).toBe(200);
  expect((await pend(w, t.team)).proposed_chain.chainId).toBe(candidate.chainId);
  expect((await accountForToken(w.d, gAcct.token))?.id).toBe(gAcct.account_id);
});

test('C2: license bind refuses an operator-rejected transfer', async () => {
  const w = C.world(), t = C.mkTeam('poc-c2'), forger = C.generateKeys();
  await C.runningRental(w, t.f, t.team, t.genesis);
  const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
  const orig = teamAuthority(t.team, { genesis: t.genesis })!;
  stripe.subs.set('sub_POCC2', C.LH.subscription({ id: 'sub_POCC2', metadata: { [M.TEAM_META]: t.team, [M.AUTHORITY_META]: t.f.pubkey,
    [M.AUTHORITY_CHAIN_META]: orig.chainId, [M.AUTHORITY_DEPTH_META]: '0', ...M.authorityPathMetadata(orig.chain) } }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: 'sub_POCC2', plan: 'team', seats: 7, email: 'fixture@example.test',
    interval: 'month', issued_at: C.LH.NOW, expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const fork = step(t.f, forger, t.team, 7);
  await C.createAccount(w.d, t.team, C.proof(forger, t.team, w.clock.now, t.genesis, [fork.transfer], { roster_events: fork.events }));
  const held = await pend(w, t.team);
  console.log('C2 operator reject:', (await op(w)(t.team, 'reject', OP_SECRET, held.proposed_chain.chainId, held.proposed_key)).status);
  const exp = C.LH.NOW + 240_000;
  const bind = C.makeBind({ ...C.LH.deps(stripe, { ...C.LH.fullEnv(signer.pem), COMPUTE_ENABLED: '1' }), computeStore: () => w.store });
  const res = await bind(new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: t.team,
    proof: { genesis: t.genesis, authority_chain: [fork.transfer], roster_events: fork.events, expires_at: exp,
      bind_signature: forger.sign(C.bindMessage(t.team, 'sub_POCC2', exp)) } }) }));
  expect(res.status).toBe(403);
  expect(stripe.subs.get('sub_POCC2')!.metadata[M.AUTHORITY_META]).toBe(t.f.pubkey);
  console.log('C2 bind with the rejected chain:', res.status, '| Stripe authority now forger:', stripe.subs.get('sub_POCC2')!.metadata[M.AUTHORITY_META] === forger.pubkey);
});
