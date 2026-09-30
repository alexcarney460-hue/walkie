/** One scheduled destroy at a time. The helper bounds its own work. */
export class CleanupQueue<T extends { ok: boolean }> {
  private readonly pending = new Map<number, { promise: Promise<T>; resolve: (value: T) => void; background: boolean }>();
  private readonly retries = new Map<number, { at: number; delay: number }>();
  private readonly failures = new Map<number, number>();
  private running: Promise<void> | null = null;
  private inFlight: number | null = null;
  private inFlightSince: number | null = null;
  private wake: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  constructor(private readonly destroy: (n: number) => Promise<T>,
    private readonly options: { retryBaseMs?: number; retryMaxMs?: number } = {}) {}

  get active(): { user: number; since: number } | null {
    return this.inFlight === null || this.inFlightSince === null ? null : { user: this.inFlight, since: this.inFlightSince };
  }

  waiting(n: number): boolean {
    return (this.inFlight !== null && this.inFlight !== n) || [...this.pending.keys()].some((id) => id !== n);
  }

  request(n: number): Promise<T> {
    return this.enqueue(n, false);
  }

  background(n: number): Promise<T> {
    return this.enqueue(n, true);
  }

  private failure(why: string): T { return { ok: false, why } as unknown as T; }

  private enqueue(n: number, background: boolean): Promise<T> {
    if (this.closed) return Promise.resolve(this.failure("seat cleanup deferred until restart"));
    const existing = this.pending.get(n);
    if (existing) {
      if (!background) existing.background = false;
      return existing.promise;
    }
    this.retries.delete(n);
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    this.pending.set(n, { promise, resolve, background });
    this.pump();
    return promise;
  }

  retryDelay(n: number): number | null { return this.retries.get(n)?.delay ?? null; }

  private pump(): void {
    if (this.running || !this.pending.size) return;
    this.running = this.runPending().finally(() => { this.running = null; if (!this.closed && this.pending.size) this.pump(); });
  }

  private async runPending(): Promise<void> {
    while (!this.closed && this.pending.size) {
      let n = Number.POSITIVE_INFINITY;
      for (const [id, item] of this.pending) if (!item.background && id < n) n = id;
      if (!Number.isFinite(n)) for (const id of this.pending.keys()) if (id < n) n = id;
      const item = this.pending.get(n) as NonNullable<ReturnType<typeof this.pending.get>>;
      this.inFlight = n;
      this.inFlightSince = Date.now();
      try {
        const result = await this.destroy(n);
        this.pending.delete(n);
        if (!result.ok && !this.closed) this.scheduleRetry(n);
        else { this.retries.delete(n); this.failures.delete(n); }
        item.resolve(result);
      } catch (error) {
        this.pending.delete(n);
        if (!this.closed) this.scheduleRetry(n);
        item.resolve(this.failure(error instanceof Error ? error.message : String(error)));
      } finally {
        this.inFlight = null;
        this.inFlightSince = null;
      }
    }
  }

  private scheduleRetry(n: number): void {
    const base = this.options.retryBaseMs ?? 60_000;
    const cap = this.options.retryMaxMs ?? 15 * 60_000;
    const delay = Math.min(cap, (this.failures.get(n) ?? 0) * 2 || base);
    this.failures.set(n, delay);
    this.retries.set(n, { at: Date.now() + delay, delay });
    this.armWake();
  }

  private armWake(): void {
    if (this.wake) clearTimeout(this.wake);
    let at = Number.POSITIVE_INFINITY;
    for (const retry of this.retries.values()) if (retry.at < at) at = retry.at;
    if (!Number.isFinite(at)) return;
    this.wake = setTimeout(() => {
      this.wake = null;
      const due = [...this.retries].filter(([, r]) => r.at <= Date.now()).map(([n]) => n).sort((a, b) => a - b);
      for (const n of due) {
        this.retries.delete(n);
        void this.enqueue(n, true);
      }
      this.armWake();
    }, Math.max(0, at - Date.now()));
  }

  /** Defer unstarted work to the helper ledger; wait only for the bounded in-flight attempt. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.wake) clearTimeout(this.wake);
    this.wake = null;
    this.retries.clear();
    for (const [n, item] of this.pending) {
      if (n === this.inFlight) continue;
      this.pending.delete(n);
      item.resolve(this.failure("seat cleanup deferred until restart"));
    }
    await this.running;
  }
}
