import { describe, expect, test } from "bun:test";
import { claudeSeatAccess } from "../../src/accounts/vault/claude-access.ts";
import { guardedClaudeKeychain, readClaudeToken } from "../../src/accounts/adapters/claude.ts";
import { SeatsHost, scrubSeatOutput } from "../../src/daemon/seats/host.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("Claude seat access projection", () => {
  test("carries Claude's inference scope but no refresh capability", () => {
    const now = Date.now();
    const copy = claudeSeatAccess({ value: "access", expiresAt: now + 3_600_000, scopes: ["user:inference"], subscriptionType: "pro" }, now);
    const login = JSON.parse(copy as string).claudeAiOauth;
    expect(login).toEqual({ accessToken: "access", expiresAt: now + 3_600_000, scopes: ["user:inference"], subscriptionType: "pro" });
    expect(Array.isArray(login.scopes) && login.scopes.includes("user:inference") && !!login.accessToken && Number.isFinite(login.expiresAt)).toBe(true);
    expect(copy).not.toContain("refreshToken");
  });

  test("refuses near expiry and accepts a newly read access token", () => {
    const now = Date.now();
    const scopes = ["user:inference"];
    expect(claudeSeatAccess({ value: "old", expiresAt: now + 60_000, scopes }, now)).toBeNull();
    expect(claudeSeatAccess({ value: "unknown", expiresAt: null, scopes }, now)).toBeNull();
    expect(claudeSeatAccess({ value: "unscoped", expiresAt: now + 3_600_000 }, now)).toBeNull();
    expect(claudeSeatAccess({ value: "new", expiresAt: now + 3_600_000, scopes }, now)).toContain("new");
  });

  test("a stale file falls through to fresh Keychain credentials", async () => {
    const home = mkdtempSync("/tmp/walkie-claude-access-");
    try {
      const dir = join(home, ".claude");
      mkdirSync(dir);
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "old-access", expiresAt: Date.now() + 60_000 } }));
      let reads = 0;
      const token = await readClaudeToken({ provider: "claude", dir, isDefault: true }, async () => {
        reads++;
        return JSON.stringify({ claudeAiOauth: { accessToken: "fresh-access", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"] } });
      }, undefined, 600_000);
      expect(reads).toBe(1);
      expect(typeof token === "object" && token.value).toBe("fresh-access");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a failed Keychain read is shared across seats and accounts readers", async () => {
    let reads = 0;
    const reader = async () => { reads++; return "timeout" as const; };
    expect(await guardedClaudeKeychain(reader, 3_600_000)("Claude Code-credentials")).toBe("timeout");
    expect(await guardedClaudeKeychain(reader, 3_600_000)("Claude Code-credentials")).toBe("unavailable");
    expect(reads).toBe(1);
  });

  test("unknown identities reread the current login instead of reusing a previous token", async () => {
    const home = mkdtempSync("/tmp/walkie-claude-unknown-identity-");
    try {
      let login = "first-login-token";
      const host = Object.create(SeatsHost.prototype) as any;
      host.opts = { keychain: async () => JSON.stringify({ claudeAiOauth: {
        accessToken: login, expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"],
      } }), env: { HOME: home } };
      host.cachedClaudeAccess = null;
      host.claudeFileCredentials = () => null;

      const first = await host.claudeCredentials();
      login = "second-login-token";
      const second = await host.claudeCredentials();
      expect(first.claude_credentials).toContain("first-login-token");
      expect(second.claude_credentials).toContain("second-login-token");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("seat output scrubs raw, base64 and hex forms of the projected token", () => {
    const token = "fake-claude-access-123456";
    for (const form of [token, Buffer.from(token).toString("base64"), Buffer.from(token).toString("hex")]) {
      expect(scrubSeatOutput(`output ${form} done`, token)).not.toContain(form);
    }
  });
});
