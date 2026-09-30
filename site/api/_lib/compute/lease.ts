import type { ComputeDeps } from './deps.js';
import type { Rental, Tx } from './store.js';
import { available, realRental } from './safety.js';
import { markStopped, ComputeError } from './service.js';
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
  const funds = await available(t, r.account_id, r.id);
  if ((realRental(r) ? funds.paid : funds.total) < needed) return false;
  await t.updateRental(r.id, { safety: { ...r.safety, lease_until: now + LEASE_MS,
    reserved: Math.max(r.safety.reserved, r.charged_micros + needed) } });
  return true;
}

export async function expireLeases(d: ComputeDeps): Promise<number> {
  const candidates = await d.store.tx(t => t.activeRentals());
  let count = 0;
  for (const r of candidates.filter(r => expired(r, d.now()))) {
    await d.store.tx(async t => {
      await t.lockAccount(r.account_id);
      const cur = await t.rental(r.id);
      if (!cur || !expired(cur, d.now())) return;
      const bounded = { ...cur, safety: cur.safety ? { ...cur.safety, billing_until: cur.safety.lease_until ?? cur.started_at! + LEASE_MS } : undefined };
      await markStopped(t, [bounded], 'heartbeat_lost', d.now());
      d.log('alert_lease_expired', { rental: cur.id });
      count++;
    });
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
