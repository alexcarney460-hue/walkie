import { expect, test } from "bun:test";
import { SyncManager } from "../../src/daemon/sync.ts";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";

test("a local 20 s stall preserves direct, Tailscale and relayed liveness, then a missing peer expires on healthy time", async () => {
  let now = 1_000;
  let stalled = 0;
  let fail = false;
  let stallOnFailure = false;
  const nodes = new Map(["self", "tail", "direct", "relay"].map((node_id) => [node_id, {
    node_id, login: "person", hostname: node_id, pubkey: "key", ip: "127.0.0.1", port: 1, revoked: false,
  }]));
  const core = {
    nodeId: "self", teamId: "team", roster: { nodes, members: new Map([["person", { login: "person", handle: "person", role: "owner" }]]) },
    store: { listMeta: () => [], vv: () => ({}) },
    hub: { nodesChanged: () => {}, agentsChanged: () => {}, accountsChanged: () => {} },
    log: { warn: () => {} },
    fillableStubIds: () => [], isAuthority: () => true,
  } as unknown as Core;
  const client = {
    addrOf: (n: { node_id: string }) => n.node_id === "relay" ? null : { host: n.node_id, ...(n.node_id === "direct" ? { pubkey: "key" } : {}) },
    vv: async (addr: { host: string }) => {
      if (fail) {
        if (stallOnFailure) { now += 20_000; stalled += 20_000; }
        throw new PeerCallError(0, "unreachable", "timed out");
      }
      return { vv: {}, online: addr.host === "tail" ? ["relay"] : [] };
    },
  } as unknown as PeerClient;
  const sync = new SyncManager(core, client, { livenessMs: 45_000, now: () => now, stallTotal: () => stalled });
  await sync.antiEntropy(nodes.get("tail") as never);
  await sync.antiEntropy(nodes.get("direct") as never);
  expect(["tail", "direct", "relay"].map((id) => sync.isOnline(id))).toEqual([true, true, true]);

  now += 40_000;
  stalled += 20_000; // injected local lag; no CPU work or real timer wait
  expect(["tail", "direct", "relay"].map((id) => sync.isOnline(id))).toEqual([true, true, true]);
  expect(sync.reachedPeers().sort()).toEqual(["direct", "tail"]);

  fail = true;
  stallOnFailure = true;
  await sync.antiEntropy(nodes.get("direct") as never);
  expect(sync.peerState("direct")?.failedAt).toBeNull();
  expect(sync.isOnline("direct")).toBe(true);

  now += 25_000; // 45 s of healthy time since the replies
  expect(["tail", "direct", "relay"].map((id) => sync.isOnline(id))).toEqual([false, false, false]);
  stallOnFailure = false;
  await sync.antiEntropy(nodes.get("direct") as never);
  expect(sync.peerState("direct")?.failedAt).toBe(now);
});
