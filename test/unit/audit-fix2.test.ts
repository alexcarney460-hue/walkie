// FIX-2 (single-writer roster authority, ALE-5156): the Codex FIX-1 re-audit scenarios #1, #2,
// #5–#8 replayed against the authority chain, plus arrival-order convergence. The integration-level
// ones (#3 blobs, #4 pages, roster requests, transfer) are in test/integration/audit-fix2.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import type { Core } from "../../src/daemon/core.ts";
import { PeerCallError, type PeerAddr, type PeerClient } from "../../src/daemon/peer-client.ts";
import { SyncManager } from "../../src/daemon/sync.ts";
import { canonicalJson } from "../../src/protocol/canonical.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, reopen, settle, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

/** A roster body carrying the authority's signed watermark `wm` (PROTOCOL §2 "Anchoring"). */
const withWm = <T>(body: T, wm: Record<string, number>): T => ({ ...body, wm }) as T;

function signedStub(n: TNode, e: Event): Record<string, unknown> {
  const h = { v: e.v, team: e.team, id: e.id, origin: e.origin, seq: e.seq, ts: e.ts, kind: e.kind, channel: e.channel };
  return { id: e.id, origin: e.origin, seq: e.seq, ts: e.ts, kind: e.kind, channel: e.channel, hsig: n.keys.sign(canonicalJson(h)), redacted: true };
}

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

/** Arrival in any order, then anti-entropy re-delivery: what every replica ends up with. */
function replicate(self: TNode, team: string, events: readonly Event[]): Core {
  const core = makeCore(self, team, cleanups);
  feed(core, events);
  feed(core, events);
  core.drainPending();
  return core;
}

function verdicts(core: Core, events: readonly Event[]): string[] {
  return events.map((e) => `${e.id}=${statusOf(core, e.id)}`).sort();
}

// ---- #1: self-demotion / demoted owner keeps roster powers --------------------------------------

describe("re-audit #1: a demoted owner can't change the roster", () => {
  test("the authority can't demote itself, so a later promotion is a legitimate authority act", () => {
    const f = tnode("fred"), b = tnode("bea"), mal = tnode("mal");
    const { team, create } = createTeam(f);
    const setup = [create, memberEv(team, f, b, "owner"), nodeEv(team, f, b)];
    const selfDemote = ev(team, f, "team.member", { login: f.login, handle: "fred", role: "member" }); // F:4
    const events = [...setup, selfDemote];
    const promote = ev(team, f, "team.member", { login: mal.login, handle: "mal", role: "owner" }, { ts: create.ts + 35 });
    const core = replicate(tnode("obs"), team, [...events, promote]);
    expect(core.store.getRow(selfDemote.id)?.reason).toBe("authority_must_stay_owner");
    expect(core.roster.members.get(f.login)?.role).toBe("owner");
    expect(statusOf(core, promote.id)).toBe("ok");
  });

  test("after a transfer the demoted ex-authority's (backdated) roster events never apply, in any arrival order", () => {
    const f = tnode("fred"), b = tnode("bea"), mal = tnode("mal");
    const { team, create } = createTeam(f);
    const setup = [create, memberEv(team, f, b, "owner"), nodeEv(team, f, b), memberEv(team, f, mal, "member"), nodeEv(team, f, mal)];
    const transfer = ev(team, f, "team.authority", { node_id: b.keys.nodeId });
    const demote = ev(team, b, "team.member", withWm({ login: f.login, handle: "fred", role: "member" as const, after: transfer.id }, { [f.keys.nodeId]: 6 }));
    const promoteMal = ev(team, f, "team.member", { login: mal.login, handle: "mal", role: "owner" }, { ts: transfer.ts - 1_000 });
    const all = [...setup, transfer, demote, promoteMal];
    const expected = verdicts(replicate(tnode("ref"), team, all), all);
    for (let seed = 1; seed <= 20; seed++) {
      const core = replicate(tnode(`r${seed}`), team, shuffle(all, seed));
      expect(core.authority).toBe(b.keys.nodeId);
      expect(core.roster.members.get(f.login)?.role).toBe("member");
      expect(core.roster.members.get(mal.login)?.role).toBe("member");
      expect(core.store.getRow(promoteMal.id)?.reason).toBe("not_authority");
      expect(verdicts(core, all)).toEqual(expected);
    }
  });
});

// ---- #2: deferred old admissions resurrect removed machines ------------------------------------

