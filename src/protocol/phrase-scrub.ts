// One normalised matcher for a set of private phrases. The matcher is cached by a hash of the phrase set (eight at a
// time) and reused for the same set, instead of compiling a regular expression per phrase. The caller builds the
// phrase list itself for each recommendation.
//
// A phrase and the text are normalised the same way: Unicode NFKC, combining marks and format characters dropped,
// common Cyrillic and Greek look-alike letters mapped to Latin, then lower case. A run of punctuation, underscores
// or whitespace is one gap. The phrase matches as a whole run of those tokens, and, when it has more than one token,
// also as those tokens joined ("Northwind Vault" matches "NorthwindVault"). A fragment inside a longer token is left
// ("seeding", "keys2"). The matcher is a token trie: each step is one normalised token, and a match is a path that
// ends on a phrase.

/** Cyrillic and Greek letters that look like Latin ones. The value is already lower case. */
const LOOKALIKE = new Map<number, string>([
  [0x0410, "a"], [0x0430, "a"], [0x0412, "b"], [0x0415, "e"], [0x0435, "e"],
  [0x041a, "k"], [0x043a, "k"], [0x041c, "m"], [0x043c, "m"], [0x041d, "h"], [0x043d, "h"],
  [0x041e, "o"], [0x043e, "o"], [0x0420, "p"], [0x0440, "p"], [0x0421, "c"], [0x0441, "c"],
  [0x0422, "t"], [0x0442, "t"], [0x0423, "y"], [0x0443, "y"], [0x0425, "x"], [0x0445, "x"],
  [0x0405, "s"], [0x0455, "s"], [0x0406, "i"], [0x0456, "i"], [0x0408, "j"], [0x0458, "j"],
  [0x04ae, "y"], [0x04af, "y"],
  [0x0391, "a"], [0x03b1, "a"], [0x0392, "b"], [0x03b2, "b"], [0x0395, "e"], [0x03b5, "e"],
  [0x0396, "z"], [0x03b6, "z"], [0x0397, "h"], [0x03b7, "h"], [0x0399, "i"], [0x03b9, "i"],
  [0x039a, "k"], [0x03ba, "k"], [0x039c, "m"], [0x03bc, "m"], [0x039d, "n"], [0x03bd, "v"],
  [0x039f, "o"], [0x03bf, "o"], [0x03a1, "p"], [0x03c1, "p"], [0x03a4, "t"], [0x03c4, "t"],
  [0x03a5, "y"], [0x03c5, "y"], [0x03a7, "x"], [0x03c7, "x"],
]);

function latinWord(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

/** What one original code point contributes. Empty: a mark or a format character, which does not split a token. */
function normalizeCodePoint(cp: number): string {
  if (cp < 128) return cp >= 65 && cp <= 90 ? String.fromCharCode(cp + 32) : String.fromCharCode(cp);
  const direct = LOOKALIKE.get(cp);
  if (direct) return direct;
  const s = String.fromCodePoint(cp).normalize("NFKC").normalize("NFD").replace(/\p{M}|\p{Cf}/gu, "");
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 65 && c <= 90) out += String.fromCharCode(c + 32);
    else if (c > 127) out += LOOKALIKE.get(c) ?? ch.toLowerCase();
    else out += ch;
  }
  return out;
}

function isWordPiece(piece: string): boolean {
  for (const ch of piece) {
    const c = ch.codePointAt(0)!;
    if (c < 128) { if (!latinWord(c)) return false; }
    else if (!/\p{L}|\p{N}/u.test(ch)) return false;
  }
  return piece.length > 0;
}

interface Tok { text: string; start: number; end: number }

/** ASCII word slices, or null when a non-ASCII code unit needs the Unicode normaliser. Spans are for the text being scrubbed. */
function asciiToks(text: string): Tok[] | null {
  const out: Tok[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    let c = text.charCodeAt(i);
    if (c > 127) return null;
    if (!latinWord(c)) { i++; continue; }
    const start = i++;
    let upper = c >= 65 && c <= 90;
    while (i < n) {
      c = text.charCodeAt(i);
      if (c > 127) return null;
      if (!latinWord(c)) break;
      if (c >= 65 && c <= 90) upper = true;
      i++;
    }
    const slice = text.slice(start, i);
    out.push({ text: upper ? slice.toLowerCase() : slice, start, end: i });
  }
  return out;
}

