import type { Core } from "../core.ts";
import { PeerCallError, type PeerClient } from "../peer-client.ts";
import { nodeMember } from "../roster.ts";
import { HttpError } from "../http.ts";
import { SCHEDULE_CHANNEL, nextRuns, validateCron, type Schedule } from "../../protocol/talkie-schedule.ts";
import { LEASE_RENEW_MS, LeaseAuthority, LeaseHolder, type LeadGrant } from "./lease.ts";
import { CLAIM_PREFIX, CLAIM_SKEW_MS, claimedSlotMark, claimRefusalFloor, compactClaims, loadScheduleClaims,
  saveScheduleClaims, signedClaimRecords, uncoveredAuthority, type ScheduleClaim, type ScheduleClaimResult } from "./schedule-claims.ts";
import { eligibleCapacityTargets, latestCapacityChecks } from "./capacity-asks.ts";
import { claimRetention, noteAuthorityCatchingUp, noteScheduleClockError, readSchedules, reconcileClaimedSlot, repairStalledNextRun, scheduleGeneration, seedScheduleIds, slotMarkTrip } from "./schedules.ts";
import { signSchedulePeer } from "./schedule-forward.ts";
export { ScheduleClaim } from "./schedule-claims.ts";

function validSlot(schedule: Schedule, claim: ScheduleClaim, now: number): boolean {
  if (claim.slot > now + CLAIM_SKEW_MS || (!claim.run_now && claim.slot !== schedule.next_run)) return false;
  if (schedule.last_run !== null && claim.slot <= schedule.last_run) return false;
  if (!claim.run_now) {
    try { if (nextRuns(schedule.cron, claim.slot - 60_000, 1)[0] !== claim.slot) return false; }
    catch { return false; }
    return true;
  }
  return claim.slot >= now - CLAIM_SKEW_MS &&
    (schedule.last_run === null || now - schedule.last_run >= 5 * 60_000);
}

