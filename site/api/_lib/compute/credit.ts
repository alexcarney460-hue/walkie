// Prepaid credit (docs/plans/RENT-1.md §5.1; Alex: prepaid, per minute, stop at $0). A block of $50 / $200 / $1,000 is
// bought through Stripe Checkout (mode=payment) and credited to the ledger from the webhook, once per checkout session
// whatever the number of deliveries. A dispute or refund on a block freezes the account: the tick stops every machine.
// The Stripe key for compute must be a TEST key (sk_test_…) unless COMPUTE_STRIPE_LIVE=1 is set on purpose.
//
// Freezes do not always name the payment intent: an early fraud warning carries `charge` and only optionally
// `payment_intent`, and a dispute or a refunded charge can carry `payment_intent: null`. Such an event is resolved through
// its charge (one Stripe read) to the purchase. One that cannot be resolved yet is held (compute-freeze-hold:<charge>),
// alerted, and refused (FreezeUnresolved -> 503) so Stripe delivers it again.
// A PAID compute checkout that fails validation is never credited and never dropped silently: it is held
// (compute-credit-hold:<session>) and alerted for the operator, who refunds it in Stripe or credits it by hand.
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
  /** The PaymentIntent a charge belongs to; null only when Stripe says it has none. Throws whenever Stripe cannot answer. */
  paymentIntentOfCharge?(charge: string): Promise<string | null>;
}
export type ChargeLookup = Pick<CreditStripe, "paymentIntentOfCharge">;

export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  /** True only for real payments; test-mode credit never launches a machine on a real provider. */
  readonly livemode?: boolean;
  /** The API version of the webhook endpoint the payload was rendered with. */
  readonly api_version?: string | null;
  readonly data: { readonly object: Record<string, unknown> };
}

/** The compute client's pinned Stripe API version (the installed SDK's; a newer SDK fails the type check until updated here). */
export const COMPUTE_STRIPE_API_VERSION = "2026-08-26.dahlia" as const;
type HttpClient = ReturnType<typeof Stripe.createFetchHttpClient>;
/** One charge read inside a 10 s webhook: no SDK retry, because Stripe redelivers a refused event. */
const LOOKUP_OPTIONS = { timeout: 4_000, maxNetworkRetries: 0 } as const;

/** True for a key compute may use: a test key, or any key when live compute billing was switched on explicitly. */
export function computeKeyAllowed(key: string, liveSwitch: string | undefined): boolean {
  return key.startsWith("sk_test_") || key.startsWith("rk_test_") || liveSwitch === "1";
}

export function computeStripeConfig(httpClient?: HttpClient): NonNullable<ConstructorParameters<typeof Stripe>[1]> {
  return { apiVersion: COMPUTE_STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 8_000, ...(httpClient ? { httpClient } : {}) };
}

/** The Checkout Session a credit block is sold with (what the customer sees on the page and the receipt). */
export function creditSessionParams(p: CreditCheckoutReq): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    // The credit terms (Alex 2026-10-09) are on the page before payment: the line item and the text by the pay button.
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: p.block * 100, product_data: { name: `Sqwakie compute credit ($${p.block})`,
      description: "Prepaid credit for rented machines, used per minute. Non-refundable. Expires 60 days after purchase." } } }],
    // Always charged in USD, so the webhook's currency and amount checks hold whatever the account's dashboard default.
    adaptive_pricing: { enabled: false },
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    client_reference_id: p.accountId,
    ...(p.expiresAt ? { expires_at: Math.floor(p.expiresAt / 1000) } : {}),
    metadata: { walkie_compute_account: p.accountId, walkie_credit_usd: String(p.block),
      ...(p.attemptId ? { walkie_checkout_attempt: p.attemptId } : {}) },
    payment_intent_data: { metadata: { walkie_compute_account: p.accountId, walkie_credit_usd: String(p.block),
      ...(p.attemptId ? { walkie_checkout_attempt: p.attemptId } : {}) } },
    custom_text: { submit: { message: "Prepaid credit for Sqwakie rented machines, used per minute. Non-refundable: unused credit "
      + "expires 60 days after purchase, and the credit that expires soonest is used first. Card statements show WALKIE." } },
  };
}

