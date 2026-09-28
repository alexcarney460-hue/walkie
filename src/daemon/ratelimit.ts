// Keyed token buckets for the local (per agent) and peer (per node) APIs.

export interface BucketSpec { readonly capacity: number; readonly perSecond: number }

export interface RateLimits {
  /** post / ask / answer by an agent (default 20 per minute). */
  readonly agentWrite: BucketSpec;
  /** post / ask / answer by a human via CLI/dashboard (default 60 per minute). */
  readonly humanWrite: BucketSpec;
  /** agent.status per agent (default 2/s). */
  readonly status: BucketSpec;
  /** peer API per peer (default 60 req/s). */
  readonly peer: BucketSpec;
  /** agent.status of one session's sub-agents together (default SUBAGENT_STATUS_LIMIT, WALKIE-MISSION-SUB-1). */
  readonly subagentStatus?: BucketSpec;
}

/** A session's sub-agents together: 6 statuses at once, 3/s sustained (each one's own 2/s bucket applies too). */
export const SUBAGENT_STATUS_LIMIT: BucketSpec = { capacity: 6, perSecond: 3 };

export const DEFAULT_LIMITS: RateLimits = {
  agentWrite: { capacity: 20, perSecond: 20 / 60 },
  humanWrite: { capacity: 60, perSecond: 1 },
  status: { capacity: 2, perSecond: 2 },
  peer: { capacity: 120, perSecond: 60 },
};

/** Global cap on tracked keys; the least recently used bucket is evicted first. */
export const MAX_BUCKETS = 512;

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  /** Whether a token is there now, without taking it (nor touching the bucket's LRU order). */
  can(key: string, spec: BucketSpec, now = Date.now()): boolean {
    const b = this.buckets.get(key);
    return (b ? Math.min(spec.capacity, b.tokens + ((now - b.at) / 1000) * spec.perSecond) : spec.capacity) >= 1;
  }

  /** Takes `n` tokens (default one); false = limited (nothing taken). */
  take(key: string, spec: BucketSpec, now = Date.now(), n = 1): boolean {
    const b = this.buckets.get(key);
    const tokens = b ? Math.min(spec.capacity, b.tokens + ((now - b.at) / 1000) * spec.perSecond) : spec.capacity;
    this.buckets.delete(key); // re-insert: Map order is the LRU order
    const ok = tokens >= n;
    this.buckets.set(key, { tokens: ok ? tokens - n : tokens, at: now });
    while (this.buckets.size > MAX_BUCKETS) this.buckets.delete(this.buckets.keys().next().value as string);
    return ok;
  }
}
