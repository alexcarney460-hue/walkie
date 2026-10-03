import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SeatsHost } from "../../src/daemon/seats/host.ts";
import { createWorkerRoot } from "../../src/daemon/seats/worker-root.ts";
import { signInCodex } from "../helpers/fake-seat-users.ts";
import { doctorChecks } from "../../src/daemon/seats/doctor.ts";
import { doctorLines } from "../../src/cli/commands/seats-enable.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture(expiresInMs = 3_600_000) {
  const home = mkdtempSync(join(tmpdir(), "walkie-login-test-"));
  homes.push(home);
  const worker = join(home, "worker-claude");
  mkdirSync(worker);
  mkdirSync(join(home, ".claude"));
  const creds = (token: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "refresh-is-never-copied", expiresAt, scopes: ["user:inference"] } });
  writeFileSync(join(worker, ".credentials.json"), creds("worker-access", Date.now() + expiresInMs));
  writeFileSync(join(home, ".claude", ".credentials.json"), creds("default-access", Date.now() + 8 * 3_600_000));
  const root = createWorkerRoot(home, "0123456789abcdef:1");
  const seat = { run: { runtime: "claude", timeout_s: 3_600 }, workerRoot: root, v2: null, projectedClaudeToken: null };
  return { home, worker, root, seat };
}

async function projected(f: ReturnType<typeof fixture>, source: string, fallback: () => Promise<{ claude_credentials?: string }>, inherit = false) {
  const host = { home: f.home, current: { inherit_person_config: inherit }, withClaudeLogin: (env: Record<string, string>) => env, claudeCredentials: fallback };
  const method = (SeatsHost.prototype as unknown as { sameUserEnv: (this: unknown, seat: unknown, env: Record<string, string>) => Promise<Record<string, string>> }).sameUserEnv;
  return method.call(host, f.seat, { CLAUDE_CONFIG_DIR: source });
}

test("selected worker file projects its own login, never the default", async () => {
  const f = fixture(8 * 3_600_000);
  let fallback = 0;
  const env = await projected(f, f.worker, async () => { fallback++; return { claude_credentials: "default" }; });
  expect(env.CLAUDE_CONFIG_DIR).toBe(f.root.claude);
  expect(readFileSync(join(f.root.claude, ".credentials.json"), "utf8")).toContain("worker-access");
  expect(readFileSync(join(f.root.claude, ".credentials.json"), "utf8")).not.toContain("default-access");
  expect(fallback).toBe(0);
});

test("near-expiry worker file keeps its refreshing source; injected default Keychain is never read", async () => {
  const f = fixture();
  let fallback = 0;
  const env = await projected(f, f.worker, async () => { fallback++; return { claude_credentials: "default-keychain" }; });
  expect(env.CLAUDE_CONFIG_DIR).toBe(f.worker);
  expect(fallback).toBe(0);
  expect(f.seat.projectedClaudeToken).toBeNull();
});

test("a worker with no credential file cannot receive the default Keychain login", async () => {
  const f = fixture();
  rmSync(join(f.worker, ".credentials.json"));
  let fallback = 0;
  const env = await projected(f, f.worker, async () => { fallback++; return { claude_credentials: "default-keychain" }; });
  expect(env.CLAUDE_CONFIG_DIR).toBe(f.worker);
  expect(fallback).toBe(0);
});

test("a long seat keeps the selected refreshing path when the token cannot cover its timeout", async () => {
  const f = fixture(8 * 3_600_000);
  f.seat.run.timeout_s = 24 * 3_600;
  const env = await projected(f, f.worker, async () => { throw new Error("wrong identity"); });
  expect(env.CLAUDE_CONFIG_DIR).toBe(f.worker);
});

