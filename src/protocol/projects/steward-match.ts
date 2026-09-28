// FO-6 board steward: which card a piece of text (an agent's status, a branch name) is about, and what a card's
// comments say. Pure and deterministic, shared by the daemon's steward and the CLI's dry run.
//
// A card is named by its key or reference (`SP-210`, `SP-210-1f2e3d4c`), or by its LANE CODE: the leading code of
// its title (`[ALE-5369] MERGE-6H-a: money chain` has the code MERGE-6H-a), which is what agents put in their
// titles and branch names (`lane/merge-6h-a-cx2`, "Opus audit AGENT-ADMIN-1"). A code matches as a whole token
// (bounded by anything but a letter or digit); when several cards' codes match the same text the longest code wins,
// so `lane/onb-2-f1` is ONB-2-F1's branch, not ONB-2's, when both cards exist.
import { keysIn } from "./assoc.ts";

/** A card as the matchers need it. */
export interface MatchCard { readonly id: string; readonly key: string; readonly short: string; readonly title: string }

const LEADING_BRACKETS = /^(?:\s*\[[^\]\n]{1,40}\]\s*)+/;
/** A lane code: an upper-case word, then at least one `-part`, with a digit somewhere. */
const CODE_RE = /^[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+$/;
/** `ALE-5096`: another issue's key, not a lane code. */
const ISSUE_KEY_LIKE = /^[A-Z]{2,10}-\d{3,}$/;
/** A product prefix that agents often leave out (`WALKIE-SEATS-1` is also `SEATS-1`). */
const PRODUCT_PREFIXES = ["WALKIE-"];

/** The Linear key a card was imported under: the leading `[ALE-5156]` of its title, or null. */
export function linearKeyOf(title: string): string | null {
  const m = /^\s*\[([A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6})\]/.exec(title);
  return m ? (m[1] as string) : null;
}

/** The lane codes of a card's title, lower-case (the code itself, and without a product prefix), or []. */
export function laneCodes(title: string): string[] {
  const rest = title.replace(LEADING_BRACKETS, "");
  const token = (/^([^\s:,;()]+)/.exec(rest)?.[1] ?? "").replace(/[.\-]+$/, "");
  if (token.length < 4 || !CODE_RE.test(token) || !/\d/.test(token) || ISSUE_KEY_LIKE.test(token)) return [];
  const out = [token.toLowerCase()];
  for (const p of PRODUCT_PREFIXES) {
    if (!token.startsWith(p)) continue;
    const alias = token.slice(p.length);
    if (alias.length >= 4 && alias.includes("-") && /\d/.test(alias) && /[A-Z]{3}/.test(alias)) out.push(alias.toLowerCase());
  }
  return out;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Whether `code` (lower-case) appears in `text` as a whole token. */
export function mentionsCode(text: string, code: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escapeRe(code)}(?![a-z0-9])`).test(text.toLowerCase());
}

/** An index of a project's cards by key, short id and lane code. */
export interface CardIndex {
  readonly prefix: string;
  readonly byKey: ReadonlyMap<string, MatchCard>;
  readonly byShort: ReadonlyMap<string, MatchCard>;
  /** Longest code first. */
  readonly codes: ReadonlyArray<{ code: string; card: MatchCard }>;
}

export function indexCards(prefix: string, cards: readonly MatchCard[]): CardIndex {
  const codeOwners = new Map<string, MatchCard[]>();
  for (const c of cards) for (const code of laneCodes(c.title)) codeOwners.set(code, [...(codeOwners.get(code) ?? []), c]);
  // A code two cards share names neither (a duplicate pair is the duplicate rule's business, not a guess).
  const codes = [...codeOwners].filter(([, owners]) => owners.length === 1)
    .map(([code, owners]) => ({ code, card: owners[0] as MatchCard }))
    .sort((a, b) => b.code.length - a.code.length || (a.code < b.code ? -1 : 1));
  return {
    prefix: prefix.toUpperCase(),
    byKey: new Map(cards.map((c) => [c.key.toUpperCase(), c])),
    byShort: new Map(cards.map((c) => [c.short.toLowerCase(), c])),
    codes,
  };
}

/** The card a text names: a reference or key of this project first, else the card with the longest matching code. */
export function cardNamedIn(text: string | undefined, idx: CardIndex): MatchCard | null {
  if (!text) return null;
  const ref = new RegExp(`(?<![A-Za-z0-9])${escapeRe(idx.prefix)}-\\d{1,7}-([0-9a-fA-F]{8})(?![0-9a-fA-F])`, "i").exec(text);
  const byRef = ref ? idx.byShort.get((ref[1] as string).toLowerCase()) : undefined;
  if (byRef) return byRef;
  for (const k of keysIn(text)) {
    if (k.prefix !== idx.prefix) continue;
    const c = idx.byKey.get(k.key);
    if (c) return c;
  }
  const lower = text.toLowerCase();
  for (const { code, card } of idx.codes) if (mentionsCode(lower, code)) return card;
  return null;
}

// ---- what a comment says ------------------------------------------------------------------------------------------

/** An explicit "this is done" post: the comment starts with the word. */
const DONE_RE = /^\s*(?:status:\s*)?(?:done|shipped|merged|released|closed|completed?)\b/i;
const NOT_DONE_RE = /\bnot\s+(?:yet\s+)?(?:done|shipped|merged|released|complete)/i;
/** A review requested, or an audit placed or running. */
const REVIEW_RE = /(?:^\s*(?:review|audit|ready for review)\b|\bready for review\b|\breview(?:s)?\s+(?:requested|placed|running|started)\b|\brequest(?:ing|ed)?\s+(?:a\s+)?review\b|\baudits?\b[^.\n]{0,24}\b(?:running|placed|started|requested)\b)/i;
/** A builder / verdict failure the lane went back to work on. */
const FAIL_RE = /\b(?:FAIL(?:ED)?|REJECT(?:ED)?|fix round|requeued|re-queued)\b/;
const ERROR_RE = /\b(?:error|errors|failed|failure|exception|crash(?:ed)?|could not|couldn't|timed out)\b/i;

export type CommentSignal = "done" | "review" | "fail" | "error" | null;

/** What one comment says, for the steward's rules (the first that applies: done, fail, review, error). */
export function commentSignal(text: string): CommentSignal {
  if (DONE_RE.test(text) && !NOT_DONE_RE.test(text)) return "done";
  if (FAIL_RE.test(text)) return "fail";
  if (REVIEW_RE.test(text)) return "review";
  if (ERROR_RE.test(text)) return "error";
  return null;
}

/** An agent status that is an audit or a review, not a build ("Opus audit AGENT-ADMIN-1", "clerk9 verdict …"). */
export function isAuditText(text: string): boolean {
  return /\b(?:audit|auditor|audits|review|reviewer|verdict)\b/i.test(text);
}

/** At most `n` characters of one line of text, for a comment. */
export function excerpt(text: string, n: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