describe("re-audit #2: a removed member's machine stays revoked until a later admission", () => {
  test("in any arrival order; another owner's stale admission never applies", () => {
    const a = tnode("alex"), o = tnode("olga"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, o, "owner"), nodeEv(team, a, o), memberEv(team, a, m, "member"), nodeEv(team, a, m),
      ev(team, a, "channel.upsert", { name: "general" })];
    const p1 = ev(team, m, "msg.post", { text: "before removal" }, { channel: "general" });
    const staleAdmit = nodeEv(team, o, m); // an owner that isn't the authority
    const removal = ev(team, a, "team.member", withWm({ login: m.login, handle: "mia", role: "removed" as const }, { [m.keys.nodeId]: 1 }));
    const reinvite = memberEv(team, a, m, "member");
    const p2 = ev(team, m, "msg.post", { text: "old laptop after re-invite" }, { channel: "general" });
    const all = [...setup, p1, staleAdmit, removal, reinvite, p2];
    for (let seed = 1; seed <= 20; seed++) {
      const core = replicate(tnode(`r${seed}`), team, shuffle(all, seed));
      expect(core.roster.nodes.get(m.keys.nodeId)?.revoked).toBe(true);
      expect(core.roster.members.get(m.login)?.role).toBe("member");
      expect(statusOf(core, p1.id)).toBe("ok");
      expect(statusOf(core, p2.id)).toBe("rejected");
      expect(core.store.getRow(staleAdmit.id)?.reason).toBe("not_authority");
    }
    // A fresh admission by the authority (walkie join) is what re-arms the machine.
    const core = replicate(tnode("fresh"), team, [...all, nodeEv(team, a, m)]);
    expect(core.roster.nodes.get(m.keys.nodeId)?.revoked).toBe(false);
  });
});

// ---- #5: invalid roster events cost O(1) ----------------------------------------------------------

describe("re-audit #5: a member's roster-event flood never reaches the chain", () => {
  // FIX-3 (F2): hidden roster rows are never stubbed and have their own cap (200 per origin); past it
  // a non-authority roster event is refused (`roster_hidden_full`), which stalls only that origin.
  test("1000 signed team.member events are rejected not_authority without a chain walk", () => {
    const a = tnode("alex"), m = tnode("mal");
    const { team, create } = createTeam(a);
    const core = makeCore(tnode("obs"), team, cleanups);
    feed(core, [create, memberEv(team, a, m, "member"), nodeEv(team, a, m)]);
    let walks = 0;
    const rows = core.store.rosterRows.bind(core.store);
    core.store.rosterRows = (o, after, upto) => { walks++; return rows(o, after, upto); };
    const t0 = performance.now();
    const reasons: string[] = [];
    for (let i = 0; i < 1_000; i++) {
      reasons.push(core.ingest(ev(team, m, "team.member", { login: a.login, handle: "alex", role: "removed" }), "remote").reason ?? "");
    }
    const ms = performance.now() - t0;
    console.log(`[metric] 1000 non-authority roster events: ${ms.toFixed(0)} ms, chain walks: ${walks}`);
    expect(walks).toBe(0);
    expect(reasons.slice(0, 200).every((r) => r === "not_authority")).toBe(true);
    expect(reasons.slice(200).every((r) => r === "roster_hidden_full")).toBe(true);
    expect(core.roster.members.get(a.login)?.role).toBe("owner");
    expect(core.store.hiddenRosterCount(m.keys.nodeId)).toBe(200);
    expect(core.store.hiddenCount(m.keys.nodeId)).toBe(0); // roster rows don't use the non-roster cap
    expect(core.store.vvOf(m.keys.nodeId)).toBe(200);
  });
});

// ---- #6: re-validation respects the hidden cap and is paged ---------------------------------------

describe("re-audit #6: re-validation is paged and keeps the deterministic hidden cap", () => {
  test("1500 accepted posts invalidated by a demotion: 1000 lowest seqs stay hidden, the rest keep a header", async () => {
    const a = tnode("alex"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), ev(team, a, "channel.upsert", { name: "general" })];
    const posts: Event[] = [];
    for (let i = 0; i < 1_500; i++) posts.push(ev(team, m, "msg.post", { text: `post ${i}` }, { channel: "general" }));
    const demote = ev(team, a, "team.member", withWm({ login: m.login, handle: "mia", role: "observer" as const }, { [m.keys.nodeId]: 0 }));

    const late = makeCore(tnode("late"), team, cleanups);
    feed(late, [...setup, ...posts]);
    feed(late, [demote]);
    expect(late.revalidating).toBeGreaterThan(0); // one ≤1000-row page ran; the rest waits for the next tick
    await settle(late);
    const early = makeCore(tnode("early"), team, cleanups);
    feed(early, [...setup, demote, ...posts]);

    for (const core of [late, early]) {
      expect(core.revalidating).toBe(0);
      expect(core.store.hiddenCount(m.keys.nodeId)).toBe(1_000);
      expect(posts.slice(0, 1_000).every((p) => statusOf(core, p.id) === "rejected")).toBe(true);
      expect(posts.slice(1_000).every((p) => statusOf(core, p.id) === "junk")).toBe(true);
      expect(core.store.vvOf(m.keys.nodeId)).toBe(1_500);
    }
  }, 30_000);

  test("a restart in the middle of re-validation re-judges everything once", async () => {
    const a = tnode("alex"), m = tnode("mia"), self = tnode("obs");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), ev(team, a, "channel.upsert", { name: "general" })];
    const posts = Array.from({ length: 1_200 }, (_, i) => ev(team, m, "msg.post", { text: `p${i}` }, { channel: "general" }));
    const core = makeCore(self, team, cleanups);
    feed(core, [...setup, ...posts]);
    feed(core, [ev(team, a, "team.member", withWm({ login: m.login, handle: "mia", role: "observer" as const }, { [m.keys.nodeId]: 0 }))]);
    expect(core.revalidating).toBeGreaterThan(0);
    const again = reopen(core, self); // the queued page is lost with the old process
    await settle(again);
    expect(posts.every((p) => ["rejected", "junk"].includes(statusOf(again, p.id)))).toBe(true);
    expect(again.store.hiddenCount(m.keys.nodeId)).toBe(1_000);
    again.close();
  }, 30_000);
});

