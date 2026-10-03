// When an agent's current state, and its current activity line, began (WALKIE-LIVE-2): the dashboard shows
// "Running a command · 8m" (ticking) instead of "updated 506 s ago", which a re-posted status would reset.
// Kept per viewer (the daemon, the mock) by agent id, across roster reads; a status that keeps the same state /
// line (a freshness re-post, another field changing) keeps its start. After a daemon restart the starts are the
// latest statuses' times, the best that is known.
//
// A read costs nothing for a row that did not change (DAEMON-STALL-2): it allocates only for the rows whose state,
// line or observation time moved, and a record whose starts stay the same keeps one `SinceView` object, so a caller can
// tell an unchanged row by identity. With a roster of thousands of long-dead agents that is what keeps a read cheap.
import type { AgentState } from "./schemas.ts";

export interface SinceInput { id: string; effective_state: AgentState; activity?: string; observed: number }
export interface SinceView { readonly state_since: number; readonly activity_since: number }

interface Since {
  readonly state: AgentState;
  /** The activity line ("" for none). */
  readonly activity: string;
  readonly observed: number;
  readonly stateSince: number;
  readonly lineSince: number;
  /** What a read answers for this record: one object for as long as both starts stay. */
  readonly view: SinceView;
  /** The read that last saw this agent. Bookkeeping only, set in place: it is how `end` forgets the absent. */
  gen: number;
}

export class AgentSince {
  private seen = new Map<string, Since>();
  private gen = 0;
  private at = 0;
  /** Records the read in progress replaces (applied by `end`); none while every row so far was unchanged. */
  private pending: Map<string, Since> | null = null;

  /** Starts a read of the whole roster at `now`: `note` each row, then `end`. */
  begin(now: number): void {
    this.gen += 1;
    this.at = now;
    this.pending = null;
  }

  /**
   * One row of the read. Every row is judged against the records as the previous read left them, never against what
   * this read already noted: two rows with one id (two machines of one person that share a hostname) both give the
   * LAST row's answer, whichever of them changed.
   */
  note(id: string, state: AgentState, activity: string | undefined, observed: number): void {
    const prev = this.seen.get(id);
    const line = activity ?? "";
    if (prev) {
      prev.gen = this.gen;
      if (prev.state === state && prev.activity === line && observed <= prev.observed) {
        if (this.pending?.has(id)) this.pending.set(id, prev); // this row is the later one: its (unchanged) record wins
        return;
      }
    }
    // A change with no newer status behind it (a machine going offline, a status going stale) starts at `now`.
    const start = prev && observed <= prev.observed ? this.at : Math.min(observed, this.at);
    const stateSince = prev && prev.state === state ? prev.stateSince : start;
    const lineSince = prev && prev.state === state && prev.activity === line ? prev.lineSince : start;
    const next: Since = {
      state, activity: line, observed: Math.max(observed, prev?.observed ?? 0), stateSince, lineSince,
      view: prev && prev.stateSince === stateSince && prev.lineSince === lineSince
        ? prev.view : { state_since: stateSince, activity_since: lineSince },
      gen: this.gen,
    };
    (this.pending ??= new Map()).set(id, next);
  }

  /** Ends the read: its changes take effect, and agents it did not note are forgotten. */
  end(): void {
    if (this.pending) {
      for (const [id, rec] of this.pending) this.seen.set(id, rec);
      this.pending = null;
    }
    for (const [id, rec] of this.seen) if (rec.gen !== this.gen) this.seen.delete(id);
  }

  /** The starts of an agent as of the last finished read; the same object while they do not change. */
  get(id: string): SinceView | undefined {
    return this.seen.get(id)?.view;
  }

  /**
   * The starts for this roster read. `rows` must be the whole roster: agents not in it are forgotten. A change with no
   * newer status behind it (a machine going offline, a status going stale) starts at `now`, not at the old status.
   */
  read(rows: readonly SinceInput[], now: number): Map<string, SinceView> {
    this.begin(now);
    for (const r of rows) this.note(r.id, r.effective_state, r.activity, r.observed);
    this.end();
    const out = new Map<string, SinceView>();
    for (const r of rows) {
      const v = this.get(r.id);
      if (v) out.set(r.id, v);
    }
    return out;
  }
}
