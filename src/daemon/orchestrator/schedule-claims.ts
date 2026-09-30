import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Core } from "../core.ts";
import { SCHEDULE_CHANNEL } from "../../protocol/talkie-schedule.ts";

export const CLAIM_SKEW_MS = 5_000;
export const CLAIM_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const CLAIMS_PER_SCHEDULE = 50;
/** A removed schedule's newest claim outlives its removal by this long, then is dropped. */
export const REMOVED_CLAIM_WINDOW_MS = 48 * 60 * 60_000;
export const MAX_STORED_CLAIMS = 20 * CLAIMS_PER_SCHEDULE;
export const MAX_CAPACITY_TARGETS = 64;
export const CLAIM_PREFIX = "walkie-talkie-claim:v1:";
const Targets = z.array(z.string().min(1).max(256)).max(MAX_CAPACITY_TARGETS);
const Checks = z.record(z.string().min(1).max(256), z.number().int().nonnegative().safe())
  .refine((checks) => Object.keys(checks).length <= MAX_CAPACITY_TARGETS);

export const ScheduleClaim = z.object({
  schedule: z.string().uuid(), slot: z.number().int().nonnegative().safe(),
  run: z.string().uuid(), epoch: z.number().int().nonnegative().safe(), run_now: z.boolean().optional(),
  capacity_targets: Targets.optional(),
}).strip();
export type ScheduleClaim = z.infer<typeof ScheduleClaim>;
export const ScheduleClaimIdentity = z.object({ term: z.number().int().nonnegative().safe(),
  seq: z.number().int().positive().safe(), generation: z.number().int().nonnegative().safe() }).strict();
export type ScheduleClaimIdentity = z.infer<typeof ScheduleClaimIdentity>;
export const ScheduleClaimResult = z.object({ claimed: z.boolean(), claim: ScheduleClaimIdentity.optional(),
  reason: z.enum(["authority_catching_up", "migration_pending", "just_ran", "clock_error"]).optional(), capacity_targets: Targets.optional() }).strip();
export type ScheduleClaimResult = z.infer<typeof ScheduleClaimResult>;

export const ClaimRecord = ScheduleClaim.extend({
  holder: z.string().min(1), term: z.number().int().nonnegative().safe(),
  after: z.string().nullable(), at: z.number().int().nonnegative().safe(), checks: Checks,
  reset: z.literal(true).optional(),
  refusal_floor: z.number().int().nonnegative().safe().optional(),
}).strip();
export type ClaimRecord = z.infer<typeof ClaimRecord>;
const StoredClaim = ClaimRecord.extend({ origin: z.string().min(1), seq: z.number().int().positive().safe() });
export type StoredClaim = z.infer<typeof StoredClaim>;
export function indexedClaim(text: unknown): Pick<ClaimRecord, "schedule" | "at" | "term" | "after"> | null {
  if (typeof text !== "string" || !text.startsWith(CLAIM_PREFIX)) return null;
  try {
    const parsed = ClaimRecord.safeParse(JSON.parse(text.slice(CLAIM_PREFIX.length)));
    if (!parsed.success) return null;
    const { schedule, at, term, after } = parsed.data;
    return { schedule, at, term, after };
  } catch { return null; }
}
const StoredClaims = z.object({ term: z.number().int().nonnegative().safe(),
  claims: z.array(StoredClaim).max(MAX_STORED_CLAIMS) });
const CLAIMS_KEY = "orchestrator_claims";

/** Which stored records belong to a schedule that still exists and when the others were removed. */
export interface ClaimRetention { live: ReadonlySet<string>; removedAt: ReadonlyMap<string, number> }

/**
 * Keep a live schedule's latest decision indefinitely and only fresh rows among its latest 50. With retention, a
 * removed schedule keeps only its newest record, only for the 48 h after its removal, and the store never exceeds its
 * cap: the removals furthest in the past are evicted first and a live schedule's record never is.
 */
export function compactClaims(claims: readonly StoredClaim[], now: number, retention?: ClaimRetention): StoredClaim[] {
  const counts = new Map<string, number>();
  const reset = new Set<string>();
  const kept = [...claims].sort((a, b) => b.term - a.term || b.seq - a.seq)
    .filter((c) => {
      if (reset.has(c.schedule)) return false;
      if (c.reset) reset.add(c.schedule);
      const n = counts.get(c.schedule) ?? 0;
      counts.set(c.schedule, n + 1);
      return n === 0 || (n < CLAIMS_PER_SCHEDULE && (c.reset || c.at >= now - CLAIM_RETENTION_MS));
    });
  return retention ? retainRemoved(kept, now, retention) : kept;
}

function retainRemoved(kept: readonly StoredClaim[], now: number, retention: ClaimRetention): StoredClaim[] {
  const newest = new Map<string, StoredClaim>();
  let live = 0;
  for (const claim of kept) {
    if (retention.live.has(claim.schedule)) live++;
    else if (!newest.has(claim.schedule)) newest.set(claim.schedule, claim);
  }
  const removedSince = (claim: StoredClaim): number => retention.removedAt.get(claim.schedule) ?? claim.at;
  const room = Math.max(0, MAX_STORED_CLAIMS - live);
  const survivors = new Set([...newest.values()].filter((claim) => now - removedSince(claim) < REMOVED_CLAIM_WINDOW_MS)
    .sort((a, b) => removedSince(b) - removedSince(a) || b.seq - a.seq || a.schedule.localeCompare(b.schedule))
    .slice(0, room));
  return kept.filter((claim) => retention.live.has(claim.schedule) || survivors.has(claim));
}

