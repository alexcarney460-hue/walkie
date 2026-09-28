import type { Meter as MeterData } from "../../api/types.ts";
import { pct } from "../../lib/projects.ts";

/**
 * Completeness: a stacked bar (done, in review, in progress, still to do) and the done number. Cancelled columns are
 * outside the denominator and not drawn.
 */
export function Meter({ meter, compact, label }: { meter: MeterData; compact?: boolean; label?: string }) {
  const { done, counted, by_role: r } = meter;
  const total = Math.max(1, counted);
  const seg = (n: number) => `${(n / total) * 100}%`;
  const unit = meter.mode === "points" ? "pts" : "";
  return (
    <div className={compact ? "meter meter-compact" : "meter"} title={`${label ?? "Completeness"}: ${done} of ${counted} ${meter.mode === "points" ? "points" : "cards"} done (${pct(done, counted)}%)`}>
      <div className="meter-bar" role="img" aria-label={`${pct(done, counted)}% done: ${done} of ${counted}`}>
        <span className="meter-seg seg-done" style={{ width: seg(r.done) }} />
        <span className="meter-seg seg-review" style={{ width: seg(r.review) }} />
        <span className="meter-seg seg-active" style={{ width: seg(r.active) }} />
      </div>
      <span className="meter-text tnum">
        <strong>{done}</strong>
        <span className="muted">/{counted}{unit ? ` ${unit}` : ""}{compact ? "" : " done"}</span>
      </span>
    </div>
  );
}
