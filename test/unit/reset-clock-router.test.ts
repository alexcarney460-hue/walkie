// RESET-CLOCK-1: the account router uses the remembered reset times — an account the clock says is out is skipped
// until its remembered reset (never pinged), usable again after it, and when every account is out the answer names
// the account that frees first (machine-readable, for an orchestrator to schedule on).
import { describe, expect, test } from "bun:test";
import { select, selectOwnFirst, type Candidate } from "../../src/accounts/select.ts";
import { candidatesFrom } from "../../src/switch/accounts.ts";
import { exhaustedLine } from "../../src/switch/wrapper.ts";
import type { AccountUsage, AccountView, ResetClock } from "../../src/protocol/accounts.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";

const T0 = Date.UTC(2026, 8, 27, 19, 0, 0);
const H = 3_600_000;
const A = "a".repeat(24);
const B = "b".repeat(24);
const C = "c".repeat(24);

const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({ at: T0, state: "ok", reason: null, source: "api", until: null, windows: [], ...over });
const clock = (over: Partial<ResetClock> = {}): ResetClock => ({ kind: "session", scope: null, window_s: 18_000, resets_at: T0 + 2 * H, observed_at: T0 - H, exhausted: true, source: "api", ...over });
const cand = (over: Partial<Candidate> = {}): Candidate => ({ id: A, provider: "claude", label: "al***@ex***.com", owner: "alex", own: true, source: "local", usage: null, leases: 0, ...over });

describe("routing by remembered reset times (never pings)", () => {
  test("an account the clock says is out is skipped until its remembered reset; after it, eligible again", () => {
    const out = cand({ clock: [clock()] });
    const sel = select([out], { provider: "claude", now: T0 });
    expect(sel.pick).toBeNull();
    expect(sel.excluded[0]).toMatchObject({ why: "limit reached (remembered)", until: T0 + 2 * H, atLimit: true });
    // Three hours later, with no new reading: usable again (room unknown until a reading), no provider asked.
    const later = select([out], { provider: "claude", now: T0 + 3 * H });
    expect(later.pick?.id).toBe(A);
    expect(later.pick?.room).toBeNull();
  });

  test("a later reading with room supersedes the remembered limit; a model's own limit does not block the account", () => {
    const c = cand({ clock: [clock()], usage: usage({ at: T0, windows: [{ kind: "session", used_pct: 30, resets_at: T0 + 4 * H, window_s: 18_000, scope: null }] }) });
    expect(select([c], { provider: "claude", now: T0 + 60_000 }).pick?.room).toBe(70);
    const opus = cand({ clock: [clock({ kind: "weekly_model", scope: "Opus", window_s: 604_800 })] });
    expect(select([opus], { provider: "claude", now: T0 }).pick?.id).toBe(A);
  });

  test("prefers an account with room; when all are out, names the earliest remembered reset (machine-readable)", () => {
    const early = cand({ id: B, label: "b***@ex***.com", clock: [clock({ resets_at: T0 + H })] });
    const late = cand({ id: C, label: "c***@ex***.com", clock: [clock({ resets_at: T0 + 5 * H })] });
    const sel = selectOwnFirst([late, early], { provider: "claude", now: T0 });
    expect(sel.pick).toBeNull();
    expect(sel.nextFree).toEqual({ at: T0 + H, id: B, key: B, label: "b***@ex***.com", provider: "claude", owner: "alex" });
    const line = exhaustedLine(sel);
    expect(line).toMatchObject({ walkie: "all_accounts_exhausted", waiting_until: T0 + H, next_free: { at: T0 + H, account: B, label: "b***@ex***.com", provider: "claude", owner: "alex" } });
    expect((line.next_free as { at_iso: string }).at_iso).toBe(new Date(T0 + H).toISOString());
    const withRoom = cand({ id: A, usage: usage({ windows: [{ kind: "session", used_pct: 20, resets_at: T0 + H, window_s: 18_000, scope: null }] }) });
    expect(selectOwnFirst([late, early, withRoom], { provider: "claude", now: T0 }).pick?.id).toBe(A);
    expect(exhaustedLine({ waitUntil: null, nextFree: null })).toEqual({ walkie: "all_accounts_exhausted", waiting_until: null, next_free: null });
  });
});

describe("the switcher's candidates carry the remembered reset times", () => {
  const entry: VaultEntry = { id: A, provider: "claude", label: "al***@ex***.com", plan: null, policy: "own", share_with: [], created_at: 1, expires_at: null, home: null, linked: false, gen: "ab12" };
  const base = { provider: "claude" as const, entries: [entry], saved: new Map(), marks: {}, localLeases: new Map<string, number>() };
  const view = (over: Partial<AccountView> = {}): AccountView => ({
    key: `alex:${A}`, id: A, provider: "claude", label: "al***@ex***.com", plan: null, owners: ["alex"], claimed_by: [], usage: null, usage_host: null, last_seen: 1,
    machines: [{ node_id: "n-mac", hostname: "alex-mac", handle: "alex", online: true, self: true, agents: [], usage: null }], leases: [], ...over,
  });

  test("from the owner's pooled view (merged across the owner's machines), else from what the daemon saved", () => {
    const pooled = candidatesFrom({ ...base, pooled: { accounts: [view({ clock: [clock()] })], me: "alex" } });
    expect(pooled[0]?.clock).toEqual([clock()]);
    const saved = candidatesFrom({ ...base, pooled: null, clocks: new Map([[A, [clock({ resets_at: T0 + 9 * H })]]]) });
    expect(saved[0]?.clock?.[0]?.resets_at).toBe(T0 + 9 * H);
    // Another member reporting the same account id never lends it their clock.
    const mal = candidatesFrom({ ...base, pooled: { accounts: [view({ key: `mal:${A}`, owners: ["mal"], clock: [clock()] })], me: "alex" } });
    expect(mal[0]?.clock).toBeUndefined();
  });
});
