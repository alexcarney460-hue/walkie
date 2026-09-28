// Kimi Code accounts.
//   identify: no identity file; the login is recorded under a provisional id until GET /coding/v1/me answers
//             (user id + email), which the poller asks with the current token.
//   token:    ~/.kimi-code/credentials/kimi-code.json access_token, read-only (Kimi rotates it every ~15 min).
//   usage:    GET https://api.kimi.com/coding/v1/usages. `usage` (the weekly quota) and `limits[]` (the 5-hour window)
//             are trusted; the `usages` block disagrees with them in practice and is ignored.
// Never calls a token or refresh endpoint.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AccountWindow } from "../../protocol/accounts.ts";
import { getUsageJson, USAGE_URLS, type FetchLike } from "../http.ts";
import { accountId, maskEmail } from "../mask.ts";
import type { AccessToken, Identity, Login, Reading } from "../types.ts";
import { kindForSeconds, num, readingFrom, toMs, window } from "../windows.ts";

export function kimiCredentialsPath(login: Login): string {
  return join(login.dir, "credentials", "kimi-code.json");
}

/** A provisional identity for a login whose /me answer is not known yet (stable per credentials file). */
export function provisionalKimiIdentity(login: Login): Identity | null {
  const path = kimiCredentialsPath(login);
  if (!existsSync(path)) return null;
  let real = path;
  try { real = realpathSync(path); } catch { /* keep the path */ }
  return { provider: "kimi", id: accountId("kimi", "login", real), label: "Kimi account", plan: null, pending: true };
}

const Me = z.object({
  user_id: z.string().min(1).max(100),
  email: z.string().max(320).nullable().optional(),
  user_level_name: z.string().max(64).nullable().optional(),
});

/** Identity from the /me body (exported for fixtures). */
export function kimiIdentityFromMe(body: unknown): Identity | null {
  const m = Me.safeParse(body);
  if (!m.success) return null;
  return { provider: "kimi", id: accountId("kimi", m.data.user_id), label: maskEmail(m.data.email) ?? "Kimi account", plan: null };
}

export async function fetchKimiIdentity(fetchFn: FetchLike, token: AccessToken): Promise<Identity | null> {
  const body = await getUsageJson(fetchFn, USAGE_URLS.kimiMe, { Authorization: `Bearer ${token.value}` }, token.value);
  return kimiIdentityFromMe(body);
}

const Creds = z.object({ access_token: z.string().max(16_384), expires_at: z.number().nullable().optional() });

export function readKimiToken(login: Login): AccessToken | "none" {
  const path = kimiCredentialsPath(login);
  if (!existsSync(path)) return "none";
  try {
    const c = Creds.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!c.success || c.data.access_token.length < 8) return "none";
    return { value: c.data.access_token, expiresAt: toMs(c.data.expires_at) };
  } catch {
    return "none";
  }
}

const UNIT_S: Record<string, number> = { TIME_UNIT_SECOND: 1, TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86_400 };

function quotaPct(d: Record<string, unknown> | undefined): number | null {
  if (!d) return null;
  const limit = num(d.limit);
  const used = num(d.used) ?? (limit !== null && num(d.remaining) !== null ? limit - (num(d.remaining) as number) : null);
  if (limit === null || used === null || limit <= 0) return null;
  return (used / limit) * 100;
}

/** Parses the /usages body. */
export function parseKimiUsage(body: unknown, at: number): Reading {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const windows: AccountWindow[] = [];
  for (const raw of Array.isArray(b.limits) ? b.limits.slice(0, 8) : []) {
    const l = (raw && typeof raw === "object" ? raw : {}) as { window?: Record<string, unknown>; detail?: Record<string, unknown> };
    const p = quotaPct(l.detail);
    if (p === null) continue;
    const dur = num(l.window?.duration);
    const unit = UNIT_S[String(l.window?.timeUnit ?? "")] ?? null;
    const secs = dur !== null && unit !== null ? dur * unit : null;
    windows.push(window(kindForSeconds(secs), p, toMs(l.detail?.resetTime), secs));
  }
  const usage = b.usage && typeof b.usage === "object" ? b.usage as Record<string, unknown> : undefined;
  const weekly = quotaPct(usage);
  if (weekly !== null) windows.push(window("weekly", weekly, toMs(usage?.resetTime), null));
  return readingFrom(at, windows, "api");
}

export async function fetchKimiUsage(fetchFn: FetchLike, token: AccessToken, at: number): Promise<Reading> {
  const body = await getUsageJson(fetchFn, USAGE_URLS.kimi, { Authorization: `Bearer ${token.value}` }, token.value);
  return parseKimiUsage(body, at);
}
