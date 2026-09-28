// Walkie Direct invites (PROTOCOL §4 "Direct"): sign / verify / expiry / single use / tamper.
import { describe, expect, test } from "bun:test";
import { buildChain } from "../../src/daemon/chain.ts";
import {
  INVITE_MAX_CHARS, INVITE_TTL_MS, checkInvite, createInvite, decodeInvite, inviteId, isInviteCode,
} from "../../src/daemon/invite.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { createTeam, ev, memberEv, nodeEv, now, tnode } from "../helpers/events.ts";

function world() {
  const alex = tnode("alex");
  const kira = tnode("kira");
  const { team, create } = createTeam(alex);
  const log: Event[] = [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira)];
  return { alex, kira, team, log, roster: buildChain(log, team).roster };
}

const RELAY = "https://usw1-1.relay.n0.iroh.link./";

function mint(w: ReturnType<typeof world>, over: Partial<Parameters<typeof createInvite>[1]> = {}, at = now()) {
  return createInvite(w.alex.keys, {
    team: w.team, authority: w.alex.keys.pubkey, relay: RELAY, handle: "riley", role: "member", now: at, pos: w.roster.pos ?? 0, ...over,
  });
}

describe("invite codes", () => {
  test("round trip: compact, copy-pasteable, carries every field", () => {
    const w = world();
    const { code, id, expires_at } = mint(w);
    expect(isInviteCode(code)).toBe(true);
    expect(code.length).toBeLessThanOrEqual(INVITE_MAX_CHARS);
    expect(code).toMatch(/^wk1[A-Za-z0-9_-]+$/);
    const d = decodeInvite(code);
    if ("error" in d) throw new Error(d.error);
    expect(d.team).toBe(w.team);
    expect(d.authority).toBe(w.alex.keys.pubkey);
    expect(d.issuer).toBe(w.alex.keys.nodeId);
    expect(d.relay).toBe(RELAY);
    expect(d.handle).toBe("riley");
    expect(d.role).toBe("member");
    expect(d.id).toBe(id);
    expect(d.expires_at).toBe(expires_at);
    expect(expires_at - now()).toBeGreaterThan(INVITE_TTL_MS - 1_000);
    expect(expires_at - now()).toBeLessThanOrEqual(INVITE_TTL_MS);
  });

  test("a longest-handle, long-relay invite stays under the size budget", () => {
    const w = world();
    const { code } = mint(w, { handle: "a".repeat(24), relay: "https://" + "r".repeat(200) + ".example/" });
    expect(code.length).toBeLessThanOrEqual(INVITE_MAX_CHARS);
    const d = decodeInvite(code);
    if ("error" in d) throw new Error(d.error);
    expect(d.relay).toBeUndefined(); // too long to carry: discovery finds the authority instead
  });

  test("each invite has a fresh one-time secret", () => {
    const w = world();
    expect(mint(w).id).not.toBe(mint(w).id);
    expect(inviteId(new Uint8Array(16))).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a valid invite from an owner node passes", () => {
    const w = world();
    const { code } = mint(w);
    const r = checkInvite(code, w.roster, w.team, now());
    expect(r.ok).toBe(true);
  });

  test("expired → refused; a far-future expiry → refused", () => {
    const w = world();
    const old = mint(w, {}, now() - INVITE_TTL_MS - 60_000).code;
    expect(checkInvite(old, w.roster, w.team, now())).toEqual({ ok: false, reason: "invite_expired" });
    const future = mint(w, {}, now() + 30 * 24 * 3600_000).code;
    expect(checkInvite(future, w.roster, w.team, now())).toEqual({ ok: false, reason: "invite_expired" });
  });

  test("single use: an invite recorded on the chain is refused", () => {
    const w = world();
    const { code, id } = mint(w);
    const riley = tnode("riley", "direct:riley");
    const log = [
      ...w.log,
      memberEv(w.team, w.alex, riley, "member"),
      ev(w.team, w.alex, "team.node", {
        node_id: riley.keys.nodeId, login: riley.login, hostname: riley.hostname, pubkey: riley.keys.pubkey, ip: "",
        transports: ["direct"], invite: id,
      }),
    ];
    const roster = buildChain(log, w.team).roster;
    expect(roster.invites?.has(id)).toBe(true);
    expect(checkInvite(code, roster, w.team, now())).toEqual({ ok: false, reason: "invite_used" });
    // A different invite is unaffected.
    expect(checkInvite(mint(w).code, roster, w.team, now()).ok).toBe(true);
  });

  test("tamper: any flipped byte fails (signature, or the decoder)", () => {
    const w = world();
    const { code } = mint(w);
    const bytes = Buffer.from(code.slice(3), "base64url");
    for (let i = 0; i < bytes.length; i += 7) {
      const t = Buffer.from(bytes);
      t[i] = (t[i] as number) ^ 0x01;
      const bad = "wk1" + t.toString("base64url");
      const r = checkInvite(bad, w.roster, w.team, now());
      expect(r.ok).toBe(false);
    }
  });

  test("handle or role swapped by re-encoding without the key → bad signature", () => {
    const w = world();
    const { code } = mint(w, { role: "member" });
    const bytes = Buffer.from(code.slice(3), "base64url");
    // role byte sits right after version(1) team(8) authority(32) issuer(8) secret(16) expiry(4) chain position(4)
    bytes[73] = 0; // owner
    const r = checkInvite("wk1" + bytes.toString("base64url"), w.roster, w.team, now());
    expect(r).toEqual({ ok: false, reason: "invite_bad_signature" });
  });

  test("signed by a non-owner node, or an unknown node → refused", () => {
    const w = world();
    const byKira = createInvite(w.kira.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "riley", role: "member", now: now(), pos: w.roster.pos ?? 0 }).code;
    expect(checkInvite(byKira, w.roster, w.team, now())).toEqual({ ok: false, reason: "invite_issuer_not_owner" });
    const stranger = tnode("mallory");
    const byStranger = createInvite(stranger.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "riley", role: "owner", now: now(), pos: w.roster.pos ?? 0 }).code;
    expect(checkInvite(byStranger, w.roster, w.team, now())).toEqual({ ok: false, reason: "invite_issuer_unknown" });
  });

  test("an owner node that was revoked can no longer vouch", () => {
    const w = world();
    const { code } = mint(w);
    const alex2 = tnode("alex", w.alex.login, "alex-studio");
    const log = [...w.log, nodeEv(w.team, w.alex, alex2)];
    const byAlex2 = createInvite(alex2.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "riley", role: "member", now: now(), pos: w.roster.pos ?? 0 }).code;
    expect(checkInvite(byAlex2, buildChain(log, w.team).roster, w.team, now()).ok).toBe(true);
    const revoked = buildChain([...log, nodeEv(w.team, w.alex, alex2, true)], w.team).roster;
    expect(checkInvite(byAlex2, revoked, w.team, now())).toEqual({ ok: false, reason: "invite_issuer_not_owner" });
    expect(checkInvite(code, revoked, w.team, now()).ok).toBe(true);
  });

  test("another team's invite → refused", () => {
    const w = world();
    const other = world();
    const { code } = mint(other);
    expect(checkInvite(code, w.roster, w.team, now())).toEqual({ ok: false, reason: "invite_wrong_team" });
  });

  test("garbage never throws", () => {
    for (const s of ["", "wk1", "wk1!!!!", "wk1" + "A".repeat(400), "hello", "wk1" + Buffer.alloc(100).toString("base64url")]) {
      expect(() => decodeInvite(s)).not.toThrow();
      expect(checkInvite(s, world().roster, "0000000000000000", now()).ok).toBe(false);
    }
    expect(isInviteCode("100.64.0.1")).toBe(false);
    expect(isInviteCode("alex-mbp:7458")).toBe(false);
  });
});
