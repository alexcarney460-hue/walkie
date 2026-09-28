// A project's Data Room tab (DATA-ROOM-1): the project's files next to its boards. Pinned documents first (they reach
// every agent that starts a card), then by name. Drop files anywhere on the page or use Upload; re-adding a name adds
// a version. Download (any version from History), rename, pin / unpin, remove: people at the dashboard.
import { Fragment, useEffect, useRef, useState, type DragEvent } from "react";
import { Bot, Download, FileCode2, FileJson, FileText, File as FileIcon, History, Pencil, Pin, PinOff, Trash2, Undo2, Upload } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { CardView, ProjectView, RoomFileDetail, RoomFileView } from "../../api/types.ts";
import { AuthorAvatar } from "../../components/Author.tsx";
import { EmptyState, ErrorState, RelTime, SkeletonRows } from "../../components/primitives.tsx";
import { bytes, displayName, mimeKind } from "../../lib/format.ts";
import { hrefFor } from "../../lib/route.ts";
import { fullTime } from "../../lib/time.ts";
import { projectsStore, useProjects } from "../../state/projects.ts";
import { useStore } from "../../state/store.tsx";
import { draggedFiles, useRoomUpload } from "./RoomUpload.tsx";

const ICON = { code: FileCode2, data: FileJson, text: FileText, image: FileIcon, archive: FileIcon, file: FileIcon };

