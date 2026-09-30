import { expect, test } from 'bun:test';
import * as Fixtures from './rent6-fixtures.ts';
import { accountForToken, rent } from '../api/_lib/compute/service.ts';
import { HANDOVER_MS, handoverKey, rejectHandover, rejectedHandoverDigest } from '../api/_lib/compute/handover.ts';
import { makeHandover } from '../api/compute/handover.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';
import * as M from '../api/_lib/metadata.ts';

const C: any = Fixtures;
const SECRET = ("0123456789abcdef0123" + "456789abcdef-probe15");
const ev = (from: any, team: string, seq: number, kind: string, body: any) => C.signEvent(from, { v: C.PROTOCOL_VERSION, team,
  id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq, ts: C.T0 + seq, author: { handle: 'alex', node: from.nodeId }, kind, body });
const step = (from: any, to: any, team: string, seq: number) => {
  const transfer = C.transfer(from, team, seq + 2, to);
  return { transfer, events: [ev(from, team, seq, 'team.member', { login: `direct:${to.nodeId}`, handle: 'next', role: 'owner' }),
    ev(from, team, seq + 1, 'team.node', { node_id: to.nodeId, login: `direct:${to.nodeId}`, hostname: 'next', pubkey: to.pubkey, ip: '127.0.0.1' }),
    transfer.event] };
};
const chainOf = (team: string, genesis: any, steps: any[]) => teamAuthority(team, { genesis, authority_chain: steps.map(s => s.transfer),
  roster_events: steps.flatMap(s => s.events) })!;
const proofFor = (w: any, key: any, t: any, steps: any[], genesis = t.genesis) => C.proof(key, t.team, w.clock.now, genesis, steps.map(s => s.transfer),
  { roster_events: steps.flatMap(s => s.events) });
const pend = (w: any, team: string) => w.store.tx((tx: any) => tx.control(handoverKey(team)));
const ctl = (w: any, key: string) => w.store.tx((tx: any) => tx.control(key));
const forked = async (w: any, team: string) => typeof await ctl(w, `enrollment-fork:${team}`) === 'number';
const fresh = (w: any) => w.store.tx((tx: any) => tx.setControl('last_tick', w.clock.now));
const op = (w: any) => {
  const h = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: SECRET }, compute: () => w.d, stripe: () => null } as any);
  return async (team: string, action: string, chain_id?: string, proposed_key?: string) => {
    const r = await h(new Request('https://site.test/api/compute/handover', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ team_id: team, action, chain_id, proposed_key }) }));
    return r.status;
  };
};
const rentTry = async (w: any, acct: string, key: any, team: string) => { await fresh(w); return C.err(rent(w.d, acct, C.rreq(key, team, w.clock.now))); };
function licenseFixture(w: any, team: string, lic: string, meta: Record<string, string>, computeEnabled = true) {
  const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
  stripe.subs.set(lic, C.LH.subscription({ id: lic, metadata: { ...meta } }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7, email: 'fixture@example.test',
    interval: 'month', issued_at: C.LH.NOW, expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const env = { ...C.LH.fullEnv(signer.pem), ...(computeEnabled ? { COMPUTE_ENABLED: '1' } : {}) };
  const bind = C.makeBind({ ...C.LH.deps(stripe, env), computeStore: () => w.store });
  return {
    stripe,
    meta: () => stripe.subs.get(lic)!.metadata,
    submit: async (signerKey: any, genesis: any, steps: any[]) => {
      const exp = C.LH.NOW + 240_000;
      const r = await bind(new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({ code, team_id: team,
        proof: { genesis, authority_chain: steps.map(s => s.transfer), roster_events: steps.flatMap(s => s.events), expires_at: exp,
          bind_signature: signerKey.sign(C.bindMessage(team, lic, exp)) } }) }));
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  };
}

test('approved fork moves the bound license only to the chosen chain', async () => {
  const { w, t, g, current } = await rotatedFunded('rent17-approved-fork');
  const lic = licenseFixture(w, t.team, ("sub_" + 'RENT17FORK'), boundTo(t.team, g.pubkey, current));
  const h = C.generateKeys(), branch = step(t.f, h, t.team, 30);
  const chosen = chainOf(t.team, t.genesis, [branch]);
  expect(await C.err(C.createAccount(w.d, t.team, proofFor(w, h, t, [branch])))).toBe('team_ownership_required');
  const operator = makeHandover({ env: { COMPUTE_HANDOVER_OPERATOR_SECRET: SECRET }, compute: () => w.d,
    stripe: () => null, licenseStripe: () => lic.stripe } as any);
  const action = async (name: string) => (await operator(new Request('https://site.test/api/compute/handover', {
    method: 'POST', headers: { authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ team_id: t.team, action: name, chain_id: chosen.chainId, proposed_key: h.pubkey }),
  }))).status;
  expect(await action('resolve_fork')).toBe(200);
  w.clock.now += HANDOVER_MS;
  expect(await action('complete')).toBe(200);
  expect((await lic.submit(h, t.genesis, [branch])).status).toBe(200);
  expect(lic.meta()[M.AUTHORITY_META]).toBe(h.pubkey);
  expect(lic.meta()[M.AUTHORITY_CHAIN_META]).toBe(chosen.chainId);
});
const boundTo = (team: string, key: string, chain: any) => ({ [M.TEAM_META]: team, [M.AUTHORITY_META]: key,
  [M.AUTHORITY_CHAIN_META]: chain.chainId, [M.AUTHORITY_DEPTH_META]: String(chain.depth), ...M.authorityPathMetadata(chain.chain) });
