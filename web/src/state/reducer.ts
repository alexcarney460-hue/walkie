import type { AccountView, AgentView, ArchiveCount, AskView, Event, MeView, NodeView, OrchMessage, OrchestratorLive, TeamView } from "../api/types.ts";

export type ConnStatus = "connecting" | "live" | "reconnecting";
/** Why the stream is being replaced: it ended, failed, went silent (no heartbeat), or skipped a roster delta. */
export type ConnReason = "closed" | "error" | "stalled" | "gap";
export interface Conn { status: ConnStatus; attempt: number; retryAt: number | null; reason?: ConnReason }

/** A reply streaming on this machine (its own orchestrator host; never stored). */
export interface LiveTurn { thread: string; turn: string; text: string; tools: string[]; done: boolean; at: number }

export interface State {
  phase: "loading" | "error" | "no-team" | "ready";
  error: string | null;
  /** The error is a 401: the dashboard session ended (sign in again), not an unreachable daemon. */
  signedOut: boolean;
  me: MeView | null;
  team: TeamView | null;
  /** The live roster (working, needing a person, recently idle or ended). */
  agents: AgentView[];
  /** Per machine: how many agents are in the Agent archive, idle / offline (the daemon's counts). */
  archive: ArchiveCount[];
  /** Archived agents the Archive view has loaded (the agent drawer can open them too). */
  archivedAgents: AgentView[];
  /** The daemon's archive revision: changes whenever the archive's contents change (null: an older daemon). */
  archiveRev: number | null;
  nodes: NodeView[];
  /** The team's provider accounts and usage left (GET /v1/accounts, SSE `accounts`). */
  accounts: AccountView[];
  /** Recent events of every kind, newest first, capped. */
  events: Event[];
  asks: AskView[];
  conn: Conn;
  readMarks: Record<string, number>;
  readBaseline: number;
  /** Orchestrator replies in progress, by the id of the message being answered. */
  live: Record<string, LiveTurn>;
  /** This machine's local orchestrator conversation (ORCH-FIX-11: from its own store only, never a peer's event). */
  orch: OrchMessage[];
}

export type Action =
  | { type: "boot/start" }
  | { type: "boot/error"; error: string; signedOut?: boolean }
  | { type: "boot/no-team"; me: MeView }
  | { type: "boot/ready"; me: MeView; team: TeamView; agents: AgentView[]; archive: ArchiveCount[]; archiveRev?: number | null; nodes: NodeView[]; accounts: AccountView[]; events: Event[]; asks: AskView[]; readMarks: Record<string, number>; readBaseline: number }
  | { type: "me"; me: MeView }
  | { type: "team"; team: TeamView }
  | { type: "agents"; agents: AgentView[]; archive?: ArchiveCount[]; archiveRev?: number | null }
  /** The stream's changed rows (whole rows) and the ids that left the live roster. */
  | { type: "agents/delta"; upsert: AgentView[]; remove: string[]; archive: ArchiveCount[]; archiveRev?: number | null }
  /** `append`: a further page (Load more) of the same query. */
  | { type: "archive/loaded"; agents: AgentView[]; append?: boolean }
  | { type: "nodes"; nodes: NodeView[] }
  | { type: "accounts"; accounts: AccountView[] }
  | { type: "asks"; asks: AskView[] }
  | { type: "events"; events: Event[] }
  /** The stream's `hidden`: events a roster change made invalid (e.g. a removed member's), dropped by id. */
  | { type: "events/hidden"; ids: string[] }
  | { type: "conn"; conn: Conn }
  | { type: "read"; channel: string; ts: number }
  | { type: "orch/live"; live: OrchestratorLive }
  | { type: "orch/messages"; messages: OrchMessage[] }
  /** After a reconnect: replies in progress may have ended while the stream was down (the resync brings them). */
  | { type: "orch/live-reset" };

export const EVENT_CAP = 1500;
const COUNTED = new Set(["msg.post", "artifact.share", "ask"]);

