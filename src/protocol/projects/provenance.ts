// WALK-77 Phase 0. Who proposed, shaped and decided a card, read off the signed authors of applied card ops.
//
// The fold already ranks ops by their parent chain (PROTOCOL §10 "Convergence"): nothing an op claims about itself
// counts, and a timestamp does not decide which write won. This view uses that same order for display. Rows are
// ordered by effective_rev, then the signing machine, then sequence as a number. A signed clock cannot drop a row
// or move it. A row with no effective_rev (a hand-built timeline; the fold always sets one) ranks as 0.
//
// "Done" is a column role on the card's board as it stands now, not the column's id and not the word "done".
// The card's board is the root's board, then each applied board write in fold order. An op that names a board is
// read on that board. A column id that board does not have is shaping. The root is the proposal, including when it
// was created already in a done column: creating a card is not a move to done. A later edit of a column's role
// reclassifies the same op the next time this is read.
//
// A placement is a column write, or a board write that keeps the column. The last applied placement is the one
// that stands. A column write is read on the board it names. A board-only write is read where that board shows
// the card: the column id when the board has it, otherwise the column the board shows the card in. If that column's
// role is done, the placement decided it and earlier done-moves are superseded. If it is not, earlier done-moves
// are reopened and nothing stands. The root sets the place and is not itself a placement. A move that changes only
// pos, title or body is not one either.
import { Author, EventId } from "../schemas.ts";
import { ColumnId, ColumnRole, type TimelineEntry } from "./schema.ts";

export interface ProvenanceColumn {
  readonly id: string;
  readonly role: ColumnRole;
  /** Board root id, when the caller knows which board this column belongs to. */
  readonly board?: string;
  readonly name?: string;
}

/** Whether a done-column move is the one the fold still has in place. */
export type ProvenanceDecision = "stands" | "reopened" | "superseded";

export interface ProvenanceAct {
  readonly id: string;
  readonly author: Author;
  readonly ts: number;
  readonly field: "create" | "title" | "body" | "column";
  /** Set when `field` is `column`: the column id the op wrote. */
  readonly columnId?: string;
  /** The board's name for that column, when every matching column agrees. */
  readonly columnName?: string;
  /** Set on a move into a done column. */
  readonly decision?: ProvenanceDecision;
}

export interface CardProvenance {
  readonly proposed: readonly ProvenanceAct[];
  readonly shaped: readonly ProvenanceAct[];
  readonly decided: readonly ProvenanceAct[];
}

/** Largest timestamp `Date` can format. A wild clock past this is kept and the time is left unshown. */
export const PROVENANCE_MAX_TS = 8_640_000_000_000_000;
/**
 * A stamp further ahead than this of the reader's clock is left unshown. Matches the protocol's future hold:
 * a `ts` more than 24 h ahead is not trusted as a time. One ahead by less is shown as ahead.
 */
export const PROVENANCE_FUTURE_MS = 24 * 60 * 60 * 1000;
const TITLE_MAX = 200;
const BODY_MAX = 16_000;

/** A signed clock `Date` can format. Negative, fractional and out-of-range stamps cannot. */
export function signedTimeShown(ts: number): boolean {
  return Number.isSafeInteger(ts) && ts >= 0 && ts <= PROVENANCE_MAX_TS;
}

/**
 * How to render a signed clock against the reader's `now`. `unshown` is not a time the row can honestly display.
 * `ahead` is in the future but within a day. `shown` is now or in the past.
 */
export function provenanceTimeKind(ts: number, now: number): "shown" | "ahead" | "unshown" {
  if (!signedTimeShown(ts)) return "unshown";
  if (!Number.isFinite(now)) return "shown";
  if (ts > now + PROVENANCE_FUTURE_MS) return "unshown";
  if (ts > now) return "ahead";
  return "shown";
}

