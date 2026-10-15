import type { ComputeDeps } from './deps.js';
import type { Rental, Tx } from './store.js';
import { available, realRental } from './safety.js';
import { markStopped, ComputeError } from './service.js';
import { onAccount, type TickPass } from './tick-pass.js';
import { tokenMatches } from './tokens.js';

export const LEASE_MS = 15 * 60_000;
export const TAG_HORIZON_MS = 60 * 60_000;
export const TAG_RENEW_MS = 30 * 60_000;
export const expired = (r: Rental, now: number): boolean =>
  (r.state === 'starting' || r.state === 'running') && r.started_at !== null &&
  (r.safety?.lease_until ?? r.started_at + LEASE_MS) <= now;

/** Reserve the next fifteen minutes from the same paid bucket used by billing. Only ticks renew. */
export async function renewLease(t: Tx, r: Rental, now: number): Promise<boolean> {
  if (!r.safety || r.started_at === null || !['starting', 'running'].includes(r.state)) return true;
  const needed = Math.ceil(r.price_per_hour_micros * LEASE_MS / 3_600_000);
  const funds = await available(t, r.account_id, now, r.id);
  if ((realRental(r) ? funds.paid : funds.total) < needed) return false;
  await t.updateRental(r.id, { safety: { ...r.safety, lease_until: now + LEASE_MS,
    reserved: Math.max(r.safety.reserved, r.charged_micros + needed) } });
  return true;
}

/**
 * Stops every rental whose paid lease lapsed (heartbeat_lost; the customer pays only to the lease's end). An account
 * whose row is busy (tick-pass.ts) is not waited on: its lapsed leases are deferred to the next pass that gets the row
 * (`lease_expiry_deferred`). They are still billed only to the lease's end, whichever path ends them first (a stop or a
 * watchdog deletion meanwhile: capLapsedLease in billing.ts); the provider time after it is operator-funded and alerted.
 * Meanwhile the machine powers itself off 15 minutes after its lease deadline and the watchdog deletes it 20 minutes
 * after its paid tag.
 */
export async function expireLeases(d: ComputeDeps, pass: TickPass): Promise<number> {
  const candidates = await d.store.tx(t => t.activeRentals());
  let count = 0;
  for (const r of candidates.filter(r => expired(r, d.now()))) {
    const done = await onAccount(d, pass, r.account_id, bounds => d.store.tx(async t => {
      await t.lockAccount(r.account_id);
      const cur = await t.rental(r.id);
      if (!cur || !expired(cur, d.now())) return true;
      const bounded = { ...cur, safety: cur.safety ? { ...cur.safety, billing_until: cur.safety.lease_until ?? cur.started_at! + LEASE_MS } : undefined };
      await markStopped(t, [bounded], 'heartbeat_lost', d.now());
      d.log('alert_lease_expired', { rental: cur.id });
      count++;
      return true;
    }, bounds));
    if (!done) d.log('lease_expiry_deferred', { account: r.account_id, rental: r.id });
  }
  return count;
}
export async function readLease(d: ComputeDeps, id: string, token: string): Promise<{ covered_until: number }> {
  return d.store.tx(async t => {
    const r = await t.rental(id);
    if (!r || !tokenMatches(token, r.heartbeat_hash)) throw new ComputeError(403, 'invalid_heartbeat');
    return { covered_until: ['starting', 'running'].includes(r.state) ? r.safety?.lease_until ?? 0 : 0 };
  });
}
