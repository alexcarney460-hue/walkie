// WALK-107 r5 review LOW-1 (ported from the reviewer probe RV5R-AC1): the authority can change while a sync round is
// awaited. The round then said nothing about the authority the spend would go to, so the queued invite spend waits for
// that authority's own round instead of being rebuilt from a stale record that would undo its newer pin. Fictional names.
import { afterEach, expect, test } from "bun:test";
import { PeerCallError, type PeerAddr, type PeerClient } from "../../src/daemon/peer-client.ts";
import { applyRequest, flushRequests, signRequest } from "../../src/daemon/requests.ts";
import { endpointHex, transportFields } from "../../src/daemon/roster.ts";
import { SyncManager } from "../../src/daemon/sync.ts";
import type { Event, RosterRequest } from "../../src/protocol/schemas.ts";
import type { Core } from "../../src/daemon/core.ts";
import { makeCore } from "../helpers/core.ts";
import { tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rows = (c: Core, origin: string, after: number): Event[] =>
  c.store.rowsForSync(origin, after, c.store.vvOf(origin), 5000).map((r) => JSON.parse(r.json) as Event);

function feed(to: Core, from: Core): void {
  for (const o of Object.keys(from.store.vv())) for (const ev of rows(from, o, to.store.vvOf(o))) to.ingest(ev, "remote");
  to.drainPending();
}

test("an authority handed over while a round is awaited: the spend is not sent from the stale record, so the new authority's pin stays", async () => {
  const bea = tnode("bea"), alex = tnode("alex"), kira = tnode("kira");
  const authority = makeCore(bea, "0000000000000000", cleanups);
  authority.store.deleteMeta("team");
  authority.createTeam("acme", "bea", { login: bea.login });
  const team = authority.teamId as string;
  authority.emit("team.node", { node_id: bea.keys.nodeId, login: bea.login, hostname: bea.hostname, pubkey: bea.keys.pubkey,
    ip: "127.0.0.1", port: 7458, transports: ["tailscale", "direct"], endpoint: endpointHex(bea.keys.pubkey), peer_sig_v1: true });
  authority.emit("team.member", { login: alex.login, handle: alex.handle, role: "owner" });
  authority.emit("team.node", { node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey, ip: "127.0.0.1", port: 7458 });
  authority.emit("team.member", { login: kira.login, handle: kira.handle, role: "owner" });
  authority.emit("team.node", { node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname, pubkey: kira.keys.pubkey, ip: "127.0.0.1", port: 7458 });
  const daemon = makeCore(alex, team, cleanups);
  feed(daemon, authority);
  expect(daemon.authority).toBe(bea.keys.nodeId);
  // alex queues an owner spend (the id alone) from its current record: no Direct pin.
  const n0 = daemon.roster.nodes.get(alex.keys.nodeId)!;
  const spend = signRequest(daemon, "team.node", { node_id: n0.node_id, login: n0.login, hostname: n0.hostname, pubkey: n0.pubkey,
    ip: n0.ip, port: n0.port, ...transportFields(n0), invite: "ab".repeat(16) });
  daemon.store.queueRequest(spend.id, JSON.stringify(spend));
  // bea hands the authority to kira; kira pins Walkie Direct on alex's record (its own origin); bea relays it.
  authority.emit("team.authority", { node_id: kira.keys.nodeId });
  const heir = makeCore(kira, team, cleanups);
  feed(heir, authority);
  expect(heir.isAuthority()).toBe(true);
  heir.emit("team.node", { node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey,
    ip: "127.0.0.1", port: 7458, transports: ["tailscale", "direct"], endpoint: endpointHex(alex.keys.pubkey), peer_sig_v1: true });
  feed(authority, heir);
  expect(heir.roster.nodes.get(alex.keys.nodeId)?.transports).toEqual(["tailscale", "direct"]);

  const sent: { to: string; req: RosterRequest }[] = [];
  const client = {
    addrOf: (n: { node_id: string }) => ({ ip: "127.0.0.1", port: 7458, node: n.node_id }),
    vv: async () => ({ vv: authority.store.vv(), online: [], capabilities: { caps: [] } }),
    // The old authority's origin comes back at once; the new authority's origin is 300 ms slower (network).
    pull: async (_a: PeerAddr, origin: string, after: number) => {
      if (origin === kira.keys.nodeId) await sleep(300);
      return { events: rows(authority, origin, after) };
    },
    pullIds: async () => ({ events: [] }),
    rosterRequest: async (_a: PeerAddr, req: RosterRequest) => {
      const to = daemon.authority ?? "none";
      sent.push({ to, req });
      if (to !== kira.keys.nodeId) throw new PeerCallError(409, "not_authority", "not the authority");
      const ev = applyRequest(heir, req);
      return { event: ev ? { id: ev.id, seq: ev.seq } : null };
    },
  } as unknown as PeerClient;
  const s = new SyncManager(daemon, client, {});
  s.tick();
  await sleep(900);
  s.stop();
  const out = {
    daemonAuthority: daemon.authority === kira.keys.nodeId ? "kira" : daemon.authority === bea.keys.nodeId ? "bea" : daemon.authority,
    sent: sent.length,
    sentTo: sent.map((x) => (x.to === kira.keys.nodeId ? "kira" : x.to === bea.keys.nodeId ? "bea" : x.to)),
    sentTransports: sent[0]?.req.body.transports ?? null,
    heirTransportsAfter: heir.roster.nodes.get(alex.keys.nodeId)?.transports ?? null,
    daemonTransportsAfter: daemon.roster.nodes.get(alex.keys.nodeId)?.transports ?? null,
    queued: daemon.store.queuedRequests().length,
  };
  expect(out.heirTransportsAfter).toEqual(["tailscale", "direct"]);
});

// Codex pre.13 audit SHOULD: the hold was decided once, before the flush. A request sent earlier in the same flush can
// move the authority (here the transfer reaches this machine while its first request is being sent); a spend queued
// behind it must then wait for a round caught up with the new authority, not go out rebuilt from the stale record.
test("an authority change during the flush itself holds the spends queued after it", async () => {
  const bea = tnode("bea"), alex = tnode("alex"), kira = tnode("kira");
  const authority = makeCore(bea, "0000000000000000", cleanups);
  authority.store.deleteMeta("team");
  authority.createTeam("acme", "bea", { login: bea.login });
  const team = authority.teamId as string;
  authority.emit("team.node", { node_id: bea.keys.nodeId, login: bea.login, hostname: bea.hostname, pubkey: bea.keys.pubkey,
    ip: "127.0.0.1", port: 7458, transports: ["tailscale", "direct"], endpoint: endpointHex(bea.keys.pubkey), peer_sig_v1: true });
  authority.emit("team.member", { login: alex.login, handle: alex.handle, role: "owner" });
  authority.emit("team.node", { node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey, ip: "127.0.0.1", port: 7458 });
  authority.emit("team.member", { login: kira.login, handle: kira.handle, role: "owner" });
  authority.emit("team.node", { node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname, pubkey: kira.keys.pubkey, ip: "127.0.0.1", port: 7458 });
  const daemon = makeCore(alex, team, cleanups);
  feed(daemon, authority);
  expect(daemon.authority).toBe(bea.keys.nodeId);
  // Queued first: an ordinary request. Queued after it: an owner spend built from the current record (no Direct pin).
  const first = signRequest(daemon, "channel.upsert", { name: "ops" });
  daemon.store.queueRequest(first.id, JSON.stringify(first));
  await sleep(5);
  const n0 = daemon.roster.nodes.get(alex.keys.nodeId)!;
  const spend = signRequest(daemon, "team.node", { node_id: n0.node_id, login: n0.login, hostname: n0.hostname, pubkey: n0.pubkey,
    ip: n0.ip, port: n0.port, ...transportFields(n0), invite: "cd".repeat(16) });
  daemon.store.queueRequest(spend.id, JSON.stringify(spend));
  // Meanwhile bea hands the authority to kira, and kira pins Walkie Direct on alex's record.
  authority.emit("team.authority", { node_id: kira.keys.nodeId });
  const heir = makeCore(kira, team, cleanups);
  feed(heir, authority);
  heir.emit("team.node", { node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey,
    ip: "127.0.0.1", port: 7458, transports: ["tailscale", "direct"], endpoint: endpointHex(alex.keys.pubkey), peer_sig_v1: true });
  feed(authority, heir);
  const sent: string[] = [];
  const client = {
    addrOf: (n: { node_id: string }) => ({ ip: "127.0.0.1", port: 7458, node: n.node_id }),
    rosterRequest: async (_a: PeerAddr, req: RosterRequest) => {
      sent.push(req.kind);
      if (req.id === first.id) {
        // While the first request is being sent, the transfer (and kira's records) reach this machine.
        feed(daemon, authority);
        return { event: null };
      }
      const ev = applyRequest(heir, req);
      return { event: ev ? { id: ev.id, seq: ev.seq } : null };
    },
  } as unknown as PeerClient;
  await flushRequests(daemon, client, async () => {}, {});
  expect(daemon.authority).toBe(kira.keys.nodeId);
  expect(sent).toEqual(["channel.upsert"]); // the spend was not sent this round
  expect(daemon.store.queuedRequests().map((q) => q.id)).toContain(spend.id);
  expect(heir.roster.nodes.get(alex.keys.nodeId)?.transports).toEqual(["tailscale", "direct"]);
});

test("an authority handed away and back during the flush (A to B to A) still holds the spends queued after it", async () => {
  const bea = tnode("bea"), alex = tnode("alex"), kira = tnode("kira");
  const authority = makeCore(bea, "0000000000000000", cleanups);
  authority.store.deleteMeta("team");
  authority.createTeam("acme", "bea", { login: bea.login });
  const team = authority.teamId as string;
  authority.emit("team.node", { node_id: bea.keys.nodeId, login: bea.login, hostname: bea.hostname, pubkey: bea.keys.pubkey,
    ip: "127.0.0.1", port: 7458, transports: ["tailscale", "direct"], endpoint: endpointHex(bea.keys.pubkey), peer_sig_v1: true });
  authority.emit("team.member", { login: alex.login, handle: alex.handle, role: "owner" });
  authority.emit("team.node", { node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey, ip: "127.0.0.1", port: 7458 });
  authority.emit("team.member", { login: kira.login, handle: kira.handle, role: "owner" });
  authority.emit("team.node", { node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname, pubkey: kira.keys.pubkey, ip: "127.0.0.1", port: 7458 });
  const daemon = makeCore(alex, team, cleanups);
  feed(daemon, authority);
  const first = signRequest(daemon, "channel.upsert", { name: "ops" });
  daemon.store.queueRequest(first.id, JSON.stringify(first));
  await sleep(5);
  const n0 = daemon.roster.nodes.get(alex.keys.nodeId)!;
  const spend = signRequest(daemon, "team.node", { node_id: n0.node_id, login: n0.login, hostname: n0.hostname, pubkey: n0.pubkey,
    ip: n0.ip, port: n0.port, ...transportFields(n0), invite: "ef".repeat(16) });
  daemon.store.queueRequest(spend.id, JSON.stringify(spend));
  // bea hands the authority to kira; kira pins Walkie Direct on alex's record and hands it back to bea.
  authority.emit("team.authority", { node_id: kira.keys.nodeId });
  const heir = makeCore(kira, team, cleanups);
  feed(heir, authority);
  heir.emit("team.node", { node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey,
    ip: "127.0.0.1", port: 7458, transports: ["tailscale", "direct"], endpoint: endpointHex(alex.keys.pubkey), peer_sig_v1: true });
  heir.emit("team.authority", { node_id: bea.keys.nodeId });
  feed(authority, heir);
  expect(authority.authority).toBe(bea.keys.nodeId);
  const sent: string[] = [];
  const client = {
    addrOf: (n: { node_id: string }) => ({ ip: "127.0.0.1", port: 7458, node: n.node_id }),
    rosterRequest: async (_a: PeerAddr, req: RosterRequest) => {
      sent.push(req.kind);
      if (req.id === first.id) { feed(daemon, authority); return { event: null }; }
      const ev = applyRequest(authority, req);
      return { event: ev ? { id: ev.id, seq: ev.seq } : null };
    },
  } as unknown as PeerClient;
  await flushRequests(daemon, client, async () => {}, {});
  expect(daemon.authority).toBe(bea.keys.nodeId); // the same authority as when the flush started
  expect(sent).toEqual(["channel.upsert"]);
  expect(daemon.store.queuedRequests().map((q) => q.id)).toContain(spend.id);
  expect(authority.roster.nodes.get(alex.keys.nodeId)?.transports).toEqual(["tailscale", "direct"]);
});

// Codex pre.13 audit round 3: a sync result for an authority is used only under the transfer count its round started
// with. After a transfer away and back (A to B to A), an older round's "caught up with A" no longer releases a spend.
test("a round's result for the authority counts only under the transfer count it started with", async () => {
  const bea = tnode("bea"), alex = tnode("alex");
  const authority = makeCore(bea, "0000000000000000", cleanups);
  authority.store.deleteMeta("team");
  authority.createTeam("acme", "bea", { login: bea.login });
  const team = authority.teamId as string;
  authority.emit("team.member", { login: alex.login, handle: alex.handle, role: "owner" });
  authority.emit("team.node", { node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey, ip: "127.0.0.1", port: 7458 });
  const daemon = makeCore(alex, team, cleanups);
  feed(daemon, authority);
  const n0 = daemon.roster.nodes.get(alex.keys.nodeId)!;
  const spend = signRequest(daemon, "team.node", { node_id: n0.node_id, login: n0.login, hostname: n0.hostname, pubkey: n0.pubkey,
    ip: n0.ip, port: n0.port, ...transportFields(n0), invite: "ab".repeat(16) });
  daemon.store.queueRequest(spend.id, JSON.stringify(spend));
  const sent: string[] = [];
  const client = {
    addrOf: (n: { node_id: string }) => ({ ip: "127.0.0.1", port: 7458, node: n.node_id }),
    rosterRequest: async (_a: PeerAddr, req: RosterRequest) => { sent.push(req.id); const ev = applyRequest(authority, req); return { event: ev ? { id: ev.id, seq: ev.seq } : null }; },
  } as unknown as PeerClient;
  const s = new SyncManager(daemon, client, {});
  const origins = (s as unknown as { authorityOrigin: Map<string, { term: number; promise: Promise<{ contacted: boolean; level: boolean }> }> }).authorityOrigin;
  const caughtUp = Promise.resolve({ contacted: true, level: true });
  try {
    // A result from an older term: the spend stays queued.
    origins.set(bea.keys.nodeId, { term: daemon.authorityLeaseTerm - 1, promise: caughtUp });
    await s.flushRequests();
    expect(sent).toEqual([]);
    // The same result under the current term releases it.
    origins.set(bea.keys.nodeId, { term: daemon.authorityLeaseTerm, promise: caughtUp });
    await s.flushRequests();
    expect(sent).toEqual([spend.id]);
  } finally { s.stop(); }
});
