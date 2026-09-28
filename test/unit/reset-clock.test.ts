// RESET-CLOCK-1 (ALE-5392): accounts remember when each window resets and count down on their own.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeUsage } from "../../src/accounts/adapters/claude.ts";
import { parseGrokLog } from "../../src/accounts/adapters/grok.ts";
import { parseKimiUsage } from "../../src/accounts/adapters/kimi.ts";
import { parseCodexUsage } from "../../src/accounts/adapters/codex.ts";
import {
  CLOCK_KEEP_MS, clockFromMark, clockFromReading, LEGACY_GUESS_MS, markGuessed, mergeClock, shiftClock, validClock,
} from "../../src/accounts/clock.ts";
import { USAGE_URLS } from "../../src/accounts/http.ts";
import { writeMark, type Mark } from "../../src/accounts/leases.ts";
import { AccountsService } from "../../src/accounts/service.ts";
import { unknownReading } from "../../src/accounts/types.ts";
import { renderAccounts } from "../../src/cli/commands/accounts.ts";
import { accountViewJson } from "../../src/cli/agent-output.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { accountsView } from "../../src/daemon/views.ts";
import {
  absTime, AVAILABLE_UNCONFIRMED, clockAvailability, clockRows, clockText, GUESSED_RESET_MS, usageLine, usageUntil,
} from "../../src/protocol/accounts-format.ts";
import { GROK_EXHAUSTED_DEFAULT_MS } from "../../src/accounts/adapters/grok.ts";
import { select } from "../../src/accounts/select.ts";
import { shiftUsage } from "../../src/daemon/views.ts";
import { displayState } from "../../src/protocol/accounts-format.ts";
import { AccountsSnapshot, type AccountSummary, AccountUsage, type AccountView, type ResetClock } from "../../src/protocol/accounts.ts";
import { PeerVvRes } from "../../src/protocol/schemas.ts";
import { claudeQuotaLimit, codexRetryAt } from "../../src/switch/watch.ts";
import { UNKNOWN_RESET_MS } from "../../src/switch/wrapper.ts";
import { fakeFetch, fixture, fixtureText, makeFakeHome, TOKENS } from "../helpers/accounts.ts";

