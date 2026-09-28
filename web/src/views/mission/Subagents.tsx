// Sub-agents under their session's card (WALKIE-MISSION-SUB-1): a session's sub-agents are rows of their own, listed
// right under the session. A sub-agent whose session isn't in the list (filtered out, or not reported) gets a card.
import { memo } from "react";
import type { AccountView, AgentView } from "../../api/types.ts";
import { StatePill } from "../../components/primitives.tsx";
import { ago, useNow } from "../../lib/time.ts";
import { subagentLabel } from "../../../../src/protocol/subagents.ts";
import { AgentCard } from "./AgentCard.tsx";

export interface AgentGroup { agent: AgentView; subs: AgentView[] }

/** The list with each sub-agent moved under its session (same machine); order otherwise kept. Pure. */
export function groupAgents(list: readonly AgentView[]): AgentGroup[] {
  const parents = new Set(list.filter((a) => !a.status.parent).map((a) => `${a.node}/${a.agent}`));
  const subs = new Map<string, AgentView[]>();
  for (const a of list) {
    const key = a.status.parent ? `${a.node}/${a.status.parent}` : null;
    if (!key || !parents.has(key)) continue;
    subs.set(key, [...(subs.get(key) ?? []), a]);
  }
  return list
    .filter((a) => !a.status.parent || !parents.has(`${a.node}/${a.status.parent}`))
    .map((a) => ({ agent: a, subs: a.status.parent ? [] : subs.get(`${a.node}/${a.agent}`) ?? [] }));
}

/** "a6d1c079" of "cc-11fd55.a6d1c079". */
export function shortSubName(a: AgentView): string {
  const p = a.status.parent;
  return p && a.agent.startsWith(`${p.slice(0, 39)}.`) ? a.agent.slice(Math.min(p.length, 39) + 1) : a.agent;
}

function SubagentRowImpl({ agent, onOpen }: { agent: AgentView; onOpen: (id: string) => void }) {
  const now = useNow();
  const s = agent.status;
  const title = s.title ?? subagentLabel(s.subagent_type);
  const seat = s.parent === "seats";
  return (
    <li>
      <button
        type="button"
        className={`subagent-row is-${agent.effective_state}`}
        onClick={() => onOpen(agent.id)}
        aria-label={`${seat ? "Seat" : "Sub-agent"} ${agent.agent} of ${s.parent ?? ""}: ${agent.effective_state}. ${title}`}
        data-testid={`subagent-${agent.agent}`}
      >
        <span className="subagent-line">
          <StatePill state={agent.effective_state} compact />
          <span className="subagent-title truncate" title={title}>{title}</span>
          <span className="subagent-time tnum muted">{ago(agent.updated_at, now)}</span>
        </span>
        <span className="subagent-meta mono truncate">
          <span>{shortSubName(agent)}</span>
          {seat && <span> · {s.runtime}{s.model ? ` · ${s.model}` : ""}{s.launcher ? ` · @${s.launcher}` : ""}</span>}
          {s.title && s.subagent_type && <span> · {s.subagent_type}</span>}
          {s.activity && <span> · {s.activity}</span>}
        </span>
      </button>
    </li>
  );
}

const SubagentRow = memo(SubagentRowImpl);

/** A session's card with its sub-agents listed under it (or a plain card when it has none shown). */
export function AgentGroupView({ group, account, onOpen }: { group: AgentGroup; account?: AccountView; onOpen: (id: string) => void }) {
  const { agent, subs } = group;
  if (!subs.length) return <AgentCard agent={agent} account={account} onOpen={onOpen} />;
  return (
    <div className="agent-group" data-testid={`agent-group-${agent.agent}`}>
      <AgentCard agent={agent} account={account} onOpen={onOpen} />
      <ul className="subagent-list" aria-label={`${agent.agent === "seats" ? "Seats" : "Sub-agents"} of ${agent.agent}`}>
        {subs.map((s) => <SubagentRow key={s.id} agent={s} onOpen={onOpen} />)}
      </ul>
    </div>
  );
}
