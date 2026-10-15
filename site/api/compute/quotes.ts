import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// GET /api/compute/quotes → the tiers on sale with PRICES only (no auth, no provider call). A tier whose quota group
// holds no machine (GPU while its quota is 0) is left out whenever the private config is present, even with
// COMPUTE_ENABLED unset; with none on sale, `available` is false. Without a config: the whole catalogue, unavailable.
import { defaultHandlerDeps, type HandlerDeps } from "../_lib/compute/handler.js";
import { TICK_STALE_MS } from "../_lib/compute/safety.js";
import { json } from "../_lib/http.js";
import { quotes, tierOffered } from "../_lib/compute/catalog.js";
import { ConfigError, parsePrivateConfig, type PrivateConfig } from "../_lib/compute/private-config.js";
import { optionalEnv, type Env } from '../_lib/env.js';

export function makeQuotes(deps: HandlerDeps = defaultHandlerDeps()): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async () => {
    const d = optionalEnv(deps.env, 'COMPUTE_ENABLED') === '1' ? await deps.compute() : null;
    const last = d ? await d.store.tx(t => t.control('last_tick')) : null;
    if (d && (typeof last !== 'number' || d.now() - last > TICK_STALE_MS)) d.log('alert_tick_stale', { last_tick_at: typeof last === 'number' ? last : null });
    const config = d?.config ?? configFrom(deps.env);
    const q = config ? quotes((id) => tierOffered(config, id)) : quotes();
    return json({ ...q, available: !!d && d.enabled !== false && q.tiers.length > 0 && typeof last === 'number' && d.now() - last <= TICK_STALE_MS });
  };
}

/** The private config when compute is not switched on but configured (rollback, or before switch-on); null otherwise. */
function configFrom(env: Env): PrivateConfig | null {
  try { return parsePrivateConfig(optionalEnv(env, 'COMPUTE_PRIVATE_CONFIG')); }
  catch (err) { if (err instanceof ConfigError) return null; throw err; }
}

export async function GET(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeQuotes()(req);
}