test("default Claude login near expiry refuses rather than inheriting personal settings", async () => {
  const f = fixture();
  writeFileSync(join(f.home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "near-default", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"] } }));
  await expect(projected(f, join(f.home, ".claude"), async () => ({}))).rejects.toThrow(/cannot be projected for the full seat timeout/);
});

test("default Codex keyring without a safe file refuses rather than inheriting personal config", async () => {
  const f = fixture();
  const seat = { ...f.seat, run: { runtime: "codex", timeout_s: 3_600 } };
  const host = { home: f.home, current: { inherit_person_config: false }, codexProjection: (SeatsHost.prototype as unknown as { codexProjection: unknown }).codexProjection };
  const method = (SeatsHost.prototype as unknown as { sameUserEnv: (this: unknown, seat: unknown, env: Record<string, string>) => Promise<Record<string, string>> }).sameUserEnv;
  await expect(method.call(host, seat, {})).rejects.toThrow(/default Codex login cannot be projected/);
});

test("empty selected CODEX_HOME has the same doctor and launch refusal", async () => {
  const f = fixture();
  const selected = join(f.home, "selected-codex");
  mkdirSync(selected);
  const methods = SeatsHost.prototype as unknown as {
    codexProjection: (this: unknown, env: Record<string, string>) => Promise<{ copy: string | null; source?: string; reason?: string }>;
    sameUserEnv: (this: unknown, seat: unknown, env: Record<string, string>) => Promise<Record<string, string>>;
  };
  const host = { home: f.home, current: { inherit_person_config: false, ephemeral: false }, env: { CODEX_HOME: selected }, envFile: join(f.home, "missing-env"),
    codexProjection: methods.codexProjection, claudeFileCredentials: () => null,
    claudeCredentials: async () => ({}), machineToken: null, codexReadiness: null, refreshingLogin: null };
  const projection = await methods.codexProjection.call(host, { CODEX_HOME: selected });
  expect(projection.reason).toContain("selected Codex login");
  const seat = { ...f.seat, run: { runtime: "codex", timeout_s: 3_600 } };
  await expect(methods.sameUserEnv.call(host, seat, { CODEX_HOME: selected })).rejects.toThrow(projection.reason);
  await SeatsHost.prototype.refreshLogin.call(host as never);
  expect(host.codexReadiness as unknown).toEqual({ login: "unavailable", reason: projection.reason });
  const local = { allow: true, same_user: true, ephemeral: false, channel_ok: true, claude_login: "machine", codex_login: "unavailable", codex_login_reason: projection.reason } as SeatsLocalView;
  const checks = doctorChecks(local, { team: "test", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: "fake", codex: "fake" } });
  expect(checks.find((check) => check.what.startsWith("Codex seats:"))?.what).toContain(projection.reason);
  expect(doctorLines(checks).at(-1)).toContain("Not ready");
});

test("consented selected Codex keyring login is ready in doctor and retained at launch", async () => {
  const f = fixture();
  const selected = join(f.home, "selected-codex");
  const bin = join(f.home, "bin");
  mkdirSync(selected);
  mkdirSync(bin);
  writeFileSync(join(selected, "keyring-ready"), "fixture");
  writeFileSync(join(bin, "codex"), '#!/bin/sh\ntest "$1" = login && test "$2" = status && test -f "$CODEX_HOME/keyring-ready"\n');
  chmodSync(join(bin, "codex"), 0o700);
  const methods = SeatsHost.prototype as unknown as {
    codexProjection: (this: unknown, env: Record<string, string>) => Promise<{ copy: string | null; source?: string; reason?: string }>;
    sameUserEnv: (this: unknown, seat: unknown, env: Record<string, string>) => Promise<Record<string, string>>;
  };
  const env = { CODEX_HOME: selected, PATH: bin };
  const host = { home: f.home, current: { inherit_person_config: true, ephemeral: false }, env, envFile: join(f.home, "missing-env"),
    codexProjection: methods.codexProjection, claudeFileCredentials: () => null,
    claudeCredentials: async () => ({}), machineToken: null, codexReadiness: null, refreshingLogin: null };
  expect(await methods.codexProjection.call(host, env)).toEqual({ copy: null, source: selected });
  const seat = { ...f.seat, run: { runtime: "codex", timeout_s: 3_600 } };
  expect(await methods.sameUserEnv.call(host, seat, env)).toEqual(env);
  await SeatsHost.prototype.refreshLogin.call(host as never);
  expect(host.codexReadiness as unknown).toEqual({ login: "machine" });
  expect(readFileSync(join(selected, "keyring-ready"), "utf8")).toBe("fixture");
  host.current.inherit_person_config = false;
  expect((await methods.codexProjection.call(host, env)).reason).toContain("selected Codex login");
  await expect(methods.sameUserEnv.call(host, seat, env)).rejects.toThrow(/selected Codex login/);
  host.current.inherit_person_config = true;
  rmSync(join(selected, "keyring-ready"));
  expect((await methods.codexProjection.call(host, env)).reason).toContain("selected Codex login");
  await SeatsHost.prototype.refreshLogin.call(host as never);
  expect(host.codexReadiness as unknown).toMatchObject({ login: "unavailable" });
});

test("a relative selected Codex home is resolved once for the login probe and seat", async () => {
  const f = fixture();
  const selected = join(f.home, "selected-codex");
  const bin = join(f.home, "bin");
  mkdirSync(selected);
  mkdirSync(bin);
  writeFileSync(join(selected, "keyring-ready"), "fixture");
  writeFileSync(join(bin, "codex"), '#!/bin/sh\ntest "$1" = login && test "$2" = status && test -f "$CODEX_HOME/keyring-ready"\n');
  chmodSync(join(bin, "codex"), 0o700);
  const env = { CODEX_HOME: relative(process.cwd(), selected), PATH: bin };
  const methods = SeatsHost.prototype as unknown as {
    codexProjection: (this: unknown, env: Record<string, string>) => Promise<{ copy: string | null; source?: string; reason?: string }>;
    sameUserEnv: (this: unknown, seat: unknown, env: Record<string, string>) => Promise<Record<string, string>>;
  };
  const host = { home: f.home, current: { inherit_person_config: true, ephemeral: false }, env, envFile: join(f.home, "missing-env"),
    codexProjection: methods.codexProjection, claudeFileCredentials: () => null,
    claudeCredentials: async () => ({}), machineToken: null, codexReadiness: null, refreshingLogin: null };
  expect((await methods.codexProjection.call(host, env)).reason).toBeUndefined();
  const seat = { ...f.seat, run: { runtime: "codex", timeout_s: 3_600 } };
  expect((await methods.sameUserEnv.call(host, seat, env)).CODEX_HOME).toBe(selected);
  await SeatsHost.prototype.refreshLogin.call(host as never);
  expect(host.codexReadiness as unknown).toEqual({ login: "machine" });
});

test("an unresolvable selected Codex home is refused by doctor and launch", async () => {
  const f = fixture();
  const env = { CODEX_HOME: "\0relative" };
  const methods = SeatsHost.prototype as unknown as {
    codexProjection: (this: unknown, env: Record<string, string>) => Promise<{ copy: string | null; source?: string; reason?: string }>;
    sameUserEnv: (this: unknown, seat: unknown, env: Record<string, string>) => Promise<Record<string, string>>;
  };
  const host = { home: f.home, current: { inherit_person_config: true, ephemeral: false }, env, envFile: join(f.home, "missing-env"),
    codexProjection: methods.codexProjection, claudeFileCredentials: () => null,
    claudeCredentials: async () => ({}), machineToken: null, codexReadiness: null, refreshingLogin: null };
  const projection = await methods.codexProjection.call(host, env);
  expect(projection.reason).toContain("could not be resolved to an absolute path");
  const seat = { ...f.seat, run: { runtime: "codex", timeout_s: 3_600 } };
  await expect(methods.sameUserEnv.call(host, seat, env)).rejects.toThrow(projection.reason);
  await SeatsHost.prototype.refreshLogin.call(host as never);
  expect(host.codexReadiness as unknown).toEqual({ login: "unavailable", reason: projection.reason });
});

test("default identity may use its injected Keychain login", async () => {
  const f = fixture();
  rmSync(join(f.home, ".claude", ".credentials.json"));
  const value = JSON.stringify({ claudeAiOauth: { accessToken: "keychain-access", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } });
  const env = await projected(f, join(f.home, ".claude"), async () => ({ claude_credentials: value }));
  expect(env.CLAUDE_CONFIG_DIR).toBe(f.root.claude);
  expect(readFileSync(join(f.root.claude, ".credentials.json"), "utf8")).toContain("keychain-access");
});

test("explicit config inheritance retains the selected provider directory", async () => {
  const f = fixture();
  const env = await projected(f, f.worker, async () => { throw new Error("should not project"); }, true);
  expect(env.CLAUDE_CONFIG_DIR).toBe(f.worker);
});

// ---- status reads (SEATS-FIX-5, pre.11 integration review F1) -------------------------------------------------------
// GET /v1/seats serves the verdicts the last explicit check made. It never reads the Keychain, runs `codex login status`
// or sources the seat env file, in any seats mode (the Seats view polls every 2 s while a seat lives).

type Rig = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const count = (file: string): number => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };

