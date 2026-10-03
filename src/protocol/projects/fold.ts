// The board fold (WALKIE-PROJECTS-1): a PURE function of the set of accepted posts in a project's channel, so every
// replica holding the same posts shows the same board, whatever order they arrived in (property-tested in
// test/unit/projects-fold.test.ts).
//
// Convergence: every entity (the project, each board, each card) is a root post plus the op replies in its thread.
// Each op names its causal parent: `after: "<event id>#<first 16 hex of sha256(its signature)>"`, the head of the
// entity its author had folded when it signed. Its rank is its parent's rank + 1 (+ 0 for a follow-up to the same
// member's own op; the root's rank is 0); an op without `after` ranks 1. A parent that is stored but hidden (not
// accepted) still carries rank; an op whose parent hasn't been received (or never will be: a wrong hash) waits and
// applies nothing. The fold
// applies the root first, then the ops ordered by (rank, origin, seq) ascending; each op writes the fields it carries,
// so every field ends up with the value of its last writer in that order (per-field last-writer-wins).
//
// Why a parent and not a counter or a timestamp (round-2 audits, Codex M2/M4, Opus M1): a rank is fixed once the
// op's ancestors exist, so nothing that arrives later can lift an old op above a correction; timestamps play no part,
// so neither backdating nor future-dating moves anything; and an op can only name a parent whose signature it has
// seen, so nobody can pre-sign an op to out-rank a future one. A member who chains many ops of their own gets a high
// rank at once, but the next op of anyone who has seen it ranks higher still: nothing can pin a field. Column +
// position (+ board) are one register ("place"); state is its own.
//
// Permissions are judged per op against the roster its event is judged by (`roleOf`, the chain's rosterFor):
//   - project create: the channel's creator, a person or one of the person's agents (fold 8, AGENT-PROJECTS: an agent
//     creates a project for its person, Linear parity; the project's creator is the handle either way)
//   - project settings: a person (not an agent) who is an owner or the project's creator (while a member)
//   - board create: any member, a person or an agent (fold 8); board changes: a person who is the board's creator,
//     an owner or the project's creator
//   - delete / restore a card: a person
//   - moving or reassigning a card whose assignee is a person (an address with no agent part): a person, or (moving
//     only) the project's board steward (fold 9, FO-6: CardContext.steward)
// An op that fails is kept in the signed log and shown in the timeline as ignored; the fold skips it. (A project's
// `agents_can_close` is a guardrail the local API applies to agent requests, not a fold rule: any member's machine can
// sign an op without an agent name, and a fold rule keyed on a setting's history would re-judge accepted ops.)
import type { Author, Role } from "../schemas.ts";
import { cardRef, shortId } from "./short.ts";
import {
  BoardOp, CardOp, ProjectOp, DEFAULT_COLUMNS, type Automations, type BoardOpT, type BoardView, type CardOpT, type CardView,
  type Column, type ColumnRole, type Meter, type PathRule, type ProjectOpT, type ProjectView, type TimelineEntry,
} from "./schema.ts";

/** One accepted post of a project's channel, as the fold needs it. */
export interface OpEvent {
  readonly id: string; readonly origin: string; readonly seq: number; readonly ts: number;
  readonly author: Author;
  /** Root id of the thread it replies in; absent on a root post. */
  readonly thread?: string;
  readonly text: string;
  /** body.board as signed (parsed by the fold). */
  readonly board?: unknown;
  /** First 16 hex of sha256(the event's signature): what an op names its parent by. */
  readonly h: string;
  /** Stored but not accepted (a hidden row): carries rank for the ops that name it, applies nothing. */
  readonly hidden?: boolean;
}

/** How an op names another as its parent (`after`). */
export function refOf(ev: Pick<OpEvent, "id" | "h">): string { return `${ev.id}#${ev.h}`; }

export interface FoldEnv {
  /** Handle of the member who created the channel (the chain's channel.upsert); null = not known here. */
  readonly creator: string | null;
  /** The author's role in the roster its event is judged by (PROTOCOL §2 "Anchoring"). */
  readonly roleOf: (ev: OpEvent) => Role | "removed" | null;
}

type Parsed<T> = { ev: OpEvent; op: T };
interface Ordered<T> extends Parsed<T> { rank: number; root: boolean }