// ---- #7: roster-dependent failures are never permanent; handles are fixed by the chain -------------

describe("re-audit #7: handle conflicts converge in every arrival order", () => {
  test("a second invite with another handle is rejected by the chain; posts converge", () => {
    const a = tnode("alex"), x = tnode("alpha");
    const { team, create } = createTeam(a);
    const iAlpha = memberEv(team, a, x, "member");
    const iBeta = ev(team, a, "team.member", { login: x.login, handle: "beta", role: "member" });
    const admit = nodeEv(team, a, x);
    const general = ev(team, a, "channel.upsert", { name: "general" });
    const pAlpha = ev(team, x, "msg.post", { text: "as alpha" }, { channel: "general" });
    const pBeta = ev(team, x, "msg.post", { text: "as beta" }, { channel: "general", handle: "beta" });
    const all = [create, iAlpha, iBeta, admit, general, pAlpha, pBeta];
    for (let seed = 1; seed <= 50; seed++) {
      const core = replicate(tnode(`r${seed}`), team, shuffle(all, seed));
      expect(core.store.getRow(iBeta.id)?.reason).toBe("handle_immutable");
      expect(core.roster.members.get(x.login)?.handle).toBe("alpha");
      expect(statusOf(core, pAlpha.id)).toBe("ok");
      expect(statusOf(core, pBeta.id)).toBe("rejected"); // hidden with its body, not junk
    }
  });
});

// ---- #8: stub fill is fair and persistent ---------------------------------------------------------

describe("re-audit #8: unfillable stubs can't starve backfill", () => {
  test("a page of unfillable stubs is rotated out; later stubs are fetched; tried ones back off", async () => {
    const a = tnode("alex"), k = tnode("kira");
    let bad = tnode("bad");
    while (bad.keys.nodeId > a.keys.nodeId) bad = tnode("bad"); // the unfillable stubs sort first
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, k, "member"), nodeEv(team, a, k), memberEv(team, a, bad, "member"), nodeEv(team, a, bad),
      ev(team, a, "channel.upsert", { name: "vault", members: ["alex", "bad"] })];
    const junk: Event[] = [];
    for (let i = 0; i < 120; i++) junk.push(ev(team, bad, "msg.post", { text: `never served ${i}` }, { channel: "vault" }));
    const real: Event[] = [];
    for (let i = 0; i < 30; i++) real.push(ev(team, a, "msg.post", { text: `history ${i}` }, { channel: "vault" }));
    const grant = ev(team, a, "channel.upsert", { name: "vault", members: ["alex", "bad", "kira"] });

    const core = makeCore(k, team, cleanups);
    feed(core, setup);
    for (const e of junk) core.ingest(signedStub(bad, e), "remote");
    for (const e of real) core.ingest(signedStub(a, e), "remote");
    core.ingest(grant, "remote");
    const asked: string[][] = [];
    const client = {
      pullIds: async (_addr: PeerAddr, ids: readonly string[]) => {
        asked.push([...ids]);
        return { events: real.filter((e) => ids.includes(e.id)) };
      },
    } as unknown as PeerClient;
    const sync = new SyncManager(core, client, { intervalMs: 3_600_000 });
    await sync.fillStubs({ ip: "127.0.0.1", port: 1 });
    expect(real.every((e) => statusOf(core, e.id) === "ok")).toBe(true);
    const firstRound = asked.flat().length;
    await sync.fillStubs({ ip: "127.0.0.1", port: 1 });
    expect(asked.flat().length).toBe(firstRound); // the unfillable ones are in backoff, not re-asked at once
    sync.stop();
  });
});

