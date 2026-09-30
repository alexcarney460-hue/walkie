// Prepaid credit (docs/plans/RENT-1.md §5.1; Alex: prepaid, per minute, stop at $0). A block of $50 / $200 / $1,000 is
// bought through Stripe Checkout (mode=payment) and credited to the ledger from the webhook, once per checkout session
// whatever the number of deliveries. A dispute or refund on a block freezes the account: the tick stops every machine.
// The Stripe key for compute must be a TEST key (sk_test_…) unless COMPUTE_STRIPE_LIVE=1 is set on purpose.
import Stripe from "stripe";
import type { ComputeDeps } from "./deps.js";
import { MICROS_PER_USD } from "./money.js";
import { CREDIT_BLOCKS_USD } from "./catalog.js";
import { ACCOUNT_ID } from "./types.js";
import { noteFirstFunded } from './roster-history.js';
import { checkoutAttempt, closeCheckout } from './checkout-state.js';

export interface CreditCheckoutReq { readonly accountId: string; readonly block: number; readonly successUrl: string; readonly cancelUrl: string;
  readonly attemptId?: string; readonly expiresAt?: number }

export interface CreditStripe {
  createCreditCheckout(p: CreditCheckoutReq): Promise<{ url: string | null }>;
}

export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  /** True only for real payments; test-mode credit never launches a machine on a real provider. */
  readonly livemode?: boolean;
  readonly data: { readonly object: Record<string, unknown> };
}

/** True for a key compute may use: a test key, or any key when live compute billing was switched on explicitly. */
export function computeKeyAllowed(key: string, liveSwitch: string | undefined): boolean {
  return key.startsWith("sk_test_") || key.startsWith("rk_test_") || liveSwitch === "1";
}

/** The Checkout Session a credit block is sold with (what the customer sees on the page and the receipt). */
export function creditSessionParams(p: CreditCheckoutReq): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: p.block * 100, product_data: { name: `Walkie compute credit ($${p.block})` } } }],
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    client_reference_id: p.accountId,
    ...(p.expiresAt ? { expires_at: Math.floor(p.expiresAt / 1000) } : {}),
    metadata: { walkie_compute_account: p.accountId, walkie_credit_usd: String(p.block),
      ...(p.attemptId ? { walkie_checkout_attempt: p.attemptId } : {}) },
    payment_intent_data: { metadata: { walkie_compute_account: p.accountId, walkie_credit_usd: String(p.block),
      ...(p.attemptId ? { walkie_checkout_attempt: p.attemptId } : {}) } },
    custom_text: { submit: { message: "Prepaid credit for Walkie rented machines, used per minute. Card statements show WALKIE." } },
  };
}

export function realCreditStripe(secretKey: string): CreditStripe {
  const s = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 8_000 });
  return {
    async createCreditCheckout(p) {
      const session = await s.checkout.sessions.create(creditSessionParams(p));
      return { url: session.url };
    },
  };
}

export async function verifyComputeWebhook(raw: string, header: string, secret: string): Promise<StripeEvent> {
  return (await Stripe.webhooks.constructEventAsync(raw, header, secret)) as unknown as StripeEvent;
}

const CREDIT_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);
const FREEZE_EVENTS = new Set(["charge.dispute.created", "charge.refunded", "radar.early_fraud_warning.created"]);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (typeof v === "object" && v !== null ? str((v as { id?: unknown }).id) : null);

export type CreditOutcome = "credited" | "duplicate" | "frozen" | "ignored";

/** Applies one verified Stripe event to the compute ledger. */
export async function applyCreditEvent(d: ComputeDeps, ev: StripeEvent): Promise<CreditOutcome> {
  const o = ev.data.object;
  if (CREDIT_EVENTS.has(ev.type)) {
    const meta = (o.metadata ?? {}) as Record<string, unknown>;
    const account = str(meta.walkie_compute_account);
    const block = Number(str(meta.walkie_credit_usd));
    if (!account || !ACCOUNT_ID.test(account) || !(CREDIT_BLOCKS_USD as readonly number[]).includes(block)) return "ignored";
    if (o.mode !== "payment" || o.payment_status !== "paid" || o.currency !== "usd" || o.amount_total !== block * 100) return "ignored";
    const session = str(o.id);
    if (!session) return "ignored";
    const accountBeforeLock = await d.store.tx(t => t.lockAccount(account));
    if (!accountBeforeLock) return 'ignored';
    const result = await d.store.tx(async (t) => {
      await t.lockControl(`enrollment-chain:${accountBeforeLock.team_id}`);
      const pi = idOf(o.payment_intent);
      if (!pi) return null;
      await t.lockControl(`payment:${pi}`);
      const target = await t.lockAccount(account);
      if (!target) return null;
      const attemptId = str(meta.walkie_checkout_attempt);
      const attempt = attemptId && /^[0-9a-f]{32}$/.test(attemptId) ? await checkoutAttempt(t, attemptId) : null;
      const chain = await t.control(`enrollment-chain:${target.team_id}`) as { chainId?: string } | undefined;
      const changed = !!attemptId && (!attempt || attempt.account !== account ||
        attempt.owner_key !== (target.owner_key ?? null) || attempt.chain_id !== (chain?.chainId ?? null));
      if (await t.control(`payment:${pi}`)) await t.setAccount(account, { status: 'frozen' });
      const inserted = await t.addLedger({
        account_id: account, kind: "purchase", amount_micros: block * MICROS_PER_USD, idem_key: `stripe:${session}`,
        ref: idOf(o.payment_intent), live: ev.livemode === true, created_at: d.now(),
      });
      if (inserted) await noteFirstFunded(t, target.team_id, d.now());
      if (attempt) await closeCheckout(t, account, attempt.id);
      if (changed) await t.setAccount(account, { status: 'frozen' });
      return { inserted, changed };
    });
    if (result === null) return "ignored";
    if (result.changed) {
      d.log('alert_account_frozen', { account });
      return 'frozen';
    }
    d.log(result.inserted ? "credit_purchased" : "credit_duplicate", { account, block });
    return result.inserted ? "credited" : "duplicate";
  }
  if (FREEZE_EVENTS.has(ev.type)) {
    const pi = idOf(o.payment_intent);
    if (!pi) return "ignored";
    const frozen = await d.store.tx(async (t) => {
      await t.lockControl(`payment:${pi}`);
      await t.setControl(`payment:${pi}`, { frozen: true, event: ev.type });
      const account = await t.accountByPurchaseRef(pi);
      if (!account || !(await t.lockAccount(account))) return null;
      await t.setAccount(account, { status: "frozen" });
      return account;
    });
    d.log("account_frozen", { account: frozen, event: ev.type });
    return "frozen";
  }
  return "ignored";
}
