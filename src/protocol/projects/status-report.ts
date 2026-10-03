// PROJECT-REPORTS-1: hourly plain-English status reports. Pure (no I/O): the daemon gathers the facts (daemon/projects/
// status-report.ts), the dashboard and CLI share the setting's rules, and everything decided here is tested without a
// daemon. docs/plans/PROJECT-REPORTS-1.md has the design.
import { containsJoinCredential } from "../join-credential.ts";
import { defang, redactSecrets } from "../safety.ts";
import type { ColumnRole } from "./schema.ts";
import { HEADER_START } from "./status-report-setting.ts";
export { reportMode, splitReport, statusReportDenial, type StatusReportMode } from "./status-report-setting.ts";

// ---- constants ----------------------------------------------------------------------------------------------------

/** The Data Room document a report is saved as (its next versions, then `Status report (2)`, … when a file is full). */
export const STATUS_REPORT_FILE = "Status report";
/** Projects written up in one turn; the rest wait for the next hour. */
export const REPORT_CAP = 10;
/** Reports in a row that could not be used (the model wrote none, or the post was refused) after which a project waits until it changes. */
export const GIVE_UP_AFTER = 3;
/** One report, in characters (a turn's reply is read whole, so this bounds what is posted). */
export const REPORT_MAX_CHARS = 4_000;
const REPORT_MIN_CHARS = 12;
/** All the fact sheets of one turn: the daemon accepts a 32 000-character prompt, and the template and fence take the rest. */
export const FACTS_BUDGET = 24_000;
const FACTS_PER_PROJECT = 2_600;
/** A card with this label is left out of every count, list and test: nothing from it reaches a report. */
export const CONFIDENTIAL_LABEL = "confidential";
const BLOCKER_LABELS: Readonly<Record<string, string>> = { blocker: "marked as a blocker", "decision-needed": "decision needed", "waiting-on": "waiting on someone else" };

export function isConfidential(labels: readonly string[]): boolean {
  return labels.some((l) => l.trim().toLowerCase() === CONFIDENTIAL_LABEL);
}

/** 2026-10-01 14:00 UTC */
export function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// ---- which projects, in what order --------------------------------------------------------------------------------

/** A due project: its last report and last attempt (successful or failed); null means never. */
export interface DueProject { channel: string; last: number | null; attempted?: number | null }

/**
 * The projects written up this turn: never-attempted ones first, then the oldest attempt, whether it succeeded or failed.
 * A failed attempt uses its place in the rotation: it neither monopolizes turns nor loses all future retry opportunities
 * to healthy projects. Equal times are ordered by channel; at most `cap` projects are selected.
 */
