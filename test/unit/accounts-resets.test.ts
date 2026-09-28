// WALKIE-ACCOUNTS-RESET-1/2: limit resets. The Codex count parsed from the usage poll, the peer field's bounds, the
// Codex app-server redemption (against a FAKE app-server: no real reset is ever used by a test), daemon-minted
// attempts bound to the confirmed account (a login switch at any point sends nothing), unconfirmed attempts kept and
// reconciled across retries and restarts, Retry-After holds, and the app-server's process group ended.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexUsage } from "../../src/accounts/adapters/codex.ts";
import { getUsageJson, USAGE_URLS, UsageHttpError } from "../../src/accounts/http.ts";
import { pollAccount } from "../../src/accounts/poll.ts";
import { pickCredit, redeemCodexReset, RpcError, stdioSession, type AppServerLauncher, type RedeemPlan } from "../../src/accounts/resets.ts";
import { AccountActionError, AccountsService, loginFor } from "../../src/accounts/service.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { nextWindowReset, resetOutcomeText, resetsDisplay, resetsText } from "../../src/protocol/accounts-format.ts";
import { AccountUsage } from "../../src/protocol/accounts.ts";
import { fakeFetch, fixture, makeFakeHome } from "../helpers/accounts.ts";

const ACCOUNT = "00000000-1111-4222-8333-444444444444"; // codex-auth.json tokens.account_id
const REQ = "5d0c7a2e-1f6b-4b8e-9a51-0c2f3b4d5e6f";
const root = mkdtempSync("/tmp/walkie-resets-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshHome = () => makeFakeHome(join(root, `h${n++}`));
const lines: string[] = [];
const log: Logger = {
  debug: (m, f) => lines.push(JSON.stringify({ m, ...f })), info: (m, f) => lines.push(JSON.stringify({ m, ...f })),
  warn: (m, f) => lines.push(JSON.stringify({ m, ...f })), error: (m, f) => lines.push(JSON.stringify({ m, ...f })),
};
const noKeychain = async () => { throw new Error("TEST FAILURE: keychain read"); };

interface FakeOpts {
  accountId?: string | null;
  available?: number | null;
  credits?: unknown[] | null;
  consume?: (params: Record<string, unknown>) => unknown;
  failLaunch?: boolean;
  failInit?: boolean;
  failRead?: boolean;
  gate?: Promise<void>;
  /** Runs when the app-server is asked for the limits (a login switch at that moment, say). */
  onRead?: () => void;
}

/** A fake `codex app-server`: records every call, never talks to OpenAI. */
function fakeCodex(o: FakeOpts = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const state = { launches: 0, closed: 0 };
  const launcher: AppServerLauncher = async () => {
    state.launches++;
    if (o.failLaunch) throw new RpcError("not_found");
    return {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "initialize") { if (o.failInit) throw new RpcError("rpc_error"); return { userAgent: "codex/fake" }; }
        if (method === "account/rateLimits/read") {
          o.onRead?.();
          if (o.failRead) throw new RpcError("rpc_error");
          return {
            accountId: o.accountId === undefined ? ACCOUNT : o.accountId,
            rateLimitResetCredits: o.available === null ? null : { availableCount: o.available ?? 2, credits: o.credits === undefined ? null : o.credits },
          };
        }
        if (method === "account/rateLimitResetCredit/consume") {
          if (o.gate) await o.gate;
          return o.consume ? o.consume(params as Record<string, unknown>) : { outcome: "reset" };
        }
        throw new Error(`TEST FAILURE: unexpected method ${method}`);
      },
      notify(method) { calls.push({ method, params: undefined }); },
      close() { state.closed++; },
    };
  };
  const consumes = () => calls.filter((c) => c.method === "account/rateLimitResetCredit/consume");
  return { launcher, calls, state, consumes };
}

const AT = Date.parse("2026-09-26T18:10:00Z");
const codexLogin = (home: string) => loginFor({ runtime: "codex" }, home);

describe("the count comes from the usage poll Walkie already makes", () => {
  test("Codex rate_limit_reset_credits → resets; absent → not reported; malformed ignored; capped at 99", () => {
    const body = fixture("codex-usage.json") as Record<string, unknown>;
    expect(parseCodexUsage(body, AT).resets).toBeUndefined();
    expect(parseCodexUsage({ ...body, rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 } }, AT).resets).toEqual({ available: 1, applicable: 0 });
    expect(parseCodexUsage({ ...body, rate_limit_reset_credits: { available_count: 3 } }, AT).resets).toEqual({ available: 3, applicable: null });
    expect(parseCodexUsage({ ...body, rate_limit_reset_credits: { available_count: 500, applicable_available_count: 400 } }, AT).resets).toEqual({ available: 99, applicable: 99 });
    expect(parseCodexUsage({ ...body, rate_limit_reset_credits: { available_count: -1 } }, AT).resets).toBeUndefined();
    expect(parseCodexUsage({ ...body, rate_limit_reset_credits: "lots" }, AT).resets).toBeUndefined();
  });

  test("a peer's resets are bounded integers; the field is optional (older peers omit it)", () => {
    const u = { at: AT, state: "ok", reason: null, source: "api", windows: [], until: null };
    expect(AccountUsage.safeParse(u).success).toBe(true);
    expect(AccountUsage.safeParse({ ...u, resets: { available: 2, applicable: null } }).success).toBe(true);
    for (const bad of [{ available: 100, applicable: null }, { available: 1.5, applicable: null }, { available: -1, applicable: 0 }, { available: 1 }, { available: "1", applicable: null }]) {
      expect(AccountUsage.safeParse({ ...u, resets: bad }).success).toBe(false);
    }
    // Unknown keys inside it are stripped, never republished.
    const parsed = AccountUsage.parse({ ...u, resets: { available: 1, applicable: 0, credit_id: "RateLimitResetCredit_x" } });
    expect(JSON.stringify(parsed)).not.toContain("credit_id");
  });

  test("a session-file reading keeps the last API reading's count (a session file says nothing about resets)", async () => {
    const home = freshHome();
    const f = fakeFetch();
    f.respond.set(USAGE_URLS.codex, () => new Response("{}", { status: 503 }));
    const prev = { ...parseCodexUsage(fixture("codex-usage.json"), AT - 60_000), resets: { available: 2, applicable: 1 } };
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const d = new Date(AT);
    const dir = join(home, ".codex", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ timestamp: new Date(AT).toISOString(), payload: { type: "token_count", rate_limits: { primary: { used_percent: 40, window_minutes: 300, resets_in_seconds: 3600 } } } });
    writeFileSync(join(dir, "rollout-x.jsonl"), line + "\n");
    const r = await pollAccount("codex", codexLogin(home), { provider: "codex", id: "x", label: "ChatGPT account", plan: null }, prev, 0, { fetch: f.fetch, keychain: noKeychain, now: AT, keychainBlockedUntil: 0 });
    expect(r.reading?.source).toBe("session");
    expect(r.reading?.resets).toEqual({ available: 2, applicable: 1 });
  });
});

