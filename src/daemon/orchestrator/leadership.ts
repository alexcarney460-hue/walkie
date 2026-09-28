import type { Core } from "../core.ts";
import type { PeerClient } from "../peer-client.ts";
import { nodeMember } from "../roster.ts";
import { HttpError } from "../http.ts";
import { LEASE_RENEW_MS, LeaseAuthority, LeaseHolder, type LeadGrant } from "./lease.ts";

/** Authority grants and the local renewable lease. No grants can be manufactured by an isolated standby. */
export class Leadership {
  private book: LeaseAuthority | null = null;
  private term = -1;
  private readonly holder: LeaseHolder;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private expires: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private pending: Promise<boolean> | null = null;
  private generation = 0;
  constructor(private readonly o: {
    core: Core; client?: PeerClient; preferred: () => string | null; lost: () => void; renewMs?: number; canRequest?: () => boolean;
  }) {
    this.holder = new LeaseHolder({ self: o.core.nodeId, now: () => performance.now(), wallNow: Date.now, lost: o.lost });
    if (o.core.isAuthority()) this.prepareBook();
  }
  get expiresAt(): number { return this.holder.expiresAt; }
  get epoch(): number { return this.holder.currentEpoch; }
  get valid(): boolean { this.holder.check(this.o.core.authority); return this.holder.valid(this.o.core.authority); }
  grant(node: string): LeadGrant {
    const { core } = this.o;
    if (!core.isAuthority()) throw new HttpError(409, "not_authority", "only the roster authority grants leadership");
    const member = nodeMember(core.roster, node);
    if (!member || member.role === "observer") throw new HttpError(403, "forbidden", "this node cannot hold leadership");
    this.prepareBook();
    return this.book!.grant(core.nodeId, node, this.o.preferred() ?? node);
  }
  private prepareBook(): void {
    const { core } = this.o;
    const term = core.authorityLeaseTerm;
    if (term === this.term) return;
    const key = `orchestrator_lease_${term}`;
    this.book = new LeaseAuthority({ load: () => core.store.getMeta(key), save: (s) => core.store.setMeta(key, s),
      now: () => performance.now(), wallNow: Date.now, ttl: 2 * this.everyMs, epochFloor: term * 1_000_000_000, quarantine: term > 0 });
    this.term = term;
  }
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
        : client && addr ? await client.leadLease(addr) : null;
      if (!this.wanted || generation !== this.generation || authority !== core.authority) return false;
      if (g && this.holder.accept(g, sent, authority, sentWall)) {
        if (this.expires) clearTimeout(this.expires);
        this.expires = setTimeout(() => this.holder.check(core.authority), this.holder.remaining() + 1);
        this.expires.unref?.();
      }
    } catch (err) {
      core.log.debug("orchestrator_lease_unavailable", { err: (err as Error).message.slice(0, 200) });
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
  }
}