export function planBatch(due: readonly DueProject[], cap = REPORT_CAP): { batch: string[]; deferred: number } {
  const sorted = [...due].sort((a, b) => (a.attempted ?? a.last ?? -1) - (b.attempted ?? b.last ?? -1)
    || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
  return { batch: sorted.slice(0, cap).map((p) => p.channel), deferred: Math.max(0, sorted.length - cap) };
}

// ---- card keys and titles -----------------------------------------------------------------------------------------

function keyPattern(prefixes: readonly string[]): RegExp | null {
  const alt = [...new Set(prefixes.filter((p) => /^[A-Z][A-Z0-9]{1,9}$/.test(p)))].sort((a, b) => b.length - a.length);
  return alt.length ? new RegExp(`(?<![A-Za-z0-9])(?:${alt.join("|")})-\\d{1,7}(?:-[0-9a-fA-F]{8})?(?![A-Za-z0-9])`, "gi") : null;
}

/** A report names no card by its key: the keys of these projects (a reference's short id with it) are removed. */
export function stripCardKeys(text: string, prefixes: readonly string[]): string {
  const re = keyPattern(prefixes);
  return re ? text.replace(re, "") : text;
}

const URL_RE = /https?:\/\/\S+/gi;
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|\p{Cf}|\p{M}/gu;
/**
 * What shows nothing but is none of a control, a format character or a mark: the Hangul fillers (default-ignorable), the
 * blank braille cell, the object replacement mark, and private-use, unassigned and lone-surrogate code points.
 */
const BLANK = /[\u2800\uFFFC]|\p{Default_Ignorable_Code_Point}|\p{Co}|\p{Cn}|\p{Cs}/gu;

/**
 * The bare letters of a text: compatibility forms written as the characters they stand for (fullwidth, ligatures, circled
 * digits), every accent and combining mark taken off its letter, and controls, format characters and blank-looking letters
 * taken out, so what is left is what a reader sees run together. Tabs, newlines and spaces stay (they separate words).
 * Decomposing first matters: composing instead (NFKC) turns a letter and its accent into one precomposed letter, which is
 * not a mark and so would stay and break the run.
 */
export function bareLetters(s: string): string {
  return s.normalize("NFKD").replace(INVISIBLE, "").replace(BLANK, "").normalize("NFKC");
}

/**
 * Text as it is shown: compatibility characters (fullwidth letters, ligatures, circled digits) as what they spell, composed
 * (a letter and its accent are one letter), and no control, invisible or non-composing combining character in it.
 */
export function readable(s: string): string {
  return s.normalize("NFKC").replace(INVISIBLE, "");
}

/**
 * Takes out of a text what must not be said (`scrub`: card keys, links, join codes, secrets), judged on the text as it is
 * shown and on its bare letters. The bare letters decide whether there is a disguise (a letter and an accent that compose, a
 * blank-looking letter between two letters): when they hold nothing to take out, what is shown is judged as shown; when they
 * hold what the shown text's own pass took out (a plain link beside accents), the text is said as shown, accents and all; when
 * they hold more (a disguised find, or a long one the shown pass only met the front of), the text is said in its bare letters
 * with the find taken out, rather than guessing which of its characters were the disguise.
 */
export function scrubbed(shown: string, scrub: (t: string) => string): string {
  const bare = bareLetters(shown);
  if (bare === shown) return scrub(shown);
  const viaBare = scrub(bare);
  if (viaBare === bare) return scrub(shown);
  const once = scrub(shown);
  return bareLetters(once) === viaBare ? once : viaBare;
}

/**
 * Teammate-written text as a model may read it, on one line: no link (a report links nowhere, and a title is not the place
 * to trust one), no join code (the daemon refuses to post one, so it must not reach a report), no secret, nothing it
 * could read as an instruction, at most `max` characters. What is judged is the text as shown and its bare letters, so a
 * disguise (fullwidth forms, an accent that composes with its letter, a filler) cannot keep a code, a link or a key out of
 * the checks while a model reads straight through it; what is said keeps its accents unless a disguise was found in it.
 */
export function safeText(s: string, max: number): string {
  const shown = readable(s);
  const bare = bareLetters(shown);
  if (containsJoinCredential(shown) || (bare !== shown && containsJoinCredential(bare))) return "(text withheld)";
  return defang(scrubbed(shown, (t) => redactSecrets(t.replace(URL_RE, "(link)")).text), max);
}

/** A card's title as a report may say it: no key (however it is written or disguised), and safeText. */
export function plainTitle(title: string, prefixes: readonly string[], max = 80): string {
  const t = scrubbed(readable(title), (x) => stripCardKeys(x, prefixes)).replace(/\(\s*\)|\[\s*\]/g, "").replace(/\s+/g, " ")
    .replace(/^[\s:;,.\-–—·|]+|[\s:;,\-–—·|]+$/g, "");
  return t ? safeText(t, max) : "(untitled)";
}

// ---- the fact sheet -----------------------------------------------------------------------------------------------

export interface FactCard {
  title: string; column: string; role: ColumnRole;
  /** Who is on it, as a person would say it ("Maren", "agent cc-2 for Alex"); null = nobody. */
  assignee: string | null; labels: readonly string[]; blocked: boolean; blocked_reason: string | null; due: string | null;
}
/** What happened to one card since the last report. */
export interface FactChange {
  title: string; created: boolean; from: string | null; to: string | null; closed: boolean;
  /** true = became blocked, false = unblocked, null = neither. */
  blocked: boolean | null; edited: boolean; comments: number;
}
/** Whether what happened to a card is something a report says: created, moved, finished, edited, blocked or unblocked, commented on. A reorder or an archive alone is not. */
export function isNews(c: FactChange): boolean {
  return c.created || c.closed || (c.to !== null && c.to !== c.from) || c.edited || c.blocked !== null || c.comments > 0;
}
export interface FactAgent { name: string; owner: string; state: string; doing: string | null }
export interface ProjectFacts {
  channel: string; name: string; description: string;
  /** The project prefixes (current and earlier): a key of any of them is removed from a title. */
  keys: readonly string[];
  /** When the facts were gathered, and the previous report's time (null: never reported). */
  at: number; last: number | null;
  columns: ReadonlyArray<{ name: string; role: ColumnRole; n: number }>;
  open: number;
  /** Cards that changed since the last report, counting those not looked at (`changes` lists the ones that were, most recent first). */
  changed: number; changes: readonly FactChange[]; comments: number;
  working: readonly FactCard[]; blocked: readonly FactCard[]; overdue: readonly FactCard[]; agents: readonly FactAgent[];
  /**
   * PROJECT-PAGES-1 (absent from a sheet made without them): titles of what was finished in the last 14 days and of the top of
   * the to-do columns (a confidential card is in neither), and the project's status page screens: how many, when the newest was
   * added, and whether they are out of date (none, or the newest is over a week old).
   */
  finished?: readonly string[]; upNext?: readonly string[];
  screens?: { count: number; newest: number | null; wanted: boolean };
  /**
   * The counts of blocked, in-progress and in-review cards as the status page counts them when the sheet is made: the report's page is
   * written against these and its post carries them, so the page can tell later that the board has moved on.
   */
  pageCounts?: { blocked: number; in_progress: number; in_review: number };
}

const CAPS = { fresh: 6, finished: 8, moved: 6, unblocked: 4, edited: 4, blocked: 8, overdue: 5, working: 8, agents: 6, lately: 6, upNext: 5 } as const;

function section(label: string, items: readonly string[], cap: number): string | null {
  if (!items.length) return null;
  const shown = items.slice(0, cap);
  return `${label} (${items.length}): ${shown.join("; ")}${items.length > shown.length ? ` (+${items.length - shown.length} more)` : ""}`;
}

function build(f: ProjectFacts, scale: number): string {
  const cap = (n: number) => Math.max(1, Math.floor(n * scale));
  const q = (title: string) => `"${plainTitle(title, f.keys)}"`;
  const say = (s: string | null) => (s ? safeText(s, 60) : "");
  const fresh = f.changes.filter((c) => c.created);
  const rest = f.changes.filter((c) => !c.created);
  const finished = rest.filter((c) => c.closed);
  const moved = rest.filter((c) => !c.closed && c.to !== null && c.to !== c.from);
  const others = rest.filter((c) => !c.closed && !(c.to !== null && c.to !== c.from));
  const unblocked = others.filter((c) => c.blocked === false);
  const edited = others.filter((c) => c.blocked !== false && c.edited);
  const about = safeText(f.description.split("\n")[0] ?? "", 200);
  const unlisted = f.changed - f.changes.length; // cards that may have changed but were not looked at
  const lines: Array<string | null> = [
    `=== PROJECT ${f.channel} ===`,
    `Name: ${safeText(f.name, 80)}`,
    about ? `About: ${about}` : null,
    `Facts as of: ${utcMinute(f.at)}`,
    `Last report: ${f.last === null ? "none yet (this is the first report)" : utcMinute(f.last)}`,
    `Open cards by column: ${f.columns.map((c) => `${say(c.name)} ${c.n}`).join("; ")} (${f.open} open in all)`,
    section("New since the last report", fresh.map((c) => `${q(c.title)}${c.to ? ` (${say(c.to)})` : ""}`), cap(CAPS.fresh)),
    section("Finished since the last report", finished.map((c) => q(c.title)), cap(CAPS.finished)),
    section("Moved since the last report", moved.map((c) => `${q(c.title)}${c.from ? ` from ${say(c.from)}` : ""} to ${say(c.to)}`), cap(CAPS.moved)),
    section("Unblocked since the last report", unblocked.map((c) => q(c.title)), cap(CAPS.unblocked)),
    section("Edited or relabelled since the last report", edited.map((c) => q(c.title)), cap(CAPS.edited)),
    unlisted > 0 ? `Also up to ${unlisted} more card${unlisted === 1 ? "" : "s"} may have changed that ${unlisted === 1 ? "is" : "are"} not listed above.` : null,
    f.comments > 0 ? `New comments since the last report: ${unlisted > 0 ? "at least " : ""}${f.comments}` : null,
    section("Blocked or waiting", f.blocked.map((c) => {
      const why = [...(c.blocked ? [`blocked${c.blocked_reason ? `: ${safeText(c.blocked_reason, 120)}` : ""}`] : []),
        ...c.labels.map((l) => BLOCKER_LABELS[l.trim().toLowerCase()]).filter((x): x is string => !!x)];
      return `${q(c.title)} (${why.join("; ") || "blocked"})`;
    }), cap(CAPS.blocked)),
    section("Overdue", f.overdue.map((c) => `${q(c.title)} (due ${c.due ?? "?"})`), cap(CAPS.overdue)),
    section("In progress now", f.working.map((c) => `${q(c.title)} (${c.assignee ? say(c.assignee) : "nobody assigned"})`), cap(CAPS.working)),
    section("Finished in the last 14 days", (f.finished ?? []).map(q), cap(CAPS.lately)),
    section("Up next (to do)", (f.upNext ?? []).map(q), cap(CAPS.upNext)),
    f.screens ? `Status page screens: ${f.screens.count === 0 || f.screens.newest === null ? "none yet" : `${f.screens.count}, the newest added ${utcMinute(f.screens.newest)}`}${f.screens.wanted ? " (out of date)" : ""}` : null,
    section("Agents on this project now", f.agents.map((a) => `${say(a.name)} for ${say(a.owner)}, ${say(a.state)}${a.doing ? ` on ${q(a.doing)}` : ""}`), cap(CAPS.agents)),
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/** One project's sheet within `budget` characters: lists shrink (each says how many it left out) before the text is cut. */
export function renderFacts(f: ProjectFacts, budget: number): string {
  for (const scale of [1, 0.75, 0.5, 0.25, 0]) {
    const text = build(f, scale);
    if (text.length <= budget) return text;
  }
  const last = build(f, 0);
  return `${last.slice(0, Math.max(0, budget - 1))}…`;
}

/** The fact sheets of one turn, sharing the prompt's room, with how many due projects wait for the next hour. */
export function renderBatch(sheets: readonly ProjectFacts[], deferred: number): string {
  const note = deferred > 0
    ? `\n\nNote: ${deferred} more project${deferred === 1 ? "" : "s"} changed and ${deferred === 1 ? "waits" : "wait"} for the next hour; write no report for ${deferred === 1 ? "it" : "them"}.` : "";
  const per = Math.min(FACTS_PER_PROJECT, Math.floor((FACTS_BUDGET - note.length - 2 * sheets.length) / Math.max(1, sheets.length)));
  return sheets.map((s) => renderFacts(s, per)).join("\n\n") + note;
}

// ---- the reply and the report -------------------------------------------------------------------------------------

const TAG = /<status-report\s+project="(p-[0-9a-f]{8})"\s*>|<\/status-report>/g;

/**
 * One report per project of this turn from the model's reply: its first block for that project, nothing for any other.
 * A closing tag ends the nearest opening tag before it (an opening tag left unclosed is dropped when another follows, so
 * its text is never filed under the next project), and the reply is read in one pass: a reply full of stray tags costs no
 * more than one without.
 */
export function parseReports(reply: string, allowed: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  let open: { channel: string; from: number } | null = null;
  for (const m of reply.matchAll(TAG)) {
    const at = m.index ?? 0;
    if (m[1] !== undefined) { open = { channel: m[1], from: at + m[0].length }; continue; }
    if (!open) continue;
    const body = reply.slice(open.from, at).trim();
    if (allowed.has(open.channel) && body && !out.has(open.channel)) out.set(open.channel, body);
    open = null;
  }
  return out;
}

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const FORMAT = /\p{Cf}/gu;

/** A markdown link, every part of it bounded (so no input costs more than a few thousand steps per `[`): `[words](target "title")`. */
const LINK = /\[([^\]\n]{0,300})\]\(\s{0,20}[^)\s]{0,2000}(?:\s{1,20}"[^"\n]{0,200}")?\s{0,20}\)/g;
const JOIN_CODE = /wk1[A-Za-z0-9_-]{38,}/g;
/** The daemon's own join-code check looks for this anywhere in a text (after it has removed every space). */
const WK1 = /wk1/g;
const CODE_CHAR = /[A-Za-z0-9_-]/;
/** A code is `wk1` and at least this many characters of base64url (join-credential.ts). */
const CODE_CHARS = 38;
/**
 * Of the CODE_CHARS a code would be read from, a random code has about 23 that are not lowercase letters (capitals,
 * digits, `-`, `_`); prose has a handful (a few capitals, a "wk4"). Fewer than this many is prose.
 */
const PROSE_CAPS_MAX = 12;

/**
 * What follows from `from` up to the 38th join-code character, spaces included: the stretch the daemon's own check takes
 * for a code (it strips every space before it looks). Null when fewer than 38 code characters follow before anything else.
 */
function codeSpan(t: string, from: number): string | null {
  let n = 0;
  let i = from;
  for (; i < t.length && n < CODE_CHARS; i++) {
    const c = t[i] as string;
    if (CODE_CHAR.test(c)) n++;
    else if (!/\s/.test(c)) return null;
  }
  return n === CODE_CHARS ? t.slice(from, i) : null;
}

/** Whether a stretch the daemon's check would read as a code is really words: it has few capitals, digits and hyphens. */
function readsAsWords(span: string): boolean {
  let odd = 0;
  for (const c of span) if (CODE_CHAR.test(c) && !/[a-z]/.test(c)) odd++;
  return odd < PROSE_CAPS_MAX;
}

/** A wk1 the daemon's join-code check would read as a code's start but that is followed by words (a week) is respelled "wk-1". */
export function respellWeeks(t: string): string {
  return t.replace(WK1, (marker, at: number, whole: string) => {
    const span = codeSpan(whole, at + marker.length);
    return span !== null && readsAsWords(span) ? "wk-1" : marker;
  });
}

/**
 * Whether a report carries a join code: one the daemon's own check would refuse to post, or one it would miss because a
 * disguise (an accent that composes with its letter, a filler) breaks the run of characters it looks for. The second is judged
 * on the bare letters, where a wk1 that is followed by words (a week, in a text with accents) is still a week.
 */
export function carriesJoinCode(t: string): boolean {
  if (containsJoinCredential(t)) return true;
  const bare = bareLetters(t);
  return bare !== t && containsJoinCredential(respellWeeks(bare));
}

/**
 * A report as it may be posted: control and invisible characters gone, the turn's own tags gone, no card key of these
 * projects, no link (its text stays), no join code (a code is dropped as a token; a lone "wk1" word is respelled), secrets
 * redacted, tidy lines, at most REPORT_MAX_CHARS. Keys, links, codes and secrets are looked for in the text as written and
 * in its bare letters (a disguise found only there puts the report in its bare letters, find taken out). Null when nothing
 * readable is left, or a join code survives, disguised or not. Only the start of a longer text is read at all: what is cut
 * at the end anyway never reaches the passes below.
 */
export function cleanReport(text: string, opts: { prefixes: readonly string[]; max?: number }): string | null {
  const max = opts.max ?? REPORT_MAX_CHARS;
  const start = text.slice(0, max * 4).replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(FORMAT, "").replace(/<\/?status-report\b[^>\n]{0,200}>/gi, "");
  let t = scrubbed(start, (x) => redactSecrets(
    stripCardKeys(x, opts.prefixes).replace(/\(\s*\)|\[\s*\]/g, "").replace(LINK, "$1").replace(/\]\(/g, "] (").replace(URL_RE, "(link removed)").replace(JOIN_CODE, "(code removed)")).text);
  t = t.split("\n").map((l) => l.replace(/(\S)[ \t]{2,}/g, "$1 ").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // The daemon refuses to post what its own check takes for a join code, and that check strips every space before it looks:
  // a plain "the wk1 launch plan for …" or "wk12 and …" (a week) trips it. A wk1 that the check would read as a code's
  // start (38 code characters follow it, spaces aside) but that is followed by words, not by what a code is made of, is
  // such a case, and only the marker is respelled, so the report still goes out. A code, however it is split (by spaces,
  // by percent escapes, by accents or fillers), is not touched here and still voids the report.
  t = respellWeeks(t);
  if (carriesJoinCode(t) || t.replace(/[\s*#_>\-•`]/g, "").length < REPORT_MIN_CHARS) return null;
  if (t.length > max) {
    const head = t.slice(0, max - 1);
    const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
    t = `${(cut > max - 300 ? head.slice(0, cut) : head).trimEnd()}…`;
  }
  return t;
}

/** What is posted and saved: a bold line naming the project and the time its facts are as of, then the report. */
export function composeReport(name: string, asOf: number, body: string): string {
  return `${HEADER_START}${safeText(name, 60).replace(/\*/g, "")} · as of ${utcMinute(asOf)}**\n\n${body}`;
}

// ---- what a run records -------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The schedule's `last_result` for a run of this duty. */
export function summarizeRun(r: { checked: number; due: number; reported: number; missing: number; failed?: number; spent?: number; deferred: number; paused?: number; badPage?: number }): string {
  const paused = r.paused ? `${plural(r.paused, "project is", "projects are")} paused until ${r.paused === 1 ? "it changes" : "they change"}: ${r.paused === 1 ? "its" : "their"} last ${GIVE_UP_AFTER} reports could not be used` : null;
  if (r.due === 0) {
    const none = r.checked === 0 ? "No project has an hourly status report; no model turn."
      : `No changes since the last ${r.checked === 1 ? "report" : "reports"} (${plural(r.checked, "project", "projects")} checked); no model turn.`;
    return paused ? `${none} ${paused[0]?.toUpperCase()}${paused.slice(1)}.` : none;
  }
  const parts = [`Reported ${r.reported} of ${plural(r.due, "changed project", "changed projects")}`];
  if (r.missing) parts.push(`${r.missing} had no usable report and ${r.missing === 1 ? "is" : "are"} tried again next hour`);
  if (r.failed) parts.push(`${r.failed} could not be posted and ${r.failed === 1 ? "is" : "are"} tried again next hour`);
  if (r.spent) parts.push(`${r.spent} had no report that could be used ${GIVE_UP_AFTER} times in a row and ${r.spent === 1 ? "is" : "are"} now paused until ${r.spent === 1 ? "it changes" : "they change"}`);
  if (r.badPage) parts.push(`${r.badPage} had a status page that could not be used`);
  if (r.deferred) parts.push(`${r.deferred} wait for the next hour`);
  if (paused) parts.push(paused);
  return `${parts.join("; ")}.`;
}