const root = mkdtempSync("/tmp/walkie-reset-clock-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshHome = () => makeFakeHome(join(root, `h${n++}`));
const noKeychain = async () => { throw new Error("TEST FAILURE: keychain read"); };
const silent: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const MIN = 60_000;
const H = 60 * MIN;
const NOW = Date.parse("2026-09-27T20:00:00Z");
const entry = (over: Partial<ResetClock> = {}): ResetClock =>
  ({ kind: "session", scope: null, window_s: 18_000, resets_at: NOW + 2 * H + 14 * MIN, observed_at: NOW - 5 * MIN, exhausted: false, source: "api", ...over });

describe("learning reset times from what already flows", () => {
  test("a Claude usage read: one entry per window, with the reading's time", () => {
    const at = Date.parse("2026-09-26T18:00:00Z");
    const c = clockFromReading(parseClaudeUsage(fixture("claude-usage.json"), at));
    expect(c.map((x) => [x.kind, x.resets_at, x.observed_at, x.exhausted, x.source])).toEqual(expect.arrayContaining([
      ["session", Date.parse("2026-09-26T20:50:00.241Z"), at, false, "api"],
      ["weekly", Date.parse("2026-10-03T06:00:00.241Z"), at, false, "api"],
    ]));
    expect(c.length).toBe(parseClaudeUsage(fixture("claude-usage.json"), at).windows.length);
  });

  test("Codex and Kimi usage reads carry their reset times too", () => {
    const at = Date.parse("2026-09-26T18:00:00Z");
    expect(clockFromReading(parseCodexUsage(fixture("codex-usage.json"), at)).every((x) => x.resets_at !== null)).toBe(true);
    const kimi = clockFromReading(parseKimiUsage(fixture("kimi-usages.json"), at));
    expect(kimi.length).toBeGreaterThan(0);
    expect(kimi.every((x) => x.source === "api")).toBe(true);
  });

  test("a failed or unknown poll (no windows) yields nothing, so it never erases what was learned", () => {
    for (const reason of ["keychain_unavailable", "no_token", "http_error", "token_expiring"] as const) {
      expect(clockFromReading(unknownReading(NOW, reason))).toEqual([]);
    }
    expect(clockFromReading({ ...unknownReading(NOW, "login_expired"), state: "relogin" })).toEqual([]);
    const prev = [entry()];
    expect(mergeClock(prev, clockFromReading(unknownReading(NOW, "http_error")), NOW)).toBe(prev);
  });

  test("Grok's CLI log (a spent balance with no windows) is one unnamed limit, from the log; its placeholder reset is unknown", () => {
    const r = parseGrokLog(fixtureText("grok-unified.jsonl"));
    expect(r?.state).toBe("exhausted");
    // This log names no reset: the reading says so (until null; the 60-min hold is the adapter's, not a reset time).
    expect(r?.until).toBeNull();
    const c = clockFromReading(r);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "other", exhausted: true, source: "log", resets_at: null });
    // A log that names its reset ("resets at <ISO>") is remembered with that time.
    const named = { ...(r as NonNullable<typeof r>), until: (r?.at ?? 0) + 17 * 60_000 };
    expect(clockFromReading(named)[0]?.resets_at).toBe((r?.at ?? 0) + 17 * 60_000);
  });

  test("an older peer's Grok placeholder (until = its time + 60 min) is not remembered as a reset either", () => {
    const legacy: AccountUsage = { at: NOW - 5 * MIN, state: "exhausted", reason: "limit_reached", source: "log", windows: [], until: NOW + 55 * MIN };
    expect(clockFromReading(legacy)[0]?.resets_at).toBeNull();
  });

  test("a limit with no reported reset reads 'limit reached' only while the adapters hold it (1 h), then nothing is claimed", () => {
    const e: ResetClock = { kind: "other", scope: null, window_s: null, resets_at: null, observed_at: NOW, exhausted: true, source: "log" };
    expect(clockAvailability([e], null, NOW + 30 * MIN)).toEqual({ kind: "exhausted", until: null });
    expect(clockAvailability([e], null, NOW + 61 * MIN)).toEqual({ kind: "none" });
  });

  test("Claude's limit message (quota headers) becomes a session reset, from the message", () => {
    const rec = { type: "assistant", timestamp: "2026-09-26T06:47:30.292Z", isApiErrorMessage: true, error: "rate_limit", quotaLimits: { status: "rejected", resetsAt: 1_790_421_000, rateLimitType: "five_hour" } };
    const hit = claudeQuotaLimit(rec)!;
    const at = Date.parse(rec.timestamp);
    const mark: Mark = { state: "exhausted", until: hit.until ?? at + UNKNOWN_RESET_MS, at, reason: hit.window, ...(hit.until === null ? { guessed: true } : {}) };
    expect(clockFromMark(mark)).toEqual([{ kind: "session", scope: null, window_s: null, resets_at: 1_790_421_000_000, observed_at: at, exhausted: true, source: "message" }]);
  });

  test("Claude's printed text ('resets 4:10am (America/Los_Angeles)') and a weekly model limit", () => {
    const text = (t: string) => ({ type: "assistant", timestamp: "2026-09-26T06:47:30.292Z", isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, quotaLimits: null, message: { content: [{ type: "text", text: t }] } });
    const hit = claudeQuotaLimit(text("You've hit your session limit · resets 4:10am (America/Los_Angeles)"))!;
    expect(hit.until).toBe(1_790_421_000_000);
    const at = Date.parse("2026-09-26T06:47:30.292Z");
    expect(clockFromMark({ state: "exhausted", until: hit.until, at, reason: hit.window })[0]).toMatchObject({ kind: "other", resets_at: 1_790_421_000_000 });
    expect(clockFromMark({ state: "exhausted", until: at + 3 * H, at, reason: "seven_day_opus" })[0]).toMatchObject({ kind: "weekly_model", scope: "Opus" });
    expect(clockFromMark({ state: "exhausted", until: at + 3 * H, at, reason: "opus model", model: "opus" })[0]).toMatchObject({ kind: "weekly_model", scope: "Opus" });
    expect(clockFromMark({ state: "exhausted", until: at + 3 * H, at, reason: "seven_day" })[0]).toMatchObject({ kind: "weekly", scope: null });
  });

  test("Codex's 'Try again at 8:29 PM.' becomes an unnamed limit with that time", () => {
    const now = new Date(2026, 8, 26, 18, 0, 0).getTime();
    const until = codexRetryAt("You've hit your usage limit. Try again at 8:29 PM.", now);
    expect(until).toBe(new Date(2026, 8, 26, 20, 29, 0).getTime());
    expect(clockFromMark({ state: "exhausted", until, at: now, reason: "usage" })[0]).toMatchObject({ kind: "other", resets_at: until, exhausted: true });
  });

  test("a guessed reset (the provider named none) is kept as unknown, never shown as a time", () => {
    expect(LEGACY_GUESS_MS).toBe(UNKNOWN_RESET_MS);
    const guessed: Mark = { state: "exhausted", until: NOW + UNKNOWN_RESET_MS, at: NOW, reason: "usage", guessed: true };
    expect(clockFromMark(guessed)[0]?.resets_at).toBeNull();
    // A mark written before the flag existed, with exactly the placeholder gap, is treated the same.
    expect(markGuessed({ until: NOW + UNKNOWN_RESET_MS, at: NOW })).toBe(true);
    expect(clockFromMark({ state: "exhausted", until: NOW + UNKNOWN_RESET_MS, at: NOW, reason: "usage" })[0]?.resets_at).toBeNull();
    expect(markGuessed({ until: NOW + UNKNOWN_RESET_MS, at: NOW, guessed: false })).toBe(false);
    expect(clockFromMark({ state: "relogin", until: null, at: NOW, reason: "token_refused" })).toEqual([]);
  });
});

