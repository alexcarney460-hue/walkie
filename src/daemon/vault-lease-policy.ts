import { readFileSync } from "node:fs";
import type { BucketSpec } from "./ratelimit.ts";

export const DEFAULT_LEASE_LIMIT = 10;
export const MAX_OWN_LEASE_LIMIT = 256;
/** Announced in `/peer/v1/vv` capabilities: this vault holder accepts `launcher` in a lease request (older holders
 *  refuse any unknown field with 400 invalid). */
export const LEASE_LAUNCHER_CAP = "lease_launcher_v1";
const BASE_LEASE_BUCKET: BucketSpec = { capacity: DEFAULT_LEASE_LIMIT, perSecond: DEFAULT_LEASE_LIMIT / 3600 };
/** Total hand-outs to this person's machines from one vault-holding daemon, across borrower nodes. */
export const MAX_OWN_PERSON_LEASES_PER_HOUR = 256;

const ownPersonBuckets = new WeakMap<object, { tokens: number; at: number }>();

/** A dedicated bucket cannot be evicted by the general peer limiter's 512-key LRU. */
export function ownPersonLeaseAvailable(holder: object, now: number): boolean {
  const bucket = ownPersonBuckets.get(holder);
  return !bucket || Math.min(MAX_OWN_PERSON_LEASES_PER_HOUR,
    bucket.tokens + Math.max(0, now - bucket.at) * MAX_OWN_PERSON_LEASES_PER_HOUR / 3_600_000) >= 1;
}

export function takeOwnPersonLease(holder: object, now: number): boolean {
  const bucket = ownPersonBuckets.get(holder);
  const tokens = bucket ? Math.min(MAX_OWN_PERSON_LEASES_PER_HOUR,
    bucket.tokens + Math.max(0, now - bucket.at) * MAX_OWN_PERSON_LEASES_PER_HOUR / 3_600_000) : MAX_OWN_PERSON_LEASES_PER_HOUR;
  if (tokens < 1) return false;
  ownPersonBuckets.set(holder, { tokens: tokens - 1, at: now });
  return true;
}

export function validOwnLeaseLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= DEFAULT_LEASE_LIMIT && value <= MAX_OWN_LEASE_LIMIT;
}

/** Owner-local opt-in; an absent, malformed or unreadable setting keeps the historical budget. */
export function readOwnLeaseLimit(configPath: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(configPath, "utf8"))?.vault_own_lease_limit;
    return validOwnLeaseLimit(value) ? value : DEFAULT_LEASE_LIMIT;
  } catch { return DEFAULT_LEASE_LIMIT; }
}

/**
 * The bucket a hand-out to `callerNode` draws on. Every request uses the fixed base of 10 per node per hour, except an
 * owner-launched seat of the vault holder's own person (grantLease decides that from the authenticated login and the
 * relayed launcher) once its configured limit is above 10: that one uses a separately keyed bucket, so teammate-launched
 * seats, launcher-less requests and older peers on the same node can neither spend it nor shrink it. At the default
 * both share the historical base. Owner-launched hand-outs charged to that shared base are remembered, and the first
 * time the separate bucket is created it starts at the new limit minus those (an existing bucket is not re-seeded).
 */
export function vaultLeaseBudget(configPath: string, callerNode: string, ownerLaunched: boolean): { key: string; spec: BucketSpec } {
  const own = ownerLaunched ? readOwnLeaseLimit(configPath) : DEFAULT_LEASE_LIMIT;
  return own > DEFAULT_LEASE_LIMIT
    ? { key: `vault-lease:${callerNode}:owner-launched`, spec: { capacity: own, perSecond: own / 3600 } }
    : { key: `vault-lease:${callerNode}`, spec: BASE_LEASE_BUCKET };
}

/** Hand-out, probe and usage-refresh budgets. One record per node id; unrelated limiter keys cannot evict one. */
export type NodeLeaseKind = "base" | "owner" | "probe" | "usage";

/**
 * `admitted`: a current member's non-revoked node. `gone`: the id is on the roster but not that (revoked, or its
 * member was removed). `unknown`: no roster record (a direct unit-test caller). Only `unknown` may draw without
 * ever having been admitted.
 */
export type RosterLeaseState = "admitted" | "gone" | "unknown";

/**
 * Team lifetime node-id cap (SECURITY admissions). A new id past this is refused. A live budget is never dropped to
 * make room: that was the eviction that reset an exhausted cap.
 */
const MAX_LEASE_NODES = 1024;

