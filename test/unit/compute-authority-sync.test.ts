// WALK-101: what ComputeService is told about its sync with the roster authority. `authorityLevelAt` is the daemon's wiring
// (main.ts passes it to ComputeService as authoritySyncedAt); `PeerState.levelAt` is stamped at the START of a sync that left
// this node holding everything the peer's version vector listed, never at its end.
import { describe, expect, test } from "bun:test";
import { authorityLevelAt } from "../../src/daemon/compute/authority-sync.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";
import { SyncManager } from "../../src/daemon/sync.ts";

describe("authorityLevelAt", () => {
  const core = (authority: string | null) => ({ authority, nodeId: "me", clock: () => 5_000 }) as Pick<Core, "authority" | "nodeId" | "clock">;

  test("the authority's own daemon is level with itself: now", () => {
    expect(authorityLevelAt(core("me"), () => { throw new Error("must not ask the sync manager"); })).toBe(5_000);
  });

  test("another machine: the start of its latest level sync with the authority, else null", () => {
    const asked: string[] = [];
    const peers: Record<string, { levelAt?: number | null }> = { auth: { levelAt: 1_234 }, behind: { levelAt: null }, fresh: {} };
    const peerState = (id: string) => { asked.push(id); return peers[id]; };
    expect(authorityLevelAt(core("auth"), peerState)).toBe(1_234);
    expect(authorityLevelAt(core("behind"), peerState)).toBeNull(); // synced but never level
    expect(authorityLevelAt(core("fresh"), peerState)).toBeNull(); // no level sync yet
    expect(authorityLevelAt(core("stranger"), peerState)).toBeNull(); // never reached (no shared transport, or offline)
    expect(asked).toEqual(["auth", "behind", "fresh", "stranger"]);
  });

  test("no authority known: null", () => {
    expect(authorityLevelAt(core(null), () => ({ levelAt: 9 }))).toBeNull();
  });
});

describe("SyncManager stamps levelAt at the start of the sync", () => {
  function world(initialVv: Record<string, number>, vvDelayMs: number) {
    const peer = { vv: initialVv };
    const node = { node_id: "peer", login: "person", hostname: "peer", pubkey: "key", ip: "127.0.0.1", port: 1, revoked: false };
    const core = {
      nodeId: "self", teamId: "team", roster: { nodes: new Map([[node.node_id, node]]), members: new Map([["person", { login: "person", handle: "person", role: "owner" }]]) },
      store: { listMeta: () => [], vv: () => ({}) },
      hub: { nodesChanged: () => {}, agentsChanged: () => {}, accountsChanged: () => {} },
      log: { warn: () => {} },
      fillableStubIds: () => [], isAuthority: () => true,
    } as unknown as Core;
    const client = {
      addrOf: () => ({ host: "peer" }),
      vv: async () => { await Bun.sleep(vvDelayMs); return { vv: peer.vv, online: [] }; },
    } as unknown as PeerClient;
    const sync = new SyncManager(core, client, {});
    return { sync, node, peer };
  }

  test("level with the peer: levelAt is when the sync began, not when it ended (lastSync)", async () => {
    const w = world({}, 40);
    const before = Date.now();
    await w.sync.antiEntropy(w.node as never);
    const s = w.sync.peerState("peer")!;
    expect(s.behind).toBe(0);
    expect(s.levelAt).toBeGreaterThanOrEqual(before);
    expect(s.lastSync! - s.levelAt!).toBeGreaterThanOrEqual(30); // the 40 ms the vector took are not claimed
  });

  test("behind the peer after the pull (it can't be fetched): no levelAt", async () => {
    const w = world({ a1: 5 }, 0); // the stub client can't pull, so 5 events stay missing
    await w.sync.antiEntropy(w.node as never);
    const s = w.sync.peerState("peer")!;
    expect(s.behind).toBe(5);
    expect(s.levelAt ?? null).toBeNull();
  });

  test("a later sync that is behind leaves the earlier level time alone (what was held then is still held)", async () => {
    const w = world({}, 0);
    await w.sync.antiEntropy(w.node as never);
    const level = w.sync.peerState("peer")!.levelAt;
    expect(level).toBeGreaterThan(0);
    await Bun.sleep(5);
    w.peer.vv = { a1: 3 };
    await w.sync.antiEntropy(w.node as never);
    expect(w.sync.peerState("peer")!.behind).toBe(3);
    expect(w.sync.peerState("peer")!.levelAt).toBe(level);
  });
});
