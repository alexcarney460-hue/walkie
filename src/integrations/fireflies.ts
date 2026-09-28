// Fireflies connector: polls GraphQL `transcripts` in time intervals and posts one message per meeting
// (summary, action items with @mentions, link) with the full transcript attached.
//
// Cursor: { floor, watermark, page? }. A run lists the interval [max(floor, watermark − overlap), now]
// page by page (newest first) and persists where it got to; the watermark moves to the interval's end
// (`page.end`) only once every page was read and every meeting in it handled (#5: a meeting another
// attempt still holds keeps the watermark where it is). Continuation is by TIME, not offset (#7): after
// a page, `to` narrows to just past its oldest meeting, so a meeting deleted or added upstream can't
// shift what the next page returns; only pages of identical dates fall back to an offset within that
// date. The overlap re-reads recent hours because a meeting's `date` is its START and its transcript
// appears after processing; dedup (external id = transcript id) makes re-reads free.
import { z } from "zod";
import { DEFAULTS } from "./config.ts";
import { graphql } from "./http.ts";
import { annotateMentions, type Teammate } from "./mentions.ts";
import type { Connector, RunCtx, RunResult } from "./types.ts";

export const FIREFLIES_URL = "https://api.fireflies.ai/graphql";
/** The API's largest page. */
const PAGE = 50;
/** Pages read per run; a longer interval continues on the next run from the persisted page. */
const MAX_PAGES_PER_RUN = 40;
/** Re-read window before the watermark: meetings (dated by their start) whose transcript arrives late. */
export const FIREFLIES_OVERLAP_MS = 6 * 3_600_000;

export const LIST_QUERY = `query WalkieTranscripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {
    id title date duration transcript_url participants
    speakers { name }
    summary { overview action_items keywords }
  }
}`;
export const SENTENCES_QUERY = `query WalkieTranscript($id: String!) {
  transcript(id: $id) { id sentences { speaker_name text start_time } }
}`;

const Str = z.string().max(200_000);
export const TranscriptMeta = z.object({
  id: z.string().min(1).max(200),
  title: Str.nullish(),
  date: z.number().nullish(),
  duration: z.number().nullish(),
  transcript_url: Str.nullish(),
  participants: z.array(Str.nullish()).max(1000).nullish(),
  speakers: z.array(z.object({ name: Str.nullish() }).passthrough()).max(1000).nullish(),
  summary: z.object({
    overview: Str.nullish(),
    action_items: Str.nullish(),
    keywords: z.array(Str.nullish()).max(200).nullish(),
  }).passthrough().nullish(),
}).passthrough();
export type TranscriptMeta = z.infer<typeof TranscriptMeta>;
export const ListData = z.object({ transcripts: z.array(TranscriptMeta).max(500).nullable() });
const Sentence = z.object({ speaker_name: Str.nullish(), text: Str.nullish(), start_time: z.number().nullish() }).passthrough();
export const SentencesData = z.object({ transcript: z.object({ id: z.string(), sentences: z.array(Sentence).max(200_000).nullish() }).passthrough().nullable() });

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "meeting";
}

/** Only https URLs are linked; anything else is dropped. */
export function httpsUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function speakerNames(t: TranscriptMeta): string[] {
  const names = (t.speakers ?? []).map((s) => s.name?.trim()).filter((n): n is string => !!n);
  return [...new Set(names)].slice(0, 30);
}

