import { afterEach, expect, test } from "bun:test";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { flushRequests, signRequest, submitRequest } from "../../src/daemon/requests.ts";
import { rememberPeerCapabilities } from "../../src/daemon/peer-capabilities.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";

let cluster: Cluster | undefined;
afterEach(async () => { await cluster?.close(); cluster = undefined; });

async function team(): Promise<{ alex: TestNode; olive: TestNode }> {
  cluster = new Cluster();
  const alex = await cluster.add({ name: "alex", login: "alex@example.com" });
  const olive = await cluster.add({ name: "olive", login: "olive@example.com" });
  await alex.client().init("acme", "alex");
  await alex.client().invite("olive@example.com", "olive", "owner");
  await alex.client().invite("noor@example.com", "noor", "member");
  expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
  await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member", { what: "roster synced" });
  await waitFor(() => olive.d.core.store.queuedRequests().length === 0, { what: "setup queue drained", timeoutMs: 20_000 });
  await waitFor(() => olive.d.core.store.getMeta(`peer_caps_verified:${alex.d.core.nodeId}`) === "1", { what: "authority version confirmed" });
  return { alex, olive };
}

test("a queued grant refused on an unconfirmed authority version stays queued and applies on a later flush", async () => {
  const { alex, olive } = await team();
  alex.d.sync.stop();
  olive.d.sync.stop();
  // The authority is back and answers, but this machine has not confirmed its version yet.
  for (const key of [`peer_capabilities:${alex.d.core.nodeId}`, `peer_caps_verified:${alex.d.core.nodeId}`]) {
    olive.d.core.store.deleteMeta(key);
  }
  const req = signRequest(olive.d.core, "team.member", { login: "noor@example.com", handle: "noor", role: "owner" });
  olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
  const real = olive.d.client;
  let probes = 0;
  let sends = 0;
  const client = {
    addrOf: real.addrOf.bind(real),
    rosterRequest: async (...args: Parameters<PeerClient["rosterRequest"]>) => { sends++; return real.rosterRequest(...args); },
    vv: async (addr: Parameters<PeerClient["vv"]>[0], pubkey: string) => {
      const vv = await real.vv(addr, pubkey);
      return ++probes === 1 ? { ...vv, verified: false } : vv;
    },
  } as PeerClient;
  await flushRequests(olive.d.core, client, olive.d.sync.requestCatchUp);
  expect(probes).toBe(1);
  expect(sends).toBe(0);
  expect(olive.d.core.store.queuedRequests()).toHaveLength(1);
  expect(olive.d.core.store.queuedRequests()[0]!.last_error).toContain("could not be confirmed");
  expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("member");
  await flushRequests(olive.d.core, olive.d.client, olive.d.sync.requestCatchUp);
  expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("owner");
  expect(olive.d.core.store.queuedRequests()).toHaveLength(0);
}, 60_000);

test("a queued grant is not sent to an authority known to run an old build; the row survives", async () => {
  const { alex, olive } = await team();
  alex.d.sync.stop();
  olive.d.sync.stop();
  // A verified record of an old build and a probe that cannot improve on it.
  rememberPeerCapabilities(olive.d.core.store, alex.d.core.nodeId, { version: "0.2.0-pre.13", caps: [] });
  const req = signRequest(olive.d.core, "team.member", { login: "noor@example.com", handle: "noor", role: "owner" });
  olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
  const real = olive.d.client;
  let sends = 0;
  const client = {
    addrOf: real.addrOf.bind(real),
    rosterRequest: async (...args: Parameters<PeerClient["rosterRequest"]>) => { sends++; return real.rosterRequest(...args); },
    vv: async (addr: Parameters<PeerClient["vv"]>[0], pubkey: string) => {
      void addr;
      void pubkey;
      throw new Error("no answer");
    },
  } as unknown as PeerClient;
  await flushRequests(olive.d.core, client, olive.d.sync.requestCatchUp);
  expect(sends).toBe(0);
  expect(olive.d.core.store.queuedRequests()).toHaveLength(1);
  expect(olive.d.core.store.queuedRequests()[0]!.last_error).toContain("could not be confirmed");
  expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("member");
}, 60_000);

for (const [answer, shouldSend] of [[undefined, false], ["0.2.0-pre.13", false], ["0.2.0-pre.14", true]] as const) {
  test(`cached pre.14 cannot authorize a queued grant when live version is ${answer ?? "unavailable"}`, async () => {
    const { alex, olive } = await team();
    alex.d.sync.stop();
    olive.d.sync.stop();
    rememberPeerCapabilities(olive.d.core.store, alex.d.core.nodeId, { version: "0.2.0-pre.14", caps: [] });
    const req = signRequest(olive.d.core, "team.member", { login: "noor@example.com", handle: "noor", role: "owner" });
    olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
    let sends = 0;
    const client = {
      addrOf: olive.d.client.addrOf.bind(olive.d.client),
      vv: async () => {
        if (!answer) throw new Error("version probe failed");
        return { verified: true, capabilities: { version: answer, caps: [] } };
      },
      rosterRequest: async () => { sends++; return {}; },
    } as unknown as PeerClient;
    await flushRequests(olive.d.core, client, async () => {});
    expect(sends).toBe(shouldSend ? 1 : 0);
    expect(olive.d.core.store.queuedRequests()).toHaveLength(shouldSend ? 0 : 1);
    if (!answer) expect(olive.d.core.store.queuedRequests()[0]!.last_error).toContain("could not be confirmed");
  }, 60_000);
}

test("interactive grant queues after a failed live version probe despite cached pre.14", async () => {
  const { alex, olive } = await team();
  rememberPeerCapabilities(olive.d.core.store, alex.d.core.nodeId, { version: "0.2.0-pre.14", caps: [] });
  let sends = 0;
  const client = {
    addrOf: olive.d.client.addrOf.bind(olive.d.client),
    vv: async () => { throw new Error("version probe failed"); },
    rosterRequest: async () => { sends++; return {}; },
  } as unknown as PeerClient;
  expect(await submitRequest(olive.d.core, client, async () => {}, "team.member", { login: "noor@example.com", handle: "noor", role: "owner" }))
    .toMatchObject({ queued: true });
  expect(sends).toBe(0);
  expect(olive.d.core.store.queuedRequests()).toHaveLength(1);
}, 60_000);
