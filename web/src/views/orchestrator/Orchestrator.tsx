import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CloudOff, Menu, Monitor, Sparkles, SquarePen, TriangleAlert, X } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import { CopyCommand, ErrorState } from "../../components/primitives.tsx";
import { useMdOpts } from "../../state/useMdOpts.ts";
import { hrefFor, navigate, useRoute } from "../../lib/route.ts";
import { useNow } from "../../lib/time.ts";
import { useActions, useStore } from "../../state/store.tsx";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { Message, MessageBoundary, Pending } from "./Messages.tsx";
import { StartOrchestrator, StopOrchestrator } from "./Lifecycle.tsx";
import { HeaderModel } from "./ModelPicker.tsx";
import { standingDown, TalkieStateCard, useTalkieView } from "./TalkieState.tsx";
import { awaitingReply, conversations, dayGroup, localOrchestrator, modelLabel, threadMessages, type Conversation, type DayGroup } from "./model.ts";

const SUGGESTIONS = [
  "What is everyone working on right now?",
  "Which agents are blocked or waiting on a person, and why?",
  "Summarize what the team got done today",
  "Ask the agents on my other machines for a status report",
];

const START = "walkie talkie start";

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

function NotRunning() {
  return (
    <div className="orch-card" role="region" aria-labelledby="orch-off-title">
      <div className="orch-card-icon" aria-hidden="true"><Sparkles size={18} strokeWidth={1.75} /></div>
      <h2 id="orch-off-title" className="orch-card-title">WalkieTalkie is stopped on this machine</h2>
      <p className="orch-card-body">
        Start it here. It runs your own Claude Code sign-in on this machine, and the conversation stays on this machine:
        talk to it in this tab or with <code className="md-code">walkie talkie say</code>.
      </p>
      <StartOrchestrator />
      <p className="orch-card-note">Or from a terminal, to choose its model, folder or permissions:</p>
      <CopyCommand command={START} />
      <LocalNote />
    </div>
  );
}

/** The conversation is local to this machine (ORCH-FIX-12): no other device reaches it, the phone app included. */
function LocalNote() {
  return (
    <p className="orch-card-note">
      <Monitor size={13} strokeWidth={1.75} aria-hidden="true" /> Only on this machine: nothing of it is synced to your team or your other devices.
    </p>
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
  const host = standingDown(talkie) ? null : status;
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
  const busy = !!waiting && !!host;
  const activity = host?.effective_state === "working" && host.status.activity ? host.status.activity : "Thinking…";

  // Stick to the bottom while the reader is there; a new conversation starts at the bottom.
  useLayoutEffect(() => { stick.current = true; }, [thread]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
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
  const where = !host && talkie?.state === "standby" ? <span>standby{talkie.lead ? ` · lead: ${talkie.lead}` : ""}</span>
    : !host && talkie?.state === "needs_login" ? <span>needs a model login</span>
    : host ? (
    <>
      <span className={`orch-dot orch-dot-${host.effective_state}`} aria-hidden="true" />
      <span>on this machine · {modelLabel(host.status.model)}</span>
    </>
  ) : <span>not running on this machine</span>;

  const composerEl = (
    <div className="orch-dock">
      {error && <ErrorState message={error} compact />}
      {reconnecting && host && (
        <div className="orch-offline" role="status">
          <CloudOff size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Reconnecting to Walkie on this machine… Sending is paused until it's back.</span>
        </div>
      )}
      {host?.effective_state === "blocked" && (
        <div className="orch-offline" role="alert">
          <TriangleAlert size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{host.status.activity || "WalkieTalkie is stuck."} It retries on its own; check <span className="mono">walkie talkie status</span>.</span>
        </div>
      )}
      {host ? (
        <Composer
          ref={composer} busy={busy} disabled={reconnecting} onSend={send} onStop={stop}
          placeholder={empty ? "Ask WalkieTalkie anything" : "Message WalkieTalkie"}
        />
      ) : !empty && talkie && standingDown(talkie) ? (
        <div className="orch-offline" role="status">
          <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{talkie.state === "standby" ? `WalkieTalkie is on standby here${talkie.lead ? `; it runs on ${talkie.lead}` : ""}.` : talkie.needs ?? "WalkieTalkie needs a model login."}</span>
        </div>
      ) : !empty ? (
        <div className="orch-offline orch-offline-start" role="status">
          <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>WalkieTalkie isn't running here. Start it to continue (or <code className="md-code">{START}</code> in a terminal).</span>
          <StartOrchestrator size="sm" />
        </div>
      ) : null}
      {host && <p className="orch-foot">Runs Claude Code on this machine with your sign-in; the conversation stays here. It can use tools; check its work.</p>}
    </div>
  );

  return (
    <div className={`orch${sideOpen ? " side-open" : ""}`}>
      <aside className="orch-side" aria-label="WalkieTalkie conversations">
        <div className="orch-side-head">
          <button type="button" className="orch-new" onClick={newChat}>
            <SquarePen size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>New chat</span>
          </button>
          <button type="button" className="btn btn-ghost btn-icon btn-sm orch-side-close" onClick={() => setSideOpen(false)} aria-label="Close conversations">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        {load === "error" ? <ErrorState message="Couldn't load conversations." onRetry={() => setLoadNonce((n) => n + 1)} compact />
          : <ConversationList items={convs} current={thread} onPick={() => setSideOpen(false)} now={now} />}
      </aside>
      {sideOpen && <button type="button" className="orch-scrim" aria-label="Close conversations" onClick={() => setSideOpen(false)} />}

      <section className={`orch-main${empty ? " is-empty" : ""}`}>
        <header className="orch-head">
          <button type="button" className="btn btn-ghost btn-icon orch-menu" onClick={() => setSideOpen(true)} aria-label="Show conversations">
            <Menu size={18} strokeWidth={1.75} />
          </button>
          <div className="orch-title">
            <h1>WalkieTalkie</h1>
            <p className="orch-where">{where}</p>
          </div>
          {host && <HeaderModel refresh={`${host.status.model ?? ""}|${host.status.started_at ?? ""}`} />}
          {host && <StopOrchestrator />}
          <button type="button" className="btn btn-ghost btn-sm orch-head-new" onClick={newChat} title="New chat">
            <SquarePen size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="orch-head-new-label">New chat</span>
          </button>
        </header>

        <div className="orch-scroll" ref={scroller} onScroll={onScroll}>
          <div className="orch-col">
            {empty ? (
              host ? (
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
              ) : talkie && standingDown(talkie) ? <TalkieStateCard view={talkie} /> : <NotRunning />
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
