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
export const CONCURRENCY = 4;
