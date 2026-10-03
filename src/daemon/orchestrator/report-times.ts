// PROJECT-REPORTS-1: when each project was last reported, where the schedules keep their state. Like the capacity summary's
// marker, a signed post in the owner-only schedule channel carries it to whichever machine leads next, and this daemon's
// meta table caches it so a restart before the post replicates loses nothing. Only a person-signed marker counts (the
// daemon signs it, never an agent). The time is when the report's facts were gathered, not when it was posted, so a change
// made while the model was writing is still news at the next hour. A time in the future (a lead whose clock ran ahead wrote it)
// is never used: it would hide every change until the clocks agreed, so that project is reported again now instead.
import { z } from "zod";
import { PROJECT_CHANNEL_RE } from "../../protocol/projects/schema.ts";
import { SCHEDULE_CHANNEL } from "../../protocol/talkie-schedule.ts";
import type { Core } from "../core.ts";

/** This daemon's cache of the times, and the marker's text prefix (exported for tests). */
export const REPORT_TIMES_META = "talkie_project_reports_v1";
/** This daemon's count, per project, of reports in a row that could not be used, and when the facts of the last try were gathered. */
export const REPORT_FAILURES_META = "talkie_project_report_failures_v1";
export const REPORT_MARKER_PREFIX = "walkie-talkie-project-reports:v1:";
/** A read goes back this far through the schedule channel, and through at most this many markers (one an hour at most). */
const MARKER_WINDOW_MS = 60 * 24 * 3_600_000;
const MARKER_ROWS = 3_000;
/** A report time may run this far ahead of the clock that reads it (honest skew); more is a wrong clock's and is ignored. */
const SKEW_MS = 60_000;
const Times = z.record(z.string().regex(PROJECT_CHANNEL_RE), z.number().int().nonnegative().safe());
const Marker = z.object({ reported: Times }).strict();
const Failures = z.record(z.string().regex(PROJECT_CHANNEL_RE), z.object({ n: z.number().int().positive().max(1_000), at: z.number().int().nonnegative().safe() }).strict());
export interface ReportFailure { n: number; at: number }

function parse(raw: string | null | undefined): Record<string, number> {
  try {
    const parsed = Times.safeParse(raw ? JSON.parse(raw) : {});
    return parsed.success ? parsed.data : {};
  } catch { return {}; }
}

/**
 * The newest time each project was reported, from this daemon's cache and the person-signed markers of the last 60 days
 * (a project not reported for longer reads as never reported: one more report, then the cache has it again). A time later
 * than the reader's clock (the cache) or than the moment its marker was received here (a marker) is a wrong clock's: it is
 * left out, so the project reads as reported before then, or never.
 */
export function readReportTimes(core: Core): Map<string, number> {
  const out = new Map<string, number>();
  const take = (times: Record<string, number>, upTo: number) => {
    for (const [channel, at] of Object.entries(times)) if (at <= upTo + SKEW_MS && (out.get(channel) ?? -1) < at) out.set(channel, at);
  };
  take(parse(core.store.getMeta(REPORT_TIMES_META)), core.clock());
  const rows = core.store.db.query<{ json: string; received_at: number }, [string, number, string, number]>(
    `SELECT json, received_at FROM events WHERE channel = ? AND +kind = 'msg.post' AND redacted = 0 AND status = 'ok' AND author_agent IS NULL
     AND ts > ? AND json_extract(body, '$.text') LIKE ? ORDER BY ts DESC LIMIT ?`).all(SCHEDULE_CHANNEL, core.clock() - MARKER_WINDOW_MS, `${REPORT_MARKER_PREFIX}%`, MARKER_ROWS);
  for (const row of rows) {
    try {
      const text = (JSON.parse(row.json) as { body?: { text?: unknown } }).body?.text;
      const marker = typeof text === "string" ? Marker.safeParse(JSON.parse(text.slice(REPORT_MARKER_PREFIX.length))) : null;
      if (marker?.success) take(marker.data.reported, row.received_at);
    } catch { /* a marker that does not parse is not one */ }
  }
  return out;
}

/** This daemon's own note that a project was reported (right after its post; the team's marker follows when the run ends). */
export function noteReported(core: Core, channel: string, at: number): void {
  const times = parse(core.store.getMeta(REPORT_TIMES_META));
  const was = times[channel];
  // The newer of the two, except that a cached time in the future (a clock that was wrong) gives way to this one.
  const kept = was !== undefined && was <= core.clock() + SKEW_MS ? Math.max(at, was) : at;
  core.store.setMeta(REPORT_TIMES_META, JSON.stringify({ ...times, [channel]: kept }));
}

/** Keeps the caches (times and failure counts) to the projects still reported: an entry for one switched off or gone is dropped. */
export function keepReportTimes(core: Core, keep: ReadonlySet<string>): void {
  const times = parse(core.store.getMeta(REPORT_TIMES_META));
  const kept = Object.fromEntries(Object.entries(times).filter(([channel]) => keep.has(channel)));
  if (Object.keys(kept).length !== Object.keys(times).length) core.store.setMeta(REPORT_TIMES_META, JSON.stringify(kept));
  const failures = parseFailures(core.store.getMeta(REPORT_FAILURES_META));
  const stillFailing = Object.fromEntries(Object.entries(failures).filter(([channel]) => keep.has(channel)));
  if (Object.keys(stillFailing).length !== Object.keys(failures).length) core.store.setMeta(REPORT_FAILURES_META, JSON.stringify(stillFailing));
}

function parseFailures(raw: string | null | undefined): Record<string, ReportFailure> {
  try {
    const parsed = Failures.safeParse(raw ? JSON.parse(raw) : {});
    return parsed.success ? parsed.data : {};
  } catch { return {}; }
}

/**
 * How many reports in a row could not be used, per project, and when the facts of the last try were gathered. The time is
 * never later than this daemon's clock (a try stamped by a clock that ran ahead counts from now).
 */
export function readReportFailures(core: Core): Map<string, ReportFailure> {
  const now = core.clock();
  return new Map(Object.entries(parseFailures(core.store.getMeta(REPORT_FAILURES_META))).map(([channel, f]) => [channel, { n: f.n, at: Math.min(f.at, now) }]));
}

/** A try for this project ended without a report that could be posted (the model wrote none, or the post was refused): the count of tries in a row now. */
export function noteReportFailure(core: Core, channel: string, at: number): number {
  const failures = parseFailures(core.store.getMeta(REPORT_FAILURES_META));
  const n = Math.min(1_000, (failures[channel]?.n ?? 0) + 1);
  core.store.setMeta(REPORT_FAILURES_META, JSON.stringify({ ...failures, [channel]: { n, at: Math.min(at, core.clock()) } }));
  return n;
}

/** A report went out for this project: the count starts again. */
export function clearReportFailure(core: Core, channel: string): void {
  const failures = parseFailures(core.store.getMeta(REPORT_FAILURES_META));
  if (!(channel in failures)) return;
  const { [channel]: _gone, ...rest } = failures;
  core.store.setMeta(REPORT_FAILURES_META, JSON.stringify(rest));
}

/** One signed marker for a run's delivered reports, so a successor lead sees them. */
export function publishReportTimes(core: Core, reported: Readonly<Record<string, number>>): void {
  if (!Object.keys(reported).length) return;
  core.emit("msg.post", { text: REPORT_MARKER_PREFIX + JSON.stringify({ reported }) }, { channel: SCHEDULE_CHANNEL });
}
