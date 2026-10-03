// PROJECT-PAGES-1: the plain-English parts of a project's status page (a headline, a lede, what is live and what lands next,
// and now and then one sentence about out-of-date screens), taken from the report turn's reply. A report block may hold one
// <page> with those parts; it is cut out of the report text, read in one bounded pass, and every string is cleaned with the
// report's own rules (what a reader sees, no link of any kind, no join code, no secret, no card key, no markup) and capped.
// What the model gets wrong costs only the page, never the report. Pure: the daemon delivers, the page shows what it posted.
import { redactSecrets } from "../safety.ts";
import type { StoryCounts } from "./status-page.ts";
import { carriesJoinCode, readable, respellWeeks, scrubbed, stripCardKeys } from "./status-report.ts";

/** What a page may carry, in characters and items. */
export const STORY_CAPS = { headline: 100, lede: 420, item: 180, live: 8, next: 6, screens: 140 } as const;
/** A headline or a lede shorter than this is not one. */
const MIN_HEADLINE = 8;
const MIN_LEDE = 20;
/** How much of a page is read at all: what the caps allow several times over (the report's own reading window is the same). */
const READ_CHARS = 16_000;

export interface StoryParts {
  headline: string; lede: string; live_now: string[]; landing_next: string[];
  /** "Screens are out of date …": only when the daemon said it was wanted. */
  screens_note?: string;
  /** The counts the summary was written against (only a post that carried them has them). */
  counts?: StoryCounts;
}

// ---- cutting the page out of a block -----------------------------------------------------------------------------------

/** `<page>` or `</page>`: case and a few spaces aside. Every repetition is bounded, so no input costs more than a few steps per `<`. */
const PAGE_TAG = /<[ \t]{0,8}(\/)?[ \t]{0,8}page[ \t]{0,8}>/gi;
const AFTER_BLOCK = /[ \t]{0,40}(?:\r?\n)?/y;

/**
 * A block's text split into the report (the text outside the page; the line break after a page goes with it) and the page
 * (the inside of the first complete one, untrimmed). Later pages are removed and ignored, a closer with no opener is dropped
 * alone, and a page that never closes is dropped with everything after its opener, so none of it lands in the report.
 * One pass over the text.
 */
export function splitPage(text: string): { report: string; page: string | null } {
  let page: string | null = null;
  let report = "";
  let copied = 0;
  let open: { start: number; end: number } | null = null;
  for (const m of text.matchAll(PAGE_TAG)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (m[1] === undefined) {
      if (open === null) open = { start: at, end };
    } else if (open !== null) {
      if (page === null) page = text.slice(open.end, at);
      report += text.slice(copied, open.start);
      AFTER_BLOCK.lastIndex = end;
      copied = end + (AFTER_BLOCK.exec(text)?.[0].length ?? 0);
      open = null;
    } else {
      report += text.slice(copied, at);
      copied = end;
    }
  }
  report += text.slice(copied, open === null ? undefined : open.start);
  return { report: report.trim(), page };
}

// ---- cleaning one string -----------------------------------------------------------------------------------------------

/** A markdown link, every part bounded and a target with one level of parentheses ("javascript:alert(1)"): `[words](target "title")`. */
const LINK = /\[([^\]\n]{0,300})\]\(\s{0,20}(?:[^()\s]|\([^()\s]{0,200}\)){0,2000}(?:\s{1,20}"[^"\n]{0,200}")?\s{0,20}\)/g;
/** Addresses in any spelling a person would click or paste: a scheme and `//`, the schemes that act without one, and `www.`. */
const SCHEME_URL = /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9+.-]{1,14}:\/\/\S*/g;
const PSEUDO_URL = /(?<![A-Za-z0-9])(?:mailto|javascript|vbscript|data|file|tel|sms|blob):\S+/gi;
const WWW_URL = /(?<![A-Za-z0-9@])www\.\S+/gi;
const TAG = /<\/?[A-Za-z][^<>\n]{0,200}>|<!--[^>]{0,500}-->/g;

const HAS_SCHEME_URL = new RegExp(SCHEME_URL.source);
const HAS_PSEUDO_URL = new RegExp(PSEUDO_URL.source, "i");
const HAS_WWW_URL = new RegExp(WWW_URL.source, "i");

/** Whether a text carries an address in any spelling a person would click or paste (what cleanStoryLine takes out). */
export function containsLink(text: string): boolean {
  const t = readable(text);
  return HAS_SCHEME_URL.test(t) || HAS_PSEUDO_URL.test(t) || HAS_WWW_URL.test(t);
}

