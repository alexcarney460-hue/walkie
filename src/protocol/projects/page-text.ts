// PROJECT-PAGES-1: what a text of a status page's own (a fact, a screen's title, sentence, note and route) may not carry, in one
// place so the two ends agree. Where a text is written the daemon refuses it (page.ts); where it is read the same judgement
// is made again (`shownText`, `shownRoute`), so an event a modified peer signed without the checks is not shown as it came.
// Every judgement is made on the text as shown and on its bare letters (status-report.ts), so a disguise (an accent that
// composes with its letter, a fullwidth letter, a blank-looking filler) cannot keep a link, a join code or a secret out of it.
import { redactSecrets } from "../safety.ts";
import type { ScreenMetaT } from "./schema.ts";
import { containsLink, stripLinks } from "./page-story.ts";
import { bareLetters, carriesJoinCode, readable, scrubbed } from "./status-report.ts";

export interface TextProblems {
  /** An address in any spelling a person would click or paste. */
  link: boolean;
  /** A join code, plain or disguised. */
  join: boolean;
  /** The kinds of secret the detectors found (the random-looking-token guess is not one: a build id is not a secret). */
  secrets: string[];
}

/** What is wrong with a text, judged as shown and on its bare letters. */
export function problemsIn(t: string): TextProblems {
  const bare = bareLetters(t);
  const disguised = bare !== t;
  const found = new Set<string>();
  for (const text of disguised ? [t, bare] : [t]) for (const kind of redactSecrets(text).redactions) if (kind !== "high_entropy") found.add(kind);
  return { link: containsLink(t) || (disguised && containsLink(bare)), join: carriesJoinCode(t), secrets: [...found].sort() };
}

/**
 * A text of a page as it is read: untouched when nothing is wrong with it (what an honest writer wrote is never reworded), a
 * link taken out (its words stay) and a secret redacted when that is all it takes, and null (the whole text is withheld) for a
 * join code or when nothing readable is left.
 */
export function shownText(t: string): string | null {
  const p = problemsIn(t);
  if (p.join) return null;
  if (!p.link && p.secrets.length === 0) return t;
  const cleaned = scrubbed(readable(t), (x) => redactSecrets(stripLinks(x)).text).replace(/\s+/g, " ").trim();
  return cleaned && !carriesJoinCode(cleaned) ? cleaned : null;
}

/**
 * Whether a route is an address rather than the path of a page: `//host/path` and `#//host/path` are addresses, and so is
 * `/\host/path` (browsers read a backslash after the slash as a second slash); a backslash has no place in a path.
 */
export function isRouteAddress(route: string): boolean {
  return /^#?\/\//.test(route) || route.includes("\\");
}

/** A route is the path of a page, without a query string: what a page was filtered by goes in the screen's note. */
export function hasQuery(route: string): boolean {
  return route.includes("?");
}

/** The dashboard's own ids in a route (web/src/lib/route.ts): an event id (a board, card or thread), a project channel, a machine's node id. */
const EVENT_ID = /^[0-9a-f]{16}:\d{1,12}$/i;
const CHANNEL_ID = /^p-[0-9a-f]{8}$/i;
const NODE_ID = /^[0-9a-f]{16}$/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Random-looking: this share of adjacent letters and digits changes kind (lower, upper, digit). Words, slugs and dates sit near 0.2 (a long PascalCase name up to 0.35); a random token of mixed case near 0.7. */
const RANDOM_SHARE = 0.4;
/** The lower share that already counts when upper case, lower case and digits are all there. */
const MIXED_SHARE = 0.25;
const TOKEN_MIN = 16;

/** Whether one path segment looks like a token: a UUID, 32 hex characters or more, or a long run of letters and digits with no words in it. */
function segmentLooksLikeToken(raw: string): boolean {
  let seg = raw;
  try { seg = decodeURIComponent(raw); } catch { /* an escape that does not decode is read as written */ }
  if (EVENT_ID.test(seg) || CHANNEL_ID.test(seg) || NODE_ID.test(seg) || /^\d+$/.test(seg)) return false;
  if (UUID.test(seg) || /[0-9a-f]{32,}/i.test(seg)) return true;
  // Hyphens and underscores belong to slugs and to base64url alike, so they are left out and the letters and digits judged together.
  const bare = seg.replace(/[^A-Za-z0-9]/g, "");
  if (bare.length < TOKEN_MIN || /^[0-9a-f]+$/i.test(bare)) return false; // a shorter id is an id; hex below 32 digits is a record id (a Mongo id), not a secret
  const kind = (c: string) => (/[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : 2);
  let changes = 0;
  for (let i = 1; i < bare.length; i++) if (kind(bare[i] as string) !== kind(bare[i - 1] as string)) changes++;
  const share = changes / (bare.length - 1);
  if (share >= RANDOM_SHARE) return true;
  // Upper, lower and digits all at once, changing kind this often, is a token's mix; a PascalCase name has no digits among its capitals.
  if (share >= MIXED_SHARE && /[A-Z]/.test(bare) && /[a-z]/.test(bare) && /\d/.test(bare)) return true;
  // Lowercase and digits alone (base 36) change kind less often than mixed case does, but digits sit between letters again and again;
  // in a slug they come in one block (a date, "q4", "v2").
  return bare.length >= 20 && !/[A-Z]/.test(bare) && (bare.match(/[a-z]\d+(?=[a-z])/g) ?? []).length >= 3;
}

/**
 * Whether a route's path carries what looks like a one-time token (an invitation, a password reset, a session): routes are signed
 * into the log for good, an invite-acceptance page is exactly what an agent captures, and the secret detectors rate such a token no
 * better than a build id. Judged for routes alone: a fact or a note may hold a build id. Best effort, like the other checks; a UUID
 * is refused too (use `/loads/:id` for a page that has one).
 */
export function routeCarriesToken(route: string): boolean {
  return route.split("/").some((segment) => segment.length >= TOKEN_MIN - 4 && segmentLooksLikeToken(segment));
}

/**
 * A screen's route as it is read: the path as written, or undefined when it is an address or carries a link, a join code or a secret.
 * A query string is never shown (writers are refused one; a screen signed with one shows its path alone), because the detectors do
 * not know every kind of token that rides in a query (an OAuth code, a session id); nor is a path with a token in it.
 */
export function shownRoute(route: string): string | undefined {
  if (isRouteAddress(route)) return undefined;
  const path = route.replace(/\?.*$/s, "");
  if (!path || routeCarriesToken(path)) return undefined;
  const p = problemsIn(path);
  return p.link || p.join || p.secrets.length > 0 ? undefined : path;
}

/**
 * A screen's details as they are shown: each text read through the same checks it was written through, so an event a modified peer
 * signed without them shows a link without the link and a secret redacted, drops a note or a route that cannot be cleaned, and
 * withholds the whole screen (null) when its title, group or sentence carries a join code. Honest details are untouched.
 */
export function shownScreen(meta: ScreenMetaT): ScreenMetaT | null {
  const title = shownText(meta.title);
  const group = shownText(meta.group);
  const about = shownText(meta.about);
  if (!title || !group || !about) return null;
  const note = meta.note === undefined ? null : shownText(meta.note);
  const route = meta.route === undefined ? undefined : shownRoute(meta.route);
  const { note: _note, route: _route, ...rest } = meta;
  return { ...rest, title, group, about, ...(note ? { note } : {}), ...(route ? { route } : {}) };
}
