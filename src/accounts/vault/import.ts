// AGENT-ADMIN-1: `walkie accounts add claude` without a pasted token imports this machine's existing Claude login, so
// no browser is needed: a setup-token already in the environment (CLAUDE_CODE_OAUTH_TOKEN), else Claude Code's own
// login (<config dir>/.credentials.json, or the macOS Keychain item for the default config dir) when it is a
// long-lived token. A `claude auth login` session token lives hours, not a year: storing it would leave a vault entry
// that stops working the same day, so it is refused with what to do instead.
import { homedir } from "node:os";
import { join } from "node:path";
import { copyFileSync, lstatSync, readFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { readClaudeToken, systemKeychain, type KeychainReader } from "../adapters/claude.ts";
import { identifyClaude } from "../adapters/claude.ts";
import { identifyCodex } from "../adapters/codex.ts";
import { pendingCodexHome, finalCodexHome, removeCodexHome } from "./codex-home.ts";
import { inferredVaultHome, readCodexAuthFromHome, readVaultCredential, vaultCodexHomePath } from "./vault-path.ts";
import { SETUP_TOKEN_RE, type Vault, type VaultEntry } from "./vault.ts";
import type { Login } from "../types.ts";

/** A login token counts as long-lived when it has no expiry, or one at least this far away. */
export const LONG_LIVED_MS = 30 * 86_400_000;

export type ClaudeImport = { token: string; source: string } | { why: string };

export async function importClaudeLogin(
  o: { env?: NodeJS.ProcessEnv; home?: string; keychain?: KeychainReader; now?: number } = {},
): Promise<ClaudeImport> {
  const env = o.env ?? process.env;
  const fromEnv = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv && SETUP_TOKEN_RE.test(fromEnv)) return { token: fromEnv, source: "CLAUDE_CODE_OAUTH_TOKEN" };
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  const dir = custom || join(o.home ?? homedir(), ".claude");
  const t = await readClaudeToken({ provider: "claude", dir, isDefault: !custom }, o.keychain ?? systemKeychain);
  if (t === "keychain_unavailable") return { why: "this machine's Claude login is in its Keychain, which didn't answer (locked, or it asked for permission)" };
  if (t === "none") return { why: "no Claude login on this machine (claude auth login / claude setup-token first)" };
  if (!SETUP_TOKEN_RE.test(t.value)) return { why: "this machine's Claude login is not an OAuth token Sqwakie can store" };
  const now = o.now ?? Date.now();
  if (t.expiresAt !== null && t.expiresAt - now < LONG_LIVED_MS) {
    const hours = Math.max(0, Math.round((t.expiresAt - now) / 3_600_000));
    return { why: `this machine's Claude login is a session token that expires in about ${hours} h, not a long-lived one` };
  }
  return { token: t.value, source: custom ? `${dir}/.credentials.json` : "this machine's Claude login" };
}

/** Only a comparison value is shared; the refresh token itself stays in auth.json on this machine. */
export function codexFingerprint(dir: string, walkieHome?: string): string | null {
  const file = join(dir, "auth.json");
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 64 * 1024 || (st.mode & 0o077) !== 0) return null;
    const vault = inferredVaultHome("codex", dir);
    const text = walkieHome ? readCodexAuthFromHome(walkieHome, dir)
      : vault ? readVaultCredential(vault.walkieHome, "codex", vault.home, "auth.json") : readFileSync(file, "utf8");
    if (text === null) return null;
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const tokens = (raw as { tokens?: unknown }).tokens;
    if (!tokens || typeof tokens !== "object") return null;
    const { account_id, refresh_token } = tokens as Record<string, unknown>;
    if (typeof account_id !== "string" || !account_id || typeof refresh_token !== "string" || !refresh_token) return null;
    return createHash("sha256").update(`${account_id.length}:${account_id}:${refresh_token}`).digest("hex");
  } catch { return null; }
}

export interface TrackedLogin { id: string; provider: string; label: string; plan: string | null; dir: string; is_default: boolean; token_login?: boolean; vault?: boolean }
export interface RemoteFingerprint { id: string; fingerprint: string }
export interface ImportResult { imported: VaultEntry[]; skipped: { id: string; label: string; reason: string }[] }

