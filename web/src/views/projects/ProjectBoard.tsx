// One project's board (WALKIE-PROJECTS-1): header (meter, boards, export, settings), filters, the columns, and the
// card drawer. Keyboard first: j/k h/l move, Enter opens, Space previews, c new card, m then 1–9 moves (the selection
// with x, or the focused card), a assigns to me, e edits the title, Esc clears. Everything goes through the daemon.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Download, FolderOpen, Lock, Plus, Settings } from "lucide-react";
import { api, friendlyError, planLimitOf } from "../../api/client.ts";
import type { CardView, PlanLimitDetails, ProjectView, RoomFileView } from "../../api/types.ts";
import { PlanLimitNotice } from "../../components/PlanLimitNotice.tsx";
import { ErrorState, hueVar } from "../../components/primitives.tsx";
import { tagHue } from "../../lib/format.ts";
import { isTyping } from "../../lib/hotkeys.ts";
import { columnsOf, dropTarget, isMe, moveFocus, NO_FILTERS, presence, type Filters, type Focus } from "../../lib/projects.ts";
import { hrefFor, navigate } from "../../lib/route.ts";
import { projectsStore, useProjects } from "../../state/projects.ts";
import { useStore } from "../../state/store.tsx";
import { CardDrawer } from "./CardDrawer.tsx";
import { DataRoom } from "./DataRoom.tsx";
import { useRoomUpload } from "./RoomUpload.tsx";
import { Kanban, KanbanSkeleton } from "./Kanban.tsx";
import { Meter } from "./Meter.tsx";
import { AgentFaces } from "./ProjectList.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";

export function ProjectBoard({ channel, boardId, cardId, room }: { channel: string; boardId?: string; cardId?: string; room?: boolean }) {
  const s = useProjects();
  const { me, agents } = useStore();
  useEffect(() => {
    if (s.status === "idle") void projectsStore.refresh();
    void projectsStore.loadCards(channel);
    void projectsStore.loadRoom(channel); // the Data Room: the tab's count, and each card's attachments
  }, [channel]);
  const project = s.projects.find((p) => p.channel === channel);
  const cards = s.cards[channel];
  const loadError = s.cardsError[channel];
  if (loadError && !cards) return <div className="page"><ErrorState message={loadError} onRetry={() => void projectsStore.loadCards(channel)} /></div>;
  if (!project || !cards) {
    return (
      <div className="page page-board">
        <div className="pboard-head"><span className="skeleton" style={{ width: 90, height: 10, marginBottom: 14 }} /><span className="skeleton" style={{ width: 240, height: 26, marginBottom: 22 }} /></div>
        <KanbanSkeleton />
      </div>
    );
  }
  return <BoardBody project={project} cards={cards} boardId={boardId} cardId={cardId} room={room === true} me={me?.handle ?? null} agents={agents} allProjects={s.projects} files={s.rooms[channel]} />;
}

