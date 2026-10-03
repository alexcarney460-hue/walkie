// PROJECT-PAGES-1 in the dashboard: the plain words the status page uses for what the daemon sends. Pure (no React, no
// fetching): the page's own components and its tests share them.
import type { ComputedFacts, ScreenStatus, StatusPagePayload, StoryView, WhoView } from "../api/types.ts";

/** How a screen's status reads on its chip: the words carry the meaning, the tone only helps. */
export const STATUS_CHIP: Record<ScreenStatus, { label: string; tone: "ok" | "warn" | "idle" }> = {
  works: { label: "Works", tone: "ok" },
  partial: { label: "Partial", tone: "warn" },
  empty: { label: "Empty state", tone: "warn" },
  "not-built": { label: "Not built yet", tone: "idle" },
};

/** The chip for a status; one this build does not know (a newer daemon's) reads plainly rather than breaking the page. */
export function chipOf(status: string): { label: string; tone: "ok" | "warn" | "idle" } {
  return STATUS_CHIP[status as ScreenStatus] ?? { label: "Not rated", tone: "idle" };
}

/** A person or their agent, as the page names them: @maren, @maren/cc-2. */
export function whoLabel(by: WhoView): string {
  return `@${by.handle}${by.agent ? `/${by.agent}` : ""}`;
}

/** "3 on 2 machines", or "None right now". */
export function agentsText(c: Pick<ComputedFacts, "agents_working" | "agent_machines">): string {
  return c.agents_working === 0 ? "None right now" : `${c.agents_working} on ${c.agent_machines} machine${c.agent_machines === 1 ? "" : "s"}`;
}

/** One tile of the facts strip: a label and a value, or a label and a time ("Last change"). */
export interface FactTile {
  key: string; label: string; value: string;
  /** A tile that shows a time rather than a value. */
  time?: number;
  /** For a fact somebody set: who, and when. */
  by?: string; at?: number;
}

/** The facts strip: what the team and its agents set (in the order they were first set), then what Walkie counts itself. */
export function factTiles(facts: StatusPagePayload["facts"]): FactTile[] {
  const set = facts.set.map((f, i): FactTile => ({ key: `set-${i}`, label: f.label, value: f.value, by: whoLabel(f.by), at: f.at }));
  const c = facts.computed;
  if (!c) return set;
  return [
    ...set,
    { key: "done-day", label: "Done in 24 hours", value: String(c.done_day) },
    { key: "done-week", label: "Done in 7 days", value: String(c.done_week) },
    { key: "in-progress", label: "In progress", value: String(c.in_progress) },
    { key: "in-review", label: "In review", value: String(c.in_review) },
    { key: "blocked", label: "Blocked or waiting", value: String(c.blocked) },
    { key: "agents", label: "Agents working", value: agentsText(c) },
    ...(c.last_change !== null ? [{ key: "last-change", label: "Last change", value: "", time: c.last_change } satisfies FactTile] : []),
  ];
}

/** WalkieTalkie reports once an hour, and only when something changed (its own schedule). */
export const REPORT_PERIOD_MS = 3_600_000;
/**
 * How long a story may sit beside numbers that disagree with it, and how long a project may be on reports with no story, before the
 * page says so: two report periods. A change reaches the story in the next hourly report, and a report that did not come out is
 * tried again an hour later, so what is still wrong after two hours is not just waiting for its turn.
 */
export const STORY_GRACE_MS = 2 * REPORT_PERIOD_MS;

/**
 * Whether the numbers beside the summary have moved on from the ones it was written against (blocked, in progress, in review: the
 * report's post carries them) and it is already past its grace. Compared as numbers, so no machine's clock decides whether the
 * board changed, and a change that moves none of them (an archived to-do card, a reordered card) never flags. A story from a
 * report posted before the counts were carried is never flagged.
 */
export function storyOutOfDate(story: Pick<StoryView, "at" | "counts">, computed: Pick<ComputedFacts, "blocked" | "in_progress" | "in_review"> | null, now: number): boolean {
  const c = story.counts;
  if (!c || !computed || !Number.isFinite(story.at)) return false;
  const moved = c.blocked !== computed.blocked || c.in_progress !== computed.in_progress || c.in_review !== computed.in_review;
  return moved && now - story.at > STORY_GRACE_MS;
}

/**
 * Whether a page with no story has waited longer than a first report takes: reports were switched on over two periods ago and the
 * project has cards to write about. Not known (an older daemon sent no switch-on time) is not overdue.
 */
export function storyOverdue(computed: Pick<ComputedFacts, "last_change"> | null, reportsSince: number | null | undefined, now: number): boolean {
  if (!computed || computed.last_change === null || typeof reportsSince !== "number" || !Number.isFinite(reportsSince)) return false;
  return now - reportsSince > STORY_GRACE_MS;
}

/** CSS `aspect-ratio` for a screen whose size is known (the page keeps room for it before the image arrives), else undefined. */
export function aspectOf(s: { w?: number; h?: number }): string | undefined {
  return s.w && s.h ? `${s.w} / ${s.h}` : undefined;
}

/** A phone-shaped screen (taller than 1.3 times its width): shown narrower and centred, as the reference does. */
export function isTall(s: { w?: number; h?: number }): boolean {
  return !!s.w && !!s.h && s.h / s.w > 1.3;
}

/** The sentence a screen reader gets for an enlarged screen. */
export function screenAlt(s: { title: string; group: string; about: string }): string {
  return `${s.title} (${s.group}): ${s.about}`;
}

/**
 * Where to scroll so a group of screens lands just below the index that sticks to the top (below the phone's own bar), however
 * many rows the index wraps to: the group's place on the page, less the index's own top and height and a little air.
 */
export function groupScrollTop(m: { groupTop: number; scrollY: number; stickyTop: number; indexHeight: number; gap?: number }): number {
  return Math.max(0, Math.round(m.groupTop + m.scrollY - (m.stickyTop + m.indexHeight + (m.gap ?? 12))));
}

/**
 * Runs requests so that only the newest one's answer is used: the page asks again on every stream tick and every two minutes,
 * and an answer for an earlier request (or for another project, once the page has moved) must never be shown over a newer one.
 * `cancel` drops whatever is still in flight (the page moved on, or went away).
 */
export function latestOnly(): {
  run: <T>(request: () => Promise<T>, ok: (value: T) => void, fail: (error: unknown) => void) => void;
  cancel: () => void;
} {
  let latest = 0;
  return {
    run: (request, ok, fail) => {
      const mine = ++latest;
      request().then((v) => { if (mine === latest) ok(v); }, (e: unknown) => { if (mine === latest) fail(e); });
    },
    cancel: () => { latest++; },
  };
}
