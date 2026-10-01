import { afterAll, beforeAll, expect, test } from "bun:test";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { createInvite, inviteMintPos } from "../../src/daemon/invite.ts";
import { signPeerRequest, signPeerVv, newPeerNonce } from "../../src/daemon/peer-sig.ts";
import { peerCapabilities, rememberValidPeerSignature } from "../../src/daemon/peer-capabilities.ts";
import { signSshRevocation } from "../../src/daemon/ssh/team-revocation.ts";
import { grantFor } from "../helpers/ssh-team.ts";
import { signedPeerFetch } from "../helpers/signed-peer-fetch.ts";

let cluster: Cluster;
let owner: TestNode;
let member: TestNode;

beforeAll(async () => {
  cluster = new Cluster();
  owner = await cluster.add({ name: "owner", login: "owner@example.com" });
  await owner.client().init("team", "owner");
  await owner.client().request("POST", "/v1/team/peer-sig-strict", { strict: false });
  await owner.client().invite("fixture-legacy@example.com", "fixture-legacy", "member");
  const old = generateKeys();
  cluster.identities.set(old.nodeId, { login: "fixture-legacy@example.com", nodeName: "fixture-legacy" });
  const oldJoin = await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST",
    headers: { "X-Walkie-Node": old.nodeId },
    body: JSON.stringify({ pubkey: old.pubkey, hostname: "fixture-legacy", ip: "127.0.0.1" }) });
  expect((await oldJoin.json() as { admitted: boolean }).admitted).toBe(true);
  await owner.client().invite("member@example.com", "member", "member");
  member = await cluster.add({ name: "member", login: "member@example.com" });
  expect((await member.client().join(owner.peerAddr)).admitted).toBe(true);
}, 30_000);
afterAll(async () => { await cluster.close(); });

