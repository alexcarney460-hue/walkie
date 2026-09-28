// ACCOUNTS-2 round 1 (Codex + Opus audits): unit tests per finding.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileKeyStore, type KeyStore } from "../../src/accounts/vault/keystore.ts";
import { Vault } from "../../src/accounts/vault/vault.ts";
import { markApplies, readMarks, writeMark } from "../../src/accounts/leases.ts";
import { select, selectOwnFirst, type Candidate } from "../../src/accounts/select.ts";
import { checkTrusted, isServiceAccount, projectRoot, recordTrusted, trustProblem } from "../../src/switch/trusted.ts";
import { plainText } from "../../src/protocol/plain-text.ts";
import { grantLease, GrantBook, liveVaultSharing, NonceBook } from "../../src/daemon/vault-lease.ts";
import { ephemeralKey } from "../../src/accounts/vault/seal.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const TOKEN = ("sk" + "-ant-oat01-FAKEROUNDONETOKEN0123456789abcdefghijk");
/** Mach-O 64 magic plus padding: what the native-executable check looks at. */
const NATIVE = Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.alloc(64)]);
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
function tmp(): string {
  const d = mkdtempSync("/tmp/walkie-r1-");
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe("key safety (Codex 8 / Opus 5)", () => {
  test("a missing key while sealed tokens exist is an error with recovery steps, never a silent new key", async () => {
    const home = join(tmp(), "w");
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    await v.addClaude({ id: "a".repeat(24), label: "Claude account", plan: null, token: TOKEN, linked: false });
    rmSync(join(home, "vault.key"));
    await expect(v.addClaude({ id: "b".repeat(24), label: "Claude account", plan: null, token: TOKEN, linked: false })).rejects.toThrow(/will not make a new key.*walkie accounts remove/s);
    expect(v.get("b".repeat(24))).toBeNull();
    v.close();
  });

  test("two first adds in parallel (two processes' vaults) end with ONE key that opens both tokens", async () => {
    const home = join(tmp(), "w");
    // A slow key store widens the race window: both see "no key" before either writes one.
    const slow = (ks: KeyStore): KeyStore => ({ ...ks, get: async (id) => { await Bun.sleep(30); return ks.get(id); } });
    const v1 = Vault.open(home, { keystore: slow(fileKeyStore(home)) });
    const v2 = Vault.open(home, { keystore: slow(fileKeyStore(home)) });
    await Promise.all([
      v1.addClaude({ id: "a".repeat(24), label: "Claude account", plan: null, token: TOKEN, linked: false }),
      v2.addClaude({ id: "b".repeat(24), label: "Claude account", plan: null, token: TOKEN.replace("FAKE", "OTHR"), linked: false }),
    ]);
    const v3 = Vault.open(home, { keystore: fileKeyStore(home) });
    expect(await v3.claudeToken("a".repeat(24))).toBe(TOKEN);
    expect(await v3.claudeToken("b".repeat(24))).toBe(TOKEN.replace("FAKE", "OTHR"));
    for (const v of [v1, v2, v3]) v.close();
  });
});

describe("marks belong to a credential generation (Codex 9)", () => {
  const NOW = Date.now();
  const cand = (over: Partial<Candidate>): Candidate => ({ id: "a".repeat(24), provider: "claude", label: "L", owner: "alex", own: true, source: "local", usage: null, leases: 0, meterless: true, ...over });
  test("a re-added credential (new generation) is not excluded by the old one's refused-token mark", () => {
    const mark = { state: "relogin" as const, until: null, at: NOW, reason: "token_refused", gen: "old" };
    expect(markApplies(mark, "old")).toBe(true);
    expect(markApplies(mark, "new")).toBe(false);
    expect(select([cand({ mark, gen: "old" })], { provider: "claude", now: NOW }).pick).toBeNull();
    expect(select([cand({ mark, gen: "new" })], { provider: "claude", now: NOW }).pick).not.toBeNull();
  });
  test("a limit mark yields to a newer meter reading (as the dashboard shows it); a refused-token mark does not", () => {
    // Round 5 (hysteresis): the reading must be at least 10 minutes newer than the mark, with room.
    const u = { at: NOW + 10 * 60_000, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [{ kind: "session" as const, used_pct: 30, resets_at: null, window_s: null, scope: null }] };
    const limit = { state: "exhausted" as const, until: NOW + 3_600_000, at: NOW, reason: "five_hour", gen: "g" };
    expect(select([cand({ mark: limit, gen: "g", usage: u, meterless: false })], { provider: "claude", now: NOW + 11 * 60_000 }).pick).not.toBeNull();
    expect(select([cand({ mark: limit, gen: "g", usage: { ...u, at: NOW + 10 }, meterless: false })], { provider: "claude", now: NOW + 20 }).pick).toBeNull();
    expect(select([cand({ mark: { ...limit, state: "relogin" }, gen: "g", usage: u, meterless: false })], { provider: "claude", now: NOW + 11 * 60_000 }).pick).toBeNull();
  });
  test("remove / add clears an account's marks", () => {
    const w = tmp();
    writeMark(w, "a".repeat(24), { state: "relogin", until: null, at: Date.now(), reason: "x" });
    writeMark(w, "a".repeat(24), null);
    expect(readMarks(w)).toEqual({});
  });
});

describe("exhausted with an unknown reset (Codex 10)", () => {
  test("positively known exhaustion is reported as such, distinct from accounts that are merely unusable", () => {
    const NOW = Date.now();
    const ex = { at: NOW, state: "exhausted" as const, reason: "limit_reached" as const, source: "api" as const, until: null, windows: [] };
    const base: Candidate = { id: "a".repeat(24), provider: "claude", label: "L", owner: "alex", own: true, source: "local", usage: ex, leases: 0 };
    const s = select([base], { provider: "claude", now: NOW });
    expect(s).toMatchObject({ pick: null, waitUntil: null, exhausted: true });
    const relogin = select([{ ...base, usage: { ...ex, state: "relogin" as const } }], { provider: "claude", now: NOW });
    expect(relogin.exhausted).toBe(false);
  });
});

describe("own accounts first; borrowed only when all own are out (Opus 4)", () => {
  const NOW = Date.now();
  const u = (used: number) => ({ at: NOW, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [{ kind: "session" as const, used_pct: used, resets_at: NOW + 3_600_000, window_s: null, scope: null }] });
  const c = (id: string, own: boolean, used: number): Candidate => ({ id: id.padEnd(24, "0"), provider: "claude", label: id, owner: own ? "alex" : "kira", own, source: own ? "local" : "peer", usage: u(used), leases: 0 });
  test("an own account at 90 % beats a teammate's at 1 %; the teammate's is used once all own are out", () => {
    expect(selectOwnFirst([c("a", true, 90), c("k", false, 1)], { provider: "claude", now: NOW }).pick?.label).toBe("a");
    // (Round 2, Codex 9: "out" means affirmatively at the limit — 99 % is not. Round 4: 99 % is still usable, so the
    // own account runs rather than nothing.)
    expect(selectOwnFirst([c("a", true, 99), c("k", false, 1)], { provider: "claude", now: NOW }).pick?.label).toBe("a");
    const out = selectOwnFirst([c("a", true, 100), c("k", false, 1)], { provider: "claude", now: NOW });
    expect(out.pick?.label).toBe("k");
    expect(out.excluded.map((e) => e.label)).toEqual(["a"]);
  });
});

describe("trusted CLI (Codex 1)", () => {
  function place(root: string, rel: string): string {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, NATIVE, { mode: 0o755 }); // a native executable's magic (round 3: only native binaries are trusted)
    return p;
  }
  test("repo-local, node_modules/.bin, under-cwd and group/other-writable places are refused; a clean one is recorded", () => {
    const root = tmp();
    chmodSync(root, 0o755);
    const o = { cwd: join(root, "work"), stopAt: root, adminGroup: null };
    mkdirSync(o.cwd, { recursive: true });
    const good = place(root, "home/.local/bin/claude");
    expect(trustProblem(good, o)).toBeNull();
    const repo = place(root, "proj/tools/claude");
    mkdirSync(join(root, "proj", ".git"));
    expect(trustProblem(repo, o)).toMatch(/git work tree/);
    expect(trustProblem(place(root, "x/node_modules/.bin/claude"), o)).toMatch(/node_modules\/\.bin/);
    // Round 3: the cwd rule applies inside a project (a marker at or above the cwd), not in any plain directory.
    const inWork = place(root, "work/claude");
    expect(trustProblem(inWork, o)).toBeNull();
    writeFileSync(join(root, "work", "package.json"), "{}");
    expect(trustProblem(inWork, o)).toMatch(/project you are running from/);
    const shared = place(root, "shared/bin/claude");
    chmodSync(join(root, "shared", "bin"), 0o777);
    expect(trustProblem(shared, o)).toMatch(/writable by others/);
    const writable = place(root, "w2/claude");
    chmodSync(writable, 0o775);
    expect(trustProblem(writable, o)).toMatch(/writable by group or others/);
    // Homebrew counts only as an exact prefix (round 2): markers inside a repository prove nothing.
    const brew = place(root, "brew/bin/codex");
    mkdirSync(join(root, "brew", ".git"));
    mkdirSync(join(root, "brew", "Library", "Homebrew"), { recursive: true });
    expect(trustProblem(brew, o)).toMatch(/git work tree/);
    // A symlink on PATH into a repo is judged by its target too.
    symlinkSync(repo, join(root, "home/.local/bin/codex"));
    expect(trustProblem(join(root, "home/.local/bin/codex"), o)).toMatch(/git work tree/);
  });

  test("round 3: launching from $HOME (even a dotfiles repo there) puts no CLI under ~ off limits; a project under ~ still does", () => {
    const root = tmp();
    chmodSync(root, 0o755);
    const home = join(root, "home");
    const good = place(root, "home/.local/bin/claude");
    mkdirSync(join(home, ".git"));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(projectRoot(home, { stopAt: root })).toBeNull();
      expect(trustProblem(good, { cwd: home, stopAt: root, adminGroup: null })).toBeNull();
      const proj = join(home, "proj");
      mkdirSync(join(proj, "sub"), { recursive: true });
      writeFileSync(join(proj, "Cargo.toml"), "");
      expect(realpathSync(projectRoot(join(proj, "sub"), { stopAt: root }) as string)).toBe(realpathSync(proj));
      expect(trustProblem(place(root, "home/proj/bin/claude"), { cwd: join(proj, "sub"), stopAt: root, adminGroup: null })).toMatch(/project you are running from/);
    } finally {
      if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    }
  });

  test("an admin-group-writable directory (Homebrew) is accepted only when the person is the admin group's sole member besides root", () => {
    const { gid } = require("node:fs").statSync(tmp()) as { gid: number };
    const root = tmp();
    chmodSync(root, 0o755);
    const o = { cwd: join(root, "work"), stopAt: root, user: "alex" };
    mkdirSync(o.cwd);
    const brew = place(root, "brewbin/claude");
    chmodSync(join(root, "brewbin"), 0o775); // group-writable, like /opt/homebrew/bin (the fixture's own group stands in for admin)
    expect(trustProblem(brew, { ...o, adminGroup: { gid, members: ["root", "alex"], nested: false } })).toBeNull();
    expect(trustProblem(brew, { ...o, adminGroup: { gid, members: ["root", "alex", "_mbsetupuser"], nested: false } })).toMatch(/writable by group/);
    // A verified service account (uid < 500, no login shell) is ignored like root; an unverified `_`-name is not.
    expect(trustProblem(brew, { ...o, adminGroup: { gid, members: ["root", "alex", "_svc"], nested: false, services: ["_svc"] } })).toBeNull();
    expect(isServiceAccount("_svc", 248, "/usr/bin/false")).toBe(true);
    expect(isServiceAccount("_svc", 248, "/sbin/nologin")).toBe(true);
    expect(isServiceAccount("_mbsetupuser", 248, "/bin/bash")).toBe(false); // a login shell: could be a person
    expect(isServiceAccount("_sneaky", 501, "/usr/bin/false")).toBe(false); // a person-range uid
    expect(isServiceAccount("svc", 248, "/usr/bin/false")).toBe(false); // not an underscore name
    expect(isServiceAccount("_svc", null, null)).toBe(false); // unreadable record
    expect(trustProblem(brew, { ...o, adminGroup: { gid, members: ["root", "alex", "kira"], nested: false } })).toMatch(/writable by group/);
    expect(trustProblem(brew, { ...o, adminGroup: { gid, members: ["alex"], nested: true } })).toMatch(/writable by group/);
    expect(trustProblem(brew, { ...o, adminGroup: { gid: gid + 1, members: ["alex"], nested: false } })).toMatch(/writable by group/); // another group
    expect(trustProblem(brew, { ...o, adminGroup: null })).toMatch(/writable by group/); // not macOS / unreadable
    chmodSync(join(root, "brewbin"), 0o777);
    expect(trustProblem(brew, { ...o, adminGroup: { gid, members: ["alex"], nested: false } })).toMatch(/writable by others/);
  });

  test("credentials go only to the recorded path; another claude earlier on PATH gets none; an in-place update is re-validated", () => {
    const root = tmp();
    chmodSync(root, 0o755);
    const walkie = join(root, "walkiehome");
    mkdirSync(walkie);
    const o = { cwd: join(root, "work"), stopAt: root, adminGroup: null };
    mkdirSync(o.cwd);
    const good = place(root, "home/.local/bin/claude");
    recordTrusted(walkie, "claude", good, o);
    expect(checkTrusted(walkie, "claude", good, o)).toMatchObject({ ok: true, refreshed: false });
    const other = place(root, "elsewhere/claude");
    expect(checkTrusted(walkie, "claude", other, o)).toMatchObject({ ok: false });
    expect(checkTrusted(walkie, "codex", good, o)).toMatchObject({ ok: false, why: expect.stringMatching(/no trusted codex/) });
    rmSync(good);
    place(root, "home/.local/bin/claude"); // an update replaced the file in the same trusted place
    expect(checkTrusted(walkie, "claude", good, o)).toMatchObject({ ok: true, refreshed: true });
    chmodSync(good, 0o777);
    expect(checkTrusted(walkie, "claude", good, o)).toMatchObject({ ok: false });
    expect(() => recordTrusted(walkie, "claude", join(root, "work", "nope"), o)).toThrow(/not trusting/);
  });
});

