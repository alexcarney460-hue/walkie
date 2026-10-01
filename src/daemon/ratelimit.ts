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
  /**
   * Bulk board writes by a person (LINEAR-IMPORT-1, `POST /v1/projects/:channel/batch`): one token per signed op, per
   * person key; never the interactive limiter. Default IMPORT_WRITE_LIMIT.
   */
  readonly importWrite?: BucketSpec;
}

/** 10 000 ops at once (a large Linear workspace's open issues and their history comments), refilled 10 000 per hour. */
export const IMPORT_WRITE_LIMIT: BucketSpec = { capacity: 10_000, perSecond: 10_000 / 3600 };

/** A session's sub-agents together: 6 statuses at once, 3/s sustained (each one's own 2/s bucket applies too). */
export const SUBAGENT_STATUS_LIMIT: BucketSpec = { capacity: 6, perSecond: 3 };

/**
 * Admission of NEW Hermes sessions per profile: it preserves a same-session hook burst while bounding a faulty hook that
 * mints sessions. Updates of known sessions take no token; they are bounded by the status coalescer and the row caps
 * (hermes-status.ts), not by this bucket.
 */
export const HERMES_HOOK_LIMIT: BucketSpec = { capacity: 64, perSecond: 8 };

export const DEFAULT_LIMITS: RateLimits = {
  agentWrite: { capacity: 20, perSecond: 20 / 60 },
  humanWrite: { capacity: 60, perSecond: 1 },
  status: { capacity: 2, perSecond: 2 },
  peer: { capacity: 120, perSecond: 60 },
  importWrite: IMPORT_WRITE_LIMIT,
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

  /** The tokens in the bucket now (without taking any). */
  available(key: string, spec: BucketSpec, now = Date.now()): number {
    const b = this.buckets.get(key);
    return b ? Math.min(spec.capacity, b.tokens + ((now - b.at) / 1000) * spec.perSecond) : spec.capacity;
  }

  /** Return tokens for an operation whose transaction rolled back; never exceed the bucket's capacity. */
  refund(key: string, spec: BucketSpec, n: number, now = Date.now()): void {
    const tokens = Math.min(spec.capacity, this.available(key, spec, now) + n);
    this.buckets.set(key, { tokens, at: now });
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
