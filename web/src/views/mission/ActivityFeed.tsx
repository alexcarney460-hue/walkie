import { useMemo } from "react";
import { CircleCheck, CircleHelp, FileText, MessageSquare, Activity, Layers, TerminalSquare } from "lucide-react";
import { STATE_LABEL } from "../../lib/format.ts";
import { getRoute, navigate } from "../../lib/route.ts";
import { ago, useNow } from "../../lib/time.ts";
import { useStore } from "../../state/store.tsx";
import { buildActivity, FEED_LIMIT, type Item } from "./activity-items.ts";

const ICON = { post: MessageSquare, state: Activity, step: TerminalSquare, churn: Layers, ask: CircleHelp, answer: CircleCheck, file: FileText };

/** Recent team activity: state changes (flapping folded), grouped churn, shared tool steps, posts and asks. */
export function useActivity(limit: number): Item[] {
  const { events, team, nodes } = useStore();
  return useMemo(() => buildActivity(events, nodes, team?.members, limit), [events, team?.members, nodes, limit]);
}

function go(it: Item): void {
  if (it.to.agent) navigate({ ...getRoute(), agent: it.to.agent });
  else navigate(it.to);
}

export function ActivityFeed({ limit = FEED_LIMIT }: { limit?: number }) {
  const items = useActivity(limit);
  const now = useNow();
  return (
    <section className="feed-rail" aria-label="Live activity">
      <header className="feed-rail-head">
        <h2 className="section-title">Live activity</h2>
      </header>
      {items.length === 0 ? (
        <p className="feed-rail-empty">Nothing yet. Activity from every teammate's agents streams in here.</p>
      ) : (
        <ol className="ticker">
          {items.map((it) => {
            const Icon = ICON[it.kind];
            return (
              <li key={it.id} className="ticker-item">
                <button type="button" className={`ticker-btn is-${it.kind}`} onClick={() => go(it)}>
                  <span className={`ticker-icon ${it.state ? `tone-${it.state}` : ""}`} aria-hidden="true">
                    <Icon size={13} strokeWidth={1.75} />
                  </span>
                  <span className="ticker-body">
                    <span className="ticker-who">
                      <span className="truncate">{it.who}</span>
                      {it.kind === "state" && it.state && <span className={`ticker-state tone-${it.state}`}>{STATE_LABEL[it.state]}</span>}
                      {it.kind === "state" && it.count ? <span className="ticker-note tnum" title="Brief changes of state folded into this entry">+{it.count} brief</span> : null}
                      {it.kind === "step" && it.count && it.count > 1 ? <span className="ticker-note tnum" title="Steps in a row, the latest shown">{it.count} steps</span> : null}
                    </span>
                    <span className="ticker-text">{it.text}</span>
                  </span>
                  <span className="ticker-time tnum">{ago(it.ts, now)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
