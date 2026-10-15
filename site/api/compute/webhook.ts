import { computeReleaseGate } from "../_lib/compute/release-gate.js";
import { operationalHandler } from "../_lib/compute/alert-handler.js";
// POST /api/compute/webhook: Stripe events for compute credit (its own endpoint and signing secret, so test-mode
// credit never mixes with the live license webhook). Signature checked on the RAW body. Credits once per checkout
// session; a dispute, refund or early fraud warning freezes the account, resolved through its charge when the event
// names no payment intent. A store failure answers 500 and a freeze that cannot be resolved yet 503, so Stripe retries.
import { optionalEnv } from "../_lib/env.js";
import { fail, json, logError } from "../_lib/http.js";
import { applyCreditEvent, FreezeUnresolved, verifyComputeWebhook, type ChargeLookup, type StripeEvent } from "../_lib/compute/credit.js";
import { defaultHandlerDeps, notConfigured, type HandlerDeps } from "../_lib/compute/handler.js";

const MAX_BODY_BYTES = 512 * 1024;

export function makeComputeWebhook(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return operationalHandler(deps, makeInner);
}
function makeInner(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const secret = optionalEnv(deps.env, "COMPUTE_STRIPE_WEBHOOK_SECRET");
    const d = await deps.compute();
    if (!secret || !d) return notConfigured();
    const header = req.headers.get("stripe-signature");
    if (!header) return fail(400, "missing_signature");
    const raw = await req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return fail(413, "too_large");
    let ev: StripeEvent;
    try {
      ev = await verifyComputeWebhook(raw, header, secret);
    } catch {
      return fail(400, "bad_signature");
    }
    // Stripe is read (and its client built) only when a freeze event names a charge but no payment intent.
    const charges: ChargeLookup = { paymentIntentOfCharge: async (charge) => {
      const stripe = deps.stripe();
      if (!stripe?.paymentIntentOfCharge) throw new Error("compute_stripe_unavailable");
      return stripe.paymentIntentOfCharge(charge);
    } };
    try {
      return json({ received: true, outcome: await applyCreditEvent(d, ev, charges) });
    } catch (err) {
      if (err instanceof FreezeUnresolved) return fail(503, "freeze_unresolved");
      logError(`compute webhook ${ev.type}`, err);
      return fail(500, "compute_error");
    }
  };
}

export async function POST(req: Request): Promise<Response> {
  return computeReleaseGate(process.env) ?? makeComputeWebhook(defaultHandlerDeps())(req);
}
