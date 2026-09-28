// FIX-3 (ALE-5156): watermark anchoring (hestia C1, Fable F1), paged dependent answers (C2), the
// local-origin hidden cap (C3), per-peer stub attempts (C4), roster rows outside the hidden cap (F2),
// the dependency-indexed pending table (F3), topic-only upserts (F4) and channel quotas (F5).
// Request idempotency across a transfer (C5) runs on a live cluster in test/integration/audit-fix3.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { buildChain } from "../../src/daemon/chain.ts";
import type { Core } from "../../src/daemon/core.ts";
import { HttpError } from "../../src/daemon/http.ts";
import type { PeerAddr, PeerClient } from "../../src/daemon/peer-client.ts";
import { applyRequest } from "../../src/daemon/requests.ts";
import { REVAL_PAGE } from "../../src/daemon/revalidate.ts";
import { EMPTY_ROSTER, applyRosterEvent, requestAllowed, type Roster } from "../../src/daemon/roster.ts";
import { SyncManager } from "../../src/daemon/sync.ts";
import { canonicalJson } from "../../src/protocol/canonical.ts";
import type { Event, RosterRequest } from "../../src/protocol/schemas.ts";
import { feed, makeCore, reopen, settle, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

/** A roster body carrying the authority's signed watermark (PROTOCOL §2 "Anchoring"). */
const withWm = <T>(body: T, wm: Record<string, number>): T => ({ ...body, wm }) as T;

/** Seeded shuffle (mulberry32) so a failing order can be replayed from its seed. */
function shuffle<T>(xs: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Arrival in the given order, then anti-entropy re-delivery and the background drains. */
async function replicate(self: TNode, team: string, events: readonly Event[]): Promise<Core> {
  const core = makeCore(self, team, cleanups);
  feed(core, events);
  feed(core, events);
  core.drainPending();
  await settle(core);
  return core;
}

/** Accepted = valid (shown, or kept as a stub because this node can't see the channel). */
function acceptedIds(core: Core, events: readonly Event[]): string[] {
  return events.filter((e) => ["ok", "stub"].includes(statusOf(core, e.id))).map((e) => e.id).sort();
}

/** Every shuffle must accept exactly the reference's set; returns the reference set. */
async function converges(name: string, team: string, events: readonly Event[], shuffles = 60): Promise<string[]> {
  const want = acceptedIds(await replicate(tnode("ref"), team, events), events);
  for (let seed = 1; seed <= shuffles; seed++) {
    const core = await replicate(tnode(`r${seed}`), team, shuffle(events, seed));
    expect({ name, seed, got: acceptedIds(core, events) }).toEqual({ name, seed, got: want });
    while (cleanups.length > 1) cleanups.shift()?.(); // keep temp stores bounded
  }
  return want;
}

// ---- Anchoring: chain mechanics --------------------------------------------------------------------

describe("anchoring: the chain's anchor and roster_before", () => {
  test("anchor = first entry whose prefix-max watermark covers the event; roster_before matches a naive fold", () => {
    const a = tnode("alex"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const events: Event[] = [create, withWmMember(team, a, m, "member", {}), withWmNode(team, a, m, {})];
    for (let i = 1; i <= 100; i++) {
      events.push(ev(team, a, "channel.upsert", withWm({ name: `c${i}` }, { [m.keys.nodeId]: i * 3 })));
    }
    const chain = buildChain(events, team);
    expect(chain.length).toBe(events.length);
    for (const seq of [1, 2, 3, 4, 150, 298, 300]) {
      const want = events.findIndex((e) => ((e.body as { wm?: Record<string, number> }).wm?.[m.keys.nodeId] ?? 0) >= seq);
      expect(chain.anchor(m.keys.nodeId, seq)).toBe(want);
    }
    expect(chain.anchor(m.keys.nodeId, 301)).toBeNull();
    expect(chain.anchor("0123456789abcdef", 1)).toBeNull();
    for (const k of [0, 1, 2, 31, 32, 33, 64, 77, 102]) {
      const naive = events.slice(0, k).reduce<Roster>((r, e) => applyRosterEvent(r, e), EMPTY_ROSTER);
      expect([...chain.rosterBefore(k).channels.keys()]).toEqual([...naive.channels.keys()]);
    }
  });

  test("a transfer to an authority with a lower version vector never un-anchors anything", () => {
    const a = tnode("alex"), b = tnode("bea"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, b, "owner"), nodeEv(team, a, b), memberEv(team, a, m, "member"), nodeEv(team, a, m)];
    const t = ev(team, a, "team.authority", withWm({ node_id: b.keys.nodeId }, { [m.keys.nodeId]: 9 }));
    const events = [...setup, t, ev(team, b, "channel.upsert", withWm({ name: "late", after: t.id }, { [m.keys.nodeId]: 2 }))];
    const chain = buildChain(events, team);
    expect(chain.authority).toBe(b.keys.nodeId);
    expect(chain.maxWm(m.keys.nodeId)).toBe(9);
    expect(chain.anchor(m.keys.nodeId, 5)).toBe(5); // still the transfer, not the later lower mark
  });
});

function withWmMember(team: string, by: TNode, who: TNode, role: "owner" | "member" | "observer" | "removed", wm: Record<string, number>): Event {
  return ev(team, by, "team.member", withWm({ login: who.login, handle: who.handle, role }, wm));
}
function withWmNode(team: string, by: TNode, who: TNode, wm: Record<string, number>, revoked = false): Event {
  return ev(team, by, "team.node", withWm({
    node_id: who.keys.nodeId, login: who.login, hostname: who.hostname, pubkey: who.keys.pubkey, ip: "127.0.0.1",
    ...(revoked ? { revoked: true } : {}),
  }, wm));
}

// ---- C1 / F1: arrival-order convergence under grants after restrictions ---------------------------

describe("C1/F1: grants after restrictions never change pre-anchor verdicts (property, 60 shuffles each)", () => {
  test("hestia C1: a repeated identical restriction; P before D stays accepted in every order", async () => {
    const a = tnode("alex"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), ev(team, a, "channel.upsert", { name: "general" })];
    const p = ev(team, m, "msg.post", { text: "seen before the demotion" }, { channel: "general" });
    const d = withWmMember(team, a, m, "observer", { [m.keys.nodeId]: 1 });
    const u = withWmMember(team, a, m, "observer", { [m.keys.nodeId]: 1 }); // the same restriction again
    const p2 = ev(team, m, "msg.post", { text: "after" }, { channel: "general" });
    // worker-b's replicas: A receives P → D → U, B receives D → U → P; both hold the full set.
    const early = await replicate(tnode("A"), team, [...setup, p, d, u, p2]);
    const late = await replicate(tnode("B"), team, [...setup, d, u, p, p2]);
    for (const core of [early, late]) {
      expect(statusOf(core, p.id)).toBe("ok");
      expect(statusOf(core, p2.id)).toBe("rejected");
    }
    const got = await converges("C1", team, [...setup, p, d, u, p2]);
    expect(got).toContain(p.id);
    expect(got).not.toContain(p2.id);
  }, 60_000);

  test("Fable F1: removal then re-invite with a lower role", async () => {
    const a = tnode("alex"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), ev(team, a, "channel.upsert", { name: "general" })];
    const posts = Array.from({ length: 3 }, (_, i) => ev(team, m, "msg.post", { text: `m${i}` }, { channel: "general" }));
    const removal = withWmMember(team, a, m, "removed", { [m.keys.nodeId]: 3 });
    const reinvite = memberEv(team, a, m, "observer"); // a grant after the restriction, no watermark
    const after = ev(team, m, "msg.post", { text: "old laptop" }, { channel: "general" });
    const got = await converges("F1-reinvite", team, [...setup, ...posts, removal, reinvite, after]);
    expect(got).toEqual(expect.arrayContaining(posts.map((p) => p.id)));
    expect(got).not.toContain(after.id);
  }, 60_000);

  test("Fable F1: a channel narrowed, then widened; later entries anchor the rest", async () => {
    const a = tnode("alex"), m = tnode("mia"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), memberEv(team, a, k, "member"), nodeEv(team, a, k),
      ev(team, a, "channel.upsert", { name: "dev" })];
    const posts = Array.from({ length: 5 }, (_, i) => ev(team, m, "msg.post", { text: `m${i}` }, { channel: "dev" }));
    const narrow = ev(team, a, "channel.upsert", withWm({ name: "dev", members: ["alex"] }, { [m.keys.nodeId]: 5, [k.keys.nodeId]: 0 }));
    const widen = ev(team, a, "channel.upsert", withWm({ name: "dev", members: ["alex", "kira"] }, { [m.keys.nodeId]: 5 }));
    const m6 = ev(team, m, "msg.post", { text: "after the narrowing" }, { channel: "dev" });
    const k1 = ev(team, k, "msg.post", { text: "kira after the widening" }, { channel: "dev" });
    const anchorAll = ev(team, a, "channel.upsert", withWm({ name: "other" }, { [m.keys.nodeId]: 6, [k.keys.nodeId]: 1 }));
    const got = await converges("F1-narrow-widen", team, [...setup, ...posts, narrow, widen, m6, k1, anchorAll]);
    expect(got).toEqual(expect.arrayContaining([...posts.map((p) => p.id), k1.id]));
    expect(got).not.toContain(m6.id);
  }, 60_000);

  test("a grant after a restriction: demoted, then promoted again", async () => {
    const a = tnode("alex"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), ev(team, a, "channel.upsert", { name: "general" })];
    const [p1, p2] = [ev(team, m, "msg.post", { text: "1" }, { channel: "general" }), ev(team, m, "msg.post", { text: "2" }, { channel: "general" })];
    const demote = withWmMember(team, a, m, "observer", { [m.keys.nodeId]: 1 });
    const p3 = ev(team, m, "msg.post", { text: "3" }, { channel: "general" });
    const seenP3 = ev(team, a, "channel.upsert", withWm({ name: "x" }, { [m.keys.nodeId]: 3 })); // the authority saw p2, p3 as an observer's
    const promote = withWmMember(team, a, m, "member", { [m.keys.nodeId]: 3 });
    const p4 = ev(team, m, "msg.post", { text: "4" }, { channel: "general" });
    const got = await converges("grant-after-restriction", team, [...setup, p1, p2, demote, p3, seenP3, promote, p4]);
    expect(got).toContain(p1.id);
    expect(got).not.toContain(p2.id);
    expect(got).not.toContain(p3.id);
    expect(got).toContain(p4.id);
  }, 60_000);

  test("everything at once, with an authority transfer in the middle", async () => {
    const alex = tnode("alex"), bea = tnode("bea"), kira = tnode("kira"), mia = tnode("mia");
    const { team, create } = createTeam(alex);
    const E: Event[] = [create, memberEv(team, alex, bea, "owner"), nodeEv(team, alex, bea), memberEv(team, alex, kira, "member"),
      nodeEv(team, alex, kira), memberEv(team, alex, mia, "member"), nodeEv(team, alex, mia),
      ev(team, alex, "channel.upsert", { name: "general" }), ev(team, alex, "channel.upsert", { name: "dev", members: ["alex", "kira", "mia"] })];
    const k1 = ev(team, kira, "msg.post", { text: "k1" }, { channel: "dev" });
    const ask = ev(team, kira, "ask", { to: "@mia", text: "q", expires_at: Date.now() + 600_000 }, { channel: "general" });
    const ans = ev(team, mia, "answer", { ask: ask.id, text: "a" }, { channel: "general" });
    E.push(k1, ask, ans);
    E.push(withWmMember(team, alex, kira, "observer", { [kira.keys.nodeId]: 1, [mia.keys.nodeId]: 0 }));
    E.push(withWmMember(team, alex, kira, "observer", { [kira.keys.nodeId]: 1 })); // repeated
    const t = ev(team, alex, "team.authority", withWm({ node_id: bea.keys.nodeId }, { [kira.keys.nodeId]: 2 }));
    E.push(t, ev(team, bea, "channel.upsert", withWm({ name: "dev", members: ["alex"], after: t.id }, { [kira.keys.nodeId]: 1, [mia.keys.nodeId]: 1 })));
    E.push(ev(team, bea, "channel.upsert", withWm({ name: "dev", members: ["alex", "mia"] }, { [mia.keys.nodeId]: 1 }))); // widen
    E.push(withWmMember(team, bea, kira, "member", { [kira.keys.nodeId]: 2 })); // grant
    const m2 = ev(team, mia, "msg.post", { text: "mia in dev after the widening" }, { channel: "dev" });
    const k3 = ev(team, kira, "msg.post", { text: "kira after the promotion" }, { channel: "general" });
    E.push(m2, k3);
    const got = await converges("combined", team, E);
    expect(got).toEqual(expect.arrayContaining([k1.id, m2.id, k3.id])); // k1 anchored while kira was a member; m2, k3 judged at the head
    expect(got).not.toContain(ask.id); // kira:2 (the ask) was only seen by the transfer: an observer's ask
    expect(got).not.toContain(ans.id);
  }, 60_000);
});

