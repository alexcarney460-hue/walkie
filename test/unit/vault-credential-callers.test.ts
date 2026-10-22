import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatCredentials } from "../../src/daemon/seats/account.ts";
import { readCodexAuthFromHome } from "../../src/accounts/vault/vault-path.ts";
import { readCodexToken } from "../../src/accounts/adapters/codex.ts";
import { readKimiToken } from "../../src/accounts/adapters/kimi.ts";
import { codexFingerprint } from "../../src/accounts/vault/import.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";

const root = join(import.meta.dir, "..", "..");

test("every vault credential call site routes through the checked reader", () => {
  const callers = [
    ["src/accounts/adapters/codex.ts", "readVaultCredential"], // identity and usage polling
    ["src/accounts/adapters/kimi.ts", "readVaultCredential"], // identity and usage polling
    ["src/accounts/vault/vault.ts", "readVaultCredential"], // access-only copies and lease
    ["src/accounts/vault/import.ts", "readCodexAuthFromHome"], // pending Codex import verification
    ["src/daemon/seats/account.ts", "readVaultCredential"], // local seat-user handoff
    ["src/daemon/seats/host.ts", "readCodexAuthFromHome"], // selected vault home projection
  ] as const;
  for (const [file, reader] of callers) {
    expect(readFileSync(join(root, file), "utf8"), file).toContain(`${reader}(`);
  }
});

test("seat-user Codex handoff rejects linked and loose vault credentials", async () => {
  const walkie = mkdtempSync(join(tmpdir(), "vault-seat-reader-"));
  const home = join(walkie, "vault", "codex", "a".repeat(24));
  const file = join(home, "auth.json");
  const outside = join(walkie, "outside-auth.json");
  const auth = JSON.stringify({ tokens: { access_token: "fake" + "-access", refresh_token: "fake" + "-refresh" } });
  const entry = { id: "a".repeat(24), provider: "codex", home } as VaultEntry;
  const deps = {
    claudeToken: async () => "",
    lease: async () => ({ grant: "" }),
    accessOnlyCodex: (text: string) => JSON.parse(text).tokens.access_token ? JSON.stringify({ tokens: { access_token: "fake" + "-access" } }) : null,
  };
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(outside, auth, { mode: 0o600 });
    symlinkSync(outside, file);
    await expect(seatCredentials({ kind: "local", entry }, "person", true, deps)).rejects.toThrow(/isn't signed in/);
    await expect(seatCredentials({ kind: "local", entry }, "person", false, deps)).rejects.toThrow(/isn't signed in/);
    rmSync(file);
    writeFileSync(file, auth, { mode: 0o600 });
    chmodSync(file, 0o644);
    await expect(seatCredentials({ kind: "local", entry }, "person", true, deps)).rejects.toThrow(/isn't signed in/);
    chmodSync(file, 0o600);
    chmodSync(home, 0o755);
    await expect(seatCredentials({ kind: "local", entry }, "person", true, deps)).rejects.toThrow(/isn't signed in/);
    await expect(seatCredentials({ kind: "local", entry }, "person", false, deps)).rejects.toThrow(/isn't signed in/);
    chmodSync(home, 0o700);
    expect((await seatCredentials({ kind: "local", entry }, "person", true, deps)).codexAuth).not.toContain("fake-refresh");
    expect((await seatCredentials({ kind: "local", entry }, "person", false, deps)).env.CODEX_HOME).toBe(home);
  } finally {
    rmSync(walkie, { recursive: true, force: true });
  }
});

test("host projection reads selected vault homes through the checked reader", () => {
  const walkie = mkdtempSync(join(tmpdir(), "vault-host-reader-"));
  const home = join(walkie, "vault", "codex", "b".repeat(24));
  const file = join(home, "auth.json");
  const auth = JSON.stringify({ tokens: { access_token: "fake" + "-access" } });
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(file, auth, { mode: 0o600 });
    expect(readCodexAuthFromHome(walkie, home)).toBe(auth);
    chmodSync(home, 0o755);
    expect(readCodexAuthFromHome(walkie, home)).toBeNull();
    chmodSync(home, 0o700);
    const alias = join(walkie, "alias");
    symlinkSync(home, alias);
    expect(readCodexAuthFromHome(walkie, alias)).toBe(auth);
    rmSync(file);
    const outside = join(walkie, "outside.json");
    writeFileSync(outside, auth, { mode: 0o600 });
    symlinkSync(outside, file);
    expect(readCodexAuthFromHome(walkie, home)).toBeNull();
    expect(readCodexAuthFromHome(walkie, alias)).toBeNull();
  } finally { rmSync(walkie, { recursive: true, force: true }); }
});

test("same-user Kimi seat refuses an unsafe vault credential", async () => {
  const walkie = mkdtempSync(join(tmpdir(), "vault-kimi-seat-reader-"));
  const home = join(walkie, "vault", "kimi", "c".repeat(24));
  const file = join(home, "credentials", "kimi-code.json");
  const entry = { id: "c".repeat(24), provider: "kimi", home } as VaultEntry;
  const deps = { claudeToken: async () => "", lease: async () => ({ grant: "" }), accessOnlyCodex: () => null };
  try {
    mkdirSync(join(home, "credentials"), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ access_token: "fake" + "-token-12345" }), { mode: 0o600 });
    expect((await seatCredentials({ kind: "local", entry }, "person", false, deps)).env.KIMI_CODE_HOME).toBe(home);
    chmodSync(file, 0o644);
    await expect(seatCredentials({ kind: "local", entry }, "person", false, deps)).rejects.toThrow(/no safe credential/);
  } finally { rmSync(walkie, { recursive: true, force: true }); }
});

test("provider readers recognize a selected vault path even without a vault flag", () => {
  const walkie = mkdtempSync(join(tmpdir(), "vault-selected-reader-"));
  const codex = join(walkie, "vault", "codex", "d".repeat(24));
  const kimi = join(walkie, "vault", "kimi", "e".repeat(24));
  try {
    mkdirSync(codex, { recursive: true, mode: 0o700 });
    mkdirSync(join(kimi, "credentials"), { recursive: true, mode: 0o700 });
    writeFileSync(join(codex, "auth.json"), JSON.stringify({ tokens: { access_token: "fake" + "-access", account_id: "fake-account", refresh_token: "fake" + "-refresh" } }), { mode: 0o600 });
    writeFileSync(join(kimi, "credentials", "kimi-code.json"), JSON.stringify({ access_token: "fake" + "-token-12345" }), { mode: 0o600 });
    chmodSync(codex, 0o755);
    chmodSync(kimi, 0o755);
    expect(readCodexToken({ provider: "codex", dir: codex, isDefault: false })).toBe("none");
    expect(readKimiToken({ provider: "kimi", dir: kimi, isDefault: false })).toBe("none");
    expect(codexFingerprint(codex)).toBeNull();
  } finally { rmSync(walkie, { recursive: true, force: true }); }
});
