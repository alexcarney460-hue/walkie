import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { importTracked, codexFingerprint } from "../../src/accounts/vault/import.ts";
import { Vault } from "../../src/accounts/vault/vault.ts";
import { lazyVault } from "../../src/accounts/vault/source.ts";
import { AccountsService } from "../../src/accounts/service.ts";
import { vaultCommand } from "../../src/cli/commands/vault.ts";
import { setTtyForTests } from "../../src/cli/tty.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { postAccountImportNotice } from "../../src/accounts/import-notice.ts";
import { Store } from "../../src/daemon/store.ts";

// The vaults these tests create keep their key in a file in the temp home: on a Mac the default key store is the real
// login Keychain, which a test never touches (test/helpers/keychain-guard.ts refuses it and fails the test).
const keystoreBefore = process.env.WALKIE_VAULT_KEYSTORE;
process.env.WALKIE_VAULT_KEYSTORE = "file";
afterAll(() => {
  if (keystoreBefore === undefined) delete process.env.WALKIE_VAULT_KEYSTORE;
  else process.env.WALKIE_VAULT_KEYSTORE = keystoreBefore;
});

const token = "sk-ant-oat01-FAKECLITOKEN0123456789abcdefghijklmnop";
const jwt = (body: object) => `x.${Buffer.from(JSON.stringify(body)).toString("base64url")}.x`;

test("imports tracked Codex and Claude once, refuses copied refresh tokens, and never returns credentials", async () => {
  const root = mkdtempSync("/tmp/walkie-import-");
  const home = join(root, "user");
  const walkie = join(root, "walkie");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"));
  mkdirSync(walkie);
  const auth = { auth_mode: "chatgpt", tokens: { account_id: "acct-1", id_token: jwt({ sub: "user-1", email: "alice@example.com" }), access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "fake-refresh-1" } };
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "claude-uuid-1", emailAddress: "alice@example.com" } }));
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 100 * 86_400_000 } }), { mode: 0o600 });
  const { identifyCodex } = await import("../../src/accounts/adapters/codex.ts");
  const { identifyClaude } = await import("../../src/accounts/adapters/claude.ts");
  const codex = identifyCodex({ provider: "codex", dir: join(home, ".codex"), isDefault: true })!;
  const claude = identifyClaude({ provider: "claude", dir: join(home, ".claude"), isDefault: true }, home)!;
  const rows = [
    { id: codex.id, provider: "codex", label: codex.label, plan: codex.plan, dir: join(home, ".codex"), is_default: true },
    { id: claude.id, provider: "claude", label: claude.label, plan: claude.plan, dir: join(home, ".claude"), is_default: true },
  ] as const;
  const vault = Vault.open(walkie, { home });
  try {
    const copied = await importTracked({ rows, vault, walkieHome: walkie, home, remote: [{ id: codex.id, fingerprint: codexFingerprint(join(home, ".codex"))! }], approve: async () => true });
    expect(copied.imported.map((e) => e.provider)).toEqual(["claude"]);
    expect(copied.skipped.some((s) => s.reason === "copied session")).toBe(true);
    const untrusted = await importTracked({ rows: [rows[0]], vault, walkieHome: walkie, home, remote: [], approve: async () => true,
      checkCodexCli: () => { throw new Error("untrusted CLI"); } });
    expect(untrusted.skipped[0]?.reason).toBe("Codex CLI unavailable or untrusted");
    expect(vault.get(codex.id)).toBeNull();
    chmodSync(join(home, ".codex", "auth.json"), 0o644);
    expect(codexFingerprint(join(home, ".codex"))).toBeNull();
    chmodSync(join(home, ".codex", "auth.json"), 0o600);
    const fresh = await importTracked({ rows, vault, walkieHome: walkie, home, remote: [], approve: async () => true });
    expect(fresh.imported.map((e) => e.provider)).toEqual(["codex"]);
    expect((await importTracked({ rows, vault, walkieHome: walkie, home, remote: [], approve: async () => true })).imported).toHaveLength(0);
    expect(JSON.stringify([copied, fresh])).not.toContain(token);
    expect(JSON.stringify([copied, fresh])).not.toContain("fake-refresh-1");
  } finally { vault.close(); rmSync(root, { recursive: true, force: true }); }
});

