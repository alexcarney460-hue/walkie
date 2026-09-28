import { useEffect, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { ProjectView } from "../../api/types.ts";
import { navigate } from "../../lib/route.ts";
import { projectsStore } from "../../state/projects.ts";
import { useStore } from "../../state/store.tsx";

/** Settings, visibility, archive and delete: the project's creator and the team's owners (the daemon checks too). */
export function ProjectSettings({ project, onClose }: { project: ProjectView; onClose: () => void }) {
  const { me } = useStore();
  const admin = !!me?.handle && (me.role === "owner" || project.creator === me.handle);
  const owner = me?.role === "owner";
  const [name, setName] = useState(project.name);
  const [folder, setFolder] = useState(project.folder);
  const [prefix, setPrefix] = useState(project.prefix);
  const [priv, setPriv] = useState(project.private);
  const [closeAgents, setCloseAgents] = useState(project.automations.agents_can_close);
  const [prOpened, setPrOpened] = useState(project.automations.pr_opened);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = async (body: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const { project: p } = await api.updateProject(project.channel, body);
      projectsStore.project(p);
      after?.();
      onClose();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      ...(name.trim() !== project.name ? { name: name.trim() } : {}),
      ...(folder.trim() !== project.folder ? { folder: folder.trim() } : {}),
      ...(prefix !== project.prefix ? { prefix } : {}),
      ...(priv !== project.private ? { private: priv } : {}),
      ...(closeAgents !== project.automations.agents_can_close || prOpened !== project.automations.pr_opened
        ? { automations: { agents_can_close: closeAgents, pr_opened: prOpened } } : {}),
    };
    if (!Object.keys(body).length) { onClose(); return; }
    void apply(body);
  };

  return (
    <div className="palette-layer" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="palette dialog" role="dialog" aria-modal="true" aria-labelledby="ps-title" onSubmit={submit}>
        <header className="dialog-head">
          <h2 id="ps-title" className="dialog-title">Project settings</h2>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close"><X size={15} strokeWidth={1.75} /></button>
        </header>
        <div className="dialog-body">
          {!admin && <p className="field-hint">Only {project.creator === me?.handle ? "you" : `@${project.creator}`} (the creator) and the team's owners can change these.</p>}
          <fieldset disabled={!admin || busy} className="dialog-fields">
            <div className="field"><label htmlFor="ps-name">Name</label><input id="ps-name" className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></div>
            <div className="dialog-row">
              <div className="field"><label htmlFor="ps-folder">Folder</label><input id="ps-folder" className="input" value={folder} maxLength={40} onChange={(e) => setFolder(e.target.value)} /></div>
              <div className="field"><label htmlFor="ps-prefix">Key prefix</label><input id="ps-prefix" className="input mono" value={prefix} maxLength={10} onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} /></div>
            </div>
            <label className="check"><input type="checkbox" checked={closeAgents} onChange={(e) => setCloseAgents(e.target.checked)} />Agents may move cards to done</label>
            <label className="check"><input type="checkbox" checked={prOpened} onChange={(e) => setPrOpened(e.target.checked)} />An agent's pull request moves its card to review</label>
            <label className={owner ? "check" : "check is-disabled"}><input type="checkbox" checked={priv} disabled={!owner} onChange={(e) => setPriv(e.target.checked)} />Private: only the team's owners{!owner ? " (owners change this)" : ""}</label>
          </fieldset>
          {error && <p className="field-error" role="alert">{error}</p>}
          {admin && (
            <div className="dialog-danger">
              {project.state === "active"
                ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void apply({ state: "archived" })}>Archive project</button>
                : <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void apply({ state: "active" })}>Restore project</button>}
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => {
                if (window.confirm(`Delete ${project.name}? Its signed history stays; an owner can restore it with: walkie projects restore ${project.prefix}`)) void apply({ state: "deleted" }, () => navigate({ view: "projects" }));
              }}>Delete project</button>
            </div>
          )}
        </div>
        <footer className="dialog-foot">
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!admin || busy}>Save</button>
        </footer>
      </form>
    </div>
  );
}
