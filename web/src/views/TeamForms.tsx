import { useEffect, useState, type FormEvent } from "react";
import { Check, X } from "lucide-react";
import { api, friendlyError, planLimitOf } from "../api/client.ts";
import type { InviteCode, PendingJoin, PlanLimitDetails, Role } from "../api/types.ts";
import { PlanLimitNotice } from "../components/PlanLimitNotice.tsx";
import { CopyCommand, ErrorState, RelTime, SkeletonRows } from "../components/primitives.tsx";
import { fullTime } from "../lib/time.ts";
import { useActions, useStore } from "../state/store.tsx";

const HANDLE_RE = /^[a-z][a-z0-9-]{0,23}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function useFlash(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4_000);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg, setMsg];
}

export function PendingJoins() {
  const { refreshTeam } = useActions();
  const [items, setItems] = useState<PendingJoin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [limit, setLimit] = useState<PlanLimitDetails | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.pending()
      .then((r) => { if (!cancelled) setItems(r.requests); })
      .catch((err) => { if (!cancelled) setError(friendlyError(err)); });
    return () => { cancelled = true; };
  }, [nonce]);

  const decide = async (p: PendingJoin, approve: boolean) => {
    setBusy(p.node_id);
    setError(null);
    setLimit(null);
    try {
      await api.admit({ node_id: p.node_id, approve });
      setItems((list) => (list ?? []).filter((x) => x.node_id !== p.node_id));
      refreshTeam();
    } catch (err) {
      const d = planLimitOf(err);
      if (d) setLimit(d); else setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  if (error && !items) return <ErrorState compact message={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (!items) return <SkeletonRows rows={1} />;
  if (!items.length) return <p className="panel-empty">No machines waiting to join. Additional machines for an admitted Tailscale login need approval unless they use an add-machine link.</p>;
  return (
    <ul className="pending-list">
      {items.map((p) => (
        <li key={p.node_id} className="pending-row">
          <div className="pending-text">
            <span className="mono">{p.hostname}</span>
            <span className="muted">Tailscale login <span className="mono">{p.login}</span>{p.handle ? <> · @{p.handle}</> : null}</span>
            <span className="pending-meta muted tnum">Requested <RelTime ts={p.requested_at} long /> · {p.ip} · node {p.node_id.slice(0, 8)}</span>
          </div>
          <div className="pending-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy === p.node_id} onClick={() => void decide(p, true)}>
              <Check size={13} strokeWidth={2} aria-hidden="true" />Approve
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy === p.node_id} onClick={() => void decide(p, false)}>
              <X size={13} strokeWidth={2} aria-hidden="true" />Deny
            </button>
          </div>
        </li>
      ))}
      {error && <li><p className="field-error" role="alert">{error}</p></li>}
      {limit && <li><PlanLimitNotice details={limit} /></li>}
    </ul>
  );
}

/**
 * Owners add teammates the way this machine connects: a Walkie Direct invite code, or a Tailscale login. A machine
 * that serves both (a mixed team's authority, `walkie direct enable`) offers both.
 */
export function InviteForm() {
  const { me } = useStore();
  if (me?.transport?.mode === "direct") return <DirectInviteForm />;
  if (me?.transport?.transports?.includes("direct")) return <><DirectInviteForm /><TailscaleInviteForm /></>;
  return <TailscaleInviteForm />;
}

const INSTALL_URL = "https://getwalkie.vercel.app/install.sh";

/** Walkie Direct: a single-use code, valid 7 days, that admits one machine as @handle. */
function DirectInviteForm() {
  const [handle, setHandle] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<InviteCode | null>(null);
  const handleBad = handle.length > 0 && !HANDLE_RE.test(handle);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!HANDLE_RE.test(handle)) {
      setError("A valid handle is required.");
      return;
    }
    setBusy(true);
    setError(null);
    setInvite(null);
    try {
      setInvite(await api.inviteCode({ handle, role }));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="form-row">
        <div className="field">
          <label htmlFor="dinv-handle">Handle</label>
          <input id="dinv-handle" className="input mono" value={handle} onChange={(e) => { setHandle(e.target.value.toLowerCase()); setInvite(null); }} placeholder="riley" aria-invalid={handleBad} aria-describedby="dinv-handle-hint" autoComplete="off" />
          <span id="dinv-handle-hint" className={handleBad ? "field-error" : "field-hint"}>{handleBad ? "Lowercase letters, digits and dashes; starts with a letter." : "An existing handle adds a machine for that person."}</span>
        </div>
        <div className="field">
          <label htmlFor="dinv-role">Role</label>
          <select id="dinv-role" className="select" value={role} onChange={(e) => { setRole(e.target.value as Role); setInvite(null); }}>
            <option value="member">Member</option>
            <option value="owner">Owner</option>
            <option value="observer">Observer (read only)</option>
          </select>
        </div>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Creating…" : "Create invite code"}</button>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {invite && (
        <div className="invite-result" role="status">
          <p className="field-hint">
            One-time code for <span className="mono">@{invite.handle}</span> ({invite.role}{invite.existing_member ? ", another machine" : ""}),
            valid until {fullTime(invite.expires_at)}. Send it privately: whoever holds it can join once.
          </p>
          <CopyCommand command={invite.code} label="Code" prompt={false} />
          <p className="field-hint">They install and join in one step:</p>
          <CopyCommand command={`curl -fsSL ${INSTALL_URL} | sh -s -- --invite ${invite.code}`} />
          <p className="field-hint">Already installed: <span className="mono">walkie join &lt;code&gt;</span></p>
        </div>
      )}
    </form>
  );
}

