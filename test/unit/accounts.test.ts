// WALKIE-ACCOUNTS-1 phase 1: adapters (parse fixtures), identities, the never-refresh guarantee, cadence/backoff,
// Grok reactive marking, peer-field validation and bounds, display rules, and the recording service.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeIdentityFrom, claudeTokenFrom, parseClaudeUsage, readClaudeToken } from "../../src/accounts/adapters/claude.ts";
import { codexIdentityFrom, parseCodexSessionTail, parseCodexUsage, passiveCodexReading } from "../../src/accounts/adapters/codex.ts";
import { grokIdentityFrom, grokReading, parseGrokLog, resetFromMessage } from "../../src/accounts/adapters/grok.ts";
import { kimiIdentityFromMe, parseKimiUsage, provisionalKimiIdentity } from "../../src/accounts/adapters/kimi.ts";
import { getUsageJson, isAllowedUsageUrl, USAGE_URLS } from "../../src/accounts/http.ts";
import { maskEmail } from "../../src/accounts/mask.ts";
import { FAST_POLL_MS, POLL_MS, pollAccount, type PollDeps } from "../../src/accounts/poll.ts";
import { AccountsService, loginFor } from "../../src/accounts/service.ts";
import type { Login } from "../../src/accounts/types.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { runtimeOf } from "../../src/daemon/discovery.ts";
import { accountJson, renderAccounts } from "../../src/cli/commands/accounts.ts";
import { displayState, leftPct, meterLevel, usageLine } from "../../src/protocol/accounts-format.ts";
import { AccountsSnapshot, MAX_ACCOUNTS_PER_NODE, type AccountSummary, type AccountView } from "../../src/protocol/accounts.ts";
import { PeerVvRes } from "../../src/protocol/schemas.ts";
import { fakeFetch, fixture, fixtureText, makeFakeHome, TOKENS } from "../helpers/accounts.ts";