function cleanColumns(columns: readonly ProvenanceColumn[] | null | undefined): ProvenanceColumn[] {
  if (!Array.isArray(columns)) return [];
  const out: ProvenanceColumn[] = [];
  for (const c of columns) {
    if (!c || typeof c !== "object") continue;
    if (!ColumnId.safeParse(c.id).success) continue;
    const role = ColumnRole.safeParse(c.role);
    if (!role.success) continue;
    const name = typeof c.name === "string" && c.name.length >= 1 && c.name.length <= 40 ? c.name : undefined;
    const board = typeof c.board === "string" && EventId.safeParse(c.board).success ? c.board : undefined;
    out.push({ id: c.id, role: role.data, ...(name ? { name } : {}), ...(board ? { board } : {}) });
  }
  return out;
}

/** Columns tagged with `boardId`, or null when the caller did not tag any column with a board. */
function columnsOn(columns: readonly ProvenanceColumn[], boardId: string): ProvenanceColumn[] | null {
  if (!columns.some((c) => c.board !== undefined)) return null;
  return columns.filter((c) => c.board === boardId);
}

function factFrom(pool: readonly ProvenanceColumn[]): { done: boolean; name?: string } {
  const names = [...new Set(pool.map((c) => c.name).filter((n): n is string => !!n))];
  const name = names.length === 1 ? names[0] : undefined;
  const named = name ? { name } : {};
  if (pool.length === 0 || pool.some((c) => c.role !== pool[0]?.role)) return { done: false, ...named };
  return { done: pool[0]?.role === "done", ...named };
}

/**
 * Where the card shows on `boardId` after a move that did not write a column. The id, when that board has it;
 * otherwise the first backlog or todo column, else the first column. Same rule as the fold's `shownColumn`.
 * Null when the caller did not tag columns with a board, so the old unscoped rule still applies.
 */
function shownOnBoard(columns: readonly ProvenanceColumn[], columnId: string, boardId: string): { done: boolean; name?: string; id: string } | null {
  const onBoard = columnsOn(columns, boardId);
  if (onBoard === null) return null;
  const hit = onBoard.filter((c) => c.id === columnId);
  if (hit.length > 0) {
    const fact = factFrom(hit);
    return { done: fact.done, ...(fact.name ? { name: fact.name } : {}), id: columnId };
  }
  const fallback = onBoard.find((c) => c.role === "backlog" || c.role === "todo") ?? onBoard[0];
  if (!fallback) return { done: false, id: columnId };
  return { done: fallback.role === "done", ...(fallback.name ? { name: fallback.name } : {}), id: fallback.id };
}

/**
 * The column an id refers to. A known board is that board only: an id it does not have is not done, even when
 * another board uses the id for a done column. No board at all (the thread never names one, and the caller did
 * not tag columns) keeps the old rule: disagreeing roles are not a decision.
 */
function columnFact(columns: readonly ProvenanceColumn[], columnId: string, boardId: string | undefined): { done: boolean; name?: string } {
  if (boardId) {
    const onBoard = columnsOn(columns, boardId);
    if (onBoard === null) return factFrom(columns.filter((c) => c.id === columnId));
    return factFrom(onBoard.filter((c) => c.id === columnId));
  }
  return factFrom(columns.filter((c) => c.id === columnId));
}

function revOf(row: TimelineEntry | null | undefined): number {
  const r = row?.effective_rev;
  return typeof r === "number" && Number.isSafeInteger(r) ? r : 0;
}

function partsOf(id: unknown): { origin: string; seq: number } {
  if (typeof id !== "string") return { origin: "", seq: 0 };
  const i = id.lastIndexOf(":");
  if (i <= 0) return { origin: id, seq: 0 };
  const seq = Number(id.slice(i + 1));
  return { origin: id.slice(0, i), seq: Number.isSafeInteger(seq) ? seq : 0 };
}

