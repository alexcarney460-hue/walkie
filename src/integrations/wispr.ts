// Wispr Flow connector (macOS, local, no key). Polls the desktop app's meetings directory:
//   <dir>/<uuid>/refined.ndjson   one {id, timestamp: "mm:ss", text, speaker: {id, name|null, source}} per line
//   <dir>/<uuid>/live.ndjson      written while recording (segments carry startEpochMs/endEpochMs)
// A meeting is complete when refined.ndjson and live.ndjson both haven't changed for `settle_minutes`.
// Each completed meeting is posted once (dedup by uuid) with the full transcript attached. It also
// unfurls notes.wisprflow.ai/shared links (wispr-unfurl.ts).
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "./config.ts";
import { clock, utcStamp } from "./fireflies.ts";
import { annotateMentions, type Teammate } from "./mentions.ts";
import { summarizeWithClaude, type SummarizeOptions } from "./summarize.ts";
import type { Connector, RunCtx, RunResult } from "./types.ts";
import { processUnfurls, unfurlEvent } from "./wispr-unfurl.ts";

export const DEFAULT_WISPR_DIR = join(homedir(), "Library", "Application Support", "Wispr Flow", "meetings");
const MEETING_DIR_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const MAX_TRANSCRIPT_FILE_BYTES = 20 * 1024 * 1024;
const LIVE_HEAD_BYTES = 256 * 1024;
const EXCERPT_LINES = 4;

export interface Segment { t: number | null; speaker: string; text: string }
export interface Meeting { id: string; startedAt: number | null; durationS: number | null; speakers: string[]; segments: Segment[] }

/** "mm:ss" / "h:mm:ss" → seconds (null when it isn't one). */
export function parseClock(s: unknown): number | null {
  if (typeof s !== "string" || !/^\d{1,3}(:\d{1,2}){1,2}$/.test(s)) return null;
  return s.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

/** External text goes through `scrub` (configured keys + patterns) before anything truncates it (#3). */
export type Scrub = (text: string) => string;
const keep: Scrub = (s) => s;

function speakerLabel(sp: unknown, names: ReadonlyMap<number, string>, scrub: Scrub): string {
  const o = (sp && typeof sp === "object" ? sp : {}) as { id?: unknown; name?: unknown };
  if (typeof o.name === "string" && o.name.trim()) return scrub(o.name).trim().slice(0, 80);
  if (typeof o.id === "number" && names.has(o.id)) return names.get(o.id) as string;
  return typeof o.id === "number" ? `Speaker ${o.id + 1}` : "Speaker";
}

function readHead(path: string, max: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function jsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn or foreign line is skipped */ }
  }
  return out;
}

/** Start time and speaker names from live.ndjson (only its head is read). */
function liveInfo(dir: string, scrub: Scrub): { start: number | null; end: number | null; names: Map<number, string> } {
  const names = new Map<number, string>();
  const path = join(dir, "live.ndjson");
  if (!existsSync(path)) return { start: null, end: null, names };
  let start: number | null = null;
  let end: number | null = null;
  for (const o of jsonLines(readHead(path, LIVE_HEAD_BYTES))) {
    const r = o as { startEpochMs?: unknown; endEpochMs?: unknown; speaker?: { id?: unknown; name?: unknown } };
    if (typeof r.startEpochMs === "number" && (start === null || r.startEpochMs < start)) start = r.startEpochMs;
    if (typeof r.endEpochMs === "number" && (end === null || r.endEpochMs > end)) end = r.endEpochMs;
    const sp = r.speaker;
    if (sp && typeof sp.id === "number" && typeof sp.name === "string" && sp.name.trim()) names.set(sp.id, scrub(sp.name).trim().slice(0, 80));
  }
  return { start, end, names };
}

/**
 * Parses one meeting directory; null when refined.ndjson is missing or too large. Every speaker name
 * and line is scrubbed with `scrub` before it is trimmed or truncated (#3).
 */
export function readMeeting(dir: string, id: string, scrub: Scrub = keep): Meeting | null {
  const refined = join(dir, "refined.ndjson");
  if (!existsSync(refined) || statSync(refined).size > MAX_TRANSCRIPT_FILE_BYTES) return null;
  const live = liveInfo(dir, scrub);
  const segments: Segment[] = [];
  for (const o of jsonLines(readFileSync(refined, "utf8"))) {
    const r = o as { text?: unknown; timestamp?: unknown; speaker?: unknown };
    if (typeof r.text !== "string" || !r.text.trim()) continue;
    segments.push({ t: parseClock(r.timestamp), speaker: speakerLabel(r.speaker, live.names, scrub), text: scrub(r.text).trim() });
  }
  const times = segments.map((s) => s.t).filter((t): t is number => t !== null);
  const durationS = times.length >= 2 ? Math.max(...times) - Math.min(...times)
    : live.start !== null && live.end !== null ? Math.round((live.end - live.start) / 1000) : null;
  const speakers = [...new Set(segments.map((s) => s.speaker))].slice(0, 30);
  return { id, startedAt: live.start, durationS, speakers, segments };
}

