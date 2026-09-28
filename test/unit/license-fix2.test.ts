// LICENSE-FIX-2 (Fable audit notes, scratchpad/fable-lic-int-notes.md): the plan clock is floored by
// every event ts this node stored (F2, scenario S2c), and the integration count is decided at the
// authority through the `team.integration` chain kind (F3).
import { afterEach, describe, expect, test } from "bun:test";
import { buildChain } from "../../src/daemon/chain.ts";
import { FUTURE_SKEW_MS, PLAN_FLOOR_META, type Core } from "../../src/daemon/core.ts";
import { HttpError } from "../../src/daemon/http.ts";
import { applyRequest, signRequest } from "../../src/daemon/requests.ts";
import { integrationsUsed } from "../../src/daemon/roster.ts";
import { DAY_MS, TRIAL_MS } from "../../src/license/plans.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, reopen, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, now, tnode, type TNode } from "../helpers/events.ts";
import { testVendor } from "../helpers/license.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const vendor = testVendor();

function thrown(fn: () => unknown): HttpError | undefined {
  try { fn(); } catch (err) { if (err instanceof HttpError) return err; throw err; }
  return undefined;
}

function nodeBody(n: TNode): { node_id: string; login: string; hostname: string; pubkey: string; ip: string } {
  return { node_id: n.keys.nodeId, login: n.login, hostname: n.hostname, pubkey: n.keys.pubkey, ip: "127.0.0.1" };
}

// ---- F2: the plan clock is floored by the chain this node holds (FINAL Fable 1: by the chain ONLY) ------

describe("F2: the plan floor follows the roster chain, clamped to the clock + 5 min", () => {
  test("S2c: authority transferred to a machine with a rolled-back clock and an empty store revives the trial by at most 5 min; a day behind, it can't act at all", () => {
    let ta = 0;
    const a = tnode("alex"), b = tnode("bea"), cc = tnode("cee");
    const { team, create } = createTeam(a);
    const A = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify, clock: () => ta });
    ta = create.ts + 1;
    A.ingest(create, "local");
    for (const n of [b, cc]) {
      A.emit("team.member", { login: n.login, handle: n.handle, role: "owner" });
      A.emit("team.node", nodeBody(n));
    }
    ta = create.ts + TRIAL_MS + 60 * 60_000; // the trial is over on A (by an hour)
    A.emit("channel.upsert", { name: "general" }); // an emit after the trial: its ts is real wall-clock time
    expect(A.plan()?.status).toBe("free");
    A.emit("team.authority", { node_id: b.keys.nodeId });
    const rows = A.store.rosterRows(a.keys.nodeId, 0, 1_000);
    const chainMaxTs = Math.max(...rows.map((e) => e.ts));
    // B: a fresh store and a clock 2 h behind the chain, an hour before the trial's end by its own clock.
    const tb = create.ts + TRIAL_MS - 60 * 60_000;
    const B = makeCore(b, team, cleanups, { licenseVerifier: vendor.verify, clock: () => tb });
    feed(B, rows);
    expect(B.isAuthority()).toBe(true);
    expect(Number(B.store.getMeta(PLAN_FLOOR_META))).toBe(tb + FUTURE_SKEW_MS); // the chain, clamped
    expect(B.planNow()).toBe(tb + FUTURE_SKEW_MS);
    expect(B.planNow()).toBeLessThan(chainMaxTs);
    expect(B.plan()?.status).toBe("trial"); // bounded revival: 55 min of it, never 14 days
    // C: more than a day behind. The authority's chain is applied whatever its ts (FINAL-2 Fable 3: holding it
    // pinned every member for as long as a corrected clock's hold lasted); the floor is still the clamp, so
    // the trade is the trial's revival on a machine an owner deliberately set back (SECURITY.md).
    const C = makeCore(cc, team, cleanups, { licenseVerifier: vendor.verify, clock: () => create.ts + DAY_MS });
    feed(C, rows);
    expect(C.chainLength).toBe(A.chainLength); // applied, not held
    expect(C.authority).toBe(b.keys.nodeId);
    expect(C.store.pendingCount()).toBe(0);
    expect(C.planNow()).toBe(create.ts + DAY_MS + FUTURE_SKEW_MS);
  });

  test("INVERTED (FINAL Fable 1): no origin's accepted event floors the clock; only the chain does, and the floor survives a restart", () => {
    const a = tnode("alex"), m = tnode("mia"), obs = tnode("obs");
    const { team, create } = createTeam(a);
    const core = makeCore(obs, team, cleanups, { clock: () => now() });
    const future = now() + 40 * DAY_MS;
    feed(core, [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), ev(team, a, "channel.upsert", { name: "general" }),
      ev(team, m, "msg.post", { text: "an hour ahead" }, { channel: "general", ts: now() + 60 * 60_000 })]);
    expect(core.planNow()).toBe(now()); // accepted, moved nothing
    const held = ev(team, m, "msg.post", { text: "from the future" }, { channel: "general", ts: future });
    expect(core.ingest(held, "remote")).toEqual({ status: "pending", reason: "future_ts" });
    expect(core.planNow()).toBe(now());
    expect(core.store.getMeta(PLAN_FLOOR_META)).toBe(String(now())); // the chain's latest entry (the channel, ticked last)
    feed(core, [ev(team, a, "channel.upsert", { name: "ops" }, { ts: now() + 60_000 })]);
    expect(core.planNow()).toBe(now() + 60_000);
    expect(reopen(core, obs).planNow()).toBe(now() + 60_000);
  });
});

