// When an agent's current state, and its current activity line, began (WALKIE-LIVE-2): the dashboard shows
// "Running a command · 8m" (ticking) instead of "updated 506 s ago", which a re-posted status would reset.
// Kept per viewer (the daemon, the mock) by agent id, across roster reads; a status that keeps the same state /
// line (a freshness re-post, another field changing) keeps its start. After a daemon restart the starts are the
// latest statuses' times, the best that is known.
import type { AgentState } from "./schemas.ts";

interface Since { state: AgentState; stateSince: number; line: string; lineSince: number; observed: number }

export interface SinceInput { id: string; effective_state: AgentState; activity?: string; observed: number }
export interface SinceView { state_since: number; activity_since: number }

export class AgentSince {
  private seen = new Map<string, Since>();

  /**
   * The starts for this roster read. `rows` must be the whole roster: agents not in it are forgotten. A change with no
   * newer status behind it (a machine going offline, a status going stale) starts at `now`, not at the old status.
   */
  read(rows: readonly SinceInput[], now: number): Map<string, SinceView> {
    const next = new Map<string, Since>();
    const out = new Map<string, SinceView>();
    for (const r of rows) {
      const prev = this.seen.get(r.id);
      const line = `${r.effective_state}\n${r.activity ?? ""}`;
      const start = prev && r.observed <= prev.observed ? now : Math.min(r.observed, now);
      const s: Since = {
        state: r.effective_state, line, observed: Math.max(r.observed, prev?.observed ?? 0),
        stateSince: prev && prev.state === r.effective_state ? prev.stateSince : start,
        lineSince: prev && prev.line === line ? prev.lineSince : start,
      };
      next.set(r.id, s);
      out.set(r.id, { state_since: s.stateSince, activity_since: s.lineSince });
    }
    this.seen = next;
    return out;
  }
}