function BoardBody({ project, cards, boardId, cardId, room, me, agents, allProjects, files }: {
  project: ProjectView; cards: CardView[]; boardId?: string; cardId?: string; room: boolean; me: string | null;
  agents: ReturnType<typeof useStore>["agents"]; allProjects: ProjectView[]; files: RoomFileView[] | undefined;
}) {
  const board = project.boards.find((b) => b.id === boardId) ?? project.boards.find((b) => b.state === "active") ?? project.boards[0];
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<string | null>(null);
  const [phoneCol, setPhoneCol] = useState(() => Math.max(0, board?.columns.findIndex((c) => c.role === "active") ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<PlanLimitDetails | null>(null);
  const [settings, setSettings] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [addingBoard, setAddingBoard] = useState(false);
  const [boardName, setBoardName] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const cardUpload = useRoomUpload(project.channel);
  /** Live Data Room files attached to each card (the paperclip count on its tile). */
  const attached = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of files ?? []) if (f.state === "active") for (const id of f.cards) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [files]);

  const cols = useMemo(() => (board ? columnsOf(board, cards, filters, me) : []), [board, cards, filters, me]);
  const { byCard, byProject } = useMemo(
    () => presence(agents, allProjects, (ch, n) => ch !== project.channel || cards.some((c) => c.n === n && c.state !== "deleted")),
    [agents, allProjects, cards, project.channel],
  );
  const labels = useMemo(() => [...new Set(cards.flatMap((c) => c.labels))].sort(), [cards]);
  const people = useMemo(() => [...new Set(cards.map((c) => c.assignee).filter((a): a is string => !!a))].sort(), [cards]);
  const open = cardId ? cards.find((c) => c.id === cardId) : undefined;
  const focused = focus ? cols[focus.col]?.cards[focus.row] : undefined;

  const go = (card?: CardView) => navigate({ view: "projects", channel: project.channel, ...(board ? { board: board.id } : {}), ...(card ? { card: card.id } : {}) });

  const write = async (fn: () => Promise<{ task: CardView }>) => {
    setError(null);
    try {
      projectsStore.card((await fn()).task);
      return true;
    } catch (err) {
      setError(friendlyError(err));
      return false;
    }
  };
  const moveTo = async (card: CardView, column: string, index: number) => {
    const target = cols.find((c) => c.column.id === column);
    const where = target ? dropTarget(target.cards, index, card.id) : {};
    await write(() => api.updateTask(card.id, { column, ...where }));
  };
  const moveMany = async (ids: string[], column: string) => {
    for (const id of ids) {
      const card = cards.find((c) => c.id === id);
      if (card && card.column !== column) await write(() => api.updateTask(id, { column }));
    }
  };
  const create = async (column: string, title: string) => {
    if (!board) return false;
    return write(() => api.createTask({ project: project.channel, board: board.id, column, title }));
  };
  const addBoard = async () => {
    setLimit(null);
    setError(null);
    try {
      const { board: b } = await api.createBoard(project.channel, { name: boardName.trim() });
      setAddingBoard(false);
      setBoardName("");
      void projectsStore.loadCards(project.channel);
      navigate({ view: "projects", channel: project.channel, board: b.id });
    } catch (err) {
      const l = planLimitOf(err);
      if (l) setLimit(l); else setError(friendlyError(err));
    }
  };

  // ---- keyboard -------------------------------------------------------------------------------------------------
  const keys = useRef({ gAt: 0, mAt: 0 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || settings || room) return;
      const k = e.key;
      const now = Date.now();
      if (k === "g") { keys.current.gAt = now; return; }
      if (now - keys.current.gAt < 1_000) { keys.current.gAt = 0; return; } // g-then-letter belongs to the global jumps
      if (open) {
        if (k === " ") { e.preventDefault(); go(); }
        return; // the drawer has the keys (Escape closes it)
      }
      const sizes = cols.map((c) => c.cards.length);
      if (/^[1-9]$/.test(k) && now - keys.current.mAt < 1_500) {
        keys.current.mAt = 0;
        const col = board?.columns[Number(k) - 1];
        const ids = selected.size ? [...selected] : focused ? [focused.id] : [];
        if (col && ids.length) { e.preventDefault(); void moveMany(ids, col.id); setSelected(new Set()); }
        return;
      }
      switch (k) {
        case "j": case "k": case "h": case "l":
          e.preventDefault();
          setFocus((f) => moveFocus(f ?? { col: 0, row: -1 }, k, sizes));
          return;
        case "Enter": case " ":
          if (focused) { e.preventDefault(); go(focused); }
          return;
        case "c":
          e.preventDefault();
          setComposer(board?.columns[focus?.col ?? 0]?.id ?? null);
          return;
        case "m": keys.current.mAt = now; return;
        case "a":
          if (focused && me) { e.preventDefault(); void write(() => api.updateTask(focused.id, { assignee: isMe(focused.assignee, me) ? null : `@${me}` })); }
          return;
        case "e":
          if (focused) { e.preventDefault(); go(focused); setTimeout(() => (document.getElementById("card-title") as HTMLInputElement | null)?.select(), 50); }
          return;
        case "x":
          if (focused) setSelected((sel) => { const n = new Set(sel); if (n.has(focused.id)) n.delete(focused.id); else n.add(focused.id); return n; });
          return;
        case "/":
          e.preventDefault();
          searchRef.current?.focus();
          return;
        case "Escape":
          setSelected(new Set());
          setFocus(null);
          setComposer(null);
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!board) return <div className="page"><ErrorState message="This project has no board." /></div>;
  const here = byProject.get(project.channel) ?? [];

  return (
    <div className="page page-board">
      <header className="pboard-head">
        <a className="pboard-back" href={hrefFor({ view: "projects" })}><ChevronLeft size={14} strokeWidth={2} />Projects{project.folder ? ` / ${project.folder}` : ""}</a>
        <div className="pboard-title-row">
          <h1 className="page-title">
            <span className="project-prefix mono" style={hueVar("--th", tagHue(project.prefix))}>{project.prefix}</span>
            {project.name}
            {project.private && <Lock size={14} strokeWidth={2} className="project-lock" aria-label="Private: the team's owners" />}
            {project.state !== "active" && <span className="chip">{project.state}</span>}
          </h1>
          <div className="pboard-meta">
            <AgentFaces agents={here} max={6} />
            <Meter meter={board.meter} label={board.name} />
          </div>
          <div className="page-actions">
            <div className="menu-wrap">
              <button type="button" className="btn btn-sm" aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen((v) => !v)}><Download size={13} strokeWidth={2} />Export</button>
              {exportOpen && (
                <div className="menu" role="menu">
                  {(["csv", "json", "ndjson"] as const).map((f) => (
                    <button key={f} type="button" role="menuitem" className="menu-item" onClick={() => { setExportOpen(false); void api.exportProject(project.channel, f, `${project.prefix.toLowerCase()}.${f}`).catch((err) => setError(friendlyError(err))); }}>
                      {f === "csv" ? "Cards (CSV)" : f === "json" ? "Project + cards (JSON)" : "Signed history (NDJSON)"}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" className="btn btn-sm btn-icon" aria-label="Project settings" onClick={() => setSettings(true)}><Settings size={14} strokeWidth={1.75} /></button>
          </div>
        </div>
        <nav className="tabs pboard-tabs" aria-label="Boards">
          {project.boards.filter((b) => b.state === "active" || b.id === board.id).map((b) => (
            <a key={b.id} className={b.id === board.id && !room ? "tab-link is-on" : "tab-link"} href={hrefFor({ view: "projects", channel: project.channel, board: b.id })} aria-current={b.id === board.id && !room ? "page" : undefined}>
              {b.name}<span className="muted tnum">{b.meter.done}/{b.meter.counted}</span>
            </a>
          ))}
          <a className={room ? "tab-link is-on pboard-room-tab" : "tab-link pboard-room-tab"} href={hrefFor({ view: "projects", channel: project.channel, room: true })} aria-current={room ? "page" : undefined}>
            <FolderOpen size={13} strokeWidth={2} aria-hidden="true" />Data Room<span className="muted tnum">{files ? files.filter((f) => f.state === "active").length : project.room?.files ?? 0}</span>
          </a>
          {addingBoard ? (
            <form className="pboard-newboard" onSubmit={(e) => { e.preventDefault(); if (boardName.trim()) void addBoard(); }}>
              <input className="input" autoFocus value={boardName} maxLength={40} placeholder="Board name" aria-label="Board name" onChange={(e) => setBoardName(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setAddingBoard(false); }} />
              <button type="submit" className="btn btn-sm btn-primary" disabled={!boardName.trim()}>Add</button>
            </form>
          ) : (
            <button type="button" className="tab-link pboard-addboard" onClick={() => setAddingBoard(true)}><Plus size={13} strokeWidth={2} />Board</button>
          )}
        </nav>
        {limit && <PlanLimitNotice details={limit} />}
      </header>

      {room ? <DataRoom project={project} cards={cards} /> : <>
      <div className="pboard-filters" role="search">
        <input ref={searchRef} className="input" type="search" placeholder="Filter cards  /" aria-label="Filter cards" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        <select className="select" aria-label="Assignee" value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })}>
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {labels.length > 0 && (
          <select className="select" aria-label="Label" value={filters.label} onChange={(e) => setFilters({ ...filters, label: e.target.value })}>
            <option value="">Any label</option>
            {labels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
        <label className="check pboard-mine"><input type="checkbox" checked={filters.mine} onChange={(e) => setFilters({ ...filters, mine: e.target.checked })} />Mine</label>
        {selected.size > 0 && <span className="pboard-sel tnum">{selected.size} selected · <kbd>m</kbd> then <kbd>1</kbd>–<kbd>9</kbd> to move</span>}
        <span className="pboard-keys muted" aria-hidden="true"><kbd>j</kbd><kbd>k</kbd> <kbd>h</kbd><kbd>l</kbd> focus · <kbd>↵</kbd> open · <kbd>c</kbd> new · <kbd>m</kbd> then <kbd>1</kbd>–<kbd>9</kbd> move</span>
      </div>
      {error && <ErrorState compact message={error} />}
      <div className="pboard-notice">{cardUpload.notice}</div>

      <Kanban
        columns={cols} byCard={byCard} focus={focus} selected={selected} openCard={open?.id ?? null} composerFor={composer}
        phoneCol={Math.min(phoneCol, Math.max(0, cols.length - 1))} onPhoneCol={setPhoneCol}
        onOpen={(c) => go(c)} onMove={(c, col, i) => void moveTo(c, col, i)} onCompose={setComposer} onCreate={create} onFocus={setFocus}
        attached={attached} onCardFiles={(c, fs) => void cardUpload.upload(fs, c.id)}
      />
      </>}

      {open && <CardDrawer card={open} project={project} byCard={byCard} onClose={() => go()} />}
      {settings && <ProjectSettings project={project} onClose={() => setSettings(false)} />}
    </div>
  );
}
