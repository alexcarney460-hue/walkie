// "I'm using this computer" (PROTOCOL §11, busy): the pure decisions behind `walkie seats busy|resume`. While the
// host's person uses the machine, at most `max` seats run there: the newest running ones are paused (SIGSTOP of
// their process group) and new launches queue; resuming continues the paused ones oldest first and starts the
// queued ones within the normal caps. No I/O here: host.ts applies these plans.

/** A seat as the planner sees it: `order` grows with each launch (older seats have smaller numbers). */
export interface PlanSeat { id: string; order: number }

/**
 * Which seats to pause (newest first) or continue (oldest first) so that at most `limit` run. `active`: seats not
 * paused (running or preparing); `paused`: seats paused now. `limit` = Infinity when the machine isn't busy.
 */
export function planPauses(active: readonly PlanSeat[], paused: readonly PlanSeat[], limit: number): { pause: string[]; resume: string[] } {
  const byOrder = (a: PlanSeat, b: PlanSeat) => a.order - b.order;
  const running = [...active].sort(byOrder);
  if (running.length > limit) return { pause: running.slice(limit).reverse().map((s) => s.id), resume: [] };
  const room = limit - running.length;
  return { pause: [], resume: [...paused].sort(byOrder).slice(0, room).map((s) => s.id) };
}

/** A queued launch as the planner sees it. */
export interface PlanQueued { id: string; launcher: string; maxConcurrent: number }

/**
 * Which queued launches start now, in queue order: while fewer than `limit` seats are active and fewer than
 * `hostMax` exist (paused ones included), each launcher below its own `max_concurrent`. A launcher at its cap is
 * skipped (the ones behind it may still start); the machine being full ends the pass.
 */
export function planStarts(
  queue: readonly PlanQueued[], counts: { active: number; total: number; byLauncher: ReadonlyMap<string, number> }, limit: number, hostMax: number,
): string[] {
  let active = counts.active;
  let total = counts.total;
  const mine = new Map(counts.byLauncher);
  const out: string[] = [];
  for (const q of queue) {
    if (active >= limit || total >= hostMax) break;
    const n = mine.get(q.launcher) ?? 0;
    if (n >= q.maxConcurrent) continue;
    out.push(q.id);
    active += 1;
    total += 1;
    mine.set(q.launcher, n + 1);
  }
  return out;
}

/**
 * A seat's wall-clock limit that doesn't run while the seat is paused: `start` arms it, `pause` keeps what is left,
 * `resume` re-arms it with that. Times are passed in (ms), so it is tested without waiting.
 */
export class SeatLimit {
  private endsAt: number | null = null;
  private left: number;

  constructor(totalMs: number) { this.left = totalMs; }

  /** Starts (or continues) the clock at `now`; returns the ms until the limit. */
  start(now: number): number {
    this.endsAt = now + this.left;
    return this.left;
  }

  /** Stops the clock at `now`; returns the ms left. */
  pause(now: number): number {
    if (this.endsAt !== null) this.left = Math.max(0, this.endsAt - now);
    this.endsAt = null;
    return this.left;
  }

  get running(): boolean { return this.endsAt !== null; }
  /** Ms left at `now`. */
  remaining(now: number): number { return this.endsAt === null ? this.left : Math.max(0, this.endsAt - now); }
}

/** `--for 2h`, `30m`, `90s`, `1h30m` (or a plain number of minutes) in seconds; null when it isn't one. */
export function parseDuration(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t) * 60;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3_600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
