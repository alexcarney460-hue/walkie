// ORCH-2: WalkieTalkie starts on its own on the team's lead machine. This machine's state from GET /v1/orchestrator:
// running (the chat), standby (another machine leads), needs a model login (the one step to add one), or stopped by
// hand (the manual Start, in Orchestrator.tsx).
import { useEffect, useState } from "react";
import { KeyRound, RadioTower } from "lucide-react";
import { api } from "../../api/client.ts";
import type { OrchestratorView } from "../../api/types.ts";
import { CopyCommand } from "../../components/primitives.tsx";

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