const ok = (over: Partial<RedeemPlan> = {}): RedeemPlan => ({
  chatgptAccount: ACCOUNT, key: REQ, afterUnconfirmed: false, creditId: null, stillBound: () => true, onCredit: () => true, ...over,
});

/** Rewrites a fake home's Codex login as another ChatGPT account (a login switch). */
function switchLogin(home: string, account = "99999999-1111-4222-8333-444444444444"): void {
  const p = join(home, ".codex", "auth.json");
  const auth = JSON.parse(readFileSync(p, "utf8"));
  writeFileSync(p, JSON.stringify({ ...auth, tokens: { ...auth.tokens, account_id: account } }));
}
/** Changes the login's email and sign-in mode, same ChatGPT account and user (RESET-3: still the same account). */
function changeEmail(home: string): void {
  const p = join(home, ".codex", "auth.json");
  const auth = JSON.parse(readFileSync(p, "utf8"));
  const [h, body, sig] = String(auth.tokens.id_token).split(".");
  const claims = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8"));
  const id = `${h}.${Buffer.from(JSON.stringify({ ...claims, email: "renamed@example.test" })).toString("base64url")}.${sig}`;
  writeFileSync(p, JSON.stringify({ ...auth, auth_mode: "chatgpt-other", tokens: { ...auth.tokens, id_token: id } }));
}
/** Rewrites the access token only (what Codex does on every refresh): the same account. */
function refreshToken(home: string): void {
  const p = join(home, ".codex", "auth.json");
  const auth = JSON.parse(readFileSync(p, "utf8"));
  writeFileSync(p, JSON.stringify({ ...auth, tokens: { ...auth.tokens, access_token: `${auth.tokens.access_token}x` } }));
}

describe("Retry-After survives a response body that can't be read (Codex r3 LOW 2)", () => {
  const url = USAGE_URLS.codex;
  const hdr = { "Retry-After": "3600", "Content-Type": "application/json" };
  test("oversized body", async () => {
    const big = "x".repeat(300 * 1024);
    const f = async () => new Response(big, { status: 429, headers: hdr });
    const err = (await getUsageJson(f, url, {}, "secret").catch((e: unknown) => e)) as UsageHttpError;
    expect(err).toBeInstanceOf(UsageHttpError);
    expect(err.retryAfterMs).toBe(3_600_000);
  });
  test("interrupted body", async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); c.error(new Error("reset")); } });
    const f = async () => new Response(body, { status: 429, headers: hdr });
    const err = (await getUsageJson(f, url, {}, "secret").catch((e: unknown) => e)) as UsageHttpError;
    expect(err).toBeInstanceOf(UsageHttpError);
    expect(err.retryAfterMs).toBe(3_600_000);
  });
  test("a readable 429 keeps it too; a 200 carries none", async () => {
    expect((await getUsageJson(async () => new Response("{}", { status: 429, headers: hdr }), url, {}, "s").catch((e: unknown) => e as UsageHttpError) as UsageHttpError).retryAfterMs).toBe(3_600_000);
    expect(await getUsageJson(async () => new Response("{}", { status: 200, headers: hdr }), url, {}, "s")).toEqual({});
  });
});

describe("display", () => {
  const base = { at: AT, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [] };
  test("the three states", () => {
    expect(resetsText("codex", resetsDisplay({ ...base, resets: { available: 2, applicable: 1 } }))).toBe("Resets available: 2");
    expect(resetsText("codex", resetsDisplay({ ...base, resets: { available: 0, applicable: 0 } }))).toBe("No resets available");
    expect(resetsText("claude", resetsDisplay(base))).toBe("Not reported by Claude");
    expect(resetsText("kimi", resetsDisplay(null))).toBe("Not reported by Kimi");
  });
  test("when the current window resets: the soonest future reset", () => {
    const u = { ...base, windows: [
      { kind: "weekly" as const, used_pct: 10, resets_at: AT + 3 * 86_400_000, window_s: null, scope: null },
      { kind: "session" as const, used_pct: 60, resets_at: AT + 2 * 3_600_000 + 5 * 60_000, window_s: 18_000, scope: null },
    ] };
    expect(nextWindowReset(u, AT)).toBe("5-hour window resets in 2h 05m");
    expect(nextWindowReset(base, AT)).toBe("");
  });
  test("outcome texts say whether anything was used and whether a retry is safe", () => {
    expect(resetOutcomeText({ outcome: "reset", left: 1 })).toMatchObject({ tone: "ok", retry: false });
    expect(resetOutcomeText({ outcome: "reset", left: 1 }).text).toContain("1 reset left");
    expect(resetOutcomeText({ outcome: "unconfirmed", left: null })).toMatchObject({ tone: "bad", retry: true });
    expect(resetOutcomeText({ outcome: "unconfirmed", left: null }).text).toContain("can't use a second reset");
    // A retry that found the earlier try went through never says "nothing was used" (Codex MEDIUM 4).
    expect(resetOutcomeText({ outcome: "already_used", left: 0 }).text).not.toMatch(/nothing was used/i);
    expect(resetOutcomeText({ outcome: "check_usage", left: null }).text).toContain("An earlier attempt may have gone through");
    expect(resetOutcomeText({ outcome: "failed", left: null, failure: "not_signed_in" }).text).toContain("codex login");
    expect(resetOutcomeText({ outcome: "failed", left: null, failure: "unreachable" }).text).toContain("Couldn't reach Codex");
    expect(resetOutcomeText({ outcome: "failed", left: null, failure: "codex_missing" }).text).toContain("isn't installed");
    for (const o of ["not_needed", "none", "login_changed", "unverified", "busy"] as const) expect(resetOutcomeText({ outcome: o, left: null }).text).toMatch(/Nothing|nothing (more )?was sent/);
  });
});

