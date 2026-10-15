import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexIdentityFrom } from "../../src/accounts/adapters/codex.ts";
import { pollAccount } from "../../src/accounts/poll.ts";
import { AccountsService, loginFor } from "../../src/accounts/service.ts";
import { pendingCodexHome, removeCodexHome, syncCodexHome } from "../../src/accounts/vault/codex-home.ts";
import { removeLeaseHome, sweepLeaseHomes } from "../../src/accounts/vault/codex-lease-home.ts";
import { wasCodexSessionsShared } from "../../src/accounts/vault/codex-shared.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { fakeFetch, fixture, makeFakeHome } from "../helpers/accounts.ts";

const NOW = Date.parse("2026-09-26T18:10:00Z");
const identity = codexIdentityFrom(fixture("codex-auth.json"))!;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync("/tmp/walkie-shared-sessions-");
  roots.push(root);
  const home = makeFakeHome(join(root, "home"), { codexExpiresAt: NOW + 60_000 });
  const walkie = join(root, "walkie");
  const vaultRoot = join(walkie, "vault", "codex");
  const sessions = join(home, ".codex", "sessions");
  const day = join(sessions, "2026", "09", "26");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-vault.jsonl"), JSON.stringify({
    timestamp: new Date(NOW).toISOString(),
    payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, window_minutes: 10080 } } },
  }) + "\n");
  const login = loginFor({ runtime: "codex" }, home);
  const poll = () => pollAccount("codex", login, identity, null, 0, {
    fetch: fakeFetch().fetch, keychain: async () => "", now: NOW, keychainBlockedUntil: 0, codexVaultRoot: vaultRoot,
  });
  return { root, home, walkie, vaultRoot, sessions, poll };
}

test("removing a pre-marker vault home before any poll records its shared sessions", async () => {
  const s = setup();
  const vaultHome = join(s.vaultRoot, "account");
  mkdirSync(vaultHome, { recursive: true });
  symlinkSync(s.sessions, join(vaultHome, "sessions"));
  removeCodexHome(vaultHome, s.walkie);
  const result = await s.poll();
  expect(result.passiveShared).toBe(true);
  expect(result.reading?.source).not.toBe("session");
});

test("removing a pre-marker lease home fences its retained rollout", async () => {
  const s = setup();
  const lease = join(s.vaultRoot, "lease-0123456789abcdef");
  mkdirSync(lease, { recursive: true });
  symlinkSync(s.sessions, join(lease, "sessions"));
  removeLeaseHome(lease, s.walkie);
  const result = await s.poll();
  expect(result.passiveShared).toBe(true);
  expect(result.reading?.source).not.toBe("session");
});

test("sweeping a pre-marker lease home fences its retained rollout", async () => {
  const s = setup();
  const lease = join(s.vaultRoot, "lease-0123456789abcdef");
  mkdirSync(lease, { recursive: true });
  symlinkSync(s.sessions, join(lease, "sessions"));
  writeFileSync(join(lease, ".walkie-lease"), "99999999");
  expect(sweepLeaseHomes(s.walkie)).toBe(1);
  const result = await s.poll();
  expect(result.passiveShared).toBe(true);
  expect(result.reading?.source).not.toBe("session");
});

test("removing a lease with a dangling sessions link fences a restored rollout", async () => {
  const s = setup();
  const lease = join(s.vaultRoot, "lease-0123456789abcdef");
  mkdirSync(lease, { recursive: true });
  symlinkSync(s.sessions, join(lease, "sessions"));
  const saved = join(s.root, "retained-sessions");
  renameSync(s.sessions, saved);
  removeLeaseHome(lease, s.walkie);
  renameSync(saved, s.sessions);
  const result = await s.poll();
  expect(result.passiveShared).toBe(true);
  expect(result.reading?.source).not.toBe("session");
});

test("a transient vault scan error withholds only this poll, then restores an unshared meter", async () => {
  const s = setup();
  mkdirSync(join(s.walkie, "vault"), { recursive: true });
  writeFileSync(s.vaultRoot, "temporarily unreadable as a directory");
  const blocked = await s.poll();
  expect(blocked.reading?.source).not.toBe("session");
  expect(blocked.passiveShared).toBeUndefined();
  unlinkSync(s.vaultRoot);
  expect((await s.poll()).reading?.source).toBe("session");

  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  let now = NOW;
  const service = new AccountsService(s.walkie, log, () => undefined, {
    home: s.home, fetch: fakeFetch().fetch, keychain: async () => "", clock: () => now,
  });
  service.observe([{ agent: "codex-error", runtime: "codex" }]);
  writeFileSync(s.vaultRoot, "temporary error");
  await service.tick();
  unlinkSync(s.vaultRoot);
  now += 5 * 60_000;
  await service.tick();
  expect(service.snapshot().accounts.find((a) => a.provider === "codex")?.usage?.source).toBe("session");
  expect(readFileSync(join(s.walkie, "accounts.json"), "utf8")).not.toContain("passive_blocked");
});

