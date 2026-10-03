// The Updates page (UPDATES-1): the latest plain-English status report of every project whose hourly report is on, on one
// page near the top of the navigation, so the team's partners find them without opening each project. It only reads: the
// project list (GET /v1/projects) and each project's latest report (GET /v1/projects/:channel/status-report), the same
// reads the project page's report panel makes. WalkieTalkie writes the reports (PROJECT-REPORTS-1).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Newspaper } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { ProjectView } from "../../api/types.ts";
import { PageHeader } from "../../components/Shell.tsx";
import { EmptyState, ErrorState, RelTime, SkeletonRows, hueVar } from "../../components/primitives.tsx";
import { tagHue } from "../../lib/format.ts";
import { RichMarkdown } from "../../lib/markdown-rich.tsx";
import { hrefFor } from "../../lib/route.ts";
import { READ_CONCURRENCY, eachLimited, orderUpdates, reportedProjects, unreportedProjects, type UpdateEntry } from "../../lib/updates.ts";
import { projectsStore, useProjects } from "../../state/projects.ts";

/** A new report arrives as an ordinary post, which no stream announces: the page looks again now and then (as the panel does). */
const REFRESH_MS = 120_000;

const ABOUT = "WalkieTalkie writes each one in plain English, each hour something changes in the project: how it is going, what is done, what is in progress and who has it, what is blocked, and what is next.";

export function UpdateCard({ project, entry, onRetry }: { project: ProjectView; entry: UpdateEntry | undefined; onRetry: () => void }) {
  const titleId = `update-${project.channel}`;
  const report = entry?.status === "ready" ? entry.data.report : null;
  return (
    <article className="update" aria-labelledby={titleId}>
      <header className="update-head">
        <span className="project-prefix mono" style={hueVar("--th", tagHue(project.prefix))}>{project.prefix}</span>
        <h2 id={titleId} className="update-title">
          {project.folder && <span className="update-folder">{project.folder} · </span>}
          {project.name}
        </h2>
        {report && <span className="update-meta">as of <RelTime ts={report.as_of} long /></span>}
      </header>
      {!entry || entry.status === "loading" ? <SkeletonRows rows={2} />
        : entry.status === "error" ? <ErrorState compact message={entry.message} onRetry={onRetry} />
          : report ? <div className="update-body"><RichMarkdown text={report.markdown} /></div>
            : <p className="update-empty">No update yet. WalkieTalkie writes the first one within the hour after something changes in the project.</p>}
      <p className="update-links">
        <a href={hrefFor({ view: "projects", channel: project.channel, page: true })}>Status page</a>
        <a href={hrefFor({ view: "projects", channel: project.channel })}>Board</a>
      </p>
    </article>
  );
}

function NotReported({ projects }: { projects: readonly ProjectView[] }) {
  if (!projects.length) return null;
  return (
    <details className="updates-off">
      <summary>{projects.length} other project{projects.length === 1 ? " has" : "s have"} no hourly update</summary>
      <p className="muted">The project's creator or an owner turns its hourly status report on from the <a href={hrefFor({ view: "projects" })}>Projects list</a>.</p>
      <ul>
        {projects.map((p) => <li key={p.channel}><a href={hrefFor({ view: "projects", channel: p.channel })}>{p.folder ? `${p.folder} · ` : ""}{p.name}</a></li>)}
      </ul>
    </details>
  );
}

/** The page's body for a loaded project list: the reported projects' cards, newest report first, then the others named. */
export function UpdatesView({ projects, entries, onRetry }: { projects: readonly ProjectView[]; entries: Readonly<Record<string, UpdateEntry>>; onRetry: (channel: string) => void }) {
  const reported = orderUpdates(reportedProjects(projects), entries);
  const others = unreportedProjects(projects);
  if (!reported.length) {
    const example = others[0]?.prefix ?? "WEB";
    return (
      <EmptyState icon={<Newspaper size={22} strokeWidth={1.5} />} title="No project updates yet" command={`walkie projects report ${example} on`}>
        <p>Turn on a project's hourly status report and its update appears here. {ABOUT}</p>
        <p>The project's creator or an owner turns it on from the <a href={hrefFor({ view: "projects" })}>Projects list</a> (the Hourly status report switch).</p>
      </EmptyState>
    );
  }
  return (
    <>
      <p className="updates-lead">{ABOUT}</p>
      <div className="update-list">
        {reported.map((p) => <UpdateCard key={p.channel} project={p} entry={entries[p.channel]} onRetry={() => onRetry(p.channel)} />)}
      </div>
      <NotReported projects={others} />
    </>
  );
}

export function Updates() {
  const s = useProjects();
  const [entries, setEntries] = useState<Record<string, UpdateEntry>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void projectsStore.refresh();
    return () => { alive.current = false; };
  }, []);

  const live = useMemo(() => s.projects.filter((p) => p.state !== "deleted"), [s.projects]);
  const channelsKey = useMemo(() => reportedProjects(live).map((p) => p.channel).sort().join(","), [live]);

  const loadOne = useCallback(async (channel: string) => {
    try {
      const data = await api.statusReport(channel);
      if (alive.current) setEntries((e) => ({ ...e, [channel]: { status: "ready", data } }));
    } catch (err) {
      // A failed refresh keeps the report already shown; only a project with nothing yet shows the failure.
      if (alive.current) setEntries((e) => (e[channel]?.status === "ready" ? e : { ...e, [channel]: { status: "error", message: friendlyError(err) } }));
    }
  }, []);

  useEffect(() => {
    if (!channelsKey) return;
    const channels = channelsKey.split(",");
    // One pass at a time (a slow daemon can take longer than the interval), and a pass stops reading when the page is
    // left or the reported projects change: it starts no further read.
    let cancelled = false;
    let running = false;
    const run = () => {
      if (running) return;
      running = true;
      void eachLimited(channels, READ_CONCURRENCY, (ch) => (cancelled ? Promise.resolve() : loadOne(ch))).finally(() => { running = false; });
    };
    run();
    const timer = setInterval(run, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [channelsKey, loadOne]);

  const retry = useCallback((channel: string) => {
    setEntries((e) => ({ ...e, [channel]: { status: "loading" } }));
    void loadOne(channel);
  }, [loadOne]);

  const count = channelsKey ? channelsKey.split(",").length : 0;
  return (
    <div className="page page-wide updates">
      <PageHeader title="Updates" meta={s.status === "ready" ? `Plain-English status reports · ${count} project${count === 1 ? "" : "s"} reported hourly` : undefined} />
      {s.status === "error" ? <ErrorState message={s.error ?? "Couldn't load projects."} onRetry={() => void projectsStore.refresh()} />
        : s.status !== "ready" ? <SkeletonRows rows={4} />
          : <UpdatesView projects={live} entries={entries} onRetry={retry} />}
    </div>
  );
}
