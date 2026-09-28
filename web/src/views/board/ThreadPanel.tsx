import { useEffect, useRef } from "react";
import { ArrowLeft, X } from "lucide-react";
import { ErrorState, SkeletonRows } from "../../components/primitives.tsx";
import { Composer } from "./Composer.tsx";
import { MessageItem } from "./MessageItem.tsx";
import { useThread } from "./useFeed.ts";

export function ThreadPanel({ id, channel, onClose }: { id: string; channel: string; onClose: () => void }) {
  const { root, replies, error, retry } = useThread(id);
  const endRef = useRef<HTMLDivElement>(null);
  const count = replies?.length ?? 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count, id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest?.(".composer")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="thread" aria-label="Thread">
      <header className="thread-head">
        <button type="button" className="btn btn-ghost btn-icon thread-back" onClick={onClose} aria-label="Back to channel">
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>
        <div className="thread-head-text">
          <h2 className="thread-title">Thread</h2>
          <span className="muted">#{channel}{replies ? ` · ${count} ${count === 1 ? "reply" : "replies"}` : ""}</span>
        </div>
        <button type="button" className="btn btn-ghost btn-icon thread-close" onClick={onClose} aria-label="Close thread">
          <X size={16} strokeWidth={1.75} />
        </button>
      </header>
      <div className="thread-scroll">
        {error ? (
          <ErrorState message={error} onRetry={retry} />
        ) : !root || !replies ? (
          <SkeletonRows rows={3} avatar />
        ) : (
          <>
            <MessageItem event={root} />
            <div className="thread-divider"><span>{count ? `${count} ${count === 1 ? "reply" : "replies"}` : "No replies yet"}</span></div>
            {replies.map((e, i) => {
              const prev = replies[i - 1];
              const compact = !!prev && prev.author.handle === e.author.handle && prev.author.agent === e.author.agent && e.ts - prev.ts < 5 * 60_000;
              return <MessageItem key={e.id} event={e} compact={compact} />;
            })}
            <div ref={endRef} />
          </>
        )}
      </div>
      <Composer key={id} channel={channel} thread={id} placeholder="Reply in thread" />
    </aside>
  );
}
