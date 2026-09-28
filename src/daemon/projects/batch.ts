// Board ops batch (LINEAR-IMPORT-1, PROTOCOL §10 "Bulk writes"): many card writes of one project, validated first and
// then signed as consecutive ordinary board ops inside ONE store transaction (all of them are in the log, or none).
// People only, and paid for from the import budget (RateLimits.importWrite, one token per op), never the interactive
// limiter. The fold is unchanged: every post is the card root / card op / comment a person makes by hand.
import { cardOpText } from "../../protocol/projects/format.ts";
import { spreadKeys } from "../../protocol/projects/position.ts";
import type { BatchOpT, BatchResult } from "../../protocol/projects/batch.ts";
import {
  boardBodyFits, CardOp, MAX_BOARD_OP_BYTES, MAX_CARDS_PER_PROJECT, MAX_LIVE_CARDS_PER_BOARD,
  type BoardView, type CardView, type Column, type ProjectView,
} from "../../protocol/projects/schema.ts";
import type { BodyOf, Event } from "../../protocol/schemas.ts";
import { HttpError } from "../http.ts";
import { IMPORT_WRITE_LIMIT, type BucketSpec } from "../ratelimit.ts";
import { boardOf, clean, columnOf, positionIn, requirePerson, visibleProject, type WriteCtx } from "./service.ts";

/** One signed post the batch will make. */
interface Planned {
  i: number;
  kind: "create" | "update" | "comment";
  /** Absent: an update that changes nothing (reported, never signed). */
  body?: BodyOf<"msg.post">;
  /** Comment on a card created earlier in this batch (resolved to its id once signed). */
  threadRef?: number;
  /** For results: the card's id (update, comment on an existing card) or proposed key (create). */
  card?: string; key?: string;
}

function opError(i: number, message: string, status = 400, code = "invalid"): HttpError {
  return new HttpError(status, code, `op ${i}: ${message}`);
}

/** The post body for a board op: the readable text gives way before the op is refused (like service.ts `post`). */
function opBody(i: number, text: string, board: Record<string, unknown> | null, thread?: string): BodyOf<"msg.post"> {
  const make = (t: string) => ({ text: t || "board update", ...(board ? { board } : {}), ...(thread ? { thread } : {}) } as BodyOf<"msg.post">);
  let body = make(text.slice(0, 32_000));
  if (board && !boardBodyFits(body)) body = make(text.slice(0, 200));
  if (board && !boardBodyFits(body)) throw opError(i, `a board op is at most ${MAX_BOARD_OP_BYTES / 1024} KB (description included); shorten it`, 413, "too_large");
  return body;
}

/** Budget key: a paired phone has its own (like limitWrite); everything else of this person shares one. */
export function importBudgetKey(rateKey: string | undefined): string {
  return `import:${rateKey ?? "human"}`;
}

/**
 * Validates every op (fields, the project's caps counting the batch, the 16 KB board-op cap), takes the batch's
 * tokens from the import budget, then signs the posts in one transaction. Throws before signing anything.
 */
