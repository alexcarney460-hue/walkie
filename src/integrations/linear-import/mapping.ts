// Linear → Walkie mapping (pure): columns by state type, labels, assignees, card bodies cut to the board-op cap, the
// history digest, prefixes, title similarity and durations. Everything here is deterministic.
import { DEFAULT_COLUMNS, MAX_BOARD_OP_BYTES, MAX_LABELS, type Column, type ColumnRole } from "../../protocol/projects/schema.ts";
import type { LIssue, LState } from "./schemas.ts";

/** The board an imported project gets: the default columns plus Canceled (cancelled role: outside the meter). */
export const IMPORT_COLUMNS: readonly Column[] = [...DEFAULT_COLUMNS, { id: "canceled", name: "Canceled", role: "cancelled" }];

/** Where an issue goes: the column (by id on IMPORT_COLUMNS) and whether the card is archived. */
export interface Place { column: string; role: ColumnRole; archived: boolean }

const REVIEW_RE = /review/i;

/** Column by Linear state type (and "…review…"-named started states). */
export function placeOf(state: { type: string; name: string }): Place {
  switch (state.type) {
    case "backlog": return { column: "backlog", role: "backlog", archived: false };
    case "triage": case "unstarted": return { column: "todo", role: "todo", archived: false };
    case "started": return REVIEW_RE.test(state.name) ? { column: "review", role: "review", archived: false } : { column: "doing", role: "active", archived: false };
    case "completed": return { column: "done", role: "done", archived: false };
    case "canceled": case "duplicate": return { column: "canceled", role: "cancelled", archived: true };
    default: return { column: "todo", role: "todo", archived: false };
  }
}

/**
 * The Linear workflow state for a Walkie column role (two-way sync), among the team's states: backlog → backlog,
 * todo → unstarted, active → a started state not named "…review…", review → a started state named "…review…" (else
 * the first started), done → completed, cancelled → canceled. First by position; null when the team has none.
 */
export function stateForRole(role: ColumnRole, states: readonly LState[]): LState | null {
  const byPos = [...states].sort((a, b) => a.position - b.position);
  const of = (type: string) => byPos.filter((s) => s.type === type);
  switch (role) {
    case "backlog": return of("backlog")[0] ?? of("unstarted")[0] ?? null;
    case "todo": return of("unstarted")[0] ?? null;
    case "active": return of("started").find((s) => !REVIEW_RE.test(s.name)) ?? of("started")[0] ?? null;
    case "review": return of("started").find((s) => REVIEW_RE.test(s.name)) ?? of("started")[0] ?? null;
    case "done": return of("completed")[0] ?? null;
    case "cancelled": return of("canceled")[0] ?? null;
  }
}

const LABEL_MAX = 32;
function cleanLabel(s: string): string {
  return s.replace(/[\n\r\t]+/g, " ").trim().slice(0, LABEL_MAX).trim();
}

/** Linear labels (≤ 10 with ours), `linear`, and `urgent` / `high` for priority 1 / 2. */
export function labelsOf(issue: Pick<LIssue, "labels" | "priority">): string[] {
  const ours = ["linear", ...(issue.priority === 1 ? ["urgent"] : issue.priority === 2 ? ["high"] : [])];
  const theirs = (issue.labels?.nodes ?? []).map((l) => cleanLabel(l.name)).filter(Boolean);
  const out: string[] = [];
  for (const l of [...theirs.slice(0, MAX_LABELS - ours.length), ...ours]) if (!out.includes(l)) out.push(l);
  return out.slice(0, MAX_LABELS);
}

export function estimateOf(e: number | null | undefined): number | null {
  return typeof e === "number" && Number.isFinite(e) ? Math.max(0, Math.min(1_000, Math.round(e))) : null;
}
export function dueOf(d: string | null | undefined): string | null {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d.slice(0, 10)) ? d.slice(0, 10) : null;
}

