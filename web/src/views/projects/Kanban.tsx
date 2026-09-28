// The board's columns and cards (WALKIE-PROJECTS-1). Props in, callbacks out: the container (ProjectBoard.tsx) owns
// data and writes. Drag and drop is plain pointer events (no library): a card follows the pointer once it moved 5 px,
// the column under the pointer and the gap between its cards decide where it lands.
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Ban, Check, Paperclip, Plus } from "lucide-react";
import type { AgentView, CardView, Column } from "../../api/types.ts";
import { Avatar, hueVar } from "../../components/primitives.tsx";
import { tagHue } from "../../lib/format.ts";
import { stuck, type Focus } from "../../lib/projects.ts";
import { AgentFaces } from "./ProjectList.tsx";
import { draggedFiles } from "./RoomUpload.tsx";

export interface KanbanColumn { column: Column; cards: CardView[]; total: number }

export interface KanbanProps {
  columns: KanbanColumn[];
  byCard: ReadonlyMap<string, AgentView[]>;
  focus: Focus | null;
  selected: ReadonlySet<string>;
  openCard: string | null;
  composerFor: string | null;
  phoneCol: number;
  onPhoneCol: (i: number) => void;
  onOpen: (card: CardView) => void;
  onMove: (card: CardView, column: string, index: number) => void;
  onCompose: (column: string | null) => void;
  onCreate: (column: string, title: string) => Promise<boolean>;
  onFocus: (f: Focus) => void;
  /** Live Data Room files attached per card id (DATA-ROOM-1). */
  attached?: ReadonlyMap<string, number>;
  /** Files dropped on a card: added to the Data Room and attached to it. */
  onCardFiles?: (card: CardView, files: File[]) => void;
}

function handleOf(addr: string): string { return addr.slice(1).split("/")[0] ?? "?"; }

export function CardFace({ card, agents, focused, selected, dragging, open, onPointerDown, onClick, files, onFiles }: {
  card: CardView; agents: AgentView[] | undefined; focused?: boolean; selected?: boolean; dragging?: boolean; open?: boolean;
  onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void; onClick?: () => void;
  /** Attached Data Room files. */
  files?: number;
  /** A file dropped on the card (HTML drag and drop, separate from the pointer-driven card moves). */
  onFiles?: (files: File[]) => void;
}) {
  const [fileOver, setFileOver] = useState(false);
  const isStuck = stuck(card, agents);
  const cls = ["kcard", focused ? "is-focus" : "", selected ? "is-selected" : "", dragging ? "is-dragging" : "", isStuck ? "is-stuck" : "", open ? "is-open" : "", fileOver ? "is-filedrop" : ""].filter(Boolean).join(" ");
  const drop = onFiles ? {
    onDragOver: (e: ReactDragEvent) => { if (draggedFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setFileOver(true); } },
    onDragLeave: () => setFileOver(false),
    onDrop: (e: ReactDragEvent) => { if (!draggedFiles(e)) return; e.preventDefault(); e.stopPropagation(); setFileOver(false); onFiles([...e.dataTransfer.files]); },
  } : {};
  const assignee = card.assignee;
  const agentAssignee = assignee && assignee.split("/").length === 3;
  return (
    <article className={cls} data-card={card.id} aria-selected={selected || undefined} onPointerDown={onPointerDown} {...drop}>
      <button type="button" className="kcard-hit" onClick={onClick} aria-label={`${card.key}: ${card.title}${isStuck ? " (stuck)" : ""}`} />
      <div className="kcard-top">
        <span className="kcard-key mono">{card.key}</span>
        {isStuck && <span className="stuck-badge" title={card.blocked_reason ?? "An agent on it is stuck or waiting on a person"}><Ban size={11} strokeWidth={2.25} aria-hidden="true" />Stuck</span>}
        {selected && <Check size={13} strokeWidth={2.5} className="kcard-check" aria-hidden="true" />}
      </div>
      <p className="kcard-title">{card.title}</p>
      {(card.labels.length > 0 || assignee || agents?.length || card.estimate !== null || card.due || !!files) && (
        <div className="kcard-foot">
          {card.labels.slice(0, 3).map((l) => <span key={l} className="chip kcard-label" style={hueVar("--th", tagHue(l))}>{l}</span>)}
          {card.estimate !== null && <span className="chip mono">{card.estimate}</span>}
          {card.due && <span className="chip mono">{card.due.slice(5)}</span>}
          {!!files && <span className="kcard-files tnum" title={`${files} file${files === 1 ? "" : "s"} from the Data Room`}><Paperclip size={11} strokeWidth={2} aria-hidden="true" />{files}</span>}
          <span className="kcard-spacer" />
          <AgentFaces agents={agents} max={3} />
          {assignee && !agentAssignee && <span className="kcard-assignee" title={`Assigned to ${assignee}`}><Avatar handle={handleOf(assignee)} name={handleOf(assignee)} size={20} /></span>}
          {assignee && agentAssignee && !agents?.length && <span className="kcard-assignee kcard-agent mono" title={`Assigned to ${assignee}`}>{assignee.split("/")[2]}</span>}
        </div>
      )}
    </article>
  );
}

