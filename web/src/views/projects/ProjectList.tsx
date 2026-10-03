import { useMemo, useState } from "react";
import { ChevronRight, Download, FolderKanban, Lock, Newspaper, Plus } from "lucide-react";
import type { AgentView, ProjectView } from "../../api/types.ts";
import { PageHeader } from "../../components/Shell.tsx";
import { Avatar, EmptyState, ErrorState, RelTime, SkeletonRows, hueVar } from "../../components/primitives.tsx";
import { tagHue } from "../../lib/format.ts";
import { hrefFor } from "../../lib/route.ts";
import { byFolder, presence } from "../../lib/projects.ts";
import { useProjects, projectsStore } from "../../state/projects.ts";
import { useStore } from "../../state/store.tsx";
import { CreateProject } from "./CreateProject.tsx";
import { LinearImport } from "./LinearImport.tsx";
import { Meter } from "./Meter.tsx";
import { reportMode } from "../../lib/status-report.ts";
import { ProjectReportToggle } from "./StatusReportSwitch.tsx";
import { reportedProjects } from "../../lib/updates.ts";

/** The way to the Updates page (UPDATES-1) at the top of the list: on a phone the tab bar has no room for it. */
export function UpdatesLink({ projects }: { projects: readonly ProjectView[] }) {
  const n = reportedProjects(projects).length;
  return (
    <a className="updates-link" href={hrefFor({ view: "updates" })}>
      <Newspaper size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="updates-link-text">
        <strong>Updates</strong> · {n ? `plain-English status reports on ${n} project${n === 1 ? "" : "s"}` : "plain-English status reports, once a project's hourly report is on"}
      </span>
      <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
    </a>
  );
}

/** Up to four live agents on a project (avatars), then a count. */
export function AgentFaces({ agents, max = 4 }: { agents: readonly AgentView[] | undefined; max?: number }) {
  if (!agents?.length) return null;
  const shown = agents.slice(0, max);
  return (
    <span className="faces" aria-label={`${agents.length} agent${agents.length === 1 ? "" : "s"} working here: ${agents.map((a) => a.agent).join(", ")}`}>
      {shown.map((a) => (
        <span key={a.id} className={`face state-${a.effective_state}`} title={`@${a.id} · ${a.effective_state}${a.status.title ? ` · ${a.status.title}` : ""}`}>
          <Avatar handle={a.handle} name={a.agent} size={20} agent />
        </span>
      ))}
      {agents.length > max && <span className="faces-more tnum">+{agents.length - max}</span>}
    </span>
  );
}

function ProjectRow({ p, agents }: { p: ProjectView; agents: AgentView[] | undefined }) {
  return (
    <li className="project-item">
      <a className="project-row" href={hrefFor({ view: "projects", channel: p.channel })}>
        <span className="project-prefix mono" style={hueVar("--th", tagHue(p.prefix))}>{p.prefix}</span>
        <span className="project-main">
          <span className="project-name">
            {p.name}
            {p.private && <Lock size={12} strokeWidth={2} aria-label="Private: the team's owners" className="project-lock" />}
            {p.state !== "active" && <span className="chip">{p.state}</span>}
          </span>
          <span className="project-sub muted">
            {p.boards.length} board{p.boards.length === 1 ? "" : "s"} · {p.cards} card{p.cards === 1 ? "" : "s"}
            {p.description ? ` · ${p.description.split("\n")[0]}` : ""}
          </span>
        </span>
        <span className="project-faces"><AgentFaces agents={agents} /></span>
        <Meter meter={p.meter} />
        <span className="project-activity muted"><RelTime ts={p.last_activity} /></span>
      </a>
      {/* Beside the link, not inside it: a control must not sit within another interactive element. */}
      <div className="project-report">
        <ProjectReportToggle project={p} />
        {/* The status page (PROJECT-PAGES-1) exists for a project whose hourly report is on; with it off nothing new shows. */}
        {reportMode(p) === "hourly" && p.state === "active" && (
          <a className="project-page-link" href={hrefFor({ view: "projects", channel: p.channel, page: true })}>Status page</a>
        )}
      </div>
    </li>
  );
}

export function ProjectList() {
  const s = useProjects();
  const { agents } = useStore();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const live = s.projects.filter((p) => p.state !== "deleted");
  const who = useMemo(() => presence(agents, live, () => true).byProject, [agents, live]);
  const groups = byFolder(live);
  const working = [...who.values()].reduce((n, a) => n + a.length, 0);

  return (
    <div className="page page-wide">
      <PageHeader
        title="Projects"
        meta={s.status === "ready" ? `${live.length} project${live.length === 1 ? "" : "s"}${working ? ` · ${working} agent${working === 1 ? "" : "s"} on them now` : ""}` : undefined}
        actions={<>
          <button type="button" className="btn btn-sm" onClick={() => setImporting(true)}><Download size={14} strokeWidth={2} />Import from Linear</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Plus size={14} strokeWidth={2} />New project</button>
        </>}
      />
      {s.status === "error" ? (
        <ErrorState message={s.error ?? "Couldn't load projects."} onRetry={() => void projectsStore.refresh()} />
      ) : s.status !== "ready" ? (
        <SkeletonRows rows={4} />
      ) : !live.length && !s.stubs.length ? (
        <EmptyState icon={<FolderKanban size={22} strokeWidth={1.5} />} title="No projects yet" command='walkie projects create "Website" --folder Acme'>
          <p>A project is a kanban board your whole team and its agents share: cards, columns, who is on what, and how far along it is.</p>
          <p><button type="button" className="btn btn-sm" onClick={() => setImporting(true)}><Download size={14} strokeWidth={2} />Import from Linear</button></p>
        </EmptyState>
      ) : (
        <>
          <UpdatesLink projects={live} />
          {groups.map((g) => (
            <section key={g.folder || "(none)"} className="project-folder" aria-label={g.folder || "No folder"}>
              <h2 className="section-title">{g.folder || "No folder"}</h2>
              <ul className="project-list">
                {g.projects.map((p) => <ProjectRow key={p.channel} p={p} agents={who.get(p.channel)} />)}
              </ul>
            </section>
          ))}
          {s.stubs.length > 0 && (
            <p className="project-stubs muted"><Lock size={12} strokeWidth={2} aria-hidden="true" /> {s.stubs.length} private project{s.stubs.length === 1 ? "" : "s"} of the team's owners.</p>
          )}
        </>
      )}
      {creating && <CreateProject onClose={() => setCreating(false)} />}
      {importing && <LinearImport onClose={() => { setImporting(false); void projectsStore.refresh(); }} />}
    </div>
  );
}
