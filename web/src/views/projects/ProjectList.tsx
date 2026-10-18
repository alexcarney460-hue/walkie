import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FolderKanban, Lock, MoreHorizontal, Plus, Settings } from "lucide-react";
import type { AgentView, CardView, ProjectView } from "../../api/types.ts";
import { PageHeader } from "../../components/Shell.tsx";
import { Avatar, EmptyState, ErrorState, SkeletonRows, hueVar } from "../../components/primitives.tsx";
import { tagHue } from "../../lib/format.ts";
import { hrefFor } from "../../lib/route.ts";
import { byFolder, presence } from "../../lib/projects.ts";
import { useProjects, projectsStore } from "../../state/projects.ts";
import { useStore } from "../../state/store.tsx";
import { displayStoredText } from "../../../../src/protocol/display-text.ts";
import { CreateProject } from "./CreateProject.tsx";
import { LinearImport } from "./LinearImport.tsx";
import { Meter } from "./Meter.tsx";
import { reportMode } from "../../lib/status-report.ts";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { projectProgressSummary } from "../../lib/project-summary.ts";
import { useHomeNeeds } from "../home/needs.tsx";

/** Up to four live agents on a project (avatars), then a count. */
export function AgentFaces({ agents, max = 4 }: { agents: readonly AgentView[] | undefined; max?: number }) {
  if (!agents?.length) return null;
  const shown = agents.slice(0, max);
  return (
    <span className="faces" aria-label={`${agents.length} agent${agents.length === 1 ? "" : "s"} working here: ${agents.map((a) => a.agent).join(", ")}`}>
      {shown.map((a) => (
        <span key={a.id} className={`face state-${a.effective_state}`} title={`@${a.id} · ${a.effective_state}${a.status.title ? ` · ${displayStoredText(a.status.title)}` : ""}`}>
          <Avatar handle={a.handle} name={a.agent} size={20} agent />
        </span>
      ))}
      {agents.length > max && <span className="faces-more tnum">+{agents.length - max}</span>}
    </span>
  );
}

function ProjectRow({ p, agents, cards, complete, loading }: { p: ProjectView; agents: AgentView[] | undefined; cards: readonly CardView[]; complete: boolean; loading: boolean }) {
  const [settings, setSettings] = useState(false);
  return (
    <li className="project-item">
      <a className="project-row" href={hrefFor({ view: "projects", channel: p.channel })}>
        <span className="project-prefix" style={hueVar("--th", tagHue(p.prefix))}><FolderKanban size={19} aria-hidden="true" /></span>
        <span className="project-main">
          <span className="project-name">
            {p.name} <span className="project-key mono">{p.prefix}</span>
            {p.private && <Lock size={12} strokeWidth={2} aria-label="Private: the team's owners" className="project-lock" />}
            {p.state !== "active" && <span className="chip">{p.state}</span>}
          </span>
          {loading ? <span className="skeleton project-count-skeleton" aria-label="Loading project counts" />
            : <span className="project-sub muted">{projectProgressSummary(p, cards, complete)}</span>}
        </span>
        <span className="project-faces"><AgentFaces agents={agents} /></span>
        <Meter meter={p.meter} />
      </a>
      {/* Beside the link, not inside it: a control must not sit within another interactive element. */}
      <div className="project-report">
        <button type="button" className="btn btn-sm btn-icon" aria-label={`Settings for ${p.name}`} onClick={() => setSettings(true)}><Settings size={15} /></button>
        {/* The status page (PROJECT-PAGES-1) exists for a project whose hourly report is on; with it off nothing new shows. */}
        {reportMode(p) === "hourly" && p.state === "active" && (
          <a className="project-page-link" href={hrefFor({ view: "projects", channel: p.channel, page: true })}>Status page</a>
        )}
      </div>
      {settings && <ProjectSettings project={p} onClose={() => setSettings(false)} />}
    </li>
  );
}

export function ProjectList() {
  const s = useProjects();
  const { agents } = useStore();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLSpanElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const needs = useHomeNeeds();
  const live = s.projects.filter((p) => p.state !== "deleted");
  const who = useMemo(() => presence(agents, live, () => true).byProject, [agents, live]);
  const groups = byFolder(live);
  const working = [...who.values()].reduce((n, a) => n + a.length, 0);
  useEffect(() => {
    if (!more) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") { setMore(false); moreButtonRef.current?.focus(); }
      else if (event instanceof MouseEvent && !moreRef.current?.contains(event.target as Node)) setMore(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [more]);

  return (
    <div className="page page-wide">
      <PageHeader
        title="Projects"
        meta={s.status === "ready" ? `${live.length} project${live.length === 1 ? "" : "s"}${working ? ` · ${working} agent${working === 1 ? "" : "s"} on them now` : ""}` : undefined}
        actions={<>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Plus size={14} strokeWidth={2} />New project</button>
          <span className="menu-wrap" ref={moreRef}><button ref={moreButtonRef} type="button" className="btn btn-sm btn-icon" aria-label="More project actions" aria-expanded={more} onClick={() => setMore((value) => !value)}><MoreHorizontal size={17} /></button>
            {more && <span className="menu" role="menu"><button type="button" role="menuitem" className="menu-item" onClick={() => { setMore(false); setImporting(true); }}><Download size={14} />Import from Linear</button></span>}</span>
        </>}
      />
      {s.status === "error" ? (
        <ErrorState message={s.error ?? "Couldn't load projects."} onRetry={() => void projectsStore.refresh()} />
      ) : s.status !== "ready" ? (
        <SkeletonRows rows={4} />
      ) : !live.length && !s.stubs.length ? (
        <EmptyState icon={<FolderKanban size={22} strokeWidth={1.5} />} title="No projects yet">
          <p>A project is a shared board for cards, people, agents, and progress.</p>
          <p><button type="button" className="btn btn-sm" onClick={() => setImporting(true)}><Download size={14} strokeWidth={2} />Import from Linear</button></p>
        </EmptyState>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.folder || "(none)"} className="project-folder" aria-label={g.folder || "No folder"}>
              <h2 className="section-title">{g.folder || "No folder"}</h2>
              <ul className="project-list">
                {g.projects.map((p) => <ProjectRow key={p.channel} p={p} agents={who.get(p.channel)} cards={needs.projectCards} complete={!!needs.projectCardsComplete} loading={needs.projectCardsStatus === "loading"} />)}
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