// ---- Revalidation touches only unanchored rows ------------------------------------------------------

describe("anchoring: a new entry re-judges only unanchored rows", () => {
  test("entries appended in one batch (a transfer releasing the new authority's rows) re-judge from the floor before the batch", async () => {
    const a = tnode("alex"), b = tnode("bea"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, b, "owner"), nodeEv(team, a, b), memberEv(team, a, m, "member"), nodeEv(team, a, m),
      ev(team, a, "channel.upsert", { name: "dev" })];
    const posts = Array.from({ length: 3 }, (_, i) => ev(team, m, "msg.post", { text: `p${i}` }, { channel: "dev" }));
    const t = ev(team, a, "team.authority", withWm({ node_id: b.keys.nodeId }, { [m.keys.nodeId]: 0 }));
    const narrow = ev(team, b, "channel.upsert", withWm({ name: "dev", members: ["alex"], after: t.id }, { [m.keys.nodeId]: 0 }));
    const seen = ev(team, b, "channel.upsert", withWm({ name: "x" }, { [m.keys.nodeId]: 3 })); // anchors the posts after the narrowing
    const core = makeCore(tnode("obs"), team, cleanups);
    feed(core, [...setup, ...posts, narrow, seen]); // bea's rows are stored hidden until the transfer
    await settle(core);
    expect(posts.every((p) => statusOf(core, p.id) === "ok")).toBe(true);
    feed(core, [t]); // one advance: transfer, narrow, seen
    await settle(core);
    expect(core.authority).toBe(b.keys.nodeId);
    expect(posts.map((p) => statusOf(core, p.id))).toEqual(["rejected", "rejected", "rejected"]);
    await converges("batch-floor", team, [...setup, ...posts, t, narrow, seen]);
  }, 60_000);

  test("narrowing a channel with 1000 anchored posts and 5 unanchored ones judges 5 rows", async () => {
    const a = tnode("alex"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, k, "member"), nodeEv(team, a, k), ev(team, a, "channel.upsert", { name: "general" })];
    const old = Array.from({ length: 1_000 }, (_, i) => ev(team, k, "msg.post", { text: `old ${i}` }, { channel: "general" }));
    const seen = ev(team, a, "channel.upsert", withWm({ name: "seen" }, { [k.keys.nodeId]: 1_000 }));
    const fresh = Array.from({ length: 5 }, (_, i) => ev(team, k, "msg.post", { text: `new ${i}` }, { channel: "general" }));
    const core = makeCore(tnode("obs"), team, cleanups);
    feed(core, [...setup, ...old, seen, ...fresh]);
    await settle(core);
    let judged = 0;
    const page = core.store.revalPage.bind(core.store);
    core.store.revalPage = (job, after, limit) => { const rows = page(job, after, limit); judged += rows.length; return rows; };
    feed(core, [ev(team, a, "channel.upsert", withWm({ name: "general", members: ["alex"] }, { [k.keys.nodeId]: 1_000 }))]);
    await settle(core);
    console.log(`[metric] rows re-judged after narrowing a channel with 1000 anchored + 5 unanchored posts: ${judged}`);
    expect(judged).toBe(5);
    expect(old.every((p) => statusOf(core, p.id) === "ok")).toBe(true);
    expect(fresh.every((p) => statusOf(core, p.id) === "rejected")).toBe(true);
  }, 30_000);
});

