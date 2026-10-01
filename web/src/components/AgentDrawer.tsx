import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, friendlyError } from "../api/client.ts";
import type { AgentView, Event, StatusBody } from "../api/types.ts";
import { STATE_LABEL, agentAddress, askBody, displayName } from "../lib/format.ts";
import { plainPreview } from "../lib/markdown.tsx";
import { getRoute, navigate } from "../lib/route.ts";
import { ago, clock, duration, fullTime, useNow } from "../lib/time.ts";
import { useStore } from "../state/store.tsx";
import { CopyCommand, ErrorState, RuntimeBadge, SkeletonRows, StatePill } from "./primitives.tsx";
import { TaskDetail } from "./TaskChip.tsx";
import { subagentLabel } from "../../../src/protocol/subagents.ts";
import { isCloudAgent } from "../../../src/protocol/guest-cloud.ts";

interface Step { id: string; ts: number; state: StatusBody["state"]; title?: string; actions: number; lastActivity?: string }

/** Collapse raw status events into state/title changes, counting tool actions between them. */
function toTimeline(events: Event[]): Step[] {
  const asc = [...events].sort((a, b) => a.ts - b.ts);
  const steps: Step[] = [];
  for (const e of asc) {
    const b = e.body as StatusBody;
    const prev = steps[steps.length - 1];
    if (prev && prev.state === b.state && prev.title === b.title) {
      steps[steps.length - 1] = { ...prev, actions: prev.actions + 1, lastActivity: b.activity ?? prev.lastActivity };
    } else {
      steps.push({ id: e.id, ts: e.ts, state: b.state, title: b.title, actions: 0, lastActivity: b.activity });
    }
  }
  return steps.reverse();
}

function useAgentHistory(agent: AgentView | undefined) {
  const { events } = useStore();
  const [fetched, setFetched] = useState<{ status: Event[]; posts: Event[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const key = agent?.id;

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    setFetched(null);
    setError(null);
    // The events API can't filter by agent yet, so fetch by kind and filter here.
    Promise.all([
      api.events({ kinds: "agent.status", limit: 500 }),
      api.events({ kinds: "msg.post,ask,answer,artifact.share", limit: 500 }),
    ])
      .then(([s, p]) => {
        if (cancelled) return;
        const mine = (e: Event) => e.author.node === agent.node && e.author.agent === agent.agent;
        setFetched({ status: s.events.filter(mine), posts: p.events.filter(mine) });
      })
      .catch((err) => { if (!cancelled) setError(friendlyError(err)); });
    return () => { cancelled = true; };
  }, [key, nonce]);

  return useMemo(() => {
    if (!agent || !fetched) return { timeline: null, posts: null, error, retry: () => setNonce((n) => n + 1) };
    const mine = (e: Event) => e.author.node === agent.node && e.author.agent === agent.agent;
    const liveStatus = events.filter((e) => e.kind === "agent.status" && mine(e));
    const livePosts = events.filter((e) => (e.kind === "msg.post" || e.kind === "ask" || e.kind === "answer" || e.kind === "artifact.share") && mine(e));
    const dedupe = (list: Event[]) => [...new Map(list.map((e) => [e.id, e])).values()];
    return {
      timeline: toTimeline(dedupe([...fetched.status, ...liveStatus])),
      posts: dedupe([...fetched.posts, ...livePosts]).sort((a, b) => b.ts - a.ts).slice(0, 12),
      error,
      retry: () => setNonce((n) => n + 1),
    };
  }, [agent, fetched, events, error]);
}

function postLine(e: Event): string {
  if (e.kind === "ask") return `Asked ${askBody(e).to}: ${plainPreview(askBody(e).text, 100)}`;
  if (e.kind === "answer") return (e.body as { declined?: boolean }).declined ? "Declined an ask" : `Answered: ${plainPreview(String((e.body as { text: string }).text), 100)}`;
  if (e.kind === "artifact.share") return `Shared ${(e.body as { name: string }).name}`;
  return plainPreview(String((e.body as { text: string }).text), 140);
}

