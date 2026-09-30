// Test fixtures for the billing functions: a throwaway ed25519 keypair, a complete env, subscription
// objects, and an in-memory StripeLike that records every call. Nothing here touches the network or
// ~/keys.
import { generateKeyPairSync } from "node:crypto";
import type { Env } from "../api/_lib/env.ts";
import type { Deps } from "../api/_lib/issue.ts";
import type {
  CheckoutCreate, CheckoutSessionLite, StripeLike, SubscriptionLite,
} from "../api/_lib/stripe.ts";

export const NOW = 1_790_000_000_000;
export const PERIOD_END_S = 1_792_000_000;
export const WEBHOOK_SECRET = ("wh" + "sec_test_secret_for_unit_tests");

export function testKeypair(): { pem: string; publicB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    pem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    publicB64: Buffer.from(jwk.x, "base64url").toString("base64"),
  };
}

export function fullEnv(pem: string, extra: Record<string, string> = {}): Env {
  return {
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    WALKIE_LICENSE_SIGNING_KEY: pem,
    STRIPE_PRICE_TEAM_MONTH: "price_team_m",
    STRIPE_PRICE_TEAM_YEAR: "price_team_y",
    STRIPE_PRICE_BUSINESS_MONTH: "price_biz_m",
    STRIPE_PRICE_BUSINESS_YEAR: "price_biz_y",
    SITE_URL: "https://site.test",
    COMPUTE_HANDOVER_TOKEN_KEY: 'rent-fixture-handover-key-32-bytes',
    ...extra,
  };
}

/** Mirrors the live prices: lookup_key walkie_<plan>_<interval>, metadata.plan, unit "seat". */
export function price(plan: "team" | "business", interval: "month" | "year", id = `price_${plan === "team" ? "team" : "biz"}_${interval[0]}`) {
  return { id, lookup_key: `walkie_${plan}_${interval}`, metadata: { plan }, recurring: { interval } };
}

type SubOver = Partial<SubscriptionLite> & { quantity?: number; price?: ReturnType<typeof price> | SubscriptionLite["items"]["data"][number]["price"] };

export function subscription(over: SubOver = {}): SubscriptionLite {
  const { quantity = 7, price: p = price("team", "month"), ...rest } = over;
  return {
    id: "sub_ABC123",
    status: "active",
    customer: { id: "cus_XYZ", email: "lead@kestrel.test", name: "Kestrel Labs" },
    metadata: {},
    created: Math.floor(NOW / 1000) - 60, // checkout completed a minute ago
    items: { data: [{ quantity, current_period_end: PERIOD_END_S, price: p }] },
    ...rest,
  };
}

export interface Calls {
  checkout: CheckoutCreate[];
  metadata: { id: string; metadata: Record<string, string> }[];
}

export class MockStripe implements StripeLike {
  readonly calls: Calls = { checkout: [], metadata: [] };
  subs = new Map<string, SubscriptionLite>();
  sessions = new Map<string, CheckoutSessionLite>();
  fail: Error | null = null;
  checkoutUrl: string | null = "https://checkout.stripe.test/c/pay/cs_test_1";

  private guard(): void { if (this.fail) throw this.fail; }

  async createCheckoutSession(p: CheckoutCreate): Promise<{ url: string | null }> {
    this.guard();
    this.calls.checkout.push(p);
    return { url: this.checkoutUrl };
  }
  async getCheckoutSession(id: string): Promise<CheckoutSessionLite | null> {
    this.guard();
    return this.sessions.get(id) ?? null;
  }
  async getSubscription(id: string): Promise<SubscriptionLite | null> {
    this.guard();
    const s = this.subs.get(id);
    return s ? structuredClone(s) : null;
  }
  async listSubscriptionsByTeam(team: string): Promise<SubscriptionLite[]> {
    this.guard();
    return [...this.subs.values()].filter(sub => sub.metadata.walkie_team === team).map(sub => structuredClone(sub));
  }
  async setSubscriptionMetadata(id: string, metadata: Record<string, string>,
    _options?: Parameters<StripeLike['setSubscriptionMetadata']>[2]): Promise<void> {
    this.guard();
    this.calls.metadata.push({ id, metadata });
    const s = this.subs.get(id);
    if (!s) throw Object.assign(new Error("No such subscription"), { statusCode: 404 });
    const next: Record<string, string> = { ...s.metadata };
    for (const [k, v] of Object.entries(metadata)) {
      if (v === "") delete next[k];
      else next[k] = v;
    }
    this.subs.set(id, { ...s, metadata: next });
  }
}

export function deps(stripe: MockStripe, env: Env): Deps & { previewCompute: true } {
  // Exercise the future compute path in existing site tests; deployed POST handlers never set this.
  return { env, stripe: () => stripe, now: () => NOW, previewCompute: true };
}

export async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** A Stripe API error the way the SDK shapes it (statusCode + type), for the 404/5xx paths. */
export function stripeError(status: number): Error {
  return Object.assign(new Error("stripe said no"), { statusCode: status, type: "StripeAPIError" });
}
