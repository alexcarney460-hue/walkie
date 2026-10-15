import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Link2, ShieldAlert, X } from "lucide-react";
import { api, friendlyError, planLimitOf } from "../api/client.ts";
import type { PlanLimitDetails } from "../api/types.ts";
import type { FleetLinkMinted, FleetLinkUse, FleetLinkView, FleetLinksView } from "../../../src/protocol/fleet-link.ts";
import { PlanLimitNotice } from "../components/PlanLimitNotice.tsx";
import { CopyCommand, ErrorState, RelTime, SkeletonRows } from "../components/primitives.tsx";
import { fullTime } from "../lib/time.ts";
import { useActions, useStore } from "../state/store.tsx";

// Fleet links (FLEET-LINK-1): ONE link that adds many machines, each as a chosen member's. Owners make them here (the
// Machines section's "Add machines" button), see every link with its uses left and the machines that used it, approve
// or deny machines waiting on an approve-each-machine link, and revoke a link.

const USES = [5, 10, 25, 50, 100, 250, 0] as const;
const STATE_LABEL: Record<FleetLinkView["state"], string> = { active: "Active", used_up: "Used up", expired: "Expired", revoked: "Revoked", dead: "Can't be used" };

function usesText(l: Pick<FleetLinkView, "uses" | "used" | "pending">): string {
  if (l.uses === 0) return `${l.used} joined · no limit`;
  return `${l.used} joined · ${Math.max(0, l.uses - l.used - l.pending)} of ${l.uses} left`;
}

function reasonText(reason: string | undefined): string {
  return (reason ?? "").replace(/^link_/, "").replace(/_/g, " ");
}