test("a rebuilt store still finds the marker after the shared sessions folder moves", async () => {
  const s = setup();
  const vaultHome = pendingCodexHome(s.walkie, join(s.home, ".codex"));
  removeCodexHome(vaultHome, s.walkie);
  const moved = join(s.home, ".codex", "sessions-moved");
  renameSync(s.sessions, moved);
  symlinkSync(moved, s.sessions);
  const result = await s.poll();
  expect(result.passiveShared).toBe(true);
  expect(result.reading?.source).not.toBe("session");
});

test("a symlinked vault home is scanned for a sessions link", async () => {
  const s = setup();
  const actual = join(s.root, "actual-vault-home");
  mkdirSync(s.vaultRoot, { recursive: true });
  mkdirSync(actual);
  symlinkSync(s.sessions, join(actual, "sessions"));
  symlinkSync(actual, join(s.vaultRoot, "alias"));
  const result = await s.poll();
  expect(result.passiveShared).toBe(true);
  expect(result.reading?.source).not.toBe("session");
});

test("startup marks a pre-marker vault link before external deletion and the first poll", async () => {
  const s = setup();
  const vaultHome = join(s.vaultRoot, "old-account");
  mkdirSync(vaultHome, { recursive: true });
  symlinkSync(s.sessions, join(vaultHome, "sessions"));
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const service = new AccountsService(s.walkie, log, () => undefined, {
    home: s.home, fetch: fakeFetch().fetch, keychain: async () => "", clock: () => NOW, poll: false,
  });
  service.start();
  rmSync(vaultHome, { recursive: true });
  expect((await s.poll()).passiveShared).toBe(true);
  service.stop();
});

test("removal of a vault home with a dangling sessions link records its target and succeeds", async () => {
  const s = setup();
  const vaultHome = join(s.vaultRoot, "old-account");
  mkdirSync(vaultHome, { recursive: true });
  symlinkSync(s.sessions, join(vaultHome, "sessions"));
  const saved = join(s.root, "retained-sessions");
  renameSync(s.sessions, saved);
  expect(removeCodexHome(vaultHome, s.walkie).moved).toEqual([]);
  expect(readdirSync(s.vaultRoot).some((name) => name.startsWith(".shared-sessions-"))).toBe(true);
  renameSync(saved, s.sessions);
  expect(wasCodexSessionsShared(s.vaultRoot, realpathSync(s.sessions))).toBe("shared");
  expect((await s.poll()).reading?.source).not.toBe("session");
});

test("sync repairs a dangling sessions link and fences its old target", async () => {
  const s = setup();
  const vaultHome = pendingCodexHome(s.walkie, join(s.home, ".codex"));
  const old = join(realpathSync(s.root), "missing-sessions");
  unlinkSync(join(vaultHome, "sessions"));
  symlinkSync(old, join(vaultHome, "sessions"));
  expect(() => syncCodexHome(vaultHome, join(s.home, ".codex"))).not.toThrow();
  expect(realpathSync(join(vaultHome, "sessions"))).toBe(realpathSync(s.sessions));
  expect(wasCodexSessionsShared(s.vaultRoot, old)).toBe("shared");
  removeCodexHome(vaultHome, s.walkie);
  const result = await s.poll();
  expect(result.passiveShared).toBe(true);
  expect(result.reading?.source).not.toBe("session");
});

test("a failed startup sweep retries on tick and fences a removed vault home", async () => {
  const s = setup();
  const vaultHome = join(s.vaultRoot, "old-account");
  mkdirSync(vaultHome, { recursive: true });
  symlinkSync(s.sessions, join(vaultHome, "sessions"));
  const warnings: string[] = [];
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: (message) => { warnings.push(message); }, error: quiet };
  const service = new AccountsService(s.walkie, log, () => undefined, { home: s.home, poll: false, clock: () => NOW });
  chmodSync(s.vaultRoot, 0o000);
  try { service.start(); }
  finally { chmodSync(s.vaultRoot, 0o700); }
  expect(warnings).toContain("codex_shared_sessions_sweep_failed");
  await service.tick();
  rmSync(vaultHome, { recursive: true });
  const result = await s.poll();
  expect(result.passiveShared).toBe(true);
  expect(result.reading?.source).not.toBe("session");
  service.stop();
});

