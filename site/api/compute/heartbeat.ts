import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// POST /api/compute/heartbeat {rental_id, token, busy_seats, pool_jobs, cpu_pct, gpu_pct?, egress_bytes, node_id?}
// → {state}. Sent once a minute by the rented machine (root-only timer) with its per-rental token. Feeds the idle
// stop, the heartbeat-lost stop, the mining heuristic and the egress cap. 5 per rental and address per minute.
import { fail, json } from "../_lib/http.js";
import { readJsonObject } from "../_lib/body.js";
import { allow, bearer, clientIp, defaultHandlerDeps, errorResponse, notConfigured, type HandlerDeps } from "../_lib/compute/handler.js";
import { heartbeat } from "../_lib/compute/service.js";
import { checkHeartbeat } from "../_lib/compute/validate.js";

export function makeHeartbeat(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const d = await deps.compute();
    if (!d) return notConfigured();
    const body = await readJsonObject(req);
    if ("response" in body) return body.response;
    const headerToken = bearer(req);
    const c = checkHeartbeat(headerToken ? { ...body.value, token: headerToken } : body.value);
    if (!c.ok) return fail(400, c.error);
    try {
      // Keyed by rental AND source address, so a stranger guessing a rental id can't use up the machine's own budget.
      if (!(await allow(d, `hb:${c.value.rental_id}:${clientIp(req)}`, 5, 60_000))) return fail(429, "rate_limited");
      return json(await heartbeat(d, c.value));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function POST(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeHeartbeat(defaultHandlerDeps())(req);
}
