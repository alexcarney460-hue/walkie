// Replication (PROTOCOL §3): push on local write, anti-entropy pull on connect
// and every interval, liveness + rtt per peer, stubs for restricted channels.
import { stubOf } from "../protocol/header.ts";
import { eventId } from "../protocol/ids.ts";
import type { MachineStats } from "../protocol/machine-stats.ts";
import { MAX_PEER_RTT, type PoolShare } from "../protocol/pool.ts";
import { MAX_IDS_PER_FETCH, type Event, type Stub } from "../protocol/schemas.ts";
import type { AccountsSnapshot } from "../protocol/accounts.ts";
import type { Core } from "./core.ts";
import { PeerCallError, type PeerAddr, type PeerClient } from "./peer-client.ts";
import { addrLabel } from "./transport.ts";
import { flushRequests } from "./requests.ts";
import { activeNodes, canSeeChannel, isRestricted, nodeMember, pickTransport, type NodeRec } from "./roster.ts";

export interface SyncOptions { intervalMs?: number; livenessMs?: number; pushTimeoutMs?: number }

export interface PeerState {
  lastSeen: number | null; rtt: number | null; lastSync: number | null; behind: number; skewMs?: number;
  error?: string; running: boolean; chain: Promise<void>; queued: number; failedAt: number | null;
  /** The peer's machine stats from its last `vv` answer (kept while it is offline; cleared when it stops sending them). */
  stats?: MachineStats;
  /** The peer's accounts from its last `vv` answer (kept while it is offline; cleared when it stops sending them). */
  accounts?: AccountsSnapshot;
  /** The peer's split-run sharing state from its last `vv` answer (WALKIE-POOL-2); absent from older daemons. */
  pool?: PoolShare;
}

const MAX_QUEUED_PUSHES = 200;
const PULL_PAGE = 500;
/** Stub-fill pages per anti-entropy round (each ≤ MAX_IDS_PER_FETCH ids). */
const FILL_PAGES = 10;
/** Per-origin pull cursors kept past a held row (FINAL-2 Fable 6); cleared wholesale beyond this. */
const MAX_PULL_CURSORS = 4_096;
/** Node ids a peer may report as online in `/peer/v1/vv` (relayed liveness, mixed teams). */
const MAX_REPORTED_ONLINE = 1_024;

export class SyncManager {
  private readonly peers = new Map<string, PeerState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  readonly intervalMs: number; readonly livenessMs: number; readonly pushTimeoutMs: number;
  private lastOnline = new Map<string, boolean>();
  private flushing = false;
  /** Per origin: the highest seq received past a held row (resumeFrom). */
  private readonly pulled = new Map<string, number>();
  /**
   * Mixed teams: per peer this node syncs with, the nodes it reported online at its last `vv` (and when). A node
   * this machine shares no transport with is shown online while a reachable peer says it is.
   */
  private readonly reported = new Map<string, { at: number; online: ReadonlySet<string> }>();

  constructor(private readonly core: Core, private readonly client: PeerClient, opts: SyncOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.livenessMs = opts.livenessMs ?? 45_000;
    this.pushTimeoutMs = opts.pushTimeoutMs ?? 2_000;
  }

  start(): void {
    this.stopped = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  /** Whether anti-entropy is running (the peer link or Walkie Direct started it). */
  get running(): boolean { return this.timer !== null; }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Active peers this node can reach itself (a transport both serve, PROTOCOL §4 "Mixed teams"). */
  private peerNodes(): NodeRec[] {
    return activeNodes(this.core.roster).filter((n) => n.node_id !== this.core.nodeId && this.reachable(n));
  }

  private stateOf(nodeId: string): PeerState {
    let s = this.peers.get(nodeId);
    if (!s) {
      s = { lastSeen: null, rtt: null, lastSync: null, behind: 0, running: false, chain: Promise.resolve(), queued: 0, failedAt: null };
      this.peers.set(nodeId, s);
    }
    return s;
  }

  peerState(nodeId: string): PeerState | undefined { return this.peers.get(nodeId); }

  isOnline(nodeId: string, now = Date.now()): boolean {
    if (nodeId === this.core.nodeId) return true;
    if (this.reachedRecently(nodeId, now)) return true;
    // No shared transport: online while a peer that reaches it (and that we synced with just now) says so.
    const n = this.core.roster.nodes.get(nodeId);
    if (!n || this.reachable(n)) return false;
    for (const [peer, r] of this.reported) {
      if (now - r.at < this.livenessMs && r.online.has(nodeId) && this.reachedRecently(peer, now)) return true;
    }
    return false;
  }

  /** Whether this node shares a transport with `n` (the client's addressing decides). */
  private reachable(n: NodeRec): boolean { return this.client.addrOf(n) !== null; }

  private reachedRecently(nodeId: string, now: number): boolean {
    const s = this.peers.get(nodeId);
    return !!s?.lastSeen && now - s.lastSeen < this.livenessMs;
  }

  /** Nodes this machine reached itself within the liveness window (served in `/peer/v1/vv` as `online`). */
  reachedPeers(now = Date.now()): string[] {
    return [...this.peers.keys()].filter((id) => this.reachedRecently(id, now)).slice(0, MAX_REPORTED_ONLINE);
  }

  /** Measured round trips (ms) to the peers reached within the liveness window, at most MAX_PEER_RTT (WALKIE-POOL-2). */
  peerRtts(now = Date.now()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of this.reachedPeers(now).slice(0, MAX_PEER_RTT)) {
      const rtt = this.peers.get(id)?.rtt;
      if (typeof rtt === "number" && Number.isFinite(rtt)) out[id] = Math.max(0, Math.min(60_000, Math.round(rtt)));
    }
    return out;
  }

