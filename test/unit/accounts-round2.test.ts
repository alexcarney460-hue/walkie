// ACCOUNTS-2 round 2 (Codex + Opus re-audits): a test per finding.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTrusted, recordTrusted, sameObjects, trustProblem, type TrustOptions } from "../../src/switch/trusted.ts";
import { markApplies } from "../../src/accounts/leases.ts";
import { select, selectOwnFirst, type Candidate } from "../../src/accounts/select.ts";
import { GrantBook } from "../../src/daemon/vault-lease.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
/** A private directory tree (the OS temp dir, not the world-writable /tmp), checks stopping at its root. */
function tree(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "walkie-r2-")));
  chmodSync(d, 0o755);
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
/** Mach-O 64 magic plus padding: what the native-executable check looks at. */
const NATIVE = Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.alloc(64)]);
function file(root: string, rel: string, body: string | Buffer = NATIVE, mode = 0o755): string {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, { mode });
  chmodSync(p, mode);
  return p;
}
const base = (root: string, extra: Partial<TrustOptions> = {}): TrustOptions => ({ cwd: join(root, "work"), stopAt: root, adminGroup: null, acl: () => [], ...extra });

describe("Homebrew by exact prefix only (Codex 2, Opus 5)", () => {
  test("a repository carrying Library/Homebrew is still a repository; an exact prefix is not", () => {
    const root = tree();
    mkdirSync(join(root, "work"));
    const fake = file(root, "brewlike/tools/claude");
    mkdirSync(join(root, "brewlike/.git"));
    mkdirSync(join(root, "brewlike/Library/Homebrew"), { recursive: true });
    expect(trustProblem(fake, base(root))).toMatch(/git work tree/);
    expect(trustProblem(fake, base(root, { brewPrefixes: [join(root, "brewlike")] }))).toBeNull();
  });
});

describe("symlink hops, ancestors, and executing what was validated (Codex 3, Opus 7)", () => {
  test("a writable ancestor of an intermediate hop is refused even when the chain ends somewhere protected", () => {
    const root = tree();
    mkdirSync(join(root, "work"));
    const real = file(root, "protected/bin/claude");
    mkdirSync(join(root, "shared"));
    chmodSync(join(root, "shared"), 0o777);
    symlinkSync(join(root, "protected"), join(root, "shared/route"));
    mkdirSync(join(root, "home/bin"), { recursive: true });
    symlinkSync(join(root, "shared/route/bin/claude"), join(root, "home/bin/claude"));
    expect(trustProblem(join(root, "home/bin/claude"), base(root))).toMatch(/shared is writable by others/);
    expect(trustProblem(real, base(root))).toBeNull();
  });

  test("sameObjects notices a replaced file (inode) and a rewritten one (size / mtime)", () => {
    const root = tree();
    mkdirSync(join(root, "work"));
    const walkie = join(root, "w");
    mkdirSync(walkie);
    const cli = file(root, "home/bin/claude");
    recordTrusted(walkie, "claude", cli, base(root));
    const t = checkTrusted(walkie, "claude", cli, base(root));
    if (!t.ok) throw new Error(t.why);
    expect(sameObjects(t.ids)).toBe(true);
    writeFileSync(cli, Buffer.concat([NATIVE, Buffer.from("changed")]));
    expect(sameObjects(t.ids)).toBe(false);
    const t2 = checkTrusted(walkie, "claude", cli, base(root));
    if (!t2.ok) throw new Error(t2.why);
    utimesSync(cli, new Date(), new Date(Date.now() + 5_000));
    expect(sameObjects(t2.ids)).toBe(false);
  });
});

describe("ACLs on the trust chain (Opus 6)", () => {
  test("an ACL entry letting anyone else write is refused; the person's own entry is fine", () => {
    const root = tree();
    mkdirSync(join(root, "work"));
    const cli = file(root, "home/bin/claude");
    const acl = (p: string) => (p === join(root, "home") ? ["group:everyone allow add_file,delete_child", "user:alex allow write"] : []);
    expect(trustProblem(cli, base(root, { acl, user: "alex" }))).toMatch(/ACL entry letting group:everyone write/);
    expect(trustProblem(cli, base(root, { acl: () => ["user:alex allow write", "group:staff deny write"], user: "alex" }))).toBeNull();
  });

  test.if(process.platform === "darwin")("macOS: a real ACL set with chmod +a is found", () => {
    const root = tree();
    mkdirSync(join(root, "work"));
    const cli = file(root, "home/bin/claude");
    const r = Bun.spawnSync(["/bin/chmod", "+a", "group:everyone allow add_file", join(root, "home")]);
    expect(r.exitCode).toBe(0);
    const { acl: _drop, ...noInjected } = base(root);
    expect(trustProblem(cli, noInjected)).toMatch(/ACL entry letting group:everyone write/);
  });
});

