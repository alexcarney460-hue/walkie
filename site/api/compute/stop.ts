import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// POST /api/compute/stop (Bearer) {rental_id} | {all: true} → {stopped, rentals}. Stop = terminate + wipe (v1 keeps no
// disks). Works while COMPUTE_ENABLED is off, so a customer can always stop what they pay for.
import { fail, json } from "../_lib/http.js";
import { defaultHandlerDeps, withAccount, type HandlerDeps } from "../_lib/compute/handler.js";
import { stop } from "../_lib/compute/service.js";
import { checkStop } from "../_lib/compute/validate.js";

export function makeStop(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner, 'stop');
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return (req) => withAccount(deps, req, async (d, a, body) => {
    const c = checkStop(body);
    if (!c.ok) return fail(400, c.error);
    return json(await stop(d, a.id, c.value));
  }, { body: true });
}

export async function POST(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeStop(defaultHandlerDeps())(req);
}
