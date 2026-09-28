import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../../src/daemon/config.ts";
import { Core } from "../../src/daemon/core.ts";
import { FakeIdentity } from "../../src/daemon/identity.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { ensureHome, pathsFor } from "../../src/daemon/paths.ts";
import { Hub } from "../../src/daemon/sse.ts";
import { Store } from "../../src/daemon/store.ts";
import { canonicalJson } from "../../src/protocol/canonical.ts";
import { stubOf } from "../../src/protocol/header.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { createTeam, ev, memberEv, nodeEv, tnode, type TNode } from "../helpers/events.ts";

let dir: string;
let store: Store;
let hub: Hub;

function makeCore(self: TNode, team: string): Core {
  const paths = pathsFor(dir);
  ensureHome(paths);
  store = new Store(join(dir, "walkie.db"));
  store.setMeta("team", team);
  hub = new Hub(60_000, 5);
  return new Core({
    paths, config: ConfigSchema.parse({}), log: createLogger({}), keys: self.keys, store,
    identity: new FakeIdentity({ ip: "127.0.0.1", login: self.login, nodeName: self.hostname }, new Map()),
    hub, hostname: self.hostname, ip: "127.0.0.1", login: self.login, peerPort: 7458,
  });
}

beforeEach(() => { dir = mkdtempSync("/tmp/walkie-ingest-"); });
afterEach(() => { hub?.close(); store?.close(); rmSync(dir, { recursive: true, force: true }); });

