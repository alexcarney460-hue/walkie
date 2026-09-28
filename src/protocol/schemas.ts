// Walkie wire contract. Every surface (daemon, CLI, MCP, hooks, dashboard)
// validates against these schemas. See docs/PROTOCOL.md for semantics.
import type { OrchMessage } from "./orchestrator.ts";
import { z } from "zod";
import type { ArchiveCount } from "./agent-roster.ts";
import { PeerCapabilities } from "./capabilities.ts";
import { MachineStats } from "./machine-stats.ts";
import { PoolShare } from "./pool.ts";
import { AccountsSnapshot } from "./accounts.ts";
import type { BoardDelta } from "./projects/schema.ts";

export const PROTOCOL_VERSION = 1;

// ---- identifiers -----------------------------------------------------------

/** Short human handle chosen at invite time: "alex", "kira". */
export const Handle = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/);
/** Node id = first 16 hex chars of sha256(node public key, raw 32 bytes). */
export const NodeId = z.string().regex(/^[0-9a-f]{16}$/);
/** Agent name, unique per machine: "claude-3f9a", "ux-seat". */
export const AgentName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/);
/** Channel name without the leading '#'. */
export const ChannelName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
/** Event id = "<nodeId>:<seq>". Deterministic, globally unique, dedupe key. */
export const EventId = z.string().regex(/^[0-9a-f]{16}:[1-9][0-9]*$/);
/** sha256 hex of artifact content. */
export const BlobHash = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Address for asks / mentions.
 *   @kira                 any agent of that person (first to answer wins)
 *   @kira/kiras-mbp       any agent on that machine (machine = node hostname)
 *   @kira/kiras-mbp/ux    one specific agent
 */
export const Address = z.string().regex(/^@[a-z][a-z0-9-]{0,23}(\/[a-z0-9][a-z0-9.-]{0,62}(\/[a-z0-9][a-z0-9._-]{0,47})?)?$/);

export const Role = z.enum(["owner", "member", "observer"]);
export type Role = z.infer<typeof Role>;

export const AgentState = z.enum(["working", "idle", "waiting", "blocked", "offline"]);
export type AgentState = z.infer<typeof AgentState>;

export const AskPolicy = z.enum(["auto", "human", "off"]);

/** How a node is reached (PROTOCOL §4): HTTP over the tailnet, or Walkie Direct (iroh QUIC, dialed by node key). */
export const TransportKind = z.enum(["tailscale", "direct"]);
export type TransportKind = z.infer<typeof TransportKind>;
/** A transport name on the wire: lenient, so a future transport doesn't make v0.2 reject the whole event. */
export const TransportName = z.string().regex(/^[a-z0-9-]{1,16}$/);
/** Hex of the raw 32-byte ed25519 node public key: the iroh endpoint id Walkie Direct dials. */
export const EndpointHex = z.string().regex(/^[0-9a-f]{64}$/);
/** sha256(invite secret) hex, first 32 chars: recorded on the chain so an invite is used once (PROTOCOL §4). */
export const InviteId = z.string().regex(/^[0-9a-f]{32}$/);

// ---- event bodies (discriminated on kind) -----------------------------------

const Text = z.string().min(1).max(32_000);

/**
 * Watermark on every roster chain entry (PROTOCOL §2 "Anchoring"): the authority's version vector
 * when it emitted the entry (every origin it knows, highest contiguous seq). A non-roster event is
 * judged against the roster just before the first chain entry whose watermark covers it.
 */
export const MAX_WM_ORIGINS = 4_096;
export const Watermark = z.record(NodeId, z.number().int().nonnegative())
  .refine((w) => Object.keys(w).length <= MAX_WM_ORIGINS, { message: `at most ${MAX_WM_ORIGINS} watermark origins` });

/** sha256 hex of a signed roster request (PROTOCOL §2 "Roster requests"). */
export const RequestId = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Fields every roster event may carry (PROTOCOL §2 "Roster"): `after` links a new authority's first
 * roster event to the transfer that made it authority; `requested_by` names the member whose roster
 * request the authority applied and `request_id` that request; `wm` is the authority's watermark.
 */