export function claimRefusalFloor(claims: readonly StoredClaim[], schedule: string): number | null {
  const floors = claims.filter((claim) => claim.schedule === schedule)
    .map((claim) => claim.refusal_floor ?? (claim.reset ? claim.at : null))
    .filter((floor): floor is number => floor !== null);
  return floors.length ? Math.max(...floors) : null;
}

/** The claimed-slot high-water mark and the record it came from, so a refusal can name what tripped it. */
export interface SlotMark { value: number; source: "last_run" | "claim" | "refusal_floor"; origin?: string }

export function claimedSlotMark(claims: readonly StoredClaim[], schedule: string, lastRun: number | null): SlotMark | null {
  const marks: SlotMark[] = lastRun === null ? [] : [{ value: lastRun, source: "last_run" }];
  for (const claim of claims) {
    if (claim.schedule !== schedule) continue;
    if (!claim.reset) marks.push({ value: claim.slot, source: "claim", origin: claim.origin });
    const floor = claim.refusal_floor ?? (claim.reset ? claim.at : null);
    if (floor !== null) marks.push({ value: floor, source: "refusal_floor", origin: claim.origin });
  }
  return marks.reduce<SlotMark | null>((top, mark) => top === null || mark.value >= top.value ? mark : top, null);
}

/** A person-authorized reset is an authority-signed barrier in the same indexed stream as claims. */
export function resetScheduleClaims(core: Core, schedule: string, now: number, lastRun: number | null,
  maxAdvance: number, retention?: ClaimRetention): number {
  if (!core.isAuthority()) throw new Error("reset must run on the roster authority machine");
  if (!core.store.claimIndexReady) throw new Error("schedule claim migration is still running");
  const term = core.authorityLeaseTerm;
  const claims = compactClaims([...signedClaimRecords(core, now, [schedule]), ...loadScheduleClaims(core, term)], now, retention);
  const priorFloor = claimRefusalFloor(claims, schedule);
  const limit = now + maxAdvance;
  const sane = (value: number | null): number => value !== null && value <= limit ? value : 0;
  const pastSlots = claims.filter((claim) => claim.schedule === schedule && !claim.reset && claim.slot <= limit)
    .map((claim) => claim.slot);
  const refusalFloor = Math.max(now, sane(lastRun), sane(priorFloor), ...pastSlots);
  const record = { schedule, slot: 0, run: randomUUID(), epoch: 0, holder: core.nodeId,
    term, after: core.authorityClaimTerms[term]?.after ?? null, at: now, checks: {}, reset: true as const,
    refusal_floor: refusalFloor };
  core.store.transaction(() => {
    const post = core.emit("msg.post", { text: CLAIM_PREFIX + JSON.stringify(record) }, { channel: SCHEDULE_CHANNEL });
    saveScheduleClaims(core, term, compactClaims([...claims, { ...record, origin: post.origin, seq: post.seq }], now, retention));
    core.store.deleteMeta(`schedule_clock_error:${schedule}`);
  }, { durable: true });
  return refusalFloor;
}

export function loadScheduleClaims(core: Core, term: number): StoredClaim[] {
  const raw = core.store.getMeta(CLAIMS_KEY);
  if (raw === null) return [];
  const saved = StoredClaims.parse(JSON.parse(raw));
  if (saved.term > term) throw new Error("schedule claim store is ahead of authority term");
  return saved.term === term ? saved.claims : [];
}

export function saveScheduleClaims(core: Core, term: number, claims: readonly StoredClaim[]): void {
  const value = JSON.stringify(StoredClaims.parse({ term, claims }));
  core.store.transaction(() => core.store.setMeta(CLAIMS_KEY, value), { durable: true });
}

/** Read only each live schedule's bounded, indexed claim tail and durable latest post. */
export function signedClaimRecords(core: Core, now: number, schedules: Iterable<string>): StoredClaim[] {
  const terms = core.authorityClaimTerms;
  const claims: StoredClaim[] = [];
  for (const schedule of schedules) for (const row of core.store.scheduleClaimEvents(
    schedule, now - CLAIM_RETENTION_MS, CLAIMS_PER_SCHEDULE, terms)) {
    let decoded: unknown;
    try {
      const text = (JSON.parse(row.json) as { body?: { text?: unknown } }).body?.text;
      if (typeof text !== "string" || !text.startsWith(CLAIM_PREFIX)) continue;
      decoded = JSON.parse(text.slice(CLAIM_PREFIX.length));
    } catch { continue; }
    const candidate = decoded as { term?: unknown } | null;
    const term = candidate && Number.isSafeInteger(candidate.term) ? terms[candidate.term as number] : undefined;
    if (!term || row.origin !== term.authority) continue;
    const parsed = ClaimRecord.safeParse(decoded);
    if (!parsed.success) continue;
    const record = parsed.data;
    if (record.after !== term.after ||
      row.seq <= term.floor || (term.ceiling !== null && row.seq >= term.ceiling)) continue;
    if (record.schedule !== schedule) continue;
    claims.push({ ...record, origin: row.origin, seq: row.seq });
  }
  return compactClaims(claims, now);
}

/** Only the previous authority's signed stream can contain its acknowledged claims. */
export function uncoveredAuthority(core: Core): string | null {
  const wm = core.authorityTransferWatermark;
  const prior = core.authorityClaimTerms?.at(-2)?.authority;
  const missing = core.store.unfilledAuthorityOrigin?.(SCHEDULE_CHANNEL, core.authorityClaimTerms ?? []);
  if (missing) return missing;
  if (!wm || !prior) return null;
  const vv = core.store.vv();
  return (vv[prior] ?? 0) < (wm[prior] ?? 0) ? prior : null;
}
