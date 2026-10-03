// Simple mode (WALK-75): three plain blocks, Move buttons, and the existing task and ask routes.
// Activity lines are a fixed reading of the card's history, not a written summary.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { api, friendlyError } from "../../api/client.ts";
import type { AskView, CardView, MemberView, ProjectView } from "../../api/types.ts";
import { displayName } from "../../lib/format.ts";
import { presence } from "../../lib/projects.ts";
import { navigate, useRoute } from "../../lib/route.ts";
import {
  STATUS_NAMES, activityLines, askText, askVisible, boardColumns, cardRole, columnForStatus, dueLabel,
  needsYourDecision, onSimplePage, partition, plainText, quotesConfidential, statusName, whoFromAddress, whoFromAuthor,
  type SimpleModel,
} from "../../lib/simple-board.ts";
import { useNow } from "../../lib/time.ts";
import { projectsStore } from "../../state/projects.ts";
import { useActions, useStore } from "../../state/store.tsx";

const MAX_NOTE = 2_000;
const STALE = "This card changed. Refresh to see the latest.";
const READ_ONLY = "You can read this. You can't change it.";

function replaceTask(list: CardView[], task: CardView): CardView[] {
  return list.some((c) => c.id === task.id) ? list.map((c) => (c.id === task.id ? task : c)) : list;
}