const AT = Date.parse("2026-09-26T18:10:00Z");
const root = mkdtempSync("/tmp/walkie-accounts-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshHome = (o: Parameters<typeof makeFakeHome>[1] = {}) => makeFakeHome(join(root, `h${n++}`), o);

const lines: string[] = [];
const log: Logger = {
  debug: (m, f) => lines.push(JSON.stringify({ m, ...f })), info: (m, f) => lines.push(JSON.stringify({ m, ...f })),
  warn: (m, f) => lines.push(JSON.stringify({ m, ...f })), error: (m, f) => lines.push(JSON.stringify({ m, ...f })),
};
const noKeychain = async () => { throw new Error("TEST FAILURE: keychain read"); };
const login = (home: string, provider: Login["provider"]): Login =>
  loginFor({ runtime: provider === "claude" ? "claude-code" : provider }, home);

describe("adapters parse the live shapes", () => {
  test("Claude: limits[] wins; null code-named keys are ignored; session, weekly and weekly per model", () => {
    const r = parseClaudeUsage(fixture("claude-usage.json"), AT);
    expect(r.state).toBe("ok");
    expect(r.source).toBe("api");
    expect(r.windows).toEqual([
      { kind: "session", used_pct: 56, resets_at: Date.parse("2026-09-26T20:50:00.241Z"), window_s: 18_000, scope: null },
      { kind: "weekly", used_pct: 35, resets_at: Date.parse("2026-10-03T06:00:00.241Z"), window_s: 604_800, scope: null },
      { kind: "weekly_model", used_pct: 39, resets_at: Date.parse("2026-10-03T06:00:00.241Z"), window_s: 604_800, scope: "Fable" },
    ]);
  });

  test("Claude: without limits[], five_hour / seven_day / seven_day_opus; a full window is exhausted until its reset", () => {
    const r = parseClaudeUsage(fixture("claude-usage-legacy.json"), AT);
    expect(r.windows.map((w) => [w.kind, w.used_pct, w.scope])).toEqual([["session", 100, null], ["weekly", 80.5, null], ["weekly_model", 12, "Opus"]]);
    expect(r.state).toBe("exhausted");
    expect(r.until).toBe(Date.parse("2026-09-26T20:50:00Z"));
  });

  test("Claude: garbage and hostile scope names are dropped (a non-model name leaves the window unnamed)", () => {
    const r = parseClaudeUsage({ limits: [{ kind: "session", percent: "x" }, { kind: "weekly_scoped", group: "weekly", percent: 10, scope: { model: { display_name: "<img src=x>Opus" } } }, 7, null] }, AT);
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0]).toMatchObject({ kind: "other", scope: null });
    expect(parseClaudeUsage("nope", AT).windows).toEqual([]);
  });

  test("Codex: the primary window is labelled by its length (weekly here); a null secondary is skipped", () => {
    const r = parseCodexUsage(fixture("codex-usage.json"), AT);
    expect(r.windows).toEqual([{ kind: "weekly", used_pct: 13, resets_at: 1_791_046_693_000, window_s: 604_800, scope: null }]);
    expect(r.state).toBe("ok");
  });

  test("Codex: 5-hour primary + weekly secondary; limit_reached marks it exhausted", () => {
    const r = parseCodexUsage(fixture("codex-usage-limit.json"), AT);
    expect(r.windows.map((w) => [w.kind, w.used_pct])).toEqual([["session", 100], ["weekly", 64]]);
    expect(r.state).toBe("exhausted");
    expect(r.until).toBe(1_790_460_000_000);
  });

  test("Codex passive: the last token_count rate_limits in a session file (a cut first line is skipped)", () => {
    const r = parseCodexSessionTail(fixtureText("codex-session.jsonl"));
    expect(r?.source).toBe("session");
    expect(r?.at).toBe(Date.parse("2026-09-26T18:07:25.653Z"));
    expect(r?.windows).toEqual([{ kind: "weekly", used_pct: 13, resets_at: 1_791_046_693_000, window_s: 604_800, scope: null }]);
    expect(parseCodexSessionTail('{"payload":{"type":"agent_message"}}')).toBeNull();
  });

  test("Codex passive from a CODEX_HOME's newest session file of today", () => {
    const home = freshHome();
    const now = Date.now();
    const d = new Date(now);
    const dir = join(home, ".codex", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-2026-09-26T10-00-00-00000000-0000-4000-8000-000000000000.jsonl"), fixtureText("codex-session.jsonl"));
    expect(passiveCodexReading(login(home, "codex"), now)?.windows[0]?.used_pct).toBe(13);
  });

  test("Kimi: `usage` (weekly) and limits[] (5-hour) are trusted; the disagreeing `usages` block is ignored", () => {
    const r = parseKimiUsage(fixture("kimi-usages.json"), AT);
    expect(r.windows).toEqual([
      { kind: "session", used_pct: 1, resets_at: Date.parse("2026-09-26T21:06:10.540Z"), window_s: 18_000, scope: null },
      { kind: "weekly", used_pct: 6, resets_at: Date.parse("2026-10-03T01:06:10.540Z"), window_s: null, scope: null },
    ]);
  });
});

