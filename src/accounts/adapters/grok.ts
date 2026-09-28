// Grok (xAI) accounts. No usage API is known, so nothing is requested and no token is read.
//   identify: ~/.grok/auth.json — the plain user_id, team_id and email fields of each login entry (never its key or
//             refresh_token); expires_at (UTC, zone-less) in the past with NO refresh token marks the login as needing a
//             new sign-in. With a refresh token the CLI renews it on its next run, so the state stays "unknown".
//   usage:    reactive: the CLI's own log (~/.grok/logs/unified.jsonl) is scanned for failed turns whose status or
//             message says the usage is spent (usage_limit_reached, usage_pool_exhausted, rate_limited, "usage balance
//             exhausted", a 402/429 status code even without such wording). That marks the account exhausted until a reset time in the message, else for
//             60 minutes — held here only: the reading's `until` stays null (the reset is unknown, never shown as a
//             time; RESET-CLOCK-1). Otherwise the reading is "unknown — no usage API".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tailText } from "../tail.ts";
import { accountId, maskEmail } from "../mask.ts";
import type { Identity, Login, Reading } from "../types.ts";
import { toMs } from "../windows.ts";

export const GROK_EXHAUSTED_DEFAULT_MS = 60 * 60_000;
const MARKERS = /usage_limit_reached|usage_pool_exhausted|rate_limited|usage balance exhausted|usage limit reached|status 402|status 429/i;
const FAILURE_MSGS = new Set(["shell.turn.inference_failed", "turn.terminal_failure"]);
/** A cheap line pre-filter: a marker word, or a 402/429 anywhere (the parsed record decides). */
const CANDIDATE = /\b(?:402|429)\b/;
const TAIL_BYTES = 512 * 1024;

/** Identity from a parsed auth.json (exported for fixtures): the first entry with a user id. */
export function grokIdentityFrom(auth: unknown, now: number): Identity | null {
  if (!auth || typeof auth !== "object") return null;
  for (const entry of Object.values(auth as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const user = typeof e.user_id === "string" ? e.user_id.slice(0, 100) : "";
    if (!user) continue;
    const team = typeof e.team_id === "string" ? e.team_id.slice(0, 100) : "";
    const exp = toMs(e.expires_at);
    const canRefresh = typeof e.refresh_token === "string" && e.refresh_token.length > 0;
    return {
      provider: "grok", id: accountId("grok", team, user), label: maskEmail(e.email) ?? "Grok account", plan: null,
      ...(exp !== null && exp < now && !canRefresh ? { expired: true } : {}),
    };
  }
  return null;
}

export function identifyGrok(login: Login, now: number): Identity | null {
  const path = join(login.dir, "auth.json");
  if (!existsSync(path)) return null;
  try {
    return grokIdentityFrom(JSON.parse(readFileSync(path, "utf8")), now);
  } catch {
    return null;
  }
}

/** "resets at <ISO>" / "try again in N minutes|seconds|hours" in a failure message → unix ms. */
export function resetFromMessage(msg: string, at: number): number | null {
  const iso = /reset[s]?\s+(?:at|on)\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9:]+)?)/i.exec(msg);
  if (iso) return toMs(iso[1]);
  const rel = /(?:in|after)\s+([0-9]+(?:\.[0-9]+)?)\s*(second|sec|s|minute|min|m|hour|hr|h)s?\b/i.exec(msg);
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] as string).toLowerCase();
    const mult = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1_000;
    return at + n * mult;
  }
  return null;
}

/** The latest usage-spent failure in log text (JSON lines) → exhausted reading, or null. */
export function parseGrokLog(text: string): Reading | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (!MARKERS.test(line) && !CANDIDATE.test(line)) continue;
    let d: { ts?: unknown; msg?: unknown; lvl?: unknown; ctx?: Record<string, unknown> };
    try { d = JSON.parse(line); } catch { continue; }
    const ctx = d.ctx ?? {};
    const message = typeof ctx.message === "string" ? ctx.message : "";
    const status = typeof ctx.status_code === "number" ? ctx.status_code : null;
    const failure = FAILURE_MSGS.has(String(d.msg)) || d.lvl === "error";
    const spent = status === 402 || status === 429 || MARKERS.test(message) || MARKERS.test(String(ctx.error_type ?? ""));
    if (!failure || !spent) continue;
    const at = toMs(d.ts);
    if (at === null) continue;
    // The reset the message named, else null: the 60-minute hold is grokReading's, never reported as a reset time.
    const until = resetFromMessage(message, at);
    return { at, state: "exhausted", reason: "limit_reached", source: "log", windows: [], until, ...(until !== null ? { until_reported: true as const } : {}) };
  }
  return null;
}


/** Reactive Grok reading: exhausted while a recent failure's window lasts, relogin when the login expired, else unknown. */
export function grokReading(login: Login, identity: Identity, now: number): Reading {
  if (identity.expired) return { at: now, state: "relogin", reason: "login_expired", source: "none", windows: [], until: null };
  const log = join(login.dir, "logs", "unified.jsonl");
  let hit: Reading | null = null;
  try { if (existsSync(log)) hit = parseGrokLog(tailText(log, TAIL_BYTES)); } catch { /* unreadable log: unknown */ }
  if (hit && (hit.until ?? hit.at + GROK_EXHAUSTED_DEFAULT_MS) > now) return hit;
  return { at: now, state: "unknown", reason: "no_usage_api", source: "none", windows: [], until: null };
}
