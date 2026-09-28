import { memo } from "react";
import { Clock, FolderKanban, GitBranch, Workflow } from "lucide-react";
import type { AccountView, AgentView } from "../../api/types.ts";
import { AccountChip } from "../../components/Accounts.tsx";
import { RuntimeBadge, StatePill } from "../../components/primitives.tsx";
import { TaskChip } from "../../components/TaskChip.tsx";
import { STATE_LABEL } from "../../lib/format.ts";
import { ago, duration, elapsed, useNow } from "../../lib/time.ts";
import { subagentLabel, subagentsText } from "../../../../src/protocol/subagents.ts";
import { associate } from "../../../../src/protocol/projects/assoc.ts";
import { useProjects } from "../../state/projects.ts";
import { agentDisplayName, ORCHESTRATOR_AGENT } from "../../../../src/protocol/orchestrator.ts";
import { modelLabel } from "../orchestrator/model.ts";

/** The project (and card) this agent works on, from its status (WALKIE-PROJECTS-1). */
function ProjectChip({ agent }: { agent: AgentView }) {
  const { projects } = useProjects();
  const hit = projects.length ? associate(agent.status, projects, () => true) : null;
  const p = hit ? projects.find((x) => x.channel === hit.channel) : undefined;
  if (!p || !hit) return null;
  return (
    <span className="chip project-chip" title={`Project ${p.name}${hit.key ? `, card ${hit.key}` : ""}`}>
      <FolderKanban size={11} strokeWidth={1.75} aria-hidden="true" />
      <span className="truncate">{hit.key ?? p.name}</span>
    </span>
  );
}

function AgentCardImpl({ agent, account, onOpen }: { agent: AgentView; account?: AccountView; onOpen: (id: string) => void }) {
  const now = useNow();
  const s = agent.status;
  const state = agent.effective_state;
  const running = s.started_at ? duration(now - s.started_at) : null;
  // How long the current line has been true ("Running a command · 8m"), ticking: a long command visibly alive. An older
  // daemon sends no start: the last update is the best known.
  const lineSince = agent.activity_since ?? agent.updated_at;
  const stateSince = agent.state_since ?? agent.updated_at;
  const repo = s.repo ? `${s.repo}${s.branch ? `@${s.branch}` : ""}` : null;
  const subs = subagentsText(agent.subagents?.working ?? 0);
  return (
    <button
      type="button"
      className={`agent-card is-${state}`}
      onClick={() => onOpen(agent.id)}
      aria-label={`${agentDisplayName(agent.agent)} on ${agent.hostname}: ${state}. ${s.title ?? ""}`}
    >
      <span className="agent-card-top">
        <span className="agent-name mono truncate">{agentDisplayName(agent.agent)}</span>
        <RuntimeBadge runtime={s.runtime} runtime_name={s.runtime_name} launch={s.launch} />
        {agent.agent === ORCHESTRATOR_AGENT && s.model && <span className="agent-model mono truncate" data-testid="orchestrator-model" title={s.model}>{modelLabel(s.model)}</span>}
        {account && <AccountChip account={account} now={now} />}
        <span className="agent-card-spacer" />
        <StatePill state={state} />
      </span>
      <span className="agent-title">{s.title ?? (s.parent ? subagentLabel(s.subagent_type) : <span className="muted">No status title</span>)}</span>
      {s.parent && <span className="agent-parent mono truncate muted">sub-agent of {s.parent}</span>}
      {subs && (
        <span className="agent-subs" data-testid={`subagents-${agent.agent}`}>
          <Workflow size={11} strokeWidth={1.75} aria-hidden="true" />
          <span className="tnum">{subs}</span>
        </span>
      )}
      {(s.task || repo) && (
        <span className="agent-meta">
          <ProjectChip agent={agent} />
          {s.task && <TaskChip task={s.task} />}
          {repo && (
            <span className="agent-repo mono truncate" title={repo}>
              <GitBranch size={11} strokeWidth={1.75} aria-hidden="true" />
              <span className="truncate">{repo}</span>
            </span>
          )}
        </span>
      )}
      <span className="agent-foot">
        <span className="agent-activity mono truncate" title={s.activity}>{s.activity ?? "No activity yet"}</span>
        <span className="agent-foot-time tnum" title={`For ${elapsed(now - lineSince)} (${STATE_LABEL[state]} for ${elapsed(now - stateSince)}; last update ${ago(agent.updated_at, now)} ago)`} data-testid="time-in-state">
          <span aria-hidden="true">· </span>for {elapsed(now - lineSince)}
        </span>
        {running && state !== "offline" && state !== "idle" && (
          <span className="agent-foot-run tnum" title="How long this session has run">
            <Clock size={11} strokeWidth={1.75} aria-hidden="true" />
            session {running}
          </span>
        )}
      </span>
    </button>
  );
}

export const AgentCard = memo(AgentCardImpl);