/** Fold order: effective_rev, then machine, then sequence as a number. Never the signer's clock. */
function byFold(a: TimelineEntry, b: TimelineEntry): number {
  const ra = revOf(a);
  const rb = revOf(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  const pa = partsOf(a?.id);
  const pb = partsOf(b?.id);
  if (pa.origin !== pb.origin) return pa.origin < pb.origin ? -1 : 1;
  return pa.seq - pb.seq;
}

function changesOf(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function boardOf(changes: Record<string, unknown> | null): string | undefined {
  const board = changes?.board;
  return typeof board === "string" && EventId.safeParse(board).success ? board : undefined;
}

/**
 * Proposed / shaped / decided for one card. `timeline` is that card's signed history (the fold's timeline).
 * `columns` are the boards' columns as they are now. A null or malformed input attributes nobody; it does not throw.
 */
export function cardProvenance(
  timeline: readonly TimelineEntry[] | null | undefined,
  columns: readonly ProvenanceColumn[] | null | undefined,
): CardProvenance {
  if (!Array.isArray(timeline) || timeline.length === 0) return { proposed: [], shaped: [], decided: [] };
  const cols = cleanColumns(columns);
  const proposed: ProvenanceAct[] = [];
  const shaped: ProvenanceAct[] = [];
  const decided: ProvenanceAct[] = [];
  const doneWrites: { done: boolean }[] = [];
  let lastWrite: { done: boolean } | null = null;
  let cardBoard: string | undefined;
  let cardColumn: string | undefined;
  const rows = timeline.slice().sort(byFold);
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.kind !== "create" && row.kind !== "op") continue;
    if (row.ignored) continue;
    if (typeof row.id !== "string" || !EventId.safeParse(row.id).success) continue;
    const author = Author.safeParse(row.author);
    if (!author.success) continue;
    const act = (field: ProvenanceAct["field"], column?: { id: string; name?: string }): ProvenanceAct => ({
      id: row.id, author: author.data, ts: row.ts, field,
      ...(column ? { columnId: column.id, ...(column.name ? { columnName: column.name } : {}) } : {}),
    });
    const changes = changesOf(row.changes);
    if (row.kind === "create") {
      const named = boardOf(changes);
      if (named) cardBoard = named;
      const column = changes?.column;
      if (typeof column === "string" && ColumnId.safeParse(column).success) cardColumn = column;
      proposed.push(act("create"));
      continue;
    }
    if (!changes) continue;
    const title = changes.title;
    if (typeof title === "string" && title.length >= 1 && title.length <= TITLE_MAX) shaped.push(act("title"));
    const body = changes.body;
    if (typeof body === "string" && body.length <= BODY_MAX) shaped.push(act("body"));
    const named = boardOf(changes);
    const columnBoard = named ?? cardBoard;
    if (named) cardBoard = named;
    const column = changes.column;
    if (typeof column === "string" && ColumnId.safeParse(column).success) {
      cardColumn = column;
      const fact = columnFact(cols, column, columnBoard);
      const columnAct = act("column", { id: column, ...(fact.name ? { name: fact.name } : {}) });
      const rec = { done: fact.done };
      lastWrite = rec;
      if (fact.done) {
        decided.push(columnAct);
        doneWrites.push(rec);
      } else shaped.push(columnAct);
      continue;
    }
    // A board write keeps the stored column. The card shows in that id when the new board has it, else in the
    // column the board shows it in. That shown column is the placement.
    if (!named || !cardColumn) continue;
    const shown = shownOnBoard(cols, cardColumn, named);
    const fact = shown ?? { ...columnFact(cols, cardColumn, cardBoard), id: cardColumn };
    const rec = { done: fact.done };
    lastWrite = rec;
    if (!fact.done) continue;
    decided.push(act("column", { id: fact.id, ...(fact.name ? { name: fact.name } : {}) }));
    doneWrites.push(rec);
  }
  const marked = decided.map((act, i) => {
    const rec = doneWrites[i];
    const decision: ProvenanceDecision = rec === lastWrite && rec?.done ? "stands" : lastWrite?.done ? "superseded" : "reopened";
    return { ...act, decision };
  });
  return { proposed, shaped, decided: marked };
}
