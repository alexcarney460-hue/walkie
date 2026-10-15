import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from '../_lib/compute/alert-handler.js';
import { allow, clientIp, defaultHandlerDeps, errorResponse, notConfigured, secretMatches, type HandlerDeps } from '../_lib/compute/handler.js';
import { readJsonObject } from '../_lib/body.js';
import { fail, json } from '../_lib/http.js';
import { optionalEnv } from '../_lib/env.js';
import { acknowledgeHandover, clearRejectedHandover, finishHandover, liftExpiredHandover, objectHandover, rejectHandover, resolveFork, statusHandover, statusMessage } from '../_lib/compute/handover.js';
import { createPublicKey, verify } from 'node:crypto';
import { signedHandoverNotice } from './state.js';
import type { SubscriptionLite } from '../_lib/stripe.js';
import { ComputeError } from '../_lib/compute/service.js';
import { RENEW_AUTHORITY_META, RENEW_CHAIN_META, RENEW_HASH_META, TEAM_META } from '../_lib/metadata.js';
import { replayBindWrite } from '../_lib/compute/bind-write.js';

/**
 * Handover status limits (REVIEW-pre17-codex P2-5). A daemon checks status at most every 10 minutes while a notice is
 * expected (src/daemon/compute/service.ts HANDOVER_CHECK_MS), so each owner (team + the owner key that signed the
 * request, verified first) gets its own 12 an hour: owners and teams behind one IP no longer share one allowance. The
 * per-IP ceiling is charged before any signature check and bounds unauthenticated floods (and their database writes)
 * while leaving room for many owners behind one NAT. Other handover actions keep 10 per IP per hour.
 */
export const HANDOVER_STATUS_PER_OWNER_HOUR = 12;
export const HANDOVER_STATUS_PER_IP_HOUR = 240;
const HOUR_MS = 3_600_000;

/** The owner key a status request is signed by (the daemon's statusMessage signature, unexpired), or null. */
function signedStatusOwner(team: string, proof: unknown, now: number): string | null {
  const p = proof as { key?: unknown; expires_at?: unknown; signature?: unknown } | null;
  if (!p || typeof p.key !== 'string' || typeof p.signature !== 'string' || !Number.isSafeInteger(p.expires_at)) return null;
  const expires = p.expires_at as number;
  if (expires <= now || expires > now + 300_000) return null;
  try {
    const raw = Buffer.from(p.key, 'base64'), sig = Buffer.from(p.signature, 'base64');
    if (raw.length !== 32 || raw.toString('base64') !== p.key || sig.length !== 64 || sig.toString('base64') !== p.signature) return null;
    const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') } });
    return verify(null, Buffer.from(statusMessage(team, expires)), key, sig) ? p.key : null;
  } catch { return null; }
}

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
      if (action === 'status') {
        if (!(await allow(d, `ip:${clientIp(req)}:handover:status`, HANDOVER_STATUS_PER_IP_HOUR, HOUR_MS))) return fail(429, 'rate_limited');
        const owner = signedStatusOwner(team_id, proof, d.now());
        if (owner && !(await allow(d, `team:${team_id}:owner:${owner}:handover:status`, HANDOVER_STATUS_PER_OWNER_HOUR, HOUR_MS)))
          return fail(429, 'rate_limited');
      } else if (!(await allow(d, `ip:${clientIp(req)}:handover:${action}`, 10, HOUR_MS))) return fail(429, 'rate_limited');
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
