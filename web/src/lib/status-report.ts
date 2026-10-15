// PROJECT-REPORTS-1 in the dashboard: who may switch a project's hourly status report, and switching it. The rules are
// the daemon's own (protocol/projects/status-report-setting.ts), so the switch is offered to exactly those it would accept.
import { ApiError, friendlyError } from "../api/client.ts";
import type { ProjectView } from "../api/types.ts";
import { statusReportDenial } from "../../../src/protocol/projects/status-report-setting.ts";
import { SAVED_REFRESHING, storeWriteAnswer } from "./store-write.ts";
import { projectsStore } from "../state/projects.ts";

export { reportMode } from "../../../src/protocol/projects/status-report-setting.ts";

/** The project's creator (while a member) and the team's owners; an observer, another member and a signed-out viewer may not. */
export function canSetStatusReport(me: { handle: string | null; role: string | null } | null | undefined, project: Pick<ProjectView, "creator">): boolean {
  return !!me?.handle && statusReportDenial(me.role, me.handle, project.creator) === null;
}

interface ProjectClient { updateProject(channel: string, body: Record<string, unknown>): Promise<{ project: ProjectView }> }

/** Shown when a write is refused because the list of what this person can see is being re-read. */
export const ACCESS_REFRESHING = "Access is refreshing. Try again in a moment.";

/**
 * Turns a project's hourly report on or off and puts the daemon's answer in the store. Resolves to null on success, else
 * a sentence for the person: the daemon's own plain reason for a refusal (an observer, another member), the usual wording
 * for anything else. The store is left alone when the change failed. When the store dropped the daemon's answer (access
 * moved during the request) the change still happened, so the list is read again and the caller receives a saved notice.
 */
export async function toggleStatusReport(client: ProjectClient, store: typeof projectsStore, channel: string, on: boolean, onShown?: () => void): Promise<string | null> {
  const generation = store.accessGeneration();
  try {
    const { project } = await client.updateProject(channel, { status_report: on ? "hourly" : "off" });
    return storeWriteAnswer({ kind: "project", value: project }, generation, onShown, store) ? null : SAVED_REFRESHING;
  } catch (err) {
    return err instanceof ApiError && err.code === "forbidden" ? err.message : friendlyError(err);
  }
}