/**
 * A SeatsHost without its daemon: only what a login verdict reads, with an injected counting Keychain reader (the real
 * one is never touched), a `codex` that counts `login status` runs, and a seat env file that counts being sourced.
 */
function statusRig(o: { ephemeral?: boolean; inherit?: boolean; expiresInMs?: number; codexKeyring?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "walkie-status-rig-"));
  homes.push(home);
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".walkie"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "status-rig-account-uuid" } }));
  if (!o.codexKeyring) signInCodex(home);
  const bin = join(home, "bin");
  const codexRuns = join(home, "codex-login-status.log");
  const sourced = join(home, "seat-env-sourced.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "$@" >> "${codexRuns}"\nexit 0\n`);
  chmodSync(join(bin, "codex"), 0o700);
  writeFileSync(join(home, ".walkie", "seat-env"), `echo sourced >> "${sourced}"\n`);
  let keychainReads = 0;
  const keychain = async () => {
    keychainReads++;
    return JSON.stringify({ claudeAiOauth: { accessToken: "rig-access-token", refreshToken: "rig-refresh", expiresAt: Date.now() + (o.expiresInMs ?? 30 * 60_000), scopes: ["user:inference"] } });
  };
  const host = Object.create(SeatsHost.prototype) as Rig;
  Object.assign(host, {
    opts: { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, keychain },
    core: { paths: { home: join(home, ".walkie") } },
    current: { allow: true, ephemeral: o.ephemeral === true, inherit_person_config: o.inherit === true },
    iso: { mode: o.ephemeral === true ? "ephemeral" : "same_user" },
    machineToken: null, cachedClaudeAccess: null, knownClaudeExpiry: null, codexReadiness: null, codexCheckedAt: null,
    refreshingLogin: null, refreshingCodex: null, refreshingClaude: null,
  });
  return { host, home, reads: () => keychainReads, codexRuns: () => count(codexRuns), sourced: () => count(sourced) };
}

