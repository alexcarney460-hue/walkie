import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Cluster, waitFor } from "../helpers/cluster.ts";
import { canonicalJson } from "../../src/protocol/canonical.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { newPeerNonce, signPeerRequest, signPeerVv } from "../../src/daemon/peer-sig.ts";
import { peerSigStrict } from "../../src/daemon/peer-capabilities.ts";
import { admitJoin } from "../../src/daemon/requests.ts";

async function legacyFixture() {
  const cluster = new Cluster();
  const owner = await cluster.add({ name: "owner", login: "owner@example.com" });
  await owner.client().init("rollout", "owner");
  await owner.client().request("POST", "/v1/team/peer-sig-strict", { strict: false });
  await owner.client().invite("legacy@example.com", "legacy", "member");
  const legacy = generateKeys();
  cluster.identities.set(legacy.nodeId, { login: "legacy@example.com", nodeName: "legacy" });
  const body = JSON.stringify({ pubkey: legacy.pubkey, hostname: "legacy", ip: "192.0.2.55", port: 7458 });
  const headers = { "X-Walkie-Node": legacy.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" };
  const joined = await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST", headers, body });
  expect((await joined.json() as { admitted: boolean }).admitted).toBe(true);
  return { cluster, owner, legacy, headers, body };
}

test("founder-only team refuses an unsigned legacy join until the owner disables strict mode", async () => {
  const cluster = new Cluster();
  try {
    const owner = await cluster.add({ name: "owner", login: "owner@example.com" });
    await owner.client().init("rollout", "owner");
    expect(peerSigStrict(owner.d.core.roster, owner.d.core.store)).toBe(true);
    await owner.client().invite("legacy@example.com", "legacy", "member");
    const legacy = generateKeys();
    cluster.identities.set(legacy.nodeId, { login: "legacy@example.com", nodeName: "legacy" });
    const body = JSON.stringify({ pubkey: legacy.pubkey, hostname: "legacy", ip: "192.0.2.55", port: 7458 });
    const headers = { "X-Walkie-Node": legacy.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" };
    const url = `http://${owner.peerAddr}/peer/v1/join`;
    const denied = await fetch(url, { method: "POST", headers, body });
    expect(denied.status).toBe(403);
    expect((await denied.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: "update_required", message: "this team requires Walkie 0.2.0-pre.10 or newer: update, then join again",
    });
    await owner.client().request("POST", "/v1/team/peer-sig-strict", { strict: false });
    expect(peerSigStrict(owner.d.core.roster, owner.d.core.store)).toBe(false);
    expect(owner.d.core.roster.peer_sig_strict).toBe(false);
    await owner.restart();
    expect(peerSigStrict(owner.d.core.roster, owner.d.core.store)).toBe(false);
    const joined = await fetch(url, { method: "POST", headers, body });
    expect(joined.status).toBe(200);
    expect((await joined.json() as { admitted: boolean }).admitted).toBe(true);
  } finally { await cluster.close(); }
});

test("an owner waiver is consumed when a previously removed legacy node is re-admitted", async () => {
  const { cluster, owner, legacy, headers, body } = await legacyFixture();
  try {
    await owner.client().request("POST", "/v1/team/peer-sig-strict", { strict: true });
    await owner.client().request("POST", "/v1/team/member", { handle: "legacy", role: "removed" });
    await owner.client().invite("legacy@example.com", "legacy", "member");
    await owner.client().request("POST", "/v1/team/peer-sig-strict", { strict: false });
    const pending = await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST", headers, body });
    expect((await pending.json() as { reason: string }).reason).toBe("pending_approval");
    admitJoin(owner.d.core, legacy.nodeId, true);
    expect(owner.d.core.roster.peer_sig_strict).toBeUndefined();
    const sig = signPeerRequest(legacy, { method: "GET", path: "/peer/v1/vv", query: "", body: "",
      requester: legacy.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "", ts: Date.now(), nonce: newPeerNonce() });
    const signed = await fetch(`http://${owner.peerAddr}/peer/v1/vv`, { headers: { ...headers, ...sig } });
    expect(signed.status).toBe(200);
    expect(owner.d.core.roster.peer_sig_strict).toBe(true);
  } finally { await cluster.close(); }
});

test("unsigned legacy re-pin changes only the observed IP; signed re-pin may change port", async () => {
  const { cluster, owner, legacy, headers, body } = await legacyFixture();
  try {
    const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({
      node: legacy.nodeId, vv: {}, ts: Date.now(), capabilities: { version: "0.2.0-pre.10", caps: ["peer_sig_v1"] },
    }) });
    try {
      const api = new PeerApi(owner.d.core);
      const moved = await api.handle(new Request("http://peer.invalid/peer/v1/join", {
        method: "POST", headers, body,
      }), "127.0.0.2");
      expect(moved.status).toBe(200);
      expect(owner.d.core.roster.nodes.get(legacy.nodeId)?.ip).toBe("127.0.0.2");
      expect(owner.d.core.roster.nodes.get(legacy.nodeId)?.port).toBe(7458);
      const changedBody = body.replace('"port":7458', `"port":${fake.port}`);
      const denied = await api.handle(new Request("http://peer.invalid/peer/v1/join", {
        method: "POST", headers, body: changedBody,
      }), "127.0.0.2");
      expect(denied.status).toBe(403);
      expect(owner.d.core.roster.nodes.get(legacy.nodeId)?.port).toBe(7458);
      const vv = await api.handle(new Request("http://peer.invalid/peer/v1/vv", { headers }), "127.0.0.2");
      expect(vv.status).toBe(200);
      expect(owner.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1).toBeUndefined();
      expect(peerSigStrict(owner.d.core.roster, owner.d.core.store)).toBe(false);
      const sig = signPeerRequest(legacy, { method: "POST", path: "/peer/v1/join", query: "", body: changedBody,
        requester: legacy.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "", ts: Date.now(), nonce: newPeerNonce() });
      const signed = await api.handle(new Request("http://peer.invalid/peer/v1/join", {
        method: "POST", headers: { ...headers, ...sig }, body: changedBody,
      }), "127.0.0.2");
      expect(signed.status).toBe(200);
      expect(owner.d.core.roster.nodes.get(legacy.nodeId)?.port).toBe(fake.port);
    } finally { fake.stop(true); }
  } finally { await cluster.close(); }
});

