// WALKIE-LICENSE-1: `team.license` in the authority chain, and soft enforcement at emit.
// The property tests show licenses change NO validity semantics: the same event set with license
// entries interleaved (valid or forged keys, and watermarks that would cover everything) gives every
// non-roster event the same verdict and the same roster on every replica.
import { afterEach, describe, expect, test } from "bun:test";
import { buildChain } from "../../src/daemon/chain.ts";
import type { Core } from "../../src/daemon/core.ts";
import { HttpError } from "../../src/daemon/http.ts";
import { signRequest, applyRequest, admitJoin } from "../../src/daemon/requests.ts";
import { activateOnAuthority, checkActivatable } from "../../src/license/activate.ts";
import { DAY_MS, GRACE_MS, TRIAL_MS } from "../../src/license/plans.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, settle, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, now, tnode, type TNode } from "../helpers/events.ts";
import { testVendor } from "../helpers/license.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const vendor = testVendor();
const forger = testVendor();
const lic = (team: string, by: TNode, key: string, extra: Record<string, unknown> = {}): Event =>
  ev(team, by, "team.license", { key, ...extra } as never);

function thrown(fn: () => unknown): HttpError | undefined {
  try { fn(); } catch (err) { if (err instanceof HttpError) return err; throw err; }
  return undefined;
}

describe("team.license in the chain", () => {
  test("applied when the authority signs a valid key; the latest valid one wins; forged keys are rejected, not applied", () => {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    const k1 = vendor.issue({ team, seats: 3 });
    const k2 = vendor.issue({ team, seats: 9 });
    const good1 = lic(team, a, k1), forged = lic(team, a, forger.issue({ seats: 500 })), good2 = lic(team, a, k2);
    const junk = lic(team, a, "not-a-key");
    const core = makeCore(tnode("obs"), team, cleanups, { licenseVerifier: vendor.verify });
    feed(core, [create, good1]);
    expect(core.roster.license?.payload.seats).toBe(3);
    feed(core, [forged]);
    expect([statusOf(core, forged.id), core.store.getRow(forged.id)?.reason]).toEqual(["rejected", "bad_license"]);
    expect(core.roster.license?.payload.seats).toBe(3);
    feed(core, [good2, junk]);
    expect(core.roster.license?.key).toBe(k2);
    expect([statusOf(core, junk.id), core.store.getRow(junk.id)?.reason]).toEqual(["rejected", "bad_license"]);
    expect(core.roster.license?.key).toBe(k2);
  });

  test("every node verifies with its own verifier: the production verifier rejects a key from any other signer", () => {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    const e = lic(team, a, vendor.issue({ team }));
    const prod = makeCore(tnode("prod"), team, cleanups); // no injected verifier: the embedded vendor key
    feed(prod, [create, e]);
    expect(prod.roster.license).toBeUndefined();
    expect(prod.store.getRow(e.id)?.reason).toBe("bad_license");
  });

  test("a non-authority owner's license never applies; a non-owner can't request one", () => {
    const a = tnode("alex"), b = tnode("bea"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, b, "owner"), nodeEv(team, a, b), memberEv(team, a, m, "member"), nodeEv(team, a, m)];
    const byB = lic(team, b, vendor.issue({ team }));
    const core = makeCore(tnode("obs"), team, cleanups, { licenseVerifier: vendor.verify });
    feed(core, [...setup, byB]);
    expect(core.store.getRow(byB.id)?.reason).toBe("not_authority");
    expect(core.roster.license).toBeUndefined();
    // On the authority, a member's request for a license is refused (owners only).
    const auth = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify });
    auth.ingest(create, "local");
    for (const [who, role] of [[b, "owner"], [m, "member"]] as const) {
      auth.emit("team.member", { login: who.login, handle: who.handle, role });
      auth.emit("team.node", nodeBody(who));
    }
    const denied = signRequest(fakeRequester(m, team) as unknown as Core, "team.license", { key: vendor.issue({ team }) });
    expect(thrown(() => applyRequest(auth, denied))?.status).toBe(403);
    // An owner's request is applied by the authority, after the same activation checks.
    const forgedReq = signRequest(fakeRequester(b, team) as unknown as Core, "team.license", { key: forger.issue() });
    expect(thrown(() => applyRequest(auth, forgedReq))?.code).toBe("invalid_license");
    const ok = signRequest(fakeRequester(b, team) as unknown as Core, "team.license", { key: vendor.issue({ team, seats: 6 }) });
    expect(applyRequest(auth, ok)?.kind).toBe("team.license");
    expect(auth.roster.license?.payload.seats).toBe(6);
  });

  test("a license entry's watermark is ignored: it anchors nothing", () => {
    const a = tnode("alex"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const events = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), lic(team, a, vendor.issue({ team }), { wm: { [m.keys.nodeId]: 50 } })];
    const chain = buildChain(events, team, { verifyLicense: vendor.verify });
    expect(chain.length).toBe(4);
    expect(chain.roster.license).toBeDefined();
    expect(chain.maxWm(m.keys.nodeId)).toBe(0);
    expect(chain.anchor(m.keys.nodeId, 1)).toBeNull();
  });
});

