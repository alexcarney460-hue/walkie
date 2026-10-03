// Which agents Mission Control shows and which live in the Agent archive (WALKIE-MISSION-1, PROTOCOL §4 "Agent
// archive"). Pure: the daemon (views, pruning), the CLI and the dashboard all decide with these same functions.
//
// - Shown by default: working, needing a person (waiting / blocked, "Stuck"), or an idle running seat.
// - Live roster: those, plus agents that went idle less than IDLE_ARCHIVE_MS ago or offline less than
//   OFFLINE_GRACE_MS ago. The daemon's /v1/agents and the dashboard stream carry only the live roster.
// - Archive: everything else (idle for a while, offline past the grace), on request. A daemon keeps at most
//   ARCHIVE_CAP_PER_NODE archived agents per machine and none older than ARCHIVE_TTL_MS; the rest is deleted from its
//   agent table (the signed status events stay in the log). An archived agent comes back the moment it reports again.
import type { AgentState } from "./schemas.ts";

export const OFFLINE_GRACE_MS = 10 * 60_000;
export const IDLE_ARCHIVE_MS = 30 * 60_000;
export const ARCHIVE_TTL_MS = 7 * 86_400_000;
export const ARCHIVE_CAP_PER_NODE = 200;

export interface RosterEntry {
  readonly agent?: string;
  readonly status?: { readonly parent?: string };
  readonly effective_state: AgentState; readonly updated_at: number;
  /** A session's sub-agents (WALKIE-MISSION-SUB-1): while one works, the session is shown and never archived. */
  readonly subagents?: { readonly working: number };
}

/** Working, waiting on a person, stuck, or a session whose sub-agents work: what Mission Control and `walkie who` show. */
export function shownByDefault(a: Pick<RosterEntry, "effective_state" | "subagents"> & { status?: { parent?: string } }): boolean {
  return a.effective_state === "working" || needsPerson(a.effective_state) || (a.subagents?.working ?? 0) > 0
    || (a.status?.parent === "seats" && a.effective_state === "idle");
}

/** Waiting on a person or stuck (blocked). */
export function needsPerson(state: AgentState): boolean {
  return state === "waiting" || state === "blocked";
}

/** Idle past IDLE_ARCHIVE_MS or offline past OFFLINE_GRACE_MS (since its last status); never while sub-agents work. */
export function isArchived(a: RosterEntry, now = Date.now()): boolean {
  return isArchivedAt(a.effective_state, a.updated_at, now, a.subagents?.working ?? 0);
}

/** `isArchived` for a state and a time (no entry object to build: the daemon asks it for every row of a roster read). */
export function isArchivedAt(state: AgentState, updatedAt: number, now = Date.now(), workingSubagents = 0): boolean {
  if (workingSubagents > 0) return false;
  const age = now - updatedAt;
  if (state === "offline") return age >= OFFLINE_GRACE_MS;
  if (state === "idle") return age >= IDLE_ARCHIVE_MS;
  return false;
}

/** Past the archive's time limit: deleted from a daemon's agent table. */
export function isExpired(a: RosterEntry, now = Date.now()): boolean {
  return isArchived(a, now) && now - a.updated_at >= ARCHIVE_TTL_MS;
}

/** Per machine: how many of its agents are idle and offline, and how many of those are archived. */
export interface ArchiveCount { node: string; idle: number; offline: number }

/** Idle / offline counts per node for `entries` (e.g. everything not shown by default). */
export function countByNode(entries: ReadonlyArray<RosterEntry & { node: string }>): ArchiveCount[] {
  const by = new Map<string, ArchiveCount>();
  for (const a of entries) {
    if (a.effective_state !== "idle" && a.effective_state !== "offline") continue;
    const c = by.get(a.node) ?? { node: a.node, idle: 0, offline: 0 };
    by.set(a.node, a.effective_state === "idle" ? { ...c, idle: c.idle + 1 } : { ...c, offline: c.offline + 1 });
  }
  return [...by.values()];
}

/** Idle / offline per node that a default view leaves out: the live roster's own plus the archive's counts. */
export function hiddenByNode(live: ReadonlyArray<RosterEntry & { node: string }>, archive: readonly ArchiveCount[]): ArchiveCount[] {
  const by = new Map<string, ArchiveCount>();
  for (const c of [...countByNode(live.filter((a) => !shownByDefault(a))), ...archive]) {
    const prev = by.get(c.node) ?? { node: c.node, idle: 0, offline: 0 };
    by.set(c.node, { node: c.node, idle: prev.idle + c.idle, offline: prev.offline + c.offline });
  }
  return [...by.values()];
}

/** "3 idle · 12 offline" (parts with zero left out); "" when both are zero. */
export function archiveCountText(c: { idle: number; offline: number }): string {
  return [c.idle ? `${c.idle} idle` : "", c.offline ? `${c.offline} offline` : ""].filter(Boolean).join(" · ");
}

/** Case-insensitive match of an archive search against an agent's name, machine, title, task, repo and activity. */
export function matchesSearch(a: { agent: string; hostname: string; status: { title?: string; task?: string; repo?: string; branch?: string; activity?: string } }, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const s = a.status;
  // Ignore malformed peer text before rendering: item boundaries cannot catch errors in the list's filter.
  return [a.agent, a.hostname, s.title, s.task, s.repo, s.branch, s.activity].some((v) => typeof v === "string" && v.toLowerCase().includes(needle));
}
