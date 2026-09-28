// ORCH-2: which model logins this machine has, for WalkieTalkie's auto-start. Only presence is checked: no token is
// read, printed or copied here (the Keychain item is looked up without -w, so `security` prints its attributes only,
// which are discarded). Uses the accounts adapters' own locations (src/accounts/adapters).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { identifyClaude, KEYCHAIN_SERVICE } from "../../accounts/adapters/claude.ts";
import { identifyCodex } from "../../accounts/adapters/codex.ts";
import { kimiCredentialsPath } from "../../accounts/adapters/kimi.ts";
import type { Login } from "../../accounts/types.ts";

export type LoginProvider = "claude" | "codex" | "kimi";
/** Where the Claude login comes from: the CLI's own sign-in, CLAUDE_CODE_OAUTH_TOKEN, or the Walkie accounts vault. */
export type ClaudeSource = "cli" | "env" | "vault";

export interface Logins {
  /** Providers with a usable login, Claude first. */
  found: LoginProvider[];
  claude: ClaudeSource | null;
  /** The vault account to run on when `claude` is "vault". */
  vaultAccount?: string;
}

export interface LoginDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Whether the macOS Keychain has Claude Code's credentials item (presence only). */
  keychainHas?: (service: string) => Promise<boolean>;
  /** The vault's Claude accounts (ids only). */
  vaultClaude?: () => string[];
  platform?: string;
}

/** `security find-generic-password -s <service>` without -w: exit 0 = the item exists. Its output is discarded. */
export async function keychainHas(service: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["/usr/bin/security", "find-generic-password", "-s", service], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: homedir(), LC_ALL: "C" },
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), 3_000);
    const code = await p.exited;
    clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
}

function login(provider: Login["provider"], dir: string): Login {
  return { provider, dir, isDefault: true } as Login;
}

/** The Claude CLI is signed in: its config names an account, and its credentials are on disk or in the Keychain. */
async function claudeCli(home: string, env: NodeJS.ProcessEnv, d: LoginDeps): Promise<boolean> {
  const dir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const l = { ...login("claude", dir), isDefault: !env.CLAUDE_CONFIG_DIR };
  if (!identifyClaude(l, home)) return false;
  if (existsSync(join(dir, ".credentials.json"))) return true;
  if ((d.platform ?? process.platform) !== "darwin" || !l.isDefault) return false;
  return (d.keychainHas ?? keychainHas)(KEYCHAIN_SERVICE);
}

export async function detectLogins(d: LoginDeps = {}): Promise<Logins> {
  const home = d.home ?? homedir();
  const env = d.env ?? process.env;
  const vault = (() => { try { return d.vaultClaude?.() ?? []; } catch { return []; } })();
  const claude: ClaudeSource | null = (await claudeCli(home, env, d)) ? "cli"
    : env.CLAUDE_CODE_OAUTH_TOKEN ? "env"
    : vault.length ? "vault" : null;
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const codex = existsSync(join(codexHome, "auth.json")) || !!identifyCodex(login("codex", codexHome));
  const kimi = existsSync(kimiCredentialsPath(login("kimi", join(home, ".kimi-code"))));
  const found: LoginProvider[] = [...(claude ? ["claude" as const] : []), ...(codex ? ["codex" as const] : []), ...(kimi ? ["kimi" as const] : [])];
  return { found, claude, ...(claude === "vault" && vault[0] ? { vaultAccount: vault[0] } : {}) };
}
