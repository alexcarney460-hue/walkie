import { useEffect, useRef, useState } from "react";
import { api, ApiError, friendlyError } from "../../api/client.ts";
import type { Recommendation, RecommendationDecision } from "../../api/types.ts";
import { displayStoredText } from "../../../../src/protocol/display-text.ts";
import { useRoute } from "../../lib/route.ts";
import { RememberedDetails } from "../../components/RememberedDetails.tsx";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";

type RowState = { pending?: RecommendationDecision; error?: string };

function RecommendationRow({ rec, row, disabled, refreshDisabled, onAnswer, onRefresh }: {
  rec: Recommendation; row?: RowState; disabled: boolean; refreshDisabled: boolean;
  onAnswer: (rec: Recommendation, decision: RecommendationDecision) => void; onRefresh: () => void;
}) {
  const [showOutgoing, setShowOutgoing] = useState(false);
  return <li id={`rec-${rec.id}`} className="orch-rec" aria-busy={!!row?.pending}>
    {rec.project_name && <p className="orch-rec-project">{rec.project_name}</p>}
    <h4>{rec.summary}</h4>
    <p>{rec.reason}</p>
    {rec.status === "pending" && typeof rec.outgoing === "string" && <div className="orch-rec-outgoing">
      <p className="orch-rec-label">Approving sends this in your name</p>
      <blockquote className={showOutgoing ? "orch-rec-message" : "orch-rec-message is-clamped"}>{displayStoredText(rec.outgoing)}</blockquote>
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showOutgoing} onClick={() => setShowOutgoing((open) => !open)}>{showOutgoing ? "Show less" : "Show all"}</button>
    </div>}
    <RememberedDetails id={`suggestion-${rec.id}`} summary="Details">
      {rec.context && <blockquote className="orch-rec-context">
        <p className="orch-rec-label">Talkie wrote this (it is not sent)</p>
        <p className="orch-rec-message">“{rec.context}”</p>
      </blockquote>}
      {rec.status === "pending" && rec.outgoing === null && <p>Its card is gone, so approving it will be refused.</p>}
      <details><summary>Evidence ({rec.evidence.length})</summary>
        {rec.evidence.length ? <ul>{rec.evidence.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p>No additional evidence.</p>}
      </details>
    </RememberedDetails>
    {rec.status === "pending" ? <>
      {rec.why_not && <p>{rec.why_not}</p>}
      <div className="orch-rec-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={disabled || !rec.can_approve}
          onClick={() => onAnswer(rec, "approve")}>Approve</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || !rec.can_dismiss}
          onClick={() => onAnswer(rec, "dismiss")}>Dismiss</button>
      </div>
    </> : <p role="status" className="orch-rec-status">{rec.status === "superseded" ? "No longer needed" : rec.status === "expired" ? "Expired" : rec.status === "approved" ? "Approved" : "Dismissed"}
      {rec.resolved && <> by {rec.resolved.by}{rec.resolved.note && <> · {rec.resolved.note}</>}</>}
    </p>}
    {row?.pending && <p role="status">{row.pending === "approve" ? "Approving…" : "Dismissing…"}</p>}
    {row?.error && <div role="alert"><p>{row.error}</p>
      <button type="button" className="btn btn-ghost btn-sm" disabled={refreshDisabled} onClick={onRefresh}>Refresh before trying again</button>
    </div>}
  </li>;
}

export function RecommendationItems({ recs, rows = {}, loading = false, more = 0, onAnswer, onRefresh }: {
  recs: readonly Recommendation[]; rows?: Readonly<Record<string, RowState>>; loading?: boolean;
  /** Open recommendations the server did not list (past its cap). */
  more?: number;
  onAnswer: (rec: Recommendation, decision: RecommendationDecision) => void; onRefresh: () => void;
}) {
  if (!recs.length) return <p>No recommendations right now.</p>;
  const refreshDisabled = loading || Object.values(rows).some((row) => row.pending);
  return <>{more > 0 && <p role="note">{more} more open recommendation{more === 1 ? " is" : "s are"} not shown. Answer some, then refresh to see the rest.</p>}
  <ul>{recs.map((rec) => <ErrorBoundary key={rec.id} scope="item" as="li" name={`suggestion ${rec.id}`} resetKeys={[rec, rows[rec.id]]}>
    <RecommendationRow rec={rec} row={rows[rec.id]} disabled={loading || !!rows[rec.id]?.pending || !!rows[rec.id]?.error}
      refreshDisabled={refreshDisabled} onAnswer={onAnswer} onRefresh={onRefresh} />
  </ErrorBoundary>)}</ul></>;
}