/** A requester stand-in with the fields signRequest reads. */
function fakeRequester(n: TNode, team: string): { nodeId: string; teamId: string; keys: TNode["keys"] } {
  return { nodeId: n.keys.nodeId, teamId: team, keys: n.keys };
}

// ---- property: licenses change no validity semantics ----------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const rnd = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

interface Cast { a: TNode; m: TNode; k: TNode; team: string; create: Event }

/**
 * One random history. The authority's choices and every member event come from `rnd`, so with and
 * without licenses the members' events are byte-identical; licenses (valid or forged keys, carrying a
 * watermark that would cover everything) are interleaved from a separate generator.
 */
function history(cast: Cast, seed: number, withLicenses: boolean): Event[] {
  const a = { ...cast.a, seq: 1 }, m = { ...cast.m, seq: 0 }, k = { ...cast.k, seq: 0 };
  const { team } = cast;
  const rnd = rng(seed), lrnd = rng(seed ^ 0x5bd1e995);
  const wm = { m: 0, k: 0 };
  // Deterministic timestamps: licenses don't advance the clock, so both histories sign identical member events.
  let clock = cast.create.ts;
  const at = (): number => (clock += 1000);
  const mark = (): Record<string, number> => {
    wm.m = Math.max(wm.m, Math.floor(rnd() * (m.seq + 1)));
    wm.k = Math.max(wm.k, Math.floor(rnd() * (k.seq + 1)));
    return { [m.keys.nodeId]: wm.m, [k.keys.nodeId]: wm.k };
  };
  const roster = (kind: "team.member" | "team.node" | "channel.upsert", body: Record<string, unknown>): Event =>
    ev(team, a, kind, { ...body, wm: mark() } as never, { ts: at() });
  const out: Event[] = [cast.create];
  out.push(roster("team.member", { login: m.login, handle: "mia", role: "member" }));
  out.push(roster("team.node", { node_id: m.keys.nodeId, login: m.login, hostname: m.hostname, pubkey: m.keys.pubkey, ip: "127.0.0.1" }));
  out.push(roster("team.member", { login: k.login, handle: "kira", role: "member" }));
  out.push(roster("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1" }));
  out.push(roster("channel.upsert", { name: "general" }));
  out.push(roster("channel.upsert", { name: "secret", members: ["alex", "mia"] }));
  for (let step = 0; step < 40; step++) {
    if (withLicenses && lrnd() < 0.3) {
      const key = lrnd() < 0.5 ? vendor.issue({ team, seats: 1 + Math.floor(lrnd() * 20) }) : forger.issue();
      out.push(ev(team, a, "team.license", { key, wm: { [m.keys.nodeId]: 10_000, [k.keys.nodeId]: 10_000 } } as never, { ts: clock }));
    }
    // team.integration entries (LICENSE-FIX-2 F3) are interleaved the same way: valid ones (a known
    // node, enabled or disabled) and invalid ones (an unknown node), all with a covering watermark.
    if (withLicenses && lrnd() < 0.25) {
      const connector = (["fireflies", "wispr", "linear"] as const)[Math.floor(lrnd() * 3)] as "fireflies" | "wispr" | "linear";
      const node = lrnd() < 0.8 ? (lrnd() < 0.5 ? m : k).keys.nodeId : "0000000000000000";
      out.push(ev(team, a, "team.integration", { connector, node, enabled: lrnd() < 0.6, wm: { [m.keys.nodeId]: 10_000, [k.keys.nodeId]: 10_000 } } as never, { ts: clock }));
    }
    const r = rnd();
    const chan = rnd() < 0.5 ? "general" : "secret";
    if (r < 0.35) out.push(ev(team, m, "msg.post", { text: `m${step}` }, { channel: chan, ts: at() }));
    else if (r < 0.55) out.push(ev(team, k, "msg.post", { text: `k${step}` }, { channel: chan, ts: at() }));
    else if (r < 0.65) out.push(roster("channel.upsert", { name: "secret", members: ["alex", ...(rnd() < 0.5 ? ["mia"] : []), ...(rnd() < 0.5 ? ["kira"] : [])] }));
    else if (r < 0.72) {
      const removed = rnd() < 0.5;
      out.push(roster("team.member", { login: k.login, handle: "kira", role: removed ? "removed" : "member" }));
      if (!removed) out.push(roster("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname, pubkey: k.keys.pubkey, ip: "127.0.0.1" }));
    } else if (r < 0.78) out.push(roster("team.member", { login: m.login, handle: "mia", role: rnd() < 0.5 ? "observer" : "member" }));
    else out.push(roster("channel.upsert", { name: "general", topic: `t${step}` }));
  }
  return out;
}

async function replica(team: string, events: readonly Event[], name: string): Promise<Core> {
  const core = makeCore(tnode(name), team, cleanups, { licenseVerifier: vendor.verify });
  feed(core, events);
  feed(core, events);
  core.drainPending();
  await settle(core);
  return core;
}

/**
 * The verdict, not the storage form: a valid event this replica can't see is kept in full or as a stub
 * depending on whether it was anchored when it arrived (PROTOCOL §3), so "ok" and "stub" both mean accepted.
 */
function verdictOf(core: Core, id: string): string {
  const s = statusOf(core, id);
  return s === "ok" || s === "stub" ? "accepted" : s === "junk" ? "rejected" : s;
}

function rosterShape(core: Core): unknown {
  const r = core.roster;
  // `removed_pos` is a chain index (the invite cut-off, DIRECT-FIX-2): license and integration entries are chain
  // entries too, so it differs between the two histories by construction, while every verdict stays the same.
  const members = [...r.members.entries()].map(([k, { removed_pos: _p, ...m }]) => [k, m]);
  return { members, nodes: [...r.nodes.entries()], channels: [...r.channels.entries()] };
}

/**
 * Everything the chain folds, chain indexes included: removal positions, the invite cut-offs, the chain length and
 * used invites. The same history must fold to exactly this in every arrival order (Opus r3 LOW 5).
 */
function chainShape(core: Core): unknown {
  const r = core.roster;
  return {
    members: [...r.members.entries()].sort(), nodes: [...r.nodes.entries()].sort(), channels: [...r.channels.entries()].sort(),
    voids: [...(r.voids ?? new Map()).entries()].sort(), pos: r.pos, invites: [...(r.invites ?? [])].sort(),
    removedPositions: [...r.members.values()].filter((m) => m.removed_pos !== undefined).length,
  };
}

describe("property: licenses change no validity semantics", () => {
  test("30 random histories x 3 arrival orders: every member event gets the same verdict, with and without licenses and integration entries", async () => {
    let licensed = 0, differentVerdicts = 0, compared = 0, withSlots = 0, removals = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const a = tnode("alex"), m = tnode("mia"), k = tnode("kira");
      const { team, create } = createTeam(a);
      const cast: Cast = { a, m, k, team, create };
      const plain = history(cast, seed, false);
      const withLic = history(cast, seed, true);
      const memberIds = plain.filter((e) => e.origin !== a.keys.nodeId).map((e) => e.id);
      // The members' events are identical in both histories (licenses only shift the authority's seqs).
      expect(withLic.filter((e) => e.origin !== a.keys.nodeId)).toEqual(plain.filter((e) => e.origin !== a.keys.nodeId));
      const ref = await replica(team, plain, `ref${seed}`);
      const want = memberIds.map((id) => verdictOf(ref, id));
      const wantRoster = rosterShape(ref);
      let wantChain: string | null = null;
      for (const order of [0, seed * 7 + 1, seed * 13 + 2]) {
        const core = await replica(team, order ? shuffle(withLic, order) : withLic, `r${seed}-${order}`);
        const got = memberIds.map((id) => verdictOf(core, id));
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          const i = got.findIndex((s, j) => s !== want[j]);
          throw new Error(`seed ${seed} order ${order}: ${memberIds[i]} is ${got[i]}, want ${want[i]}`);
        }
        expect(rosterShape(core)).toEqual(wantRoster);
        // The same (licensed) history in another arrival order: identical chain positions, removal indexes, cut-offs.
        const chain = JSON.stringify(chainShape(core));
        wantChain ??= chain;
        if (chain !== wantChain) throw new Error(`seed ${seed} order ${order}: chain fold differs from order 0: ${chain} vs ${wantChain}`);
        removals += (chainShape(core) as { removedPositions: number }).removedPositions;
        if (core.roster.license) licensed++;
        if (core.roster.integrations?.size) withSlots++;
        compared += got.length;
        while (cleanups.length > 1) cleanups.shift()?.();
      }
      // Sanity: the histories exercise both outcomes.
      differentVerdicts += new Set(want).size > 1 ? 1 : 0;
    }
    expect(licensed).toBeGreaterThan(30);
    expect(withSlots).toBeGreaterThan(30);
    expect(removals).toBeGreaterThan(0); // the arrival-order comparison covers removal positions and cut-offs
    expect(differentVerdicts).toBeGreaterThan(20);
    expect(compared).toBeGreaterThan(1000);
  }, 120_000);

  test("plan limits never affect validity: a Free-plan replica accepts an authority's 6th person and 9th machine and their posts", async () => {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    const people = Array.from({ length: 5 }, (_, i) => tnode(`p${i}`));
    const events: Event[] = [create, ev(team, a, "channel.upsert", { name: "general" }), ev(team, a, "channel.upsert", { name: "x", members: ["alex", "p0"] })];
    for (const p of people) events.push(memberEv(team, a, p, "member"), nodeEv(team, a, p));
    for (let i = 0; i < 3; i++) events.push(nodeEv(team, a, tnode("p0", people[0]!.login, `p0-${i}`)));
    for (const p of people) events.push(ev(team, p, "msg.post", { text: "hi" }, { channel: "general" }));
    const late = create.ts + TRIAL_MS + GRACE_MS + 10 * DAY_MS; // Free on this replica's clock
    const core = makeCore(tnode("obs"), team, cleanups, { clock: () => late });
    feed(core, events);
    await settle(core);
    expect(core.plan()?.plan).toBe("free");
    expect(events.every((e) => ["ok", "stub"].includes(statusOf(core, e.id)))).toBe(true);
    expect(core.plan()?.seats).toEqual({ used: 6, limit: 2 });
    expect(core.plan()?.machines).toEqual({ used: 9, limit: 4 });
  });
});

