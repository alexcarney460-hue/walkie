// ORCH-2: WalkieTalkie starts on its own on the team's lead machine. This machine's state from GET /v1/orchestrator:
// running (the chat), standby (another machine leads), needs a model login (the one step to add one), or stopped by
// hand (the manual Start, in Orchestrator.tsx).
import { useEffect, useState } from "react";
import { ArrowUpRight, KeyRound, Loader, Play, RadioTower, TriangleAlert } from "lucide-react";
import { api } from "../../api/client.ts";
import { ErrorState } from "../../components/primitives.tsx";
import { duration, useNow } from "../../lib/time.ts";
import { lifecycleError } from "./lifecycle-error.ts";
import { StartOrchestrator, StopOrchestrator } from "./Lifecycle.tsx";
import { modelLabel } from "./model.ts";
import type { OrchestratorAccess, OrchestratorView } from "../../api/types.ts";
import { CopyCommand } from "../../components/primitives.tsx";

export type TalkieView = OrchestratorView["local"];

export function cleanupDiagnostic(view: TalkieView): string {
  return (view.last_error ?? "Verifying that the dedicated shell user has no processes.")
    .replace(/\s+/g, " ").slice(0, 240);
}

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

/** The Start dialog's access labels (ORCH-2), for a compact status line that isn't the dialog itself. */
export function accessLabel(access?: OrchestratorAccess): string {
  return access === "full" ? "Full access" : "Walkie tools";
}

/**
 * ORCH-STATUS-1: one line of this host's real WalkieTalkie state — running (model, access, uptime), standby (the
 * lead), needing a model login, or stopped (by a person, or starting on its own) — for Mission Control's card and
 * the WalkieTalkie page's header.
 */
export function talkieSummaryText(v: TalkieView | null, now: number): string {
  if (!v) return "Not reporting";
  if (v.state === "standby") return v.lead ? `Standby · leads on ${v.lead}` : "Standby · no machine can lead yet";
  if (v.state === "needs_login") return "Needs a model login";
  if (v.running) {
    const bits = [modelLabel(v.model ?? v.model_setting), accessLabel(v.access)];
    if (v.started_at) bits.push(`up ${duration(now - v.started_at)}`);
    return bits.join(" · ");
  }
  if (v.stopped_by_hand) return "Stopped by you";
  if (v.auto) return "Starting on its own";
  return "Stopped";
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
        <p className="orch-card-body">{view?.last_error ?? "It starts on its own on this machine; nothing to press."}</p>
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
  if (view.state === "cleanup_pending") {
    return (
      <div className="orch-card" role="status" aria-labelledby="orch-cleanup-title">
        <div className="orch-card-icon" aria-hidden="true"><TriangleAlert size={18} strokeWidth={1.75} /></div>
        <h2 id="orch-cleanup-title" className="orch-card-title">WalkieTalkie cleanup pending</h2>
        <p className="orch-card-body">{cleanupDiagnostic(view)}</p>
      </div>
    );
  }
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

/**
 * ORCH-STATUS-1: Mission Control's compact card for this host's WalkieTalkie — its real state (running or why not),
 * the lead machine, model, access and uptime — with the one control that matches it (Resume, Start, or Stop; none
 * while standing by or starting, since nothing to press there either). Pure and prop-driven so it's testable without
 * the fetch; `WalkieTalkieCard` below wires it to the live view.
 */
export function WalkieTalkieStatus({ view, now }: { view: TalkieView | null; now: number }) {
  const running = view?.running === true && !standingDown(view);
  const kind = notRunningKind(view);
  return (
    <section className="wt-card" aria-labelledby="wt-card-h" data-testid="walkietalkie-card">
      <header className="wt-card-head">
        <RadioTower size={14} strokeWidth={1.75} className="wt-icon" aria-hidden="true" />
        <h2 id="wt-card-h" className="wt-card-title">WalkieTalkie</h2>
        <span className={`wt-dot${running ? " is-on" : ""}`} aria-hidden="true" data-testid="walkietalkie-dot" />
        <a className="wt-more" href="#/orchestrator">
          Open <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden="true" />
        </a>
      </header>
      <p className="wt-card-meta" data-testid="walkietalkie-summary">{talkieSummaryText(view, now)}</p>
      {running ? (
        <div className="wt-card-controls"><StopOrchestrator /></div>
      ) : standingDown(view) || kind === "starting" ? null : (
        <div className="wt-card-controls">{kind === "stopped_by_you" ? <ResumeButton size="sm" /> : <StartOrchestrator size="sm" />}</div>
      )}
    </section>
  );
}

/** The live wrapper Mission Control renders: this host's view, polled, fed into WalkieTalkieStatus. */
export function WalkieTalkieCard() {
  const now = useNow();
  const view = useTalkieView("");
  return <WalkieTalkieStatus view={view} now={now} />;
}
