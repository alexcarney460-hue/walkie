// The latest status report of a project, above its board (PROJECT-REPORTS-1): what WalkieTalkie last wrote for the
// project's members, as rendered Markdown, with the time its facts are as of; or a plain empty state. It reads the
// report post from the channel (every machine has it), through GET /v1/projects/:channel/status-report.
import { useCallback, useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { StatusReportPayload } from "../../api/types.ts";
import { ErrorState, RelTime, SkeletonRows } from "../../components/primitives.tsx";
import { RichMarkdown } from "../../lib/markdown-rich.tsx";

export type StatusReportState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: StatusReportPayload };

/** A new report arrives as an ordinary post, which the board's own stream does not announce: the panel looks again now and then. */
const REFRESH_MS = 120_000;

/** `paused`: the project is archived, so no new report is written until it is active again. */
export function StatusReportView({ state, onRetry, paused = false }: { state: StatusReportState; onRetry: () => void; paused?: boolean }) {
  if (state.status === "loading") return <section className="status-report" aria-label="Status report"><SkeletonRows rows={2} /></section>;
  if (state.status === "error") return <section className="status-report" aria-label="Status report"><ErrorState compact message={state.message} onRetry={onRetry} /></section>;
  const { mode, report } = state.data;
  return (
    <section className="status-report" aria-labelledby="status-report-title">
      <header className="status-report-head">
        <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
        <h2 id="status-report-title" className="status-report-title">Status report</h2>
        {report && <span className="status-report-meta muted">as of <RelTime ts={report.as_of} long /> · written by WalkieTalkie</span>}
      </header>
      {report ? <div className="status-report-body"><RichMarkdown text={report.markdown} /></div> : (
        <p className="status-report-empty muted">
          {paused ? "Status reports pause while a project is archived."
            : mode === "hourly"
              ? "No status report yet. WalkieTalkie writes one each hour something changes, so the first one appears within the hour."
              : "Hourly status reports are off for this project. An owner or the project's creator turns them on from the Projects list."}
        </p>
      )}
      {report && paused && <p className="status-report-note muted">This project is archived, so this report is no longer updated.</p>}
      {report && !paused && mode === "off" && <p className="status-report-note muted">Hourly status reports are off for this project, so this one is no longer updated.</p>}
    </section>
  );
}

export function StatusReportPanel({ channel, paused = false }: { channel: string; paused?: boolean }) {
  const [state, setState] = useState<StatusReportState>({ status: "loading" });
  const load = useCallback(() => {
    api.statusReport(channel)
      .then((data) => setState({ status: "ready", data }))
      .catch((err) => setState((s) => (s.status === "ready" ? s : { status: "error", message: friendlyError(err) })));
  }, [channel]);
  useEffect(() => {
    setState({ status: "loading" });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [channel, load]);
  return <StatusReportView state={state} paused={paused} onRetry={() => { setState({ status: "loading" }); load(); }} />;
}