export function isPerson(ev: Pick<OpEvent, "author">): boolean { return !ev.author.agent; }
/** An address naming a person or a person's machine, not an agent (`@kira`, `@kira/kiras-mbp`). */
export function isPersonAddress(a: string | null | undefined): boolean { return !!a && a.split("/").length < 3; }

/** Origin, then seq as a NUMBER (string ids would put :10 before :9). */
function byOriginSeq(a: { origin: string; seq: number }, b: { origin: string; seq: number }): number {
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  return a.seq - b.seq;
}

/** Create order: (ts, origin, seq). */
function byTs(a: { ts: number; origin: string; seq: number }, b: { ts: number; origin: string; seq: number }): number {
  return a.ts - b.ts || byOriginSeq(a, b);
}

function cmp(a: Ordered<unknown>, b: Ordered<unknown>): number {
  if (a.root !== b.root) return a.root ? -1 : 1;
  return a.rank - b.rank || byOriginSeq(a.ev, b.ev);
}

const AFTER_RE = /^([0-9a-f]{16}:[1-9][0-9]*)#([0-9a-f]{16})$/;

/**
 * How much an op adds to its parent's rank: 1, except 0 for a follow-up to an op signed by the SAME MACHINE (origin),
 * whose seq already orders them (a later seq was signed after, and saw, the earlier): chaining one's own ops gains no
 * rank against a concurrent edit (round-3 LOW). Keyed on the machine, not the person: a correction from a person's
 * other machine, or another agent's, is an ordinary +1 and wins over what it saw (round-4 audit, Opus HIGH).
 */
function step(x: OpEvent, parent: OpEvent, root: OpEvent): number {
  return parent.id === root.id || parent.origin !== x.origin ? 1 : 0;
}

/**
 * The fold order of one entity's ops (by rank), and the ops still waiting for their parent. Ops marked `hidden`
 * (signed and stored, but not accepted: e.g. judged invalid after their author's removal) carry rank for the ops that
 * name them and apply nothing, so an accepted op built on one keeps its place (round-3 audit, Opus HIGH). An op whose
 * parent hasn't been received at all waits until it is.
 */
export function order<T extends { after?: string }>(root: Parsed<T>, replies: readonly Parsed<T>[]): { applied: Ordered<T>[]; waiting: Parsed<T>[] } {
  const byId = new Map<string, Parsed<T>>([[root.ev.id, root], ...replies.map((x) => [x.ev.id, x] as const)]);
  const ranks = new Map<string, number | null>([[root.ev.id, 0]]);
  const rankOf = (start: Parsed<T>): void => {
    // Iterative walk up the parent chain (chains can be long), then ranks filled back down. A rank comes ONLY from the
    // parent chain, with every parent's signature hash checked; nothing an op claims about itself counts.
    const path: Array<{ x: Parsed<T>; parent: Parsed<T> | null }> = [];
    let cur: Parsed<T> | undefined = start;
    let base: number | null = null;
    const seen = new Set<string>();
    while (cur) {
      const known = ranks.get(cur.ev.id);
      if (known !== undefined) { base = known; break; }
      if (seen.has(cur.ev.id)) { base = null; break; } // a cycle can't be signed; refuse it anyway
      seen.add(cur.ev.id);
      const after = cur.op.after;
      if (after === undefined) { path.push({ x: cur, parent: root }); base = 0; break; } // no parent named: after the root
      const m = AFTER_RE.exec(after);
      const parent = m ? byId.get(m[1] as string) : undefined;
      if (!m || !parent || parent.ev.h !== m[2] || parent === cur) { path.push({ x: cur, parent: null }); base = null; break; }
      path.push({ x: cur, parent });
      cur = parent;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const { x, parent } = path[i] as { x: Parsed<T>; parent: Parsed<T> | null };
      const r: number | null = base === null || parent === null ? null : base + step(x.ev, parent.ev, root.ev);
      ranks.set(x.ev.id, r);
      base = r;
    }
  };
  for (const x of replies) rankOf(x);
  const applied: Ordered<T>[] = [{ ...root, rank: 0, root: true }];
  const waiting: Parsed<T>[] = [];
  for (const x of replies) {
    const r = ranks.get(x.ev.id) ?? null;
    if (x.ev.hidden) continue;
    if (r === null) waiting.push(x); else applied.push({ ...x, rank: r, root: false });
  }
  return { applied: applied.sort(cmp), waiting };
}

function fieldsOf(op: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of names) if (op[k] !== undefined) out[k] = op[k];
  return out;
}

