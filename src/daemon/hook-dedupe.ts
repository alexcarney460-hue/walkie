// A bounded memory of the hook deliveries this daemon has applied, so one hook event that reaches it twice is applied
// once (src/protocol/hook-delivery.ts). It keys on what the event is, never on what is configured: two Walkie installs,
// a stale or hand-edited hook file, or the same hook registered in two files all end here the same way.

/** How long a delivery is remembered: far longer than two hooks of one event take to arrive (a hook's timeout is 5 s). */
export const DELIVERY_TTL_MS = 60_000;
/** The most deliveries remembered at once; the oldest go first, so a flood of distinct events cannot grow the daemon. */
export const MAX_DELIVERIES = 4_096;

export class RecentDeliveries {
  /** key -> when it was first seen. Insertion order is age order: a repeat never re-inserts. */
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = DELIVERY_TTL_MS,
    private readonly max = MAX_DELIVERIES,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get size(): number { return this.seen.size; }

  /**
   * True the first time `key` arrives inside the window (apply it), false for a repeat (drop it). The window runs from
   * the first sighting: a repeat does not extend it.
   */
  firstSeen(key: string): boolean {
    const t = this.now();
    for (const [k, at] of this.seen) {
      if (t - at < this.ttlMs) break;
      this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, t);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
}
