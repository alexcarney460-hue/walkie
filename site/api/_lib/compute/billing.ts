// Metering and capacity helpers shared by the rent path and the minute tick. All run inside a store transaction that
// holds the account lock.
import { EGRESS_INCLUDED_GIB, EGRESS_PRICE_PER_GIB_MICROS, GIB, HOURS_PER_MONTH, tierSpec } from "./catalog.js";
import { HOUR_MS, priceOfMinutes, startedMinutes } from "./money.js";
import type { PrivateConfig } from "./private-config.js";
import type { Rental, Tx } from "./store.js";
import { realRental } from "./safety.js";
import { BURNING_STATES, CAPACITY_STATES, type TierId } from "./types.js";

/**
 * Charges a burning rental for every started minute up to `upTo` (idempotent: the charge is computed from the minute
 * count and the ledger key names it). Returns the rental as updated. Billing starts once the provider accepted the
 * machine (instance_id set).
 */
export async function bill(t: Tx, r: Rental, upTo: number): Promise<Rental> {
  if (!BURNING_STATES.has(r.state) || r.started_at === null || r.instance_id === null) return r;
  upTo = Math.min(upTo, r.safety?.billing_until ?? upTo);
  const withEgress = await billEgress(t, r, upTo);
  const minutes = Math.max(tierSpec(r.tier).min_minutes, startedMinutes(r.started_at, upTo));
  if (minutes <= withEgress.billed_minutes) return withEgress;
  const owed = priceOfMinutes(r.price_per_hour_micros, minutes);
  const due = owed - withEgress.charged_micros;
  if (due > 0) {
    await charge(t, r, {
      account_id: r.account_id, kind: "burn", amount_micros: -due, idem_key: `burn:${r.id}:${minutes}`, rental_id: r.id, created_at: upTo,
    });
  }
  const patch = { charged_micros: Math.max(owed, withEgress.charged_micros), billed_minutes: minutes };
  await t.updateRental(r.id, patch);
  return { ...withEgress, ...patch };
}

/** Reconcile a late provider deletion against minutes charged by earlier ticks. */
export async function reconcileDeletion(t: Tx, r: Rental, deletedAt: number): Promise<void> {
  if (r.started_at === null || r.instance_id === null) return;
  const minutes = Math.max(tierSpec(r.tier).min_minutes, startedMinutes(r.started_at, deletedAt));
  const owed = priceOfMinutes(r.price_per_hour_micros, minutes);
  const excess = Math.max(0, r.charged_micros - owed);
  if (!excess) return;
  const charges = await t.rentalCharges(r.id);
  let remaining = excess;
  for (const bucket of ['paid', 'other'] as const) {
    const amount = Math.min(remaining, Math.max(0, charges[bucket]));
    if (!amount) continue;
    await t.addLedger({ account_id: r.account_id, kind: 'refund', live: bucket === 'paid', amount_micros: amount,
      idem_key: `watchdog-refund:${r.id}:${bucket}`, rental_id: r.id, created_at: deletedAt });
    remaining -= amount;
  }
  if (remaining) throw new Error('watchdog charge reconciliation incomplete');
  await t.updateRental(r.id, { charged_micros: owed, billed_minutes: minutes });
}

/** GiB of outbound data a rental may send without charge: the allowance for each 730 hours (started) of its life. */
export function egressAllowanceGib(r: Rental, upTo: number): number {
  const hours = r.started_at === null ? 0 : Math.max(0, upTo - r.started_at) / HOUR_MS;
  return EGRESS_INCLUDED_GIB * hours / HOURS_PER_MONTH;
}

/** Charges outbound data beyond the allowance, per whole GiB (idempotent on the GiB count). */
async function billEgress(t: Tx, r: Rental, upTo: number): Promise<Rental> {
  const over = Math.max(0, Math.ceil(r.egress_bytes / GIB - egressAllowanceGib(r, upTo)));
  if (over <= r.egress_billed_gib) return r;
  const due = (over - r.egress_billed_gib) * EGRESS_PRICE_PER_GIB_MICROS;
  await charge(t, r, {
    account_id: r.account_id, kind: "burn", amount_micros: -due, idem_key: `egress:${r.id}:${over}`, rental_id: r.id, created_at: upTo,
  });
  await t.updateRental(r.id, { egress_billed_gib: over });
  return { ...r, egress_billed_gib: over };
}

/** Credit a request must have: the first `hours` of every machine asked for. */
export function creditNeeded(machines: readonly { tier: TierId; count: number }[], hours: number): number {
  return machines.reduce((sum, m) => sum + tierSpec(m.tier).price_per_hour_micros * m.count * hours, 0);
}

/** Machines held per quota group by rentals that occupy provider quota. */
export function usedByGroup(active: readonly Rental[], cfg: PrivateConfig): Map<string, number> {
  const used = new Map<string, number>();
  for (const r of active) {
    if (!CAPACITY_STATES.has(r.state)) continue;
    const g = cfg.tiers[r.tier].quota_group;
    used.set(g, (used.get(g) ?? 0) + 1);
  }
  return used;
}

/** A capacity ledger for one decision pass: `take` reserves one machine in its tier's group when there is room. */
export function capacity(active: readonly Rental[], cfg: PrivateConfig): { take(tier: TierId): boolean } {
  const used = usedByGroup(active, cfg);
  return {
    take(tier) {
      const g = cfg.tiers[tier].quota_group;
      const have = used.get(g) ?? 0;
      if (have + 1 > (cfg.quotas[g] ?? 0)) return false;
      used.set(g, have + 1);
      return true;
    },
  };
}

/** FakeCloud spends other credit first; real machines debit only paid-eligible credit. */
async function charge(t: Tx, r: Rental, e: import('./store.js').LedgerEntry): Promise<void> {
  const other = realRental(r) ? 0 : Math.min(-e.amount_micros, Math.max(0, await t.balance(r.account_id) - await t.paidBalance(r.account_id)));
  if (other) await t.addLedger({ ...e, amount_micros: -other, live: false, idem_key: `${e.idem_key}:other` });
  const paid = -e.amount_micros - other;
  if (paid) await t.addLedger({ ...e, amount_micros: -paid, live: true });
}

/** Refund a failed boot only once deletion is confirmed, preserving each credit bucket. */
export async function refundBoot(t: Tx, r: Rental, now: number): Promise<void> {
  if (r.started_at === null || r.last_heartbeat_at !== null || r.node_id !== null) return;
  const amounts = await t.rentalCharges(r.id, r.started_at + 15 * 60_000);
  let remaining = priceOfMinutes(r.price_per_hour_micros, 15);
  let refunded = 0;
  for (const bucket of ['paid', 'other'] as const) {
    const amount = Math.min(Math.max(0, amounts[bucket]), remaining);
    remaining -= amount;
    if (amount > 0 && await t.addLedger({ account_id: r.account_id, kind: 'refund', live: bucket === 'paid',
      amount_micros: amount, idem_key: `refund:${r.id}:${bucket}`, rental_id: r.id, created_at: now })) refunded += amount;
  }
  await t.updateRental(r.id, { charged_micros: Math.max(0, r.charged_micros - refunded) });
}
