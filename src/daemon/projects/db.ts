// SQL for the boards (WALKIE-PROJECTS-1, migration 12): reads the accepted posts of project channels and keeps the
// folded projects and cards (board_projects, board_cards) plus an FTS5 index (board_fts) when this SQLite has FTS5.
// Everything here is derived from the event log and local: never replicated.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Event } from "../../protocol/schemas.ts";
import type { OpEvent } from "../../protocol/projects/fold.ts";
import { boardBodyFits, type CardView } from "../../protocol/projects/schema.ts";

// `+kind` / `+thread IS NULL` / `+channel` (DAEMON-STALL-1): every query here names its channel (for the project channels,
// the `p-` name range) or its rows, which bound what it reads; SQLite must not walk the kind index (every msg.post of
// every channel) or the thread index's NULL entries (every root, agent statuses included) instead.
const VISIBLE = "+kind = 'msg.post' AND redacted = 0 AND status = 'ok'";
/** Accepted, or stored in full but hidden (a rank carrier for the fold: fold.ts `hidden`). */
const STORED = "+kind = 'msg.post' AND redacted = 0 AND status IN ('ok', 'rejected')";

/** First 16 hex of sha256(signature): how an op names its parent (fold.ts). */
export function sigHash(sig: string): string {
  return createHash("sha256").update(sig).digest("hex").slice(0, 16);
}

export function opEventOf(json: string, hidden = false): OpEvent {
  const ev = JSON.parse(json) as Event;
  const b = ev.body as { thread?: unknown; text?: unknown; board?: unknown };
  return {
    id: ev.id, origin: ev.origin, seq: ev.seq, ts: ev.ts, author: ev.author,
    ...(typeof b.thread === "string" ? { thread: b.thread } : {}),
    text: typeof b.text === "string" ? b.text : "",
    // A body over MAX_BOARD_OP_BYTES is an ordinary post, never an op (isBoardOp; round-6 audit, Opus M3).
    ...(b.board !== undefined && boardBodyFits(ev.body) ? { board: b.board } : {}),
    h: sigHash(ev.sig),
    ...(hidden ? { hidden: true } : {}),
  };
}

export interface CardRow { id: string; n: number; n_proposed: number | null; root_ts: number }

export class ProjectsDb {
  /** Whether board_fts exists (this SQLite build has FTS5); search falls back to LIKE otherwise. */
  readonly fts: boolean;

  constructor(readonly db: Database) {
    let fts = false;
    try {
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS board_fts USING fts5(id UNINDEXED, channel UNINDEXED, key, title, body, labels)");
      fts = true;
    } catch { /* no FTS5 in this build */ }
    this.fts = fts;
    // A round-2 build kept per-machine key aliases here; aliases now come from the fold (round-4 audit LOW). The table
    // was created at runtime, so it is dropped the same way.
    db.exec("DROP TABLE IF EXISTS board_key_alias");
    if (fts) this.mapFtsRows();
  }

  /**
   * board_fts_rid names each card's FTS row (DAEMON-STALL-1): a card's old row is deleted by rowid, not found by a scan
   * of the whole FTS table (id is UNINDEXED) for every card saved. The map must name every FTS row and only those; an
   * older build (it deletes and inserts FTS rows by id) breaks that, and then the map is rebuilt from the FTS table, a
   * card with several rows keeping its newest (the highest rowid: FTS5 gives a new row one past the largest).
   */
  private mapFtsRows(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS board_fts_rid(id TEXT PRIMARY KEY, rid INTEGER NOT NULL)");
    const n = (sql: string) => this.db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    const stale = n("SELECT COUNT(*) AS n FROM board_fts_rid m WHERE NOT EXISTS (SELECT 1 FROM board_fts f WHERE f.rowid = m.rid)");
    if (stale === 0 && n("SELECT COUNT(*) AS n FROM board_fts") === n("SELECT COUNT(*) AS n FROM board_fts_rid")) return;
    this.db.transaction(() => {
      this.db.exec(`DELETE FROM board_fts WHERE rowid NOT IN (SELECT MAX(rowid) FROM board_fts GROUP BY id);
        DELETE FROM board_fts_rid;
        INSERT INTO board_fts_rid(id, rid) SELECT id, rowid FROM board_fts;`);
    })();
  }