function Composer({ column, onCreate, onCancel }: { column: string; onCreate: KanbanProps["onCreate"]; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await onCreate(column, t);
    setBusy(false);
    if (ok) setTitle("");
  };
  return (
    <div className="kcompose">
      <textarea
        ref={ref} className="textarea" rows={2} maxLength={200} value={title} placeholder="Card title" aria-label="New card title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
      />
      <div className="kcompose-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={!title.trim() || busy} onClick={() => void submit()}>{busy ? "Adding…" : "Add card"}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** While a board's cards load: the board's shape (tinted columns with a few card outlines), not a blank page. */
export function KanbanSkeleton() {
  const roles = ["backlog", "todo", "active", "review", "done"] as const;
  return (
    <div className="kanban kanban-skeleton" aria-busy="true" aria-label="Loading the board">
      {roles.map((r, i) => (
        <div key={r} className={`kcol role-${r}${r === "active" ? " is-phone-on" : ""}`} aria-hidden="true">
          <div className="kcol-head"><span className="skeleton" style={{ width: 72 + ((i * 23) % 30), height: 10 }} /></div>
          <div className="kcol-body">
            {Array.from({ length: 3 - (i % 2) }, (_, j) => (
              <div key={j} className="kcard kcard-ghost">
                <span className="skeleton" style={{ width: 44, height: 8 }} />
                <span className="skeleton" style={{ width: `${62 + ((i * 17 + j * 11) % 30)}%`, height: 10 }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface Drag { id: string; x0: number; y0: number; active: boolean }
interface Target { col: string | null; index: number; x: number; y: number }

/** The gap under the pointer: how many of the column's other cards have their middle above it. */
function indexAt(colEl: Element, y: number, self: string): number {
  let n = 0;
  for (const el of colEl.querySelectorAll("[data-card]")) {
    if ((el as HTMLElement).dataset.card === self) continue;
    const r = el.getBoundingClientRect();
    if (r.top + r.height / 2 < y) n++;
  }
  return n;
}

export function Kanban(p: KanbanProps) {
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [target, setTargetState] = useState<(Target & { id: string }) | null>(null);
  const targetRef = useRef<(Target & { id: string }) | null>(null);
  const setTarget = (t: (Target & { id: string }) | null) => { targetRef.current = t; setTargetState(t); };
  const all = p.columns.flatMap((c) => c.cards);
  const dragged = target ? all.find((c) => c.id === target.id) : undefined;

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.active && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
      d.active = true;
      const colEl = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-col]") ?? null;
      const col = colEl ? (colEl as HTMLElement).dataset.col ?? null : null;
      setTarget({ id: d.id, col, index: colEl ? indexAt(colEl, e.clientY, d.id) : 0, x: e.clientX, y: e.clientY });
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (!d?.active) return;
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      const t = targetRef.current;
      setTarget(null);
      const card = all.find((c) => c.id === d.id);
      if (t?.col && card) p.onMove(card, t.col, t.index);
    };
    const cancel = (e: KeyboardEvent) => { if (e.key === "Escape" && drag.current) { drag.current = null; setTarget(null); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", cancel);
    };
  });

  const down = (card: CardView) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || e.pointerType === "touch") return; // phones move cards from the drawer's "Move to"
    drag.current = { id: card.id, x0: e.clientX, y0: e.clientY, active: false };
  };

  return (
    <>
      <div className="kcol-tabs" role="tablist" aria-label="Columns">
        {p.columns.map((c, i) => (
          <button key={c.column.id} type="button" role="tab" aria-selected={i === p.phoneCol} className={`kcol-tab role-${c.column.role}${i === p.phoneCol ? " is-on" : ""}`} onClick={() => p.onPhoneCol(i)}>
            {c.column.name}<span className="tnum muted">{c.total}</span>
          </button>
        ))}
      </div>
      <div className={target ? "kanban is-dragging" : "kanban"}>
        {p.columns.map((c, ci) => {
          const over = c.column.wip !== undefined && c.total > c.column.wip;
          const dropHere = target?.col === c.column.id;
          const list = c.cards.filter((x) => x.id !== target?.id || !dropHere);
          return (
            <section key={c.column.id} className={`kcol role-${c.column.role}${ci === p.phoneCol ? " is-phone-on" : ""}${dropHere ? " is-drop" : ""}`} data-col={c.column.id} aria-label={c.column.name}>
              <header className="kcol-head">
                <span className="kcol-name">{c.column.name}</span>
                <span className={`kcol-count tnum${over ? " is-over" : ""}`} title={c.column.wip ? `Work-in-progress limit ${c.column.wip}` : undefined}>
                  {c.cards.length !== c.total ? `${c.cards.length} of ${c.total}` : c.total}{c.column.wip ? `/${c.column.wip}` : ""}
                </span>
                <button type="button" className="btn btn-ghost btn-icon btn-sm kcol-add" aria-label={`Add a card to ${c.column.name}`} onClick={() => p.onCompose(c.column.id)}><Plus size={14} strokeWidth={2} /></button>
              </header>
              <div className="kcol-body">
                {list.map((card, ri) => (
                  <div key={card.id} className="kslot">
                    {dropHere && target?.index === ri && <div className="kdrop" aria-hidden="true" />}
                    <CardFace
                      card={card} agents={p.byCard.get(card.key)}
                      focused={p.focus?.col === ci && p.focus.row === ri} selected={p.selected.has(card.id)}
                      dragging={target?.id === card.id} open={p.openCard === card.id}
                      onPointerDown={down(card)} files={p.attached?.get(card.id)}
                      {...(p.onCardFiles ? { onFiles: (fs: File[]) => p.onCardFiles?.(card, fs) } : {})}
                      onClick={() => { if (suppressClick.current) return; p.onFocus({ col: ci, row: ri }); p.onOpen(card); }}
                    />
                  </div>
                ))}
                {dropHere && (target?.index ?? 0) >= list.length && <div className="kdrop" aria-hidden="true" />}
                {!c.cards.length && !dropHere && p.composerFor !== c.column.id && <p className="kcol-empty">{c.total ? "No cards match the filter" : "No cards"}</p>}
                {p.composerFor === c.column.id
                  ? <Composer column={c.column.id} onCreate={p.onCreate} onCancel={() => p.onCompose(null)} />
                  : <button type="button" className="kcol-new" onClick={() => p.onCompose(c.column.id)}><Plus size={13} strokeWidth={2} />Add card</button>}
              </div>
            </section>
          );
        })}
      </div>
      {target && dragged && (
        <div className="kghost" style={{ transform: `translate(${target.x + 8}px, ${target.y + 8}px)` }} aria-hidden="true">
          <CardFace card={dragged} agents={p.byCard.get(dragged.key)} />
        </div>
      )}
    </>
  );
}
