// The Updates page (UPDATES-1): every project's latest plain-English status report in one place, for the team's partners.
// Which projects it lists and in what order; the view (views/updates/Updates.tsx) fetches and renders.
import type { ProjectView, StatusReportPayload } from "../api/types.ts";
import { reportMode } from "./status-report.ts";

/** A reported project's latest report as the page holds it: still loading, failed (with why), or what the daemon said. */
export type UpdateEntry =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: StatusReportPayload };

/** The projects the page reports on: active ones whose hourly status report is on (an archived one writes no new report). */
export function reportedProjects(projects: readonly ProjectView[]): ProjectView[] {
  return projects.filter((p) => p.state === "active" && reportMode(p) === "hourly");
}

/** The other active projects: no hourly report, so the page only names them. */
export function unreportedProjects(projects: readonly ProjectView[]): ProjectView[] {
  return projects.filter((p) => p.state === "active" && reportMode(p) !== "hourly");
}

/** More active projects than this and the picker offers a text filter (fewer fit on a screen without one). */
export const PICKER_FILTER_ABOVE = 12;

/** Letters compared without case or accents, so "alpha" and "Alpha" are one place in the order. */
const alike = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base" });

/**
 * The picker's rows: every active project (an archived one writes no report, so it is not offered), in a fixed order that
 * reads as the label each row shows, "folder · name": by folder (projects with none first), then name, then channel.
 * The report setting is not part of it, so switching a project on or off never moves a row. A new array.
 */
export function pickerProjects(projects: readonly ProjectView[]): ProjectView[] {
  return projects
    .filter((p) => p.state === "active")
    .sort((a, b) => alike(a.folder, b.folder) || alike(a.name, b.name) || a.channel.localeCompare(b.channel));
}

/** The projects whose name, folder or prefix contains the text (case-insensitive, surrounding spaces ignored); no text keeps all. A new array. */
export function filterPickerProjects(projects: readonly ProjectView[], query: string): ProjectView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...projects];
  return projects.filter((p) => [p.name, p.folder, p.prefix].some((field) => field.toLowerCase().includes(q)));
}

function reportAt(e: UpdateEntry | undefined): number | null {
  return e?.status === "ready" && e.data.report ? e.data.report.at : null;
}

/**
 * Newest report first; projects with no report yet (or failed) after them, by name. While any report is still loading,
 * by the projects' latest activity instead, so the cards don't jump as each report arrives. A new array.
 */
export function orderUpdates(projects: readonly ProjectView[], entries: Readonly<Record<string, UpdateEntry>>): ProjectView[] {
  if (projects.some((p) => !entries[p.channel] || entries[p.channel]?.status === "loading")) {
    return [...projects].sort((a, b) => b.last_activity - a.last_activity || a.name.localeCompare(b.name));
  }
  return [...projects].sort((a, b) => {
    const ta = reportAt(entries[a.channel]);
    const tb = reportAt(entries[b.channel]);
    if (ta !== null && tb !== null && ta !== tb) return tb - ta;
    if (ta !== null && tb === null) return -1;
    if (ta === null && tb !== null) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** At most this many report reads at once, so a team with many reported projects does not flood its own daemon. */
export const READ_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `limit` in flight; resolves when all have settled (fn handles its own errors). */
export async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
