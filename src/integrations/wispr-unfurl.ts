// Unfurls https://notes.wisprflow.ai/shared/<slug> links posted in any channel: fetches the public share
// page (GET, 10 s timeout, 2 MB cap, no cross-host redirects), extracts the title + text and replies in
// the thread with an excerpt and the full text attached. A JS-only page that yields no text is skipped.
// Fallback: the page's own public JSON endpoint (api.wisprflow.ai .../meetings/shared/<slug>), which the
// share page itself calls; 401/403/404/410 there, or no text, means "absent: do nothing".
//
// Each link is a persisted job (integration_retries). A transient failure (network, timeout, 5xx, 429)
// or the rate cap reschedules it with jittered exponential backoff that survives restarts, up to
// MAX_UNFURL_ATTEMPTS; permanent absence settles it at once.
import { isConnectorId } from "./config.ts";
import { readCapped } from "./http.ts";
import type { Event } from "../protocol/schemas.ts";
import { STALE_CLAIM_MS } from "./state.ts";
import type { RunCtx } from "./types.ts";

export const SHARE_HOST = "notes.wisprflow.ai";
export const SHARE_API = "https://api.wisprflow.ai/api/v1/meetings/shared/";
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_LINKS_PER_POST = 3;
/** Posts older than this (history arriving by sync) are never unfurled. */
const FRESH_MS = 10 * 60_000;
const EXCERPT_CHARS = 600;
const LINK_RE = /https:\/\/notes\.wisprflow\.ai\/shared\/([A-Za-z0-9_-]{4,128})(?![A-Za-z0-9_-])/g;
/** Attempts per link before it is given up (transient failures only). */
export const MAX_UNFURL_ATTEMPTS = 8;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;
/** Wait when the rate cap is exhausted (the attempt isn't counted). */
const RATE_WAIT_MS = 2 * 60_000;
const BATCH = 20;
const PROCESS_KEY = "wispr-unfurl";

export interface ShareNote { title: string; text: string }

/** A share fetch: the note, permanently absent, or a transient failure worth retrying. */
export type ShareResult = { kind: "note"; note: ShareNote } | { kind: "absent" } | { kind: "transient"; why: string };

export function shareLinks(text: string): { url: string; slug: string }[] {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(LINK_RE)) {
    const slug = m[1] as string;
    if (!seen.has(slug)) seen.set(slug, `https://${SHARE_HOST}/shared/${slug}`);
    if (seen.size >= MAX_LINKS_PER_POST) break;
  }
  return [...seen].map(([slug, url]) => ({ url, slug }));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (whole, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith("#x")) { const n = parseInt(lower.slice(2), 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; }
    if (lower.startsWith("#")) { const n = parseInt(lower.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; }
    return ENTITIES[lower] ?? whole;
  });
}

function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== key) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    const v = content?.[1] ?? content?.[2];
    if (v?.trim()) return decodeEntities(v).trim();
  }
  return null;
}

function tidy(s: string): string {
  return s.replace(/[ \t\f\v\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Visible text of an HTML fragment: no scripts/styles, block tags become line breaks. */
export function htmlText(fragment: string): string {
  const stripped = fragment
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|blockquote|pre|header|footer|main)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return tidy(decodeEntities(stripped));
}

/** External text goes through `scrub` (configured keys + patterns) before anything truncates it (#3). */
type Scrub = (text: string) => string;
const keep: Scrub = (s) => s;

/** Title + text of a server-rendered share page; null when the page carries no note text (JS-only). */
export function parseSharePage(html: string, scrub: Scrub = keep): ShareNote | null {
  const rawTitle = scrub(metaContent(html, "og:title") ?? decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")).trim();
  const body = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(html)?.[2] ?? /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? "";
  let text = scrub(htmlText(body));
  if (text.length < 20) text = scrub(metaContent(html, "og:description") ?? metaContent(html, "description") ?? "");
  text = tidy(text);
  if (text.length < 20) return null;
  const title = rawTitle && rawTitle !== "Wispr Flow Notes" ? rawTitle : "Wispr Flow note";
  return { title: title.slice(0, 200), text };
}

/** Collects string leaves of a JSON value (depth- and size-capped). */
function strings(v: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || out.length > 5_000) return out;
  if (typeof v === "string") { if (v.trim()) out.push(v.trim()); return out; }
  if (Array.isArray(v)) { for (const x of v) strings(x, depth + 1, out); return out; }
  if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, depth + 1, out);
  return out;
}

/** The share API's JSON ({ title, summary, notes }); null when it carries no text. */
export function parseShareJson(data: unknown, scrub: Scrub = keep): ShareNote | null {
  if (!data || typeof data !== "object") return null;
  const o = data as { title?: unknown; summary?: unknown; notes?: unknown };
  const text = tidy(scrub([...strings(o.summary), ...strings(o.notes)].join("\n\n")));
  if (text.length < 20) return null;
  const rawTitle = typeof o.title === "string" ? scrub(o.title).trim() : "";
  const title = rawTitle ? rawTitle.slice(0, 200) : "Wispr Flow note";
  return { title, text };
}

type Got = { ok: true; status: number; type: string; body: string } | { ok: false; transient: boolean; why: string };

async function getCapped(ctx: RunCtx, url: string, accept: string): Promise<Got> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { method: "GET", headers: { Accept: accept }, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (ctx.signal.aborted) throw err; // disabled/removed: stop, don't classify
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, transient: true, why: timeout ? "timeout" : "network" };
  }
  if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => undefined); return { ok: false, transient: false, why: `HTTP ${res.status}` }; } // never follow
  if (res.status === 429 || res.status >= 500) { await res.body?.cancel().catch(() => undefined); return { ok: false, transient: true, why: `HTTP ${res.status}` }; }
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(res, MAX_PAGE_BYTES);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return { ok: false, transient: true, why: "network" };
  }
  if (!bytes) return { ok: false, transient: false, why: "too large" };
  return { ok: true, status: res.status, type: res.headers.get("content-type") ?? "", body: new TextDecoder().decode(bytes) };
}

