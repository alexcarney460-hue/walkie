// SEATS-FIX-5 end to end (docs/audits/2026-09-26-*-seats-r5.md): every seat as a fresh OS user, made before it and
// destroyed after it by the root helper's REAL logic (admin.ts) over a fake system (test/helpers/fake-seat-users.ts:
// tests can't create OS users). Covers what earlier rounds fixed, now on ephemeral users (separate users for
// concurrent seats; control by uid through escapes; verified busy; deny first; the socket; the daily bound across a
// restart; a crash while paused), and round 5: nothing of a seat reaches a later one (a new user, a fresh home, its
// files outside the home gone), an unverifiable destroy is reported and quarantined, and a Keychain-only Claude login
// is refused with the fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { doctorChecks } from "../../src/daemon/seats/doctor.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { canSandbox, fakeSeatWorld, type FakeSeatWorld, signInCodex } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const EXPIRY = Date.now() + 8 * 3_600_000;
const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: "the-machines-own-login", refreshToken: "the-machines-refresh-token", expiresAt: EXPIRY, scopes: ["user:inference"] } });
/** What a seat is handed of it: the access token only, never the refresh token (SEATS-FIX-8, Opus r8 2). */
const HANDED = JSON.stringify({ claudeAiOauth: { accessToken: "the-machines-own-login", expiresAt: EXPIRY, scopes: ["user:inference"] } });
const DEDICATED = `sk${""}-ant-oat01-${"d".repeat(40)}`;
let keychainCredentials: string | null = null;
let keychainReads = 0;

let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let world: FakeSeatWorld;
let log: string;
let claudeLog: string;
let personHome: string;
const seatsOpts: Record<string, unknown> = {};
const leftovers: number[] = [];

const person = (n: TestNode): WalkieClient => n.client("");
const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const inState = (id: string, state: SeatView["state"]) =>
  waitFor(async () => ((await seatOn(id))?.state === state ? seatOn(id) : null), { timeoutMs: 20_000, what: `seat ${id} ${state}` });
const ended = (id: string) =>
  waitFor(async () => { const s = await seatOn(id); return s && TERMINAL_STATES.has(s.state) ? s : null; }, { timeoutMs: 40_000, what: `seat ${id} to end` });
const lines = (f = log): Array<Record<string, unknown>> =>
  existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const runOf = (prompt: string) => waitFor(() => lines().filter((l) => l.prompt === prompt).pop(), { what: `the runtime for "${prompt}"` });
const workerOf = (pid: number) => waitFor(() => lines().find((l) => l.from === pid && typeof l.worker === "number")?.worker as number | undefined, { what: "its worker" });
const claudeCheck = (prompt: string) => waitFor(() => lines(claudeLog).find((l) => l.check === prompt), { what: `the check of "${prompt}"` });
const stat = (pid: number) => Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const launch = async (prompt: string, runtime: "codex" | "claude" = "codex") => (await person(alex).seatRun({ machine: "arvid-mac", runtime, prompt })).seat;
const host = () => seatsFor(arvid.d.core) as unknown as {
  destroyUser(n: number): Promise<{ ok: boolean }>; api: { stop(): void }; startApi(): void; seats: Map<string, unknown>; stopAll(): Promise<void>; reaping: Set<unknown>;
};
const userOf = (home: unknown) => String(home).split("/").pop() as string;

