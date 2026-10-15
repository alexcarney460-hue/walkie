import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiCredentialsPath, readKimiToken } from "../../src/accounts/adapters/kimi.ts";
import { readCodexToken } from "../../src/accounts/adapters/codex.ts";
import { finalCodexHome, pendingCodexHome, removeCodexHome } from "../../src/accounts/vault/codex-home.ts";
import { pendingKimiHome, finalKimiHome, removeKimiHome } from "../../src/accounts/vault/kimi-home.ts";
import { discardFailedVaultHome, readVaultCredential, secureVaultHomeAfterLogin } from "../../src/accounts/vault/vault-path.ts";
import { Vault } from "../../src/accounts/vault/vault.ts";
import { vaultCommand } from "../../src/cli/commands/vault.ts";
import { setTtyForTests } from "../../src/cli/tty.ts";
import type { Ctx } from "../../src/cli/context.ts";

const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "kimi-security-")); roots.push(p); return p; };
const id = "a".repeat(24);
const fake = JSON.stringify({ access_token: "fake-token-12345" });
const home = (walkie: string) => join(walkie, "vault", "kimi", id);
const credential = (dir: string, mode = 0o600) => {
  mkdirSync(join(dir, "credentials"), { recursive: true, mode: 0o700 });
  const path = join(dir, "credentials", "kimi-code.json");
  writeFileSync(path, fake, { mode });
  chmodSync(path, mode);
  return path;
};
const login = (dir: string) => ({ provider: "kimi" as const, dir, isDefault: false, vault: true as const });
afterEach(() => { setTtyForTests(undefined); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

test("creating a Kimi home refuses a linked vault root", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(join(walkie, "vault"), { recursive: true }); mkdirSync(outside);
  symlinkSync(outside, join(walkie, "vault", "kimi"));
  expect(() => pendingKimiHome(walkie)).toThrow(/symlink|directory/i);
  expect(readdirSync(outside)).toEqual([]);
});

test("creating a Kimi home refuses a linked vault parent and a wrong-type root", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(walkie); mkdirSync(outside); symlinkSync(outside, join(walkie, "vault"));
  expect(() => pendingKimiHome(walkie)).toThrow(/symlink|directory/i);
  rmSync(join(walkie, "vault")); writeFileSync(join(walkie, "vault"), "not a directory");
  expect(() => pendingKimiHome(walkie)).toThrow(/directory/i);
});

test("finalizing refuses a linked pending home", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(join(walkie, "vault", "kimi"), { recursive: true }); mkdirSync(outside);
  const pending = join(walkie, "vault", "kimi", "pending-0123456789ab"); symlinkSync(outside, pending);
  expect(() => finalKimiHome(pending, walkie, id)).toThrow(/symlink|directory/i);
  expect(existsSync(join(walkie, "vault", "kimi", id))).toBe(false);
});

test("removal refuses a linked vault root without touching the outside credential", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(join(walkie, "vault"), { recursive: true });
  const path = credential(join(outside, id)); symlinkSync(outside, join(walkie, "vault", "kimi"));
  expect(() => removeKimiHome(home(walkie), walkie)).toThrow(/symlink|directory/i);
  expect(readFileSync(path, "utf8")).toBe(fake);
});

test("removal refuses a linked account home and linked credentials directory", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(join(walkie, "vault", "kimi"), { recursive: true });
  const path = credential(outside); symlinkSync(outside, home(walkie));
  expect(() => removeKimiHome(home(walkie), walkie)).toThrow(/symlink|directory/i);
  expect(readFileSync(path, "utf8")).toBe(fake);
  rmSync(home(walkie)); mkdirSync(home(walkie)); symlinkSync(join(outside, "credentials"), join(home(walkie), "credentials"));
  expect(() => removeKimiHome(home(walkie), walkie)).toThrow(/symlink|directory/i);
  expect(readFileSync(path, "utf8")).toBe(fake);
});

