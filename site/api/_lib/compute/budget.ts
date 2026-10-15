/** Wall-clock budgets are independent of the billing clock. Cancellation reaches provider HTTP calls. */
export async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('compute_deadline')); }, Math.max(1, milliseconds));
    })]);
  } finally { clearTimeout(timer); }
}
export const CALL_MS = 8_000;
export const TICK_MS = 40_000;
/** Each of the tick's two bounded cleanup drains (stops get the first provider slots). */
export const CLEANUP_MS = 16_000;
/** Alert delivery after a handler's work (alerts.ts: three seconds per alert, all sent in parallel). */
export const ALERT_MS = 3_000;
/**
 * The tick function's Vercel limit: site/vercel.json `functions["api/compute/tick.ts"].maxDuration` (Vercel Pro).
 * TICK_MS of work, ALERT_MS of delivery and one CALL_MS of store slack fit inside it (site/test/compute-tick-cron.test.ts).
 */
export const TICK_MAX_DURATION_S = 60;
export const CONCURRENCY = 4;

export interface TickBudget {
  /** Wall time for the whole pass; nothing new starts after it. */
  readonly total: number;
  /** Wall time for each cleanup drain. */
  readonly cleanup: number;
  /** Wall time for one provider call, and the reserve kept before the deadline when billing accounts. */
  readonly call: number;
}
export const TICK_BUDGET: TickBudget = { total: TICK_MS, cleanup: CLEANUP_MS, call: CALL_MS };