  /** Deletes a card's FTS row (by the rowid the map names). */
  private dropFts(id: string): void {
    const r = this.db.query<{ rid: number }, [string]>("SELECT rid FROM board_fts_rid WHERE id = ?").get(id);
    if (!r) return;
    this.db.query("DELETE FROM board_fts WHERE rowid = ?").run(r.rid);
    this.db.query("DELETE FROM board_fts_rid WHERE id = ?").run(id);
  }

  // ---- the event log ----------------------------------------------------------------------------------------------

  /** The project's and its boards' roots and the posts in their threads (the settings entities). */
  settingsPosts(channel: string): OpEvent[] {
    return this.db.query<{ json: string; status: string }, [string, string]>(
      `SELECT json, status FROM events WHERE channel = ? AND ${STORED} AND (
         (+thread IS NULL AND json_extract(body, '$.board.op') IN ('project', 'board'))
         OR thread IN (SELECT id FROM events WHERE channel = ? AND ${VISIBLE} AND +thread IS NULL
                       AND json_extract(body, '$.board.op') IN ('project', 'board')))`,
    ).all(channel, channel).map((r) => opEventOf(r.json, r.status !== "ok"));
  }

  /**
   * A root post and every accepted post in its thread, IN THIS CHANNEL ONLY: a reply that names a root of another
   * channel (a private card's id is visible from its stub) belongs to nothing here (round-1 audit, Codex HIGH 1).
   */
  threadPosts(rootId: string, channel: string): { root: OpEvent | null; thread: OpEvent[] } {
    const rows = this.db.query<{ id: string; json: string; status: string }, [string, string, string]>(
      `SELECT id, json, status FROM events WHERE (id = ? OR thread = ?) AND +channel = ? AND ${STORED}`).all(rootId, rootId, channel);
    let root: OpEvent | null = null;
    const thread: OpEvent[] = [];
    for (const r of rows) {
      const ev = opEventOf(r.json, r.status !== "ok");
      if (r.id === rootId) root = ev; else thread.push(ev);
    }
    return { root, thread };
  }

  /** Every room op of the channel (DATA-ROOM-1), accepted or stored hidden (rank carriers), as the room fold reads them. */
  roomPosts(channel: string): OpEvent[] {
    return this.db.query<{ json: string; status: string }, [string]>(
      `SELECT json, status FROM events WHERE channel = ? AND ${STORED} AND json_extract(body, '$.board.op') = 'file'`,
    ).all(channel).map((r) => opEventOf(r.json, r.status !== "ok"));
  }

  /** Whether `share` is an accepted artifact.share of `hash` in `channel` (a room version's bytes may be served). */
  shareAccepted(share: string, hash: string, channel: string): boolean {
    return !!this.db.query(
      `SELECT 1 FROM events WHERE id = ? AND kind = 'artifact.share' AND channel = ? AND redacted = 0 AND status = 'ok'
       AND json_extract(body, '$.hash') = ?`).get(share, channel, hash);
  }

  /** Ids of the channel's card roots (posts whose board op is a card, not in a thread). */
  cardRootIds(channel: string): string[] {
    return this.db.query<{ id: string }, [string]>(
      `SELECT id FROM events WHERE channel = ? AND ${VISIBLE} AND +thread IS NULL AND json_extract(body, '$.board.op') = 'card'
       ORDER BY ts, id`).all(channel).map((r) => r.id);
  }

  /** What kind of board entity a root post of `channel` is ("project", "board", "card"), or null (not one, elsewhere). */
  rootOp(id: string, channel: string): string | null {
    const r = this.db.query<{ op: string | null }, [string, string]>(
      `SELECT json_extract(body, '$.board.op') AS op FROM events WHERE id = ? AND channel = ? AND ${VISIBLE} AND +thread IS NULL`).get(id, channel);
    return typeof r?.op === "string" ? r.op : null;
  }

