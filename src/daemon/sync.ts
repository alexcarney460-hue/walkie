import { PeerCapabilities } from "../protocol/capabilities.ts";
import { peerCapabilities, recordPeerProof, recordPeerSignature, rememberPeerCapabilities, rememberValidPeerSignature, validPeerProof } from "./peer-capabilities.ts";
// Replication (PROTOCOL §3): push on local write, anti-entropy pull on connect
// and every interval, liveness + rtt per peer, stubs for restricted channels.
import { stubOf } from "../protocol/header.ts";
import { eventId } from "../protocol/ids.ts";
import type { MachineStats } from "../protocol/machine-stats.ts";
import { MAX_PEER_RTT, type PoolShare } from "../protocol/pool.ts";
import { MAX_IDS_PER_FETCH, PeerVvRelay, type Event, type Stub } from "../protocol/schemas.ts";
import type { AccountsSnapshot } from "../protocol/accounts.ts";
import type { Core } from "./core.ts";
import { PeerCallError, type PeerAddr, type PeerClient } from "./peer-client.ts";
import { addrLabel } from "./transport.ts";
import { flushRequests } from "./requests.ts";
import { activeNodes, canSeeChannel, isRestricted, nodeMember, pickTransport, type NodeRec } from "./roster.ts";
import { trackOp } from "./watchdog.ts";
import { SSH_REVOCATION_CAP } from "./ssh/team-revocation.ts";

export interface SyncOptions {
  intervalMs?: number; livenessMs?: number; pushTimeoutMs?: number;
  /** Injectable clocks keep local stalls and elapsed liveness deterministic in tests. */
  now?: () => number; stallTotal?: () => number;
  /**
   * This daemon should run Walkie Direct but its endpoint is not up (DirectLink.pending; set once that exists, main.ts).
   * While it holds, `unreached()` reports nothing: the machine reaches nobody over Direct, which is not a fact about the team.
   */
  directPending?: () => boolean;
}

export interface PeerState {
  lastSeen: number | null; rtt: number | null; lastSync: number | null; behind: number; skewMs?: number;
  /**
   * The START of the latest sync after which this node held everything the peer's version vector listed. The vector is
   * read after that start, so everything the peer had logged by then is here. Unset until such a sync. Unlike `lastSync`
   * (stamped when the pull ends) it never claims events the peer logged while the pull ran.
   */
  levelAt?: number | null;
  error?: string; running: boolean; chain: Promise<void>; queued: number; failedAt: number | null;
  lastSeenStall?: number;
  /**
   * When one of OUR calls last succeeded (a push, or a sync round), as `lastSeen` but never moved by the peer's own
   * requests: whether the peer can be reached from here. Pushes and the `online` list served to others follow this, not
   * the presence `lastSeen` (WALK-87).
   */
  lastReached?: number;
  lastReachedStall?: number;
  /** Only heard from so far (its own requests): none of our calls has been made to it, so a roster change still syncs it. */
  heardOnly?: boolean;
  sshRevocationCap?: boolean;
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

/**
 * PRESENCE RULE (WALK-87). A machine is online while it was reached within `livenessMs` of HEALTHY time: the time since
 * the last contact, less what this daemon spent stalled (watchdog.ts) in between. A stall of this daemon is not evidence
 * about any peer, so:
 *  - a peer is never aged by the length of a stall of ours (`healthyElapsed`, also for the relayed reports);
 *  - a call that failed or timed out across a stall of ours says nothing about the peer (`failed`);
 *  - contact is the peer's request too, not only the reply to ours (`heard`): a peer that stalled shows online the moment
 *    it speaks again. That is presence only: pushes, the `online` list we serve and round trip times follow our own calls.
 * Agents follow their machine (`effectiveState`), so none of them turns offline because of the stall, and none is archived
 * or pruned for it. (A working or waiting status nobody refreshed for 30 minutes still reads offline, as it always did:
 * after a stall or sleep longer than that it does until the agent's next status.)
 */
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
  private readonly reported = new Map<string, { at: number; stall: number; online: ReadonlySet<string> }>();
  /** Verified proofs awaiting the authority; the signed envelopes also live in local store metadata. */
  private readonly pendingPeerProofs = new Map<string, PeerVvRelay>();
  private readonly peerProofRetry = new Map<string, { failures: number; nextAt: number }>();
  private peerProofFlush: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly stallTotal: () => number;
  private readonly directPending: () => boolean;

