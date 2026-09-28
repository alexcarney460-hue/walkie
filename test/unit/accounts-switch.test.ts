// ACCOUNTS-2 daemon side: vault accounts in the poller (never a refresh; a setup-token without a meter is
// "no_usage_api", not "needs re-login"), leases + vault badges on the `vv` snapshot and in the pooled view, session
// marks and readings, wrapped sessions attributed by WALKIE_ACCOUNT, the hook side channel, and the watchers.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeLease, writeMark, writeSessionReading } from "../../src/accounts/leases.ts";
import { METERLESS_RETRY_MS, pollAccount } from "../../src/accounts/poll.ts";
import { AccountsService, type VaultSource } from "../../src/accounts/service.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { USAGE_URLS } from "../../src/accounts/http.ts";
import { AccountsSnapshot, type AccountView } from "../../src/protocol/accounts.ts";
import { candidatesFrom, mayLease } from "../../src/switch/accounts.ts";
import { ClaudeWatcher, CodexWatcher, codexRetryAt } from "../../src/switch/watch.ts";
import { recordSwitchEvent, switchEventsFile } from "../../src/hooks/switch-channel.ts";
import { fakeFetch } from "../helpers/accounts.ts";

const root = mkdtempSync("/tmp/walkie-acsw-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => { const d = join(root, `d${n++}`); mkdirSync(d, { recursive: true }); return d; };
const lines: string[] = [];
const log: Logger = {
  debug: (m, f) => lines.push(JSON.stringify({ m, ...f })), info: (m, f) => lines.push(JSON.stringify({ m, ...f })),
  warn: (m, f) => lines.push(JSON.stringify({ m, ...f })), error: (m, f) => lines.push(JSON.stringify({ m, ...f })),
};
const TOKEN = ("sk" + "-ant-oat01-FAKEVAULTPOLLTOKEN0123456789abcdefghij");
const A = "a".repeat(24);
const noKeychain = async () => { throw new Error("TEST FAILURE: keychain read"); };

function entry(over: Partial<VaultEntry> = {}): VaultEntry {
  return { id: A, provider: "claude", label: "al***@ex***.com", plan: "Max", policy: "own", share_with: [], created_at: 1, expires_at: Date.now() + 1e10, home: null, linked: false, gen: "g1", ...over };
}
function vaultOf(entries: VaultEntry[], reads: string[] = []): VaultSource {
  return { list: () => entries, claudeToken: async (id) => { reads.push(id); return TOKEN; } };
}

describe("vault accounts in the poller", () => {
  test("a setup-token is tried once on the usage endpoint only; 401/403 → no_usage_api for 6 h, never re-login", async () => {
    const ff = fakeFetch();
    ff.respond.set(USAGE_URLS.claude, () => new Response("{}", { status: 403 }));
    const res = await pollAccount("claude", { provider: "claude", dir: `vault:${A}`, isDefault: false, vault: true }, { provider: "claude", id: A, label: "x", plan: null }, null, 0, {
      fetch: ff.fetch, keychain: noKeychain, now: Date.now(), keychainBlockedUntil: 0, vaultToken: { read: async () => TOKEN, expiresAt: null },
    });
    expect(ff.calls).toEqual([USAGE_URLS.claude]);
    expect(res.reading).toMatchObject({ state: "unknown", reason: "no_usage_api" });
    expect(res.nextInMs).toBe(METERLESS_RETRY_MS);
    ff.respond.set(USAGE_URLS.claude, () => new Response("{}", { status: 401 }));
    const r401 = await pollAccount("claude", { provider: "claude", dir: `vault:${A}`, isDefault: false, vault: true }, { provider: "claude", id: A, label: "x", plan: null }, null, 0, {
      fetch: ff.fetch, keychain: noKeychain, now: Date.now(), keychainBlockedUntil: 0, vaultToken: { read: async () => TOKEN, expiresAt: null },
    });
    expect(r401.reading?.state).toBe("unknown");
  });

  test("the service records vault accounts (badge, polled, never saved with a token) and shares leases, marks and session readings", async () => {
    const w = dir();
    const reads: string[] = [];
    const ff = fakeFetch();
    const snaps: AccountsSnapshot[] = [];
    const svc = new AccountsService(w, log, (s) => snaps.push(s), { home: dir(), fetch: ff.fetch, keychain: noKeychain, vault: vaultOf([entry()], reads), tickMs: 3_600_000 });
    await svc.tick();
    let snap = svc.snapshot();
    expect(AccountsSnapshot.safeParse(snap).success).toBe(true);
    expect(snap.accounts[0]).toMatchObject({ id: A, label: "al***@ex***.com", vault: { policy: "own" } });
    expect(snap.accounts[0]?.usage?.state).toBe("ok"); // the fixture answered for the setup-token
    expect(reads).toEqual([A]);
    expect(ff.calls).toEqual([USAGE_URLS.claude]);
    const saved = readFileSync(join(w, "accounts.json"), "utf8");
    expect(saved).not.toContain("FAKEVAULTPOLL");
    expect(JSON.parse(saved).records[0]).toMatchObject({ id: A, vault: true });

    writeLease(w, { provider: "claude", account: A, pid: process.pid, agent: "cc-abc123", session: "3f9a2b7c-1111-4222-8333-944455556666" });
    writeMark(w, A, { state: "exhausted", until: Date.now() + 3_600_000, at: Date.now() + 1, reason: "five_hour", gen: "old-credential" });
    expect(svc.snapshot().accounts[0]?.usage?.state).toBe("ok"); // about another credential: not shown
    writeMark(w, A, { state: "exhausted", until: Date.now() + 3_600_000, at: Date.now() + 1, reason: "five_hour", gen: "g1" });
    svc.syncLeases();
    snap = svc.snapshot();
    expect(snap.leases).toEqual([{ account: A, provider: "claude", agent: "cc-abc123", since: expect.any(Number) }]);
    expect(snap.accounts[0]?.usage).toMatchObject({ state: "exhausted", reason: "limit_reached", source: "session" });
    expect(JSON.stringify(snap)).not.toContain("3f9a2b7c"); // the session id stays local
    svc.stop();
  });

  test("a vault account whose real login is recorded here is one record (the login meters it); removal forgets it", async () => {
    const w = dir();
    let entries = [entry({ id: "b".repeat(24), provider: "codex", home: join(w, "nohome"), label: "ChatGPT account" })];
    const svc = new AccountsService(w, log, () => undefined, { home: dir(), fetch: fakeFetch().fetch, keychain: noKeychain, vault: { list: () => entries, claudeToken: async () => TOKEN }, poll: false });
    svc.syncVault();
    expect(svc.snapshot().accounts.map((a) => a.id)).toEqual(["b".repeat(24)]);
    entries = [];
    svc.syncVault();
    expect(svc.snapshot().accounts).toEqual([]);
  });

  test("round 3 (Codex 6): a replaced credential (new generation) is published at once and its old reading dropped", async () => {
    const w = dir();
    let entries = [entry()];
    const snaps: AccountsSnapshot[] = [];
    const svc = new AccountsService(w, log, (s) => snaps.push(s), { home: dir(), fetch: fakeFetch().fetch, keychain: noKeychain, vault: { list: () => entries, claudeToken: async () => TOKEN }, tickMs: 3_600_000 });
    await svc.tick();
    expect(svc.snapshot().accounts[0]?.usage?.state).toBe("ok");
    const published = snaps.length;
    svc.syncVault();
    expect(snaps.length).toBe(published); // nothing changed: no publication
    entries = [entry({ gen: "g2" })];
    svc.syncVault();
    expect(snaps.length).toBe(published + 1);
    expect(svc.snapshot().accounts[0]?.usage ?? null).toBeNull(); // the reading was about the old credential
    svc.stop();
  });

  test("a wrapped session (WALKIE_ACCOUNT) counts as an agent of its vault account, not a 'Token login'", () => {
    const w = dir();
    const svc = new AccountsService(w, log, () => undefined, { home: dir(), fetch: fakeFetch().fetch, keychain: noKeychain, vault: vaultOf([entry()]), poll: false });
    svc.syncVault();
    svc.observe([{ agent: "cc-abc123", runtime: "claude-code", account: A }, { agent: "cc-zzz999", runtime: "claude-code", account: "c".repeat(24) }]);
    const snap = svc.snapshot();
    expect(snap.accounts.map((a) => [a.id, a.agents])).toEqual([[A, ["cc-abc123"]]]);
  });

  test("session readings (Codex rate limits) show when newer than the poller's", () => {
    const w = dir();
    const svc = new AccountsService(w, log, () => undefined, { home: dir(), fetch: fakeFetch().fetch, keychain: noKeychain, vault: vaultOf([entry()]), poll: false });
    svc.syncVault();
    writeSessionReading(w, A, { at: Date.now(), state: "ok", reason: null, source: "session", until: null, windows: [{ kind: "session", used_pct: 61, resets_at: null, window_s: 18_000, scope: null }] });
    expect(svc.snapshot().accounts[0]?.usage?.windows[0]?.used_pct).toBe(61);
  });
});

describe("candidates for the switcher", () => {
  const view = (over: Partial<AccountView>): AccountView => ({
    key: `alex:${A}`, id: A, provider: "claude", label: "al***@ex***.com", plan: null, owners: ["alex"], claimed_by: [], usage: null, usage_host: null, last_seen: 1,
    machines: [{ node_id: "n-mac", hostname: "alex-mac", handle: "alex", online: true, self: false, agents: [], usage: null, vault: { policy: "own" } }],
    vault: { policy: "own" }, leases: [], ...over,
  });
  const base = { provider: "claude" as const, entries: [], saved: new Map(), marks: {}, localLeases: new Map<string, number>() };

  test("hand-outs: own-machines accounts reach the owner's other machines; shared only the listed teammates; never Codex", () => {
    expect(candidatesFrom({ ...base, pooled: { accounts: [view({})], me: "alex" } }).map((c) => [c.source, c.node])).toEqual([["peer", "n-mac"]]);
    expect(candidatesFrom({ ...base, pooled: { accounts: [view({})], me: "kira" } })).toEqual([]);
    const shared = view({ machines: [{ node_id: "n-mac", hostname: "alex-mac", handle: "alex", online: true, self: false, agents: [], usage: null, vault: { policy: "shared", share_with: ["kira"] } }] });
    // Round 1 (Opus 4): a teammate's shared account only with the borrower's opt-in.
    expect(candidatesFrom({ ...base, pooled: { accounts: [shared], me: "kira" } })).toEqual([]);
    expect(candidatesFrom({ ...base, borrow: true, pooled: { accounts: [shared], me: "kira" } })[0]).toMatchObject({ own: false, owner: "alex", source: "peer", leases: 0 });
    expect(candidatesFrom({ ...base, borrow: true, pooled: { accounts: [shared], me: "arvid" } })).toEqual([]);
    expect(candidatesFrom({ ...base, provider: "codex", pooled: { accounts: [view({ provider: "codex" })], me: "alex" } })).toEqual([]);
    expect(mayLease({ policy: "local" }, "alex", "alex")).toBe(false);
  });

  test("a local vault entry uses its OWNER's reading and only verified leases (round 1, Codex 7)", () => {
    const u = { at: Date.now(), state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [] };
    const lease = (verified: boolean) => ({ handle: "kira", hostname: "k", node_id: "x", agent: null, since: 1, verified });
    const c = candidatesFrom({ ...base, entries: [entry()], pooled: { accounts: [view({ usage: u, leases: [lease(true), lease(false)] })], me: "alex" } });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ source: "local", usage: u, leases: 1, gen: "g1" });
    // Another member's entry for the same id (exhausted, with leases) never touches the local account.
    const mal = view({ key: `mal:${A}`, owners: ["mal"], usage: { ...u, state: "exhausted" as const, until: Date.now() + 1e7 }, leases: [lease(true), lease(true)] });
    const d = candidatesFrom({ ...base, entries: [entry()], pooled: { accounts: [mal], me: "alex" } });
    expect(d[0]).toMatchObject({ usage: null, leases: 0, meterless: true });
  });
});

