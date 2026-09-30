import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// GET /api/compute/tick: the minute control loop (Vercel cron, `Authorization: Bearer $CRON_SECRET`). See
// _lib/compute/tick.ts. Answers counts only.
import { optionalEnv } from "../_lib/env.js";
import { fail, json } from "../_lib/http.js";
import { defaultHandlerDeps, errorResponse, secretMatches, type HandlerDeps } from "../_lib/compute/handler.js";
import { tick, EMPTY_REPORT } from "../_lib/compute/tick.js";

export function makeTick(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner, 'tick');
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
    if (!secretMatches(m?.[1] ?? null, optionalEnv(deps.env, "CRON_SECRET"))) return fail(401, "unauthorized");
    const d = await deps.compute();
    if (!d) return json(EMPTY_REPORT);
    try {
      return json(await tick(d));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function GET(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeTick(defaultHandlerDeps())(req);
}
