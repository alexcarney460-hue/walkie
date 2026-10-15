import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from '../_lib/compute/alert-handler.js';
// POST /api/compute/licence-backfill {restart?} (operator; Authorization: Bearer COMPUTE_HANDOVER_OPERATOR_SECRET, like the
// handover operator actions). The one-time step after the lock-ON site is deployed with its store: records every
// licence subscription bound before then (licence-records.ts), paging through Stripe's list API from a cursor kept
// in the store. Repeat until {complete: true}; until then every first compute enrollment answers 503
// licence_backfill_pending. One call runs at a time: while another holds the lease the answer is 409
// licence_backfill_busy (stop, and wait for that one). Reads Stripe only; idempotent.
import { allow, clientIp, defaultHandlerDeps, errorResponse, notConfigured, secretMatches, type HandlerDeps } from '../_lib/compute/handler.js';
import { readJsonObject } from '../_lib/body.js';
import { fail, json } from '../_lib/http.js';
import { optionalEnv } from '../_lib/env.js';
import { backfillBusy, backfillLicenceBindings } from '../_lib/compute/licence-records.js';

/** Leaves room inside the 10 s function for the store writes after the last page. */
const BUDGET_MS = 5_000;

export function makeLicenceBackfill(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async req => {
    const d = await deps.compute();
    if (!d) return notConfigured();
    const body = await readJsonObject(req, 1024);
    if ('response' in body) return body.response;
    const { restart } = body.value;
    if (restart !== undefined && typeof restart !== 'boolean') return fail(400, 'invalid_backfill_request');
    try {
      const configured = optionalEnv(deps.env, 'COMPUTE_HANDOVER_OPERATOR_SECRET');
      if (!configured || configured.length < 32) {
        d.log('alert_handover_operator_secret_invalid', {});
        return fail(503, 'handover_operator_unavailable');
      }
      // Authenticate before charging the operator's quota (round 11): failed attempts have a bucket of their own, so
      // they cannot use up the operator's calls from a shared address.
      const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null;
      if (!secretMatches(bearer, configured)) {
        if (!(await allow(d, `ip:${clientIp(req)}:licence-backfill-unauthorized`, 60, 3_600_000))) return fail(429, 'rate_limited');
        return fail(401, 'unauthorized');
      }
      // A busy answer costs the operator nothing (lane C round 13): another call holds the lease, so stop and wait for it.
      if (await backfillBusy(d.store, d.now())) return fail(409, 'licence_backfill_busy');
      if (!(await allow(d, `ip:${clientIp(req)}:licence-backfill`, 60, 3_600_000))) return fail(429, 'rate_limited');
      const stripe = deps.licenseStripe?.();
      if (!stripe) return fail(503, 'licence_backfill_unavailable');
      let result;
      try {
        result = await backfillLicenceBindings(d.store, stripe, { now: d.now, budgetMs: BUDGET_MS, restart: restart === true,
          log: (event, fields) => d.log(`alert_${event}`, fields) }); // a team over the binding limit pages the operator
      }
      catch { return fail(503, 'licence_backfill_unavailable'); } // the stored cursor keeps the progress; call again
      // Another call is running (it holds the lease): stop this loop and wait for that one (lane C round 12).
      if (result.busy) return fail(409, 'licence_backfill_busy');
      d.log('licence_backfill', { complete: result.complete, pages: result.pages, scanned: result.scanned });
      return json(result);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function POST(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeLicenceBackfill(defaultHandlerDeps())(req);
}