describe("identities (from the CLI's own files, never a token)", () => {
  test("Claude: stable id from account + org uuid, masked email, plan from the tier", () => {
    const a = claudeIdentityFrom(fixture("claude.json"));
    const b = claudeIdentityFrom(JSON.parse(fixtureText("claude.json")));
    expect(a).toEqual({ provider: "claude", id: expect.stringMatching(/^[0-9a-f]{24}$/), label: "de***@ex***.test", plan: "Max 20x" });
    expect(a?.id).toBe(b?.id as string);
    expect(claudeIdentityFrom({})).toBeNull();
  });

  test("Codex: account id + ChatGPT user id from the id_token claims; plan; email masked", () => {
    const id = codexIdentityFrom(fixture("codex-auth.json"));
    expect(id).toMatchObject({ provider: "codex", label: "de***@ex***.test", plan: "Pro" });
    expect(codexIdentityFrom({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x", tokens: null })).toBeNull();
  });

  test("Kimi: provisional per login until /me names the user", () => {
    const home = freshHome();
    const p = provisionalKimiIdentity(login(home, "kimi"));
    expect(p).toMatchObject({ provider: "kimi", pending: true, label: "Kimi account" });
    const real = kimiIdentityFromMe(fixture("kimi-me.json"));
    expect(real).toMatchObject({ provider: "kimi", label: "de***@ex***.test" });
    expect(real?.id).not.toBe(p?.id as string);
  });

  test("Grok: user_id + team_id + email only; an expired login without a refresh token is flagged", () => {
    const auth = fixture("grok-auth.json") as Record<string, Record<string, unknown>>;
    const g = grokIdentityFrom(auth, Date.parse("2026-09-26T10:00:00Z"));
    expect(g).toEqual({ provider: "grok", id: expect.stringMatching(/^[0-9a-f]{24}$/), label: "de***@ex***.test", plan: null });
    expect(grokIdentityFrom(auth, Date.parse("2026-09-26T13:00:00Z"))?.expired).toBeUndefined(); // refresh token present
    const noRefresh = Object.fromEntries(Object.entries(auth).map(([k, v]) => [k, { ...v, refresh_token: undefined }]));
    expect(grokIdentityFrom(noRefresh, Date.parse("2026-09-26T13:00:00Z"))?.expired).toBe(true);
    expect(JSON.stringify(g)).not.toContain("FIXTURE-GROK");
  });

  test("maskEmail never keeps more than two characters of either part", () => {
    expect(maskEmail("alice.walkerson@gmail.com")).toBe("al***@gm***.com");
    expect(maskEmail("a@b.io")).toBe("a***@b***.io");
    expect(maskEmail("not-an-email")).toBeNull();
    expect(maskEmail("<x>@y.z")).toBe("x***@y***.z");
  });
});

describe("never refresh, fixed endpoints only", () => {
  const deps = (f: ReturnType<typeof fakeFetch>, now = Date.now()): PollDeps => ({ fetch: f.fetch, keychain: noKeychain, now, keychainBlockedUntil: 0 });

  test("getUsageJson refuses anything but the usage endpoints without making a request", async () => {
    const f = fakeFetch();
    for (const url of ["https://console.anthropic.com/v1/oauth/token", "https://auth.openai.com/oauth/token", "https://api.kimi.com/coding/v1/oauth/refresh", "https://api.anthropic.com/api/oauth/usage?x=1", "http://api.anthropic.com/api/oauth/usage"]) {
      expect(isAllowedUsageUrl(url)).toBe(false);
      await expect(getUsageJson(f.fetch, url, {}, "s")).rejects.toThrow("refused");
    }
    expect(f.calls).toEqual([]);
  });

  test("each provider requests exactly its usage endpoint (Kimi: /me once, then usages); every call is GET, no redirects", async () => {
    const home = freshHome();
    const f = fakeFetch();
    const now = Date.now();
    const claude = await pollAccount("claude", login(home, "claude"), claudeIdentityFrom(fixture("claude.json"))!, null, 0, deps(f, now));
    const codex = await pollAccount("codex", login(home, "codex"), codexIdentityFrom(fixture("codex-auth.json"))!, null, 0, deps(f, now));
    const kimi = await pollAccount("kimi", login(home, "kimi"), provisionalKimiIdentity(login(home, "kimi"))!, null, 0, deps(f, now));
    const grok = await pollAccount("grok", login(home, "grok"), grokIdentityFrom(fixture("grok-auth.json"), now)!, null, 0, deps(f, now));
    expect(f.calls).toEqual([USAGE_URLS.claude, USAGE_URLS.codex, USAGE_URLS.kimiMe, USAGE_URLS.kimi]);
    expect(claude.reading?.windows).toHaveLength(3);
    expect(codex.reading?.windows[0]?.kind).toBe("weekly");
    expect(kimi.identity?.label).toBe("de***@ex***.test");
    expect(grok.reading?.state).toBe("unknown"); // expired 2026-09-26 12:16Z, but it has a refresh token (the CLI renews it)
  });

  test("a token expiring within 2 minutes is not used and not refreshed: no request at all", async () => {
    const now = Date.now();
    const home = freshHome({ claudeExpiresAt: now + 90_000, codexExpiresAt: now + 60_000, kimiExpiresAt: now - 1 });
    const f = fakeFetch();
    for (const p of ["claude", "codex", "kimi"] as const) {
      const ident = p === "claude" ? claudeIdentityFrom(fixture("claude.json"))! : p === "codex" ? codexIdentityFrom(fixture("codex-auth.json"))! : provisionalKimiIdentity(login(home, "kimi"))!;
      const r = await pollAccount(p, login(home, p), ident, null, 0, deps(f, now));
      expect(r.reading).toMatchObject({ state: "unknown", reason: "token_expiring" });
      expect(r.nextInMs).toBe(FAST_POLL_MS);
    }
    expect(f.calls).toEqual([]);
  });

  test("an expired login whose refresh token has expired too needs a re-login (no request)", async () => {
    const now = Date.now();
    const home = freshHome({ claudeExpiresAt: now - 3_600_000, claudeRefreshExpiresAt: now - 1 });
    const f = fakeFetch();
    const r = await pollAccount("claude", login(home, "claude"), claudeIdentityFrom(fixture("claude.json"))!, null, 0, deps(f, now));
    expect(r.reading).toMatchObject({ state: "relogin", reason: "login_expired" });
    expect(f.calls).toEqual([]);
  });

  test("the Keychain is read only for the default config dir, and a timeout blocks it for 6 h (never prompts again)", async () => {
    const home = join(root, "kc");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), fixtureText("claude.json"));
    const asked: string[] = [];
    const t = await readClaudeToken(login(home, "claude"), async (s) => { asked.push(s); return "timeout"; });
    expect(t).toBe("keychain_unavailable");
    expect(asked).toEqual(["Claude Code-credentials"]);
    const f = fakeFetch();
    const r = await pollAccount("claude", login(home, "claude"), claudeIdentityFrom(fixture("claude.json"))!, null, 0, { fetch: f.fetch, keychain: async () => "timeout", now: 1_000, keychainBlockedUntil: 0 });
    expect(r.keychainBlockedUntil).toBe(1_000 + 6 * 3_600_000);
    expect(r.reading?.reason).toBe("keychain_unavailable");
    const custom = loginFor({ runtime: "claude-code", login_dir: join(root, "elsewhere") }, home);
    expect(custom.isDefault).toBe(false);
    expect(await readClaudeToken(custom, async () => { throw new Error("TEST FAILURE: keychain for a custom dir"); })).toBe("none");
    expect(claudeTokenFrom("{}")).toBeNull();
  });
});

describe("cadence and failures", () => {
  test("5 min normally, 60 s once a window is ≥ 80 % used", async () => {
    const home = freshHome();
    const f = fakeFetch();
    const d = { fetch: f.fetch, keychain: noKeychain, now: Date.now(), keychainBlockedUntil: 0 };
    expect((await pollAccount("claude", login(home, "claude"), claudeIdentityFrom(fixture("claude.json"))!, null, 0, d)).nextInMs).toBe(POLL_MS);
    f.respond.set(USAGE_URLS.claude, () => Response.json({ limits: [{ kind: "session", group: "session", percent: 81, resets_at: null }] }));
    expect((await pollAccount("claude", login(home, "claude"), claudeIdentityFrom(fixture("claude.json"))!, null, 0, d)).nextInMs).toBe(FAST_POLL_MS);
  });

  test("429 / 5xx back off (5 → 10 → 20 → 30 min) and keep the previous reading; 401 needs a re-login; errors are scrubbed", async () => {
    const home = freshHome();
    const f = fakeFetch();
    const d = { fetch: f.fetch, keychain: noKeychain, now: Date.now(), keychainBlockedUntil: 0 };
    const ident = claudeIdentityFrom(fixture("claude.json"))!;
    const prev = parseClaudeUsage(fixture("claude-usage.json"), d.now - 60_000);
    f.respond.set(USAGE_URLS.claude, () => new Response(`slow down ${TOKENS.claude}`, { status: 429 }));
    let backoff = 0;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await pollAccount("claude", login(home, "claude"), ident, prev, backoff, d);
      expect(r.reading).toBeNull();
      expect(r.error).not.toContain(TOKENS.claude);
      backoff = r.backoffMs;
      seen.push(r.nextInMs / 60_000);
    }
    expect(seen).toEqual([5, 10, 20, 30]);
    const first = await pollAccount("claude", login(home, "claude"), ident, null, 0, d);
    expect(first.reading).toMatchObject({ state: "unknown", reason: "rate_limited" });
    f.respond.set(USAGE_URLS.claude, () => new Response("{}", { status: 503 }));
    expect((await pollAccount("claude", login(home, "claude"), ident, null, 0, d)).reading?.reason).toBe("http_error");
    f.respond.set(USAGE_URLS.claude, () => new Response("{}", { status: 401 }));
    expect((await pollAccount("claude", login(home, "claude"), ident, prev, 0, d)).reading).toMatchObject({ state: "relogin", reason: "login_expired" });
  });

  test("Codex falls back to its session files while the endpoint fails", async () => {
    const home = freshHome();
    const now = Date.now();
    const dt = new Date(now);
    const dir = join(home, ".codex", "sessions", String(dt.getFullYear()), String(dt.getMonth() + 1).padStart(2, "0"), String(dt.getDate()).padStart(2, "0"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-x.jsonl"), fixtureText("codex-session.jsonl"));
    const f = fakeFetch();
    f.respond.set(USAGE_URLS.codex, () => new Response("{}", { status: 502 }));
    const r = await pollAccount("codex", login(home, "codex"), codexIdentityFrom(fixture("codex-auth.json"))!, null, 0, { fetch: f.fetch, keychain: noKeychain, now, keychainBlockedUntil: 0 });
    expect(r.reading?.source).toBe("session");
  });
});

describe("Grok: reactive marking (no usage API, no token read)", () => {
  const g = (_now: number) => grokIdentityFrom(fixture("grok-auth.json"), Date.parse("2026-09-26T10:00:00Z"))!;
  test("a 402 'usage balance exhausted' failure marks it exhausted for 60 min (a hold, not a reported reset: until null)", () => {
    const r = parseGrokLog(fixtureText("grok-unified.jsonl"));
    expect(r).toMatchObject({ state: "exhausted", reason: "limit_reached", source: "log", until: null });
    expect(r?.at).toBe(Date.parse("2026-09-26T06:16:14.554Z"));
  });

  test("a reset time in the message wins; usage_limit_reached / usage_pool_exhausted / rate_limited count too", () => {
    expect(resetFromMessage("usage_limit_reached: try again in 30 minutes", 1_000)).toBe(1_000 + 30 * 60_000);
    expect(resetFromMessage("pool exhausted, resets at 2026-09-27T00:00:00Z", 0)).toBe(Date.parse("2026-09-27T00:00:00Z"));
    for (const marker of ["usage_limit_reached", "usage_pool_exhausted", "rate_limited"]) {
      const line = JSON.stringify({ ts: "2026-09-26T08:00:00Z", lvl: "error", msg: "shell.turn.inference_failed", ctx: { error_type: marker, message: `sampler said ${marker}` } });
      expect(parseGrokLog(line)?.state).toBe("exhausted");
    }
    expect(parseGrokLog(JSON.stringify({ ts: "2026-09-26T08:00:00Z", lvl: "info", msg: "subagent turn rate limited; waiting" }))).toBeNull();
  });

  test("tile states: exhausted while the window lasts, then unknown (no usage API); an expired login needs a re-login", () => {
    const home = freshHome();
    const l = login(home, "grok");
    const ident = g(0);
    expect(grokReading(l, ident, Date.parse("2026-09-26T06:30:00Z")).state).toBe("exhausted");
    expect(grokReading(l, ident, Date.parse("2026-09-26T09:00:00Z"))).toMatchObject({ state: "unknown", reason: "no_usage_api" });
    expect(grokReading(l, { ...ident, expired: true }, Date.parse("2026-09-26T09:00:00Z"))).toMatchObject({ state: "relogin", reason: "login_expired" });
  });
});

describe("discovery finds Grok sessions", () => {
  test("the grok CLI (installed name or downloaded binary) is a session; its login/update subcommands are not", () => {
    expect(runtimeOf("grok")).toBe("grok");
    expect(runtimeOf("/Users/x/.grok/downloads/grok-1.0.40-macos-aarch64 --model grok-4.6")).toBe("grok");
    expect(runtimeOf("grok login")).toBeNull();
    expect(runtimeOf("grok-pager")).toBeNull();
    expect(runtimeOf("claude")).toBe("claude-code");
  });
});

describe("peer field: validated and bounded", () => {
  const acct = (i: number, over: Partial<AccountSummary> = {}): AccountSummary => ({
    id: i.toString(16).padStart(24, "0"), provider: "claude", label: "de***@ex***.test", plan: "Max 20x", agents: ["cc-1a2b3c"],
    usage: { at: 1, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: 40, resets_at: 2, window_s: 18_000, scope: null }] },
    last_seen: 1, ...over,
  });
  const vv = (accounts: unknown) => PeerVvRes.parse({ node: "a1b2c3d4e5f60718", vv: {}, ts: 1, accounts });

  test("a valid snapshot passes; a v0.1.3 answer without it is fine", () => {
    expect(vv({ at: 1, accounts: [acct(1)] }).accounts?.accounts).toHaveLength(1);
    expect(PeerVvRes.parse({ node: "x", vv: {}, ts: 1 }).accounts).toBeUndefined();
  });

  test("malformed or oversized values are dropped without failing the sync", () => {
    const bad = [
      { at: 1, accounts: Array.from({ length: MAX_ACCOUNTS_PER_NODE + 1 }, (_, i) => acct(i)) },
      { at: 1, accounts: [acct(1, { label: "<script>alert(1)</script>" })] },
      { at: 1, accounts: [acct(1, { id: "not-hex" })] },
      { at: 1, accounts: [acct(1, { provider: "openrouter" as never })] },
      { at: 1, accounts: [acct(1, { agents: ["Bad Name"] })] },
      { at: 1, accounts: [acct(1, { usage: { ...acct(1).usage!, windows: [{ kind: "session", used_pct: 140, resets_at: 1, window_s: 1, scope: null }] } })] },
      { at: 1, accounts: [acct(1, { usage: { ...acct(1).usage!, state: "hacked" as never } })] },
      { at: 1, accounts: [acct(1, { usage: { ...acct(1).usage!, windows: Array.from({ length: 7 }, () => acct(1).usage!.windows[0]!) } })] },
      { at: 1, accounts: [acct(1, { label: "x".repeat(49) })] },
      { at: 1, accounts: [{ ...acct(1), token: ("sk" + "-ant-oat01-smuggled") }] },
      "junk",
    ];
    for (const b of bad) {
      const parsed = vv(b);
      expect(parsed.node).toBe("a1b2c3d4e5f60718");
      // Unknown keys are stripped (the smuggled token never survives); everything else malformed drops the field.
      expect(JSON.stringify(parsed)).not.toContain("smuggled");
      if (b !== bad[9]) expect(parsed.accounts).toBeUndefined();
    }
  });
});

