export { FakeCloud } from '../api/_lib/compute/fake-cloud.ts';
export { MemoryStore } from '../api/_lib/compute/memory-store.ts';
export { parsePrivateConfig } from '../api/_lib/compute/private-config.ts';
export { rent, state, heartbeat, stop, createAccount } from '../api/_lib/compute/service.ts';
export { tick } from '../api/_lib/compute/tick.ts';
export { applyCreditEvent } from '../api/_lib/compute/credit.ts';
export { ownershipMessage } from '../api/_lib/compute/ownership.ts';
export { licenseVerifier } from '../api/_lib/compute/license-proof.ts';
export { makeLease } from '../api/compute/lease.ts';
export { makeHeartbeat } from '../api/compute/heartbeat.ts';
export { makeComputeWebhook } from '../api/compute/webhook.ts';
export { makeQuotes } from '../api/compute/quotes.ts';
export { makeState } from '../api/compute/state.ts';
export { makeBind, bindMessage } from '../api/license/bind.ts';
export { signLicense, signingKeyFromPem } from '../api/_lib/license.ts';
export { generateKeys, signEvent } from '../../src/daemon/keys.ts';
export { deriveTeamId } from '../../src/protocol/ids.ts';
export { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
export { sweep } from '../../scripts/compute-watchdog.ts';
export { DigitalOceanDriver } from '../api/_lib/compute/digitalocean.ts';
export * as H from './compute-helpers.ts';
export * as LH from './helpers.ts';
export { createInvite } from '../../src/daemon/invite.ts';
import { FakeCloud } from '../api/_lib/compute/fake-cloud.ts';
import { MemoryStore } from '../api/_lib/compute/memory-store.ts';
import { parsePrivateConfig } from '../api/_lib/compute/private-config.ts';
import { rent, heartbeat, createAccount } from '../api/_lib/compute/service.ts';
import { tick } from '../api/_lib/compute/tick.ts';
import { applyCreditEvent } from '../api/_lib/compute/credit.ts';
import { ownershipMessage } from '../api/_lib/compute/ownership.ts';
import { generateKeys, signEvent } from '../../src/daemon/keys.ts';
import { deriveTeamId } from '../../src/protocol/ids.ts';
import { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
import { createInvite } from '../../src/daemon/invite.ts';
import * as H from './compute-helpers.ts';
export const { configJson, idem, T0, stripeTestHeader } = H;
export function world(cloud = new FakeCloud()) {
  const clock = { now: T0 };
  const store = new MemoryStore();
  void store.tx((t: any) => t.setControl("last_tick", T0));
  const logs: string[] = [];
  const d: any = { store, config: parsePrivateConfig(configJson({ cpu: 1000, gpu: 100 }, { team_authorities: {}, customer_teams: [] }, "digitalocean")),
    driver: (p: string) => (p === "digitalocean" ? cloud : null), now: () => clock.now, siteOrigin: "https://site.test",
    handoverTokenKey: 'rent-fixture-handover-key-32-bytes', log: (e: string) => logs.push(e) };
  return { d, store, clock, cloud, logs };
}
export function mkTeam(name: string) {
  const f = generateKeys();
  const team = deriveTeamId(f.pubkey, name, T0);
  const genesis = signEvent(f, { v: PROTOCOL_VERSION, team, id: `${f.nodeId}:1`, origin: f.nodeId, seq: 1, ts: T0,
    author: { handle: "alex", node: f.nodeId }, kind: "team.create",
    body: { name, owner_login: "direct:alex", owner_handle: "alex", node_hostname: "founder", node_pubkey: f.pubkey, node_ip: "127.0.0.1" } });
  return { f, team, genesis };
}
export const transfer = (from: any, team: string, seq: number, to: any) => ({ key: to.pubkey, event: signEvent(from, {
  v: PROTOCOL_VERSION, team, id: `${from.nodeId}:${seq}`, origin: from.nodeId, seq, ts: T0 + seq,
  author: { handle: "alex", node: from.nodeId }, kind: "team.authority", body: { node_id: to.nodeId } }) });
export const proof = (keys: any, team: string, now: number, genesis?: any, chain: any[] = [], extra: any = {}) => ({ key: keys.pubkey,
  expires_at: now + 240_000, signature: keys.sign(ownershipMessage(team, now + 240_000)),
  ...(genesis ? { genesis, authority_chain: chain } : {}), ...extra });
export const purchase = (account: string, block: number) => { const s = `cs_${idem()}`; return { id: `evt_${idem()}`, type: "checkout.session.completed", livemode: true,
  data: { object: { id: s, mode: "payment", payment_status: "paid", currency: "usd", amount_total: block * 100, payment_intent: `pi_${s}`, metadata: { walkie_compute_account: account, walkie_credit_usd: String(block) } } } }; };
export const invite = (keys: any, team: string, now: number) => createInvite(keys, { team, authority: keys.pubkey, handle: "x", role: "member", now, pos: 1, ttlMs: 3_600_000 }).code;
export const rreq = (keys: any, team: string, now: number) => ({ idempotency_key: idem(), machines: [{ tier: "agent" as const, count: 1 }], codes: [invite(keys, team, now)], walkie_version: "v0.2.0-pre.7" });
export const tokOf = (ud: string) => /printf '%s' '([A-Za-z0-9_-]{43})' > \/etc\/walkie-rental\/heartbeat-token/.exec(ud)![1]!;

/** Enroll `keys` with the given chain, buy $block live credit, rent one agent, launch it, first heartbeat. */
export async function runningRental(w: any, keys: any, team: string, genesis: any, chain: any[] = [], block = 50) {
  const a = await createAccount(w.d, team, proof(keys, team, w.clock.now, genesis, chain));
  await applyCreditEvent(w.d, purchase(a.account_id, block));
  const r = await rent(w.d, a.account_id, rreq(keys, team, w.clock.now));
  await tick(w.d);
  const rid = r.rentals[0]!.id;
  const tok = tokOf(w.cloud.provisions[w.cloud.provisions.length - 1]!.user_data);
  await heartbeat(w.d, { rental_id: rid, token: tok, busy_seats: 1, pool_jobs: 0, cpu_pct: 50, egress_bytes: 0, node_id: "1111111111111111" });
  return { a, rid, tok };
}
export const beat = (w: any, x: any) => heartbeat(w.d, { rental_id: x.rid, token: x.tok, busy_seats: 1, pool_jobs: 0, cpu_pct: 50, egress_bytes: 0 });
export const row = (w: any, id: string) => w.store.tx((t: any) => t.rental(id));
export async function err(p: Promise<unknown>): Promise<string> { try { await p; return "ok"; } catch (e: any) { return e.code ?? e.message; } }
