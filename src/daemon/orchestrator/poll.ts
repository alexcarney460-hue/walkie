// TALKIE-OPS-1: the orchestration poll, the duty's prepare step. Every five minutes the lead's daemon reads what Capacity check
// used to read through the CLI (the machines with their stats, the seat hosts and the seats in flight, the accounts and their
// windows, the agents) and each active project's waiting work, decides in poll-plan.ts which waiting work fits which free
// seat, and reconciles the open recommendations with it. Nothing here asks a model or acts: the run ends in the prepare step
// with a line saying what it found, and a poll that finds nothing new writes nothing.
import { ORCHESTRATOR_AGENT } from "../../protocol/orchestrator.ts";
import { associate } from "../../protocol/projects/assoc.ts";
import type { CardView, ColumnRole, ProjectView } from "../../protocol/projects/schema.ts";
import { STEWARD_AGENT } from "../../protocol/projects/steward.ts";
import { CONFIDENTIAL_LABEL, isConfidential } from "../../protocol/projects/status-report.ts";
import type { AccountView } from "../../protocol/accounts.ts";
import type { AgentView, NodeView } from "../../protocol/schemas.ts";
import type { SeatHostView, SeatRuntime, SeatView } from "../../protocol/seats.ts";
import { visibleProjects } from "../projects/service.ts";
import type { SkippedTurn } from "./prepared.ts";
import { PER_PROJECT_CAP, machineCapacity, planPoll, usableRuntimes, type PollMachine, type WaitingWork } from "./poll-plan.ts";
import { reconcile, type Desired, type RecDeps } from "./recs.ts";

export interface PollDeps extends RecDeps {
  readonly nodes: () => readonly NodeView[];
  readonly seatHosts: () => readonly SeatHostView[];
  readonly seats: () => readonly SeatView[];
  readonly accounts: () => readonly AccountView[];
  readonly agents: () => readonly AgentView[];
}

const ACTIVE_SEAT_STATES: ReadonlySet<string> = new Set(["running", "paused", "queued"]);
/** A card carrying one of these is waiting on someone else (or is not for a seat), however long it has sat. */
const NOT_FOR_A_SEAT: ReadonlySet<string> = new Set(["decision-needed", "waiting-on", CONFIDENTIAL_LABEL]);
/** Waiting cards read per project and kind, oldest first (the plan takes at most PER_PROJECT_CAP of them). */
const READ_PER_KIND = PER_PROJECT_CAP * 2;

const yieldLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const RUNTIME_OF: Readonly<Record<string, SeatRuntime>> = { "claude-code": "claude", codex: "codex", kimi: "kimi" };

/** Cards an agent is working on now (by the Mission Control mapping), and the runtime of each agent address. */
function agentFacts(d: PollDeps, projects: readonly ProjectView[]): { onCard: Set<string>; runtimes: Map<string, SeatRuntime> } {
  const onCard = new Set<string>();
  const runtimes = new Map<string, SeatRuntime>();
  for (const a of d.agents()) {
    if (a.status.parent || a.agent === ORCHESTRATOR_AGENT || a.agent === STEWARD_AGENT || a.archived) continue;
    const runtime = RUNTIME_OF[a.status.runtime ?? ""];
    if (runtime) runtimes.set(`@${a.handle}/${a.hostname}/${a.agent}`, runtime);
    if (a.effective_state !== "working" || a.machine_online === false) continue;
    const cwd = a.node === d.core.nodeId ? d.core.localCwds.get(a.agent) : undefined;
    const hit = associate(a.status, projects, (channel, n) => d.idx.db.hasCardN(channel, n), cwd ?? a.status.cwd);
    const n = hit?.key ? Number(hit.key.split("-").pop()) : NaN;
    const card = hit && Number.isInteger(n) ? d.idx.db.cardByN(hit.channel, n) : null;
    if (card) onCard.add(card.id);
  }
  return { onCard, runtimes };
}

/**
 * Why a card is not one for a seat now, by the poll's rules, or null: blocked, labelled confidential, an agent working on it, and
 * for a build an assignee or a label that says it waits on someone; for a review a named reviewer. The poll leaves such cards out
 * and approving a seat recommendation is refused for one (rec-act.ts), whatever changed since it was made.
 */
export function seatHold(card: Pick<CardView, "blocked" | "labels" | "assignee" | "reviewer">, kind: "build" | "review", working: boolean): string | null {
  if (card.blocked) return "the card is blocked";
  if (isConfidential(card.labels)) return "the card is labelled confidential";
  if (working) return "an agent is working on it";
  if (kind === "review") return card.reviewer ? "the card has a reviewer" : null;
  if (card.assignee) return "the card has an assignee";
  const label = card.labels.map((l) => l.trim().toLowerCase()).find((l) => NOT_FOR_A_SEAT.has(l));
  return label ? `the card is labelled ${label}` : null;
}