export function AgentDrawer({ id }: { id: string }) {
  const { agents, archivedAgents, team, me } = useStore();
  const agent = agents.find((a) => a.id === id) ?? archivedAgents.find((a) => a.id === id);
  const now = useNow();
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const history = useAgentHistory(agent);
  const [revoked, setRevoked] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const cloud = !!agent && isCloudAgent(agent);
  const close = () => {
    const { agent: _drop, ...rest } = getRoute();
    navigate(rest);
  };

  useEffect(() => {
    returnFocus.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      (returnFocus.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  const s = agent?.status;
  const hermesViewOnly = s?.runtime === "other" && s.runtime_name === "hermes";
  return (
    <div className="drawer-layer">
      <div className="scrim" onClick={close} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header className="drawer-head">
          <div className="drawer-head-text">
            <div className="drawer-kicker">
              {s && <RuntimeBadge runtime={s.runtime} runtime_name={s.runtime_name} launch={s.launch} />}
              <span className="mono muted truncate">{agent ? agentAddress(agent) : id}</span>
            </div>
            <h2 className="drawer-title mono" id="drawer-title">{agent?.agent ?? id.split("/").pop()}</h2>
          </div>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-icon" onClick={close} aria-label="Close agent details">
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        {!agent || !s ? (
          <div className="drawer-body">
            <ErrorState message="This agent isn't reporting anymore. Its machine may have left the team." />
          </div>
        ) : (
          <div className="drawer-body">
            <div className="drawer-now">
              <StatePill state={agent.effective_state} />
              <span className="muted tnum">updated {ago(agent.updated_at, now)} ago</span>
            </div>
            <p className="drawer-status-title">{s.title ?? (s.parent ? subagentLabel(s.subagent_type) : hermesViewOnly ? "View only" : "No status title")}</p>
            {s.activity && <p className="drawer-activity mono">{s.activity}</p>}

            <dl className="facts">
              <dt>Owner</dt><dd>{displayName(team?.members, agent.handle)} <span className="muted mono">@{agent.handle}</span></dd>
              <dt>Location</dt><dd className="mono">{cloud ? "Cloud · self-reported" : agent.hostname}{!cloud && !agent.machine_online && <span className="fact-warn"> offline</span>}</dd>
              {s.parent && <><dt>Sub-agent of</dt><dd className="mono">{s.parent}{s.subagent_type && <span className="muted"> · {s.subagent_type}</span>}</dd></>}
              {agent.subagents && <><dt>Sub-agents</dt><dd className="tnum">{agent.subagents.working} working · {agent.subagents.live} live</dd></>}
              {s.task && <><dt>Task</dt><dd><TaskDetail task={s.task} /></dd></>}
              {s.repo && <><dt>Repo</dt><dd className="mono">{s.repo}{s.branch ? <span className="muted">@{s.branch}</span> : null}</dd></>}
              {s.cwd && <><dt>Directory</dt><dd className="mono truncate" title={s.cwd}>{s.cwd}</dd></>}
              {s.model && <><dt>Model</dt><dd className="mono">{s.model}</dd></>}
              {s.started_at && <><dt>Session</dt><dd><span className="tnum" title={fullTime(s.started_at)}>started {clock(s.started_at)}, {duration(now - s.started_at)} ago</span>{s.session && <span className="muted mono"> · {s.session}</span>}</dd></>}
              <dt>Asks</dt><dd>{hermesViewOnly ? "Unavailable — view only" : s.ask_policy === "human" ? "Routed to a person in the dashboard" : s.ask_policy === "off" ? "Not accepting asks" : "Answered by the agent"}</dd>
            </dl>

            {cloud && (
              <div className="drawer-section">
                <h3 className="drawer-h">Cloud access</h3>
                <p className="muted">Walkie receives this agent's reports. Start, pause and stop are controlled in its own platform.</p>
                {me?.node.id === agent.node && me.handle === agent.handle && (
                  <button type="button" className="btn btn-sm" disabled={revoked} onClick={() => {
                    void api.revokeGuest(agent.agent).then(() => setRevoked(true)).catch((error) => setRevokeError(friendlyError(error)));
                  }}>{revoked ? "Walkie access revoked" : "Revoke Walkie access"}</button>
                )}
                {revokeError && <p role="alert">{revokeError}</p>}
              </div>
            )}
            {!s.parent && !cloud && !hermesViewOnly && (
              // A sub-agent never reads asks (its session does): no ask command for it (WALKIE-MISSION-SUB-1).
              <div className="drawer-section">
                <h3 className="drawer-h">Ask this agent</h3>
                <CopyCommand command={`walkie ask ${agentAddress(agent)} "…"`} />
              </div>
            )}

            <div className="drawer-section">
              <h3 className="drawer-h">Status history</h3>
              {history.error ? (
                <ErrorState compact message={history.error} onRetry={history.retry} />
              ) : !history.timeline ? (
                <SkeletonRows rows={4} />
              ) : history.timeline.length === 0 ? (
                <p className="muted">No status reports yet.</p>
              ) : (
                <ol className="timeline">
                  {history.timeline.map((step) => (
                    <li key={step.id} className={`tl-step tone-${step.state}`}>
                      <span className="tl-dot" aria-hidden="true" />
                      <div className="tl-body">
                        <div className="tl-top">
                          <span className="tl-state">{STATE_LABEL[step.state]}</span>
                          <span className="tl-time tnum muted" title={fullTime(step.ts)}>{clock(step.ts)}</span>
                        </div>
                        {step.title && <p className="tl-title">{step.title}</p>}
                        {step.actions > 0 && <p className="tl-actions muted tnum">{step.actions} tool action{step.actions === 1 ? "" : "s"}{step.lastActivity ? <>, last <span className="mono">{step.lastActivity}</span></> : null}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="drawer-section">
              <h3 className="drawer-h">Recent posts and asks</h3>
              {history.error ? null : !history.posts ? (
                <SkeletonRows rows={3} />
              ) : history.posts.length === 0 ? (
                <p className="muted">This agent hasn't posted yet.</p>
              ) : (
                <ul className="drawer-posts">
                  {history.posts.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        className="drawer-post"
                        onClick={() => {
                          if (e.kind === "ask" || e.kind === "answer") navigate({ view: "asks" });
                          else if (e.kind === "artifact.share") navigate({ view: "artifacts" });
                          else navigate({ view: "board", channel: e.channel, thread: (e.body as { thread?: string }).thread ?? e.id });
                        }}
                      >
                        <span className="drawer-post-meta tnum">{e.channel ? `#${e.channel}` : "direct"} · {ago(e.ts, now)}</span>
                        <span className="drawer-post-text">{postLine(e)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