describe("ingest pipeline", () => {
  test("pending → accepted after late admission (and vv advances past it)", () => {
    const alex = tnode("alex"), kira = tnode("kira"), carol = tnode("carol");
    const { team, create } = createTeam(alex);
    const core = makeCore(carol, team);
    expect(core.ingest(create, "remote").status).toBe("accepted");
    core.ingest(ev(team, alex, "channel.upsert", { name: "general" }), "remote");
    const early = ev(team, kira, "msg.post", { text: "before admission" }, { channel: "general" });
    expect(core.ingest(early, "remote")).toEqual({ status: "pending", reason: "unknown_origin" });
    expect(store.pendingCount()).toBe(1);
    expect(store.vvOf(kira.keys.nodeId)).toBe(0);
    expect(core.ingest(early, "remote").status).toBe("pending"); // re-delivery doesn't duplicate
    core.ingest(memberEv(team, alex, kira, "member"), "remote");
    core.ingest(nodeEv(team, alex, kira), "remote");
    core.drainPending(); // FIX-3 (F3): held rows drain on a later tick, only for the dependency that arrived
    expect(store.pendingCount()).toBe(0);
    expect(store.getRow(early.id)?.status).toBe("ok");
    expect(store.vvOf(kira.keys.nodeId)).toBe(1);
  });

  // Cores below are observers or the owner's second machine: a daemon never ingests its own origin
  // from a peer (D3), so feeding the owner's events "remotely" into the owner's own core is refused.
  test("answer before its ask is held, then accepted", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const core = makeCore(tnode("obs"), team);
    for (const e of [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira)]) core.ingest(e, "remote");
    const askEv = ev(team, alex, "ask", { to: "@kira", text: "q?", expires_at: Date.now() + 60_000 });
    const ans = ev(team, kira, "answer", { ask: askEv.id, text: "a" });
    expect(core.ingest(ans, "remote").status).toBe("pending");
    expect(core.ingest(askEv, "remote").status).toBe("accepted");
    core.drainPending(); // FIX-3 (F3): the ask released `ask:<id>`; its held answers drain off the ingest path
    expect(store.getRow(ans.id)?.status).toBe("ok");
  });

  test("duplicate is ignored; different body under the same id is a conflict (first kept)", () => {
    const alex = tnode("alex");
    const { team, create } = createTeam(alex);
    const core = makeCore(tnode("obs"), team);
    core.ingest(create, "remote");
    core.ingest(ev(team, alex, "channel.upsert", { name: "general" }), "remote");
    const first = ev(team, alex, "msg.post", { text: "one" }, { channel: "general" });
    alex.seq -= 1; // re-use the seq: a node that lost its DB would do this
    const second = ev(team, alex, "msg.post", { text: "two" }, { channel: "general" });
    expect(second.id).toBe(first.id);
    expect(core.ingest(first, "remote").status).toBe("accepted");
    expect(core.ingest(first, "remote").status).toBe("duplicate");
    expect(core.ingest(second, "remote")).toEqual({ status: "rejected", reason: "conflict" });
    expect(JSON.parse(store.getRow(first.id)?.json ?? "{}").body.text).toBe("one");
    expect(store.conflictOrigins()).toEqual([{ origin: alex.keys.nodeId, n: 1 }]);
  });

  test("a forged event (bad sig) is not stored and not a conflict", () => {
    const alex = tnode("alex"), mallory = tnode("mallory");
    const { team, create } = createTeam(alex);
    const core = makeCore(tnode("obs"), team);
    core.ingest(create, "remote");
    core.ingest(ev(team, alex, "channel.upsert", { name: "general" }), "remote");
    const real = ev(team, alex, "msg.post", { text: "real" }, { channel: "general" });
    const forged: Event = { ...real, sig: mallory.keys.sign("x") };
    expect(core.ingest(forged, "remote")).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(store.getRow(real.id)).toBeNull();
    expect(core.ingest(real, "remote").status).toBe("accepted");
  });

  test("signed-but-invalid events are kept hidden so seq contiguity holds", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const alex2 = tnode("alex", alex.login, "alex-studio"); // the owner's second machine
    const core = makeCore(alex2, team);
    for (const e of [create, nodeEv(team, alex, alex2), memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), ev(team, alex, "channel.upsert", { name: "secret", members: ["alex"] })]) core.ingest(e, "remote");
    const bad = ev(team, kira, "msg.post", { text: "not a member" }, { channel: "secret" });
    expect(core.ingest(bad, "remote")).toEqual({ status: "rejected", reason: "not_channel_member" });
    expect(store.getRow(bad.id)?.status).toBe("rejected");
    expect(store.vvOf(kira.keys.nodeId)).toBe(1);
    expect(store.queryEvents({ limit: 100 }).some((r) => r.id === bad.id)).toBe(false);
    // The membership update that raced behind the post arrives: the post converges to accepted.
    core.ingest(ev(team, alex, "channel.upsert", { name: "secret", members: ["alex", "kira"] }), "remote");
    expect(store.getRow(bad.id)?.status).toBe("ok");
    expect(store.queryEvents({ channel: "secret", limit: 100 }).some((r) => r.id === bad.id)).toBe(true);
  });

  test("restricted events for a non-member: a final (anchored) one is stored as a stub only; an unanchored one is kept in full, never shown", () => {
    const alex = tnode("alex"), kira = tnode("kira"), bob = tnode("bob");
    const { team, create } = createTeam(alex);
    const core = makeCore(kira, team);
    const setup = [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), memberEv(team, alex, bob, "member"), nodeEv(team, alex, bob),
      ev(team, alex, "channel.upsert", { name: "secret", members: ["alex", "bob"] })];
    for (const e of setup) core.ingest(e, "remote");
    // The authority's watermark already covers bob:1 when it arrives: its verdict is final.
    core.ingest(ev(team, alex, "channel.upsert", { name: "general", wm: { [bob.keys.nodeId]: 1 } }), "remote");
    const secret = ev(team, bob, "msg.post", { text: "classified" }, { channel: "secret" });
    expect(core.ingest(secret, "remote").status).toBe("accepted");
    const row = store.getRow(secret.id);
    expect(row?.redacted).toBe(1);
    expect(row?.json).not.toContain("classified");
    expect(store.vvOf(bob.keys.nodeId)).toBe(secret.seq);
    // No entry covers bob:2 yet: kept in full so a later entry can still re-judge it, but never shown.
    const later = ev(team, bob, "msg.post", { text: "classified too" }, { channel: "secret" });
    expect(core.ingest(later, "remote").status).toBe("accepted");
    expect(store.getRow(later.id)?.redacted).toBe(0);
    expect(core.visible(later)).toBe(false);
  });

  test("stubs: accepted for non-members, refused for members and public channels", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const setup = [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), ev(team, alex, "channel.upsert", { name: "secret", members: ["alex"] }), ev(team, alex, "channel.upsert", { name: "general" })];
    const kiraCore = makeCore(kira, team);
    for (const e of setup) kiraCore.ingest(e, "remote");
    // Stubs carry the origin's header signature (D3); an unsigned one is refused.
    const signed = (seq: number, channel?: string) => {
      const h = { v: 1, team, id: `${alex.keys.nodeId}:${seq}`, origin: alex.keys.nodeId, seq, ts: 1, kind: "msg.post" as const, ...(channel ? { channel } : {}) };
      return { id: h.id, origin: h.origin, seq, ts: 1, kind: h.kind, ...(channel ? { channel } : {}), hsig: alex.keys.sign(canonicalJson(h)), redacted: true as const };
    };
    expect(kiraCore.ingest(signed(99, "secret"), "remote").status).toBe("accepted");
    expect(kiraCore.ingest({ ...signed(96, "secret"), hsig: undefined }, "remote")).toEqual({ status: "rejected", reason: "bad_stub" });
    expect(kiraCore.ingest(signed(98, "general"), "remote")).toEqual({ status: "rejected", reason: "stub_for_public_channel" });
    expect(kiraCore.ingest(signed(97), "remote").status).toBe("rejected");
  });

  test("a member upgrades a stub when the real event arrives", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const alex2 = tnode("alex", alex.login, "alex-studio");
    const core = makeCore(alex2, team);
    for (const e of [create, nodeEv(team, alex, alex2), memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira)]) core.ingest(e, "remote");
    const up = ev(team, alex, "channel.upsert", { name: "secret", members: ["alex", "kira"] });
    core.ingest(up, "remote");
    const post = ev(team, kira, "msg.post", { text: "hi" }, { channel: "secret" });
    store.insertStub(stubOf(post));
    expect(core.ingest(post, "remote").status).toBe("accepted");
    expect(store.getRow(post.id)?.redacted).toBe(0);
  });

  // Was "historic roster events from a since-removed owner are accepted" (multi-writer, FIX-1): only
  // the roster authority's events enter the chain; another owner's are stored hidden (not_authority).
  test("a non-authority owner's roster event is stored hidden (not_authority), never applied", () => {
    const alex = tnode("alex"), bea = tnode("bea"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const core = makeCore(tnode("fresh"), team);
    for (const e of [create, memberEv(team, alex, bea, "owner"), nodeEv(team, alex, bea)]) core.ingest(e, "remote");
    const inviteByBea = memberEv(team, bea, kira, "member");
    expect(core.ingest(inviteByBea, "remote")).toEqual({ status: "rejected", reason: "not_authority" });
    expect(store.getRow(inviteByBea.id)?.status).toBe("rejected");
    expect(core.roster.members.has(kira.login)).toBe(false);
    expect(store.vvOf(bea.keys.nodeId)).toBe(1);
  });

  test("local emit enforces rules and assigns contiguous seqs", () => {
    const alex = tnode("alex");
    const { team, create } = createTeam(alex);
    alex.seq = 1;
    const core = makeCore(alex, team);
    core.ingest(create, "local");
    const a = core.emit("channel.upsert", { name: "general" });
    const b = core.emit("msg.post", { text: "x" }, { channel: "general" });
    expect([a.seq, b.seq]).toEqual([2, 3]);
    expect(() => core.emit("msg.post", { text: "x" }, { channel: "nope" })).toThrow(/unknown_channel/);
    expect(core.emit("msg.post", { text: "y" }, { channel: "general" }).seq).toBe(4);
  });
});