export function SimpleBoard() {
  const route = useRoute();
  const { me, team, agents } = useStore();
  const now = useNow();
  const handle = me?.handle ?? null;
  const readOnly = me?.role === "observer";
  const members = team?.members;
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [teamTasks, setTeamTasks] = useState<CardView[]>([]);
  const [mineTasks, setMineTasks] = useState<CardView[]>([]);
  const [reviewTasks, setReviewTasks] = useState<CardView[]>([]);
  const [asks, setAsks] = useState<AskView[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answeredTick, setAnsweredTick] = useState(0);
  const answeredRef = useRef(new Set<string>());
  const returnTo = useRef<string | null>(null);
  const gen = useRef(0);

  function remember(task: CardView) {
    setTeamTasks((list) => replaceTask(list, task));
    setMineTasks((list) => replaceTask(list, task));
    setReviewTasks((list) => replaceTask(list, task));
    projectsStore.card(task);
  }

  function markAnswered(id: string) {
    answeredRef.current.add(id);
    setAnsweredTick((n) => n + 1);
  }

  function openCard(id: string) {
    returnTo.current = id;
    navigate({ view: "simple", card: id });
  }

  async function load(mode: "first" | "refresh") {
    const token = ++gen.current;
    if (mode === "first") {
      setPhase("loading");
      setError(null);
    } else {
      setRefreshing(true);
      setError(null);
    }
    try {
      const [proj, teamPage, minePage, reviewPage, askPage] = await Promise.all([
        api.projects(),
        api.tasks({ state: "open", limit: 500 }),
        api.tasks({ state: "open", assignee: "me", limit: 500 }),
        api.tasks({ state: "open", role: "review", limit: 500 }),
        api.asks(),
      ]);
      if (token !== gen.current) return;
      setProjects(proj.projects);
      setTeamTasks(teamPage.tasks);
      setMineTasks(minePage.tasks);
      setReviewTasks(reviewPage.tasks);
      setTruncated(teamPage.truncated || minePage.truncated || reviewPage.truncated);
      setAsks(askPage.asks);
      setPhase("ready");
      setError(null);
    } catch (err) {
      if (token !== gen.current) return;
      const message = friendlyError(err);
      if (mode === "first") {
        setProjects([]);
        setTeamTasks([]);
        setMineTasks([]);
        setReviewTasks([]);
        setAsks([]);
        setPhase("error");
      } else {
        setPhase("ready");
      }
      setError(message);
    } finally {
      if (token === gen.current) setRefreshing(false);
    }
  }

  useEffect(() => { void load("first"); }, []);

  const model = useMemo(
    () => partition(teamTasks, projects, handle, { mine: mineTasks, review: reviewTasks }),
    [teamTasks, mineTasks, reviewTasks, projects, handle],
  );
  const known = useMemo(() => {
    const map = new Map<string, CardView>();
    for (const card of [...mineTasks, ...reviewTasks, ...teamTasks]) map.set(card.id, card);
    return [...map.values()];
  }, [mineTasks, reviewTasks, teamTasks]);
  // answeredTick re-renders after a local answer. The ref is written first, so the ask is already
  // hidden if the route changes in the same turn, before this tick is committed.
  void answeredTick;
  const visibleAsks = asks.filter((ask) => askVisible(ask, handle, agents, now, model.needles, answeredRef.current));

  async function move(card: CardView, columnId: string) {
    if (busy || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await api.task(card.id);
      if (detail.card.column !== card.column) {
        setError(STALE);
        return;
      }
      const res = await api.updateTask(card.id, { column: columnId });
      remember(res.task);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const shared = { model, members, handle, busy, readOnly, error, onTask: remember, onMove: move };
  return (
    <main className="simple" aria-busy={phase === "loading" || refreshing}>
      {phase === "ready" && route.card ? (
        <CardRoute cardId={route.card} tasks={known} {...shared} />
      ) : phase === "ready" && route.ask ? (
        <AskRoute askId={route.ask} asks={asks} visibleAsks={visibleAsks} needles={model.needles} members={members} handle={handle} readOnly={readOnly} onAnswered={markAnswered} />
      ) : (
        <BoardList
          phase={phase} error={error} model={model} asks={visibleAsks} truncated={truncated} members={members} handle={handle}
          agents={agents} tasks={known} busy={busy} readOnly={readOnly} returnTo={returnTo} onOpen={openCard} onMove={move}
          onLoad={() => void load(phase === "ready" ? "refresh" : "first")}
        />
      )}
    </main>
  );
}

function BoardList({
  phase, error, model, asks, truncated, members, handle, agents, tasks, busy, readOnly, returnTo, onOpen, onMove, onLoad,
}: {
  phase: "loading" | "error" | "ready";
  error: string | null;
  model: SimpleModel;
  asks: AskView[];
  truncated: boolean;
  members: readonly MemberView[] | undefined;
  handle: string | null;
  agents: ReturnType<typeof useStore>["agents"];
  tasks: CardView[];
  busy: boolean;
  readOnly: boolean;
  returnTo: { current: string | null };
  onOpen: (id: string) => void;
  onMove: (card: CardView, columnId: string) => void;
  onLoad: () => void;
}) {
  const here = presence(agents, model.projects, (channel, n) => tasks.some((t) => t.channel === channel && t.n === n && t.state !== "deleted"));
  // Cleared here, not inside each block: the first block does not contain a card that lives in a later one.
  // When the card is gone from every list, leaving the marker set would focus it if a later refresh brings it back.
  useEffect(() => {
    if (phase !== "ready") return;
    const id = returnTo.current;
    if (!id) return;
    const listed = model.myWork.some((card) => card.id === id)
      || model.decisions.some((card) => card.id === id)
      || asks.some((ask) => ask.ask.id === id);
    if (!listed) returnTo.current = null;
  }, [phase, model, asks, returnTo]);
  return (
    <>
      <h1>Simple</h1>
      {phase === "ready" && error ? <p role="alert">{error}</p> : null}
      {phase === "ready" ? <button type="button" onClick={onLoad}>Refresh</button> : null}
      {truncated && phase === "ready" ? <p className="simple-note" role="note">Showing the latest 500. Some older work is not listed.</p> : null}
      {model.confidentialLeftOff && phase === "ready" ? <p className="simple-note" role="note">Work marked confidential is left off this page.</p> : null}
      {readOnly && phase === "ready" ? <p className="simple-note" role="note">{READ_ONLY}</p> : null}
      <Block
        name="my-work" heading="My work" phase={phase} error={error} loading="Loading your work…" onRetry={onLoad} returnTo={returnTo}
        rows={model.myWork.map((card) => rowFor(card, model, members, handle, busy, readOnly, onOpen, onMove))} empty="Nothing is assigned to you."
      />
      <Block
        name="decisions" heading="Needs your decision" phase={phase} error={error} loading="Loading decisions…" onRetry={onLoad} returnTo={returnTo}
        rows={[
          ...model.decisions.map((card) => rowFor(card, model, members, handle, busy, readOnly, onOpen, onMove)),
          ...asks.map((ask) => ({
            key: ask.ask.id,
            label: askRowLabel(plainText(askText(ask)), whoFromAuthor(ask.ask.author, handle, members)),
            open: () => {
              returnTo.current = ask.ask.id;
              navigate({ view: "simple", ask: ask.ask.id });
            },
          })),
        ]}
        empty="Nothing needs your decision."
      />
      <Block name="team" heading="Team status" phase={phase} error={error} loading="Loading team status…" onRetry={onLoad} returnTo={returnTo}>
        {model.projects.length === 0 ? <p>No projects yet.</p> : model.projects.map((project) => {
          const tally = model.counts.find((c) => c.channel === project.channel)?.counts;
          const lines = assistantLines(here.byProject.get(project.channel) ?? [], handle, members);
          return (
            <div key={project.channel}>
              <h3>{project.name}</h3>
              <ul>
                {STATUS_NAMES.map((status) => <li key={status}>{status} {tally?.[status] ?? 0}</li>)}
              </ul>
              {lines.length ? lines.map((line) => <p key={line}>{line}</p>) : <p>No assistants are working right now.</p>}
            </div>
          );
        })}
      </Block>
    </>
  );
}

function assistantLines(list: ReturnType<typeof useStore>["agents"], handle: string | null, members: readonly MemberView[] | undefined): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const one of list) {
    if (seen.has(one.id)) continue;
    seen.add(one.id);
    const verb = one.effective_state === "waiting" ? "is waiting." : one.effective_state === "blocked" ? "is stuck." : one.effective_state === "working" ? "is working." : null;
    if (!verb) continue;
    const who = one.handle === handle ? "Your assistant" : `${displayName(members as MemberView[] | undefined, one.handle)}'s assistant`;
    lines.push(`${who} ${verb}`);
  }
  return lines;
}

