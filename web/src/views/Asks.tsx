import { ArrowRight, CircleHelp } from "lucide-react";
import type { AskView } from "../api/types.ts";
import { AskAnswer } from "../components/AskAnswer.tsx";
import { AuthorAvatar, AuthorName } from "../components/Author.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { EmptyState, RelTime } from "../components/primitives.tsx";
import { addressedToMe, askBody, askExpiresAt, canAnswer, displayName, effectiveAskState } from "../lib/format.ts";
import { Markdown } from "../lib/markdown.tsx";
import { hrefFor, useRoute } from "../lib/route.ts";
import { clock, countdown, fullTime, useNow } from "../lib/time.ts";
import { useStore } from "../state/store.tsx";
import { useMdOpts } from "../state/useMdOpts.ts";

type Tab = "open" | "resolved" | "expired";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Answered" },
  { id: "expired", label: "Expired" },
];

function bucket(v: AskView, now: number): Tab {
  const s = effectiveAskState(v, now);
  return s === "open" ? "open" : s === "expired" ? "expired" : "resolved";
}

function AskRow({ view, showState }: { view: AskView; showState: boolean }) {
  const { me, agents, team } = useStore();
  const md = useMdOpts();
  const now = useNow();
  const body = askBody(view.ask);
  const state = effectiveAskState(view, now);
  const expiresAt = askExpiresAt(view);
  const left = expiresAt - now;
  const forMe = addressedToMe(view, me?.handle ?? null);
  const actionable = canAnswer(view, me?.handle ?? null, agents, now) && me?.role !== "observer";
  const expiryPct = Math.max(0, Math.min(100, (left / Math.max(1, expiresAt - view.ask.ts)) * 100));

  return (
    <li className={`ask-row is-${state} ${actionable ? "is-actionable" : ""}`}>
      <div className="ask-row-gutter"><AuthorAvatar author={view.ask.author} size={28} /></div>
      <div className="ask-row-main">
        <div className="ask-row-head">
          <AuthorName author={view.ask.author} />
          <ArrowRight size={13} strokeWidth={1.75} className="muted" aria-label="to" />
          <span className="chip mono ask-row-to">{body.to}</span>
          {forMe && <span className="chip chip-amber">For you</span>}
          {!forMe && actionable && <span className="chip chip-amber" title="The target agent routes asks to a person">Needs a person</span>}
        </div>
        <div className="ask-row-text">
          <Markdown text={body.text} opts={md} />
        </div>
        <div className="ask-row-meta tnum">
          <span title={fullTime(view.ask.ts)}>asked <RelTime ts={view.ask.ts} long /></span>
          {view.ask.channel && <a className="ask-row-channel" href={hrefFor({ view: "board", channel: view.ask.channel })}>#{view.ask.channel}</a>}
          {state === "open" && (
            <span className={`ask-row-expiry ${left < 5 * 60_000 ? "is-urgent" : ""}`} title={`Expires ${fullTime(expiresAt)}`}>
              <span className="expiry-bar" aria-hidden="true"><span style={{ transform: `scaleX(${expiryPct / 100})` }} /></span>
              expires in {countdown(left)}
            </span>
          )}
          {state === "expired" && <span>expired {clock(expiresAt)}</span>}
        </div>
        {view.answers.map((a) => {
          const declined = !!(a.body as { declined?: boolean }).declined;
          return (
            <div key={a.id} className={`ask-row-answer ${declined ? "is-declined" : ""}`}>
              <AuthorAvatar author={a.author} size={18} />
              <div>
                <p className="ask-row-answer-who">
                  {a.author.agent ? <span className="mono">{a.author.agent}</span> : displayName(team?.members, a.author.handle)}
                  <span className="muted"> {declined ? "declined" : "answered"} · <RelTime ts={a.ts} long /></span>
                </p>
                <Markdown text={String((a.body as { text: string }).text)} opts={md} />
              </div>
            </div>
          );
        })}
        {actionable && <AskAnswer view={view} />}
      </div>
      {showState && <div className="ask-row-state">
        <span className={`ask-state is-${state}`}>{state === "open" ? "Open" : state === "answered" ? "Answered" : state === "declined" ? "Declined" : "Expired"}</span>
      </div>}
    </li>
  );
}

export function Asks() {
  const { asks, me, agents } = useStore();
  const route = useRoute();
  const now = useNow();
  const tab: Tab = route.tab === "resolved" || route.tab === "expired" ? route.tab : "open";
  const counts = { open: 0, resolved: 0, expired: 0 } as Record<Tab, number>;
  for (const a of asks) counts[bucket(a, now)] += 1;
  const list = asks
    .filter((a) => bucket(a, now) === tab)
    .sort((a, b) => {
      if (tab === "open") {
        const ra = canAnswer(a, me?.handle ?? null, agents, now) ? 0 : 1;
        const rb = canAnswer(b, me?.handle ?? null, agents, now) ? 0 : 1;
        return ra - rb || askExpiresAt(a) - askExpiresAt(b);
      }
      return b.ask.ts - a.ask.ts;
    });
  const mine = asks.filter((a) => canAnswer(a, me?.handle ?? null, agents, now)).length;

  return (
    <div className="page">
      <PageHeader
        title="Asks"
        meta={mine ? <><span className="text-amber">{mine} waiting on you</span> · agents block until someone answers or the ask expires</> : "Directed questions between people and agents. The asker waits for an answer or the expiry."}
      />
      <div className="tabs" role="tablist" aria-label="Ask state">
        {TABS.map((t) => (
          <a key={t.id} role="tab" aria-selected={tab === t.id} href={hrefFor({ view: "asks", tab: t.id === "open" ? undefined : t.id })} className={tab === t.id ? "tab-link is-on" : "tab-link"}>
            {t.label}<span className="seg-n tnum">{counts[t.id]}</span>
          </a>
        ))}
      </div>
      {list.length === 0 ? (
        <EmptyState
          icon={<CircleHelp size={18} strokeWidth={1.75} />}
          title={tab === "open" ? "No open asks" : tab === "resolved" ? "Nothing answered yet" : "No expired asks"}
          command={tab === "open" ? `walkie ask @${me?.handle ?? "teammate"} "Can I run the migration on staging?"` : undefined}
        >
          {tab === "open" && <p>Agents use <span className="mono">walkie ask</span> to ask a person or another agent and wait for the answer. Asks for you land here.</p>}
        </EmptyState>
      ) : (
        <ul className="ask-list">{list.map((v) => <AskRow key={v.ask.id} view={v} showState={tab !== "open"} />)}</ul>
      )}
    </div>
  );
}