/** `[ALE-12] Title`, at most 200 characters (how imported cards are found by their Linear key). */
export function titleOf(issue: Pick<LIssue, "identifier" | "title">): string {
  const t = `[${issue.identifier}] ${issue.title.replace(/\s+/g, " ").trim()}`;
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

// ---- people -----------------------------------------------------------------------------------------------------

export interface Member { handle: string; login: string; display_name?: string }

/** `--map-users @morgan=Morgan Example,@kira=kira@example.test` → Linear name / display name / email (lowercase) → handle. */
export function parseMapUsers(s: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (s ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^@?([A-Za-z0-9][A-Za-z0-9_.-]{0,39})\s*=\s*(.{1,200})$/.exec(part);
    if (!m) throw new Error(`--map-users entry "${part.slice(0, 60)}" is not @handle=Linear name or email`);
    out.set((m[2] as string).trim().toLowerCase(), m[1] as string);
  }
  return out;
}

/**
 * The member a Linear user is: an explicit mapping (name, display name or email), else the member whose login is the
 * user's email, else whose handle or display name equals the user's name, display name or first name. Null: unmapped.
 */
export function memberFor(user: { name?: string | null; displayName?: string | null; email?: string | null } | null | undefined, members: readonly Member[], explicit: ReadonlyMap<string, string>): string | null {
  if (!user) return null;
  const keys = [user.email, user.name, user.displayName].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  for (const k of keys) {
    const h = explicit.get(k);
    if (h && members.some((m) => m.handle === h)) return h;
  }
  const email = user.email?.toLowerCase();
  const byLogin = email ? members.find((m) => m.login.toLowerCase() === email) : undefined;
  if (byLogin) return byLogin.handle;
  const names = [user.name, user.displayName, user.name?.split(/\s+/)[0]].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const byName = members.filter((m) => names.includes(m.handle.toLowerCase()) || (!!m.display_name && names.includes(m.display_name.toLowerCase())));
  return byName.length === 1 ? (byName[0] as Member).handle : null;
}

// ---- text -------------------------------------------------------------------------------------------------------

const enc = new TextEncoder();
export function bytes(s: string): number { return enc.encode(s).length; }
/** JSON-encoded size of a string value (quotes, escapes and UTF-8 included). */
function jsonBytes(s: string): number { return bytes(JSON.stringify(s)); }

/**
 * Room for a card body inside one board op: MAX_BOARD_OP_BYTES minus the rest of the op (title, labels, ext, the
 * fields the daemon adds: board id, column, pos, key number) and the post's readable text (`New card KEY: title`).
 */
export function bodyBudget(title: string, labels: readonly string[], extBytes: number): number {
  const fixed = 400 + jsonBytes(title) * 2 + labels.reduce((n, l) => n + jsonBytes(l) + 1, 0) + extBytes;
  return MAX_BOARD_OP_BYTES - fixed;
}

/** Cuts `text` so its JSON encoding is at most `max` bytes, at a character boundary. */
export function cutJson(text: string, max: number): string {
  if (jsonBytes(text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes(text.slice(0, mid)) <= max) lo = mid; else hi = mid - 1;
  }
  let out = text.slice(0, lo);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1); // never half a surrogate pair
  return out;
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

/**
 * The card body: identifier, link, state, priority, the Linear assignee when no member matches, the parent (its Walkie
 * reference once imported), creator and date, then the description. Cut by bytes to the board-op cap with a pointer
 * back to Linear.
 */
export function bodyOf(issue: LIssue, o: { unmappedAssignee: string | null; parentRef: string | null; budget: number }): string {
  const head = [
    `Linear ${issue.identifier} · ${issue.url}`,
    `State in Linear: ${issue.state.name}${issue.priority ? ` · priority ${["", "urgent", "high", "medium", "low"][issue.priority] ?? issue.priority}` : ""}`,
    ...(o.unmappedAssignee ? [`Assignee in Linear: ${o.unmappedAssignee}`] : []),
    ...(issue.parent ? [`Parent: ${issue.parent.identifier}${o.parentRef ? ` (${o.parentRef})` : ""}`] : []),
    `Created ${day(issue.createdAt)}${issue.creator?.name ? ` by ${issue.creator.name}` : ""}`,
  ].join("\n");
  const desc = (issue.description ?? "").trim();
  const full = desc ? `${head}\n\n${desc}` : head;
  if (jsonBytes(full) <= o.budget && full.length <= 16_000) return full;
  const tail = `\n\n[cut: the full description is in Linear: ${issue.url}]`;
  const room = Math.max(0, o.budget - jsonBytes(tail));
  return (cutJson(full, room).slice(0, 16_000 - tail.length) + tail).slice(0, 16_000);
}

/** The history (state and assignee changes) and comments as one comment text, at most `max` characters; null if empty. */
export function digestOf(issue: LIssue, max = 12_000): string | null {
  const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
  const lines: string[] = [];
  for (const h of [...(issue.history?.nodes ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const who = h.actor?.name ?? "someone";
    if (h.fromState?.name || h.toState?.name) lines.push(`${when(h.createdAt)} ${who}: ${h.fromState?.name ?? "–"} → ${h.toState?.name ?? "–"}`);
    else if (h.fromAssignee?.name || h.toAssignee?.name) lines.push(`${when(h.createdAt)} ${who}: assignee ${h.fromAssignee?.name ?? "none"} → ${h.toAssignee?.name ?? "none"}`);
  }
  if (issue.completedAt) lines.push(`${when(issue.completedAt)} completed`);
  if (issue.canceledAt) lines.push(`${when(issue.canceledAt)} canceled`);
  const comments = [...(issue.comments?.nodes ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => `— ${c.user?.name ?? "someone"}, ${when(c.createdAt)}:\n${c.body.trim()}`);
  if (!lines.length && !comments.length) return null;
  const text = [`From Linear ${issue.identifier}:`, ...(lines.length ? ["History:", ...lines] : []), ...(comments.length ? ["", "Comments:", ...comments] : [])].join("\n");
  if (text.length <= max) return text;
  const tail = `\n\n[cut: the rest is in Linear: ${issue.url}]`;
  return text.slice(0, max - tail.length) + tail;
}

// ---- prefixes, similarity, durations ------------------------------------------------------------------------------

/**
 * A project's card prefix from its name: the words' initials (up to 4), or the first letters of a single word; the
 * fallback is `fallback` (the Linear team key); a taken one gets 2, 3, … Deterministic.
 */
export function prefixFor(name: string, taken: ReadonlySet<string>, fallback = "LIN"): string {
  const all = name.toUpperCase().normalize("NFKD").replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const lettered = all.filter((w) => /^[A-Z]/.test(w)); // "Postgres 18 upgrade" → PU, not P1U
  const words = lettered.length ? lettered : all;
  let base = (words.length > 1 ? words.map((w) => w[0]).join("") : words[0] ?? "").replace(/^[0-9]+/, "").slice(0, 4);
  if (base.length < 2) base = (fallback.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^[0-9]+/, "") || "LIN").slice(0, 6);
  if (base.length < 2) base = "LIN";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const p = `${base.slice(0, 10 - String(i).length)}${i}`;
    if (!taken.has(p)) return p;
  }
  return `L${taken.size}`.slice(0, 10);
}

/** A title for comparison: lowercase, no Linear keys, bracket tags or punctuation. */
export function normTitle(t: string): string {
  return t.toLowerCase().replace(/\[[^\]]*\]/g, " ").replace(/\b[a-z][a-z0-9]{0,9}-\d+\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}
function tokens(t: string): Set<string> { return new Set(normTitle(t).split(" ").filter((w) => w.length > 1)); }

/** A title prepared for comparison (normalised once: plans compare every pair in a project). */
export interface TitleKey { norm: string; tokens: Set<string> }
export function titleKey(t: string): TitleKey { return { norm: normTitle(t), tokens: tokens(t) }; }

/** Near duplicates: the same normalised title, or ≥ 4 words each with token overlap (Jaccard) ≥ 0.85. */
export function similarKeys(a: TitleKey, b: TitleKey): boolean {
  if (!a.norm || !b.norm) return false;
  if (a.norm === b.norm) return true;
  const x = a.tokens.size;
  const y = b.tokens.size;
  if (x < 4 || y < 4 || Math.min(x, y) / Math.max(x, y) < 0.85) return false; // Jaccard ≤ min/max
  let inter = 0;
  for (const w of a.tokens) if (b.tokens.has(w)) inter++;
  return inter / (x + y - inter) >= 0.85;
}
export function similar(a: string, b: string): boolean { return similarKeys(titleKey(a), titleKey(b)); }

/** "45d", "12h", "2w", "30m" → milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d{1,5})\s*(m|h|d|w)$/i.exec(s.trim());
  if (!m) throw new Error(`"${s.slice(0, 20)}" is not a duration (e.g. 45d, 12h, 2w, 30m)`);
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[(m[2] as string).toLowerCase() as "m" | "h" | "d" | "w"];
  return n * unit;
}