describe("display rules", () => {
  test("meter bands on what is left: green ≥ 30, amber 10–30, red < 10", () => {
    expect(leftPct({ used_pct: 62 })).toBe(38);
    expect([meterLevel(30), meterLevel(29), meterLevel(10), meterLevel(9)]).toEqual(["green", "amber", "amber", "red"]);
  });

  test("states: ok, stale after 15 min, unknown after 60 min or without a reading, exhausted until reset, relogin", () => {
    const now = 10 * 3_600_000;
    const u = (over = {}) => ({ at: now - 60_000, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [{ kind: "session" as const, used_pct: 20, resets_at: now + 1, window_s: null, scope: null }], ...over });
    expect(displayState(u(), now)).toBe("ok");
    expect(displayState(u({ at: now - 16 * 60_000 }), now)).toBe("stale");
    expect(displayState(u({ at: now - 61 * 60_000 }), now)).toBe("unknown");
    expect(displayState(null, now)).toBe("unknown");
    expect(displayState(u({ state: "exhausted", until: now + 60_000 }), now)).toBe("exhausted");
    expect(displayState(u({ state: "exhausted", until: now - 1 }), now)).toBe("ok");
    expect(displayState(u({ state: "relogin" }), now)).toBe("relogin");
    expect(usageLine({ provider: "claude", usage: u() }, now)).toBe("5-hour 80% left (resets in 1m)");
  });
});

