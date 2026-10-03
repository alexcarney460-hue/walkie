// PROJECT-PAGES-1: what `GET /v1/projects/:channel/page` answers, shared by the daemon, the CLI and the dashboard (types only:
// the dashboard bundles this file as is). docs/plans/PROJECT-PAGES-1.md has the design.
import type { ScreenMetaT, ScreenStatus } from "./schema.ts";
import type { StatusReportMode } from "./status-report-setting.ts";

export type { ScreenStatus };

/** Who wrote something, as the page says it (a person, or a person's agent). */
export interface WhoView { handle: string; agent?: string }

/**
 * The counts a summary was written against: how many cards were blocked, in progress and in review when its facts were gathered.
 * The page flags a story when today's three differ from these (done in a day and in a week fall by themselves, so they are not here).
 */
export interface StoryCounts { blocked: number; in_progress: number; in_review: number }

/** The plain-English parts of the latest report that carried them (WalkieTalkie's), with when they were written. */
export interface StoryView {
  headline: string; lede: string; live_now: string[]; landing_next: string[];
  /** "Screens are out of date …": present only while it is still true when the page is read. */
  screens_note?: string;
  /**
   * The time the facts were gathered, and the time the report was posted: the earlier of the lead machine's stamp and this daemon's
   * receipt, so a lead whose clock runs ahead does not date its story in the future, and never later than the moment the page was read.
   */
  as_of: number; at: number; by: WhoView;
  /** What the summary was written against (absent from a report posted before the counts were carried: such a story is never flagged). */
  counts?: StoryCounts;
}

/** What Walkie counts itself, from the project's cards (those labelled confidential are in none of it) and its agents. */
export interface ComputedFacts {
  done_day: number; done_week: number; in_progress: number; in_review: number; blocked: number;
  /** Agents working on the project now, and on how many machines. */
  agents_working: number; agent_machines: number;
  /** The newest change to any of its cards, or null when it has none. */
  last_change: number | null;
}

/** A fact the project's people or agents set, with who set it and when. */
export interface SetFactView { label: string; value: string; by: WhoView; at: number }

export interface ScreenView extends ScreenMetaT {
  /** The Data Room file the image is (its id), the version shown, and its size and type. */
  id: string; version: number; size: number; mime: "image/png" | "image/jpeg" | "image/webp";
  /** When this version was added, and by whom. */
  at: number; by: WhoView;
  /** The image's bytes can be served from this machine or an online one (the Data Room's own rule). */
  available: boolean;
}

export interface ScreenGroupView { id: string; name: string; screens: ScreenView[] }
export interface ScreensView { total: number; newest_at: number | null; groups: ScreenGroupView[] }

export interface StatusPagePayload {
  /** The project's report setting: off suppresses the story and computed counts; set facts and screens remain. */
  mode: StatusReportMode;
  state: "active" | "archived" | "deleted";
  generated_at: number;
  /**
   * Latest timestamp of the visible story or an applied fact/screen mutation, including metadata and removals.
   * Retained when the last item is removed; null before any such content. No-op service writes do not advance it.
   * Millisecond event time (ties are valid), not a revision or a clock for computed counts, availability or report settings.
   */
  updated_at: number | null;
  /**
   * When this project's hourly report was switched on (the page's own clock for "no summary yet": a first report is due within an
   * hour of that), or null when it is off. Absent from an older daemon's answer.
   */
  reports_since?: number | null;
  story: StoryView | null;
  facts: { computed: ComputedFacts | null; set: SetFactView[] };
  screens: ScreensView;
}
