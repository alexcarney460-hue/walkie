import type { ComputeDeps } from './deps.js';
import type { Account, Rental, Tx } from './store.js';
import { ComputeError } from './service.js';

export const TICK_STALE_MS = 180_000;
export const realRental = (r: Rental): boolean => r.safety?.provider !== 'fake';
export const reservation = (r: Rental): number => Math.max(0, (r.safety?.reserved ?? 0) - r.charged_micros);
export async function available(t: Tx, account: string, except?: string): Promise<{ total: number; paid: number }> {
  const rentals = (await t.rentals(account, 0)).filter(r => r.id !== except);
  return {
    total: await t.balance(account) - rentals.reduce((n, r) => n + reservation(r), 0),
    paid: await t.paidBalance(account) - rentals.filter(realRental).reduce((n, r) => n + reservation(r), 0),
  };
}
export async function assertFresh(d: ComputeDeps, t: Tx): Promise<void> {
  const last = await t.control('last_tick');
  if (typeof last !== 'number' || d.now() - last > TICK_STALE_MS) {
    d.log('alert_tick_stale', { last_tick_at: typeof last === 'number' ? last : null });
    throw new ComputeError(503, 'compute_tick_stale');
  }
}
export async function eligible(d: ComputeDeps, t: Tx, a: Account): Promise<boolean> {
  if (d.config.internal_teams.includes(a.team_id) || !a.owner_key) return false;
  const enrolled = await t.enrollment(a.team_id);
  return !!enrolled && (d.config.customer_teams.includes(a.team_id) || enrolled.source !== 'tofu');
}
export async function launchEligible(d: ComputeDeps, t: Tx, a: Account): Promise<boolean> {
  const enrolled = await t.enrollment(a.team_id);
  return !!enrolled && enrolled.key === a.owner_key && await eligible(d, t, a) && !(await launchFrozen(t, a.team_id));
}
export async function launchFrozen(t: Tx, team: string): Promise<boolean> {
  return typeof await t.control(`enrollment-fork:${team}`) === 'number' ||
    !!(await t.control(`compute-handover:${team}`));
}