export function applyBatch(w: WriteCtx, channel: string, ops: readonly BatchOpT[], opts: { budgetKey: string; spec?: BucketSpec } = { budgetKey: importBudgetKey(undefined) }): BatchResult {
  requirePerson(w, "bulk board writes (an import)");
  w.idx.flushAll(); // fold what arrived first: numbers and positions build on it
  const p = visibleProject(w, channel);
  if (p.state !== "active") throw new HttpError(409, "conflict", `project ${p.name} is ${p.state}`);
  const planned = plan(w, p, ops);

  const spec = opts.spec ?? w.core.limits.importWrite ?? IMPORT_WRITE_LIMIT;
  const now = Date.now();
  if (!w.core.limiter.take(opts.budgetKey, spec, now, ops.length)) {
    const missing = ops.length - w.core.limiter.available(opts.budgetKey, spec, now);
    const retry = Math.max(1, Math.ceil(missing / spec.perSecond));
    throw new HttpError(429, "rate_limited", `the import budget is used up for now (${Math.floor(spec.capacity)} board writes, refilled ${Math.round(spec.perSecond * 3600)} per hour); retry in ${retry} s`, { retry_after_s: retry });
  }

  const result: BatchResult = { created: [], updated: [], unchanged: [], comments: [], events: 0 };
  const createdIds = new Map<number, string>();
  const seqBefore = w.core.store.allocatedSelfSeq(w.core.nodeId);
  try {
    w.core.store.transaction(() => {
      for (const x of planned) {
        if (!x.body) { result.unchanged.push({ i: x.i, id: x.card as string, key: x.key as string }); continue; }
        const thread = x.threadRef !== undefined ? createdIds.get(x.threadRef) : undefined;
        const body = thread ? { ...x.body, thread } as BodyOf<"msg.post"> : x.body;
        const ev: Event = w.core.emit("msg.post", body, { channel });
        result.events++;
        if (x.kind === "create") { createdIds.set(x.i, ev.id); result.created.push({ i: x.i, id: ev.id, key: x.key as string }); }
        else if (x.kind === "update") result.updated.push({ i: x.i, id: x.card as string, key: x.key as string });
        else result.comments.push({ i: x.i, id: ev.id, card: thread ?? (x.card as string) });
      }
    }, { durable: true });
  } catch (err) {
    // A notification can throw AFTER commit; only a real rollback refunds signed writes.
    if (w.core.store.allocatedSelfSeq(w.core.nodeId) === seqBefore) w.core.limiter.refund(opts.budgetKey, spec, ops.length);
    throw err;
  }
  w.idx.flushAll();
  // Keys as folded (a concurrent creation elsewhere may have renumbered one).
  for (const c of [...result.created, ...result.updated]) c.key = w.idx.db.card(c.id)?.key ?? c.key;
  return result;
}