/**
 * Fetches a share link: the page first, then the page's public JSON endpoint. The endpoint decides:
 * 200 with text = the note; 200 without text, 3xx, 4xx (except 429) or oversize = absent; a network
 * error, timeout, 5xx or 429 = transient.
 */
export async function fetchShare(ctx: RunCtx, link: { url: string; slug: string }): Promise<ShareResult> {
  const page = await getCapped(ctx, link.url, "text/html");
  if (page.ok && page.status === 200 && page.type.includes("html")) {
    const note = parseSharePage(page.body, ctx.scrub);
    if (note) return { kind: "note", note };
  }
  const api = await getCapped(ctx, SHARE_API + encodeURIComponent(link.slug), "application/json");
  if (!api.ok) return api.transient ? { kind: "transient", why: api.why } : { kind: "absent" };
  if (api.status !== 200 || !api.type.includes("json")) return { kind: "absent" };
  try {
    const note = parseShareJson(JSON.parse(api.body), ctx.scrub);
    return note ? { kind: "note", note } : { kind: "absent" };
  } catch {
    return { kind: "absent" };
  }
}

/** Delay before attempt `attempts + 1`: 30 s · 2^(n−1), at most an hour, ±25 % jitter. */
export function unfurlBackoff(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 12)), RETRY_MAX_MS);
  return Math.round(base * (0.75 + 0.5 * random()));
}

export function excerpt(text: string, max = EXCERPT_CHARS): string {
  const flat = text.length > max ? text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : text;
  return flat.split("\n").map((l) => `> ${l}`).join("\n");
}

interface UnfurlJob { event: string; root: string; url: string; slug: string }

function parseJob(payload: string): UnfurlJob | null {
  try {
    const j = JSON.parse(payload) as Partial<UnfurlJob>;
    if (typeof j.event !== "string" || typeof j.root !== "string" || typeof j.url !== "string" || typeof j.slug !== "string") return null;
    const link = shareLinks(j.url)[0];
    return link && link.url === j.url && link.slug === j.slug ? (j as UnfurlJob) : null;
  } catch {
    return null;
  }
}

/** Queues one post's share links (at most once per post and link on this machine, best effort across the team). */
export function unfurlEvent(ev: Event, ctx: RunCtx): void {
  if (ev.kind !== "msg.post" || !ev.channel) return;
  if (ev.author.agent && isConnectorId(ev.author.agent)) return; // never react to connector posts (loops)
  if (ctx.now() - ev.ts > FRESH_MS || !ctx.visible(ev)) return;
  const links = shareLinks(String((ev.body as { text?: unknown }).text ?? ""));
  if (!links.length) return;
  const own = ev.origin === ctx.selfNode;
  // Another member's daemon may unfurl the same link: others wait a jittered moment and look first.
  const delay = own ? 0 : 5_000 + Math.floor(Math.random() * 15_000);
  const root = typeof (ev.body as { thread?: unknown }).thread === "string" ? String((ev.body as { thread: string }).thread) : ev.id;
  const now = ctx.now();
  for (const link of links) {
    const ext = `unfurl:${ev.id}:${link.slug}`;
    if (ctx.state.seen("wispr", ext)) continue;
    ctx.state.enqueueRetry("wispr", ext, JSON.stringify({ event: ev.id, root, url: link.url, slug: link.slug } satisfies UnfurlJob), now + delay, now);
  }
  ctx.schedule(() => processUnfurls(ctx), delay, PROCESS_KEY);
}