test("vault token reader refuses linked root, account home and credentials directory", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  credential(join(outside, id)); mkdirSync(join(walkie, "vault"), { recursive: true });
  symlinkSync(outside, join(walkie, "vault", "kimi"));
  expect(kimiCredentialsPath(login(home(walkie)))).toBeNull();
  expect(readKimiToken(login(home(walkie)))).toBe("none");
  rmSync(join(walkie, "vault", "kimi")); mkdirSync(join(walkie, "vault", "kimi"));
  symlinkSync(join(outside, id), home(walkie));
  expect(readKimiToken(login(home(walkie)))).toBe("none");
  rmSync(home(walkie)); mkdirSync(home(walkie));
  symlinkSync(join(outside, id, "credentials"), join(home(walkie), "credentials"));
  expect(readKimiToken(login(home(walkie)))).toBe("none");
});

test("vault token reader refuses loose credential mode and accepts restored 0600", () => {
  const p = root(); const dir = home(join(p, "walkie")); const path = credential(dir, 0o644);
  const reasons: string[] = [];
  expect(readKimiToken(login(dir), (reason) => reasons.push(reason))).toBe("none");
  expect(reasons.join(" ")).toMatch(/fix.*0600/i);
  chmodSync(path, 0o600);
  expect(readKimiToken(login(dir))).toMatchObject({ value: "fake-token-12345" });
});

test("review probes: later Kimi and Codex reads refuse a 0755 home without changing it", () => {
  const p = root(); const walkie = join(p, "walkie");
  const kimi = home(walkie); credential(kimi); chmodSync(kimi, 0o755);
  const reasons: string[] = [];
  expect(readKimiToken(login(kimi), (reason) => reasons.push(reason))).toBe("none");
  expect(reasons.join(" ")).toMatch(/home.*0700/i);
  expect(readFileSync(join(kimi, "credentials", "kimi-code.json"), "utf8")).toBe(fake);
  const codex = join(walkie, "vault", "codex", id);
  mkdirSync(codex, { recursive: true, mode: 0o700 });
  writeFileSync(join(codex, "auth.json"), fake, { mode: 0o600 });
  chmodSync(codex, 0o755);
  expect(readVaultCredential(walkie, "codex", codex, "auth.json", 64 * 1024, (reason) => reasons.push(reason))).toBeNull();
  expect(readCodexToken({ provider: "codex", dir: codex, isDefault: false, vault: true }, (reason) => reasons.push(reason))).toBe("none");
  expect(reasons.join(" ")).toMatch(/home.*0700/i);
  expect((lstatSync(kimi).mode & 0o777)).toBe(0o755);
  expect((lstatSync(codex).mode & 0o777)).toBe(0o755);
});

test("review probes: finalization refuses a loose home, while post-login repair verifies both providers", () => {
  const p = root(); const walkie = join(p, "walkie");
  for (const provider of ["kimi", "codex"] as const) {
    const pending = provider === "kimi" ? pendingKimiHome(walkie) : pendingCodexHome(walkie, join(p, "base"));
    chmodSync(pending, 0o755);
    expect(() => provider === "kimi" ? finalKimiHome(pending, walkie, id) : finalCodexHome(pending, walkie, id)).toThrow(/home.*0700/i);
    secureVaultHomeAfterLogin(walkie, provider, pending);
    expect(lstatSync(pending).mode & 0o777).toBe(0o700);
  }
});

test("failed post-rename verification removes an unrecorded final home for both providers", () => {
  const p = root(); const walkie = join(p, "walkie");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("POSIX owner id required");
  for (const provider of ["kimi", "codex"] as const) {
    const pending = provider === "kimi" ? pendingKimiHome(walkie) : pendingCodexHome(walkie, join(p, "base"));
    let calls = 0;
    const mock = spyOn(process, "getuid").mockImplementation(() => (++calls === 2 ? uid + 1 : uid));
    try {
      expect(() => provider === "kimi" ? finalKimiHome(pending, walkie, id) : finalCodexHome(pending, walkie, id)).toThrow(/home owner/i);
    } finally { mock.mockRestore(); }
    expect(existsSync(pending)).toBe(false);
    expect(existsSync(join(walkie, "vault", provider, id))).toBe(false);
  }
});