function parse<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, v: unknown): T | null {
  const r = schema.safeParse(v);
  return r.success ? (r.data as T) : null;
}

/** Timeline entries for ops still waiting for their parent. */
function waitingEntries<T>(waiting: readonly Parsed<T>[], names: readonly string[]): TimelineEntry[] {
  return waiting.map((x) => ({
    id: x.ev.id, ts: x.ev.ts, author: x.ev.author, kind: "op" as const, changes: fieldsOf(x.op as Record<string, unknown>, names),
    ignored: "waiting_for_parent",
  }));
}

function byTsEntry(a: TimelineEntry, b: TimelineEntry): number {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ---- project ------------------------------------------------------------------------------------------------------

export interface ProjectState {
  id: string; name: string; folder: string; description: string; prefix: string; paths: PathRule[];
  /** Every prefix an applied op ever gave the project (the current one included): old keys stay masked (Opus r4 M4). */
  prefixes: string[];
  meter: "count" | "points"; automations: Required<Automations>; state: "active" | "archived" | "deleted";
  steward: "on" | "off"; steward_node: string; status_report: "hourly" | "off";
  creator: string; created_at: number; updated_at: number;
  /** Highest applied rank, and the op new settings changes name as their parent. */
  rev: number; head: string;
  timeline: TimelineEntry[];
}

const DEFAULT_AUTOMATIONS: Required<Automations> = { pr_opened: true, pr_merged: false, agents_can_close: true };
const PROJECT_FIELDS = ["name", "folder", "description", "prefix", "paths", "meter", "automations", "state", "steward", "steward_node", "status_report"] as const;

function isAdmin(ev: OpEvent, env: FoldEnv, creator: string): boolean {
  if (!isPerson(ev)) return false;
  const role = env.roleOf(ev);
  // The creator counts only while a member (a removed creator is no admin; round-1 audit LOW).
  return role === "owner" || (ev.author.handle === creator && role === "member");
}

/**
 * The project: the earliest (ts, origin, seq) project root by the member who created the channel (the person, or one of
 * the person's agents: fold 8), then its settings ops. Other roots are ignored (a second "project" in the same channel
 * can't take it over).
 */
export function foldProject(posts: readonly OpEvent[], env: FoldEnv): ProjectState | null {
  const roots: Parsed<ProjectOpT>[] = [];
  for (const ev of posts) {
    if (ev.thread || ev.hidden) continue;
    const op = parse<ProjectOpT>(ProjectOp, ev.board);
    if (!op || !op.name || !op.prefix) continue;
    if (env.creator !== null && ev.author.handle !== env.creator) continue;
    roots.push({ ev, op });
  }
  const root = roots.sort((a, b) => byTs(a.ev, b.ev))[0];
  if (!root) return null;
  const replies: Parsed<ProjectOpT>[] = [];
  for (const ev of posts) {
    if (ev.thread !== root.ev.id) continue;
    const op = parse<ProjectOpT>(ProjectOp, ev.board);
    if (op) replies.push({ ev, op });
  }
  const creator = root.ev.author.handle;
  const r = root.op;
  let s: ProjectState = {
    id: root.ev.id, name: r.name as string, folder: r.folder ?? "", description: r.description ?? "", prefix: r.prefix as string, prefixes: [r.prefix as string],
    paths: r.paths ?? [], meter: r.meter ?? "count", automations: { ...DEFAULT_AUTOMATIONS, ...(r.automations ?? {}) },
    state: r.state ?? "active", steward: r.steward ?? "on", steward_node: r.steward_node ?? "", status_report: isPerson(root.ev) ? r.status_report ?? "off" : "off", creator, created_at: root.ev.ts, updated_at: root.ev.ts, rev: 0, head: refOf(root.ev), timeline: [],
  };
  const { applied, waiting } = order(root, replies);
  const timeline: TimelineEntry[] = waitingEntries(waiting, PROJECT_FIELDS);
  for (const o of applied) {
    const changes = fieldsOf(o.op as Record<string, unknown>, PROJECT_FIELDS);
    const entry: TimelineEntry = { id: o.ev.id, ts: o.ev.ts, author: o.ev.author, kind: o.root ? "create" : "op", changes, rev: o.op.rev, effective_rev: o.rank };
    if (!o.root && !isAdmin(o.ev, env, creator)) { timeline.push({ ...entry, ignored: "not_admin" }); continue; }
    timeline.push(entry);
    s = { ...s, head: refOf(o.ev), rev: o.rank };
    if (o.root) continue;
    const p = o.op;
    s = {
      ...s,
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.folder !== undefined ? { folder: p.folder } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.prefix !== undefined ? { prefix: p.prefix, prefixes: s.prefixes.includes(p.prefix) ? s.prefixes : [...s.prefixes, p.prefix] } : {}),
      ...(p.paths !== undefined ? { paths: p.paths } : {}),
      ...(p.meter !== undefined ? { meter: p.meter } : {}),
      ...(p.automations !== undefined ? { automations: { ...s.automations, ...p.automations } } : {}),
      ...(p.state !== undefined ? { state: p.state } : {}),
      ...(p.steward !== undefined ? { steward: p.steward } : {}),
      ...(p.steward_node !== undefined ? { steward_node: p.steward_node } : {}),
      ...(p.status_report !== undefined ? { status_report: p.status_report } : {}),
      updated_at: Math.max(s.updated_at, o.ev.ts),
    };
  }
  return { ...s, timeline: timeline.sort(byTsEntry) };
}

