// AGENT-ADMIN-1: this machine's two admin switches, the person's kill switch for agent setup. Off is sticky: an agent
// can turn a switch off, never on; the dashboard is the person (a session never carries an agent header).
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api, friendlyError, type AdminView } from "../../api/client.ts";
import { RelTime } from "../../components/primitives.tsx";

type Key = "agent_admin" | "remote_admin";

const LABEL: Record<Key, { title: string; on: string; off: string }> = {
  agent_admin: {
    title: "Agents set up Walkie here",
    on: "Agents on this machine may do its Walkie setup for you (seats, accounts, hooks, pool, WalkieTalkie, invites). Each action is posted to #general, naming the agent.",
    off: "Agents on this machine are refused Walkie setup. Only you can turn this back on.",
  },
  remote_admin: {
    title: "Owners set up Walkie here remotely",
    on: "Team owners (and your own other machines) may run allow-listed walkie setup commands on this machine over Walkie, never a shell. You are mentioned on each one.",
    off: "Nobody can administer this machine remotely. Only you can turn this back on.",
  },
};

/** The switches and the newest audit lines (presentational: the render test drives it with a fixed view). */
export function AgentAdminSwitches({ view, busy, error, onToggle }: {
  view: AdminView; busy: boolean; error: string | null; onToggle: (key: Key, on: boolean) => void;
}) {
  return (
    <article className="seat-host-card" aria-labelledby="agent-admin-title">
      <header className="seat-host-head">
        <span className="source-avatar" aria-hidden="true"><ShieldCheck size={16} strokeWidth={1.75} /></span>
        <h2 className="int-title" id="agent-admin-title">Agent admin <span className="mono muted">{view.machine}</span></h2>
      </header>
      {(["agent_admin", "remote_admin"] as const).map((k) => (
        <div key={k} className="admin-switch">
          <label className="toggle-row">
            <input type="checkbox" role="switch" aria-checked={view[k]} checked={view[k]} disabled={busy} onChange={(e) => onToggle(k, e.currentTarget.checked)} />
            <span>{LABEL[k].title}</span>
            <span className={`int-status ${view[k] ? "is-on" : "is-off"}`}>{view[k] ? "On" : "Off"}</span>
          </label>
          <p className="field-hint">{view[k] ? LABEL[k].on : LABEL[k].off}</p>
        </div>
      ))}
      {error && <p className="int-error" role="alert">{error}</p>}
      {view.audit.length ? (
        <ul className="admin-audit" aria-label="Recent admin actions on this machine">
          {view.audit.map((a) => (
            <li key={`${a.ts}-${a.actor}`}><RelTime ts={a.ts} /> <span className="mono">{a.actor}</span> {a.action}{a.refused ? <span className="int-error"> (refused: {a.refused})</span> : null}</li>
          ))}
        </ul>
      ) : <p className="field-hint">No agent or remote admin actions on this machine yet.</p>}
    </article>
  );
}

export function AgentAdminCard() {
  const [view, setView] = useState<AdminView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.admin().then((v) => { setView(v); setError(null); }).catch((err) => setError(friendlyError(err)));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const toggle = async (key: Key, on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.adminSwitches({ [key]: on });
      reload();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  if (!view) return error ? <p className="int-error" role="alert">{error}</p> : null;
  return <AgentAdminSwitches view={view} busy={busy} error={error} onToggle={(k, on) => void toggle(k, on)} />;
}