test("fake Codex login may leave 0755; Walkie repairs its home before the credential read", async () => {
  const p = root(); const walkie = join(p, "walkie");
  const pending = pendingCodexHome(walkie, join(p, "base"));
  const binary = join(p, "fake-codex");
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\' \'{"tokens":{"account_id":"fake-account","access_token":"fake-token"}}\' > "$CODEX_HOME/auth.json"\nchmod 600 "$CODEX_HOME/auth.json"\nchmod 755 "$CODEX_HOME"\n');
  chmodSync(binary, 0o755);
  const child = Bun.spawn([binary, "login"], { env: { PATH: process.env.PATH ?? "", CODEX_HOME: pending }, stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(0);
  expect(lstatSync(pending).mode & 0o777).toBe(0o755);
  secureVaultHomeAfterLogin(walkie, "codex", pending);
  expect(lstatSync(pending).mode & 0o777).toBe(0o700);
  expect(readVaultCredential(walkie, "codex", pending, "auth.json")).toContain("fake-account");
});

test("failed Codex login discards its pending files without following a noncredential link", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(outside); writeFileSync(join(outside, "keep.txt"), "keep");
  const pending = pendingCodexHome(walkie, join(p, "base"));
  writeFileSync(join(pending, "extra.txt"), "provider data");
  symlinkSync(outside, join(pending, "outside"));
  chmodSync(pending, 0o755);
  discardFailedVaultHome(walkie, "codex", pending);
  expect(existsSync(pending)).toBe(false);
  expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
});

test("failed add unlinks a replaced pending-home symlink without touching its target", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(outside); writeFileSync(join(outside, "keep.txt"), "keep");
  for (const provider of ["kimi", "codex"] as const) {
    const pending = provider === "kimi" ? pendingKimiHome(walkie) : pendingCodexHome(walkie, join(p, "base"));
    rmSync(pending, { recursive: true });
    symlinkSync(provider === "kimi" ? outside : join(p, "missing"), pending);
    discardFailedVaultHome(walkie, provider, pending);
    expect(lstatSync(join(walkie, "vault", provider)).isDirectory()).toBe(true);
    expect(existsSync(pending)).toBe(false);
  }
  expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
});

test("vault reads refuse an account home owned by another user", () => {
  const p = root(); const walkie = join(p, "walkie");
  const kimi = home(walkie); credential(kimi);
  const codex = join(walkie, "vault", "codex", id);
  mkdirSync(codex, { recursive: true, mode: 0o700 });
  writeFileSync(join(codex, "auth.json"), fake, { mode: 0o600 });
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("POSIX owner id required");
  const mock = spyOn(process, "getuid").mockReturnValue(uid + 1);
  try {
    const reasons: string[] = [];
    expect(readKimiToken(login(kimi), (reason) => reasons.push(reason))).toBe("none");
    expect(readVaultCredential(walkie, "codex", codex, "auth.json", 64 * 1024, (reason) => reasons.push(reason))).toBeNull();
    expect(reasons.join(" ")).toMatch(/home.*owner/i);
  } finally { mock.mockRestore(); }
});