export function RecommendationsPanel() {
  const route = useRoute();
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [more, setMore] = useState(0);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  // Synchronous locks also cover clicks before React renders the disabled controls.
  const pending = useRef(new Set<string>());
  const blocked = useRef(new Set<string>());
  const reading = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const scrolledTo = useRef<string | null>(null);

  async function refresh() {
    if (reading.current || pending.current.size) return;
    reading.current = true;
    const current = ++generation.current;
    setState("loading"); setError("");
    try {
      const result = await api.recommendations();
      if (!mounted.current || current !== generation.current) return;
      setRecs(result.recs); setMore(result.more_open ?? 0); setRows({}); blocked.current.clear(); setState("ready");
    } catch (err) {
      if (mounted.current && current === generation.current) { setError(friendlyError(err)); setState("error"); }
    } finally { if (current === generation.current) reading.current = false; }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; generation.current++; reading.current = false; };
  }, []);

  useEffect(() => {
    if (!route.tab?.startsWith("rec-")) { scrolledTo.current = null; return; }
    if (scrolledTo.current !== route.tab && recs.some((rec) => `rec-${rec.id}` === route.tab)) {
      const target = document.getElementById(route.tab);
      if (target) { target.scrollIntoView({ block: "center" }); scrolledTo.current = route.tab; }
    }
  }, [route.tab, recs]);

  async function answer(rec: Recommendation, decision: RecommendationDecision) {
    if (reading.current || state !== "ready" || pending.current.has(rec.id) || blocked.current.has(rec.id)
      || rec.status !== "pending" || !(decision === "approve" ? rec.can_approve : rec.can_dismiss)) return;
    pending.current.add(rec.id);
    setRows((old) => ({ ...old, [rec.id]: { pending: decision } }));
    try {
      // The exact text shown is echoed: if the recommendation changed since (a card renamed), the daemon refuses it.
      const result = await api.answerRecommendation(rec.id, decision, typeof rec.outgoing === "string" ? rec.outgoing : undefined);
      if (result.rec.id !== rec.id || result.rec.status !== (decision === "approve" ? "approved" : "dismissed")) {
        throw new ApiError("bad_response", "The action could not be confirmed.", 502);
      }
      if (!mounted.current) return;
      setRecs((old) => old.map((r) => r.id === rec.id ? result.rec : r));
      setRows((old) => ({ ...old, [rec.id]: {} }));
    } catch (err) {
      // Never replay a POST: even a timeout may follow a completed action. A person must read fresh state first.
      blocked.current.add(rec.id);
      if (!mounted.current) return;
      const message = err instanceof ApiError ? err.message : friendlyError(err);
      setRows((old) => ({ ...old, [rec.id]: { error: `${message} Refresh to check its current status.` } }));
    } finally { pending.current.delete(rec.id); }
  }

  if (state === "ready" && !recs.length && more === 0) return null;
  return <section className="orch-recommendations" aria-labelledby="talkie-recs-heading">
    <div className="orch-rec-heading"><h2 id="talkie-recs-heading">Suggestions</h2>
      <button type="button" className="btn btn-ghost btn-sm" disabled={state === "loading" || Object.values(rows).some((r) => r.pending)} onClick={() => void refresh()}>Refresh</button>
    </div>
    <p>Review these suggestions. Each approval carries out the suggested action.</p>
    {state === "loading" && <p role="status">Loading recommendations…</p>}
    {state === "error" && <div role="alert"><p>{error}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}>Retry recommendations</button></div>}
    {state === "ready" && <RecommendationItems recs={recs} rows={rows} more={more} onAnswer={(rec, decision) => void answer(rec, decision)} onRefresh={() => void refresh()} />}
  </section>;
}
