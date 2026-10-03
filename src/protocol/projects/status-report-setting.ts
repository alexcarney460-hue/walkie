// PROJECT-REPORTS-1: the small part of the status report the dashboard shares with the daemon and the CLI (the setting,
// who may change it, the posted report's header). No imports: the dashboard bundles it as is.

/** The project setting: WalkieTalkie writes a report each hour something changed, or never. */
export type StatusReportMode = "hourly" | "off";

/** A project's mode; a view stored before the field existed has none, which reads as off. */
export function reportMode(p: { status_report?: StatusReportMode | undefined }): StatusReportMode {
  return p.status_report === "hourly" ? "hourly" : "off";
}

/**
 * Why this person may not turn a project's status report on or off, or null when they may: its creator (while still a
 * member) and the team's owners, as people (the fold's own rule for project settings, fold.ts isAdmin). The caller says
 * whether it is a person; an agent is refused wherever the request arrives.
 */
export function statusReportDenial(role: string | null | undefined, handle: string | null | undefined, creator: string): string | null {
  if (role === "observer") return "observers can't change a project's status report";
  if (role === "owner" || (role === "member" && !!handle && handle === creator)) return null;
  return "only the project's creator or an owner can turn its status report on or off";
}

/** The first characters of a posted report's header line (status-report.ts composeReport writes the rest). */
export const HEADER_START = "**Status report · ";
const HEADER = /^\*\*Status report · [^\n]*\*\*\n\n/;

/** A posted report split into its header line and the report (the dashboard shows the report under its own heading). */
export function splitReport(text: string): { header: string | null; body: string } {
  const m = HEADER.exec(text);
  return m ? { header: m[0].trimEnd(), body: text.slice(m[0].length) } : { header: null, body: text };
}

/** GET /v1/projects/:channel/status-report: the setting and the latest report, split into its header line and the report. */
export interface StatusReportPayload {
  mode: StatusReportMode;
  report: { markdown: string; header: string | null; as_of: number; at: number; by: { handle: string; agent?: string } } | null;
}
