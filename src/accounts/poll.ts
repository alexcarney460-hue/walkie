// One usage poll for one account on the machine that holds its login. Reads the CLI's CURRENT access token
// read-only, never refreshes it (an expiring token is skipped: the CLI refreshes it the next time it runs), and asks
// only the allow-listed usage endpoints (http.ts). Returns the reading and when to poll next.
import type { AccountProvider } from "../protocol/accounts.ts";
import { fetchClaudeUsage, readClaudeToken, type KeychainReader } from "./adapters/claude.ts";
import { fetchCodexUsage, passiveCodexReading, readCodexToken } from "./adapters/codex.ts";
import { grokReading, identifyGrok } from "./adapters/grok.ts";
import { fetchKimiIdentity, fetchKimiUsage, readKimiToken } from "./adapters/kimi.ts";
import { errorName, UsageHttpError, type FetchLike } from "./http.ts";
import { unknownReading, type AccessToken, type Identity, type Login, type Reading } from "./types.ts";

export const POLL_MS = 5 * 60_000;
export const FAST_POLL_MS = 60_000;
/** A window at least this used polls every FAST_POLL_MS. */
export const FAST_POLL_USED_PCT = 80;
export const MAX_BACKOFF_MS = 30 * 60_000;
/** A token expiring sooner than this is left alone (the CLI is about to refresh it). */
export const TOKEN_MARGIN_MS = 2 * 60_000;
export const RELOGIN_RETRY_MS = 15 * 60_000;
export const KEYCHAIN_BLOCK_MS = 6 * 60 * 60_000;

export interface PollDeps {
  fetch: FetchLike;
  keychain: KeychainReader;
  now: number;
  /** Keychain reads are off until then (it did not answer without a prompt). */
  keychainBlockedUntil: number;
  /** How many polls in a row were skipped for an expiring token (Opus LOW 5: after the first, every 5 min). */
  tokenSkips?: number;
  /** ACCOUNTS-2: a vault Claude account's setup-token (read for this one request). */
  vaultToken?: { read: () => Promise<string>; expiresAt: number | null };
}

/** A vault setup-token the usage endpoint will not meter is asked again this rarely. */
export const METERLESS_RETRY_MS = 6 * 60 * 60_000;

export interface PollResult {
  /** null: keep the previous reading (a transient failure); it goes stale on its own. */
  reading: Reading | null;
  nextInMs: number;
  /** Backoff to carry into the next failure (0 after a success). */
  backoffMs: number;
  /** Kimi: the account the token belongs to, from /me (asked on every poll). */
  identity?: Identity;
  keychainBlockedUntil?: number;
  /** A short scrubbed error for the log (never contains the token). */
  error?: string;
  /** This poll was skipped for an expiring token. */
  skipped?: true;
}

export function cadence(r: Reading): number {
  return r.windows.some((w) => w.used_pct >= FAST_POLL_USED_PCT) ? FAST_POLL_MS : POLL_MS;
}

/**
 * A failed poll. 401 (the token was refused) needs a re-login; anything else, 403 included (a scope or policy
 * refusal a new login may not fix), backs off 5 → 10 → 20 → 30 min, or longer when Retry-After says so. The error is
 * a fixed code (http.ts); an unexpected exception is logged by its class name only.
 */
function failed(err: unknown, prev: Reading | null, backoffMs: number, now: number): PollResult {
  const http = err instanceof UsageHttpError ? err : null;
  const status = http?.status ?? 0;
  const error = http ? http.message : `usage poll failed (${errorName(err)})`;
  if (status === 401) {
    return { reading: { ...unknownReading(now, "login_expired"), state: "relogin" }, nextInMs: RELOGIN_RETRY_MS, backoffMs: 0, error };
  }
  const backoff = Math.min(MAX_BACKOFF_MS, Math.max(POLL_MS, backoffMs * 2 || POLL_MS));
  const next = Math.max(backoff, http?.retryAfterMs ?? 0);
  return { reading: prev ? null : unknownReading(now, status === 429 ? "rate_limited" : "http_error"), nextInMs: next, backoffMs: backoff, error };
}

/** Whether a token may be used now: false when it expires within the margin (never refreshed by us). */
export function tokenUsable(t: AccessToken, now: number): boolean {
  return t.expiresAt === null || t.expiresAt - now > TOKEN_MARGIN_MS;
}

/**
 * An expiring token is skipped (never refreshed). The first skip re-checks in 60 s (the CLI is probably refreshing it
 * right now); after that every 5 min, so an idle login is not read every minute for a week.
 */
function tokenGate(t: AccessToken, prev: Reading | null, now: number, skips: number): PollResult | null {
  if (tokenUsable(t, now)) return null;
  if (t.refreshExpired) return { reading: { ...unknownReading(now, "login_expired"), state: "relogin" }, nextInMs: RELOGIN_RETRY_MS, backoffMs: 0 };
  return {
    reading: prev && prev.state !== "unknown" ? null : unknownReading(now, "token_expiring"),
    nextInMs: skips > 0 ? POLL_MS : FAST_POLL_MS, backoffMs: 0, skipped: true,
  };
}

/**
 * A vault setup-token (ACCOUNTS-2): tried once on the usage endpoint. A setup-token may carry only the inference
 * scope, so a 401 / 403 there means "no meter for this login" (reason no_usage_api, asked again in 6 h), never
 * "needs re-login": a refused token is learned from a session that actually used it (a mark).
 */