/** The post text for one meeting. */
export function formatMeeting(t: TranscriptMeta, members: readonly Teammate[]): string {
  const title = t.title?.trim() || "Untitled meeting";
  const meta = [
    t.date ? utcStamp(t.date) : null,
    t.duration ? `${Math.max(1, Math.round(t.duration))} min` : null,
    t.participants?.length ? `${t.participants.length} participant${t.participants.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
  const speakers = speakerNames(t);
  const lines = [`**Meeting: ${title}**`, meta];
  if (speakers.length) lines.push(`Speakers: ${speakers.join(", ")}`);
  const overview = t.summary?.overview?.trim();
  if (overview) lines.push("", "**Overview**", overview);
  const actions = t.summary?.action_items?.trim();
  if (actions) lines.push("", "**Action items**", annotateMentions(actions, members));
  const keywords = (t.summary?.keywords ?? []).filter((k): k is string => !!k).slice(0, 12);
  if (keywords.length) lines.push("", `Keywords: ${keywords.join(", ")}`);
  const url = httpsUrl(t.transcript_url);
  if (url) lines.push("", `Transcript in Fireflies: ${url}`);
  return lines.filter((l, i) => !(l === "" && lines[i - 1] === "")).join("\n");
}

export function formatTranscript(t: TranscriptMeta, sentences: z.infer<typeof Sentence>[]): string {
  const head = `${t.title?.trim() || "Untitled meeting"}${t.date ? ` (${utcStamp(t.date)})` : ""}\nSource: Fireflies${httpsUrl(t.transcript_url) ? ` ${httpsUrl(t.transcript_url)}` : ""}\n`;
  const body = sentences
    .filter((s) => s.text?.trim())
    .map((s) => `[${clock(s.start_time ?? 0)}] ${s.speaker_name?.trim() || "Speaker"}: ${s.text?.trim()}`)
    .join("\n");
  return `${head}\n${body}\n`;
}

/** One page of the interval [fromMs, toMs], newest first as the API returns it. */
async function listPage(ctx: RunCtx, fromMs: number, toMs: number, skip: number): Promise<TranscriptMeta[]> {
  const data = await graphql({
    fetch: ctx.fetch, url: FIREFLIES_URL, auth: `Bearer ${ctx.key}`, service: "fireflies", secrets: ctx.secrets,
    query: LIST_QUERY, variables: { fromDate: new Date(fromMs).toISOString(), toDate: new Date(toMs).toISOString(), limit: PAGE, skip },
  }, ListData);
  return data.transcripts ?? [];
}

/** `to` is the next page's upper bound; `end` the interval's (the watermark once done; `to` before FIX-2). */
const Interval = z.object({
  from: z.number(), to: z.number(), skip: z.number().int().min(0), end: z.number().optional(),
  /** Some meeting of this interval is still held by another attempt: the watermark must not pass it. */
  unfinished: z.boolean().optional(),
});
const CursorSchema = z.object({ floor: z.number(), watermark: z.number(), page: Interval.optional() });
export type FirefliesCursor = z.infer<typeof CursorSchema>;

/** The stored cursor; a pre-FIX-1 cursor (a bare timestamp) becomes floor = watermark = that time. */
export function parseFirefliesCursor(raw: string | null): FirefliesCursor | null {
  if (!raw) return null;
  const legacy = Number(raw);
  if (Number.isFinite(legacy) && legacy > 0) return { floor: legacy, watermark: legacy };
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function sentencesOf(ctx: RunCtx, id: string): Promise<z.infer<typeof Sentence>[]> {
  const data = await graphql({
    fetch: ctx.fetch, url: FIREFLIES_URL, auth: `Bearer ${ctx.key}`, service: "fireflies", secrets: ctx.secrets,
    query: SENTENCES_QUERY, variables: { id },
  }, SentencesData);
  return data.transcript?.sentences ?? [];
}

export const fireflies: Connector = {
  id: "fireflies",
  name: "Fireflies",
  needsKey: true,
  async run(ctx: RunCtx): Promise<RunResult> {
    if (!ctx.key) throw new Error("fireflies: no API key configured");
    const now = ctx.now();
    const backfill = (ctx.settings.backfill_hours ?? DEFAULTS.fireflies.backfill_hours) * 3_600_000;
    const cur = parseFirefliesCursor(ctx.state.cursor("fireflies")) ?? { floor: now - backfill, watermark: now - backfill };
    const start = cur.page ?? { from: Math.max(cur.floor, cur.watermark - FIREFLIES_OVERLAP_MS), to: Math.max(now, cur.watermark), skip: 0 };
    let iv: z.infer<typeof Interval> = { ...start, end: start.end ?? start.to };
    const save = (next: FirefliesCursor) => ctx.state.setCursor("fireflies", JSON.stringify(next));
    save({ floor: cur.floor, watermark: cur.watermark, page: iv });
    const channel = ctx.settings.channel ?? DEFAULTS.fireflies.channel;
    let posted = 0;
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_PAGES_PER_RUN) return { posted }; // the persisted page continues next run
      const batch = await listPage(ctx, iv.from, iv.to, iv.skip);
      for (const t of [...batch].sort((a, b) => (a.date ?? 0) - (b.date ?? 0) || a.id.localeCompare(b.id))) {
        if ((t.date ?? 0) < iv.from || ctx.state.posted("fireflies", t.id)) continue;
        if (!ctx.take()) return { posted, capped: true }; // this page is re-read next run; done items are deduped
        if (!ctx.state.claim("fireflies", t.id, ctx.now())) {
          // Held by another attempt (a live claim): the interval stays open past it (#5).
          if (!iv.unfinished) { iv = { ...iv, unfinished: true }; save({ floor: cur.floor, watermark: cur.watermark, page: iv }); }
          continue;
        }
        try {
          const sentences = await sentencesOf(ctx, t.id);
          const title = ctx.scrub(t.title ?? "meeting"); // before the filename is derived from it
          const name = `${slug(title)}-${t.date ? new Date(t.date).toISOString().slice(0, 10) : "undated"}.txt`;
          await ctx.poster.deliver({
            connector: "fireflies", channel, externalId: t.id, text: formatMeeting(t, ctx.members()),
            attachment: { name, mime: "text/plain; charset=utf-8", text: formatTranscript(t, sentences), note: "Full transcript (Fireflies)" },
          });
          posted++;
        } catch (err) {
          ctx.state.release("fireflies", t.id);
          throw err;
        }
      }
      if (batch.length < PAGE) break;
      // Stable continuation (#7): the next page is bounded by time, just past this page's oldest
      // meeting (re-read, deduped), so upstream deletions or insertions above it move nothing. Only a
      // page of identical dates continues by offset within that same bound.
      const oldest = Math.min(...batch.map((t) => t.date ?? iv.to));
      const next = oldest + 1;
      iv = next < iv.to ? { ...iv, to: next, skip: 0 } : { ...iv, skip: iv.skip + PAGE };
      save({ floor: cur.floor, watermark: cur.watermark, page: iv });
    }
    // The whole interval was read: the watermark moves to its end, unless a meeting in it is still
    // held by another attempt, in which case the next run re-reads from the old watermark (#5).
    save({ floor: cur.floor, watermark: iv.unfinished ? cur.watermark : iv.end ?? iv.to });
    return { posted };
  },
};
