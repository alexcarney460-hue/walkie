import { afterEach, expect, test } from "bun:test";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { flushRequests, signRequest } from "../../src/daemon/requests.ts";
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
  await alex.client().invite("bea@example.com", "bea", "member");
  expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
  await waitFor(() => olive.d.core.roster.members.get("bea@example.com")?.role === "member", { what: "roster synced" });
  await waitFor(() => olive.d.core.store.queuedRequests().length === 0, { what: "setup queue drained", timeoutMs: 20_000 });
  await waitFor(() => olive.d.core.store.getMeta(`peer_caps_verified:${alex.d.core.nodeId}`) === "1", { what: "authority version confirmed" });
  return { alex, olive };
}

async function stagedPair(alex: TestNode, olive: TestNode, beforeSecond?: () => void, beforeFlush?: () => void, client?: PeerClient): Promise<void> {
  alex.d.sync.stop();
  olive.d.sync.stop();
  const body = { login: "noor@example.com", handle: "noor" };
  for (const role of ["owner", "member"] as const) {
    const req = signRequest(olive.d.core, "team.member", { ...body, role });
    olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
  }
  expect(olive.d.core.store.queuedRequests().map((q) => JSON.parse(q.json).body.role)).toEqual(["owner", "member"]);
  beforeFlush?.();
  let pulls = 0;
  await flushRequests(olive.d.core, client ?? olive.d.client, async (addr, origin, seq) => {
    await olive.d.sync.requestCatchUp(addr, origin, seq);
    if (++pulls === 1) beforeSecond?.();
  });
}

test("a foreign change before flush refuses both queued role requests", async () => {
  const { alex, olive } = await team();
  const initial = alex.d.core.rosterEntries().length;
  await stagedPair(alex, olive, undefined, () => alex.d.core.emit("team.member", { login: "noor@example.com", handle: "noor", role: "observer" }));
  expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("observer");
  expect(alex.d.core.rosterEntries().length).toBe(initial + 1);
}, 60_000);

test("a foreign change between queued requests refuses the second", async () => {
  const { alex, olive } = await team();
  await stagedPair(alex, olive, () => alex.d.core.emit("team.member", { login: "noor@example.com", handle: "noor", role: "observer" }));
  expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("observer");
  expect(alex.d.core.rosterEntries().filter((e) => e.kind === "team.member" && e.body.handle === "noor").map((e) => e.body.role)).toEqual(["member", "owner", "observer"]);
}, 60_000);

test("a foreign topic edit between queued channel requests prevents re-signing", async () => {
  const { alex, olive } = await team();
  alex.d.core.emit("channel.upsert", { name: "secret", members: ["alex", "olive"] });
  await waitFor(() => olive.d.core.roster.channels.has("secret"), { what: "channel synced" });
  alex.d.sync.stop();
  olive.d.sync.stop();
  for (const members of [["alex", "olive", "noor"], ["alex", "olive", "noor", "bea"]]) {
    const req = signRequest(olive.d.core, "channel.upsert", { name: "secret", members });
    olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
  }
  let pulls = 0;
  await flushRequests(olive.d.core, olive.d.client, async (addr, origin, seq) => {
    await olive.d.sync.requestCatchUp(addr, origin, seq);
    if (++pulls === 1) alex.d.core.emit("channel.upsert", { name: "secret", topic: "foreign edit" });
  });
  expect(alex.d.core.roster.channels.get("secret")?.topic).toBe("foreign edit");
  expect(alex.d.core.roster.channels.get("secret")?.members).toEqual(["alex", "olive", "noor"]);
}, 60_000);

for (const role of ["observer", "removed"] as const) {
  test(`a requester changed to ${role} between queued requests cannot apply the correction`, async () => {
    const { alex, olive } = await team();
    await stagedPair(alex, olive, () => alex.d.core.emit("team.member", { login: "olive@example.com", handle: "olive", role }));
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("owner");
    expect(alex.d.core.roster.members.get("olive@example.com")?.role).toBe(role);
  }, 60_000);
}

