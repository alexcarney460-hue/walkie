import { z } from "zod";
import { NodeId } from "../../protocol/schemas.ts";

export const LEASE_RENEW_MS = 15_000;
export const SUPERVISOR_KILL_WINDOW_MS = 2_000;
export const LEASE_SKEW_MS = 1_000;
export const LEASE_HANDOFF_MS = SUPERVISOR_KILL_WINDOW_MS + LEASE_SKEW_MS;
export const LEASE_MS = 2 * LEASE_RENEW_MS;
export const LeadGrant = z.object({
  authority: NodeId, holder: NodeId.nullable(), epoch: z.number().int().nonnegative().safe(),
  expires_at: z.number().int().nonnegative().safe(),
  granted: z.boolean(), ttl_ms: z.number().int().min(1).max(LEASE_MS),
}).strict();
export type LeadGrant = z.infer<typeof LeadGrant>;
interface Record { epoch: number; holder: string | null }

/** One authority, synchronous durable grants. A restart waits out every possible previous grant. */
export class LeaseAuthority {
  private record: Record;
  private until: number;
  constructor(private readonly o: {
    load: () => string | null; save: (s: string) => void; now: () => number; wallNow?: () => number; ttl: number; epochFloor?: number; quarantine?: boolean;
  }) {
    const raw = o.load();
    const saved = raw === null ? null : z.object({ epoch: z.number().int().nonnegative().safe(), holder: NodeId.nullable(), ttl: z.number().int().min(1).max(LEASE_MS).optional() }).strict().parse(JSON.parse(raw));
    this.record = { epoch: Math.max(saved?.epoch ?? 0, o.epochFloor ?? 0), holder: null };
    this.until = saved || o.quarantine ? o.now() + (o.quarantine ? LEASE_MS : saved?.ttl ?? LEASE_MS) + LEASE_HANDOFF_MS : 0;
  }
  grant(authority: string, requester: string, preferred: string | null): LeadGrant {
    const now = this.o.now();
    const available = now >= this.until;
    if (requester !== preferred || (!available && this.record.holder !== requester)) return this.reply(authority, false);
    const next = { holder: requester, epoch: available ? this.record.epoch + 1 : this.record.epoch };
    if (!Number.isSafeInteger(next.epoch) || next.epoch >= (this.o.epochFloor ?? 0) + 1_000_000_000) throw new Error("orchestrator lease epoch exhausted");
    // Persist before acknowledging. A failed write never grants permission to act.
    this.o.save(JSON.stringify({ ...next, ttl: this.o.ttl }));
    this.record = next;
    this.until = now + this.o.ttl + LEASE_HANDOFF_MS;
    return this.reply(authority, true);
  }
  private reply(authority: string, granted: boolean): LeadGrant {
    return { authority, ...this.record, granted, expires_at: Math.max(0, (this.o.wallNow?.() ?? Date.now()) + this.o.ttl), ttl_ms: this.o.ttl };
  }
}

/** A holder measures from request SEND, never response receipt; network delay cannot extend its authority. */
export class LeaseHolder {
  private epoch = 0;
  private deadline = 0;
  private wallDeadline = 0;
  private authority: string | null = null;
  constructor(private readonly o: { self: string; now: () => number; wallNow?: () => number; lost: () => void }) {}
  valid(authority: string | null): boolean {
    return authority !== null && authority === this.authority && this.o.now() < this.deadline && this.wallNow() < this.wallDeadline;
  }
  accept(g: LeadGrant, sent: number, authority: string | null, sentWall = this.wallNow()): boolean {
    if (g.authority !== authority || g.epoch < this.epoch) return false;
    if (g.epoch > this.epoch || (this.authority !== null && this.authority !== authority)) this.invalidate();
    this.epoch = g.epoch;
    if (!g.granted || g.holder !== this.o.self) return false;
    const deadline = sent + g.ttl_ms - Math.min(1_000, g.ttl_ms / 10);
    const wallDeadline = sentWall + g.ttl_ms - Math.min(1_000, g.ttl_ms / 10);
    if (deadline <= this.o.now() || wallDeadline <= this.wallNow()) return false;
    this.authority = authority;
    this.deadline = deadline;
    this.wallDeadline = wallDeadline;
    return true;
  }
  private wallNow(): number { return this.o.wallNow?.() ?? Date.now(); }
  get expiresAt(): number { return this.wallDeadline; }
  get currentEpoch(): number { return this.epoch; }
  remaining(): number { return Math.max(0, Math.min(this.deadline - this.o.now(), this.wallDeadline - this.wallNow())); }
  invalidate(notify = true): void {
    const had = this.authority !== null;
    this.authority = null;
    this.deadline = 0;
    if (had && notify) this.o.lost();
  }
  check(authority: string | null): void { if (!this.valid(authority)) this.invalidate(); }
}
