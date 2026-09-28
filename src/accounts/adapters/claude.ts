// Claude Code subscription accounts.
//   identify: ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json) `oauthAccount` — account/org uuids, email, tier.
//   token:    the CURRENT access token, read-only: macOS Keychain item "Claude Code-credentials" (default config dir
//             only), else <config dir>/.credentials.json (Linux / WSL). The item is read with /usr/bin/security, the
//             tool Claude Code itself writes it with (so it is on the item's access list and reads without a prompt),
//             in its own session with no terminal, a minimal environment and a hard 3 s deadline; any failure but
//             "not found" turns Keychain reads off for 6 h (poll.ts).
//   usage:    GET https://api.anthropic.com/api/oauth/usage (anthropic-beta: oauth-2025-04-20); `limits[]` parsed
//             generically (session / weekly / weekly per model), five_hour / seven_day as the fallback.
// Never calls a token or refresh endpoint: an expiring token is skipped until Claude Code refreshes it itself.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AccountWindow } from "../../protocol/accounts.ts";
import { runProcess, type RunOptions, type RunResult } from "../../daemon/procs.ts";
import { getUsageJson, USAGE_URLS, type FetchLike } from "../http.ts";
import { accountId, claudePlan, maskEmail, modelScope } from "../mask.ts";
import type { AccessToken, Identity, Login, Reading } from "../types.ts";
import { num, readingFrom, toMs, window } from "../windows.ts";

export const KEYCHAIN_SERVICE = "Claude Code-credentials";
export const BETA_HEADER = "oauth-2025-04-20";

/** The global config file for a config dir: ~/.claude.json for the default dir, <dir>/.claude.json otherwise. */
export function claudeJsonPath(login: Login, home = homedir()): string {
  return login.isDefault ? join(home, ".claude.json") : join(login.dir, ".claude.json");
}

const OauthAccount = z.object({
  accountUuid: z.string().min(8).max(100),
  organizationUuid: z.string().max(100).nullable().optional(),
  emailAddress: z.string().max(320).nullable().optional(),
  organizationRateLimitTier: z.string().max(100).nullable().optional(),
  billingType: z.string().max(100).nullable().optional(),
});

/** Identity from the parsed global config (exported for fixtures). */
export function claudeIdentityFrom(config: unknown): Identity | null {
  const oa = OauthAccount.safeParse((config as { oauthAccount?: unknown } | null)?.oauthAccount);
  if (!oa.success) return null;
  const a = oa.data;
  return {
    provider: "claude",
    id: accountId("claude", a.accountUuid, a.organizationUuid ?? ""),
    label: maskEmail(a.emailAddress) ?? "Claude account",
    plan: claudePlan(a.organizationRateLimitTier),
  };
}

export function identifyClaude(login: Login, home = homedir()): Identity | null {
  const path = claudeJsonPath(login, home);
  if (!existsSync(path)) return null;
  try {
    return claudeIdentityFrom(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

const Creds = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(8).max(8_192),
    expiresAt: z.number().nullable().optional(),
    refreshTokenExpiresAt: z.number().nullable().optional(),
  }),
});

/** The access token from a credentials JSON (Keychain item or .credentials.json); nothing else is kept. */
export function claudeTokenFrom(raw: string): AccessToken | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const c = Creds.safeParse(parsed);
  if (!c.success) return null;
  const o = c.data.claudeAiOauth;
  const refreshExp = o.refreshTokenExpiresAt ?? null;
  return {
    value: o.accessToken, expiresAt: o.expiresAt ?? null,
    ...(refreshExp !== null && refreshExp < Date.now() ? { refreshExpired: true } : {}),
  };
}

/**
 * Reads the Keychain item's secret: the secret, null when there is no such item, "timeout" when `security` did not
 * finish by the deadline (it may be showing a prompt) and "unavailable" for any other failure (locked Keychain,
 * interaction not allowed, a refused access). Either of the last two turns Keychain reads off for 6 h.
 */
export type KeychainReader = (service: string) => Promise<string | null | "timeout" | "unavailable">;

export const KEYCHAIN_TIMEOUT_MS = 3_000;
/** readClaudeToken's own bound on any reader (a reader that never answers cannot hold up the poll). */
export const KEYCHAIN_DEADLINE_MS = KEYCHAIN_TIMEOUT_MS + 1_500;
/** `security` exit status for errSecItemNotFound. */
const SECURITY_NOT_FOUND = 44;

export type Runner = (argv: string[], opts: RunOptions) => Promise<RunResult>;

