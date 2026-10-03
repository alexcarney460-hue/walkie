// A project's status page (PROJECT-PAGES-1): the page the project's non-technical teammates read. A headline and two plain
// sentences from WalkieTalkie's hourly report, a strip of facts (what the team and its agents set, then what Walkie counts
// itself), what is live and what lands next, and the project's screens grouped by who uses them. It is a view over what the
// daemon folds from the signed log (GET /v1/projects/:channel/page); the terminal and the agents write it, this page only reads.
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { ProjectView, StatusPagePayload } from "../../api/types.ts";
import { EmptyState, ErrorState, PlainTime, SkeletonRows } from "../../components/primitives.tsx";
import { factTiles, latestOnly, storyOutOfDate, storyOverdue } from "../../lib/status-page.ts";
import { fullTime } from "../../lib/time.ts";
import { usePageTick } from "../../state/projects.ts";
import { ScreensSection } from "./StatusPageScreens.tsx";

/** `refreshFailed`: the last look at the page failed, so what is shown is what the page said (`data.generated_at`) before that. */
export type StatusPageState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: StatusPagePayload; refreshFailed?: boolean };

/** The page is not announced by the board's own stream alone (a report is an ordinary post): it looks again now and then. */
const REFRESH_MS = 120_000;

const WAITING = "WalkieTalkie writes the headline and the two lists below each hour something changes in the project, so the first ones appear within the hour. The facts and the screens are live.";
/** Said instead of WAITING once reports have been on for over two hours, the project has cards, and still no story has come. */
const OVERDUE = "No summary has arrived yet. WalkieTalkie writes it within an hour of a change on the board, on the team's main machine (the one that keeps the member list), and that machine has to be running the latest Walkie to do it. If this stays empty, ask whoever looks after the team's Walkie to update it. The facts and the screens below are live.";

function RefreshNotice({ data, onRetry }: { data: StatusPagePayload; onRetry: () => void }) {
  return (
    <p className="spage-notice" role="status">
      We couldn't refresh this page just now, so it shows what it said <PlainTime ts={data.generated_at} />.{" "}
      <button type="button" className="btn btn-sm" onClick={onRetry}>Try again</button>
    </p>
  );
}

function List({ items }: { items: readonly string[] }) {
  return items.length ? <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="muted">Nothing listed yet.</p>;
}

