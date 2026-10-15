// Metering and capacity helpers shared by the rent path and the minute tick. All run inside a store transaction that
// holds the account lock.
//
// Shutdown and debt policy (go-live review: REVIEW-codex.md P1-2 and P2-7). A machine is metered for every started
// minute until the provider confirms its deletion, whatever stopped it. The customer pays those minutes, and its
// egress beyond the allowance, out of credit only: a balance never goes below zero. Two parts are operator-funded
// and booked on the rental instead of being dropped: (1) after a paid lease expired unrenewed (the tick could not
// renew it: our outage), the customer owes nothing past `billing_until`; (2) whatever the covering credit cannot pay
// (the paid bucket for a real provider, all credit for FakeCloud). `safety.unpaid_micros` (minutes) and
// `safety.unpaid_egress_micros` hold those amounts at customer prices. They are bounded: at $0 the tick stops every
// machine of the account, and the independent watchdog deletes a droplet 20 minutes after its paid tag, which a
// stopping or unpaid machine no longer renews.
import { EGRESS_INCLUDED_GIB, EGRESS_PRICE_PER_GIB_MICROS, GIB, HOURS_PER_MONTH, tierSpec } from "./catalog.js";
import { HOUR_MS, priceOfMinutes, startedMinutes } from "./money.js";
import type { PrivateConfig } from "./private-config.js";
import type { ComputeDeps } from "./deps.js";
import type { LedgerEntry, Rental, Tx } from "./store.js";
import { allocate, expiriesBetween, readCredit, settleExpiries, type Part } from "./lots.js";
import { realRental } from "./safety.js";
import { BURNING_STATES, CAPACITY_STATES, type TierId } from "./types.js";

const minutesAt = (r: Rental, at: number): number => Math.max(tierSpec(r.tier).min_minutes, startedMinutes(r.started_at!, at));

/**
 * Meters a burning rental for every started minute up to `upTo` (idempotent: the amount is computed from the minute
 * count and the ledger key names it) and charges what the customer owes and its credit covers; the remainder is
 * booked as operator-funded (see the policy above). Returns the rental as updated. Metering starts once the provider
 * accepted the machine (instance_id set). When a credit lot it can spend expires inside the period, the minutes started
 * before that expiry are billed first, dated just before it, so the expiring lot pays for them (lots.ts).
 */
export async function bill(t: Tx, r: Rental, upTo: number): Promise<Rental> {
  if (!BURNING_STATES.has(r.state) || r.started_at === null || r.instance_id === null) return r;
  let cur = r;
  for (const at of expiriesBetween(await readCredit(t, r.account_id), r.started_at, upTo, realRental(r)))
    cur = await billMinutes(t, cur, at, at - 1);
  return billMinutes(t, await billEgress(t, cur, upTo), upTo, upTo);
}

/**
 * A paid lease that lapsed unrenewed by `at` (a tick outage, or a busy account whose lease expiry was deferred) bills
 * the customer only to the lease's end, whichever path then ends the machine (its owner's stop, any other stop, a
 * watchdog deletion): the provider time after it is operator-funded (policy (1) above), booked on the rental and alerted
 * when it ends (noteOperatorFunded). A rental already stopping keeps its own rule (its stop came while its lease was
 * current: the deletion tail is the customer's). `lease_until` is set with `started_at` at every launch claim (launch.ts).
 */
export function capLapsedLease(r: Rental, at: number): Rental {
  const end = r.safety?.lease_until;
  if ((r.state !== "starting" && r.state !== "running") || r.started_at === null || end === undefined || end > at ||
      r.safety?.billing_until !== undefined) return r;
  return { ...r, safety: { ...r.safety!, billing_until: end } };
}

/** The minutes started before `upTo`, charged at time `at` (the bill's own time, or just before a lot's expiry). */
async function billMinutes(t: Tx, r: Rental, upTo: number, at: number): Promise<Rental> {
  const minutes = minutesAt(r, upTo);
  if (minutes <= r.billed_minutes) return r;
  const unpaid = r.safety?.unpaid_micros ?? 0;
  const due = Math.max(0, priceOfMinutes(r.price_per_hour_micros, minutes) - r.charged_micros - unpaid);
  const until = r.safety?.billing_until;
  const owed = until === undefined ? due : Math.max(0, Math.min(due,
    priceOfMinutes(r.price_per_hour_micros, minutesAt(r, Math.min(upTo, until))) - r.charged_micros));
  const paid = owed > 0 ? await charge(t, r, {
    account_id: r.account_id, kind: "burn", amount_micros: -owed, idem_key: `burn:${r.id}:${minutes}`, rental_id: r.id, created_at: at,
  }) : 0;
  const patch = { charged_micros: r.charged_micros + paid, billed_minutes: minutes,
    ...(paid < due && r.safety ? { safety: { ...r.safety, unpaid_micros: unpaid + due - paid } } : {}) };
  await t.updateRental(r.id, patch);
  return { ...r, ...patch };
}