// ---- boards -------------------------------------------------------------------------------------------------------

export interface BoardState {
  id: string; name: string; columns: Column[]; state: "active" | "archived";
  created_at: number; created_by: Author; rev: number; head: string; timeline: TimelineEntry[];
}

const BOARD_FIELDS = ["name", "columns", "state"] as const;

/** Every board root in the channel (a person's or an agent's since fold 8, with a name and columns), each with its ops; ordered by create order. */
export function foldBoards(posts: readonly OpEvent[], env: FoldEnv, project: ProjectState | null): BoardState[] {
  const roots: Parsed<BoardOpT>[] = [];
  const replies = new Map<string, Parsed<BoardOpT>[]>();
  for (const ev of posts) {
    const op = parse<BoardOpT>(BoardOp, ev.board);
    if (!op) continue;
    if (!ev.thread) {
      if (op.name && op.columns && !ev.hidden) roots.push({ ev, op });
    } else {
      replies.set(ev.thread, [...(replies.get(ev.thread) ?? []), { ev, op }]);
    }
  }
  const creator = project?.creator ?? env.creator ?? "";
  return roots.sort((a, b) => byTs(a.ev, b.ev)).map((root) => {
    let b: BoardState = {
      id: root.ev.id, name: root.op.name as string, columns: root.op.columns as Column[], state: root.op.state ?? "active",
      created_at: root.ev.ts, created_by: root.ev.author, rev: 0, head: refOf(root.ev), timeline: [],
    };
    const { applied, waiting } = order(root, replies.get(root.ev.id) ?? []);
    const timeline: TimelineEntry[] = waitingEntries(waiting, BOARD_FIELDS);
    for (const o of applied) {
      const changes = fieldsOf(o.op as Record<string, unknown>, BOARD_FIELDS);
      const entry: TimelineEntry = { id: o.ev.id, ts: o.ev.ts, author: o.ev.author, kind: o.root ? "create" : "op", changes, rev: o.op.rev, effective_rev: o.rank };
      const allowed = o.root || (isPerson(o.ev) && (o.ev.author.handle === root.ev.author.handle || isAdmin(o.ev, env, creator)));
      if (!allowed) { timeline.push({ ...entry, ignored: "not_admin" }); continue; }
      timeline.push(entry);
      b = { ...b, head: refOf(o.ev), rev: o.rank };
      if (o.root) continue;
      b = {
        ...b,
        ...(o.op.name !== undefined ? { name: o.op.name } : {}),
        ...(o.op.columns !== undefined ? { columns: o.op.columns } : {}),
        ...(o.op.state !== undefined ? { state: o.op.state } : {}),
      };
    }
    return { ...b, timeline: timeline.sort(byTsEntry) };
  });
}

// ---- cards --------------------------------------------------------------------------------------------------------

export interface CardState {
  id: string; board: string; title: string; body: string; column: string; pos: string;
  assignee: string | null; reviewer: string | null; labels: string[]; estimate: number | null; due: string | null;
  blocked: boolean; blocked_reason: string | null; state: "open" | "archived" | "deleted";
  /** Proposed key number (root). */
  n_proposed: number | null;
  created_at: number; created_by: Author; updated_at: number; updated_by: Author;
  /** Highest applied rank, and the op the next change names as its parent. */
  rev: number; head: string;
  comments: number; timeline: TimelineEntry[];
}