const ChainFields = {
  after: z.string().regex(/^[0-9a-f]{16}:[1-9][0-9]*$/).optional(),
  requested_by: Handle.optional(),
  request_id: RequestId.optional(),
  wm: Watermark.optional(),
};

export const Bodies = {
  /** First event of a team. Signed by the founding node, which it also admits. */
  "team.create": z.object({
    name: z.string().min(1).max(60),
    owner_login: z.string().min(1).max(200),
    owner_handle: Handle,
    node_hostname: z.string().min(1).max(63),
    node_pubkey: z.string(), // base64 raw ed25519 public key
    node_ip: z.string().max(45),
    node_port: z.number().int().min(1).max(65535).optional(), // default 7458
  }),
  /** Add/change/remove a member. Authority-signed only. role "removed" revokes. */
  "team.member": z.object({
    login: z.string().min(1).max(200),
    handle: Handle,
    role: z.union([Role, z.literal("removed")]),
    display_name: z.string().max(60).optional(),
    ...ChainFields,
  }),
  /** Admit (or revoke) a machine of an existing member. Authority-signed only. */
  "team.node": z.object({
    node_id: NodeId,
    login: z.string().min(1).max(200),
    hostname: z.string().min(1).max(63),
    pubkey: z.string(),
    ip: z.string().max(45),
    port: z.number().int().min(1).max(65535).optional(), // default 7458
    revoked: z.boolean().optional(),
    /** v0.2 (additive): the node's iroh endpoint id (= its pubkey, hex); informational, the pubkey is what's trusted. */
    endpoint: EndpointHex.optional(),
    /** v0.2 (additive): transports the node serves; absent = ["tailscale"] (every v0.1 node). */
    transports: z.array(TransportName).min(1).max(4).optional(),
    /** v0.2 (additive): the Direct invite this admission used (single use, PROTOCOL §4). */
    invite: InviteId.optional(),
    ...ChainFields,
  }),
  /**
   * Create/update a channel. `members` present = restricted (handles). On an existing channel an
   * omitted `members`, `archived` or `topic` is unchanged (the authority fills the previous values
   * before signing); `public: true` (without `members`) makes it team-wide again. Authority-signed;
   * any non-observer may *request* a NEW public channel (PROTOCOL §2).
   */
  "channel.upsert": z.object({
    name: ChannelName,
    topic: z.string().max(200).optional(),
    members: z.array(Handle).max(50).optional(),
    public: z.boolean().optional(),
    archived: z.boolean().optional(),
    /**
     * WALKIE-PROJECTS-1 (additive): set when the channel is CREATED by the projects code. Only such a `p-<8 hex>`
     * channel is a project channel; an older `p-…` channel stays an ordinary one (round-1 audit, Opus M3).
     */
    project: z.literal(true).optional(),
    /**
     * Remote seats (additive, PRE4 RC Codex 5): set by the seats host on the `seats-<node id>` channel it creates or
     * re-shapes. From the chain entry that first carries it the channel is a seats channel and the seats content rule
     * applies (roster.ts seatsContent); history before it, and a same-named channel never marked, stay ordinary.
     */
    seats: z.literal(true).optional(),
    ...ChainFields,
  }),
  /**
   * Records a vendor-signed license (src/license/format.ts) on the chain. Authority-signed only; every
   * node verifies the key's signature against the embedded vendor key when folding, and an invalid key
   * is rejected and not applied. The latest applied license wins. Its `wm`, if any, is ignored: a
   * license entry never anchors anything (PROTOCOL §2 "Licenses").
   */
  "team.license": z.object({
    key: z.string().min(1).max(4_096),
    ...ChainFields,
  }),
  /** Moves roster authority to another admitted owner node. Authority-signed only. */
  "team.authority": z.object({
    node_id: NodeId,
    ...ChainFields,
  }),
  /**
   * A connector enabled (or disabled) on one machine, decided by the authority within the plan's
   * integration entitlement (PROTOCOL §2 "Licenses"; LICENSE-FIX-2 F3). Authority-signed only; a
   * member requests it for its own node. Like `team.license` it anchors nothing: any `wm` is ignored.
   */
  "team.integration": z.object({
    connector: z.enum(["fireflies", "wispr", "linear"]),
    node: NodeId,
    enabled: z.boolean(),
    ...ChainFields,
  }),
  /** A board message. thread = root event id; omit to start a new thread. */
  "msg.post": z.object({
    text: Text,
    thread: EventId.optional(),
    mentions: z.array(Address).max(20).optional(),
    artifacts: z.array(BlobHash).max(10).optional(),
  }),
  /** Directed request to an agent/person. Pending until an answer references it or it expires. */
  "ask": z.object({
    to: Address,
    text: Text,
    expires_at: z.number().int(), // unix ms
    artifacts: z.array(BlobHash).max(10).optional(),
  }),
  "answer": z.object({
    ask: EventId,
    text: Text,
    declined: z.boolean().optional(),
    artifacts: z.array(BlobHash).max(10).optional(),
  }),
  /** Latest-wins status per agent (compacted). Emitted by hooks / set_status. */
  "agent.status": z.object({
    agent: AgentName,
    state: AgentState,
    runtime: z.enum(["claude-code", "codex", "kimi", "cli", "other"]).default("other"),
    title: z.string().max(200).optional(),       // what it's doing, one line
    task: z.string().max(80).optional(),         // e.g. "ALE-5156"
    repo: z.string().max(120).optional(),
    branch: z.string().max(120).optional(),
    cwd: z.string().max(300).optional(),         // home-relative, "~/workspace/x"
    activity: z.string().max(200).optional(),    // last tool action: "Edit src/x.ts"
    model: z.string().max(60).optional(),
    session: z.string().max(80).optional(),
    started_at: z.number().int().optional(),
    ask_policy: AskPolicy.optional(),
    /**
     * Set only on a status re-signed later under a narrower sharing policy (MISSION-1 fix 5): when it was really
     * observed. Freshness (stale, archive) counts from it, never from the re-signing. Older nodes ignore it.
     */
    observed_at: z.number().int().nonnegative().optional(),
    /**
     * A sub-agent's row (WALKIE-MISSION-SUB-1, src/protocol/subagents.ts): the agent name of the session that started
     * it (its own name is "<parent>.<id>"), or the host's `seats` card for a `seat-*` agent. Older nodes ignore
     * the parent and show each child as an agent of its own.
     */
    parent: AgentName.optional(),
    /** Handle that requested a host-owned seat; older peers ignore this optional field. */
    launcher: Handle.optional(),
    subagent_type: z.string().min(1).max(60).optional(),
    /**
     * AGENT-SEE-1: how the agent runs, when known: "headless" (a one-shot run: `claude -p`, `codex exec`, `kimi -p`, or
     * no terminal) or "acp" (through an editor's ACP adapter). A short word, not an enum, so a later value never makes a
     * newer node reject the status; malformed: dropped. Older nodes ignore it.
     */
    launch: z.string().regex(/^[a-z][a-z0-9-]{0,15}$/).optional().catch(undefined),
    /**
     * AGENT-SEE-1: the runtime's own name when `runtime` is "other" (grok, gemini, opencode): the wire enum has no value
     * for them, and adding one would make older nodes reject the status. Malformed: dropped. Older nodes ignore it.
     */
    runtime_name: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).optional().catch(undefined),
  }),
  /** Artifact announcement; content lives in the blob store, fetched on demand. */
  "artifact.share": z.object({
    hash: BlobHash,
    name: z.string().min(1).max(200),
    size: z.number().int().nonnegative().max(25 * 1024 * 1024),
    mime: z.string().max(100),
    note: z.string().max(2000).optional(),
    thread: EventId.optional(),
  }),
} as const;

