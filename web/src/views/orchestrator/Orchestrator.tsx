import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CloudOff, Menu, Sparkles, SquarePen, TriangleAlert, X } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import { ErrorState } from "../../components/primitives.tsx";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { RememberedDetails } from "../../components/RememberedDetails.tsx";
import { useMdOpts } from "../../state/useMdOpts.ts";
import { hrefFor, navigate, useRoute } from "../../lib/route.ts";
import { duration, useNow } from "../../lib/time.ts";
import { useActions, useStore } from "../../state/store.tsx";
import { displayStoredText } from "../../../../src/protocol/display-text.ts";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { Message, MessageBoundary, Pending } from "./Messages.tsx";
import { StartOrchestrator, StopOrchestrator } from "./Lifecycle.tsx";
import { RecommendationsPanel } from "./Recommendations.tsx";
import { SchedulesPanel } from "./Schedules.tsx";
import { HeaderModel } from "./ModelPicker.tsx";
import { cleanupDiagnostic, notRunningKind, ResumeButton, standingDown, StoppedCard, TalkieStateCard, useTalkieView } from "./TalkieState.tsx";
import { awaitingReply, conversations, dayGroup, localOrchestrator, threadMessages, type Conversation, type DayGroup } from "./model.ts";

const SUGGESTIONS = [
  "What is everyone working on right now?",
  "Which agents are blocked or waiting on a person, and why?",
  "Summarize what the team got done today",
  "Ask the agents on my other machines for a status report",
];