/** A text with every link in it taken out and the words of a markdown link kept (what a page says of a link: nothing, but its words). */
export function stripLinks(text: string): string {
  return text.replace(LINK, "$1").replace(SCHEME_URL, "").replace(PSEUDO_URL, "").replace(WWW_URL, "");
}

/** `max` characters, cut at a word where one is near the end, with an ellipsis; never half of a character outside the BMP. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let head = s.slice(0, max - 1);
  const cut = head.lastIndexOf(" ");
  if (cut >= max * 0.5) head = head.slice(0, cut);
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}

/**
 * One teammate- or model-written string as a page may say it, or null when nothing is left or it must not be said: what a
 * reader sees (compatibility characters as what they spell; no control, invisible or combining character), no link in any
 * spelling (a link's words stay), no markup or markdown marker, no card key of these projects, secrets redacted, a week
 * written "wk1" respelled, a join code (the daemon would refuse the post) and the whole string is dropped. At most `max` characters.
 */
export function cleanStoryLine(s: string, max: number, prefixes: readonly string[]): string | null {
  const shown = readable(s.slice(0, max * 8)).replace(/[\r\n\t]+/g, " ");
  // The same bare-letters judgement the report gets (status-report.ts): a disguise (an accent that composes with its letter, a
  // blank-looking filler) must not keep a key or a code out of the checks while a reader reads straight through it.
  let t = scrubbed(shown, (x) => {
    let y = x.replace(LINK, "$1").replace(TAG, "").replace(SCHEME_URL, "").replace(PSEUDO_URL, "").replace(WWW_URL, "");
    y = stripCardKeys(y, prefixes).replace(/\(\s*\)|\[\s*\]/g, "");
    y = y.replace(/^#{1,6}\s+/, "").replace(/[*~`]+/g, "").replace(/(?<![A-Za-z0-9])_+(?=\S)|(?<=\S)_+(?![A-Za-z0-9])/g, "");
    return redactSecrets(y).text;
  });
  t = respellWeeks(t).replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(t) || carriesJoinCode(t)) return null;
  return clip(t, max);
}

// ---- reading the page --------------------------------------------------------------------------------------------------

const PART = ["headline", "lede", "live-now", "landing-next", "screens"] as const;
type Part = (typeof PART)[number];
/** How a part's name may be spelled: a model writes live-now, live_now or live now (a separator of at most two characters, any case). */
const SPELLING: Record<Part, string> = { headline: "headline", lede: "lede", "live-now": "live[-_ ]{0,2}now", "landing-next": "landing[-_ ]{0,2}next", screens: "screens" };
const OPENER = new RegExp(`<[ \\t]{0,8}(${PART.map((n) => SPELLING[n]).join("|")})[ \\t]{0,8}>`, "gi");
const CLOSER = Object.fromEntries(PART.map((name) => [name, new RegExp(`<[ \\t]{0,8}\\/[ \\t]{0,8}${SPELLING[name]}[ \\t]{0,8}>`, "gi")])) as Record<Part, RegExp>;
/** The part a spelling names. */
function partNamed(spelled: string): Part {
  const k = spelled.toLowerCase().replace(/[-_ ]/g, "");
  return k === "livenow" ? "live-now" : k === "landingnext" ? "landing-next" : (k as Part);
}

/** The inside of the first complete part of each name, found in one pass (the inside of a part is never searched for the next one). */
function partsOf(win: string): Map<string, string> {
  const found = new Map<string, string>();
  OPENER.lastIndex = 0;
  for (let m = OPENER.exec(win); m; m = OPENER.exec(win)) {
    const name = partNamed(m[1] as string);
    const from = m.index + m[0].length;
    const closer = CLOSER[name];
    closer.lastIndex = from;
    const c = closer.exec(win);
    if (!c) continue; // never closed: not read, and the scan goes on after its opener
    if (!found.has(name)) found.set(name, win.slice(from, c.index));
    OPENER.lastIndex = c.index + c[0].length;
  }
  return found;
}

const BULLET = /^\s{0,8}(?:[-*•–—]|\d{1,2}[.)])\s+/;

/** The items of a list part: one per line (a bullet or number is not part of it), blank, empty and repeated ones skipped, at most `cap`. */
function itemsOf(inside: string | undefined, cap: number, prefixes: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of (inside ?? "").split("\n")) {
    if (out.length >= cap) break;
    const item = cleanStoryLine(line.replace(BULLET, ""), STORY_CAPS.item, prefixes);
    if (item === null || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
  }
  return out;
}

