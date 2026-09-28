// The `--settings` a credentialed Claude Code launch gets (ACCOUNTS-2, round 4). Two jobs:
//   · the switcher's own hooks (SessionStart / UserPromptSubmit / SessionEnd → `walkie hook switch`);
//   · credential routing that no other settings file can undo. Claude Code applies the `env` of every settings source
//     it loads (user, project, local) to its own process, so a project's `.claude/settings.json` could put
//     ANTHROPIC_BASE_URL (or a proxy, a CA, a unix socket) back after the wrapper cleaned the environment. Flag
//     settings (`--settings`) take precedence over user / project / local settings key by key (only managed policy
//     settings rank higher), so the wrapper pins each routing key there: ANTHROPIC_BASE_URL to the official endpoint,
//     every other endpoint / socket / proxy override to "" (unset for Claude Code), TLS verification on, and the
//     CA-file variables to the system bundle (never "": that breaks TLS in the session's own tools). With
//     `walkie accounts allow-proxy on` the proxy keys are not pinned (the person's proxy stays usable).
// A caller's own `--settings` (JSON text or a file) is merged in: its keys stay, the pinned env keys and the switcher's
// hooks are laid over it. One that cannot be read means no credentials for that run (the caller decides).
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const OFFICIAL_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Endpoint / socket overrides Claude Code knows (claude 2.1.x): pinned to "" (the official default applies). */
export const CLAUDE_ENDPOINT_KEYS: readonly string[] = [
  "ANTHROPIC_API_HOST", "ANTHROPIC_ASSETS_HOST", "ANTHROPIC_AWS_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_AI_AUTHORIZE_URL", "CLAUDE_AI_HOST",
  "CLAUDE_BRIDGE_BASE_URL", "CLAUDE_BRIDGE_SESSION_INGRESS_URL", "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_MEMORY_API_BASE_URL", "CLAUDE_CODE_ARTIFACTS_API_BASE_URL", "CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL",
  "CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL", "CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL", "CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL",
  "CLAUDE_CODE_CLIENT_DATA_URL", "CLAUDE_CODE_GB_BASE_URL", "CLAUDE_CODE_MCP_SERVER_URL", "CLAUDE_CODE_MODEL_CATALOG_URL",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_REMOTE",
  // Round 7 (Opus r6 LOW): more endpoint variables found in the claude binary.
  "CLAUDE_REMOTE_TOOLS_BRIDGE_URL", "CLAUDE_RUNNER_API_BASE_URL", "CLAUDE_AI_ORIGIN", "CLAUDE_LOCAL_OAUTH_API_BASE",
  "CLAUDE_LOCAL_OAUTH_APPS_BASE", "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
  // Another provider (the vault token is a Claude subscription token; these would route the session elsewhere).
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY",
];

/** Proxy keys: pinned to "" unless the person allowed proxies. */
export const CLAUDE_PROXY_KEYS: readonly string[] = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "CLAUDE_CODE_HTTP_PROXY", "CLAUDE_CODE_HTTPS_PROXY", "CLAUDE_CODE_PROXY_URL", "CLAUDE_CODE_PROXY_HOST",
];

const CA_FILES = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem"];
const CA_DIRS = ["/etc/ssl/certs"];

/** The system CA bundle (file, directory) when there is one. */
export function systemCa(exists: (p: string) => boolean = existsSync): { file: string; dir: string } {
  return { file: CA_FILES.find((f) => exists(f)) ?? "", dir: CA_DIRS.find((d) => exists(d)) ?? "" };
}

/** The env keys the wrapper pins for a credentialed Claude Code launch. */
export function pinnedEnv(o: { allowProxy: boolean; baseUrl?: string; ca?: { file: string; dir: string } }): Record<string, string> {
  const ca = o.ca ?? systemCa();
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: o.baseUrl ?? OFFICIAL_ANTHROPIC_BASE_URL };
  for (const k of CLAUDE_ENDPOINT_KEYS) env[k] = "";
  if (!o.allowProxy) for (const k of CLAUDE_PROXY_KEYS) env[k] = "";
  env.NODE_EXTRA_CA_CERTS = "";
  env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
  env.SSL_CERT_FILE = ca.file;
  env.SSL_CERT_DIR = ca.dir;
  env.REQUESTS_CA_BUNDLE = ca.file;
  env.CURL_CA_BUNDLE = ca.file;
  return env;
}