  /** How this node reaches a peer: the transport, or "relay" when they share none (PROTOCOL §4 "Mixed teams"). */
  via(n: NodeRec): "tailscale" | "direct" | "relay" {
    const addr = this.client.addrOf(n);
    return !addr ? "relay" : addr.pubkey ? "direct" : "tailscale";
  }

  tick(): void {
    if (this.stopped || !this.core.teamId) return;
    for (const n of this.peerNodes()) void this.antiEntropy(n);
    this.checkLiveness();
    void this.flushRequests();
  }

  /** After a roster request applied: pull the authority's origin so the new event is local. */
  readonly requestCatchUp = async (addr: PeerAddr, origin: string, seq: number): Promise<void> => {
    await this.catchUp(addr, origin, seq, origin); // the authority itself serves its origin
    this.core.drainPending();
  };

  /** Retries queued roster requests against the authority (PROTOCOL §2 "Roster requests"). */
  async flushRequests(): Promise<void> {
    if (this.flushing || this.stopped) return;
    this.flushing = true;
    try {
      await flushRequests(this.core, this.client, this.requestCatchUp);
    } catch (err) {
      this.core.log.warn("roster_requests_failed", { err: (err as Error).message });
    } finally {
      this.flushing = false;
    }
  }

  /** Roster changed: connect to peers we have never synced with; fill stubs that became visible. */
  rosterChanged(): void {
    if (this.stopped) return;
    for (const n of this.peerNodes()) if (!this.peers.has(n.node_id)) void this.antiEntropy(n);
    for (const n of this.peerNodes()) {
      const addr = this.client.addrOf(n);
      if (addr && this.isOnline(n.node_id) && this.core.fillableStubIds(1, n.node_id).length) {
        this.fillStubs(addr, n.node_id).catch(() => undefined);
      }
    }
  }

  private checkLiveness(): void {
    let changed = false;
    // Every active peer, reachable or not (a relayed one's liveness follows what its relays report).
    for (const n of activeNodes(this.core.roster)) {
      if (n.node_id === this.core.nodeId) continue;
      const on = this.isOnline(n.node_id);
      if (this.lastOnline.get(n.node_id) !== on) changed = true;
      this.lastOnline.set(n.node_id, on);
    }
    if (changed) { this.core.hub.nodesChanged(); this.core.hub.agentsChanged(); this.core.hub.accountsChanged(); }
  }

  private seen(nodeId: string): void {
    const s = this.stateOf(nodeId);
    s.lastSeen = Date.now();
    s.error = undefined;
    s.failedAt = null;
    this.checkLiveness();
  }

  private failed(nodeId: string, err: unknown): void {
    const s = this.stateOf(nodeId);
    s.error = err instanceof Error ? err.message : String(err);
    // Only a transport failure marks the peer unreachable (pushes skipped until it answers again);
    // an HTTP error means it is up but refused, e.g. it hasn't finished joining yet.
    s.failedAt = err instanceof PeerCallError && err.code === "unreachable" ? Date.now() : null;
    this.checkLiveness();
  }

  // ---- push -------------------------------------------------------------------

  /** What a given peer may receive for this event: the event itself or a tombstone stub. */
  payloadFor(ev: Event, peerNodeId: string): Event | Stub {
    const r = this.core.roster;
    if (!isRestricted(r, ev.channel)) return ev;
    const handle = nodeMember(r, peerNodeId)?.handle ?? null;
    return canSeeChannel(r, ev.channel, handle) ? ev : stubOf(ev);
  }

