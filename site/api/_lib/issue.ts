// Turning a Stripe subscription into an activation code or a team-bound license (docs/BUSINESS.md
// "Billing"): lic_id = the subscription id, seats = the item quantity, plan from the price, expiry =
// period end + 5 days. The payload carries the billing email and nothing else about the customer (H1).
import { optionalEnv, planForPriceId, type Env } from "./env.js";
import {
  expiryFromPeriodEnd, LicenseError, signLicense, signingKeyFromPem, verifySigned,
  type LicenseInterval, type LicensePayload, type LicensePlan,
} from "./license.js";
import { realStripe, type CustomerLite, type StripeLike, type SubscriptionLite } from "./stripe.js";

export interface Deps {
  readonly env: Env;
  /** Called only after the handler checked its env, so the real client always has a key. */
  readonly stripe: () => StripeLike;
  readonly now: () => number;
}

export function defaultDeps(): Deps {
  const env = process.env as Env;
  let client: StripeLike | null = null;
  return {
    env,
    stripe: () => (client ??= realStripe(optionalEnv(env, "STRIPE_SECRET_KEY") ?? "")),
    now: () => Date.now(),
  };
}

/** The only subscription status that reveals, binds or renews a license (audit L8: not `trialing`). */
export const LICENSED_STATUS = "active";
/** Subscriptions that will never become licensed without a new checkout. */
export const DEAD_STATUSES: ReadonlySet<string> = new Set(["canceled", "unpaid", "incomplete_expired"]);

/** The Stripe prices' lookup keys: walkie_team_month, walkie_team_year, walkie_business_month, walkie_business_year. */
export const LOOKUP_KEY = /^walkie_(team|business)_(month|year)$/;

function planFrom(s: string | null | undefined): LicensePlan | null {
  const t = (s ?? "").trim().toLowerCase();
  return t === "team" || t === "business" ? t : null;
}

function intervalFrom(s: string | null | undefined): LicenseInterval | null {
  return s === "month" || s === "year" ? s : null;
}

/**
 * Plan and interval, in order: the price's lookup_key (walkie_<plan>_<interval>); the price's
 * metadata.plan and recurring.interval; the configured STRIPE_PRICE_* ids; last, the walkie_plan /
 * walkie_interval metadata checkout puts on the subscription.
 */
export function planOf(sub: SubscriptionLite, env: Env): { plan: LicensePlan; interval: LicenseInterval } {
  const item = sub.items.data[0];
  if (!item) throw new LicenseError("no_items", "subscription has no items");
  const price = item.price;
  const lk = LOOKUP_KEY.exec(price.lookup_key ?? "");
  const byId = planForPriceId(env, price.id);
  // The subscription's own metadata goes stale after a plan switch in the portal, so it comes last.
  const plan = planFrom(lk?.[1]) ?? planFrom(price.metadata?.plan) ?? byId?.plan ?? planFrom(sub.metadata.walkie_plan) ?? null;
  const interval = intervalFrom(lk?.[2]) ?? intervalFrom(price.recurring?.interval)
    ?? byId?.interval ?? intervalFrom(sub.metadata.walkie_interval) ?? null;
  if (!plan) throw new LicenseError("unknown_plan", "cannot tell the plan from the subscription's price");
  if (!interval) throw new LicenseError("unknown_interval", "cannot tell the billing interval from the subscription's price");
  return { plan, interval };
}

function periodEnd(sub: SubscriptionLite): number {
  const end = sub.current_period_end ?? sub.items.data[0]?.current_period_end ?? null;
  if (typeof end !== "number" || !Number.isInteger(end) || end <= 0) throw new LicenseError("no_period", "subscription has no current period end");
  return end;
}

function customerOf(sub: SubscriptionLite): CustomerLite | null {
  return typeof sub.customer === "object" && sub.customer !== null && !sub.customer.deleted ? sub.customer : null;
}

/**
 * The payload a subscription earns now (throws LicenseError when it can't be derived): an activation
 * code when `team` is absent, a license bound to `team` otherwise.
 */
export function payloadFor(sub: SubscriptionLite, env: Env, now: number, team?: string): LicensePayload {
  const { plan, interval } = planOf(sub, env);
  const quantity = sub.items.data[0]?.quantity ?? 1;
  const email = customerOf(sub)?.email?.trim() || "unknown";
  return {
    v: 2, kind: team === undefined ? "activation" : "license", lic_id: sub.id, plan, seats: Math.max(1, Math.floor(quantity)),
    email: email.slice(0, 320), interval, issued_at: now, expires_at: expiryFromPeriodEnd(periodEnd(sub)),
    ...(team !== undefined ? { team } : {}),
  };
}

function signingKey(env: Env) {
  const pem = optionalEnv(env, "WALKIE_LICENSE_SIGNING_KEY");
  if (!pem) throw new LicenseError("billing_not_configured", "no signing key");
  return signingKeyFromPem(pem);
}

export function issueKey(payload: LicensePayload, env: Env): string {
  return signLicense(payload, signingKey(env));
}

/** The payload of an activation code WE signed (signature, format and kind checked), or null. */
export function verifyActivationCode(code: string, env: Env): LicensePayload | null {
  const p = verifySigned(code, signingKey(env));
  return p && p.kind === "activation" ? p : null;
}
