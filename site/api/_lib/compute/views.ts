// Customer-facing views of rentals and accounts: PRICES ONLY. These are the only functions that turn stored rows into
// response bodies; site/test/compute-no-cost.test.ts runs them all through the forbidden-field check.
import { EGRESS_PRICE_PER_GIB_MICROS } from "./catalog.js";
import { hoursLeft } from "./money.js";
import type { Account, Rental } from "./store.js";
import { BURNING_STATES, type ComputeStateView, type RentalView } from "./types.js";

/** 1-based queue positions of every queued rental, all accounts, in queue order. */
export function queuePositions(active: readonly Rental[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const r of active) if (r.state === "queued") out.set(r.id, ++n);
  return out;
}

export function rentalView(r: Rental, positions: ReadonlyMap<string, number>): RentalView {
  return {
    id: r.id, tier: r.tier, name: r.name, state: r.state, queue_position: positions.get(r.id) ?? null,
    price_per_hour_micros: r.price_per_hour_micros,
    spent_micros: r.charged_micros + r.egress_billed_gib * EGRESS_PRICE_PER_GIB_MICROS, created_at: r.created_at,
    started_at: r.started_at, ended_at: r.ended_at, end_reason: r.end_reason, node_id: r.node_id, idle_minutes: r.idle_minutes,
  };
}

export function burnPerHour(rentals: readonly Rental[]): number {
  return rentals.filter((r) => BURNING_STATES.has(r.state)).reduce((sum, r) => sum + r.price_per_hour_micros, 0);
}

export function stateView(a: Account, balance: number, rentals: readonly Rental[], positions: ReadonlyMap<string, number>): ComputeStateView {
  const burn = burnPerHour(rentals);
  return {
    account_id: a.id, team_id: a.team_id, status: a.status, balance_micros: balance, burn_per_hour_micros: burn,
    hours_left: hoursLeft(balance, burn), rentals: rentals.map((r) => rentalView(r, positions)),
  };
}
