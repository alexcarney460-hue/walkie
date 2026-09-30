import type { Schedules } from "../../src/daemon/orchestrator/schedules.ts";

/** Advance a test schedule's monotonic clock with its explicit tick/completion time. */
export function withScheduleClock(schedules: Schedules): Schedules {
  let elapsed = 0;
  let inTick = false;
  const clock = schedules as unknown as {
    opts: { monotonicNow?: () => number };
    complete: (...args: unknown[]) => Promise<void>;
  };
  clock.opts.monotonicNow = () => elapsed;
  const tick = schedules.tick.bind(schedules);
  schedules.tick = async (at = Date.now()) => {
    elapsed = Math.max(elapsed + 15_000, at);
    inTick = true;
    try { await tick(at); } finally { inTick = false; }
  };
  const complete = clock.complete.bind(schedules);
  clock.complete = async (...args: unknown[]) => {
    elapsed = Math.max(elapsed + (inTick ? 0 : 120_000), args[3] as number);
    await complete(...args);
  };
  return schedules;
}
