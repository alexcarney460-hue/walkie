// The roster's agent views, built incrementally (DAEMON-STALL-2). Every consumer of the roster (the stream's agents frames
// every quarter second while anything changes, the archive upkeep, the seats view, the capacity and report checks) asks
// for the views of ALL agents this node knows, live and archived. Building each from scratch parsed every row's JSON and
// allocated a view, a status copy and a time-in-state record per agent, a few thousand of them, only to find that almost
// none changed: on a machine short of memory that garbage is what stalled the daemon.
//
// Here a row costs allocation only when something about it changed: its status (a new event), its machine's presence,
// its state or archive membership as time passes, its time-in-state, its sub-agent counts. Every other row hands back the
// view object it handed back last time, so a caller can also tell an unchanged agent by identity (the stream keeps one
// JSON text per view object). What is left per read is one pass of cheap comparisons over the rows.
//
// The result is exactly what building every view from scratch gives (test/unit/agent-scale.test.ts compares them).
import { AgentSince, type SinceView } from "../protocol/agent-since.ts";
import { isArchivedAt } from "../protocol/agent-roster.ts";
import { cloudAddress, isCloudAgent } from "../protocol/guest-cloud.ts";
import type { AgentState, AgentView, BodyOf } from "../protocol/schemas.ts";
import { CUSTOM_SUBAGENT_TYPE, type SubagentCount } from "../protocol/subagents.ts";
import { effectiveState, observedAt } from "./agent-state.ts";
import type { Core } from "./core.ts";
import type { AgentRow } from "./store.ts";
import type { SyncManager } from "./sync.ts";

type Status = BodyOf<"agent.status">;

/** What building a row's view needs from the daemon: the roster, the store and which machines are online. */
type Source = Pick<Core, "roster" | "nodeId" | "store" | "localSubagents">;

/** What is kept per agent between reads. */
interface Memo {
  // The row it was built from.
  readonly eventId: string;
  readonly ts: number;
  readonly body: string;
  /** The status as the view shows it (a runtime always named): parsed once, and what every field below reads. */
  readonly shown: Status & { runtime: NonNullable<Status["runtime"]> };
  /** Whether it is a cloud guest's card (judged on the status as sent: a missing runtime is not "other" here). */
  readonly cloud: boolean;
  readonly observed: number;
  /** What the time-in-state record is told: the observation, but never before this node received the status. */
  readonly start: number;
  // What the base view was built from besides the row.
  handle: string;
  hostname: string;
  online: boolean;
  effective: AgentState;
  archived: boolean;
  /** The view before time-in-state and sub-agent counts. */
  base: AgentView;
  // The final view and what it was built from.
  out: AgentView | null;
  outBase: AgentView | null;
  outSince: SinceView | undefined;
  outCount: SubagentCount | undefined;
  outTitle: string | undefined;
  outType: string | undefined;
  /** The read that last used this memo (how a read forgets the agents that are gone). */
  gen: number;
}

/** How much work the cache has done (tests, and anyone asking why a read was slow). */
export interface ViewCacheCounters {
  /** Rows whose status JSON was parsed (a new event for the agent, or the first read). */
  parsed: number;
  /** Base views built: the row's status changed, or its machine's presence, state or archive membership did. */
  based: number;
  /** Final views built: the base view, its time-in-state or its sub-agent counts changed. */
  finals: number;
}

function viewId(handle: string, hostname: string, agent: string, cloud: boolean): string {
  return cloud ? cloudAddress({ handle, agent }) : `${handle}/${hostname}/${agent}`;
}

/**
 * One agent's view as it stands, built from nothing (no time-in-state, no sub-agent counts): null when nothing shows the
 * row (its machine is unknown or revoked, or its person removed). The same view the roster read gives before those two.
 */