function forged(path: string, method = "POST", body = "{}") {
  return fetch(`http://${owner.peerAddr}${path}`, { method,
    headers: { "X-Walkie-Node": member.d.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "", "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body }) });
}

test("a member's IP and public node header do not authorize tier A", async () => {
  for (const path of ["/peer/v1/admin/run", "/peer/v1/vault/lease", "/peer/v1/pool/stage"]) {
    const res = await forged(path);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("bad_peer_sig");
  }
  const join = await forged("/peer/v1/join", "POST", JSON.stringify({ pubkey: member.d.core.keys.pubkey,
    hostname: "member-mbp", ip: "127.0.0.1", port: 9999 }));
  expect(join.status).toBe(403);
  expect((await join.json() as { error: { code: string } }).error.code).toBe("bad_peer_sig");
});

test("signed admission makes tier B sticky without a capability fetch", async () => {
  owner.d.core.store.deleteMeta(`peer_capabilities:${member.d.nodeId}`);
  owner.d.core.store.deleteMeta(`peer_sig_required:${member.d.nodeId}`);
  const first = await forged("/peer/v1/vv", "GET");
  expect(first.status).toBe(403);
  expect((await first.json() as { error: { code: string } }).error.code).toBe("bad_peer_sig");
  expect(owner.d.core.store.getMeta(`peer_capabilities:${member.d.nodeId}`)).toBeNull();
  expect(owner.d.core.roster.nodes.get(member.d.nodeId)?.peer_sig_v1).toBe(true);
  expect((await member.d.client.vv({ ip: "127.0.0.1", port: owner.peerPort })).node).toBe(owner.d.nodeId);
  expect(owner.d.core.store.getMeta(`peer_sig_required:${member.d.nodeId}`)).toBe("1");
  owner.d.sync.rememberCapabilities(member.d.nodeId, { version: "0.2.0-pre.9", caps: [] });
  expect(owner.d.core.roster.nodes.get(member.d.nodeId)?.peer_sig_v1).toBe(true);
  const downgraded = await forged("/peer/v1/vv", "GET");
  expect(downgraded.status).toBe(403);
  await owner.stop();
  await owner.start();
  expect(owner.d.core.store.getMeta(`peer_sig_required:${member.d.nodeId}`)).toBe("1");
  expect((await forged("/peer/v1/vv", "GET")).status).toBe(403);
});

test("a presented invalid signature is refused even on exempt hello", async () => {
  const res = await fetch(`http://${owner.peerAddr}/peer/v1/hello`, {
    headers: { "X-Walkie-Node": member.d.nodeId, "X-Walkie-Sig": "invalid" },
  });
  expect(res.status).toBe(403);
  expect((await res.json() as { error: { code: string } }).error.code).toBe("bad_peer_sig");
});

test("signed hello from a new key remains discoverable before admission", async () => {
  const key = generateKeys();
  cluster.identities.set(key.nodeId, { login: "owner@example.com", nodeName: "not-joined" });
  const sig = signPeerRequest(key, { method: "GET", path: "/peer/v1/hello", query: "", body: "",
    requester: key.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "", ts: Date.now(), nonce: newPeerNonce() });
  const res = await fetch(`http://${owner.peerAddr}/peer/v1/hello`, { headers: { "X-Walkie-Node": key.nodeId, ...sig } });
  expect(res.status).toBe(200);
});

test("unproved legacy unsigned warning is limited to one per node", async () => {
  await owner.client().invite("legacy@example.com", "legacy", "member");
  const key = generateKeys();
  cluster.identities.set(key.nodeId, { login: "legacy@example.com", nodeName: "legacy-mac" });
  const headers = { "X-Walkie-Node": key.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" };
  const body = JSON.stringify({ pubkey: key.pubkey, hostname: "legacy-mac", ip: "127.0.0.1", port: 7458 });
  expect((await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST", headers, body })).status).toBe(200);
  owner.d.sync.rememberCapabilities(key.nodeId, { version: "0.2.0-pre.9", caps: [] });
  const log = owner.d.core.log;
  const original = log.warn;
  let warnings = 0;
  log.warn = (msg, fields) => { if (msg === "peer_unsigned" && fields?.node === key.nodeId) warnings++; original(msg, fields); };
  try {
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`http://${owner.peerAddr}/peer/v1/vv`, { headers })).status).toBe(200);
    }
    expect(warnings).toBe(1);
  } finally { log.warn = original; }
});

test("Direct peer calls require no request signature", async () => {
  const direct = new Cluster();
  try {
    const a = await direct.add({ name: "direct-owner", login: "owner@direct", direct: true });
    await a.client().init("direct-team", "owner");
    const b = await direct.add({ name: "direct-member", login: "member@direct", direct: true });
    const invite = await a.client().inviteCode("member", "member");
    expect((await b.client().join(invite.code)).admitted).toBe(true);
    const addr = b.d.client.addrOf(b.d.core.roster.nodes.get(a.d.nodeId)!);
    expect(addr?.pubkey).toBe(a.d.core.keys.pubkey);
    const vv = await b.d.client.vv(addr!, a.d.core.keys.pubkey);
    expect(vv.node).toBe(a.d.nodeId);
    expect(vv.verified).toBe(true);
  } finally {
    await direct.close();
  }
});

test("a new key under an admitted login waits for approval and cannot use tier A", async () => {
  const key = generateKeys();
  cluster.identities.set(key.nodeId, { login: "owner@example.com", nodeName: "owner-shared" });
  const body = JSON.stringify({ pubkey: key.pubkey, hostname: "unapproved-mac", ip: "127.0.0.1", port: 7458 });
  const headers = { "X-Walkie-Node": key.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" };
  const joined = await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST", headers, body });
  expect((await joined.json() as { admitted: boolean; reason: string })).toMatchObject({ admitted: false, reason: "pending_approval" });
  expect(owner.d.core.store.joinRequest(key.nodeId, Date.now())?.hostname).toBe("unapproved-mac");
  const adminBody = JSON.stringify({ argv: ["status"] });
  const sig = signPeerRequest(key, { method: "POST", path: "/peer/v1/admin/run", query: "", body: adminBody,
    requester: key.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "", ts: Date.now(), nonce: newPeerNonce() });
  const admin = await fetch(`http://${owner.peerAddr}/peer/v1/admin/run`, { method: "POST", headers: { ...headers, ...sig }, body: adminBody });
  expect(admin.status).toBe(403);
  expect(owner.d.core.roster.nodes.has(key.nodeId)).toBe(false);
});

test("a pending new-key join does not consume admitted-node replay slots", async () => {
  const key = generateKeys();
  cluster.identities.set(key.nodeId, { login: "owner@example.com", nodeName: "owner-pending" });
  const body = JSON.stringify({ pubkey: key.pubkey, hostname: "pending-mac", ip: "127.0.0.1", port: 7458 });
  const sig = signPeerRequest(key, { method: "POST", path: "/peer/v1/join", query: "", body,
    requester: key.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "", ts: Date.now(), nonce: newPeerNonce() });
  const send = () => fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST",
    headers: { "X-Walkie-Node": key.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "", ...sig }, body });
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(200);
});

test("an owner add-machine credential admits the named login without another approval", async () => {
  const key = generateKeys();
  cluster.identities.set(key.nodeId, { login: "owner@example.com", nodeName: "owner-added" });
  const roster = owner.d.core.roster;
  const invite = createInvite(owner.d.core.keys, { team: owner.d.core.teamId ?? "", authority: owner.d.core.keys.pubkey,
    handle: "owner", role: "owner", now: Date.now(), pos: inviteMintPos(roster) });
  const body = JSON.stringify({ pubkey: key.pubkey, hostname: "approved-mac", ip: "127.0.0.1", port: 7458, invite: invite.code });
  const joined = await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST",
    headers: { "X-Walkie-Node": key.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" }, body });
  expect((await joined.json() as { admitted: boolean }).admitted).toBe(true);
  expect(owner.d.core.roster.nodes.get(key.nodeId)?.login).toBe("owner@example.com");
  expect(owner.d.core.roster.invites?.has(invite.id)).toBe(true);
});

test("first node of a member's Tailscale login still auto-admits", async () => {
  await owner.client().invite("fresh@example.com", "fresh", "member");
  const key = generateKeys();
  cluster.identities.set(key.nodeId, { login: "fresh@example.com", nodeName: "fresh-mac" });
  const body = JSON.stringify({ pubkey: key.pubkey, hostname: "fresh-mac", ip: "127.0.0.1", port: 7458 });
  const joined = await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST",
    headers: { "X-Walkie-Node": key.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" }, body });
  expect((await joined.json() as { admitted: boolean }).admitted).toBe(true);
  expect(owner.d.core.store.getMeta(`peer_capabilities:${key.nodeId}`)).toBeNull();
  const legacyVv = await fetch(`http://${owner.peerAddr}/peer/v1/vv`, {
    headers: { "X-Walkie-Node": key.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" },
  });
  expect(legacyVv.status).toBe(200);
});

for (const history of ["revoked", "removed"] as const) {
  test(`a ${history} login's replacement key waits for approval`, async () => {
    const login = `${history}@example.com`;
    await owner.client().invite(login, history, "member");
    const first = generateKeys();
    cluster.identities.set(first.nodeId, { login, nodeName: `${history}-first` });
    const headers = (nodeId: string) => ({ "X-Walkie-Node": nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" });
    const join = (key: ReturnType<typeof generateKeys>) => fetch(`http://${owner.peerAddr}/peer/v1/join`, {
      method: "POST", headers: headers(key.nodeId),
      body: JSON.stringify({ pubkey: key.pubkey, hostname: `${history}-mac`, ip: "127.0.0.1", port: 7458 }),
    });
    expect((await (await join(first)).json() as { admitted: boolean }).admitted).toBe(true);
    if (history === "revoked") await owner.client().revokeNode(first.nodeId);
    else {
      await owner.client().setRole(history, "removed");
      await owner.client().invite(login, history, "member");
    }
    expect(owner.d.core.roster.nodes.get(first.nodeId)?.revoked).toBe(true);
    const replacement = generateKeys();
    cluster.identities.set(replacement.nodeId, { login, nodeName: `${history}-replacement` });
    expect(await (await join(replacement)).json()).toMatchObject({ admitted: false, reason: "pending_approval" });
    expect(owner.d.core.roster.nodes.has(replacement.nodeId)).toBe(false);
  });
}

test("a fake responder on a stopped peer's port cannot downgrade sticky Tier B", async () => {
  const nodeId = member.d.nodeId;
  const port = member.peerPort;
  owner.d.sync.rememberCapabilities(nodeId, { version: "0.2.0", caps: ["peer_sig_v1"] });
  await member.stop();
  let answered = 0;
  const fake = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => {
    if (new URL(req.url).pathname !== "/peer/v1/vv") return new Response(null, { status: 404 });
    answered++;
    return Response.json({ node: nodeId, vv: {}, ts: Date.now(), capabilities: { version: "0.2.0-pre.9", caps: [] } });
  } });
  try {
    await waitFor(() => answered > 0, { what: "fake vv response", timeoutMs: 5_000 });
    await Bun.sleep(100);
    expect(owner.d.core.store.getMeta(`peer_capabilities:${nodeId}`)).toContain("peer_sig_v1");
    const res = await fetch(`http://${owner.peerAddr}/peer/v1/vv`, {
      headers: { "X-Walkie-Node": nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" },
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("bad_peer_sig");
  } finally { fake.stop(true); await member.start(); }
}, 10_000);

for (const claim of ["legacy", "modern"] as const) {
  test(`unsigned ${claim} vv claim at first contact stays unknown`, async () => {
    const nodeId = member.d.nodeId;
    const port = member.peerPort;
    await member.stop();
    await Bun.sleep(100);
    owner.d.core.store.deleteMeta(`peer_capabilities:${nodeId}`);
    owner.d.core.store.deleteMeta(`peer_caps_verified:${nodeId}`);
    owner.d.core.store.deleteMeta(`peer_sig_required:${nodeId}`);
    expect(owner.d.core.store.getMeta(`peer_sig_required:${nodeId}`)).toBeNull();
    const fake = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => {
      if (new URL(req.url).pathname !== "/peer/v1/vv") return new Response(null, { status: 404 });
      return Response.json({ node: nodeId, vv: {}, ts: Date.now(), capabilities: {
        version: claim === "legacy" ? "0.2.0-pre.9" : "0.2.0-pre.10",
        caps: claim === "legacy" ? [] : ["peer_sig_v1"],
      } });
    } });
    try {
      const res = await fetch(`http://${owner.peerAddr}/peer/v1/vv`, {
        headers: { "X-Walkie-Node": nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" },
      });
      expect(res.status).toBe(403);
      expect((await res.json() as { error: { code: string } }).error.code).toBe("bad_peer_sig");
      expect(owner.d.core.store.getMeta(`peer_caps_verified:${nodeId}`)).toBeNull();
      expect(owner.d.core.store.getMeta(`peer_sig_required:${nodeId}`)).toBeNull();
      await waitFor(() => !owner.d.sync.peerState(nodeId)?.running, { what: "sync idle", timeoutMs: 5_000 });
      await owner.d.sync.antiEntropy(owner.d.core.roster.nodes.get(nodeId)!);
      expect(owner.d.core.store.getMeta(`peer_caps_verified:${nodeId}`)).toBeNull();
      expect(owner.d.core.store.getMeta(`peer_sig_required:${nodeId}`)).toBeNull();
    } finally {
      fake.stop(true);
      await member.start();
    }
  }, 10_000);
}

test("an old unverified sticky marker cannot classify a peer", async () => {
  const nodeId = member.d.nodeId;
  const port = member.peerPort;
  await member.stop();
  await Bun.sleep(100);
  owner.d.core.store.deleteMeta(`peer_caps_verified:${nodeId}`);
  owner.d.core.store.setMeta(`peer_sig_required:${nodeId}`, "1");
  const fake = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({
    node: nodeId, vv: {}, ts: Date.now(), capabilities: { version: "0.2.0-pre.9", caps: [] },
  }) });
  try {
    const res = await fetch(`http://${owner.peerAddr}/peer/v1/vv`, {
      headers: { "X-Walkie-Node": nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" },
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("bad_peer_sig");
  } finally { fake.stop(true); await member.start(); }
}, 10_000);

test("a valid request signature does not launder an old unverified capability cache", () => {
  const store = owner.d.core.store;
  const nodeId = member.d.nodeId;
  store.setMeta(`peer_capabilities:${nodeId}`, JSON.stringify({ version: "0.2.0-pre.9", caps: ["forged_feature"] }));
  store.deleteMeta(`peer_caps_verified:${nodeId}`);
  rememberValidPeerSignature(store, nodeId);
  expect(peerCapabilities(store, nodeId)?.caps ?? []).not.toContain("forged_feature");
  expect(store.getMeta(`peer_sig_required:${nodeId}`)).toBe("1");
});

test("signed vv proof survives response fields unknown to this client", async () => {
  const nodeId = member.d.nodeId;
  const keys = member.d.core.keys;
  const port = member.peerPort;
  const requester = owner.d.nodeId;
  await member.stop();
  const fake = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => {
    const body = { node: nodeId, vv: {}, ts: Date.now(), capabilities: { version: "0.2.0-pre.10", caps: ["peer_sig_v1"] },
      future_field: { supported: true } };
    return Response.json({ ...body, proof: signPeerVv(keys, body, requester, req.headers.get("x-walkie-vv-challenge") ?? "") });
  } });
  try {
    const vv = await owner.d.client.vv({ ip: "127.0.0.1", port, nodeId }, keys.pubkey);
    expect(vv.verified).toBe(true);
  } finally { fake.stop(true); await member.start(); }
}, 10_000);

test("the SSH revocation receipt route is a signed peer route: tier A, admission first, only the caller's own receipt", async () => {
  const body = JSON.stringify(signSshRevocation(member.d.core, grantFor(member, owner)));
  const refusedCode = async (res: Response) => (await res.json() as { error: { code: string } }).error.code;
  // No peer signature: refused like admin/run, before the receipt is looked at.
  const unsigned = await forged("/peer/v1/ssh/revocation", "POST", body);
  expect([unsigned.status, await refusedCode(unsigned)]).toEqual([403, "bad_peer_sig"]);
  // A signature from a key the roster does not admit: refused at admission, whatever the receipt says.
  const ghost = generateKeys();
  cluster.identities.set(ghost.nodeId, { login: "member@example.com", nodeName: "ghost-mac" });
  const ghostSig = signPeerRequest(ghost, { method: "POST", path: "/peer/v1/ssh/revocation", query: "", body,
    requester: ghost.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "", ts: Date.now(), nonce: newPeerNonce() });
  const notAdmitted = await fetch(`http://${owner.peerAddr}/peer/v1/ssh/revocation`, { method: "POST",
    headers: { "X-Walkie-Node": ghost.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "", "Content-Type": "application/json", ...ghostSig }, body });
  expect(notAdmitted.status).toBe(403);
  // The admitted node's signed request stores its own receipt; a repeat answers the same event.
  const stored = await signedPeerFetch(member, owner, "/peer/v1/ssh/revocation", { method: "POST", body });
  expect(stored.status).toBe(200);
  const { event_id } = await stored.json() as { event_id: string };
  expect(event_id).toMatch(/./);
  expect(await (await signedPeerFetch(member, owner, "/peer/v1/ssh/revocation", { method: "POST", body })).json()).toEqual({ event_id });
  // A valid peer signature does not make another machine's receipt storable: the receipt must name the caller.
  const other = JSON.stringify(signSshRevocation(owner.d.core, grantFor(owner, owner)));
  const named = await signedPeerFetch(member, owner, "/peer/v1/ssh/revocation", { method: "POST", body: other });
  expect([named.status, await refusedCode(named)]).toEqual([403, "invalid_ssh_revocation"]);
});