test("a pre-marker home with no search permission keeps the sweep retry open", async () => {
  const s = setup();
  const lease = join(s.vaultRoot, "lease-0123456789abcdef");
  mkdirSync(lease, { recursive: true });
  symlinkSync(s.sessions, join(lease, "sessions"));
  writeFileSync(join(s.walkie, "accounts.json"), JSON.stringify({ version: 1, records: [{
    id: identity.id, provider: "codex", label: identity.label, plan: identity.plan,
    dir: join(s.home, ".codex"), is_default: true, last_seen: NOW,
    reading: { at: NOW, state: "exhausted", reason: "limit_reached", source: "session", windows: [], until: null },
  }] }));
  const warnings: string[] = [];
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: (message) => { warnings.push(message); }, error: quiet };
  const published: ReturnType<AccountsService["snapshot"]>[] = [];
  const service = new AccountsService(s.walkie, log, (snapshot) => { published.push(snapshot); }, { home: s.home, poll: false, clock: () => NOW });
  chmodSync(lease, 0o000);
  try {
    service.start();
    expect(warnings).toContain("codex_shared_sessions_sweep_failed");
    expect(published[0]?.accounts.find((account) => account.id === identity.id)?.usage?.source).not.toBe("session");
    expect(readdirSync(s.vaultRoot).some((name) => name.startsWith(".shared-sessions-"))).toBe(false);
  } finally { chmodSync(lease, 0o700); }
  await service.tick();
  expect(readdirSync(s.vaultRoot).some((name) => name.startsWith(".shared-sessions-"))).toBe(true);
  service.stop();
});

test("a pre.15 local session reading and clock are fenced before snapshot and first publish", () => {
  const s = setup();
  const lease = join(s.vaultRoot, "lease-0123456789abcdef");
  mkdirSync(lease, { recursive: true });
  symlinkSync(s.sessions, join(lease, "sessions"));
  const id = identity.id;
  const reading = {
    at: NOW, state: "exhausted", reason: "limit_reached", source: "session",
    windows: [{ kind: "weekly", used_pct: 100, resets_at: NOW + 60_000, window_s: 604800, scope: null }], until: null,
  };
  const clock = [{ kind: "weekly", scope: null, window_s: 604800, resets_at: NOW + 60_000, observed_at: NOW, exhausted: true, source: "session" }];
  const oldStore = JSON.stringify({ version: 1, records: [{
    id, provider: "codex", label: identity.label, plan: identity.plan, dir: join(s.home, ".codex"),
    is_default: true, last_seen: NOW, reading, clock,
  }] });
  writeFileSync(join(s.walkie, "accounts.json"), oldStore);
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const published: ReturnType<AccountsService["snapshot"]>[] = [];
  const service = new AccountsService(s.walkie, log, (snapshot) => { published.push(snapshot); }, { home: s.home, poll: false, clock: () => NOW });
  service.start();
  const first = published[0]?.accounts.find((account) => account.id === id);
  expect(first?.usage?.source).not.toBe("session");
  expect(first?.clock?.some((entry) => entry.source === "session") ?? false).toBe(false);
  expect(JSON.parse(readFileSync(join(s.walkie, "accounts.json"), "utf8")).records[0].passive_blocked).toBe(true);
  service.stop();

  writeFileSync(join(s.walkie, "accounts.json"), oldStore);
  const beforeStart = new AccountsService(s.walkie, log, () => undefined, { home: s.home, poll: false, clock: () => NOW });
  const before = beforeStart.snapshot().accounts.find((account) => account.id === id);
  expect(before?.usage?.source).not.toBe("session");
  expect(before?.clock?.some((entry) => entry.source === "session") ?? false).toBe(false);
});

test("occupied marker paths fence passive readings but allow vault sync and removal", async () => {
  const s = setup();
  mkdirSync(s.vaultRoot, { recursive: true });
  const marker = join(s.vaultRoot, `.shared-sessions-${createHash("sha256").update(realpathSync(s.sessions)).digest("hex")}`);
  const { dev, ino } = statSync(s.sessions, { bigint: true });
  const inodeMarker = join(s.vaultRoot, `.shared-sessions-inode-${createHash("sha256").update(`${dev}:${ino}`).digest("hex")}`);
  mkdirSync(marker);
  mkdirSync(inodeMarker);
  const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const vaultHome = pendingCodexHome(s.walkie, join(s.home, ".codex"));
    expect((await s.poll()).passiveShared).toBe(true);
    rmSync(marker, { recursive: true });
    expect((await s.poll()).passiveShared).toBe(true);
    expect(removeCodexHome(vaultHome, s.walkie).moved).toEqual([]);
    expect(warnings.mock.calls.length).toBeGreaterThan(0);
  } finally { warnings.mockRestore(); }
});

test("startup logs an unreadable vault root and continues", () => {
  const s = setup();
  mkdirSync(join(s.walkie, "vault"), { recursive: true });
  writeFileSync(s.vaultRoot, "not a directory");
  const warnings: string[] = [];
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: (message) => { warnings.push(message); }, error: quiet };
  const service = new AccountsService(s.walkie, log, () => undefined, { home: s.home, poll: false });
  expect(() => service.start()).not.toThrow();
  expect(warnings).toContain("codex_shared_sessions_sweep_failed");
  service.stop();
});