export function agentRowView(core: Source, sync: Pick<SyncManager, "isOnline">, row: AgentRow, now = Date.now()): AgentView | null {
  const node = core.roster.nodes.get(row.node);
  if (!node || node.revoked) return null;
  const member = core.roster.members.get(node.login);
  if (!member || member.role === "removed") return null;
  const status = JSON.parse(row.body) as Status;
  const online = sync.isOnline(row.node, now);
  const observed = observedAt(status, row.ts);
  const effective = effectiveState(status.state, observed, online, now);
  return {
    id: viewId(member.handle, node.hostname, row.agent, isCloudAgent({ agent: row.agent, status })),
    handle: member.handle, node: row.node, hostname: node.hostname, agent: row.agent,
    status: { ...status, runtime: status.runtime ?? "other" },
    updated_at: observed, machine_online: online, effective_state: effective,
    archived: isArchivedAt(effective, observed, now),
  };
}

export class AgentViewCache {
  readonly counters: ViewCacheCounters = { parsed: 0, based: 0, finals: 0 };
  private readonly since = new AgentSince();
  private readonly memos = new Map<string, Map<string, Memo>>();
  private size = 0;
  private gen = 0;

  /**
   * Every agent this node knows (live and archived), each marked `archived` (agent-roster.ts); a session's row counts its
   * sub-agents and stays live while one works (WALKIE-MISSION-SUB-1). A new array each read; the views in it are shared
   * with the reads before and after, and are never changed.
   */
  build(core: Source, sync: Pick<SyncManager, "isOnline">, now = Date.now()): AgentView[] {
    const gen = ++this.gen;
    const roster = core.roster;
    const online = new Map<string, boolean>();
    const visible: Memo[] = [];
    /** Per machine, per parent: how many of its live sub-agents are working / live. Only parents with sub-agents are here. */
    const counts = new Map<string, Map<string, { working: number; live: number }>>();
    this.since.begin(now);
    for (const row of core.store.agents()) {
      const node = roster.nodes.get(row.node);
      if (!node || node.revoked) continue;
      const member = roster.members.get(node.login);
      if (!member || member.role === "removed") continue;
      let up = online.get(row.node);
      if (up === undefined) { up = sync.isOnline(row.node, now); online.set(row.node, up); }
      const m = this.memoOf(core, row, member.handle, node.hostname, up, now);
      m.gen = gen;
      this.since.note(m.base.id, m.effective, m.shown.activity, m.start);
      const parent = m.shown.parent;
      if (parent && !m.archived) {
        let byParent = counts.get(row.node);
        if (!byParent) { byParent = new Map(); counts.set(row.node, byParent); }
        const c = byParent.get(parent);
        if (c) { c.live += 1; if (m.effective === "working") c.working += 1; }
        else byParent.set(parent, { working: m.effective === "working" ? 1 : 0, live: 1 });
      }
      visible.push(m);
    }
    this.since.end();
    if (this.size > visible.length) this.forget(gen);
    return visible.map((m) => this.finalOf(core, m, counts));
  }

