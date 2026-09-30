import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from '../_lib/compute/alert-handler.js';
import { allow, clientIp, defaultHandlerDeps, errorResponse, notConfigured, secretMatches, type HandlerDeps } from '../_lib/compute/handler.js';
import { readJsonObject } from '../_lib/body.js';
import { fail, json } from '../_lib/http.js';
import { optionalEnv } from '../_lib/env.js';
import { acknowledgeHandover, clearRejectedHandover, finishHandover, liftExpiredHandover, objectHandover, rejectHandover, resolveFork, statusHandover } from '../_lib/compute/handover.js';
import { signedHandoverNotice } from './state.js';
import type { SubscriptionLite } from '../_lib/stripe.js';
import { ComputeError } from '../_lib/compute/service.js';
import { RENEW_AUTHORITY_META, RENEW_CHAIN_META, RENEW_HASH_META, TEAM_META } from '../_lib/metadata.js';
import { replayBindWrite } from '../_lib/compute/bind-write.js';

export function makeHandover(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async req => {
    const d = await deps.compute();
    if (!d) return notConfigured();
    const body = await readJsonObject(req, 64 * 1024);
    if ('response' in body) return body.response;
    const { team_id, action, proof, chain_id, proposed_key } = body.value;
    if (typeof team_id !== 'string' || !/^[0-9a-f]{16}$/.test(team_id) ||
        !['status', 'object', 'ack', 'complete', 'override_objection', 'reject', 'clear_rejection', 'lift_expired', 'resolve_fork'].includes(String(action))) return fail(400, 'invalid_handover_request');
    try {
      if (!(await allow(d, `ip:${clientIp(req)}:handover:${action}`, 10, 3_600_000))) return fail(429, 'rate_limited');
      if (action === 'complete' || action === 'override_objection' || action === 'reject' || action === 'clear_rejection' || action === 'lift_expired' || action === 'resolve_fork') {
        const configured = optionalEnv(deps.env, 'COMPUTE_HANDOVER_OPERATOR_SECRET');
        if (!configured || configured.length < 32) {
          d.log('alert_handover_operator_secret_invalid', { team: team_id });
          return fail(503, 'handover_operator_unavailable');
        }
        const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null;
        if (!secretMatches(bearer, configured))
          return fail(401, 'unauthorized');
        if (['complete', 'override_objection', 'clear_rejection', 'lift_expired', 'reject'].includes(action) &&
            (typeof chain_id !== 'string' || !/^[0-9a-f]{64}$/.test(chain_id) ||
            typeof proposed_key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(proposed_key)))
          return fail(400, 'invalid_handover_request');
        if (action === 'resolve_fork' && (typeof chain_id !== 'string' || !/^[0-9a-f]{64}$/.test(chain_id)))
          return fail(400, 'invalid_handover_request');
        const completing = action === 'complete' || action === 'override_objection';
        const licenseStripe = completing ? deps.licenseStripe?.() : null;
        if (completing && deps.licenseStripe && !licenseStripe) return fail(503, 'handover_operator_unavailable');
        let subscriptions: SubscriptionLite[] = [];
        if (completing) {
          try { subscriptions = licenseStripe ? await licenseStripe.listSubscriptionsByTeam(team_id) : []; }
          catch { throw new ComputeError(503, 'handover_operator_unavailable'); }
        }
        const done = await d.store.tx(async t => {
          if (completing) await t.lockControl(`enrollment-chain:${team_id}`);
          return completing ? finishHandover(d, t, team_id,
          { chainId: chain_id as string, proposedKey: proposed_key as string, overrideObjection: action === 'override_objection', subscriptions,
            reconcileClaim: async (id, claim) => {
              if (!licenseStripe) throw new ComputeError(503, 'handover_operator_unavailable');
              try {
                const current = await replayBindWrite(licenseStripe, id, claim);
                if (!current || current.metadata[TEAM_META] !== team_id)
                  throw new ComputeError(503, 'handover_operator_unavailable');
                if (current.metadata[RENEW_HASH_META] !== claim.hash) return;
                await licenseStripe.setSubscriptionMetadata(id, { [RENEW_HASH_META]: '',
                  [RENEW_AUTHORITY_META]: '', [RENEW_CHAIN_META]: '' },
                  { idempotencyKey: `${claim.write!.key}-void`, timeout: 3_000, maxNetworkRetries: 0 });
                const after = await licenseStripe.getSubscription(id);
                if (after?.metadata[TEAM_META] !== team_id || after.metadata[RENEW_HASH_META] ||
                    after.metadata[RENEW_AUTHORITY_META] || after.metadata[RENEW_CHAIN_META])
                  throw new ComputeError(503, 'handover_operator_unavailable');
              } catch { throw new ComputeError(503, 'handover_operator_unavailable'); }
            } }) :
          action === 'reject' ? rejectHandover(d, t, team_id, chain_id as string, proposed_key as string) : action === 'resolve_fork' ? resolveFork(d, t, team_id, chain_id as string) :
          action === 'lift_expired' ? liftExpiredHandover(d, t, team_id, chain_id as string, proposed_key as string) :
            clearRejectedHandover(d, t, team_id, chain_id as string, proposed_key as string);
        });
        return done ? json({ [action === 'complete' || action === 'override_objection' ? 'completed' : action === 'reject' ? 'rejected' :
          action === 'resolve_fork' ? 'resolved' : action === 'lift_expired' ? 'lifted' : 'cleared']: true }) :
          fail(409, 'handover_not_ready');
      }
      if (action === 'status') {
        const p = await statusHandover(d, team_id, proof);
        return json({ chain_id: p.proposed_chain.chainId, accounts: p.accounts,
          completes_at: p.completes_at, expires_at: p.expires_at, objected: !!p.objected_by,
          notice: signedHandoverNotice(deps, team_id, p) });
      }
      if (action === 'ack') {
        await acknowledgeHandover(d, team_id, proof);
        return json({ acknowledged: true });
      }
      await objectHandover(d, team_id, proof);
      return json({ objected: true });
    } catch (err) { return errorResponse(err); }
  };
}
export async function POST(req: Request): Promise<Response> { return computeReleaseGate(process.env) ?? makeHandover(defaultHandlerDeps())(req); }
