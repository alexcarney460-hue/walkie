// Codex (ChatGPT plan) accounts.
//   identify: $CODEX_HOME/auth.json — tokens.account_id plus the id_token's claims (user id, email, plan type).
//   token:    tokens.access_token, read-only (expiry from its `exp` claim).
//   usage:    GET https://chatgpt.com/backend-api/wham/usage with ChatGPT-Account-Id; windows labelled by their length
//             (the primary window may be the weekly one, the secondary may be null).
//   passive:  the newest session file's `event_msg` / `token_count` `rate_limits` (free, no request).
// Never calls a token or refresh endpoint.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AccountResets, AccountWindow } from "../../protocol/accounts.ts";
import { getUsageJson, USAGE_URLS, type FetchLike } from "../http.ts";
import { tailText } from "../tail.ts";
import { accountId, maskEmail, titlePlan } from "../mask.ts";
import type { AccessToken, Identity, Login, Reading } from "../types.ts";
import { kindForSeconds, num, readingFrom, toMs, window } from "../windows.ts";

/** The payload of a JWT, or null. Used for the id_token's identity claims and the access token's expiry only. */
export function jwtClaims(jwt: unknown): Record<string, unknown> | null {
  if (typeof jwt !== "string") return null;
  const part = jwt.split(".")[1];
  if (!part || part.length > 16_384) return null;
  try {
    const c = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return c && typeof c === "object" ? c as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const Auth = z.object({
  auth_mode: z.string().max(64).nullable().optional(),
  OPENAI_API_KEY: z.string().nullable().optional(),
  tokens: z.object({
    id_token: z.string().max(16_384).nullable().optional(),
    access_token: z.string().max(16_384).nullable().optional(),
    account_id: z.string().max(100).nullable().optional(),
  }).nullable().optional(),
});

function readAuth(login: Login): z.infer<typeof Auth> | null {
  const path = join(login.dir, "auth.json");
  if (!existsSync(path)) return null;
  try {
    const a = Auth.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return a.success ? a.data : null;
  } catch {
    return null;
  }
}

/** Identity from a parsed auth.json (exported for fixtures). API-key logins have no plan to meter: null. */
export function codexIdentityFrom(auth: unknown): Identity | null {
  const a = Auth.safeParse(auth);
  if (!a.success || !a.data.tokens?.account_id) return null;
  const claims = jwtClaims(a.data.tokens.id_token) ?? {};
  const oa = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const user = typeof oa.chatgpt_user_id === "string" ? oa.chatgpt_user_id : typeof claims.sub === "string" ? claims.sub : "";
  return {
    provider: "codex",
    id: accountId("codex", a.data.tokens.account_id, user),
    label: maskEmail(claims.email) ?? "ChatGPT account",
    plan: titlePlan(oa.chatgpt_plan_type),
  };
}

export function identifyCodex(login: Login): Identity | null {
  const a = readAuth(login);
  return a ? codexIdentityFrom(a) : null;
}

/**
 * The login's identity as ONE read of auth.json (RESET-2/3): the Walkie account id and the ChatGPT account id the
 * Codex app-server must answer with. A reset attempt is bound to these (and the login directory); an email or
 * sign-in-mode change with the same account id is the same account. null: no ChatGPT login there.
 */
export interface CodexAuthSnapshot { identityId: string; chatgptAccount: string }

export function codexAuthSnapshot(login: Login): CodexAuthSnapshot | null {
  const a = readAuth(login);
  const account = a?.tokens?.account_id;
  if (!a || !account) return null;
  const identity = codexIdentityFrom(a);
  return identity ? { identityId: identity.id, chatgptAccount: account } : null;
}

export function readCodexToken(login: Login): AccessToken | "none" {
  const a = readAuth(login);
  if (!a) return "none";
  const t = a.tokens;
  if (!t?.access_token || !t.account_id) {
    return a.OPENAI_API_KEY ? { value: "", expiresAt: null, apiKey: true } : "none";
  }
  const exp = num(jwtClaims(t.access_token)?.exp);
  return { value: t.access_token, expiresAt: exp !== null ? exp * 1000 : null, accountId: t.account_id };
}

const WhamWindow = z.object({
  used_percent: z.number(),
  limit_window_seconds: z.number().nullable().optional(),
  reset_after_seconds: z.number().nullable().optional(),
  reset_at: z.number().nullable().optional(),
}).nullable().optional();

function whamWindow(raw: unknown, at: number): AccountWindow | null {
  const w = WhamWindow.safeParse(raw);
  if (!w.success || !w.data) return null;
  const secs = num(w.data.limit_window_seconds);
  const resets = toMs(w.data.reset_at) ?? (num(w.data.reset_after_seconds) !== null ? at + (w.data.reset_after_seconds as number) * 1000 : null);
  return window(kindForSeconds(secs), w.data.used_percent, resets, secs);
}

const ResetCredits = z.object({
  available_count: z.number().int().min(0),
  applicable_available_count: z.number().int().min(0).nullable().optional(),
});

/** `rate_limit_reset_credits` (the limit resets the account holds), capped at 99; undefined when absent or malformed. */
export function codexResets(raw: unknown): AccountResets | undefined {
  const r = ResetCredits.safeParse(raw);
  if (!r.success) return undefined;
  const cap = (n: number) => Math.min(99, n);
  const applicable = r.data.applicable_available_count;
  return { available: cap(r.data.available_count), applicable: applicable === undefined || applicable === null ? null : cap(applicable) };
}

/** Parses the wham/usage body. */
export function parseCodexUsage(body: unknown, at: number): Reading {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const rl = (b.rate_limit && typeof b.rate_limit === "object" ? b.rate_limit : {}) as Record<string, unknown>;
  const windows = [whamWindow(rl.primary_window, at), whamWindow(rl.secondary_window, at)].filter((w): w is AccountWindow => w !== null);
  const reached = rl.limit_reached === true || rl.allowed === false || (typeof b.rate_limit_reached_type === "string" && b.rate_limit_reached_type !== "");
  const reading = readingFrom(at, windows, "api", reached);
  const resets = codexResets(b.rate_limit_reset_credits);
  return resets ? { ...reading, resets } : reading;
}

export async function fetchCodexUsage(fetchFn: FetchLike, token: AccessToken, at: number): Promise<Reading> {
  const body = await getUsageJson(fetchFn, USAGE_URLS.codex, {
    Authorization: `Bearer ${token.value}`, "ChatGPT-Account-Id": token.accountId ?? "",
  }, token.value);
  return parseCodexUsage(body, at);
}

const SessionWindow = z.object({
  used_percent: z.number(),
  window_minutes: z.number().nullable().optional(),
  resets_at: z.number().nullable().optional(),
  resets_in_seconds: z.number().nullable().optional(),
}).nullable().optional();

function sessionWindow(raw: unknown, at: number): AccountWindow | null {
  const w = SessionWindow.safeParse(raw);
  if (!w.success || !w.data) return null;
  const mins = num(w.data.window_minutes);
  const secs = mins !== null ? mins * 60 : null;
  const resets = toMs(w.data.resets_at) ?? (num(w.data.resets_in_seconds) !== null ? at + (w.data.resets_in_seconds as number) * 1000 : null);
  return window(kindForSeconds(secs), w.data.used_percent, resets, secs);
}

/** The last `token_count` rate_limits in a session file's text (one JSON object per line). */
export function parseCodexSessionTail(text: string): Reading | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
    try {
      const d = JSON.parse(line) as { timestamp?: unknown; payload?: { type?: unknown; rate_limits?: Record<string, unknown> | null } };
      if (d.payload?.type !== "token_count" || !d.payload.rate_limits) continue;
      const at = toMs(d.timestamp);
      if (at === null) continue;
      const rl = d.payload.rate_limits;
      const windows = [sessionWindow(rl.primary, at), sessionWindow(rl.secondary, at)].filter((w): w is AccountWindow => w !== null);
      if (!windows.length) continue;
      const reached = typeof rl.rate_limit_reached_type === "string" && rl.rate_limit_reached_type !== "";
      return readingFrom(at, windows, "session", reached);
    } catch { /* a partial line at the cut */ }
  }
  return null;
}

const TAIL_BYTES = 256 * 1024;


function dayDir(root: string, d: Date): string {
  return join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
}

/** The freshest rate-limit reading in today's or yesterday's session files (newest file first). */
export function passiveCodexReading(login: Login, now: number): Reading | null {
  const root = join(login.dir, "sessions");
  const files: { path: string; mtime: number }[] = [];
  for (const d of [new Date(now), new Date(now - 86_400_000)]) {
    const dir = dayDir(root, d);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try { files.push({ path, mtime: statSync(path).mtimeMs }); } catch { /* removed meanwhile */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, 5)) {
    try {
      const r = parseCodexSessionTail(tailText(f.path, TAIL_BYTES));
      if (r) return r;
    } catch { /* unreadable: next */ }
  }
  return null;
}