test("signed admission is replicated; the last legacy proof engages strict mode", async () => {
  const { cluster, owner, legacy, headers } = await legacyFixture();
  try {
    await owner.client().invite("modern@example.com", "modern", "member");
    const modern = await cluster.add({ name: "modern", login: "modern@example.com" });
    expect((await modern.client().join(owner.peerAddr)).admitted).toBe(true);
    await waitFor(() => modern.d.core.roster.nodes.get(modern.d.nodeId)?.peer_sig_v1, { what: "admission marker" });
    expect(owner.d.core.roster.nodes.get(modern.d.nodeId)?.peer_sig_v1).toBe(true);
    expect(modern.d.core.roster.nodes.get(modern.d.nodeId)?.peer_sig_v1).toBe(true);
    expect(peerSigStrict(owner.d.core.roster, owner.d.core.store)).toBe(false);
    const sig = signPeerRequest(legacy, { method: "GET", path: "/peer/v1/vv", query: "", body: "",
      requester: legacy.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "", ts: Date.now(), nonce: newPeerNonce() });
    const signed = await fetch(`http://${owner.peerAddr}/peer/v1/vv`, { headers: { ...headers, ...sig } });
    expect(signed.status).toBe(200);
    await waitFor(() => modern.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1, { what: "legacy proof replicated" });
    expect(peerSigStrict(owner.d.core.roster, owner.d.core.store)).toBe(true);
    expect(peerSigStrict(modern.d.core.roster, modern.d.core.store)).toBe(true);
    await waitFor(() => modern.d.core.roster.peer_sig_strict, { what: "strict marker replicated" });
    await owner.restart();
    expect(owner.d.core.roster.peer_sig_strict).toBe(true);
    const unsigned = await fetch(`http://${owner.peerAddr}/peer/v1/vv`, { headers });
    expect(unsigned.status).toBe(403);
    const newKey = generateKeys();
    cluster.identities.set(newKey.nodeId, { login: "legacy@example.com", nodeName: "old-new" });
    const join = await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST",
      headers: { "X-Walkie-Node": newKey.nodeId }, body: JSON.stringify({ pubkey: newKey.pubkey, hostname: "old-new", ip: "127.0.0.1" }) });
    expect(join.status).toBe(403);
    expect((await join.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: "update_required", message: "this team requires Walkie 0.2.0-pre.10 or newer: update, then join again",
    });
  } finally { await cluster.close(); }
}, 30_000);

