// A card's drawer (WALKIE-PROJECTS-1): every field editable, "Move to" (the phone's way to move a card), the agents on
// it, open asks that name it, and its signed history: every op (ignored ones flagged, with why) and the comments.
import { useEffect, useRef, useState } from "react";
import { Ban, Download, Paperclip, Pin, Trash2, Unlink, Upload, X } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { AgentView, CardView, ProjectView, TimelineEntry } from "../../api/types.ts";
import { AskAnswer } from "../../components/AskAnswer.tsx";
import { ErrorState, RelTime, SkeletonRows } from "../../components/primitives.tsx";
import { agentAddress, canAnswer } from "../../lib/format.ts";
import { assignees } from "../../lib/projects.ts";
import { useNow } from "../../lib/time.ts";
import { projectsStore, useProjects } from "../../state/projects.ts";
import { bytes } from "../../lib/format.ts";
import { hrefFor } from "../../lib/route.ts";
import { draggedFiles, useRoomUpload } from "./RoomUpload.tsx";
import { useStore } from "../../state/store.tsx";
import { AgentFaces } from "./ProjectList.tsx";

const IGNORED: Record<string, string> = {
  person_only: "only a person can delete or restore a card",
  person_card: "an agent can't move or reassign a person's card",
  waiting_for_parent: "waiting for the change it builds on to arrive",
  not_admin: "only the project's creator or an owner can change settings",
  unknown_board: "that board doesn't exist",
};

function who(a: TimelineEntry["author"]): string {
  return `@${a.handle}${a.agent ? `/${a.agent}` : ""}`;
}

function describe(t: TimelineEntry, project: ProjectView): string {
  if (t.kind === "create") return "created the card";
  const c = t.changes ?? {};
  const parts: string[] = [];
  const board = project.boards.find((b) => b.id === (typeof c.board === "string" ? c.board : undefined));
  const cols = project.boards.flatMap((b) => b.columns);
  if (typeof c.column === "string") parts.push(`moved to ${cols.find((x) => x.id === c.column)?.name ?? c.column}${board ? ` (${board.name})` : ""}`);
  else if (c.pos !== undefined) parts.push("reordered");
  if (c.assignee !== undefined) parts.push(c.assignee ? `assigned ${String(c.assignee)}` : "unassigned");
  if (c.reviewer !== undefined) parts.push(c.reviewer ? `asked ${String(c.reviewer)} to review` : "cleared the reviewer");
  if (typeof c.title === "string") parts.push(`renamed to “${c.title}”`);
  if (c.body !== undefined) parts.push("edited the description");
  if (Array.isArray(c.labels)) parts.push(`labels: ${(c.labels as string[]).join(", ") || "none"}`);
  if (c.estimate !== undefined) parts.push(c.estimate === null ? "cleared the estimate" : `estimate ${String(c.estimate)}`);
  if (c.due !== undefined) parts.push(c.due ? `due ${String(c.due)}` : "cleared the due date");
  if (c.blocked === true) parts.push(`marked blocked${c.blocked_reason ? `: ${String(c.blocked_reason)}` : ""}`);
  if (c.blocked === false) parts.push("unblocked");
  if (typeof c.state === "string") parts.push(c.state === "open" ? "restored" : String(c.state));
  return parts.join(", ") || "changed";
}

