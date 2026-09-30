import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from '../_lib/compute/alert-handler.js';
import { bearer, defaultHandlerDeps, fail, json, notConfigured, type HandlerDeps } from '../_lib/compute/handler.js';
import { readJsonObject } from '../_lib/body.js';
import { RENTAL_ID } from '../_lib/compute/types.js';
import { readLease } from '../_lib/compute/lease.js';

export function makeLease(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, wrapped => async req => {
    const d = await wrapped.compute();
    if (!d) return notConfigured();
    const token = bearer(req);
    if (!token) return fail(403, 'invalid_heartbeat');
    const body = await readJsonObject(req);
    if ('response' in body) return body.response;
    const id = body.value.rental_id;
    if (typeof id !== 'string' || !RENTAL_ID.test(id) || Object.keys(body.value).length !== 1) return fail(400, 'invalid_rental_id');
    return json(await readLease(d, id, token));
  });
}
export async function POST(req: Request): Promise<Response> { return computeReleaseGate(process.env) ?? makeLease(defaultHandlerDeps())(req); }