  /** Active peers, plus the nodes a removal/revocation just cut off (so they learn about it). */
  private pushTargets(ev: Event): NodeRec[] {
    const targets = this.peerNodes();
    const b = ev.body as { login?: string; role?: string; node_id?: string; revoked?: boolean };
    const cut = [...this.core.roster.nodes.values()].filter((n) =>
      n.node_id !== this.core.nodeId && this.reachable(n) &&
      ((ev.kind === "team.member" && b.role === "removed" && n.login === b.login) ||
       (ev.kind === "team.node" && b.revoked === true && n.node_id === b.node_id)));
    return [...targets, ...cut.filter((n) => !targets.some((t) => t.node_id === n.node_id))];
  }

  push(ev: Event): void {
    if (this.stopped) return;
    this.enqueuePushes(ev, this.pushTargets(ev), (t) => this.pushTargets(ev).find((x) => x.node_id === t));
  }

  /**
   * Mixed teams (PROTOCOL §3 "Relay"): an event its origin pushed to this node is pushed on, once, to the peers the
   * origin shares no transport with (a Tailscale-only machine's post to the Direct-only ones, and back), so live
   * delivery doesn't wait for their next anti-entropy round through this node. Only an event pushed by its own
   * origin is relayed (one hop, no loops); recipients and payload (event or stub) are decided at send time.
   */
  relay(ev: Event, from: string): void {
    if (this.stopped || from !== ev.origin || ev.origin === this.core.nodeId) return;
    this.enqueuePushes(ev, this.relayTargets(ev), (t) => this.relayTargets(ev).find((x) => x.node_id === t));
  }

  private relayTargets(ev: Event): NodeRec[] {
    const origin = this.core.roster.nodes.get(ev.origin);
    if (!origin) return [];
    return this.peerNodes().filter((n) => n.node_id !== ev.origin && pickTransport(origin, n) === null);
  }

  private enqueuePushes(ev: Event, targets: NodeRec[], current: (nodeId: string) => NodeRec | undefined): void {
    const now = Date.now();
    for (const n of targets) {
      const s = this.stateOf(n.node_id);
      // Known-offline peer: skip; anti-entropy delivers when it comes back.
      if (s.failedAt && !this.isOnline(n.node_id, now)) continue;
      if (s.queued >= MAX_QUEUED_PUSHES) continue;
      s.queued++;
      s.chain = s.chain.then(async () => {
        try {
          // D8: recipient and full-vs-stub payload are decided at send time, not when queued.
          const target = this.stopped ? undefined : current(n.node_id);
          const addr = target ? this.client.addrOf(target) : null;
          if (!target || !addr) return;
          // A status queued while sharing was wider, or superseded meanwhile, is not pushed (nor relayed): the pull
          // serves it under today's policy (MISSION-1 fix 5, Codex r4 #2). Pushes carry no capability, so the legacy
          // rules apply. Relays of a peer's status come through here too.
          if (ev.kind === "agent.status" && !this.core.serveStatusInFull(ev, { legacy: true })) return;
          await this.client.push(addr, [this.payloadFor(ev, target.node_id)], this.pushTimeoutMs);
          this.seen(n.node_id);
        } catch (err) {
          this.failed(n.node_id, err);
          this.core.log.debug("push_failed", { peer: n.node_id, err: (err as Error).message });
        } finally {
          s.queued--;
        }
      });
    }
  }

  // ---- anti-entropy -------------------------------------------------------------

  async antiEntropy(n: NodeRec): Promise<void> {
    const s = this.stateOf(n.node_id);
    if (s.running || this.stopped) return;
    s.running = true;
    try {
      const addr = this.client.addrOf(n);
      if (!addr) return; // no shared transport: its events come through the machines that serve both
      const t0 = performance.now();
      const w0 = Date.now();
      const peerVv = await this.client.vv(addr);
      s.rtt = Math.round(performance.now() - t0);
      if (typeof peerVv.ts === "number") s.skewMs = Math.round(peerVv.ts - (w0 + Date.now()) / 2);
      s.stats = peerVv.stats;
      s.pool = peerVv.pool;
      if (JSON.stringify(s.accounts ?? null) !== JSON.stringify(peerVv.accounts ?? null)) {
        s.accounts = peerVv.accounts;
        this.core.hub.accountsChanged();
      }
      this.reported.set(n.node_id, { at: Date.now(), online: new Set(peerVv.online ?? []) });
      this.seen(n.node_id);
      await this.pullAll(addr, peerVv.vv, n.node_id);
      await this.fillStubs(addr, n.node_id).catch((err: Error) => this.core.log.warn("stub_fill_failed", { peer: n.node_id, err: err.message }));
      s.behind = this.behind(peerVv.vv);
      s.lastSync = Date.now();
      this.core.hub.nodesChanged();
    } catch (err) {
      this.failed(n.node_id, err);
      if (!(err instanceof PeerCallError && err.code === "unreachable")) {
        this.core.log.warn("sync_failed", { peer: n.node_id, err: (err as Error).message });
      }
    } finally {
      s.running = false;
    }
  }

