import type { ComputeDeps } from './deps.js';
import type { Account, Rental, Tx } from './store.js';
import { ComputeError } from './service.js';
import { readCredit, usable, usableCredit, type Credit } from './lots.js';
import { MIN_HOURS_COVERED } from './catalog.js';
import { HOUR_MS } from './money.js';
import { BURNING_STATES } from './types.js';

export const TICK_STALE_MS = 180_000;
export const realRental = (r: Rental): boolean => r.safety?.provider !== 'fake';
export const reservation = (r: Rental): number => Math.max(0, (r.safety?.reserved ?? 0) - r.charged_micros);
/** Credit usable at `now` (unexpired lots only: lots.ts) less every other rental's reservation, in total and paid. */
export async function available(t: Tx, account: string, now: number, except?: string): Promise<{ total: number; paid: number }> {
  const rentals = (await t.rentals(account, 0)).filter(r => r.id !== except);
  const credit = await usableCredit(t, account, now);
  return {
    total: credit.total - rentals.reduce((n, r) => n + reservation(r), 0),
    paid: credit.paid - rentals.filter(realRental).reduce((n, r) => n + reservation(r), 0),
  };
}
/** A machine's first hours must be covered by credit that stays unexpired through them (pre.17 review: Opus P3-1). */
export const FIRST_HOURS_MS = MIN_HOURS_COVERED * HOUR_MS;
const waiting = (r: Rental): boolean => r.state === 'queued' || r.state === 'needs_code';
const held = (rs: readonly Rental[]): number => rs.reduce((n, r) => n + reservation(r), 0);

export interface FirstHourFunds {
  readonly total: number;
  readonly paid: number;
  /** Credit usable now that expires within the first hours: it cannot cover a new machine's first hour. */
  readonly expiring: { readonly total: number; readonly paid: number };
}

/**
 * What a waiting machine's first hours may draw on at `now`: credit still unexpired FIRST_HOURS_MS from now, less what
 * the burning rentals reserve beyond the credit that expires sooner (they spend the soonest-expiring credit first). In
 * total and in the paid bucket. Waiting rentals' own reservations are not subtracted here (firstHourFunds does).
 */
export function firstHourCover(c: Credit, rentals: readonly Rental[], now: number): FirstHourFunds {
  const later = now + FIRST_HOURS_MS;
  const burning = rentals.filter(r => BURNING_STATES.has(r.state));
  const paidLasting = usable(c.paid, later), paidSoon = usable(c.paid, now);
  const lasting = paidLasting + usable(c.other, later), soon = paidSoon + usable(c.other, now);
  const cover = (last: number, sooner: number, reserved: number) => last - Math.max(0, reserved - (sooner - last));
  return { total: cover(lasting, soon, held(burning)), paid: cover(paidLasting, paidSoon, held(burning.filter(realRental))),
    expiring: { total: Math.max(0, soon - lasting), paid: Math.max(0, paidSoon - paidLasting) } };
}

/** firstHourCover less every other waiting rental's reservation: what admits one more machine (rent, queue, start). */
export async function firstHourFunds(t: Tx, account: string, now: number, except?: string): Promise<FirstHourFunds> {
  const rentals = (await t.rentals(account, 0)).filter(r => r.id !== except);
  const cover = firstHourCover(await readCredit(t, account), rentals, now);
  const others = rentals.filter(waiting);
  return { ...cover, total: cover.total - held(others), paid: cover.paid - held(others.filter(realRental)) };
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
