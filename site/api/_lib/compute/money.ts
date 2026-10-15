// Per-minute metering (docs/plans/RENT-1.md §5.1). A burning rental owes, for each STARTED minute since it began
// burning, 1/60 of its hourly price; the total is computed from the minute count (not summed per tick), rounded up
// to a micro-dollar, so a missed, doubled or late tick neither loses nor double-charges a minute.
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const MICROS_PER_USD = 1_000_000;

/** Minutes started between `from` and `to` (at least 1 once burning began). */
export function startedMinutes(from: number, to: number): number {
  if (to <= from) return 1;
  return Math.max(1, Math.ceil((to - from) / MINUTE_MS));
}

/** What `minutes` of a tier costs the customer, in micros (rounded up). */
export function priceOfMinutes(pricePerHourMicros: number, minutes: number): number {
  return Math.ceil((pricePerHourMicros * minutes) / 60);
}

/**
 * Hours of credit left at `burnPerHour` when credit lots expire (null when nothing burns): the lots are burned soonest
 * expiry first and what a lot still holds at its expiry is lost; credit in no listed lot lasts until spent. views.ts
 * passes every lot (not only those listed); the daemon keeps each account's figure (src/daemon/compute/service.ts).
 */
export function creditHoursLeft(balanceMicros: number, burnPerHourMicros: number,
    lots: readonly { readonly remaining_micros: number; readonly expires_at: number }[], now: number): number | null {
  if (burnPerHourMicros <= 0) return null;
  let hours = 0, left = Math.max(0, balanceMicros);
  for (const l of [...lots].sort((a, b) => a.expires_at - b.expires_at)) {
    const use = Math.min(l.remaining_micros, left);
    left -= use;
    const until = (l.expires_at - now) / HOUR_MS;
    if (until > hours) hours = Math.min(until, hours + use / burnPerHourMicros);
  }
  return Math.max(0, Math.floor((hours + left / burnPerHourMicros) * 100) / 100);
}

/** Hours of credit left at `burnPerHour` (null when nothing burns). */
export function hoursLeft(balanceMicros: number, burnPerHourMicros: number): number | null {
  if (burnPerHourMicros <= 0) return null;
  return Math.max(0, Math.floor((balanceMicros / burnPerHourMicros) * 100) / 100);
}