/**
 * The page from the inside of a <page>: a headline and a lede (both required, and long enough to be one) and two lists
 * (which may be empty), each string cleaned and capped. The screens sentence is kept only when `screensAsked` (the daemon
 * judged the screens out of date); anything else is left out. Null when there is no usable headline and lede.
 */
export function parseStory(inside: string, opts: { prefixes: readonly string[]; screensAsked: boolean }): StoryParts | null {
  const parts = partsOf(inside.slice(0, READ_CHARS));
  const headline = cleanStoryLine(parts.get("headline") ?? "", STORY_CAPS.headline, opts.prefixes);
  const lede = cleanStoryLine(parts.get("lede") ?? "", STORY_CAPS.lede, opts.prefixes);
  if (headline === null || headline.length < MIN_HEADLINE || lede === null || lede.length < MIN_LEDE) return null;
  const note = opts.screensAsked ? cleanStoryLine(parts.get("screens") ?? "", STORY_CAPS.screens, opts.prefixes) : null;
  return {
    headline, lede, live_now: itemsOf(parts.get("live-now"), STORY_CAPS.live, opts.prefixes),
    landing_next: itemsOf(parts.get("landing-next"), STORY_CAPS.next, opts.prefixes),
    ...(note !== null ? { screens_note: note } : {}),
  };
}

/**
 * A report made from a page alone, for a block whose own report text was missing or unusable: the headline in bold, the lede,
 * then the two lists. (The post and the Data Room document are made from the same plain-English result.)
 */
export function storyAsReport(story: StoryParts): string {
  const list = (items: readonly string[]) => (items.length ? items : ["Nothing yet."]).map((i) => `- ${i}`).join("\n");
  return `**${story.headline}**\n\n${story.lede}\n\n**Live now**\n${list(story.live_now)}\n\n**Landing next**\n${list(story.landing_next)}`;
}

/** What the post carries beside its text, and what the page reads back. */
export interface StoryPost { v: 1; headline: string; lede: string; live_now: string[]; landing_next: string[]; screens_note?: string; counts?: StoryCounts }

/** The post's `status_page`: the story and, when the daemon has them, the counts its facts held (what the page compares later). */
export function storyPost(story: StoryParts, counts?: StoryCounts): StoryPost {
  return {
    v: 1, headline: story.headline, lede: story.lede, live_now: story.live_now, landing_next: story.landing_next,
    ...(story.screens_note ? { screens_note: story.screens_note } : {}), ...(counts ? { counts } : {}),
  };
}

/** Counts as posted: three whole numbers, or nothing (a story with unreadable counts is a story without them, which is never flagged). */
function readCounts(raw: unknown): StoryCounts | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000 ? v : null);
  const blocked = n(c.blocked);
  const inProgress = n(c.in_progress);
  const inReview = n(c.in_review);
  return blocked === null || inProgress === null || inReview === null ? null : { blocked, in_progress: inProgress, in_review: inReview };
}

/**
 * A story read back from a posted `status_page`: every string cleaned again with the same rules (a post by a modified
 * daemon, or by an older build with other caps, is never shown as it came), null when it is not a usable page.
 */
export function readStoryPost(raw: unknown, prefixes: readonly string[]): StoryParts | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.headline !== "string" || typeof r.lede !== "string") return null;
  const headline = cleanStoryLine(r.headline, STORY_CAPS.headline, prefixes);
  const lede = cleanStoryLine(r.lede, STORY_CAPS.lede, prefixes);
  if (headline === null || headline.length < MIN_HEADLINE || lede === null || lede.length < MIN_LEDE) return null;
  const list = (v: unknown, cap: number): string[] => {
    const out: string[] = [];
    for (const x of Array.isArray(v) ? v.slice(0, cap * 3) : []) {
      if (out.length >= cap) break;
      const item = typeof x === "string" ? cleanStoryLine(x, STORY_CAPS.item, prefixes) : null;
      if (item !== null && !out.some((y) => y.toLowerCase() === item.toLowerCase())) out.push(item);
    }
    return out;
  };
  const note = typeof r.screens_note === "string" ? cleanStoryLine(r.screens_note, STORY_CAPS.screens, prefixes) : null;
  const counts = readCounts(r.counts);
  return {
    headline, lede, live_now: list(r.live_now, STORY_CAPS.live), landing_next: list(r.landing_next, STORY_CAPS.next),
    ...(note !== null ? { screens_note: note } : {}), ...(counts ? { counts } : {}),
  };
}