export interface CardContext {
  /** The project's boards by id (a card on an unknown board isn't shown until the board arrives). */
  readonly boards: ReadonlyMap<string, Pick<BoardState, "id" | "columns">>;
  /**
   * FO-6: whether an op's author is the project's board steward (steward.ts isStewardAuthor: the reserved `steward`
   * agent of an owner, or of the project's creator). The steward may MOVE a card assigned to a person; it still can't
   * reassign one or delete anything. Absent: nobody is (pre.6 folds, which ignore such a move as person_card).
   */
  readonly steward?: (ev: OpEvent) => boolean;
}

export const DEFAULT_POS = "i";
const CARD_FIELDS = ["title", "body", "board", "column", "pos", "assignee", "reviewer", "labels", "estimate", "due", "blocked", "blocked_reason", "state"] as const;

function cardDenial(ev: OpEvent, op: CardOpT, cur: CardState, ctx: CardContext): string | null {
  const person = isPerson(ev);
  if (op.state !== undefined && op.state !== cur.state && (op.state === "deleted" || cur.state === "deleted") && !person) return "person_only";
  const moves = op.board !== undefined || op.column !== undefined || op.pos !== undefined;
  const reassigns = op.assignee !== undefined || op.reviewer !== undefined;
  if (!person && (moves || reassigns) && isPersonAddress(cur.assignee) && !(moves && !reassigns && ctx.steward?.(ev))) return "person_card";
  if (op.board !== undefined && !ctx.boards.has(op.board)) return "unknown_board";
  return null;
}

/**
 * One card: its root and the posts in its thread (ops and comments). Null when the root isn't a valid card root or
 * names a board this project doesn't have (yet).
 */
export function foldCard(root: OpEvent, thread: readonly OpEvent[], ctx: CardContext): CardState | null {
  if (root.thread || root.hidden) return null;
  const r = parse<CardOpT>(CardOp, root.board);
  if (!r || !r.board || !r.title || !r.column || !ctx.boards.has(r.board)) return null;
  const replies: Parsed<CardOpT>[] = [];
  const comments: OpEvent[] = [];
  for (const ev of thread) {
    if (ev.thread !== root.id) continue;
    if (ev.board === undefined) { if (!ev.hidden) comments.push(ev); continue; }
    const op = parse<CardOpT>(CardOp, ev.board);
    if (op) replies.push({ ev, op });
  }
  let s: CardState = {
    id: root.id, board: r.board, title: r.title, body: r.body ?? "", column: r.column, pos: r.pos ?? DEFAULT_POS,
    assignee: r.assignee ?? null, reviewer: r.reviewer ?? null, labels: r.labels ?? [], estimate: r.estimate ?? null,
    due: r.due ?? null, blocked: r.blocked ?? false, blocked_reason: r.blocked_reason ?? null, state: r.state ?? "open",
    n_proposed: r.n ?? null, created_at: root.ts, created_by: root.author, updated_at: root.ts, updated_by: root.author,
    rev: 0, head: refOf(root), comments: comments.length, timeline: [],
  };
  const { applied, waiting } = order({ ev: root, op: r }, replies);
  const timeline: TimelineEntry[] = [
    ...comments.map((ev) => ({ id: ev.id, ts: ev.ts, author: ev.author, kind: "comment" as const, text: ev.text })),
    ...waitingEntries(waiting, CARD_FIELDS),
  ];
  for (const o of applied) {
    const changes = fieldsOf(o.op as Record<string, unknown>, CARD_FIELDS);
    const entry: TimelineEntry = { id: o.ev.id, ts: o.ev.ts, author: o.ev.author, kind: o.root ? "create" : "op", changes, rev: o.op.rev, effective_rev: o.rank };
    const denied = o.root ? null : cardDenial(o.ev, o.op, s, ctx);
    if (denied) { timeline.push({ ...entry, ignored: denied }); continue; }
    timeline.push(entry);
    s = { ...s, head: refOf(o.ev), rev: o.rank };
    if (o.root) continue;
    s = applyCardOp(s, o.op, o.ev);
  }
  return { ...s, timeline: timeline.sort(byTsEntry) };
}