  /** The newest accepted post in the channel (the project's last activity). */
  lastTs(channel: string): number {
    return this.db.query<{ t: number | null }, [string]>(
      `SELECT MAX(ts) AS t FROM events WHERE channel = ? AND ${VISIBLE}`).get(channel)?.t ?? 0;
  }

  /** Every accepted post of the channel, oldest first, as signed (the NDJSON export). */
  signedPosts(channel: string, limit: number): string[] {
    return this.db.query<{ json: string }, [string, number]>(
      `SELECT json FROM events WHERE channel = ? AND ${VISIBLE} ORDER BY ts, id LIMIT ?`).all(channel, limit).map((r) => r.json);
  }

  /**
   * Whether a post in a project-shaped channel, or any roster event (membership, privacy, roles: what the fold and the
   * views depend on), was stored after event row `rowid` (restart recovery; round-3 audit, Codex M2).
   */
  projectPostsAfter(rowid: number): boolean {
    return !!this.db.query(
      `SELECT 1 FROM events WHERE rowid > ? AND ((kind = 'msg.post' AND channel LIKE 'p-%')
       OR kind IN ('team.create','team.member','team.node','channel.upsert','team.authority','team.license','team.integration')) LIMIT 1`).get(rowid);
  }
  maxRowid(): number {
    return this.db.query<{ m: number | null }, []>("SELECT MAX(rowid) AS m FROM events").get()?.m ?? 0;
  }

  /**
   * Accepted card roots (thread IS NULL) and project roots carrying `ext.src = src`, authored by `handle`, in visible
   * project channels, oldest first (LINEAR-IMPORT-1: what this person imported before; `ext` is informational and
   * ignored by the fold, so only the importing person's own roots are trusted).
   */
  extRoots(src: string, handle: string): Array<{ id: string; channel: string; op: string; ext_id: string; ts: number }> {
    return this.db.query<{ id: string; channel: string; op: string; ext_id: string; ts: number }, [string, string]>(
      `SELECT id, channel, json_extract(body, '$.board.op') AS op, json_extract(body, '$.board.ext.id') AS ext_id, ts
       FROM events WHERE channel >= 'p-' AND channel < 'p.' AND channel LIKE 'p-%' AND ${VISIBLE} AND +thread IS NULL AND author_handle = ? AND +author_agent IS NULL
       AND json_extract(body, '$.board.op') IN ('card', 'project') AND json_extract(body, '$.board.ext.src') = ?
       AND typeof(json_extract(body, '$.board.ext.id')) = 'text' ORDER BY ts, id`).all(handle, src);
  }

  /** Accepted card roots of a channel authored by `handle`, with their signed title and body (adoption of older imports). */
  authoredCardRoots(channel: string, handle: string): Array<{ id: string; title: string; body: string }> {
    return this.db.query<{ id: string; title: string | null; body: string | null }, [string, string]>(
      `SELECT id, json_extract(body, '$.board.title') AS title, json_extract(body, '$.board.body') AS body FROM events
       WHERE channel = ? AND ${VISIBLE} AND +thread IS NULL AND author_handle = ? AND +author_agent IS NULL AND json_extract(body, '$.board.op') = 'card'
       ORDER BY ts, id`).all(channel, handle).map((r) => ({ id: r.id, title: r.title ?? "", body: r.body ?? "" }));
  }

  /** Channels that have at least one project post (startup: rebuild what was folded under another fold version). */
  projectChannels(): string[] {
    return this.db.query<{ channel: string }, []>(
      `SELECT DISTINCT channel FROM events WHERE channel >= 'p-' AND channel < 'p.' AND channel LIKE 'p-%' AND ${VISIBLE} AND +thread IS NULL
       AND json_extract(body, '$.board.op') = 'project'`).all().map((r) => r.channel);
  }

  // ---- folded projects --------------------------------------------------------------------------------------------

  /** Bumped by every write to board_projects (a cache of what the views say, e.g. the status scrub's prefixes, checks it). */
  get revision(): number { return this.rev; }
  private rev = 0;