describe("merging, pruning and validation", () => {
  test("per window the newer report wins; an older one is ignored; an unmentioned window is kept", () => {
    const a = entry({ observed_at: NOW - 10 * MIN, resets_at: NOW + H });
    const weekly = entry({ kind: "weekly", window_s: 604_800, resets_at: NOW + 3 * 86_400_000 });
    const newer = entry({ observed_at: NOW - MIN, resets_at: NOW + 2 * H });
    expect(mergeClock([a, weekly], [newer], NOW)).toEqual([newer, weekly]);
    const older = entry({ observed_at: NOW - 20 * MIN, resets_at: NOW + 9 * H });
    const kept = [newer, weekly];
    expect(mergeClock(kept, [older], NOW)).toBe(kept);
  });

  test("the same report again changes nothing (no rewrite every tick)", () => {
    const prev = [entry()];
    expect(mergeClock(prev, [{ ...entry() }], NOW)).toBe(prev);
  });

  test("a time more than 8 days past is dropped; at most MAX_CLOCK kept", () => {
    const old = entry({ resets_at: NOW - CLOCK_KEEP_MS - 1, observed_at: NOW - CLOCK_KEEP_MS - H });
    expect(mergeClock([old], [], NOW)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => entry({ kind: "other", scope: null, window_s: (i + 1) * 60, observed_at: NOW - i * MIN }));
    // Distinct windows need distinct keys: "other" + scope; use model scopes instead.
    const scoped = many.map((e, i) => ({ ...e, kind: "weekly_model" as const, scope: `Model ${i + 1}` }));
    const m = mergeClock([], scoped, NOW);
    expect(m).toHaveLength(8);
    expect(m[0]?.observed_at).toBe(NOW);
  });

  test("malformed entries (from a file or a peer) are dropped one by one", () => {
    expect(validClock([entry(), { kind: "session", resets_at: "soon" }, entry({ kind: "weekly" }), null])).toHaveLength(2);
    expect(validClock("nope")).toEqual([]);
  });

  test("a peer's times move onto our clock; one reported from the future is dropped; resets capped at 8 days", () => {
    const skew = 30_000; // the peer's clock is 30 s ahead
    const [s] = shiftClock([entry({ observed_at: NOW, resets_at: NOW + H })], skew, NOW, 5 * MIN);
    expect(s).toMatchObject({ observed_at: NOW - skew, resets_at: NOW + H - skew });
    expect(shiftClock([entry({ observed_at: NOW + H })], 0, NOW, 5 * MIN)).toEqual([]);
    expect(shiftClock([entry({ observed_at: NOW, resets_at: NOW + 30 * 86_400_000 })], 0, NOW, 5 * MIN)[0]?.resets_at).toBe(NOW + 8 * 86_400_000);
  });
});