function applyCardOp(s: CardState, op: CardOpT, ev: OpEvent): CardState {
  // Board, column and position are one register: a move writes all three (a missing one keeps its value).
  const moves = op.board !== undefined || op.column !== undefined || op.pos !== undefined;
  return {
    ...s,
    ...(op.title !== undefined ? { title: op.title } : {}),
    ...(op.body !== undefined ? { body: op.body } : {}),
    ...(moves ? { board: op.board ?? s.board, column: op.column ?? s.column, pos: op.pos ?? s.pos } : {}),
    ...(op.assignee !== undefined ? { assignee: op.assignee } : {}),
    ...(op.reviewer !== undefined ? { reviewer: op.reviewer } : {}),
    ...(op.labels !== undefined ? { labels: op.labels } : {}),
    ...(op.estimate !== undefined ? { estimate: op.estimate } : {}),
    ...(op.due !== undefined ? { due: op.due } : {}),
    ...(op.blocked !== undefined ? { blocked: op.blocked } : {}),
    ...(op.blocked_reason !== undefined ? { blocked_reason: op.blocked_reason } : {}),
    ...(op.state !== undefined ? { state: op.state } : {}),
    updated_at: Math.max(s.updated_at, ev.ts), updated_by: ev.ts >= s.updated_at ? ev.author : s.updated_by,
  };
}

/**
 * A proposed key number is honoured only up to this far past the highest number honoured before it (in create
 * order): an honest creator proposes (highest it knows) + 1, well within it, while one card proposing 1 000 000 can't
 * push every later number out of range, and a card inserted into the order (backdated) only ever loosens the bound for
 * the cards after it, so it never renumbers them (round-1 Codex HIGH 2, round-2 Opus M2).
 */
export const KEY_SLACK = 100;

function idParts(id: string): { origin: string; seq: number } {
  const i = id.lastIndexOf(":");
  return { origin: id.slice(0, i), seq: Number(id.slice(i + 1)) };
}

/**
 * Key numbers for a project's cards. First, in create order (ts, origin, seq), each card keeps the number its creator
 * proposed unless an earlier card holds it or it is more than KEY_SLACK past the highest number kept so far. Then the
 * others, in the same order, each take the lowest number no card holds that is above what they proposed (from 1 for a
 * proposal out of range). So a card that lost a collision keeps its number when ordinary cards are created after it
 * (they propose above every number in use; round-4 audit, Codex M4), and a card inserted into the order (backdated,
 * or created offline) moves only the card it collides with, never a cascade (round-2 audit, Opus M2).
 */
export function assignKeys(cards: ReadonlyArray<{ id: string; ts: number; n: number | null }>): Map<string, number> {
  const sorted = [...cards].map((c) => ({ ...c, ...idParts(c.id) })).sort(byTs);
  const used = new Set<number>();
  const out = new Map<string, number>();
  const losers: Array<{ id: string; from: number }> = [];
  let top = 0;
  for (const c of sorted) {
    const inRange = c.n !== null && c.n >= 1 && c.n <= top + 1 + KEY_SLACK;
    if (inRange && !used.has(c.n as number)) {
      used.add(c.n as number);
      out.set(c.id, c.n as number);
      top = Math.max(top, c.n as number);
    } else {
      losers.push({ id: c.id, from: inRange ? (c.n as number) + 1 : 1 });
    }
  }
  for (const l of losers) {
    let n = l.from;
    while (used.has(n)) n++;
    used.add(n);
    out.set(l.id, n);
  }
  return out;
}

/** The column a card shows in: its own when the board has it, else the board's first backlog/todo column (or first). */
export function shownColumn(columns: readonly Column[], column: string): string {
  if (columns.some((c) => c.id === column)) return column;
  return (columns.find((c) => c.role === "backlog" || c.role === "todo") ?? columns[0] ?? DEFAULT_COLUMNS[0] as Column).id;
}

// ---- meters -------------------------------------------------------------------------------------------------------

export function emptyMeter(mode: "count" | "points"): Meter {
  return { mode, done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } };
}

/**
 * Completeness of one board: counted = open and archived cards outside cancelled columns (deleted cards never count);
 * done = those in done columns (an archived done card stays done). Points mode sums estimates, 1 for a card without.
 */
