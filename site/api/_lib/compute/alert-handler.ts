import { errorResponse } from './handler.js';
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
    const pending: { event: AlertEvent; fields: Parameters<ComputeDeps['log']>[1] }[] = [];
    let log = stderrLog;
    let compute: ComputeDeps | null | undefined;
    const wrapped: HandlerDeps = { ...deps, compute: async () => {
      if (compute !== undefined) return compute;
      const original = await deps.compute();
      if (!original) {
        compute = null;
        if (mode !== 'tick') pending.push({ event: 'config_invalid', fields: {} });
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
        const store = pending.length && optionalEnv(deps.env, 'COMPUTE_ENABLED') === '1'
          ? d?.store ?? await deps.alertStore?.() ?? null : null;
        await Promise.all(pending.map(p => sendAlert({ store, env: deps.env, now: d?.now ?? Date.now,
          log, fetch: deps.alertFetch }, p.event, p.fields)));
      } catch { /* even configuration/store setup failures must not change the response */ }
    }
  };
}
