import { AudioLines, Bot, ListTodo, NotebookPen } from "lucide-react";
import type { Event } from "../api/types.ts";
import { displayName, hostFor } from "../lib/format.ts";
import { SOURCES, sourceOf, type SourceId } from "../lib/sources.ts";
import { navigate, getRoute } from "../lib/route.ts";
import { useStore } from "../state/store.tsx";
import { Avatar } from "./primitives.tsx";

export const SOURCE_ICON: Record<SourceId, typeof Bot> = { fireflies: AudioLines, wispr: NotebookPen, linear: ListTodo };

/** Avatar for an event author. Agents get the owner's avatar with a bot corner mark; integrations their source icon. */
export function AuthorAvatar({ author, size = 28 }: { author: Event["author"]; size?: number }) {
  const { team } = useStore();
  const src = sourceOf({ author });
  if (src) {
    const Icon = SOURCE_ICON[src];
    return (
      <span className="source-avatar" data-source={src} style={{ width: size, height: size }} aria-hidden="true">
        <Icon size={Math.round(size * 0.55)} strokeWidth={1.75} />
      </span>
    );
  }
  const name = displayName(team?.members, author.handle);
  return (
    <span className="author-avatar">
      <Avatar handle={author.handle} name={name} size={size} agent={!!author.agent} />
      {author.agent && size >= 24 && (
        <span className="author-bot" aria-hidden="true">
          <Bot size={9} strokeWidth={2.25} />
        </span>
      )}
    </span>
  );
}

/** "Maren Okafor  [bot ux-seat · maren-mbp]": which person, and which of their agents. */
export function AuthorName({ author }: { author: Event["author"] }) {
  const { team, nodes } = useStore();
  const name = displayName(team?.members, author.handle);
  const host = hostFor(nodes, author.node);
  const src = sourceOf({ author });
  if (src) {
    return (
      <span className="author-line">
        <span className="author-source-name">{SOURCES[src].label}</span>
        <span className="source-badge" data-source={src} title={`Posted by the ${SOURCES[src].label} integration on ${name.split(" ")[0]}'s ${host ?? "machine"}`}>
          Integration
        </span>
        <span className="author-via muted">via {name.split(" ")[0]}{host ? ` · ${host}` : ""}</span>
      </span>
    );
  }
  if (!author.agent) return <span className="author-name">{name}</span>;
  const agentId = host ? `${author.handle}/${host}/${author.agent}` : undefined;
  return (
    <span className="author-line">
      <span className="author-agent-name mono">{author.agent}</span>
      <button
        type="button"
        className="author-agent"
        title={agentId ? `Open ${agentId}` : undefined}
        onClick={() => agentId && navigate({ ...getRoute(), agent: agentId })}
        disabled={!agentId}
      >
        <Bot size={11} strokeWidth={2} aria-hidden="true" />
        <span>{name.split(" ")[0]}'s agent{host ? ` on ${host}` : ""}</span>
      </button>
    </span>
  );
}