export type Kind = keyof typeof Bodies;
export const KINDS = Object.keys(Bodies) as Kind[];
export const KindSchema = z.enum(KINDS as [Kind, ...Kind[]]);
export type BodyOf<K extends Kind> = z.infer<(typeof Bodies)[K]>;

// ---- event envelope --------------------------------------------------------

export const Author = z.object({
  handle: Handle,
  node: NodeId,
  agent: AgentName.optional(), // absent = a human acting via CLI/dashboard
});
export type Author = z.infer<typeof Author>;

/** Fields covered by the signature. */
export const UnsignedEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  team: z.string().regex(/^[0-9a-f]{16}$/), // team id minted at `walkie init`, bound to the founder key (see ids.ts deriveTeamId)
  id: EventId,
  origin: NodeId,
  seq: z.number().int().positive(),
  ts: z.number().int(), // origin wall clock, unix ms
  author: Author,
  kind: KindSchema,
  channel: ChannelName.optional(), // required for msg.post / artifact.share; optional for ask
  body: z.record(z.unknown()),
  /** Header signature over canonicalJson(EventHeader) by the origin; lets stubs be verified (PROTOCOL §3). */
  hsig: z.string().max(200).optional(),
});
export type UnsignedEvent = z.infer<typeof UnsignedEvent>;