describe("hook side channel", () => {
  test("written only to a regular file inside ~/.walkie/run; the Stop hook's block is recorded as blocked", () => {
    const w = dir();
    mkdirSync(join(w, "run"));
    const file = join(w, "run", "switch-1.jsonl");
    writeFileSync(file, "");
    const env = { WALKIE_HOME: w, WALKIE_SWITCH_EVENTS: file };
    const prev = process.env.WALKIE_HOME;
    process.env.WALKIE_HOME = w;
    try {
      recordSwitchEvent({ hook_event_name: "SessionStart", session_id: "3f9a2b7c-1111-4222-8333-944455556666", transcript_path: "/x/t.jsonl" }, env);
      recordSwitchEvent({ hook_event_name: "Stop", session_id: "3f9a2b7c-1111-4222-8333-944455556666" }, env); // not read by the switcher (round 3)
      recordSwitchEvent({ hook_event_name: "NotAnEvent" }, env);
      const got = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(got).toEqual([{ ev: "SessionStart", sid: "3f9a2b7c-1111-4222-8333-944455556666", tp: "/x/t.jsonl", ts: expect.any(Number) }]);
      expect(switchEventsFile({ WALKIE_SWITCH_EVENTS: join(w, "elsewhere.jsonl") })).toBeNull();
      symlinkSync(file, join(w, "run", "link.jsonl"));
      expect(switchEventsFile({ WALKIE_SWITCH_EVENTS: join(w, "run", "link.jsonl") })).toBeNull();
      expect(switchEventsFile({ WALKIE_SWITCH_EVENTS: join(w, "run", "..", "x.jsonl") })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = prev;
    }
  });
});

describe("watchers", () => {
  test("Claude: the session from the SessionStart event; the limit from the transcript; earlier lines ignored", () => {
    const d = dir();
    const events = join(d, "ev.jsonl");
    writeFileSync(events, "");
    const tp = join(d, "t.jsonl");
    const since = Date.now();
    writeFileSync(tp, JSON.stringify({ type: "assistant", timestamp: new Date(since - 60_000).toISOString(), isApiErrorMessage: true, error: "rate_limit", quotaLimits: { resetsAt: 1 } }) + "\n");
    const sid = "3f9a2b7c-1111-4222-8333-944455556666";
    const w = new ClaudeWatcher({ eventsFile: events, configDir: d, cwd: d, session: null, since });
    const ev = (e: Record<string, unknown>) => writeFileSync(events, JSON.stringify(e) + "\n", { flag: "a" });
    ev({ ev: "SessionStart", sid, tp, ts: since + 1 });
    expect(w.poll(since + 10)).toMatchObject({ session: sid, limit: null, background: [], promptAfterLimit: false });
    ev({ ev: "UserPromptSubmit", sid, tp, ts: since + 20 });
    expect(w.poll(since + 30).promptAfterLimit).toBe(false); // before the limit: an ordinary prompt
    writeFileSync(tp, JSON.stringify({ type: "assistant", timestamp: new Date(since + 40).toISOString(), isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, quotaLimits: { resetsAt: 1_790_421_000, rateLimitType: "seven_day" } }) + "\n", { flag: "a" });
    const s = w.poll(since + 50);
    expect(s.limit).toMatchObject({ until: 1_790_421_000_000, window: "seven_day" });
    expect(s.promptAfterLimit).toBe(false);
    ev({ ev: "UserPromptSubmit", sid, tp, ts: since + 60 });
    expect(w.poll(since + 70).promptAfterLimit).toBe(true); // a prompt after the limit is carried to the next account
  });

  test("Codex: task_started / task_complete, rate limits, usage_limit_exceeded with the retry time from the message", () => {
    const d = dir();
    const sid = "35a3fc06-a27b-7106-8fd8-f2bb6d700e29";
    const day = new Date();
    const sessions = join(d, "sessions");
    const dd = join(sessions, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    mkdirSync(dd, { recursive: true });
    const f = join(dd, `rollout-2026-09-26T10-00-00-${sid}.jsonl`);
    const since = Date.now();
    const ts = (o: number) => new Date(since + o).toISOString();
    writeFileSync(f, [
      { type: "session_meta", timestamp: ts(1), payload: { id: sid, cwd: d, timestamp: ts(1) } },
      { type: "event_msg", timestamp: ts(2), payload: { type: "task_started" } },
      { type: "event_msg", timestamp: ts(3), payload: { type: "token_count", rate_limits: { primary: { used_percent: 97, window_minutes: 300, resets_at: 1_790_430_000 }, secondary: null } } },
      { type: "event_msg", timestamp: ts(4), payload: { type: "task_complete", error: { message: "You've hit your usage limit. Try again at Sep 30th, 2026 8:54 PM.", codex_error_info: "usage_limit_exceeded" } } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");
    // Unbound (no process association, no session id): nothing is read — never a guessed rollout (round 1, Codex 5).
    const unbound = new CodexWatcher({ sessionsDir: sessions, cwd: d, session: null, since });
    const w = new CodexWatcher({ sessionsDir: sessions, cwd: d, session: null, since, openRollout: async () => f });
    return unbound.refresh(since + 10).then((u) => {
      expect(u).toMatchObject({ bound: false, session: null, limit: null, reading: null });
      return w.refresh(since + 10);
    }).then((s) => {
      expect(s.bound).toBe(true);
      expect(s.session).toBe(sid);
      expect(s.background).toEqual([]);
      expect(s.reading?.windows[0]?.used_pct).toBe(97);
      expect(s.limit?.until).toBe(Date.parse("Sep 30, 2026 8:54 PM"));
      expect(codexRetryAt("no time here")).toBeNull();
    });
  });
});

describe("pooled view (accountsView): vault badges, leases, and unknown readings never hide known ones", () => {
  const NOW = Date.parse("2026-09-26T18:00:00Z");
  const X = "a1c0ffee0000000000000001";
  const node = (id: string, login: string, hostname: string) => [id, { node_id: id, login, hostname, pubkey: "k", ip: "100.64.0.1", port: 1, revoked: false }] as const;
  const member = (login: string, handle: string) => [login, { login, handle, role: "member" as const }] as const;
  const ok = (at: number, used: number) => ({ at, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [{ kind: "session" as const, used_pct: used, resets_at: at + 3_600_000, window_s: 18_000, scope: null }] });
  const unknown = (at: number) => ({ at, state: "unknown" as const, reason: "no_usage_api" as const, source: "none" as const, until: null, windows: [] });

  test("the owner's vault machine carries the badge; a teammate's wrapped session on it is listed under the owner", async () => {
    const { accountsView } = await import("../../src/daemon/views.ts");
    const roster = {
      team: null, channels: new Map(),
      members: new Map([member("alex@x", "alex"), member("kira@x", "kira")]),
      nodes: new Map([node("mac", "alex@x", "alex-mac"), node("hestia", "alex@x", "hestia"), node("kmac", "kira@x", "kira-mbp")]),
    };
    const peers: Record<string, unknown> = {
      mac: { at: NOW, accounts: [{ id: X, provider: "claude", label: "al***@ex***.com", plan: null, agents: [], usage: ok(NOW - 30 * 60_000, 40), last_seen: NOW }] },
      hestia: { at: NOW, accounts: [{ id: X, provider: "claude", label: "al***@ex***.com", plan: null, agents: [], usage: unknown(NOW - 1_000), last_seen: NOW, vault: { policy: "shared", share_with: ["kira"] } }] },
      kmac: { at: NOW, accounts: [], leases: [{ account: X, provider: "claude", agent: "cc-kira01", since: NOW - 5_000, owner: "alex" }] },
    };
    const core = { roster, nodeId: "self-none", accounts: null } as unknown as import("../../src/daemon/core.ts").Core;
    const sync = { peerState: (id: string) => (peers[id] ? { accounts: peers[id], skewMs: 0 } : undefined), isOnline: () => true } as unknown as import("../../src/daemon/sync.ts").SyncManager;
    const list = accountsView(core, sync, NOW);
    expect(list).toHaveLength(1);
    const a = list[0] as AccountView;
    expect(a.vault).toEqual({ policy: "shared", share_with: ["kira"] });
    expect(a.machines.find((m) => m.hostname === "hestia")?.vault?.policy).toBe("shared");
    expect(a.usage?.state).toBe("ok"); // hestia's newer "unknown" does not hide alex-mac's 30-minute-old reading
    // Kira's machine claims a lease on Alex's account: listed under Alex, but unverified (this daemon granted nothing).
    expect(a.leases).toEqual([{ handle: "kira", hostname: "kira-mbp", node_id: "kmac", agent: "cc-kira01", since: NOW - 5_000, verified: false }]);
  });
});

describe("sessions outside the switcher", () => {
  test("a running Claude session on a machine with vault Claude accounts, not wrapped, is listed; wrapped or offline ones are not", async () => {
    const { unswitchedSessions } = await import("../../src/protocol/accounts-format.ts");
    const acct = {
      key: "alex:x", id: "x".repeat(24), provider: "claude", label: "Claude account", plan: null, owners: ["alex"], claimed_by: [], usage: null, usage_host: null, last_seen: 1,
      machines: [{ node_id: "mac", hostname: "alex-mac", handle: "alex", online: true, self: true, agents: ["cc-wrapped"], usage: null, vault: { policy: "local" } }],
      leases: [{ handle: "alex", hostname: "alex-mac", node_id: "mac", agent: "cc-leased", since: 1 }],
    } as unknown as AccountView;
    const ag = (agent: string, runtime: string, node = "mac", state = "idle") => ({ node, hostname: "alex-mac", handle: "alex", agent, effective_state: state, status: { runtime } });
    const got = unswitchedSessions([
      ag("cc-old", "claude-code"), ag("cc-wrapped", "claude-code"), ag("cc-leased", "claude-code"), ag("cc-gone", "claude-code", "mac", "offline"),
      ag("codex-x", "codex"), ag("cc-other", "claude-code", "hestia"),
    ], [acct]);
    expect(got.map((u) => u.agent)).toEqual(["cc-old"]);
  });
});

describe("the side channel belongs to the wrapped session only", () => {
  test("a nested claude's events (another pid, another session) are ignored; the session's own /clear is followed", () => {
    const d = dir();
    const events = join(d, "ev.jsonl");
    writeFileSync(events, "");
    const since = Date.now();
    const SID = "3f9a2b7c-1111-4222-8333-944455556666";
    const NESTED = "9fb4b7fa-0000-4000-8000-000000000000";
    const CLEARED = "35a3fc06-a67b-4532-8df8-f2bb6d700e29";
    const w = new ClaudeWatcher({ eventsFile: events, configDir: d, cwd: d, session: SID, since, childPid: () => 4242 });
    const ev = (e: Record<string, unknown>) => writeFileSync(events, JSON.stringify(e) + "\n", { flag: "a" });
    ev({ ev: "SessionStart", sid: SID, cpid: 4242, ts: since + 1 });
    ev({ ev: "SessionStart", sid: NESTED, cpid: 5555, ts: since + 3 });
    ev({ ev: "UserPromptSubmit", sid: NESTED, cpid: 5555, ts: since + 4 });
    expect(w.poll(since + 10)).toMatchObject({ session: SID });
    ev({ ev: "SessionStart", sid: CLEARED, cpid: 4242, ts: since + 20 });
    expect(w.poll(since + 30)).toMatchObject({ session: CLEARED });
    ev({ ev: "SessionStart", sid: NESTED, ts: since + 40 }); // no pid, not our session
    expect(w.poll(since + 50).session).toBe(CLEARED);
  });
});

describe("round 1 (Codex 7): leases are verified or informational, never moved onto another owner", () => {
  test("a hand-out this owner daemon granted is verified; a claim naming a nonexistent owner entry lands nowhere", async () => {
    const { accountsView } = await import("../../src/daemon/views.ts");
    const { GrantBook } = await import("../../src/daemon/vault-lease.ts");
    const NOW = Date.parse("2026-09-26T18:00:00Z");
    const X = "a1c0ffee0000000000000001";
    const node = (id: string, login: string, hostname: string) => [id, { node_id: id, login, hostname, pubkey: "k", ip: "100.64.0.1", port: 1, revoked: false }] as const;
    const roster = {
      team: null, channels: new Map(),
      members: new Map([["alex@x", { login: "alex@x", handle: "alex", role: "member" as const }], ["kira@x", { login: "kira@x", handle: "kira", role: "member" as const }]]),
      nodes: new Map([node("mac", "alex@x", "alex-mac"), node("kmac", "kira@x", "kira-mbp")]),
    };
    const grants = new GrantBook();
    const grant = grants.record(X, "kmac", NOW);
    const self = { at: NOW, accounts: [{ id: X, provider: "claude", label: "al***@ex***.com", plan: null, agents: [], usage: null, last_seen: NOW, vault: { policy: "shared", share_with: ["kira"] } }] };
    const peers: Record<string, unknown> = {
      kmac: { at: NOW, accounts: [], leases: [
        { account: X, provider: "claude", agent: "cc-granted", since: NOW, owner: "alex", grant },
        { account: "b".repeat(24), provider: "claude", agent: "cc-fake", since: NOW, owner: "alex" },
      ] },
    };
    const core = { roster, nodeId: "mac", accounts: self, myHandle: () => "alex", vaultGrants: grants } as unknown as import("../../src/daemon/core.ts").Core;
    const sync = { peerState: (id: string) => (peers[id] ? { accounts: peers[id], skewMs: 0 } : undefined), isOnline: () => true } as unknown as import("../../src/daemon/sync.ts").SyncManager;
    const list = accountsView(core, sync, NOW);
    expect(list).toHaveLength(1);
    expect(list[0]?.leases).toEqual([{ handle: "kira", hostname: "kira-mbp", node_id: "kmac", agent: "cc-granted", since: NOW, verified: true }]);
  });
});
