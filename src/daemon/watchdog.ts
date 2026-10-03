// Event-loop stall watchdog (DAEMON-STALL-1). A daemon whose one thread sits in a long synchronous call (a SQLite
// statement on a busy disk) stays alive but answers nothing: requests on its socket time out. This names the cause:
// a timer checks how late it fires, and a tick `stallMs` or more late logs `event_loop_stall` with the operation that
// ran longest since the previous check (when it held the loop for at least half the delay; else `untracked`).
// Operations are named by wrapping them in `trackOp` (route dispatch, the periodic jobs): it costs two clock reads per
// call. An async operation's continuation after an `await` runs outside its wrapper, so the log also names the
// operation that started last (`last_op`), usually the one that continued.
//
// Sleep is not a stall (WALK-87). The monotonic clock does not run while a laptop sleeps (macOS), the wall clock does:
// a wall clock that gained time on the monotonic one between two ticks means the machine slept (or its clock was set
// forward). A sleeping daemon is as unaware of its peers as a stalled one, so the time its peers' last contact is
// measured in (sync.ts, wall clock) is discounted by the sleep too (`stallTotalMs`), or every machine would look offline
// for a moment after the lid opens; but it is logged as `sleep_resume` and never shown as a lagging daemon (`recentLag`).
// A wall clock set BACK and later forward again (a correction) must not read as a sleep: every loss, including one
// under a second, is credited against what it gains later, so only time gained beyond that counts. Crediting only a
// loss past a second lets a repeated step back of 0.9 s and forward of 1.1 s count the whole forward step, and the
// discount then grows faster than the clock, so a dead peer stays online (WALK-102). The credit is capped and lapses.
import type { Logger } from "./logger.ts";

/** A tick this late is a stall. */
export const STALL_MS = 500;
/** How often the loop is checked. */
export const WATCH_INTERVAL_MS = 250;
/** A wall-clock gain past this against the monotonic clock in one tick counts as sleep, after credit (below). */
export const CLOCK_STEP_MS = 1_000;
/** The most backward drift may later cancel from the time the wall clock gains, and for how long (monotonic ms). */
export const MAX_STEP_CREDIT_MS = 3_600_000;
export const STEP_CREDIT_TTL_MS = 600_000;
/**
 * A loss of at least this renews the credit's lifetime. Anything smaller is still credited (so a step under a second
 * offsets the next gain) but must not renew it: a one-millisecond residual on an integer wall clock would otherwise
 * keep an old correction in force until the hour cap ran out, and a real sleep would no longer discount presence.
 */
const STEP_CREDIT_RENEW_MS = 50;

export interface WatchdogOptions {
  stallMs?: number;
  intervalMs?: number;
  /** A monotonic clock in ms (tests). */
  now?: () => number;
  /** Wall clock (the health response, and noticing a sleep); tests fake it together with `now`. */
  wallNow?: () => number;
}

interface Slow { readonly op: string; readonly ms: number; readonly at: number }

