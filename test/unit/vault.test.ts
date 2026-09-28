// ACCOUNTS-2 vault: AES-256-GCM at rest (AAD-bound), the key store (never on a command line), file modes, the Codex
// account homes (symlinks, never followed on removal) and the X25519 hand-out sealing. Never the real Keychain: the
// file key store or a fake `security` tool.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileKeyStore, macKeychain } from "../../src/accounts/vault/keystore.ts";
import { aadFor, ephemeralKey, openAtRest, openLease, sealAtRest, sealLease } from "../../src/accounts/vault/seal.ts";
import { SETUP_TOKEN_RE, Vault } from "../../src/accounts/vault/vault.ts";
import { codexBaseHome, codexSessionsDir, finalCodexHome, isVaultCodexHome, pendingCodexHome, removeCodexHome, syncCodexHome } from "../../src/accounts/vault/codex-home.ts";

const TOKEN_A = ("sk" + "-ant-oat01-FAKEVAULTTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
const TOKEN_B = ("sk" + "-ant-oat01-FAKEVAULTTOKENBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
const ID_A = "a".repeat(24);
const ID_B = "b".repeat(24);

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
function tmp(): string {
  const d = mkdtempSync("/tmp/walkie-vault-");
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe("seal at rest", () => {
  const key = randomBytes(32);
  test("round-trips and binds the AAD", () => {
    const blob = sealAtRest(key, TOKEN_A, aadFor("v1", ID_A, "claude"));
    expect(openAtRest(key, blob, aadFor("v1", ID_A, "claude"))).toBe(TOKEN_A);
    expect(() => openAtRest(key, blob, aadFor("v1", ID_B, "claude"))).toThrow(); // moved onto another account
    expect(() => openAtRest(key, blob, aadFor("v2", ID_A, "claude"))).toThrow(); // another vault
    expect(() => openAtRest(randomBytes(32), blob, aadFor("v1", ID_A, "claude"))).toThrow(); // wrong key
  });
  test("tampering is detected; the IV is fresh each time", () => {
    const aad = aadFor("v1", ID_A, "claude");
    const a = sealAtRest(key, TOKEN_A, aad);
    const b = sealAtRest(key, TOKEN_A, aad);
    expect(a.equals(b)).toBe(false);
    const bad = Buffer.from(a);
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    expect(() => openAtRest(key, bad, aad)).toThrow();
    expect(a.toString("latin1")).not.toContain("FAKEVAULTTOKEN");
  });
});

describe("lease sealing (X25519 + HKDF + AES-GCM)", () => {
  test("only the requester's key and the same context open it", () => {
    const req = ephemeralKey();
    const sealed = sealLease(TOKEN_A, req.publicKey, "n".repeat(32), "acct|req|own");
    expect(sealed.box).not.toContain("FAKEVAULTTOKEN");
    expect(openLease(sealed, req.privateKey, "n".repeat(32), "acct|req|own")).toBe(TOKEN_A);
    expect(() => openLease(sealed, ephemeralKey().privateKey, "n".repeat(32), "acct|req|own")).toThrow();
    expect(() => openLease(sealed, req.privateKey, "m".repeat(32), "acct|req|own")).toThrow();
    expect(() => openLease(sealed, req.privateKey, "n".repeat(32), "acct|other|own")).toThrow();
  });
});

describe("vault", () => {
  test("stores a setup-token encrypted, 0600 / 0700, readable back only through the key", async () => {
    const home = join(tmp(), "w");
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    await v.addClaude({ id: ID_A, label: "al***@ex***.com", plan: "Max", token: TOKEN_A, linked: false });
    expect(await v.claudeToken(ID_A)).toBe(TOKEN_A);
    v.close();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "vault.db")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "vault.key")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "vault.db")).toString("latin1")).not.toContain("FAKEVAULTTOKEN");
    // Without the key the token cannot be read.
    rmSync(join(home, "vault.key"));
    const again = Vault.open(home, { keystore: fileKeyStore(home) });
    await expect(again.claudeToken(ID_A)).rejects.toThrow(/key is missing/);
    again.close();
  });

  test("refuses what is not a setup-token, uncontrolled labels, duplicates and more than 16 accounts", async () => {
    const home = join(tmp(), "w");
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    await expect(v.addClaude({ id: ID_A, label: "Claude account", plan: null, token: ("sk" + "-ant-api03-notasetuptoken0123456789"), linked: false })).rejects.toThrow(/setup-token/);
    await expect(v.addClaude({ id: ID_A, label: "alex@example.com", plan: null, token: TOKEN_A, linked: false })).rejects.toThrow(/label/);
    await v.addClaude({ id: ID_A, label: "Claude account", plan: "not a plan", token: TOKEN_A, linked: false });
    expect(v.get(ID_A)?.plan).toBeNull();
    await expect(v.addClaude({ id: ID_A, label: "Claude account", plan: null, token: TOKEN_B, linked: false })).rejects.toThrow(/already/);
    for (let i = 0; i < 15; i++) await v.addClaude({ id: i.toString(16).padStart(24, "c"), label: "Claude account", plan: null, token: TOKEN_B, linked: false });
    await expect(v.addClaude({ id: "d".repeat(24), label: "Claude account", plan: null, token: TOKEN_B, linked: false })).rejects.toThrow(/at most 16/);
    expect(SETUP_TOKEN_RE.test(TOKEN_A)).toBe(true);
    v.close();
  });

  test("policy: local by default; Codex logins never leave their machine; shared needs handles", async () => {
    const home = join(tmp(), "w");
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    await v.addClaude({ id: ID_A, label: "Claude account", plan: null, token: TOKEN_A, linked: false });
    v.addCodex({ id: ID_B, label: "ChatGPT account", plan: "Pro", home: join(home, "vault", "codex", ID_B) });
    expect(v.get(ID_A)?.policy).toBe("local");
    expect(() => v.setPolicy(ID_B, "own")).toThrow(/Codex logins stay/);
    expect(() => v.setPolicy(ID_A, "shared")).toThrow(/--with/);
    expect(() => v.setPolicy(ID_A, "shared", ["Not A Handle"])).toThrow();
    expect(v.setPolicy(ID_A, "shared", ["kira", "kira"]).share_with).toEqual(["kira"]);
    expect(v.setPolicy(ID_A, "own").share_with).toEqual([]);
    expect(v.remove(ID_A)?.id).toBe(ID_A);
    expect(v.get(ID_A)).toBeNull();
    v.close();
  });
});