  constructor(private readonly core: Core, private readonly client: PeerClient, opts: SyncOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.livenessMs = opts.livenessMs ?? 45_000;
    this.pushTimeoutMs = opts.pushTimeoutMs ?? 2_000;
    this.now = opts.now ?? Date.now;
    this.stallTotal = opts.stallTotal ?? (() => 0);
    this.directPending = opts.directPending ?? (() => false);
    for (const { key, value } of core.store.listMeta("pending_peer_proof:")) {
      try {
        const parsed = PeerVvRelay.safeParse(JSON.parse(value));
        if (parsed.success && key === `pending_peer_proof:${parsed.data.node}`) {
          this.pendingPeerProofs.set(parsed.data.node, parsed.data);
          continue;
        }
      } catch { /* corrupt local metadata is discarded below */ }
      core.store.deleteMeta(key);
    }
  }

  start(): void {
    this.stopped = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => trackOp("sync", () => this.tick()), this.intervalMs);
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

  /** The state of a peer for one of OUR calls to it (`heard` makes it for a peer's own request). */
  private stateOf(nodeId: string): PeerState {
    let s = this.peers.get(nodeId);
    if (!s) {
      s = { lastSeen: null, rtt: null, lastSync: null, behind: 0, running: false, chain: Promise.resolve(), queued: 0, failedAt: null };
      this.peers.set(nodeId, s);
    }
    if (s.heardOnly) s.heardOnly = false;
    return s;
  }

  peerState(nodeId: string): PeerState | undefined { return this.peers.get(nodeId); }

  /**
   * The owner SSH startup gate: this process must hold the roster authority's view of the team log.
   * A target that is not the authority needs a successful pull of the authority's full vector since this start,
   * and nothing else counts: another peer may lack receipts the authority holds, and the authority being
   * unreachable keeps SSH closed. The authority's own replayed log holds the receipts it stored itself, so no
   * one sits above it; it still waits for every peer it can reach, because a receipt it could not write locally
   * survives only on peers.
   */
  sshTeamConfirmed(): boolean {
    const syncedSinceStart = (id: string): boolean => {
      const state = this.peers.get(id);
      return !!state?.lastSync && state.lastSync >= this.core.startedAt && state.behind === 0 && state.sshRevocationCap === true;
    };
    const authority = this.core.authority;
    if (!authority) return false;
    if (authority !== this.core.nodeId) return syncedSinceStart(authority);
    const peers = this.peerNodes();
    return peers.length > 0 && peers.every((peer) => syncedSinceStart(peer.node_id));
  }

  peerCapabilities(nodeId: string): PeerCapabilities | undefined {
    return peerCapabilities(this.core.store, nodeId);
  }

  rememberCapabilities(nodeId: string, value: PeerCapabilities | undefined): void {
    rememberPeerCapabilities(this.core.store, nodeId, value);
  }

  isOnline(nodeId: string, now = this.now()): boolean {
    if (nodeId === this.core.nodeId) return true;
    if (this.reachedRecently(nodeId, now)) return true;
    // No shared transport: online while a peer that reaches it (and that we synced with just now) says so.
    const n = this.core.roster.nodes.get(nodeId);
    if (!n || this.reachable(n)) return false;
    for (const [peer, r] of this.reported) {
      if (this.healthyElapsed(r.at, r.stall, now) < this.livenessMs && r.online.has(nodeId) && this.reachedRecently(peer, now)) return true;
    }
    return false;
  }

  /**
   * The active machines this one shares no transport with (a Tailscale-only machine and a Direct-only one, PROTOCOL §4
   * "Mixed teams"; never itself), each with whether it shows online. Such a machine is online here only on the word of
   * a machine that reaches it (`isOnline`; or for a moment after this one last reached it itself). Without that it
   * shows offline and its agents are hidden on this machine. Not an observer's machine (an observer publishes no agent
   * status, so nothing of theirs is hidden), and nothing at all while this daemon's own Walkie Direct endpoint is not up
   * but should be (`directPending`): it then reaches no machine over Direct, whoever they are. One pass over the roster,
   * no I/O.
   */
  unreached(now = this.now()): { node: NodeRec; vouched: boolean }[] {
    if (this.directPending()) return [];
    const roster = this.core.roster;
    return activeNodes(roster)
      .filter((n) => n.node_id !== this.core.nodeId && nodeMember(roster, n.node_id)?.role !== "observer" && !this.reachable(n))
      .map((node) => ({ node, vouched: this.isOnline(node.node_id, now) }));
  }

  /** Whether this node shares a transport with `n` (the client's addressing decides). */
  private reachable(n: NodeRec): boolean { return this.client.addrOf(n) !== null; }

  private reachedRecently(nodeId: string, now: number): boolean {
    const s = this.peers.get(nodeId);
    return s?.lastSeen !== null && s?.lastSeen !== undefined
      && this.healthyElapsed(s.lastSeen, s.lastSeenStall ?? 0, now) < this.livenessMs;
  }