export function transcriptText(m: Meeting): string {
  const head = `Wispr Flow meeting ${m.id}${m.startedAt ? ` (${utcStamp(m.startedAt)})` : ""}\n`;
  return `${head}\n${m.segments.map((s) => `${s.t !== null ? `[${clock(s.t)}] ` : ""}${s.speaker}: ${s.text}`).join("\n")}\n`;
}

export function formatWisprMeeting(m: Meeting, summary: string | null, members: readonly Teammate[]): string {
  const meta = [
    m.startedAt ? utcStamp(m.startedAt) : null,
    m.durationS !== null ? `${Math.max(1, Math.round(m.durationS / 60))} min` : null,
    `${m.segments.length} lines`,
  ].filter(Boolean).join(" · ");
  const lines = ["**Wispr Flow meeting**", meta];
  if (m.speakers.length) lines.push(`Speakers: ${m.speakers.join(", ")}`);
  if (summary) lines.push("", annotateMentions(summary, members));
  const excerpt = m.segments.slice(0, EXCERPT_LINES).map((s) => `> ${s.speaker}: ${s.text.length > 200 ? s.text.slice(0, 199) + "…" : s.text}`);
  if (excerpt.length) lines.push("", "Excerpt:", ...excerpt);
  lines.push("", "Full transcript attached.");
  return lines.join("\n");
}

/** Meetings ready to post: complete (settled, not recording) and newer than the cursor. Oldest first. */
export function completedMeetings(root: string, now: number, settleMs: number, sinceMs: number): { id: string; dir: string; mtime: number }[] {
  const out: { id: string; dir: string; mtime: number }[] = [];
  for (const name of readdirSync(root)) {
    if (!MEETING_DIR_RE.test(name)) continue;
    const dir = join(root, name);
    let refinedM: number;
    try {
      if (!statSync(dir).isDirectory()) continue;
      const refined = join(dir, "refined.ndjson");
      if (!existsSync(refined)) continue;
      refinedM = statSync(refined).mtimeMs;
      const live = join(dir, "live.ndjson");
      const liveM = existsSync(live) ? statSync(live).mtimeMs : 0;
      if (now - Math.max(refinedM, liveM) < settleMs) continue; // still recording or being refined
    } catch {
      continue; // removed while scanning
    }
    if (refinedM < sinceMs) continue;
    out.push({ id: name, dir, mtime: refinedM });
  }
  return out.sort((a, b) => a.mtime - b.mtime || a.id.localeCompare(b.id));
}

export function makeWispr(summarizeOpts: SummarizeOptions = {}): Connector {
  return {
    id: "wispr",
    name: "Wispr Flow",
    needsKey: false,
    async run(ctx: RunCtx): Promise<RunResult> {
      if (ctx.settings.unfurl !== false) await processUnfurls(ctx); // retries due now (also after a restart)
      const root = ctx.settings.dir ?? DEFAULT_WISPR_DIR;
      if (!existsSync(root)) throw new Error("wispr: meetings directory not found (is Wispr Flow installed?)");
      const backfill = (ctx.settings.backfill_hours ?? DEFAULTS.wispr.backfill_hours) * 3_600_000;
      const stored = Number(ctx.state.cursor("wispr"));
      const since = Number.isFinite(stored) && stored > 0 ? stored : ctx.now() - backfill;
      if (!(stored > 0)) ctx.state.setCursor("wispr", String(since));
      const settleMs = (ctx.settings.settle_minutes ?? 10) * 60_000;
      const channel = ctx.settings.channel ?? DEFAULTS.wispr.channel;
      let posted = 0;
      for (const cand of completedMeetings(root, ctx.now(), settleMs, since)) {
        if (ctx.state.seen("wispr", cand.id)) continue;
        const meeting = readMeeting(cand.dir, cand.id, ctx.scrub);
        if (!meeting || !meeting.segments.length) {
          ctx.state.record("wispr", cand.id, null, ctx.now()); // empty or oversized: never retried
          continue;
        }
        if (!ctx.take()) return { posted, capped: true };
        if (!ctx.state.claim("wispr", cand.id, ctx.now())) continue;
        try {
          const transcript = transcriptText(meeting);
          // Redacted (configured keys + secret patterns) BEFORE it leaves Walkie for the summarizer,
          // which the generation's signal aborts (#8: a reconfigure kills the CLI at once).
          const summary = ctx.settings.summarize === "claude" ? await summarizeWithClaude(ctx.scrub(transcript), summarizeOpts, ctx.signal) : null;
          const stamp = meeting.startedAt ? new Date(meeting.startedAt).toISOString().slice(0, 10) : "undated";
          await ctx.poster.deliver({
            connector: "wispr", channel, externalId: cand.id, text: formatWisprMeeting(meeting, summary, ctx.members()),
            attachment: { name: `wispr-meeting-${stamp}-${cand.id.slice(0, 8)}.txt`, mime: "text/plain; charset=utf-8", text: transcript, note: "Full transcript (Wispr Flow)" },
          });
          posted++;
        } catch (err) {
          ctx.state.release("wispr", cand.id);
          throw err;
        }
      }
      return { posted };
    },
    onEvent(ev, ctx) {
      if (ctx.settings.unfurl === false) return;
      unfurlEvent(ev, ctx);
    },
  };
}