/** What view() asks of the host about logins: both verdicts and the near-expiry flag. */
const poll = (h: Rig) => ({ claude: h.claudeLogin(), codex: h.codexLogin(), near: h.claudeProjectionNearExpiry() });

const STATUS_CASES: Array<{ name: string; rig: Parameters<typeof statusRig>[0]; keychain: boolean; codex: boolean }> = [
  { name: "same-user, Keychain token near expiry", rig: { expiresInMs: 30 * 60_000 }, keychain: true, codex: false },
  { name: "seat users, Keychain token near expiry", rig: { ephemeral: true, expiresInMs: 30 * 60_000 }, keychain: true, codex: false },
  { name: "same-user inheriting the person's config, Codex in a keyring", rig: { inherit: true, codexKeyring: true, expiresInMs: 8 * 3_600_000 }, keychain: false, codex: true },
];

for (const t of STATUS_CASES) {
  test(`status reads never read the Keychain, run a Codex check or source the seat env: ${t.name}`, async () => {
    const r = statusRig(t.rig);
    for (let i = 0; i < 5; i++) poll(r.host);
    await Bun.sleep(80); // anything a poll started in the background has settled by now
    expect({ keychain: r.reads(), codex: r.codexRuns(), sourced: r.sourced() }).toEqual({ keychain: 0, codex: 0, sourced: 0 });
    // The counters are live: the explicit refresh (start, enable, doctor, a stale launch) does all three.
    await r.host.refreshLogin();
    expect(r.sourced()).toBe(1);
    if (t.keychain) expect(r.reads()).toBeGreaterThanOrEqual(1);
    if (t.codex) expect(r.codexRuns()).toBeGreaterThanOrEqual(1);
    const after = { keychain: r.reads(), codex: r.codexRuns(), sourced: r.sourced() };
    for (let i = 0; i < 5; i++) poll(r.host);
    await Bun.sleep(80);
    expect({ keychain: r.reads(), codex: r.codexRuns(), sourced: r.sourced() }).toEqual(after);
  });
}

test("a machine nobody has checked yet reads as it did before verdicts existed, not as a guess of unavailable", () => {
  const same = statusRig();
  expect(poll(same.host)).toMatchObject({ claude: "machine", codex: "machine" });
  const users = statusRig({ ephemeral: true });
  expect(poll(users.host)).toMatchObject({ claude: "unavailable", codex: "machine" }); // a Keychain-only login, Codex's auth file there
  const noCodex = statusRig({ ephemeral: true, codexKeyring: true });
  expect(poll(noCodex.host)).toMatchObject({ codex: "unavailable" });
});

test("a verdict past its freshness window is still what a status read says: age alone never makes a working machine unavailable", async () => {
  for (const ephemeral of [false, true]) {
    const r = statusRig({ ephemeral, expiresInMs: 8 * 3_600_000 });
    await r.host.refreshLogin();
    expect(poll(r.host)).toMatchObject({ claude: "machine", codex: "machine" });
    const before = r.reads();
    const old = Date.now() - 20 * 60_000;
    if (r.host.machineToken) r.host.machineToken = { ...r.host.machineToken, at: old };
    if (r.host.cachedClaudeAccess) r.host.cachedClaudeAccess = { ...r.host.cachedClaudeAccess, readAt: old };
    r.host.codexCheckedAt = old;
    expect(poll(r.host)).toMatchObject({ claude: "machine", codex: "machine" });
    expect(r.reads()).toBe(before);
  }
});