function Facts({ facts }: { facts: StatusPagePayload["facts"] }) {
  const tiles = factTiles(facts);
  if (!tiles.length) return null;
  return (
    <section aria-label="Key facts">
      <dl className="spage-facts">
        {tiles.map((t) => (
          <div key={t.key} className="spage-fact">
            <dt>{t.label}</dt>
            <dd>
              {t.time !== undefined ? <PlainTime ts={t.time} /> : t.value}
              {t.by && <span className="spage-by" style={{ display: "block" }}> (set by {t.by})</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** `group`: the group of screens the address names, which the page scrolls to once it has them. */
export function StatusPageView({ project, state, group, onRetry }: { project: ProjectView; state: StatusPageState; group?: string | undefined; onRetry: () => void }) {
  if (state.status === "loading") return <section className="spage" aria-label="Status page" aria-busy="true"><SkeletonRows rows={4} /></section>;
  if (state.status === "error") return <section className="spage" aria-label="Status page"><ErrorState message={state.message} onRetry={onRetry} /></section>;
  const { data } = state;
  const refreshNotice = state.refreshFailed ? <RefreshNotice data={data} onRetry={onRetry} /> : null;
  if (data.mode !== "hourly") {
    return (
      <section className="spage" aria-label="Status page">
        {refreshNotice}
        <EmptyState icon={<FileText size={22} strokeWidth={1.5} />} title="The status page is off for this project" command={`walkie projects report ${project.prefix} on`}>
          <p>The page is written from the project's hourly status report. The project's creator or an owner turns it on from the Projects list (the Hourly status report switch).</p>
        </EmptyState>
      </section>
    );
  }
  const story = data.story;
  // The story is WalkieTalkie's and is only as new as its last report; the page's own "updated" time moves with any fact or screen.
  // It is flagged when the numbers beside it have moved on from the ones it was written against (lib/status-page.ts).
  const written = story && Number.isFinite(story.at) ? story.at : null;
  const outOfDate = story !== null && storyOutOfDate(story, data.facts.computed, data.generated_at);
  return (
    <article className="spage" aria-labelledby="spage-headline">
      {refreshNotice}
      <header className="spage-top">
        <p className="spage-eyebrow">{project.folder ? `${project.folder} · ` : ""}{project.name}</p>
        <h2 id="spage-headline" className="spage-headline">{story?.headline ?? project.name}</h2>
        <p className="spage-when">
          {data.updated_at !== null ? <>Page updated <PlainTime ts={data.updated_at} /></> : "Nothing added yet"}
          {written !== null && <> · Summary written by WalkieTalkie <PlainTime ts={written} /></>}
        </p>
        {outOfDate && written !== null && (
          <p className="spage-notice" role="note">
            This summary was written <PlainTime ts={written} />. The numbers on this page (blocked, in progress, in review) have changed since then, so parts of the summary may be out of date. The facts and numbers here are current.
          </p>
        )}
        <p className="spage-lede">{story?.lede ?? (storyOverdue(data.facts.computed, data.reports_since, data.generated_at) ? OVERDUE : WAITING)}</p>
        {data.state !== "active" && <p className="spage-notice" role="note">This project is {data.state}, so its status page is no longer updated.</p>}
        <Facts facts={data.facts} />
      </header>
      {story && (
        <div className="spage-cols">
          <section aria-labelledby="spage-live"><h3 id="spage-live">Live now</h3><List items={story.live_now} /></section>
          <section aria-labelledby="spage-next"><h3 id="spage-next">Landing next</h3><List items={story.landing_next} /></section>
        </div>
      )}
      <ScreensSection channel={project.channel} prefix={project.prefix} screens={data.screens} group={group} note={story?.screens_note} />
      <footer className="spage-foot">
        {data.updated_at !== null ? <p>Updated <time dateTime={new Date(data.updated_at).toISOString()}>{fullTime(data.updated_at)}</time>.</p> : <p>Nothing has been added to this page yet.</p>}
        <p>The headline and the two lists are written by WalkieTalkie each hour something changes in the project. The counts come from the project's board (cards marked confidential are never counted). The other facts and the screens are added by the team and its agents, who are named under each one.</p>
      </footer>
    </article>
  );
}

export function StatusPage({ project, group }: { project: ProjectView; group?: string | undefined }) {
  // Route identity owns all page state, including in-flight requests and screen dialogs.
  // A passive-effect reset would commit the previous report under the new project first.
  return <ProjectStatusPage key={project.channel} project={project} group={group} />;
}

function ProjectStatusPage({ project, group }: { project: ProjectView; group?: string | undefined }) {
  const channel = project.channel;
  const [state, setState] = useState<StatusPageState>({ status: "loading" });
  const tick = usePageTick(channel);
  const gate = useRef(latestOnly()).current;
  const load = useCallback(() => {
    gate.run(
      () => api.statusPage(channel),
      (data) => setState({ status: "ready", data }),
      // A page already showing keeps what it has, and says the last look failed; one with nothing yet shows the error.
      (err) => setState((s) => (s.status === "ready" ? (s.refreshFailed ? s : { ...s, refreshFailed: true }) : { status: "error", message: friendlyError(err) })),
    );
  }, [channel, gate]);
  useEffect(() => {
    setState({ status: "loading" });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { clearInterval(timer); gate.cancel(); }; // an answer for the project the page has left is never shown
  }, [channel, load, gate]);
  useEffect(() => { if (tick > 0) load(); }, [tick, load]);
  return <StatusPageView project={project} state={state} group={group} onRetry={() => { setState((s) => (s.status === "ready" ? s : { status: "loading" })); load(); }} />;
}