export const Event = UnsignedEvent.extend({ sig: z.string() }); // base64 ed25519 over canonicalJson(unsigned)

/** Largest serialized event accepted (PROTOCOL §2 rule 1); peer pages are byte-budgeted well above it. */
export const MAX_EVENT_BYTES = 256 * 1024;
export type Event = z.infer<typeof Event>;

/** The fields covered by `hsig`: enough to place and route an event without its body. */
export interface EventHeader {
  v: number; team: string; id: string; origin: string; seq: number; ts: number; kind: string; channel?: string;
}

/**
 * Tombstone stub served in place of an event the requesting peer may not see
 * (restricted channel). Keeps per-origin seq contiguity. `hsig` is the origin's
 * header signature, so a relay can't invent a stub or move an event into another
 * channel. `channel` lets a peer that IS a member refuse the stub and fetch the
 * real event elsewhere.
 */
export const Stub = z.object({
  id: EventId,
  origin: NodeId,
  seq: z.number().int().positive(),
  ts: z.number().int(),
  kind: KindSchema,
  channel: ChannelName.optional(),
  hsig: z.string().max(200),
  redacted: z.literal(true),
});
export type Stub = z.infer<typeof Stub>;

// ---- peer API bodies -------------------------------------------------------

export const PeerJoinReq = z.object({
  pubkey: z.string().min(40).max(64),
  hostname: z.string().min(1).max(63),
  ip: z.string().max(45),
  port: z.number().int().min(1).max(65535).optional(), // joiner's peer port, default 7458
  /** Walkie Direct: the invite code (PROTOCOL §4). Never logged. */
  invite: z.string().min(1).max(512).optional(),
});
export const PeerEventsPush = z.object({ events: z.array(z.unknown()).max(100) });

// Peer API responses, validated by the client (a peer is not trusted to send well-formed data).
const PeerOwnerAddrSchema = z.object({
  node_id: z.string().max(64), hostname: z.string().max(100), ip: z.string().max(45), port: z.number().int().min(1).max(65535),
  pubkey: z.string().max(64).optional(), transports: z.array(TransportName).max(4).optional(), relay: z.string().max(200).optional(),
});
export const PeerHelloRes = z.object({
  team: z.string().max(64), name: z.string().max(100), node_id: z.string().max(64), hostname: z.string().max(100),
  authority: PeerOwnerAddrSchema.nullable(),
});
export const PeerVvRes = z.object({
  capabilities: PeerCapabilities.optional().catch(undefined),
  node: z.string().max(64), vv: z.record(z.number().int().nonnegative()), ts: z.number(),
  /** The peer's machine stats (PROTOCOL §3 "Machine stats"); a malformed value is dropped, never fails the sync. */
  stats: MachineStats.optional().catch(undefined),
  /** The peer's provider accounts (PROTOCOL §3 "Accounts"); a malformed or oversized value is dropped, never fails the sync. */
  accounts: AccountsSnapshot.optional().catch(undefined),
  /** v0.2 mixed teams (additive): node ids the peer reached itself within its liveness window. */
  online: z.array(NodeId).max(1024).optional(),
  /** WALKIE-POOL-2 (additive): the peer's split-run sharing state; malformed is dropped. */
  pool: PoolShare.optional().catch(undefined),
});
export const PeerEventsRes = z.object({ events: z.array(z.unknown()).max(500) });
export const PeerPushResSchema = z.object({
  accepted: z.number().int(), pending: z.number().int(), rejected: z.array(z.object({ id: z.string(), reason: z.string() })).max(500),
});
export const PeerJoinResSchema = z.object({
  admitted: z.boolean(), team: z.string().max(64).optional(), node_id: z.string().max(64).optional(),
  reason: z.enum(["not_member", "not_authority", "pending_approval"]).optional(), authority: PeerOwnerAddrSchema.optional(),
});
/**
 * A non-authority node asking the roster authority to append a roster event (PROTOCOL §4
 * `/peer/v1/roster-request`). `sig` = the requester node's signature over canonicalJson of the other
 * fields plus `team`. `team.admit` ({node_id, approve}) decides a join request held by the authority.
 */