export const initialState: State = {
  phase: "loading",
  error: null,
  signedOut: false,
  me: null,
  team: null,
  agents: [],
  archive: [],
  archivedAgents: [],
  archiveRev: null,
  nodes: [],
  accounts: [],
  events: [],
  asks: [],
  conn: { status: "connecting", attempt: 0, retryAt: null },
  readMarks: {},
  readBaseline: Date.now(),
  live: {},
  orch: [],
};

const LIVE_CAP = 20;
const LIVE_TEXT_MAX = 200_000;

function applyLive(live: Record<string, LiveTurn>, p: OrchestratorLive): Record<string, LiveTurn> {
  const prev = live[p.turn];
  const base: LiveTurn = p.phase === "start" || !prev
    ? { thread: p.thread, turn: p.turn, text: "", tools: [], done: false, at: Date.now() }
    : prev;
  const next: LiveTurn = p.phase === "delta" ? { ...base, text: (base.text + (p.text ?? "")).slice(0, LIVE_TEXT_MAX) }
    : p.phase === "tool" ? { ...base, tools: [...base.tools, p.tool ?? ""].slice(-50) }
    : p.phase === "end" ? { ...base, done: true }
    : base;
  const entries = Object.entries({ ...live, [p.turn]: next }).sort((a, b) => b[1].at - a[1].at).slice(0, LIVE_CAP);
  return Object.fromEntries(entries);
}

const ORCH_CAP = 2_000;

/** Messages by id (a later copy replaces: a state change), oldest first, capped. */
function mergeOrch(existing: OrchMessage[], incoming: OrchMessage[]): OrchMessage[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)).slice(-ORCH_CAP);
}