async function pollVaultClaude(prev: Reading | null, backoffMs: number, d: PollDeps & { vaultToken: NonNullable<PollDeps["vaultToken"]> }): Promise<PollResult> {
  let value: string;
  try { value = await d.vaultToken.read(); } catch (err) {
    return { reading: unknownReading(d.now, "no_token"), nextInMs: POLL_MS, backoffMs: 0, error: `vault read failed (${errorName(err)})` };
  }
  try {
    const r = await fetchClaudeUsage(d.fetch, { value, expiresAt: d.vaultToken.expiresAt }, d.now);
    return { reading: r, nextInMs: cadence(r), backoffMs: 0 };
  } catch (err) {
    const status = err instanceof UsageHttpError ? err.status : 0;
    if (status === 401 || status === 403) return { reading: unknownReading(d.now, "no_usage_api"), nextInMs: METERLESS_RETRY_MS, backoffMs: 0 };
    return failed(err, prev, backoffMs, d.now);
  }
}

async function pollClaude(login: Login, prev: Reading | null, backoffMs: number, d: PollDeps): Promise<PollResult> {
  if (login.vault) return d.vaultToken ? pollVaultClaude(prev, backoffMs, { ...d, vaultToken: d.vaultToken }) : { reading: unknownReading(d.now, "no_token"), nextInMs: POLL_MS, backoffMs: 0 };
  if (login.isDefault && d.keychainBlockedUntil > d.now) {
    return { reading: unknownReading(d.now, "keychain_unavailable"), nextInMs: d.keychainBlockedUntil - d.now, backoffMs: 0 };
  }
  const t = await readClaudeToken(login, d.keychain);
  if (t === "keychain_unavailable") {
    return { reading: unknownReading(d.now, "keychain_unavailable"), nextInMs: KEYCHAIN_BLOCK_MS, backoffMs: 0, keychainBlockedUntil: d.now + KEYCHAIN_BLOCK_MS };
  }
  if (t === "none") return { reading: unknownReading(d.now, "no_token"), nextInMs: POLL_MS, backoffMs: 0 };
  const gate = tokenGate(t, prev, d.now, d.tokenSkips ?? 0);
  if (gate) return gate;
  try {
    const r = await fetchClaudeUsage(d.fetch, t, d.now);
    return { reading: r, nextInMs: cadence(r), backoffMs: 0 };
  } catch (err) {
    return failed(err, prev, backoffMs, d.now);
  }
}

function keepResets(r: Reading | null, prev: Reading | null): Reading | null {
  return r && !r.resets && prev?.resets ? { ...r, resets: prev.resets } : r;
}

async function pollCodex(login: Login, prev: Reading | null, backoffMs: number, d: PollDeps): Promise<PollResult> {
  // A session file says nothing about limit resets: the last API reading's count is carried over (RESET-1).
  // A vault account home shares sessions/ with the user's own CODEX_HOME: its session files are not this login's.
  const passive = login.vault ? null : (() => { try { return keepResets(passiveCodexReading(login, d.now), prev); } catch { return null; } })();
  const t = readCodexToken(login);
  if (t === "none") return passive ? { reading: passive, nextInMs: cadence(passive), backoffMs: 0 } : { reading: unknownReading(d.now, "no_token"), nextInMs: POLL_MS, backoffMs: 0 };
  if (t.apiKey) return { reading: unknownReading(d.now, "api_key_login"), nextInMs: 60 * 60_000, backoffMs: 0 };
  const gate = tokenGate(t, prev, d.now, d.tokenSkips ?? 0);
  if (gate) return passive && gate.reading?.state !== "relogin" ? { ...gate, reading: passive } : gate;
  try {
    const r = await fetchCodexUsage(d.fetch, t, d.now);
    return { reading: r, nextInMs: cadence(r), backoffMs: 0 };
  } catch (err) {
    const f = failed(err, prev, backoffMs, d.now);
    // A session file's reading is better than none (or than a stale API reading) while the endpoint fails.
    return passive && f.reading?.state !== "relogin" && (!prev || passive.at > prev.at) ? { ...f, reading: passive } : f;
  }
}

/**
 * Kimi has no identity file: /me is asked on EVERY poll with the same token as /usages, so the reading is always
 * attributed to the account that token belongs to (a login change moves it; Codex MED 5). No answer, no reading.
 */
async function pollKimi(login: Login, prev: Reading | null, backoffMs: number, d: PollDeps): Promise<PollResult> {
  const t = readKimiToken(login);
  if (t === "none") return { reading: unknownReading(d.now, "no_token"), nextInMs: POLL_MS, backoffMs: 0 };
  const gate = tokenGate(t, prev, d.now, d.tokenSkips ?? 0);
  if (gate) return gate;
  try {
    const real = await fetchKimiIdentity(d.fetch, t);
    if (!real) throw new UsageHttpError(0, "usage identity unreadable");
    const r = await fetchKimiUsage(d.fetch, t, d.now);
    return { reading: r, nextInMs: cadence(r), backoffMs: 0, identity: real };
  } catch (err) {
    return failed(err, prev, backoffMs, d.now);
  }
}

/** One poll of one account. Never throws. */
export async function pollAccount(provider: AccountProvider, login: Login, identity: Identity, prev: Reading | null, backoffMs: number, d: PollDeps): Promise<PollResult> {
  try {
    if (provider === "claude") return await pollClaude(login, prev, backoffMs, d);
    if (provider === "codex") return await pollCodex(login, prev, backoffMs, d);
    if (provider === "kimi") return await pollKimi(login, prev, backoffMs, d);
    const fresh = identifyGrok(login, d.now) ?? identity;
    return { reading: grokReading(login, fresh, d.now), nextInMs: FAST_POLL_MS, backoffMs: 0 }; // a local log read, no request
  } catch (err) {
    return failed(err, prev, backoffMs, d.now);
  }
}