export function CardDrawer({ card, project, onClose, byCard }: {
  card: CardView; project: ProjectView; onClose: () => void; byCard: ReadonlyMap<string, AgentView[]>;
}) {
  const { team, agents, asks, me } = useStore();
  const now = useNow();
  const [detail, setDetail] = useState<{ timeline: TimelineEntry[]; agents: AgentView[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [labels, setLabels] = useState(card.labels.join(", "));
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState(card.blocked_reason ?? "");
  const closeRef = useRef<HTMLButtonElement>(null);
  const board = project.boards.find((b) => b.id === card.board) ?? project.boards[0];

  const load = () => {
    setLoadError(null);
    api.task(card.id).then((d) => setDetail({ timeline: d.timeline, agents: d.agents })).catch((err) => setLoadError(friendlyError(err)));
  };
  useEffect(load, [card.id, card.rev, card.comments]);
  useEffect(() => { setTitle(card.title); setBody(card.body); setLabels(card.labels.join(", ")); setReason(card.blocked_reason ?? ""); }, [card.id, card.rev]);
  useEffect(() => {
    const prev = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); (prev as HTMLElement | null)?.focus?.(); };
  }, [card.id]);

  const save = async (fields: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const { task } = await api.updateTask(card.id, fields);
      projectsStore.card(task);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    const t = comment.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      const { task } = await api.commentTask(card.id, t);
      projectsStore.card(task);
      setComment("");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const people = assignees(team?.members ?? [], agents);
  const openAsks = asks.filter((a) => a.state === "open" && String((a.ask.body as { text?: string }).text ?? "").includes(card.key) && canAnswer(a, me?.handle ?? null, agents, now));
  const onIt = detail?.agents.length ? detail.agents : byCard.get(card.key) ?? [];

  return (
    <div className="drawer-layer">
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer card-drawer" role="dialog" aria-modal="true" aria-labelledby="card-title">
        <header className="drawer-head">
          <div className="drawer-head-text">
            <div className="drawer-kicker">
              <span className="mono">{card.key}</span>
              <span className="muted truncate">{project.name}{board ? ` / ${board.name}` : ""}</span>
            </div>
            <input
              id="card-title" className="drawer-title card-title-input" value={title} maxLength={200} aria-label="Title"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => { if (title.trim() && title.trim() !== card.title) void save({ title: title.trim() }); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
          </div>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close card">
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="drawer-body">
          {card.state !== "open" && <p className="card-state-note">This card is {card.state}.</p>}
          <div className="card-fields">
            <label className="field">
              <span className="field-label">Move to</span>
              <select className="select" value={card.column} disabled={busy} onChange={(e) => void save({ column: e.target.value })}>
                {board?.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            {project.boards.length > 1 && (
              <label className="field">
                <span className="field-label">Board</span>
                <select className="select" value={card.board} disabled={busy} onChange={(e) => void save({ board: e.target.value })}>
                  {project.boards.filter((b) => b.state === "active" || b.id === card.board).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            )}
            <label className="field">
              <span className="field-label">Assignee</span>
              <select className="select mono" value={card.assignee ?? ""} disabled={busy} onChange={(e) => void save({ assignee: e.target.value || null })}>
                <option value="">Unassigned</option>
                {[...new Set([...(card.assignee ? [card.assignee] : []), ...people])].map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Estimate</span>
              <input className="input tnum" type="number" min={0} max={1000} defaultValue={card.estimate ?? ""} key={`e${card.rev}`}
                onBlur={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); if (v !== card.estimate && (v === null || Number.isInteger(v))) void save({ estimate: v }); }} />
            </label>
            <label className="field">
              <span className="field-label">Due</span>
              <input className="input tnum" type="date" defaultValue={card.due ?? ""} key={`d${card.rev}`}
                onChange={(e) => { const v = e.target.value || null; if (v !== card.due) void save({ due: v }); }} />
            </label>
            <label className="field">
              <span className="field-label">Labels</span>
              <input className="input" value={labels} placeholder="design, p1" onChange={(e) => setLabels(e.target.value)}
                onBlur={() => { const next = labels.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10); if (next.join(",") !== card.labels.join(",")) void save({ labels: next }); }} />
            </label>
          </div>

          <div className="drawer-section">
            <h3 className="drawer-h">Description</h3>
            <textarea className="textarea card-body" rows={5} value={body} maxLength={16_000} placeholder="What needs doing, links, acceptance criteria" onChange={(e) => setBody(e.target.value)} />
            {body !== card.body && <div className="card-actions"><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save({ body })}>Save description</button></div>}
          </div>

          <CardFiles card={card} project={project} />

          <div className="drawer-section">
            <h3 className="drawer-h">Blocked</h3>
            <div className="card-block">
              <input className="input" value={reason} maxLength={300} placeholder="What it's waiting on" onChange={(e) => setReason(e.target.value)} />
              {card.blocked
                ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save({ blocked: false, blocked_reason: null })}>Unblock</button>
                : <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save({ blocked: true, blocked_reason: reason.trim() || null })}><Ban size={13} strokeWidth={2} />Mark blocked</button>}
            </div>
          </div>

          <div className="drawer-section">
            <h3 className="drawer-h">Agents on it</h3>
            {onIt.length ? (
              <ul className="card-agents">
                {onIt.map((a) => (
                  <li key={a.id}><AgentFaces agents={[a]} max={1} /><span className="mono truncate">{agentAddress(a)}</span><span className={`muted state-text-${a.effective_state}`}>{a.effective_state}</span></li>
                ))}
              </ul>
            ) : <p className="muted">No agent reports working on {card.key}. An agent joins it with walkie_task_start or a branch named after the key.</p>}
          </div>

          {openAsks.length > 0 && (
            <div className="drawer-section">
              <h3 className="drawer-h">Open asks about {card.key}</h3>
              {openAsks.map((a) => (
                <div key={a.ask.id} className="card-ask">
                  <p>{String((a.ask.body as { text?: string }).text ?? "")}</p>
                  <AskAnswer view={a} />
                </div>
              ))}
            </div>
          )}

          <div className="drawer-section">
            <h3 className="drawer-h">History and comments</h3>
            {loadError ? <ErrorState compact message={loadError} onRetry={load} /> : !detail ? <SkeletonRows rows={3} /> : (
              <ol className="card-timeline">
                {detail.timeline.map((t) => (
                  <li key={t.id} className={`ctl ctl-${t.kind}${t.ignored ? " is-ignored" : ""}`}>
                    <div className="ctl-top">
                      <span className="mono">{who(t.author)}</span>
                      <RelTime ts={t.ts} className="muted" />
                    </div>
                    {t.kind === "comment" ? <p className="ctl-text">{t.text}</p> : <p className="ctl-op">{describe(t, project)}</p>}
                    {t.ignored && <p className="ctl-ignored">Not applied: {IGNORED[t.ignored] ?? t.ignored}</p>}
                  </li>
                ))}
              </ol>
            )}
            <div className="card-comment">
              <textarea className="textarea" rows={2} value={comment} maxLength={16_000} placeholder="Comment (everyone on the project sees it)" aria-label="Comment"
                onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }} />
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || !comment.trim()} onClick={() => void send()}>Comment</button>
            </div>
          </div>

          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="drawer-section card-danger">
            {card.state === "deleted"
              ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save({ state: "open" })}>Restore card</button>
              : <>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save({ state: card.state === "archived" ? "open" : "archived" })}>{card.state === "archived" ? "Unarchive" : "Archive"}</button>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => { if (window.confirm(`Delete ${card.key}? It stays in the signed history and can be restored.`)) void save({ state: "deleted" }); }}><Trash2 size={13} strokeWidth={2} />Delete</button>
              </>}
          </div>
        </div>
      </aside>
    </div>
  );
}