export function makeSystemKeychain(run: Runner = runProcess, platform: string = process.platform): KeychainReader {
  return async (service) => {
    if (platform !== "darwin") return null;
    const r = await run(["/usr/bin/security", "find-generic-password", "-s", service, "-w"], {
      timeoutMs: KEYCHAIN_TIMEOUT_MS, max: 256 * 1024, detached: true, killGraceMs: 500,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: homedir() },
    });
    if (r.kind === "timeout") return "timeout";
    if (r.kind !== "ok") return "unavailable";
    if (r.code === SECURITY_NOT_FOUND) return null;
    if (r.code !== 0) return "unavailable";
    return r.stdout.trim() || null;
  };
}

export const systemKeychain: KeychainReader = makeSystemKeychain();

export type TokenResult = AccessToken | "none" | "keychain_unavailable";

export async function readClaudeToken(login: Login, keychain: KeychainReader, deadlineMs = KEYCHAIN_DEADLINE_MS): Promise<TokenResult> {
  const file = join(login.dir, ".credentials.json");
  if (existsSync(file)) {
    try {
      const t = claudeTokenFrom(readFileSync(file, "utf8"));
      if (t) return t;
    } catch { /* fall through */ }
  }
  if (!login.isDefault) return "none";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), deadlineMs); });
  const raw = await Promise.race([keychain(KEYCHAIN_SERVICE).catch((): "unavailable" => "unavailable"), late]);
  clearTimeout(timer);
  if (raw === "timeout" || raw === "unavailable") return "keychain_unavailable";
  return (raw && claudeTokenFrom(raw)) || "none";
}

const Limit = z.object({
  kind: z.string().max(64).nullable().optional(),
  group: z.string().max(64).nullable().optional(),
  percent: z.number().nullable().optional(),
  resets_at: z.string().max(64).nullable().optional(),
  scope: z.object({
    model: z.object({ display_name: z.string().max(100).nullable().optional() }).nullable().optional(),
  }).nullable().optional(),
});
const LegacyWindow = z.object({ utilization: z.number().nullable().optional(), resets_at: z.string().max(64).nullable().optional() });

function limitWindow(raw: unknown): AccountWindow | null {
  const p = Limit.safeParse(raw);
  if (!p.success || typeof p.data.percent !== "number") return null;
  const l = p.data;
  const tag = `${l.kind ?? ""} ${l.group ?? ""}`.toLowerCase();
  const named = l.scope?.model?.display_name;
  const model = modelScope(named);
  const resets = toMs(l.resets_at);
  if (tag.includes("session")) return window("session", l.percent as number, resets, 5 * 3600);
  // A per-model window whose name is not a model name stays unnamed ("other"), never shown as the account's weekly.
  if (tag.includes("week")) {
    if (model) return window("weekly_model", l.percent as number, resets, 7 * 86_400, model);
    return named ? window("other", l.percent as number, resets, 7 * 86_400) : window("weekly", l.percent as number, resets, 7 * 86_400);
  }
  return window("other", l.percent as number, resets, null, null);
}

/** Parses the /api/oauth/usage body. `limits[]` wins; code-named top-level keys (null or not) are ignored. */
export function parseClaudeUsage(body: unknown, at: number): Reading {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const limits = Array.isArray(b.limits) ? b.limits.slice(0, 32) : [];
  let windows = limits.map(limitWindow).filter((w): w is AccountWindow => w !== null);
  if (!windows.length) {
    const legacy: Array<[string, AccountWindow["kind"], string | null]> = [
      ["five_hour", "session", null], ["seven_day", "weekly", null], ["seven_day_opus", "weekly_model", "Opus"], ["seven_day_sonnet", "weekly_model", "Sonnet"],
    ];
    windows = legacy.flatMap(([key, kind, scope]) => {
      const w = LegacyWindow.safeParse(b[key]);
      const u = w.success ? num(w.data.utilization) : null;
      if (!w.success || u === null) return [];
      return [window(kind, u, toMs(w.data.resets_at), kind === "session" ? 5 * 3600 : 7 * 86_400, scope)];
    });
  }
  // One of each kind (and one per model), in the order the API listed them.
  const seen = new Set<string>();
  const unique = windows.filter((w) => {
    const k = `${w.kind}:${w.scope ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return readingFrom(at, unique, "api");
}

export async function fetchClaudeUsage(fetchFn: FetchLike, token: AccessToken, at: number): Promise<Reading> {
  const body = await getUsageJson(fetchFn, USAGE_URLS.claude, {
    Authorization: `Bearer ${token.value}`, "anthropic-beta": BETA_HEADER,
  }, token.value);
  return parseClaudeUsage(body, at);
}
