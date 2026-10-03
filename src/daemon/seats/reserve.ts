import { freshRoomOf } from "../../accounts/select.ts";
import type { AccountUsage } from "../../protocol/accounts.ts";
import { PERSONAL_RESERVE_PCT } from "../../protocol/pool-rules.ts";

/** Checks that cannot establish the person's reserve, with no fresh reading in between, before a borrowed seat stops. */
export const RESERVE_FAILED_CHECKS = 3;
/** Throttled refreshes (429 from the lender) are retried; past this many since the last fresh reading, each one counts
 *  as a failed check, so at most RESERVE_THROTTLED_CHECKS + RESERVE_FAILED_CHECKS checks pass without a fresh reading. */
export const RESERVE_THROTTLED_CHECKS = 10;

const throttled = (err: unknown) => (err as { status?: unknown } | null)?.status === 429;

/**
 * A borrowed seat continues while fresh readings prove its person's reserve is intact. A fresh reading at or under the
 * reserve stops it at once; an unknown reading (missing grant, failed refresh, stale data) stops it after
 * RESERVE_FAILED_CHECKS such checks with no fresh reading in between. A throttled refresh is retried at the next check.
 */
export function superviseReserve(o: {
  read: () => AccountUsage | null; refresh: () => Promise<AccountUsage | null>;
  stop: () => Promise<void>; error: (err: unknown) => void; everyMs?: number;
}): () => void {
  let ended = false, pending = false, failed = 0, throttledChecks = 0;
  const cancel = () => { ended = true; clearInterval(timer); };
  const report = (err: unknown) => { try { o.error(err); } catch { /* a log failure must not skip the stop */ } };
  const check = async () => {
    if (ended || pending) return;
    pending = true;
    let room: number | null = null;
    let wasThrottled = false;
    try {
      room = freshRoomOf(o.read(), null, Date.now());
      if (room === null) room = freshRoomOf(await o.refresh(), null, Date.now());
    } catch (err) { wasThrottled = throttled(err); report(err); }
    // Only a fresh reading with room resets the counts; failures and throttled checks in any mix stay bounded.
    if (room !== null && room > PERSONAL_RESERVE_PCT) { failed = 0; throttledChecks = 0; }
    else if (room === null) {
      if (wasThrottled) throttledChecks++;
      if (!wasThrottled || throttledChecks > RESERVE_THROTTLED_CHECKS) failed++;
    }
    if (!ended && ((room !== null && room <= PERSONAL_RESERVE_PCT) || failed >= RESERVE_FAILED_CHECKS)) {
      try { await o.stop(); cancel(); } catch (err) { report(err); /* retry the stop on the next check */ }
    }
    pending = false;
  };
  const timer = setInterval(() => { void check(); }, o.everyMs ?? 60_000);
  timer.unref?.();
  return cancel;
}
