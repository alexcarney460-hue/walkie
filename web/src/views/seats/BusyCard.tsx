import { useState } from "react";
import { Coffee, Monitor } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { HostAvailability, SeatsLocalView } from "../../api/types.ts";

const LIMITS = [
  { max: 0, label: "Pause all" },
  { max: 1, label: "Keep 1" },
  { max: 2, label: "Keep 2" },
  { max: 3, label: "Keep 3" },
] as const;
const TIMERS = [
  { s: 0, label: "Until I'm done" },
  { s: 1_800, label: "For 30 minutes" },
  { s: 3_600, label: "For 1 hour" },
  { s: 7_200, label: "For 2 hours" },
  { s: 14_400, label: "For 4 hours" },
] as const;

/** "3:40 PM", or "Sep 27, 3:40 PM" when it isn't today. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a busy host is doing, in one line: "1 running · 2 paused · 1 queued". */
export function busyCounts(a: HostAvailability): string {
  return [`${a.running ?? 0} running`, `${a.paused ?? 0} paused`, `${a.queued ?? 0} queued`].join(" · ");
}

/**
 * "I'm using this computer" / "I'm done" (PROTOCOL §11, busy): on this machine's own dashboard only. The person picks
 * how many seats may keep running (the newest others are paused, new launches queue) and, optionally, a timer.
 */
export function BusyCard({ local, onChange }: { local: SeatsLocalView; onChange: () => void }) {
  const [max, setMax] = useState(1);
  const [timer, setTimer] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = local.availability;
  const busy = a.state === "busy";

  const act = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setPending(false);
    }
  };

  if (busy) {
    const limit = a.max ?? 0;
    return (
      <article className="seat-busy-card is-busy" aria-labelledby="seat-busy-title">
        <header className="seat-host-head">
          <span className="seat-busy-icon" aria-hidden="true"><Coffee size={16} strokeWidth={1.75} /></span>
          <h2 className="int-title" id="seat-busy-title">You're using this computer</h2>
        </header>
        <p className="seat-busy-lede">
          {`${a.paused ?? 0} paused, ${a.running ?? 0} running`}
          {(a.running ?? 0) > limit ? " (the rest are being paused: each counts as paused only once all its processes are verified stopped)" : ""}
          {`; at most ${plural(limit, "seat")} may run; new launches wait in line.`}
          Teammates see this machine as busy{a.until ? ` until ${clockTime(a.until)}` : ""}.
        </p>
        <dl className="seat-busy-facts">
          <div><dt>Running</dt><dd className="tnum">{a.running ?? 0}</dd></div>
          <div><dt>Paused</dt><dd className="tnum">{a.paused ?? 0}</dd></div>
          <div><dt>Queued</dt><dd className="tnum">{a.queued ?? 0}</dd></div>
        </dl>
        <button type="button" className="btn btn-primary seat-busy-btn" disabled={pending} onClick={() => void act(() => api.seatsResume())}>
          {pending ? "Resuming…" : "I'm done"}
        </button>
        <p className="field-hint" role="status">
          {a.until ? `Resumes by itself at ${clockTime(a.until)}. ` : ""}Paused seats continue where they stopped; their time limits don't run meanwhile.
        </p>
        {error && <p className="field-error" role="alert">{error}</p>}
      </article>
    );
  }

  return (
    <article className="seat-busy-card" aria-labelledby="seat-busy-title">
      <header className="seat-host-head">
        <span className="source-avatar" aria-hidden="true"><Monitor size={16} strokeWidth={1.75} /></span>
        <h2 className="int-title" id="seat-busy-title">Need this machine?</h2>
        <span className="int-status is-on">Available</span>
      </header>
      <p className="seat-busy-lede">
        {local.running ? `${plural(local.running, "seat")} running here. ` : ""}Pause seats while you work. Nothing is lost: paused seats keep their work and continue when you're done.
      </p>
      <div className="field">
        <span className="field-label" id="seat-busy-limit-label">Seats that keep running</span>
        <div className="seg seat-busy-seg" role="radiogroup" aria-labelledby="seat-busy-limit-label">
          {LIMITS.map((l) => (
            <button key={l.max} type="button" role="radio" aria-checked={max === l.max} className={max === l.max ? "seg-btn is-on" : "seg-btn"} onClick={() => setMax(l.max)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor="seat-busy-timer">How long</label>
        <select id="seat-busy-timer" className="select" value={timer} onChange={(e) => setTimer(Number(e.target.value))}>
          {TIMERS.map((t) => <option key={t.s} value={t.s}>{t.label}</option>)}
        </select>
      </div>
      <button type="button" className="btn btn-primary seat-busy-btn" disabled={pending}
        onClick={() => void act(() => api.seatsBusy({ max, ...(timer ? { for_s: timer } : {}) }))}>
        {pending ? "Pausing…" : "I'm using this computer"}
      </button>
      {error && <p className="field-error" role="alert">{error}</p>}
    </article>
  );
}
