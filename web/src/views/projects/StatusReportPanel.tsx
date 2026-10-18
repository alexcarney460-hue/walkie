// The latest status report of a project, above its board (PROJECT-REPORTS-1): what Talkie last wrote for the
// project's members, as rendered Markdown, with the time its facts are as of; or a plain empty state. It reads the
// report post from the channel (every machine has it), through GET /v1/projects/:channel/status-report.
import { useCallback, useEffect, useState } from "react";
import { api, friendlyError } from "../../api/client.ts";
import type { StatusReportPayload } from "../../api/types.ts";
import { ErrorState, RelTime, SkeletonRows } from "../../components/primitives.tsx";
import { RichMarkdown } from "../../lib/markdown-rich.tsx";
import { inline } from "../../lib/markdown.tsx";
import { RememberedDetails } from "../../components/RememberedDetails.tsx";

export type StatusReportState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: StatusReportPayload };

/** A new report arrives as an ordinary post, which the board's own stream does not announce: the panel looks again now and then. */
const REFRESH_MS = 120_000;

/** `paused`: the project is archived, so no new report is written until it is active again. */
export function StatusReportView({ state, onRetry, paused = false, id = "status-report" }: { state: StatusReportState; onRetry: () => void; paused?: boolean; id?: string }) {
  if (state.status === "loading") return <section className="status-report" aria-label="Status report"><SkeletonRows rows={2} /></section>;
  if (state.status === "error") return <section className="status-report" aria-label="Status report"><ErrorState compact message={state.message} onRetry={onRetry} /></section>;
  const { mode, report } = state.data;
  if (mode === "off" && !report) return null;
  const verdict = report?.markdown.replace(/^#+[^\n]*\n/, "").trim().split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? "";
  const old = mode === "off";
  return (
    <section className="status-report" aria-label={old ? "Last report" : "Status report"}>
      {report ? <RememberedDetails id={old ? `${id}-last` : id} summary={(open) => <span className="status-report-summary">
        <span className="status-report-verdict">{old ? "Last report" : inline(verdict.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"), "verdict", {})}</span>
        <span className="status-report-meta">as of <RelTime ts={report.as_of} long /></span>
        {old && <span className="status-report-meta">hourly reports are off</span>}
        <span className="status-report-toggle">{open ? "Hide full report" : "Read full report"}</span>
      </span>}>
        <div className="status-report-body"><RichMarkdown text={report.markdown} /></div>
      </RememberedDetails> : (
        <p className="status-report-empty muted">
          {paused ? "Status reports pause while a project is archived."
            : mode === "hourly"
              ? "No status report yet. Talkie writes one each hour something changes, so the first one appears within the hour."
              : "Hourly status reports are off for this project. An owner or the project's creator turns them on from the Projects list."}
        </p>
      )}
      {report && paused && <p className="status-report-note muted">This project is archived, so this report is no longer updated.</p>}
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
  return <StatusReportView id={`project-report-${channel}`} state={state} paused={paused} onRetry={() => { setState({ status: "loading" }); load(); }} />;
}
