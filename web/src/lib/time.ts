import { useSyncExternalStore } from "react";

// One shared 1 s clock for every relative timestamp on screen, started only
// while something is subscribed.
let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      subs.forEach((s) => s());
    }, 1_000);
  }
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// A static render never subscribes, so the interval never moves `now`. Serving that import-time value
// makes "12m ago" read "11m" once the import was more than half a second earlier. React also calls
// getServerSnapshot twice in one mount and requires the same result, so a bare Date.now() is not safe.
let serverSnap = 0;
function serverNow(): number {
  const t = Date.now();
  if (serverSnap !== 0 && t - serverSnap < 400) return serverSnap;
  serverSnap = t;
  return serverSnap;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, serverNow);
}

/**
 * Same clock, read in steps of `stepMs` (30s). The snapshot stays the same until the step changes, so a badge
 * does not redraw its page every second. Callers that need the second (a lag banner, a relative time) keep useNow.
 */
export function useCoarseNow(stepMs = 30_000): number {
  const step = Number.isFinite(stepMs) && stepMs >= 1_000 ? Math.floor(stepMs) : 30_000;
  const read = () => Math.floor(now / step) * step;
  return useSyncExternalStore(subscribe, read, read);
}

export function ago(ts: number, at: number): string {
  const s = Math.max(0, Math.round((at - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Whole words for a reader who is not on a terminal: "just now", "5 minutes ago", "2 hours ago", "2 days ago", "3 weeks ago", "4 months ago". */
export function agoPlain(ts: number, at: number): string {
  const s = Math.max(0, Math.floor((at - ts) / 1000));
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return unit(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return unit(h, "hour");
  const d = Math.floor(h / 24);
  if (d < 14) return unit(d, "day");
  if (d < 60) return unit(Math.floor(d / 7), "week");
  if (d < 365) return unit(Math.floor(d / 30), "month");
  return unit(Math.floor(d / 365), "year");
}

export function agoLong(ts: number, at: number): string {
  const short = ago(ts, at);
  return short === "now" ? "just now" : `${short} ago`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/** Time in a state, ticking by the second under an hour: "12s", "8m 03s", "1h 4m", "2d 3h". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return duration(ms);
}

/** Countdown with seconds while under an hour: "42m 10s", "1h 3m". */
export function countdown(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

const clockFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export function clock(ts: number): string {
  const sameDay = new Date(ts).toDateString() === new Date().toDateString();
  return sameDay ? clockFmt.format(ts) : dayFmt.format(ts);
}

export function fullTime(ts: number): string {
  return fullFmt.format(ts);
}