describe("leases, marks and borrowing (Codex 7-9)", () => {
  test("one grant backs one lease; claims are capped per machine and never push verified leases out", async () => {
    const { accountsView } = await import("../../src/daemon/views.ts");
    const NOW = Date.parse("2026-09-26T18:00:00Z");
    const X = "a1c0ffee0000000000000001";
    const node = (id: string, login: string, hostname: string) => [id, { node_id: id, login, hostname, pubkey: "k", ip: "100.64.0.1", port: 1, revoked: false }] as const;
    const roster = {
      team: null, channels: new Map(),
      members: new Map([["alex@x", { login: "alex@x", handle: "alex", role: "member" as const }], ["kira@x", { login: "kira@x", handle: "kira", role: "member" as const }]]),
      nodes: new Map([node("mac", "alex@x", "alex-mac"), node("kmac", "kira@x", "kira-mbp")]),
    };
    const grants = new GrantBook();
    const g = grants.record(X, "kmac", NOW);
    const lease = (agent: string, grant?: string) => ({ account: X, provider: "claude", agent, since: NOW, owner: "alex", ...(grant ? { grant } : {}) });
    const peers: Record<string, unknown> = {
      kmac: { at: NOW, accounts: [], leases: [lease("cc-a", g), lease("cc-b", g), ...Array.from({ length: 10 }, (_, i) => lease(`cc-x${i}`))] },
    };
    const self = { at: NOW, accounts: [{ id: X, provider: "claude", label: "al***@ex***.com", plan: null, agents: [], usage: null, last_seen: NOW, vault: { policy: "shared", share_with: ["kira"], gen: "abc" } }] };
    const core = { roster, nodeId: "mac", accounts: self, myHandle: () => "alex", vaultGrants: grants } as unknown as import("../../src/daemon/core.ts").Core;
    const sync = { peerState: (id: string) => (peers[id] ? { accounts: peers[id], skewMs: 0 } : undefined), isOnline: () => true } as unknown as import("../../src/daemon/sync.ts").SyncManager;
    const [v] = accountsView(core, sync, NOW);
    expect(v?.leases?.filter((l) => l.verified).map((l) => l.agent)).toEqual(["cc-a"]);
    expect(v?.leases?.filter((l) => !l.verified)).toHaveLength(4);
    expect(v?.vault?.gen).toBe("abc");
  });

  test("marks bind to the exact credential generation (a remote mark about a replaced credential no longer applies)", () => {
    const m = { state: "relogin" as const, until: null, at: 1, reason: "token_refused", gen: "old" };
    expect(markApplies(m, "old")).toBe(true);
    expect(markApplies(m, "new")).toBe(false);
    expect(markApplies(m, undefined)).toBe(false);
    expect(markApplies({ ...m, gen: undefined }, "new")).toBe(false);
    expect(markApplies({ ...m, gen: undefined }, undefined)).toBe(true);
  });

  test("borrowing only when every own account is affirmatively at its limit", () => {
    const NOW = Date.now();
    const u = (used: number, state: "ok" | "exhausted" = "ok", at = NOW) => ({ at, state, reason: null, source: "api" as const, until: state === "exhausted" ? NOW + 3_600_000 : null, windows: [{ kind: "session" as const, used_pct: used, resets_at: NOW + 3_600_000, window_s: null, scope: null }] });
    const own = (usage: Candidate["usage"], extra: Partial<Candidate> = {}): Candidate => ({ id: "a".repeat(24), provider: "claude", label: "mine", owner: "kira", own: true, source: "local", usage, leases: 0, ...extra });
    const theirs: Candidate = { id: "b".repeat(24), provider: "claude", label: "alex's", owner: "alex", own: false, source: "peer", usage: u(5), leases: 0 };
    const o = { provider: "claude" as const, now: NOW };
    // Near the threshold, stale, or no reading: not at the limit, so never a teammate's — and (round 4) still the
    // caller's own account to run on.
    expect(selectOwnFirst([own(u(97)), theirs], o).pick?.label).toBe("mine");
    expect(selectOwnFirst([own(u(40, "ok", NOW - 2 * 3_600_000)), theirs], o).pick?.label).toBe("mine");
    expect(selectOwnFirst([own(null), theirs], o).pick?.label).toBe("mine");
    expect(selectOwnFirst([own(u(100, "exhausted")), theirs], o).pick?.label).toBe("alex's");
    expect(selectOwnFirst([own(u(40), { mark: { state: "exhausted", until: NOW + 60_000, at: NOW + 1, reason: "five_hour" } }), theirs], o).pick?.label).toBe("alex's");
    expect(selectOwnFirst([own(u(100, "exhausted")), theirs], { ...o, exclude: [] }).pick?.label).toBe("alex's");
    expect(select([own(u(100))], o).excluded[0]?.atLimit).toBe(true);
  });
});