beforeAll(async () => {
  c = new Cluster();
  personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true });
  chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), CREDS, { mode: 0o600 }); // this machine's own Claude login
  signInCodex(personHome);
  log = join(c.root, "codex.jsonl");
  claudeLog = join(c.root, "claude.jsonl");
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome);
  Object.assign(seatsOpts, {
    keychain: async () => { keychainReads++; return keychainCredentials; },
    flushMs: 100, launchesPerMinute: 100, busyReapplyMs: 300,
    userSwitch: world.userSwitch, admin: world.admin, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
    env: {
      PATH: `${join(FIXTURES, "fake-codex")}:${join(FIXTURES, "fake-claude")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome,
      FAKE_CODEX_LOG: log, FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_STATE: join(c.root, "claude-state"), FAKE_OUTSIDE_DIR: world.outside,
    },
  });
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac", seats: seatsOpts });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  const { local } = await person(arvid).seatsConfig({
    allow: true, ephemeral: true, env: ["FAKE_CODEX_LOG", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STATE", "FAKE_OUTSIDE_DIR"],
  });
  expect(local).toMatchObject({ allow: true, ephemeral: true, claude_login: "machine" });
  expect(local.disabled_reason).toBeUndefined();
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "arvid-mac takes seats" });
}, 60_000);

afterAll(async () => {
  for (const p of leftovers) if (alive(p)) { try { process.kill(p, "SIGCONT"); process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  await c.close();
});

describe("SEATS-FIX-5: ephemeral seat users", () => {
  test("Codex r5 HIGH 1-2, Opus r5 HIGH 1: a later seat never gets an earlier one's user, home or files outside it", async () => {
    const first = await launch("plant-home plant-outside");
    expect((await ended(first)).state).toBe("done");
    const u1 = userOf((await runOf("plant-home plant-outside")).home);
    // Destroyed: its user, its home (the planted ~/.claude hook and LaunchAgent with it), its file outside the home.
    expect(world.destroyed).toContain(u1);
    expect(existsSync(join(world.homes, u1))).toBe(false);
    expect(readdirSync(world.outside)).toEqual([]);
    const second = await launch("check-home", "claude");
    expect((await ended(second)).state).toBe("done");
    const seen = await claudeCheck("check-home");
    const u2 = userOf(seen.home);
    expect(u2).not.toBe(u1); // a new user, never reused
    expect(Number(u2.slice(8))).toBeGreaterThan(Number(u1.slice(8)));
    expect(seen).toMatchObject({ planted: false, dot_claude: false, launch_agents: false, outside: [] });
    expect(JSON.parse(seen.settings as string)).toEqual({ disableAllHooks: true });
    expect(seen.credentials).toEqual({ text: HANDED, mode: "600" }); // the machine's own login, for that run only
    expect(existsSync(join(world.homes, u2))).toBe(false); // and gone with its user
  }, 60_000);

  test("concurrent seats are different users; one can't read the other's token", async () => {
    const b = await launch("ticker 600 as the victim");
    const bRun = await runOf("ticker 600 as the victim");
    await inState(b, "running");
    const token = join(String(bRun.cwd).slice(0, String(bRun.cwd).lastIndexOf("/")), ".walkie-seat-token");
    expect(existsSync(token)).toBe(true);
    const a = await launch(`read-file ${token}`);
    expect((await ended(a)).state).toBe("done");
    const aRun = await runOf(`read-file ${token}`);
    expect(userOf(aRun.home)).not.toBe(userOf(bRun.home));
    if (canSandbox) expect(lines().find((l) => l.pid === aRun.pid && typeof l.read_file === "string")?.read_file).toBe("EPERM");
    await person(alex).seatStop(b);
    await ended(b);
  }, 60_000);

  test("a worker that left the group, and a seat that kills or stops its runner, are all removed with the user", async () => {
    const a = await launch("setsid-worker then done");
    const w = await workerOf((await runOf("setsid-worker then done")).pid as number);
    leftovers.push(w);
    expect((await ended(a)).state).toBe("done");
    await waitFor(() => !alive(w), { what: "the escaped worker gone", timeoutMs: 8_000 });
    const k = await launch("kill-runner and keep going");
    const kRun = await runOf("kill-runner and keep going");
    const kw = await workerOf(kRun.pid as number);
    leftovers.push(kw, kRun.pid as number);
    expect((await ended(k)).reason).toMatch(/lost control of the seat/);
    await waitFor(() => !alive(kw) && !alive(kRun.pid as number), { what: "all of it gone" });
    const s = await launch("stop-runner and keep going");
    const sRun = await runOf("stop-runner and keep going");
    const sw = await workerOf(sRun.pid as number);
    leftovers.push(sw, sRun.pid as number);
    await inState(s, "running");
    await person(alex).seatStop(s);
    expect((await ended(s)).reason).toBe("stopped by @alex");
    await waitFor(() => !alive(sw) && !alive(sRun.pid as number), { what: "all of it gone" });
  }, 90_000);

  test("busy is said only once verified; a SIGCONT from elsewhere is undone; a pause that can't be verified isn't announced", async () => {
    const id = await launch("setsid-worker ticker 600 busy");
    const pid = (await runOf("setsid-worker ticker 600 busy")).pid as number;
    const w = await workerOf(pid);
    leftovers.push(w, pid);
    await inState(id, "running");
    await person(arvid).seatsBusy({ max: 0 });
    await waitFor(() => stat(pid).startsWith("T") && stat(w).startsWith("T"), { what: "stopped" });
    await inState(id, "paused");
    process.kill(pid, "SIGCONT");
    process.kill(w, "SIGCONT");
    await waitFor(() => stat(pid).startsWith("T") && stat(w).startsWith("T"), { what: "stopped again", timeoutMs: 3_000 });
    await person(arvid).seatsResume();
    await inState(id, "running");
    await person(alex).seatStop(id);
    await ended(id);
    const u = await launch("ticker 600 unpausable");
    await inState(u, "running");
    world.failing.add("stop");
    try {
      await person(arvid).seatsBusy({ max: 0 });
      const s = await waitFor(async () => { const x = await seatOn(u); return x?.reason?.includes("could not be paused") ? x : null; }, { what: "said" });
      expect(s.state).toBe("running");
      expect((await person(arvid).seats()).local.availability).toMatchObject({ state: "busy", paused: 0 });
    } finally {
      world.failing.delete("stop");
      await person(arvid).seatsResume();
    }
    await person(alex).seatStop(u);
    await ended(u);
  }, 90_000);

  test("Opus r5 LOW 3 / Codex r5 MEDIUM 3: a destroy that can't be verified is reported, quarantined, and retried", async () => {
    world.broken.add("destroy-files");
    let s: SeatView;
    try {
      const id = await launch("plant-outside then end");
      s = await ended(id);
    } finally {
      world.broken.delete("destroy-files");
    }
    expect(s.state).toBe("stopped");
    // Seat round 19 reports the destroy's actual reason, not a generic "processes or files may remain".
    expect(s.reason).toMatch(/could not verify that its seat user was removed: files it owns remain or couldn't be checked \(the sweep failed \(broken\)\) \(seat user quarantined\)/);
    const { local } = await person(arvid).seats();
    expect(local.quarantined?.length).toBe(1);
    const n = Number((local.quarantined as string[])[0]?.slice(8));
    expect((await host().destroyUser(n)).ok).toBe(true); // the retry, now verified
    const healed = (await person(arvid).seats()).local;
    expect(healed.quarantined).toBeUndefined();
    expect(doctorChecks(healed, { team: "test", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok",
      runtimes: { claude: "/x", codex: "/x" } }).some((check) => check.what.includes("seat users not verified removed"))).toBe(false);
    expect(readdirSync(world.outside)).toEqual([]);
  }, 60_000);

  test("Keychain login is projected access-only; expiry waits for Claude Code, and a seat token overrides it", async () => {
    const creds = join(personHome, ".claude", ".credentials.json");
    const identity = join(personHome, ".claude.json");
    rmSync(creds);
    writeFileSync(identity, JSON.stringify({ oauthAccount: { accountUuid: "known-seat-account-uuid" } }));
    try {
      keychainCredentials = JSON.stringify({ claudeAiOauth: { accessToken: "old-access-token", refreshToken: "private-refresh", expiresAt: Date.now() + 60_000 } });
      await (host() as unknown as { refreshLogin(): Promise<void> }).refreshLogin();
      expect((await person(arvid).seats()).local.claude_login).toBe("unavailable");
      const s = await ended(await launch("check-home expiring", "claude"));
      expect(s.state).toBe("failed");
      expect(s.reason).toMatch(/near expiry/);
      const expiry = Date.now() + 3_600_000;
      keychainCredentials = JSON.stringify({ claudeAiOauth: { accessToken: "fresh-access-token", refreshToken: "private-refresh", expiresAt: expiry, scopes: ["user:inference"] } });
      await (host() as unknown as { refreshLogin(): Promise<void> }).refreshLogin();
      expect((await person(arvid).seats()).local.claude_login).toBe("machine");
      const readsAfterSuccess = keychainReads;
      await (host() as unknown as { refreshLogin(): Promise<void> }).refreshLogin();
      expect(keychainReads).toBe(readsAfterSuccess); // dashboard/status polling reuses the usable projection
      expect((await ended(await launch("check-home projected", "claude"))).state).toBe("done");
      const projected = await claudeCheck("check-home projected");
      expect(projected.credentials).toEqual({ text: JSON.stringify({ claudeAiOauth: { accessToken: "fresh-access-token", expiresAt: expiry, scopes: ["user:inference"] } }), mode: "600" });
      expect(existsSync(join(projected.claude_config as string, ".credentials.json"))).toBe(false);
      expect(keychainReads).toBe(readsAfterSuccess); // launch also reuses a token with enough lifetime
      const cache = host() as unknown as { cachedClaudeAccess: { expiresAt: number } };
      cache.cachedClaudeAccess.expiresAt = Date.now() + 60_000;
      keychainCredentials = JSON.stringify({ claudeAiOauth: { accessToken: "new-access-token", refreshToken: "private-refresh", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"] } });
      for (let i = 0; i < 5; i++) expect((await person(arvid).seats()).local.claude_login).toBe("unavailable");
      expect(keychainReads).toBe(readsAfterSuccess); // dashboard polling never re-reads a near-expiry Keychain token
      expect((await ended(await launch("check-home refreshed", "claude"))).state).toBe("done");
      expect(keychainReads).toBe(readsAfterSuccess + 1);
      expect(JSON.stringify((await claudeCheck("check-home refreshed")).credentials)).toContain("new-access-token");
      expect((await person(arvid).seatsToken(DEDICATED)).local.claude_login).toBe("dedicated");
      expect((await ended(await launch("check-home with the dedicated token", "claude"))).state).toBe("done");
      const seen = await claudeCheck("check-home with the dedicated token");
      expect(seen.token_sha).toBe(new Bun.CryptoHasher("sha256").update(DEDICATED).digest("hex").slice(0, 12));
      expect(seen.credentials).toBeNull();
      await person(arvid).seatsToken(null);
    } finally {
      keychainCredentials = null;
      writeFileSync(creds, CREDS, { mode: 0o600 });
      rmSync(identity, { force: true });
    }
  }, 60_000);

  test("cached Keychain projection follows Claude account changes and has a fifteen-minute age bound", async () => {
    const creds = join(personHome, ".claude", ".credentials.json");
    const identity = join(personHome, ".claude.json");
    rmSync(creds);
    const cache = host() as unknown as { cachedClaudeAccess: { readAt: number } | null };
    cache.cachedClaudeAccess = null;
    try {
      const login = (id: string) => writeFileSync(identity, JSON.stringify({ oauthAccount: { accountUuid: id } }));
      const token = (value: string) => JSON.stringify({ claudeAiOauth: { accessToken: value, expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"] } });
      login("account-one-uuid");
      keychainCredentials = token("account-one-access");
      expect((await ended(await launch("check-home account one", "claude"))).state).toBe("done");
      const firstReads = keychainReads;
      login("account-two-uuid");
      keychainCredentials = token("account-two-access");
      expect((await ended(await launch("check-home account two", "claude"))).state).toBe("done");
      expect(JSON.stringify((await claudeCheck("check-home account two")).credentials)).toContain("account-two-access");
      expect(keychainReads).toBe(firstReads + 1);
      expect(cache.cachedClaudeAccess).not.toBeNull();
      cache.cachedClaudeAccess!.readAt = Date.now() - 16 * 60_000;
      keychainCredentials = token("account-two-new-access");
      expect((await ended(await launch("check-home account two refreshed", "claude"))).state).toBe("done");
      expect(JSON.stringify((await claudeCheck("check-home account two refreshed")).credentials)).toContain("account-two-new-access");
      expect(keychainReads).toBe(firstReads + 2);
    } finally {
      keychainCredentials = null;
      rmSync(identity, { force: true });
      writeFileSync(creds, CREDS, { mode: 0o600 });
      cache.cachedClaudeAccess = null;
    }
  }, 60_000);

  test("no seat starts while the seats' socket isn't listening", async () => {
    const h = host();
    h.api.stop();
    try {
      const s = await ended(await launch("while the socket is down"));
      expect(s.state).toBe("failed");
      expect(s.reason).toMatch(/seats' socket isn't listening/);
    } finally {
      h.startApi();
    }
  }, 30_000);

  test("deny stops the seats first, even when the isolation just broke", async () => {
    const id = await launch("ticker 600 before the home opens");
    const pid = (await runOf("ticker 600 before the home opens")).pid as number;
    await inState(id, "running");
    chmodSync(personHome, 0o755);
    try {
      const { local } = await person(arvid).seatsConfig({ allow: false });
      expect(local.running).toBe(0);
      expect((await ended(id)).reason).toBe("seats were turned off on this machine");
      await waitFor(() => !alive(pid), { what: "its runtime gone" });
    } finally {
      chmodSync(personHome, 0o700);
    }
    await person(arvid).seatsConfig({ allow: true });
  }, 60_000);

  test("a crash with a seat paused: the next start destroys its user (stopped processes included), and ids keep going up", async () => {
    const id = await launch("setsid-worker ticker 600 before a crash");
    const pid = (await runOf("setsid-worker ticker 600 before a crash")).pid as number;
    const w = await workerOf(pid);
    leftovers.push(w, pid);
    await inState(id, "running");
    await person(arvid).seatsBusy({ max: 0 });
    await waitFor(() => stat(pid).startsWith("T") && stat(w).startsWith("T"), { what: "paused" });
    const before = world.created.length;
    const h = host();
    h.stopAll = async () => undefined; // a crash: nothing of the seats is stopped
    h.reaping.clear();
    h.seats = new Map();
    await arvid.restart();
    await waitFor(() => !alive(pid) && !alive(w), { what: "its user destroyed at start", timeoutMs: 15_000 });
    const s = await ended(id);
    expect(s.state).toBe("failed");
    expect(s.reason).toBe("the host's Walkie daemon restarted while it ran (its processes were stopped)");
    await person(arvid).seatsResume();
    expect((await ended(await launch("after the crash"))).state).toBe("done");
    const last = world.created[world.created.length - 1] as string;
    expect(world.created.length).toBe(before + 1);
    expect(new Set(world.created).size).toBe(world.created.length); // never a name twice
    expect(Number(last.slice(8))).toBeGreaterThan(Number((world.created[before - 1] as string).slice(8)));
  }, 90_000);

  test("the daily launch bound outlives a daemon restart", async () => {
    const saved = JSON.parse(readFileSync(join(arvid.home, "seats.json"), "utf8")) as { launches?: Record<string, number[]> };
    seatsOpts.launchesPerDay = saved.launches?.alex?.length ?? 0;
    await arvid.restart();
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows), { what: "back" });
    const s = await ended(await launch("one more after the restart"));
    expect(s.state).toBe("refused");
    expect(s.reason).toMatch(/launches a day per launcher/);
    delete seatsOpts.launchesPerDay;
  }, 60_000);
});