function duePhrase(due: string | null): string {
  const label = dueLabel(due);
  return label === "No due date" ? "no due date" : `due ${label}`;
}

function askRowLabel(text: string, who: string): string {
  if (!text) return who;
  return /[.?!]$/.test(text) ? `${text} From ${who}` : `${text}, from ${who}`;
}

function rowFor(
  card: CardView, model: SimpleModel, members: readonly MemberView[] | undefined, handle: string | null,
  busy: boolean, readOnly: boolean, onOpen: (id: string) => void, onMove: (card: CardView, columnId: string) => void,
) {
  const status = statusName(cardRole(card, model.projects)) ?? "To do";
  const label = `${plainText(card.title)}, ${status}, ${whoFromAddress(card.assignee, handle, members)}, ${duePhrase(card.due)}`;
  return {
    key: card.id,
    label,
    open: () => onOpen(card.id),
    extra: <MoveButtons card={card} projects={model.projects} busy={busy} readOnly={readOnly} onMove={(columnId) => onMove(card, columnId)} />,
  };
}

interface Row { key: string; label: string; open: () => void; extra?: ReactNode }

function cursorFor(rows: Row[] | undefined, returnTo: { current: string | null }): number {
  const id = returnTo.current;
  if (!id || !rows?.length) return 0;
  const i = rows.findIndex((row) => row.key === id);
  return i >= 0 ? i : 0;
}

