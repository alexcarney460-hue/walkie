import { useCallback, useEffect, useMemo, useState } from "react";
import { api, friendlyError } from "../../api/client.ts";
import type { Event } from "../../api/types.ts";
import { useStore } from "../../state/store.tsx";

const PAGE = 200;
const FEED_KINDS = new Set(["msg.post", "artifact.share", "ask"]);

function threadOf(e: Event): string | undefined {
  return (e.body as { thread?: string }).thread;
}

export interface ThreadSummary { count: number; lastTs: number; authors: Event["author"][] }

/** Channel feed: an initial page from /v1/events merged with live stream events. */
export function useChannelFeed(channel: string | undefined) {
  const { events: live } = useStore();
  const [pages, setPages] = useState<Event[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!channel) return;
    let cancelled = false;
    setPages(null);
    setError(null);
    api.events({ channel, limit: PAGE })
      .then((r) => {
        if (cancelled) return;
        setPages(r.events);
        setHasMore(r.events.length >= PAGE);
      })
      .catch((err) => { if (!cancelled) setError(friendlyError(err)); });
    return () => { cancelled = true; };
  }, [channel, nonce]);

  const loadOlder = useCallback(async () => {
    if (!channel || !pages?.length) return;
    setLoadingMore(true);
    try {
      const oldest = pages.reduce((m, e) => Math.min(m, e.ts), Infinity);
      const r = await api.events({ channel, limit: PAGE, before_ts: oldest });
      setPages((p) => [...(p ?? []), ...r.events]);
      setHasMore(r.events.length >= PAGE);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoadingMore(false);
    }
  }, [channel, pages]);

  const data = useMemo(() => {
    if (!pages) return null;
    const byId = new Map<string, Event>();
    for (const e of pages) byId.set(e.id, e);
    for (const e of live) if (e.channel === channel) byId.set(e.id, e);
    const all = [...byId.values()];
    const threads = new Map<string, ThreadSummary>();
    for (const e of all) {
      const t = threadOf(e);
      if (!t || !FEED_KINDS.has(e.kind)) continue;
      const cur = threads.get(t) ?? { count: 0, lastTs: 0, authors: [] };
      const authors = cur.authors.some((a) => a.handle === e.author.handle && a.agent === e.author.agent) ? cur.authors : [...cur.authors, e.author];
      threads.set(t, { count: cur.count + 1, lastTs: Math.max(cur.lastTs, e.ts), authors });
    }
    const roots = all.filter((e) => FEED_KINDS.has(e.kind) && !threadOf(e)).sort((a, b) => a.ts - b.ts);
    return { roots, threads };
  }, [pages, live, channel]);

  return { data, error, retry: () => setNonce((n) => n + 1), hasMore, loadOlder, loadingMore };
}

/** Thread: root + replies from /v1/events/:id, merged with live replies. */
export function useThread(id: string | undefined) {
  const { events: live } = useStore();
  const [base, setBase] = useState<{ event: Event; replies: Event[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setBase(null);
    setError(null);
    api.event(id)
      .then((r) => { if (!cancelled) setBase(r); })
      .catch((err) => { if (!cancelled) setError(friendlyError(err)); });
    return () => { cancelled = true; };
  }, [id, nonce]);

  const replies = useMemo(() => {
    if (!base) return null;
    const byId = new Map(base.replies.map((e) => [e.id, e]));
    for (const e of live) if (threadOf(e) === id) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.ts - b.ts);
  }, [base, live, id]);

  return { root: base?.event ?? null, replies, error, retry: () => setNonce((n) => n + 1) };
}
