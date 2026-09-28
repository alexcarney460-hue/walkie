// In-memory model of one daemon's view of a fictional team. Everything here is
// invented for demos and screenshots: no real people, hosts or paths.
import { AgentSince } from "../../src/protocol/agent-since.ts";
import { countSubagents } from "../../src/protocol/subagents.ts";
import type {
  AgentState, AgentView, AskView, BodyOf, ChannelView, Event, Kind, MeView, MemberView,
  NodeView, PlanView, Role, StreamMessage, TeamView,
} from "../../src/protocol/schemas.ts";
import type { MachineStats } from "../../src/protocol/machine-stats.ts";
import type { PoolShare } from "../../src/protocol/pool.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";
import { countByNode, isArchived, matchesSearch } from "../../src/protocol/agent-roster.ts";
import type { AgentsPayload } from "../../src/protocol/schemas.ts";
import { planView, seedPlan, type MockPlanState } from "./plan.ts";

export type StatusBody = BodyOf<"agent.status">;

export interface MockMember { login: string; handle: string; role: Role; display_name: string }
export interface MockNode {
  node_id: string; handle: string; hostname: string; ip: string; port: number;
  online: boolean; rtt_ms: number; last_seen: number; behind: number; last_sync: number;
  /** Memory + temperature the machine last published (absent = never reported). */
  stats?: MachineStats;
  /** WALKIE-POOL-2: split-run sharing (absent = an older Walkie). */
  pool?: PoolShare;
}
export interface MockAgent { handle: string; node: string; hostname: string; agent: string; status: StatusBody; updated_at: number }
export interface MockChannel { name: string; topic?: string; members?: string[]; archived?: boolean }
export interface PendingJoin { node_id: string; login: string; handle: string; hostname: string; ip: string; requested_at: number }

export const TEAM_ID = "7c1e4a90b25fd318";
export const VERSION = "0.1.0-mock";

/** Deterministic 16-hex node id from a hostname (the real one hashes the node pubkey). */
export function nodeIdFor(hostname: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`node:${hostname}`);
  return h.digest("hex").slice(0, 16);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
}

type Listener = (msg: StreamMessage) => void;

export class World {
  readonly members: MockMember[] = [];
  readonly nodes: MockNode[] = [];
  readonly channels: MockChannel[] = [];
  readonly events: Event[] = []; // ascending by insertion
  readonly agents = new Map<string, MockAgent>();
  readonly blobs = new Map<string, { bytes: Uint8Array; mime: string; name: string }>();
  readonly pending: PendingJoin[] = [];
  /** Provider accounts and usage (mock/accounts.ts); machine `online` follows the nodes. */
  accounts: AccountView[] = [];
  /** Plan state behind /v1/me, /v1/team and /v1/license (mock/plan.ts). */
  planState: MockPlanState = seedPlan("trial");
  /** WALKIE_MOCK_TRANSPORT: how this team connects (Walkie Direct: no tailnet IPs, invite codes). */
  transport: "tailscale" | "direct" = "tailscale";
  private readonly seqs = new Map<string, number>();
  private readonly since = new AgentSince();
  private readonly listeners = new Set<Listener>();

  constructor(
    readonly teamName: string,
    readonly meHandle: string,
    readonly meNodeHost: string,
    readonly hasTeam: boolean,
  ) {}

  // ---- lookups ---------------------------------------------------------------

  node(hostname: string): MockNode {
    const n = this.nodes.find((x) => x.hostname === hostname);
    if (!n) throw new Error(`unknown host ${hostname}`);
    return n;
  }
  nodeById(id: string): MockNode | undefined { return this.nodes.find((x) => x.node_id === id); }
  member(handle: string): MockMember | undefined { return this.members.find((m) => m.handle === handle); }
  me(): MockMember { return this.member(this.meHandle)!; }
  meNode(): MockNode { return this.node(this.meNodeHost); }
  agentKey(hostname: string, agent: string): string { return `${this.node(hostname).handle}/${hostname}/${agent}`; }

  // ---- events ----------------------------------------------------------------