test("daemon notes a new login once while off, then imports when the person opts in", async () => {
  const root = mkdtempSync("/tmp/walkie-auto-import-");
  const home = join(root, "user");
  const walkie = join(root, "walkie");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(walkie);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "claude-uuid-2", emailAddress: "alice@example.com" } }));
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 100 * 86_400_000 } }), { mode: 0o600 });
  const notes: string[] = [];
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const svc = new AccountsService(walkie, log, () => undefined, { home, poll: false, vault: lazyVault(walkie), keychain: async () => null, importNotice: (s) => notes.push(s) });
  try {
    svc.observe([{ agent: "claude-one", runtime: "claude-code" }]);
    await svc.tick();
    await svc.tick();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("walkie accounts import");
    expect(Vault.exists(walkie)).toBe(false);
    writeFileSync(join(walkie, "config.json"), JSON.stringify({ accounts_auto_import: true }));
    await svc.tick();
    const vault = Vault.open(walkie, { home });
    try { expect(vault.list().map((e) => e.provider)).toEqual(["claude"]); }
    finally { vault.close(); }
    expect(notes.join(" ")).not.toContain(token);
  } finally { svc.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("daemon refuses a copied Codex session even when auto-import is on", async () => {
  const root = mkdtempSync("/tmp/walkie-auto-copy-");
  const home = join(root, "user");
  const walkie = join(root, "walkie");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(walkie);
  const auth = { auth_mode: "chatgpt", tokens: { account_id: "copied-account", id_token: jwt({ sub: "person" }), access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "fake-copied-refresh" } };
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  writeFileSync(join(walkie, "config.json"), JSON.stringify({ accounts_auto_import: true }));
  const { identifyCodex } = await import("../../src/accounts/adapters/codex.ts");
  const id = identifyCodex({ provider: "codex", dir: join(home, ".codex"), isDefault: true })!.id;
  const notes: string[] = [];
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const svc = new AccountsService(walkie, log, () => undefined, { home, poll: false, vault: lazyVault(walkie),
    remoteFingerprints: () => [{ id, fingerprint: codexFingerprint(join(home, ".codex"))! }], importNotice: (s) => notes.push(s) });
  try {
    svc.observe([{ agent: "codex-one", runtime: "codex" }]);
    await svc.tick();
    await svc.tick();
    const vault = Vault.open(walkie, { home });
    try { expect(vault.list()).toHaveLength(0); } finally { vault.close(); }
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("copy from another machine");
    expect(notes.join(" ")).not.toContain("fake-copied-refresh");
  } finally { svc.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("auto-import switch is person-only even when agent administration is on", async () => {
  const root = mkdtempSync("/tmp/walkie-import-gate-");
  const old = process.env.WALKIE_HOME;
  process.env.WALKIE_HOME = root;
  writeFileSync(join(root, "config.json"), JSON.stringify({ agent_admin: true, accounts_auto_import: false }));
  const output: string[] = [];
  const ctx = (marker: string | null) => ({
    args: { pos: ["auto-import", "on"], flags: new Map() }, json: false, forAgent: !!marker,
    agentSignals: () => ({ marker, inspection: "ok" }), out: (s: string) => output.push(s), err: () => undefined,
  } as unknown as Ctx);
  try {
    setTtyForTests(null);
    await expect(vaultCommand(ctx("codex"), "auto-import")).rejects.toThrow(/only this machine's person/);
    expect(JSON.parse((await Bun.file(join(root, "config.json")).text())).accounts_auto_import).toBe(false);
    setTtyForTests({ ask: async () => "", secret: async () => "", close: () => undefined });
    expect(await vaultCommand(ctx(null), "auto-import")).toBe(0);
    expect(JSON.parse((await Bun.file(join(root, "config.json")).text())).accounts_auto_import).toBe(true);
  } finally {
    setTtyForTests(undefined);
    if (old === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent import follows agent-admin gate and writes a local audit without credentials", async () => {
  const root = mkdtempSync("/tmp/walkie-import-audit-");
  const old = process.env.WALKIE_HOME;
  process.env.WALKIE_HOME = root;
  writeFileSync(join(root, "accounts.json"), JSON.stringify({ version: 1, records: [] }));
  const output: string[] = [];
  const ctx = { args: { pos: ["import"], flags: new Map() }, json: false, forAgent: true,
    agentSignals: () => ({ marker: "codex", inspection: "ok" }),
    client: () => { throw new Error("fixture daemon unavailable"); }, out: (s: string) => output.push(s), err: () => undefined,
  } as unknown as Ctx;
  try {
    setTtyForTests(null);
    writeFileSync(join(root, "config.json"), JSON.stringify({ agent_admin: false }));
    await expect(vaultCommand(ctx, "import")).rejects.toThrow(/agent admin is off/);
    writeFileSync(join(root, "config.json"), JSON.stringify({ agent_admin: true }));
    expect(await vaultCommand(ctx, "import")).toBe(0);
    const audit = await Bun.file(join(root, "admin-audit.jsonl")).text();
    expect(audit).toContain("walkie accounts import");
    expect(audit + output.join(" ")).not.toContain(token);
  } finally {
    setTtyForTests(undefined);
    if (old === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("untrusted Codex CLI skips that login and still imports independent Claude login", async () => {
  const root = mkdtempSync("/tmp/walkie-import-independent-");
  const home = join(root, "user");
  const walkie = join(root, "walkie");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"));
  mkdirSync(walkie);
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {
    account_id: "acct-independent", id_token: jwt({ sub: "user-independent" }), access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "fake-refresh-independent",
  } }), { mode: 0o600 });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "claude-independent", emailAddress: "alice@example.com" } }));
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 100 * 86_400_000 } }), { mode: 0o600 });
  const { identifyCodex } = await import("../../src/accounts/adapters/codex.ts");
  const { identifyClaude } = await import("../../src/accounts/adapters/claude.ts");
  const codex = identifyCodex({ provider: "codex", dir: join(home, ".codex"), isDefault: true })!;
  const claude = identifyClaude({ provider: "claude", dir: join(home, ".claude"), isDefault: true }, home)!;
  const vault = Vault.open(walkie, { home });
  try {
    const result = await importTracked({ rows: [
      { id: codex.id, provider: "codex", label: codex.label, plan: codex.plan, dir: join(home, ".codex"), is_default: true },
      { id: claude.id, provider: "claude", label: claude.label, plan: claude.plan, dir: join(home, ".claude"), is_default: true },
    ], vault, walkieHome: walkie, home, remote: [], approve: async () => true,
    checkCodexCli: () => { throw new Error("fixture untrusted CLI"); } });
    expect(result.imported.map((e) => e.provider)).toEqual(["claude"]);
    expect(result.skipped).toContainEqual({ id: codex.id, label: codex.label, reason: "Codex CLI unavailable or untrusted" });
    expect(vault.get(codex.id)).toBeNull();
    expect(vault.get(claude.id)).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(token);
  } finally { vault.close(); rmSync(root, { recursive: true, force: true }); }
});

test("account import notice is delivered to the local person's conversation only", () => {
  const root = mkdtempSync("/tmp/walkie-import-notice-");
  const store = new Store(join(root, "walkie.db"));
  const published: unknown[] = [];
  const core = { myHandle: () => "alice", store,
    hub: { publishLocal: (event: unknown) => published.push(event) }, emit: () => { throw new Error("team post must not be called"); } };
  try {
    postAccountImportNotice(core, "alice@example.com can be added: walkie accounts import");
    const messages = store.orchMessages({ limit: 10 });
    expect(messages).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "orchestrator", via: "private", text: "alice@example.com can be added: walkie accounts import" });
    expect(published[0]).toMatchObject({ type: "orchestrator_message", message: messages[0] });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
