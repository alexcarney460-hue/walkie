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