describe("the daemon remembers reset times (persisted, restored, never erased by a failed poll)", () => {
  test("after a poll fails the clock stays; after a restart it is restored; no token is written", async () => {
    const home = freshHome();
    const wh = mkdtempSync(join(root, "wh-"));
    const f = fakeFetch();
    let clock = Date.parse("2026-09-26T18:00:00Z");
    const svc = new AccountsService(wh, silent, () => undefined, { home, fetch: f.fetch, keychain: noKeychain, clock: () => clock });
    svc.observe([{ agent: "cc-1", runtime: "claude-code" }]);
    await svc.tick();
    const first = svc.snapshot().accounts.find((a) => a.provider === "claude")!;
    expect(first.clock?.map((c) => [c.kind, c.resets_at])).toEqual(expect.arrayContaining([
      ["session", Date.parse("2026-09-26T20:50:00.241Z")], ["weekly", Date.parse("2026-10-03T06:00:00.241Z")],
    ]));
    // The credentials file goes away and the Keychain does not answer (as on alex-mac today, "al***@ne***"): the next
    // poll is a reading without windows.
    unlinkSync(join(home, ".claude", ".credentials.json"));
    clock += 10 * MIN;
    await svc.tick();
    const after = svc.snapshot().accounts.find((a) => a.provider === "claude")!;
    expect(after.usage?.reason).toBe("keychain_unavailable");
    expect(after.usage?.windows).toEqual([]);
    expect(after.clock).toEqual(first.clock); // remembered
    svc.stop();
    const file = readFileSync(join(wh, "accounts.json"), "utf8");
    for (const t of Object.values(TOKENS)) expect(file).not.toContain(t);
    expect(file).toContain('"clock"');
    // Restart: a new daemon on the same ~/.walkie knows the reset times before any poll.
    const again = new AccountsService(wh, silent, () => undefined, { home, fetch: fakeFetch().fetch, keychain: noKeychain, clock: () => clock, poll: false });
    expect(again.snapshot().accounts.find((a) => a.provider === "claude")?.clock).toEqual(first.clock);
  });

  test("an accounts.json from pre.5 (no clock) seeds the clock from its saved readings", () => {
    const wh = mkdtempSync(join(root, "wh-"));
    const at = NOW - 13 * H; // a 13-hour-old reading: shown as "unknown" on its own
    const reading: AccountUsage = {
      at, state: "exhausted", reason: "limit_reached", source: "api", until: at + H,
      windows: [
        { kind: "session", used_pct: 100, resets_at: at + H, window_s: 18_000, scope: null },
        { kind: "weekly", used_pct: 95, resets_at: NOW + 5 * 86_400_000, window_s: 604_800, scope: null },
      ],
    };
    writeFileSync(join(wh, "accounts.json"), JSON.stringify({ version: 1, records: [{
      id: "a1c0ffee0000000000000001", provider: "claude", label: "ae***@gm***.com", plan: "Max 20x", dir: "/nonexistent/.claude", is_default: false,
      last_seen: NOW - 12 * H, reading,
    }] }));
    const svc = new AccountsService(wh, silent, () => undefined, { home: freshHome(), fetch: fakeFetch().fetch, keychain: noKeychain, clock: () => NOW, poll: false });
    const a = svc.snapshot().accounts[0]!;
    expect(a.clock?.map((c) => [c.kind, c.exhausted, c.resets_at])).toEqual([["session", true, at + H], ["weekly", false, NOW + 5 * 86_400_000]]);
    // What a person sees: the weekly countdown, and the 5-hour limit that passed with no reading since.
    const view = { ...a, key: "x", owners: ["alex"], claimed_by: [], machines: [], usage_host: null } as unknown as AccountView;
    expect(clockAvailability(view.clock, view.usage, NOW)).toEqual({ kind: "available_unconfirmed", since: at + H });
    expect(usageLine(view, NOW)).toContain(AVAILABLE_UNCONFIRMED);
  });

  test("a limit message a wrapped session hit is learned on the next tick, without asking the provider", async () => {
    const home = freshHome();
    const wh = mkdtempSync(join(root, "wh-"));
    const f = fakeFetch();
    const svc = new AccountsService(wh, silent, () => undefined, { home, fetch: f.fetch, keychain: noKeychain, clock: () => NOW, poll: false });
    svc.observe([{ agent: "cc-1", runtime: "claude-code" }]);
    const id = svc.snapshot().accounts[0]!.id;
    writeMark(wh, id, { state: "exhausted", until: NOW + 2 * H + 14 * MIN, at: NOW - MIN, reason: "five_hour" }, NOW);
    await svc.tick();
    expect(f.calls).toEqual([]);
    const c = svc.snapshot().accounts[0]!.clock!;
    expect(c).toEqual([{ kind: "session", scope: null, window_s: null, resets_at: NOW + 2 * H + 14 * MIN, observed_at: NOW - MIN, exhausted: true, source: "message" }]);
    expect(JSON.parse(readFileSync(join(wh, "accounts.json"), "utf8")).records[0].clock).toEqual(c);
  });

  test("the snapshot with its clock is valid on the wire; a malformed clock drops only itself", () => {
    const s: AccountSummary = { id: "a1c0ffee0000000000000001", provider: "claude", label: "Claude account", plan: null, agents: [], usage: null, last_seen: NOW, clock: [entry()] };
    expect(AccountsSnapshot.parse({ at: NOW, accounts: [s] }).accounts[0]?.clock).toEqual([entry()]);
    const bad = PeerVvRes.parse({ node: "n", vv: {}, ts: NOW, accounts: { at: NOW, accounts: [{ ...s, clock: [{ kind: "nope" }] }] } });
    expect(bad.accounts?.accounts).toHaveLength(1);
    expect(bad.accounts?.accounts[0]?.clock).toBeUndefined();
  });
});

