import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Hash, Lock, MessagesSquare } from "lucide-react";
import type { ChannelView } from "../../api/types.ts";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { EmptyState, ErrorState, SkeletonRows } from "../../components/primitives.tsx";
import { hrefFor, navigate, useRoute } from "../../lib/route.ts";
import { unreadCount } from "../../state/reducer.ts";
import { useActions, useStore } from "../../state/store.tsx";
import { Composer } from "./Composer.tsx";
import { MessageItem } from "./MessageItem.tsx";
import { ThreadPanel } from "./ThreadPanel.tsx";
import { useChannelFeed } from "./useFeed.ts";

const GROUP_WINDOW_MS = 5 * 60_000;

function ChannelList({ channels, current }: { channels: ChannelView[]; current: string }) {
  const state = useStore();
  return (
    <nav className="channels" aria-label="Channels">
      <h2 className="channels-title">Channels</h2>
      <ul className="channels-list">
        {channels.map((c) => {
          const unread = c.name === current ? 0 : unreadCount(state, c.name);
          const active = c.name === current;
          return (
            <li key={c.name}>
              <a href={hrefFor({ view: "board", channel: c.name })} className={`channel-link ${active ? "is-active" : ""} ${unread ? "is-unread" : ""}`} aria-current={active ? "page" : undefined}>
                {c.members ? <Lock size={13} strokeWidth={1.75} aria-label="Restricted" /> : <Hash size={13} strokeWidth={1.75} aria-hidden="true" />}
                <span className="truncate">{c.name}</span>
                {unread > 0 && <span className="badge badge-signal tnum" aria-label={`${unread} unread`}>{unread}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Feed({ channel }: { channel: ChannelView }) {
  const { me } = useStore();
  const { markRead } = useActions();
  const route = useRoute();
  const { data, error, retry, hasMore, loadOlder, loadingMore } = useChannelFeed(channel.name);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const rootCount = data?.roots.length ?? 0;
  const lastRoot = data?.roots[rootCount - 1];

  const openThread = useCallback((id: string) => navigate({ view: "board", channel: channel.name, thread: id }), [channel.name]);

  // Keep the newest message in view unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rootCount, lastRoot?.id, data]);

  useEffect(() => {
    stick.current = true;
  }, [channel.name]);

  // Reading the channel clears its unread count, including messages that arrive while it's open.
  useEffect(() => {
    markRead(channel.name);
  }, [channel.name, lastRoot?.id, data?.threads, markRead]);

  const restricted = !!channel.members;
  const canSee = !restricted || (me?.handle ? channel.members?.includes(me.handle) : false);

  return (
    <section className="feed" aria-label={`#${channel.name}`}>
      <header className="feed-head">
        <div className="feed-head-title">
          {restricted ? <Lock size={15} strokeWidth={1.75} aria-hidden="true" /> : <Hash size={15} strokeWidth={1.75} aria-hidden="true" />}
          <h1 className="feed-name">{channel.name}</h1>
        </div>
        {channel.topic && <p className="feed-topic truncate" title={channel.topic}>{channel.topic}</p>}
        {restricted && <span className="chip feed-members" title={channel.members?.join(", ")}><Lock size={10} strokeWidth={2} aria-hidden="true" />{channel.members?.length} members</span>}
      </header>

      <div
        className="feed-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        {!canSee ? (
          <EmptyState icon={<Lock size={18} strokeWidth={1.75} />} title={`#${channel.name} is restricted`}>
            <p>Only {channel.members?.join(", ")} can read it. Ask an owner to add you.</p>
          </EmptyState>
        ) : error && !data ? (
          <ErrorState message={error} onRetry={retry} />
        ) : !data ? (
          <SkeletonRows rows={6} avatar />
        ) : data.roots.length === 0 ? (
          <EmptyState icon={<MessagesSquare size={18} strokeWidth={1.75} />} title={`Nothing in #${channel.name} yet`} command={`walkie post '#${channel.name}' "hello"`}>
            <p>Post below, or have an agent post from its terminal. Agents in this channel see every message.</p>
          </EmptyState>
        ) : (
          <div className="feed-list">
            {hasMore && (
              <button type="button" className="btn btn-ghost btn-sm feed-older" onClick={() => void loadOlder()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load earlier messages"}
              </button>
            )}
            {data.roots.map((e, i) => {
              const prev = data.roots[i - 1];
              const prevHasThread = prev ? (data.threads.get(prev.id)?.count ?? 0) > 0 : false;
              const compact = !!prev && !prevHasThread && e.kind === "msg.post" && prev.kind === "msg.post" && prev.author.handle === e.author.handle && prev.author.agent === e.author.agent && e.ts - prev.ts < GROUP_WINDOW_MS;
              const thread = data.threads.get(e.id);
              const active = route.thread === e.id;
              return (
                <ErrorBoundary key={e.id} scope="item" name={`message ${e.id}`} resetKeys={[e, thread, compact, active]}>
                  <MessageItem event={e} compact={compact} thread={thread} onOpenThread={openThread} active={active} />
                </ErrorBoundary>
              );
            })}
          </div>
        )}
      </div>
      {canSee && <Composer key={channel.name} channel={channel.name} placeholder={`Message #${channel.name}`} />}
    </section>
  );
}

export function Board() {
  const { team } = useStore();
  const route = useRoute();
  const channels = (team?.channels ?? []).filter((c) => !c.archived);
  const current = channels.find((c) => c.name === route.channel) ?? channels[0];

  useEffect(() => {
    if (current && route.channel !== current.name) navigate({ view: "board", channel: current.name });
  }, [current, route.channel]);

  const closeThread = useCallback(() => {
    if (current) navigate({ view: "board", channel: current.name });
  }, [current]);

  if (!current) {
    return (
      <div className="board board-empty">
        <EmptyState title="No channels yet" command={`walkie post '#build' "hello"`}>
          <p>Create a channel from the Team page, or post to one from the CLI and it appears here.</p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={route.thread ? "board has-thread" : "board"}>
      <ChannelList channels={channels} current={current.name} />
      <Feed channel={current} />
      {route.thread && <ThreadPanel id={route.thread} channel={current.name} onClose={closeThread} />}
    </div>
  );
}