export const RosterRequestKind = z.enum(["team.member", "team.node", "channel.upsert", "team.authority", "team.license", "team.integration", "team.admit"]);
export type RosterRequestKind = z.infer<typeof RosterRequestKind>;
export const RosterRequest = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/), kind: RosterRequestKind, body: z.record(z.unknown()),
  node: NodeId, ts: z.number().int(), sig: z.string().max(200),
});
export type RosterRequest = z.infer<typeof RosterRequest>;
export const RosterRequestRes = z.object({ event: z.unknown().nullable() });
/** A serialized `/peer/v1/events` response stops before this many bytes (the client accepts 1 MiB). */
export const PEER_PAGE_BUDGET = 768 * 1024;
/** `GET /peer/v1/events?ids=a,b` (stub fill, PROTOCOL §3). */
export const MAX_IDS_PER_FETCH = 100;

export interface PeerOwnerAddr {
  node_id: string; hostname: string; ip: string; port: number;
  /** v0.2: the authority's node key (base64), transports and relay hint, so a Direct joiner can dial it. */
  pubkey?: string; transports?: string[]; relay?: string;
}
export interface PeerHello { team: string; name: string; node_id: string; hostname: string; authority: PeerOwnerAddr | null }
export interface PeerVv { capabilities?: PeerCapabilities; node: string; vv: Record<string, number>; ts: number; stats?: MachineStats; accounts?: AccountsSnapshot; online?: string[]; pool?: PoolShare }
export interface PeerJoinRes {
  admitted: boolean; team?: string; node_id?: string;
  reason?: "not_member" | "not_authority" | "pending_approval"; authority?: PeerOwnerAddr;
}
export interface PeerPushRes { accepted: number; pending: number; rejected: { id: string; reason: string }[] }

// ---- local API request bodies ----------------------------------------------