export function DataRoom({ project, cards }: { project: ProjectView; cards: CardView[] }) {
  const s = useProjects();
  const { team } = useStore();
  const files = s.rooms[project.channel];
  const loadError = s.roomsError[project.channel];
  const [showRemoved, setShowRemoved] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const { upload, busy, notice } = useRoomUpload(project.channel);
  useEffect(() => { void projectsStore.loadRoom(project.channel); }, [project.channel]);

  const keyOf = new Map(cards.map((c) => [c.id, c]));
  const shown = (files ?? []).filter((f) => showRemoved || f.state === "active");
  const live = (files ?? []).filter((f) => f.state === "active");
  const removed = (files ?? []).length - live.length;
  const total = live.reduce((n, f) => n + f.size, 0);

  const change = async (f: RoomFileView, body: Parameters<typeof api.roomChange>[2]) => {
    setError(null);
    try {
      projectsStore.roomFile((await api.roomChange(project.channel, f.id, body)).file);
      return true;
    } catch (err) {
      setError(friendlyError(err));
      return false;
    }
  };

  const onDrag = (e: DragEvent<HTMLElement>, kind: "enter" | "leave" | "over" | "drop") => {
    if (!draggedFiles(e)) return;
    e.preventDefault();
    if (kind === "enter") { depth.current += 1; setDragging(true); }
    if (kind === "leave") { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); }
    if (kind === "drop") {
      depth.current = 0;
      setDragging(false);
      void upload([...e.dataTransfer.files]);
    }
  };

  return (
    <section
      className={`room${dragging ? " is-drop" : ""}`} aria-label="Data Room"
      onDragEnter={(e) => onDrag(e, "enter")} onDragLeave={(e) => onDrag(e, "leave")} onDragOver={(e) => onDrag(e, "over")} onDrop={(e) => onDrag(e, "drop")}
    >
      <div className="room-head">
        <p className="room-meta muted">
          {files ? `${live.length} file${live.length === 1 ? "" : "s"} · ${bytes(total)}` : "The project's files"}
          <span className="room-meta-note"> · Visible to everyone on this project{project.private ? " (the team's owners)" : ""}. Pinned documents go to every agent that starts a card.</span>
        </p>
        <div className="room-actions">
          {removed > 0 && (
            <label className="check"><input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />Show removed ({removed})</label>
          )}
          <input ref={input} type="file" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void upload(fs); }} />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => input.current?.click()}>
            <Upload size={13} strokeWidth={2} />{busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
      {notice}
      {error && <ErrorState compact message={error} />}
      {dragging && <div className="room-dropzone" aria-hidden="true"><Upload size={22} strokeWidth={1.6} />Drop to add to the Data Room</div>}

      {loadError && !files ? (
        <ErrorState message={loadError} onRetry={() => void projectsStore.loadRoom(project.channel)} />
      ) : !files ? (
        <SkeletonRows rows={4} />
      ) : shown.length === 0 ? (
        <EmptyState icon={<Upload size={18} strokeWidth={1.75} />} title="No files yet" command={`walkie room ${project.prefix} add ./brief.pdf --pin`}>
          <p>Drop files here, or use Upload. Specs, contracts, designs, data: the project's documents, next to its board. Pin the ones every agent on a card should read.</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table files-table room-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="num">Size</th>
                <th scope="col">Added by</th>
                <th scope="col" className="num">When</th>
                <th scope="col">Cards</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => {
                const Icon = ICON[mimeKind(f.mime, f.name)];
                const by = f.updated_by;
                return (
                  <Fragment key={f.id}>
                    <tr className={f.state === "removed" ? "is-off" : undefined}>
                      <td className="file-cell">
                        <span className="file-icon" aria-hidden="true"><Icon size={15} strokeWidth={1.6} /></span>
                        <span className="file-text">
                          {renaming === f.id ? (
                            <RenameInput file={f} onDone={async (name) => { if (name && name !== f.name) await change(f, { name }); setRenaming(null); }} />
                          ) : (
                            <span className="mono file-name">
                              {f.pinned && <Pin size={12} strokeWidth={2.2} className="room-pin" aria-label="Pinned" />}
                              {f.name}
                            </span>
                          )}
                          <span className="file-note">
                            v{f.version}{f.versions > 1 ? ` · ${f.versions} versions` : ""} · {f.mime}
                            {f.state === "removed" ? " · removed" : ""}{f.available ? "" : " · not available on any online machine"}
                          </span>
                        </span>
                      </td>
                      <td className="num tnum muted" data-label="Size">{bytes(f.size)}</td>
                      <td data-label="By">
                        <span className="by-cell">
                          <AuthorAvatar author={by} size={18} />
                          {by.agent
                            ? <span className="room-agent mono" title={`${displayName(team?.members, by.handle)}'s agent ${by.agent}`}><Bot size={12} strokeWidth={2} aria-label="agent" />{by.handle}/{by.agent}</span>
                            : <span>{displayName(team?.members, by.handle)}</span>}
                        </span>
                      </td>
                      <td className="num muted" data-label="When" title={fullTime(f.updated_at)}><RelTime ts={f.updated_at} long /></td>
                      <td data-label={f.cards.some((id) => keyOf.has(id)) ? "Cards" : undefined}>
                        <span className="room-cards">
                          {f.cards.map((id) => keyOf.get(id)).filter((c): c is CardView => !!c).map((c) => (
                            <a key={c.id} className="chip mono" href={hrefFor({ view: "projects", channel: project.channel, board: c.board, card: c.id })} title={c.title}>{c.key}</a>
                          ))}
                        </span>
                      </td>
                      <td className="room-row-actions">
                        <button type="button" className="btn btn-sm btn-icon" aria-label={`Download ${f.name}`} title="Download" onClick={() => void api.roomDownload(project.channel, f.id, f.name).catch((err) => setError(friendlyError(err)))}><Download size={13} strokeWidth={1.75} /></button>
                        <button type="button" className="btn btn-sm btn-icon" aria-label={`History of ${f.name}`} aria-expanded={history === f.id} title="History" onClick={() => setHistory((h) => (h === f.id ? null : f.id))}><History size={13} strokeWidth={1.75} /></button>
                        {f.state === "active" ? (
                          <>
                            <button type="button" className="btn btn-sm btn-icon" aria-label={f.pinned ? `Unpin ${f.name}` : `Pin ${f.name}`} title={f.pinned ? "Unpin" : "Pin: every agent that starts a card gets it"} onClick={() => void change(f, { pin: !f.pinned })}>
                              {f.pinned ? <PinOff size={13} strokeWidth={1.75} /> : <Pin size={13} strokeWidth={1.75} />}
                            </button>
                            <button type="button" className="btn btn-sm btn-icon" aria-label={`Rename ${f.name}`} title="Rename" onClick={() => setRenaming(f.id)}><Pencil size={13} strokeWidth={1.75} /></button>
                            <button type="button" className="btn btn-sm btn-icon btn-danger-quiet" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => { if (window.confirm(`Remove ${f.name} from the Data Room? It stays in the signed history (and on machines that downloaded it) and can be restored.`)) void change(f, { state: "removed" }); }}><Trash2 size={13} strokeWidth={1.75} /></button>
                          </>
                        ) : (
                          <button type="button" className="btn btn-sm" onClick={() => void change(f, { state: "active" })}><Undo2 size={13} strokeWidth={1.75} />Restore</button>
                        )}
                      </td>
                    </tr>
                    {history === f.id && (
                      <tr className="room-history-row"><td colSpan={6}><VersionHistory channel={project.channel} file={f} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RenameInput({ file, onDone }: { file: RoomFileView; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(file.name);
  return (
    <input
      className="input mono room-rename" autoFocus value={name} maxLength={200} aria-label={`New name for ${file.name}`}
      onChange={(e) => setName(e.target.value)} onBlur={() => onDone(name.trim())}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") onDone(null); }}
    />
  );
}

/** Every version of a file, newest first: who added it, when, its size; any version downloads. */
function VersionHistory({ channel, file }: { channel: string; file: RoomFileView }) {
  const [d, setD] = useState<RoomFileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.roomFile(channel, file.id).then(setD).catch((err) => setError(friendlyError(err)));
  }, [channel, file.id, file.version, file.rev]);
  if (error) return <ErrorState compact message={error} />;
  if (!d) return <SkeletonRows rows={2} />;
  const ignored = d.timeline.filter((t) => t.ignored && t.ignored !== "waiting_for_parent");
  return (
    <div className="room-history">
      <ol>
        {[...d.versions].reverse().map((v) => (
          <li key={v.id}>
            <span className="mono">v{v.v}</span>
            <span className="tnum muted">{bytes(v.size)}</span>
            <span className="mono">@{v.by.handle}{v.by.agent ? `/${v.by.agent}` : ""}</span>
            <RelTime ts={v.ts} className="muted" long />
            {v.name !== file.name && <span className="muted">as {v.name}</span>}
            {v.ignored === "person_pinned" && <span className="muted" title="Added by an agent that hadn't seen the pin: kept, but agents get the pinned version">not the pinned version</span>}
            {v.available === false
              ? <span className="muted">not available</span>
              : <button type="button" className="btn btn-sm btn-ghost" onClick={() => void api.roomDownload(channel, file.id, v.name, v.v)}><Download size={12} strokeWidth={1.75} />v{v.v}</button>}
          </li>
        ))}
      </ol>
      {ignored.length > 0 && (
        <p className="room-ignored">
          {ignored.length} change{ignored.length === 1 ? "" : "s"} by agents not applied ({[...new Set(ignored.map((t) => t.ignored === "person_pinned" ? "a new version of a pinned file is for people" : "renaming, pinning and removing are for people"))].join("; ")}).
        </p>
      )}
    </div>
  );
}