export function realCreditStripe(secretKey: string, httpClient?: HttpClient): CreditStripe {
  const s = new Stripe(secretKey, computeStripeConfig(httpClient));
  return {
    async createCreditCheckout(p) {
      const session = await s.checkout.sessions.create(creditSessionParams(p));
      return { url: session.url };
    },
    async paymentIntentOfCharge(charge) {
      return idOf((await s.charges.retrieve(charge, {}, LOOKUP_OPTIONS)).payment_intent);
    },
  };
}

export async function verifyComputeWebhook(raw: string, header: string, secret: string): Promise<StripeEvent> {
  return (await Stripe.webhooks.constructEventAsync(raw, header, secret)) as unknown as StripeEvent;
}

const CREDIT_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);
const FREEZE_EVENTS = new Set(["charge.dispute.created", "charge.refunded", "radar.early_fraud_warning.created"]);
const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{1,250}$/;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (typeof v === "object" && v !== null ? str((v as { id?: unknown }).id) : null);
const clip = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 200) : null);

export type CreditOutcome = "credited" | "duplicate" | "frozen" | "ignored" | "unmatched";
export type CreditIgnoreReason = "metadata" | "mode" | "unpaid" | "currency" | "amount" | "session_id" | "no_payment_intent" | "unknown_account";

/** A freeze event that names a charge Stripe could not resolve yet: held, alerted, and refused so Stripe redelivers it. */
export class FreezeUnresolved extends Error {
  constructor() { super("freeze_unresolved"); }
}

/** Applies one verified Stripe event to the compute ledger. `charges` resolves a charge-only freeze to its payment intent. */
export async function applyCreditEvent(d: ComputeDeps, ev: StripeEvent, charges?: ChargeLookup | null): Promise<CreditOutcome> {
  if (CREDIT_EVENTS.has(ev.type)) {
    const result = await credit(d, ev);
    if (typeof result === "string") return result;
    if (paidCompute(ev.data.object)) await holdCredit(d, ev, result.ignored);
    return "ignored";
  }
  if (FREEZE_EVENTS.has(ev.type)) return freeze(d, ev, charges);
  return "ignored";
}

async function credit(d: ComputeDeps, ev: StripeEvent): Promise<"credited" | "duplicate" | "frozen" | { ignored: CreditIgnoreReason }> {
  const o = ev.data.object;
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const account = str(meta.walkie_compute_account);
  const block = Number(str(meta.walkie_credit_usd));
  if (!account || !ACCOUNT_ID.test(account) || !(CREDIT_BLOCKS_USD as readonly number[]).includes(block)) return { ignored: "metadata" };
  if (o.mode !== "payment") return { ignored: "mode" };
  if (o.payment_status !== "paid") return { ignored: "unpaid" };
  if (o.currency !== "usd") return { ignored: "currency" };
  if (o.amount_total !== block * 100) return { ignored: "amount" };
  const session = str(o.id);
  if (!session) return { ignored: "session_id" };
  const pi = idOf(o.payment_intent);
  if (!pi) return { ignored: "no_payment_intent" };
  const accountBeforeLock = await d.store.tx(t => t.lockAccount(account));
  if (!accountBeforeLock) return { ignored: "unknown_account" };
  const result = await d.store.tx(async (t) => {
    await t.lockControl(`enrollment-chain:${accountBeforeLock.team_id}`);
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
      ref: pi, live: ev.livemode === true, created_at: d.now(),
    });
    if (inserted) await noteFirstFunded(t, target.team_id, d.now());
    if (attempt) await closeCheckout(t, account, attempt.id);
    if (changed) await t.setAccount(account, { status: 'frozen' });
    return { inserted, changed };
  });
  if (result === null) return { ignored: "unknown_account" };
  if (result.changed) {
    d.log('alert_account_frozen', { account });
    return 'frozen';
  }
  d.log(result.inserted ? "credit_purchased" : "credit_duplicate", { account, block });
  return result.inserted ? "credited" : "duplicate";
}


