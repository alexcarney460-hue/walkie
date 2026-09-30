// Mixed teams (PROTOCOL §4 "Mixed teams"): per-peer transport selection, and each listener's own gate. A dual
// authority (alex: Tailscale + Direct), a Tailscale-only member (bob) and a Direct-only member (carol, invited).
import { afterEach, describe, expect, test } from "bun:test";
import { FakeIdentity, type WhoisResult } from "../../src/daemon/identity.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { PeerClient } from "../../src/daemon/peer-client.ts";
import { authorityReachable, pickTransport, reachableOver, withTransport, type NodeRec } from "../../src/daemon/roster.ts";
import type { Transport } from "../../src/daemon/transport.ts";
import type { TransportKind } from "../../src/protocol/schemas.ts";
import { makeCore } from "../helpers/core.ts";
import { tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const hex = (who: TNode) => Buffer.from(who.keys.pubkey, "base64").toString("hex");
const rec = (transports: TransportKind[] | undefined, ip: string) => ({ ...(transports ? { transports } : {}), ip });

describe("transport selection", () => {
  test("a transport both serve, Tailscale first; none in common is null", () => {
    const v01 = rec(undefined, "100.64.0.2"); // a v0.1 record: Tailscale
    const dual = rec(["tailscale", "direct"], "100.64.0.1");
    const direct = rec(["direct"], "");
    expect(pickTransport(dual, v01)).toBe("tailscale");
    expect(pickTransport(dual, dual)).toBe("tailscale");
    expect(pickTransport(dual, direct)).toBe("direct");
    expect(pickTransport(direct, dual)).toBe("direct");
    expect(pickTransport(direct, direct)).toBe("direct");
    expect(pickTransport(v01, direct)).toBeNull();
    expect(pickTransport(direct, v01)).toBeNull();
    // Tailscale with no pinned address isn't reachable over the tailnet.
    expect(reachableOver(rec(["tailscale", "direct"], ""))).toEqual(["direct"]);
    expect(pickTransport(rec(["tailscale", "direct"], ""), v01)).toBeNull();
    expect(withTransport({}, "direct")).toEqual(["tailscale", "direct"]);
    expect(withTransport({ transports: ["direct"] }, "direct")).toEqual(["direct"]);
  });

  test("PeerClient.addrOf follows this node's own record, and Direct only while it runs", () => {
    const fakeDirect = { kind: "direct", request: async () => new Response("{}") } as Transport;
    const bob: Pick<NodeRec, "ip" | "port" | "pubkey" | "transports"> = { ip: "100.64.0.2", port: 7458, pubkey: "BOB" };
    const carol: Pick<NodeRec, "ip" | "port" | "pubkey" | "transports"> = { ip: "", port: 7458, pubkey: "CAROL", transports: ["direct"] };
    const alex: Pick<NodeRec, "ip" | "port" | "pubkey" | "transports"> = { ip: "100.64.0.1", port: 7458, pubkey: "ALEX", transports: ["tailscale", "direct"] };
    let self: Pick<NodeRec, "transports" | "ip"> | undefined = rec(["tailscale", "direct"], "100.64.0.1");
    const client = new PeerClient({ team: () => "t", nodeId: "n", self: () => self });
    client.transports.direct = fakeDirect;
    expect(client.addrOf(bob)).toEqual({ ip: "100.64.0.2", port: 7458 }); // dual → Tailscale-only: tailnet
    expect(client.addrOf(carol)).toEqual({ ip: "", port: 7458, pubkey: "CAROL" }); // dual → Direct-only: Direct
    client.transports.direct = null; // Direct not running (yet): the Direct-only peer is out of reach
    expect(client.addrOf(carol)).toBeNull();
    client.transports.direct = fakeDirect;
    self = rec(["direct"], ""); // this node is Direct-only
    expect(client.addrOf(alex)).toEqual({ ip: "100.64.0.1", port: 7458, pubkey: "ALEX" });
    expect(client.addrOf(bob)).toBeNull();
    self = rec(undefined, "100.64.0.2"); // this node is Tailscale-only (v0.1 record)
    expect(client.addrOf(alex)).toEqual({ ip: "100.64.0.1", port: 7458 });
    expect(client.addrOf(carol)).toBeNull();
    expect(client.reaches(carol)).toBe(false);
  });

  test("POOL-REAL-1: PeerClient.addrVia names one transport, only when both machines serve it now", () => {
    const fakeDirect = { kind: "direct", request: async () => new Response("{}") } as Transport;
    const alex: Pick<NodeRec, "ip" | "port" | "pubkey" | "transports"> = { ip: "100.64.0.1", port: 7458, pubkey: "ALEX", transports: ["tailscale", "direct"] };
    const bob: Pick<NodeRec, "ip" | "port" | "pubkey" | "transports"> = { ip: "100.64.0.2", port: 7458, pubkey: "BOB" };
    const client = new PeerClient({ team: () => "t", nodeId: "n", self: () => rec(["tailscale", "direct"], "100.64.0.3") });
    client.transports.direct = fakeDirect;
    // Both dual: Tailscale is what addrOf picks; a pool tunnel may ask for Direct instead.
    expect(client.addrOf(alex)).toEqual({ ip: "100.64.0.1", port: 7458 });
    expect(client.addrVia(alex, "direct")).toEqual({ ip: "100.64.0.1", port: 7458, pubkey: "ALEX" });
    expect(client.addrVia(alex, "tailscale")).toEqual({ ip: "100.64.0.1", port: 7458 });
    // A Tailscale-only peer has no Direct address; Direct not running here: none either.
    expect(client.addrVia(bob, "direct")).toBeNull();
    client.transports.direct = null;
    expect(client.addrVia(alex, "direct")).toBeNull();
  });
});

/** alex's daemon (authority, dual), bob (Tailscale-only), carol (Direct-only, `direct:carol`), alex2 (alex's Direct-only machine). */
function world() {
  const alex = tnode("alex");
  const bob = tnode("bob");
  const carol = tnode("carol", "direct:carol");
  const alex2 = tnode("alex", "alex@example.com", "alex-air");
  const byNode = new Map<string, WhoisResult>();
  const core = makeCore(alex, "0000000000000000", cleanups, {
    identity: new FakeIdentity({ ip: "100.64.0.1", login: alex.login, nodeName: alex.hostname }, byNode),
  });
  core.store.deleteMeta("team");
  core.ip = "100.64.0.1";
  core.createTeam("aka", "alex");
  // `walkie direct enable` on the authority: its own record gains "direct" (a re-pin, same address).
  core.emit("team.node", { node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey, ip: "100.64.0.1", endpoint: hex(alex), transports: ["tailscale", "direct"], peer_sig_strict: false });
  core.emit("team.member", { login: bob.login, handle: "bob", role: "member" });
  core.emit("team.node", { node_id: bob.keys.nodeId, login: bob.login, hostname: bob.hostname, pubkey: bob.keys.pubkey, ip: "100.64.0.2" });
  core.store.setMeta(`peer_capabilities:${bob.keys.nodeId}`, JSON.stringify({ version: "0.1.3", caps: [] }));
  core.emit("team.member", { login: carol.login, handle: "carol", role: "member" });
  core.emit("team.node", { node_id: carol.keys.nodeId, login: carol.login, hostname: carol.hostname, pubkey: carol.keys.pubkey, ip: "", endpoint: hex(carol), transports: ["direct"] });
  core.emit("team.node", { node_id: alex2.keys.nodeId, login: alex.login, hostname: alex2.hostname, pubkey: alex2.keys.pubkey, ip: "", endpoint: hex(alex2), transports: ["direct"] });
  byNode.set(bob.keys.nodeId, { login: bob.login, nodeName: bob.hostname });
  return { alex, bob, carol, alex2, byNode, core, team: core.teamId as string, api: new PeerApi(core) };
}

type W = ReturnType<typeof world>;

function direct(w: W, who: TNode, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const req = new Request(`http://walkie.direct${path}`, {
    method: init.method ?? "GET", headers: { "X-Walkie-Team": w.team, ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return w.api.handle(req, { kind: "direct", pubkey: who.keys.pubkey });
}

function tailnet(w: W, ip: string, nodeHdr: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const req = new Request(`http://${ip}:7458${path}`, {
    method: init.method ?? "GET", headers: { "X-Walkie-Team": w.team, "X-Walkie-Node": nodeHdr, "Content-Type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return w.api.handle(req, ip);
}

async function errCode(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
}

describe("each listener keeps its own gate", () => {
  test("Tailscale: a Tailscale member passes; a Direct-only machine never does, whatever the login", async () => {
    const w = world();
    expect((await tailnet(w, "100.64.0.2", w.bob.keys.nodeId, "/peer/v1/vv")).status).toBe(200);
    // A whois answer can never be a Direct login (Tailscale doesn't mint `direct:` logins): refused outright.
    w.byNode.set(w.carol.keys.nodeId, { login: "direct:carol", nodeName: "carol-mbp" });
    const asCarol = await tailnet(w, "100.64.0.9", w.carol.keys.nodeId, "/peer/v1/vv");
    expect(asCarol.status).toBe(403);
    expect(await errCode(asCarol)).toBe("not_member");
    // alex's own tailnet login naming his Direct-only machine: that machine doesn't serve Tailscale.
    w.byNode.set(w.alex2.keys.nodeId, { login: w.alex.login, nodeName: "alex-air" });
    expect((await tailnet(w, "100.64.0.7", w.alex2.keys.nodeId, "/peer/v1/vv")).status).toBe(403);
    // …and a Tailscale join can't re-pin it to a tailnet address (nothing proves the key over Tailscale).
    const repin = await tailnet(w, "100.64.0.7", w.alex2.keys.nodeId, "/peer/v1/join", {
      method: "POST", body: { pubkey: w.alex2.keys.pubkey, hostname: "alex-air", ip: "100.64.0.7" },
    });
    expect(repin.status).toBe(403);
    expect(w.core.roster.nodes.get(w.alex2.keys.nodeId)?.ip).toBe("");
  });

  test("Direct: a Direct-serving member passes; a Tailscale-only key is refused until it proves its key", async () => {
    const w = world();
    expect((await direct(w, w.carol, "/peer/v1/vv")).status).toBe(200);
    expect((await direct(w, w.alex2, "/peer/v1/vv")).status).toBe(200);
    const bob = await direct(w, w.bob, "/peer/v1/vv");
    expect(bob.status).toBe(403);
    expect(await errCode(bob)).toBe("not_member");
    // carol can't claim bob's node id (the key decides; the header must match it).
    const spoof = await direct(w, w.carol, "/peer/v1/vv", { headers: { "X-Walkie-Node": w.bob.keys.nodeId } });
    expect(spoof.status).toBe(403);
    // A push from carol claiming to relay as bob is attributed to carol's node.
    expect((await direct(w, w.carol, "/peer/v1/roster-request", { method: "POST", body: { id: "0".repeat(32), kind: "channel.upsert", body: { name: "x" }, node: w.bob.keys.nodeId, ts: 1, sig: "x" } })).status).toBe(403);
  });

  test("bob turns Direct on: a Direct /join with his own key (no invite) adds \"direct\" to his record", async () => {
    const w = world();
    const len = w.core.chainLength;
    const res = await direct(w, w.bob, "/peer/v1/join", { method: "POST", body: { pubkey: w.bob.keys.pubkey, hostname: "bob-mbp", ip: "100.64.0.2", port: 7458 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ admitted: true, node_id: w.bob.keys.nodeId });
    expect(w.core.chainLength).toBe(len + 1); // one appended re-pin, nothing rewritten
    const rec = w.core.roster.nodes.get(w.bob.keys.nodeId);
    expect(rec).toMatchObject({ login: w.bob.login, ip: "100.64.0.2", transports: ["tailscale", "direct"] });
    expect((await direct(w, w.bob, "/peer/v1/vv")).status).toBe(200);
    // Idempotent: a second call appends nothing.
    await direct(w, w.bob, "/peer/v1/join", { method: "POST", body: { pubkey: w.bob.keys.pubkey, hostname: "bob-mbp", ip: "100.64.0.2" } });
    expect(w.core.chainLength).toBe(len + 1);
  });

  test("an outsider key still needs an invite; a key can't join as another machine", async () => {
    const w = world();
    const mallory = tnode("mallory");
    const res = await direct(w, mallory, "/peer/v1/join", { method: "POST", body: { pubkey: mallory.keys.pubkey, hostname: "evil", ip: "" } });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("not_member");
    const asBob = await direct(w, mallory, "/peer/v1/join", { method: "POST", body: { pubkey: w.bob.keys.pubkey, hostname: "evil", ip: "" } });
    expect(asBob.status).toBe(403);
    expect(w.core.roster.nodes.get(w.bob.keys.nodeId)?.transports).toBeUndefined();
  });

  test("removal closes both doors: carol and a removed Tailscale member are refused on their transport", async () => {
    const w = world();
    w.core.emit("team.member", { login: w.carol.login, handle: "carol", role: "removed" });
    w.core.emit("team.member", { login: w.bob.login, handle: "bob", role: "removed" });
    expect((await direct(w, w.carol, "/peer/v1/vv")).status).toBe(403);
    expect((await tailnet(w, "100.64.0.2", w.bob.keys.nodeId, "/peer/v1/vv")).status).toBe(403);
  });
});

describe("mixed-team roster rules", () => {
  test("the authority must share a transport with every active machine", () => {
    const w = world();
    const r = authorityReachable(w.core.roster, w.bob.keys.nodeId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unreachable.map((n) => n.hostname).sort()).toEqual(["alex-air", "carol-mbp"]);
    expect(authorityReachable(w.core.roster, w.alex.keys.nodeId).ok).toBe(true);
  });

  test("/peer/v1/vv reports the peers this node reached itself (relayed liveness)", async () => {
    const w = world();
    w.core.reachedPeers = () => [w.bob.keys.nodeId];
    const res = await direct(w, w.carol, "/peer/v1/vv");
    expect(((await res.json()) as { online?: string[] }).online).toEqual([w.bob.keys.nodeId]);
  });
});