describe("redeemCodexReset (fake app-server)", () => {
  const login = codexLogin(join(root, "unused"));

  test("success: initialize, read, consume with the attempt id as idempotency key and the first live credit", async () => {
    const fx = fakeCodex({ available: 2, credits: [
      { id: "C_expired", resetType: "codexRateLimits", status: "available", grantedAt: 1, expiresAt: Math.floor(AT / 1000) - 10 },
      { id: "C_used", resetType: "codexRateLimits", status: "redeemed", grantedAt: 1, expiresAt: null },
      { id: "C_good", resetType: "codexRateLimits", status: "available", grantedAt: 1, expiresAt: Math.floor(AT / 1000) + 86_400 },
    ] });
    const named: Array<string | null> = [];
    const r = await redeemCodexReset(fx.launcher, login, ok({ onCredit: (c) => { named.push(c); return true; } }), AT);
    expect(r).toEqual({ outcome: "reset", left: 1 });
    expect(fx.calls.map((c) => c.method)).toEqual(["initialize", "initialized", "account/rateLimits/read", "account/rateLimitResetCredit/consume"]);
    expect(fx.consumes()[0]?.params).toEqual({ idempotencyKey: REQ, creditId: "C_good" });
    expect(named).toEqual(["C_good"]); // told BEFORE the use is sent
    expect(fx.state.closed).toBe(1);
  });

  test("credits without details: the backend picks (no creditId)", async () => {
    const fx = fakeCodex({ available: 1, credits: null });
    expect(await redeemCodexReset(fx.launcher, login, ok(), AT)).toEqual({ outcome: "reset", left: 0 });
    expect(fx.consumes()[0]?.params).toEqual({ idempotencyKey: REQ });
  });

  test("nothing is sent: none available, only expired, another account, no account named (fail closed), not reported", async () => {
    for (const [o, want] of [
      [{ available: 0 }, "none"],
      [{ available: 1, credits: [{ id: "C", status: "available", expiresAt: Math.floor(AT / 1000) - 1 }] }, "none"],
      [{ available: 1, accountId: "another-account" }, "login_changed"],
      [{ available: 1, accountId: null }, "unverified"],
      [{ available: 1, accountId: "" }, "unverified"],
      [{ available: null }, "none"],
    ] as const) {
      const fx = fakeCodex(o as FakeOpts);
      expect((await redeemCodexReset(fx.launcher, login, ok(), AT)).outcome).toBe(want);
      expect(fx.consumes()).toHaveLength(0);
      expect(fx.state.closed).toBe(1);
    }
  });

  test("the login is re-checked right before the use: switched after the read → login_changed, nothing sent", async () => {
    let bound = true;
    const fx = fakeCodex({ available: 2, onRead: () => { bound = false; } });
    expect((await redeemCodexReset(fx.launcher, login, ok({ stillBound: () => bound }), AT)).outcome).toBe("login_changed");
    expect(fx.consumes()).toHaveLength(0);
  });

  test("failures say why: Codex missing, unreachable, refused (nothing sent); during the use → unconfirmed", async () => {
    expect(await redeemCodexReset(fakeCodex({ failLaunch: true }).launcher, login, ok(), AT)).toEqual({ outcome: "failed", left: null, failure: "codex_missing" });
    const down: AppServerLauncher = async () => { throw new RpcError("spawn_failed"); };
    expect((await redeemCodexReset(down, login, ok(), AT)).failure).toBe("unreachable");
    const init = fakeCodex({ failInit: true });
    expect((await redeemCodexReset(init.launcher, login, ok(), AT)).failure).toBe("refused");
    expect(init.consumes()).toHaveLength(0);
    const read = fakeCodex({ failRead: true });
    expect((await redeemCodexReset(read.launcher, login, ok(), AT)).failure).toBe("refused");
    const rpc = fakeCodex({ consume: () => { throw new RpcError("rpc_error"); } });
    expect(await redeemCodexReset(rpc.launcher, login, ok(), AT)).toEqual({ outcome: "unconfirmed", left: null });
    const junk = fakeCodex({ consume: () => ({ nope: true }) });
    expect((await redeemCodexReset(junk.launcher, login, ok(), AT)).outcome).toBe("unconfirmed");
  });

  test("Codex's own outcomes map one to one on a first try", async () => {
    const out = async (outcome: string) => (await redeemCodexReset(fakeCodex({ available: 3, consume: () => ({ outcome }) }).launcher, login, ok(), AT)).outcome;
    expect(await out("reset")).toBe("reset");
    expect(await out("alreadyRedeemed")).toBe("already_used");
    expect(await out("nothingToReset")).toBe("not_needed");
    expect(await out("noCredit")).toBe("none");
    expect(await out("somethingNew")).toBe("unconfirmed");
  });

  test("a retry after an unconfirmed try reconciles it: same key and credit even when none is left; never 'nothing used'", async () => {
    for (const [codex, want] of [["alreadyRedeemed", "already_used"], ["noCredit", "already_used"], ["nothingToReset", "already_used"], ["reset", "reset"]] as const) {
      const fx = fakeCodex({ available: 0, consume: () => ({ outcome: codex }) });
      const r = await redeemCodexReset(fx.launcher, login, ok({ afterUnconfirmed: true, creditId: "C_first" }), AT);
      expect(r.outcome).toBe(want);
      expect(fx.consumes().map((c) => c.params)).toEqual([{ idempotencyKey: REQ, creditId: "C_first" }]);
    }
  });

  test("pickCredit", () => {
    expect(pickCredit(null, AT)).toBeNull();
    expect(pickCredit([], AT)).toBeUndefined();
    expect(pickCredit([{ id: "A", status: "available", resetType: "unknown" }, { id: "B", status: "available", expiresAt: null }], AT)).toBe("B");
  });
});