describe("macOS Keychain key store (fake security tool)", () => {
  test("the key goes in on stdin, never in argv, and is read back", async () => {
    const d = tmp();
    const tool = join(d, "security");
    const store = join(d, "store.txt");
    const argvLog = join(d, "argv.txt");
    writeFileSync(tool, `#!/bin/sh
echo "$@" >> ${argvLog}
if [ "$1" = "-i" ]; then cat > ${join(d, "stdin.txt")}; sed -n 's/.* -w \\([0-9a-f]*\\).*/\\1/p' ${join(d, "stdin.txt")} > ${store}; exit 0; fi
if [ "$1" = "find-generic-password" ]; then [ -s ${store} ] || exit 44; cat ${store}; exit 0; fi
exit 1
`);
    chmodSync(tool, 0o755);
    const ks = macKeychain(d, tool);
    expect(await ks.get("vaultid")).toBeNull();
    const key = randomBytes(32);
    await ks.put("vaultid", key);
    expect((await ks.get("vaultid"))?.equals(key)).toBe(true);
    const argv = readFileSync(argvLog, "utf8");
    expect(argv).not.toContain(key.toString("hex"));
    expect(readFileSync(join(d, "stdin.txt"), "utf8")).toContain(key.toString("hex"));
    await expect(ks.put("bad id; rm -rf /", key)).rejects.toThrow(/invalid keystore name/);
  });
});

