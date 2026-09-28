import { afterEach, expect, test } from "bun:test";
import { requireV2Replicas } from "../../src/daemon/seats/routes.ts";
import type { RouteCtx } from "../../src/daemon/local-routes.ts";
import { SyncManager } from "../../src/daemon/sync.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";
import { makeCore, reopen } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, tnode } from "../helpers/events.ts";
import { seatsChannel } from "../../src/protocol/seats.ts";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

test.each([false, true])("v2 requires every current channel replica (same person: %s)", (samePerson) => {
  const owner = tnode("owner"); const host = tnode("host"); const old = samePerson ? tnode("owner", owner.login, "old-mbp") : tnode("old");
  const { team, create } = createTeam(owner);
  const core = makeCore(owner, team, cleanups);
  const feed = (_core: typeof core, events: Parameters<typeof core.ingest>[0][]) => { for (const e of events) core.ingest(e, "local"); };
  const channel = seatsChannel(host.keys.nodeId);
  feed(core, [create, memberEv(team, owner, host, "member"), nodeEv(team, owner, host),
    ...(samePerson ? [] : [memberEv(team, owner, old, "member")]), nodeEv(team, owner, old),
    ev(team, owner, "channel.upsert", { name: channel, members: samePerson ? ["owner", "host"] : ["owner", "host", "old"], seats: true })]);
  const caps = new Map([[host.keys.nodeId, ["seats_v2"]], [old.keys.nodeId, [] as string[]]]);
  const sync = { peerCapabilities: (id: string) => caps.has(id) ? { caps: caps.get(id) } : undefined } as unknown as RouteCtx["sync"];
  expect(() => requireV2Replicas({ core, sync }, channel)).toThrow(/old-mbp/);
  caps.delete(old.keys.nodeId);
  expect(() => requireV2Replicas({ core, sync }, channel)).not.toThrow();
  caps.set(old.keys.nodeId, ["seats_v2"]);
  expect(() => requireV2Replicas({ core, sync }, channel)).not.toThrow();
});

 test("replica capabilities persist across a restart with machine stats disabled", () => {
  const owner = tnode("owner"), host = tnode("host"); const { team, create } = createTeam(owner);
  let core = makeCore(owner, team, cleanups);
  const channel = seatsChannel(host.keys.nodeId);
  for (const e of [create, memberEv(team, owner, host, "member"), nodeEv(team, owner, host),
    ev(team, owner, "channel.upsert", { name: channel, members: ["owner", "host"], seats: true })]) core.ingest(e, "local");
  const client = {} as PeerClient;
  let sync = new SyncManager(core, client);
  const peer = host.keys.nodeId;
  sync.rememberCapabilities(peer, { version: "0.2.0-pre.8", caps: ["seats_v2"] });
  sync.rememberCapabilities(peer, undefined); // a telemetry-free reply cannot erase last-known features
  sync.rememberCapabilities("c".repeat(16), undefined);
  expect(sync.peerCapabilities("c".repeat(16))).toBeUndefined();
  core = reopen(core, owner);
  sync = new SyncManager(core, client);
  expect(sync.peerCapabilities(peer)).toEqual({ version: "0.2.0-pre.8", caps: ["seats_v2"] });
  expect(sync.peerState(peer)).toBeUndefined();
  expect(() => requireV2Replicas({ core, sync }, channel)).not.toThrow();
  sync.rememberCapabilities(peer, { version: "0.2.0-pre.5", caps: [] });
  sync = new SyncManager(core, client);
  expect(sync.peerCapabilities(peer)?.caps).toEqual([]);
  expect(() => requireV2Replicas({ core, sync }, channel)).toThrow("pre-v2");
});

test("vv advertises protocol capabilities with machine_stats false", async () => {
  const { PeerApi } = await import("../../src/daemon/peer-api.ts");
  const { PeerVvRes } = await import("../../src/protocol/schemas.ts");
  const a = tnode("owner", "direct:owner"), b = tnode("peer", "direct:peer");
  const core = makeCore(a, "0000000000000000", cleanups);
  core.store.deleteMeta("team"); core.createTeam("example", "owner", { login: a.login });
  core.emit("team.member", { login: b.login, handle: b.handle, role: "member" });
  core.emit("team.node", { node_id: b.keys.nodeId, login: b.login, hostname: b.hostname, pubkey: b.keys.pubkey,
    ip: "", endpoint: Buffer.from(b.keys.pubkey, "base64").toString("hex"), transports: ["direct"] });
  core.config.machine_stats = false;
  const res = await new PeerApi(core).handle(new Request("http://walkie.direct/peer/v1/vv", {
    headers: { "X-Walkie-Team": core.teamId! },
  }), { kind: "direct", pubkey: b.keys.pubkey });
  expect(res.status).toBe(200);
  const vv = PeerVvRes.parse(await res.json());
  expect(vv.stats).toBeUndefined();
  expect(vv.capabilities).toEqual({ version: "0.2.0-pre.8", caps: ["seats_v2"] });
});
