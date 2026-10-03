// The "Hourly status report" switch of a project (PROJECT-REPORTS-1): a labelled checkbox with the switch role, so it is a real
// control a keyboard operates (Space) and a screen reader announces with its state; for people who may not change it, a
// small read-only marker on a project that has it on. An archived project is not reported on, so it shows neither.
import { useState } from "react";
import { api } from "../../api/client.ts";
import type { ProjectView } from "../../api/types.ts";
import { canSetStatusReport, reportMode, toggleStatusReport } from "../../lib/status-report.ts";
import { projectsStore } from "../../state/projects.ts";
import { useStore } from "../../state/store.tsx";

export function StatusReportSwitch({ project, canSet, busy, error, onToggle }: {
  project: ProjectView; canSet: boolean; busy: boolean; error: string | null; onToggle: (on: boolean) => void;
}) {
  const on = reportMode(project) === "hourly";
  if (project.state !== "active") return null;
  if (!canSet) {
    return on ? <span className="chip project-report-marker" title="WalkieTalkie writes a plain-English status report for this project each hour something changes">Reported hourly</span> : null;
  }
  return (
    <div className="project-report-switch">
      <label className="toggle-row">
        {/* aria-disabled, not disabled: a disabled input drops the keyboard focus, so a keyboard user who pressed Space would lose their place. */}
        <input type="checkbox" role="switch" aria-checked={on} aria-label={`Hourly status report for ${project.name}`} checked={on}
          aria-disabled={busy ? true : undefined} onChange={(e) => { if (!busy) onToggle(e.currentTarget.checked); }} />
        <span>Hourly status report</span>
      </label>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}

/** The switch of one row of the project list, wired to the daemon. */
export function ProjectReportToggle({ project }: { project: ProjectView }) {
  const { me } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (on: boolean) => {
    setBusy(true);
    setError(null);
    setError(await toggleStatusReport(api, projectsStore, project.channel, on));
    setBusy(false);
  };
  return <StatusReportSwitch project={project} canSet={canSetStatusReport(me, project)} busy={busy} error={error} onToggle={(on) => void change(on)} />;
}