test("vault reads identify credential ownership separately from home ownership", () => {
  const p = root(); const walkie = join(p, "walkie");
  const kimi = home(walkie); credential(kimi);
  const codex = join(walkie, "vault", "codex", id);
  mkdirSync(codex, { recursive: true, mode: 0o700 });
  writeFileSync(join(codex, "auth.json"), fake, { mode: 0o600 });
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("POSIX owner id required");
  let calls = 0;
  const mock = spyOn(process, "getuid").mockImplementation(() => (++calls === 2 ? uid + 1 : uid));
  try {
    const reasons: string[] = [];
    expect(readKimiToken(login(kimi), (reason) => reasons.push(reason))).toBe("none");
    expect(reasons.join(" ")).toMatch(/credential owner/i);
    calls = 0; reasons.length = 0;
    expect(readVaultCredential(walkie, "codex", codex, "auth.json", 64 * 1024, (reason) => reasons.push(reason))).toBeNull();
    expect(reasons.join(" ")).toMatch(/credential owner/i);
  } finally { mock.mockRestore(); }
});

test("Codex vault read refuses a 0644 credential with a fix reason and leaves it unchanged", () => {
  const p = root(); const walkie = join(p, "walkie");
  const codex = join(walkie, "vault", "codex", id);
  mkdirSync(codex, { recursive: true, mode: 0o700 });
  const auth = join(codex, "auth.json");
  writeFileSync(auth, fake, { mode: 0o600 }); chmodSync(auth, 0o644);
  const reasons: string[] = [];
  expect(readCodexToken({ provider: "codex", dir: codex, isDefault: false, vault: true }, (reason) => reasons.push(reason))).toBe("none");
  expect(reasons.join(" ")).toMatch(/credential.*0600/i);
  expect(lstatSync(auth).mode & 0o777).toBe(0o644);
});

test("vault token reader refuses a credential owned by another user", () => {
  const p = root(); const dir = home(join(p, "walkie")); credential(dir);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("this fixture needs a POSIX owner id");
  const mock = spyOn(process, "getuid").mockReturnValue(uid + 1);
  try {
    const reasons: string[] = [];
    expect(readKimiToken(login(dir), (reason) => reasons.push(reason))).toBe("none");
    expect(reasons.join(" ")).toMatch(/fix.*owner/i);
  } finally { mock.mockRestore(); }
});

test("vault token reader refuses a non-regular credential and credentials directory", () => {
  const p = root(); const dir = home(join(p, "walkie"));
  mkdirSync(join(dir, "credentials", "kimi-code.json"), { recursive: true });
  expect(readKimiToken(login(dir))).toBe("none");
  rmSync(join(dir, "credentials"), { recursive: true });
  writeFileSync(join(dir, "credentials"), "not a directory");
  expect(readKimiToken(login(dir))).toBe("none");
});

test("Kimi removal refuses a linked credential file without touching its target", () => {
  const p = root(); const walkie = join(p, "walkie"); const dir = home(walkie);
  const outside = credential(join(p, "outside"));
  mkdirSync(join(dir, "credentials"), { recursive: true });
  symlinkSync(outside, join(dir, "credentials", "kimi-code.json"));
  expect(() => removeKimiHome(dir, walkie)).toThrow(/symlink/i);
  expect(readFileSync(outside, "utf8")).toBe(fake);
});

