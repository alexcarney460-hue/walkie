import { useEffect, useMemo, useState } from "react";
import { Check, CircleHelp, CirclePause, FolderKanban, Lightbulb, LogIn, Server } from "lucide-react";
import { api } from "../../api/client.ts";
import { AskAnswer } from "../../components/AskAnswer.tsx";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { RelTime, SkeletonRows, StatePill } from "../../components/primitives.tsx";
import { askBody, askExpiresAt, displayName } from "../../lib/format.ts";
import { byFolder } from "../../lib/projects.ts";
import { projectProgressSummary } from "../../lib/project-summary.ts";
import { hrefFor, navigate } from "../../lib/route.ts";
import { cardRole, statusName } from "../../lib/simple-board.ts";
import { reportMode } from "../../lib/status-report.ts";
import { countdown, useNow } from "../../lib/time.ts";
import { projectsStore, useProjects } from "../../state/projects.ts";
import { useStore } from "../../state/store.tsx";
import { displayStoredText } from "../../../../src/protocol/display-text.ts";
import { PROVIDER_NAME } from "../../../../src/protocol/accounts-format.ts";
import { CreateProject } from "../projects/CreateProject.tsx";
import { Meter } from "../projects/Meter.tsx";
import { useHomeNeeds } from "./needs.tsx";
import type { AccountView, AgentView, AskView, CardView, PendingJoin, ProjectView, Recommendation } from "../../api/types.ts";

type NeedRow =
  | { key: string; resetKey: unknown; kind: "ask"; ask: AskView }
  | { key: string; resetKey: unknown; kind: "agent"; agent: AgentView }
  | { key: string; resetKey: unknown; kind: "card"; card: CardView }
  | { key: string; resetKey: unknown; kind: "rec"; rec: Recommendation }
  | { key: string; resetKey: unknown; kind: "join"; node: PendingJoin }
  | { key: string; resetKey: unknown; kind: "login"; account: AccountView; hostname: string };

function ProjectReportLine({ channel }: { channel: string }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; line?: string }>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void api.statusReport(channel).then((result) => {
      if (cancelled) return;
      const line = result.report?.markdown.replace(/^#+[^\n]*\n/, "").trim().split(/(?<=[.!?])\s|\n/)[0]?.trim();
      setState({ status: "ready", line });
    }).catch(() => { if (!cancelled) setState({ status: "error" }); });
    return () => { cancelled = true; };
  }, [channel, attempt]);
  if (state.status === "loading") return <p className="home-project-report muted">Checking latest update…</p>;
  if (state.status === "error") return <p className="home-project-report muted">Couldn't load the latest update · <button type="button" onClick={() => setAttempt((n) => n + 1)}>Retry</button></p>;
  return state.line ? <p className="home-project-report muted">{state.line}</p> : null;
}