describe("hand-outs: sharing read live, grants make leases verifiable (Opus 7, Codex 7)", () => {
  test("turning vault_sharing off in config.json takes effect at the next hand-out", async () => {
    const d = tmp();
    const cfg = join(d, "config.json");
    writeFileSync(cfg, JSON.stringify({ vault_sharing: true }));
    const alex = tnode("alex");
    const { team, create } = createTeam(alex);
    const core = makeCore(alex, team, cleanups);
    core.ingest(create, "local");
    const entry = { id: "a".repeat(24), provider: "claude", label: "Claude account", plan: null, policy: "shared", share_with: ["kira"], created_at: 1, expires_at: null, home: null, linked: false, gen: "g" } as VaultEntry;
    const grants = new GrantBook();
    const deps = { vault: { list: () => [entry], claudeToken: async () => TOKEN }, sharing: () => liveVaultSharing(cfg), nonces: new NonceBook(), grants };
    const kira = { login: "kira@example.com", handle: "kira", role: "member" as const };
    const req = () => ({ account: entry.id, epk: ephemeralKey().publicKey, nonce: crypto.getRandomValues(new Uint8Array(16)).reduce((x, b) => x + b.toString(16).padStart(2, "0"), ""), ts: now() });
    const res = await grantLease(core, deps, "node-kira", kira, req(), now());
    expect(res.gen).toBe("g"); // the credential generation travels with the hand-out
    expect(grants.valid(res.grant, entry.id, "node-kira", now())).toBe(true);
    expect(grants.valid(res.grant, entry.id, "node-other", now())).toBe(false);
    expect(grants.valid(res.grant, "b".repeat(24), "node-kira", now())).toBe(false);
    writeFileSync(cfg, JSON.stringify({ vault_sharing: false }));
    await expect(grantLease(core, deps, "node-kira", kira, req(), now())).rejects.toMatchObject({ code: "not_allowed" });
  });
});

