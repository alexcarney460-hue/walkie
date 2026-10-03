// Node core: the roster authority chain, the accept pipeline (PROTOCOL §2/§3) and local event
// emission. Transport-free so every surface shares one path.
import { homedir } from "node:os";
import { cleanSubagentType, MAX_SUBAGENTS_PER_PARENT } from "../protocol/subagents.ts";
import { isLiveSubagentRow, liveSubagents } from "./views.ts";
import { canonicalJson } from "../protocol/canonical.ts";
import { containsJoinCredentialValue } from "../protocol/join-credential.ts";
import { eventHeader, jsonDepthOk, stubHeader, stubOf } from "../protocol/header.ts";
import { deriveTeamId, eventId } from "../protocol/ids.ts";
import {
  Event as EventSchema, MAX_EVENT_BYTES, PROTOCOL_VERSION, Stub as StubSchema, type BodyOf, type Event, type Kind,
} from "../protocol/schemas.ts";
import { assertPlanAllows, machinesUsed, peopleUsed } from "../license/enforce.ts";
import { verifyLicense, type LicenseVerifier } from "../license/format.ts";
import { FUTURE_SKEW_MS, planView } from "../license/plans.ts";
import type { PlanView } from "../protocol/schemas.ts";
import type { MachineStats } from "../protocol/machine-stats.ts";
import type { PoolShare } from "../protocol/pool.ts";
import type { PoolService } from "../pool/run/service.ts";
import { DEFAULT_TEAM_POLICY, type AccountsSnapshot, type TeamPolicy } from "../protocol/accounts.ts";
import type { VaultSource } from "../accounts/service.ts";
import { GrantBook, NonceBook } from "./vault-lease.ts";
import { Chain, type Decision, type RosterSource } from "./chain.ts";
import type { Config } from "./config.ts";
import { HttpError } from "./http.ts";
import type { Identity } from "./identity.ts";
import { signEvent, verifyEvent, verifyHeader, type NodeKeys } from "./keys.ts";
import { engagePeerSigStrict } from "./peer-capabilities.ts";
import type { Logger } from "./logger.ts";
import type { Paths } from "./paths.ts";
import { DEFAULT_LIMITS, RateLimiter, SUBAGENT_STATUS_LIMIT, type RateLimits } from "./ratelimit.ts";
import { HIDDEN_PER_ORIGIN_CAP, Revalidator, jobsFor } from "./revalidate.ts";
import {
  CHANNEL_KINDS, InviteSet, MAX_NODES_PER_LOGIN, MAX_NODES_PER_TEAM, PERMANENT_REASONS, ROSTER_KINDS, canSeeChannel,
  completeChannelUpsert, nodeCapacity, nodeMember, validate,
  type AskRef, type MemberRec, type Roster, type Verdict,
} from "./roster.ts";
import type { Hub } from "./sse.ts";
import { StatusCoalescer } from "./status-coalesce.ts";
import { RecentDeliveries } from "./hook-dedupe.ts";
import { SharePolicyFile } from "../agent/share-policy.ts";
import { ACTIVITY_PHRASES, parseProvenance, projectStatus, type StatusProvenance } from "../protocol/status-projection.ts";
import { SEATS_AGENT, isSeatAgent, seatBlobRefs, seatOf } from "../protocol/seats.ts";
import type { EventRow, PendingRow, RevalJob, Store } from "./store.ts";
import { isBoardOp, isProjectChannel as isProjectChannelName } from "../protocol/projects/schema.ts";
import { trackOp } from "./watchdog.ts";

export type IngestStatus = "accepted" | "duplicate" | "pending" | "rejected";
export interface IngestResult { readonly status: IngestStatus; readonly reason?: string }

const PENDING_CAP = 10_000;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** Held events of an origin nobody admitted within an hour are dropped (F3); the relay may send them again. */
export const PENDING_UNKNOWN_ORIGIN_TTL_MS = 60 * 60 * 1000;
/** Held bytes per relaying peer and per claimed origin (F3); beyond that a new hold is `pending_full`. */
export const PENDING_BYTES_PER_RELAY = 8 * 1024 * 1024;
export const PENDING_BYTES_PER_ORIGIN = 8 * 1024 * 1024;
/**
 * Hidden board ops (isBoardOp) whose rejection is FINAL (anchored: no chain entry can cure it) kept in full per origin
 * per project channel (WALKIE-PROJECTS-1, round-6 audits): the lowest seqs; beyond it they are reduced to header
 * stubs. Final verdicts are the same on every replica, and a replica only reduces a row once it holds this many final
 * rows below it, so every replica ends with the same rows (ops built on a reduced row wait everywhere).
 */
export const HIDDEN_BOARD_OPS_PER_ORIGIN_CHANNEL = 20_000;
/**
 * Bytes of hidden board ops whose rejection is still CURABLE (unanchored: a later chain entry may accept them) kept per
 * origin per project channel. They are never reduced to stubs (a replica that learned the cure first accepts them);
 * beyond this a new one is refused and not stored (`board_hidden_full`), so its sender offers it again later.
 */
export const CURABLE_BOARD_BYTES_PER_ORIGIN_CHANNEL = 64 * 1024 * 1024;
/** Junk stubs a full copy may restore (only the caps' reductions, never a failure of the event itself). */
const CAP_REASONS = new Set(["hidden_cap", "hidden_board_cap"]);
/** Hidden roster-kind rows kept per origin (F2): never stubbed; beyond this a new one is refused. */
export const HIDDEN_ROSTER_PER_ORIGIN_CAP = 200;
/** Channels per team (F5); creations past it are refused on the authority. */
export const MAX_CHANNELS_PER_TEAM = 500;
/** Held rows re-ingested per drain pass; the rest continues on the next tick. */
const DRAIN_PAGE = 500;
/**
 * Bumped when validity rules change: stored events are re-judged once on startup.
 * 11 (FO-2 seats v2): the seats content rule also takes a `v: 2` run request exactly as the daemon writes it
 * (runTextV2), so one an older build stored as rejected is accepted after the upgrade. Local only (never on the wire).
 * 10 (PRE4 delta): the seats content rule applies only to a channel marked `seats: true` (from the mark on), so an
 * unmarked `seats-<node>` channel's posts are ordinary again. 9 (pre.4 merge of both 8s): a seats channel carries no
 * asks/answers and only the daemon's own request text (seats r9; Codex r10 MEDIUM 3), and final hidden board ops are
 * marked (PROJECTS round 6); 7: team.integration is a roster kind (LICENSE-FIX-2 F3).
 */
const VALIDITY_VERSION = "11";
/** Which shapes `isBoardOp` counts (4: dispute ops too, WALK-73; 3: status page ops too, PROJECT-PAGES-1; 2: Data Room file ops too, DATA-ROOM-1): a change re-examines stored rows once. */
const BOARD_OPS_CLASS = "4";
/**
 * Store meta key of the plan-clock floor (Core.planNow, audit M4; FINAL Fable 1): raised only by this
 * node's own clock and by the roster chain's entries (clamped). The key before this fix
 * (`max_seen_time`) took any member's event ts and is dropped at startup.
 */
export const PLAN_FLOOR_META = "plan_floor";
const LEGACY_FLOOR_META = "max_seen_time";
export { FUTURE_SKEW_MS };
/** A member's event stamped further ahead of this node's clock than this is held (`future_ts`) until the clock catches up. */
export const FUTURE_HOLD_MS = 24 * 60 * 60 * 1000;
/**
 * A persisted plan floor further than this past anything the node can vouch for at startup (its clock,
 * the chain's clamped max) was recorded by a clock that has since been corrected: it is reset (FINAL-2 Fable 3).
 */
export const FLOOR_RESET_MS = 24 * 60 * 60 * 1000;
/** Hold reasons of a candidate nobody could authenticate (its origin's key unknown): yields to an authenticated event. */
const UNAUTHENTICATED_HOLDS: ReadonlySet<string> = new Set(["unknown_origin", "no_team"]);
/** Drain key of `future_ts` holds: marked ready by every housekeeping pass (the dependency is time itself). */
const TIME_DEP = "time";
/** Drain key for every held row of an origin, whatever it waits for (F2); never a real dependency. */
const HELD_ORIGIN = "held-origin:";
const HELD_CHANNEL = "held-channel:";
/** Stub fill backoff (PROTOCOL §3): 2 s · 2^attempts per (stub, peer), at most an hour between tries. */
const STUB_RETRY_BASE_MS = 2_000;
const STUB_RETRY_MAX_MS = 60 * 60_000;

export interface CoreDeps {
  readonly paths: Paths; readonly config: Config; readonly log: Logger; readonly keys: NodeKeys;
  readonly sshUserHome?: string;
  readonly store: Store; readonly identity: Identity; readonly hub: Hub; readonly limits?: RateLimits;
  readonly hostname: string; readonly ip: string; readonly login: string | null; readonly peerPort: number;
  /** Tests only: a verifier for a throwaway vendor key. Production always uses the embedded key. */
  readonly licenseVerifier?: LicenseVerifier;
  /** Wall clock for plan decisions (trial, grace, expiry); tests pass their simulated clock. Default Date.now. */
  readonly clock?: () => number;
  /** Tests only: smaller board-op hidden-row bounds. */
  readonly boardBounds?: { readonly finalCap?: number; readonly curableBytes?: number };
}

export interface EmitOptions {
  readonly channel?: string; readonly agent?: string; readonly requestId?: string;
  /** agent.status: where its free-text fields came from (status-projection.ts); absent = unknown. */
  readonly provenance?: StatusProvenance;
  /** agent.status re-signed later (reprojectOwnStatuses): when it was really observed; views use it for freshness. */
  readonly observedAt?: number;
}

/** A status with no free text: no title, task or cwd, and a fixed activity phrase (or none). */
function contentFree(b: BodyOf<"agent.status">): boolean {
  return !b.title && !b.task && !b.cwd && (b.activity === undefined || ACTIVITY_PHRASES.has(b.activity));
}

/** Statuses re-signed per upkeep pass (reprojectOwnStatuses). */
export const REPROJECT_BATCH = 50;