/**
 * Reconcile a provider deletion earlier than our metering: minutes after `deletedAt` are taken back, the customer is
 * refunded what it paid for them (into the lots it came from: refundToLots), and the operator-funded amount is
 * recomputed. Returns the rental as updated.
 */
export async function reconcileDeletion(t: Tx, r: Rental, deletedAt: number, now: number): Promise<Rental> {
  if (r.started_at === null || r.instance_id === null) return r;
  const minutes = minutesAt(r, deletedAt);
  const metered = priceOfMinutes(r.price_per_hour_micros, minutes);
  const excess = Math.max(0, r.charged_micros - metered);
  if (!excess && minutes >= r.billed_minutes) return r;
  if (excess) {
    const charges = await t.rentalCharges(r.id);
    let remaining = excess;
    for (const bucket of ['paid', 'other'] as const) {
      const amount = Math.min(remaining, Math.max(0, charges[bucket]));
      if (!amount) continue;
      // The excess is the latest minutes: back to the latest-expiring lots they came from first.
      await refundToLots(t, r, { bucket, amount, upTo: Number.MAX_SAFE_INTEGER, key: `watchdog-refund:${r.id}:${bucket}`,
        latestFirst: true, at: deletedAt, now });
      remaining -= amount;
    }
    if (remaining) throw new Error('watchdog charge reconciliation incomplete');
  }
  const charged = r.charged_micros - excess;
  const patch = { charged_micros: charged, billed_minutes: minutes,
    ...(r.safety ? { safety: { ...r.safety, unpaid_micros: metered - charged } } : {}) };
  await t.updateRental(r.id, patch);
  return { ...r, ...patch };
}

/**
 * Books a finished rental's operator-funded provider time in the log (alert `operator_funded`: ids and our estimated
 * provider cost for the unpaid minutes only; uncovered egress is on the rental record).
 */
export function noteOperatorFunded(log: ComputeDeps['log'], r: Rental, configuredCostPerHour = 0): void {
  const minutes = r.safety?.unpaid_micros ?? 0, egress = r.safety?.unpaid_egress_micros ?? 0;
  if (minutes + egress <= 0) return;
  const cost = r.safety?.cost_per_hour_micros ?? configuredCostPerHour;
  log('alert_operator_funded', { team: r.team_id, account: r.account_id, rental: r.id, provider: r.safety?.provider ?? null,
    cost_usd: Math.ceil(minutes * cost / r.price_per_hour_micros / 10_000) / 100 });
}

/** GiB of outbound data a rental may send without charge: the allowance for each 730 hours (started) of its life. */
export function egressAllowanceGib(r: Rental, upTo: number): number {
  const hours = r.started_at === null ? 0 : Math.max(0, upTo - r.started_at) / HOUR_MS;
  return EGRESS_INCLUDED_GIB * hours / HOURS_PER_MONTH;
}