// ---- C2: dependent answers are paged under the shared budget ----------------------------------------

describe("C2: an ask that flips re-judges its answers as paged jobs", () => {
  test("1500 answers of an invalidated ask: one pass judges at most REVAL_PAGE rows; the end state matches an early replica", async () => {
    const a = tnode("alex"), m = tnode("mal"), b = tnode("bea");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), memberEv(team, a, b, "member"), nodeEv(team, a, b),
      ev(team, a, "channel.upsert", { name: "general" })];
    const ask = ev(team, m, "ask", { to: "@bea", text: "q", expires_at: Date.now() + 600_000 }, { channel: "general" });
    const answers = Array.from({ length: 1_500 }, (_, i) => ev(team, b, "answer", { ask: ask.id, text: `a${i}` }, { channel: "general" }));
    const demote = withWmMember(team, a, m, "observer", { [m.keys.nodeId]: 0 }); // the authority never saw the ask

    const late = makeCore(tnode("late"), team, cleanups);
    feed(late, [...setup, ask, ...answers]);
    await settle(late);
    expect(answers.every((x) => statusOf(late, x.id) === "ok")).toBe(true);
    let judged = 0;
    const page = late.store.revalPage.bind(late.store);
    late.store.revalPage = (job, after, limit) => { const rows = page(job, after, limit); judged += rows.length; return rows; };
    feed(late, [demote]);
    expect(judged).toBeLessThanOrEqual(REVAL_PAGE);
    expect(late.revalidating).toBeGreaterThan(0);
    await settle(late);

    const early = makeCore(tnode("early"), team, cleanups);
    feed(early, [...setup, demote, ask, ...answers]);
    await settle(early);
    for (const core of [late, early]) {
      expect(statusOf(core, ask.id)).toBe("rejected");
      expect(answers.every((x) => ["rejected", "junk"].includes(statusOf(core, x.id)))).toBe(true);
      expect(core.store.hiddenCount(b.keys.nodeId)).toBe(1_000);
    }
  }, 60_000);
});

