import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// GET /api/compute/quotes → the tier catalogue with PRICES only (no auth, no provider call; static data).
import { defaultHandlerDeps, type HandlerDeps } from "../_lib/compute/handler.js";
import { TICK_STALE_MS } from "../_lib/compute/safety.js";
import { json } from "../_lib/http.js";
import { quotes } from "../_lib/compute/catalog.js";
import { optionalEnv } from '../_lib/env.js';

export function makeQuotes(deps: HandlerDeps = defaultHandlerDeps()): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async () => {
    const d = optionalEnv(deps.env, 'COMPUTE_ENABLED') === '1' ? await deps.compute() : null;
    const last = d ? await d.store.tx(t => t.control('last_tick')) : null;
    if (d && (typeof last !== 'number' || d.now() - last > TICK_STALE_MS)) d.log('alert_tick_stale', { last_tick_at: typeof last === 'number' ? last : null });
    return json({ ...quotes(), available: !!d && typeof last === 'number' && d.now() - last <= TICK_STALE_MS });
  };
}

export async function GET(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeQuotes()(req);
}