  /** Append a locally-known event and fan it out to stream listeners. */
  emit(opts: { handle: string; hostname: string; agent?: string; kind: Kind; channel?: string; body: Record<string, unknown>; ts?: number; silent?: boolean }): Event {
    const node = this.node(opts.hostname);
    const seq = (this.seqs.get(node.node_id) ?? 0) + 1;
    this.seqs.set(node.node_id, seq);
    const event: Event = {
      v: 1, team: TEAM_ID, id: `${node.node_id}:${seq}`, origin: node.node_id, seq,
      ts: opts.ts ?? Date.now(),
      author: opts.agent ? { handle: opts.handle, node: node.node_id, agent: opts.agent } : { handle: opts.handle, node: node.node_id },
      kind: opts.kind,
      ...(opts.channel ? { channel: opts.channel } : {}),
      body: opts.body,
      sig: "bW9jay1zaWduYXR1cmUtbm90LXZlcmlmaWVk",
    };
    this.events.push(event);
    if (opts.kind === "agent.status") this.applyStatus(event);
    if (!opts.silent) {
      this.broadcast({ type: "event", event });
      if (opts.kind === "agent.status") this.broadcast({ type: "agents", ...this.agentsPayload() });
    }
    return event;
  }

  private applyStatus(event: Event): void {
    const body = event.body as StatusBody;
    const node = this.nodeById(event.origin)!;
    const key = `${node.handle}/${node.hostname}/${body.agent}`;
    this.agents.set(key, { handle: node.handle, node: node.node_id, hostname: node.hostname, agent: body.agent, status: body, updated_at: event.ts });
  }