/** Imports tracker-confirmed local logins through the vault's existing add methods. No credential leaves this process. */
export async function importTracked(o: {
  rows: readonly TrackedLogin[]; vault: Vault; walkieHome: string; home: string;
  remote: readonly RemoteFingerprint[]; provider?: "claude" | "codex";
  approve: (label: string, provider: "claude" | "codex") => Promise<boolean>;
  checkCodexCli?: () => void;
  keychain?: KeychainReader;
}): Promise<ImportResult> {
  const imported: VaultEntry[] = [];
  const skipped: ImportResult["skipped"] = [];
  for (const row of o.rows) {
    if (row.provider !== "claude" && row.provider !== "codex") continue;
    if (o.provider && row.provider !== o.provider) continue;
    if (row.token_login || row.vault || (row.provider === "codex" && vaultCodexHomePath(o.walkieHome, row.dir)) || o.vault.get(row.id)) {
      skipped.push({ id: row.id, label: row.label, reason: "already vaulted or not a file login" }); continue;
    }
    const login: Login = { provider: row.provider, dir: row.dir, isDefault: row.is_default };
    const ident = row.provider === "claude" ? identifyClaude(login, o.home) : identifyCodex(login);
    if (!ident || ident.id !== row.id) { skipped.push({ id: row.id, label: row.label, reason: "login changed" }); continue; }
    if (row.provider === "codex") {
      const fp = codexFingerprint(row.dir, o.walkieHome);
      if (!fp) { skipped.push({ id: row.id, label: row.label, reason: "unreadable refresh token" }); continue; }
      if (o.remote.some((r) => r.id === row.id && r.fingerprint === fp)) { skipped.push({ id: row.id, label: row.label, reason: "copied session" }); continue; }
      try { o.checkCodexCli?.(); }
      catch { skipped.push({ id: row.id, label: row.label, reason: "Codex CLI unavailable or untrusted" }); continue; }
      if (!(await o.approve(ident.label, "codex"))) { skipped.push({ id: row.id, label: row.label, reason: "declined" }); continue; }
      const pending = pendingCodexHome(o.walkieHome, row.dir);
      let done = false;
      try {
        copyFileSync(join(row.dir, "auth.json"), join(pending, "auth.json"));
        chmodSync(join(pending, "auth.json"), 0o600);
        if (codexFingerprint(pending, o.walkieHome) !== fp || identifyCodex({ provider: "codex", dir: pending, isDefault: false, vault: true })?.id !== row.id || codexFingerprint(row.dir, o.walkieHome) !== fp) {
          throw new Error("Codex login changed during import");
        }
        const final = finalCodexHome(pending, o.walkieHome, row.id);
        done = true;
        try { imported.push(o.vault.addCodex({ id: ident.id, label: ident.label, plan: ident.plan, home: final })); }
        catch (err) { removeCodexHome(final, o.walkieHome); throw err; }
      } finally { if (!done) removeCodexHome(pending, o.walkieHome); }
      continue;
    }
    const env = row.is_default ? { CLAUDE_CONFIG_DIR: "" } : { CLAUDE_CONFIG_DIR: row.dir };
    const source = await importClaudeLogin({ env, home: o.home, keychain: o.keychain });
    if ("why" in source) { skipped.push({ id: row.id, label: row.label, reason: source.why }); continue; }
    if (!(await o.approve(ident.label, "claude"))) { skipped.push({ id: row.id, label: row.label, reason: "declined" }); continue; }
    if (identifyClaude(login, o.home)?.id !== row.id) { skipped.push({ id: row.id, label: row.label, reason: "login changed" }); continue; }
    const current = await importClaudeLogin({ env, home: o.home, keychain: o.keychain });
    if ("why" in current || current.token !== source.token) { skipped.push({ id: row.id, label: row.label, reason: "login changed" }); continue; }
    imported.push(await o.vault.addClaude({ id: ident.id, label: ident.label, plan: ident.plan, token: source.token, linked: true }));
  }
  return { imported, skipped };
}