// A second, validly signed genesis for the SAME team id (same founder key, name and ts; different hostname).
const altGenesis = (t: any, n: number) => C.signEvent(t.f, { v: C.PROTOCOL_VERSION, team: t.team, id: `${t.f.nodeId}:1`, origin: t.f.nodeId,
  seq: 1, ts: C.T0, author: { handle: 'alex', node: t.f.nodeId }, kind: 'team.create',
  body: { name: t.name, owner_login: 'direct:alex', owner_handle: 'alex', node_hostname: `founder-alt-${n}`, node_pubkey: t.f.pubkey, node_ip: '127.0.0.1' } });
function team(name: string) { return { ...C.mkTeam(name), name }; }

/** F founds; F -> G rotation while unfunded (automatic); G's account then funded with $1000. Stored chain [genesis, G]. */
async function rotatedFunded(name: string) {
  const w = C.world(), t = team(name), g = C.generateKeys(), call = op(w);
  const moved = step(t.f, g, t.team, 2);
  await C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, t.genesis));
  const gAcct = await C.createAccount(w.d, t.team, proofFor(w, g, t, [moved]));
  await C.applyCreditEvent(w.d, C.purchase(gAcct.account_id, 1000));
  return { w, t, g, call, moved, gAcct, current: chainOf(t.team, t.genesis, [moved]) };
}

