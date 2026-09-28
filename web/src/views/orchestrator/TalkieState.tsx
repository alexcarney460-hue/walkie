// ORCH-2: WalkieTalkie starts on its own on the team's lead machine. This machine's state from GET /v1/orchestrator:
// running (the chat), standby (another machine leads), needs a model login (the one step to add one), or stopped by
// hand (the manual Start, in Orchestrator.tsx).
import { useEffect, useState } from "react";
import { KeyRound, Loader, Play, RadioTower } from "lucide-react";
import { api } from "../../api/client.ts";
import { ErrorState } from "../../components/primitives.tsx";
import { lifecycleError } from "./lifecycle-error.ts";
import type { OrchestratorView } from "../../api/types.ts";
import { CopyCommand } from "../../components/primitives.tsx";
import { StartOrchestrator } from "./Lifecycle.tsx";

export type TalkieView = OrchestratorView["local"];

/** The host's view, fetched now, whenever `refresh` changes (its status moved) and every 10 s. */
export function useTalkieView(refresh: string): TalkieView | null {
  const [view, setView] = useState<TalkieView | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.orchestrator().then((v) => { if (!cancelled) setView(v.local); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [refresh]);
  return view;
}

/** Whether this machine's WalkieTalkie is standing down (another machine leads, or no model login here). */
export function standingDown(v: TalkieView | null): boolean {
  return v?.state === "standby" || v?.state === "needs_login";
}

/**
 * pre.8 (Alex: "it should just run on its own"): what a machine whose WalkieTalkie isn't running shows instead of a
 * Start button: stopped by you (the one button: Resume = automatic), or starting (it starts on its own), or, only on a
 * daemon without the auto-start, the manual start.
 */
export type NotRunningKind = "stopped_by_you" | "starting" | "failed" | "manual";
export function notRunningKind(v: TalkieView | null): NotRunningKind {
  if (v?.stopped_by_hand) return "stopped_by_you";
  if (v?.state === "failed") return "failed";
  if (v?.auto) return "starting";
  return "manual";
}

/** Resume = back to automatic (POST /v1/orchestrator/auto). */
export function ResumeButton({ size }: { size?: "sm" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = async () => {
    setBusy(true);
    setError(null);
    try { await api.orchestratorAuto(); } catch (err) { setError(lifecycleError(err)); } finally { setBusy(false); }
  };
  return (
    <div className="orch-start">
      <button type="button" className={`btn btn-primary${size === "sm" ? " btn-sm" : ""}`} disabled={busy} aria-busy={busy} onClick={() => void resume()}>
        <Play size={size === "sm" ? 13 : 15} strokeWidth={2} aria-hidden="true" />
        {busy ? "Resuming…" : "Resume"}
      </button>
      {error && <ErrorState message={error} compact />}
    </div>
  );
}

export function StoppedCard({ kind, view }: { kind: Exclude<NotRunningKind, "manual">; view?: TalkieView | null }) {
  if (kind === "failed") {
    return (
      <div className="orch-card" role="alert" aria-labelledby="orch-failed-title">
        <div className="orch-card-icon" aria-hidden="true"><KeyRound size={18} strokeWidth={1.75} /></div>
        <h2 id="orch-failed-title" className="orch-card-title">WalkieTalkie keeps failing</h2>
        <p className="orch-card-body">{view?.last_error ?? "Claude exited repeatedly. Check walkie talkie status for the error."}</p>
        <StartOrchestrator />
      </div>
    );
  }
  if (kind === "starting") {
    return (
      <div className="orch-card" role="status" aria-labelledby="orch-starting-title">
        <div className="orch-card-icon" aria-hidden="true"><Loader size={18} strokeWidth={1.75} /></div>
        <h2 id="orch-starting-title" className="orch-card-title">WalkieTalkie is starting</h2>
        <p className="orch-card-body">It starts on its own on this machine; nothing to press.</p>
      </div>
    );
  }
  return (
    <div className="orch-card" role="region" aria-labelledby="orch-stopped-title">
      <div className="orch-card-icon" aria-hidden="true"><Play size={18} strokeWidth={1.75} /></div>
      <h2 id="orch-stopped-title" className="orch-card-title">WalkieTalkie is stopped (by you)</h2>
      <p className="orch-card-body">It stays stopped until you resume it. Resume makes it automatic again: it runs here while this machine leads your team, and stands by otherwise.</p>
      <ResumeButton />
    </div>
  );
}

export function TalkieStateCard({ view }: { view: TalkieView }) {
  if (view.state === "standby") {
    return (
      <div className="orch-card" role="region" aria-labelledby="orch-standby-title">
        <div className="orch-card-icon" aria-hidden="true"><RadioTower size={18} strokeWidth={1.75} /></div>
        <h2 id="orch-standby-title" className="orch-card-title">WalkieTalkie is on standby here</h2>
        <p className="orch-card-body">
          {view.lead
            ? <>Your team's WalkieTalkie runs on <strong className="mono">{view.lead}</strong>, the lead machine. This machine takes over on its own if {view.lead} is offline for 5 minutes, and hands back when it returns.</>
            : <>No team machine can lead yet (the lead is the roster authority, or an owner's machine, with a model login). This machine starts it as soon as it may lead.</>}
        </p>
      </div>
    );
  }
  return (
    <div className="orch-card" role="region" aria-labelledby="orch-login-title">
      <div className="orch-card-icon" aria-hidden="true"><KeyRound size={18} strokeWidth={1.75} /></div>
      <h2 id="orch-login-title" className="orch-card-title">WalkieTalkie needs a model login</h2>
      <p className="orch-card-body">{view.needs ?? "Sign in to Claude Code on this machine."} It starts on its own the moment one is there.</p>
      {view.logins && view.logins.length > 0 && <p className="orch-card-note">Found here: {view.logins.join(", ")}.</p>}
      <CopyCommand command="claude" />
    </div>
  );
}