/** The drawer: make a link (who, how many, how long, approval), then the link and commands to send. */
export function FleetLinkSheet({ onClose }: { onClose: () => void }) {
  const { team, me } = useStore();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const close = useCallback(onClose, [onClose]);
  const members = team?.members ?? [];
  const [target, setTarget] = useState(me?.handle ?? members[0]?.handle ?? "");
  const [uses, setUses] = useState<number>(25);
  const [days, setDays] = useState(7);
  const [approve, setApprove] = useState(false);
  const [observerOk, setObserverOk] = useState(false);
  const [ownerOk, setOwnerOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<FleetLinkMinted | null>(null);
  const targetRole = members.find((m) => m.handle === target)?.role;

  useEffect(() => {
    returnFocus.current = document.activeElement;
    closeRef.current?.focus();
    const dialog = dialogRef.current;
    const background: { element: HTMLElement; wasInert: boolean }[] = [];
    // The drawer is nested in the view: disable sibling subtrees up to body, retaining any pre-existing inert state.
    for (let layer = dialog?.closest<HTMLElement>(".drawer-layer") ?? null; layer && layer !== document.body; layer = layer.parentElement) {
      for (const sibling of layer.parentElement?.children ?? []) {
        if (sibling !== layer && sibling instanceof HTMLElement) {
          background.push({ element: sibling, wasInert: sibling.inert });
          sibling.inert = true;
        }
      }
    }
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]') ?? [])]
      .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key !== "Tab") return;
      const items = focusable();
      const first = items[0], last = items.at(-1);
      if (!first || !last) { e.preventDefault(); dialog?.focus(); return; }
      if (!dialog?.contains(document.activeElement) || (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    // Contain programmatic focus too (e.g. background shortcuts); the scrim already blocks pointer interaction.
    const onFocus = (e: FocusEvent) => {
      if (dialog && !dialog.contains(e.target as Node)) (closeRef.current ?? dialog).focus();
    };
    document.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      for (const { element, wasInert } of background) element.inert = wasInert;
      (returnFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [close]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (targetRole === "observer" && !observerOk) { setError("Tick the box to add machines as an observer's (they can read, never post)."); return; }
    if (targetRole === "owner" && !ownerOk) { setError("Confirm that this link grants owner-level access to every machine that joins."); return; }
    setBusy(true);
    setError(null);
    try {
      setMinted(await api.mintLink({ for: target, uses, expires_days: days, approve, ...(targetRole === "observer" ? { observer: true } : {}), ...(targetRole === "owner" && ownerOk ? { owner_machines: true } : {}) }));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-layer">
      <div className="scrim" onClick={close} aria-hidden="true" />
      <aside ref={dialogRef} tabIndex={-1} className="drawer add-machine" role="dialog" aria-modal="true" aria-labelledby="fl-title">
        <header className="drawer-head">
          <div className="drawer-head-text">
            <div className="drawer-kicker"><span className="muted">{team?.name}</span></div>
            <h2 className="drawer-title" id="fl-title">Add machines</h2>
          </div>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-icon" onClick={close} aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="drawer-body">
          {minted ? (
            <>
              <FleetLinkResult res={minted} />
              <div className="form-actions"><button type="button" className="btn" onClick={() => setMinted(null)}>Make another link</button></div>
            </>
          ) : (
            <form className="form" onSubmit={submit} noValidate>
              <p className="am-lead">One link for all of them: open it (or paste its command) on each machine and it joins, with no questions asked.</p>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="fl-for">Whose machines</label>
                  <select id="fl-for" className="select" value={target} onChange={(e) => { setTarget(e.target.value); setObserverOk(false); setOwnerOk(false); }}>
                    {members.map((m) => <option key={m.handle} value={m.handle}>@{m.handle}{m.handle === me?.handle ? " (you)" : ""} · {m.role}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="fl-uses">How many machines</label>
                  <select id="fl-uses" className="select" value={uses} onChange={(e) => setUses(Number(e.target.value))}>
                    {USES.map((n) => <option key={n} value={n}>{n === 0 ? "No limit" : `Up to ${n}`}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="fl-days">Works for</label>
                  <select id="fl-days" className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                  </select>
                </div>
              </div>
              <label className="check">
                <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
                <span>Approve each machine: new machines wait under <b>Waiting to join</b> until an owner approves them.</span>
              </label>
              {targetRole === "observer" && (
                <label className="check">
                  <input type="checkbox" checked={observerOk} onChange={(e) => setObserverOk(e.target.checked)} />
                  <span>Yes, as an observer&rsquo;s machines (they can read the team, never post).</span>
                </label>
              )}
              {targetRole === "owner" && (
                <label className="check">
                  <input type="checkbox" checked={ownerOk} onChange={(e) => setOwnerOk(e.target.checked)} />
                  <span>Yes, grant owner-level access: these machines can mint links, remove members, move authority and read restricted channels.</span>
                </label>
              )}
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={busy || !target || (targetRole === "owner" && !ownerOk)}>{busy ? "Creating…" : "Create link"}</button>
              </div>
              {error && <p className="field-error" role="alert">{error}</p>}
            </form>
          )}
          <h3 className="drawer-h">Fleet links</h3>
          <FleetLinkList refresh={minted?.id ?? ""} />
        </div>
      </aside>
    </div>
  );
}

/** What to send: the link (the token only in its #fragment) and the commands, with the facts and the warning. */
export function FleetLinkResult({ res }: { res: FleetLinkMinted }) {
  return (
    <div className="am-result" role="status">
      <p className="am-lead">
        Open this link on each machine: it shows the one command that installs Sqwakie and joins the machine as one of{" "}
        <span className="mono">@{res.handle}</span>&rsquo;s. Or run the command yourself on each machine.
      </p>
      <div className="am-facts">
        <span className="am-fact">{res.uses === 0 ? <>Any number of machines</> : <>Up to <b>{res.uses}</b> {res.uses === 1 ? "machine" : "machines"}</>}</span>
        <span className="am-fact">They join as <b className="mono">@{res.handle}</b>&rsquo;s ({res.role})</span>
        <span className="am-fact">Works until <b>{fullTime(res.expires_at)}</b></span>
        {res.approve && <span className="am-fact">Each waits for <b>your approval</b></span>}
      </div>
      {res.role === "owner" && <p className="am-warning">Owner-level access: these machines can mint links, remove members, move authority and read restricted channels.</p>}
      <div className="am-block">
        <h3 className="drawer-h">The link</h3>
        <CopyCommand command={res.link} label="Link" prompt={false} />
      </div>
      <div className="am-block">
        <h3 className="drawer-h">macOS or Linux</h3>
        <CopyCommand command={res.command} />
      </div>
      <div className="am-block">
        <h3 className="drawer-h">Windows (PowerShell, with WSL2)</h3>
        <CopyCommand command={res.windows_command} />
        <p className="field-hint">Sqwakie already installed there: <span className="mono">walkie join &lt;the link&gt;</span>.</p>
      </div>
      <div className="am-warn" role="note">
        <ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />
        <p>
          <b>Anyone with this link can add machines as @{res.handle}&rsquo;s</b> until it&rsquo;s used up, expires or you revoke it
          (link <span className="mono">{res.short}</span>, below). Keep it inside the business. Every machine that joins is listed here
          and under Machines, where you can revoke it; shell history and browser history may keep the link.
        </p>
      </div>
    </div>
  );
}

/** Every link on the roster authority: state, uses left, the machines that used it, waiting machines, Revoke. */
export function FleetLinkList({ refresh }: { refresh?: string }) {
  const { refreshTeam } = useActions();
  const [view, setView] = useState<FleetLinksView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [limit, setLimit] = useState<PlanLimitDetails | null>(null);
  const [nonce, setNonce] = useState(0);
  const keepError = useRef(false); // the reload after a refused decision must not wipe the refusal's message

  useEffect(() => {
    let cancelled = false;
    api.links()
      .then((v) => { if (!cancelled) { setView(v); setLoadError(null); if (keepError.current) keepError.current = false; else setError(null); } })
      .catch((err) => { if (!cancelled) setLoadError(friendlyError(err)); });
    return () => { cancelled = true; };
  }, [nonce, refresh]);

  const revoke = async (l: FleetLinkView) => {
    setBusy(l.id);
    setError(null);
    try {
      await api.revokeLink(l.id);
      setConfirm(null);
      setNonce((n) => n + 1);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (use: FleetLinkUse, approve: boolean) => {
    setBusy(use.node_id);
    setError(null);
    setLimit(null);
    try {
      await api.admit({ node_id: use.node_id, approve, link: use.link, generation: use.generation });
      refreshTeam();
      setNonce((n) => n + 1);
    } catch (err) {
      const d = planLimitOf(err);
      if (d) setLimit(d); else setError(friendlyError(err));
      keepError.current = true;
      setNonce((n) => n + 1); // a refused decision is usually a stale row: reload so it cannot be acted on again
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <ErrorState compact message={loadError} onRetry={() => setNonce((n) => n + 1)} />;
  if (!view) return <SkeletonRows rows={2} />;
  if (!view.links.length) return <p className="panel-empty">No fleet links yet. Add machines makes one link for a whole fleet.</p>;
  return (
    <ul className="fleet-list">
      {view.links.map((l) => {
        const uses = view.uses.filter((u) => u.link === l.id);
        const waiting = uses.filter((u) => u.state === "pending");
        const joined = uses.filter((u) => u.state === "admitted");
        const live = l.state === "active" || l.state === "used_up";
        return (
          <li key={l.id} className={`fleet-row${live ? "" : " is-off"}`}>
            <div className="fleet-head">
              <span className="person-cell">
                <Link2 size={13} strokeWidth={1.75} aria-hidden="true" />
                <span className="mono">{l.short}</span>
                <span className="muted">for <span className="mono">@{l.handle}</span></span>
                <span className={`chip${l.state === "active" ? "" : " chip-amber"}`}>{STATE_LABEL[l.state]}</span>
              </span>
              {live && (confirm === l.id ? (
                <span className="pending-actions">
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy === l.id} onClick={() => void revoke(l)} aria-label={`Confirm revoke fleet link ${l.short}`}>Revoke link</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>Keep</button>
                </span>
              ) : (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(l.id)} aria-label={`Revoke fleet link ${l.short}`}>Revoke</button>
              ))}
            </div>
            <div className="pending-meta muted tnum">
              {usesText(l)}{l.pending ? ` · ${l.pending} waiting` : ""}
              {l.state === "active" && <> · until {fullTime(l.expires_at)}</>}
              {l.state === "dead" && <> · {reasonText(l.reason)}</>}
              {l.approve && " · approve each"} · by @{l.created_by}
            </div>
            {waiting.length > 0 && (
              <ul className="pending-list">
                {waiting.map((u) => (
                  <li key={u.node_id} className="pending-row">
                    <div className="pending-text">
                      <span className="mono">{u.hostname}</span>
                      <span className="pending-meta muted tnum">node {u.node_id.slice(0, 8)} · <RelTime ts={u.at} long /></span>
                    </div>
                    <div className="pending-actions">
                      <button type="button" className="btn btn-sm btn-primary" disabled={busy === u.node_id} onClick={() => void decide(u, true)} aria-label={`Approve ${u.hostname} node ${u.node_id.slice(0, 8)}`}>
                        <Check size={13} strokeWidth={2} aria-hidden="true" />Approve
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" disabled={busy === u.node_id} onClick={() => void decide(u, false)} aria-label={`Deny ${u.hostname} node ${u.node_id.slice(0, 8)}`}>
                        <X size={13} strokeWidth={2} aria-hidden="true" />Deny
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {joined.length > 0 && (
              <p className="pending-meta muted">
                Joined: {joined.slice(0, 8).map((u) => u.hostname).join(", ")}{joined.length > 8 ? ` and ${joined.length - 8} more` : ""}
              </p>
            )}
          </li>
        );
      })}
      {error && <li><p className="field-error" role="alert">{error}</p></li>}
      {limit && <li><PlanLimitNotice details={limit} /></li>}
    </ul>
  );
}