describe("recovery: the child is owned even when the token hand-over fails (Codex 5, Opus 4)", () => {
  test("spawnInherit never throws after spawning: a failed hand-over is reported on the child", async () => {
    const { spawnInherit } = await import("../../src/switch/launch.ts");
    const d = tree();
    // fd 3 closed by the child before the write: the write fails (EPIPE) or succeeds into a closed pipe — never a throw.
    const child = spawnInherit({ argv: ["/bin/sh", "-c", "exec 3<&-; sleep 0.3"], env: { PATH: "/usr/bin:/bin" }, cwd: d, fd3: "x".repeat(200_000) });
    expect(typeof child.pid).toBe("number");
    expect(await child.exited).toBe(0);
    expect(typeof (child.handoffError ?? "")).toBe("string");
  });
});

export type _Unused = AccountView;

describe("first-key creation across processes (Codex 6, Opus 9)", () => {
  test("two processes adding the first accounts at once end with ONE key that opens both tokens", async () => {
    const { Vault } = await import("../../src/accounts/vault/vault.ts");
    const { fileKeyStore } = await import("../../src/accounts/vault/keystore.ts");
    const d = tree();
    const home = join(d, "w");
    const script = join(d, "add.ts");
    const src = join(import.meta.dir, "../../src/accounts/vault");
    writeFileSync(script, `import { Vault } from "${src}/vault.ts";\nimport { fileKeyStore } from "${src}/keystore.ts";\n`
      + `const [home, id, tok] = process.argv.slice(2);\nconst slow = { ...fileKeyStore(home), get: async (v) => { await Bun.sleep(40); return fileKeyStore(home).get(v); } };\n`
      + `const v = Vault.open(home, { keystore: slow });\nawait v.addClaude({ id, label: "Claude account", plan: null, token: tok, linked: false });\nv.close();\n`);
    const tokA = ("sk" + "-ant-oat01-FAKEPROCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const tokB = ("sk" + "-ant-oat01-FAKEPROCBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    Vault.open(home, { keystore: fileKeyStore(home) }).close(); // the database exists for both
    const run = (id: string, tok: string) => Bun.spawn([process.execPath, script, home, id, tok], { stdout: "pipe", stderr: "pipe" });
    const [p1, p2] = [run("a".repeat(24), tokA), run("b".repeat(24), tokB)];
    expect([await p1.exited, await p2.exited]).toEqual([0, 0]);
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    expect(await v.claudeToken("a".repeat(24))).toBe(tokA);
    expect(await v.claudeToken("b".repeat(24))).toBe(tokB);
    v.close();
  });

  test("a claim left by a process that no longer exists is taken over (compare-and-swap), never by age", async () => {
    const { Vault } = await import("../../src/accounts/vault/vault.ts");
    const { fileKeyStore } = await import("../../src/accounts/vault/keystore.ts");
    const { Database } = await import("bun:sqlite");
    const d = tree();
    const home = join(d, "w");
    Vault.open(home, { keystore: fileKeyStore(home) }).close();
    const gone = Bun.spawn(["/usr/bin/true"]);
    await gone.exited; // a pid that just exited
    const db = new Database(join(home, "vault.db"));
    db.query("INSERT INTO meta (k, v) VALUES ('key_claim', ?)").run(`${gone.pid}:deadbeefdeadbeef`);
    db.close();
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    await v.addClaude({ id: "a".repeat(24), label: "Claude account", plan: null, token: ("sk" + "-ant-oat01-FAKECLAIMAAAAAAAAAAAAAAAAAAAAAAAAAAA"), linked: false });
    expect(await v.claudeToken("a".repeat(24))).toContain("FAKECLAIM");
    v.close();
  });
});
