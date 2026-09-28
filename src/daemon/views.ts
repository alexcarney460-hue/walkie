// Local API response views (schemas.ts MeView / TeamView / NodeView / AgentView / AskView).
import { AgentSince } from "../protocol/agent-since.ts";
import { PROTOCOL_VERSION, type AgentState, type AgentsPayload, type AgentView, type AskView, type BodyOf, type ChannelView, type Event, type MeView, type NodeView, type PlanView, type TeamView } from "../protocol/schemas.ts";
import { FUTURE_SKEW_MS } from "../license/plans.ts";
import { UNKNOWN_MS, usageUntil } from "../protocol/accounts-format.ts";
import type { MachineStats } from "../protocol/machine-stats.ts";
import { clockFromReading, mergeClock, shiftClock, validClock } from "../accounts/clock.ts";
import { MAX_LEASES_PER_NODE, PROVIDERS, type AccountLeaseView, type AccountUsage, type AccountView, type ResetClock as ResetClockT } from "../protocol/accounts.ts";
import { countByNode, IDLE_ARCHIVE_MS, isArchived, matchesSearch } from "../protocol/agent-roster.ts";
import { countSubagents, CUSTOM_SUBAGENT_TYPE } from "../protocol/subagents.ts";
import type { Core } from "./core.ts";
import type { TransportControl } from "./direct/link.ts";
import { activeNodes, transportsOf } from "./roster.ts";
import type { AgentRow, EventRow } from "./store.ts";
import type { SyncManager } from "./sync.ts";
import { VERSION } from "./version.ts";

export const STALE_STATUS_MS = 30 * 60_000;

export function meView(core: Core, tailscaleError?: string, transport?: TransportControl): MeView {
  const r = core.roster;
  const me = core.me();
  return {
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    team: r.team ? { id: r.team.id, name: r.team.name } : null,
    node: { id: core.nodeId, hostname: core.hostname, ip: core.ip, port: core.peerPort },
    handle: me?.handle ?? null,
    role: me && me.role !== "removed" ? me.role : null,
    tailscale: { ok: !!core.login && !tailscaleError, login: core.login, ...(tailscaleError ? { error: tailscaleError } : {}) },
    ...(transport ? {
      transport: {
        mode: transport.mode(), transports: transport.serving(),
        ...(transport.direct() ? { direct: transport.direct() as { endpoint: string; relay: string | null } } : {}),
      },
    } : {}),
    plan: core.plan(),
  };
}

/** A peer sample time this far past our clock (after the skew correction) is not a real time: its stats are dropped. */
export const STATS_FUTURE_TOLERANCE_MS = 5 * 60_000;

/**
 * A peer's stats with `at` moved onto this node's clock (skew = peer - ours). A little in the future (clock jitter)
 * becomes now; far in the future means the value is wrong, and the stats are dropped rather than shown as "just now".
 */
export function peerStats(stats: MachineStats | undefined, skewMs: number | undefined, now = Date.now()): MachineStats | undefined {
  if (!stats) return undefined;
  const at = stats.at - (skewMs ?? 0);
  if (!Number.isFinite(at) || at > now + STATS_FUTURE_TOLERANCE_MS) return undefined;
  return { ...stats, at: Math.max(0, Math.min(now, at)) };
}