const metaOf = (o: Record<string, unknown>): Record<string, unknown> =>
  (typeof o.metadata === "object" && o.metadata !== null ? o.metadata as Record<string, unknown> : {});
const accountRef = (v: unknown): string | null => { const s = str(v); return s && ACCOUNT_ID.test(s) ? s : null; };
const creditHoldKey = (session: string): string => `compute-credit-hold:${session}`;
/** Payment intent -> held session, so a later refund of a held checkout marks it handled. */
const heldByPaymentKey = (pi: string): string => `compute-credit-held-pi:${pi}`;

/**
 * Paid, and identifiably ours: compute metadata, or a compute account id in client_reference_id (only the compute
 * checkout sets it). A license checkout or another product sharing the Stripe account has neither.
 */
function paidCompute(o: Record<string, unknown>): boolean {
  if (o.payment_status !== "paid") return false;
  const meta = metaOf(o);
  return "walkie_compute_account" in meta || "walkie_credit_usd" in meta || accountRef(o.client_reference_id) !== null;
}

/** state: "held" until handled; a refund of its payment marks it "refunded" (freeze path). Redelivery keeps the state. */
async function holdCredit(d: ComputeDeps, ev: StripeEvent, reason: CreditIgnoreReason): Promise<void> {
  const o = ev.data.object;
  const meta = metaOf(o);
  const session = clip(o.id) ?? ev.id;
  const account = accountRef(meta.walkie_compute_account) ?? accountRef(o.client_reference_id);
  const pi = clip(idOf(o.payment_intent));
  const key = creditHoldKey(session);
  await d.store.tx(async (t) => {
    await t.lockControl(key);
    const prior = await t.control(key) as { first_at?: number; deliveries?: number; state?: string } | null | undefined;
    await t.setControl(key, {
      session, state: prior?.state ?? "held", event_id: ev.id, event: ev.type, reason, account,
      client_reference_id: clip(o.client_reference_id), block: clip(meta.walkie_credit_usd),
      currency: clip(o.currency), amount_total: typeof o.amount_total === "number" ? o.amount_total : null,
      payment_intent: pi, livemode: ev.livemode === true, api_version: clip(ev.api_version),
      first_at: prior?.first_at ?? d.now(), updated_at: d.now(), deliveries: (prior?.deliveries ?? 0) + 1,
    });
    if (pi) await t.setControl(heldByPaymentKey(pi), session);
  });
  d.log("alert_credit_ignored", { account, session, reason });
}

/** The charge a freeze event is about: a refunded Charge is the charge itself; a Dispute or EarlyFraudWarning names it. */
function chargeOf(ev: StripeEvent): string | null {
  const o = ev.data.object;
  const id = ev.type === "charge.refunded" ? str(o.id) : idOf(o.charge);
  return id && CHARGE_ID.test(id) ? id : null;
}

/**
 * A Charge or Dispute that says `payment_intent: null` is Stripe's own answer (no PaymentIntent, so not a compute
 * purchase). Only an omitted field, and the EarlyFraudWarning's optional one, needs a Stripe read.
 */
const statesNoPaymentIntent = (ev: StripeEvent): boolean =>
  ev.type !== "radar.early_fraud_warning.created" && "payment_intent" in ev.data.object && ev.data.object.payment_intent === null;

type FreezeHoldReason = "lookup_failed" | "no_payment_intent" | "no_reference";
interface FreezeHold { readonly state?: string; readonly payment_intent?: string; readonly first_at?: number; readonly attempts?: number }
const freezeHoldKey = (subject: string): string => `compute-freeze-hold:${subject}`;

