// ACCOUNTS-2 selector: room over the applicable windows, exclusions, the lease reserve, tie-breaks, meterless logins,
// and the earliest reset when nothing is usable.
import { describe, expect, test } from "bun:test";
import { roomOf, select, type Candidate } from "../../src/accounts/select.ts";
import type { AccountUsage, AccountWindow } from "../../src/protocol/accounts.ts";

const NOW = 1_790_000_000_000;
const H = 3_600_000;

function w(kind: AccountWindow["kind"], used: number, resetsIn: number | null = 2 * H, scope: string | null = null): AccountWindow {
  return { kind, used_pct: used, resets_at: resetsIn === null ? null : NOW + resetsIn, window_s: null, scope };
}
function usage(windows: AccountWindow[], state: AccountUsage["state"] = "ok", until: number | null = null): AccountUsage {
  return { at: NOW - 60_000, state, reason: state === "unknown" ? "no_usage_api" : null, source: "api", windows, until };
}
function cand(id: string, u: AccountUsage | null, extra: Partial<Candidate> = {}): Candidate {
  return { id: id.padEnd(24, "0"), provider: "claude", label: `L${id}`, owner: "alex", own: true, source: "local", usage: u, leases: 0, ...extra };
}

describe("room", () => {
  test("is the least left over the windows that apply; a window past its reset counts as unused", () => {
    const u = usage([w("session", 40), w("weekly", 70), w("weekly_model", 90, 2 * H, "Opus")]);
    expect(roomOf(u, null, NOW)).toBe(10); // unknown model: every model window applies
    expect(roomOf(u, "claude-sonnet-4", NOW)).toBe(30); // the Opus window does not apply to Sonnet
    expect(roomOf(u, "opus", NOW)).toBe(10);
    expect(roomOf(usage([w("session", 99, -1000), w("weekly", 20)]), null, NOW)).toBe(80);
  });
});

describe("select", () => {
  const opts = { provider: "claude" as const, now: NOW };

  test("most room wins; exhausted and needs-re-login are excluded; unknown and over-threshold rank last (round 4)", () => {
    const s = select([
      cand("a", usage([w("session", 50)])),
      cand("b", usage([w("session", 10)])),
      cand("c", usage([w("session", 100)], "exhausted", NOW + H)),
      cand("d", usage([], "relogin")),
      cand("e", { ...usage([]), state: "unknown", reason: "http_error" }),
      cand("f", usage([w("session", 96)])),
    ], opts);
    expect(s.pick?.id.startsWith("b")).toBe(true);
    // Below the threshold first, then room unknown, then at/over the threshold (a preference, never an exclusion).
    expect(s.ranked.map((r) => [r.id[0], r.tier])).toEqual([["b", 0], ["a", 0], ["e", 1], ["f", 2]]);
    expect(Object.fromEntries(s.excluded.map((e) => [e.id[0], e.why]))).toEqual({ c: "limit reached", d: "needs re-login" });
  });

  test("the lease reserve spreads terminals: −10 points per active session", () => {
    const s = select([cand("a", usage([w("session", 10)]), { leases: 2 }), cand("b", usage([w("session", 20)]))], opts);
    expect(s.pick?.id[0]).toBe("b"); // 90 − 20 = 70 < 80
  });

  test("ties: own account, then soonest weekly reset, then fewest leases", () => {
    const base = [w("session", 20)];
    const t1 = select([cand("a", usage(base), { own: false, owner: "kira" }), cand("b", usage(base))], opts);
    expect(t1.pick?.id[0]).toBe("b");
    const t2 = select([cand("a", usage([...base, w("weekly", 20, 5 * 24 * H)])), cand("b", usage([...base, w("weekly", 20, 2 * 24 * H)]))], opts);
    expect(t2.pick?.id[0]).toBe("b");
  });

  test("a meterless login (a setup-token nobody meters) ranks after metered accounts with room, fewest leases first", () => {
    const meterless = { ...usage([]), state: "unknown" as const };
    const s = select([
      cand("m1", meterless, { meterless: true, leases: 1 }), cand("m2", null, { meterless: true }), cand("k", usage([w("session", 80)])),
    ], opts);
    expect(s.ranked.map((r) => r.id.slice(0, 2))).toEqual(["k0", "m2", "m1"]);
    expect(s.ranked[1]?.room).toBeNull();
  });

  test("a mark (a limit a session hit) excludes until its reset; the threshold is configurable", () => {
    // A reset the session named (not exactly mark + 60 min: that is an older switcher's placeholder, never reported).
    const s = select([cand("a", usage([w("session", 10)]), { mark: { state: "exhausted", until: NOW + H, at: NOW - 1_000, reason: "five_hour" } })], opts);
    expect(s.pick).toBeNull();
    expect(s.waitUntil).toBe(NOW + H);
    expect(select([cand("a", usage([w("session", 10)]), { mark: { state: "exhausted", until: NOW - 1, at: NOW - H, reason: "x" } })], opts).pick).not.toBeNull();
    // The threshold is configurable — and only ranks: an account over it still runs when nothing has more room.
    const t = select([cand("a", usage([w("session", 85)])), cand("b", usage([w("session", 70)]))], { ...opts, thresholdPct: 80 });
    expect(t.ranked.map((r) => [r.id[0], r.tier])).toEqual([["b", 0], ["a", 2]]);
    expect(select([cand("a", usage([w("session", 85)]))], { ...opts, thresholdPct: 80 }).pick?.id[0]).toBe("a");
    expect(select([cand("a", usage([w("session", 100)]))], opts)).toMatchObject({ pick: null, exhausted: true });
  });

  test("nothing usable: waitUntil is the earliest time any excluded account is usable again", () => {
    const s = select([
      cand("a", usage([w("session", 100, 3 * H)], "exhausted", NOW + 3 * H)),
      cand("b", usage([w("session", 100, 2 * H)])),
      cand("c", usage([], "relogin")),
    ], opts);
    expect(s.pick).toBeNull();
    expect(s.waitUntil).toBe(NOW + 2 * H);
    expect(s.exhausted).toBe(true);
  });

  test("an explicit exclude and another provider are never picked; a stale reading (over an hour) is unknown", () => {
    const s = select([cand("a", usage([w("session", 1)])), { ...cand("b", usage([w("session", 1)])), provider: "codex" }], { ...opts, exclude: ["a".padEnd(24, "0")] });
    expect(s.pick).toBeNull();
    const old = { ...usage([w("session", 1)]), at: NOW - 2 * H };
    // Round 4: room unknown is not "at the limit" — it ranks after known room, still usable.
    expect(select([cand("a", old)], opts).ranked[0]).toMatchObject({ room: null, tier: 1 });
    // …but an exhausted reading whose reset is still ahead holds, however old.
    expect(select([cand("a", { ...usage([w("session", 100)], "exhausted", NOW + H), at: NOW - 3 * H })], opts)).toMatchObject({ pick: null, exhausted: true });
  });
});