test("a cached token that is known to be near expiry still reads unavailable, without a read (seats-fix5)", async () => {
  const r = statusRig({ ephemeral: true, expiresInMs: 8 * 3_600_000 });
  await r.host.refreshLogin();
  expect(poll(r.host).claude).toBe("machine");
  const before = r.reads();
  r.host.cachedClaudeAccess = { ...r.host.cachedClaudeAccess, expiresAt: Date.now() + 60_000 };
  expect(poll(r.host).claude).toBe("unavailable");
  expect(r.reads()).toBe(before);
});

// ---- the check just before a launch ------------------------------------------------------------------------------------

/** The launch's own call: which verdict, with which environment, or nothing. */
async function recheck(h: Rig, seat: Record<string, unknown>, env: Record<string, string> = {}) {
  const calls: unknown[][] = [];
  h.refreshLogin = async (...args: unknown[]) => { calls.push(args); };
  await h.recheckLogin(seat, env);
  return calls;
}
const seat = (runtime: string, creds = false) => ({ run: { runtime }, v2: creds ? { creds: {} } : null });

test("a launch re-checks the verdict of its own runtime when it is stale or was never made, and nothing else", async () => {
  const r = statusRig();
  const now = Date.now();
  const env = { CODEX_HOME: "/x" };
  expect(await recheck(r.host, seat("claude"), env)).toEqual([["claude", env]]); // never checked
  expect(await recheck(r.host, seat("codex"), env)).toEqual([["codex", env]]);
  r.host.machineToken = { has: true, at: now - 1_000 };
  r.host.codexCheckedAt = now - 1_000;
  expect(await recheck(r.host, seat("claude"), env)).toEqual([]); // fresh
  expect(await recheck(r.host, seat("codex"), env)).toEqual([]);
  r.host.machineToken = { has: true, at: now - 16 * 60_000 };
  expect(await recheck(r.host, seat("claude"), env)).toEqual([["claude", env]]); // stale: only Claude's
  expect(await recheck(r.host, seat("codex"), env)).toEqual([]);
  r.host.codexCheckedAt = now - 16 * 60_000;
  expect(await recheck(r.host, seat("codex"), env)).toEqual([["codex", env]]);
  expect(await recheck(r.host, seat("kimi"), env)).toEqual([]); // no login verdict for it
});

test("a launch that does not use the machine's login does not re-check it", async () => {
  const r = statusRig();
  expect(await recheck(r.host, seat("claude", true))).toEqual([]); // a named account
  expect(await recheck(r.host, seat("codex", true))).toEqual([]);
  expect(await recheck(r.host, seat("claude"), { CLAUDE_CODE_OAUTH_TOKEN: "set-in-the-seat-env" })).toEqual([]); // its own Claude token
  writeFileSync(join(r.home, ".walkie", "seats-claude-token"), "dedicated-seat-token\n", { mode: 0o600 });
  expect(await recheck(r.host, seat("claude"))).toEqual([]);
  expect((await recheck(r.host, seat("codex"))).length).toBe(1); // Codex has no such override
  const own = statusRig({ inherit: true }); // a same-user seat on the person's own configuration projects no Claude token
  expect(await recheck(own.host, seat("claude"))).toEqual([]);
  expect((await recheck(own.host, seat("codex"))).length).toBe(1);
  const users = statusRig({ ephemeral: true, inherit: true }); // seat users always get a projected token
  expect((await recheck(users.host, seat("claude"))).length).toBe(1);
});

// The launch path re-checks the machine login before bindAccount, while an account seat's creds are still empty.
// That seat does not use this machine's login: the check must not read the Keychain or run `codex login status`.
test("an account seat does not re-check this machine's login before its credentials are bound", async () => {
  const r = statusRig();
  const account = (runtime: string, id: string) => ({ run: { runtime }, v2: { run: { account: `bea:${id}` } } });
  expect(await recheck(r.host, account("claude", "a".repeat(24)))).toEqual([]);
  expect(await recheck(r.host, account("codex", "c".repeat(24)))).toEqual([]);
  expect({ keychain: r.reads(), codex: r.codexRuns() }).toEqual({ keychain: 0, codex: 0 });
});