// ---- C3: the local origin is capped too; seq allocation is persisted --------------------------------

describe("C3: the hidden cap applies to this node's own rows; its seq counter lives in meta", () => {
  test("1001 own posts hidden by a demotion: 1000 stay hidden, 1 becomes a header; the next emit is seq 1002", async () => {
    const a = tnode("alex"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const core = makeCore(m, team, cleanups);
    feed(core, [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), ev(team, a, "channel.upsert", { name: "general" })]);
    for (let i = 0; i < 1_001; i++) core.emit("msg.post", { text: `mine ${i}` }, { channel: "general" });
    feed(core, [withWmMember(team, a, m, "observer", { [m.keys.nodeId]: 0 })]);
    await settle(core);
    expect(core.store.hiddenCount(m.keys.nodeId)).toBe(1_000);
    expect(statusOf(core, `${m.keys.nodeId}:1001`)).toBe("junk");
    feed(core, [withWmMember(team, a, m, "member", { [m.keys.nodeId]: 0 })]);
    await settle(core);
    expect(core.emit("msg.post", { text: "back" }, { channel: "general" }).seq).toBe(1_002);
    const again = reopen(core, m); // the junk self-stub survives a restart and the counter continues
    expect(statusOf(again, `${m.keys.nodeId}:1001`)).toBe("junk");
    expect(again.emit("msg.post", { text: "after restart" }, { channel: "general" }).seq).toBe(1_003);
    again.close();
  }, 60_000);
});

