import { memo } from "react";
import { CircleHelp, ExternalLink, FileCode2, FileJson, FileText, File as FileIcon, MessageSquareText } from "lucide-react";
import type { ArtifactBody, AskView, Event } from "../../api/types.ts";
import { AskAnswer } from "../../components/AskAnswer.tsx";
import { AuthorAvatar, AuthorName } from "../../components/Author.tsx";
import { DownloadButton } from "../../components/DownloadButton.tsx";
import { Avatar, RelTime } from "../../components/primitives.tsx";
import { askBody, bytes, canAnswer, displayName, effectiveAskState, mimeKind } from "../../lib/format.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { SOURCES, sourceLink, sourceOf } from "../../lib/sources.ts";
import { clock, countdown, fullTime, useNow } from "../../lib/time.ts";
import { useStore } from "../../state/store.tsx";
import { useMdOpts } from "../../state/useMdOpts.ts";
import type { ThreadSummary } from "./useFeed.ts";

const FILE_ICON = { code: FileCode2, data: FileJson, text: FileText, image: FileIcon, archive: FileIcon, file: FileIcon };

export function ArtifactRow({ body }: { body: ArtifactBody }) {
  const Icon = FILE_ICON[mimeKind(body.mime, body.name)];
  return (
    <div className="artifact">
      <span className="artifact-icon" aria-hidden="true"><Icon size={16} strokeWidth={1.6} /></span>
      <div className="artifact-text">
        <span className="artifact-name mono truncate">{body.name}</span>
        <span className="artifact-meta tnum">{bytes(body.size)} · {body.mime}</span>
      </div>
      <DownloadButton hash={body.hash} name={body.name} labelClass="artifact-dl-label" />
    </div>
  );
}

const ASK_STATE_LABEL = { open: "Open", answered: "Answered", declined: "Declined", expired: "Expired" };

export function AskCard({ view }: { view: AskView }) {
  const { me, agents, team } = useStore();
  const md = useMdOpts();
  const now = useNow();
  const body = askBody(view.ask);
  const state = effectiveAskState(view, now);
  const left = body.expires_at - now;
  const answer = view.answers[0];
  const actionable = canAnswer(view, me?.handle ?? null, agents, now) && me?.role !== "observer";
  return (
    <div className={`ask-card is-${state}`}>
      <div className="ask-card-head">
        <CircleHelp size={14} strokeWidth={1.75} aria-hidden="true" className="ask-icon" />
        <span className="ask-to">Ask to <span className="mono">{body.to}</span></span>
        <span className={`ask-state is-${state}`}>{ASK_STATE_LABEL[state]}</span>
        {state === "open" && <span className={`ask-expiry tnum ${left < 5 * 60_000 ? "is-urgent" : ""}`} title={`Expires ${fullTime(body.expires_at)}`}>expires in {countdown(left)}</span>}
      </div>
      <Markdown text={body.text} opts={md} />
      {answer && (
        <div className="ask-answer">
          <AuthorAvatar author={answer.author} size={18} />
          <div className="ask-answer-body">
            <span className="ask-answer-who">
              {answer.author.agent ? <span className="mono">{answer.author.agent}</span> : displayName(team?.members, answer.author.handle)}
              <span className="muted"> {(answer.body as { declined?: boolean }).declined ? "declined" : "answered"} · {clock(answer.ts)}</span>
            </span>
            <Markdown text={String((answer.body as { text: string }).text)} opts={md} />
          </div>
        </div>
      )}
      {actionable && <AskAnswer view={view} />}
    </div>
  );
}

function ThreadLink({ summary, onOpen }: { summary: ThreadSummary; onOpen: () => void }) {
  const { team } = useStore();
  return (
    <button type="button" className="thread-link" onClick={onOpen}>
      <span className="thread-avatars" aria-hidden="true">
        {summary.authors.slice(0, 3).map((a, i) => (
          <Avatar key={i} handle={a.handle} name={displayName(team?.members, a.handle)} size={16} agent={!!a.agent} />
        ))}
      </span>
      <span className="thread-count">{summary.count} {summary.count === 1 ? "reply" : "replies"}</span>
      <span className="thread-last muted">last <RelTime ts={summary.lastTs} long /></span>
    </button>
  );
}

interface Props {
  event: Event;
  compact?: boolean; // same author as the previous message, within a few minutes
  thread?: ThreadSummary;
  onOpenThread?: (id: string) => void;
  active?: boolean;
}

function MessageItemImpl({ event, compact, thread, onOpenThread, active }: Props) {
  const { asks } = useStore();
  const md = useMdOpts();
  const openThread = () => onOpenThread?.(event.id);
  const isAgent = !!event.author.agent;
  const src = sourceOf(event);
  const link = src ? sourceLink(event) : null;
  const cls = ["msg", compact ? "is-compact" : "", isAgent ? "is-agent" : "is-human", src ? "is-integration" : "", active ? "is-active" : "", `kind-${event.kind.replace(".", "-")}`].join(" ");

  let content;
  if (event.kind === "ask") {
    const view = asks.find((a) => a.ask.id === event.id) ?? { ask: event, answers: [], state: "open" as const, expires_at: (event.body as { expires_at: number }).expires_at };
    content = <AskCard view={view} />;
  } else if (event.kind === "artifact.share") {
    const body = event.body as ArtifactBody;
    content = (
      <>
        {body.note && <Markdown text={body.note} opts={md} />}
        <ArtifactRow body={body} />
      </>
    );
  } else {
    content = <Markdown text={String((event.body as { text: string }).text)} opts={md} />;
  }

  return (
    <article className={cls} aria-label={`${event.author.agent ?? event.author.handle}, ${fullTime(event.ts)}`}>
      <div className="msg-gutter">
        {compact ? <time className="msg-gutter-time tnum" dateTime={new Date(event.ts).toISOString()}>{clock(event.ts)}</time> : <AuthorAvatar author={event.author} />}
      </div>
      <div className="msg-main">
        {!compact && (
          <header className="msg-head">
            <AuthorName author={event.author} />
            <time className="msg-time tnum" dateTime={new Date(event.ts).toISOString()} title={fullTime(event.ts)}>{clock(event.ts)}</time>
            {src && link && (
              <a className="msg-source-link" href={link} target="_blank" rel="noopener noreferrer">
                {SOURCES[src].linkLabel}
                <ExternalLink size={11} strokeWidth={1.75} aria-hidden="true" />
              </a>
            )}
            {onOpenThread && !thread?.count && event.kind !== "ask" && (
              <button type="button" className="msg-reply-inline" onClick={openThread}>Reply</button>
            )}
          </header>
        )}
        <div className="msg-body">{content}</div>
        {thread && thread.count > 0 && onOpenThread && <ThreadLink summary={thread} onOpen={openThread} />}
      </div>
      {onOpenThread && !thread?.count && event.kind !== "ask" && (
        <div className="msg-hover-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={openThread} aria-label="Reply in thread">
            <MessageSquareText size={14} strokeWidth={1.75} aria-hidden="true" />
            Reply
          </button>
        </div>
      )}
    </article>
  );
}

export const MessageItem = memo(MessageItemImpl);
