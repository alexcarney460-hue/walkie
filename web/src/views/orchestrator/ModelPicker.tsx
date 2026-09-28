// ORCH-2: the orchestrator's model: Default (Claude's own), an alias the installed claude accepts, or a full model id.
// Used in the chat header (switches now, or after the reply in progress; the conversation continues) and in the
// Start dialog (the model it starts with).
import { useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import type { OrchestratorAccess, OrchestratorView } from "../../api/types.ts";
import { ErrorState } from "../../components/primitives.tsx";
import { DEFAULT_MODEL, MODEL_ALIASES, validModel } from "../../../../src/protocol/orchestrator.ts";
import { lifecycleError } from "./lifecycle-error.ts";

const CUSTOM = "__custom";
const LABEL: Record<string, string> = { default: "Default", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };

export const MODEL_CHOICES: readonly string[] = [DEFAULT_MODEL, ...MODEL_ALIASES];

/**
 * A select of the choices plus "Full model id…", which shows a text field; `onPick` gets a valid name only.
 * `value` is the current setting (a full id shows as itself, selected).
 */
export function ModelPicker({ value, onPick, disabled, compact, id = "orch-model" }: {
  value: string; onPick: (model: string) => void; disabled?: boolean; compact?: boolean; id?: string;
}) {
  const known = MODEL_CHOICES.includes(value);
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState(known ? "" : value);
  const bad = text.trim() !== "" && !validModel(text.trim());
  return (
    <span className={`orch-model${compact ? " is-compact" : ""}`}>
      <label htmlFor={id} className="orch-model-label">Model</label>
      <select
        id={id} className="orch-model-select" value={custom ? CUSTOM : value} disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM) { setCustom(true); return; }
          setCustom(false);
          if (v !== value) onPick(v);
        }}
      >
        {MODEL_CHOICES.map((m) => <option key={m} value={m}>{LABEL[m] ?? m}</option>)}
        {!known && <option value={value}>{value}</option>}
        <option value={CUSTOM}>Full model id…</option>
      </select>
      {custom && (
        <form className="orch-model-custom" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t && !bad) { setCustom(false); onPick(t); } }}>
          <input
            className="orch-model-input mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="claude-sonnet-4-6"
            aria-label="Full model id" aria-invalid={bad} maxLength={100} disabled={disabled} autoFocus
          />
          <button type="submit" className="btn btn-sm" disabled={disabled || !text.trim() || bad}>Use</button>
        </form>
      )}
    </span>
  );
}

/** The chat header's access switch (ORCH-2): Walkie tools only, or every tool. */
export function AccessSelect({ value, onPick, disabled }: { value: OrchestratorAccess; onPick: (a: OrchestratorAccess) => void; disabled?: boolean }) {
  return (
    <span className="orch-model is-compact">
      <label htmlFor="orch-head-access" className="orch-model-label">Access</label>
      <select id="orch-head-access" className="orch-model-select" value={value} disabled={disabled}
        onChange={(e) => { const v = e.target.value as OrchestratorAccess; if (v !== value) onPick(v); }}>
        <option value="platform">Walkie tools</option>
        <option value="full">Full access</option>
      </select>
    </span>
  );
}

/** The chat header's picker: the running orchestrator's setting, switched in place (ORCH-2). */
export function HeaderModel({ refresh }: { refresh: string }) {
  const [view, setView] = useState<OrchestratorView["local"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.orchestrator().then((v) => { if (!cancelled) setView(v.local); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [refresh]);
  if (!view?.running) return null;
  const run = async (op: () => Promise<OrchestratorView>) => {
    setBusy(true);
    setError(null);
    try {
      setView((await op()).local);
    } catch (err) {
      setError(lifecycleError(err));
    } finally {
      setBusy(false);
    }
  };
  const pickAccess = (a: OrchestratorAccess) => {
    if (a === "full" && !window.confirm("Give WalkieTalkie full access? Every tool runs on this machine without asking (Claude's bypass permissions).")) return;
    void run(() => api.orchestratorAccess(a));
  };
  return (
    <div className="orch-head-model">
      <AccessSelect value={view.access ?? "platform"} onPick={pickAccess} disabled={busy} />
      <ModelPicker value={view.model_setting ?? DEFAULT_MODEL} onPick={(m) => void run(() => api.orchestratorModel(m))} disabled={busy} compact id="orch-head-model" />
      {view.model_pending && <span className="orch-model-pending" role="status">after this reply</span>}
      {error && <div className="orch-head-error"><ErrorState message={error} compact /></div>}
    </div>
  );
}
