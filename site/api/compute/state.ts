import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// GET /api/compute/state (Bearer compute token) → balance, burn, hours left and rentals. Prices only.
import { json } from "../_lib/http.js";
import { defaultHandlerDeps, withAccount, type HandlerDeps } from "../_lib/compute/handler.js";
import { state } from "../_lib/compute/service.js";
import { handoverKey, type PendingHandover } from '../_lib/compute/handover.js';
import { optionalEnv } from '../_lib/env.js';
import { signingKeyFromPem } from '../_lib/license.js';
import { sign } from 'node:crypto';

export function makeState(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return (req) => withAccount(deps, req, async (d, a) => {
    const view = await state(d, a.id);
    if (req.headers.get('x-walkie-handover-notice') !== '1') return json(view);
    const pending = await d.store.tx(t => t.control(handoverKey(a.team_id))) as PendingHandover | undefined;
    if (!pending) return json(view);
    const notice = signedHandoverNotice(deps, a.team_id, pending);
    return json(notice ? { ...view, handover_notice: notice } : view);
  }, { body: false });
}

export function signedHandoverNotice(deps: HandlerDeps, team: string, pending: PendingHandover): string | null {
    const key = optionalEnv(deps.env, 'WALKIE_LICENSE_SIGNING_KEY');
    if (!key) return null;
    const payload = Buffer.from(JSON.stringify({ v: 1, team, proposed_by: pending.proposed_key,
      old_chain: pending.old_chain.chainId, proposed_chain: pending.proposed_chain.chainId,
      accounts: pending.accounts, proposed_at: pending.proposed_at, completes_at: pending.completes_at,
      objected: !!pending.objected_by })).toString('base64url');
    const signature = sign(null, Buffer.from(payload), signingKeyFromPem(key)).toString('base64url');
    return `${payload}.${signature}`;
}

export async function GET(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeState(defaultHandlerDeps())(req);
}
