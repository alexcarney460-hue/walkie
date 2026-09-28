import { describe, expect, test } from "bun:test";
import { buildChain } from "../../src/daemon/chain.ts";
import { EMPTY_ROSTER, requestAllowed, validate, type AskRef, type Roster } from "../../src/daemon/roster.ts";
import { signEvent } from "../../src/daemon/keys.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { createTeam, ev, memberEv, nodeEv, tnode } from "../helpers/events.ts";

const fold = (events: Event[], team: string) => buildChain(events, team);

function world() {
  const alex = tnode("alex");
  const kira = tnode("kira");
  const obs = tnode("olly");
  const { team, create } = createTeam(alex);
  const log: Event[] = [
    create,
    memberEv(team, alex, kira, "member"),
    nodeEv(team, alex, kira),
    memberEv(team, alex, obs, "observer"),
    nodeEv(team, alex, obs),
    ev(team, alex, "channel.upsert", { name: "general" }),
    ev(team, alex, "channel.upsert", { name: "secret", members: ["alex"] }),
  ];
  const roster = fold(log, team).roster;
  return { alex, kira, obs, team, log, roster };
}

const status = (e: Event, r: Roster, team: string, askLookup?: (id: string) => AskRef) =>
  validate(e, r, { teamId: team, askLookup });

describe("team.create", () => {
  test("founds the team: owner member + founder node", () => {
    const { roster, alex, team } = world();
    expect(roster.team?.id).toBe(team);
    expect(roster.members.get(alex.login)?.role).toBe("owner");
    expect(roster.nodes.get(alex.keys.nodeId)?.login).toBe(alex.login);
  });

  test("rejects a team id not bound to the founder key", () => {
    const alex = tnode("alex");
    const { create } = createTeam(alex);
    const forged = signEvent(alex.keys, { ...stripSig(create), team: "0123456789abcdef" });
    expect(status(forged, EMPTY_ROSTER, "0123456789abcdef")).toEqual({ status: "reject", reason: "team_id_mismatch" });
  });

  test("rejects tampering and a second team.create", () => {
    const { roster, team, kira, log } = world();
    const tampered = { ...(log[0] as Event), body: { ...(log[0] as Event).body, name: "evil" } };
    expect(status(tampered, EMPTY_ROSTER, team).status).toBe("reject");
    const second = ev(team, kira, "team.create", { name: "x", owner_login: kira.login, owner_handle: "kira", node_hostname: "k", node_pubkey: kira.keys.pubkey, node_ip: "1.1.1.1" });
    expect(status(second, roster, team).status).toBe("reject");
  });
});

describe("§2 rule 1–3: envelope, origin, authorship", () => {
  test("wrong team and bad id are rejected", () => {
    const { roster, team, alex } = world();
    const other = ev("ffffffffffffffff", alex, "msg.post", { text: "hi" }, { channel: "general" });
    expect(status(other, roster, team)).toEqual({ status: "reject", reason: "wrong_team" });
    const e = ev(team, alex, "msg.post", { text: "hi" }, { channel: "general" });
    expect(status({ ...e, id: `${e.origin}:999` }, roster, team)).toEqual({ status: "reject", reason: "bad_id" });
  });

  test("signature tamper detection", () => {
    const { roster, team, alex } = world();
    const e = ev(team, alex, "msg.post", { text: "hi" }, { channel: "general" });
    expect(status(e, roster, team).status).toBe("ok");
    expect(status({ ...e, body: { text: "hacked" } }, roster, team)).toEqual({ status: "reject", reason: "bad_signature" });
    expect(status({ ...e, sig: e.sig.slice(0, -4) + "AAAA" }, roster, team)).toEqual({ status: "reject", reason: "bad_signature" });
  });

  test("unknown origin is pending (rule 5), then ok after admission", () => {
    const { roster, team, alex, log } = world();
    const zed = tnode("zed");
    const post = ev(team, zed, "msg.post", { text: "early" }, { channel: "general" });
    expect(status(post, roster, team)).toEqual({ status: "pending", reason: "unknown_origin" });
    const r2 = fold([...log, memberEv(team, alex, zed, "member"), nodeEv(team, alex, zed)], team).roster;
    expect(status(post, r2, team).status).toBe("ok");
  });

  test("author handle must bind to the origin's member; author.node must be origin", () => {
    const { roster, team, kira } = world();
    const asAlex = ev(team, kira, "msg.post", { text: "i am alex" }, { channel: "general", handle: "alex" });
    expect(status(asAlex, roster, team)).toEqual({ status: "reject", reason: "author_handle_mismatch" });
    const e = ev(team, kira, "msg.post", { text: "x" }, { channel: "general" });
    const moved = signEvent(kira.keys, { ...stripSig(e), author: { handle: "kira", node: "0000000000000000" } });
    expect(status(moved, roster, team)).toEqual({ status: "reject", reason: "author_node_mismatch" });
  });

  test("removed member and revoked node are rejected", () => {
    const { team, alex, kira, log } = world();
    const removed = fold([...log, memberEv(team, alex, kira, "removed")], team).roster;
    expect(status(ev(team, kira, "msg.post", { text: "x" }, { channel: "general" }), removed, team)).toEqual({ status: "reject", reason: "member_removed" });
    const revoked = fold([...log, nodeEv(team, alex, kira, true)], team).roster;
    expect(status(ev(team, kira, "msg.post", { text: "x" }, { channel: "general" }), revoked, team)).toEqual({ status: "reject", reason: "node_revoked" });
  });
});