async function freeze(d: ComputeDeps, ev: StripeEvent, charges: ChargeLookup | null | undefined): Promise<CreditOutcome> {
  const charge = chargeOf(ev);
  let pi = idOf(ev.data.object.payment_intent);
  if (!pi && !charge) {
    await holdFreeze(d, ev, null, "pending", "no_reference");
    throw new FreezeUnresolved();
  }
  if (!pi && charge) {
    const known = await d.store.tx(t => t.control(freezeHoldKey(charge))) as FreezeHold | null | undefined;
    pi = known?.state === "resolved" && known.payment_intent ? known.payment_intent : null;
  }
  if (!pi && charge) {
    if (statesNoPaymentIntent(ev)) {
      await holdFreeze(d, ev, charge, "unmatched", "no_payment_intent");
      return "unmatched";
    }
    let found: string | null;
    try {
      if (!charges?.paymentIntentOfCharge) throw new Error("compute_stripe_unavailable");
      found = await charges.paymentIntentOfCharge(charge);
    } catch {
      await holdFreeze(d, ev, charge, "pending", "lookup_failed");
      throw new FreezeUnresolved();
    }
    if (!found) {
      await holdFreeze(d, ev, charge, "unmatched", "no_payment_intent");
      return "unmatched";
    }
    pi = found;
  }
  const result = await applyFreeze(d, ev, pi as string, charge);
  if (result.refundedHold) d.log("credit_hold_refunded", { session: result.refundedHold, event: ev.type });
  else d.log("account_frozen", { account: result.account, event: ev.type });
  return "frozen";
}

/**
 * Records the freeze by payment intent (it also freezes a purchase that arrives later), remembers charge -> payment
 * intent as a resolved hold, marks a held checkout of that payment, and freezes the account that bought it.
 */
async function applyFreeze(d: ComputeDeps, ev: StripeEvent, pi: string, charge: string | null):
    Promise<{ account: string | null; refundedHold: string | null }> {
  return d.store.tx(async (t) => {
    await t.lockControl(`payment:${pi}`);
    await t.setControl(`payment:${pi}`, { frozen: true, event: ev.type });
    if (charge) {
      const key = freezeHoldKey(charge);
      await t.lockControl(key);
      const hold = await t.control(key) as Record<string, unknown> | null | undefined;
      await t.setControl(key, hold
        ? { ...hold, state: "resolved", payment_intent: pi, updated_at: d.now() }
        : { charge, state: "resolved", payment_intent: pi, event: ev.type, event_id: ev.id, livemode: ev.livemode === true,
          first_at: d.now(), updated_at: d.now(), attempts: 0 });
    }
    const account = await t.accountByPurchaseRef(pi);
    if (account && await t.lockAccount(account)) {
      await t.setAccount(account, { status: "frozen" });
      return { account, refundedHold: null };
    }
    const session = str(await t.control(heldByPaymentKey(pi)));
    if (!session) return { account: null, refundedHold: null };
    await t.lockControl(creditHoldKey(session));
    const held = await t.control(creditHoldKey(session)) as Record<string, unknown> | null | undefined;
    if (!held) return { account: null, refundedHold: null };
    const refunded = ev.type === "charge.refunded";
    await t.setControl(creditHoldKey(session), { ...held, ...(refunded ? { state: "refunded" } : {}),
      freeze_event: ev.type, updated_at: d.now() });
    return { account: null, refundedHold: refunded ? session : null };
  });
}

/**
 * Durable record of a freeze not yet applied, keyed by charge (or by event id when the event names neither a payment
 * intent nor a charge): "pending" retries on redelivery, "unmatched" has no payment intent at all. Never downgrades a
 * resolved hold, which keeps its payment intent.
 */
async function holdFreeze(d: ComputeDeps, ev: StripeEvent, charge: string | null, state: "pending" | "unmatched",
    reason: FreezeHoldReason): Promise<void> {
  const eventId = clip(ev.id) ?? "unknown";
  const key = freezeHoldKey(charge ?? eventId);
  await d.store.tx(async (t) => {
    await t.lockControl(key);
    const prior = await t.control(key) as FreezeHold | null | undefined;
    const resolved = prior?.state === "resolved";
    await t.setControl(key, { ...(prior ?? {}), ...(charge ? { charge } : {}),
      state: resolved ? "resolved" : state, ...(resolved ? {} : { reason }),
      event: ev.type, event_id: eventId, livemode: ev.livemode === true,
      first_at: prior?.first_at ?? d.now(), updated_at: d.now(), attempts: (prior?.attempts ?? 0) + 1 });
  });
  d.log("alert_freeze_unresolved", charge ? { event: ev.type, charge, reason } : { event: ev.type, event_id: eventId, reason });
}