  /** Whether one of our own calls reached the peer within the liveness window (healthy time): not moved by its requests. */
  private reachedByUs(nodeId: string, now: number): boolean {
    const s = this.peers.get(nodeId);
    return s?.lastReached !== undefined && this.healthyElapsed(s.lastReached, s.lastReachedStall ?? 0, now) < this.livenessMs;
  }

  private healthyElapsed(at: number, stallAt: number, now: number): number {
    return Math.max(0, now - at - Math.max(0, this.stallTotal() - stallAt));
  }

  /**
   * Nodes this machine reached itself (a call of OURS succeeded) within the liveness window, served in `/peer/v1/vv` as
   * `online`. A peer that only called us is not in it: we cannot vouch to others that we can reach it.
   */
  reachedPeers(now = this.now()): string[] {
    return [...this.peers.keys()].filter((id) => this.reachedByUs(id, now)).slice(0, MAX_REPORTED_ONLINE);
  }

  /** Measured round trips (ms) to the peers our calls reached within the liveness window, at most MAX_PEER_RTT (WALKIE-POOL-2). */
  peerRtts(now = this.now()): Record<string, number> {
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
    void this.flushPeerProofs();
  }

  private flushPeerProofs(): Promise<void> {
    if (this.peerProofFlush) return this.peerProofFlush;
    this.peerProofFlush = this.sendPeerProofs()
      .catch((err: unknown) => this.core.log.warn("peer_proof_relay_failed", { err: err instanceof Error ? err.message : String(err) }))
      .finally(() => { this.peerProofFlush = null; });
    return this.peerProofFlush;
  }

  private async sendPeerProofs(): Promise<void> {
    if (this.stopped) return;
    for (const [id, proof] of this.pendingPeerProofs) {
      const node = this.core.roster.nodes.get(id);
      if (node?.peer_sig_v1 || !node || !nodeMember(this.core.roster, id)
        || !validPeerProof(this.core, proof, this.core.nodeId)) {
        this.forgetPeerProof(id);
      }
    }
    if (!this.pendingPeerProofs.size) return;
    if (this.core.isAuthority()) {
      for (const [id, proof] of this.pendingPeerProofs) {
        try {
          const result = recordPeerProof(this.core, proof, this.core.nodeId);
          if (result === "recorded" || result === "invalid") this.forgetPeerProof(id);
        } catch (err) {
          this.core.log.warn("peer_proof_local_failed", { node: id, err: err instanceof Error ? err.message : String(err) });
        }
      }
      return;
    }
    const authority = this.core.authority ? this.core.roster.nodes.get(this.core.authority) : undefined;
    const addr = authority ? this.client.addrOf(authority) : null;
    if (!addr) return;
    for (const [id, proof] of this.pendingPeerProofs) {
      if (Date.now() < (this.peerProofRetry.get(id)?.nextAt ?? 0)) continue;
      try {
        if ((await this.client.reportPeerProof(addr, proof)).recorded) this.forgetPeerProof(id);
        else this.deferPeerProof(id);
      } catch (err) {
        this.core.log.warn("peer_proof_relay_failed", { node: id, err: err instanceof Error ? err.message : String(err) });
        this.deferPeerProof(id);
      }
    }
  }

  private forgetPeerProof(id: string): void {
    this.pendingPeerProofs.delete(id);
    this.peerProofRetry.delete(id);
    this.core.store.deleteMeta(`pending_peer_proof:${id}`);
  }