describe("Codex account homes", () => {
  test("round 1 (Opus 1): on a fresh base the shared entries are created there first, then linked", () => {
    const d = tmp();
    const walkie = join(d, "w");
    const base = join(d, "fresh-codex"); // does not exist yet
    const pending = pendingCodexHome(walkie, base);
    for (const n of ["sessions", "archived_sessions", "log", "config.toml", "history.jsonl"]) {
      expect(existsSync(join(base, n))).toBe(true);
      // Round 5: config.toml is a cleaned copy, never a link.
      expect(lstatSync(join(pending, n)).isSymbolicLink()).toBe(n !== "config.toml");
    }
    expect(codexSessionsDir(pending)).toBe(realpathSync(join(base, "sessions")));
    removeCodexHome(pending, walkie);
    expect(existsSync(join(base, "sessions"))).toBe(true);
  });

  test("link everything but auth.json; keep a real file Codex wrote; removal never follows links", () => {
    const d = tmp();
    const walkie = join(d, "w");
    const base = join(d, "codex");
    mkdirSync(join(base, "sessions"), { recursive: true });
    writeFileSync(join(base, "config.toml"), "model = 'x'\n");
    writeFileSync(join(base, "auth.json"), "{\"user\":\"own login\"}");
    writeFileSync(join(base, "history.jsonl"), "");
    const pending = pendingCodexHome(walkie, base);
    expect(statSync(pending).mode & 0o777).toBe(0o700);
    expect(existsSync(join(pending, "auth.json"))).toBe(false);
    expect(lstatSync(join(pending, "config.toml")).isSymbolicLink()).toBe(false); // round 5: a cleaned copy
    expect(readFileSync(join(pending, "config.toml"), "utf8")).toContain("model = 'x'");
    expect(lstatSync(join(pending, "sessions")).isSymbolicLink()).toBe(true);
    writeFileSync(join(pending, "auth.json"), "{}");
    const home = finalCodexHome(pending, walkie, "e".repeat(24));
    rmSync(join(home, "history.jsonl"));
    writeFileSync(join(home, "history.jsonl"), "own copy\n");
    writeFileSync(join(base, "AGENTS.md"), "hi");
    const r = syncCodexHome(home, base);
    expect(r.linked).toEqual(["AGENTS.md"]);
    expect(r.kept).toEqual(["history.jsonl"]);
    expect(readFileSync(join(home, "history.jsonl"), "utf8")).toBe("own copy\n");
    // Round 1 (Opus 1): a real entry Codex wrote is never deleted recursively: refused (the base has one too) ...
    expect(() => removeCodexHome(home, walkie, { move: true, baseHome: base })).toThrow(/history\.jsonl/);
    expect(existsSync(home)).toBe(true);
    // ... and moved into the base when the base has no entry of that name.
    rmSync(join(base, "history.jsonl"));
    expect(removeCodexHome(home, walkie, { move: true, baseHome: base }).moved).toEqual(["history.jsonl"]);
    expect(readFileSync(join(base, "history.jsonl"), "utf8")).toBe("own copy\n");
    expect(existsSync(home)).toBe(false);
    expect(readFileSync(join(base, "config.toml"), "utf8")).toBe("model = 'x'\n");
    expect(existsSync(join(base, "sessions"))).toBe(true);
    expect(() => removeCodexHome(base, walkie)).toThrow(/outside the vault/);
    // A CODEX_HOME that is one of our account homes is never taken as the user's own.
    expect(isVaultCodexHome(join(walkie, "vault", "codex", "x"), walkie)).toBe(true);
    expect(codexBaseHome(walkie, { CODEX_HOME: join(walkie, "vault", "codex", "x") }, d)).toBe(join(d, ".codex"));
    expect(codexBaseHome(walkie, { CODEX_HOME: base }, d)).toBe(base);
    symlinkSync(base, join(d, "link"));
  });
});
