// Read-only view of audits this machine already stored (WALK-70 phase 0). No new rows, no other machine.
import { redactSecrets } from "../protocol/safety.ts";

/** Newest matches returned when the caller does not pass `limit`. Covers the guest registry cap plus the admin tail. */
export const HISTORY_MAX_LIMIT = 10_000;
/** What a response is allowed to claim it read. The rotated admin file is not opened. */
export const HISTORY_COVERAGE = "this-machine; admin-audit.jsonl tail (not the rotated file); guest registry";

/** Free text longer than this, in UTF-8 bytes, is replaced rather than redacted. */
const TEXT_MAX = 8 * 1024;
const CUT = 600;
const OMITTED = "[omitted: too long]";
const SINCE = "since must be epoch milliseconds, YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SSZ with an optional offset";
const TOOL = "tool must be 1 to 64 visible ASCII characters";
const QUERY = "q must be 1 to 200 characters without control characters";
const LIMIT = `limit must be an integer from 1 to ${HISTORY_MAX_LIMIT}`;

const KIND = /^[a-z0-9_]{1,32}$/;
const GUEST_ID = /^[0-9a-f]{16}\/[a-z0-9][a-z0-9._-]{0,40}$/;
const OBJECT_ID = /^[0-9a-f]{16}:[1-9][0-9]{0,15}$/;
const CALLER = /^(?:[0-9a-f]{16}|unknown|overflow)$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TOOL_RE = /^[\x21-\x7e]{1,64}$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/;

export class HistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryQueryError";
  }
}

export interface HistoryQuery {
  since?: number;
  tool?: string;
  q?: string;
  limit?: number;
}

export type GuestOmitReason = "person_only" | "no_team" | "unavailable";

export interface HistoryEntry {
  ts: number;
  source: "admin" | "guest";
  summary: string;
  actor?: string;
  action?: string;
  machine?: string;
  via?: "local" | "remote";
  refused?: string;
  kind?: string;
  guest?: string;
  tool?: string;
  object?: string;
  event?: string;
  digest?: string;
  /** Guest audit's hashed tunnel subject (stored as `source` on the guest row). */
  caller?: string;
  status?: number;
  count?: number;
}

export interface HistoryView {
  entries: HistoryEntry[];
  omitted: { source: "guest"; reason: GuestOmitReason }[];
  truncated: boolean;
  coverage: string;
}

export function parseHistoryQuery(raw: { since?: string; tool?: string; q?: string; limit?: string }): HistoryQuery {
  const query: HistoryQuery = {};
  if (raw.since !== undefined) query.since = parseSince(raw.since);
  if (raw.tool !== undefined) {
    if (!TOOL_RE.test(raw.tool)) throw new HistoryQueryError(TOOL);
    query.tool = raw.tool;
  }
  if (raw.q !== undefined) {
    if (raw.q.length < 1 || raw.q.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(raw.q)) throw new HistoryQueryError(QUERY);
    query.q = raw.q;
  }
  if (raw.limit !== undefined) {
    if (!/^[0-9]+$/.test(raw.limit)) throw new HistoryQueryError(LIMIT);
    const n = Number(raw.limit);
    if (!Number.isSafeInteger(n) || n < 1 || n > HISTORY_MAX_LIMIT) throw new HistoryQueryError(LIMIT);
    query.limit = n;
  }
  return query;
}

export function historyPath(query: HistoryQuery): string {
  const params = new URLSearchParams();
  if (query.since !== undefined) params.set("since", String(query.since));
  if (query.tool !== undefined) params.set("tool", query.tool);
  if (query.q !== undefined) params.set("q", query.q);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const text = params.toString();
  return text ? `/v1/history?${text}` : "/v1/history";
}

/**
 * `admin` is in `readAudit` order (newest line first). `guest` is in `GuestRegistry.audit()` order (oldest append
 * first). Equal timestamps keep that source's own order, and an admin row precedes a guest row.
 * A guest array is ignored when `omitGuest` is set, so a caller who must not see it cannot leak it by passing both.
 */
export function mergeHistory(input: {
  admin: readonly unknown[];
  guest: readonly unknown[] | null;
  omitGuest?: GuestOmitReason;
  query?: HistoryQuery;
}): HistoryView {
  const limit = input.query?.limit ?? HISTORY_MAX_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT) throw new HistoryQueryError(LIMIT);
  const drafts: { ts: number; rank: number; seq: number; entry: HistoryEntry }[] = [];
  input.admin.forEach((row, index) => {
    const entry = adminEntry(row);
    if (entry) drafts.push({ ts: entry.ts, rank: 0, seq: input.admin.length - 1 - index, entry });
  });
  const guestRows = input.omitGuest ? [] : input.guest ?? [];
  guestRows.forEach((row, index) => {
    const entry = guestEntry(row);
    if (entry) drafts.push({ ts: entry.ts, rank: 1, seq: index, entry });
  });
  drafts.sort((a, b) => a.ts - b.ts || a.rank - b.rank || a.seq - b.seq);
  const since = input.query?.since;
  const tool = input.query?.tool;
  const q = input.query?.q?.toLowerCase();
  const matched = drafts.filter(({ entry }) => {
    if (since !== undefined && entry.ts < since) return false;
    if (tool !== undefined && entry.tool !== tool) return false;
    if (q !== undefined && !haystack(entry).includes(q)) return false;
    return true;
  }).map((d) => d.entry);
  const truncated = matched.length > limit;
  return {
    entries: truncated ? matched.slice(matched.length - limit) : matched,
    omitted: input.omitGuest ? [{ source: "guest", reason: input.omitGuest }] : [],
    truncated,
    coverage: HISTORY_COVERAGE,
  };
}