describe("terminal-safe text (Opus 8)", () => {
  test("escape sequences and control characters never reach the terminal", () => {
    expect(plainText("refused\u001b[2J\u001b]0;title\u0007 now\r\nx‮")).toBe("refused now  x ");
  });
});

describe("remote-only bootstrap (Codex 6)", () => {
  test("a machine with no vault of its own still finds the owner's accounts on their other machine (and borrowed ones only when opted in)", async () => {
    const { defaultSource } = await import("../../src/switch/accounts.ts");
    const d = tmp();
    const sock = join(d, "walkie.sock");
    const view = (owner: string, policy: "own" | "shared") => ({
      key: `${owner}:${"a".repeat(24)}`, id: "a".repeat(24), provider: "claude", label: "Claude account", plan: null, owners: [owner], claimed_by: [], usage: null, usage_host: null, last_seen: 1,
      machines: [{ node_id: "mac", hostname: "alex-mac", handle: owner, online: true, self: false, agents: [], usage: null, vault: { policy, share_with: ["kira"] } }], vault: { policy }, leases: [],
    });
    let accounts = [view("alex", "own")];
    const server = Bun.serve({ unix: sock, fetch: (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/v1/accounts") return Response.json({ accounts });
      if (p === "/v1/me") return Response.json({ handle: me });
      return new Response("{}", { status: 404 });
    } });
    let me = "alex";
    const prev = process.env.WALKIE_SOCKET;
    process.env.WALKIE_SOCKET = sock;
    try {
      const w = join(d, "w");
      mkdirSync(w);
      const src = defaultSource(w, {});
      expect(src.hasAccounts("claude")).toBe(false);
      expect(await src.available("claude", Date.now())).toBe(true); // alex's own account on alex-mac (policy own)
      expect(await src.available("codex", Date.now())).toBe(false); // Codex logins never move
      me = "kira";
      accounts = [view("alex", "shared")];
      expect(await src.available("claude", Date.now())).toBe(false); // not opted in to borrowing
      writeFileSync(join(w, "config.json"), JSON.stringify({ borrow_shared: true }));
      expect(await src.available("claude", Date.now())).toBe(true);
    } finally {
      server.stop(true);
      if (prev === undefined) delete process.env.WALKIE_SOCKET; else process.env.WALKIE_SOCKET = prev;
    }
  });
});

describe("the token pipe descriptor is closed exactly once", () => {
  test("after the token is handed over and the process object could be collected, a reused descriptor stays open", async () => {
    const { spawnInherit } = await import("../../src/switch/launch.ts");
    const { fstatSync, openSync, writeSync, closeSync } = await import("node:fs");
    const d = tmp();
    const out = join(d, "got.txt");
    await (async () => {
      const child = spawnInherit({ argv: ["/bin/sh", "-c", `cat <&3 > ${out}`], env: { PATH: "/usr/bin:/bin" }, cwd: d, fd3: "tok" });
      expect(await child.exited).toBe(0);
    })();
    const reuse = openSync(join(d, "reuse.txt"), "w");
    for (let i = 0; i < 5; i++) { Bun.gc(true); await Bun.sleep(20); }
    expect(() => { fstatSync(reuse); writeSync(reuse, "x"); }).not.toThrow();
    closeSync(reuse);
    expect(await Bun.file(out).text()).toBe("tok");
  });
});
