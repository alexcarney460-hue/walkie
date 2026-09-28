// FINAL-2 re-audits (docs/audits/2026-09-26-hestia-codex-final2.md, 2026-09-26-fable-final2.md): the core.
import { afterEach, describe, expect, test } from "bun:test";
import { Core, FUTURE_HOLD_MS, FUTURE_SKEW_MS, PLAN_FLOOR_META } from "../../src/daemon/core.ts";
import { generateKeys, signEvent } from "../../src/daemon/keys.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";
import { SyncManager } from "../../src/daemon/sync.ts";
import { activateOnAuthority } from "../../src/license/activate.ts";
import { DAY_MS } from "../../src/license/plans.ts";
import { eventId } from "../../src/protocol/ids.ts";
import { PROTOCOL_VERSION, type Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, reopen, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, now, tnode, type TNode } from "../helpers/events.ts";
import { testVendor } from "../helpers/license.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const vendor = testVendor();
const YEARS_10 = 10 * 365 * DAY_MS;

function nodeBody(n: TNode) {
  return { node_id: n.keys.nodeId, login: n.login, hostname: n.hostname, pubkey: n.keys.pubkey, ip: "127.0.0.1" };
}

/** An event that CLAIMS `victim`'s origin and next seq but is signed by someone else's key (a forgery). */
function forged(team: string, victim: TNode, seq: number, opts: { ts?: number; kind?: "msg.post" | "channel.upsert" } = {}): Event {
  const attacker = generateKeys();
  const kind = opts.kind ?? "msg.post";
  const body = kind === "msg.post" ? { text: "forged" } : { name: "forged" };
  return signEvent(attacker, {
    v: PROTOCOL_VERSION, team, id: eventId(victim.keys.nodeId, seq), origin: victim.keys.nodeId, seq, ts: opts.ts ?? now(),
    author: { handle: victim.handle, node: victim.keys.nodeId }, kind, ...(kind === "msg.post" ? { channel: "general" } : {}), body,
  } as never) as Event;
}

/** An observer member's core `M` holding the authority `a`'s chain (team, members `m` + `obs` admitted, #general). */
function memberOf(a: TNode, m: TNode, clock: () => number = now) {
  const obs = tnode("obs");
  const { team: id, create } = createTeam(a);
  const M = makeCore(obs, id, cleanups, { clock });
  feed(M, [create, memberEv(id, a, m, "member"), nodeEv(id, a, m), memberEv(id, a, obs, "member"), nodeEv(id, a, obs),
    ev(id, a, "channel.upsert", { name: "general" })]);
  expect(M.chainLength).toBe(6);
  return { id, M };
}

// ---- Codex 1 (HIGH): a forged far-future event must never reserve a known origin's next id -------------