describe("recording service", () => {
  test("records the accounts running sessions use, maps agents, persists without tokens, and forgets after 7 days", async () => {
    const home = freshHome();
    const walkieHome = join(root, "wh");
    mkdirSync(walkieHome, { recursive: true });
    const f = fakeFetch();
    let clock = Date.now();
    const snaps: string[] = [];
    const svc = new AccountsService(walkieHome, log, (s) => snaps.push(JSON.stringify(s)), { home, fetch: f.fetch, keychain: noKeychain, clock: () => clock });
    svc.observe([
      { agent: "cc-1a2b3c", runtime: "claude-code" }, { agent: "cc-4d5e6f", runtime: "claude-code" },
      { agent: "codex-0192ab", runtime: "codex" }, { agent: "kimi-pid7", runtime: "kimi" }, { agent: "grok-pid9", runtime: "grok" },
      { agent: "Not A Valid Name", runtime: "claude-code" },
    ]);
    let s = svc.snapshot();
    expect(AccountsSnapshot.safeParse(s).success).toBe(true);
    expect(s.accounts.map((a) => a.provider).sort()).toEqual(["claude", "codex", "grok", "kimi"]);
    expect(s.accounts.find((a) => a.provider === "claude")?.agents).toEqual(["cc-1a2b3c", "cc-4d5e6f"]);
    expect(s.accounts.find((a) => a.provider === "kimi")?.usage?.reason).toBe("identity_pending");
    await svc.tick();
    s = svc.snapshot();
    const kimi = s.accounts.find((a) => a.provider === "kimi");
    expect(kimi?.label).toBe("de***@ex***.test"); // /me identified it; the provisional record was replaced
    expect(kimi?.agents).toEqual(["kimi-pid7"]);
    expect(s.accounts.find((a) => a.provider === "claude")?.usage?.windows).toHaveLength(3);
    expect(f.calls.every(isAllowedUsageUrl)).toBe(true);
    const file = join(walkieHome, "accounts.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = readFileSync(file, "utf8");
    for (const secret of [TOKENS.claude, TOKENS.codexSecret, TOKENS.kimi, "FIXTURE-GROK", "dev.claude@example.test", "REFRESH"]) {
      expect(saved).not.toContain(secret);
      expect(snaps.join("\n")).not.toContain(secret);
      expect(lines.join("\n")).not.toContain(secret);
    }
    // A restart keeps the records (and the Kimi alias) without any session running.
    const again = new AccountsService(walkieHome, log, () => undefined, { home, fetch: f.fetch, keychain: noKeychain, clock: () => clock, poll: false });
    expect(again.snapshot().accounts.map((a) => a.id).sort()).toEqual(s.accounts.map((a) => a.id).sort());
    again.observe([{ agent: "kimi-pid8", runtime: "kimi" }]);
    expect(again.snapshot().accounts.find((a) => a.provider === "kimi")?.agents).toEqual(["kimi-pid8"]);
    // Sessions gone: agents cleared; 7 days later the records are forgotten.
    svc.observe([]);
    expect(svc.snapshot().accounts.every((a) => a.agents.length === 0)).toBe(true);
    clock += 8 * 86_400_000;
    svc.observe([]);
    expect(svc.snapshot().accounts).toEqual([]);
  });
});

describe("walkie accounts output", () => {
  const now = Date.parse("2026-09-26T18:00:00Z");
  const usage = { at: now - 60_000, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [
    { kind: "session" as const, used_pct: 62, resets_at: now + 2 * 3_600_000, window_s: 18_000, scope: null },
    { kind: "weekly" as const, used_pct: 35, resets_at: now + 3 * 86_400_000, window_s: 604_800, scope: null },
  ] };
  const view = (over = {}): AccountView => ({
    key: "alex:a1c0ffee0000000000000001", id: "a1c0ffee0000000000000001", provider: "claude" as const, label: "de***@ex***.test", plan: "Max 20x", owners: ["alex"], claimed_by: [],
    machines: [{ node_id: "a1b2c3d4e5f60718", hostname: "alex-mbp", handle: "alex", online: true, self: true, agents: ["cc-1a2b3c"], usage }],
    usage, usage_host: "alex-mbp", last_seen: now, ...over,
  });
  test("people see a meter per window with what is left; re-login shows the step", () => {
    const out = renderAccounts([view()], now);
    expect(out).toContain("Claude de***@ex***.test");
    expect(out).toContain("38%");
    expect(out).toContain("65%");
    expect(out).toContain("[AL] alex/alex-mbp (1)");
    const relogin = renderAccounts([view({ provider: "codex", usage: { at: now, state: "relogin", reason: "login_expired", source: "none", until: null, windows: [] } })], now);
    expect(relogin).toContain("needs re-login — On alex-mbp: run `codex login`");
    expect(renderAccounts([], now)).toContain("No accounts recorded yet");
    expect(renderAccounts([view({ claimed_by: ["mallory"] })], now)).toContain("also reported by mallory (unverified, listed separately)");
  });
  test("--json for a model: rebuilt from an allowlist, left_pct added, labels validated, trust + provenance", () => {
    const j = accountJson(view({ label: "de***@ex***.test" }));
    expect(j).toMatchObject({ provider: "claude", label: "de***@ex***.test", trust: "team-member", usage: { state: "ok", windows: [{ kind: "session", left_pct: 38 }, { kind: "weekly", left_pct: 65 }] } });
    expect(Object.keys(j).sort()).toEqual(["claimed_by", "clock", "id", "key", "label", "machines", "owners", "plan", "provider", "reported_by", "trust", "usage", "usage_host"]);
  });
});