/**
 * The card's files (DATA-ROOM-1): Data Room files attached to it. Drop files here (or choose) to add them to the room
 * and attach them; attach one already in the room; detach (the file stays in the room).
 */
function CardFiles({ card, project }: { card: CardView; project: ProjectView }) {
  const s = useProjects();
  const files = s.rooms[project.channel];
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { upload, busy, notice } = useRoomUpload(project.channel);
  useEffect(() => { if (!files) void projectsStore.loadRoom(project.channel); }, [project.channel]);
  const live = (files ?? []).filter((f) => f.state === "active");
  const mine = live.filter((f) => f.cards.includes(card.id));
  const others = live.filter((f) => !f.cards.includes(card.id));
  const change = async (id: string, body: { attach?: string[]; detach?: string[] }) => {
    setError(null);
    try { projectsStore.roomFile((await api.roomChange(project.channel, id, body)).file); } catch (err) { setError(friendlyError(err)); }
  };
  return (
    <div
      className={`drawer-section card-files${over ? " is-drop" : ""}`}
      onDragOver={(e) => { if (draggedFiles(e)) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { if (!draggedFiles(e)) return; e.preventDefault(); setOver(false); void upload([...e.dataTransfer.files], card.id); }}
    >
      <h3 className="drawer-h">
        Files <a className="muted card-files-room" href={hrefFor({ view: "projects", channel: project.channel, room: true })}>Data Room</a>
      </h3>
      {mine.length > 0 && (
        <ul className="card-file-list">
          {mine.map((f) => (
            <li key={f.id}>
              <Paperclip size={13} strokeWidth={1.8} aria-hidden="true" />
              <span className="mono truncate card-file-name">{f.pinned && <Pin size={11} strokeWidth={2.2} className="room-pin" aria-label="Pinned" />}{f.name}</span>
              <span className="muted tnum">v{f.version} · {bytes(f.size)}</span>
              <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Download ${f.name}`} onClick={() => void api.roomDownload(project.channel, f.id, f.name).catch((err) => setError(friendlyError(err)))}><Download size={13} strokeWidth={1.75} /></button>
              <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Detach ${f.name} from ${card.key}`} title="Detach (the file stays in the Data Room)" onClick={() => void change(f.id, { detach: [card.id] })}><Unlink size={13} strokeWidth={1.75} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="card-file-drop">
        <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>{busy ? "Uploading…" : "Drop files here to add them to the Data Room and attach them, or"}</span>
        <input ref={input} type="file" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void upload(fs, card.id); }} />
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>choose files</button>
        {others.length > 0 && (
          <select className="select card-file-attach" aria-label="Attach a file from the Data Room" value="" onChange={(e) => { if (e.target.value) void change(e.target.value, { attach: [card.id] }); }}>
            <option value="">Attach from the Data Room…</option>
            {others.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
      </div>
      {notice}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}
