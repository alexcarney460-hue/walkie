import { ExternalLink } from "lucide-react";
import type { LinearIssueInfo } from "../api/types.ts";
import { useLinearIssue } from "../state/linear.ts";

function stateTone(info: LinearIssueInfo): string {
  if (info.state_type === "completed") return "is-done";
  if (info.state_type === "canceled") return "is-canceled";
  if (info.state_type === "started") return "is-started";
  return "";
}

/** Task chip for agent cards (inside a button, so never a link): key, plus the Linear state when known. */
export function TaskChip({ task }: { task: string }) {
  const info = useLinearIssue(task);
  return (
    <span className={`chip mono agent-task ${info ? `has-issue ${stateTone(info)}` : ""}`} title={info ? `${info.key} · ${info.state}: ${info.title}` : undefined}>
      {task}
      {info && <span className="task-state">{info.state}</span>}
    </span>
  );
}

/** Task line for the agent drawer: key linked to Linear, state and title. */
export function TaskDetail({ task }: { task: string }) {
  const info = useLinearIssue(task);
  if (!info) return <span className="mono">{task}</span>;
  return (
    <span className="task-detail">
      {info.url ? (
        <a className="mono task-link" href={info.url} target="_blank" rel="noopener noreferrer">
          {info.key}
          <ExternalLink size={11} strokeWidth={1.75} aria-hidden="true" />
          <span className="sr-only"> (opens Linear)</span>
        </a>
      ) : <span className="mono">{info.key}</span>}
      <span className={`task-state ${stateTone(info)}`}>{info.state}</span>
      <span className="task-title">{info.title}</span>
      {info.assignee && <span className="muted">· {info.assignee}</span>}
    </span>
  );
}