// ---- F3: team.integration on the chain ------------------------------------------------------------

const lic = (team: string, by: TNode, key: string, extra: Record<string, unknown> = {}): Event =>
  ev(team, by, "team.license", { key, ...extra } as never);

describe("F3: team.integration is an authority-only chain kind", () => {
  test("applied from the authority's chain; a non-authority owner's entry is not_authority; an unknown node is rejected", () => {
    const a = tnode("alex"), b = tnode("bea"), m = tnode("mia"), x = tnode("xul");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, b, "owner"), nodeEv(team, a, b), memberEv(team, a, m, "member"), nodeEv(team, a, m)];
    const onB = ev(team, a, "team.integration", { connector: "linear", node: b.keys.nodeId, enabled: true });
    const onM = ev(team, a, "team.integration", { connector: "fireflies", node: m.keys.nodeId, enabled: true });
    const byB = ev(team, b, "team.integration", { connector: "wispr", node: b.keys.nodeId, enabled: true });
    const unknown = ev(team, a, "team.integration", { connector: "wispr", node: x.keys.nodeId, enabled: true });
    const core = makeCore(tnode("obs"), team, cleanups);
    feed(core, [...setup, onB, onM, byB, unknown]);
    expect([...(core.roster.integrations?.get("linear") ?? [])]).toEqual([b.keys.nodeId]);
    expect([...(core.roster.integrations?.get("fireflies") ?? [])]).toEqual([m.keys.nodeId]);
    expect(core.roster.integrations?.has("wispr")).toBe(false);
    expect(core.store.getRow(byB.id)?.reason).toBe("not_authority");
    expect([statusOf(core, unknown.id), core.store.getRow(unknown.id)?.reason]).toEqual(["rejected", "bad_integration_target"]);
    expect(integrationsUsed(core.roster)).toBe(2);
    // Disabling releases; a revoked node's entries don't count; a removed member's don't either.
    feed(core, [ev(team, a, "team.integration", { connector: "linear", node: b.keys.nodeId, enabled: false })]);
    expect(core.roster.integrations?.has("linear")).toBe(false);
    expect(integrationsUsed(core.roster)).toBe(1);
    feed(core, [memberEv(team, a, m, "removed")]);
    expect(integrationsUsed(core.roster)).toBe(0);
  });

  test("an entry never anchors anything: its watermark counts for nothing", () => {
    const a = tnode("alex"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const events = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m),
      ev(team, a, "team.integration", { connector: "wispr", node: m.keys.nodeId, enabled: true, wm: { [m.keys.nodeId]: 50 } } as never)];
    const chain = buildChain(events, team, { verifyLicense: vendor.verify });
    expect(chain.length).toBe(4);
    expect(chain.maxWm(m.keys.nodeId)).toBe(0);
    expect(chain.anchor(m.keys.nodeId, 1)).toBeNull();
  });

  test("the authority refuses a 2nd connector team-wide on Free (402 plan_limit); the same connector elsewhere, and disabling, are free", () => {
    let t = 0;
    const a = tnode("alex"), b = tnode("bea");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify, clock: () => t });
    t = create.ts + 1;
    core.ingest(create, "local");
    core.emit("team.member", { login: b.login, handle: b.handle, role: "member" });
    core.emit("team.node", nodeBody(b));
    core.emit("team.integration", { connector: "linear", node: b.keys.nodeId, enabled: true });
    t = create.ts + TRIAL_MS + DAY_MS; // Free: 1 integration
    const err = thrown(() => core.emit("team.integration", { connector: "fireflies", node: a.keys.nodeId, enabled: true }));
    expect([err?.status, err?.code]).toEqual([402, "plan_limit"]);
    expect(err?.details).toMatchObject({ resource: "integrations", limit: 1, used: 1, plan: "free" });
    expect(core.roster.integrations?.has("fireflies")).toBe(false);
    expect(core.emit("team.integration", { connector: "linear", node: a.keys.nodeId, enabled: true }).kind).toBe("team.integration");
    expect(core.emit("team.integration", { connector: "linear", node: b.keys.nodeId, enabled: false }).kind).toBe("team.integration");
    expect(thrown(() => core.emit("team.integration", { connector: "fireflies", node: a.keys.nodeId, enabled: true }))?.code).toBe("plan_limit");
    core.emit("team.integration", { connector: "linear", node: a.keys.nodeId, enabled: false }); // the slot is released
    expect(core.emit("team.integration", { connector: "fireflies", node: a.keys.nodeId, enabled: true }).kind).toBe("team.integration");
    expect(integrationsUsed(core.roster)).toBe(1);
  });

  test("a member requests it for its OWN node only (owners too); an observer can't", () => {
    const a = tnode("alex"), b = tnode("bea"), m = tnode("mia"), o = tnode("obs");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify });
    core.ingest(create, "local");
    for (const [who, role] of [[b, "owner"], [m, "member"], [o, "observer"]] as const) {
      core.emit("team.member", { login: who.login, handle: who.handle, role });
      core.emit("team.node", nodeBody(who));
    }
    const req = (n: TNode, node: string, enabled = true) =>
      signRequest({ nodeId: n.keys.nodeId, teamId: team, keys: n.keys } as unknown as Core, "team.integration", { connector: "wispr", node, enabled });
    expect(applyRequest(core, req(m, m.keys.nodeId))?.kind).toBe("team.integration");
    expect(thrown(() => applyRequest(core, req(m, b.keys.nodeId)))?.message).toContain("not_own_node");
    expect(thrown(() => applyRequest(core, req(b, m.keys.nodeId, false)))?.message).toContain("not_own_node");
    expect(thrown(() => applyRequest(core, req(o, o.keys.nodeId)))?.status).toBe(403);
    expect([...(core.roster.integrations?.get("wispr") ?? [])]).toEqual([m.keys.nodeId]);
    // Idempotent: the same signed request again returns the applied entry.
    const r = req(b, b.keys.nodeId);
    expect(applyRequest(core, r)?.id).toBe(applyRequest(core, r)?.id);
  });

  test("interleaving team.integration and team.license entries changes no other verdict", () => {
    const a = tnode("alex"), m = tnode("mia");
    const { team, create } = createTeam(a);
    const plain = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), ev(team, a, "channel.upsert", { name: "general" })];
    const posts = [ev(team, m, "msg.post", { text: "one" }, { channel: "general" }), ev(team, m, "msg.post", { text: "two" }, { channel: "general" })];
    const withEntries = [...plain.slice(0, 2), ev(team, a, "team.integration", { connector: "linear", node: m.keys.nodeId, enabled: true, wm: { [m.keys.nodeId]: 99 } } as never),
      ...plain.slice(2), lic(team, a, vendor.issue({ team })), ev(team, a, "team.integration", { connector: "linear", node: m.keys.nodeId, enabled: false })];
    const ref = makeCore(tnode("r"), team, cleanups, { licenseVerifier: vendor.verify });
    feed(ref, [...plain, ...posts]);
    const got = makeCore(tnode("g"), team, cleanups, { licenseVerifier: vendor.verify });
    feed(got, [...withEntries, ...posts]);
    expect(posts.map((p) => statusOf(got, p.id))).toEqual(posts.map((p) => statusOf(ref, p.id)));
    expect(got.roster.integrations?.has("linear")).toBe(false);
  });
});