  behind(peerVv: Record<string, number>): number {
    const mine = this.core.store.vv();
    let n = 0;
    for (const [o, seq] of Object.entries(peerVv)) n += Math.max(0, seq - (mine[o] ?? 0));
    return n;
  }

  /**
   * Pulls every origin where the peer is ahead, the roster authority first so roster events land
   * early. A failure on one origin is logged and never stops the others (PROTOCOL §3).
   */
  async pullAll(addr: PeerAddr, peerVv: Record<string, number>, peer = addrLabel(addr)): Promise<void> {
    const r = this.core.roster;
    const first = this.core.authority ?? r.team?.founder;
    const origins = Object.keys(peerVv).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
    function rank(o: string): number { return o === first ? 0 : r.nodes.has(o) ? 1 : 2; }
    for (const origin of origins) {
      if (this.stopped) return;
      // A revoked origin's history the authority saw before the revocation stays valid and must stay pullable (D1).
      // Our own origin is never pulled: nobody else can hold events we don't (D3).
      if (origin === this.core.nodeId) continue;
      await this.catchUp(addr, origin, peerVv[origin] ?? 0, peer).catch((err: Error) =>
        this.core.log.warn("pull_failed", { origin, peer: addrLabel(addr), err: err.message }));
    }
    // Held rows whose dependency arrived drain on later ticks (F3); nothing is re-ingested wholesale.
  }

  /**
   * D4/R7: replaces stubs in channels this node can now see with full events from a peer. Stubs are
   * rotated fairly (never tried first, then least recently tried) and each unfilled one backs off
   * per (stub, peer) (C4): a peer that doesn't serve a stub only delays asking THAT peer again, so
   * every reachable peer is tried before a stub waits everywhere, and unfillable stubs can't starve the rest.
   */
  async fillStubs(addr: PeerAddr, peer = addrLabel(addr)): Promise<void> {
    for (let page = 0; page < FILL_PAGES && !this.stopped; page++) {
      const ids = this.core.fillableStubIds(MAX_IDS_PER_FETCH, peer);
      if (!ids.length) return;
      this.core.store.markStubsTried(ids, peer, Date.now());
      const { events } = await this.client.pullIds(addr, ids);
      for (const e of events) {
        if (typeof e === "object" && e !== null && (e as { redacted?: unknown }).redacted === true) continue;
        this.core.ingest(e, "remote", peer);
      }
    }
  }

  /**
   * Where a pull of `origin` starts (FINAL-2 Fable 6): the version vector, or, while the row right after
   * it is held (`future_ts` and the like pin the vector for as long as the hold lasts), the highest seq
   * already received past it, so the origin isn't re-fetched every round. An expired hold means a
   * real re-pull from the vector.
   */
  private resumeFrom(origin: string, mine: number): number {
    const upto = this.pulled.get(origin);
    if (upto === undefined) return mine;
    if (upto <= mine || !this.core.store.hasPending(eventId(origin, mine + 1))) { this.pulled.delete(origin); return mine; }
    return upto;
  }

  /** Records a pulled seq as received once the node keeps it (stored in any state, or held). */
  private notePulled(origin: string, seq: number): boolean {
    const id = eventId(origin, seq);
    if (!this.core.store.getRow(id) && !this.core.store.hasPending(id)) return false;
    if (this.pulled.size >= MAX_PULL_CURSORS) this.pulled.clear();
    if ((this.pulled.get(origin) ?? 0) < seq) this.pulled.set(origin, seq);
    return true;
  }

  /** Pulls one origin up to `target`, halving the page size when a response is too large (R6). */
  async catchUp(addr: PeerAddr, origin: string, target: number, peer = addrLabel(addr)): Promise<void> {
    let limit = PULL_PAGE;
    for (let page = 0; page < 10_000; page++) {
      const from = this.resumeFrom(origin, this.core.store.vvOf(origin));
      if (from >= target) break;
      let events: unknown[];
      try {
        ({ events } = await this.client.pull(addr, origin, from, limit));
      } catch (err) {
        if (!(err instanceof PeerCallError && err.code === "too_large") || limit === 1) throw err;
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      if (!Array.isArray(events) || events.length === 0) break;
      let expected = from + 1;
      let kept = true;
      for (const e of events) {
        const seq = (e as { seq?: unknown }).seq;
        if (seq !== expected) {
          this.core.log.warn("sync_gap", { origin, expected, got: seq, peer: addrLabel(addr) });
          return;
        }
        expected++;
        this.core.ingest(e, "remote", peer);
        if (kept) kept = this.notePulled(origin, seq); // a row not kept (pending_full) is where the next round resumes
      }
      if (this.resumeFrom(origin, this.core.store.vvOf(origin)) <= from) break; // nothing kept; retry next round
    }
  }
}
