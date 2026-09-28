import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { api, friendlyError, planLimitOf } from "../../api/client.ts";
import type { PlanLimitDetails } from "../../api/types.ts";
import { PlanLimitNotice } from "../../components/PlanLimitNotice.tsx";
import { navigate } from "../../lib/route.ts";
import { projectsStore } from "../../state/projects.ts";
import { useStore } from "../../state/store.tsx";

/** A new project: name, folder, key prefix, private (the team's owners), where its work happens. */
export function CreateProject({ onClose }: { onClose: () => void }) {
  const { me, team } = useStore();
  const owner = me?.role === "owner";
  const restricted = team?.plan?.entitlements.restricted_channels ?? me?.plan?.entitlements.restricted_channels ?? false;
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [prefix, setPrefix] = useState("");
  const [path, setPath] = useState("");
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<PlanLimitDetails | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const prefixOk = !prefix || /^[A-Z][A-Z0-9]{1,9}$/.test(prefix);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !prefixOk) return;
    setBusy(true);
    setError(null);
    setLimit(null);
    try {
      const { project } = await api.createProject({
        name: name.trim(), ...(folder.trim() ? { folder: folder.trim() } : {}), ...(prefix ? { prefix } : {}),
        ...(priv ? { private: true } : {}), ...(path.trim() ? { paths: [{ path: path.trim() }] } : {}),
      });
      projectsStore.project(project);
      onClose();
      navigate({ view: "projects", channel: project.channel });
    } catch (err) {
      const l = planLimitOf(err);
      if (l) setLimit(l); else setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="palette-layer" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="palette dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title" onSubmit={submit}>
        <header className="dialog-head">
          <h2 id="new-project-title" className="dialog-title">New project</h2>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close"><X size={15} strokeWidth={1.75} /></button>
        </header>
        <div className="dialog-body">
          <div className="field">
            <label htmlFor="np-name">Name</label>
            <input ref={first} id="np-name" className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Website relaunch" required />
          </div>
          <div className="dialog-row">
            <div className="field">
              <label htmlFor="np-folder">Folder</label>
              <input id="np-folder" className="input" value={folder} maxLength={40} onChange={(e) => setFolder(e.target.value)} placeholder="Acme" />
            </div>
            <div className="field">
              <label htmlFor="np-prefix">Card key prefix</label>
              <input id="np-prefix" className="input mono" value={prefix} maxLength={10} aria-invalid={!prefixOk} onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="auto" />
              {!prefixOk && <span className="field-error">A letter, then 1–9 letters or digits.</span>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="np-path">Work happens in <span className="muted">(optional)</span></label>
            <input id="np-path" className="input mono" value={path} maxLength={300} onChange={(e) => setPath(e.target.value)} placeholder="~/workspace/site" />
            <span className="field-hint">Agents working under this directory show up on the project.</span>
          </div>
          <label className={`check${owner && restricted ? "" : " is-disabled"}`}>
            <input type="checkbox" checked={priv} disabled={!owner || !restricted} onChange={(e) => setPriv(e.target.checked)} />
            <span>Private: only the team's owners see it{!owner ? " (owners only)" : !restricted ? " (Team plan)" : ""}</span>
          </label>
          {priv && <p className="field-hint">{prefix ? "A readable prefix can reveal the project where Walkie can't mask its keys (commit messages, file names); leave it empty for an opaque one." : "Its cards get an opaque key prefix (like PX7Q), so a key that escapes reveals nothing."}</p>}
          {limit && <PlanLimitNotice details={limit} />}
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        <footer className="dialog-foot">
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim() || !prefixOk}>{busy ? "Creating…" : "Create project"}</button>
        </footer>
      </form>
    </div>
  );
}