  saveProject(channel: string, rootId: string | null, json: string | null, lastTs: number): void {
    this.rev++;
    this.db.query(`INSERT INTO board_projects(channel, root_id, json, last_ts, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(channel) DO UPDATE SET root_id = excluded.root_id, json = excluded.json, last_ts = excluded.last_ts,
      updated_at = excluded.updated_at`).run(channel, rootId, json, lastTs, Date.now());
  }
  projectJson(channel: string): string | null {
    return this.db.query<{ json: string | null }, [string]>("SELECT json FROM board_projects WHERE channel = ?").get(channel)?.json ?? null;
  }
  allProjectJson(): Array<{ channel: string; json: string }> {
    return this.db.query<{ channel: string; json: string }, []>(
      "SELECT channel, json FROM board_projects WHERE json IS NOT NULL ORDER BY channel").all();
  }

  // ---- folded cards -----------------------------------------------------------------------------------------------

  saveCard(c: CardView, nProposed: number | null, rootTs: number): void {
    this.db.query(`INSERT INTO board_cards(id, channel, board, n, n_proposed, root_ts, state, column_id, assignee, updated_ts, json, short)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, board = excluded.board,
      n = excluded.n, n_proposed = excluded.n_proposed, root_ts = excluded.root_ts, state = excluded.state,
      column_id = excluded.column_id, assignee = excluded.assignee, updated_ts = excluded.updated_ts, json = excluded.json,
      short = excluded.short`).run(
      c.id, c.channel, c.board, c.n, nProposed, rootTs, c.state, c.column, c.assignee, c.updated_at, JSON.stringify(c), c.short);
    // Every number a card holds on this node is remembered: a bare key it held before stays ambiguous (Codex r6 M3).
    this.db.query("INSERT OR IGNORE INTO board_key_history(channel, n, id) VALUES (?,?,?)").run(c.channel, c.n, c.id);
    if (!this.fts) return;
    this.dropFts(c.id);
    if (c.state !== "deleted") {
      const rid = this.db.query("INSERT INTO board_fts(id, channel, key, title, body, labels) VALUES (?,?,?,?,?,?)").run(
        c.id, c.channel, c.key, c.title, c.body, c.labels.join(" ")).lastInsertRowid;
      this.db.query("INSERT INTO board_fts_rid(id, rid) VALUES (?, ?)").run(c.id, Number(rid));
    }
  }
  deleteCard(id: string): void {
    this.db.query("DELETE FROM board_cards WHERE id = ?").run(id);
    if (this.fts) this.dropFts(id);
  }
  card(id: string): CardView | null {
    const r = this.db.query<{ json: string }, [string]>("SELECT json FROM board_cards WHERE id = ?").get(id);
    return r ? (JSON.parse(r.json) as CardView) : null;
  }
  /** The card holding key number n now. */
  cardByN(channel: string, n: number): CardView | null {
    const r = this.db.query<{ json: string }, [string, number]>("SELECT json FROM board_cards WHERE channel = ? AND n = ?").get(channel, n);
    return r ? (JSON.parse(r.json) as CardView) : null;
  }
  /**
   * Every card a bare key number could mean: the one holding it now, any that proposed it, and any that held it on this
   * node before (board_key_history). More than one: the key alone is ambiguous.
   */
  keyCandidates(channel: string, n: number): CardView[] {
    return this.db.query<{ json: string }, [string, number, number, string, number]>(
      `SELECT json FROM board_cards WHERE channel = ? AND (n = ? OR n_proposed = ?
         OR id IN (SELECT id FROM board_key_history WHERE channel = ? AND n = ?)) ORDER BY root_ts, id`)
      .all(channel, n, n, channel, n).map((r) => JSON.parse(r.json) as CardView);
  }
  /** Cards (any project) with this short id. */
  cardsByShort(short: string): CardView[] {
    return this.db.query<{ json: string }, [string]>("SELECT json FROM board_cards WHERE short = ? ORDER BY root_ts, id")
      .all(short).map((r) => JSON.parse(r.json) as CardView);
  }
  hasCardN(channel: string, n: number): boolean {
    return !!this.db.query("SELECT 1 FROM board_cards WHERE channel = ? AND n = ? AND state != 'deleted'").get(channel, n);
  }
  cardRows(channel: string): CardRow[] {
    return this.db.query<CardRow, [string]>("SELECT id, n, n_proposed, root_ts FROM board_cards WHERE channel = ?").all(channel);
  }
  maxN(channel: string): number {
    return this.db.query<{ m: number | null }, [string]>("SELECT MAX(n) AS m FROM board_cards WHERE channel = ?").get(channel)?.m ?? 0;
  }
  cards(channel: string, opts: { board?: string; states?: readonly string[]; limit: number }): CardView[] {
    const where = ["channel = ?"];
    const args: (string | number)[] = [channel];
    if (opts.board) { where.push("board = ?"); args.push(opts.board); }
    if (opts.states?.length) { where.push(`state IN (${opts.states.map(() => "?").join(",")})`); args.push(...opts.states); }
    args.push(opts.limit);
    return this.db.query<{ json: string }, (string | number)[]>(
      `SELECT json FROM board_cards WHERE ${where.join(" AND ")} ORDER BY board, column_id, n LIMIT ?`).all(...args)
      .map((r) => JSON.parse(r.json) as CardView);
  }
  /** Per board, column and state: how many cards and how many points (an estimate, else 1). */
  meterGroups(channel: string): Array<{ board: string; column_id: string; state: string; n: number; pts: number }> {
    return this.db.query<{ board: string; column_id: string; state: string; n: number; pts: number }, [string]>(
      `SELECT board, column_id, state, COUNT(*) AS n, SUM(COALESCE(json_extract(json, '$.estimate'), 1)) AS pts
       FROM board_cards WHERE channel = ? GROUP BY board, column_id, state`).all(channel);
  }
  countCards(channel: string, opts: { board?: string; live?: boolean } = {}): number {
    const where = ["channel = ?"];
    const args: string[] = [channel];
    if (opts.board) { where.push("board = ?"); args.push(opts.board); }
    if (opts.live) where.push("state = 'open'");
    return this.db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM board_cards WHERE ${where.join(" AND ")}`).get(...args)?.n ?? 0;
  }
  deleteChannel(channel: string): void {
    this.rev++;
    this.db.query("DELETE FROM board_cards WHERE channel = ?").run(channel);
    this.db.query("DELETE FROM board_projects WHERE channel = ?").run(channel);
    if (!this.fts) return;
    this.db.query("DELETE FROM board_fts WHERE channel = ?").run(channel); // rare (a channel stops being a project): one scan
    this.db.query("DELETE FROM board_fts_rid WHERE NOT EXISTS (SELECT 1 FROM board_fts f WHERE f.rowid = board_fts_rid.rid)").run();
  }

  /** Card ids matching `q` in these channels, best first (FTS5), or by substring without FTS5. */
  search(q: string, channels: readonly string[], limit: number): string[] {
    if (!channels.length) return [];
    const inCh = channels.map(() => "?").join(",");
    if (this.fts) {
      const terms = q.split(/\s+/).map((t) => t.replace(/["*^:(){}]/g, "")).filter(Boolean).map((t) => `"${t}"*`);
      if (!terms.length) return [];
      try {
        return this.db.query<{ id: string }, (string | number)[]>(
          `SELECT id FROM board_fts WHERE board_fts MATCH ? AND channel IN (${inCh}) ORDER BY rank LIMIT ?`).all(terms.join(" "), ...channels, limit).map((r) => r.id);
      } catch { /* a query FTS5 can't parse: fall through to LIKE */ }
    }
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    return this.db.query<{ id: string }, (string | number)[]>(
      `SELECT id FROM board_cards WHERE channel IN (${inCh}) AND state != 'deleted' AND
       (json_extract(json, '$.title') LIKE ? ESCAPE '\\' OR json_extract(json, '$.key') LIKE ? ESCAPE '\\' OR json_extract(json, '$.body') LIKE ? ESCAPE '\\')
       ORDER BY updated_ts DESC LIMIT ?`).all(...channels, like, like, like, limit).map((r) => r.id);
  }
}
