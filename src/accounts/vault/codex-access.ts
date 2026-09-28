// An access-only copy of a Codex (ChatGPT plan) login: what a seat or a borrowing machine may run on without ever
// holding the login's refresh token (COMPANY POOL / SEATS-FIX-8). The machine that holds the login stays its only
// refresher: its refresh token rotates on use, so a second holder refreshing would sign the other copies out.
//
// codex-cli 0.156.1 refuses an auth.json without a `refresh_token` field ("missing field `refresh_token`") and accepts
// an empty one (verified offline with fake tokens), so the copy carries `"refresh_token": ""` — never the real one.

/** A copy whose access token runs out sooner than this is not handed out (the session could not refresh it). */
export const CODEX_ACCESS_MIN_LEFT_MS = 10 * 60_000;

export interface CodexAccess {
  /** The auth.json text to write for the borrower (access + id token, empty refresh token, no API key). */
  json: string;
  /** When the access token runs out (its JWT `exp`), when readable. */
  expiresAt: number | null;
}

/** The `exp` of a JWT (seconds → ms), without verifying anything; null when it cannot be read. */
export function jwtExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part || part.length > 8192) return null;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0 ? Math.round(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * The access-only copy of a Codex auth.json, or null when it has no access token, is an API-key login, or its access
 * token runs out within CODEX_ACCESS_MIN_LEFT_MS (`now` given). Only known fields are carried, as strings.
 */
export function codexAccessOnly(text: string, now?: number): CodexAccess | null {
  let o: { auth_mode?: unknown; tokens?: Record<string, unknown>; last_refresh?: unknown };
  try { o = JSON.parse(text) as typeof o; } catch { return null; }
  const t = o?.tokens;
  if (!t || typeof t !== "object" || typeof t.access_token !== "string" || !t.access_token) return null;
  const expiresAt = jwtExpiry(t.access_token);
  if (now !== undefined && expiresAt !== null && expiresAt < now + CODEX_ACCESS_MIN_LEFT_MS) return null;
  const json = JSON.stringify({
    ...(typeof o.auth_mode === "string" ? { auth_mode: o.auth_mode } : {}),
    OPENAI_API_KEY: null,
    tokens: {
      access_token: t.access_token,
      ...(typeof t.id_token === "string" ? { id_token: t.id_token } : {}),
      refresh_token: "",
      ...(typeof t.account_id === "string" ? { account_id: t.account_id } : {}),
    },
    ...(typeof o.last_refresh === "string" ? { last_refresh: o.last_refresh } : {}),
  });
  return { json, expiresAt };
}
