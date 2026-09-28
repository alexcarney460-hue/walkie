// GET /api/portal → 303 to STRIPE_PORTAL_LOGIN_URL: Stripe's hosted customer-portal login, which
// verifies the customer's email before showing anything (docs/BUSINESS.md "Billing" step 4). This
// function NEVER creates a portal session itself, whatever it is given (audit H2): neither a checkout
// session id nor a customer id is proof of who is asking. Unset or non-https → 503 billing_not_configured (L9).
import { optionalEnv } from "./_lib/env.js";
import { fail, redirect } from "./_lib/http.js";
import { defaultDeps, type Deps } from "./_lib/issue.js";

export function makePortal(deps: Deps): (req: Request) => Promise<Response> {
  return async () => {
    const login = optionalEnv(deps.env, "STRIPE_PORTAL_LOGIN_URL");
    if (!login || !/^https:\/\//.test(login)) return fail(503, "billing_not_configured");
    return redirect(login);
  };
}

export async function GET(req: Request): Promise<Response> {
  return makePortal(defaultDeps())(req);
}
