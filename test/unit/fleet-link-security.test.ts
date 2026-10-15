import { afterEach, expect, test } from "bun:test";
import { encodeFleetLink, newLinkSecret } from "../../src/daemon/fleet-link.ts";
import { admitLinkJoin, registerLink } from "../../src/daemon/fleet-link-service.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { RateLimiter, MAX_BUCKETS } from "../../src/daemon/ratelimit.ts";
import { LINK_ATTEMPTS } from "../../src/daemon/fleet-link-service.ts";
import { makeCore } from "../helpers/core.ts";
import { tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function world() {
  const alex = tnode("alex", "direct:alex");
  const sam = tnode("sam", "direct:sam");
  const core = makeCore(alex, "0000000000000000", cleanups);
  core.store.deleteMeta("team");
  core.createTeam("acme", "alex", { login: alex.login });
  core.emit("team.node", {
    node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey,
    ip: "", endpoint: Buffer.from(alex.keys.pubkey, "base64").toString("hex"), transports: ["direct"],
  });
  core.emit("team.member", { login: sam.login, handle: "sam", role: "member" });
  core.emit("team.node", {
    node_id: sam.keys.nodeId, login: sam.login, hostname: sam.hostname, pubkey: sam.keys.pubkey,
    ip: "", endpoint: Buffer.from(sam.keys.pubkey, "base64").toString("hex"), transports: ["direct"],
  });
  const mint = async (handle = "alex", owner_machines = true, approve = false) => {
    const { secret, id } = newLinkSecret();
    const fields = { handle, uses: 5, expires_at: Math.floor((core.clock() + 86_400_000) / 1000) * 1000, approve };
    const made = await registerLink(core, { id, ...fields, owner_machines }, alex.keys.nodeId);
    return { ...made.link, token: encodeFleetLink(alex.keys, secret, { ...fields, team: core.teamId!, authority: alex.keys.pubkey }) };
  };
  const api = new PeerApi(core);
  const join = async (who: TNode, link?: string) => {
    const res = await api.handle(new Request("http://walkie.direct/peer/v1/join", {
      method: "POST", body: JSON.stringify({ pubkey: who.keys.pubkey, hostname: who.hostname, ip: "", ...(link ? { link } : {}) }),
    }), { kind: "direct", pubkey: who.keys.pubkey });
    const body = await res.json() as { admitted?: boolean; reason?: string; error?: { code: string } };
    return { status: res.status, code: body.error?.code, admitted: body.admitted, reason: body.reason };
  };
  return { core, alex, sam, mint, join };
}

test("the authority requires explicit owner-level confirmation, even with approval on", async () => {
  const w = world();
  for (const approve of [false, true]) await expect(w.mint("alex", false, approve)).rejects.toMatchObject({ status: 409, code: "owner_target" });
  expect((await w.mint()).role).toBe("owner");
  expect((await w.mint("sam", false)).role).toBe("member");
});

test("a removed redeemer cannot use an owner link from before their removal, including after re-invite", async () => {
  const w = world();
  const link = await w.mint();
  w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
  expect(await w.join(w.sam, link.token)).toMatchObject({ status: 403, code: "link_predates_removal" });
  w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "member" });
  expect(await w.join(w.sam, link.token)).toMatchObject({ status: 403, code: "link_predates_removal" });
  expect(w.core.roster.nodes.get(w.sam.keys.nodeId)?.revoked).toBe(true);
  // A genuinely new invitation for that member can still re-admit the machine.
  expect(await w.join(w.sam, (await w.mint("sam")).token)).toMatchObject({ status: 200, admitted: true });
});

test("changing a target's role refuses redemption and approval of an already waiting machine", async () => {
  const w = world();
  const link = await w.mint("sam", false, true);
  const waiting = tnode("waiting");
  expect(await w.join(waiting, link.token)).toMatchObject({ status: 200, reason: "pending_approval" });
  w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "owner" });
  expect(await w.join(tnode("fresh"), link.token)).toMatchObject({ status: 403, code: "link_role_changed" });
  const { admitLinkJoin } = await import("../../src/daemon/fleet-link-service.ts");
  expect(() => admitLinkJoin(w.core, w.core.store.joinRequest(waiting.keys.nodeId, w.core.clock())!, true)).toThrow("role changed");
});

test("the fourth fleet-link attempt by the same key is limited, and a different key has its own bucket", async () => {
  const w = world();
  const link = await w.mint("sam");
  w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "owner" });
  const who = tnode("retry");
  for (let i = 0; i < 3; i++) expect(await w.join(who, link.token)).toMatchObject({ status: 403, code: "link_role_changed" });
  expect(await w.join(who, link.token)).toMatchObject({ status: 429, code: "rate_limited" });
  expect(await w.join(tnode("other"), link.token)).toMatchObject({ status: 403, code: "link_role_changed" });
});

test("the per-key bucket refills after 20 seconds and is bounded in memory (LRU eviction resets it)", () => {
  const limiter = new RateLimiter();
  for (let i = 0; i < 3; i++) expect(limiter.take("joining-key", LINK_ATTEMPTS, 0)).toBe(true);
  expect(limiter.take("joining-key", LINK_ATTEMPTS, 19_999)).toBe(false);
  expect(limiter.take("joining-key", LINK_ATTEMPTS, 20_000)).toBe(true);
  expect(limiter.take("joining-key", LINK_ATTEMPTS, 20_000)).toBe(false);
  for (let i = 0; i < MAX_BUCKETS; i++) limiter.take(`other-${i}`, LINK_ATTEMPTS, 20_000);
  expect(limiter.take("joining-key", LINK_ATTEMPTS, 20_000)).toBe(true);
});

test("key-only approval polling reports a pending machine and then tells it that it was declined", async () => {
  const w = world();
  const link = await w.mint("sam", false, true);
  const who = tnode("waiting");
  expect(await w.join(who, link.token)).toMatchObject({ reason: "pending_approval" });
  expect(await w.join(who)).toMatchObject({ status: 200, reason: "pending_approval" });
  const { admitLinkJoin } = await import("../../src/daemon/fleet-link-service.ts");
  admitLinkJoin(w.core, w.core.store.joinRequest(who.keys.nodeId, w.core.clock())!, false);
  expect(await w.join(who)).toMatchObject({ status: 403, code: "link_declined" });
});


test("a pending fleet machine gets a terminal refusal when its link expires", async () => {
  const w = world();
  const link = await w.mint("sam", false, true);
  const who = tnode("expired-waiter");
  expect(await w.join(who, link.token)).toMatchObject({ reason: "pending_approval" });
  w.core.store.db.query("UPDATE fleet_links SET expires_at = ? WHERE id = ?").run(w.core.clock(), link.id);
  expect(await w.join(who)).toMatchObject({ status: 403, code: "link_expired" });
});

test("approval cannot admit a machine after the fleet link expires", async () => {
  const w = world();
  const link = await w.mint("sam", false, true);
  const who = tnode("expired-approval");
  expect(await w.join(who, link.token)).toMatchObject({ reason: "pending_approval" });
  const j = w.core.store.joinRequest(who.keys.nodeId, w.core.clock())!;
  w.core.store.db.query("UPDATE fleet_links SET expires_at = ? WHERE id = ?").run(w.core.clock(), link.id);
  expect(() => admitLinkJoin(w.core, j, true)).toThrow("expired");
  expect(w.core.roster.nodes.has(who.keys.nodeId)).toBe(false);
  expect(w.core.store.links.counted(link.id, w.core.clock()).used).toBe(0);
});