describe("§2 rule 4: kind rules", () => {
  test("team.member and team.node are owner-only", () => {
    const { roster, team, kira } = world();
    const mallory = tnode("mallory");
    expect(status(memberEv(team, kira, mallory, "owner"), roster, team)).toEqual({ status: "reject", reason: "not_owner" });
    expect(status(nodeEv(team, kira, mallory), roster, team)).toEqual({ status: "reject", reason: "not_owner" });
  });

  test("last owner cannot be demoted or removed; with two owners it can", () => {
    const { roster, team, alex, kira, log } = world();
    expect(status(memberEv(team, alex, alex, "member"), roster, team)).toEqual({ status: "reject", reason: "last_owner" });
    expect(status(memberEv(team, alex, alex, "removed"), roster, team)).toEqual({ status: "reject", reason: "last_owner" });
    const two = fold([...log, memberEv(team, alex, kira, "owner")], team).roster;
    expect(status(memberEv(team, alex, alex, "member"), two, team).status).toBe("ok");
  });

  test("handles are unique and immutable per login", () => {
    const { roster, team, alex, kira } = world();
    const imposter = { ...tnode("kira"), login: "other@example.com" };
    expect(status(memberEv(team, alex, imposter, "member"), roster, team)).toEqual({ status: "reject", reason: "handle_taken" });
    const rename = ev(team, alex, "team.member", { login: kira.login, handle: "kira2", role: "member" });
    expect(status(rename, roster, team)).toEqual({ status: "reject", reason: "handle_immutable" });
  });

  test("team.node for an unknown member is pending; node id must match pubkey", () => {
    const { roster, team, alex } = world();
    const stranger = tnode("stranger");
    expect(status(nodeEv(team, alex, stranger), roster, team)).toEqual({ status: "pending", reason: "unknown_member" });
    const bad = ev(team, alex, "team.node", { node_id: "0123456789abcdef", login: alex.login, hostname: "x", pubkey: stranger.keys.pubkey, ip: "1.2.3.4" });
    expect(status(bad, roster, team)).toEqual({ status: "reject", reason: "bad_node_id" });
  });

  test("observer is read-only", () => {
    const { roster, team, obs } = world();
    expect(status(ev(team, obs, "msg.post", { text: "x" }, { channel: "general" }), roster, team)).toEqual({ status: "reject", reason: "observer_readonly" });
    expect(status(ev(team, obs, "ask", { to: "@alex", text: "q", expires_at: Date.now() + 1000 }), roster, team).status).toBe("reject");
    expect(status(ev(team, obs, "agent.status", { agent: "a1", state: "working", runtime: "cli" }, { agent: "a1" }), roster, team).status).toBe("reject");
    expect(status(ev(team, obs, "channel.upsert", { name: "mine" }), roster, team).status).toBe("reject");
  });

  test("restricted channel: only listed members may post", () => {
    const { roster, team, alex, kira } = world();
    expect(status(ev(team, kira, "msg.post", { text: "x" }, { channel: "secret" }), roster, team)).toEqual({ status: "reject", reason: "not_channel_member" });
    expect(status(ev(team, alex, "msg.post", { text: "x" }, { channel: "secret" }), roster, team).status).toBe("ok");
  });

  test("msg.post needs a channel; unknown channel is pending", () => {
    const { roster, team, alex } = world();
    expect(status(ev(team, alex, "msg.post", { text: "x" }), roster, team)).toEqual({ status: "reject", reason: "channel_required" });
    expect(status(ev(team, alex, "msg.post", { text: "x" }, { channel: "later" }), roster, team)).toEqual({ status: "pending", reason: "unknown_channel" });
  });

  // Multi-writer rule replaced (FIX-2): a channel.upsert is an owner-signed (authority) event; a
  // member's "create a new public channel" power is a *request* the authority checks (requestAllowed).
  test("channel.upsert: owner-signed; members may only request a new public channel", () => {
    const { team, alex, kira, obs, roster: r } = world();
    const kiraRec = r.members.get(kira.login);
    const obsRec = r.members.get(obs.login);
    if (!kiraRec || !obsRec) throw new Error("world");
    expect(status(ev(team, kira, "channel.upsert", { name: "fresh" }), r, team)).toEqual({ status: "reject", reason: "not_owner" });
    expect(requestAllowed("channel.upsert", { name: "fresh" }, r, kiraRec).status).toBe("ok");
    expect(requestAllowed("channel.upsert", { name: "general", topic: "t" }, r, kiraRec)).toEqual({ status: "reject", reason: "not_channel_owner" });
    expect(requestAllowed("channel.upsert", { name: "fresh", members: ["kira"] }, r, kiraRec)).toEqual({ status: "reject", reason: "owner_only" });
    expect(requestAllowed("team.member", { login: "x", handle: "x", role: "owner" }, r, kiraRec)).toEqual({ status: "reject", reason: "not_owner" });
    expect(requestAllowed("channel.upsert", { name: "fresh" }, r, obsRec)).toEqual({ status: "reject", reason: "not_owner" });
    expect(status(ev(team, alex, "channel.upsert", { name: "general", archived: true }), r, team).status).toBe("ok");
  });

  test("answer to an unknown ask is pending; a known ask must address the author", () => {
    const { roster, team, alex, kira } = world();
    const ask = ev(team, alex, "ask", { to: "@kira", text: "q?", expires_at: Date.now() + 60_000 });
    const a = ev(team, kira, "answer", { ask: ask.id, text: "yes" });
    expect(status(a, roster, team, () => ({ state: "none" }))).toEqual({ status: "pending", reason: "unknown_ask" });
    expect(status(a, roster, team, () => ({ state: "ok", event: ask })).status).toBe("ok");
    const byAlex = ev(team, alex, "answer", { ask: ask.id, text: "me instead" });
    expect(status(byAlex, roster, team, () => ({ state: "ok", event: ask }))).toEqual({ status: "reject", reason: "not_addressee" });
  });

  test("agent.status binds author.agent to body.agent and forbids a channel", () => {
    const { roster, team, kira } = world();
    expect(status(ev(team, kira, "agent.status", { agent: "ux", state: "working", runtime: "cli" }, { agent: "ux" }), roster, team).status).toBe("ok");
    expect(status(ev(team, kira, "agent.status", { agent: "ux", state: "working", runtime: "cli" }, { agent: "other" }), roster, team)).toEqual({ status: "reject", reason: "agent_mismatch" });
    expect(status(ev(team, kira, "agent.status", { agent: "ux", state: "working", runtime: "cli" }), roster, team)).toEqual({ status: "reject", reason: "agent_mismatch" });
    expect(status(ev(team, kira, "agent.status", { agent: "ux", state: "working", runtime: "cli" }, { agent: "ux", channel: "general" }), roster, team)).toEqual({ status: "reject", reason: "unexpected_channel" });
  });
});