function parseSince(raw: string): number {
  if (/^[0-9]{1,16}$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new HistoryQueryError(SINCE);
    return n;
  }
  const m = ISO.exec(raw);
  if (!m) throw new HistoryQueryError(SINCE);
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (hour > 23 || minute > 59 || second > 59) throw new HistoryQueryError(SINCE);
  const wall = new Date(Date.UTC(year, month - 1, day));
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) throw new HistoryQueryError(SINCE);
  if (m[4] === undefined) return wall.getTime();
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new HistoryQueryError(SINCE);
  return parsed;
}

/**
 * At most 599 UTF-16 units, then an ellipsis. If that unit is a high surrogate, drop it too:
 * `slice` would keep `\uD83D` and lose the emoji's pair, and a strict JSON parser rejects that.
 */
function cut(text: string): string {
  if (text.length <= CUT) return text;
  let end = CUT - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Redact the whole value, then cut. A value too long to redact whole is replaced, not shortened. */
function freeText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // Characters would let a multibyte string past 8 KiB through (你 is 3 bytes and 1 character).
  if (Buffer.byteLength(value, "utf8") > TEXT_MAX) return OMITTED;
  const redacted = redactSecrets(value).text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  if (!redacted) return undefined;
  return cut(redacted);
}

function stamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** JSON `null`, arrays, numbers and strings are not rows. Reading `.ts` on null throws. */
function isPlainRow(row: unknown): row is Record<string, unknown> {
  return !!row && typeof row === "object" && !Array.isArray(row);
}

function adminEntry(row: unknown): HistoryEntry | null {
  if (!isPlainRow(row)) return null;
  const ts = stamp(row.ts);
  const actor = freeText(row.actor);
  const action = freeText(row.action);
  const machine = freeText(row.machine);
  const via = row.via === "local" || row.via === "remote" ? row.via : undefined;
  if (ts === undefined || actor === undefined || action === undefined || machine === undefined || via === undefined) return null;
  const refused = freeText(row.refused);
  const summary = cut(`${actor}${via === "remote" ? " (remote)" : ""} on ${machine}: ${action}${refused ? ` [refused: ${refused}]` : ""}`);
  return { ts, source: "admin", summary, actor, action, machine, via, ...(refused ? { refused } : {}) };
}

function exact(value: unknown, re: RegExp): string | undefined {
  return typeof value === "string" && re.test(value) ? value : undefined;
}

function guestEntry(row: unknown): HistoryEntry | null {
  if (!isPlainRow(row)) return null;
  const ts = stamp(row.at);
  const kind = exact(row.kind, KIND);
  if (ts === undefined || kind === undefined) return null;
  const toolRaw = exact(row.tool, TOOL_RE);
  const tool = toolRaw === undefined ? undefined : freeText(toolRaw);
  const guest = exact(row.guest, GUEST_ID);
  const object = exact(row.object, OBJECT_ID);
  const event = exact(row.event, OBJECT_ID);
  const digest = exact(row.digest, DIGEST);
  const caller = exact(row.source, CALLER);
  const status = typeof row.status === "number" && Number.isSafeInteger(row.status) && row.status >= 0 && row.status <= 599 ? row.status : undefined;
  const count = typeof row.count === "number" && Number.isSafeInteger(row.count) && row.count >= 0 && row.count <= 1_000_000_000 ? row.count : undefined;
  const summary = cut([kind, tool, guest, object].filter((part) => part !== undefined).join(" "));
  return {
    ts, source: "guest", summary, kind,
    ...(tool ? { tool } : {}), ...(guest ? { guest } : {}), ...(object ? { object } : {}), ...(event ? { event } : {}),
    ...(digest ? { digest } : {}), ...(caller ? { caller } : {}),
    ...(status !== undefined ? { status } : {}), ...(count !== undefined ? { count } : {}),
  };
}

function haystack(entry: HistoryEntry): string {
  return [entry.summary, entry.actor, entry.action, entry.machine, entry.via, entry.refused, entry.kind, entry.guest, entry.tool, entry.object, entry.event, entry.digest, entry.caller]
    .filter((part): part is string => typeof part === "string").join("\n").toLowerCase();
}