test("a member relays a signed legacy vv proof and the authority verifies it", async () => {
  const cluster = new Cluster();
  const legacy = generateKeys();
  let reporter = "";
  let fakeStopped = false;
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => {
    if (new URL(req.url).pathname !== "/peer/v1/vv") return Response.json({ events: [] });
    const body = { node: legacy.nodeId, vv: {}, ts: Date.now() };
    const requester = req.headers.get("x-walkie-node") ?? "";
    const challenge = req.headers.get("x-walkie-vv-challenge") ?? "";
    const relay_proof = requester === reporter
      ? signPeerVv(legacy, { node: body.node, ts: body.ts }, reporter, challenge) : undefined;
    const proved = { ...body, ...(relay_proof ? { relay_proof } : {}) };
    return Response.json(requester === reporter
      ? { ...proved, proof: signPeerVv(legacy, proved, reporter, challenge) }
      : body);
  } });
  try {
    const owner = await cluster.add({ name: "owner", login: "owner@example.com" });
    await owner.client().init("relay", "owner");
    await owner.client().request("POST", "/v1/team/peer-sig-strict", { strict: false });
    await owner.client().invite("legacy@example.com", "legacy", "member");
    cluster.identities.set(legacy.nodeId, { login: "legacy@example.com", nodeName: "legacy" });
    const headers = { "X-Walkie-Node": legacy.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" };
    const joined = await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST", headers,
      body: JSON.stringify({ pubkey: legacy.pubkey, hostname: "legacy", ip: "127.0.0.1", port: fake.port }) });
    expect(joined.status).toBe(200);
    await owner.client().invite("reporter@example.com", "reporter", "member");
    const member = await cluster.add({ name: "reporter", login: "reporter@example.com" });
    expect((await member.client().join(owner.peerAddr)).admitted).toBe(true);
    await waitFor(() => member.d.core.roster.nodes.has(legacy.nodeId), { what: "legacy roster replicated" });
    expect(owner.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1).toBeUndefined();
    const forgedBody = JSON.stringify({ node: legacy.nodeId, body: { node: legacy.nodeId, ts: Date.now() },
      challenge: newPeerNonce(), proof: "invalid" });
    const forgedSig = signPeerRequest(member.d.core.keys, { method: "POST", path: "/peer/v1/peer-proof", query: "",
      body: forgedBody, requester: member.d.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "",
      ts: Date.now(), nonce: newPeerNonce() });
    const forged = await fetch(`http://${owner.peerAddr}/peer/v1/peer-proof`, { method: "POST", body: forgedBody,
      headers: { "X-Walkie-Node": member.d.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "", ...forgedSig } });
    expect(forged.status).toBe(403);
    expect(owner.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1).toBeUndefined();
    await owner.stop();
    reporter = member.d.nodeId;
    const report = member.d.client.reportPeerProof.bind(member.d.client);
    let attempts = 0;
    member.d.client.reportPeerProof = (...args) => { attempts++; return report(...args); };
    // A background anti-entropy run still in flight makes the explicit call below a no-op (sync.ts: s.running).
    await waitFor(() => !member.d.sync.peerState(legacy.nodeId)?.running, { what: "initial legacy sync" });
    await member.d.sync.antiEntropy(member.d.core.roster.nodes.get(legacy.nodeId)!);
    expect(member.d.core.store.getMeta(`peer_sig_required:${legacy.nodeId}`)).toBe("1");
    expect(member.d.core.store.getMeta(`pending_peer_proof:${legacy.nodeId}`)).not.toBeNull();
    member.d.sync.tick();
    member.d.sync.tick();
    expect(attempts).toBe(1);
    const oldBody = { node: legacy.nodeId, ts: Date.now() - 3 * 60 * 1000 };
    const oldChallenge = newPeerNonce();
    member.d.core.store.setMeta(`pending_peer_proof:${legacy.nodeId}`, JSON.stringify({ node: legacy.nodeId,
      body: oldBody, challenge: oldChallenge, proof: signPeerVv(legacy, oldBody, member.d.nodeId, oldChallenge) }));
    fake.stop(true);
    fakeStopped = true;
    await member.restart();
    expect(member.d.core.store.getMeta(`pending_peer_proof:${legacy.nodeId}`)).not.toBeNull();
    await owner.start();
    await waitFor(() => owner.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1, { what: "authority recorded relayed proof" });
    await waitFor(() => member.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1, { what: "relayed marker replicated" });
    await waitFor(() => member.d.core.store.getMeta(`pending_peer_proof:${legacy.nodeId}`) === null,
      { what: "durable proof acknowledged" });
    const unsigned = await fetch(`http://${owner.peerAddr}/peer/v1/vv`, { headers });
    expect(unsigned.status).toBe(403);
  } finally { if (!fakeStopped) fake.stop(true); await cluster.close(); }
}, 30_000);