  private deferPeerProof(id: string): void {
    const failures = Math.min(10, (this.peerProofRetry.get(id)?.failures ?? 0) + 1);
    const delay = Math.min(60_000, 1_000 * 2 ** (failures - 1));
    this.peerProofRetry.set(id, { failures, nextAt: Date.now() + delay });
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
    for (const n of this.peerNodes()) {
      const s = this.peers.get(n.node_id);
      if (!s || s.heardOnly) void this.antiEntropy(n);
    }
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

  /**
   * A request from this peer reached us through the gate (a known machine of a current member, signature checked where it
   * carries one): it is up and talking, as surely as a reply to one of ours. Its presence (`lastSeen`, what `isOnline` and
   * the dashboards judge) moves to now, so a peer that stalled for a minute shows online again the moment it speaks (its
   * first call after the stall), not at our next round, and the stall's own length is kept out of the window like any
   * other (`healthyElapsed`). Presence only: what OUR calls found is left alone (`failedAt`, `error`, `lastReached`), so
   * a peer that can reach us but that we cannot reach (Direct behind NAT, a one-way ACL) still gets no pushes, and is not
   * vouched for to other machines or given a round trip time, until a call of ours succeeds. Only machines this one can
   * reach itself; one it hears of only through relays stays judged by what those relays report.
   */
  heard(nodeId: string): void {
    if (this.stopped || nodeId === this.core.nodeId) return;
    const n = this.core.roster.nodes.get(nodeId);
    if (!n || n.revoked || !nodeMember(this.core.roster, nodeId) || !this.reachable(n)) return;
    let s = this.peers.get(nodeId);
    if (!s) {
      s = { lastSeen: null, rtt: null, lastSync: null, behind: 0, running: false, chain: Promise.resolve(), queued: 0, failedAt: null, heardOnly: true };
      this.peers.set(nodeId, s);
    }
    s.lastSeen = this.now();
    s.lastSeenStall = this.stallTotal();
    if (this.lastOnline.get(nodeId) !== true) this.checkLiveness(); // it was shown offline (or never judged): tell the dashboards now
  }

  private seen(nodeId: string): void {
    const s = this.stateOf(nodeId);
    s.lastSeen = this.now();
    s.lastSeenStall = this.stallTotal();
    s.lastReached = s.lastSeen;
    s.lastReachedStall = s.lastSeenStall;
    s.error = undefined;
    s.failedAt = null;
    this.checkLiveness();
  }

  private failed(nodeId: string, err: unknown, startedStall: number): void {
    // A deadline that spanned this daemon's own stall says nothing about the peer.
    if (this.stallTotal() > startedStall) return;
    const s = this.stateOf(nodeId);
    s.error = err instanceof Error ? err.message : String(err);
    // Only a transport failure marks the peer unreachable (pushes skipped until it answers again);
    // an HTTP error means it is up but refused, e.g. it hasn't finished joining yet.
    s.failedAt = err instanceof PeerCallError && err.code === "unreachable" ? this.now() : null;
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
    const now = this.now();
    for (const n of targets) {
      const s = this.stateOf(n.node_id);
      // A peer our last call failed to reach is skipped until one of our calls reaches it again (anti-entropy delivers then):
      // it must be online AND reached by us lately. Its presence alone is not enough: it may well reach us without our
      // reaching it (Direct behind NAT, a one-way ACL), and then every push would wait out its timeout.
      if (s.failedAt && !(this.isOnline(n.node_id, now) && this.reachedByUs(n.node_id, now))) continue;
      if (s.queued >= MAX_QUEUED_PUSHES) continue;
      s.queued++;
      s.chain = s.chain.then(async () => {
        const startedStall = this.stallTotal();
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
          this.failed(n.node_id, err, startedStall);
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
    const startedStall = this.stallTotal();
    try {
      const addr = this.client.addrOf(n);
      if (!addr) return; // no shared transport: its events come through the machines that serve both
      const t0 = performance.now();
      const w0 = Date.now();
      const peerVv = await this.client.vv(addr, n.pubkey);
      s.sshRevocationCap = (peerVv.capabilities?.caps ?? peerVv.stats?.sys?.caps ?? []).includes(SSH_REVOCATION_CAP);
      s.rtt = Math.round(performance.now() - t0);
      if (typeof peerVv.ts === "number") s.skewMs = Math.round(peerVv.ts - (w0 + Date.now()) / 2);
      s.stats = peerVv.stats;
      if (peerVv.verified) {
        rememberValidPeerSignature(this.core.store, n.node_id);
        this.rememberCapabilities(n.node_id, peerVv.capabilities ?? (peerVv.stats?.sys ? {
          version: peerVv.stats.sys.version, caps: peerVv.stats.sys.caps ?? [],
        } : undefined));
        recordPeerSignature(this.core, n.node_id);
        if (!this.core.isAuthority() && peerVv.envelope && !this.core.roster.nodes.get(n.node_id)?.peer_sig_v1) {
          this.pendingPeerProofs.set(n.node_id, peerVv.envelope);
          this.core.store.setMeta(`pending_peer_proof:${n.node_id}`, JSON.stringify(peerVv.envelope));
          await this.flushPeerProofs();
        }
      }
      s.pool = peerVv.pool;
      if (JSON.stringify(s.accounts ?? null) !== JSON.stringify(peerVv.accounts ?? null)) {
        s.accounts = peerVv.accounts;
        this.core.hub.accountsChanged();
      }
      this.reported.set(n.node_id, { at: this.now(), stall: this.stallTotal(), online: new Set(peerVv.online ?? []) });
      this.seen(n.node_id);
      await this.pullAll(addr, peerVv.vv, n.node_id);
      await this.fillStubs(addr, n.node_id).catch((err: Error) => this.core.log.warn("stub_fill_failed", { peer: n.node_id, err: err.message }));
      s.behind = this.behind(peerVv.vv);
      if (s.behind === 0) s.levelAt = Math.max(s.levelAt ?? 0, w0);
      s.lastSync = Date.now();
      this.core.hub.nodesChanged();
    } catch (err) {
      this.failed(n.node_id, err, startedStall);
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
