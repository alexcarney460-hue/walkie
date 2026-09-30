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

/** Hours of credit left at `burnPerHour` (null when nothing burns). */
export function hoursLeft(balanceMicros: number, burnPerHourMicros: number): number | null {
  if (burnPerHourMicros <= 0) return null;
  return Math.max(0, Math.floor((balanceMicros / burnPerHourMicros) * 100) / 100);
}