/** One project's waiting work: builds (to-do, nobody on it) and reviews (in review, no reviewer, nobody on it), oldest first. */
function waitingIn(d: PollDeps, p: ProjectView, facts: ReturnType<typeof agentFacts>): WaitingWork[] {
  const columns = new Map(p.boards.filter((b) => b.state === "active").flatMap((b) => b.columns.map((c) => [`${b.id}/${c.id}`, c.role] as const)));
  const role = (c: CardView): ColumnRole | undefined => columns.get(`${c.board}/${c.column}`);
  const open = d.idx.db.cards(p.channel, { states: ["open"], limit: 20_000 });
  const work = (c: CardView, kind: "build" | "review"): WaitingWork => ({
    card: c.id, channel: p.channel, project: p.name, prefixes: [p.prefix, ...(p.prior_prefixes ?? [])], title: c.title, role: kind, since: c.updated_at,
    audience: p.private ? "owners" : "team", ...(kind === "review" && c.assignee ? { builderRuntime: facts.runtimes.get(c.assignee) ?? null } : {}),
    viewers: d.core.roster.channels.get(p.channel)?.members ?? null,
  });
  const oldest = (cards: CardView[]) => cards.sort((a, b) => a.updated_at - b.updated_at || (a.id < b.id ? -1 : 1)).slice(0, READ_PER_KIND);
  const builds = open.filter((c) => role(c) === "todo" && !seatHold(c, "build", facts.onCard.has(c.id)));
  const reviews = open.filter((c) => role(c) === "review" && !seatHold(c, "review", facts.onCard.has(c.id)));
  return [...oldest(builds).map((c) => work(c, "build")), ...oldest(reviews).map((c) => work(c, "review"))];
}

function machineOf(d: PollDeps, n: NodeView, hosts: readonly SeatHostView[], active: readonly SeatView[], accounts: readonly AccountView[], now: number): PollMachine {
  const host = hosts.find((h) => h.node === n.node_id);
  const sys = n.stats?.sys;
  const load = sys && sys.load1 !== null && sys.load1 !== undefined ? (sys.load1 / sys.cpus) * 100 : null;
  return {
    node: n.node_id, hostname: n.hostname, handle: n.handle, online: n.online,
    seats: host ? { allows: host.allows, max: host.availability?.max ?? null, active: active.filter((s) => s.host.node === n.node_id).length } : null,
    ...(n.stats?.mem ? { mem: { pressure: n.stats.mem.pressure, free: n.stats.mem.free ?? null } } : {}),
    cpuBusyPct: sys?.cpu_busy_pct ?? load,
    runtimes: usableRuntimes(accounts, n.node_id, now),
  };
}

/** "3 machines (5 free seats)". */
function fleetLine(machines: readonly PollMachine[]): string {
  const free = machines.reduce((sum, m) => sum + machineCapacity(m).slots, 0);
  return `${machines.length} machine${machines.length === 1 ? "" : "s"} (${free} free seat${free === 1 ? "" : "s"})`;
}

/** The fleet as the poll reads it: each machine's capacity facts, and the cards an agent is working on now. */
export function fleetNow(d: PollDeps, projects: readonly ProjectView[], now: number): { machines: PollMachine[]; facts: ReturnType<typeof agentFacts> } {
  const facts = agentFacts(d, projects);
  const accounts = d.accounts();
  const active = d.seats().filter((s) => ACTIVE_SEAT_STATES.has(s.state));
  const hosts = d.seatHosts();
  return { machines: d.nodes().map((n) => machineOf(d, n, hosts, active, accounts, now)), facts };
}

export async function prepareOrchestrationPoll(d: PollDeps, canAct: () => boolean, signal?: AbortSignal): Promise<SkippedTurn> {
  const now = (d.now ?? d.core.clock)();
  d.idx.flushAll();
  const projects = visibleProjects({ core: d.core, idx: d.idx }).filter((p) => p.state === "active");
  const { machines, facts } = fleetNow(d, projects, now);
  const waiting: WaitingWork[] = [];
  for (const p of projects) {
    if (!canAct() || signal?.aborted) throw new Error("WalkieTalkie lease expired");
    await yieldLoop();
    waiting.push(...waitingIn(d, p, facts));
  }
  const plan = planPoll({ machines, waiting, now });
  const channelOf = new Map(waiting.map((w) => [w.card, w.channel]));
  const desired: Desired[] = plan.recs.flatMap((rec) => {
    const card = rec.action.kind === "start_seat" ? rec.action.card : null;
    const channel = card ? channelOf.get(card) : undefined;
    return channel ? [{ rec, channel }] : [];
  });
  if (!canAct()) throw new Error("WalkieTalkie lease expired");
  const done = reconcile(d, { source: "poll", scope: new Set(projects.map((p) => p.channel)), desired, canAct });
  const held = plan.machines.length ? ` Not taking work: ${plan.machines.slice(0, 3).map((m) => `${m.hostname} (${m.why})`).join("; ")}${plan.machines.length > 3 ? `; and ${plan.machines.length - 3} more` : ""}.` : "";
  const parts = [
    `${done.created} new`, `${done.kept} already open`,
    ...(done.superseded + done.replaced ? [`${done.superseded + done.replaced} retired`] : []),
    ...(done.suppressed ? [`${done.suppressed} not repeated`] : []), ...(done.capped ? [`${done.capped} over the limits`] : []),
  ];
  const line = `Orchestration poll: ${fleetLine(machines)}, ${waiting.length} card${waiting.length === 1 ? "" : "s"} waiting, ${plan.unplaced} without a seat; recommendations ${parts.join(", ")}.${held}`;
  return { skip: line.slice(0, 1_900) };
}