/** Works through the unfurl jobs that are due, then schedules a wake-up for the next one. */
export async function processUnfurls(ctx: RunCtx): Promise<void> {
  for (const job of ctx.state.dueRetries("wispr", ctx.now(), BATCH)) {
    if (!ctx.alive()) return;
    await unfurlOne(ctx, job.external_id, job.payload, job.attempts);
  }
  const next = ctx.state.nextRetryAt("wispr");
  if (next !== null && ctx.alive()) ctx.schedule(() => processUnfurls(ctx), Math.max(1_000, next - ctx.now()), PROCESS_KEY);
}

async function unfurlOne(ctx: RunCtx, ext: string, payload: string, attempts: number): Promise<void> {
  const job = parseJob(payload);
  const ev = job ? ctx.event(job.event) : null;
  if (!job || !ev || !ev.channel) { ctx.state.dropRetry("wispr", ext); return; } // gone, hidden or malformed
  const mine = ctx.state.item("wispr", ext);
  if (mine?.state === "posted") { ctx.state.dropRetry("wispr", ext); return; }
  if (mine && (mine.claimed_at ?? 0) > ctx.now() - STALE_CLAIM_MS) return; // another attempt is in flight right now
  // The local ledger first (#6): our own reply without its attachment (a crash between the two) is
  // resumed by `deliver`, which only emits what is missing. Only then does another daemon's reply
  // in the thread count as done.
  const resumable = !!mine?.event_id;
  if (!resumable) {
    const already = ctx.replies(job.root).some((r) => r.author.agent === "wispr" && String((r.body as { text?: unknown }).text ?? "").includes(job.url));
    if (already) {
      ctx.state.atomically(() => { ctx.state.record("wispr", ext, null, ctx.now()); ctx.state.dropRetry("wispr", ext); });
      return;
    }
  }
  if (!ctx.take()) { ctx.state.rescheduleRetry("wispr", ext, attempts, ctx.now() + RATE_WAIT_MS); return; } // queued, not dropped
  if (!ctx.state.claim("wispr", ext, ctx.now())) return;
  const failed = (why: string) => {
    ctx.state.release("wispr", ext);
    const n = attempts + 1;
    if (n >= MAX_UNFURL_ATTEMPTS) {
      ctx.state.atomically(() => { ctx.state.record("wispr", ext, null, ctx.now()); ctx.state.dropRetry("wispr", ext); });
      ctx.log.warn("wispr_unfurl_gave_up", { event: job.event, attempts: n, why: ctx.scrub(why).slice(0, 200) });
      return;
    }
    ctx.state.rescheduleRetry("wispr", ext, n, ctx.now() + unfurlBackoff(n));
    ctx.log.info("wispr_unfurl_retry", { event: job.event, attempts: n, why: ctx.scrub(why).slice(0, 200) });
  };
  let res: ShareResult;
  try {
    res = await fetchShare(ctx, job);
  } catch (err) {
    if (!ctx.alive()) return; // cancelled: leave the job exactly as it was
    failed(err instanceof Error ? err.message : "error");
    return;
  }
  if (res.kind === "absent") {
    ctx.state.atomically(() => { ctx.state.record("wispr", ext, null, ctx.now()); ctx.state.dropRetry("wispr", ext); });
    return;
  }
  if (res.kind === "transient") { failed(res.why); return; }
  const note = res.note;
  try {
    await ctx.poster.deliver({
      connector: "wispr", channel: ev.channel, externalId: ext, thread: job.root,
      text: `**${note.title}** (Wispr Flow note)\n${job.url}\n\n${excerpt(note.text)}`,
      attachment: {
        name: `wispr-note-${job.slug.slice(0, 24)}.txt`, mime: "text/plain; charset=utf-8",
        text: `${note.title}\nSource: ${job.url}\n\n${note.text}\n`, note: "Full note text (Wispr Flow)",
      },
    });
    ctx.state.dropRetry("wispr", ext);
  } catch (err) {
    if (!ctx.alive()) return;
    failed(err instanceof Error ? err.message : "error");
  }
}
