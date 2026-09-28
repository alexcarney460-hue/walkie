// POST /api/webhook: Stripe events (docs/BUSINESS.md "Billing" step 2). The signature is checked
// against the RAW body. Nothing is issued here any more (LICENSE-FIX-1: the welcome page reveals an
// activation code once, and the authority binds and renews online); on any subscription event the
// webhook only clears license keys that earlier versions stored in the subscription's metadata (they
// carried the customer's email and organization), and on a seat or price change it marks the
// subscription `walkie_refresh_at` so the authority's daily check-in fetches the new grant (FINAL Codex 4).
import { requireEnv } from "./_lib/env.js";
import { fail, json, logError } from "./_lib/http.js";
import { defaultDeps, type Deps } from "./_lib/issue.js";
import { clearLicenseMetadata, REFRESH_META } from "./_lib/metadata.js";
import { idOf, verifyWebhook, type StripeLike, type WebhookEventLite } from "./_lib/stripe.js";

const SUBSCRIPTION_EVENTS = new Set(["checkout.session.completed", "invoice.paid", "customer.subscription.updated", "customer.subscription.deleted"]);
const MAX_BODY_BYTES = 512 * 1024;

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (typeof v === "object" && v !== null ? (v as Obj) : null);

/** The subscription an event is about (invoice: old `subscription` field or the newer `parent`). */
export function subscriptionIdOf(ev: WebhookEventLite): string | null {
  const o = ev.data.object;
  switch (ev.type) {
    case "checkout.session.completed":
      return o.mode === "subscription" ? idOf(o.subscription as string | { id: string } | null) : null;
    case "invoice.paid": {
      const direct = idOf(o.subscription as string | { id: string } | null);
      if (direct) return direct;
      const details = asObj(asObj(o.parent)?.subscription_details);
      return idOf(details?.subscription as string | { id: string } | null);
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return typeof o.id === "string" ? o.id : null;
    default:
      return null;
  }
}

/** Fields of a `customer.subscription.updated` whose change alters the grant (seats or price). */
const GRANT_FIELDS = ["items", "quantity", "plan"];

/** True when an update changed what the license carries; false for metadata-only updates (our own writes: no loop). */
export function changesGrant(ev: WebhookEventLite): boolean {
  if (ev.type !== "customer.subscription.updated") return false;
  const prev = ev.data.previous_attributes;
  return !!prev && GRANT_FIELDS.some((f) => f in prev);
}

/** Clears legacy license chunks and marks a grant change; reports what it did. */
async function touch(stripe: StripeLike, ev: WebhookEventLite, subId: string, now: number): Promise<{ cleared: boolean; refresh: boolean }> {
  const sub = await stripe.getSubscription(subId);
  if (!sub) return { cleared: false, refresh: false };
  const update = clearLicenseMetadata(sub.metadata);
  const cleared = Object.keys(update).length > 0;
  const refresh = changesGrant(ev);
  if (refresh) update[REFRESH_META] = String(typeof ev.created === "number" ? ev.created * 1000 : now);
  if (cleared || refresh) await stripe.setSubscriptionMetadata(subId, update);
  return { cleared, refresh };
}

export function makeWebhook(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const env = requireEnv(deps.env, ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
    if (!env.ok) return env.response;
    const header = req.headers.get("stripe-signature");
    if (!header) return fail(400, "missing_signature");
    const raw = await req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return fail(413, "too_large");
    let ev: WebhookEventLite;
    try {
      ev = await verifyWebhook(raw, header, env.values.STRIPE_WEBHOOK_SECRET);
    } catch {
      return fail(400, "bad_signature");
    }
    const subId = subscriptionIdOf(ev);
    if (!subId || !SUBSCRIPTION_EVENTS.has(ev.type)) return json({ received: true });
    // Best effort: a legacy key in metadata grants nothing (no renewal token), and a missed refresh mark
    // is caught by the daemon's renewal before expiry, so never make Stripe retry.
    try {
      return json({ received: true, ...(await touch(deps.stripe(), ev, subId, deps.now())) });
    } catch (err) {
      logError(`webhook ${ev.type}`, err);
      return json({ received: true, cleared: false, refresh: false });
    }
  };
}

export async function POST(req: Request): Promise<Response> {
  return makeWebhook(defaultDeps())(req);
}
