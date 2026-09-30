import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// POST /api/compute/rent (Bearer) {idempotency_key, machines:[{tier,count}], codes[], walkie_version, idle_minutes?}
// → RentResult. Credit must cover the first hour of every machine asked for (402 insufficient_credit otherwise); what
// quota can't hold now is queued, never refused. The join codes go only into the machines' user-data: stored briefly with pending work, never logged. COMPUTE_ENABLED=1 must be set. 30 rent requests per account per hour.
import { fail, json } from "../_lib/http.js";
import { optionalEnv } from "../_lib/env.js";
import { allow, defaultHandlerDeps, withAccount, type HandlerDeps } from "../_lib/compute/handler.js";
import { rent } from "../_lib/compute/service.js";
import { checkRent } from "../_lib/compute/validate.js";

export function makeRent(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return (req) => withAccount(deps, req, async (d, a, body) => {
    const c = checkRent(body);
    if (!c.ok) return fail(400, c.error);
    if (!(await allow(d, `acct:${a.id}:rent`, 30, 3_600_000))) return fail(429, "rate_limited");
    return json(await rent({ ...d, enabled: optionalEnv(deps.env, "COMPUTE_ENABLED") === "1" }, a.id, c.value));
  }, { body: true });
}

export async function POST(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeRent(defaultHandlerDeps())(req);
}
