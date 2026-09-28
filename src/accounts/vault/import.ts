// AGENT-ADMIN-1: `walkie accounts add claude` without a pasted token imports this machine's existing Claude login, so
// no browser is needed: a setup-token already in the environment (CLAUDE_CODE_OAUTH_TOKEN), else Claude Code's own
// login (<config dir>/.credentials.json, or the macOS Keychain item for the default config dir) when it is a
// long-lived token. A `claude auth login` session token lives hours, not a year: storing it would leave a vault entry
// that stops working the same day, so it is refused with what to do instead.
import { homedir } from "node:os";
import { join } from "node:path";
import { readClaudeToken, systemKeychain, type KeychainReader } from "../adapters/claude.ts";
import { SETUP_TOKEN_RE } from "./vault.ts";

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
  if (!SETUP_TOKEN_RE.test(t.value)) return { why: "this machine's Claude login is not an OAuth token Walkie can store" };
  const now = o.now ?? Date.now();
  if (t.expiresAt !== null && t.expiresAt - now < LONG_LIVED_MS) {
    const hours = Math.max(0, Math.round((t.expiresAt - now) / 3_600_000));
    return { why: `this machine's Claude login is a session token that expires in about ${hours} h, not a long-lived one` };
  }
  return { token: t.value, source: custom ? `${dir}/.credentials.json` : "this machine's Claude login" };
}