describe("the team view: shared per owner, newest report per window", () => {
  const X = "a1c0ffee0000000000000001";
  const node = (id: string, login: string, hostname: string) => [id, { node_id: id, login, hostname, pubkey: "k", ip: "100.64.0.1", port: 1, revoked: false }] as const;
  const summary = (over: Partial<AccountSummary>): AccountSummary =>
    ({ id: X, provider: "claude", label: "al***@ex***.test", plan: "Max 20x", agents: [], usage: null, last_seen: NOW - 1_000, ...over });
  function view(peers: Record<string, AccountSummary[]>) {
    const roster = {
      team: null, channels: new Map(), members: new Map([["alex@x", { login: "alex@x", handle: "alex", role: "member" as const }]]),
      nodes: new Map([node("k0", "alex@x", "alex-mac"), node("a1", "alex@x", "build-01"), node("a2", "alex@x", "build-02")]),
    };
    const core = { roster, nodeId: "k0", accounts: { at: NOW, accounts: [] } } as unknown as Core;
    const sync = { peerState: (id: string) => (peers[id] ? { accounts: { at: NOW, accounts: peers[id] }, skewMs: 0 } : undefined), isOnline: () => true } as unknown as SyncManager;
    return accountsView(core, sync, NOW);
  }

  test("two machines' clocks merge per window (newest report); each machine keeps its own", () => {
    const oldSession = entry({ observed_at: NOW - 30 * MIN, resets_at: NOW + H });
    const newSession = entry({ observed_at: NOW - 2 * MIN, resets_at: NOW + 3 * H });
    const weekly = entry({ kind: "weekly", window_s: 604_800, resets_at: NOW + 4 * 86_400_000, observed_at: NOW - 40 * MIN });
    const [a] = view({ a1: [summary({ clock: [oldSession, weekly] })], a2: [summary({ clock: [newSession] })] });
    expect(a?.clock?.find((c) => c.kind === "session")?.resets_at).toBe(NOW + 3 * H);
    expect(a?.clock?.find((c) => c.kind === "weekly")?.resets_at).toBe(NOW + 4 * 86_400_000);
    expect(a?.machines.find((m) => m.hostname === "build-01")?.clock).toEqual([oldSession, weekly]);
  });

  test("a pre.5 peer (no clock field) still gets a countdown from its reading", () => {
    const usage: AccountUsage = { at: NOW - MIN, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: 40, resets_at: NOW + H, window_s: 18_000, scope: null }] };
    const [a] = view({ a1: [summary({ usage })] });
    expect(a?.clock).toEqual([{ kind: "session", scope: null, window_s: 18_000, resets_at: NOW + H, observed_at: NOW - MIN, exhausted: false, source: "api" }]);
    expect(accountViewJson(a!).clock).toHaveLength(1);
  });
});