function Block({ name, heading, phase, error, loading, onRetry, rows, empty, children, returnTo }: {
  name: string; heading: string; phase: "loading" | "error" | "ready"; error: string | null; loading: string; onRetry: () => void;
  rows?: Row[]; empty?: string; children?: ReactNode; returnTo: { current: string | null };
}) {
  const [cursor, setCursor] = useState(() => cursorFor(rows, returnTo));
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const list = rows ?? [];
  const safe = list.length ? Math.min(cursor, list.length - 1) : 0;
  useEffect(() => {
    if (phase !== "ready" || !rows?.length) return;
    const id = returnTo.current;
    if (!id) return;
    const i = rows.findIndex((row) => row.key === id);
    if (i < 0) return;
    const el = refs.current[i];
    if (!el || typeof el.focus !== "function") return;
    returnTo.current = null;
    setCursor(i);
    el.focus();
  }, [phase, rows, returnTo]);
  function focusAt(next: number) {
    if (!list.length) return;
    const i = Math.max(0, Math.min(next, list.length - 1));
    setCursor(i);
    const el = refs.current[i];
    if (el && typeof el.focus === "function") el.focus();
  }
  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (!rows) return;
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.getAttribute !== "function" || target.getAttribute("data-move") != null) return;
    const indexAttr = target.getAttribute("data-card-index");
    const from = indexAttr != null ? Number(indexAttr) : safe;
    if (Number.isNaN(from)) return;
    if (e.key === "ArrowDown") { e.preventDefault(); focusAt(from + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(from - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusAt(0); }
    else if (e.key === "End") { e.preventDefault(); focusAt(list.length - 1); }
    else if ((e.key === "Enter" || e.key === " ") && list.length) {
      e.preventDefault();
      list[indexAttr != null ? Number(indexAttr) : safe]?.open();
    }
  }
  return (
    <section className="simple-block" data-block={name} aria-labelledby={`simple-${name}`} aria-busy={phase === "loading"} onKeyDown={onKeyDown}>
      <h2 id={`simple-${name}`}>{heading}</h2>
      {phase === "loading" ? <p>{loading}</p> : null}
      {phase === "error" ? <><p role="alert">{error}</p><button type="button" onClick={onRetry}>Retry</button></> : null}
      {phase === "ready" && rows ? (
        list.length === 0 ? <p>{empty}</p> : (
          <div className="simple-items">
            <p className="sr-only">Use the arrow keys to move between cards. Press Enter to open one.</p>
            {list.map((row, i) => (
              <div className="simple-item" key={row.key}>
                <button
                  type="button" className="simple-card" data-card-index={i} data-card-id={row.key}
                  data-cursor={i === safe ? "true" : undefined} aria-label={row.label}
                  ref={(el) => { refs.current[i] = el; }} onClick={row.open}
                >{row.label}</button>
                {row.extra}
              </div>
            ))}
          </div>
        )
      ) : null}
      {phase === "ready" && !rows ? children : null}
    </section>
  );
}

function MoveButtons({ card, projects, busy, readOnly, onMove }: {
  card: CardView; projects: readonly ProjectView[]; busy: boolean; readOnly: boolean; onMove: (columnId: string) => void;
}) {
  if (readOnly) return null;
  const columns = boardColumns(card, projects);
  const current = statusName(cardRole(card, projects));
  const title = plainText(card.title);
  const labelId = `simple-move-${card.id}`;
  return (
    <div className="simple-moves" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="simple-move-label">Move to:</span>
      {STATUS_NAMES.map((status) => {
        const column = columnForStatus(columns, status);
        if (!column) return null;
        if (current === status) return <span key={status} className="simple-current">{status}, current</span>;
        return (
          <button
            key={status} type="button" data-move="true" disabled={busy}
            aria-label={`Move ${title} to ${status}`} onClick={() => onMove(column.id)}
          >{status}</button>
        );
      })}
    </div>
  );
}