/** Charges outbound data beyond the allowance, per whole GiB (idempotent on the GiB count), out of credit only. */
async function billEgress(t: Tx, r: Rental, upTo: number): Promise<Rental> {
  const over = Math.max(0, Math.ceil(r.egress_bytes / GIB - egressAllowanceGib(r, upTo)));
  if (over <= r.egress_billed_gib) return r;
  const due = (over - r.egress_billed_gib) * EGRESS_PRICE_PER_GIB_MICROS;
  const paid = await charge(t, r, {
    account_id: r.account_id, kind: "burn", amount_micros: -due, idem_key: `egress:${r.id}:${over}`, rental_id: r.id, created_at: upTo,
  });
  const patch = { egress_billed_gib: over, ...(paid < due && r.safety
    ? { safety: { ...r.safety, unpaid_egress_micros: (r.safety.unpaid_egress_micros ?? 0) + due - paid } } : {}) };
  await t.updateRental(r.id, patch);
  return { ...r, ...patch };
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

/**
 * FakeCloud spends other credit first; real machines debit only paid-eligible credit. Never debits a bucket below
 * zero: returns the amount actually charged (at most the amount asked for). Within a bucket the lots that expire
 * soonest pay first, and only lots unexpired at the entry's time (lots.ts); one row per lot, the first keeping the
 * entry's key (`…:other` for the other bucket), the next ones `…:2`, `…:3`.
 */
async function charge(t: Tx, r: Rental, e: LedgerEntry): Promise<number> {
  const asked = -e.amount_micros;
  const credit = await readCredit(t, r.account_id);
  const other = realRental(r) ? [] : allocate(credit.other, e.created_at, asked);
  const fromOther = other.reduce((n, p) => n + p.amount, 0);
  const paid = allocate(credit.paid, e.created_at, asked - fromOther);
  const write = async (parts: readonly Part[], live: boolean, key: string) => {
    for (const [i, p] of parts.entries())
      await t.addLedger({ ...e, amount_micros: -p.amount, live, lot: p.lot, idem_key: i ? `${key}:${i + 1}` : key });
  };
  await write(other, false, `${e.idem_key}:other`);
  await write(paid, true, e.idem_key);
  return fromOther + paid.reduce((n, p) => n + p.amount, 0);
}

/**
 * Gives `amount` of a rental's charges in one bucket back to the lots they came from (lots.ts): its net charge per lot
 * up to `upTo`, the soonest-expiring lot first (`latestFirst`: the latest first). One refund row per lot, the first
 * keeping `key`, the next ones `key:2`, `key:3`. Whatever lands in a lot already settled as expired at `now` is written
 * off at once, so refunded credit never outlives its lot. Returns the amount newly refunded.
 */
async function refundToLots(t: Tx, r: Rental, o: { readonly bucket: 'paid' | 'other'; readonly amount: number; readonly upTo: number;
    readonly key: string; readonly latestFirst: boolean; readonly at: number; readonly now: number }): Promise<number> {
  const live = o.bucket === 'paid';
  const credit = await readCredit(t, r.account_id);
  const expiry = new Map([...credit.paid.lots, ...credit.other.lots].map(l => [l.id, l.expires_at]));
  const sources = (await t.rentalLotCharges(r.id, o.upTo)).filter(c => c.live === live && c.charged > 0)
    // Charges from no lot (normally none) go back with no lot, after every lot.
    .map(c => ({ ...c, expires_at: c.lot === null ? Infinity : expiry.get(c.lot) ?? Infinity }))
    .sort((a, b) => a.expires_at - b.expires_at || String(a.lot).localeCompare(String(b.lot)));
  let left = o.amount, refunded = 0, i = 0;
  const touched = new Set<string>();
  for (const c of o.latestFirst ? [...sources].reverse() : sources) {
    if (left <= 0) break;
    const amount = Math.min(left, c.charged);
    if (await t.addLedger({ account_id: r.account_id, kind: 'refund', live, lot: c.lot, amount_micros: amount,
      idem_key: i ? `${o.key}:${i + 1}` : o.key, rental_id: r.id, created_at: o.at })) refunded += amount;
    if (c.lot !== null) touched.add(c.lot);
    left -= amount;
    i++;
  }
  await settleExpiries(t, r.account_id, o.now, l => touched.has(l.id) && l.expire_rows > 0);
  return refunded;
}

/**
 * Refunded boot failures a team may have in any 24 hours. A customer can make a boot fail on purpose (revoke or let
 * the join code expire, turn the authority machine off), so later failures are charged as metered and alerted.
 */
export const BOOT_REFUNDS_PER_DAY = 3;
const BOOT_REFUND_WINDOW_MS = 24 * HOUR_MS;
type BootRefund = { readonly rental: string; readonly at: number };
const isBootRefund = (x: unknown): x is BootRefund => !!x && typeof x === 'object' &&
  typeof (x as BootRefund).rental === 'string' && Number.isSafeInteger((x as BootRefund).at);

/**
 * Refund a failed boot only once deletion is confirmed, preserving each credit bucket, while the team is under its
 * daily cap. 'capped': the boot time stays charged (the caller alerts the operator).
 */
export async function refundBoot(t: Tx, r: Rental, now: number): Promise<'refunded' | 'capped' | 'none'> {
  if (r.started_at === null || r.last_heartbeat_at !== null || r.node_id !== null) return 'none';
  const key = `boot-refunds:${r.team_id}`;
  await t.lockControl(key);
  const stored = await t.control(key);
  const recent = (Array.isArray(stored) ? stored : []).filter(isBootRefund).filter(x => x.at > now - BOOT_REFUND_WINDOW_MS);
  const counted = recent.some(x => x.rental === r.id);
  if (!counted && recent.length >= BOOT_REFUNDS_PER_DAY) return 'capped';
  const upTo = r.started_at + 15 * 60_000;
  const amounts = await t.rentalCharges(r.id, upTo);
  let remaining = priceOfMinutes(r.price_per_hour_micros, 15);
  let refunded = 0;
  for (const bucket of ['paid', 'other'] as const) {
    const amount = Math.min(Math.max(0, amounts[bucket]), remaining);
    remaining -= amount;
    // The first fifteen minutes are the earliest charges: back to the soonest-expiring lots they came from first.
    if (amount > 0) refunded += await refundToLots(t, r, { bucket, amount, upTo, key: `refund:${r.id}:${bucket}`,
      latestFirst: false, at: now, now });
  }
  if (refunded > 0 && !counted) await t.setControl(key, [...recent, { rental: r.id, at: now }]);
  await t.updateRental(r.id, { charged_micros: Math.max(0, r.charged_micros - refunded) });
  return refunded > 0 ? 'refunded' : 'none';
}