describe("the countdown and 'should be available again'", () => {
  test("rows count down on their own as time passes; unknown stays unknown", () => {
    const clock = [entry(), entry({ kind: "weekly", window_s: 604_800, resets_at: null })];
    expect(clockRows(clock, NOW).map((r) => [r.label, clockText(r, NOW)])).toEqual([["5-hour", "resets in 2h 14m"], ["Weekly", "reset time not reported"]]);
    const later = NOW + 2 * H;
    expect(clockText(clockRows(clock, later)[0]!, later)).toBe("resets in 14m");
    const past = NOW + 3 * H;
    expect(clockText(clockRows(clock, past)[0]!, past)).toBe("reset passed, not yet confirmed");
  });

  test("an exhausted limit counts down, then reads 'should be available again' until a real reading", () => {
    const hit = entry({ exhausted: true, observed_at: NOW - 10 * MIN, resets_at: NOW + H });
    expect(clockAvailability([hit], null, NOW)).toEqual({ kind: "exhausted", until: NOW + H });
    expect(clockAvailability([hit], null, NOW + 2 * H)).toEqual({ kind: "available_unconfirmed", since: NOW + H });
    // A later reading with room confirms it: no longer "should be", just the reading.
    const fresh: AccountUsage = { at: NOW + 2 * H, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: 3, resets_at: NOW + 7 * H, window_s: 18_000, scope: null }] };
    const merged = mergeClock([hit], clockFromReading(fresh), NOW + 2 * H);
    expect(clockAvailability(merged, fresh, NOW + 2 * H)).toEqual({ kind: "none" });
    // An "unknown" reading after the reset confirms nothing.
    expect(clockAvailability([hit], unknownReading(NOW + 2 * H, "http_error"), NOW + 2 * H).kind).toBe("available_unconfirmed");
    // A reset time the provider never named keeps it "exhausted, time unknown", never invented.
    expect(clockAvailability([entry({ exhausted: true, resets_at: null })], null, NOW)).toEqual({ kind: "exhausted", until: null });
  });

  test("one model's limit does not mark the whole account out", () => {
    expect(clockAvailability([entry({ kind: "weekly_model", scope: "Opus", exhausted: true })], null, NOW)).toEqual({ kind: "none" });
  });
});

describe("walkie accounts prints the countdown", () => {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const base = (over: Partial<AccountView>): AccountView => ({
    key: "alex:a1c0ffee0000000000000001", id: "a1c0ffee0000000000000001", provider: "claude", label: "ae***@gm***.com", plan: "Max 20x",
    owners: ["alex"], claimed_by: [], machines: [{ node_id: "k0", hostname: "alex-mac", handle: "alex", online: true, self: true, agents: [], usage: null }],
    usage: null, usage_host: "alex-mac", last_seen: NOW, ...over,
  });

  test("no current reading: the remembered 5-hour and weekly resets, with the local time", () => {
    const out = plain(renderAccounts([base({
      usage: { at: NOW - 3 * H, state: "unknown", reason: "keychain_unavailable", source: "none", windows: [], until: null },
      clock: [entry(), entry({ kind: "weekly", window_s: 604_800, resets_at: NOW + 3 * 86_400_000 + 4 * H })],
    })], NOW, "UTC"));
    expect(out).toContain("usage unknown — Keychain did not answer without a prompt");
    expect(out).toMatch(/5-hour\s+resets in 2h 14m \(10:14 PM\)/);
    expect(out).toMatch(/Weekly\s+resets in 3d 4h \(Thu 12:00 AM\)/);
  });

  test("a limit whose reset passed: 'should be available again (not yet confirmed)'", () => {
    const out = plain(renderAccounts([base({
      usage: { at: NOW - 13 * H, state: "exhausted", reason: "limit_reached", source: "api", until: NOW - 12 * H, windows: [] },
      clock: [entry({ exhausted: true, observed_at: NOW - 13 * H, resets_at: NOW - 12 * H })],
    })], NOW, "UTC"));
    expect(out).toContain(`${AVAILABLE_UNCONFIRMED} — the limit reset at 8:00 AM; no reading since`);
    expect(out).toMatch(/5-hour\s+reset passed, not yet confirmed \(8:00 AM\)/);
  });

  test("a live reading: bars keep their countdown and add the local time", () => {
    const usage: AccountUsage = { at: NOW - MIN, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: 40, resets_at: NOW + 2 * H + 14 * MIN, window_s: 18_000, scope: null }] };
    expect(plain(renderAccounts([base({ usage, clock: clockFromReading(usage) })], NOW, "UTC"))).toContain("60%  ↻ 2h 14m (10:14 PM)");
  });

  test("absTime: today, this week, later", () => {
    expect(absTime(NOW + H, NOW, "UTC")).toBe("9:00 PM");
    expect(absTime(NOW + 2 * 86_400_000, NOW, "UTC")).toBe("Tue 8:00 PM");
    expect(absTime(NOW + 10 * 86_400_000, NOW, "UTC")).toBe("Oct 7, 8:00 PM");
  });
});

