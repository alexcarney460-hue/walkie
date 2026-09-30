import type { AccessToken } from "../types.ts";

/** Seats cannot refresh the person's login; require time for a useful run. */
export const CLAUDE_ACCESS_MIN_LEFT_MS = 10 * 60_000;

/** A minimal Claude Code credential file for one seat, with no refresh capability. */
export function claudeSeatAccess(token: AccessToken, now: number): string | null {
  if (!token.value || token.value.length > 8192) return null;
  if (!token.scopes?.includes("user:inference")) return null;
  if (token.expiresAt === null || !Number.isFinite(token.expiresAt) || token.expiresAt < now + CLAUDE_ACCESS_MIN_LEFT_MS) return null;
  return JSON.stringify({ claudeAiOauth: {
    accessToken: token.value,
    expiresAt: token.expiresAt,
    ...(token.scopes ? { scopes: token.scopes } : {}),
    ...(token.subscriptionType ? { subscriptionType: token.subscriptionType } : {}),
  } });
}
