// GET /v1/history (WALK-70 phase 0): a local read of audits already on this machine. Nothing is written, replicated,
// or served to another machine. Older peers never see this route.
import { existsSync, statSync } from "node:fs";
import { ADMIN_AUDIT_MAX, auditPath, readAudit } from "./admin/audit.ts";
import { agentCaller } from "./admin/gate.ts";
import { HttpError, json } from "./http.ts";
import { route, type RouteCtx } from "./local-routes.ts";
import { guestRegistryFor } from "../mcp/guest-routes.ts";
import { HistoryQueryError, mergeHistory, parseHistoryQuery, type GuestOmitReason } from "../history/facade.ts";

const FILTERS = new Set(["since", "tool", "q", "limit"]);
/** The admin tail is 256 KiB. This only stops the scan if that tail holds more lines than a normal audit row would. */
const ADMIN_SCAN = 200_000;

function filters(url: URL): { since?: string; tool?: string; q?: string; limit?: string } {
  const seen = new Map<string, number>();
  for (const [key] of url.searchParams) seen.set(key, (seen.get(key) ?? 0) + 1);
  for (const [key, count] of seen) {
    if (!FILTERS.has(key)) throw new HttpError(400, "invalid", "unknown history filter");
    if (count > 1) throw new HttpError(400, "invalid", "repeated history filter");
  }
  const raw: { since?: string; tool?: string; q?: string; limit?: string } = {};
  for (const key of FILTERS) {
    const value = url.searchParams.get(key);
    if (value !== null) raw[key as keyof typeof raw] = value;
  }
  return raw;
}

function loadAdmin(home: string, limit: number): unknown[] {
  const path = auditPath(home);
  try {
    if (!existsSync(path)) return [];
    if (!statSync(path).isFile()) throw new Error("not a file");
    return readAudit(home, limit);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, "admin_audit_unreadable", "the admin audit on this machine could not be read");
  }
}

/**
 * An agent is the parsed caller, or any agent header that reached this route. `X-Walkie-Under-Agent` counts
 * for every value, including "0" and "true". The listener rejects an empty or invalid `X-Walkie-Agent` with
 * 400 (`validAgentHeader`) before dispatch, so only a valid name arrives; a header that does arrive still
 * counts. The parsed `underAgent` flag is set only when that value is exactly "1" (local-api.ts). Same
 * presence rule as the accounts routes' person-only check.
 */
function agentMarked(c: RouteCtx): boolean {
  return agentCaller(c) || c.req.headers.has("x-walkie-agent") || c.req.headers.has("x-walkie-under-agent");
}

/**
 * Guest audit stays as person-only as GET /v1/guests/audit (a person on this machine, in a team, not a phone).
 * The admin audit stays as open as GET /v1/admin, including an agent while agent admin is off, except an agent
 * sees at most the newest 200 lines. The guest registry is not read for a caller who cannot see it.
 */
function guestOmit(c: RouteCtx, agent: boolean): GuestOmitReason | null {
  if (agent) return "person_only";
  if (!c.core.teamId || !c.core.me()) return "no_team";
  if (!guestRegistryFor(c.core)) return "unavailable";
  return null;
}

function loadGuest(c: RouteCtx): unknown[] {
  const registry = guestRegistryFor(c.core);
  if (!registry) throw new HttpError(503, "guest_audit_unreadable", "the guest audit on this machine could not be read");
  try {
    return registry.audit();
  } catch {
    throw new HttpError(503, "guest_audit_unreadable", "the guest audit on this machine could not be read");
  }
}

route("GET", "/v1/history", (c) => {
  if (c.via === "phone") throw new HttpError(403, "forbidden", "history is read on this machine, not from a phone");
  let query;
  try { query = parseHistoryQuery(filters(c.url)); }
  catch (err) {
    if (err instanceof HistoryQueryError) throw new HttpError(400, "invalid", err.message);
    throw err;
  }
  // One classification: the cap and the guest omission cannot disagree.
  // A person reads every line in the tail. An agent gets the same newest-200 window as GET /v1/admin.
  const agent = agentMarked(c);
  const admin = loadAdmin(c.core.paths.home, agent ? ADMIN_AUDIT_MAX : ADMIN_SCAN);
  const omit = guestOmit(c, agent);
  const guest = omit ? null : loadGuest(c);
  return json(mergeHistory({ admin, guest, ...(omit ? { omitGuest: omit } : {}), query }));
});