function TailscaleInviteForm() {
  const { refreshTeam } = useActions();
  const [login, setLogin] = useState("");
  const [handle, setHandle] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<PlanLimitDetails | null>(null);
  const [flash, setFlash] = useFlash();
  const handleBad = handle.length > 0 && !HANDLE_RE.test(handle);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!login.trim() || !HANDLE_RE.test(handle)) {
      setError("A Tailscale login and a valid handle are required.");
      return;
    }
    setBusy(true);
    setError(null);
    setLimit(null);
    try {
      await api.invite({ login: login.trim(), handle, role, ...(name.trim() ? { display_name: name.trim() } : {}) });
      setFlash(`@${handle} added. They can run walkie join from any of their tailnet machines.`);
      setLogin(""); setHandle(""); setName(""); setRole("member");
      refreshTeam();
    } catch (err) {
      const d = planLimitOf(err);
      if (d) setLimit(d); else setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="inv-login">Tailscale login</label>
        <input id="inv-login" className="input" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="name@company.com or github user" autoComplete="off" />
        <span className="field-hint">The identity Tailscale reports for their machines.</span>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="inv-handle">Handle</label>
          <input id="inv-handle" className="input mono" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} placeholder="riley" aria-invalid={handleBad} aria-describedby="inv-handle-hint" />
          <span id="inv-handle-hint" className={handleBad ? "field-error" : "field-hint"}>{handleBad ? "Lowercase letters, digits and dashes; starts with a letter." : "Used in addresses like @riley/laptop"}</span>
        </div>
        <div className="field">
          <label htmlFor="inv-role">Role</label>
          <select id="inv-role" className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member</option>
            <option value="owner">Owner</option>
            <option value="observer">Observer (read only)</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="inv-name">Display name <span className="muted">(optional)</span></label>
        <input id="inv-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Riley Chen" maxLength={60} />
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Adding…" : "Add to team"}</button>
        {flash && <span className="form-flash" role="status">{flash}</span>}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {limit && <PlanLimitNotice details={limit} />}
    </form>
  );
}

export function ChannelForm() {
  const { team } = useStore();
  const { refreshTeam } = useActions();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<PlanLimitDetails | null>(null);
  const [flash, setFlash] = useFlash();
  const bad = name.length > 0 && !CHANNEL_RE.test(name);
  const exists = team?.channels.some((c) => c.name === name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!CHANNEL_RE.test(name) || exists) {
      setError(exists ? `#${name} already exists.` : "Pick a channel name first.");
      return;
    }
    if (restricted && !members.length) {
      setError("A restricted channel needs at least one member.");
      return;
    }
    setBusy(true);
    setError(null);
    setLimit(null);
    try {
      await api.channel({ name, ...(topic.trim() ? { topic: topic.trim() } : {}), ...(restricted ? { members } : {}) });
      setFlash(`#${name} created.`);
      setName(""); setTopic(""); setRestricted(false); setMembers([]);
      refreshTeam();
    } catch (err) {
      const d = planLimitOf(err);
      if (d) setLimit(d); else setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="ch-name">Name</label>
        <div className="input-prefix">
          <span aria-hidden="true">#</span>
          <input id="ch-name" className="input mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))} placeholder="releases" aria-invalid={bad || exists} />
        </div>
        {(bad || exists) && <span className="field-error">{exists ? "That channel already exists." : "Lowercase letters, digits, - and _ only."}</span>}
      </div>
      <div className="field">
        <label htmlFor="ch-topic">Topic <span className="muted">(optional)</span></label>
        <input id="ch-topic" className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What agents should post here" maxLength={200} />
      </div>
      <label className="check">
        <input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
        <span>Restricted: only listed members can read it. Other machines never receive its messages.</span>
      </label>
      {restricted && (
        <fieldset className="member-pick">
          <legend className="field-label">Members</legend>
          {(team?.members ?? []).map((m) => (
            <label key={m.handle} className="check">
              <input type="checkbox" checked={members.includes(m.handle)} onChange={(e) => setMembers((cur) => (e.target.checked ? [...cur, m.handle] : cur.filter((h) => h !== m.handle)))} />
              <span>{m.display_name ?? m.handle} <span className="muted mono">@{m.handle}</span></span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Creating…" : "Create channel"}</button>
        {flash && <span className="form-flash" role="status">{flash}</span>}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {limit && <PlanLimitNotice details={limit} />}
    </form>
  );
}
