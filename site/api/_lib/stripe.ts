// The narrow slice of Stripe the billing functions use. Handlers depend on StripeLike, so tests pass
// a mock; production wraps the official client, built from STRIPE_SECRET_KEY.
import Stripe from "stripe";
import { isHttpStatus } from "./http.js";
import type { LicenseInterval, LicensePlan } from "./license.js";

export interface PriceLite {
  id: string;
  lookup_key?: string | null;
  metadata?: Record<string, string> | null;
  recurring?: { interval: string } | null;
}
export interface ItemLite { quantity?: number | null; current_period_end?: number | null; price: PriceLite }
export interface CustomerLite {
  id: string; email?: string | null; name?: string | null; metadata?: Record<string, string> | null; deleted?: boolean;
}
export interface SubscriptionLite {
  id: string;
  status: string;
  customer: string | CustomerLite;
  metadata: Record<string, string>;
  /** Unix seconds: when the subscription was created, i.e. when its checkout completed. */
  created?: number | null;
  /** Older API versions keep the period on the subscription, newer ones on each item. */
  current_period_end?: number | null;
  items: { data: ItemLite[] };
}
export interface CheckoutSessionLite {
  id: string;
  mode?: string | null;
  status?: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
}
export interface CheckoutCreate {
  price: string; quantity: number; successUrl: string; cancelUrl: string; plan: LicensePlan; interval: LicenseInterval;
}
export interface WebhookEventLite {
  id: string; type: string;
  /** Unix seconds when Stripe created the event. */
  created?: number;
  /** `previous_attributes` names the fields an `*.updated` event changed (their old values). */
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
}

/** Subscriptions that bill, or will bill again once payment is fixed: a second checkout for one is a mistake (FINAL Codex 1). */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due", "paused"]);

export interface StripeLike {
  createCheckoutSession(p: CheckoutCreate): Promise<{ url: string | null }>;
  /** null when Stripe has no such session. */
  getCheckoutSession(id: string): Promise<CheckoutSessionLite | null>;
  /** With the customer expanded; null when Stripe has no such subscription. */
  getSubscription(id: string): Promise<SubscriptionLite | null>;
  setSubscriptionMetadata(id: string, metadata: Record<string, string>): Promise<void>;
}

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (isHttpStatus(err, 404)) return null;
    throw err;
  }
}

/** The production client. Constructing it makes no network call. */
export function realStripe(secretKey: string): StripeLike {
  const s = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 8_000 });
  return {
    async createCheckoutSession(p) {
      const session = await s.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: p.price, quantity: p.quantity }],
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        allow_promotion_codes: true,
        metadata: { walkie_plan: p.plan, walkie_interval: p.interval },
        subscription_data: { metadata: { walkie_plan: p.plan, walkie_interval: p.interval } },
        // The Stripe account's public name predates Walkie; say plainly what is being bought.
        custom_text: { submit: { message: "You're subscribing to Walkie, the live network for your team's AI agents. Card statements show WALKIE." } },
      });
      return { url: session.url };
    },
    async getCheckoutSession(id) {
      return (await orNull(s.checkout.sessions.retrieve(id))) as unknown as CheckoutSessionLite | null;
    },
    async getSubscription(id) {
      return (await orNull(s.subscriptions.retrieve(id, { expand: ["customer"] }))) as unknown as SubscriptionLite | null;
    },
    async setSubscriptionMetadata(id, metadata) {
      await s.subscriptions.update(id, { metadata });
    },
  };
}

/**
 * Verifies the Stripe-Signature header against the RAW body; throws on any mismatch or stale
 * timestamp. Async because Stripe's non-Node builds (Bun, workers) only verify with SubtleCrypto.
 */
export async function verifyWebhook(rawBody: string, header: string, secret: string): Promise<WebhookEventLite> {
  return (await Stripe.webhooks.constructEventAsync(rawBody, header, secret)) as unknown as WebhookEventLite;
}

export function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}
