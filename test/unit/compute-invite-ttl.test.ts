// RENT-2: a rented machine's add-machine code lives 1 hour (createInvite ttlMs). No wire change: the expiry was always
// signed, and the authority's check accepts any expiry up to the 7-day TTL.
import { describe, expect, test } from "bun:test";
import { buildChain } from "../../src/daemon/chain.ts";
import { INVITE_TTL_MS, checkInvite, createInvite, decodeInvite } from "../../src/daemon/invite.ts";
import { RENTAL_CODE_TTL_MS } from "../../src/protocol/compute.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { createTeam, memberEv, nodeEv, now, tnode } from "../helpers/events.ts";

function world() {
  const alex = tnode("alex");
  const kira = tnode("kira");
  const { team, create } = createTeam(alex);
  const log: Event[] = [create, memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira)];
  return { alex, team, roster: buildChain(log, team).roster };
}

function mint(w: ReturnType<typeof world>, ttlMs: number | undefined, at: number) {
  return createInvite(w.alex.keys, {
    team: w.team, authority: w.alex.keys.pubkey, handle: "alex", role: "owner", now: at, pos: w.roster.pos ?? 0,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
}

describe("invite ttl (RENT-2)", () => {
  test("a 1-hour code: accepted before it expires, invite_expired after", () => {
    const w = world();
    const t = now();
    const inv = mint(w, RENTAL_CODE_TTL_MS, t);
    expect(inv.expires_at - t).toBeLessThanOrEqual(RENTAL_CODE_TTL_MS);
    expect(inv.expires_at - t).toBeGreaterThan(RENTAL_CODE_TTL_MS - 1_000);
    const d = decodeInvite(inv.code);
    expect("error" in d ? d.error : d.expires_at).toBe(inv.expires_at);
    expect(checkInvite(inv.code, w.roster, w.team, t + 59 * 60_000).ok).toBe(true);
    const late = checkInvite(inv.code, w.roster, w.team, t + RENTAL_CODE_TTL_MS + 1_000);
    expect(late).toEqual({ ok: false, reason: "invite_expired" });
  });

  test("default stays 7 days", () => {
    const w = world();
    const t = now();
    const inv = mint(w, undefined, t);
    expect(inv.expires_at - t).toBeGreaterThan(INVITE_TTL_MS - 1_000);
    expect(checkInvite(inv.code, w.roster, w.team, t + 6 * 24 * 3_600_000).ok).toBe(true);
  });

  test("a ttl of zero, negative, fractional or past 7 days is refused at minting", () => {
    const w = world();
    for (const bad of [0, -1, 1.5, INVITE_TTL_MS + 1]) expect(() => mint(w, bad, now())).toThrow("invalid invite ttl");
  });
});
