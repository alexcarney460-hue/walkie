// The minute tick's credit-expiry work (lots.ts; lane H, pre.17 review rounds 2-4): which waiting rentals credit still
// backs, and the bounded sweep that writes off expired lots of accounts the billing pass does not reach. Busy accounts
// and the tick's bounds are in tick-pass.ts.
import { bill } from './billing.js';
import type { ComputeDeps } from './deps.js';
import { CREDIT_LIFETIME_MS, readCredit, settleExpiries, type Credit } from './lots.js';
import { firstHourCover, realRental, reservation } from './safety.js';
import { markStopped } from './service.js';
import type { Rental, Tx } from './store.js';
import { onAccount, type TickPass } from './tick-pass.js';

/** Accounts settled per tick by the expiry sweep, beyond those the billing pass settles. */
export const EXPIRY_SWEEP_MAX = 25;
/**
 * Every safety pass: the machines that burn keep their reservations first; then each waiting rental (queued or
 * needs_code, queue order) keeps its first hour only while credit that stays unexpired through that hour still covers
 * it (paid credit for a real provider; safety.ts firstHourCover). One no longer covered ends `no_credit` instead of
 * holding a reservation, and a place in its quota group's queue, that no credit backs. Returns the ids it ended.
 */
export async function endUncovered(t: Tx, rentals: readonly Rental[], credit: Credit, now: number): Promise<Set<string>> {
  const cover = firstHourCover(credit, rentals, now);
  let total = cover.total, paid = cover.paid;
  const ended = new Set<string>();
  for (const r of rentals.filter(x => x.state === 'queued' || x.state === 'needs_code')) {
    const need = reservation(r);
    if (total >= need && (!realRental(r) || paid >= need)) {
      total -= need;
      if (realRental(r)) paid -= need;
      continue;
    }
    await markStopped(t, [r], 'no_credit', now);
    ended.add(r.id);
  }
  return ended;
}

/**
 * Writes off expired credit lots of accounts the billing pass did not settle (nothing active, a drain, or an expiry the
 * clock reached after the account's billing pass), oldest due lot first, at most EXPIRY_SWEEP_MAX accounts and lots in
 * batches (lots.ts SETTLE_BATCH), within `deadline`. Each account is settled under its lock as the billing pass settles
 * it: its burning machines billed up to now, the lots written off, its waiting rentals reconciled. A busy account is
 * skipped (tick-pass.ts onAccount) and any other failure logged; both are left for the next tick.
 */
export async function sweepExpiries(d: ComputeDeps, deadline: number, pass: TickPass): Promise<void> {
  if (Date.now() >= deadline) return;
  const now = d.now();
  let due: readonly string[];
  try { due = await d.store.tx(t => t.dueLotAccounts(now - CREDIT_LIFETIME_MS, EXPIRY_SWEEP_MAX), pass.bounds); }
  catch { d.log('credit_expiry_failed', { reason: 'list' }); return; }
  for (const id of due) {
    if (Date.now() >= deadline) break;
    try {
      const expired = await onAccount(d, pass, id, bounds => d.store.tx(async t => {
        if (!(await t.lockAccount(id))) return 0;
        const rentals: Rental[] = [];
        for (const r of await t.rentals(id, 0)) rentals.push(await bill(t, r, now));
        const n = await settleExpiries(t, id, now);
        await endUncovered(t, rentals, await readCredit(t, id), now);
        return n;
      }, bounds));
      if (expired) d.log('credit_expired', { account: id, micros: expired });
    } catch { d.log('credit_expiry_failed', { account: id, reason: 'settle' }); }
  }
}