describe("the app-server's process group is ended (Codex MEDIUM 6)", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitGone = async (pid: number) => { for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50); return !alive(pid); };

  for (const [name, script] of [
    ["the leader still running", "sleep 300 & echo $! > \"$F\"; exec cat"],
    ["the leader already gone (a descendant outlived it)", "sleep 300 & echo $! > \"$F\"; exit 0"],
    ["a descendant that ignores SIGTERM", "(trap '' TERM; sleep 300) & echo $! > \"$F\"; exec cat"],
  ] as const) {
    test(`close() ends the group: ${name}`, async () => {
      const f = join(mkdtempSync(join(root, "pg-")), "child.pid");
      const child = spawn("/bin/sh", ["-c", script], { env: { PATH: "/usr/bin:/bin", F: f }, stdio: ["pipe", "pipe", "ignore"], detached: true });
      for (let i = 0; i < 40 && !(existsSync(f) && readFileSync(f, "utf8").trim()); i++) await Bun.sleep(25);
      const descendant = Number(readFileSync(f, "utf8").trim());
      expect(alive(descendant)).toBe(true);
      await Bun.sleep(100);
      stdioSession(child, 200).close();
      expect(await waitGone(descendant)).toBe(true);
    });
  }
});

describe("AccountsService: attempts minted and bound by the daemon", () => {
  /** A service with one recorded Codex account whose usage poll reports `available` resets. */
  function setup(fx: ReturnType<typeof fakeCodex>, available = 2, walkieHome = mkdtempSync(join(root, "w-")), home = freshHome(), o: { clock?: () => number; onUsage?: () => void } = {}) {
    const f = fakeFetch();
    let count = available;
    let status = 200;
    const usage = () => { o.onUsage?.(); return status === 200
      ? new Response(JSON.stringify({ ...(fixture("codex-usage.json") as object), rate_limit_reset_credits: { available_count: count, applicable_available_count: count } }), { status: 200 })
      : new Response("{}", { status, headers: { "Retry-After": "3600" } }); };
    f.respond.set(USAGE_URLS.codex, usage);
    const svc = new AccountsService(walkieHome, log, () => undefined, { home, fetch: f.fetch, keychain: noKeychain, codexAppServer: fx.launcher, tickMs: 3_600_000, ...(o.clock ? { clock: o.clock } : {}) });
    svc.observe([{ agent: "codex-1", runtime: "codex" }, { agent: "cc-1", runtime: "claude-code" }]);
    const id = (p: string) => svc.snapshot().accounts.find((a) => a.provider === p)!.id;
    return { svc, f, id, setCount: (v: number) => { count = v; }, setStatus: (v: number) => { status = v; }, home, walkieHome };
  }

  test("prepare mints one attempt per account and hands the same one back until it is used", async () => {
    const { svc, id } = setup(fakeCodex());
    const cx = id("codex");
    const a = svc.prepareReset(cx);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.earlier).toBeNull();
    expect(svc.prepareReset(cx).id).toBe(a.id);
    await svc.useReset(cx, a.id);
    expect(svc.prepareReset(cx).id).not.toBe(a.id);
  });

  test("a double-click (same id) uses ONE reset and both get the same answer; later, the recorded answer", async () => {
    let release!: () => void;
    const fx = fakeCodex({ available: 2, gate: new Promise<void>((r) => { release = r; }) });
    const { svc, id } = setup(fx);
    await svc.tick();
    const cx = id("codex");
    const { id: attempt } = svc.prepareReset(cx);
    const a = svc.useReset(cx, attempt);
    const b = svc.useReset(cx, attempt);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ outcome: "reset", left: 1 });
    expect(rb).toEqual(ra);
    expect(fx.state.launches).toBe(1);
    expect(fx.consumes()).toHaveLength(1);
    expect(await svc.useReset(cx, attempt)).toEqual(ra);
    expect(fx.consumes()).toHaveLength(1);
  });

  test("ids the daemon did not mint are refused; an id stays bound to its account even after a failed try", async () => {
    const fx = fakeCodex({ failLaunch: true });
    const { svc, id } = setup(fx);
    const cx = id("codex");
    await expect(svc.useReset(cx, REQ)).rejects.toMatchObject({ code: "unknown_attempt" });
    const { id: attempt } = svc.prepareReset(cx);
    expect((await svc.useReset(cx, attempt)).failure).toBe("codex_missing");
    await expect(svc.useReset(id("claude"), attempt)).rejects.toMatchObject({ code: "request_reused" });
    expect(svc.prepareReset(cx).id).toBe(attempt); // open again (nothing was sent), same id
  });

  test("login switched between the sheet and the confirmation: login_changed, the app-server never starts", async () => {
    const fx = fakeCodex();
    const { svc, id, home } = setup(fx);
    const cx = id("codex");
    const { id: attempt } = svc.prepareReset(cx);
    switchLogin(home);
    expect((await svc.useReset(cx, attempt)).outcome).toBe("login_changed");
    expect(fx.state.launches).toBe(0);
    // Prepare refuses too while the login is someone else's.
    expect(() => svc.prepareReset(cx)).toThrow(AccountActionError);
  });

  test("login switched while the app-server runs (after its read): nothing is sent (Codex HIGH 1)", async () => {
    let home = "";
    const fx = fakeCodex({ available: 2, onRead: () => switchLogin(home) });
    const env = setup(fx);
    home = env.home;
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    expect((await env.svc.useReset(cx, attempt)).outcome).toBe("login_changed");
    expect(fx.consumes()).toHaveLength(0);
  });

  test("the app-server signed in as another account, or naming none: nothing is sent", async () => {
    for (const [accountId, want] of [["99999999-1111-4222-8333-444444444444", "login_changed"], [null, "unverified"]] as const) {
      const fx = fakeCodex({ available: 2, accountId });
      const { svc, id } = setup(fx);
      const { id: attempt } = svc.prepareReset(id("codex"));
      expect((await svc.useReset(id("codex"), attempt)).outcome).toBe(want);
      expect(fx.consumes()).toHaveLength(0);
    }
  });

  test("Codex refreshing its token (auth.json rewritten, same account) is not a login switch", async () => {
    const fx = fakeCodex({ available: 2, onRead: () => refreshToken(env.home) });
    const env = setup(fx);
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    refreshToken(env.home);
    expect((await env.svc.useReset(cx, attempt)).outcome).toBe("reset");
  });

  test("an email or sign-in-mode change on the same account is the same account (RESET-3)", async () => {
    const fx = fakeCodex({ available: 2 });
    const env = setup(fx);
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    changeEmail(env.home);
    expect(env.svc.prepareReset(cx).id).toBe(attempt);
    expect((await env.svc.useReset(cx, attempt)).outcome).toBe("reset");
  });

  test("no ChatGPT login on this machine any more: prepare says not signed in", () => {
    const fx = fakeCodex();
    const { svc, id, home } = setup(fx);
    const cx = id("codex");
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "FAKE-API-KEY-NOT-A-LOGIN", tokens: null }));
    expect(() => svc.prepareReset(cx)).toThrow(expect.objectContaining({ code: "not_signed_in" }));
    expect(fx.state.launches).toBe(0);
  });

  test("unconfirmed: kept per account, handed back (never a new id), retried only after a re-read, reconciled; survives a restart", async () => {
    let n = 0;
    let t = Date.now();
    const fx = fakeCodex({ available: 1, credits: [{ id: "C_one", status: "available", expiresAt: null }], consume: () => {
      if (n++ === 0) throw new RpcError("timeout"); // the use went out; its answer was lost
      return { outcome: "noCredit" }; // the retry finds the credit spent: the first try went through
    } });
    const env = setup(fx, 1, mkdtempSync(join(root, "w-")), freshHome(), { clock: () => t });
    const cx = env.id("codex");
    env.setStatus(429); // the provider holds polling: usage cannot be re-read yet
    await env.svc.tick();
    const { id: attempt } = env.svc.prepareReset(cx);
    expect((await env.svc.useReset(cx, attempt)).outcome).toBe("unconfirmed");
    const again = env.svc.prepareReset(cx);
    expect(again.id).toBe(attempt);
    expect(again.earlier).toMatchObject({ reread: false });
    expect(await env.svc.useReset(cx, attempt)).toEqual({ outcome: "check_usage", left: null });
    expect(fx.consumes()).toHaveLength(1);

    // Restart: the attempt (with its credit) and the provider's hold are in the ledger file, not accounts.json.
    const ledger = JSON.parse(readFileSync(join(env.walkieHome, "reset-attempts.json"), "utf8")) as { attempts: unknown[]; holds: Record<string, { not_before: number }> };
    expect(ledger.attempts).toEqual([expect.objectContaining({ id: attempt, state: "unconfirmed", credit_id: "C_one", sent: true })]);
    expect(ledger.holds[cx]?.not_before).toBeGreaterThan(t);
    expect(readFileSync(join(env.walkieHome, "accounts.json"), "utf8")).not.toContain("reset_attempts");
    const fx2 = fakeCodex({ available: 0, consume: () => ({ outcome: "noCredit" }) });
    const env2 = setup(fx2, 0, env.walkieHome, env.home, { clock: () => t });
    expect(env2.svc.prepareReset(cx).id).toBe(attempt);
    await env2.svc.tick();
    expect(env2.f.calls.filter((u) => u === USAGE_URLS.codex)).toHaveLength(0); // the hold came back from the ledger
    t += 3_601_000; // the hold ran out (and a reading now starts well after the try)
    await env2.svc.tick();
    expect(env2.svc.prepareReset(cx).earlier).toMatchObject({ reread: true });
    const r = await env2.svc.useReset(cx, attempt);
    expect(r.outcome).toBe("already_used"); // not "nothing was used"
    expect(fx2.consumes().map((c) => c.params)).toEqual([{ idempotencyKey: attempt, creditId: "C_one" }]);
    expect(env2.svc.prepareReset(cx).id).not.toBe(attempt); // resolved: a new attempt may be minted now
  });

  test("the re-read gate needs a reading that STARTED 30 s after the try (Opus r3)", async () => {
    let t = Date.now();
    const fx = fakeCodex({ consume: () => { throw new RpcError("timeout"); } });
    const env = setup(fx, 2, mkdtempSync(join(root, "w-")), freshHome(), { clock: () => t });
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    expect((await env.svc.useReset(cx, attempt)).outcome).toBe("unconfirmed");
    await env.svc.tick(); // the re-read is scheduled 30 s out, not now
    expect(env.svc.prepareReset(cx).earlier).toMatchObject({ reread: false });
    t += 10_000;
    expect(env.svc.refresh(cx)).toBe("scheduled");
    await Bun.sleep(10); // the refresh's own poll finishes (a reading 10 s after the try: it does not count)
    expect(env.svc.prepareReset(cx).earlier).toMatchObject({ reread: false });
    expect(await env.svc.useReset(cx, attempt)).toEqual({ outcome: "check_usage", left: null });
    t += 21_000;
    await env.svc.tick(); // the scheduled re-read, 31 s after the try
    expect(env.svc.prepareReset(cx).earlier).toMatchObject({ reread: true });
  });

  test("an unconfirmed attempt survives a login switch and comes back when the account logs in again", async () => {
    const fx = fakeCodex({ consume: () => { throw new RpcError("timeout"); } });
    const env = setup(fx);
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    expect((await env.svc.useReset(cx, attempt)).outcome).toBe("unconfirmed");
    switchLogin(env.home);
    expect(() => env.svc.prepareReset(cx)).toThrow(expect.objectContaining({ code: "login_changed" }));
    expect((await env.svc.useReset(cx, attempt)).outcome).not.toBe("reset");
    switchLogin(env.home, ACCOUNT); // back to the confirmed account
    expect(env.svc.prepareReset(cx)).toMatchObject({ id: attempt, earlier: expect.anything() });
    expect(fx.consumes()).toHaveLength(1);
  });

  test("a daemon that stopped mid-use reloads the attempt as unconfirmed", async () => {
    const walkieHome = mkdtempSync(join(root, "w-"));
    let release!: () => void;
    const fx = fakeCodex({ gate: new Promise<void>((r) => { release = r; }) });
    const env = setup(fx, 2, walkieHome);
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    const p = env.svc.useReset(cx, attempt);
    await Bun.sleep(20);
    const env2 = setup(fakeCodex(), 2, walkieHome, env.home); // what a restart would load now
    expect(env2.svc.prepareReset(cx)).toMatchObject({ id: attempt, earlier: expect.objectContaining({ tried_at: expect.any(Number) }) });
    release();
    await p;
  });

  test("a daemon that stopped before sending reloads the attempt as NOT sent: open, 'interrupted', a fresh try", async () => {
    const walkieHome = mkdtempSync(join(root, "w-"));
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });
    const fx = fakeCodex({ available: 1, onRead: () => undefined, consume: () => ({ outcome: "reset" }) });
    const slow: AppServerLauncher = async (l) => { const s = await fx.launcher(l); return { ...s, request: async (m, p, t) => { if (m === "account/rateLimits/read") await hang; return s.request(m, p, t); } }; };
    const env = setup({ ...fx, launcher: slow }, 1, walkieHome);
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    const p = env.svc.useReset(cx, attempt);
    await Bun.sleep(20); // running, stuck before the use is sent
    const fx2 = fakeCodex({ available: 0, consume: () => ({ outcome: "noCredit" }) });
    const env2 = setup(fx2, 0, walkieHome, env.home);
    const view = env2.svc.prepareReset(cx);
    expect(view).toMatchObject({ id: attempt, earlier: null, interrupted: true });
    // A fresh try (not a reconciliation): no credit left means "none", never "already used".
    expect((await env2.svc.useReset(cx, attempt)).outcome).toBe("none");
    expect(fx2.consumes()).toHaveLength(0);
    release();
    await p;
  });

  test("the meter is re-read right after a reset (the count and windows update)", async () => {
    const fx = fakeCodex({ available: 2 });
    const { svc, id, setCount, f } = setup(fx);
    await svc.tick();
    const cx = id("codex");
    expect(svc.snapshot().accounts.find((a) => a.id === cx)?.usage?.resets).toEqual({ available: 2, applicable: 2 });
    setCount(1);
    const polls = f.calls.filter((u) => u === USAGE_URLS.codex).length;
    await svc.useReset(cx, svc.prepareReset(cx).id);
    expect(f.calls.filter((u) => u === USAGE_URLS.codex).length).toBe(polls + 1);
    expect(svc.snapshot().accounts.find((a) => a.id === cx)?.usage?.resets).toEqual({ available: 1, applicable: 1 });
  });

  test("refusals before anything runs: unknown account, Claude (used on claude.ai)", async () => {
    const fx = fakeCodex();
    const { svc, id } = setup(fx);
    expect(() => svc.prepareReset("0".repeat(24))).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => svc.prepareReset(id("claude"))).toThrow(expect.objectContaining({ code: "not_supported" }));
    expect(fx.state.launches).toBe(0);
  });

  test("refresh brings the next poll forward at most every 30 s, and never ahead of a provider's Retry-After (Opus MEDIUM 3)", async () => {
    const fx = fakeCodex();
    const env = setup(fx);
    await env.svc.tick();
    const cx = env.id("codex");
    const before = env.f.calls.length;
    expect(env.svc.refresh(cx)).toBe("scheduled");
    await env.svc.tick();
    expect(env.f.calls.length).toBeGreaterThan(before);
    expect(env.svc.refresh(cx)).toBe("throttled");
    expect(() => env.svc.refresh("0".repeat(24))).toThrow(AccountActionError);

    const held = setup(fakeCodex());
    held.setStatus(429);
    await held.svc.tick(); // 429 with Retry-After: 3600
    const calls = held.f.calls.length;
    expect(held.svc.refresh(held.id("codex"))).toBe("held");
    await held.svc.tick();
    expect(held.f.calls.length).toBe(calls);
    // A reset's own re-read waits for the hold too.
    const codexPolls = () => held.f.calls.filter((u) => u === USAGE_URLS.codex).length;
    const polls = codexPolls();
    const { id: attempt } = held.svc.prepareReset(held.id("codex"));
    expect((await held.svc.useReset(held.id("codex"), attempt)).outcome).toBe("reset");
    expect(codexPolls()).toBe(polls);
  });

  test("a Retry-After hold survives a discovery pass and a restart (RESET-3)", async () => {
    const env = setup(fakeCodex());
    env.setStatus(429);
    await env.svc.tick(); // 429 with Retry-After: 3600
    const polls = () => env.f.calls.filter((u) => u === USAGE_URLS.codex).length;
    const before = polls();
    env.svc.observe([{ agent: "codex-1", runtime: "codex" }, { agent: "cc-1", runtime: "claude-code" }]); // a discovery pass
    await env.svc.tick();
    expect(polls()).toBe(before);
    expect(env.svc.refresh(env.id("codex"))).toBe("held");
    // Restart: the hold comes back from accounts.json.
    const env2 = setup(fakeCodex(), 2, env.walkieHome, env.home);
    const polls2 = () => env2.f.calls.filter((u) => u === USAGE_URLS.codex).length;
    await env2.svc.tick();
    expect(polls2()).toBe(0);
    expect(env2.svc.refresh(env2.id("codex"))).toBe("held");
  });

  test("an unreadable accounts.json is copied aside and polling starts over; resets are not blocked (it is rebuildable)", () => {
    const walkieHome = mkdtempSync(join(root, "w-"));
    writeFileSync(join(walkieHome, "accounts.json"), "{ this is not json");
    const env = setup(fakeCodex(), 2, walkieHome);
    const kept = readdirSync(walkieHome).filter((f) => f.startsWith("accounts.json.corrupt-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(walkieHome, kept[0]!), "utf8")).toBe("{ this is not json");
    expect(() => env.svc.prepareReset(env.id("codex"))).not.toThrow();
  });

  test("one unreadable attempt row: the ledger is copied aside, the rest loads, resets are refused (RESET-3/5)", async () => {
    const env = setup(fakeCodex());
    const cx = env.id("codex");
    env.svc.prepareReset(cx);
    const path = join(env.walkieHome, "reset-attempts.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...saved, attempts: [...saved.attempts, { id: "garbage" }] }));
    const env2 = setup(fakeCodex(), 2, env.walkieHome, env.home);
    expect(readdirSync(env.walkieHome).filter((f) => f.startsWith("reset-attempts.json.corrupt-"))).toHaveLength(1);
    expect(env2.svc.snapshot().accounts.some((a) => a.id === cx)).toBe(true);
    expect(() => env2.svc.prepareReset(cx)).toThrow(expect.objectContaining({ code: "ledger_unreadable" }));
  });

  test("records are capped the same in memory and in the file; a bad record row is dropped alone (RESET-3)", () => {
    const walkieHome = mkdtempSync(join(root, "w-"));
    const now = Date.now();
    const rows = Array.from({ length: 70 }, (_, i) => ({
      id: i.toString(16).padStart(24, "0"), provider: "claude", label: "Claude account", plan: null, dir: `/tmp/x${i}`, is_default: false,
      last_seen: now - i * 1000, reading: null,
    }));
    writeFileSync(join(walkieHome, "accounts.json"), JSON.stringify({ version: 1, records: [...rows, { id: "bad" }], kimi_aliases: {}, reset_attempts: [] }));
    const env = setup(fakeCodex(), 2, walkieHome); // observe() adds two more and saves
    const saved = JSON.parse(readFileSync(join(walkieHome, "accounts.json"), "utf8")) as { records: Array<{ id: string }> };
    expect(saved.records.length).toBe(64);
    expect(saved.records.some((r) => r.id === env.id("codex"))).toBe(true); // the newest are kept
    expect(readdirSync(walkieHome).some((f) => f.includes("corrupt"))).toBe(false); // a bad account row is not a ledger problem
  });

  test("Codex r2 HIGH 1 on the daemon: after A is final and B was minted, a retry of A replays A; nothing more is spent", async () => {
    const fx = fakeCodex({ available: 2 });
    const { svc, id } = setup(fx);
    const cx = id("codex");
    const { id: a } = svc.prepareReset(cx);
    expect((await svc.useReset(cx, a)).outcome).toBe("reset"); // the dashboard never heard this answer
    const { id: b } = svc.prepareReset(cx); // a usage update: the daemon mints B
    expect(b).not.toBe(a);
    expect(await svc.useReset(cx, a)).toEqual({ outcome: "reset", left: 1 }); // "Try the same attempt again" asks for A
    expect(fx.consumes()).toHaveLength(1);
  });

  test("persistence must succeed before anything is sent (Codex r2 MEDIUM 3)", async () => {
    const { chmodSync } = await import("node:fs");
    const fx = fakeCodex();
    const env = setup(fx);
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    const file = join(env.walkieHome, "reset-attempts.json");
    chmodSync(env.walkieHome, 0o500); // no new file can be written (the save is a write + rename)
    try {
      expect(await env.svc.useReset(cx, attempt)).toEqual({ outcome: "failed", left: null, failure: "not_saved" });
      expect(fx.state.launches).toBe(0);
      expect(fx.consumes()).toHaveLength(0);
      expect(() => env.svc.prepareReset(env.id("codex"))).not.toThrow(); // the open attempt comes back (no write needed)
    } finally {
      chmodSync(env.walkieHome, 0o700);
    }
    expect(readFileSync(file, "utf8")).toContain(attempt);
    // Not writable when the credit is recorded: the use is never sent.
    const fx2 = fakeCodex({ onRead: () => chmodSync(env.walkieHome, 0o500) });
    const env2 = setup(fx2, 2, env.walkieHome, env.home);
    try {
      expect(await env2.svc.useReset(cx, attempt)).toEqual({ outcome: "failed", left: null, failure: "not_saved" });
      expect(fx2.consumes()).toHaveLength(0);
    } finally {
      chmodSync(env.walkieHome, 0o700);
    }
  });

  test("an unreadable ledger blocks resets across restarts until a person says they checked usage (Codex r2 MEDIUM 3)", () => {
    const walkieHome = mkdtempSync(join(root, "w-"));
    writeFileSync(join(walkieHome, "reset-attempts.json"), "{ broken");
    const env = setup(fakeCodex(), 2, walkieHome);
    const cx = env.id("codex");
    expect(() => env.svc.prepareReset(cx)).toThrow(expect.objectContaining({ code: "ledger_unreadable" }));
    const again = setup(fakeCodex(), 2, walkieHome, env.home); // a restart: marker and leftover copy both block
    expect(() => again.svc.prepareReset(cx)).toThrow(expect.objectContaining({ code: "ledger_unreadable" }));
    expect(again.svc.resolveReset(cx)).toEqual({ attempt: null, ledger: true });
    expect(readdirSync(walkieHome).filter((f) => f.includes(".corrupt-") && f.endsWith(".checked"))).toHaveLength(1);
    expect(() => again.svc.prepareReset(cx)).not.toThrow();
    const third = setup(fakeCodex(), 2, walkieHome, env.home);
    expect(() => third.svc.prepareReset(cx)).not.toThrow();
  });

  test("the recovery marker can't be lost: its save fails, the unreadable original stays and blocks again (Opus r3 MEDIUM 1)", () => {
    const { mkdirSync, rmdirSync } = require("node:fs") as typeof import("node:fs");
    const walkieHome = mkdtempSync(join(root, "w-"));
    writeFileSync(join(walkieHome, "reset-attempts.json"), "{ broken");
    mkdirSync(join(walkieHome, "reset-attempts.json.tmp")); // the marker save fails (a disk-full stand-in)
    const env = setup(fakeCodex(), 2, walkieHome);
    const cx = env.id("codex");
    expect(() => env.svc.prepareReset(cx)).toThrow(expect.objectContaining({ code: "ledger_unreadable" }));
    rmdirSync(join(walkieHome, "reset-attempts.json.tmp"));
    expect(readFileSync(join(walkieHome, "reset-attempts.json"), "utf8")).toBe("{ broken"); // not moved away
    const again = setup(fakeCodex(), 2, walkieHome, env.home);
    expect(() => again.svc.prepareReset(cx)).toThrow(expect.objectContaining({ code: "ledger_unreadable" }));
  });

  test("a leftover unconfirmed corrupt copy blocks at startup, even next to a clean ledger (Opus r3 MEDIUM 1)", () => {
    const env = setup(fakeCodex());
    const cx = env.id("codex");
    writeFileSync(join(env.walkieHome, "reset-attempts.json.corrupt-123"), "{ old");
    const again = setup(fakeCodex(), 2, env.walkieHome, env.home);
    expect(() => again.svc.prepareReset(cx)).toThrow(expect.objectContaining({ code: "ledger_unreadable", detail: "reset-attempts.json.corrupt-123" }));
  });

  test("a rollback to pre.2 rewriting accounts.json can't erase the ledger (Opus r3 MEDIUM 2)", async () => {
    const fx = fakeCodex({ consume: () => { throw new RpcError("timeout"); } });
    const env = setup(fx);
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    expect((await env.svc.useReset(cx, attempt)).outcome).toBe("unconfirmed");
    const path = join(env.walkieHome, "accounts.json");
    const cur = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ version: 1, records: cur.records, kimi_aliases: cur.kimi_aliases }) + "\n"); // what pre.2 writes
    const env2 = setup(fakeCodex(), 2, env.walkieHome, env.home);
    expect(env2.svc.prepareReset(cx)).toMatchObject({ id: attempt, earlier: expect.anything() });
  });

  test("a RESET-2..4 ledger inside accounts.json is moved into its own file", () => {
    const env = setup(fakeCodex());
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    const ledger = JSON.parse(readFileSync(join(env.walkieHome, "reset-attempts.json"), "utf8"));
    const acc = JSON.parse(readFileSync(join(env.walkieHome, "accounts.json"), "utf8"));
    writeFileSync(join(env.walkieHome, "accounts.json"), JSON.stringify({ ...acc, reset_attempts: ledger.attempts }));
    rmSync(join(env.walkieHome, "reset-attempts.json"));
    const env2 = setup(fakeCodex(), 2, env.walkieHome, env.home);
    expect(env2.svc.prepareReset(cx).id).toBe(attempt);
    expect(JSON.parse(readFileSync(join(env.walkieHome, "reset-attempts.json"), "utf8")).attempts).toEqual([expect.objectContaining({ id: attempt })]);
  });

  test("a Retry-After hold survives an unreadable account row (it lives in the ledger; Opus r3 LOW)", async () => {
    const env = setup(fakeCodex());
    env.setStatus(429);
    await env.svc.tick();
    const cx = env.id("codex");
    const path = join(env.walkieHome, "accounts.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...saved, records: saved.records.map((r: { id: string }) => (r.id === cx ? { ...r, reading: { state: "weird-new-state" } } : r)) }));
    const env2 = setup(fakeCodex(), 2, env.walkieHome, env.home); // the row is dropped; observe records the account again
    await env2.svc.tick();
    expect(env2.f.calls.filter((u) => u === USAGE_URLS.codex)).toHaveLength(0);
    expect(env2.svc.refresh(cx)).toBe("held");
  });

  test("an unconfirmed attempt never expires on a clock; only a person's 'I checked usage' releases it (Codex r2 MEDIUM 5)", async () => {
    let t = Date.now();
    const fx = fakeCodex({ consume: () => { throw new RpcError("timeout"); } });
    const env = setup(fx, 2, mkdtempSync(join(root, "w-")), freshHome(), { clock: () => t });
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    expect((await env.svc.useReset(cx, attempt)).outcome).toBe("unconfirmed");
    t += 400 * 86_400_000; // a forward clock jump of 400 days
    expect(env.svc.prepareReset(cx).id).toBe(attempt);
    const restarted = setup(fakeCodex(), 2, env.walkieHome, env.home, { clock: () => t });
    expect(restarted.svc.prepareReset(cx)).toMatchObject({ id: attempt, earlier: expect.anything() });
    expect(restarted.svc.resolveReset(cx)).toEqual({ attempt, ledger: false });
    // Released: never retried (its answer ages out with the 400-day jump, so the id is simply unknown now).
    await expect(restarted.svc.useReset(cx, attempt)).rejects.toMatchObject({ code: "unknown_attempt" });
    expect(restarted.svc.prepareReset(cx).id).not.toBe(attempt);
    expect(fx.consumes()).toHaveLength(1);
  });

  test("a dismissed attempt replays 'dismissed' for its id", async () => {
    const fx = fakeCodex({ consume: () => { throw new RpcError("timeout"); } });
    const env = setup(fx);
    const cx = env.id("codex");
    const { id: attempt } = env.svc.prepareReset(cx);
    await env.svc.useReset(cx, attempt);
    env.svc.resolveReset(cx);
    expect(await env.svc.useReset(cx, attempt)).toEqual({ outcome: "dismissed", left: null });
    expect(fx.consumes()).toHaveLength(1);
  });

  test("a Retry-After counts from the answer's arrival, not the request's start (Codex r2 LOW 6)", async () => {
    const t0 = Date.now();
    let t = t0;
    const env = setup(fakeCodex(), 2, mkdtempSync(join(root, "w-")), freshHome(), { clock: () => t, onUsage: () => { t += 10_000; } });
    env.setStatus(429);
    await env.svc.tick(); // started at t0, answered at t0 + 10 s with Retry-After: 3600
    const polls = () => env.f.calls.filter((u) => u === USAGE_URLS.codex).length;
    const before = polls();
    t = t0 + 3_600_000 + 5_000; // past a start-anchored deadline, before the receipt-anchored one
    await env.svc.tick();
    expect(polls()).toBe(before);
    expect(env.svc.refresh(env.id("codex"))).toBe("held");
    t = t0 + 3_610_000 + 1;
    await env.svc.tick();
    expect(polls()).toBe(before + 1);
  });

  test("a queued poll rechecks its hold right before it starts (Codex r3 LOW 3)", async () => {
    const t0 = Date.now();
    let t = t0;
    const env = setup(fakeCodex(), 2, mkdtempSync(join(root, "w-")), freshHome(), { clock: () => t });
    env.setStatus(429);
    await env.svc.tick(); // Codex held until t0 + 3600 s (Claude read too)
    const codexPolls = () => env.f.calls.filter((u) => u === USAGE_URLS.claude ? false : u === USAGE_URLS.codex).length;
    const before = codexPolls();
    t = t0 + 3_600_000 + 200_000; // both due now: Claude first (its next poll is earlier)
    // Claude's poll takes the clock back before Codex's hold ends (an NTP correction mid-batch).
    env.f.respond.set(USAGE_URLS.claude, () => { t = t0 + 3_600_000 - 100_000; return new Response(JSON.stringify(fixture("claude-usage.json")), { status: 200 }); });
    await env.svc.tick();
    expect(env.f.calls.filter((u) => u === USAGE_URLS.claude).length).toBeGreaterThan(1);
    expect(codexPolls()).toBe(before);
  });

  test("logs name the account and outcome, never a credit id or token", async () => {
    const fx = fakeCodex({ credits: [{ id: "RateLimitResetCredit_SECRETISH", status: "available", expiresAt: null }] });
    const { svc, id } = setup(fx);
    lines.length = 0;
    const { id: attempt } = svc.prepareReset(id("codex"));
    await svc.useReset(id("codex"), attempt);
    const text = lines.join("\n");
    expect(text).toContain("account_reset_result");
    expect(text).not.toContain("RateLimitResetCredit_SECRETISH");
    expect(text).not.toContain(attempt);
  });
});