// ---- soft enforcement on the authority --------------------------------------------------------------

describe("soft enforcement at emit", () => {
  function authority(clockAt: (createTs: number) => number) {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    let t = clockAt(create.ts);
    const core = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify, clock: () => t });
    core.ingest(create, "local");
    core.emit("channel.upsert", { name: "general" });
    return { a, team, core, setClock: (v: number) => { t = v; }, created: create.ts };
  }
  const invite = (core: Core, n: TNode) => core.emit("team.member", { login: n.login, handle: n.handle, role: "member" });

  test("trial: adding is free; after it, Free limits apply with 402 plan_limit, and nothing is removed", () => {
    const { core, setClock, created } = authority((c) => c + DAY_MS);
    const ppl = [tnode("bea"), tnode("cal")];
    for (const p of ppl) invite(core, p);
    core.emit("channel.upsert", { name: "secret", members: ["alex", "bea"] });
    setClock(created + TRIAL_MS + 1);
    const err = thrown(() => invite(core, tnode("dan")));
    expect([err?.status, err?.code]).toEqual([402, "plan_limit"]);
    expect(err?.details).toMatchObject({ resource: "people", limit: 2, used: 3, plan: "free" });
    expect(thrown(() => core.emit("channel.upsert", { name: "ops", members: ["alex"] }))?.code).toBe("plan_limit");
    expect(thrown(() => core.emit("channel.upsert", { name: "general", members: ["alex"] }))?.code).toBe("plan_limit");
    // Existing people, the restricted channel and edits of it keep working.
    expect(core.roster.members.size).toBe(3);
    expect(core.emit("channel.upsert", { name: "secret", topic: "still restricted" }).kind).toBe("channel.upsert");
    expect(core.roster.channels.get("secret")?.members).toEqual(["alex", "bea"]);
    expect(core.emit("team.member", { login: ppl[0]!.login, handle: "bea", role: "owner" }).kind).toBe("team.member");
    expect(core.plan()).toMatchObject({ plan: "free", status: "free", seats: { used: 3, limit: 2 } });
  });

  test("activating a license lifts the limits; after its grace the team is Free again, still without losing anyone", () => {
    const { team, core, setClock, created } = authority((c) => c + TRIAL_MS + 1);
    invite(core, tnode("bea"));
    expect(thrown(() => invite(core, tnode("cal")))?.code).toBe("plan_limit");
    const t = created + TRIAL_MS + 1;
    const key = vendor.issue({ team, seats: 4, issued_at: t, expires_at: t + 35 * DAY_MS });
    expect(activateOnAuthority(core, key, t)?.kind).toBe("team.license");
    expect(activateOnAuthority(core, key, t)).toBeNull(); // same key again: no-op
    invite(core, tnode("cal"));
    invite(core, tnode("dan"));
    expect(thrown(() => invite(core, tnode("eve")))?.details).toMatchObject({ resource: "people", limit: 4, used: 4, plan: "team" });
    expect(core.emit("channel.upsert", { name: "ops", members: ["alex"] }).kind).toBe("channel.upsert");
    setClock(t + 35 * DAY_MS + GRACE_MS - 1);
    expect(core.plan()?.status).toBe("grace");
    setClock(t + 35 * DAY_MS + GRACE_MS + 1);
    expect(core.plan()?.status).toBe("free");
    expect(thrown(() => invite(core, tnode("eve")))?.code).toBe("plan_limit");
    expect([...core.roster.members.values()].filter((m) => m.role !== "removed").length).toBe(4);
    expect(core.roster.channels.get("ops")?.members).toEqual(["alex"]);
  });

  test("activation checks: forged key 400, lapsed past grace 400", () => {
    const { team, core, created } = authority((c) => c + DAY_MS);
    expect(thrown(() => checkActivatable(core, forger.issue()))?.code).toBe("invalid_license");
    const old = vendor.issue({ team, issued_at: created - 100 * DAY_MS, expires_at: created - 20 * DAY_MS });
    expect(thrown(() => checkActivatable(core, old, created))?.code).toBe("license_expired");
  });

  test("machine limit: admission refused on Free (direct, approval and owner request), revocation still works", () => {
    const { a, team, core, setClock, created } = authority((c) => c + DAY_MS);
    const b = tnode("bea", "bea@example.com");
    core.emit("team.member", { login: b.login, handle: "bea", role: "owner" });
    const machines = Array.from({ length: 4 }, (_, i) => tnode("bea", b.login, `bea-${i}`));
    for (const n of machines.slice(0, 3)) core.emit("team.node", nodeBody(n));
    setClock(created + TRIAL_MS + 1); // Free: 4 machines (alex's + 3 of bea's)
    expect(thrown(() => core.emit("team.node", nodeBody(machines[3]!)))?.details).toMatchObject({ resource: "machines", limit: 4, used: 4 });
    // A join held for approval stays held when approving it would exceed the limit.
    const j = machines[3]!;
    core.store.addJoinRequest({ node_id: j.keys.nodeId, login: b.login, pubkey: j.keys.pubkey, hostname: j.hostname, ip: "127.0.0.1", port: 7458, requested_at: core.clock() });
    expect(thrown(() => admitJoin(core, j.keys.nodeId, true))?.code).toBe("plan_limit");
    expect(core.store.joinRequest(j.keys.nodeId, core.clock())).not.toBeNull();
    // Another owner's roster request hits the same limit.
    const req = signRequest({ nodeId: machines[0]!.keys.nodeId, teamId: team, keys: machines[0]!.keys } as unknown as Core, "team.node",
      { ...nodeBody(machines[0]!), revoked: true });
    expect(applyRequest(core, req)?.kind).toBe("team.node"); // revoking is never limited
    expect(admitJoin(core, j.keys.nodeId, true)?.kind).toBe("team.node"); // the revocation freed a slot
    void a;
  });

  test("review: remove + re-invite can't reactivate machines past the limit (removal revokes them)", () => {
    const { core, setClock, created } = authority((c) => c + DAY_MS);
    const b = tnode("bea");
    core.emit("team.member", { login: b.login, handle: "bea", role: "member" });
    const bMachines = [b, tnode("bea", b.login, "bea-2")];
    for (const n of bMachines) core.emit("team.node", nodeBody(n));
    setClock(created + TRIAL_MS + 1); // Free: 4 machines, 2 people
    core.emit("team.member", { login: b.login, handle: "bea", role: "removed" });
    expect(core.plan()?.machines.used).toBe(1);
    const aMore = [tnode("alex", "alex@example.com", "alex-2"), tnode("alex", "alex@example.com", "alex-3"), tnode("alex", "alex@example.com", "alex-4")];
    for (const n of aMore) core.emit("team.node", nodeBody(n));
    expect(core.plan()?.machines.used).toBe(4);
    core.emit("team.member", { login: b.login, handle: "bea", role: "member" }); // re-invite: 2 people, allowed
    expect(core.plan()?.machines.used).toBe(4); // bea's machines stay revoked
    expect(thrown(() => core.emit("team.node", nodeBody(bMachines[0]!)))?.code).toBe("plan_limit");
  });

  test("an owner's queued request over the people limit is refused with plan_limit", () => {
    const { team, core, setClock, created } = authority((c) => c + DAY_MS);
    const b = tnode("bea");
    core.emit("team.member", { login: b.login, handle: "bea", role: "owner" });
    core.emit("team.node", nodeBody(b));
    setClock(created + TRIAL_MS + 1);
    const req = signRequest({ nodeId: b.keys.nodeId, teamId: team, keys: b.keys } as unknown as Core, "team.member",
      { login: "cal@example.com", handle: "cal", role: "member" });
    const err = thrown(() => applyRequest(core, req));
    expect([err?.status, err?.code]).toEqual([402, "plan_limit"]);
  });
});

function nodeBody(n: TNode): { node_id: string; login: string; hostname: string; pubkey: string; ip: string } {
  return { node_id: n.keys.nodeId, login: n.login, hostname: n.hostname, pubkey: n.keys.pubkey, ip: "127.0.0.1" };
}