test("a pending peer proof is recorded locally after its holder becomes authority", async () => {
  const cluster = new Cluster();
  const legacy = generateKeys();
  let reporter = "";
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => {
    if (new URL(req.url).pathname !== "/peer/v1/vv") return Response.json({ events: [] });
    const body = { node: legacy.nodeId, vv: {}, ts: Date.now() };
    const requester = req.headers.get("x-walkie-node") ?? "";
    const challenge = req.headers.get("x-walkie-vv-challenge") ?? "";
    if (requester !== reporter) return Response.json(body);
    const relay_proof = signPeerVv(legacy, { node: body.node, ts: body.ts }, reporter, challenge);
    const proved = { ...body, relay_proof };
    return Response.json({ ...proved, proof: signPeerVv(legacy, proved, reporter, challenge) });
  } });
  let fakeStopped = false;
  try {
    const owner = await cluster.add({ name: "owner", login: "owner@example.com" });
    await owner.client().init("relay", "owner");
    await owner.client().request("POST", "/v1/team/peer-sig-strict", { strict: false });
    await owner.client().invite("legacy@example.com", "legacy", "member");
    cluster.identities.set(legacy.nodeId, { login: "legacy@example.com", nodeName: "legacy" });
    const joined = await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST",
      headers: { "X-Walkie-Node": legacy.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "" },
      body: JSON.stringify({ pubkey: legacy.pubkey, hostname: "legacy", ip: "127.0.0.1", port: fake.port }) });
    expect(joined.status).toBe(200);
    await owner.client().invite("reporter@example.com", "reporter", "owner");
    const member = await cluster.add({ name: "reporter", login: "reporter@example.com" });
    expect((await member.client().join(owner.peerAddr)).admitted).toBe(true);
    await waitFor(() => member.d.core.roster.nodes.has(legacy.nodeId), { what: "legacy roster replicated" });
    reporter = member.d.nodeId;
    let attempts = 0;
    member.d.client.reportPeerProof = async () => { attempts++; throw new Error("authority unavailable"); };
    await waitFor(() => !member.d.sync.peerState(legacy.nodeId)?.running, { what: "initial legacy sync" });
    await member.d.sync.antiEntropy(member.d.core.roster.nodes.get(legacy.nodeId)!);
    const pendingKey = `pending_peer_proof:${legacy.nodeId}`;
    expect(member.d.core.store.getMeta(pendingKey)).not.toBeNull();
    expect(owner.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1).toBeUndefined();
    fake.stop(true);
    fakeStopped = true;
    const store = member.d.core.store;
    const setMeta = store.setMeta.bind(store);
    let blocked = 0;
    store.setMeta = (key, value) => {
      if (key.startsWith("peer_proof_consumed:")) { blocked++; throw new Error("marker store unavailable"); }
      setMeta(key, value);
    };
    try {
      await owner.client().setAuthority(member.hostname);
      await waitFor(() => member.d.core.isAuthority(), { what: "reporter authority transfer" });
      await waitFor(() => blocked > 0, { what: "failed local proof recording" });
      expect(member.d.core.store.getMeta(pendingKey)).not.toBeNull();
      expect(member.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1).toBeUndefined();
    } finally { store.setMeta = setMeta; }
    const attemptsBeforeLocalRecord = attempts;
    member.d.sync.tick();
    await waitFor(() => member.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1, { what: "local proof marker" });
    expect(member.d.core.store.getMeta(pendingKey)).toBeNull();
    expect(member.d.core.store.vv()[member.d.nodeId]).toBeGreaterThan(0);
    expect(attempts).toBe(attemptsBeforeLocalRecord);
  } finally { if (!fakeStopped) fake.stop(true); await cluster.close(); }
}, 30_000);

test("the authority accepts old signed evidence only for a currently admitted node, within 30 days", async () => {
  const { cluster, owner, legacy } = await legacyFixture();
  try {
    await owner.client().invite("reporter@example.com", "reporter", "member");
    const member = await cluster.add({ name: "reporter", login: "reporter@example.com" });
    expect((await member.client().join(owner.peerAddr)).admitted).toBe(true);
    const send = async (ageMs: number) => {
      const body = { node: legacy.nodeId, ts: Date.now() - ageMs };
      const challenge = newPeerNonce();
      const relay = { node: legacy.nodeId, body, challenge,
        proof: signPeerVv(legacy, body, member.d.nodeId, challenge) };
      const wire = JSON.stringify(relay);
      const signed = signPeerRequest(member.d.core.keys, { method: "POST", path: "/peer/v1/peer-proof", query: "",
        body: wire, requester: member.d.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "",
        ts: Date.now(), nonce: newPeerNonce() });
      return fetch(`http://${owner.peerAddr}/peer/v1/peer-proof`, { method: "POST", body: wire,
        headers: { "X-Walkie-Node": member.d.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "", ...signed } });
    };
    expect((await send(31 * 24 * 60 * 60 * 1000)).status).toBe(403);
    expect(owner.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1).toBeUndefined();
    const accepted = await send(3 * 60 * 1000);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ recorded: true });
    await owner.client().request("POST", "/v1/team/member", { handle: "legacy", role: "removed" });
    expect((await send(3 * 60 * 1000)).status).toBe(403);
  } finally { await cluster.close(); }
}, 30_000);

