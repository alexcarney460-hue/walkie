// POST /api/license/status {lic_id, renewal_token, issued_at?} → {seats, plan, interval, expires_at, status, newer}
// (FINAL Codex 4). The roster authority checks in once a day: when `newer` is true (the webhook saw a seat
// or price change after the daemon's current grant was issued) it renews at once instead of waiting for
// the expiry window, so a seat increase bought in the portal is usable the same day. Authorized exactly
// like a renewal: the token's hash must match, and an unknown or unbound subscription answers the same 403.
import { requireEnv } from "../_lib/env.js";
import { fail, json, logError } from "../_lib/http.js";
import { defaultDeps, planOf, type Deps } from "../_lib/issue.js";
import { expiryFromPeriodEnd, LicenseError, TEAM_ID } from "../_lib/license.js";
import { REFRESH_META, RENEW_HASH_META, renewTokenMatches, TEAM_META } from "../_lib/metadata.js";
import { readJsonObject } from "../_lib/body.js";
import { LIC_ID, RENEWAL_TOKEN } from "./renew.js";

export function makeStatus(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const env = requireEnv(deps.env, ["STRIPE_SECRET_KEY"]);
    if (!env.ok) return env.response;
    const body = await readJsonObject(req);
    if ("response" in body) return body.response;
    const { lic_id: licId, renewal_token: token, issued_at: issuedAt } = body.value;
    if (typeof licId !== "string" || !LIC_ID.test(licId)) return fail(400, "invalid_lic_id");
    if (typeof token !== "string" || !RENEWAL_TOKEN.test(token)) return fail(400, "invalid_renewal_token");
    if (issuedAt !== undefined && !(typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) && issuedAt >= 0)) return fail(400, "invalid_issued_at");
    try {
      const sub = await deps.stripe().getSubscription(licId);
      if (!sub || !renewTokenMatches(token, sub.metadata[RENEW_HASH_META])) return fail(403, "invalid_renewal");
      const team = sub.metadata[TEAM_META];
      if (!team || !TEAM_ID.test(team)) return fail(403, "invalid_renewal");
      const { plan, interval } = planOf(sub, deps.env);
      const item = sub.items.data[0];
      const end = sub.current_period_end ?? item?.current_period_end ?? null;
      const refreshAt = Number(sub.metadata[REFRESH_META] ?? "0");
      const newer = Number.isFinite(refreshAt) && refreshAt > 0 && refreshAt > (typeof issuedAt === "number" ? issuedAt : 0);
      return json({
        seats: Math.max(1, Math.floor(item?.quantity ?? 1)), plan, interval,
        expires_at: typeof end === "number" && end > 0 ? expiryFromPeriodEnd(end) : null,
        status: sub.status, newer,
      });
    } catch (err) {
      if (err instanceof LicenseError) {
        logError("status", { type: "license", code: err.code });
        return fail(500, "license_unavailable");
      }
      logError("status", err);
      return fail(502, "stripe_unavailable");
    }
  };
}

export async function POST(req: Request): Promise<Response> {
  return makeStatus(defaultDeps())(req);
}
