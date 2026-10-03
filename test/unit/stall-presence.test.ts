// WALK-87: a machine is not shown offline because of a stall. The rule (sync.ts, "PRESENCE RULE"): presence is judged on
// healthy time, the time since the last contact less what this daemon spent stalled; a call that failed across a stall of
// ours says nothing about the peer; and a peer's own request is contact too, so a peer that stalled shows online the moment
// it speaks. Time and stalls are injected: no CPU work and no real waiting.
import { afterEach, describe, expect, test } from "bun:test";
import { FakeIdentity, type WhoisResult } from "../../src/daemon/identity.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { PeerCallError, type PeerAddr, type PeerClient } from "../../src/daemon/peer-client.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { SyncManager, type SyncOptions } from "../../src/daemon/sync.ts";
import { LoopWatchdog } from "../../src/daemon/watchdog.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { makeCore } from "../helpers/core.ts";
import { tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

interface Rec { node_id: string; login: string; hostname: string; pubkey: string; ip: string; port: number; revoked: boolean }

/** A daemon with four peers: `tail` (Tailscale), `direct`, `relay` (no transport in common) and `solo` (a second member's). */
function setup(syncOpts?: (clock: { now: number; stalled: number }) => SyncOptions) {
  const clock = { now: 1_000, stalled: 0 };
  const nodes = new Map<string, Rec>(["self", "tail", "direct", "relay", "solo"].map((node_id) => [node_id, {
    node_id, login: node_id === "solo" ? "other" : "person", hostname: node_id, pubkey: "key", ip: "127.0.0.1", port: 1, revoked: false,
  }]));
  const members = new Map([["person", { login: "person", handle: "person", role: "owner" }], ["other", { login: "other", handle: "other", role: "member" }]]);
  const changed = { nodes: 0, agents: 0 };
  const core = {
    nodeId: "self", teamId: "team", roster: { nodes, members, channels: new Map() },
    store: { listMeta: () => [], vv: () => ({}) },
    hub: { nodesChanged: () => { changed.nodes++; }, agentsChanged: () => { changed.agents++; }, accountsChanged: () => {} },
    log: { warn: () => {}, debug: () => {} },
    fillableStubIds: () => [], isAuthority: () => true,
  } as unknown as Core;
  let failure: "stall" | "down" | null = null;
  /** The calls this daemon made to peers (and what they were): a skipped push is a push never made. */
  const calls = { vvs: [] as string[], pushes: [] as string[] };
  const client = {
    addrOf: (n: { node_id: string }): PeerAddr | null => n.node_id === "relay" ? null : { host: n.node_id, ...(n.node_id === "direct" ? { pubkey: "key" } : {}) } as unknown as PeerAddr,
    vv: async (addr: { host: string }) => {
      calls.vvs.push(addr.host);
      if (failure === "stall") { clock.now += 20_000; clock.stalled += 20_000; }
      if (failure !== null) throw new PeerCallError(0, "unreachable", "timed out");
      return { vv: {}, online: [] };
    },
    push: async (addr: { host: string }) => {
      calls.pushes.push(addr.host);
      if (failure === "stall") { clock.now += 20_000; clock.stalled += 20_000; }
      if (failure !== null) throw new PeerCallError(0, "unreachable", "timed out");
      return { accepted: 1 };
    },
  } as unknown as PeerClient;
  const sync = new SyncManager(core, client, syncOpts?.(clock) ?? { livenessMs: 45_000, now: () => clock.now, stallTotal: () => clock.stalled });
  return { clock, nodes, members, changed, calls, sync, fail: (f: typeof failure) => { failure = f; } };
}

const online = (s: SyncManager, ...ids: string[]): boolean[] => ids.map((id) => s.isOnline(id));
const post = (seq: number): Event => ({ id: `self:${seq}`, origin: "self", seq, ts: 1, kind: "msg.post", channel: "general", body: { text: "x" }, author: { handle: "person", node: "self" } }) as unknown as Event;

describe("a peer's own request is contact", () => {
  test("a peer shown offline shows online the moment it speaks, and its silence is measured from then", () => {
    const t = setup();
    expect(online(t.sync, "tail", "direct")).toEqual([false, false]); // never in contact
    const before = t.changed.nodes;
    t.sync.heard("tail");
    expect(online(t.sync, "tail", "direct")).toEqual([true, false]);
    expect(t.changed.nodes).toBe(before + 1); // the dashboards are told it came back
    expect(t.sync.peerState("tail")?.lastSeen).toBe(1_000);
    // Presence only: nothing of ours reached it, so it is not vouched for to others and has no round trip time.
    expect(t.sync.reachedPeers()).toEqual([]);
    expect(t.sync.peerRtts()).toEqual({});
    t.clock.now += 44_000;
    expect(online(t.sync, "tail")).toEqual([true]);
    t.clock.now += 2_000; // 46 s of silence
    expect(online(t.sync, "tail")).toEqual([false]);
    t.sync.heard("tail");
    expect(online(t.sync, "tail")).toEqual([true]);
  });

  test("a stall of this daemon in between does not age the peer, and the window then counts healthy time only", () => {
    const t = setup();
    t.sync.heard("direct");
    t.clock.now += 60_000;
    t.clock.stalled += 40_000; // 60 s passed, 40 s of them this daemon was stalled: 20 s of healthy time
    expect(online(t.sync, "direct")).toEqual([true]);
    t.clock.now += 24_000; // 44 s healthy
    expect(online(t.sync, "direct")).toEqual([true]);
    t.clock.now += 2_000; // 46 s healthy
    expect(online(t.sync, "direct")).toEqual([false]);
  });

  test("it refreshes presence only: what this machine's own calls last found stays recorded", async () => {
    const t = setup();
    await t.sync.antiEntropy(t.nodes.get("tail") as never);
    t.fail("down");
    t.clock.now += 50_000;
    await t.sync.antiEntropy(t.nodes.get("tail") as never);
    const state = t.sync.peerState("tail");
    expect(state?.failedAt).toBe(t.clock.now);
    expect(state?.error).toContain("timed out");
    expect(online(t.sync, "tail")).toEqual([false]);
    t.sync.heard("tail");
    expect(online(t.sync, "tail")).toEqual([true]);
    expect(t.sync.peerState("tail")?.failedAt).toBe(t.clock.now); // our own calls still failed: pushes still wait for one that works
    expect(t.sync.peerState("tail")?.error).toContain("timed out");
  });

  test("a peer that reaches us but that we cannot reach shows online and gets no pushes until a call of ours succeeds", async () => {
    const t = setup();
    await t.sync.antiEntropy(t.nodes.get("tail") as never);
    t.fail("down");
    t.clock.now += 50_000;
    await t.sync.antiEntropy(t.nodes.get("tail") as never); // our call fails: failedAt is set
    const toTail = () => t.calls.pushes.filter((h) => h === "tail").length;
    t.sync.push(post(1));
    await Bun.sleep(5);
    expect(toTail()).toBe(0); // offline: skipped
    t.sync.heard("tail"); // …but it reaches us (Direct behind NAT, a one-way ACL)
    expect(online(t.sync, "tail")).toEqual([true]);
    for (let seq = 2; seq < 8; seq++) t.sync.push(post(seq));
    await Bun.sleep(5);
    expect(toTail()).toBe(0); // still none: no push waits out its timeout for a peer our calls do not reach
    expect(t.sync.reachedPeers()).toEqual([]);
    expect(t.sync.peerRtts()).toEqual({});
    t.fail(null); // our calls work again
    await t.sync.antiEntropy(t.nodes.get("tail") as never);
    expect(t.sync.peerState("tail")?.failedAt).toBeNull();
    t.sync.push(post(9));
    await Bun.sleep(5);
    expect(toTail()).toBe(1);
    expect(t.sync.reachedPeers()).toEqual(["tail"]);
  });

  test("a peer only heard from is still synced when the roster changes, and a stale round trip time is not served", async () => {
    const t = setup();
    t.sync.heard("direct");
    expect(t.calls.vvs).toEqual([]);
    t.sync.rosterChanged();
    await Bun.sleep(5);
    expect(t.calls.vvs).toContain("direct"); // we had never called it: heard-only is not "already synced"
    // A round trip measured long ago, then the peer only calling us: not reported.
    await t.sync.antiEntropy(t.nodes.get("tail") as never);
    (t.sync.peerState("tail") as { rtt: number | null }).rtt = 42;
    expect(t.sync.peerRtts().tail).toBe(42);
    t.clock.now += 50_000;
    t.sync.heard("tail");
    expect(online(t.sync, "tail")).toEqual([true]);
    expect(t.sync.peerRtts()).not.toHaveProperty("tail");
  });

  test("nothing is learned from itself, a stranger, a revoked machine, a removed person's machine, a machine it cannot reach, or after stop", () => {
    const t = setup();
    t.sync.heard("self");
    t.sync.heard("nobody");
    t.sync.heard("relay"); // no transport in common: only what its relays report counts
    expect(t.sync.peerState("relay")).toBeUndefined();
    expect(t.sync.peerState("nobody")).toBeUndefined();
    t.nodes.set("tail", { ...(t.nodes.get("tail") as Rec), revoked: true });
    t.sync.heard("tail");
    expect(t.sync.peerState("tail")).toBeUndefined();
    t.members.set("other", { login: "other", handle: "other", role: "removed" });
    t.sync.heard("solo");
    expect(t.sync.peerState("solo")).toBeUndefined();
    t.sync.stop();
    t.sync.heard("direct");
    expect(t.sync.peerState("direct")).toBeUndefined();
  });
});

describe("a stall of this daemon says nothing about the peers", () => {
  test("a push that failed across a stall does not mark the peer unreachable or its machine offline", async () => {
    const t = setup();
    await t.sync.antiEntropy(t.nodes.get("tail") as never);
    t.fail("stall"); // the push waits 20 s on a stalled loop, then reports a timeout
    t.sync.push(post(1));
    await Bun.sleep(10);
    expect(t.sync.peerState("tail")?.failedAt).toBeNull();
    expect(online(t.sync, "tail")).toEqual([true]);
  });

  test("the same push failing with no stall of ours is the peer's failure, and its machine goes offline once the window passes", async () => {
    const t = setup();
    await t.sync.antiEntropy(t.nodes.get("tail") as never);
    t.fail("down");
    t.clock.now += 1_000;
    t.sync.push(post(2));
    await Bun.sleep(10);
    expect(t.sync.peerState("tail")?.failedAt).toBe(t.clock.now);
    expect(online(t.sync, "tail")).toEqual([true]); // within the window: still online
    t.clock.now += 45_000;
    expect(online(t.sync, "tail")).toEqual([false]);
  });

  test("a relayed machine follows what its relay reported, with the stall left out of that window too", async () => {
    const t = setup();
    // `tail` reports `relay` online; `relay` shares no transport with this daemon.
    (t.sync as unknown as { reported: Map<string, unknown> }).reported.set("tail", { at: 1_000, stall: 0, online: new Set(["relay"]) });
    t.sync.heard("tail");
    expect(online(t.sync, "relay")).toEqual([true]);
    t.clock.now += 100_000;
    t.clock.stalled += 70_000; // 30 s healthy
    t.sync.heard("tail"); // tail is still talking; its last report is 100 s old but only 30 s of it healthy
    expect(online(t.sync, "relay")).toEqual([true]);
    t.clock.now += 20_000;
    expect(online(t.sync, "relay")).toEqual([false]);
  });
});

describe("a sleeping machine is a stalled one", () => {
  test("peers still look online when the laptop wakes after ten minutes, and go offline only after healthy time passes", async () => {
    const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const clocks = { mono: 1_000, wall: 5_000_000 };
    const dog = new LoopWatchdog(quiet, { now: () => clocks.mono, wallNow: () => clocks.wall });
    dog.start();
    cleanups.push(() => dog.stop());
    // This daemon's presence clock is the wall clock (as in production) and its stall total is the real watchdog's.
    const t = setup(() => ({ livenessMs: 45_000, now: () => clocks.wall, stallTotal: () => dog.stallTotalMs() }));
    await t.sync.antiEntropy(t.nodes.get("tail") as never);
    await t.sync.antiEntropy(t.nodes.get("direct") as never);
    const tick = (ms: number) => { for (let spent = 0; spent < ms; spent += 250) { clocks.mono += 250; clocks.wall += 250; dog.check(); } };
    tick(10_000);
    expect(online(t.sync, "tail", "direct")).toEqual([true, true]);
    clocks.wall += 600_000; // the lid is closed for ten minutes: only the wall clock ran
    expect(online(t.sync, "tail", "direct")).toEqual([true, true]); // not offline on wake
    // …and nothing else is owed to the sleep: 45 s of healthy time without contact is the usual window.
    tick(30_000);
    expect(online(t.sync, "tail")).toEqual([true]);
    tick(10_000);
    expect(online(t.sync, "tail")).toEqual([false]);
  });
});

// ---- the gate: which requests count as contact ----------------------------------------------------------------------

const hex = (who: TNode) => Buffer.from(who.keys.pubkey, "base64").toString("hex");

/** alex's daemon (the authority: Tailscale and Direct), bob (Tailscale only), carol (Direct only). */
function gateWorld() {
  const alex = tnode("alex");
  const bob = tnode("bob");
  const carol = tnode("carol", "direct:carol");
  const byNode = new Map<string, WhoisResult>();
  const core = makeCore(alex, "0000000000000000", cleanups, { identity: new FakeIdentity({ ip: "100.64.0.1", login: alex.login, nodeName: alex.hostname }, byNode) });
  core.store.deleteMeta("team");
  core.ip = "100.64.0.1";
  core.createTeam("aka", "alex");
  core.emit("team.node", { node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey, ip: "100.64.0.1", endpoint: hex(alex), transports: ["tailscale", "direct"], peer_sig_strict: false });
  core.emit("team.member", { login: bob.login, handle: "bob", role: "member" });
  core.emit("team.node", { node_id: bob.keys.nodeId, login: bob.login, hostname: bob.hostname, pubkey: bob.keys.pubkey, ip: "100.64.0.2" });
  core.store.setMeta(`peer_capabilities:${bob.keys.nodeId}`, JSON.stringify({ version: "0.1.3", caps: [] }));
  core.emit("team.member", { login: carol.login, handle: "carol", role: "member" });
  core.emit("team.node", { node_id: carol.keys.nodeId, login: carol.login, hostname: carol.hostname, pubkey: carol.keys.pubkey, ip: "", endpoint: hex(carol), transports: ["direct"] });
  byNode.set(bob.keys.nodeId, { login: bob.login, nodeName: bob.hostname });
  const contacts: string[] = [];
  core.onPeerContact = (id) => { contacts.push(id); };
  return { alex, bob, carol, byNode, core, team: core.teamId as string, api: new PeerApi(core), contacts };
}

describe("a clock correction is not a stall", () => {
  test("a wall clock set back five minutes and forward again does not keep a dead peer online", async () => {
    const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const clocks = { mono: 1_000, wall: 5_000_000 };
    const dog = new LoopWatchdog(quiet, { now: () => clocks.mono, wallNow: () => clocks.wall });
    dog.start();
    cleanups.push(() => dog.stop());
    const t = setup(() => ({ livenessMs: 45_000, now: () => clocks.wall, stallTotal: () => dog.stallTotalMs() }));
    const tick = (ms: number) => { for (let spent = 0; spent < ms; spent += 250) { clocks.mono += 250; clocks.wall += 250; dog.check(); } };
    await t.sync.antiEntropy(t.nodes.get("tail") as never);
    tick(5_000);
    clocks.wall -= 300_000; // set back…
    tick(1_000);
    clocks.wall += 300_000; // …and forward again, by the correction
    tick(1_000);
    expect(online(t.sync, "tail")).toEqual([true]); // 7 s since it last answered
    tick(30_000);
    expect(online(t.sync, "tail")).toEqual([true]); // 37 s
    tick(10_000); // 47 s, and the peer never answered again: offline after the usual window, not 345 s
    expect(online(t.sync, "tail")).toEqual([false]);
  });

  test("alternating steps back 0.9 s and forward 1.1 s do not keep a dead peer online past 45 s", async () => {
    const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const clocks = { mono: 1_000, wall: 5_000_000 };
    const dog = new LoopWatchdog(quiet, { now: () => clocks.mono, wallNow: () => clocks.wall });
    dog.start();
    cleanups.push(() => dog.stop());
    const t = setup(() => ({ livenessMs: 45_000, now: () => clocks.wall, stallTotal: () => dog.stallTotalMs() }));
    // Older than the credit lifetime, with the clocks agreeing. The pattern then has to credit a loss under a second
    // on a daemon that is already past that lifetime, or the next tick treats the forward step as a full sleep.
    for (let i = 0; i < 2_440; i++) { clocks.mono += 250; clocks.wall += 250; dog.check(); }
    await t.sync.antiEntropy(t.nodes.get("tail") as never);
    const seen = clocks.wall;
    const monoAtContact = clocks.mono;
    let back = true;
    const pattern = () => {
      const drift = back ? -900 : 1_100;
      back = !back;
      clocks.mono += 250;
      clocks.wall += 250 + drift;
      dog.check();
    };
    while (clocks.wall - seen < 37_000) pattern();
    expect(online(t.sync, "tail")).toEqual([true]); // inside the usual window
    while (clocks.wall - seen < 46_000) pattern();
    expect(online(t.sync, "tail")).toEqual([false]); // 45 s of presence time, not held open by the discount
    expect(clocks.mono - monoAtContact).toBeLessThan(45_000); // the wall clock ran ahead; real time was shorter
    // The probe that found this kept the peer online for a 7_200 s run of the same pattern.
    const monoAtOffline = clocks.mono;
    while (clocks.mono - monoAtOffline < 7_200_000) pattern();
    expect(clocks.mono - monoAtOffline).toBeGreaterThanOrEqual(7_200_000);
    expect(online(t.sync, "tail")).toEqual([false]);
  });
});

describe("the gate reports contact from admitted machines only", () => {
  test("a Tailscale request that passed the gate is contact from the machine named by its tailnet identity", async () => {
    const w = gateWorld();
    const req = (ip: string, node: string) => w.api.handle(new Request(`http://${ip}:7458/peer/v1/vv`, { headers: { "X-Walkie-Team": w.team, "X-Walkie-Node": node } }), ip);
    expect((await req("100.64.0.2", w.bob.keys.nodeId)).status).toBe(200);
    expect(w.contacts).toEqual([w.bob.keys.nodeId]);
    // An address that is not bob's, a node id that is not his login's, and a team mismatch are refused: no contact.
    expect((await req("100.64.0.9", w.bob.keys.nodeId)).status).toBe(403);
    expect((await req("100.64.0.2", w.carol.keys.nodeId)).status).toBe(403);
    expect((await w.api.handle(new Request("http://100.64.0.2:7458/peer/v1/vv", { headers: { "X-Walkie-Team": "ffffffffffffffff", "X-Walkie-Node": w.bob.keys.nodeId } }), "100.64.0.2")).status).toBe(409);
    expect(w.contacts).toEqual([w.bob.keys.nodeId]);
  });

  test("a Direct request is contact from the machine whose key made the connection; refused ones, and /hello, are not", async () => {
    const w = gateWorld();
    const direct = (who: TNode | string, path: string, headers: Record<string, string> = {}) =>
      w.api.handle(new Request(`http://walkie.direct${path}`, { headers: { "X-Walkie-Team": w.team, ...headers } }), { kind: "direct", pubkey: typeof who === "string" ? who : who.keys.pubkey });
    expect((await direct(w.carol, "/peer/v1/vv")).status).toBe(200);
    expect(w.contacts).toEqual([w.carol.keys.nodeId]);
    expect((await direct(w.carol, "/peer/v1/events?origin=" + w.alex.keys.nodeId + "&after=0")).status).toBe(200);
    expect(w.contacts).toEqual([w.carol.keys.nodeId, w.carol.keys.nodeId]);
    const stranger = tnode("mallory");
    expect((await direct(stranger, "/peer/v1/vv")).status).toBe(403);
    expect((await direct(w.bob, "/peer/v1/vv")).status).toBe(403); // Tailscale-only: its key is not let in over Direct
    expect((await direct(w.carol, "/peer/v1/vv", { "X-Walkie-Node": w.bob.keys.nodeId })).status).toBe(403); // the key decides, not the header
    expect((await direct(w.carol, "/peer/v1/hello")).status).toBe(200); // discovery is not the machine's own traffic
    expect(w.contacts).toHaveLength(2);
  });
});
