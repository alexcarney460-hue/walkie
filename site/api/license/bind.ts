// POST /api/license/bind {code, team_id} → {key, renewal_token?} (docs/BUSINESS.md "Billing", audit H3).
// The roster authority calls this from `walkie license activate <code>`. The code must be an
// activation code we signed; its subscription must be active and either unbound or already bound to
// this team (idempotent). The FIRST bind stores the team id and the sha256 of a fresh 32-byte renewal
// token in the subscription's metadata and returns the token, once; later binds of the same team get a
// fresh key without it. Another team → 409 license_bound_elsewhere.
import { randomBytes } from "node:crypto";
import { requireEnv } from "../_lib/env.js";
import { fail, json, logError } from "../_lib/http.js";
import { defaultDeps, issueKey, LICENSED_STATUS, payloadFor, verifyActivationCode, type Deps } from "../_lib/issue.js";
import { LicenseError, MAX_KEY_CHARS, TEAM_ID } from "../_lib/license.js";
import { RENEW_HASH_META, renewHash, TEAM_META } from "../_lib/metadata.js";
import { readJsonObject } from "../_lib/body.js";

export function makeBind(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const env = requireEnv(deps.env, ["STRIPE_SECRET_KEY", "WALKIE_LICENSE_SIGNING_KEY"]);
    if (!env.ok) return env.response;
    const body = await readJsonObject(req);
    if ("response" in body) return body.response;
    const { code, team_id: team } = body.value;
    if (typeof code !== "string" || code.length > MAX_KEY_CHARS) return fail(400, "invalid_code");
    if (typeof team !== "string" || !TEAM_ID.test(team)) return fail(400, "invalid_team_id");
    const stripe = deps.stripe();
    try {
      const p = verifyActivationCode(code, deps.env);
      if (!p) return fail(400, "invalid_code");
      const sub = await stripe.getSubscription(p.lic_id);
      if (!sub) return fail(404, "not_found");
      if (sub.status !== LICENSED_STATUS) return fail(402, "subscription_inactive");
      const bound = sub.metadata[TEAM_META];
      if (bound && bound !== team) return fail(409, "license_bound_elsewhere");
      const key = issueKey(payloadFor(sub, deps.env, deps.now(), team), deps.env);
      if (bound === team) return json({ key });
      const token = randomBytes(32).toString("base64url");
      const hash = renewHash(token);
      await stripe.setSubscriptionMetadata(sub.id, { [TEAM_META]: team, [RENEW_HASH_META]: hash });
      // Stripe has no compare-and-set: read back, so of two concurrent first binds only the one whose
      // write stuck gets a token (the other is told the code is bound elsewhere).
      const after = await stripe.getSubscription(sub.id);
      if (after?.metadata[TEAM_META] !== team || after.metadata[RENEW_HASH_META] !== hash) return fail(409, "license_bound_elsewhere");
      return json({ key, renewal_token: token });
    } catch (err) {
      if (err instanceof LicenseError) {
        logError("bind", { type: "license", code: err.code });
        return fail(500, "license_unavailable");
      }
      logError("bind", err);
      return fail(502, "stripe_unavailable");
    }
  };
}

export async function POST(req: Request): Promise<Response> {
  return makeBind(defaultDeps())(req);
}