/** The same words, without spans. Building the trie does not need the phrase's original indexes. */
function asciiParts(text: string): string[] | null {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    let c = text.charCodeAt(i);
    if (c > 127) return null;
    if (!latinWord(c)) { i++; continue; }
    const start = i++;
    let upper = c >= 65 && c <= 90;
    while (i < n) {
      c = text.charCodeAt(i);
      if (c > 127) return null;
      if (!latinWord(c)) break;
      if (c >= 65 && c <= 90) upper = true;
      i++;
    }
    const slice = text.slice(start, i);
    out.push(upper ? slice.toLowerCase() : slice);
  }
  return out;
}

function unicodeToks(text: string): Tok[] {
  const out: Tok[] = [];
  const n = text.length;
  let i = 0;
  let buf = "";
  let start = -1;
  let end = -1;
  const flush = (): void => {
    if (!buf) return;
    out.push({ text: buf, start, end });
    buf = "";
    start = -1;
  };
  while (i < n) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const piece = normalizeCodePoint(cp);
    if (piece.length === 0) {
      if (start >= 0) end = i + len;
    } else if (isWordPiece(piece)) {
      if (start < 0) start = i;
      buf += piece;
      end = i + len;
    } else flush();
    i += len;
  }
  flush();
  return out;
}

function tokens(text: string): Tok[] {
  return asciiToks(text) ?? unicodeToks(text);
}

function partsOf(text: string): string[] {
  const ascii = asciiParts(text);
  if (ascii) return ascii;
  const toks = unicodeToks(text);
  const parts = new Array<string>(toks.length);
  for (let i = 0; i < toks.length; i++) parts[i] = toks[i]!.text;
  return parts;
}

interface Node { next: Map<string, Node> | null; term: boolean }

function add(root: Node, parts: readonly string[]): void {
  let cur = root;
  for (const part of parts) {
    let next = cur.next?.get(part);
    if (!next) {
      next = { next: null, term: false };
      if (cur.next === null) cur.next = new Map();
      cur.next.set(part, next);
    }
    cur = next;
  }
  cur.term = true;
}

interface Matcher { root: Node }

function compile(phrases: readonly string[]): Matcher {
  const root: Node = { next: null, term: false };
  for (const raw of phrases) {
    const phrase = raw.trim();
    if (!phrase) continue;
    const parts = partsOf(phrase);
    if (parts.length === 0) continue;
    add(root, parts);
    if (parts.length > 1) add(root, [parts.join("")]);
  }
  return { root };
}

function find(matcher: Matcher, text: string): Array<{ start: number; end: number }> {
  const root = matcher.root;
  if (root.next === null) return [];
  const toks = tokens(text);
  const hits: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < toks.length; i++) {
    let cur: Node | undefined = root;
    let best = -1;
    for (let j = i; j < toks.length; j++) {
      cur = cur.next?.get(toks[j]!.text);
      if (!cur) break;
      if (cur.term) best = j;
    }
    if (best >= 0) hits.push({ start: toks[i]!.start, end: toks[best]!.end });
  }
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const taken: Array<{ start: number; end: number }> = [];
  let until = -1;
  for (const hit of hits) {
    if (hit.start < until) continue;
    taken.push(hit);
    until = hit.end;
  }
  return taken;
}

function tidy(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}

const cache = new Map<string, Matcher>();
const MAX_CACHE = 8;

/** Order-independent identity of the phrase set. Eight matchers are kept. */
function cacheKey(phrases: readonly string[]): string {
  let sum = 0n;
  let xor = 0n;
  let n = 0;
  let chars = 0;
  for (const phrase of phrases) {
    if (phrase.length === 0) continue;
    const h = Bun.hash(phrase);
    const b = typeof h === "bigint" ? h : BigInt(h);
    sum += b;
    xor ^= b;
    n++;
    chars += phrase.length;
  }
  return n === 0 ? "" : `${n}:${chars}:${sum}:${xor}`;
}

/** Removes every phrase that stands as a whole normalised phrase. The same phrase set reuses one matcher. */
export function scrubPhrases(text: string, phrases: readonly string[]): string {
  if (phrases.length === 0) return tidy(text);
  const key = cacheKey(phrases);
  if (!key) return tidy(text);
  let matcher = cache.get(key);
  if (!matcher) {
    matcher = compile(phrases);
    cache.set(key, matcher);
    if (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  } else {
    cache.delete(key);
    cache.set(key, matcher);
  }
  const spans = find(matcher, text);
  if (spans.length === 0) return tidy(text);
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) out = out.slice(0, spans[i]!.start) + out.slice(spans[i]!.end);
  return tidy(out);
}