  // ---- stream ----------------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  broadcast(msg: StreamMessage): void {
    for (const fn of this.listeners) fn(msg);
  }
  get listenerCount(): number { return this.listeners.size; }

  // ---- views -----------------------------------------------------------------

  meView(): MeView {
    const n = this.meNode();
    const m = this.me();
    return {
      version: VERSION, protocol: 1,
      team: this.hasTeam ? { id: TEAM_ID, name: this.teamName } : null,
      node: { id: n.node_id, hostname: n.hostname, ip: n.ip, port: 7458 },
      handle: this.hasTeam ? m.handle : null,
      role: this.hasTeam ? m.role : null,
      tailscale: this.transport === "direct" ? { ok: false, login: null, error: "tailscale CLI not found" } : { ok: true, login: m.login },
      transport: { mode: this.transport, ...(this.transport === "direct" ? { direct: { endpoint: sha256Hex(`endpoint:${n.hostname}`), relay: "https://usw1-1.relay.n0.iroh.link./" } } : {}) },
      plan: this.hasTeam ? this.planView() : null,
    };
  }

  planView(): PlanView {
    return planView(this.planState, { people: this.members.length, machines: this.nodes.length });
  }

  nodeViews(): NodeView[] {
    return this.nodes.map((n) => ({
      node_id: n.node_id, handle: n.handle, hostname: n.hostname, ip: this.transport === "direct" ? "" : n.ip, transports: [this.transport],
      online: n.online, last_seen: n.last_seen, rtt_ms: n.online ? n.rtt_ms : null,
      self: n.hostname === this.meNodeHost,
      ...(n.node_id === this.nodes[0]?.node_id ? { authority: true } : {}),
      sync: { behind: n.behind, last_sync: n.last_sync, ...(n.online ? {} : { error: "peer unreachable (timeout 2s)" }) },
      ...(n.stats ? { stats: n.stats } : {}),
      ...(n.pool ? { pool: n.pool } : {}),
    }));
  }

  accountViews(): AccountView[] {
    return this.accounts.map((a) => ({
      ...a,
      machines: a.machines.map((m) => {
        const online = this.nodes.find((n) => n.node_id === m.node_id)?.online ?? false;
        return { ...m, online, agents: online ? m.agents : [] };
      }),
    }));
  }

  channelViews(): ChannelView[] {
    return this.channels.map((c) => {
      const inChannel = this.events.filter((e) => e.channel === c.name && (e.kind === "msg.post" || e.kind === "artifact.share" || e.kind === "ask"));
      const last = inChannel.reduce<number | null>((acc, e) => (acc === null || e.ts > acc ? e.ts : acc), null);
      return { ...c, last_ts: last, count: inChannel.length };
    });
  }

  teamView(): TeamView {
    const members: MemberView[] = this.members.map((m) => ({ login: m.login, handle: m.handle, role: m.role, display_name: m.display_name }));
    return { id: TEAM_ID, name: this.teamName, members, nodes: this.nodeViews(), channels: this.channelViews(), authority: this.nodes[0]?.node_id ?? null, plan: this.planView() };
  }

  /** Every agent, live and archived (the daemon's views.ts agentsView). */
  agentViews(): AgentView[] {
    const rows = this.rawAgentViews();
    // A session's sub-agents (WALKIE-MISSION-SUB-1): counted on its row, which stays live while one works.
    const counts = countSubagents(rows);
    return rows.map((a) => {
      const c = a.status.parent ? undefined : counts.get(`${a.node}/${a.agent}`);
      return c ? { ...a, subagents: c, archived: a.archived && c.working === 0 } : a;
    });
  }

  private rawAgentViews(): AgentView[] {
    const now = Date.now();
    const list = [...this.agents.entries()].map(([id, a]) => {
      const node = this.nodeById(a.node)!;
      const stale = a.status.state !== "idle" && now - a.updated_at > 30 * 60_000;
      const effective: AgentState = !node.online || stale ? "offline" : a.status.state;
      return {
        id, handle: a.handle, node: a.node, hostname: a.hostname, agent: a.agent,
        status: a.status, updated_at: a.updated_at, machine_online: node.online, effective_state: effective,
        archived: isArchived({ effective_state: effective, updated_at: a.updated_at }, now),
      };
    });
    // When each state / activity line began, as the daemon reports it (src/protocol/agent-since.ts).
    const since = this.since.read(list.map((a) => ({ id: a.id, effective_state: a.effective_state, activity: a.status.activity, observed: a.updated_at })), now);
    return list.map((a) => ({ ...a, ...since.get(a.id) }));
  }

  /** GET /v1/agents: the live roster plus archive counts, or the archive (views.ts agentsPayload). */
  agentsPayload(q: { scope?: string; node?: string; q?: string; states?: string; limit?: string; offset?: string } = {}): AgentsPayload {
    const all = this.agentViews();
    const archived = all.filter((a) => a.archived);
    const archive = countByNode(archived);
    if (!q.scope || q.scope === "live") return { agents: all.filter((a) => !a.archived), archive, archive_rev: 1 };
    const pool = q.scope === "archive" ? archived : all;
    const states = q.states ? q.states.split(",") : null;
    const picked = pool
      .filter((a) => !q.node || a.node === q.node || a.hostname === q.node)
      .filter((a) => !states || states.includes(a.effective_state))
      .filter((a) => !q.q || matchesSearch(a, q.q))
      .sort((a, b) => b.updated_at - a.updated_at);
    const offset = Number(q.offset ?? 0) || 0;
    const agents = picked.slice(offset, offset + (Number(q.limit ?? 1000) || 1000));
    return { agents, archive, archive_rev: 1, total: picked.length, offset, truncated: offset + agents.length < picked.length };
  }

  askView(ask: Event): AskView {
    const answers = this.events.filter((e) => e.kind === "answer" && (e.body as { ask?: string }).ask === ask.id);
    const first = answers[0];
    const expires = (ask.body as { expires_at: number }).expires_at;
    const state: AskView["state"] = first
      ? ((first.body as { declined?: boolean }).declined ? "declined" : "answered")
      : Date.now() > expires ? "expired" : "open";
    return { ask, answers, state, expires_at: expires };
  }

  askViews(): AskView[] {
    return this.events.filter((e) => e.kind === "ask").map((e) => this.askView(e)).sort((a, b) => b.ask.ts - a.ask.ts);
  }

  /** Is this address aimed at the local handle, one of its machines, or one of its agents? */
  addressedToMe(to: string): boolean {
    const [handle] = to.slice(1).split("/");
    return handle === this.meHandle;
  }

  canSee(channel: string | undefined): boolean {
    if (!channel) return true;
    const c = this.channels.find((x) => x.name === channel);
    return !c?.members || c.members.includes(this.meHandle);
  }
}
