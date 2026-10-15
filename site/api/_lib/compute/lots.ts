// Prepaid credit expiry (Alex 2026-10-09: credit is NON-REFUNDABLE and EXPIRES 60 DAYS AFTER PURCHASE).
//
// Every positive purchase or adjustment row is a credit LOT, in its bucket (paid = Stripe livemode, other = everything
// else; see Tx.paidBalance). A lot expires CREDIT_LIFETIME_MS after the time it was credited (its row's created_at).
// Burn, refund and expire rows name the lot they draw on or return to (LedgerEntry.lot), so what a lot has left is its
// amount plus the rows attributed to it, and the ledger stays one append-only sum:
//   purchases + adjustments + refunds - burns - expiries = balance, per bucket and in total.
// - Spending (billing.ts charge) takes the lots of the bucket that expire soonest first (ties in insertion order), and
//   only lots still unexpired at the spend's time; a spend that crosses a lot's end continues in the next lot.
// - A refund (boot failure, watchdog deletion) goes back to the lots the rental's charges came from, with their own
//   expiry; whatever lands in a lot that has already expired is written off at once (never usable again).
// - At a lot's expiry the minute tick (or its sweep, for an account with nothing running) writes ONE expire row for its
//   unspent remainder (zero included: the row marks the lot settled). Reads (state, rent, start, the queue, launches,
//   lease renewals) count only unexpired lots, so expired credit is never usable even when the tick is late.
// Rows attributed to no lot (operator SQL, older fixtures) are applied soonest-expiring first, so every number above
// still adds up; credit that ends up in no lot (normally none) never expires.
import { HOUR_MS } from './money.js';
import type { CreditLotRow, Tx } from './store.js';

/** A lot's life: exactly 60 x 24 hours from the time it was credited. */
export const CREDIT_LIFETIME_MS = 60 * 24 * HOUR_MS;
/** Lots one account writes off per pass (tick budget): the rest stay unusable and the next pass continues. */
export const SETTLE_BATCH = 50;
/** A lot that expires within this is flagged to the customer (views.ts). */
export const EXPIRING_SOON_MS = 7 * 24 * HOUR_MS;

export interface Lot {
  readonly id: string;
  readonly live: boolean;
  readonly amount: number;
  readonly created_at: number;
  readonly expires_at: number;
  /** What is left, never negative. */
  readonly remaining: number;
  readonly expire_rows: number;
}
export interface Bucket {
  /** Soonest expiry first, ties in insertion order. */
  readonly lots: readonly Lot[];
  /** Credit in no lot: normally 0; negative only when every lot is empty (a deficit). */
  readonly unlotted: number;
}
export interface Credit { readonly paid: Bucket; readonly other: Bucket }

const ordered = (rows: readonly CreditLotRow[]): CreditLotRow[] =>
  rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.created_at - b.r.created_at || a.i - b.i).map(x => x.r);

/** One bucket's lots from their rows and the bucket's ledger sum (unattributed flow spread soonest first). */
export function bucketOf(rows: readonly CreditLotRow[], balance: number): Bucket {
  const lots = ordered(rows);
  const left = lots.map(r => Math.min(r.amount_micros, Math.max(0, r.amount_micros + r.attributed_micros)));
  let flow = balance - left.reduce((n, x) => n + x, 0);
  for (let k = 0; k < left.length && flow < 0; k++) {
    const take = Math.min(left[k]!, -flow);
    left[k] = left[k]! - take;
    flow += take;
  }
  for (let k = left.length - 1; k >= 0 && flow > 0; k--) {
    const give = Math.min(lots[k]!.amount_micros - left[k]!, flow);
    left[k] = left[k]! + give;
    flow -= give;
  }
  return { unlotted: flow, lots: lots.map((r, k) => ({ id: r.id, live: r.live, amount: r.amount_micros, created_at: r.created_at,
    expires_at: r.created_at + CREDIT_LIFETIME_MS, remaining: left[k]!, expire_rows: r.expire_rows })) };
}

export async function readCredit(t: Tx, account: string): Promise<Credit> {
  const rows = await t.creditLots(account);
  const paid = await t.paidBalance(account);
  const total = await t.balance(account);
  return { paid: bucketOf(rows.filter(r => r.live), paid), other: bucketOf(rows.filter(r => !r.live), total - paid) };
}

/** What a bucket can still spend at `at`: unexpired lots plus credit in no lot (a deficit makes it negative). */
export function usable(b: Bucket, at: number): number {
  return b.lots.reduce((n, l) => n + (l.expires_at > at ? l.remaining : 0), 0) + b.unlotted;
}

/** Usable credit at `at`, in total and in the paid bucket (what available() and the tick's stop rule start from). */
export async function usableCredit(t: Tx, account: string, at: number): Promise<{ total: number; paid: number }> {
  const c = await readCredit(t, account);
  const paid = usable(c.paid, at);
  return { total: paid + usable(c.other, at), paid };
}

export interface Part { readonly lot: string | null; readonly amount: number }

/** Up to `amount` from a bucket at `at`: soonest-expiring unexpired lots first, then credit in no lot. */
export function allocate(b: Bucket, at: number, amount: number): Part[] {
  const parts: Part[] = [];
  let left = Math.min(amount, Math.max(0, usable(b, at)));
  for (const l of b.lots) {
    if (left <= 0) break;
    if (l.expires_at <= at || l.remaining <= 0) continue;
    const take = Math.min(l.remaining, left);
    parts.push({ lot: l.id, amount: take });
    left -= take;
  }
  if (left > 0) parts.push({ lot: null, amount: left });
  return parts;
}

/** Expiry times in (after, upTo] of lots that still hold credit, ascending (billing.ts splits a bill at each one). */
export function expiriesBetween(c: Credit, after: number, upTo: number, paidOnly: boolean): number[] {
  const lots = [...c.paid.lots, ...(paidOnly ? [] : c.other.lots)];
  return [...new Set(lots.filter(l => l.remaining > 0 && l.expires_at > after && l.expires_at <= upTo).map(l => l.expires_at))]
    .sort((a, b) => a - b);
}

/**
 * Writes off the unspent remainder of every lot expired at `now` (that `which` selects): one expire row per lot, keyed
 * `expire:<lot>:<n>` (n = 1 at its expiry, 2… for credit refunded into it later), so a repeated or concurrent run under
 * the account lock writes nothing more. The first row is dated at the expiry, later ones at `now`. At most `limit` lots
 * per call (SETTLE_BATCH, soonest expiry first): the rest stay unusable to every read and the next pass continues.
 * Returns the total written off.
 */
export async function settleExpiries(t: Tx, account: string, now: number, which: (l: Lot) => boolean = () => true,
    limit = SETTLE_BATCH): Promise<number> {
  const c = await readCredit(t, account);
  const due = [...c.paid.lots, ...c.other.lots].filter(l => l.expires_at <= now && which(l) && !(l.remaining <= 0 && l.expire_rows > 0))
    .sort((x, y) => x.expires_at - y.expires_at).slice(0, limit);
  let total = 0;
  for (const l of due) {
    const first = l.expire_rows === 0;
    if (await t.addLedger({ account_id: account, kind: 'expire', amount_micros: l.remaining > 0 ? -l.remaining : 0,
      idem_key: `expire:${l.id}:${l.expire_rows + 1}`, lot: l.id, live: l.live, created_at: first ? l.expires_at : now }))
      total += l.remaining;
  }
  return total;
}