test("a re-signed grant still needs a confirmed authority version", async () => {
  const { alex, olive } = await team();
  const real = olive.d.client;
  let probes = 0;
  const client = {
    addrOf: real.addrOf.bind(real),
    rosterRequest: real.rosterRequest.bind(real),
    vv: async (addr: Parameters<PeerClient["vv"]>[0], pubkey: string) => {
      const vv = await real.vv(addr, pubkey);
      if (++probes === 2) olive.d.core.store.deleteMeta(`peer_caps_verified:${alex.d.core.nodeId}`);
      if (probes !== 3) return vv;
      return { ...vv, capabilities: undefined, stats: undefined };
    },
  } as PeerClient;
  await stagedPair(alex, olive, undefined, undefined, client);
  expect(probes).toBe(3);
  expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("owner");
}, 60_000);

test("a failed catch-up keeps the applied predecessor until its correction can follow", async () => {
  const { alex, olive } = await team();
  alex.d.sync.stop();
  olive.d.sync.stop();
  for (const role of ["owner", "observer"] as const) {
    const req = signRequest(olive.d.core, "team.member", { login: "noor@example.com", handle: "noor", role });
    olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
  }
  await flushRequests(olive.d.core, olive.d.client, async () => { throw new Error("pull failed"); });
  expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("owner");
  expect(olive.d.core.store.queuedRequests()).toHaveLength(2);
  await flushRequests(olive.d.core, olive.d.client, olive.d.sync.requestCatchUp);
  expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("observer");
  expect(olive.d.core.store.queuedRequests()).toHaveLength(0);
}, 60_000);

async function queuedPair(alex: TestNode, olive: TestNode, kind: "team.member" | "channel.upsert", first: Record<string, unknown>, second: Record<string, unknown>): Promise<void> {
  await alex.stop();
  for (const body of [first, second]) {
    const req = signRequest(olive.d.core, kind, kind === "team.member" ? { login: "noor@example.com", handle: "noor", ...body } : body);
    olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
  }
  await alex.start();
  await waitFor(() => olive.d.core.store.queuedRequests().length === 0, { what: "corrections drained", timeoutMs: 40_000 });
}

for (const [first, second, final] of [["owner", "observer", "observer"], ["owner", "member", "member"]] as const) {
  test(`queued role ${first} then ${second} ends at ${final}`, async () => {
    const { alex, olive } = await team();
    await queuedPair(alex, olive, "team.member", { handle: "noor", role: first }, { handle: "noor", role: second });
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe(final);
  }, 120_000);
}

for (const [first, second, final] of [
  [{ members: ["alex", "olive", "noor"] }, { members: ["alex", "olive"] }, ["alex", "olive"]],
  [{ public: true }, { members: ["alex", "olive"] }, ["alex", "olive"]],
  [{ members: ["alex", "olive", "noor"] }, { members: ["alex", "olive", "noor", "bea"] }, ["alex", "olive", "noor", "bea"]],
] as const) {
  test(`queued channel correction ${JSON.stringify(first)} then ${JSON.stringify(second)}`, async () => {
    const { alex, olive } = await team();
    alex.d.core.emit("channel.upsert", { name: "secret", members: ["alex", "olive"] });
    await waitFor(() => olive.d.core.roster.channels.get("secret")?.members?.length === 2, { what: "channel synced" });
    await queuedPair(alex, olive, "channel.upsert", { name: "secret", ...first }, { name: "secret", ...second });
    expect(alex.d.core.roster.channels.get("secret")?.members).toEqual(final);
  }, 120_000);
}

test("one queued channel narrowing applies unchanged", async () => {
  const { alex, olive } = await team();
  alex.d.core.emit("channel.upsert", { name: "secret", members: ["alex", "olive", "noor"] });
  await waitFor(() => olive.d.core.roster.channels.get("secret")?.members?.length === 3, { what: "channel synced" });
  await alex.stop();
  const req = signRequest(olive.d.core, "channel.upsert", { name: "secret", members: ["alex", "olive"] });
  olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
  await alex.start();
  await waitFor(() => alex.d.core.roster.channels.get("secret")?.members?.length === 2, { what: "narrowing applied", timeoutMs: 40_000 });
  expect(alex.d.core.roster.channels.get("secret")?.members).toEqual(["alex", "olive"]);
}, 120_000);