// ------------------------------------------------------------------ F-1 re-check: alternate-genesis forks by the founder key
test('P15-1 the old founder key re-freezes a paying team with a fresh alternate genesis after every resolve_fork', async () => {
  const { w, t, g, call, gAcct, current } = await rotatedFunded('p15-altgen');
  expect(teamAuthority(t.team, { genesis: altGenesis(t, 1) })?.key).toBe(t.f.pubkey);
  const rounds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const r = await C.err(C.createAccount(w.d, t.team, C.proof(t.f, t.team, w.clock.now, altGenesis(t, i))));
    const frozen = await forked(w, t.team);
    const gRent = await rentTry(w, gAcct.account_id, g, t.team);
    const resolved = await call(t.team, 'resolve_fork', current.chainId);
    rounds.push(`round ${i}: createAccount=${r} fork_flag=${frozen} G_rent=${gRent} resolve_fork(current)=${resolved}`);
  }
  const rejected = await ctl(w, `enrollment-fork-rejected:${t.team}`);
  console.log('P15-1', rounds.join(' || '), '| fork-rejected entries:', rejected?.length,
    '| predecessor recorded is F:', rejected?.every((r: any) => r.predecessor_key === t.f.pubkey),
    '| fork alerts:', w.logs.filter((l: string) => l === 'alert_authority_fork').length);
  // Also through /api/license/bind with a license bound to this team.
  const lic = licenseFixture(w, t.team, 'sub_P15ALT', boundTo(t.team, g.pubkey, current));
  const b = await lic.submit(t.f, altGenesis(t, 9), []);
  console.log('P15-1 bind with alternate genesis #9:', b.status, '| fork flag set:', await forked(w, t.team));
  expect(rounds.slice(1).every(r => r.includes('fork_flag=false'))).toBe(true);
  expect(b.status).toBe(403);
  expect(await forked(w, t.team)).toBe(false);
});

// ------------------------------------------------------------------ rejected handover digest re-freezes as a fork
test('P15-2 an operator-REJECTED handover proof re-freezes the team as a fork after the legitimate rotation completes', async () => {
  const w = C.world(), t = team('p15-rej-refork'), x = C.generateKeys(), g = C.generateKeys(), call = op(w);
  const live = await C.runningRental(w, t.f, t.team, t.genesis, [], 1000);
  const hij = step(t.f, x, t.team, 2), xChain = chainOf(t.team, t.genesis, [hij]);
  await C.createAccount(w.d, t.team, proofFor(w, x, t, [hij]));
  const rej = await call(t.team, 'reject', xChain.chainId, x.pubkey);
  const legit = step(t.f, g, t.team, 30), gChain = chainOf(t.team, t.genesis, [legit]);
  const clr = await call(t.team, 'clear_rejection', gChain.chainId, g.pubkey);
  const gHold = await C.createAccount(w.d, t.team, proofFor(w, g, t, [legit]));
  w.clock.now += HANDOVER_MS;
  const done = await call(t.team, 'complete', gChain.chainId, g.pubkey);
  const gOwns = (await accountForToken(w.d, gHold.token))?.id === live.a.account_id;
  const before = await rentTry(w, live.a.account_id, g, t.team);
  // Exercise rejection state written before the dedicated digest index existed.
  await w.store.tx((tx: any) => tx.setControl(`compute-handover-rejected-digests:${t.team}`, null));
  const replay = await C.err(C.createAccount(w.d, t.team, proofFor(w, x, t, [hij])));
  const frozen = await forked(w, t.team);
  const after = await rentTry(w, live.a.account_id, g, t.team);
  console.log('P15-2 reject(X):', rej, '| clear(G):', clr, '| complete(G):', done, '| G owns:', gOwns, '| G rent before replay:', before,
    '|| replay of the REJECTED F->X proof:', replay, '| fork flag set:', frozen, '| G rent after replay:', after,
    '| X digest in compute-handover-rejected:', (await ctl(w, `compute-handover-rejected:${t.team}`))?.includes(xChain.chainId));
  expect(frozen).toBe(false);
  const license = licenseFixture(w, t.team, ("sub_" + 'P15REJECT'), boundTo(t.team, g.pubkey, gChain));
  expect((await license.submit(x, t.genesis, [hij])).status).toBe(403);
  expect(await forked(w, t.team)).toBe(false);
  expect(license.meta()[M.AUTHORITY_META]).toBe(g.pubkey);
});

