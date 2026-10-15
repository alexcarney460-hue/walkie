import { errorResponse, privateConfigInvalid } from './handler.js';
import type { HandlerDeps } from './handler.js';
import type { ComputeDeps } from './deps.js';
import { stderrLog } from './deps.js';
import { alertFromLog, sendAlert, type AlertEvent } from './alerts.js';
import { optionalEnv } from '../env.js';

type Handler = (req: Request) => Promise<Response>;
/** Request-scoped queue: drained even on an error/rollback, and awaited before serverless suspension. */
export function operationalHandler(deps: HandlerDeps, make: (deps: HandlerDeps) => Handler, mode: 'request' | 'tick' | 'stop' = 'request'): Handler {
  return async req => {
    const deadline = Date.now() + 6_000;
    const pending: { event: AlertEvent; fields: Parameters<ComputeDeps['log']>[1]; memory?: true }[] = [];
    let log = stderrLog;
    let compute: ComputeDeps | null | undefined;
    const wrapped: HandlerDeps = { ...deps, compute: async () => {
      if (compute !== undefined) return compute;
      const original = await deps.compute();
      if (!original) {
        compute = null;
        // Set but unparseable: paged in every mode, deduplicated in memory when no store can be opened. Otherwise (no
        // config or no database: fully off) only requests report it, and only through a store.
        if (privateConfigInvalid(deps.env)) pending.push({ event: 'config_invalid', fields: {}, memory: true });
        else if (mode !== 'tick') pending.push({ event: 'config_invalid', fields: {} });
        return null;
      }
      if (original.alertConfigInvalid) pending.push({ event: 'config_invalid', fields: {} });
      log = original.log;
      compute = { ...original, ...(mode !== 'tick' ? { deadline } : {}), log: (event, fields) => {
        const alert = alertFromLog(event, fields);
        if (alert) pending.push({ event: alert, fields });
        try { original.log(event, fields); } catch { /* operational logs cannot interrupt billing */ }
      } };
      return compute;
    } };
    try {
      return await make(wrapped)(req);
    } catch (err) { return errorResponse(err); }
    finally {
      try {
        const d = compute as ComputeDeps | null | undefined;
        // Compute deps carry their store whatever the switch (a drain still pages the operator about money events);
        // a separate alert store is opened only while compute is switched on.
        const store = !pending.length ? null
          : d?.store ?? (optionalEnv(deps.env, 'COMPUTE_ENABLED') === '1' ? await deps.alertStore?.() ?? null : null);
        await Promise.all(pending.map(p => sendAlert({ store, env: deps.env, now: d?.now ?? Date.now,
          log, fetch: deps.alertFetch, ...(p.memory ? { memory: true } : {}) }, p.event, p.fields)));
      } catch { /* even configuration/store setup failures must not change the response */ }
    }
  };
}