// ---- C4: stub attempts per (stub, peer) -------------------------------------------------------------

describe("C4: an unhelpful peer can't use up the attempts for a stub another peer can fill", () => {
  test("P (no body) is tried first every time; H still gets asked and fills the stub", async () => {
    const a = tnode("alex"), k = tnode("kira"), b = tnode("bob");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, k, "member"), nodeEv(team, a, k), memberEv(team, a, b, "member"), nodeEv(team, a, b),
      ev(team, a, "channel.upsert", { name: "vault", members: ["alex", "bob"] })];
    // Anchored on arrival (FIX-4: only a final verdict is reduced to a stub).
    const anchor = ev(team, a, "channel.upsert", withWm({ name: "general" }, { [b.keys.nodeId]: 1 }));
    const secret = ev(team, b, "msg.post", { text: "history" }, { channel: "vault" });
    const core = makeCore(k, team, cleanups);
    feed(core, [...setup, anchor, secret]);
    expect(statusOf(core, secret.id)).toBe("stub");
    feed(core, [ev(team, a, "channel.upsert", { name: "vault", members: ["alex", "bob", "kira"] })]);
    const asked: string[] = [];
    const client = {
      pullIds: async (addr: PeerAddr, ids: readonly string[]) => {
        asked.push(`${addr.port}:${ids.length}`);
        return { events: addr.port === 2 ? [secret].filter((e) => ids.includes(e.id)) : [] };
      },
    } as unknown as PeerClient;
    const sync = new SyncManager(core, client, { intervalMs: 3_600_000 });
    await sync.fillStubs({ ip: "127.0.0.1", port: 1 }, "P");
    await sync.fillStubs({ ip: "127.0.0.1", port: 1 }, "P"); // in P's backoff: not asked again
    await sync.fillStubs({ ip: "127.0.0.1", port: 2 }, "H");
    expect(asked).toEqual(["1:1", "2:1"]);
    expect(statusOf(core, secret.id)).toBe("ok");
    sync.stop();
  });
});

