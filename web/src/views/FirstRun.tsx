import { useEffect, useState } from "react";
import { CircleCheck, RefreshCw } from "lucide-react";
import type { MeView } from "../api/types.ts";
import { Logo } from "../components/Shell.tsx";
import { CopyCommand } from "../components/primitives.tsx";
import { useActions } from "../state/store.tsx";

function suggestHandle(login: string | null): string {
  const local = (login ?? "").split("@")[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "") ?? "";
  return /^[a-z]/.test(local) ? local.slice(0, 24) : "you";
}

export function FirstRun({ me }: { me: MeView }) {
  const ts = me.tailscale;
  return (
    <main className="firstrun">
      <div className="firstrun-inner">
        <div className="firstrun-brand"><Logo size={28} /><span>Walkie</span></div>
        <h1 className="firstrun-title">This machine isn't on a team yet</h1>
        <p className="firstrun-lede">
          Walkie links your team's coding agents machine to machine: peer-to-peer and end-to-end encrypted with
          Walkie Direct, or over your Tailscale network if your team uses one. Start a team here, or join the one a
          teammate already runs. This page switches to the live dashboard as soon as the daemon joins.
        </p>

        <div className="firstrun-check is-ok">
          <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />
          <div>
            <p className="firstrun-check-title">{ts.ok ? "Tailscale is connected (optional)" : "Ready for Walkie Direct"}</p>
            <p className="muted">
              {ts.ok
                ? <>Signed in as <span className="mono">{ts.login}</span> on <span className="mono">{me.node.hostname}</span> ({me.node.ip}). New teams still default to Walkie Direct; pass <span className="mono">--tailscale</span> for a tailnet team.</>
                : <>No Tailscale on <span className="mono">{me.node.hostname}</span>, and none needed: Walkie Direct connects machines by their keys.</>}
            </p>
          </div>
        </div>

        <ol className="firstrun-steps">
          <li className="firstrun-step">
            <span className="firstrun-num tnum" aria-hidden="true">1</span>
            <div className="firstrun-step-body">
              <h2>Start a new team</h2>
              <p className="muted">You become its first owner. Then <span className="mono">walkie invite --handle &lt;name&gt;</span> prints a one-time code for each teammate.</p>
              <CopyCommand command={`walkie init "Our Team" --handle ${suggestHandle(ts.login)} --direct`} />
            </div>
          </li>
          <li className="firstrun-step">
            <span className="firstrun-num tnum" aria-hidden="true">2</span>
            <div className="firstrun-step-body">
              <h2>Or join your team</h2>
              <p className="muted">Paste the invite code an owner sent you. (A Tailscale team: <span className="mono">walkie join &lt;teammate-machine&gt;</span> instead.)</p>
              <CopyCommand command="walkie join <invite-code>" />
            </div>
          </li>
          <li className="firstrun-step">
            <span className="firstrun-num tnum" aria-hidden="true">3</span>
            <div className="firstrun-step-body">
              <h2>Connect your agents</h2>
              <p className="muted">Hooks report what each Claude Code or Codex session is doing. They never send prompts or spend tokens.</p>
              <CopyCommand command="walkie hooks install claude" />
            </div>
          </li>
        </ol>
        <p className="firstrun-foot muted"><span className="live-dot" aria-hidden="true" />Waiting for the daemon to join a team…</p>
      </div>
    </main>
  );
}

export function BootError({ message }: { message: string }) {
  const { retryBoot } = useActions();
  const [left, setLeft] = useState(5);
  useEffect(() => {
    const t = setInterval(() => setLeft((n) => (n <= 1 ? 0 : n - 1)), 1_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left === 0) retryBoot();
  }, [left, retryBoot]);
  return (
    <main className="firstrun">
      <div className="firstrun-inner">
        <div className="firstrun-brand"><Logo size={28} /><span>Walkie</span></div>
        <h1 className="firstrun-title">Can't reach the Walkie daemon</h1>
        <p className="firstrun-lede">{message} The dashboard is served by the <span className="mono">walkie</span> daemon on this machine. Start it, then this page reconnects by itself.</p>
        <CopyCommand command="walkie daemon start" />
        <div className="firstrun-actions">
          <button type="button" className="btn" onClick={retryBoot}>
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            Retry now
          </button>
          <span className="muted tnum">Retrying in {left}s</span>
        </div>
        <p className="muted firstrun-foot">Still stuck? <span className="mono">walkie doctor</span> checks the network (Walkie Direct or Tailscale), the roster, peers and the database.</p>
      </div>
    </main>
  );
}

/**
 * The dashboard session ended (a 401): sign-out, token rotation or the 7-day limit. Not "can't reach the daemon":
 * the daemon answered. A new sign-in (another tab, `walkie dashboard`, the desktop app's Open Dashboard) is picked up
 * by itself (store.tsx listens for it), so there is nothing to retry on a timer.
 */
export function SignedOut() {
  const { retryBoot } = useActions();
  return (
    <main className="firstrun">
      <div className="firstrun-inner">
        <div className="firstrun-brand"><Logo size={28} /><span>Walkie</span></div>
        <h1 className="firstrun-title">Signed out of this dashboard</h1>
        <p className="firstrun-lede">
          Walkie is running, but this dashboard's session ended: every dashboard was signed out, the local token was rotated,
          it went unused for 12 hours, or it reached its 7-day limit. Sign in again with <strong>Open Dashboard</strong> in the Walkie menu bar,
          or in a terminal:
        </p>
        <CopyCommand command="walkie dashboard" />
        <div className="firstrun-actions">
          <button type="button" className="btn" onClick={retryBoot}>
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            I signed in, check again
          </button>
          <span className="muted">This page also picks up a new sign-in by itself.</span>
        </div>
      </div>
    </main>
  );
}