describe("Codex 1: known origins are authenticated before any hold", () => {
  test("a forged authority seq+1 held as future_ts does not block the authentic event", () => {
    const a = tnode("alex"), m = tnode("mia");
    const { id, M } = memberOf(a, m);
    const next = M.store.vvOf(a.keys.nodeId) + 1;
    const fake = forged(id, a, next, { ts: now() + YEARS_10, kind: "channel.upsert" });
    expect(M.ingest(fake, "remote")).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(statusOf(M, fake.id)).toBe("absent"); // never held
    const real = ev(id, a, "channel.upsert", { name: "ops" });
    expect(real.seq).toBe(next);
    expect(M.ingest(real, "remote")).toEqual({ status: "accepted" });
    expect(M.roster.channels.has("ops")).toBe(true);
    // A removal after it still lands: the chain isn't frozen.
    expect(M.ingest(memberEv(id, a, m, "removed"), "remote")).toEqual({ status: "accepted" });
    expect(M.roster.members.get(m.login)?.role).toBe("removed");
  });

  test("a forged member event with a far-future ts is rejected, not held; the member's real event is accepted", () => {
    const a = tnode("alex"), m = tnode("mia");
    const { id, M } = memberOf(a, m);
    const fake = forged(id, m, 1, { ts: now() + YEARS_10 });
    expect(M.ingest(fake, "remote")).toEqual({ status: "rejected", reason: "bad_signature" });
    const real = ev(id, m, "msg.post", { text: "hi" }, { channel: "general" });
    expect(M.ingest(real, "remote")).toEqual({ status: "accepted" });
  });

  test("an unknown-origin candidate never blocks the authentic event once the origin is known", () => {
    const a = tnode("alex"), m = tnode("mia"), n = tnode("nia");
    const { id, M } = memberOf(a, m);
    const fake = forged(id, n, 1); // nia isn't admitted yet: the candidate is quarantined (unknown_origin)
    expect(M.ingest(fake, "remote")).toEqual({ status: "pending", reason: "unknown_origin" });
    feed(M, [memberEv(id, a, n, "member"), nodeEv(id, a, n)]);
    // Before the drain runs, nia's authentic seq 1 arrives by push: it replaces the candidate.
    const real = ev(id, n, "msg.post", { text: "hello" }, { channel: "general" });
    expect(M.ingest(real, "remote")).toEqual({ status: "accepted" });
    expect(statusOf(M, real.id)).toBe("ok");
    expect(M.store.hasPending(real.id)).toBe(false);
  });

  test("an authenticated far-future event of a member is still held (future_ts), and a duplicate stays pending", () => {
    const a = tnode("alex"), m = tnode("mia");
    const { id, M } = memberOf(a, m);
    const far = ev(id, m, "msg.post", { text: "2036" }, { channel: "general", ts: now() + YEARS_10 });
    expect(M.ingest(far, "remote")).toEqual({ status: "pending", reason: "future_ts" });
    expect(M.ingest(far, "remote")).toEqual({ status: "pending", reason: "already_pending" });
  });
});

// ---- Fable 3 (MEDIUM): an authority whose clock was wrong recovers ---------------------------------------

describe("Fable 3: authority clock recovery", () => {
  test("members accept the authority's chain entries whatever their ts (clock-derived state stays clamped)", () => {
    const a = tnode("alex"), m = tnode("mia");
    const { id, M } = memberOf(a, m);
    const wrong = ev(id, a, "channel.upsert", { name: "x" }, { ts: now() + YEARS_10 }); // emitted while its clock was +10 y
    expect(M.ingest(wrong, "remote")).toEqual({ status: "accepted" });
    expect(M.roster.channels.has("x")).toBe(true);
    expect(M.planNow()).toBeLessThanOrEqual(now() + FUTURE_SKEW_MS);
    const fixed = ev(id, a, "channel.upsert", { name: "y" }, { ts: now() + 1000 }); // after the correction
    expect(M.ingest(fixed, "remote")).toEqual({ status: "accepted" });
    expect(M.ingest(memberEv(id, a, tnode("bea"), "member"), "remote")).toEqual({ status: "accepted" });
    expect(M.chainLength).toBe(9);
  });

  test("the authority's own far-future non-roster events don't pin its chain on a member either", () => {
    const a = tnode("alex"), m = tnode("mia");
    const { id, M } = memberOf(a, m);
    const post = ev(id, a, "msg.post", { text: "from 2036" }, { channel: "general", ts: now() + YEARS_10 });
    expect(M.ingest(post, "remote").status).toBe("accepted");
    expect(M.ingest(ev(id, a, "channel.upsert", { name: "after" }), "remote")).toEqual({ status: "accepted" });
    expect(M.roster.channels.has("after")).toBe(true);
  });

  test("authority +10 y for an hour, then corrected: after a restart the plan and a fresh license work again", () => {
    let t = now();
    const a = tnode("alex"), m = tnode("mia");
    const { team: id, create } = createTeam(a);
    const A = makeCore(a, id, cleanups, { licenseVerifier: vendor.verify, clock: () => t });
    t = Math.max(t, create.ts + 1);
    A.ingest(create, "local");
    A.emit("team.member", { login: m.login, handle: m.handle, role: "member" });
    A.emit("team.node", nodeBody(m));
    A.emit("channel.upsert", { name: "general" });
    A.emit("team.license", { key: vendor.issue({ team: id, plan: "business", seats: 10, issued_at: t }) });
    const base = t;
    expect(A.plan()?.status).toBe("active");
    t = base + YEARS_10; A.noteTime(); // the hourly plan-clock record while the clock was wrong
    t = base + 2 * DAY_MS; // corrected
    expect(A.plan()?.status).toBe("free"); // still pinned until the restart (the floor is persisted)
    const R = reopen(A, a); cleanups.push(() => R.close());
    expect(R.planNow()).toBeLessThanOrEqual(t + FUTURE_SKEW_MS);
    expect(Number(R.store.getMeta(PLAN_FLOOR_META))).toBeLessThanOrEqual(t + FUTURE_SKEW_MS);
    expect(R.plan()).toMatchObject({ plan: "business", status: "active" });
    expect(activateOnAuthority(R, vendor.issue({ team: id, plan: "business", seats: 12, issued_at: t }))?.kind).toBe("team.license");
    expect(R.plan()?.seats.limit).toBe(12);
  });

  test("a floor within a day of the clock is kept at startup (a rolled-back clock still can't revive a trial by more than that)", () => {
    const a = tnode("alex"), m = tnode("mia"), obs = tnode("obs");
    const { team: id, create } = createTeam(a);
    const core = makeCore(obs, id, cleanups, { clock: () => now() });
    feed(core, [create, memberEv(id, a, m, "member"), nodeEv(id, a, m)]);
    core.store.setMeta(PLAN_FLOOR_META, String(now() + 20 * 60 * 60_000)); // 20 h ahead: kept
    expect(reopen(core, obs).planNow()).toBe(now() + 20 * 60 * 60_000);
    core.store.setMeta(PLAN_FLOOR_META, String(now() + 2 * DAY_MS)); // 2 d ahead: reset
    const R = reopen(core, obs); cleanups.push(() => R.close());
    expect(R.planNow()).toBeLessThanOrEqual(now() + FUTURE_SKEW_MS);
  });
});