export function nodesView(core: Core, sync: SyncManager): NodeView[] {
  const r = core.roster;
  const now = Date.now();
  return activeNodes(r).map((n) => {
    const self = n.node_id === core.nodeId;
    const s = sync.peerState(n.node_id);
    const stats = self ? core.publishedStats() ?? undefined : peerStats(s?.stats, s?.skewMs, now);
    const pool = self ? core.poolShare?.() ?? undefined : s?.pool;
    return {
      node_id: n.node_id,
      handle: r.members.get(n.login)?.handle ?? "?",
      hostname: n.hostname,
      ip: n.ip,
      transports: transportsOf(n),
      ...(self ? {} : { via: sync.via(n) }),
      online: self || sync.isOnline(n.node_id),
      last_seen: self ? Date.now() : s?.lastSeen ?? null,
      rtt_ms: self ? 0 : s?.rtt ?? null,
      self,
      ...(n.node_id === core.authority ? { authority: true } : {}),
      sync: {
        behind: self ? 0 : s?.behind ?? 0, last_sync: self ? null : s?.lastSync ?? null,
        ...(s?.error && !self ? { error: s.error } : {}), ...(s?.skewMs !== undefined && !self ? { skew_ms: s.skewMs } : {}),
      },
      ...(stats ? { stats } : {}),
      ...(pool ? { pool } : {}),
    };
  });
}

