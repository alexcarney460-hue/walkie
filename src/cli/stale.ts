// `walkie stale` (ORCH-2): what has gone stale while work is happening, for the orchestrator's survey-and-refresh loop.
// Pure: built from what the daemon already serves (tasks, agents, team machines). Staleness is a failure; each item
// is something the orchestrator asks about. Teammate text (card and status titles) is defanged and marked team-member.
import type { CardView, ColumnRole } from "../protocol/projects/schema.ts";
import type { AgentView, NodeView } from "../protocol/schemas.ts";
import { defang } from "../protocol/safety.ts";
import { machineBusy } from "../protocol/machine-stats.ts";

export const DEFAULT_CARD_HOURS = 4;
export const DEFAULT_AGENT_MINUTES = 30;
/** An agent silent for longer than this is gone, not quiet (the archive lists it); it is not reported. */
export const SILENT_MAX_HOURS = 24;

interface ProjectRef { channel: string; name: string; prefix: string; boards: { id: string; columns: { id: string; role: ColumnRole }[] }[] }

export interface StaleInput {
  now: number;
  cardHours: number;
  agentMinutes: number;
  /** Open cards in in-progress and review columns (others are ignored). */
  tasks: readonly CardView[];
  /** Open cards in a to-do column (the daemon counts them). */
  todoWaiting: number;
  projects: readonly ProjectRef[];
  agents: readonly AgentView[];
  nodes: readonly NodeView[];
}

export interface StaleCard { key: string; ref: string; project: string; column: string; role: "active" | "review"; title: string; assignee: string | null; updated_at: number; idle_hours: number }
export interface SilentAgent { id: string; hostname: string; agent: string; state: string; title: string; task: string | null; updated_at: number; silent_minutes: number }
export interface MachineFlag { hostname: string; handle: string; reason: "idle_while_cards_wait" | "pressure_without_agents" | "load_without_agents"; working_agents: number; pressure: string | null }
export interface StaleReport {
  generated_at: number;
  thresholds: { card_hours: number; agent_minutes: number };
  cards: StaleCard[];
  agents: SilentAgent[];
  machines: MachineFlag[];
  /** Open cards in a to-do column (work waiting for a machine). */
  todo_waiting: number;
  trust: "team-member";
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

function roleOf(card: CardView, projects: readonly ProjectRef[]): ColumnRole | undefined {
  const p = projects.find((x) => x.channel === card.channel);
  return p?.boards.find((b) => b.id === card.board)?.columns.find((col) => col.id === card.column)?.role;
}

function staleCards(i: StaleInput): StaleCard[] {
  const out: StaleCard[] = [];
  for (const card of i.tasks) {
    const role = roleOf(card, i.projects);
    if (card.state !== "open" || (role !== "active" && role !== "review")) continue;
    const idle = (i.now - card.updated_at) / HOUR;
    if (idle < i.cardHours) continue;
    const project = i.projects.find((x) => x.channel === card.channel)?.name ?? "?";
    out.push({
      key: defang(card.key, 40), ref: defang(card.ref, 60), project: defang(project, 80), column: defang(card.column, 40), role,
      title: defang(card.title, 200), assignee: card.assignee ? defang(card.assignee, 120) : null, updated_at: card.updated_at, idle_hours: round1(idle),
    });
  }
  return out.sort((a, b) => a.updated_at - b.updated_at);
}

const DECLARED_BUSY = new Set(["working", "waiting", "blocked"]);

function silentAgents(i: StaleInput): SilentAgent[] {
  const out: SilentAgent[] = [];
  for (const a of i.agents) {
    if (!a.machine_online || !DECLARED_BUSY.has(a.status.state)) continue;
    const silent = (i.now - a.updated_at) / MINUTE;
    if (silent < i.agentMinutes || silent > SILENT_MAX_HOURS * 60) continue;
    out.push({
      id: defang(a.id, 200), hostname: defang(a.hostname, 63), agent: defang(a.agent, 80), state: a.status.state,
      title: defang(a.status.title ?? "", 200), task: a.status.task ? defang(a.status.task, 80) : null,
      updated_at: a.updated_at, silent_minutes: Math.round(silent),
    });
  }
  return out.sort((a, b) => a.updated_at - b.updated_at);
}

function machineFlags(i: StaleInput, todoWaiting: number): MachineFlag[] {
  const out: MachineFlag[] = [];
  for (const n of i.nodes) {
    if (!n.online) continue;
    const working = i.agents.filter((a) => a.node === n.node_id && a.effective_state === "working").length;
    if (working > 0 || n.stats?.agent_processes?.some((a) => a.count > 0)) continue;
    const pressure = n.stats?.mem?.pressure ?? null;
    const base = { hostname: defang(n.hostname, 63), handle: n.handle, working_agents: 0, pressure };
    if (pressure === "warn" || pressure === "critical") out.push({ ...base, reason: "pressure_without_agents" });
    else if (machineBusy(n.stats)) out.push({ ...base, reason: "load_without_agents" });
    else if (todoWaiting > 0) out.push({ ...base, reason: "idle_while_cards_wait" });
  }
  return out;
}

export function staleReport(i: StaleInput): StaleReport {
  const todoWaiting = i.todoWaiting;
  return {
    generated_at: i.now,
    thresholds: { card_hours: i.cardHours, agent_minutes: i.agentMinutes },
    cards: staleCards(i), agents: silentAgents(i), machines: machineFlags(i, todoWaiting), todo_waiting: todoWaiting,
    trust: "team-member",
  };
}