  /** The memo for `row` with its base view current for the inputs given: kept when none changed, else rebuilt. */
  private memoOf(core: Source, row: AgentRow, handle: string, hostname: string, online: boolean, now: number): Memo {
    let byAgent = this.memos.get(row.node);
    if (!byAgent) { byAgent = new Map(); this.memos.set(row.node, byAgent); }
    let m = byAgent.get(row.agent);
    if (!m || m.eventId !== row.event_id || m.ts !== row.ts || m.body !== row.body) {
      const status = JSON.parse(row.body) as Status;
      this.counters.parsed++;
      const observed = observedAt(status, row.ts);
      // Time-in-state never starts before this node received the status (Opus r1 LOW): a peer's `observed_at` (or ts) can't
      // make a card claim hours in a state. This node's own statuses keep their observed time (re-signed copies).
      const received = row.node === core.nodeId ? null : core.store.agentReceivedAt(row);
      const shown = { ...status, runtime: status.runtime ?? "other" } as Memo["shown"];
      const cloud = isCloudAgent({ agent: row.agent, status });
      const effective = effectiveState(status.state, observed, online, now);
      const archived = isArchivedAt(effective, observed, now);
      const fresh: Memo = {
        eventId: row.event_id, ts: row.ts, body: row.body, shown, cloud, observed,
        start: received === null ? observed : Math.max(observed, received),
        handle, hostname, online, effective, archived,
        base: this.baseView(row, shown, cloud, handle, hostname, online, effective, archived, observed),
        out: null, outBase: null, outSince: undefined, outCount: undefined, outTitle: undefined, outType: undefined, gen: 0,
      };
      if (!m) this.size++;
      byAgent.set(row.agent, fresh);
      return fresh;
    }
    const effective = effectiveState(m.shown.state, m.observed, online, now);
    const archived = isArchivedAt(effective, m.observed, now);
    if (m.handle !== handle || m.hostname !== hostname || m.online !== online || m.effective !== effective || m.archived !== archived) {
      m.base = this.baseView(row, m.shown, m.cloud, handle, hostname, online, effective, archived, m.observed);
      m.handle = handle; m.hostname = hostname; m.online = online; m.effective = effective; m.archived = archived;
    }
    return m;
  }

  private baseView(row: AgentRow, shown: Memo["shown"], cloud: boolean, handle: string, hostname: string, online: boolean, effective: AgentState, archived: boolean, observed: number): AgentView {
    this.counters.based++;
    return {
      id: viewId(handle, hostname, row.agent, cloud),
      handle, node: row.node, hostname, agent: row.agent,
      status: shown, updated_at: observed, machine_online: online, effective_state: effective, archived,
    };
  }

  /**
   * The agent's view with its time-in-state, this node's own sub-agent description (shown to this machine's dashboard
   * even when the team doesn't get it), and its sub-agent counts: the one handed out last time when none changed.
   */
  private finalOf(core: Source, m: Memo, counts: ReadonlyMap<string, ReadonlyMap<string, SubagentCount>>): AgentView {
    const since = this.since.get(m.base.id);
    const count = m.shown.parent ? undefined : counts.get(m.base.node)?.get(m.base.agent);
    const own = m.shown.parent && m.base.node === core.nodeId ? core.localSubagents.get(m.base.agent) : undefined;
    const title = own && !m.shown.title && own.title ? own.title : undefined;
    const type = own && m.shown.subagent_type === CUSTOM_SUBAGENT_TYPE && own.type ? own.type : undefined;
    if (m.out !== null && m.outBase === m.base && m.outSince === since && m.outTitle === title && m.outType === type
      && m.outCount?.working === count?.working && m.outCount?.live === count?.live && (m.outCount === undefined) === (count === undefined)) {
      return m.out;
    }
    this.counters.finals++;
    const timed = { ...m.base, ...since } as AgentView;
    const status = title !== undefined || type !== undefined
      ? { ...timed.status, ...(title !== undefined ? { title } : {}), ...(type !== undefined ? { subagent_type: type } : {}) }
      : timed.status;
    const out = !count && status === timed.status
      ? timed
      : { ...timed, status, ...(count ? { subagents: count, archived: timed.archived && count.working === 0 } : {}) };
    m.out = out; m.outBase = m.base; m.outSince = since; m.outCount = count; m.outTitle = title; m.outType = type;
    return out;
  }

  /** Drops the memos no read since `gen` used: agents deleted from the table, or no longer shown. */
  private forget(gen: number): void {
    for (const [node, byAgent] of this.memos) {
      for (const [agent, m] of byAgent) {
        if (m.gen === gen) continue;
        byAgent.delete(agent);
        this.size--;
      }
      if (!byAgent.size) this.memos.delete(node);
    }
  }
}

const CACHES = new WeakMap<object, AgentViewCache>();

/** The roster view cache of this Core (one per Core, made on first use). */
export function agentViewCache(core: object): AgentViewCache {
  let c = CACHES.get(core);
  if (!c) { c = new AgentViewCache(); CACHES.set(core, c); }
  return c;
}