export function boardMeter(cards: ReadonlyArray<Pick<CardView, "column" | "state" | "estimate">>, columns: readonly Column[], mode: "count" | "points"): Meter {
  const m = emptyMeter(mode);
  const roles = new Map(columns.map((c) => [c.id, c.role]));
  const by = { ...m.by_role };
  let done = 0;
  let counted = 0;
  for (const c of cards) {
    if (c.state === "deleted") continue;
    const role = roles.get(shownColumn(columns, c.column)) ?? "todo";
    const w = mode === "points" ? c.estimate ?? 1 : 1;
    by[role] += w;
    if (role === "cancelled") continue;
    counted += w;
    if (role === "done") done += w;
  }
  return { mode, done, counted, by_role: by };
}

/** A project's meter: the sum of its boards' (counts, never averaged percentages). */
export function sumMeters(meters: readonly Meter[], mode: "count" | "points"): Meter {
  const out = emptyMeter(mode);
  const by = { ...out.by_role };
  let done = 0;
  let counted = 0;
  for (const m of meters) {
    done += m.done;
    counted += m.counted;
    for (const k of Object.keys(by) as ColumnRole[]) by[k] += m.by_role[k];
  }
  return { mode, done, counted, by_role: by };
}

export function cardKey(prefix: string, n: number): string { return `${prefix}-${n}`; }

/** A card as the API shows it (the column resolved against its board). */
export function cardView(s: CardState, channel: string, prefix: string, n: number, columns: readonly Column[]): CardView {
  return {
    id: s.id, channel, board: s.board, key: cardKey(prefix, n), n, short: shortId(s.id), ref: cardRef(cardKey(prefix, n), s.id), title: s.title, body: s.body,
    column: shownColumn(columns, s.column), pos: s.pos, assignee: s.assignee, reviewer: s.reviewer, labels: s.labels,
    estimate: s.estimate, due: s.due, blocked: s.blocked, blocked_reason: s.blocked_reason, state: s.state,
    created_at: s.created_at, created_by: s.created_by, updated_at: s.updated_at, updated_by: s.updated_by,
    comments: s.comments, rev: s.rev,
  };
}

/** Cards of one board grouped by (column, state): how many, and their points. */
export interface CardGroup { column: string; state: string; n: number; pts: number }

/** boardMeter over grouped counts (the daemon aggregates in SQL instead of loading every card). */
export function meterFromGroups(groups: readonly CardGroup[], columns: readonly Column[], mode: "count" | "points"): Meter {
  const m = emptyMeter(mode);
  const roles = new Map(columns.map((c) => [c.id, c.role]));
  const by = { ...m.by_role };
  let done = 0;
  let counted = 0;
  for (const g of groups) {
    if (g.state === "deleted") continue;
    const role = roles.get(shownColumn(columns, g.column)) ?? "todo";
    const w = mode === "points" ? g.pts : g.n;
    by[role] += w;
    if (role === "cancelled") continue;
    counted += w;
    if (role === "done") done += w;
  }
  return { mode, done, counted, by_role: by };
}

/** Assembles a project view from its folded parts and its cards grouped per board. */
export function projectView(
  channel: string, p: ProjectState, boards: readonly BoardState[], groups: ReadonlyMap<string, readonly CardGroup[]>,
  opts: { private: boolean; owners: readonly string[]; lastActivity: number },
): ProjectView {
  const boardViews: BoardView[] = boards.map((b) => {
    const mine = groups.get(b.id) ?? [];
    return {
      id: b.id, name: b.name, columns: b.columns, state: b.state, created_at: b.created_at, created_by: b.created_by,
      meter: meterFromGroups(mine, b.columns, p.meter), live_cards: mine.filter((g) => g.state === "open").reduce((n, g) => n + g.n, 0),
    };
  });
  let cards = 0;
  for (const gs of groups.values()) for (const g of gs) if (g.state !== "deleted") cards += g.n;
  const admins = [...new Set([...opts.owners, p.creator])].sort();
  return {
    channel, id: p.id, name: p.name, folder: p.folder, description: p.description, prefix: p.prefix, paths: p.paths,
    ...(p.prefixes.length > 1 ? { prior_prefixes: p.prefixes.filter((x) => x !== p.prefix) } : {}),
    meter_mode: p.meter, automations: p.automations, state: p.state, steward: p.steward, steward_node: p.steward_node, status_report: p.status_report, private: opts.private, admins, creator: p.creator,
    created_at: p.created_at, boards: boardViews,
    meter: sumMeters(boardViews.filter((b) => b.state === "active").map((b) => b.meter), p.meter),
    cards, last_activity: Math.max(opts.lastActivity, p.updated_at),
  };
}