function Hidden({ kind }: { kind: "confidential" | "unknown" }) {
  return (
    <>
      <button type="button" onClick={() => navigate({ view: "simple" })}>Back</button>
      <h1>Simple</h1>
      <p role="note">{kind === "confidential" ? "This work is marked confidential and stays off this page." : "That work is not on this page."}</p>
    </>
  );
}

function shownCard(tasks: readonly CardView[], projects: readonly ProjectView[], id: string): CardView | undefined {
  const card = tasks.find((c) => c.id === id);
  if (!card || !onSimplePage(card, projects)) return undefined;
  return card;
}

function CardRoute({ cardId, tasks, model, members, handle, busy, readOnly, error, onTask, onMove }: {
  cardId: string; tasks: readonly CardView[]; model: SimpleModel; members: readonly MemberView[] | undefined; handle: string | null;
  busy: boolean; readOnly: boolean; error: string | null; onTask: (task: CardView) => void; onMove: (card: CardView, columnId: string) => void;
}) {
  if (model.hiddenIds.has(cardId)) return <Hidden kind="confidential" />;
  const stored = shownCard(tasks, model.projects, cardId);
  if (!stored) return <Hidden kind="unknown" />;
  return <CardPage key={stored.id} card={stored} projects={model.projects} members={members} handle={handle} busy={busy} readOnly={readOnly} error={error} onTask={onTask} onMove={onMove} />;
}

function AskRoute({ askId, asks, visibleAsks, needles, members, handle, readOnly, onAnswered }: {
  askId: string; asks: AskView[]; visibleAsks: AskView[]; needles: SimpleModel["needles"];
  members: readonly MemberView[] | undefined; handle: string | null; readOnly: boolean; onAnswered: (id: string) => void;
}) {
  const found = asks.find((ask) => ask.ask.id === askId);
  if (!found) return <Hidden kind="unknown" />;
  if (quotesConfidential(askText(found), needles)) return <Hidden kind="confidential" />;
  if (!visibleAsks.some((ask) => ask.ask.id === askId)) return <Hidden kind="unknown" />;
  return <AskPage key={found.ask.id} ask={found} members={members} handle={handle} readOnly={readOnly} onAnswered={onAnswered} />;
}

function useDialogFocus(): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (node && typeof node.focus === "function") node.focus();
  }, []);
  return ref;
}