/** What a held event waits for (PROTOCOL §2 rule 5); rows are drained only when that arrives. */
function depOf(ev: Event, reason: string): string {
  switch (reason) {
    case "no_team": return "team";
    case "unknown_channel": return `channel:${ev.channel ?? ""}`;
    case "unknown_ask": return `ask:${String((ev.body as { ask?: unknown }).ask ?? "")}`;
    case "chain_gap": return `gap:${ev.origin}`;
    case "future_ts": return TIME_DEP;
    default: return `origin:${ev.origin}`; // unknown_origin, unknown_member
  }
}

export class Core {
  readonly paths: Paths; readonly config: Config; readonly log: Logger; readonly keys: NodeKeys;
  readonly sshUserHome: string;
  readonly store: Store; readonly identity: Identity; readonly hub: Hub;
  readonly limits: RateLimits; readonly limiter = new RateLimiter();
  private readonly boardFinalCap: number;
  private readonly boardCurableBytes: number;
  /** Latest-wins status bursts are held and emitted when the per-agent bucket refills. */
  readonly statuses = new StatusCoalescer({
    tryEmit: (agent, body, provenance, final = false, observedAt) => {
      // A session's sub-agents share one more bucket (WALKIE-MISSION-SUB-1): many at once can't flood the team's log.
      // Checked first without taking, so a refusal there never spends the agent's own token.
      const shared = body.parent && !(body.parent === SEATS_AGENT && isSeatAgent(agent)) ? `subagents:${body.parent}` : null;
      // The per-session cap, again where the status is signed (a held one was admitted before others were emitted).
      if (shared && body.parent && body.state !== "offline" && !isLiveSubagentRow(this.store.agent(this.nodeId, agent)) && liveSubagents(this, body.parent, agent) >= MAX_SUBAGENTS_PER_PARENT) {
        throw new HttpError(429, "rate_limited", `${body.parent} already shows ${MAX_SUBAGENTS_PER_PARENT} live sub-agents`);
      }
      const sharedSpec = this.limits.subagentStatus ?? SUBAGENT_STATUS_LIMIT;
      if (!final && shared && !this.limiter.can(shared, sharedSpec)) return null;
      if (!final && !this.limiter.take(`status:${agent}`, this.limits.status)) return null;
      if (!final && shared) this.limiter.take(shared, sharedSpec);
      return this.emit("agent.status", body, { agent, ...(provenance ? { provenance } : {}), ...(observedAt !== undefined ? { observedAt } : {}) });
    },
  });
  /** What agent statuses may carry (config.json share_prompts / share_activity / share_paths), re-read on change. */
  private sharePolicyFile: SharePolicyFile | null = null;
  /** Working directories of this node's agents as their local writers reported them: kept here, never signed. */
  readonly localCwds = new Map<string, string>();
  /**
   * This node's sub-agents' descriptions and types as the hooks reported them (WALKIE-MISSION-SUB-1): kept here, never
   * signed, shown only on this machine's own dashboard when the sharing policy keeps them from the team.
   */
  readonly localSubagents = new Map<string, { title?: string; type?: string }>();
  /**
   * The hook deliveries this node applied lately (src/daemon/hook-dedupe.ts): a status whose delivery identity was seen
   * is a repeat of one hook event and is dropped. Kept here, never signed; bounded in size and in age.
   */
  readonly hookDeliveries = new RecentDeliveries();
  readonly hostname: string;
  /** Where the peer API listens ("" while it is down) and the Tailscale login; both follow Tailscale (peer-link.ts). */
  ip: string; login: string | null;
  /** Actual bound peer port (set once the peer listener is up). */
  peerPort: number;
  readonly startedAt = Date.now();
  /** Verifies `team.license` keys, in the chain and on activation (PROTOCOL §2 "Licenses"). */
  readonly licenseVerifier: LicenseVerifier;
  /** Wall clock for plan decisions (CoreDeps.clock); plan decisions read it through planNow(). */
  readonly clock: () => number;
  /** The plan-clock floor (store meta `plan_floor`): this node's own clock records and the chain's clamped ts. */
  private floor: number;

  private chain: Chain;
  /** Invite ids this daemon must not honour, even before the chain records them (WALK-107). Null until first read. */
  private retiredInvites: Set<string> | null = null;
  /** `chain.roster` plus those ids. Kept until the chain roster object or the set changes (projects caches the reference). */
  private rosterView: { base: Roster; roster: Roster } | null = null;
  private readonly reval: Revalidator;
  private readonly source: RosterSource = {
    rows: (o, after, upto) => this.store.rosterRows(o, after, upto),
    vv: (o) => this.store.vvOf(o),
  };
  /** Dependencies that arrived and still have held rows to re-ingest (F3). */
  private readonly ready = new Set<string>();
  /** Per ready dependency: the (ts, id) of the last held row already re-ingested in this pass. */
  private readonly cursors = new Map<string, { ts: number; id: string }>();
  /** Dependencies marked again while their rows were being drained: restart them from the top. */
  private readonly remarked = new Set<string>();
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  /** Origins whose held next-seq rows are being re-ingested (rowStored). */
  private readonly fillingGap = new Set<string>();
  private closed = false;
  /** Called for every accepted event originated by this node (sync push). */
  onLocalEvent: ((ev: Event) => void) | null = null;
  /** Called after the roster changes (sync connects to new peers, fills newly visible stubs). */
  onRosterChange: (() => void) | null = null;
  /** This machine's published memory/temperature (machine-stats/sampler.ts): served on `vv`, shown on NodeView. */
  machineStats: MachineStats | null = null;
  /** Agent discovery's last scan was incomplete (discovery.ts): shown with this machine's stats. */
  discoveryHealth: { incomplete: boolean; unreported: number; stale?: boolean } | null = null;
  /** AGENT-SEE-1: local model servers discovery saw running on this machine (machine load), published with its stats. */
  modelServers: { name: string; count: number }[] | null = null;
  /** Counts from discovery's last successful cheap process-table pass. */
  agentProcesses: NonNullable<MachineStats["agent_processes"]> | null = null;

  /** This machine's stats as published (vv answer, NodeView): machine stats plus discovery health when incomplete. */
  publishedStats(): MachineStats | null {
    if (!this.machineStats) return null;
    const rtt = this.peerRtts?.() ?? {};
    return {
      ...this.machineStats,
      ...(this.discoveryHealth?.incomplete ? { discovery: this.discoveryHealth } : {}),
      ...(this.modelServers?.length ? { model_servers: this.modelServers } : {}),
      ...(this.agentProcesses ? { agent_processes: this.agentProcesses } : {}),
      ...(Object.keys(rtt).length ? { peer_rtt: rtt } : {}),
    };
  }
  /** WALKIE-POOL-2: this machine's measured round trips to the peers it reached recently (sync.ts), published in stats. */
  peerRtts: (() => Record<string, number>) | null = null;
  /** WALKIE-POOL-2: this machine's sharing state for split runs (src/pool/run/), served on `vv` and NodeView. */
  poolShare: (() => PoolShare | null) | null = null;
  /** WALKIE-POOL-2: split runs (worker stages + the head's run); null when the daemon runs without them. */
  pool: PoolService | null = null;
  /** Bumped whenever the Agent archive's contents change (agent-archive.ts); dashboards refresh a loaded list on it. */
  archiveRev = 0;
  /** This machine's provider accounts and usage (src/accounts/service.ts): served on `vv`, pooled on /v1/accounts. */
  accounts: AccountsSnapshot | null = null;
  /** Called for a full event a peer pushed that this node accepted (mixed teams: relayed on, sync.ts). */
  onPeerEvent: ((ev: Event, from: string) => void) | null = null;
  /**
   * Called after the store committed an accepted or newly hidden `msg.post` (Projects: the board index re-folds the
   * entity it belongs to, src/daemon/projects/index.ts), and an accepted or newly hidden `artifact.share` (a Data Room
   * version's bytes become servable or stop being: its room's availability changes).
   */
  onPostChange: ((ev: Event, change: "accepted" | "hidden") => void) | null = null;
  /** Node ids this node reached itself lately (served as `online` in `/peer/v1/vv`, mixed teams). */
  reachedPeers: (() => string[]) | null = null;
  /** Called for each peer request that passed the gate (peer-api.ts): the machine is up (sync.ts `heard`). */
  onPeerContact: ((nodeId: string) => void) | null = null;
  /** Owner SSH remains closed until this process has reconciled the team's revocations. */
  sshTeamConfirmed: () => boolean = () => false;
  /** Fetches a share's bytes from the node that uploaded them, gaining provenance (mixed teams: peer-api.ts fetchThrough). */
  fetchBlob: ((nodeId: string, hash: string, channel: string) => Promise<boolean>) | null = null;
  /** ACCOUNTS-2: this machine's vault (read-only here) for hand-outs, and the owner's "vault_sharing" setting. */
  vault: VaultSource | null = null;
  /** Read at each hand-out (round 1, Opus 7): turning `vault_sharing` off takes effect at once. */
  vaultSharing: () => boolean = () => false;
  /** COMPANY POOL: the team's pool setting (newest owner setting seen; off when unknown), read at each hand-out. */
  teamPool: () => { policy: TeamPolicy; at: number | null; by: string | null } = () => ({ policy: DEFAULT_TEAM_POLICY, at: null, by: null });
  teamPolicy: () => TeamPolicy = () => this.teamPool().policy;
  /** COMPANY POOL: this machine's accounts service's room on a vault login (the lender's reserve check), and renewal. */
  vaultRoomLeft: (id: string, now: number) => number | null = () => null;
  vaultRefresh: (id: string) => void = () => undefined;
  vaultRenew: (id: string) => void = () => undefined;
  readonly vaultNonces = new NonceBook();
  readonly vaultGrants = new GrantBook();

