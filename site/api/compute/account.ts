import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// POST /api/compute/account {team_id, proof}. A signed key enrolls automatically; a license renewal proof can recover ownership.
// Only the token hash is stored; its bearer value is returned once. Per-IP rate limited.
import { fail, json } from "../_lib/http.js";
import { readJsonObject } from "../_lib/body.js";
import { allow, clientIp, defaultHandlerDeps, errorResponse, notConfigured, type HandlerDeps } from "../_lib/compute/handler.js";
import { createAccount } from "../_lib/compute/service.js";
import { checkTeam } from "../_lib/compute/validate.js";

export function makeAccount(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const d = await deps.compute();
    if (!d) return notConfigured();
    const body = await readJsonObject(req, 64 * 1024);
    if ("response" in body) return body.response;
    const c = checkTeam(body.value);
    if (!c.ok) return fail(400, c.error);
    try {
      if (!(await allow(d, `ip:${clientIp(req)}:account`, 10, 3_600_000))) return fail(429, "rate_limited");
      return json(await createAccount(d, c.value.team_id, body.value.proof,
        req.headers.get('x-walkie-handover-notice') === '1'), 201);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function POST(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeAccount(defaultHandlerDeps())(req);
}