type Json = Record<string, unknown>;

/** A caller's `--settings` value: inline JSON, or a JSON file (relative to the cwd). Throws when it cannot be read. */
export function readUserSettings(value: string, cwd: string): Json {
  const text = value.trim().startsWith("{") ? value : readFileSync(isAbsolute(value) ? value : join(cwd, value), "utf8");
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("--settings is not a JSON object");
  return v as Json;
}

/** The merged `--settings` JSON: the caller's settings, the switcher's hooks added, the routing env pinned. */
export function launchSettings(o: { walkie: string; allowProxy: boolean; user?: Json | null; baseUrl?: string; ca?: { file: string; dir: string } }): string {
  const user = o.user ?? {};
  const hook = { hooks: [{ type: "command", command: `${o.walkie} hook switch # walkie-managed`, timeout: 5 }] };
  const userHooks = user.hooks && typeof user.hooks === "object" && !Array.isArray(user.hooks) ? user.hooks as Record<string, unknown> : {};
  const hooks: Record<string, unknown> = { ...userHooks };
  for (const ev of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
    const had = Array.isArray(userHooks[ev]) ? userHooks[ev] as unknown[] : [];
    hooks[ev] = [...had, hook];
  }
  const userEnv = user.env && typeof user.env === "object" && !Array.isArray(user.env) ? user.env as Record<string, unknown> : {};
  return JSON.stringify({ ...user, hooks, env: { ...userEnv, ...pinnedEnv(o) } });
}

/** Removes every `--settings <v>` / `--settings=<v>` before a `--` (the wrapper passes one merged value instead). */
export function withoutSettings(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") { out.push(...args.slice(i)); break; }
    if (a === "--settings") { i++; continue; }
    if (a.startsWith("--settings=")) continue;
    out.push(a);
  }
  return out;
}

/** The value of the caller's (last) `--settings`, when given. */
export function settingsValue(args: readonly string[]): string | null {
  let v: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") break;
    if (a === "--settings" && i + 1 < args.length) v = args[++i] as string;
    else if (a.startsWith("--settings=")) v = a.slice("--settings=".length);
  }
  return v;
}

/** Settings keys that make Claude Code use another credential than the vault's (round 5, Opus 3). */
function ownCredentialIn(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of ["apiKeyHelper", "awsCredentialExport", "awsAuthRefresh", "gcpAuthRefresh"]) if (typeof o[k] === "string" && o[k]) return k;
  const env = o.env && typeof o.env === "object" ? o.env as Record<string, unknown> : {};
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) if (typeof env[k] === "string" && env[k]) return `env.${k}`;
  return null;
}

/**
 * Whether a settings file this session would load gives it its own credential (an apiKeyHelper, an API key in its
 * env, …): then the session would run on that credential anyway, so the vault's is not handed over. Looks at the
 * caller's --settings, the user settings in the config dir, and every .claude/settings(.local).json from the cwd up to
 * (not including) the home directory. Returns "<file>: <key>" or null.
 */
export function ownCredentialSetting(o: { cwd: string; configDir: string; home: string; user?: Record<string, unknown> | null }): string | null {
  const hit = ownCredentialIn(o.user);
  if (hit) return `--settings: ${hit}`;
  const files = [join(o.configDir, "settings.json")];
  let dir = o.cwd;
  for (let i = 0; i < 64 && dir !== o.home && dir !== "/"; i++) {
    files.push(join(dir, ".claude", "settings.json"), join(dir, ".claude", "settings.local.json"));
    const up = join(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      const k = ownCredentialIn(JSON.parse(readFileSync(f, "utf8")));
      if (k) return `${f}: ${k}`;
    } catch { /* unreadable or not JSON: Claude Code would not load it either */ }
  }
  return null;
}