function CardPage({ card, projects, members, handle, busy, readOnly, error, onTask, onMove }: {
  card: CardView; projects: readonly ProjectView[]; members: readonly MemberView[] | undefined; handle: string | null;
  busy: boolean; readOnly: boolean; error: string | null; onTask: (task: CardView) => void; onMove: (card: CardView, columnId: string) => void;
}) {
  const status = statusName(cardRole(card, projects)) ?? "To do";
  const who = whoFromAddress(card.assignee, handle, members);
  const reviewer = card.reviewer ? whoFromAddress(card.reviewer, handle, members) : null;
  const [form, setForm] = useState<null | "changes" | "question">(null);
  const [draft, setDraft] = useState("");
  const [banner, setBanner] = useState<null | { kind: "alert" | "status"; text: string }>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const working = localBusy || busy;
  const columns = boardColumns(card, projects);
  const [act, setAct] = useState<{ phase: "loading" | "ready" | "error"; lines: string[]; message: string }>({ phase: "loading", lines: [], message: "" });
  const [tick, setTick] = useState(0);
  const canApprove = needsYourDecision(card, projects, handle);
  const due = dueLabel(card.due);

  useEffect(() => {
    let cancel = false;
    setAct({ phase: "loading", lines: [], message: "" });
    api.task(card.id).then((detail) => {
      if (cancel) return;
      setAct({ phase: "ready", lines: activityLines(detail.timeline ?? [], columns, handle, members), message: "" });
    }).catch((err: unknown) => {
      if (cancel) return;
      setAct({ phase: "error", lines: [], message: friendlyError(err) });
    });
    return () => { cancel = true; };
  }, [card.id, tick]);

  async function approve() {
    if (working || readOnly || status === "Done") return;
    setLocalBusy(true);
    setBanner(null);
    let saved: CardView | null = null;
    try {
      const detail = await api.task(card.id);
      if (detail.card.column !== card.column) {
        setBanner({ kind: "alert", text: STALE });
        return;
      }
      const commented = await api.commentTask(card.id, "Approved.");
      saved = commented.task;
      const done = await api.taskDone(card.id);
      onTask(done.task);
      setBanner({ kind: "status", text: "Approved." });
    } catch (err) {
      if (saved) {
        onTask(saved);
        setBanner({ kind: "alert", text: "The approval was saved, but the status did not change." });
      } else {
        setBanner({ kind: "alert", text: friendlyError(err) });
      }
    } finally {
      setLocalBusy(false);
    }
  }

  async function send() {
    const text = draft.trim().slice(0, MAX_NOTE);
    if (!text) {
      setBanner({ kind: "alert", text: form === "question" ? "Write your question." : "Write what needs to change." });
      return;
    }
    if (working || readOnly) return;
    setLocalBusy(true);
    setBanner(null);
    try {
      if (form === "question") {
        const commented = await api.commentTask(card.id, text);
        onTask(commented.task);
        setDraft("");
        setForm(null);
        setBanner({ kind: "status", text: "Your question was posted." });
        return;
      }
      const commented = await api.commentTask(card.id, `Needs changes: ${text}`);
      let next = commented.task;
      const target = columnForStatus(columns, "Working on");
      if (target && status !== "Working on" && card.column !== target.id) {
        try {
          const detail = await api.task(card.id);
          if (detail.card.column !== card.column) {
            onTask(next);
            setDraft("");
            setForm(null);
            setBanner({ kind: "alert", text: STALE });
            return;
          }
          next = (await api.updateTask(card.id, { column: target.id })).task;
        } catch {
          onTask(next);
          setDraft("");
          setForm(null);
          setBanner({ kind: "alert", text: "The note was saved, but the status did not change." });
          return;
        }
      }
      onTask(next);
      setDraft("");
      setForm(null);
      setBanner({ kind: "status", text: "Your note was saved." });
    } catch (err) {
      setBanner({ kind: "alert", text: friendlyError(err) });
    } finally {
      setLocalBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    navigate({ view: "simple" });
  }
  const dialogRef = useDialogFocus();

  return (
    <div role="dialog" aria-labelledby="simple-detail-title" tabIndex={-1} ref={dialogRef} onKeyDown={onKeyDown}>
      <button type="button" onClick={() => navigate({ view: "simple" })}>Back</button>
      <h1 id="simple-detail-title">{plainText(card.title)}</h1>
      <p>Status: {status}</p>
      <p>Who: {who}</p>
      {reviewer ? <p>Reviewer: {reviewer}</p> : null}
      <p>{due === "No due date" ? "No due date" : `Due date: ${due}`}</p>
      {card.blocked ? <p>{card.blocked_reason ? `Waiting: ${plainText(card.blocked_reason)}` : "Waiting on something else."}</p> : null}
      <h2>Activity</h2>
      {act.phase === "loading" ? <p>Loading activity…</p> : null}
      {act.phase === "error" ? <><p role="alert">{act.message}</p><button type="button" onClick={() => setTick((n) => n + 1)}>Retry</button></> : null}
      {act.phase === "ready" && act.lines.length === 0 ? <p>No activity yet.</p> : null}
      {act.phase === "ready" && act.lines.length > 0 ? <ul>{act.lines.map((line) => <li key={line}>{line}</li>)}</ul> : null}
      {readOnly ? <p className="simple-note" role="note">{READ_ONLY}</p> : (
        <>
          <MoveButtons card={card} projects={projects} busy={working} readOnly={false} onMove={(columnId) => onMove(card, columnId)} />
          <h2>Your decision</h2>
          <div className="simple-actions">
            {canApprove ? <button type="button" onClick={() => void approve()} disabled={working}>Approve</button> : null}
            <button type="button" onClick={() => { setForm("changes"); setDraft(""); setBanner(null); }} disabled={working}>Needs changes</button>
            <button type="button" onClick={() => { setForm("question"); setDraft(""); setBanner(null); }} disabled={working}>Ask a question</button>
          </div>
        </>
      )}
      {form && !readOnly ? (
        <div className="simple-form">
          <label>
            {form === "question" ? "Your question" : "What needs to change?"}
            <textarea value={draft} maxLength={MAX_NOTE} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <p className="sr-only">2,000 characters at most.</p>
          {form === "question" ? <p>This posts your question on the work.</p> : null}
          <button type="button" onClick={() => void send()} disabled={working}>Send</button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {banner ? <p role={banner.kind}>{banner.text}</p> : null}
    </div>
  );
}

function AskPage({ ask, members, handle, readOnly, onAnswered }: {
  ask: AskView; members: readonly MemberView[] | undefined; handle: string | null; readOnly: boolean; onAnswered: (id: string) => void;
}) {
  const { applyEvents } = useActions();
  const [form, setForm] = useState<null | "changes" | "question">(null);
  const [draft, setDraft] = useState("");
  const [banner, setBanner] = useState<null | { kind: "alert" | "status"; text: string }>(null);
  const [busy, setBusy] = useState(false);
  const text = plainText(askText(ask));
  const who = whoFromAuthor(ask.ask.author, handle, members);

  async function answer(body: string) {
    if (busy || readOnly) return;
    setBusy(true);
    setBanner(null);
    try {
      const res = await api.answer({ ask: ask.ask.id, text: body });
      if (res.event) applyEvents([res.event]);
      onAnswered(ask.ask.id);
      navigate({ view: "simple" });
    } catch (err) {
      setBanner({ kind: "alert", text: friendlyError(err) });
      setBusy(false);
    }
  }

  async function send() {
    const note = draft.trim().slice(0, MAX_NOTE);
    if (!note) {
      setBanner({ kind: "alert", text: form === "question" ? "Write your question." : "Write what needs to change." });
      return;
    }
    await answer(form === "question" ? note : `Needs changes: ${note}`);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    navigate({ view: "simple" });
  }
  const dialogRef = useDialogFocus();

  return (
    <div role="dialog" aria-labelledby="simple-detail-title" tabIndex={-1} ref={dialogRef} onKeyDown={onKeyDown}>
      <button type="button" onClick={() => navigate({ view: "simple" })}>Back</button>
      <h1 id="simple-detail-title">{text}</h1>
      <p>From {who}</p>
      {readOnly ? <p className="simple-note" role="note">{READ_ONLY}</p> : (
        <div className="simple-actions">
          <button type="button" onClick={() => void answer("Approved")} disabled={busy}>Approve</button>
          <button type="button" onClick={() => { setForm("changes"); setDraft(""); setBanner(null); }} disabled={busy}>Needs changes</button>
          <button type="button" onClick={() => { setForm("question"); setDraft(""); setBanner(null); }} disabled={busy}>Ask a question</button>
        </div>
      )}
      {form && !readOnly ? (
        <div className="simple-form">
          <label>
            {form === "question" ? "Your question" : "What needs to change?"}
            <textarea value={draft} maxLength={MAX_NOTE} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <p className="sr-only">2,000 characters at most.</p>
          {form === "question" ? <p>This sends your question as the answer.</p> : null}
          <button type="button" onClick={() => void send()} disabled={busy}>Send</button>
        </div>
      ) : null}
      {banner ? <p role={banner.kind}>{banner.text}</p> : null}
    </div>
  );
}