// ---- Fable 6 (LOW): a held far-future event must not cost a re-pull of the origin every round ----------

describe("Fable 6: pulls resume past a held row instead of re-fetching the origin every round", () => {
  function fakeClient(served: Event[], log: number[]): PeerClient {
    return {
      pull: async (_addr: unknown, origin: string, after: number, limit: number) => {
        log.push(after);
        return { events: served.filter((e) => e.origin === origin && e.seq > after).slice(0, limit) };
      },
    } as unknown as PeerClient;
  }

  test("seq 1 held future_ts, seq 2..4 accepted once; the next rounds pull nothing new", async () => {
    const a = tnode("alex"), m = tnode("mia");
    const { id, M } = memberOf(a, m);
    const held = ev(id, m, "msg.post", { text: "2036" }, { channel: "general", ts: now() + YEARS_10 });
    const rest = [2, 3, 4].map((i) => ev(id, m, "msg.post", { text: `t${i}` }, { channel: "general" }));
    const log: number[] = [];
    const served = [held, ...rest];
    const sync = new SyncManager(M, fakeClient(served, log), { intervalMs: 60_000 });
    const addr = { ip: "127.0.0.1", port: 1 };
    await sync.catchUp(addr, m.keys.nodeId, 4, "peer");
    expect(statusOf(M, held.id)).toBe("pending");
    for (const e of rest) expect(statusOf(M, e.id)).toBe("ok");
    expect(M.store.vvOf(m.keys.nodeId)).toBe(0); // pinned by the hold
    const before = log.length;
    await sync.catchUp(addr, m.keys.nodeId, 4, "peer");
    await sync.catchUp(addr, m.keys.nodeId, 4, "peer");
    expect(log.slice(before)).toEqual([]); // nothing past what was already received: no re-pull
    // A fifth event appears at the peer: pulled from where we left off, not from 0.
    const fifth = ev(id, m, "msg.post", { text: "t5" }, { channel: "general" });
    served.push(fifth);
    await sync.catchUp(addr, m.keys.nodeId, 5, "peer");
    expect(log[log.length - 1]).toBe(4);
    expect(statusOf(M, fifth.id)).toBe("ok");
    // Once the hold is gone (expired), the pull starts from the version vector again.
    M.store.deletePending(held.id);
    const before2 = log.length;
    await sync.catchUp(addr, m.keys.nodeId, 5, "peer");
    expect(log[before2]).toBe(0);
  });
});
