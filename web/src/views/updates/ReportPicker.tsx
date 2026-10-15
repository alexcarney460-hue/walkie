// The picker on the Updates page (WALK-121): every active project with the switch that turns its hourly update on, so a
// person chooses right where the updates are read. It adds no way to change the setting: each row's control is the
// Projects list's own (ProjectReportToggle), which writes through toggleStatusReport. A person who may not change a
// project gets a read-only state and reason on that row, never a control the daemon would refuse.
import { useId } from "react";
import type { ProjectView } from "../../api/types.ts";
import { hrefFor } from "../../lib/route.ts";
import { PICKER_FILTER_ABOVE, filterPickerProjects, pickerProjects, reportedProjects } from "../../lib/updates.ts";
import { ProjectReportToggle } from "../projects/StatusReportSwitch.tsx";

const TITLE = "Choose projects for hourly updates";

function PickerRow({ project }: { project: ProjectView }) {
  return (
    <li className="updates-pick-row">
      <span className="updates-pick-name">
        {project.folder && <span className="updates-pick-folder">{project.folder} · </span>}
        {project.name}
      </span>
      <span className="updates-pick-control">
        <ProjectReportToggle project={project} />
      </span>
    </li>
  );
}

function PickerBody({ active, query, onQuery }: { active: readonly ProjectView[]; query: string; onQuery: (q: string) => void }) {
  const findId = useId();
  if (!active.length) {
    return <p className="updates-pick-intro">No active projects yet. <a href={hrefFor({ view: "projects" })}>Create one on the Projects page.</a></p>;
  }
  const filtered = active.length > PICKER_FILTER_ABOVE;
  const shown = filtered ? filterPickerProjects(active, query) : active;
  return (
    <>
      <p className="updates-pick-intro">Turn a project on and Talkie writes its update each hour something changes.</p>
      {filtered && (
        <div className="field updates-pick-find">
          <label htmlFor={findId}>Find a project</label>
          <input id={findId} className="input" type="search" autoComplete="off" value={query} onChange={(e) => onQuery(e.currentTarget.value)} />
        </div>
      )}
      {shown.length ? (
        <ul className="updates-pick-list">
          {shown.map((p) => <PickerRow key={p.channel} project={p} />)}
        </ul>
      ) : <p className="muted updates-pick-none" role="status">No project matches that.</p>}
    </>
  );
}

/**
 * One disclosure in every state, so the checkboxes are never remounted: the page changes shape when the first project is
 * switched on (explanation, then the picker, becomes the cards, then the picker), and a remounted checkbox would take the
 * keyboard focus of the person who just pressed Space on it. While nothing is on, its summary is the section's title and
 * it is open; once some are, the summary counts them. Open and the filter text are held by the page, not here, so a
 * person ticking several in a row also keeps their list open and their filter.
 */
export function ReportPicker({ projects, open, onOpenChange, query, onQuery }: {
  projects: readonly ProjectView[]; open: boolean; onOpenChange: (open: boolean) => void; query: string; onQuery: (q: string) => void;
}) {
  const active = pickerProjects(projects);
  const on = reportedProjects(projects).length;
  return (
    <section className="updates-pick" aria-label={TITLE}>
      <details className="updates-pick-details" open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)}>
        <summary>{on ? `Hourly updates: ${on} of ${active.length} project${active.length === 1 ? "" : "s"}` : TITLE}</summary>
        <PickerBody active={active} query={query} onQuery={onQuery} />
      </details>
    </section>
  );
}