describe("unknown means unknown everywhere: a placeholder reset is never shown or scheduled on (pre.7 RC)", () => {
  // What an older (pre.7) Grok adapter published when its log named no reset: its time + 60 min.
  const legacy: AccountUsage = { at: NOW - 5 * MIN, state: "exhausted", reason: "limit_reached", source: "log", windows: [], until: NOW - 5 * MIN + 60 * MIN };
  const grok = (usage: AccountUsage): AccountView => ({
    key: "alex:g", id: "a1c0ffee00000000000000ff", provider: "grok", label: "al***@ex***.test", plan: null, owners: ["alex"], claimed_by: [],
    machines: [{ node_id: "n1", hostname: "alex-mac", handle: "alex", online: true, self: true, agents: [], usage }], usage, usage_host: "alex-mac", last_seen: NOW,
  });
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  test("usageUntil: the placeholder is unknown; a real reset (Claude/Codex, or a named Grok one) passes through", () => {
    expect(GUESSED_RESET_MS).toBe(GROK_EXHAUSTED_DEFAULT_MS);
    expect(usageUntil(legacy)).toBeNull();
    expect(usageUntil({ ...legacy, until: legacy.at + 17 * MIN })).toBe(legacy.at + 17 * MIN);
    expect(usageUntil({ ...legacy, source: "api" })).toBe(legacy.until);
  });

  test("the compact line (chips, tooltips) and `walkie accounts` say 'reset time not reported', never 'resets in 55m'", () => {
    expect(usageLine(grok(legacy), NOW)).toBe("exhausted · reset time not reported");
    const cli = plain(renderAccounts([grok(legacy)], NOW, "UTC"));
    expect(cli).toContain("exhausted · reset time not reported");
    expect(cli).not.toMatch(/resets in|55m/);
    expect(accountViewJson(grok(legacy)).usage?.until).toBeNull();
  });

  test("the router: neither a placeholder reading nor a guessed mark is reported as when an account frees", () => {
    const c = { id: "a".repeat(24), provider: "codex" as const, label: "x", owner: "alex", own: true, source: "local" as const, leases: 0 };
    const viaReading = select([{ ...c, usage: { ...legacy, at: NOW - MIN, until: NOW - MIN + 60 * MIN } }], { provider: "codex", now: NOW });
    expect(viaReading.excluded[0]).toMatchObject({ why: "limit reached", until: null });
    expect(viaReading.nextFree).toBeNull();
    const guessed = { state: "exhausted" as const, until: NOW + 50 * MIN, at: NOW - 10 * MIN, reason: "usage", guessed: true };
    const viaMark = select([{ ...c, usage: null, mark: guessed }], { provider: "codex", now: NOW });
    expect(viaMark.excluded[0]).toMatchObject({ until: null, atLimit: true });
    expect(viaMark.waitUntil).toBeNull();
    expect(viaMark.nextFree).toBeNull();
  });

  test("a guessed mark is published as exhausted with no reset time (never the placeholder)", () => {
    const home = freshHome();
    const wh = mkdtempSync(join(root, "wh-"));
    const svc = new AccountsService(wh, silent, () => undefined, { home, fetch: fakeFetch().fetch, keychain: noKeychain, clock: () => NOW, poll: false });
    svc.observe([{ agent: "cc-1", runtime: "claude-code" }]);
    const id = svc.snapshot().accounts[0]!.id;
    writeMark(wh, id, { state: "exhausted", until: NOW + UNKNOWN_RESET_MS - MIN, at: NOW - MIN, reason: "usage", guessed: true }, NOW);
    expect(svc.snapshot().accounts[0]!.usage).toMatchObject({ state: "exhausted", until: null });
    svc.stop();
  });
});