function NeedContent({ row, projects, now }: { row: NeedRow; projects: readonly ProjectView[]; now: number }) {
  const { team } = useStore();
  if (row.kind === "ask") {
    const { ask } = row;
    return <li className="home-need">
      <span className="home-need-leading"><CircleHelp size={19} aria-hidden="true" /></span>
      <div className="home-need-copy"><span className="home-need-identity"><strong>{ask.ask.author.agent ?? displayName(team?.members, ask.ask.author.handle)}</strong>
        {ask.ask.author.agent && <span className="muted"> · {displayName(team?.members, ask.ask.author.handle).split(" ")[0]}'s agent</span>}</span>
        <span className="truncate">{displayStoredText(askBody(ask.ask).text).split("\n")[0]}</span>
        <small className="muted">{countdown(askExpiresAt(ask) - now)} left</small>
      </div><div className="home-need-action"><AskAnswer view={ask} /></div>
    </li>;
  }
  if (row.kind === "agent") {
    const { agent } = row;
    return <li className="home-need">
      <span className="home-need-leading"><CirclePause size={19} aria-hidden="true" /></span>
      <span className="home-need-copy"><span className="home-need-identity is-agent" title={`@${agent.handle}/${agent.hostname}/${agent.agent}`}><strong>{agent.agent}</strong><span className="muted"> · {displayName(team?.members, agent.handle).split(" ")[0]}'s agent</span> <StatePill state={agent.effective_state} /></span>
        <span className="truncate">{agent.status.title ? displayStoredText(agent.status.title) : "Waiting for help"}</span>
        <small className="muted"><RelTime ts={agent.updated_at} /></small></span>
      <button type="button" className="btn btn-sm home-need-action" onClick={() => navigate({ view: "home", agent: agent.id })}>Open</button>
    </li>;
  }
  if (row.kind === "card") {
    const { card } = row;
    return <li className="home-need">
      <span className="home-need-leading"><FolderKanban size={19} aria-hidden="true" /></span>
      <span className="home-need-copy"><span className="home-need-identity"><strong>{card.key} · {displayStoredText(card.title)}</strong></span>
        <span className="muted">{projects.find((project) => project.channel === card.channel)?.name ?? "Project"} · {statusName(cardRole(card, projects))}</span>
        <small className="muted"><RelTime ts={card.updated_at} /></small></span>
      <a className="btn btn-sm home-need-action" href={hrefFor({ view: "projects", channel: card.channel, card: card.id })}>Open</a>
    </li>;
  }
  if (row.kind === "rec") return <li className="home-need">
    <span className="home-need-leading"><Lightbulb size={19} aria-hidden="true" /></span>
    <span className="home-need-copy"><span className="home-need-identity"><strong>Talkie suggestion</strong></span><span className="truncate">{displayStoredText(row.rec.summary)}</span>
      <small className="muted">Waiting for review</small></span>
    <a className="btn btn-sm home-need-action" href={hrefFor({ view: "orchestrator", tab: `rec-${row.rec.id}` })}>Review</a>
  </li>;
  if (row.kind === "join") return <li className="home-need">
    <span className="home-need-leading"><Server size={19} aria-hidden="true" /></span>
    <span className="home-need-copy"><span className="home-need-identity"><strong>{row.node.hostname}</strong></span><span>Waiting to join · {row.node.handle ?? row.node.login}</span>
      <small className="muted"><RelTime ts={row.node.requested_at} /></small></span>
    <a className="btn btn-sm home-need-action" href={hrefFor({ view: "team" })}>Review</a>
  </li>;
  return <li className="home-need">
    <span className="home-need-leading"><LogIn size={19} aria-hidden="true" /></span>
    <span className="home-need-copy"><span className="home-need-identity"><strong>{PROVIDER_NAME[row.account.provider]} login</strong></span>
      <span>On {row.hostname} · needs signing in again</span><small className="muted">Needs you now</small></span>
    <a className="btn btn-sm home-need-action" href={hrefFor({ view: "accounts" })}>How</a>
  </li>;
}

/** The top of Home: what needs the person, then each project's progress. The live agent view follows it (MissionControl home). */
export function HomeTop() {
  const store = useStore();
  const needs = useHomeNeeds();
  const projectState = useProjects();
  const now = useNow();
  const [showAll, setShowAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const projects = useMemo(() => byFolder(projectState.projects.filter((project) => project.state === "active"))
    .flatMap((group) => group.projects), [projectState.projects]);

  const rows: NeedRow[] = [
    ...needs.asks.map((ask) => ({ key: `ask-${ask?.ask?.id}`, resetKey: ask, kind: "ask" as const, ask })),
    ...needs.agents.map((agent) => ({ key: `agent-${agent.id}`, resetKey: agent, kind: "agent" as const, agent })),
    ...needs.cards.map((card) => ({ key: `card-${card.id}`, resetKey: card, kind: "card" as const, card })),
    ...needs.recommendations.map((rec) => ({ key: `rec-${rec.id}`, resetKey: rec, kind: "rec" as const, rec })),
    ...needs.pending.map((node) => ({ key: `join-${node.node_id}`, resetKey: node, kind: "join" as const, node })),
    ...needs.logins.map(({ account, hostname }) => ({ key: `login-${account.key}-${hostname}`, resetKey: account, kind: "login" as const, account, hostname })),
  ];
  const cap = 5;
  const shown = showAll ? rows : rows.slice(0, cap);

  return <div className="home-top">
    <ErrorBoundary scope="item" name="Needs you" resetKeys={[needs.count]}>
      <section className="home-section" aria-labelledby="home-needs-title"><h2 id="home-needs-title">Needs you</h2>
        {needs.cardsError && <p role="alert">Couldn't load cards. <button type="button" onClick={needs.retryCards}>Retry</button></p>}
        {store.me?.role === "owner" && needs.pendingStatus === "error" && <p role="alert">Couldn't check machines waiting to join. <button type="button" onClick={needs.retryPending}>Retry</button></p>}
        {rows.length ? <ul className="home-needs">{shown.map((row) => <ErrorBoundary key={row.key} scope="item" as="li" name={row.key} resetKeys={[row.resetKey]}>
          <NeedContent row={row} projects={projects} now={now} />
        </ErrorBoundary>)}</ul> : needs.cardsLoading || store.me?.role === "owner" && needs.pendingStatus === "loading" ? <SkeletonRows rows={2} />
          : needs.cardsError || store.me?.role === "owner" && needs.pendingStatus === "error" ? null
          : <p className="home-empty"><Check size={17} aria-hidden="true" /> Nothing needs you right now.</p>}
        {rows.length > cap && <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>{showAll ? "Show less" : `Show all (${rows.length})`}</button>}
        <a href={hrefFor({ view: "asks" })}>See all asks</a>
      </section>
    </ErrorBoundary>
    <ErrorBoundary scope="item" name="Projects" resetKeys={[projectState.status, projects]}>
      <section className="home-section" aria-labelledby="home-projects-title"><h2 id="home-projects-title">Projects</h2>
        {projectState.status === "error" ? <p role="alert">Could not load projects. <button type="button" onClick={() => void projectsStore.refresh()}>Retry</button></p>
          : projectState.status !== "ready" ? <SkeletonRows rows={2} />
          : projects.length ? <><ul className="home-projects">{projects.slice(0, 6).map((project) => <ErrorBoundary key={project.id} scope="item" as="li" name={project.name} resetKeys={[project]}>
            <li><a href={hrefFor({ view: "projects", channel: project.channel })}>
              <FolderKanban className="home-project-icon" size={19} aria-hidden="true" />
              <span className="home-project-main"><span><strong>{project.name}</strong> <span className="muted mono">{project.prefix}</span></span>
              <Meter meter={project.meter} />
              {needs.projectCardsStatus === "loading" ? <span className="skeleton project-count-skeleton" aria-label="Loading project counts" />
                : projectProgressSummary(project, needs.projectCards, !!needs.projectCardsComplete) && <span className="muted">{projectProgressSummary(project, needs.projectCards, !!needs.projectCardsComplete)}</span>}
              </span>
            </a>{reportMode(project) === "hourly" && <ProjectReportLine channel={project.channel} />}</li>
          </ErrorBoundary>)}</ul>{projects.length > 6 && <a href={hrefFor({ view: "projects" })}>All projects</a>}</>
          : <p>No projects yet. <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>New project</button></p>}
      </section>
    </ErrorBoundary>
    {creating && <CreateProject onClose={() => setCreating(false)} />}
  </div>;
}