function mergeEvents(existing: Event[], incoming: Event[]): Event[] {
  const seen = new Set(existing.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  if (!fresh.length) return existing;
  return [...fresh, ...existing].sort((a, b) => b.ts - a.ts).slice(0, EVENT_CAP);
}

/** Applies a roster delta: changed rows replaced in place (unchanged rows keep their identity), new rows appended. */
export function applyAgentsDelta(agents: AgentView[], upsert: AgentView[], remove: string[]): AgentView[] {
  if (!upsert.length && !remove.length) return agents;
  // By row key (node id + agent, as the daemon sends them), not the display id, which can repeat (Codex r1 #1).
  const key = (a: AgentView) => `${a.node}/${a.agent}`;
  const byKey = new Map(upsert.map((a) => [key(a), a]));
  const gone = new Set(remove);
  const kept = agents.filter((a) => !gone.has(key(a))).map((a) => byKey.get(key(a)) ?? a);
  const known = new Set(agents.map(key));
  return [...kept, ...upsert.filter((a) => !known.has(key(a)))];
}

function applyToAsks(asks: AskView[], e: Event): AskView[] {
  if (e.kind === "ask") {
    if (asks.some((a) => a.ask.id === e.id)) return asks;
    return [{ ask: e, answers: [], state: "open" as const, expires_at: (e.body as { expires_at: number }).expires_at }, ...asks];
  }
  if (e.kind === "answer") {
    const askId = (e.body as { ask?: string }).ask;
    return asks.map((a) => {
      if (a.ask.id !== askId || a.answers.some((x) => x.id === e.id)) return a;
      const declined = !!(e.body as { declined?: boolean }).declined;
      const state = a.answers.length ? a.state : declined ? "declined" : "answered";
      return { ...a, answers: [...a.answers, e], state };
    });
  }
  return asks;
}

/**
 * Project channels belong to the Projects view, not the channel list (WALKIE-PROJECTS-1). The daemon marks them
 * (`project`); an older `p-…` channel that isn't a project stays in the list.
 */
export function withoutProjectChannels(team: TeamView): TeamView {
  return team.channels.some((c) => c.project) ? { ...team, channels: team.channels.filter((c) => !c.project) } : team;
}

function applyToTeam(team: TeamView | null, e: Event): TeamView | null {
  if (!team || !e.channel || !COUNTED.has(e.kind)) return team;
  return {
    ...team,
    channels: team.channels.map((c) =>
      c.name === e.channel ? { ...c, count: c.count + 1, last_ts: Math.max(c.last_ts ?? 0, e.ts) } : c,
    ),
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "boot/start":
      return { ...state, phase: state.phase === "ready" ? "ready" : "loading", error: null };
    case "boot/error":
      return { ...state, phase: "error", error: action.error, signedOut: action.signedOut === true };
    case "boot/no-team":
      return { ...state, phase: "no-team", me: action.me, error: null };
    case "boot/ready":
      return {
        ...state, phase: "ready", error: null, signedOut: false, me: action.me, team: withoutProjectChannels(action.team), agents: action.agents, archive: action.archive,
        archiveRev: action.archiveRev ?? null,
        nodes: action.nodes, accounts: action.accounts, events: mergeEvents([], action.events), asks: action.asks,
        readMarks: action.readMarks, readBaseline: action.readBaseline,
      };
    case "me":
      return { ...state, me: action.me };
    case "team":
      return { ...state, team: withoutProjectChannels(action.team), nodes: action.team.nodes.length ? action.team.nodes : state.nodes };
    case "agents":
      return { ...state, agents: action.agents, archive: action.archive ?? state.archive, archiveRev: action.archiveRev ?? state.archiveRev };
    case "agents/delta":
      return {
        ...state, agents: applyAgentsDelta(state.agents, action.upsert, action.remove), archive: action.archive,
        archiveRev: action.archiveRev ?? state.archiveRev,
      };
    case "archive/loaded": {
      if (!action.append) return { ...state, archivedAgents: action.agents };
      const seen = new Set(state.archivedAgents.map((a) => a.id));
      return { ...state, archivedAgents: [...state.archivedAgents, ...action.agents.filter((a) => !seen.has(a.id))] };
    }
    case "nodes":
      return { ...state, nodes: action.nodes, team: state.team ? { ...state.team, nodes: action.nodes } : state.team };
    case "accounts":
      return { ...state, accounts: action.accounts };
    case "asks":
      return { ...state, asks: action.asks };
    case "events": {
      const known = new Set(state.events.map((e) => e.id));
      const fresh = action.events.filter((e) => !known.has(e.id));
      if (!fresh.length) return state;
      let asks = state.asks;
      let team = state.team;
      for (const e of fresh) {
        asks = applyToAsks(asks, e);
        team = applyToTeam(team, e);
      }
      return { ...state, events: mergeEvents(state.events, fresh), asks, team };
    }
    case "events/hidden": {
      if (!action.ids.length) return state;
      const gone = new Set(action.ids);
      const events = state.events.filter((e) => !gone.has(e.id));
      const asks = state.asks.filter((a) => !gone.has(a.ask.id)).map((a) => {
        if (!a.answers.some((x) => gone.has(x.id))) return a;
        // The ask's state follows its first remaining answer; with none left it is open again (or expired): Codex r1 #5.
        const answers = a.answers.filter((x) => !gone.has(x.id));
        const first = answers[0];
        const st: AskView["state"] = first ? ((first.body as { declined?: boolean }).declined ? "declined" : "answered") : a.expires_at > Date.now() ? "open" : "expired";
        return { ...a, answers, state: st };
      });
      if (events.length === state.events.length && asks.length === state.asks.length && asks.every((a, i) => a === state.asks[i])) return state;
      return { ...state, events, asks };
    }
    case "conn":
      return { ...state, conn: action.conn };
    case "read":
      if ((state.readMarks[action.channel] ?? 0) >= action.ts) return state;
      return { ...state, readMarks: { ...state.readMarks, [action.channel]: action.ts } };
    case "orch/live":
      return { ...state, live: applyLive(state.live, action.live) };
    case "orch/messages":
      return { ...state, orch: mergeOrch(state.orch, action.messages) };
    case "orch/live-reset":
      return Object.keys(state.live).length ? { ...state, live: {} } : state;
  }
}

export function unreadCount(state: State, channel: string): number {
  const mark = state.readMarks[channel] ?? state.readBaseline;
  const me = state.me?.handle;
  return state.events.filter((e) =>
    e.channel === channel && COUNTED.has(e.kind) && e.ts > mark && !(e.author.handle === me && !e.author.agent),
  ).length;
}