describe("pre.7 RC delta: the hold, the limit's own reset, provenance, the skew shift", () => {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const view = (usage: AccountUsage, provider: AccountView["provider"] = "codex"): AccountView => ({
    key: "alex:x", id: "a1c0ffee00000000000000fe", provider, label: "al***@ex***.test", plan: null, owners: ["alex"], claimed_by: [],
    machines: [{ node_id: "n1", hostname: "alex-mac", handle: "alex", online: true, self: true, agents: [], usage }], usage, usage_host: "alex-mac", last_seen: NOW,
  });

  test("an exhausted reading with no reported reset shows exhausted only for the 1-hour hold, in every renderer", () => {
    const u: AccountUsage = { at: NOW, state: "exhausted", reason: "limit_reached", source: "session", windows: [], until: null };
    expect(displayState(u, NOW + 30 * MIN)).toBe("exhausted");
    expect(displayState(u, NOW + 61 * MIN)).not.toBe("exhausted");
    expect(displayState(u, NOW + 72 * H)).toBe("unknown");
    expect(usageLine(view(u), NOW + 72 * H)).not.toContain("exhausted");
    expect(plain(renderAccounts([view(u)], NOW + 72 * H, "UTC"))).not.toContain("exhausted");
    expect(plain(renderAccounts([view(u)], NOW + 30 * MIN, "UTC"))).toContain("exhausted · reset time not reported");
  });

  test("the limit's unknown reset is not taken from another window: each window keeps its own countdown", () => {
    const five = { kind: "session" as const, used_pct: 20, resets_at: NOW + 2 * H, window_s: 18_000, scope: null };
    const u: AccountUsage = { at: NOW, state: "exhausted", reason: "limit_reached", source: "session", windows: [five], until: null };
    expect(usageLine(view(u), NOW)).toBe("exhausted · reset time not reported · 5-hour 80% left (resets in 2h 00m)");
    // A window that is itself at 100 % IS the limit: its reset is the limit's.
    const full = { ...u, windows: [{ ...five, used_pct: 100 }] };
    expect(usageLine(view(full), NOW)).toBe("exhausted · resets in 2h 00m · 5-hour 0% left (resets in 2h 00m)");
  });

  test("provenance: Grok's genuine 'try again in 60 minutes' is a reset; only legacy data without provenance is guessed", () => {
    const line = JSON.stringify({ ts: "2026-09-26T08:00:00Z", lvl: "error", msg: "shell.turn.inference_failed", ctx: { status_code: 429, message: "usage_limit_reached: try again in 60 minutes" } });
    const r = parseGrokLog(line) as NonNullable<ReturnType<typeof parseGrokLog>>;
    expect(r.until).toBe(r.at + 60 * MIN);
    expect(r.until_reported).toBe(true);
    expect(usageUntil(r)).toBe(r.at + 60 * MIN);
    expect(clockFromReading(r)[0]?.resets_at).toBe(r.at + 60 * MIN);
    expect(AccountUsage.parse(r).until_reported).toBe(true); // travels on the snapshot
    const { until_reported: _p, ...legacy } = r;
    expect(usageUntil(legacy)).toBeNull();
  });

  test("the skew shift drops an older peer's placeholder before moving times (a clamped `at` would hide it)", () => {
    const legacy: AccountUsage = { at: NOW + 30_000, state: "exhausted", reason: "limit_reached", source: "log", windows: [], until: NOW + 30_000 + 60 * MIN };
    const shifted = shiftUsage(legacy, -20_000, NOW) as AccountUsage;
    expect(shifted.until).toBeNull();
    const named: AccountUsage = { ...legacy, until_reported: true };
    expect((shiftUsage(named, -20_000, NOW) as AccountUsage).until).toBe(NOW + 50_000 + 60 * MIN);
  });
});