interface LeaseSlot { tokens: number; at: number }
interface NodeBudgets {
  /** True once `admitted` said this id was on the roster. Never-admitted ids (direct unit-test callers) stay false. */
  admitted: boolean;
  /**
   * Was admitted, and the roster no longer says so. Takes fail until it is admitted again; the slots are kept, so coming
   * back continues the cap it left with (refilled by the time away), never a fresh one (Codex pre.12 audit SHOULD 4).
   */
  gone: boolean;
  base?: LeaseSlot;
  owner?: LeaseSlot;
  probe?: LeaseSlot;
  usage?: LeaseSlot;
  /**
   * Owner-launched hand-outs charged to the shared base slot while the limit was still 10. The first time the
   * separate owner slot is created, it starts at its capacity minus what this slot has spent. Other base hand-outs
   * are not counted: a limit that was already above 10 keeps a bucket other requests cannot shrink.
   */
  ownerSeed?: LeaseSlot;
}

const nodeBudgets = new WeakMap<object, Map<string, NodeBudgets>>();

function budgetsOf(holder: object): Map<string, NodeBudgets> {
  let map = nodeBudgets.get(holder);
  if (!map) { map = new Map(); nodeBudgets.set(holder, map); }
  return map;
}

/** The same refill the shared RateLimiter uses, including a clock that steps backwards. A missing slot is full. */
function level(slot: LeaseSlot | undefined, spec: BucketSpec, now: number): number {
  if (!slot) return spec.capacity;
  return Math.min(spec.capacity, slot.tokens + ((now - slot.at) / 1000) * spec.perSecond);
}

/**
 * Notice a node that is not an admitted member. A full slot is kept while the node stays admitted: dropping it would
 * make the next higher capacity look full, and the shared limiter did not do that. A roster node that is not admitted
 * draws nothing, and its slots are kept: revoking and readmitting a node does not reset its hourly cap.
 */
function settle(rec: NodeBudgets, nodeId: string, view: ((id: string) => RosterLeaseState) | undefined): "ok" | "denied" {
  if (!view) return "ok";
  const state = view(nodeId);
  if (state === "admitted") {
    rec.gone = false;
    rec.admitted = true;
    return "ok";
  }
  // No roster record, and this id was never admitted here: direct unit-test callers.
  if (state === "unknown" && !rec.admitted) return "ok";
  rec.gone = true;
  rec.admitted = true;
  return "denied";
}

function sweep(map: Map<string, NodeBudgets>, view: (id: string) => RosterLeaseState, skip: string): void {
  for (const [id, rec] of map) if (id !== skip) settle(rec, id, view);
}

/** Whether a token is there, without taking one and without creating a record. */
export function nodeLeaseAvailable(holder: object, nodeId: string, spec: BucketSpec, kind: NodeLeaseKind, now: number, view?: (id: string) => RosterLeaseState): boolean {
  if (view?.(nodeId) === "gone" && !nodeBudgets.get(holder)?.has(nodeId)) return false;
  const rec = nodeBudgets.get(holder)?.get(nodeId);
  if (!rec) return true;
  if (settle(rec, nodeId, view) === "denied") return false;
  return level(rec[kind], spec, now) >= 1;
}

/** How many owner-launched hand-outs the base slot has already charged this hour. A missing seed has charged none. */
function ownerSeedSpent(slot: LeaseSlot | undefined, now: number): number {
  if (!slot) return 0;
  const left = level(slot, BASE_LEASE_BUCKET, now);
  return Math.min(BASE_LEASE_BUCKET.capacity, Math.max(0, BASE_LEASE_BUCKET.capacity - left));
}

/**
 * Takes one token. False = limited (nothing taken). A failed take still moves the refill clock, as RateLimiter does.
 * `noteOwnerOnBase`: this take is an owner-launched hand-out that still draws on the shared base (the limit is 10).
 * A successful one is remembered on `ownerSeed`, so the first time the separate owner slot is created it starts at
 * its capacity minus those hand-outs. An owner slot that already exists is left alone.
 */
export function takeNodeLease(holder: object, nodeId: string, spec: BucketSpec, kind: NodeLeaseKind, now: number, view?: (id: string) => RosterLeaseState, noteOwnerOnBase = false): boolean {
  const map = budgetsOf(holder);
  if (view) sweep(map, view, nodeId);
  let rec = map.get(nodeId);
  if (!rec) {
    if (map.size >= MAX_LEASE_NODES) return false;
    rec = { admitted: false, gone: false };
    map.set(nodeId, rec);
  }
  if (settle(rec, nodeId, view) === "denied") return false;
  if (kind === "owner" && !rec.owner) {
    const spent = ownerSeedSpent(rec.ownerSeed, now);
    if (spent > 0) rec.owner = { tokens: Math.max(0, spec.capacity - spent), at: now };
  }
  const tokens = level(rec[kind], spec, now);
  const ok = tokens >= 1;
  rec[kind] = { tokens: ok ? tokens - 1 : tokens, at: now };
  if (ok && noteOwnerOnBase && kind === "base") {
    const left = level(rec.ownerSeed, BASE_LEASE_BUCKET, now);
    rec.ownerSeed = { tokens: left - 1, at: now };
  }
  return ok;
}