  constructor(d: CoreDeps) {
    this.paths = d.paths; this.config = d.config; this.log = d.log; this.keys = d.keys; this.store = d.store;
    this.sshUserHome = d.sshUserHome ?? homedir();
    this.identity = d.identity; this.hub = d.hub; this.limits = d.limits ?? DEFAULT_LIMITS;
    this.hostname = d.hostname; this.ip = d.ip; this.login = d.login; this.peerPort = d.peerPort;
    this.licenseVerifier = d.licenseVerifier ?? verifyLicense;
    this.clock = d.clock ?? Date.now;
    this.boardFinalCap = d.boardBounds?.finalCap ?? HIDDEN_BOARD_OPS_PER_ORIGIN_CHANNEL;
    this.boardCurableBytes = d.boardBounds?.curableBytes ?? CURABLE_BOARD_BYTES_PER_ORIGIN_CHANNEL;
    const stored = Number(this.store.getMeta(PLAN_FLOOR_META) ?? "0");
    this.floor = Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
    this.store.deleteMeta(LEGACY_FLOOR_META); // took any member's event ts (FINAL Fable 1): never trusted again
    this.reval = new Revalidator(this.store, (rows) => this.revalidate(rows),
      (err) => this.log.warn("revalidate_failed", { err: err instanceof Error ? err.message : String(err) }));
    this.store.selfId = this.nodeId;
    if (this.store.deleteSelfStubs(this.nodeId) > 0) this.store.setVv(this.nodeId, this.store.maxSeq(this.nodeId));
    this.store.allocatedSelfSeq(this.nodeId);
    this.chain = this.buildChain();
    // F2 / FINAL Fable 1: at startup the floor is rebuilt from the CHAIN only (never from members' rows),
    // so a machine that becomes the authority with a rolled-back clock can't revive an expired trial
    // by more than the clamp allows, and no member's timestamp ever reaches it.
    this.noteChainTs(this.chain.maxTs);
    this.resetRunawayFloor();
    // The chain and the floor follow the store's transactions (FINAL Codex 2): a failed ledger write
    // that emitted inside it leaves the cursor where the database is.
    this.store.onTransaction<{ chain: Chain; snap: ReturnType<Chain["snapshot"]>; floor: number }>({
      snapshot: () => ({ chain: this.chain, snap: this.chain.snapshot(), floor: this.floor }),
      restore: (s) => {
        this.chain = s.chain;
        s.chain.restore(s.snap);
        this.floor = s.floor;
        // The invites overlay was built from the roster this rollback just undid.
        this.rosterView = null;
        this.retiredInvites = null;
      },
    });
    // Board-op rows not examined yet (stored before the columns existed, or by an older build after a rollback: its
    // inserts leave bop at 0) are classified at every start (PRE4 RC Opus 3), only those above the examined mark, in
    // pages (PRE4 delta). Rows it newly marks are re-judged below, which marks the final ones.
    // DATA-ROOM-1: `isBoardOp` also counts Data Room file ops (op "file") since this classification version, so every
    // stored `p-` post is examined once more (no honest older build signed one; a crafted one is re-judged below).
    // PROJECT-PAGES-1: and status page ops (op "page"), the same way.
    // WALK-73: and dispute ops (op "dispute"), the same way. A pre.12 peer has no such arm and keeps the post as a message.
    if (this.store.getMeta("board_ops_class") !== BOARD_OPS_CLASS) this.store.deleteMeta("board_ops_rowid");
    const newlyMarked = this.store.classifyBoardOps(isBoardOp).marked;
    this.store.setMeta("board_ops_class", BOARD_OPS_CLASS);
    if (this.teamId && (newlyMarked > 0 || this.store.getMeta("validity_version") !== VALIDITY_VERSION || this.reval.interrupted)) {
      this.reval.enqueue([{ kind: "all" }]);
      this.reval.run();
      this.store.setMeta("validity_version", VALIDITY_VERSION);
    }
    // A restart may have lost the ready set: every held dependency is re-checked once.
    for (const dep of this.store.pendingDeps(PENDING_CAP)) this.ready.add(dep);
    this.scheduleDrain();
  }

  get nodeId(): string { return this.keys.nodeId; }
  get teamId(): string | null { return this.store.getMeta("team"); }

