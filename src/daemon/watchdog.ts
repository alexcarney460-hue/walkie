// Event-loop stall watchdog (DAEMON-STALL-1). A daemon whose one thread sits in a long synchronous call (a SQLite
// statement on a busy disk) stays alive but answers nothing: requests on its socket time out. This names the cause:
// a timer checks how late it fires, and a tick `stallMs` or more late logs `event_loop_stall` with the operation that
// ran longest since the previous check (when it held the loop for at least half the delay; else `untracked`).
// Operations are named by wrapping them in `trackOp` (route dispatch, the periodic jobs): it costs two clock reads per
// call. An async operation's continuation after an `await` runs outside its wrapper, so the log also names the
// operation that started last (`last_op`), usually the one that continued.
import type { Logger } from "./logger.ts";

/** A tick this late is a stall. */
export const STALL_MS = 500;
/** How often the loop is checked. */
export const WATCH_INTERVAL_MS = 250;

export interface WatchdogOptions {
  stallMs?: number;
  intervalMs?: number;
  /** A monotonic clock in ms (tests). */
  now?: () => number;
  /** Wall clock for the health response (tests). */
  wallNow?: () => number;
}

interface Slow { readonly op: string; readonly ms: number; readonly at: number }

export class LoopWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
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

  /** One check (the interval's; tests call it directly): logs a stall when this tick is `stallMs` or more late. */
  check(): void {
    if (!this.timer) return;
    const t = this.now();
    const lag = t - this.last - this.intervalMs;
    this.last = t;
    const s = this.slowest;
    this.slowest = null;
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

  /** Includes a late tick even when a sync callback runs before the watchdog timer after a stall. */
  stallTotalMs(): number {
    if (this.timer && this.now() - this.last - this.intervalMs >= this.stallMs) this.check();
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