// ---- #4 (client side): smaller pages on a cap error, one origin's failure doesn't stop the rest ----

describe("re-audit #4: page retries and per-origin isolation", () => {
  test("too_large halves the page; a failing origin doesn't abort the others", async () => {
    const a = tnode("alex"), k = tnode("kira"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, k, "member"), nodeEv(team, a, k), memberEv(team, a, m, "member"), nodeEv(team, a, m),
      ev(team, a, "channel.upsert", { name: "general" })];
    const kPosts = Array.from({ length: 40 }, (_, i) => ev(team, k, "msg.post", { text: `k${i}` }, { channel: "general" }));
    const core = makeCore(tnode("obs"), team, cleanups);
    feed(core, setup);
    const limits: number[] = [];
    const client = {
      pull: async (_addr: PeerAddr, origin: string, after: number, limit: number) => {
        if (origin === m.keys.nodeId) throw new PeerCallError(502, "bad_response", "broken origin");
        limits.push(limit);
        if (limit > 20) throw new PeerCallError(200, "too_large", "too large");
        return { events: kPosts.filter((e) => e.seq > after).slice(0, limit) };
      },
    } as unknown as PeerClient;
    const sync = new SyncManager(core, client, { intervalMs: 3_600_000 });
    await sync.pullAll({ ip: "127.0.0.1", port: 1 }, { [m.keys.nodeId]: 5, [k.keys.nodeId]: 40 });
    expect(core.store.vvOf(k.keys.nodeId)).toBe(40);
    expect(limits.slice(0, 5)).toEqual([500, 250, 125, 62, 31]);
    sync.stop();
  });
});

// ---- convergence property -------------------------------------------------------------------------

describe("arrival-order convergence (property)", () => {
  test("replicas receiving one event set in 60 random orders accept exactly the same events", () => {
    const alex = tnode("alex"), bea = tnode("bea"), kira = tnode("kira"), mal = tnode("mal");
    const obs = tnode("alex", alex.login, "alex-studio");
    const { team, create } = createTeam(alex);
    const E: Event[] = [create, nodeEv(team, alex, obs), memberEv(team, alex, bea, "owner"), nodeEv(team, alex, bea),
      memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira), ev(team, alex, "channel.upsert", { name: "general" }),
      ev(team, alex, "channel.upsert", { name: "secret", members: ["alex", "kira"] })];
    const k1 = ev(team, kira, "msg.post", { text: "hello" }, { channel: "general" });
    const k2 = ev(team, kira, "msg.post", { text: "secret hello" }, { channel: "secret" });
    const ask = ev(team, kira, "ask", { to: "@alex", text: "q?", expires_at: Date.now() + 600_000 }, { channel: "general" });
    const answer = ev(team, alex, "answer", { ask: ask.id, text: "a" }, { channel: "general" });
    E.push(k1, k2, ask, answer, memberEv(team, bea, mal, "owner"));
    E.push(memberEv(team, alex, mal, "member"), ev(team, alex, "team.member", { login: mal.login, handle: "mallory", role: "member" }), nodeEv(team, alex, mal));
    E.push(ev(team, mal, "msg.post", { text: "as mal" }, { channel: "general" }),
      ev(team, mal, "msg.post", { text: "as mallory" }, { channel: "general", handle: "mallory" }));
    E.push(ev(team, alex, "team.member", withWm({ login: kira.login, handle: "kira", role: "observer" as const }, { [kira.keys.nodeId]: 2 })));
    E.push(ev(team, kira, "msg.post", { text: "after demotion" }, { channel: "general" }));
    const transfer = ev(team, alex, "team.authority", { node_id: bea.keys.nodeId });
    E.push(transfer, ev(team, bea, "channel.upsert", withWm({ name: "secret", members: ["alex"], after: transfer.id }, { [kira.keys.nodeId]: 2 })));
    E.push(memberEv(team, alex, tnode("late"), "member"), ev(team, alex, "msg.post", { text: "alex still posts" }, { channel: "general" }));
    E.push(ev(team, kira, "msg.post", { text: "secret after cut" }, { channel: "secret" }));

    const ref = replicate(obs, team, E);
    const expected = verdicts(ref, E);
    expect(ref.authority).toBe(bea.keys.nodeId);
    expect(statusOf(ref, k2.id)).toBe("ok");
    expect(statusOf(ref, ask.id)).toBe("rejected");
    expect(statusOf(ref, answer.id)).toBe("rejected");
    for (let seed = 1; seed <= 60; seed++) {
      const core = replicate({ ...obs }, team, shuffle(E, seed));
      expect({ seed, v: verdicts(core, E) }).toEqual({ seed, v: expected });
    }
  });
});