test("agent removal has the same AGENT-ADMIN-1 gate for Claude, Codex and Kimi", async () => {
  for (const provider of ["claude", "codex", "kimi"] as const) {
    const p = root(); const walkie = join(p, "walkie");
    const previous = process.env.WALKIE_HOME; const priorStore = process.env.WALKIE_VAULT_KEYSTORE;
    process.env.WALKIE_HOME = walkie; process.env.WALKIE_VAULT_KEYSTORE = "file";
    const vault = Vault.open(walkie);
    try {
      if (provider === "kimi") { mkdirSync(home(walkie), { recursive: true }); vault.addKimi({ id, label: "Kimi account", plan: null, home: home(walkie) }); }
      else if (provider === "codex") vault.addCodex({ id, label: "ChatGPT account", plan: null, home: join(walkie, "vault", "codex", id) });
      else await vault.addClaude({ id, label: "Claude account", plan: null, linked: false, token: "sk-ant-oat01-FAKECLITOKEN0123456789abcdefghijklmnop" });
    } finally { vault.close(); }
    setTtyForTests(null);
    const ctx = { args: { pos: ["remove", id], flags: new Map() }, json: false,
      agentSignals: () => ({ marker: "agent", inspection: "ok" }),
      client: () => ({ adminAudit: async () => undefined }), out: () => undefined, err: () => undefined } as unknown as Ctx;
    try {
      writeFileSync(join(walkie, "config.json"), JSON.stringify({ agent_admin: false }));
      await expect(vaultCommand(ctx, "remove")).rejects.toThrow(/agent admin is off/);
      const kept = Vault.open(walkie); expect(kept.get(id)).not.toBeNull(); kept.close();
      writeFileSync(join(walkie, "config.json"), JSON.stringify({ agent_admin: true }));
      expect(await vaultCommand(ctx, "remove")).toBe(0);
      const gone = Vault.open(walkie); expect(gone.get(id)).toBeNull(); gone.close();
    } finally {
      if (previous === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = previous;
      if (priorStore === undefined) delete process.env.WALKIE_VAULT_KEYSTORE; else process.env.WALKIE_VAULT_KEYSTORE = priorStore;
    }
  }
});

test("Codex home creation refuses a linked vault root", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(join(walkie, "vault"), { recursive: true }); mkdirSync(outside);
  symlinkSync(outside, join(walkie, "vault", "codex"));
  expect(() => pendingCodexHome(walkie, join(p, "base"))).toThrow(/symlink|directory/i);
  expect(readdirSync(outside)).toEqual([]);
});

test("Codex removal refuses a linked vault root without touching outside auth", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(join(walkie, "vault"), { recursive: true }); mkdirSync(join(outside, id), { recursive: true });
  const auth = join(outside, id, "auth.json"); writeFileSync(auth, fake, { mode: 0o600 });
  symlinkSync(outside, join(walkie, "vault", "codex"));
  expect(() => removeCodexHome(join(walkie, "vault", "codex", id), walkie)).toThrow(/symlink|directory/i);
  expect(readFileSync(auth, "utf8")).toBe(fake);
});

test("Codex vault token reader refuses a linked home and linked auth file", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(join(walkie, "vault", "codex"), { recursive: true }); mkdirSync(outside);
  const auth = join(outside, "auth.json");
  writeFileSync(auth, JSON.stringify({ tokens: { account_id: "acct", access_token: "fake-token-12345" } }), { mode: 0o600 });
  const dir = join(walkie, "vault", "codex", id);
  symlinkSync(outside, dir);
  expect(readCodexToken({ provider: "codex", dir, isDefault: false, vault: true })).toBe("none");
  rmSync(dir); mkdirSync(dir); symlinkSync(auth, join(dir, "auth.json"));
  expect(readCodexToken({ provider: "codex", dir, isDefault: false, vault: true })).toBe("none");
});

test("Codex vault lease reader refuses a linked home and auth file", () => {
  const p = root(); const walkie = join(p, "walkie"); const outside = join(p, "outside");
  mkdirSync(join(walkie, "vault", "codex"), { recursive: true }); mkdirSync(outside);
  const jwt = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url")}.x`;
  const auth = join(outside, "auth.json");
  writeFileSync(auth, JSON.stringify({ tokens: { account_id: "acct", access_token: jwt, id_token: jwt, refresh_token: "fake-refresh" } }), { mode: 0o600 });
  const dir = join(walkie, "vault", "codex", id); symlinkSync(outside, dir);
  const vault = Vault.open(walkie);
  try {
    vault.addCodex({ id, label: "ChatGPT account", plan: null, home: dir });
    expect(vault.codexExpiry(id)).toBeNull();
    rmSync(dir); mkdirSync(dir); symlinkSync(auth, join(dir, "auth.json"));
    expect(vault.codexExpiry(id)).toBeNull();
  } finally { vault.close(); }
});