test("a consumed relay envelope is recorded once and a lost response is safely retried", async () => {
  const { cluster, owner, legacy } = await legacyFixture();
  try {
    await owner.client().invite("reporter@example.com", "reporter", "member");
    const member = await cluster.add({ name: "reporter", login: "reporter@example.com" });
    expect((await member.client().join(owner.peerAddr)).admitted).toBe(true);
    const body = { node: legacy.nodeId, ts: Date.now() };
    const challenge = newPeerNonce();
    const envelope = { node: legacy.nodeId, body, challenge,
      proof: signPeerVv(legacy, body, member.d.nodeId, challenge) };
    const digest = createHash("sha256").update(canonicalJson(envelope)).digest("hex");
    const wire = JSON.stringify(envelope);
    const send = async () => {
      const sig = signPeerRequest(member.d.core.keys, { method: "POST", path: "/peer/v1/peer-proof", query: "",
        body: wire, requester: member.d.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "",
        ts: Date.now(), nonce: newPeerNonce() });
      return fetch(`http://${owner.peerAddr}/peer/v1/peer-proof`, { method: "POST", body: wire,
        headers: { "X-Walkie-Node": member.d.nodeId, "X-Walkie-Team": owner.d.core.teamId ?? "", ...sig } });
    };
    expect((await send()).status).toBe(200); // first response is not used by the reporter
    const recordedAt = owner.d.core.store.vv()[owner.d.nodeId];
    expect(owner.d.core.store.getMeta(`peer_proof_consumed:${digest}`)).toBe(legacy.nodeId);
    expect(await (await send()).json()).toEqual({ recorded: true });
    expect(owner.d.core.store.vv()[owner.d.nodeId]).toBe(recordedAt);
    await owner.restart();
    expect(await (await send()).json()).toEqual({ recorded: true });
    expect(owner.d.core.store.vv()[owner.d.nodeId]).toBe(recordedAt);
    expect(owner.d.core.store.listMeta("peer_proof_consumed:")).toHaveLength(1);
  } finally { await cluster.close(); }
}, 30_000);

test("an owner can explicitly enable signed peer requests before legacy upgrades", async () => {
  const { cluster, owner, legacy, headers } = await legacyFixture();
  try {
    expect(peerSigStrict(owner.d.core.roster, owner.d.core.store)).toBe(false);
    await owner.client().request("POST", "/v1/team/peer-sig-strict", {});
    expect(owner.d.core.roster.peer_sig_strict).toBe(true);
    const unsigned = await fetch(`http://${owner.peerAddr}/peer/v1/vv`, { headers });
    expect(unsigned.status).toBe(403);
    expect(owner.d.core.roster.nodes.get(legacy.nodeId)?.peer_sig_v1).toBeUndefined();
  } finally { await cluster.close(); }
});

test("a signed pending join retains its proof through owner approval", async () => {
  const { cluster, owner } = await legacyFixture();
  try {
    const key = generateKeys();
    cluster.identities.set(key.nodeId, { login: "owner@example.com", nodeName: "pending" });
    const body = JSON.stringify({ pubkey: key.pubkey, hostname: "pending", ip: "192.0.2.1" });
    const sig = signPeerRequest(key, { method: "POST", path: "/peer/v1/join", query: "", body,
      requester: key.nodeId, target: owner.d.nodeId, team: owner.d.core.teamId ?? "", ts: Date.now(), nonce: newPeerNonce() });
    const pending = await fetch(`http://${owner.peerAddr}/peer/v1/join`, { method: "POST",
      headers: { "X-Walkie-Node": key.nodeId, ...sig }, body });
    expect(await pending.json()).toMatchObject({ admitted: false, reason: "pending_approval" });
    expect(owner.d.core.roster.nodes.has(key.nodeId)).toBe(false);
    admitJoin(owner.d.core, key.nodeId, true);
    expect(owner.d.core.roster.nodes.get(key.nodeId)?.peer_sig_v1).toBe(true);
  } finally { await cluster.close(); }
});
