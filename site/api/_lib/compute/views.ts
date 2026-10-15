// Customer-facing views of rentals and accounts: PRICES ONLY. These are the only functions that turn stored rows into
// response bodies; site/test/compute-no-cost.test.ts runs them all through the forbidden-field check.
import { EGRESS_PRICE_PER_GIB_MICROS } from "./catalog.js";
import { EXPIRING_SOON_MS, usable, type Credit } from "./lots.js";
import { creditHoursLeft } from "./money.js";
import type { Account, Rental } from "./store.js";
import { BURNING_STATES, type ComputeStateView, type CreditLotView, type RentalView } from "./types.js";

/** Credit lots listed in a state view (soonest expiry first); 100 lots is at least $5,000 bought within 60 days. */
export const MAX_CREDIT_LOTS_SHOWN = 100;

/** 1-based queue positions of every queued rental, all accounts, in queue order. */
export function queuePositions(active: readonly Rental[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const r of active) if (r.state === "queued") out.set(r.id, ++n);
  return out;
}

/**
 * What the customer's credit paid for this rental: its minutes (charged_micros, net of boot refunds) plus the egress the
 * credit covered. Egress booked as operator-funded (billing.ts, safety.unpaid_egress_micros) was never taken from the
 * customer, so it is not "spent" (REVIEW-merged-opus.md 3: the view showed $4.01 against a $1.00 ledger).
 */
function spentMicros(r: Rental): number {
  return r.charged_micros + r.egress_billed_gib * EGRESS_PRICE_PER_GIB_MICROS - (r.safety?.unpaid_egress_micros ?? 0);
}

export function rentalView(r: Rental, positions: ReadonlyMap<string, number>): RentalView {
  return {
    id: r.id, tier: r.tier, name: r.name, state: r.state, queue_position: positions.get(r.id) ?? null,
    price_per_hour_micros: r.price_per_hour_micros,
    spent_micros: spentMicros(r), created_at: r.created_at,
    started_at: r.started_at, ended_at: r.ended_at, end_reason: r.end_reason, node_id: r.node_id, idle_minutes: r.idle_minutes,
  };
}

export function burnPerHour(rentals: readonly Rental[]): number {
  return rentals.filter((r) => BURNING_STATES.has(r.state)).reduce((sum, r) => sum + r.price_per_hour_micros, 0);
}

/** Every lot with credit left that is still unexpired at `now`, both buckets, soonest expiry first. */
export function creditLotViews(c: Credit, now: number): CreditLotView[] {
  return [...c.paid.lots, ...c.other.lots].filter((l) => l.remaining > 0 && l.expires_at > now)
    .sort((x, y) => x.expires_at - y.expires_at)
    .map((l) => ({ purchased_micros: l.amount, remaining_micros: l.remaining, purchased_at: l.created_at, expires_at: l.expires_at,
      expiring_soon: l.expires_at - now <= EXPIRING_SOON_MS }));
}

/** The account at `now`: usable (unexpired) credit only, its lots and soonest expiry, and hours left at the burn. */
export function stateView(a: Account, credit: Credit, now: number, rentals: readonly Rental[], positions: ReadonlyMap<string, number>): ComputeStateView {
  const burn = burnPerHour(rentals);
  const balance = usable(credit.paid, now) + usable(credit.other, now);
  // The forecast counts every lot; only the first MAX_CREDIT_LOTS_SHOWN are listed (pre.17 review: Codex P3-8).
  const lots = creditLotViews(credit, now);
  return {
    account_id: a.id, team_id: a.team_id, status: a.status, balance_micros: balance, burn_per_hour_micros: burn,
    hours_left: creditHoursLeft(balance, burn, lots, now), credit_lots: lots.slice(0, MAX_CREDIT_LOTS_SHOWN),
    next_expiry_at: lots[0]?.expires_at ?? null,
    rentals: rentals.map((r) => rentalView(r, positions)),
  };
}