export class LoopWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private lastWall = 0;
  /** What the wall clock lost against the monotonic one, not yet made up by a later gain. */
  private stepCredit = 0;
  /** When (monotonic) the credit's lifetime was last renewed: it lapses after STEP_CREDIT_TTL_MS. */
  private stepCreditAt = 0;
  private readonly stack: string[] = [];
  private slowest: Slow | null = null;
  private lastOp: string | null = null;
  private seq = 0;
  private readonly stallMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private totalLag = 0;
  private recent: { at: number; lagMs: number }[] = [];

  constructor(private readonly log: Logger, opts: WatchdogOptions = {}) {
    this.stallMs = opts.stallMs ?? STALL_MS;
    this.intervalMs = opts.intervalMs ?? WATCH_INTERVAL_MS;
    this.now = opts.now ?? (() => performance.now());
    this.wallNow = opts.wallNow ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.last = this.now();
    this.lastWall = this.wallNow();
    this.timer = setInterval(() => this.check(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Runs `fn` as the named operation (nested ones are named `outer > inner`). Its synchronous time is what a stall is
   * blamed on; a nested operation that took at least half of its caller's time names the stall more precisely, so it
   * is kept. Never changes what `fn` returns or throws.
   */
  track<T>(op: string, fn: () => T): T {
    const mark = this.seq;
    const outer = this.stack[this.stack.length - 1];
    const path = outer === undefined ? op : `${outer} > ${op}`;
    this.stack.push(path);
    this.lastOp = path;
    const t0 = this.now();
    try {
      return fn();
    } finally {
      this.stack.pop();
      const ms = this.now() - t0;
      const s = this.slowest;
      const innerNames = s !== null && s.at > mark && s.ms * 2 >= ms;
      if (!innerNames && (s === null || ms > s.ms)) this.slowest = { op: path, ms, at: ++this.seq };
    }
  }

  /**
   * How late the tick due now is, and how much the wall clock gained on the monotonic one since the last tick (slept):
   * `stall` is the event loop's own lateness, `slept` what remains of a gain past CLOCK_STEP_MS after backward drift is
   * credited. Every loss is credited. A gain of a second or less is not a sleep; it only spends that credit.
   */
  private measure(t = this.now(), wall = this.wallNow()): { stall: number; slept: number; credit: number; creditAt: number } {
    const monotonic = t - this.last;
    const drift = wall - this.lastWall - monotonic;
    const expired = t - this.stepCreditAt > STEP_CREDIT_TTL_MS;
    let credit = expired ? 0 : this.stepCredit;
    let creditAt = this.stepCreditAt;
    let slept = 0;
    if (drift < 0) {
      credit = Math.min(MAX_STEP_CREDIT_MS, credit - drift);
      // A loss of STEP_CREDIT_RENEW_MS or more renews the lifetime. The first loss after a lapse renews it
      // too, once the old credit has been discarded, so that loss can meet the next tick's gain. A
      // one-millisecond residual does not renew a credit that is still live.
      if (drift <= -STEP_CREDIT_RENEW_MS || expired) creditAt = t;
    } else if (drift > 0) {
      const made = Math.min(drift, credit);
      credit -= made;
      if (drift > CLOCK_STEP_MS) slept = drift - made;
    }
    return { stall: monotonic - this.intervalMs, slept, credit, creditAt };
  }

  /** One check (the interval's; tests call it directly): logs a stall when this tick is `stallMs` or more late. */
  check(): void {
    if (!this.timer) return;
    const t = this.now();
    const wall = this.wallNow();
    const m = this.measure(t, wall);
    this.last = t;
    this.lastWall = wall;
    this.stepCredit = m.credit;
    this.stepCreditAt = m.creditAt;
    const s = this.slowest;
    this.slowest = null;
    if (m.slept >= this.stallMs) {
      // Counted in what peers' last contact is discounted by, not in the lag shown on the dashboard.
      this.totalLag += m.slept;
      this.log.info("sleep_resume", { slept_ms: Math.round(m.slept) });
    }
    const lag = m.stall;
    if (lag < this.stallMs) return;
    this.totalLag += lag;
    this.recent = [...this.recent.filter((x) => this.wallNow() - x.at < 60_000), { at: this.wallNow(), lagMs: Math.round(lag) }];
    // An operation is blamed only when it held the loop for at least half the delay.
    const named = s !== null && s.ms * 2 >= lag ? s : null;
    this.log.warn("event_loop_stall", {
      lag_ms: Math.round(lag),
      op: named?.op ?? "untracked",
      ...(named ? { op_ms: Math.round(named.ms) } : {}),
      ...(this.lastOp !== null && this.lastOp !== named?.op ? { last_op: this.lastOp } : {}),
    });
  }

  /** Includes a late tick (or a sleep) even when a sync callback runs before the watchdog timer after it. */
  stallTotalMs(): number {
    if (this.timer) {
      const m = this.measure();
      if (m.stall >= this.stallMs || m.slept >= this.stallMs) this.check();
    }
    return this.totalLag;
  }

  recentLag(now = this.wallNow()): { max_ms: number; at: number } | null {
    this.stallTotalMs();
    const recent = this.recent.filter((x) => now - x.at >= 0 && now - x.at < 60_000);
    if (!recent.length) return null;
    const max = recent.reduce((a, b) => b.lagMs >= a.lagMs ? b : a);
    return { max_ms: max.lagMs, at: max.at };
  }
}

/** The running daemon's watchdog (one per process; the latest started), or none: `trackOp` then just runs `fn`. */
let active: LoopWatchdog | null = null;

export function startWatchdog(log: Logger, opts: WatchdogOptions = {}): LoopWatchdog {
  const w = new LoopWatchdog(log, opts);
  w.start();
  active = w;
  return w;
}

export function stopWatchdog(w: LoopWatchdog): void {
  w.stop();
  if (active === w) active = null;
}

/** Runs `fn` as a named operation of the running daemon's watchdog (see LoopWatchdog.track). */
export function trackOp<T>(op: string, fn: () => T): T {
  return active ? active.track(op, fn) : fn();
}
