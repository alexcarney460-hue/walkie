import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// POST /api/compute/credit (Bearer) {block: 50|200|1000} → {url}: a Stripe Checkout page (mode=payment) for a prepaid
// credit block. A person pays there; the webhook (/api/compute/webhook) credits the ledger.
import { assertFresh, launchFrozen } from "../_lib/compute/safety.js";
import { fail, json, logError, siteOrigin } from "../_lib/http.js";
import { optionalEnv } from "../_lib/env.js";
import { CREDIT_BLOCKS_USD } from "../_lib/compute/catalog.js";
import { defaultHandlerDeps, withAccount, type HandlerDeps } from "../_lib/compute/handler.js";
import { checkCredit } from "../_lib/compute/validate.js";
import { ComputeError } from '../_lib/compute/service.js';
import { randomBytes } from 'node:crypto';
import { CHECKOUT_MS, closeCheckout, openCheckout } from '../_lib/compute/checkout-state.js';
import { noteFirstFunded } from '../_lib/compute/roster-history.js';

export function makeCredit(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return (req) => withAccount(deps, req, async (d, a, body) => {
    if (optionalEnv(deps.env, "COMPUTE_ENABLED") !== "1") return fail(503, "compute_disabled");
    const c = checkCredit(body, CREDIT_BLOCKS_USD);
    if (!c.ok) return fail(400, c.error);
    const stripe = deps.stripe();
    if (!stripe) return fail(503, "compute_not_configured");
    const origin = siteOrigin(req, optionalEnv(deps.env, "SITE_URL"));
    const attemptId = randomBytes(16).toString('hex');
    const expiresAt = d.now() + CHECKOUT_MS;
    try {
      await d.store.tx(async t => {
        await assertFresh(d, t);
        await t.lockControl(`enrollment-chain:${a.team_id}`);
        const current = await t.lockAccount(a.id);
        if (!current || current.token_hash !== a.token_hash) throw new ComputeError(401, 'invalid_token');
        if (await launchFrozen(t, a.team_id)) throw new ComputeError(403, 'handover_pending');
        const chain = await t.control(`enrollment-chain:${a.team_id}`) as { chainId?: string } | undefined;
        if (!(await openCheckout(t, a.id, { id: attemptId, expires_at: expiresAt,
          owner_key: current.owner_key ?? null, chain_id: chain?.chainId ?? null }, d.now())))
          throw new ComputeError(429, 'too_many_open_checkouts');
        await noteFirstFunded(t, a.team_id, d.now());
      });
      const s = await stripe.createCreditCheckout({
        accountId: a.id, block: c.value.block, successUrl: `${origin}/?compute=credit-added`, cancelUrl: `${origin}/`,
        attemptId, expiresAt,
      });
      if (s.url) return json({ url: s.url });
    } catch (err) {
      if (err instanceof ComputeError) throw err;
      logError("compute credit", err);
    }
    await d.store.tx(t => closeCheckout(t, a.id, attemptId));
    return fail(502, "checkout_unavailable");
  }, { body: true });
}

export async function POST(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeCredit(defaultHandlerDeps())(req);
}