function ConversationList({ items, current, onPick, now }: { items: Conversation[]; current?: string; onPick: () => void; now: number }) {
  const groups: Array<[DayGroup, Conversation[]]> = [];
  for (const c of items) {
    const g = dayGroup(c.lastTs, now);
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(c); else groups.push([g, [c]]);
  }
  if (!items.length) return <p className="orch-side-empty">Your conversations will show up here.</p>;
  return (
    <nav className="orch-convs" aria-label="Conversations">
      {groups.map(([g, list]) => (
        <div key={g} className="orch-conv-group">
          <h2 className="orch-conv-label">{g}</h2>
          <ul>
            {list.map((c) => (
              <li key={c.id}>
                <a
                  href={hrefFor({ view: "orchestrator", thread: c.id })}
                  className={c.id === current ? "orch-conv is-active" : "orch-conv"}
                  aria-current={c.id === current ? "page" : undefined}
                  onClick={onPick}
                  title={c.title}
                >
                  <span className="truncate">{c.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function NotRunning({ canStart, stoppedByYou = false }: { canStart: boolean; stoppedByYou?: boolean }) {
  return (
    <p className="orch-card-body">{canStart
      ? stoppedByYou ? "Resume Talkie above to begin a conversation on this machine." : "Start Talkie above to begin a conversation on this machine."
      : "Talkie is not running on this machine."}</p>
  );
}

export function Orchestrator() {
  const route = useRoute();
  const { me, agents, orch, live, conn } = useStore();
  const { applyOrch } = useActions();
  const now = useNow();
  const mdOpts = useMdOpts();
  // This machine's own host only (ORCH-FIX-11): the conversation is local.
  const status = localOrchestrator(agents, me?.node.id);
  // ORCH-2: a machine standing by (or without a model login) publishes a status too; its host isn't running here.
  const talkie = useTalkieView(`${status?.effective_state ?? ""}|${status?.updated_at ?? ""}`);
  const [channelNotice, setChannelNotice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.channelHealth().then((result) => {
      if (!cancelled) setChannelNotice(result.quota_damaged ? result.notice : null);
    }).catch(() => undefined);
    void load();
    const timer = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  // The host's running flag is authoritative; the replicated agent card can be stale or swept by older peers.
  const hostRunning = talkie?.running === true && !standingDown(talkie);
  const host = hostRunning ? status : null;
  // The host says it runs: show the conversation even while its replicated card is missing or stale (it re-announces
  // itself every 10 min; before that fix, an idle card went stale after 30 min and this page said "starting").
  const talkieLive = hostRunning;
  const reconnecting = conn.status === "reconnecting";
  const thread = route.thread;
  const [load, setLoad] = useState<"loading" | "ok" | "error">("loading");
  const [loadNonce, setLoadNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const composer = useRef<ComposerHandle>(null);

  // The history comes from this machine's store (a reload shows it again); new messages arrive on the stream.
  useEffect(() => {
    let cancelled = false;
    setLoad("loading");
    api.orchestratorMessages()
      .then((r) => { if (!cancelled) { applyOrch(r.messages); setLoad("ok"); } })
      .catch(() => { if (!cancelled) setLoad("error"); });
    return () => { cancelled = true; };
  }, [applyOrch, loadNonce]);

  const convs = useMemo(() => conversations(orch), [orch]);
  const messages = useMemo(() => (thread ? threadMessages(orch, thread) : []), [orch, thread]);
  const waiting = awaitingReply(messages, now);
  const liveTurn = waiting ? live[waiting.id] : undefined;
  const busy = !!waiting && hostRunning;
  const activity = host?.effective_state === "working" && host.status.activity ? displayStoredText(host.status.activity) : "Thinking…";

  // Stick to the bottom while the reader is there; a new conversation starts at the bottom.
  useLayoutEffect(() => {
    stick.current = true;
    if (!thread && scroller.current) scroller.current.scrollTop = 0;
  }, [thread]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && thread && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => { setError(null); composer.current?.focus(); }, [thread]);

  // Escape closes the phone conversations drawer.
  useEffect(() => {
    if (!sideOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSideOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sideOpen]);

  const send = useCallback(async (text: string): Promise<boolean> => {
    setError(null);
    try {
      const { message } = await api.orchestratorSay(text, thread);
      applyOrch([message]);
      stick.current = true;
      if (!thread) navigate({ view: "orchestrator", thread: message.thread });
      return true;
    } catch (err) {
      setError(friendlyError(err));
      return false;
    }
  }, [thread, applyOrch]);

  const stop = useCallback(() => {
    if (!thread) return;
    void api.orchestratorStopReply(thread).catch((err) => setError(friendlyError(err)));
  }, [thread]);

  const newChat = () => {
    setSideOpen(false);
    navigate({ view: "orchestrator" });
    requestAnimationFrame(() => composer.current?.focus());
  };

  const empty = !thread;
  const where = talkie?.state === "cleanup_pending" ? <span>cleanup pending</span>
    : !host && talkie?.state === "standby" ? <span>standby{talkie.lead ? ` · lead: ${talkie.lead}` : ""}</span>
    : !host && talkie?.state === "needs_login" ? <span>needs a model login</span>
    : hostRunning ? (
    <>
      <span className={`orch-dot orch-dot-${status?.effective_state ?? talkie?.state ?? "idle"}`} aria-hidden="true" />
      <span>
        on this machine
        {talkie?.started_at ? ` · up ${duration(now - talkie.started_at)}` : ""}
      </span>
      {talkie?.access === "full" && <span className="chip chip-amber">Full access</span>}
    </>
  ) : (
    <span>
      {notRunningKind(talkie) === "stopped_by_you" ? "stopped (by you)"
        : notRunningKind(talkie) === "starting" ? "starting on its own"
        : "not running on this machine"}
    </span>
  );

  const composerEl = (
    <div className="orch-dock">
      {error && <ErrorState message={error} compact />}
      {hostRunning && talkie?.state === "cleanup_pending" && (
        <div className="orch-offline" role="status"><TriangleAlert size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Talkie cleanup pending: {cleanupDiagnostic(talkie)}</span></div>
      )}
      {reconnecting && hostRunning && (
        <div className="orch-offline" role="status">
          <CloudOff size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Reconnecting to Sqwakie on this machine… Sending is paused until it's back.</span>
        </div>
      )}
      {host?.effective_state === "blocked" && (
        <div className="orch-offline" role="alert">
          <TriangleAlert size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{host.status.activity ? displayStoredText(host.status.activity) : "Talkie is stuck."} It retries on its own.</span>
        </div>
      )}
      {hostRunning ? (
        <Composer
          ref={composer} busy={busy} disabled={reconnecting} onSend={send} onStop={stop}
          placeholder={empty ? "Ask Talkie anything" : "Message Talkie"}
        />
      ) : !empty && talkie?.state === "cleanup_pending" ? (
        <div className="orch-offline" role="status"><TriangleAlert size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Talkie cleanup pending: {cleanupDiagnostic(talkie)}</span></div>
      ) : !empty && talkie && standingDown(talkie) ? (
        <div className="orch-offline" role="status">
          <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{talkie.state === "standby" ? `Talkie is on standby here${talkie.lead ? `; it runs on ${talkie.lead}` : ""}.` : talkie.needs ?? "Talkie needs a model login."}</span>
        </div>
      ) : !empty && notRunningKind(talkie) === "stopped_by_you" && me?.role === "observer" ? (
        <div className="orch-offline orch-offline-start" role="status">
          <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Talkie is stopped (by you). Resume to continue: it runs on its own again.</span>
          <ResumeButton size="sm" />
        </div>
      ) : !empty && notRunningKind(talkie) === "failed" && me?.role === "observer" ? (
        <div className="orch-offline orch-offline-start" role="alert">
          <TriangleAlert size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{talkie?.last_error ?? "Talkie keeps failing."}</span>
          <StartOrchestrator size="sm" />
        </div>
      ) : !empty && notRunningKind(talkie) === "starting" ? (
        <div className="orch-offline" role="status">
          <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{talkie?.last_error ?? "Talkie is starting on its own…"}</span>
        </div>
      ) : !empty && (me?.role === "observer" || !talkie) ? (
        <div className="orch-offline orch-offline-start" role="status">
          <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Talkie isn't running here. Start it to continue.</span>
          <StartOrchestrator size="sm" />
        </div>
      ) : null}
      {hostRunning && <p className="orch-foot">Runs Claude Code on this machine with your sign-in; the conversation stays here. It can use tools; check its work.</p>}
    </div>
  );

  return (
    <div className={`orch${sideOpen ? " side-open" : ""}`}>
      <aside className="orch-side" aria-label="Talkie conversations">
        <div className="orch-side-head">
          <button type="button" className="orch-new" onClick={newChat}>
            <SquarePen size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>New chat</span>
          </button>
          <button type="button" className="btn btn-ghost btn-icon btn-sm orch-side-close" onClick={() => setSideOpen(false)} aria-label="Close conversations">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        {load === "error" ? <p className="orch-side-empty">Couldn't load conversations. <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLoadNonce((n) => n + 1)}>Retry</button></p>
          : <ConversationList items={convs} current={thread} onPick={() => setSideOpen(false)} now={now} />}
      </aside>
      {sideOpen && <button type="button" className="orch-scrim" aria-label="Close conversations" onClick={() => setSideOpen(false)} />}

      <section className={`orch-main${empty ? " is-empty" : ""}`}>
        <header className="orch-head">
          <button type="button" className="btn btn-ghost btn-icon orch-menu" onClick={() => setSideOpen(true)} aria-label="Show conversations">
            <Menu size={18} strokeWidth={1.75} />
          </button>
          <div className="orch-title">
            <h1>Talkie</h1>
            <p className="orch-where">{where}</p>
          </div>
          {talkieLive && <StopOrchestrator />}
          <button type="button" className="btn btn-ghost btn-sm orch-head-new" onClick={newChat} title="New chat">
            <SquarePen size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="orch-head-new-label">New chat</span>
          </button>
        </header>

        {channelNotice && <div className="orch-offline" role="alert"><TriangleAlert size={15} strokeWidth={1.75} aria-hidden="true" />{channelNotice}</div>}

        {talkie && !hostRunning && !standingDown(talkie) && notRunningKind(talkie) !== "starting" && me?.role !== "observer" &&
          <ErrorBoundary scope="item" name="Talkie controls" resetKeys={[talkie]}><div className="orch-offline orch-offline-start"><span>{notRunningKind(talkie) === "failed" ? `Talkie keeps failing: ${talkie.last_error ?? "Try starting it again."}` : "Talkie is stopped."}</span>
            {notRunningKind(talkie) === "stopped_by_you" ? <><ResumeButton size="sm" /><RememberedDetails id="talkie-settings" summary="Talkie settings" className="orch-settings"><SchedulesPanel /></RememberedDetails></>
              : <StartOrchestrator size="sm" settings={<SchedulesPanel />} />}
          </div></ErrorBoundary>}
        {(hostRunning || standingDown(talkie)) && <RememberedDetails id="talkie-settings" summary="Talkie settings" className="orch-settings">
          {host && <HeaderModel refresh={`${host.status.model ?? ""}|${host.status.started_at ?? ""}`} />}
          <SchedulesPanel />
        </RememberedDetails>}

        <div className="orch-scroll" ref={scroller} onScroll={onScroll}>
          <div className="orch-col">
            {empty && <ErrorBoundary scope="item" name="Talkie suggestions"><div id="talkie-recommendations"><RecommendationsPanel /></div></ErrorBoundary>}
            {empty ? (
              talkieLive ? (
                <div className="orch-hello">
                  <h2 className="orch-hello-title">What should we get done?</h2>
                  {composerEl}
                  <ul className="orch-chips" aria-label="Suggestions">
                    {SUGGESTIONS.map((s) => (
                      <li key={s}>
                        <button type="button" className="orch-chip" disabled={reconnecting} onClick={() => void send(s)}>{s}</button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : talkie?.state === "cleanup_pending" ? <TalkieStateCard view={talkie} />
                : talkie && standingDown(talkie) ? <TalkieStateCard view={talkie} />
                : notRunningKind(talkie) === "starting" ? <StoppedCard view={talkie} /> : <NotRunning canStart={!!talkie && me?.role !== "observer"}
                  stoppedByYou={notRunningKind(talkie) === "stopped_by_you"} />
            ) : (
              <div className="orch-thread" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
                {load === "loading" && !messages.length && (
                  <div className="orch-skeleton" aria-busy="true" aria-label="Loading the conversation">
                    <span className="skeleton orch-skel-you" />
                    <span className="skeleton orch-skel-line" style={{ width: "78%" }} />
                    <span className="skeleton orch-skel-line" style={{ width: "64%" }} />
                    <span className="skeleton orch-skel-line" style={{ width: "42%" }} />
                  </div>
                )}
                {messages.map((m) => <MessageBoundary key={m.id} text={m.text}><Message msg={m} opts={mdOpts} /></MessageBoundary>)}
                {busy && waiting && (
                  <MessageBoundary text={liveTurn && !liveTurn.done ? liveTurn.text : ""}>
                    <Pending
                      text={liveTurn && !liveTurn.done ? liveTurn.text : ""}
                      tools={liveTurn?.tools ?? []}
                      activity={activity}
                      opts={mdOpts}
                    />
                  </MessageBoundary>
                )}
              </div>
            )}
          </div>
        </div>
        {!empty && composerEl}
      </section>
    </div>
  );
}
