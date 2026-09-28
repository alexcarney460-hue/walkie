import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import { ApiError, api, friendlyError } from "../api/client.ts";
import type { AddMachine } from "../../../src/protocol/add-machine.ts";
import { CopyCommand, ErrorState, SkeletonRows } from "../components/primitives.tsx";
import { fullTime } from "../lib/time.ts";

type Load = { state: "loading" } | { state: "ready"; res: AddMachine } | { state: "error"; message: string; direct: boolean };

/** What an owner sees when this team can't mint codes (a Tailscale team whose authority doesn't run Walkie Direct). */
const DIRECT_UNAVAILABLE =
  "This team's roster authority doesn't run Walkie Direct, so there is no one-time link to send. On a Tailscale team, "
  + "the person's new machine joins by itself: sign it in to Tailscale with their login, then run walkie setup --join <a teammate's machine>. "
  + "To send links instead, run walkie direct enable on the roster authority.";

/**
 * "Add a machine" (WALKIE-ADD-MACHINE-1): mints a one-time code for another machine of a current member and shows the
 * shareable link (the code only in its #fragment), the install command pinned to this release, copy buttons, the
 * expiry and who it works for. Owners only: the Team page offers it on each member row.
 */
export function AddMachineSheet({ handle, name, onClose }: { handle: string; name: string; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [nonce, setNonce] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const close = useCallback(onClose, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    api.addMachine({ handle })
      .then((res) => { if (!cancelled) setLoad({ state: "ready", res }); })
      .catch((err) => {
        if (cancelled) return;
        const direct = err instanceof ApiError && err.code === "direct_unavailable";
        setLoad({ state: "error", message: direct ? DIRECT_UNAVAILABLE : friendlyError(err), direct });
      });
    return () => { cancelled = true; };
  }, [handle, nonce]);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      (returnFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [close]);

  return (
    <div className="drawer-layer">
      <div className="scrim" onClick={close} aria-hidden="true" />
      <aside className="drawer add-machine" role="dialog" aria-modal="true" aria-labelledby="am-title">
        <header className="drawer-head">
          <div className="drawer-head-text">
            <div className="drawer-kicker"><span className="muted">{name}</span></div>
            <h2 className="drawer-title" id="am-title">Add a machine for <span className="mono">@{handle}</span></h2>
          </div>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-icon" onClick={close} aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="drawer-body">
          {load.state === "loading" && <SkeletonRows rows={3} />}
          {load.state === "error" && <ErrorState message={load.message} onRetry={load.direct ? undefined : () => setNonce((n) => n + 1)} />}
          {load.state === "ready" && <AddMachineResult res={load.res} />}
        </div>
      </aside>
    </div>
  );
}

export function AddMachineResult({ res }: { res: AddMachine }) {
  return (
    <div className="am-result" role="status">
      <p className="am-lead">
        Send <span className="mono">@{res.handle}</span> this link. It opens a page with the one command that installs Walkie on
        their new machine and joins it to the team as one of their machines.
      </p>
      <div className="am-facts">
        <span className="am-fact">Works once, only for <b className="mono">@{res.handle}</b></span>
        <span className="am-fact">Expires <b>{fullTime(res.expires_at)}</b></span>
        <span className="am-fact">Role stays <b>{res.role}</b></span>
      </div>
      <div className="am-block">
        <h3 className="drawer-h">The link to send them</h3>
        <CopyCommand command={res.link} label="Link" prompt={false} />
      </div>
      <div className="am-block">
        <h3 className="drawer-h">Or the command, on the new machine (macOS or Linux)</h3>
        <CopyCommand command={res.command} />
        <p className="field-hint">Walkie already installed there: <span className="mono">walkie join &lt;code&gt;</span> with the code at the end of the command.</p>
      </div>
      {res.team_agents && (
        <p className="field-hint">
          The installer asks them one question: may the team start agents on that machine? No is the default. Yes runs each agent
          as a separate user of its own on their Claude or Codex sign-in, and they can turn it off any time.
        </p>
      )}
      <div className="am-warn" role="note">
        <ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />
        <p>
          <b>Anyone with this link joins as one of @{res.handle}&rsquo;s machines.</b> Send it privately, only to them: it works once
          and expires in 7 days, but until then it stays in the browser history (and synced history) of wherever it&rsquo;s opened. If it
          leaks, the machine it admits shows up under Machines: revoke it with <span className="mono">walkie team revoke &lt;machine&gt;</span>.
        </p>
      </div>
    </div>
  );
}