// ---- F2: roster rows are never stubbed or counted in the hidden cap ---------------------------------

describe("F2: a future authority's linking event survives a full hidden cap", () => {
  test("the link arriving before the transfer on a replica whose cap is full still links (Fable A2)", async () => {
    const a = tnode("alex"), b = tnode("bea"), mal = tnode("mal");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, b, "owner"), nodeEv(team, a, b), memberEv(team, a, mal, "member"), nodeEv(team, a, mal),
      ev(team, a, "channel.upsert", { name: "general" }), ev(team, a, "channel.upsert", { name: "dev" })];
    const posts = Array.from({ length: 1_001 }, (_, i) => ev(team, b, "msg.post", { text: `dev ${i}` }, { channel: "dev" }));
    const narrow = ev(team, a, "channel.upsert", withWm({ name: "dev", members: ["alex"] }, { [b.keys.nodeId]: 0, [mal.keys.nodeId]: 0 }));
    const transfer = ev(team, a, "team.authority", { node_id: b.keys.nodeId });
    const removeMal = ev(team, b, "team.member", withWm({ login: mal.login, handle: "mal", role: "removed" as const, after: transfer.id }, { [mal.keys.nodeId]: 0 }));
    const later = ev(team, b, "channel.upsert", { name: "ops" });
    const malPost = ev(team, mal, "msg.post", { text: "still here?" }, { channel: "general" });

    const s = makeCore(tnode("s"), team, cleanups);
    feed(s, [...setup, ...posts, narrow, transfer, removeMal, later, malPost]);
    await settle(s);
    const r = makeCore(tnode("r"), team, cleanups);
    feed(r, [...setup, ...posts, narrow]);
    await settle(r);
    expect(r.store.hiddenCount(b.keys.nodeId)).toBe(1_000);
    feed(r, [removeMal]);
    expect(statusOf(r, removeMal.id)).toBe("rejected"); // hidden with its body, not a junk stub
    expect(r.store.getRow(removeMal.id)?.reason).toBe("not_authority");
    feed(r, [transfer, later, malPost]);
    r.drainPending();
    await settle(r);
    for (const core of [s, r]) {
      expect(core.authority).toBe(b.keys.nodeId);
      expect(core.roster.members.get(mal.login)?.role).toBe("removed");
      expect(core.roster.channels.has("ops")).toBe(true);
      expect(statusOf(core, removeMal.id)).toBe("ok");
      expect(statusOf(core, malPost.id)).toBe("rejected");
    }
  }, 60_000);
});

// ---- F3: the pending table ---------------------------------------------------------------------------