export const PostReq = z.object({
  channel: ChannelName,
  text: Text,
  thread: EventId.optional(),
  artifacts: z.array(BlobHash).max(10).optional(),
  raw: z.boolean().optional(), // skip secret redaction
});
export const AskReq = z.object({
  to: Address,
  text: Text,
  channel: ChannelName.optional(),
  timeout_s: z.number().int().min(1).max(86_400).default(300),
  artifacts: z.array(BlobHash).max(10).optional(),
});
export const AnswerReq = z.object({
  ask: EventId,
  text: Text,
  declined: z.boolean().optional(),
  artifacts: z.array(BlobHash).max(10).optional(),
});
export const StatusReq = Bodies["agent.status"];
export const DeliveriesReq = z.object({ ids: z.array(EventId).min(1).max(100) });
export const ChannelReq = Bodies["channel.upsert"];
export const InviteReq = z.object({ login: z.string().min(1).max(200), handle: Handle, role: Role, display_name: z.string().max(60).optional() });
export const EventsQuery = z.object({
  channel: ChannelName.optional(),
  thread: EventId.optional(),
  kinds: z.string().optional(), // comma list
  before_ts: z.coerce.number().int().optional(),
  since_ts: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// ---- local API response views ----------------------------------------------

/** The team's effective plan (src/license/plans.ts): license (valid or in grace), else trial, else Free. */
export type PlanName = "free" | "team" | "business";
export interface EntitlementsView {
  /** null = unlimited. */
  people: number | null;
  machines: number | null;
  restricted_channels: boolean;
  /** Integrations that may be enabled at once; null = all. */
  integrations: number | null;
  audit_export: boolean;
  join_approval: boolean;
}
export interface PlanView {
  plan: PlanName;
  /** active = a valid license; grace = expired under 14 days ago; trial = the 14-day Team trial; free = none of these. */
  status: "active" | "grace" | "trial" | "free";
  entitlements: EntitlementsView;
  /** People (non-removed members) and machines (active nodes) in use, with the plan's limit (null = unlimited). */
  seats: { used: number; limit: number | null };
  machines: { used: number; limit: number | null };
  /** The license on the chain, if any (also after it lapsed past grace). */
  license: {
    lic_id: string; plan: "team" | "business"; seats: number; email: string;
    interval: "month" | "year"; issued_at: number; expires_at: number; grace_ends_at: number;
  } | null;
  /** While the trial runs. */
  trial: { ends_at: number; days_left: number } | null;
  /**
   * Where to add seats: the billing portal while a license is active (an existing subscriber changes
   * its seat count there; never a second checkout), else checkout for the current people count.
   * manage = the billing portal.
   */
  upgrade_url: string;
  manage_url: string;
}

/** Extra fields of a 402 `plan_limit` error (inside `error`, next to code and message). */
export interface PlanLimitDetails {
  /** `projects` / `boards` (WALKIE-PROJECTS-1): checked by the node creating them, never by the chain. */
  resource: "people" | "machines" | "restricted_channels" | "integrations" | "projects" | "boards";
  limit: number; used: number; plan: PlanName;
  /** True when the team already has an active license: `upgrade_url` is then the billing portal. */
  subscribed?: boolean;
  upgrade_url: string;
}

export interface MeView {
  version: string;
  protocol: number;
  team: { id: string; name: string } | null;
  node: { id: string; hostname: string; ip: string; port: number };
  handle: string | null;
  role: Role | null;
  tailscale: { ok: boolean; login: string | null; error?: string };
  /**
   * v0.2: how this node reaches its team. `mode` null = not decided yet (no team). `direct` is present
   * while the Walkie Direct endpoint runs: its endpoint id and home relay (null until connected).
   */
  transport?: {
    mode: TransportKind | null; direct?: { endpoint: string; relay: string | null };
    /** v0.2 mixed teams: the transports this machine serves now (a dual machine: both). */
    transports?: TransportKind[];
  };
  /** The team's plan; null before the team exists. */
  plan: PlanView | null;
}

export interface MemberView { login: string; handle: string; role: Role; display_name?: string }
export interface NodeView {
  node_id: string; handle: string; hostname: string; ip: string;
  /** v0.2: the transports this machine serves (absent in v0.1 = tailscale). */
  transports?: TransportKind[];
  /**
   * v0.2 mixed teams: how this node reaches it; "relay" = no transport in common (its events come through
   * machines that serve both, and `online` is what they report).
   */
  via?: TransportKind | "relay";
  online: boolean; last_seen: number | null; rtt_ms: number | null; self: boolean;
  /** This node is the team's roster authority (PROTOCOL §2). */
  authority?: boolean;
  sync: { behind: number; last_sync: number | null; error?: string; skew_ms?: number }; // skew = peer clock - ours
  /** Memory and temperature, the last the node published (`at` on this node's clock); absent = never reported. */
  stats?: MachineStats;
  /** WALKIE-POOL-2: whether its owner shares it for split runs (absent = an older Walkie, or never reported). */
  pool?: PoolShare;
}
export interface ChannelView {
  name: string; topic?: string; members?: string[]; archived?: boolean; last_ts: number | null; count: number;
  /** WALKIE-PROJECTS-1: a project's channel (shown in Projects, not in the channel list). */
  project?: true;
}
export interface TeamView {
  id: string; name: string; members: MemberView[]; nodes: NodeView[]; channels: ChannelView[];
  /** Node id of the roster authority (PROTOCOL §2). */
  authority: string | null;
  plan: PlanView;
}

export interface AgentView {
  id: string;              // "<handle>/<hostname>/<agent>"
  handle: string; node: string; hostname: string; agent: string;
  status: BodyOf<"agent.status">;
  updated_at: number;
  machine_online: boolean;
  effective_state: AgentState; // "offline" when the machine is offline or status is stale (>30 min working w/o update)
  /** In the Agent archive (agent-roster.ts isArchived): idle for 30 min or offline for 10 min. */
  archived: boolean;
  /** When the current effective state began, and the current activity line (agent-since.ts; absent: older daemon). */
  state_since?: number;
  activity_since?: number;
  /** A session's sub-agents in the live roster (WALKIE-MISSION-SUB-1): absent when it has none. */
  subagents?: { working: number; live: number };
}

/** GET /v1/agents and the stream's `agents` message: the agents asked for, plus the archive's size per machine. */
export interface AgentsPayload {
  agents: AgentView[];
  /** Per machine: archived agents that are idle / offline (agent-roster.ts). */
  archive: ArchiveCount[];
  /** Changes whenever the archive's contents change (not only its counts): a loaded archive list refreshes on it. */
  archive_rev?: number;
  /** scope archive / all: how many agents match the filters, how many were skipped (offset), and whether more remain. */
  total?: number;
  offset?: number;
  truncated?: boolean;
}

export interface AskView {
  ask: Event;
  answers: Event[];
  state: "open" | "answered" | "declined" | "expired";
  /**
   * When the ask expires on THIS node: the body's `expires_at`, but never later than its own timeout
   * (at most a day) counted from when this node received it (a peer's clock can't keep an ask open).
   */
  expires_at: number;
}

/** Server-sent events on GET /v1/stream (event: <type>, data: JSON). */
export type StreamMessage =
  | { type: "event"; event: Event }
  /** The whole live roster. `rev`: the roster revision it is (a delta stream's deltas chain from it). */
  | ({ type: "agents"; rev?: number } & AgentsPayload)
  /**
   * `GET /v1/stream?agents=delta` only: the rows that changed since revision `base` (whole rows, idempotent), the rows
   * that left as `<node id>/<agent>` keys (a row's identity; the display id can repeat across one person's machines),
   * and the archive counts. A client whose revision is not `base` missed something and reconnects.
   */
  | { type: "agents.delta"; base: number; rev: number; upsert: AgentView[]; remove: string[]; archive: ArchiveCount[]; archive_rev?: number }
  | { type: "nodes"; nodes: NodeView[] }
  /** The team's pooled provider accounts (GET /v1/accounts), on change. */
  | { type: "accounts"; accounts: AccountView[] }
  | { type: "hello"; me: MeView }
  /** Previously delivered events that a roster change made invalid: clients drop them. */
  | { type: "hidden"; ids: string[] }
  /** Live orchestrator progress on this machine's host; never stored or replicated (PROTOCOL §8; dashboard streams only). */
  | { type: "orchestrator"; live: OrchestratorLive }
  /** A message of this machine's local orchestrator conversation, stored or updated (dashboard streams only). */
  | { type: "orchestrator_message"; message: OrchMessage }
  /** WALKIE-PROJECTS-1: a project's board changed (cards changed or gone, the project's view); only visible projects. */
  | ({ type: "board" } & BoardDelta);

/**
 * One step of a reply in progress on this machine's orchestrator host (local dashboard streams only). `turn` = the id
 * of the message being answered, `thread` = its conversation. start → delta/tool… → end (then the reply arrives as an
 * `orchestrator_message`).
 */
export interface OrchestratorLive {
  thread: string; turn: string;
  phase: "start" | "delta" | "tool" | "end";
  /** delta: text appended to the reply. */
  text?: string;
  /** tool: "Bash bun test", "Edit src/x.ts". */
  tool?: string;
}

export type { AccountView } from "./accounts.ts";
import type { AccountView } from "./accounts.ts";

export interface ApiError { error: { code: string; message: string } & Partial<PlanLimitDetails> }