/** Every op checked and turned into its post, in order; nothing signed. */
function plan(w: WriteCtx, p: ProjectView, ops: readonly BatchOpT[]): Planned[] {
  const out: Planned[] = [];
  const liveAdded = new Map<string, number>();
  let added = 0;
  let n = w.idx.db.maxN(p.channel);
  const updated = new Set<string>();
  // Positions: the creates of each (board, column) are spread after the column's last open card, in batch order.
  const creates = new Map<string, number[]>();
  const resolved: Array<{ b: BoardView; col: Column } | null> = ops.map((op, i) => {
    if (op.op !== "create") return null;
    const b = boardOf(p, op.board);
    if (b.state !== "active") throw opError(i, `board ${b.name} is archived`, 409, "conflict");
    const col = columnRef(b, op.column, i);
    const k = `${b.id}\n${col.id}`;
    creates.set(k, [...(creates.get(k) ?? []), i]);
    return { b, col };
  });
  const positions = new Map<number, string>();
  for (const [k, idxs] of creates) {
    const [board, column] = k.split("\n") as [string, string];
    const last = w.idx.db.cards(p.channel, { board, states: ["open"], limit: MAX_LIVE_CARDS_PER_BOARD })
      .filter((c) => c.column === column).map((c) => c.pos).sort().pop() ?? null;
    const keys = spreadKeys(last, null, idxs.length);
    idxs.forEach((i, j) => positions.set(i, keys[j] as string));
  }

  ops.forEach((op, i) => {
    if (op.op === "create") {
      const { b, col } = resolved[i] as { b: BoardView; col: Column };
      added++;
      if (p.cards + added > MAX_CARDS_PER_PROJECT) throw opError(i, `a project holds at most ${MAX_CARDS_PER_PROJECT} cards`, 409, "card_limit");
      if ((op.state ?? "open") === "open") {
        const live = (liveAdded.get(b.id) ?? 0) + 1;
        liveAdded.set(b.id, live);
        if (b.live_cards + live > MAX_LIVE_CARDS_PER_BOARD) throw opError(i, `board ${b.name} holds at most ${MAX_LIVE_CARDS_PER_BOARD} open cards`, 409, "card_limit");
      }
      n++;
      const title = clean(w, op.title);
      const board: Record<string, unknown> = {
        v: 1, rev: 0, op: "card", board: b.id, title, column: col.id, pos: positions.get(i) as string, n,
        ...(op.body ? { body: clean(w, op.body) } : {}), ...(op.assignee ? { assignee: op.assignee } : {}),
        ...(op.labels?.length ? { labels: op.labels.map((l) => clean(w, l)) } : {}),
        ...(op.estimate !== undefined && op.estimate !== null ? { estimate: op.estimate } : {}), ...(op.due ? { due: op.due } : {}),
        ...(op.state === "archived" ? { state: "archived" } : {}), ...(op.ext ? { ext: op.ext } : {}),
      };
      if (!CardOp.safeParse(board).success) throw opError(i, "a field is out of range (key number, title, labels…)");
      const key = `${p.prefix}-${n}`;
      out.push({ i, kind: "create", key, body: opBody(i, `New card ${key}: ${title}`, board) });
      return;
    }
    if (op.op === "update") {
      const card = cardIn(w, p, op.card, i);
      if (updated.has(card.id)) throw opError(i, `card ${card.key} is updated twice in one batch`);
      updated.add(card.id);
      const b = boardOf(p, card.board);
      const col = op.column !== undefined ? columnRef(b, op.column, i) : undefined;
      const moves = col !== undefined && col.id !== card.column;
      const fields: Record<string, unknown> = {
        ...(op.title !== undefined ? { title: clean(w, op.title) } : {}),
        ...(op.body !== undefined ? { body: clean(w, op.body) } : {}),
        ...(moves ? { board: b.id, column: (col as Column).id, pos: positionIn(w, p, b.id, (col as Column).id, { self: card.id }) } : {}),
        ...(op.assignee !== undefined ? { assignee: op.assignee } : {}),
        ...(op.labels !== undefined ? { labels: op.labels.map((l) => clean(w, l)) } : {}),
        ...(op.estimate !== undefined ? { estimate: op.estimate } : {}),
        ...(op.due !== undefined ? { due: op.due } : {}),
        ...(op.state !== undefined && op.state !== card.state ? { state: op.state } : {}),
      };
      if (card.state === "deleted") throw opError(i, `card ${card.key} is deleted`, 409, "conflict");
      // Reopening counts toward the board's open cards like a create (archiving earlier in the batch frees a place).
      if (fields.state === "open" || fields.state === "archived") {
        const live = (liveAdded.get(b.id) ?? 0) + (fields.state === "open" ? 1 : -1);
        liveAdded.set(b.id, live);
        if (fields.state === "open" && b.live_cards + live > MAX_LIVE_CARDS_PER_BOARD) {
          throw opError(i, `board ${b.name} holds at most ${MAX_LIVE_CARDS_PER_BOARD} open cards (reopening ${card.key})`, 409, "card_limit");
        }
      }
      if (!Object.keys(fields).length) { out.push({ i, kind: "update", card: card.id, key: card.key }); return; }
      const folded = w.idx.foldCardNow(p.channel, card.id);
      const headOrigin = folded?.state.head.split(":")[0];
      const rev = (folded?.state.rev ?? card.rev) + (headOrigin === w.core.nodeId && folded?.state.head !== card.id && !folded?.state.head.startsWith(`${card.id}#`) ? 0 : 1);
      const board = { v: 1, rev, op: "card", ...(folded ? { after: folded.state.head } : {}), ...fields };
      if (!CardOp.safeParse(board).success) throw opError(i, "a field is out of range");
      out.push({ i, kind: "update", card: card.id, key: card.key, body: opBody(i, cardOpText(card.key, card.title, fields, b.columns), board, card.id) });
      return;
    }
    const text = clean(w, op.text);
    if (op.card.startsWith("#")) {
      const ref = Number(op.card.slice(1));
      if (!(ref < i) || ops[ref]?.op !== "create") throw opError(i, `${op.card} is not a card created earlier in this batch`);
      out.push({ i, kind: "comment", threadRef: ref, body: opBody(i, text, null) });
      return;
    }
    const card = cardIn(w, p, op.card, i);
    out.push({ i, kind: "comment", card: card.id, body: opBody(i, text, null, card.id) });
  });
  return out;
}

function columnRef(b: BoardView, ref: string, i: number): Column {
  try {
    return columnOf(b, ref);
  } catch (err) {
    throw opError(i, err instanceof HttpError ? err.message : `no column ${ref}`);
  }
}

function cardIn(w: WriteCtx, p: ProjectView, id: string, i: number): CardView {
  const card = w.idx.db.card(id);
  if (!card || card.channel !== p.channel) throw opError(i, `no card ${id} in project ${p.prefix}`, 404, "not_found");
  return card;
}
