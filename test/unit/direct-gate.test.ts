// The Walkie Direct peer gate (PROTOCOL §4): the QUIC-authenticated key must be an admitted, non-revoked node of
// a current member; /join takes an owner-signed, single-use invite and admits the connection's own key.
import { afterEach, describe, expect, test } from "bun:test";
import { createInvite } from "../../src/daemon/invite.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";

import { makeCore } from "../helpers/core.ts";
import { now, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const directBody = (who: TNode, extra: { revoked?: boolean } = {}) => ({
  node_id: who.keys.nodeId, login: who.login, hostname: who.hostname, pubkey: who.keys.pubkey, ip: "",
  endpoint: Buffer.from(who.keys.pubkey, "base64").toString("hex"), transports: ["direct"], ...extra,
});

/** alex's daemon (the roster authority of a Direct team) with members kira and sam, one machine each. */
function world() {
  const alex = tnode("alex", "direct:alex");
  const kira = tnode("kira", "direct:kira");
  const sam = tnode("sam", "direct:sam");
  const core = makeCore(alex, "0000000000000000", cleanups);
  core.store.deleteMeta("team");
  core.createTeam("acme", "alex", { login: alex.login });
  core.emit("team.node", directBody(alex));
  for (const who of [kira, sam]) {
    core.emit("team.member", { login: who.login, handle: who.handle, role: "member" });
    core.emit("team.node", directBody(who));
  }
  return { alex, kira, sam, team: core.teamId as string, core, api: new PeerApi(core) };
}

function call(api: PeerApi, who: TNode | string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}, team?: string) {
  const pubkey = typeof who === "string" ? who : who.keys.pubkey;
  const headers: Record<string, string> = { ...(team ? { "X-Walkie-Team": team } : {}), ...init.headers };
  const req = new Request(`http://walkie.direct${path}`, {
    method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return api.handle(req, { kind: "direct", pubkey });
}

async function code(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

describe("Direct peer gate", () => {
  test("an admitted node's key passes; the answer is the served data", async () => {
    const w = world();
    const res = await call(w.api, w.kira, "/peer/v1/vv", {}, w.team);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { node: string }).node).toBe(w.alex.keys.nodeId);
  });

  test("an outsider key is refused everywhere (403 not_member)", async () => {
    const w = world();
    const mallory = tnode("mallory");
    for (const path of ["/peer/v1/vv", "/peer/v1/hello", `/peer/v1/events?origin=${w.alex.keys.nodeId}&after=0`]) {
      const res = await call(w.api, mallory, path, {}, w.team);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("not_member");
    }
    const push = await call(w.api, mallory, "/peer/v1/events", { method: "POST", body: { events: [] } }, w.team);
    expect(push.status).toBe(403);
  });

  test("a revoked node and a removed member's node are refused", async () => {
    const w = world();
    w.core.emit("team.node", directBody(w.kira, { revoked: true }));
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    for (const who of [w.kira, w.sam]) {
      const res = await call(w.api, who, "/peer/v1/vv", {}, w.team);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("not_member");
    }
  });

  test("X-Walkie-Node can't claim another node; the team header must match", async () => {
    const w = world();
    const spoof = await call(w.api, w.kira, "/peer/v1/vv", { headers: { "X-Walkie-Node": w.sam.keys.nodeId } }, w.team);
    expect(spoof.status).toBe(403);
    const other = await call(w.api, w.kira, "/peer/v1/vv", {}, "0123456789abcdef");
    expect(other.status).toBe(409);
  });

  test("rate limits are per endpoint, and strangers share one small bucket", async () => {
    const w = world();
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const res = await call(w.api, tnode(`x${i}`), "/peer/v1/vv", {}, w.team);
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    // A member is unaffected by strangers' traffic.
    expect((await call(w.api, w.kira, "/peer/v1/vv", {}, w.team)).status).toBe(200);
  });

  test("unadmitted Direct keys cannot evict an exhausted bucket on the main limiter", async () => {
    const w = world();
    const sentinel = "security:sentinel";
    const spec = { capacity: 10, perSecond: 0 };
    const clock = now();
    for (let i = 0; i < 10; i++) expect(w.core.limiter.take(sentinel, spec, clock)).toBe(true);
    expect(w.core.limiter.take(sentinel, spec, clock)).toBe(false);
    // Fill the main limiter until the sentinel is its oldest key. One more main-limiter insert would drop it.
    for (let i = 0; i < 511; i++) expect(w.core.limiter.take(`filler:${i}`, w.core.limits.peer, clock)).toBe(true);
    for (let i = 0; i < 30; i++) await call(w.api, tnode(`stranger${i}`), "/peer/v1/vv", {}, w.team);
    expect(w.core.limiter.take(sentinel, spec, clock)).toBe(false);
  });

  test("two PeerApi instances share the unadmitted bucket, and an admitted node still draws on the main limiter", async () => {
    const w = world();
    const other = new PeerApi(w.core);
    let limited = 0;
    for (let i = 0; i < 30; i++) {
      const api = i % 2 === 0 ? w.api : other;
      const res = await call(api, tnode(`share${i}`), "/peer/v1/vv", {}, w.team);
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    const key = `peer:direct:${w.kira.keys.nodeId}`;
    while (w.core.limiter.take(key, w.core.limits.peer)) { /* drain this node's own bucket */ }
    expect((await call(w.api, w.kira, "/peer/v1/vv", {}, w.team)).status).toBe(429);
  });

  test("the Tailscale path is unchanged: without a whois login, 403", async () => {
    const w = world();
    const res = await w.api.handle(new Request("http://127.0.0.1:7458/peer/v1/vv"), "127.0.0.1");
    expect(res.status).toBe(403);
  });
});

describe("Direct /join", () => {
  const join = (w: ReturnType<typeof world>, who: TNode, invite?: string, pubkey = who.keys.pubkey) =>
    call(w.api, who, "/peer/v1/join", { method: "POST", body: { pubkey, hostname: who.hostname, ip: "", ...(invite ? { invite } : {}) } });

  test("a valid invite admits the connection's key once, recording the invite on the chain", async () => {
    const w = world();
    const riley = tnode("riley");
    const inv = createInvite(w.alex.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "riley", role: "observer", now: now(), pos: w.core.roster.pos ?? 0 });
    const res = await join(w, riley, inv.code);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ admitted: true, team: w.team, node_id: riley.keys.nodeId });
    const r = w.core.roster;
    expect(r.members.get("direct:riley")?.role).toBe("observer");
    expect(r.nodes.get(riley.keys.nodeId)).toMatchObject({ login: "direct:riley", transports: ["direct"], revoked: false });
    expect(r.invites?.has(inv.id)).toBe(true);
    // Idempotent for the same key; refused for another.
    expect((await join(w, riley, inv.code)).status).toBe(200);
    const eve = tnode("eve");
    const again = await join(w, eve, inv.code);
    expect(again.status).toBe(403);
    expect(await code(again)).toBe("invite_used");
  });

  test("no invite, or an invite for someone else's key → refused, nothing emitted", async () => {
    const w = world();
    const riley = tnode("riley");
    const chain = w.core.chainLength;
    const none = await join(w, riley);
    expect(none.status).toBe(403);
    expect(await code(none)).toBe("not_member");
    const inv = createInvite(w.alex.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "riley", role: "member", now: now(), pos: w.core.roster.pos ?? 0 });
    const wrongKey = await join(w, riley, inv.code, w.kira.keys.pubkey);
    expect(wrongKey.status).toBe(403);
    expect(await code(wrongKey)).toBe("forbidden");
    expect(w.core.chainLength).toBe(chain);
  });

  test("an invite minted by a member (not an owner) is refused", async () => {
    const w = world();
    const inv = createInvite(w.kira.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "eve", role: "owner", now: now(), pos: w.core.roster.pos ?? 0 });
    const res = await join(w, tnode("eve"), inv.code);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("invite_issuer_not_owner");
  });

  test("an invite for a current member adds a machine under their login and role", async () => {
    const w = world();
    const kira2 = tnode("kira", "direct:kira", "kiras-studio");
    const inv = createInvite(w.alex.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "kira", role: "owner", now: now(), pos: w.core.roster.pos ?? 0 });
    expect((await join(w, kira2, inv.code)).status).toBe(200);
    expect(w.core.roster.nodes.get(kira2.keys.nodeId)?.login).toBe("direct:kira");
    expect(w.core.roster.members.get("direct:kira")?.role).toBe("member");
  });

  // DIRECT-FIX-1 (Opus HIGH 1): a code minted before the member's removal can't bring them back, with any key.
  test("a removed owner can't rejoin with an owner code minted before the removal (new machine key)", async () => {
    const w = world();
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "owner" });
    const old = createInvite(w.alex.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "sam", role: "owner", now: now(), pos: w.core.roster.pos ?? 0 });
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    const chain = w.core.chainLength;
    const sam2 = tnode("sam", "direct:sam", "sams-new-laptop");
    const res = await join(w, sam2, old.code);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("invite_predates_removal");
    expect(w.core.roster.members.get("direct:sam")?.role).toBe("removed");
    expect(w.core.roster.nodes.get(sam2.keys.nodeId)).toBeUndefined();
    expect(w.core.chainLength).toBe(chain);
  });

  test("a removed member's old (revoked-by-removal) machine can't come back with a pre-removal code", async () => {
    const w = world();
    const old = createInvite(w.alex.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "sam", role: "member", now: now(), pos: w.core.roster.pos ?? 0 });
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    expect(w.core.roster.nodes.get(w.sam.keys.nodeId)).toMatchObject({ revoked: true, revoked_by_removal: true });
    const res = await join(w, w.sam, old.code);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("invite_predates_removal");
    expect(w.core.roster.nodes.get(w.sam.keys.nodeId)?.revoked).toBe(true);
    expect(w.core.roster.members.get("direct:sam")?.role).toBe("removed");
  });

  test("a code minted after the removal re-invites the member with that code's role (even within the same second)", async () => {
    const w = world();
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    expect(w.core.roster.members.get("direct:sam")?.removed_pos).toBeNumber();
    const fresh = createInvite(w.alex.keys, {
      team: w.team, authority: w.alex.keys.pubkey, handle: "sam", role: "observer", now: now(), pos: w.core.roster.pos ?? 0,
    });
    const res = await join(w, w.sam, fresh.code);
    expect(res.status).toBe(200);
    expect(w.core.roster.members.get("direct:sam")?.role).toBe("observer");
    expect(w.core.roster.nodes.get(w.sam.keys.nodeId)?.revoked).toBe(false);
  });

  test("an explicitly revoked key can't come back with a fresh invite", async () => {
    const w = world();
    w.core.emit("team.node", directBody(w.kira, { revoked: true }));
    const inv = createInvite(w.alex.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "kira", role: "member", now: now(), pos: w.core.roster.pos ?? 0 });
    const res = await join(w, w.kira, inv.code);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("forbidden");
  });
});