/** Authority grants and the local renewable lease. No grants can be manufactured by an isolated standby. */
export class Leadership {
  private book: LeaseAuthority | null = null;
  private term = -1;
  private seededTerm = -1;
  private seededIds = new Set<string>();
  private readonly holder: LeaseHolder;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private expires: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private pending: Promise<boolean> | null = null;
  private generation = 0;
  private lastLeaseFailure: PeerCallError | null = null;
  constructor(private readonly o: {
    core: Core; client?: PeerClient; preferred: () => string | null; lost: () => void; renewMs?: number; canRequest?: () => boolean;
    now?: () => number; monoNow?: () => number;
  }) {
    this.holder = new LeaseHolder({ self: o.core.nodeId, now: () => this.monoNow(), wallNow: () => this.wallNow(), lost: o.lost });
    if (o.core.isAuthority()) this.prepareBook();
  }
  get expiresAt(): number { return this.holder.expiresAt; }
  get epoch(): number { return this.holder.currentEpoch; }
  get valid(): boolean { this.holder.check(this.o.core.authority); return this.holder.valid(this.o.core.authority); }
  get leaseFailure(): PeerCallError | null { return this.lastLeaseFailure; }
  holds(node: string, epoch: number): boolean {
    if (!this.o.core.isAuthority()) return false;
    this.prepareBook();
    return this.book?.holds(node, epoch) ?? false;
  }
  grant(node: string): LeadGrant {
    const { core } = this.o;
    if (!core.isAuthority()) throw new HttpError(409, "not_authority", "only the roster authority grants leadership");
    const member = nodeMember(core.roster, node);
    if (!member || member.role === "observer") throw new HttpError(403, "forbidden", "this node cannot hold leadership");
    this.prepareBook();
    if (this.seededTerm === this.term) this.pruneClaims();
    return this.book!.grant(core.nodeId, node, this.o.preferred() ?? node);
  }
  /** Append the authority-signed claim post and durable local decision in one transaction before replying. */
  claimFromPeer(node: string, claim: ScheduleClaim): ScheduleClaimResult {
    const { core } = this.o;
    if (!core.isAuthority()) throw new HttpError(409, "not_authority", "only the roster authority claims schedule runs");
    this.prepareBook();
    if (!this.book?.holds(node, claim.epoch)) return { claimed: false };
    const now = this.wallNow();
    const previous = uncoveredAuthority(core);
    if (previous) {
      const schedule = readSchedules(core).find((entry) => entry.id === claim.schedule);
      if (schedule) noteAuthorityCatchingUp(core, schedule, previous, now);
      return { claimed: false, reason: "authority_catching_up" };
    }
    const schedules = readSchedules(core);
    const schedule = schedules.find((s) => s.id === claim.schedule);
    if (!schedule?.enabled) return { claimed: false };
    try { validateCron(schedule.cron, now); } catch { return { claimed: false }; }
    if (!core.store.claimIndexReady) return { claimed: false, reason: "migration_pending" };
    this.ensureSeeded(now, claim.schedule);
    const retention = claimRetention(core);
    const loaded = compactClaims(loadScheduleClaims(core, this.term), now, retention);
    const mark = claimedSlotMark(loaded, claim.schedule, schedule.last_run);
    const interval = nextRuns(schedule.cron, now, 2);
    const maxAdvance = Math.min(Math.max(interval[1]! - interval[0]!, 60 * 60_000), 48 * 60 * 60_000);
    if (mark !== null && mark.value > now + maxAdvance) {
      noteScheduleClockError(core, schedule, slotMarkTrip(mark), now);
      return { claimed: false, reason: "clock_error" };
    }
    if (mark !== null && claim.slot <= mark.value) {
      const prior = loaded.find((entry) => !entry.reset && entry.schedule === claim.schedule &&
        schedule.next_run !== null && entry.slot >= schedule.next_run &&
        (schedule.last_run === null || entry.slot > schedule.last_run));
      if (prior && now - prior.at >= CLAIM_SKEW_MS) reconcileClaimedSlot(core, schedule, prior, now);
      else if (!prior) repairStalledNextRun(core, schedule, now);
      return { claimed: false, reason: "just_ran" };
    }
    const latest = loaded.find((entry) => !entry.reset && entry.schedule === claim.schedule);
    if (claim.run_now && latest && now - Math.max(latest.slot, latest.at) < 5 * 60_000)
      return { claimed: false, reason: "just_ran" };
    if (!validSlot(schedule, claim, now)) return { claimed: false };
    const checked = latestCapacityChecks(schedules);
    for (const saved of loaded) for (const [target, at] of Object.entries(saved.checks))
      checked[target] = Math.max(checked[target] ?? 0, at);
    const targets = "template" in schedule.task && schedule.task.template === "capacity-check"
      ? eligibleCapacityTargets(core, claim.capacity_targets ?? [], now, checked) : [];
    const { capacity_targets: _proposed, ...fields } = claim;
    const refusalFloor = claimRefusalFloor(loaded, claim.schedule);
    const record = { ...fields, holder: node, term: this.term, after: core.authorityClaimTerms[this.term]?.after ?? null,
      at: now, checks: Object.fromEntries(targets.map((target) => [target, now])),
      ...(refusalFloor === null ? {} : { refusal_floor: refusalFloor }) };
    const post = core.store.transaction(() => {
      const post = core.emit("msg.post", { text: CLAIM_PREFIX + JSON.stringify(record) }, { channel: SCHEDULE_CHANNEL });
      saveScheduleClaims(core, this.term, compactClaims([...loaded, { ...record, origin: post.origin, seq: post.seq }], now, retention));
      return post;
    }, { durable: true });
    return { claimed: true, claim: { term: this.term, seq: post.seq,
      generation: scheduleGeneration(core, claim.schedule) },
      ...(targets.length ? { capacity_targets: targets } : {}) };
  }
  async claimSchedule(schedule: string, slot: number, run: string, runNow = false,
    capacityTargets?: readonly string[]): Promise<ScheduleClaimResult> {
    const { core, client } = this.o;
    if (!this.valid) return { claimed: false };
    const claim = { schedule, slot, run, epoch: this.epoch,
      ...(runNow ? { run_now: true } : {}), ...(capacityTargets ? { capacity_targets: [...capacityTargets] } : {}) };
    if (core.authority === core.nodeId) return this.claimFromPeer(core.nodeId, claim);
    const node = core.authority ? core.roster.nodes.get(core.authority) : null;
    const addr = node && client?.addrOf(node);
    if (!addr || !client) throw new HttpError(503, "authority_unreachable", "the schedule authority is unreachable");
    try {
      const result = await client.scheduleClaim(addr, signSchedulePeer(core, "schedule-claim", claim));
      return this.valid && this.epoch === claim.epoch ? result : { claimed: false };
    } catch (err) {
      if (err instanceof PeerCallError && err.status === 404)
        throw new HttpError(409, "authority_outdated", node.hostname + " runs an older Walkie; update it");
      if (err instanceof PeerCallError && ["clock_skew", "stale_run", "forbidden", "rate_limited", "just_ran"].includes(err.code))
        throw new HttpError(err.status, err.code, err.message);
      throw new HttpError(503, "authority_unreachable", node.hostname + " is unreachable");
    }
  }
  private prepareBook(): void {
    const { core } = this.o;
    const term = core.authorityLeaseTerm;
    if (term === this.term) return;
    const key = `orchestrator_lease_${term}`;
    this.book = new LeaseAuthority({ load: () => core.store.getMeta(key), save: (s) => core.store.setMeta(key, s),
      now: () => this.monoNow(), wallNow: () => this.wallNow(), ttl: 2 * this.everyMs,
      epochFloor: term * 1_000_000_000, quarantine: term > 0 });
    this.term = term;
    this.seededTerm = -1;
  }
  /** Seed the predecessor's signed claims once per term, then per schedule on its first claim: a schedule whose puts
   * arrive after the term was seeded must not lose the slot the predecessor already acknowledged. */
  private ensureSeeded(now: number, schedule: string): void {
    if (this.seededTerm !== this.term) {
      const ids = seedScheduleIds(this.o.core, now);
      this.seed(now, ids);
      this.seededIds = new Set(ids);
      this.seededTerm = this.term;
    }
    const retained = loadScheduleClaims(this.o.core, this.term).some((claim) => claim.schedule === schedule);
    if (this.seededIds.has(schedule) && retained) return;
    this.seededIds.delete(schedule);
    this.seed(now, [schedule]);
    this.seededIds.add(schedule);
  }
  private seed(now: number, ids: Iterable<string>): void {
    const { core } = this.o;
    const local = loadScheduleClaims(core, this.term);
    const signed = signedClaimRecords(core, now, ids);
    const byId = new Map([...signed, ...local].map((claim) => [`${claim.origin}:${claim.seq}`, claim]));
    saveScheduleClaims(core, this.term, compactClaims([...byId.values()], now, claimRetention(core)));
  }
  private pruneClaims(): void {
    const { core } = this.o;
    const claims = loadScheduleClaims(core, this.term);
    const kept = compactClaims(claims, this.wallNow(), claimRetention(core));
    if (kept.length !== claims.length) saveScheduleClaims(core, this.term, kept);
  }
  private wallNow(): number { return this.o.now?.() ?? Date.now(); }
  private monoNow(): number { return this.o.monoNow?.() ?? performance.now(); }
  private get everyMs(): number { return Math.max(50, Math.min(LEASE_RENEW_MS, this.o.renewMs ?? LEASE_RENEW_MS)); }
  acquire(): Promise<boolean> {
    this.wanted = true;
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => { void this.acquire(); }, this.everyMs);
      this.renewTimer.unref?.();
    }
    if (this.pending) return this.pending;
    this.pending = this.request().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async request(): Promise<boolean> {
    const { core, client } = this.o;
    if (this.o.canRequest && !this.o.canRequest()) { this.holder.invalidate(); return false; }
    const generation = this.generation;
    this.holder.check(core.authority);
    const authority = core.authority;
    const sent = performance.now();
    const sentWall = Date.now();
    try {
      const node = authority ? core.roster.nodes.get(authority) : null;
      if (!node) return false;
      const addr = client?.addrOf(node);
      const g = authority === core.nodeId ? this.grant(core.nodeId)
        : client && addr ? await client.leadLease(addr, signSchedulePeer(core, "lease", {})) : null;
      if (!this.wanted || generation !== this.generation || authority !== core.authority) return false;
      if (g && this.holder.accept(g, sent, authority, sentWall)) {
        this.lastLeaseFailure = null;
        if (this.expires) clearTimeout(this.expires);
        this.expires = setTimeout(() => this.holder.check(core.authority), this.holder.remaining() + 1);
        this.expires.unref?.();
      }
    } catch (err) {
      if (this.wanted && generation === this.generation)
        this.lastLeaseFailure = err instanceof PeerCallError ? err : null;
      core.log.warn("orchestrator_lease_unavailable", { err: String(err).slice(0, 200) });
    }
    return this.valid;
  }
  stop(): void {
    this.wanted = false;
    this.generation++;
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.expires) clearTimeout(this.expires);
    this.renewTimer = null; this.expires = null;
    this.holder.invalidate(false);
    this.lastLeaseFailure = null;
  }
}
