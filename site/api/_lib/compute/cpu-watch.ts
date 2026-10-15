// CPU mining signal for the CPU-only launch (REVIEW-merged-opus.md 4, REVIEW-merged-codex.md 4, REVIEW-fixdiff-opus.md
// P2-3). Two alerts, both with the rental, team and account ids, both ALERT ONLY: nothing is stopped, put under review
// or billed differently; the operator decides. The figures are guest-reported, like every heartbeat field.
// - `cpu_pegged` (idle-pegged): cpu_pct at or above CPU_HOT_PCT and NO Walkie agent work (busy_seats 0, pool_jobs 0) on
//   every heartbeat for CPU_HOT_MS, at most once per CPU_ALERT_EVERY_MS per rental. Agent work restarts its window.
// - `cpu_pegged_long` (long-run): cpu_pct at or above CPU_HOT_PCT on every heartbeat for CPU_LONG_MS WHATEVER the agent
//   work, at most once per CPU_LONG_ALERT_EVERY_MS per rental. It sees a miner run inside a seat task, which an honest
//   guest reports as agent work; a long build or test run can trigger it too.
// A heartbeat below CPU_HOT_PCT restarts both windows.
import type { RentalSafety } from './store.js';

export const CPU_HOT_PCT = 90;
export const CPU_HOT_MS = 10 * 60_000;
export const CPU_ALERT_EVERY_MS = 30 * 60_000;
export const CPU_LONG_MS = 60 * 60_000;
export const CPU_LONG_ALERT_EVERY_MS = 6 * 60 * 60_000;

const due = (since: number | undefined, last: number | undefined, now: number, run: number, every: number): boolean =>
  since !== undefined && now - since >= run && (last === undefined || now - last >= every);

/**
 * One heartbeat's effect on the rental's CPU watch: the new safety record when it changes (undefined when it does not)
 * and which alerts to raise now.
 */
export function watchCpu(s: RentalSafety, cpuPct: number, busy: boolean, now: number):
    { readonly safety?: RentalSafety; readonly alert: boolean; readonly longAlert: boolean } {
  const hot = cpuPct >= CPU_HOT_PCT;
  const idleSince = hot && !busy ? s.cpu_hot_since ?? now : undefined;
  const longSince = hot ? s.cpu_long_since ?? now : undefined;
  const alert = due(idleSince, s.cpu_alert_at, now, CPU_HOT_MS, CPU_ALERT_EVERY_MS);
  const longAlert = due(longSince, s.cpu_long_alert_at, now, CPU_LONG_MS, CPU_LONG_ALERT_EVERY_MS);
  if (idleSince === s.cpu_hot_since && longSince === s.cpu_long_since && !alert && !longAlert) return { alert, longAlert };
  return { safety: { ...s, cpu_hot_since: idleSince, cpu_long_since: longSince, ...(alert ? { cpu_alert_at: now } : {}),
    ...(longAlert ? { cpu_long_alert_at: now } : {}) }, alert, longAlert };
}
