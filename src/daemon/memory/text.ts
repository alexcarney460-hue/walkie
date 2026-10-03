// Personal memory text, checked at the write boundary. Length is judged on the raw string before anything is
// shortened. A join code is refused (not stored, not stripped). Secrets are redacted, including ones split by
// invisible characters or a lone surrogate. Team and org scopes are not accepted here.
import { bareLetters, carriesJoinCode, readable, respellWeeks, scrubbed } from "../../protocol/projects/status-report.ts";
import { redactSecrets } from "../../protocol/safety.ts";

export const MEMORY_KINDS = ["fact", "preference", "decision", "procedure", "contact", "warning"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_TEXT_MAX = 2000;
export const MEMORY_SOURCE_MAX = 200;
export const MEMORY_SOURCES_MAX = 8;
export const MEMORY_QUERY_MAX = 200;
export const MEMORY_LIST_DEFAULT = 50;
export const MEMORY_LIST_MAX = 100;
/** Active (not retracted) rows in one memory.db. A retracted row stays and does not count. */
export const MEMORY_ROWS_MAX = 5000;
/** Active note text plus the stored JSON of its sources, in UTF-8 bytes. A retracted row does not count.
 *  An unpaired surrogate is replaced with U+FFFD before this is measured, so the count matches the file. */
export const MEMORY_BYTES_MAX = 16 * 1024 * 1024;
export const MEMORY_FULL_MESSAGE = `personal memory is full (${MEMORY_ROWS_MAX} active notes or 16 MiB of their text). Retract old notes with walkie memory retract and try again`;

const ACTOR = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const MARKER = /^\[REDACTED:[a-z0-9_]+\]$/;

export class MemoryError extends Error {
  constructor(readonly code: "invalid" | "join_code" | "not_found" | "too_long" | "full", message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

export function isMemoryKind(v: string): v is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(v);
}

/** Replace unpaired surrogates with U+FFFD. SQLite stores those as 3 UTF-8 bytes; counting the surrogate undercounts, and a later read can drop it. */
function wellFormed(text: string): string {
  return (text as unknown as { toWellFormed(): string }).toWellFormed();
}

/** Join check used for memory: weeks are respelled first, so "wk1" followed by words is not a code. The spelling is not what gets stored. */
function memoryHasJoinCode(text: string): boolean {
  const shown = readable(text);
  if (carriesJoinCode(respellWeeks(shown))) return true;
  const bare = bareLetters(shown);
  return bare !== shown && carriesJoinCode(respellWeeks(bare));
}

function dedupe(xs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function redactionKinds(shown: string): string[] {
  const found = [...redactSecrets(shown).redactions];
  const bare = bareLetters(shown);
  if (bare !== shown) found.push(...redactSecrets(bare).redactions);
  return dedupe(found);
}

function onlyMarkers(text: string): boolean {
  const parts = text.split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => MARKER.test(p));
}

export function prepareMemoryText(raw: string): { text: string; redactions: string[] } {
  if (typeof raw !== "string") throw new MemoryError("invalid", "personal memory text must be a string");
  if (raw.length > MEMORY_TEXT_MAX) throw new MemoryError("too_long", `personal memory text is at most ${MEMORY_TEXT_MAX} characters`);
  const shown = readable(raw.replace(/\r\n?/g, "\n")).trim();
  if (!shown) throw new MemoryError("invalid", "personal memory text is empty");
  if (shown.length > MEMORY_TEXT_MAX) throw new MemoryError("too_long", `personal memory text is at most ${MEMORY_TEXT_MAX} characters`);
  if (memoryHasJoinCode(shown)) throw new MemoryError("join_code", "personal memory refuses join codes");
  const redactions = redactionKinds(shown);
  const text = scrubbed(shown, (t) => redactSecrets(t).text).trim();
  if (!text) throw new MemoryError("invalid", "personal memory text is empty");
  if (text.length > MEMORY_TEXT_MAX) throw new MemoryError("too_long", `personal memory text is at most ${MEMORY_TEXT_MAX} characters`);
  if (memoryHasJoinCode(text)) throw new MemoryError("join_code", "personal memory refuses join codes");
  return { text, redactions };
}

/** A source the redactor reduced to only markers is dropped. A join code refuses the whole write. */
export function prepareSource(raw: string): { text: string | null; redactions: string[] } {
  if (typeof raw !== "string") throw new MemoryError("invalid", "a source must be text");
  if (raw.length > MEMORY_SOURCE_MAX) throw new MemoryError("invalid", `a source is at most ${MEMORY_SOURCE_MAX} characters`);
  const shown = readable(raw).replace(/\s+/g, " ").trim();
  if (!shown) throw new MemoryError("invalid", "a source is empty");
  if (shown.length > MEMORY_SOURCE_MAX) throw new MemoryError("invalid", `a source is at most ${MEMORY_SOURCE_MAX} characters`);
  if (memoryHasJoinCode(shown)) throw new MemoryError("join_code", "personal memory refuses join codes");
  const redactions = redactionKinds(shown);
  const text = scrubbed(shown, (t) => redactSecrets(t).text).trim();
  if (memoryHasJoinCode(text)) throw new MemoryError("join_code", "personal memory refuses join codes");
  if (!text || onlyMarkers(text)) return { text: null, redactions };
  if (text.length > MEMORY_SOURCE_MAX) throw new MemoryError("invalid", `a source is at most ${MEMORY_SOURCE_MAX} characters`);
  return { text, redactions };
}

export interface PreparedMemory {
  kind: MemoryKind;
  text: string;
  sources: string[];
  redactions: string[];
  actor: string;
}

export function prepareMemory(input: { kind?: string; text: string; sources?: readonly string[]; actor: string }): PreparedMemory {
  const kind = input.kind ?? "fact";
  if (!isMemoryKind(kind)) throw new MemoryError("invalid", `kind must be ${MEMORY_KINDS.join("|")}`);
  if (!ACTOR.test(input.actor)) throw new MemoryError("invalid", "actor is not a valid name");
  const sourcesIn = input.sources ?? [];
  if (sourcesIn.length > MEMORY_SOURCES_MAX) throw new MemoryError("invalid", `at most ${MEMORY_SOURCES_MAX} sources`);
  const body = prepareMemoryText(input.text);
  const sources: string[] = [];
  const seen = new Set<string>();
  const redactions = [...body.redactions];
  for (const raw of sourcesIn) {
    const one = prepareSource(raw);
    redactions.push(...one.redactions);
    if (one.text === null || seen.has(one.text)) continue;
    seen.add(one.text);
    sources.push(one.text);
  }
  // After redaction and the join-code check. U+FFFD is not stripped by those checks, so replacing a lone
  // surrogate earlier would store a secret or a join code that was split by one.
  // Two sources that differ only in a lone surrogate are the same once it is replaced: kept once (WALK-71 review LOW-1).
  return { kind, text: wellFormed(body.text), sources: dedupe(sources.map((s) => wellFormed(s))), redactions: dedupe(redactions), actor: input.actor };
}
