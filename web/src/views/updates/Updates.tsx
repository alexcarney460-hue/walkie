// The Updates page (UPDATES-1): the latest plain-English status report of every project whose hourly report is on, on one
// page near the top of the navigation, so the team's partners find them without opening each project. It only reads: the
// project list (GET /v1/projects) and each project's latest report (GET /v1/projects/:channel/status-report), the same
// reads the project page's report panel makes. Talkie writes the reports (PROJECT-REPORTS-1). The one write is the
// picker's (ReportPicker, WALK-121): the switch that turns a project's hourly report on, as on the Projects list.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Newspaper } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { ProjectView } from "../../api/types.ts";
import { PageHeader } from "../../components/Shell.tsx";
import { EmptyState, ErrorState, RelTime, SkeletonRows, hueVar } from "../../components/primitives.tsx";
import { tagHue } from "../../lib/format.ts";
import { RichMarkdown } from "../../lib/markdown-rich.tsx";
import { hrefFor } from "../../lib/route.ts";
import { READ_CONCURRENCY, eachLimited, orderUpdates, reportedProjects, type UpdateEntry } from "../../lib/updates.ts";
import { projectsStore, useProjects } from "../../state/projects.ts";
import { ReportPicker } from "./ReportPicker.tsx";

/** A new report arrives as an ordinary post, which no stream announces: the page looks again now and then (as the panel does). */
const REFRESH_MS = 120_000;

const ABOUT = "Talkie writes each one in plain English, each hour something changes in the project: how it is going, what is done, what is in progress and who has it, what is blocked, and what is next.";

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
            : <p className="update-empty">No update yet. Talkie writes the first one within the hour after something changes in the project.</p>}
      <p className="update-links">
        <a href={hrefFor({ view: "projects", channel: project.channel, page: true })}>Status page</a>
        <a href={hrefFor({ view: "projects", channel: project.channel })}>Board</a>
      </p>
    </article>
  );
}

/**
 * The page's body for a loaded project list: the reported projects' cards, newest report first, then the picker that turns
 * a project's hourly update on (open and explained while none is on; counting them once some are).
 */
export function UpdatesView({ projects, entries, onRetry }: { projects: readonly ProjectView[]; entries: Readonly<Record<string, UpdateEntry>>; onRetry: (channel: string) => void }) {
  const reported = orderUpdates(reportedProjects(projects), entries);
  // The picker's open state and filter text live here so they survive the page changing shape under a person who is ticking.
  const [open, setOpen] = useState(() => reported.length === 0);
  const [query, setQuery] = useState("");
  // With nothing on, the picker is the way forward: it opens again when the last project is switched off.
  const none = reported.length === 0;
  useEffect(() => { if (none) setOpen(true); }, [none]);
  // The picker is the second child of this fragment in both shapes of the page, so React keeps it (and its checkboxes) mounted.
  return (
    <>
      {reported.length ? (
        <>
          <p className="updates-lead">{ABOUT}</p>
          <div className="update-list">
            {reported.map((p) => <UpdateCard key={p.channel} project={p} entry={entries[p.channel]} onRetry={() => onRetry(p.channel)} />)}
          </div>
        </>
      ) : (
        <EmptyState icon={<Newspaper size={22} strokeWidth={1.5} />} title="No project updates yet">
          <p>Turn on a project's hourly status report and its update appears here. {ABOUT}</p>
        </EmptyState>
      )}
      <ReportPicker projects={projects} open={open} onOpenChange={setOpen} query={query} onQuery={setQuery} />
    </>
  );
}

export function Updates() {
  const s = useProjects();
  const [entries, setEntries] = useState<Record<string, UpdateEntry>>({});
  const alive = useRef(true);
  // The channels reported right now: a response for a project no longer in it is dropped, not stored.
  const reported = useRef<ReadonlySet<string>>(new Set());
  const requestGeneration = useRef(0);
  useEffect(() => {
    alive.current = true;
    void projectsStore.refresh();
    return () => { alive.current = false; };
  }, []);

  const live = useMemo(() => s.projects.filter((p) => p.state !== "deleted"), [s.projects]);
  const channelsKey = useMemo(() => reportedProjects(live).map((p) => p.channel).sort().join(","), [live]);

  const loadOne = useCallback(async (channel: string, generation: number) => {
    try {
      const data = await api.statusReport(channel);
      if (alive.current && requestGeneration.current === generation && reported.current.has(channel)) setEntries((e) => ({ ...e, [channel]: { status: "ready", data } }));
    } catch (err) {
      // A failed refresh keeps the report already shown; only a project with nothing yet shows the failure.
      if (alive.current && requestGeneration.current === generation && reported.current.has(channel)) setEntries((e) => (e[channel]?.status === "ready" ? e : { ...e, [channel]: { status: "error", message: friendlyError(err) } }));
    }
  }, []);

  useEffect(() => {
    // A report is kept only for a project still reported: an evicted one's text must not reappear on re-admission.
    const keep = new Set(channelsKey ? channelsKey.split(",") : []);
    reported.current = keep;
    setEntries((e) => {
      const next = Object.fromEntries(Object.entries(e).filter(([channel]) => keep.has(channel)));
      return Object.keys(next).length === Object.keys(e).length ? e : next;
    });
    if (!channelsKey) return;
    const channels = channelsKey.split(",");
    // One pass at a time (a slow daemon can take longer than the interval), and a pass stops reading when the page is
    // left or the reported projects change: it starts no further read.
    let cancelled = false;
    let running = false;
    const generation = requestGeneration.current;
    const run = () => {
      if (running) return;
      running = true;
      void eachLimited(channels, READ_CONCURRENCY, (ch) => (cancelled ? Promise.resolve() : loadOne(ch, generation))).finally(() => { running = false; });
    };
    run();
    const timer = setInterval(run, REFRESH_MS);
    return () => { cancelled = true; requestGeneration.current++; clearInterval(timer); };
  }, [channelsKey, loadOne]);

  const retry = useCallback((channel: string) => {
    setEntries((e) => ({ ...e, [channel]: { status: "loading" } }));
    void loadOne(channel, requestGeneration.current);
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
