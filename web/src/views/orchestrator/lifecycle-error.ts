// Pure: what the dashboard shows when starting or stopping the orchestrator is refused.
import { ApiError, friendlyError } from "../../api/client.ts";

/** Codes whose generic text is better than the daemon's (the session, the connection, a malformed answer). */
const GENERIC = new Set(["unauthorized", "rate_limited", "network", "timeout", "bad_response"]);

/**
 * The daemon's own words for a refused start or stop (claude_not_found, no_team, an observer, a missing directory,
 * the daemon shutting down), capitalised; the friendly text for everything else.
 */
export function lifecycleError(err: unknown): string {
  if (err instanceof ApiError && !GENERIC.has(err.code) && err.status >= 400 && err.message.trim()) {
    const m = err.message.trim();
    return m.charAt(0).toUpperCase() + m.slice(1);
  }
  return friendlyError(err);
}