  private retiredInviteIds(): ReadonlySet<string> {
    if (this.retiredInvites) return this.retiredInvites;
    const ids = new Set<string>();
    const raw = this.store.getMeta("retired_invites");
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const id of parsed) if (typeof id === "string" && /^[0-9a-f]{32}$/.test(id)) ids.add(id);
        }
      } catch { /* damaged meta: the next retire rewrites it */ }
    }
    this.retiredInvites = ids;
    return ids;
  }

  /**
   * The code for `id` must not admit a machine through this daemon, even before the chain records it used (WALK-107).
   * A non-id is ignored. The newest 256 are kept.
   */
  retireInvite(id: string): void {
    if (!/^[0-9a-f]{32}$/.test(id)) return;
    const ids = this.retiredInviteIds();
    if (ids.has(id)) return;
    const next = [...ids, id].slice(-256);
    this.retiredInvites = new Set(next);
    this.rosterView = null;
    this.store.setMeta("retired_invites", JSON.stringify(next));
  }

  get roster(): Roster {
    const base = this.chain.roster;
    const ids = this.retiredInviteIds();
    if (ids.size === 0) return base;
    if (this.rosterView?.base === base) return this.rosterView.roster;
    let invites: ReadonlySet<string> | undefined = base.invites;
    for (const id of ids) invites = InviteSet.of(invites, id);
    const roster: Roster = { ...base, invites };
    this.rosterView = { base, roster };
    return roster;
  }
  /** The roster authority's node id (PROTOCOL §2); null before the team exists. */
  get authority(): string | null { return this.chain.authority; }
  /** Ordered authority transfers give each lease authority a disjoint, increasing epoch range. */
  get authorityLeaseTerm(): number {
    // Counted once per chain state (its length and last entry), not on every call: a flush checks it per queued spend.
    const len = this.chain.length;
    const last = len ? this.chain.entriesFrom(len - 1)[0]?.ev.id ?? "" : "";
    if (this.termCache && this.termCache.len === len && this.termCache.last === last) return this.termCache.term;
    const term = this.chain.entriesFrom(0).filter((e) => e.ev.kind === "team.authority").length;
    this.termCache = { len, last, term };
    return term;
  }
  private termCache: { len: number; last: string; term: number } | null = null;
  /** Signed roster timestamp of the transfer that began this authority term. */
  get authorityTransferTimestamp(): number | null {
    return this.chain.entriesFrom(0).filter((e) => e.ev.kind === "team.authority").at(-1)?.ev.ts ?? null;
  }
  /** The transfer's signed watermark is the predecessor's acknowledged-post barrier. */
  get authorityTransferWatermark(): Readonly<Record<string, number>> | null {
    const transfer = this.chain.entriesFrom(0).filter((e) => e.ev.kind === "team.authority").at(-1)?.ev;
    return transfer ? (transfer.body as { wm?: Record<string, number> }).wm ?? null : null;
  }
  /** Each authority's signed sequence interval; `after` binds posts to the transfer. */
  get authorityClaimTerms(): readonly { authority: string; after: string | null; floor: number; ceiling: number | null }[] {
    const entries = this.chain.entriesFrom(0);
    const founder = entries[0]?.ev;
    if (!founder) return [];
    const terms = [{ authority: founder.origin, after: null as string | null, floor: 0, ceiling: null as number | null }];
    for (const { ev } of entries) {
      if (ev.kind !== "team.authority") continue;
      const prior = terms.at(-1)!;
      terms[terms.length - 1] = { ...prior, ceiling: ev.seq };
      const authority = (ev.body as { node_id: string }).node_id;
      const wm = (ev.body as { wm?: Record<string, number> }).wm ?? {};
      terms.push({ authority, after: ev.id, floor: wm[authority] ?? 0, ceiling: null });
    }
    return terms;
  }
  orchestratorCanAct?: () => boolean;
  /** Entries in the roster chain (tests). */
  get chainLength(): number { return this.chain.length; }
  /** Accepted roster events in the order the chain applied them. */
  rosterEntries(): readonly Event[] { return this.chain.entriesFrom(0).map(entry => entry.ev); }
  isAuthority(): boolean { return this.chain.authority === this.nodeId; }
  /** Re-validation jobs still queued (they continue on later ticks). */
  get revalidating(): number { return this.reval.pending; }
  /** Queued background work: re-validation jobs plus dependencies whose held rows await re-ingest. */
  get busy(): number { return this.reval.pending + this.ready.size; }
  /** The member owning this node (null before init/join or after removal). */
  me(): MemberRec | null { return nodeMember(this.roster, this.nodeId); }
  myHandle(): string | null { return this.me()?.handle ?? null; }
  /** Id of the chain entry that applied roster request `requestId` (C5), if any. */
  requestEvent(requestId: string): string | undefined { return this.chain.requestEvent(requestId); }
  /**
   * Invite ids the chain has recorded. `roster.invites` also includes ids this daemon retired locally and has not
   * yet had the authority write down; a spend of one of those still has to be appended, so it is not in this set.
   */
  recordedInvites(): ReadonlySet<string> | undefined { return this.chain.roster.invites; }
  /** Who created `channel` (the chain's first channel.upsert for it: its requester, else the authority's member). */
  channelCreator(channel: string): string | null { return this.chain.creatorOf(channel); }
  /**
   * A project channel (WALKIE-PROJECTS-1): named `p-<8 hex>` AND created by the projects code (`project: true` on its
   * creating channel.upsert). A `p-…` channel made before this version is an ordinary channel.
   */
  isProjectChannel(channel: string | null | undefined): boolean {
    return isProjectChannelName(channel) && this.chain.createdAsProject(channel as string);
  }
  /** The roster a non-roster event (origin, seq) is judged by (PROTOCOL §2 "Anchoring"): its anchor's, else the head. */
  rosterAt(origin: string, seq: number): Roster { return this.chain.rosterFor(origin, seq).roster; }

  /** Channels the chain created on `handle`'s request since `since` (F5). */
  channelCreationsBy(handle: string, since: number): number { return this.chain.creationsBy(handle, since); }

  close(): void {
    this.closed = true;
    this.reval.stop();
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  /** Whether the local member may see an event (restricted channels). */
  visible(ev: Pick<Event, "channel">): boolean {
    return canSeeChannel(this.roster, ev.channel ?? null, this.myHandle());
  }

  /** Stubs in channels this node can now see that are due for a fill attempt from `peer` (PROTOCOL §3). */
  fillableStubIds(limit: number, peer: string): string[] {
    const handle = this.myHandle();
    const channels = this.store.stubChannels().filter((ch) => this.roster.channels.has(ch) && canSeeChannel(this.roster, ch, handle));
    return this.store.dueStubIds(channels, peer, Date.now(), STUB_RETRY_BASE_MS, STUB_RETRY_MAX_MS, limit, channels.filter((ch) => !!this.roster.channels.get(ch)?.seats), VALIDITY_VERSION);
  }

  // ---- chain -------------------------------------------------------------------------

  private buildChain(): Chain {
    const team = this.teamId;
    const chain = this.newChain(team ?? "");
    const create = team ? this.store.teamCreate() : null;
    if (!create) return chain;
    chain.start(create);
    for (const d of chain.advance(this.source)) this.record(d);
    return chain;
  }

  private newChain(team: string): Chain {
    return new Chain(team, { verifyLicense: this.licenseVerifier });
  }

  private record(d: Decision): void {
    this.store.setStatus(d.ev.id, d.ok ? "ok" : "rejected", d.ok ? null : d.reason);
  }

  /** Appends every newly decidable authority event, then re-judges what the new entries affect. */
  private advanceChain(): void {
    const start = this.chain.length;
    const floor = this.chain.wmSnapshot();
    // One transaction: the chain's in-memory advance and the verdicts' rows commit or roll back together.
    this.store.transaction(() => {
      for (const d of this.chain.advance(this.source)) {
        this.record(d);
        if (d.ok) { this.noteChainTs(d.ev.ts); this.afterAccept(d.ev); }
        else this.log.info("event_rejected", { id: d.ev.id, kind: d.ev.kind, reason: d.reason });
      }
      // The re-judge the new entries need is marked in the same commit (round-7 audit): a crash before the jobs
      // below are queued restarts into a full re-validation, which marks the newly anchored rows final. `run()`
      // clears the flag once nothing is queued.
      if (this.chain.length > start) this.store.setMeta("reval_pending", "1");
    });
    const added = this.chain.entriesFrom(start);
    if (!added.length) return;
    const jobs = jobsFor(added, this.chain.roster, floor);
    // Curable hidden board ops the new watermarks anchor are re-judged: their verdict is final now, and final ones
    // count toward the board bound (round-6 audits).
    for (const [o, w] of Object.entries(this.chain.wmSnapshot())) {
      const lo = floor[o] ?? 0;
      if (w > lo && this.store.hasCurableBoard(o, lo, w)) jobs.push({ kind: "origin", origin: o, minSeq: lo + 1 });
    }
    this.reval.enqueue(jobs);
    for (const e of added) this.rosterDepsArrived(e.ev);
    // F2: an origin's held rows are re-judged too, whatever they wait for, so one that the change made
    // invalid regardless of its dependency is rejected now (as on a replica that held its dependency).
    for (const j of jobs) {
      if (j.kind === "origin") this.markReady(`${HELD_ORIGIN}${j.origin}`);
      if (j.kind === "channel") this.markReady(`${HELD_CHANNEL}${j.channel}`); // FIX-4 re-audit #3
    }
    this.hub.nodesChanged();
    this.hub.agentsChanged();
    this.onRosterChange?.();
    this.reval.run();
  }

  /** The held rows a new chain entry can release: a node's events, a member's nodes' events, a channel's. */
  private rosterDepsArrived(ev: Event): void {
    if (ev.kind === "team.node") this.markReady(`origin:${(ev.body as BodyOf<"team.node">).node_id}`);
    if (ev.kind === "team.member") {
      const login = (ev.body as BodyOf<"team.member">).login;
      for (const n of this.roster.nodes.values()) if (n.login === login) this.markReady(`origin:${n.node_id}`);
    }
    if (ev.kind === "channel.upsert") this.markReady(`channel:${(ev.body as BodyOf<"channel.upsert">).name}`);
  }

  /**
   * The verdict for an authenticated non-roster event (PROTOCOL §2 rule 3): a pure function of (event,
   * chain). It is judged against the roster just before its anchor, or the head if none covers it
   * yet. What an anchored event's roster lacks can never arrive, so that is a rejection, not a hold
   * (an answer still waits for its ask, which isn't part of the roster).
   */
  private verdict(ev: Event): Verdict {
    const { roster, anchored } = this.chain.rosterFor(ev.origin, ev.seq);
    const v = validate(ev, roster, { teamId: this.chain.teamId, verifySig: false, trusted: true, askLookup: (id) => this.askRef(id) });
    if (anchored && v.status === "pending" && v.reason !== "unknown_ask") return { status: "reject", reason: v.reason };
    return v;
  }

  /**
   * A valid event this member can't see is stored as a stub only if its verdict is final (PROTOCOL §3):
   * it is anchored, and an answer's ask is anchored too. Otherwise it is stored in full and never shown
   * (every local read, SSE message and push filters by visibility), so a later chain entry can still
   * re-judge it; a stub can't be.
   */
  private stubbable(ev: Event): boolean {
    if (this.visible(ev) || ev.origin === this.nodeId || this.chain.anchor(ev.origin, ev.seq) === null) return false;
    if (ev.kind !== "answer") return true;
    const ask = /^([0-9a-f]{16}):(\d+)$/.exec(String((ev.body as { ask?: unknown }).ask ?? ""));
    return !!ask && this.chain.anchor(ask[1] as string, Number(ask[2])) !== null;
  }

  private askRef(id: string): AskRef {
    const row = this.store.getRow(id);
    if (!row) return { state: "none" };
    if (row.redacted === 1) return { state: row.status === "junk" ? "hidden" : "stub" };
    if (row.status !== "ok") return { state: "hidden" };
    return { state: "ok", event: JSON.parse(row.json) as Event };
  }

  /** Re-judges stored rows (a re-validation page): accepted→invalid hides, hidden→valid shows. */
  private revalidate(rows: readonly EventRow[]): void {
    const answerJobs: RevalJob[] = [];
    const hid = new Set<string>();
    const boards = new Map<string, Set<string>>();
    for (const row of rows) {
      const ev = JSON.parse(row.json) as Event;
      const v = this.verdict(ev);
      const ok = v.status === "ok";
      if (ok === (row.status === "ok")) {
        // Still not accepted: keep the current reason. A `pending` verdict (`unknown_ask`) is a dependency,
        // not a rejection: the row is re-judged by its ask's answers job when the ask is accepted (H2/F1).
        if (v.status !== "ok" && row.reason !== v.reason) this.store.setStatus(ev.id, "rejected", v.reason);
        if (v.status === "reject") this.noteBoardFinal(ev, boards);
        continue;
      }
      // An ask that flips re-judges its answers as a paged job under the same budget (C2).
      if (ev.kind === "ask") answerJobs.push({ kind: "answers", ask: ev.id });
      if (v.status !== "ok") {
        this.store.setStatus(ev.id, "rejected", v.reason);
        this.log.info("event_hidden", { id: ev.id, kind: ev.kind });
        this.afterHide(ev);
        if (isBoardOp(ev)) this.noteBoardFinal(ev, boards); else hid.add(ev.origin);
      } else {
        // Kept in full even if this member can't see it (never shown): the row was already stored in full,
        // and its answers can still be judged against it.
        this.store.setStatus(ev.id, "ok", null);
        this.log.info("event_accepted_late", { id: ev.id, kind: ev.kind });
        this.afterAccept(ev);
      }
    }
    for (const o of hid) this.enforceHiddenCap(o);
    for (const [o, chs] of boards) for (const ch of chs) this.enforceBoardBound(o, ch);
    if (answerJobs.length) this.reval.enqueue(answerJobs);
  }

  /**
   * Reduces every project channel already over the final board bound (a lower bound than the last run's, or a crash
   * between marking rows final and reducing them); otherwise only the next final op in that channel would. Called once
   * at startup after `onPostChange` is wired, so the projects index re-folds the affected cards. Returns the channels.
   */
  reduceOverCapBoards(): number {
    const over = this.store.boardOverCap(this.boardFinalCap);
    for (const { origin, channel } of over) this.enforceBoardBound(origin, channel);
    return over.length;
  }

  /** A hidden board op whose verdict is now final (anchored) counts toward its channel's bound from here on. */
  private noteBoardFinal(ev: Event, boards: Map<string, Set<string>>): void {
    if (!isBoardOp(ev) || this.chain.anchor(ev.origin, ev.seq) === null) return;
    this.store.setFinal(ev.id);
    const set = boards.get(ev.origin) ?? new Set<string>();
    set.add(ev.channel as string);
    boards.set(ev.origin, set);
  }

  /**
   * Keeps each origin's lowest-seq HIDDEN_PER_ORIGIN_CAP hidden non-roster rows that aren't board ops; the rest keep
   * only their header. Our own origin too (C3): our seq allocation lives in `meta`, not in our rows. Board ops have
   * their own bounds (enforceBoardBound, CURABLE_BOARD_BYTES_PER_ORIGIN_CHANNEL): the general count depends on each
   * replica's view of other channels (round-5 audit, Opus).
   */
  private enforceHiddenCap(origin: string): void {
    for (;;) {
      const rows = this.store.hiddenBeyond(origin, HIDDEN_PER_ORIGIN_CAP, 500);
      for (const row of rows) {
        const ev = JSON.parse(row.json) as Event;
        this.store.replaceWithStub(stubOf(ev), "junk", "hidden_cap");
        if (ev.kind === "msg.post") this.store.afterCommit(() => this.onPostChange?.(ev, "hidden"));
      }
      if (rows.length < 500) return;
    }
  }

  /**
   * Keeps an origin's lowest-seq `boardFinalCap` FINAL hidden board ops in a project channel; the ones above are reduced
   * to header stubs (highest first). O(reduced · log n): the count is a trigger-maintained counter.
   */
  private enforceBoardBound(origin: string, channel: string): void {
    for (;;) {
      const over = this.store.boardHidden(origin, channel).final_n - this.boardFinalCap;
      if (over <= 0) return;
      const rows = this.store.boardFinalTop(origin, channel, Math.min(over, 500));
      if (!rows.length) return;
      for (const row of rows) {
        const ev = JSON.parse(row.json) as Event;
        this.store.replaceWithStub(stubOf(ev), "junk", "hidden_board_cap");
        this.store.afterCommit(() => this.onPostChange?.(ev, "hidden"));
      }
    }
  }

  /**
   * Stores a hidden board op (ingest or a stub's full copy). A curable one past its origin's byte bound in the channel
   * is refused, not stored: its sender offers it again, and by then it may be accepted or final.
   */
  private storeHiddenBoardOp(ev: Event, reason: string, upgrade: boolean): string | null {
    const fin = this.chain.anchor(ev.origin, ev.seq) !== null;
    if (!fin) {
      const bytes = Buffer.byteLength(JSON.stringify(ev));
      if (this.store.boardHidden(ev.origin, ev.channel as string).curable_bytes + bytes > this.boardCurableBytes) {
        this.log.info("event_refused", { id: ev.id, kind: ev.kind, reason: "board_hidden_full" });
        return "board_hidden_full";
      }
    }
    if (upgrade) this.store.upgradeStub(ev, "rejected", reason, fin); else this.store.insertEvent(ev, "rejected", reason, fin);
    if (fin) this.enforceBoardBound(ev.origin, ev.channel as string);
    // A hidden board op still carries rank for the ops naming it: its card is re-folded (round-4 audit, Codex M2).
    this.store.afterCommit(() => this.onPostChange?.(ev, "hidden"));
    return null;
  }

  // ---- ingest ----------------------------------------------------------------

  /** `relay` is the peer that handed us the event (push sender or pull source), for the pending caps. */
  ingest(input: unknown, source: "local" | "remote", relay: string | null = null): IngestResult {
    try {
      return isStubShape(input) ? this.ingestStub(input) : this.ingestEvent(input, source, false, relay);
    } catch (err) {
      if (source === "local") throw err;
      this.log.warn("ingest_failed", { err: err instanceof Error ? err.message : String(err) });
      return { status: "rejected", reason: "internal" };
    }
  }

  /** Rules 1–2: signature + header signature by an origin whose key we know (revoked or not). */
  private authenticate(ev: Event, team: string): Verdict {
    if (ev.kind === "team.create") return validate(ev, this.roster, { teamId: team, trusted: true });
    if (!this.roster.team) return { status: "pending", reason: "no_team" };
    const node = this.roster.nodes.get(ev.origin);
    if (!node) return { status: "pending", reason: "unknown_origin" };
    if (!verifyEvent(ev, node.pubkey)) return { status: "reject", reason: "bad_signature" };
    if (!verifyHeader(eventHeader(ev), ev.hsig, node.pubkey)) return { status: "reject", reason: "bad_hsig" };
    return { status: "ok" };
  }

  /** A held row of an origin that couldn't be authenticated when it arrived (its key unknown). */
  private pendingUnauthenticated(id: string): boolean {
    const row = this.store.pendingRow(id);
    return !!row && UNAUTHENTICATED_HOLDS.has(row.reason);
  }

  /** Whether `ev` (authenticated) waits for the clocks to agree: a non-authority event stamped > FUTURE_HOLD_MS ahead. */
  private futureHeld(ev: Event): boolean {
    return ev.origin !== this.chain.authority && ev.ts > this.clock() + FUTURE_HOLD_MS;
  }

  private ingestEvent(input: unknown, source: "local" | "remote", fromPending: boolean, relay: string | null): IngestResult {
    if (!jsonDepthOk(input) || !EventSchema.safeParse(input).success) return { status: "rejected", reason: "bad_event" };
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_EVENT_BYTES) return { status: "rejected", reason: "bad_event" };
    const ev = input as Event;
    const team = this.teamId;
    if (!team) return { status: "rejected", reason: "no_team" };
    if (ev.id !== eventId(ev.origin, ev.seq)) return { status: "rejected", reason: "bad_id" };
    if (ev.team !== team) return { status: "rejected", reason: "wrong_team" };

    const existing = this.store.getRow(ev.id);
    if (existing) return existing.redacted === 1 ? this.fillStub(ev, existing, team, relay) : this.compareExisting(ev, existing);
    // D3: never take a copy of our own origin from elsewhere (it would move our seq allocation).
    if (source === "remote" && ev.origin === this.nodeId) return { status: "rejected", reason: "self_origin" };
    // FINAL-2 Codex 1: a known origin is authenticated BEFORE anything reserves its id. A forgery claiming
    // the authority's next seq is rejected here, never held, so it can't freeze the chain on this node.
    const auth = this.authenticate(ev, team);
    if (auth.status === "reject") {
      this.log.info("event_rejected", { id: ev.id, kind: ev.kind, reason: auth.reason, source });
      return { status: "rejected", reason: auth.reason };
    }
    if (!fromPending && this.store.hasPending(ev.id)) {
      // Only a candidate nobody could authenticate yet (its origin unknown) yields to an authenticated event
      // with the same id; two candidates of an unknown origin keep the first.
      if (auth.status !== "ok" || !this.pendingUnauthenticated(ev.id)) return { status: "pending", reason: "already_pending" };
      this.store.deletePending(ev.id);
    }
    if (auth.status === "pending") return this.hold(ev, auth.reason, source, fromPending, relay); // quarantined: unknown_origin / no_team
    if (ev.kind === "team.create") return this.ingestCreate(ev);
    // FINAL Fable 1: a member's timestamp more than a day ahead of this clock is held, not judged, until the
    // clocks agree (a hold, so a wrong clock on either side cures itself); nothing else about it is trusted.
    // FINAL-2 Fable 3: the authority's events are never held for their ts. Everything a timestamp can move
    // is clamped (the plan floor, agent staleness, ask expiry), and holding them would pin its chain on
    // every member for as long as the hold lasts after its clock is corrected.
    if (this.futureHeld(ev)) return this.hold(ev, "future_ts", source, fromPending, relay);
    // Checked before and after: the row may itself be the transfer that ends its origin's authority,
    // and that origin's later held rows must still be released (as non-authority rows).
    const wasAuthority = ev.origin === this.chain.authority;
    const res = ROSTER_KINDS.has(ev.kind) ? this.ingestRosterEvent(ev, source, fromPending, relay) : this.ingestOther(ev, source, fromPending, relay);
    if (this.store.getRow(ev.id)) this.rowStored(ev.origin, wasAuthority || ev.origin === this.chain.authority);
    return res;
  }

  /**
   * A stored row may close a gap: for the authority, in front of its stored roster events (the chain
   * advances); for any origin, in front of a row held `chain_gap` (a roster event of an origin that
   * was the authority when it arrived). Only the next seq (vv + 1) can be stored now, so that one
   * held row is re-ingested at once, and so on while they chain: O(1) per step, and the roster is
   * current when the call returns.
   */
  private rowStored(origin: string, authority: boolean): void {
    if (authority) this.advanceChain();
    if (this.fillingGap.has(origin)) return; // the loop below picks up the next seq
    this.fillingGap.add(origin);
    try {
      for (;;) {
        const row = this.store.pendingRow(eventId(origin, this.store.vvOf(origin) + 1));
        if (row?.reason !== "chain_gap") return; // other holds wait for their dependency
        const res = this.ingestEvent(JSON.parse(row.json), "remote", true, row.relay);
        if (res.status === "pending") return;
        this.store.deletePending(row.id);
      }
    } finally {
      this.fillingGap.delete(origin);
    }
  }

  private ingestCreate(ev: Event): IngestResult {
    this.store.insertEvent(ev, "ok", null);
    this.chain = this.newChain(ev.team);
    this.chain.start(ev);
    this.noteChainTs(ev.ts);
    this.afterAccept(ev);
    this.markReady("team");
    this.hub.nodesChanged();
    this.onRosterChange?.();
    this.advanceChain();
    return { status: "accepted" };
  }

  /**
   * Roster kinds (PROTOCOL §2): only the authority's events can join the chain, in its seq order.
   * Anyone else's is stored hidden (`not_authority`) at O(1) cost, never stubbed (it must still be
   * there if a transfer makes that node the authority), and capped separately (F2).
   */
  private ingestRosterEvent(ev: Event, source: "local" | "remote", fromPending: boolean, relay: string | null): IngestResult {
    if (source === "local") {
      const d = this.chain.decide(ev, true); // the authority signs it: new events get the full rules
      if (!d.ok) return { status: "rejected", reason: d.reason ?? "rejected" };
    } else if (ev.origin !== this.chain.authority) {
      return this.storeRosterHidden(ev);
    } else if (ev.seq > this.store.vvOf(ev.origin) + 1) {
      return this.hold(ev, "chain_gap", source, fromPending, relay);
    }
    this.store.insertEvent(ev, "rejected", "chain_wait");
    this.advanceChain();
    const row = this.store.getRow(ev.id);
    return row?.status === "ok" ? { status: "accepted" } : { status: "rejected", reason: row?.reason ?? "rejected" };
  }

  private storeRosterHidden(ev: Event): IngestResult {
    this.log.info("event_rejected", { id: ev.id, kind: ev.kind, reason: "not_authority", source: "remote" });
    if (this.store.hiddenRosterCount(ev.origin) >= HIDDEN_ROSTER_PER_ORIGIN_CAP) {
      return { status: "rejected", reason: "roster_hidden_full" };
    }
    this.store.insertEvent(ev, "rejected", "not_authority");
    return { status: "rejected", reason: "not_authority" };
  }

  private ingestOther(ev: Event, source: "local" | "remote", fromPending: boolean, relay: string | null): IngestResult {
    const v = this.verdict(ev);
    if (v.status === "pending") return this.hold(ev, v.reason, source, fromPending, relay);
    if (v.status === "reject") return this.storeRejected(ev, v.reason, source);
    if (this.stubbable(ev)) {
      // Valid for good, in a restricted channel this member can't see: keep only a stub.
      this.store.insertStub(stubOf(ev));
      return { status: "accepted" };
    }
    this.store.insertEvent(ev, "ok", null);
    this.afterAccept(ev);
    return { status: "accepted" };
  }

  private compareExisting(ev: Event, existing: EventRow): IngestResult {
    if (canonicalJson(JSON.parse(existing.json)) === canonicalJson(ev)) return { status: "duplicate" };
    const node = this.roster.nodes.get(ev.origin);
    if (node && verifyEvent(ev, node.pubkey)) {
      this.store.addConflict(ev.id, ev.origin);
      this.log.warn("event_conflict", { id: ev.id, origin: ev.origin });
      return { status: "rejected", reason: "conflict" };
    }
    return { status: "rejected", reason: "bad_signature" };
  }

  /**
   * Holds an event until its dependency arrives (PROTOCOL §2 rule 5). A new hold is refused
   * (`pending_full`) past the row cap, or past the byte cap of the relaying peer or of the claimed origin.
   */
  private hold(ev: Event, reason: string, source: "local" | "remote", fromPending: boolean, relay: string | null): IngestResult {
    if (source === "local") return { status: "rejected", reason };
    const dep = depOf(ev, reason);
    if (fromPending) {
      this.store.addPending(ev, reason, dep, relay, 0); // a re-hold keeps its place and byte count
      return { status: "pending", reason };
    }
    const bytes = Buffer.byteLength(JSON.stringify(ev));
    const full = this.store.pendingCount() >= PENDING_CAP
      || (relay !== null && this.store.pendingBytesOfRelay(relay) + bytes > PENDING_BYTES_PER_RELAY)
      || this.store.pendingBytesOfOrigin(ev.origin) + bytes > PENDING_BYTES_PER_ORIGIN;
    if (full) return { status: "rejected", reason: "pending_full" };
    this.store.addPending(ev, reason, dep, relay, bytes);
    return { status: "pending", reason };
  }

  /**
   * Signed by an admitted origin but invalid: keep it so seq contiguity holds. Schema-level failures
   * keep only the signed header (junk); roster-dependent ones stay hidden and are re-judged later.
   */
  private storeRejected(ev: Event, reason: string, source: "local" | "remote"): IngestResult {
    this.log.info("event_rejected", { id: ev.id, kind: ev.kind, reason, source });
    if (source === "local") return { status: "rejected", reason };
    if (PERMANENT_REASONS.has(reason)) {
      this.store.insertStub(stubOf(ev), "junk", reason);
    } else if (isBoardOp(ev)) {
      const refused = this.storeHiddenBoardOp(ev, reason, false);
      if (refused) return { status: "rejected", reason: refused };
    } else {
      this.store.insertEvent(ev, "rejected", reason);
      this.enforceHiddenCap(ev.origin);
      if (ev.kind === "msg.post") this.store.afterCommit(() => this.onPostChange?.(ev, "hidden"));
    }
    if (ev.kind === "ask") this.markReady(`ask:${ev.id}`); // held answers now learn it isn't accepted
    return { status: "rejected", reason };
  }

  /**
   * A full event for a stored stub (D4 fill, or a member's copy): replace the stub after full checks. A board op the
   * caps reduced to a junk stub is restored when its verdict is no longer final-rejected (round-6 audit, Opus H1).
   */
  private fillStub(ev: Event, existing: EventRow, team: string, relay: string | null): IngestResult {
    const junk = existing.status === "junk";
    if (ROSTER_KINDS.has(ev.kind) || (junk && !(CAP_REASONS.has(existing.reason ?? "") && (isBoardOp(ev) || (existing.reason === "hidden_cap" && ev.kind === "msg.post" && !!seatOf(ev.body) && !!this.roster.channels.get(ev.channel ?? "")?.seats))))) return { status: "duplicate" };
    if (canonicalJson(stubOf(ev)) !== canonicalJson(JSON.parse(existing.json))) return { status: "rejected", reason: "stub_header_mismatch" };
    if (junk && this.store.getMeta(`stub_recovery:${ev.id}`) === VALIDITY_VERSION) return { status: "duplicate" };
    const auth = this.authenticate(ev, team); // FINAL-2 Codex 1: authenticated before any hold
    if (auth.status !== "ok") return { status: auth.status === "pending" ? "duplicate" : "rejected", reason: auth.reason };
    if (this.futureHeld(ev)) return this.hold(ev, "future_ts", "remote", this.store.hasPending(ev.id), relay);
    const v = this.verdict(ev);
    if (v.status === "ok") {
      if (!this.visible(ev)) {
        if (!junk) return { status: "duplicate" };
        this.store.unjunkStub(ev.id); // valid now, in a channel this member can't see: an ordinary stub
        return { status: "accepted" };
      }
      this.store.upgradeStub(ev, "ok");
      this.afterAccept(ev);
      return { status: "accepted" };
    }
    if (v.status === "pending") return this.hold(ev, v.reason, "remote", this.store.hasPending(ev.id), relay);
    if (junk && !isBoardOp(ev)) this.store.setMeta(`stub_recovery:${ev.id}`, VALIDITY_VERSION);
    if (PERMANENT_REASONS.has(v.reason)) {
      if (!junk) this.store.markStubJunk(ev.id, v.reason);
    } else if (isBoardOp(ev)) {
      if (junk && this.chain.anchor(ev.origin, ev.seq) !== null) return { status: "duplicate" }; // still final: stays reduced
      const refused = this.storeHiddenBoardOp(ev, v.reason, true);
      if (refused) return { status: "rejected", reason: refused };
    } else {
      this.store.upgradeStub(ev, "rejected", v.reason);
      this.enforceHiddenCap(ev.origin);
      if (ev.kind === "msg.post") this.store.afterCommit(() => this.onPostChange?.(ev, "hidden"));
    }
    if (ev.kind === "ask") this.markReady(`ask:${ev.id}`);
    return { status: "rejected", reason: v.reason };
  }

  /** D3: a stub is stored only if its header is signed by its origin and its channel is hidden from us. */
  private ingestStub(input: unknown): IngestResult {
    const p = StubSchema.safeParse(input);
    if (!p.success) return { status: "rejected", reason: "bad_stub" };
    const stub = p.data;
    if (stub.id !== eventId(stub.origin, stub.seq)) return { status: "rejected", reason: "bad_id" };
    const team = this.teamId;
    if (!team) return { status: "rejected", reason: "no_team" };
    if (stub.origin === this.nodeId) return { status: "rejected", reason: "self_origin" };
    if (this.store.getRow(stub.id)) return { status: "duplicate" };
    const node = this.roster.nodes.get(stub.origin);
    if (!node) return { status: "rejected", reason: "stub_unknown_origin" };
    if (!verifyHeader(stubHeader(stub, team), stub.hsig, node.pubkey)) return { status: "rejected", reason: "bad_hsig" };
    // A superseded agent.status (MISSION-1 fix round 3): its header stands in for it; the latest status comes in full.
    if (stub.kind === "agent.status" && !stub.channel) {
      this.store.insertStub(stub);
      this.rowStored(stub.origin, stub.origin === this.chain.authority);
      return { status: "accepted" };
    }
    if (!stub.channel || !CHANNEL_KINDS.has(stub.kind)) return { status: "rejected", reason: "stub_without_channel" };
    const ch = this.roster.channels.get(stub.channel);
    if (!ch) return { status: "rejected", reason: "stub_unresolved" };
    if (!ch.members) return { status: "rejected", reason: "stub_for_public_channel" };
    // A member wants the real event: refusing the stub keeps the gap open so it gets pulled.
    if (canSeeChannel(this.roster, stub.channel, this.myHandle())) return { status: "rejected", reason: "stub_for_member" };
    this.store.insertStub(stub);
    this.rowStored(stub.origin, stub.origin === this.chain.authority);
    return { status: "accepted" };
  }

  private afterAccept(ev: Event): void {
    if (ev.kind === "ask") {
      this.markReady(`ask:${ev.id}`);
      this.answersChanged(ev.id);
    }
    if (ev.kind === "agent.status") {
      this.store.upsertAgent(ev, Date.now() + FUTURE_SKEW_MS); // its ts counts from now at most (FINAL Fable 8)
      this.hub.agentsChanged();
    }
    const hash = (ev.body as { hash?: unknown }).hash;
    if (ev.kind === "artifact.share" && typeof hash === "string") this.store.addBlobRef(hash, ev.id);
    // A seat request names its repo bundle (v2: its brief and delta bundle): that (validated) request is their
    // reference in its seats channel.
    for (const hash of seatBlobRefs(ev)) this.store.addBlobRef(hash, ev.id);
    // Publication and the peer push wait for the outermost store transaction to commit (#1): an emit
    // inside a ledger transaction that then fails leaves no trace anywhere, and its seq is reused.
    this.store.afterCommit(() => {
      this.hub.publishEvent(ev);
      if (ev.origin === this.nodeId) this.onLocalEvent?.(ev);
      if (ev.kind === "msg.post" || ev.kind === "artifact.share") this.onPostChange?.(ev, "accepted");
    });
  }

  /**
   * An ask became accepted (ingest, stub fill or re-validation): its stored answers, accepted or hidden,
   * are re-judged as a paged job under the shared re-validation budget, on a later tick (H2/F1).
   */
  private answersChanged(askId: string): void {
    if (!this.store.hasAnswers(askId)) return;
    this.reval.enqueue([{ kind: "answers", ask: askId }]);
    this.reval.schedule();
  }

  private afterHide(ev: Event): void {
    if (ev.kind === "agent.status") {
      this.store.recomputeAgent(ev.origin, String((ev.body as { agent?: unknown }).agent ?? ""), FUTURE_SKEW_MS);
      this.hub.agentsChanged();
    }
    this.hub.publishHidden([ev.id]);
    if (ev.kind === "msg.post" || ev.kind === "artifact.share") this.store.afterCommit(() => this.onPostChange?.(ev, "hidden"));
  }

  // ---- pending drain (F3) ---------------------------------------------------------

  /** A dependency arrived: its held rows (only those) are re-ingested off the ingest path. */
  private markReady(dep: string): void {
    if (!this.hasHeld(dep)) return;
    if (this.ready.has(dep)) this.remarked.add(dep);
    this.ready.add(dep);
    this.cursors.delete(dep);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.closed || !this.ready.size) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      try {
        trackOp("drain_pending", () => this.drainSome(DRAIN_PAGE));
      } catch (err) {
        this.log.warn("drain_failed", { err: err instanceof Error ? err.message : String(err) });
      }
      this.scheduleDrain();
    }, 0);
  }

  /** Re-ingests up to `budget` held rows whose dependency arrived, page by page. */
  private drainSome(budget: number): void {
    if (this.draining) return;
    this.draining = true;
    try {
      let done = 0;
      while (done < budget && this.ready.size) {
        const dep = this.ready.values().next().value as string;
        const cur = this.cursors.get(dep) ?? { ts: Number.MIN_SAFE_INTEGER, id: "" };
        const limit = Math.min(200, budget - done);
        this.remarked.delete(dep);
        const rows = this.heldPage(dep, cur.ts, cur.id, limit);
        for (const row of rows) {
          const res = this.ingestEvent(JSON.parse(row.json), "remote", true, row.relay);
          if (res.status !== "pending") this.store.deletePending(row.id);
        }
        done += Math.max(rows.length, 1);
        const last = rows[rows.length - 1];
        if (this.remarked.has(dep)) this.cursors.delete(dep); // it arrived again meanwhile: from the top
        else if (rows.length < limit || !last) { this.ready.delete(dep); this.cursors.delete(dep); }
        else this.cursors.set(dep, { ts: last.ts, id: last.id });
      }
    } finally {
      this.draining = false;
    }
  }

  /** `held-origin:<id>` stands for every held row of that origin (F2); anything else is a real dependency. */
  private hasHeld(dep: string): boolean {
    if (dep.startsWith(HELD_ORIGIN)) return this.store.hasPendingOrigin(dep.slice(HELD_ORIGIN.length));
    if (dep.startsWith(HELD_CHANNEL)) return this.store.hasPendingChannel(dep.slice(HELD_CHANNEL.length));
    return this.store.hasPendingDep(dep);
  }

  private heldPage(dep: string, ts: number, id: string, limit: number): PendingRow[] {
    if (dep.startsWith(HELD_ORIGIN)) return this.store.pendingByOrigin(dep.slice(HELD_ORIGIN.length), ts, id, limit);
    if (dep.startsWith(HELD_CHANNEL)) return this.store.pendingByChannel(dep.slice(HELD_CHANNEL.length), ts, id, limit);
    return this.store.pendingByDep(dep, ts, id, limit);
  }

  /** Drains every ready dependency now and expires stale held rows (housekeeping, sync rounds, tests). */
  drainPending(): void {
    this.store.expirePending(PENDING_TTL_MS, PENDING_UNKNOWN_ORIGIN_TTL_MS);
    this.markReady(TIME_DEP); // `future_ts` holds: time is their dependency
    this.drainSome(Number.MAX_SAFE_INTEGER);
  }

  // ---- plan clock (audit M4, FINAL Fable 1) -------------------------------------

  /**
   * The time plan decisions use: the clock, but never earlier than the floor this node recorded, so
   * setting the clock back can't revive a trial or a lapsed license. The floor is raised by exactly two
   * things: this node's own clock (every emit, every hour) and the `ts` of the roster chain's entries,
   * clamped to the clock plus FUTURE_SKEW_MS. No other node's event ever moves it: a member whose
   * clock is in the future can't end the team's plan (the HIGH finding of the final audit).
   */
  planNow(): number { return Math.max(this.clock(), this.floor); }

  /** Records the current clock as the plan-clock floor (persisted in store meta) if it moved forward. */
  noteTime(): void { this.raiseFloor(this.clock()); }

  /** A chain entry's ts raises the floor, never past the clock plus the skew allowance. */
  private noteChainTs(t: number): void {
    this.raiseFloor(Math.min(t, this.clock() + FUTURE_SKEW_MS));
  }

  private raiseFloor(t: number): void {
    if (!Number.isSafeInteger(t) || t <= this.floor) return;
    this.floor = t;
    this.store.setMeta(PLAN_FLOOR_META, String(t));
  }

  /**
   * Startup only (FINAL-2 Fable 3): a floor more than FLOOR_RESET_MS past max(own clock, the chain's
   * clamped max) was recorded while this node's clock was wrong (an authority an hour at +10 y would
   * otherwise stay Free for good). It is reset to that max and logged. The trade: a clock set back by
   * more than a day and a restart also reset it; within a day the floor still holds (SECURITY.md).
   */
  private resetRunawayFloor(): void {
    const clock = this.clock();
    const bound = Math.max(clock, Math.min(this.chain.maxTs, clock + FUTURE_SKEW_MS));
    if (this.floor <= bound + FLOOR_RESET_MS) return;
    this.log.warn("plan_floor_reset", { floor: this.floor, to: bound, clock });
    this.floor = bound;
    this.store.setMeta(PLAN_FLOOR_META, String(bound));
  }

  // ---- local emission ---------------------------------------------------------

  /** Signs, validates and stores an event authored by this node; throws HttpError if invalid. */
  /** The effective sharing policy for agent statuses (src/agent/share-policy.ts). */
  sharePolicy() {
    this.sharePolicyFile ??= new SharePolicyFile(this.paths.config);
    return this.sharePolicyFile.get();
  }

  /**
   * The Hermes profiles whose status may carry activity text, read from config.json when it changes (src/agent/share-policy.ts):
   * none unless the file lists them, so a missing, unreadable or invalid file shows none. The Hermes route and discovery use it.
   */
  hermesActivityProfiles(): readonly string[] {
    this.sharePolicyFile ??= new SharePolicyFile(this.paths.config);
    return this.sharePolicyFile.hermesActivityProfiles();
  }

  /** Remembers an agent's working directory locally (discovery matches unnamed sessions by it); bounded. */
  noteLocalCwd(agent: string, cwd: string | undefined): void {
    if (!cwd) return;
    this.localCwds.delete(agent);
    this.localCwds.set(agent, cwd);
    while (this.localCwds.size > 2_048) this.localCwds.delete(this.localCwds.keys().next().value as string);
  }

  /** Remembers a sub-agent's description and type locally (views.ts shows them to this machine's owner); bounded. */
  noteLocalSubagent(agent: string, v: { title?: string; type?: string }): void {
    const prev = this.localSubagents.get(agent);
    this.localSubagents.delete(agent);
    const title = v.title ?? prev?.title;
    const type = cleanSubagentType(v.type) ?? prev?.type; // the owner's own view gets the same name characters only
    this.localSubagents.set(agent, { ...(title ? { title } : {}), ...(type ? { type } : {}) });
    while (this.localSubagents.size > 2_048) this.localSubagents.delete(this.localSubagents.keys().next().value as string);
  }

  emit<K extends Kind>(kind: K, body: BodyOf<K>, opts: EmitOptions = {}): Event {
    if (opts.agent && containsJoinCredentialValue(body))
      throw new HttpError(403, "join_credential_private_reply_only", "agents cannot publish join credentials; the daemon delivers minted credentials privately");
    if (opts.agent === "orchestrator" && kind !== "agent.status" && this.orchestratorCanAct && !this.orchestratorCanAct()) {
      throw new Error("orchestrator leadership lease expired");
    }
    const team = this.teamId;
    const me = this.me();
    if (!team) throw new HttpError(409, "no_team", "this node is not in a team (run: walkie init or walkie join)");
    if (!me) throw new HttpError(403, "forbidden", "this node is not an admitted member of the team");
    this.noteTime();
    const roster = ROSTER_KINDS.has(kind);
    if (roster && !this.isAuthority()) throw new HttpError(409, "not_authority", "only the roster authority writes roster events");
    const seq = this.store.allocatedSelfSeq(this.nodeId) + 1;
    // The node clock (Date.now in production), kept monotonic with this node's earlier events but never
    // more than FUTURE_SKEW_MS ahead of the clock: after a clock correction the node keeps emitting
    // events its peers accept instead of stamping them a decade ahead forever.
    const clock = this.clock();
    const ts = Math.max(clock, Math.min(this.store.maxTs(this.nodeId), clock + FUTURE_SKEW_MS));
    // Every agent.status this node signs, whoever wrote it, is rebuilt from the allow-list (WALKIE-MISSION-1 fix 2).
    const projected = kind === "agent.status"
      ? { ...this.projectOwnStatus(body as BodyOf<"agent.status">, opts.provenance), ...(opts.observedAt !== undefined ? { observed_at: Math.max(0, Math.round(opts.observedAt)) } : {}) } as BodyOf<K>
      : body;
    const clean = stripUndefined(projected) as Record<string, unknown>;
    const signedBody = roster ? this.chainBody(kind, clean, opts.requestId) : clean;
    const ev = signEvent(this.keys, {
      v: PROTOCOL_VERSION, team, id: eventId(this.nodeId, seq), origin: this.nodeId, seq, ts,
      author: { handle: me.handle, node: this.nodeId, ...(opts.agent ? { agent: opts.agent } : {}) },
      kind, ...(opts.channel ? { channel: opts.channel } : {}), body: signedBody as BodyOf<K>,
    });
    const res = this.ingest(ev, "local");
    if (res.status !== "accepted") throw rejectionError(res.reason ?? "rejected");
    if (kind === "agent.status") this.noteStatusProvenance((body as BodyOf<"agent.status">).agent, ev.id, opts.provenance);
    if (kind === "team.member" && (signedBody as { role?: unknown }).role === "removed") {
      this.dropFromRestricted((signedBody as BodyOf<"team.member">).handle);
    }
    if (roster) engagePeerSigStrict(this);
    return ev;
  }

  /**
   * The authority just removed `handle`: it leaves every restricted channel NOW, archived ones and ones left with nobody
   * included, before this call returns, so no re-invite (the next roster event this authority signs) can find them
   * still listed (round-2 audits, Codex HIGH 1 / Opus M3). The channel entries follow the removal in the chain.
   */
  private dropFromRestricted(handle: string): void {
    for (const [name, ch] of this.roster.channels) {
      if (!ch.members?.includes(handle)) continue;
      try {
        this.emit("channel.upsert", { name, members: ch.members.filter((h) => h !== handle) });
      } catch (err) {
        this.log.warn("restricted_drop_failed", { channel: name, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** The recorded provenance of an own agent's status `id` (store row per agent; null: none recorded for it). */
  private provenanceOf(agent: string, id: string): StatusProvenance | null {
    const row = this.store.statusProvenance(agent);
    if (!row || row.event_id !== id) return null;
    try { return parseProvenance(JSON.parse(row.prov) as unknown); } catch { return {}; }
  }

  /**
   * What an own agent status may carry: the sharing policy's projection, then the Projects scrub (a private project's
   * card key never leaves in a status; round-1 audit M7). Used where the status is signed AND where its compliance is
   * judged, so a project made private later makes older statuses non-compliant (they are re-signed without the key).
   */
  private projectOwnStatus(body: BodyOf<"agent.status">, prov: StatusProvenance | undefined): BodyOf<"agent.status"> {
    const p = projectStatus(body, prov, this.sharePolicy());
    return this.statusScrub ? this.statusScrub(p) : p;
  }

  /** Throws 402 when the team's plan has no room for another project (the authority creating a project channel). */
  projectQuota: (() => void) | null = null;

  /** Removes what a status must not disclose about private projects (set by the daemon: src/daemon/projects/). */
  statusScrub: ((b: BodyOf<"agent.status">) => BodyOf<"agent.status">) | null = null;

  /** The provenance recorded for an agent's current own status (null: none, or it's not the current one). */
  currentStatusProvenance(agent: string): StatusProvenance | null {
    const row = this.store.agent(this.nodeId, agent);
    return row ? this.provenanceOf(agent, row.event_id) : null;
  }

  /** One row per agent (Opus r4 #2 / Codex r4 #6): O(1) per status, pruned with the archive (forgetStatusProvenance). */
  private noteStatusProvenance(agent: string, id: string, p: StatusProvenance | undefined): void {
    try { this.store.setStatusProvenance(agent, id, JSON.stringify(p ?? {})); } catch (err) {
      this.log.warn("status_provenance_failed", { agent, err: (err as Error).message });
    }
  }

  /** The archive deleted these own agents: their provenance rows go too. */
  forgetStatusProvenance(agents: readonly string[]): void {
    if (agents.length) this.store.deleteStatusProvenance(agents);
  }

  /**
   * Whether a peer gets an agent.status in full (MISSION-1 fix rounds 3-5, Opus r3 #1 / r4 #4, Codex r4 #2-3). An own
   * status only if it is what today's sharing policy would sign (its provenance as recorded when it was signed; none =
   * unknown). And, for a peer that accepts status stubs (`legacy` false), only the LATEST status of its (machine,
   * agent). A peer that does not (an older version) still gets superseded statuses that pass the policy in full (a stub
   * would stall its replication), and other machines' statuses in full (their policy can't be judged here); this is
   * why every machine must run this version before members are added. Anything else is served as its stub.
   */
  serveStatusInFull(ev: Event, opts: { legacy?: boolean } = {}): boolean {
    if (ev.kind !== "agent.status") return true;
    const body = ev.body as BodyOf<"agent.status">;
    const own = ev.origin === this.nodeId;
    if (own && !this.compliant(body.agent, ev.id, body)) return false;
    const latest = this.store.agent(ev.origin, body.agent);
    if (latest && latest.event_id === ev.id) return true;
    // Superseded. A peer that takes stubs gets the stub. One that doesn't (older) gets it in full only when that can't
    // disclose anything: this node's own compliant status, or a status carrying no free text at all (round 6, Codex
    // r5 #1: whatever the requester claims, another machine's superseded text is never served in full).
    return !!opts.legacy && (own || contentFree(body));
  }

  private compliant(agent: string, id: string, body: BodyOf<"agent.status">): boolean {
    const prov = this.provenanceOf(agent, id) ?? undefined;
    const now = this.projectOwnStatus(body, prov);
    const keep = typeof body.observed_at === "number" ? { ...now, observed_at: body.observed_at } : now;
    return canonicalJson(stripUndefined(keep)) === canonicalJson(body);
  }

  /**
   * This node's latest statuses that the current policy would not sign (sharing was narrowed, or they predate the
   * projection) are re-signed, re-projected, so the old ones become superseded and are stubbed everywhere. The copy
   * carries `observed_at` = when the status was really observed: publication time is not liveness, so a long-dead
   * agent stays archived / stale (Opus r4 #1, Codex r4 #6). At most `batch` per call (the archive upkeep, every
   * minute): a first run after the upgrade is spread out. Returns how many were re-signed.
   */
  reprojectOwnStatuses(batch = REPROJECT_BATCH): number {
    if (!this.teamId || !this.me()) return 0;
    let n = 0;
    for (const row of this.store.agents()) {
      if (n >= batch) break;
      if (row.node !== this.nodeId) continue;
      const body = JSON.parse(row.body) as BodyOf<"agent.status">;
      if (this.compliant(row.agent, row.event_id, body)) continue;
      const prov = this.provenanceOf(row.agent, row.event_id) ?? undefined;
      const observedAt = typeof body.observed_at === "number" ? Math.min(body.observed_at, row.ts) : row.ts;
      try {
        if (!this.limiter.take(`status:${row.agent}`, this.limits.status)) continue; // try again next pass
        this.emit("agent.status", body, { agent: row.agent, ...(prov ? { provenance: prov } : {}), observedAt });
        n++;
      } catch (err) {
        this.log.warn("status_reproject_failed", { agent: row.agent, err: (err as Error).message });
      }
    }
    return n;
  }

  /**
   * The body of a roster event this authority signs: caller-supplied chain fields are replaced by
   * the link to the transfer (if due), the request id (C5) and the watermark `wm` (this node's
   * version vector now, PROTOCOL §2 "Anchoring"); a channel.upsert states its members/archived (F4).
   */
  private chainBody(kind: Kind, body: Record<string, unknown>, requestId: string | undefined): Record<string, unknown> {
    // invite_code proves who minted an id. It stays on the request and never on the chain.
    const { wm: _wm, after: _after, request_id: _rid, invite_code: _inviteCode, ...rest } = body;
    this.checkPlan(kind, rest);
    let b = rest;
    if (kind === "channel.upsert") {
      const up = rest as BodyOf<"channel.upsert">;
      // The `p-` prefix is reserved for project channels, created with the projects code's marker (Opus r1 M3).
      if (!this.roster.channels.has(up.name) && up.name.startsWith("p-") && up.project !== true) {
        throw new HttpError(409, "conflict", "channel names starting with p- are reserved for projects (walkie projects create)");
      }
      if (!this.roster.channels.has(up.name) && up.project === true) this.projectQuota?.();
      if (!this.roster.channels.has(up.name) && this.roster.channels.size >= MAX_CHANNELS_PER_TEAM) {
        throw new HttpError(409, "channel_limit", `this team already has ${MAX_CHANNELS_PER_TEAM} channels`);
      }
      b = completeChannelUpsert(up, this.roster) as Record<string, unknown>;
    }
    if (kind === "team.node") {
      const n = rest as BodyOf<"team.node">;
      this.checkNodeCapacity(n.node_id, n.login, n.revoked === true);
    }
    const link = this.chain.pendingLink;
    // A license or integration entry carries no watermark: it never anchors anything (PROTOCOL §2 "Licenses").
    const wm = kind === "team.license" || kind === "team.integration" ? {} : { wm: this.watermark() };
    return { ...b, ...(link ? { after: link } : {}), ...(requestId ? { request_id: requestId } : {}), ...wm };
  }

  /**
   * Soft plan enforcement (src/license/enforce.ts): throws 402 `plan_limit` when a roster event this
   * authority is about to emit would add people, machines or a restricted channel beyond the plan.
   * Emit-time only: validity of events on every node is unaffected.
   */
  checkPlan(kind: string, body: Record<string, unknown>, now = this.planNow()): void {
    assertPlanAllows(this.roster, kind, body, Math.max(now, this.floor), this.clock());
  }

  /** The team's effective plan and usage (null before the team exists). */
  plan(now = this.planNow()): PlanView | null {
    const r = this.roster;
    if (!r.team) return null;
    return planView(r.license, r.team.created_ts, { people: peopleUsed(r), machines: machinesUsed(r) }, Math.max(now, this.floor), this.clock());
  }

  /**
   * The authority's watermark (PROTOCOL §2 "Anchoring"): its version vector restricted to origins in the
   * roster, i.e. nodes ever admitted, so its size is bounded by MAX_NODES_PER_TEAM (H1/F5).
   */
  private watermark(): Record<string, number> {
    const nodes = this.roster.nodes;
    return Object.fromEntries(Object.entries(this.store.vv()).filter(([o]) => nodes.has(o)));
  }

  /** Throws `409 node_limit` if admitting (nodeId, login) would exceed the node limits (H1/F5). */
  checkNodeCapacity(nodeId: string, login: string, revoked = false): void {
    if (nodeCapacity(this.roster, nodeId, login, revoked).status === "ok") return;
    throw new HttpError(409, "node_limit",
      `node limit reached: at most ${MAX_NODES_PER_LOGIN} active machines per member and ${MAX_NODES_PER_TEAM} machines ever admitted per team; an owner can revoke unused machines`);
  }

  /** `walkie init`: mints the team id and emits team.create (seq 1) signed by this node. */
  createTeam(name: string, handle: string, direct?: { login: string }): Event {
    if (this.teamId) throw new HttpError(409, "team_exists", "this node already belongs to a team");
    if (this.store.countEvents() > 0) throw new HttpError(409, "team_exists", "this node has history from another team; use a fresh WALKIE_HOME");
    // A Walkie Direct team has no Tailscale login: the founder's login is its Direct login (direct:<handle>).
    const login = direct?.login ?? this.login;
    if (!login) throw new HttpError(409, "tailscale_unavailable", "Tailscale identity unavailable; run walkie doctor");
    const ts = this.clock();
    const team = deriveTeamId(this.keys.pubkey, name, ts);
    const body: BodyOf<"team.create"> = {
      name, owner_login: login, owner_handle: handle, node_hostname: this.hostname,
      node_pubkey: this.keys.pubkey, node_ip: this.ip, ...(this.peerPort >= 1 ? { node_port: this.peerPort } : {}),
      peer_sig_v1: true,
    };
    const ev = signEvent(this.keys, {
      v: PROTOCOL_VERSION, team, id: eventId(this.nodeId, 1), origin: this.nodeId, seq: 1, ts,
      author: { handle, node: this.nodeId }, kind: "team.create" as const, body,
    });
    this.store.setMeta("team", team);
    this.store.setMeta("validity_version", VALIDITY_VERSION);
    const res = this.ingest(ev, "local");
    if (res.status !== "accepted") {
      this.store.db.query("DELETE FROM meta WHERE key = 'team'").run();
      throw rejectionError(res.reason ?? "rejected");
    }
    return ev;
  }

  /** Records the team id learned from the authority during join. */
  adoptTeam(team: string): void {
    const cur = this.teamId;
    if (cur && cur !== team) throw new HttpError(409, "team_exists", "this node already belongs to another team");
    if (!/^[0-9a-f]{16}$/.test(team)) throw new HttpError(502, "bad_peer", "peer returned an invalid team id");
    this.store.setMeta("team", team);
    this.store.setMeta("validity_version", VALIDITY_VERSION);
    if (!cur) this.chain = this.newChain(team);
  }
}

function rejectionError(reason: string): HttpError {
  const status = reason === "rate_limited" ? 429 : reason.startsWith("unknown_") || reason === "no_team" ? 409 : 403;
  return new HttpError(status, status === 403 ? "forbidden" : "conflict", `event rejected: ${reason}`);
}

function stripUndefined<T>(body: T): T {
  return JSON.parse(JSON.stringify(body)) as T;
}

function isStubShape(input: unknown): boolean {
  return typeof input === "object" && input !== null && (input as { redacted?: unknown }).redacted === true && !("sig" in input);
}