describe("authority chain fold", () => {
  test("is deterministic regardless of input order", () => {
    const { team, log } = world();
    const a = fold(log, team).roster;
    for (let i = 0; i < 20; i++) {
      const shuffled = [...log].sort(() => Math.random() - 0.5);
      const b = fold(shuffled, team).roster;
      expect([...b.members.values()]).toEqual([...a.members.values()]);
      expect([...b.nodes.keys()].sort()).toEqual([...a.nodes.keys()].sort());
      expect([...b.channels.keys()].sort()).toEqual([...a.channels.keys()].sort());
    }
  });

  // Was "clock skew: a member event stamped before its node's admission still applies" (multi-writer):
  // the chain orders by the authority's seq, so timestamps don't matter at all.
  test("timestamps don't order the chain: a skewed authority event still applies in seq order", () => {
    const { team, alex, log } = world();
    const skewed = ev(team, alex, "channel.upsert", { name: "early" }, { ts: 1 });
    expect(fold([...log, skewed], team).roster.channels.has("early")).toBe(true);
  });

  // Was "an owner's earlier invites survive that owner's later removal" (multi-writer): a non-authority
  // owner's roster events never enter the chain; its powers go through roster requests.
  test("a non-authority owner's roster events never apply", () => {
    const alex = tnode("alex");
    const bea = tnode("bea");
    const kira = tnode("kira");
    const { team, create } = createTeam(alex);
    const log = [create, memberEv(team, alex, bea, "owner"), nodeEv(team, alex, bea), memberEv(team, bea, kira, "member")];
    const r = fold(log, team).roster;
    expect(r.members.get(bea.login)?.role).toBe("owner");
    expect(r.members.has(kira.login)).toBe(false);
  });

  test("authority transfer: the new authority's events count only after one links the transfer", () => {
    const alex = tnode("alex"), bea = tnode("bea"), kira = tnode("kira"), zed = tnode("zed");
    const { team, create } = createTeam(alex);
    const base = [create, memberEv(team, alex, bea, "owner"), nodeEv(team, alex, bea)];
    const transfer = ev(team, alex, "team.authority", { node_id: bea.keys.nodeId });
    const unlinked = memberEv(team, bea, kira, "member");
    const linked = ev(team, bea, "team.member", { login: zed.login, handle: "zed", role: "member", after: transfer.id });
    const late = memberEv(team, bea, kira, "observer");
    const stale = memberEv(team, alex, tnode("old"), "member"); // old authority after the transfer
    const c = fold([...base, transfer, unlinked, linked, late, stale], team);
    expect(c.authority).toBe(bea.keys.nodeId);
    expect(c.roster.members.get(zed.login)?.role).toBe("member");
    expect(c.roster.members.get(kira.login)?.role).toBe("observer");
    expect([...c.roster.members.values()].some((m) => m.handle === "old")).toBe(false);
    // Only an admitted owner node can receive authority, and the authority can't demote itself.
    const toMember = ev(team, alex, "team.authority", { node_id: tnode("ghost").keys.nodeId });
    expect(fold([...base, toMember], team).authority).toBe(alex.keys.nodeId);
    const selfDemote = memberEv(team, alex, alex, "member");
    expect(fold([...base, selfDemote], team).roster.members.get(alex.login)?.role).toBe("owner");
  });

  test("the fold ignores non-roster kinds and forged roster events", () => {
    const { team, kira, log } = world();
    const forged = memberEv(team, kira, tnode("evil"), "owner");
    const r = fold([...log, forged, ev(team, kira, "msg.post", { text: "x" }, { channel: "general" })], team).roster;
    expect([...r.members.values()].some((m) => m.handle === "evil")).toBe(false);
  });
});

function stripSig(e: Event): Omit<Event, "sig"> {
  const { sig: _sig, ...rest } = e;
  return rest;
}
