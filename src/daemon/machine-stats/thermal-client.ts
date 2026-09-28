// Runs the macOS temperature read (darwin-thermal.ts, native IOKit calls) in a Bun Worker with a deadline, so a slow
// or stuck native call never blocks the daemon's event loop. The native calls NEVER run on the daemon thread: when
// the worker can't start or fails, the temperature is reported unavailable and a new worker is tried later, with a
// growing delay (RETRY_BASE_MS doubling up to RETRY_MAX_MS).
//
// A worker is retired cooperatively: it is asked to release its CoreFoundation references and close the native
// libraries, then exits itself. It counts as gone only when its "close" event fires; until then no new worker starts.
// If it hasn't closed within the grace period (a native call that never returns), it is terminated and, because Bun
// terminates asynchronously and a thread stuck in native code may never actually stop, worker creation is turned off
// until restart: at most one worker is ever abandoned. A read that misses the deadline retires its worker; after
// MAX_TIMEOUTS in a row, or MAX_TOTAL_TIMEOUTS since start (so intermittent successes can't reset the count forever),
// the reader is turned off until restart. A native crash inside the worker still ends the whole process: a worker is
// a thread, not a process (docs/SECURITY.md).
import type { Sensor } from "./parse.ts";

declare const WALKIE_EMBEDDED: boolean | undefined;

export interface ThermalResult { sensors: Sensor[] | null; error: string | null }

export const DEFAULT_DEADLINE_MS = 2_000;
export const MAX_TIMEOUTS = 3;
export const MAX_TOTAL_TIMEOUTS = 10;
/** How long a retiring worker gets to release its native resources and exit before it is terminated. */
export const RETIRE_GRACE_MS = 30_000;
/** After a worker fails to start or errors: the first retry delay, doubled per failure up to RETRY_MAX_MS. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 60 * 60_000;

/** The worker entry: next to this file in a source checkout, at the bundle root's relative path in a release binary. */
function workerSpec(): string {
  const embedded = typeof WALKIE_EMBEDDED !== "undefined" && WALKIE_EMBEDDED === true;
  return embedded ? "./daemon/machine-stats/thermal-worker.ts" : new URL("./thermal-worker.ts", import.meta.url).href;
}

export interface ThermalClientOptions {
  deadlineMs?: number;
  retireGraceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Tests inject a worker; default the thermal-worker.ts entry. */
  spawn?: () => Worker;
  clock?: () => number;
}

type Reply = { id?: number; closed?: boolean } & Partial<ThermalResult>;

export class ThermalClient {
  private worker: Worker | null = null;
  /** A worker asked to close whose "close" event hasn't fired: no new worker starts meanwhile (kept for good if forced). */
  private retiring: Worker | null = null;
  /** Workers whose "close" event has fired (a worker that fails to load may close before it is retired). */
  private readonly exited = new WeakSet<Worker>();
  private seq = 0;
  private timeouts = 0;
  private totalTimeouts = 0;
  private failures = 0;
  private retryAt = 0;
  private disabled: string | null = null;
  private readonly deadlineMs: number;
  private readonly graceMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly spawn: () => Worker;
  private readonly clock: () => number;

  constructor(opts: ThermalClientOptions = {}) {
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.graceMs = opts.retireGraceMs ?? RETIRE_GRACE_MS;
    this.retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = opts.retryMaxMs ?? RETRY_MAX_MS;
    this.spawn = opts.spawn ?? (() => new Worker(workerSpec()));
    this.clock = opts.clock ?? Date.now;
  }

  /** One reading; never rejects and never runs a native call on this thread. */
  async read(): Promise<ThermalResult> {
    if (this.disabled) return { sensors: null, error: this.disabled };
    if (this.retiring) return { sensors: null, error: "the previous temperature read is still finishing" };
    const now = this.clock();
    if (now < this.retryAt) return { sensors: null, error: `temperature worker unavailable; retrying in ${Math.ceil((this.retryAt - now) / 1000)} s` };
    let w: Worker;
    try {
      w = this.worker ??= this.start();
    } catch (err) {
      return this.failed(`temperature worker could not start: ${(err as Error).message}`);
    }
    const id = ++this.seq;
    return new Promise<ThermalResult>((resolve) => {
      const done = (r: ThermalResult): void => {
        clearTimeout(timer);
        w.removeEventListener("message", onMessage);
        w.removeEventListener("error", onError);
        resolve(r);
      };
      const onMessage = (e: MessageEvent<Reply>): void => {
        if (e.data?.id !== id) return;
        this.timeouts = 0;
        this.failures = 0;
        done({ sensors: Array.isArray(e.data.sensors) ? e.data.sensors : null, error: typeof e.data.error === "string" ? e.data.error : null });
      };
      const onError = (e: Event): void => {
        this.retire(w);
        done(this.failed(`temperature worker failed: ${(e as ErrorEvent).message ?? "error"}`));
      };
      const timer = setTimeout(() => {
        this.retire(w);
        this.timeouts++;
        this.totalTimeouts++;
        const msg = `temperature read took longer than ${this.deadlineMs} ms`;
        if (this.timeouts >= MAX_TIMEOUTS) this.disabled = `${msg} ${MAX_TIMEOUTS} times in a row; turned off until restart`;
        else if (this.totalTimeouts >= MAX_TOTAL_TIMEOUTS) this.disabled = `${msg} ${MAX_TOTAL_TIMEOUTS} times since start; turned off until restart`;
        done({ sensors: null, error: this.disabled ?? msg });
      }, this.deadlineMs);
      w.addEventListener("message", onMessage);
      w.addEventListener("error", onError);
      w.postMessage({ id });
    });
  }

  close(): void {
    this.disabled ??= "closed";
    const w = this.worker;
    if (w) this.retire(w);
  }

  private failed(error: string): ThermalResult {
    this.failures++;
    this.retryAt = this.clock() + Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (this.failures - 1));
    return { sensors: null, error };
  }

  private start(): Worker {
    const w = this.spawn();
    (w as { unref?: () => void }).unref?.();
    w.addEventListener("close", () => this.exited.add(w));
    return w;
  }

  /**
   * Asks the worker to release its native resources and exit (thermal-worker.ts handles {type:"close"}). It counts as
   * gone only when its "close" event fires. If that hasn't happened within the grace period it is terminated and
   * worker creation is turned off until restart: termination is asynchronous, a thread in a native call that never
   * returns may never stop, so it stays `retiring` (tracked, never replaced).
   */
  private retire(w: Worker): void {
    if (this.worker === w) this.worker = null;
    if (this.exited.has(w)) return;
    this.retiring = w;
    const gone = (): void => {
      clearTimeout(grace);
      w.removeEventListener("close", gone);
      if (this.retiring === w) this.retiring = null;
    };
    const grace = setTimeout(() => {
      w.removeEventListener("close", gone);
      try { w.terminate(); } catch { /* already gone */ }
      this.disabled = `the temperature worker did not stop within ${this.graceMs} ms; turned off until restart`;
    }, this.graceMs);
    (grace as { unref?: () => void }).unref?.();
    w.addEventListener("close", gone);
    try { w.postMessage({ type: "close" }); } catch { /* the grace timer handles a worker that can't be asked */ }
  }
}
