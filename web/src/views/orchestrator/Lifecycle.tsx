// Start and stop this machine's orchestrator from the dashboard (POST /v1/orchestrator/start | stop). The dashboard is
// the person at this machine (a session): the daemon lets it, and refuses agents and the paired phone (routes.ts);
// the phone app has no Orchestrator tab. Start sends only the access and model the person picks (ORCH-2: `platform`, the default,
// always allows the Walkie tools and CLI; `full` allows every tool); the rest is the daemon's defaults (Claude from its
// PATH or the usual install places, the home directory, default permissions). `walkie orchestrator start` sets them.
import { useEffect, useState } from "react";
import { Play, Square } from "lucide-react";
import { api } from "../../api/client.ts";
import type { OrchestratorAccess } from "../../api/types.ts";
import { ErrorState } from "../../components/primitives.tsx";
import { lifecycleError } from "./lifecycle-error.ts";
import { ModelPicker } from "./ModelPicker.tsx";

const STARTED_WAIT_MS = 20_000;

const ACCESS_OPTIONS: readonly { value: OrchestratorAccess; label: string; hint: string }[] = [
  { value: "platform", label: "Walkie platform", hint: "Recommended. Runs Walkie for you (boards, agents, seats, accounts); other tools follow the default permissions, so some are refused." },
  { value: "full", label: "Full access", hint: "Every tool allowed on this machine without asking (Claude's bypass permissions)." },
];

/** The access choice of the Start dialog (ORCH-2). */
export function AccessChoice({ value, onChange, disabled, compact }: { value: OrchestratorAccess; onChange: (v: OrchestratorAccess) => void; disabled?: boolean; compact?: boolean }) {
  return (
    <fieldset className={`orch-access${compact ? " is-compact" : ""}`} disabled={disabled}>
      <legend className="orch-access-legend">Access</legend>
      {ACCESS_OPTIONS.map((o) => (
        <label key={o.value} className="orch-access-option">
          <input type="radio" name="orch-access" value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span className="orch-access-label">{o.label}</span>
          {!compact && <span className="orch-access-hint">{o.hint}</span>}
        </label>
      ))}
    </fieldset>
  );
}

/** Starts the orchestrator: "Starting…" until it answers (and until it shows as running here), the daemon's refusal inline. */
export function StartOrchestrator({ size }: { size?: "sm" }) {
  const [phase, setPhase] = useState<"idle" | "starting" | "started">("idle");
  const [error, setError] = useState<string | null>(null);
  const [access, setAccess] = useState<OrchestratorAccess>("platform");
  const [model, setModel] = useState("default");
  // It shows as running once its status reaches the stream (this card is replaced then); if that never comes, the
  // button is back after a while rather than stuck on "Starting…".
  useEffect(() => {
    if (phase !== "started") return;
    const t = setTimeout(() => setPhase("idle"), STARTED_WAIT_MS);
    return () => clearTimeout(t);
  }, [phase]);
  const start = async () => {
    setError(null);
    // ORCH-2: another machine leads the team's WalkieTalkie; starting here too means two running.
    const lead = await api.orchestrator().then((v) => (v.local.running ? undefined : v.local.lead), () => undefined);
    if (lead && !window.confirm(`WalkieTalkie is already running on ${lead}; start here anyway?`)) return;
    setPhase("starting");
    try {
      const { local } = await api.orchestratorStart(access, model);
      if (local.running) { setPhase("started"); return; }
      setError(local.last_error ? `It didn't start: ${local.last_error}` : "It didn't start. Try walkie talkie start in a terminal to see why.");
      setPhase("idle");
    } catch (err) {
      setError(lifecycleError(err));
      setPhase("idle");
    }
  };
  return (
    <div className="orch-start">
      <AccessChoice value={access} onChange={setAccess} disabled={phase !== "idle"} compact={size === "sm"} />
      <ModelPicker value={model} onPick={setModel} disabled={phase !== "idle"} compact={size === "sm"} id={size === "sm" ? "orch-start-model-sm" : "orch-start-model"} />
      <button type="button" className={`btn btn-primary${size === "sm" ? " btn-sm" : ""}`} disabled={phase !== "idle"} aria-busy={phase !== "idle"} onClick={() => void start()}>
        <Play size={size === "sm" ? 13 : 15} strokeWidth={2} aria-hidden="true" />
        {phase === "idle" ? "Start WalkieTalkie" : "Starting…"}
      </button>
      {error && <ErrorState message={error} compact />}
    </div>
  );
}

/** Stops it, after a confirmation: a reply in progress ends; the conversations stay on this machine. */
export function StopOrchestrator() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    if (!window.confirm("Stop WalkieTalkie on this machine? A reply in progress ends, and it stays stopped (it no longer starts on its own) until you start it again. Your conversations stay here.")) return;
    setError(null);
    setBusy(true);
    try {
      await api.orchestratorStop();
    } catch (err) {
      setError(lifecycleError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm orch-head-stop" disabled={busy} aria-busy={busy} onClick={() => void stop()} title="Stop WalkieTalkie" aria-label={busy ? "Stopping WalkieTalkie" : "Stop WalkieTalkie"}>
        <Square size={13} strokeWidth={2} aria-hidden="true" />
        <span className="orch-head-new-label">{busy ? "Stopping…" : "Stop"}</span>
      </button>
      {error && <div className="orch-head-error"><ErrorState message={error} compact /></div>}
    </>
  );
}