describe("F3: held events drain only when their dependency arrives", () => {
  function world() {
    const a = tnode("alex"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, k, "member"), nodeEv(team, a, k), ev(team, a, "channel.upsert", { name: "general" })];
    return { a, k, team, setup };
  }

  test("with 10k held rows an accepted ask costs O(1) (printed); nothing is re-ingested", () => {
    const { a, k, team, setup } = world();
    const core = makeCore(tnode("obs"), team, cleanups);
    feed(core, setup);
    const ghosts = Array.from({ length: 100 }, (_, i) => tnode(`ghost${i}`));
    const t0 = performance.now();
    for (const g of ghosts) {
      for (let i = 0; i < 100; i++) core.ingest(ev(team, g, "msg.post", { text: "x".repeat(500) }, { channel: "general" }), "remote");
    }
    const fillMs = performance.now() - t0;
    expect(core.store.pendingCount()).toBe(10_000);
    let reads = 0;
    const byDep = core.store.pendingByDep.bind(core.store);
    core.store.pendingByDep = (dep, ts, id, limit) => { const rows = byDep(dep, ts, id, limit); reads += rows.length; return rows; };
    const t1 = performance.now();
    const res = core.ingest(ev(team, k, "ask", { to: "@alex", text: "q", expires_at: Date.now() + 60_000 }, { channel: "general" }), "remote");
    const askMs = performance.now() - t1;
    core.drainPending();
    console.log(`[metric] 10k held rows (filled in ${fillMs.toFixed(0)} ms): one accepted ask took ${askMs.toFixed(2)} ms; rows re-ingested: ${reads}`);
    expect(res.status).toBe("accepted");
    expect(askMs).toBeLessThan(50);
    expect(reads).toBe(0);
    void a;
  }, 60_000);

  test("a new channel releases only the rows waiting for it", () => {
    const { a, k, team, setup } = world();
    const core = makeCore(tnode("obs"), team, cleanups);
    feed(core, setup);
    const early = Array.from({ length: 50 }, (_, i) => ev(team, k, "msg.post", { text: `x${i}` }, { channel: "x" }));
    const ghost = tnode("ghost");
    const ghostRows = Array.from({ length: 50 }, () => ev(team, ghost, "msg.post", { text: "g" }, { channel: "general" }));
    feed(core, [...early, ...ghostRows]);
    expect(core.store.pendingCount()).toBe(100);
    const deps: string[] = [];
    const byDep = core.store.pendingByDep.bind(core.store);
    core.store.pendingByDep = (dep, ts, id, limit) => { deps.push(dep); return byDep(dep, ts, id, limit); };
    feed(core, [ev(team, a, "channel.upsert", { name: "x" })]);
    expect(core.busy).toBeGreaterThan(0); // scheduled, not run inside ingest
    core.drainPending();
    expect([...new Set(deps)]).toEqual(["channel:x"]);
    expect(early.every((e) => statusOf(core, e.id) === "ok")).toBe(true);
    expect(core.store.pendingCount()).toBe(50);
  });

  test("held bytes are capped per claimed origin and per relaying peer", () => {
    const { team, setup } = world();
    const core = makeCore(tnode("obs"), team, cleanups);
    feed(core, setup);
    const big = "y".repeat(200_000);
    const ghost = tnode("ghost");
    const perOrigin = Array.from({ length: 50 }, () => core.ingest(ev(team, ghost, "msg.post", { text: "x", pad: big } as never, { channel: "general" }), "remote").reason);
    const firstFull = perOrigin.indexOf("pending_full");
    expect(firstFull).toBeGreaterThan(30);
    expect(perOrigin.slice(firstFull).every((r) => r === "pending_full")).toBe(true);
    const relayed = Array.from({ length: 50 }, (_, i) =>
      core.ingest(ev(team, tnode(`g${i}`), "msg.post", { text: "x", pad: big } as never, { channel: "general" }), "remote", "relay-p").reason);
    expect(relayed.filter((r) => r === "pending_full").length).toBeGreaterThan(0);
    expect(core.ingest(ev(team, tnode("other"), "msg.post", { text: "x", pad: big } as never, { channel: "general" }), "remote", "relay-q").status).toBe("pending");
  });

  test("an origin still unknown after an hour expires; other holds live 24 h", () => {
    const { k, team, setup } = world();
    const core = makeCore(tnode("obs"), team, cleanups);
    feed(core, setup);
    const ghostRow = ev(team, tnode("ghost"), "msg.post", { text: "g" }, { channel: "general" });
    const chanRow = ev(team, k, "msg.post", { text: "c" }, { channel: "nochan" });
    feed(core, [ghostRow, chanRow]);
    const now = Date.now();
    expect(core.store.expirePending(24 * 3_600_000, 3_600_000, now + 30 * 60_000)).toBe(0);
    expect(core.store.expirePending(24 * 3_600_000, 3_600_000, now + 61 * 60_000)).toBe(1);
    expect(core.store.hasPending(ghostRow.id)).toBe(false);
    expect(core.store.hasPending(chanRow.id)).toBe(true);
    expect(core.store.expirePending(24 * 3_600_000, 3_600_000, now + 25 * 3_600_000)).toBe(1);
  });
});