export function channelsView(core: Core): ChannelView[] {
  const stats = core.store.channelStats();
  const handle = core.myHandle();
  return [...core.roster.channels.values()]
    .filter((c) => !c.members || (handle !== null && c.members.includes(handle)))
    .map((c) => ({
      name: c.name,
      ...(c.topic !== undefined ? { topic: c.topic } : {}),
      ...(c.members ? { members: [...c.members] } : {}),
      ...(c.archived ? { archived: true } : {}),
      ...(core.isProjectChannel(c.name) ? { project: true as const } : {}),
      last_ts: stats.get(c.name)?.last_ts ?? null,
      count: stats.get(c.name)?.count ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function teamView(core: Core, sync: SyncManager): TeamView | null {
  const r = core.roster;
  if (!r.team) return null;
  const members = [...r.members.values()]
    .filter((m) => m.role !== "removed")
    .map((m) => ({ login: m.login, handle: m.handle, role: m.role as Exclude<typeof m.role, "removed">, ...(m.display_name ? { display_name: m.display_name } : {}) }));
  return {
    id: r.team.id, name: r.team.name, members, nodes: nodesView(core, sync), channels: channelsView(core), authority: core.authority,
    plan: core.plan() as PlanView,
  };
}

export function effectiveState(state: AgentState, updatedAt: number, machineOnline: boolean, now = Date.now()): AgentState {
  if (!machineOnline) return "offline";
  if (state !== "idle" && now - updatedAt > STALE_STATUS_MS) return "offline";
  return state;
}

/** When a status was observed: its signing time, or an earlier `observed_at` of a re-signed copy (never later). */
export function observedAt(status: { observed_at?: number }, ts: number): number {
  return typeof status.observed_at === "number" ? Math.min(status.observed_at, ts) : ts;
}

/**
 * A status row that is a sub-agent in the live roster: any state but offline (idle included: Codex mission-sub r2 #2,
 * idle children stay live for IDLE_ARCHIVE_MS), reported within the last 30 minutes.
 */
export function isLiveSubagentRow(row: AgentRow | null, now = Date.now()): boolean {
  if (!row) return false;
  const st = JSON.parse(row.body) as BodyOf<"agent.status">;
  return !!st.parent && st.state !== "offline" && now - observedAt(st, row.ts) < Math.min(STALE_STATUS_MS, IDLE_ARCHIVE_MS);
}

/**
 * This node's live sub-agents of `parent` (other than `except`): the per-session cap (WALKIE-MISSION-SUB-1). Statuses
 * still waiting in the coalescer count too (Codex mission-sub r1 #2): a burst can't admit more than the cap by being
 * queued. A held offline status frees its row's place.
 */
export function liveSubagents(core: Core, parent: string, except: string, now = Date.now()): number {
  const live = new Set<string>();
  for (const row of core.store.agents()) {
    if (row.node !== core.nodeId || row.agent === except || !row.body.includes('"parent"')) continue;
    if (isLiveSubagentRow(row, now) && (JSON.parse(row.body) as { parent?: string }).parent === parent) live.add(row.agent);
  }
  for (const held of core.statuses.heldStatuses()) {
    if (held.parent !== parent || held.agent === except) continue;
    if (held.state === "offline") live.delete(held.agent); else live.add(held.agent);
  }
  return live.size;
}

/**
 * Every agent this node knows (live and archived), each marked `archived` (agent-roster.ts). Sub-agents
 * (WALKIE-MISSION-SUB-1): a session's row counts its sub-agents (`subagents`) and stays live while one works; this
 * node's own sub-agents show their description and type to this machine's dashboard even when the team doesn't get them.
 */
export function agentsView(core: Core, sync: SyncManager, now = Date.now()): AgentView[] {
  const rows = rawAgentsView(core, sync, now);
  const counts = countSubagents(rows);
  return rows.map((a) => {
    const c = a.status.parent ? undefined : counts.get(`${a.node}/${a.agent}`);
    const own = a.status.parent && a.node === core.nodeId ? core.localSubagents.get(a.agent) : undefined;
    const status = own && ((!a.status.title && own.title) || (a.status.subagent_type === CUSTOM_SUBAGENT_TYPE && own.type))
      ? { ...a.status, ...(!a.status.title && own.title ? { title: own.title } : {}), ...(a.status.subagent_type === CUSTOM_SUBAGENT_TYPE && own.type ? { subagent_type: own.type } : {}) }
      : a.status;
    if (!c && status === a.status) return a;
    return { ...a, status, ...(c ? { subagents: c, archived: a.archived && c.working === 0 } : {}) };
  });
}

function rawAgentsView(core: Core, sync: SyncManager, now: number): AgentView[] {
  const r = core.roster;
  const out: AgentView[] = [];
  /** Per row: the start its time-in-state may claim (see withSince). */
  const starts = new Map<string, number>();
  for (const row of core.store.agents()) {
    const node = r.nodes.get(row.node);
    if (!node || node.revoked) continue;
    const member = r.members.get(node.login);
    if (!member || member.role === "removed") continue;
    const status = JSON.parse(row.body) as BodyOf<"agent.status">;
    const online = sync.isOnline(row.node, now);
    const observed = observedAt(status, row.ts);
    const effective = effectiveState(status.state, observed, online, now);
    out.push({
      id: `${member.handle}/${node.hostname}/${row.agent}`,
      handle: member.handle, node: row.node, hostname: node.hostname, agent: row.agent,
      status: { ...status, runtime: status.runtime ?? "other" },
      updated_at: observed, machine_online: online,
      effective_state: effective,
      archived: isArchived({ effective_state: effective, updated_at: observed }, now),
    });
    // Time-in-state never starts before this node received the status (Opus r1 LOW): a peer's `observed_at` (or ts)
    // can't make a card claim hours in a state. This node's own statuses keep their observed time (re-signed copies).
    const received = row.node === core.nodeId ? null : core.store.agentReceivedAt(row);
    starts.set(`${member.handle}/${node.hostname}/${row.agent}`, received === null ? observed : Math.max(observed, received));
  }
  return withSince(core, out, starts, now);
}

/** Per Core: when each agent's state and activity line began (agent-since.ts). */
const SINCE = new WeakMap<object, AgentSince>();

function withSince(core: Core, list: AgentView[], starts: ReadonlyMap<string, number>, now: number): AgentView[] {
  let t = SINCE.get(core);
  if (!t) { t = new AgentSince(); SINCE.set(core, t); }
  const since = t.read(list.map((a) => ({ id: a.id, effective_state: a.effective_state, activity: a.status.activity, observed: starts.get(a.id) ?? a.updated_at })), now);
  return list.map((a) => ({ ...a, ...since.get(a.id) }));
}

export type AgentScope = "live" | "archive" | "all";
export interface AgentQuery {
  scope?: AgentScope; node?: string; q?: string; limit?: number; offset?: number;
  /** Only agents in these effective states (e.g. idle + offline: everything a default view leaves out). */
  states?: readonly AgentState[];
}
export const ARCHIVE_PAGE_MAX = 1_000;

/**
 * GET /v1/agents and the stream (WALKIE-MISSION-1): the live roster by default (the archive only as counts per
 * machine), the archive (newest first) or both. Machine, search and state filters apply BEFORE the page is cut
 * (fix round 1, Codex 6), and the page says how many matched in all (total) and whether more remain (truncated).
 */
export function agentsPayload(core: Core, sync: SyncManager, query: AgentQuery = {}, now = Date.now()): AgentsPayload {
  const all = agentsView(core, sync, now);
  const archived = all.filter((a) => a.archived);
  const archive = countByNode(archived);
  const rev = { archive_rev: core.archiveRev };
  const scope = query.scope ?? "live";
  if (scope === "live") return { agents: all.filter((a) => !a.archived), archive, ...rev };
  const pool = scope === "archive" ? archived : all;
  const picked = pool
    .filter((a) => !query.node || a.node === query.node || a.hostname === query.node)
    .filter((a) => !query.states?.length || query.states.includes(a.effective_state))
    .filter((a) => !query.q || matchesSearch(a, query.q))
    .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(query.limit ?? ARCHIVE_PAGE_MAX, ARCHIVE_PAGE_MAX);
  const page = picked.slice(offset, offset + limit);
  return { agents: page, archive, ...rev, total: picked.length, offset, truncated: offset + page.length < picked.length };
}

/** No real usage window resets further ahead than this from its reading (weekly windows are 7 days). */
export const MAX_RESET_AHEAD_MS = 8 * 86_400_000;

/**
 * A usage reading with its times moved onto this node's clock (skew = reporter − ours). A reading dated beyond the
 * allowed clock skew is REJECTED, not clamped (Opus MED 1: clamping kept a far-future reading winning); reset and
 * `until` times are capped at the reading + 8 days.
 */
export function shiftUsage(u: AccountUsage, skewMs: number, now = Date.now()): AccountUsage | null {
  const at = u.at - skewMs;
  if (at > now + FUTURE_SKEW_MS) return null;
  const limit = Math.max(0, at) + MAX_RESET_AHEAD_MS;
  const shift = (t: number | null) => (t === null ? null : Math.min(limit, Math.max(0, t - skewMs)));
  // An older peer's placeholder reset is recognised BEFORE shifting (the shift and the clamp of `at` would otherwise
  // hide its exact +60 min signature) and dropped: unknown stays unknown (pre.7 RC delta).
  return {
    ...u, at: Math.max(0, Math.min(now, at)), until: shift(usageUntil(u)),
    windows: u.windows.map((w) => ({ ...w, resets_at: shift(w.resets_at) })),
  };
}

/**
 * Whether reading a should replace b as an account's shown reading: the newer one, except that an "unknown" reading
 * (a machine that cannot meter the account, e.g. a vault setup-token) never hides a known one under an hour old.
 */
/** Unverified lease claims shown per machine and account (they never count for scheduling). */
export const MAX_UNVERIFIED_PER_NODE = 4;

const fresher = (a: AccountUsage | null, b: AccountUsage | null): boolean => {
  if (!a) return false;
  if (!b) return true;
  if (a.state === "unknown" && b.state !== "unknown" && a.at - b.at < UNKNOWN_MS) return false;
  if (b.state === "unknown" && a.state !== "unknown" && b.at - a.at < UNKNOWN_MS) return true;
  return a.at > b.at;
};

/**
 * The team's accounts (ACCOUNTS-1): every machine's `accounts` snapshot (this node's own, peers' from their `vv`
 * answers), one entry per (owner, account id). Each machine keeps its own reading; the entry shows the freshest of its
 * owner's machines. The same id reported by another member is that member's own entry, named in `claimed_by` on both:
 * a claim, never authority over the owner's reading. An offline machine's agents are not counted as using it.
 */
export function accountsView(core: Core, sync: SyncManager, now = Date.now()): AccountView[] {
  const r = core.roster;
  const byKey = new Map<string, AccountView>();
  const leases: { key: string; view: AccountLeaseView }[] = [];
  const usedGrants = new Set<string>();
  for (const n of activeNodes(r)) {
    const member = r.members.get(n.login);
    if (!member || member.role === "removed") continue;
    const self = n.node_id === core.nodeId;
    const s = self ? undefined : sync.peerState(n.node_id);
    const snap = self ? core.accounts : s?.accounts;
    if (!snap) continue;
    const skew = self ? 0 : s?.skewMs ?? 0;
    const online = sync.isOnline(n.node_id, now);
    for (const a of snap.accounts) {
      const usage = a.usage ? shiftUsage(a.usage, skew, now) : null;
      // RESET-CLOCK-1: the machine's remembered reset times; a pre-RESET-CLOCK peer sends none, so its reading's own.
      const clock = shiftClock(a.clock !== undefined ? validClock(a.clock) : clockFromReading(a.usage), skew, now, FUTURE_SKEW_MS);
      const machine = {
        node_id: n.node_id, hostname: n.hostname, handle: member.handle, online, self, agents: online ? [...a.agents] : [], usage,
        ...(a.vault ? { vault: a.vault } : {}), ...(clock.length ? { clock } : {}),
      };
      const lastSeen = Math.max(0, Math.min(now, a.last_seen - skew));
      const key = `${member.handle}:${a.id}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, {
          key, id: a.id, provider: a.provider, label: a.label, plan: a.plan, owners: [member.handle], claimed_by: [], machines: [machine],
          usage, usage_host: usage ? n.hostname : null, last_seen: lastSeen, vault: a.vault ?? null, leases: [],
          ...(clock.length ? { clock } : {}),
        });
        continue;
      }
      const newer = fresher(usage, prev.usage);
      byKey.set(key, {
        ...prev,
        plan: prev.plan ?? a.plan,
        machines: [...prev.machines, machine],
        usage: newer ? usage : prev.usage,
        usage_host: newer ? n.hostname : prev.usage_host,
        last_seen: Math.max(prev.last_seen, lastSeen),
        vault: prev.vault ?? a.vault ?? null,
        ...mergedClock(prev.clock ?? [], clock, now),
      });
    }
    // ACCOUNTS-2: wrapped sessions on this machine (while it is online), under the account owner's entry. Verified
    // (round 2, Codex 7): a lease from the owner's own machine, or one naming a live grant this (owner) daemon issued for
    // that account to that machine — each grant backs one lease.
    if (!online) continue;
    for (const l of snap.leases ?? []) {
      const owner = l.owner ?? member.handle;
      const granted = owner === core.myHandle?.() && !!l.grant && !usedGrants.has(l.grant) && core.vaultGrants?.valid(l.grant, l.account, n.node_id, now) === true;
      if (granted) usedGrants.add(l.grant as string);
      const verified = owner === member.handle || granted;
      leases.push({ key: `${owner}:${l.account}`, view: { handle: member.handle, hostname: n.hostname, node_id: n.node_id, agent: l.agent ?? null, since: Math.max(0, l.since - skew), verified } });
    }
  }
  // Only under the named owner's own entry: a lease never lands on another member's account. Verified leases first; at
  // most MAX_UNVERIFIED_PER_NODE unverified claims per machine and account, so claims can never push verified ones out.
  const perNode = new Map<string, number>();
  for (const l of [...leases].sort((a, b) => Number(b.view.verified) - Number(a.view.verified))) {
    const v = byKey.get(l.key);
    if (!v) continue;
    if (!l.view.verified) {
      const k = `${l.key}|${l.view.node_id}`;
      const n = perNode.get(k) ?? 0;
      if (n >= MAX_UNVERIFIED_PER_NODE) continue;
      perNode.set(k, n + 1);
    }
    byKey.set(v.key, { ...v, leases: [...(v.leases ?? []), l.view].slice(0, MAX_LEASES_PER_NODE) });
  }
  const holders = new Map<string, string[]>();
  for (const v of byKey.values()) holders.set(v.id, [...(holders.get(v.id) ?? []), ...v.owners]);
  const order = (p: string) => PROVIDERS.indexOf(p as (typeof PROVIDERS)[number]);
  return [...byKey.values()]
    .map((v) => ({ ...v, claimed_by: (holders.get(v.id) ?? []).filter((h) => !v.owners.includes(h)).sort() }))
    .sort((a, b) => order(a.provider) - order(b.provider) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id) || a.key.localeCompare(b.key));
}

/** The owner's machines' remembered reset times, per window the newest report (RESET-CLOCK-1). */
function mergedClock(a: readonly ResetClockT[], b: readonly ResetClockT[], now: number): { clock?: ResetClockT[] } {
  const m = mergeClock(a, b, now);
  return m.length ? { clock: [...m] } : {};
}

/** The longest an ask stays open on a node after it received it (the ask's own timeout is capped here). */
export const MAX_ASK_OPEN_MS = 24 * 60 * 60 * 1000;

/**
 * When an ask expires on this node (FINAL Fable 8): the body's `expires_at`, but never later than the
 * ask's own timeout (capped at a day) counted from this node's receipt plus the skew allowance, so a
 * peer's clock, or a body naming next year, can't keep an ask open in anyone's inbox.
 */
export function askExpiry(ask: Event, receivedAt: number | null): number {
  const claimed = (ask.body as { expires_at: number }).expires_at;
  if (receivedAt === null) return claimed;
  const timeout = Math.min(MAX_ASK_OPEN_MS, Math.max(0, claimed - ask.ts));
  return Math.min(claimed, receivedAt + FUTURE_SKEW_MS + timeout);
}

/** The first valid answer (by ts, id) decides the state, a decline included (D6). */
export function askState(ask: Event, answers: readonly Event[], now = Date.now(), expiresAt = (ask.body as { expires_at: number }).expires_at): AskView["state"] {
  const first = [...answers].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  if (first) return (first.body as { declined?: boolean }).declined === true ? "declined" : "answered";
  return now > expiresAt ? "expired" : "open";
}

/** `text` cut to at most `max` characters, never between the halves of a surrogate pair; null when it fits. */
export function cutText(text: string, max: number): string | null {
  if (text.length <= max) return null;
  const hi = text.charCodeAt(max - 1);
  return text.slice(0, hi >= 0xd800 && hi <= 0xdbff ? max - 1 : max);
}

/** An event whose body text is cut to `max` characters (a new object; the body says `truncated`). */
function cutEvent(e: Event, max: number): Event {
  const body = e.body as { text?: unknown };
  const cut = typeof body?.text === "string" ? cutText(body.text, max) : null;
  return cut === null ? e : { ...e, body: { ...(e.body as object), text: cut, truncated: true } } as Event;
}

/** An ask view for a small client: the ask's and the answers' texts cut to `max` characters. */
export function cutAskView(v: AskView, max: number): AskView {
  return { ...v, ask: cutEvent(v.ask, max), answers: v.answers.map((a) => cutEvent(a, max)) };
}

export function askView(core: Core, askRow: EventRow): AskView {
  const ask = JSON.parse(askRow.json) as Event;
  const answers = core.store.replies(ask.id)
    .map((r) => JSON.parse(r.json) as Event)
    .filter((e) => e.kind === "answer" && core.visible(e));
  const expires_at = askExpiry(ask, core.store.receivedAt(ask.id));
  return { ask, answers, state: askState(ask, answers, Date.now(), expires_at), expires_at };
}
