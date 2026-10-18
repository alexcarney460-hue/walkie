import type { CardView, ProjectView } from "../api/types.ts";
import { cardRole, onSimplePage } from "./simple-board.ts";

/** The same visible, open cards feed Home and the Projects list. */
export function projectProgressSummary(project: ProjectView, cards: readonly CardView[], complete: boolean): string {
  if (!complete) return "Counts unavailable";
  const own = cards.filter((card) => card.channel === project.channel && onSimplePage(card, [project]));
  const active = own.filter((card) => cardRole(card, [project]) === "active").length;
  const review = own.filter((card) => cardRole(card, [project]) === "review").length;
  const blocked = own.filter((card) => card.blocked).length;
  return [active ? `${active} in progress` : "", review ? `${review} waiting for review` : "",
    blocked ? `${blocked} blocked` : ""].filter(Boolean).join(" · ");
}