describe("Direct invite preview", () => {
  test("only a current owner-signed invite reveals the authority's team and inviter", async () => {
    const w = world();
    const stranger = tnode("stranger");
    const invite = createInvite(w.alex.keys, { team: w.team, authority: w.alex.keys.pubkey,
      handle: "riley", role: "member", now: now(), pos: w.core.roster.pos ?? 0 });
    const good = await call(w.api, stranger, "/peer/v1/invite-preview", { method: "POST", body: { code: invite.code } });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ team_id: w.team, team_name: "acme", inviter_handle: "alex", spent: false });
    const joined = await call(w.api, stranger, "/peer/v1/join", { method: "POST",
      body: { pubkey: stranger.keys.pubkey, hostname: stranger.hostname, ip: "", invite: invite.code } });
    expect(joined.status).toBe(200);
    const spent = await call(w.api, stranger, "/peer/v1/invite-preview", { method: "POST", body: { code: invite.code } });
    expect(await spent.json()).toMatchObject({ team_id: w.team, spent: true });
    const forged = createInvite(stranger.keys, { team: w.team, authority: w.alex.keys.pubkey,
      handle: "riley", role: "member", now: now(), pos: w.core.roster.pos ?? 0 });
    const bad = await call(w.api, stranger, "/peer/v1/invite-preview", { method: "POST", body: { code: forged.code } });
    expect(bad.status).toBe(403);
    expect(await code(bad)).toBe("invite_issuer_not_owner");
  });
});
