// PROJECT-PAGES-1: the card counts a project's status page shows, in one place so the page and the report agree on them. The page
// reads them when it is built; the report turn records the three that its summary talks about (blocked, in progress, in review) in
// its post, so the page can tell, later, that the board has moved on from the numbers the summary was written against.
import type { ProjectView } from "../../protocol/projects/schema.ts";
import type { StoryCounts } from "../../protocol/projects/status-page.ts";
import { isConfidential } from "../../protocol/projects/status-report.ts";
import type { ProjectsIndex } from "./index.ts";

const DAY_MS = 24 * 3_600_000;

export interface CardCounts {
  done_day: number; done_week: number; in_progress: number; in_review: number; blocked: number; last_change: number | null;
}

/**
 * The counts from the project's cards that are not labelled `confidential`, on its active boards, as of `now` (the report's own
 * rules: the same lists of blocked and waiting; a card on a board that is not active is in none of them).
 */
export function cardCounts(idx: ProjectsIndex, p: ProjectView, now: number): CardCounts {
  const roles = new Map(p.boards.filter((b) => b.state === "active").flatMap((b) => b.columns.map((c) => [`${b.id}/${c.id}`, c.role] as const)));
  const waiting = new Set(["blocker", "decision-needed", "waiting-on"]);
  const out: CardCounts = { done_day: 0, done_week: 0, in_progress: 0, in_review: 0, blocked: 0, last_change: null };
  for (const r of idx.db.cardsForCounts(p.channel)) {
    let labels: string[] = [];
    if (r.labels !== "[]") {
      try { const parsed: unknown = JSON.parse(r.labels); labels = Array.isArray(parsed) ? parsed.map(String) : []; } catch { /* a card whose labels do not parse has none */ }
    }
    if (isConfidential(labels)) continue;
    out.last_change = out.last_change === null ? r.updated : Math.max(out.last_change, r.updated);
    if (r.state !== "open") continue;
    const role = roles.get(`${r.board}/${r.column}`);
    if (role === undefined) continue; // on a board that is not active: not counted, as the report's sheet does
    const age = now - r.updated;
    if (role === "done") { if (age <= DAY_MS) out.done_day++; if (age <= 7 * DAY_MS) out.done_week++; continue; }
    if (role === "active") out.in_progress++;
    else if (role === "review") out.in_review++;
    if (role !== "cancelled" && (r.blocked || labels.some((l) => waiting.has(l.trim().toLowerCase())))) out.blocked++;
  }
  return out;
}

/**
 * The counts a summary is written against: the three that do not age by themselves. (Done in a day and in a week fall as time
 * passes with nothing changing, so comparing them would flag every quiet board.)
 */
export function storyCounts(c: Pick<CardCounts, "blocked" | "in_progress" | "in_review">): StoryCounts {
  return { blocked: c.blocked, in_progress: c.in_progress, in_review: c.in_review };
}
