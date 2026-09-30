import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// POST /api/compute/start (Bearer) {rental_id, code, walkie_version?} → {rental}: the owner's daemon hands a fresh
// one-hour join code to a rental the tick moved from the queue to needs_code. The code is used, never stored.
import { fail, json } from "../_lib/http.js";
import { optionalEnv } from "../_lib/env.js";
import { defaultHandlerDeps, withAccount, type HandlerDeps } from "../_lib/compute/handler.js";
import { start } from "../_lib/compute/service.js";
import { checkStart } from "../_lib/compute/validate.js";
import { RELEASE_TAG } from "../_lib/compute/types.js";

export function makeStart(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return (req) => withAccount(deps, req, async (d, a, body) => {
    if (optionalEnv(deps.env, "COMPUTE_ENABLED") !== "1") return fail(503, "compute_not_configured");
    const { walkie_version: version, ...rest } = body;
    if (version !== undefined && !(typeof version === "string" && RELEASE_TAG.test(version))) return fail(400, "invalid_walkie_version");
    const c = checkStart(rest);
    if (!c.ok) return fail(400, c.error);
    return json({ rental: await start(d, a.id, c.value.rental_id, c.value.code, version as string | undefined) });
  }, { body: true });
}

export async function POST(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeStart(defaultHandlerDeps())(req);
}