// ---- F4: omitted channel fields keep their values -----------------------------------------------------

describe("F4: a topic-only upsert can't declassify a channel", () => {
  function authority() {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups);
    expect(core.ingest(create, "local").status).toBe("accepted");
    return { a, team, core };
  }

  test("the authority signs the previous members; only public: true opens the channel", () => {
    const { core } = authority();
    core.emit("channel.upsert", { name: "vault", members: ["alex"] });
    const topic = core.emit("channel.upsert", { name: "vault", topic: "renamed" });
    expect((topic.body as { members?: string[] }).members).toEqual(["alex"]);
    expect(core.roster.channels.get("vault")).toEqual({ name: "vault", topic: "renamed", members: ["alex"] });
    core.emit("channel.upsert", { name: "vault", archived: true });
    expect((core.emit("channel.upsert", { name: "vault", topic: "t2" }).body as { archived?: boolean }).archived).toBe(true);
    core.emit("channel.upsert", { name: "vault", public: true });
    expect(core.roster.channels.get("vault")?.members).toBeUndefined();
    expect(() => core.emit("channel.upsert", { name: "vault", public: true, members: ["alex"] })).toThrow(HttpError);
  });

  test("an upsert signed without members (older authority) keeps the channel restricted on every replica", () => {
    const a = tnode("alex"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const events = [create, memberEv(team, a, k, "member"), nodeEv(team, a, k), ev(team, a, "channel.upsert", { name: "vault", members: ["alex"] }),
      ev(team, a, "channel.upsert", { name: "vault", topic: "only a topic" })];
    const core = makeCore(tnode("obs"), team, cleanups);
    feed(core, events);
    expect(core.roster.channels.get("vault")?.members).toEqual(["alex"]);
    const peek = ev(team, k, "msg.post", { text: "in?" }, { channel: "vault" });
    expect(core.ingest(peek, "remote")).toEqual({ status: "rejected", reason: "not_channel_member" });
  });

  test("a member may not ask for public", () => {
    const r = buildChain([createTeam(tnode("alex")).create], "x").roster;
    expect(requestAllowed("channel.upsert", { name: "fresh", public: true }, r, { login: "k", handle: "kira", role: "member" }))
      .toEqual({ status: "reject", reason: "owner_only" });
  });
});

// ---- F5: channel quotas ---------------------------------------------------------------------------------

describe("F5: channel creation is capped", () => {
  test("a member gets 20 new channels per day through requests; owners aren't limited per day", () => {
    const a = tnode("alex"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups);
    core.ingest(create, "local");
    core.emit("team.member", { login: k.login, handle: "kira", role: "member" });
    core.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1" });
    const req = (name: string): RosterRequest => {
      const unsigned = { id: crypto.randomUUID().replaceAll("-", ""), kind: "channel.upsert" as const, body: { name }, node: k.keys.nodeId, ts: Date.now() };
      return { ...unsigned, sig: k.keys.sign(canonicalJson({ team, ...unsigned })) };
    };
    for (let i = 0; i < 20; i++) expect(applyRequest(core, req(`k${i}`))?.kind).toBe("channel.upsert");
    let err: unknown = null;
    try { applyRequest(core, req("k20")); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).code).toBe("channel_limit");
    expect(core.emit("channel.upsert", { name: "owner-made" }).kind).toBe("channel.upsert");
  });

  test("a team has at most 500 channels", () => {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups);
    core.ingest(create, "local");
    for (let i = 0; i < 500; i++) core.emit("channel.upsert", { name: `c${i}` });
    let err: unknown = null;
    try { core.emit("channel.upsert", { name: "one-more" }); } catch (e) { err = e; }
    expect((err as HttpError).code).toBe("channel_limit");
    expect(core.emit("channel.upsert", { name: "c7", topic: "updates still work" }).kind).toBe("channel.upsert");
  }, 60_000);
});