// ------------------------------------------------------------------ resolve_fork(keep candidate) on a descendant of a rejected digest
test('P15-3 resolve_fork(keep candidate) opens a hold for a DESCENDANT of an operator-rejected transfer', async () => {
  const w = C.world(), t = team('p15-rej-desc'), x = C.generateKeys(), x2 = C.generateKeys(), g = C.generateKeys(), call = op(w);
  const live = await C.runningRental(w, t.f, t.team, t.genesis, [], 1000);
  const hij = step(t.f, x, t.team, 2), xChain = chainOf(t.team, t.genesis, [hij]);
  await C.createAccount(w.d, t.team, proofFor(w, x, t, [hij]));
  await call(t.team, 'reject', xChain.chainId, x.pubkey);
  const legit = step(t.f, g, t.team, 30), gChain = chainOf(t.team, t.genesis, [legit]);
  await call(t.team, 'clear_rejection', gChain.chainId, g.pubkey);
  await C.createAccount(w.d, t.team, proofFor(w, g, t, [legit]));
  w.clock.now += HANDOVER_MS;
  expect(await call(t.team, 'complete', gChain.chainId, g.pubkey)).toBe(200);
  const desc = [hij, step(x, x2, t.team, 2)], dChain = chainOf(t.team, t.genesis, desc);
  const r = await C.err(C.createAccount(w.d, t.team, proofFor(w, x2, t, desc)));
  const frozen = await forked(w, t.team);
  // Recreate a fork already recorded before the rejection check, exercising resolveFork itself.
  await w.store.tx(async (tx: any) => {
    await tx.setControl(`enrollment-fork:${t.team}`, w.clock.now);
    await tx.setControl(`enrollment-fork-candidate:${t.team}`, {
      chain: dChain, roster: { genesis: t.genesis, authority_chain: desc.map(s => s.transfer),
        roster_events: desc.flatMap(s => s.events) },
    });
  });
  const keep = await call(t.team, 'resolve_fork', dChain.chainId);
  const p = await pend(w, t.team);
  console.log('P15-3 F->X(rejected)->X2 after G completed:', r, '| fork flag:', frozen, '| operator resolve_fork(keep X2):', keep,
    '| hold opened for X2 (descendant of rejected X):', p?.proposed_key === x2.pubkey, '| account still G:', (await w.store.tx((tx: any) => tx.lockAccount(live.a.account_id))).owner_key === g.pubkey);
  expect(p?.proposed_key === x2.pubkey).toBe(false);
});

test('rejecting an equal-chain legacy proposal does not reject the shared genesis', async () => {
  const w = C.world(), t = team('rent16-equal-rejection');
  const root = teamAuthority(t.team, { genesis: t.genesis })!;
  await w.store.tx(async (tx: any) => tx.setControl(handoverKey(t.team), {
    old_chain: root, proposed_chain: root, proposed_key: t.f.pubkey,
  }));
  expect(await w.store.tx((tx: any) => rejectHandover(w.d, tx, t.team, root.chainId, t.f.pubkey))).toBe(true);
  expect(await w.store.tx((tx: any) => rejectedHandoverDigest(tx, t.team, root))).toBeNull();
});

test('disabled compute refuses a fork without writing fork controls', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const w = C.world(), t = team('rent21-fork-off'), g = C.generateKeys(), h = C.generateKeys();
    const kept = step(t.f, g, t.team, 2), candidate = step(t.f, h, t.team, 20);
    const keptChain = chainOf(t.team, t.genesis, [kept]);
    await w.store.tx((tx: any) => tx.setControl(`enrollment-chain:${t.team}`, keptChain));
    const lic = licenseFixture(w, t.team, ("sub_" + 'RENT21_FORK_OFF'), boundTo(t.team, g.pubkey, keptChain), false);
    expect((await lic.submit(h, t.genesis, [candidate])).status).toBe(403);
    expect(await ctl(w, `enrollment-fork:${t.team}`)).toBeUndefined();
    expect(await ctl(w, `enrollment-fork-candidate:${t.team}`)).toBeUndefined();
    expect(lic.meta()[M.AUTHORITY_META]).toBe(g.pubkey);
  } finally { globalThis.fetch = previous; }
});
