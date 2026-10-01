// SQLite (WAL) persistence: events, version vector, pending, agents, blobs, joins.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { OrchMessage } from "../protocol/orchestrator.ts";
import type { Event, Stub } from "../protocol/schemas.ts";
import { isBoardOp } from "../protocol/projects/schema.ts";
import { indexedClaim } from "./orchestrator/schedule-claims.ts";

const ROSTER_KIND_SQL = "('team.create','team.member','team.node','channel.upsert','team.authority','team.license','team.integration')";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE events(
     id TEXT PRIMARY KEY, origin TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER, kind TEXT, channel TEXT,
     thread TEXT, author_handle TEXT, author_agent TEXT, body TEXT, sig TEXT,
     redacted INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ok', reason TEXT,
     json TEXT NOT NULL, received_at INTEGER NOT NULL, UNIQUE(origin, seq));
   CREATE INDEX events_channel_ts ON events(channel, ts);
   CREATE INDEX events_kind_ts ON events(kind, ts);
   CREATE INDEX events_thread ON events(thread);
   CREATE INDEX events_ts ON events(ts);
   CREATE TABLE vv(origin TEXT PRIMARY KEY, seq INTEGER NOT NULL);
   CREATE TABLE pending(id TEXT PRIMARY KEY, origin TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL,
     reason TEXT NOT NULL, received_at INTEGER NOT NULL);
   CREATE TABLE agents_latest(node TEXT NOT NULL, agent TEXT NOT NULL, handle TEXT NOT NULL, event_id TEXT NOT NULL,
     ts INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(node, agent));
   CREATE TABLE blobs(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT, name TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE blob_refs(hash TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(hash, event_id));
   CREATE TABLE conflicts(id TEXT NOT NULL, origin TEXT NOT NULL, detected_at INTEGER NOT NULL);
   CREATE INDEX conflicts_origin ON conflicts(origin);
   CREATE TABLE join_requests(node_id TEXT PRIMARY KEY, login TEXT NOT NULL, pubkey TEXT NOT NULL,
     hostname TEXT NOT NULL, ip TEXT NOT NULL, port INTEGER NOT NULL, requested_at INTEGER NOT NULL);`,
  // 2: exactly-once delivery of asks/mentions to a local agent (hooks + MCP push race for the same event)
  `CREATE TABLE deliveries(agent TEXT NOT NULL, event_id TEXT NOT NULL, delivered_at INTEGER NOT NULL, PRIMARY KEY(agent, event_id));`,
  // 3: re-validation by status/origin (hidden cap, D1) and stub fill by channel (D4)
  `CREATE INDEX events_status_origin ON events(status, origin);
   CREATE INDEX events_redacted_channel ON events(redacted, channel);`,
  // 4: roster authority requests (queued here / applied log on the authority), blob provenance, stub fill state
  `CREATE TABLE roster_requests(id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
   CREATE TABLE roster_request_log(id TEXT PRIMARY KEY, event_id TEXT, applied_at INTEGER NOT NULL);
   CREATE TABLE blob_provenance(channel TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(channel, hash));
   CREATE TABLE stub_fill(id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, last_try INTEGER NOT NULL);`,
  // 5 (FIX-3): pending indexed by dependency with byte accounting per relay/origin (F3); stub fill
  // attempts per (stub, peer) (C4). Old pending rows carry no dependency: they are re-pulled.
  `DELETE FROM pending;
   ALTER TABLE pending ADD COLUMN dep TEXT NOT NULL DEFAULT '';
   ALTER TABLE pending ADD COLUMN relay TEXT;
   ALTER TABLE pending ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX pending_dep ON pending(dep, ts, id);
   CREATE INDEX pending_relay ON pending(relay, bytes);
   CREATE INDEX pending_origin ON pending(origin, bytes);
   DROP TABLE stub_fill;
   CREATE TABLE stub_fill(id TEXT NOT NULL, peer TEXT NOT NULL, attempts INTEGER NOT NULL, last_try INTEGER NOT NULL,
     PRIMARY KEY(id, peer));
   CREATE INDEX events_thread_kind ON events(thread, kind);`,
  // 6 (FIX-4): held rows of one origin in (ts, id) order, re-ingested when that origin's roster changes (F2).
  `CREATE INDEX pending_origin_ts ON pending(origin, ts, id);`,
  // 7 (integrations, local only, never replicated): connector state + cursor, external-id dedup, Linear caches.
  `CREATE TABLE integration_state(connector TEXT PRIMARY KEY, cursor TEXT, last_run INTEGER, last_ok INTEGER,
     last_error TEXT, items_posted INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, next_run INTEGER);
   CREATE TABLE integration_items(connector TEXT NOT NULL, external_id TEXT NOT NULL, event_id TEXT,
     created_at INTEGER NOT NULL, PRIMARY KEY(connector, external_id));
   CREATE TABLE linear_issues(key TEXT PRIMARY KEY, json TEXT, fetched_at INTEGER NOT NULL);
   CREATE TABLE linear_snapshots(issue_id TEXT PRIMARY KEY, key TEXT NOT NULL, state_id TEXT NOT NULL,
     state_name TEXT NOT NULL, updated_at TEXT NOT NULL, seen_at INTEGER NOT NULL);
   CREATE INDEX events_author_agent_ts ON events(author_agent, ts);`,
  // 8 (INTEGRATIONS-FIX-1): dedup rows carry a state (claimed → posted) with a claim time, and the
  // post/share events they produced, so a crashed run is retried and a half-done item is completed
  // instead of re-posted. Old rows without an event were claims (or skips) of runs that may have
  // crashed: they become stale claims, retried once. Pending unfurls are persisted with their backoff.
  `ALTER TABLE integration_items ADD COLUMN state TEXT NOT NULL DEFAULT 'posted';
   ALTER TABLE integration_items ADD COLUMN claimed_at INTEGER;
   ALTER TABLE integration_items ADD COLUMN share_id TEXT;
   UPDATE integration_items SET state = 'claimed', claimed_at = 0 WHERE event_id IS NULL;
   CREATE TABLE integration_retries(connector TEXT NOT NULL, external_id TEXT NOT NULL, payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
     PRIMARY KEY(connector, external_id));
   CREATE INDEX integration_retries_due ON integration_retries(connector, next_at);`,
  // 9 (INTEGRATIONS-FIX-2, Fable F5): migration 8 turned every pre-FIX-1 row without an event into a
  // stale claim, but such a row was a DELIBERATE skip as often as a crashed claim, and a skip must never
  // be retried (a re-post). Only migration 8 produced claimed rows with claimed_at = 0 and no event
  // (release() deletes those; a live claim carries its time): they are marked posted (skipped) again.
  `UPDATE integration_items SET state = 'posted', claimed_at = NULL WHERE state = 'claimed' AND claimed_at = 0 AND event_id IS NULL;`,
  // 10 (WALKIE-MISSION-1 fix 5): where the text of each own agent's latest status came from (never signed), one row per
  // agent, pruned with the Agent archive. Replaces the round-3 meta blob that was rewritten whole per status.
  // Round 6 (Codex r5 #4): the round-3 blob's entries ({agent: {id, p}}) are carried over before it is deleted, so a
  // person's / agent's title keeps its provenance through the upgrade.
  `CREATE TABLE status_provenance(agent TEXT PRIMARY KEY, event_id TEXT NOT NULL, prov TEXT NOT NULL);
   INSERT OR REPLACE INTO status_provenance(agent, event_id, prov)
     SELECT j.key, json_extract(j.value, '$.id'), COALESCE(json(json_extract(j.value, '$.p')), '{}')
     FROM json_each(COALESCE((SELECT value FROM meta WHERE key = 'status_prov' AND json_valid(value)), '{}')) AS j
     WHERE json_type(j.value) = 'object' AND json_type(j.value, '$.id') = 'text'
       AND (json_type(j.value, '$.p') IS NULL OR json_type(j.value, '$.p') = 'object');
   DELETE FROM meta WHERE key = 'status_prov';`,
  // 11 (ORCH-FIX-12): this machine's local orchestrator conversation (PROTOCOL §9). Never an event, never replicated
  // or served to a peer.
  `CREATE TABLE orch_messages(id TEXT PRIMARY KEY, thread TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL,
     via TEXT, state TEXT, tools TEXT, reply_to TEXT);
   CREATE INDEX orch_messages_thread ON orch_messages(thread, ts);
   CREATE INDEX orch_messages_ts ON orch_messages(ts);`,
  // 12 (WALKIE-PROJECTS-1; 11 on its lane, renumbered after orch_messages at the pre.4 merge): the boards folded
  // from project channels' posts (src/daemon/projects/). Local, derived, never replicated: rebuilt from the event log whenever the fold changes (meta `projects_fold`). Plus the board-op
  // hidden-row bounds (round-6 audits): `bop` = a board op (isBoardOp, a function of the event), `fin` = its rejection
  // is final (anchored); board_hidden keeps, per origin per project channel, the count of final hidden board ops and
  // the bytes of curable ones, maintained by triggers so no ingest scans (Opus r6 M-H2).
  `CREATE TABLE board_projects(channel TEXT PRIMARY KEY, root_id TEXT, json TEXT, last_ts INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL);
   CREATE TABLE board_cards(id TEXT PRIMARY KEY, channel TEXT NOT NULL, board TEXT NOT NULL, n INTEGER NOT NULL,
     n_proposed INTEGER, root_ts INTEGER NOT NULL, state TEXT NOT NULL, column_id TEXT NOT NULL, assignee TEXT,
     updated_ts INTEGER NOT NULL, json TEXT NOT NULL);
   CREATE INDEX board_cards_channel ON board_cards(channel, board, state);
   CREATE INDEX board_cards_key ON board_cards(channel, n);
   ALTER TABLE board_cards ADD COLUMN short TEXT;
   CREATE INDEX board_cards_short ON board_cards(short);
   CREATE TABLE board_key_history(channel TEXT NOT NULL, n INTEGER NOT NULL, id TEXT NOT NULL, PRIMARY KEY(channel, n, id));
   ALTER TABLE events ADD COLUMN bop INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE events ADD COLUMN fin INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE board_hidden(origin TEXT NOT NULL, channel TEXT NOT NULL, final_n INTEGER NOT NULL DEFAULT 0,
     curable_bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(origin, channel));
   CREATE TRIGGER events_bh_ins AFTER INSERT ON events WHEN NEW.bop = 1 AND NEW.status = 'rejected' AND NEW.redacted = 0 BEGIN
     INSERT INTO board_hidden(origin, channel, final_n, curable_bytes)
       VALUES (NEW.origin, NEW.channel, NEW.fin, (1 - NEW.fin) * length(CAST(NEW.json AS BLOB)))
       ON CONFLICT(origin, channel) DO UPDATE SET final_n = final_n + excluded.final_n, curable_bytes = curable_bytes + excluded.curable_bytes;
   END;
   CREATE TRIGGER events_bh_del AFTER DELETE ON events WHEN OLD.bop = 1 AND OLD.status = 'rejected' AND OLD.redacted = 0 BEGIN
     UPDATE board_hidden SET final_n = final_n - OLD.fin, curable_bytes = curable_bytes - (1 - OLD.fin) * length(CAST(OLD.json AS BLOB))
       WHERE origin = OLD.origin AND channel = OLD.channel;
   END;
   CREATE TRIGGER events_bh_upd_old AFTER UPDATE ON events WHEN OLD.bop = 1 AND OLD.status = 'rejected' AND OLD.redacted = 0 BEGIN
     UPDATE board_hidden SET final_n = final_n - OLD.fin, curable_bytes = curable_bytes - (1 - OLD.fin) * length(CAST(OLD.json AS BLOB))
       WHERE origin = OLD.origin AND channel = OLD.channel;
   END;
   CREATE TRIGGER events_bh_upd_new AFTER UPDATE ON events WHEN NEW.bop = 1 AND NEW.status = 'rejected' AND NEW.redacted = 0 BEGIN
     INSERT INTO board_hidden(origin, channel, final_n, curable_bytes)
       VALUES (NEW.origin, NEW.channel, NEW.fin, (1 - NEW.fin) * length(CAST(NEW.json AS BLOB)))
       ON CONFLICT(origin, channel) DO UPDATE SET final_n = final_n + excluded.final_n, curable_bytes = curable_bytes + excluded.curable_bytes;
   END;
   CREATE INDEX events_board_final ON events(origin, channel, seq) WHERE bop = 1 AND fin = 1 AND status = 'rejected' AND redacted = 0;
   CREATE INDEX events_board_curable ON events(origin, seq) WHERE bop = 1 AND fin = 0 AND status = 'rejected' AND redacted = 0;
   CREATE INDEX events_hidden_general ON events(origin, seq) WHERE status = 'rejected' AND redacted = 0 AND bop = 0;`,
  // (The FTS5 search table board_fts is created by src/daemon/projects/store.ts when the SQLite build has FTS5; search
  // falls back to LIKE without it, so a build without FTS5 still starts.)
  // 13 (DAEMON-STALL-1): indexes the query planner can't misuse. The store has no statistics, and SQLite picked
  // events_redacted_channel (redacted, channel) for any `redacted = 0` filter: a thread's replies, an events page without a
  // channel, the roster walk and blob references each walked every row (94% of them agent.status) in rowid order with a
  // table seek per row, the multi-second sqlite3_step that stopped a daemon answering on a busy disk. The two indexes
  // led by a column nearly every row shares (redacted, status) become partial indexes over the few rows that differ. The
  // roster walk, an origin's newest ts (every emit) and a channel's visible rows get their own indexes, partial where a
  // general index would attract other queries (events_origin_ts serves only a query that says `ts IS NOT NULL`;
  // events_visible_channel carries redacted and status so the per-channel counts read the index alone).
  // agents_latest remembers when its event was received (recv_id says for which event: an older build that updates the
  // row leaves it naming the old one), so a roster read no longer seeks one events row per agent. Local, never replicated.
  `DROP INDEX IF EXISTS events_redacted_channel;
   DROP INDEX IF EXISTS events_status_origin;
   CREATE INDEX IF NOT EXISTS events_stub_origin ON events(origin, seq) WHERE redacted = 1;
   CREATE INDEX IF NOT EXISTS events_stub_channel ON events(channel) WHERE redacted = 1;
   CREATE INDEX IF NOT EXISTS events_rejected ON events(origin, kind) WHERE status = 'rejected';
   CREATE INDEX IF NOT EXISTS events_visible_channel ON events(channel, ts, redacted, status) WHERE channel IS NOT NULL AND redacted = 0 AND status = 'ok';
   CREATE INDEX IF NOT EXISTS events_origin_ts ON events(origin, ts) WHERE ts IS NOT NULL;
   CREATE INDEX IF NOT EXISTS events_roster ON events(origin, seq) WHERE kind IN ${ROSTER_KIND_SQL};`,
  // 14: local-only lookup for bounded schedule-claim seeding. No event or wire format changes.
  `ALTER TABLE events ADD COLUMN claim_schedule TEXT;
   ALTER TABLE events ADD COLUMN claim_at INTEGER;
   ALTER TABLE events ADD COLUMN claim_term INTEGER;
   ALTER TABLE events ADD COLUMN claim_after TEXT;
   CREATE INDEX events_claim_latest ON events(claim_schedule, claim_term DESC, seq DESC)
     WHERE claim_schedule IS NOT NULL AND redacted = 0 AND status = 'ok';`,
  // 15: constant-cost schedule channel revision check for the schedule fold.
  `INSERT OR REPLACE INTO meta(key, value) SELECT 'schedule_channel_count', CAST(COUNT(*) AS TEXT) FROM events
     WHERE channel = 'talkie-schedules' AND kind = 'msg.post' AND redacted = 0 AND status = 'ok';
   CREATE TRIGGER IF NOT EXISTS schedule_count_insert AFTER INSERT ON events
     WHEN NEW.channel = 'talkie-schedules' AND NEW.kind = 'msg.post' AND NEW.redacted = 0 AND NEW.status = 'ok'
     BEGIN UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schedule_channel_count'; END;
   CREATE TRIGGER IF NOT EXISTS schedule_count_delete AFTER DELETE ON events
     WHEN OLD.channel = 'talkie-schedules' AND OLD.kind = 'msg.post' AND OLD.redacted = 0 AND OLD.status = 'ok'
     BEGIN UPDATE meta SET value = CAST(CAST(value AS INTEGER) - 1 AS TEXT) WHERE key = 'schedule_channel_count'; END;
   CREATE TRIGGER IF NOT EXISTS schedule_count_update_old AFTER UPDATE ON events
     WHEN OLD.channel = 'talkie-schedules' AND OLD.kind = 'msg.post' AND OLD.redacted = 0 AND OLD.status = 'ok'
     BEGIN UPDATE meta SET value = CAST(CAST(value AS INTEGER) - 1 AS TEXT) WHERE key = 'schedule_channel_count'; END;
   CREATE TRIGGER IF NOT EXISTS schedule_count_update_new AFTER UPDATE ON events
     WHEN NEW.channel = 'talkie-schedules' AND NEW.kind = 'msg.post' AND NEW.redacted = 0 AND NEW.status = 'ok'
     BEGIN UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schedule_channel_count'; END;`,
  // 16: Hermes hook observations are local daemon state. They are never replicated; only the derived agent status is signed.
  `CREATE TABLE hermes_sessions(profile TEXT NOT NULL, session TEXT NOT NULL, at INTEGER NOT NULL,
     seq INTEGER NOT NULL, state TEXT NOT NULL, fallback TEXT NOT NULL, activity TEXT, source TEXT,
     PRIMARY KEY(profile, session));
   CREATE INDEX hermes_sessions_profile_at ON hermes_sessions(profile, at DESC, seq DESC);`,
  // 17: local receipt time protects hooks that arrive while a process census is still being examined.
  `ALTER TABLE hermes_sessions ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0;`,
  // 18: a hook-supplied process id lets the census retire one session without affecting its profile peers.
  `ALTER TABLE hermes_sessions ADD COLUMN pid INTEGER;`,
];

/** Independently replayable migration 13, also used by the startup ledger. */
export function migrate13(db: Database): void {
  db.transaction(() => {
    db.exec(MIGRATIONS[12] as string);
    const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(agents_latest)").all().map((c) => c.name));
    if (!columns.has("recv_id")) db.exec("ALTER TABLE agents_latest ADD COLUMN recv_id TEXT");
    if (!columns.has("recv_at")) db.exec("ALTER TABLE agents_latest ADD COLUMN recv_at INTEGER");
    db.exec("UPDATE agents_latest SET recv_id = event_id, recv_at = (SELECT e.received_at FROM events e WHERE e.id = agents_latest.event_id)");
  })();
}

/** Indexes (0-based) of the orch_messages (11) and projects boards (12) migrations: see migrate(). */
const ORCH_MIGRATION = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE orch_messages"));
const BOARDS_MIGRATION = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE board_projects"));
/**
 * Index of the first migration after the schedule-claim index (14 and 15). The index is built from the events in batches and
 * records both numbers with its last batch (migrateClaimIndexBatch), so the migrations from here on (16, Hermes sessions) run in
 * that same transaction: the ledger is never ahead of the index, and a migration after it is never skipped.
 */
const AFTER_CLAIM_INDEX = 15;


/**
 * A page of stored non-roster rows to re-judge (PROTOCOL §2 "Re-validation"), accepted or hidden:
 * an origin's rows from `minSeq`; a channel's rows above `floor[origin]` (the chain's watermark before
 * the change: lower rows are anchored); an ask's answers; or everything (startup after a rules change).
 */
export type RevalJob =
  | { readonly kind: "origin"; readonly origin: string; readonly minSeq: number }
  | { readonly kind: "channel"; readonly channel: string; readonly floor: Readonly<Record<string, number>> }
  | { readonly kind: "answers"; readonly ask: string }
  | { readonly kind: "all" };

const ROW_COLS = "id, origin, seq, ts, kind, channel, thread, sig, redacted, status, reason, json";

export interface EventRow {
  id: string; origin: string; seq: number; ts: number | null; kind: string | null; channel: string | null;
  thread: string | null; sig: string | null; redacted: number; status: string; json: string;
  /** Present on rows read with ROW_COLS (getRow, re-validation pages). */
  reason?: string | null;
}
export interface PendingRow {
  id: string; origin: string; ts: number; json: string; reason: string; received_at: number;
  /** What the row waits for (PROTOCOL §2 rule 5): `origin:<id>`, `channel:<name>`, `ask:<id>`, `gap:<origin>`, `team`. */
  dep: string; relay: string | null; bytes: number;
}
export interface AgentRow {
  node: string; agent: string; handle: string; event_id: string; ts: number; body: string;
  /** When this node received the event `recv_id` (migration 13); trusted only while it names `event_id`. */
  recv_id?: string | null; recv_at?: number | null;
}
export interface JoinRequest { node_id: string; login: string; pubkey: string; hostname: string; ip: string; port: number; requested_at: number }
export interface BlobRow { hash: string; size: number; mime: string | null; name: string | null; created_at: number }
export interface QueuedRequest { id: string; json: string; created_at: number; attempts: number; last_error: string | null }

/**
 * In-memory state that must follow a `transaction()` (FINAL Codex 2): `snapshot` runs before each
 * level's body, `restore` with that snapshot if the level throws (its savepoint rolled back).
 */
export interface TxHook<S = unknown> { snapshot(): S; restore(s: S): void }

/** Pending join requests kept per login and per team, and how long one waits for an owner (FINAL Fable 4). */
export const MAX_JOIN_REQUESTS_PER_LOGIN = 16;
export const MAX_JOIN_REQUESTS_PER_TEAM = 256;
export const JOIN_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export class JoinLimitError extends Error {}

export interface EventFilter {
  channel?: string; thread?: string; kinds?: string[]; before_ts?: number; since_ts?: number; limit: number;
  /** Only events whose author.agent is one of these (integration posts). */
  agents?: string[];
  /** Only thread roots. */
  roots?: boolean;
}

type ClaimTerm = { readonly authority: string; readonly after: string | null;
  readonly floor: number; readonly ceiling: number | null };

function threadOf(ev: Event): string | null {
  const b = ev.body as { thread?: unknown; ask?: unknown };
  if (ev.kind === "answer" && typeof b.ask === "string") return b.ask;
  return typeof b.thread === "string" ? b.thread : null;
}

export class Store {
  readonly db: Database;
  /** Claims wait until every pre-14 schedule post has been indexed. */
  claimIndexReady = false;
  claimIndexFailure: string | null = null;
  private claimIndexTimer: ReturnType<typeof setTimeout> | null = null;
  /** This node's id: storing one of its own rows raises the persisted seq allocation (C3). */
  selfId: string | null = null;
  /** Open `transaction()` levels; external effects queued by `afterCommit` wait for the outermost. */
  private txDepth = 0;
  private deferred: (() => void)[] = [];
  private readonly hooks: TxHook[] = [];
  private syncMode: "NORMAL" | "FULL" = "NORMAL";
  private vvCache: Record<string, number> | null = null;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    // Durability (FINAL Codex 3): a transaction that writes an event THIS node signed (and so allocates
    // its seq) commits with synchronous=FULL, so the row is on disk before it is acknowledged and pushed:
    // under NORMAL a WAL commit can be lost to a power cut, after which the node would sign different
    // content under the same seq and peers would hold a conflicting first copy forever. Other rows
    // (peers' events, verdicts, caches) stay NORMAL: a lost one is simply pulled again. SQLite refuses
    // to change the safety level inside a transaction, so the mode is chosen before one starts.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private setSync(mode: "NORMAL" | "FULL"): void {
    if (mode === this.syncMode) return;
    this.db.exec(`PRAGMA synchronous = ${mode}`);
    this.syncMode = mode;
  }

  /** The current safety level (tests). */
  get synchronous(): "NORMAL" | "FULL" { return this.syncMode; }

  /** Registers in-memory state that transactions snapshot and restore (FINAL Codex 2). */
  onTransaction<S>(hook: TxHook<S>): void { this.hooks.push(hook as TxHook); }

  /**
   * Runs `fn` in one transaction (nested calls become savepoints). Effects handed to `afterCommit`
   * inside it run only once the OUTERMOST transaction committed, in order; a level that throws
   * discards what it queued (its savepoint rolled back) and restores every registered in-memory
   * snapshot, so nothing rolled back ever escapes or lingers (INTEGRATIONS-FIX-2 #1, FINAL Codex 2).
   * `durable` (a transaction that will emit this node's own events, e.g. a connector's ledger write)
   * commits with synchronous=FULL; it is decided at the outermost level.
   */
  transaction<T>(fn: () => T, opts: { durable?: boolean } = {}): T {
    const mark = this.deferred.length;
    const snaps = this.hooks.map((h) => h.snapshot());
    const outermost = this.txDepth === 0;
    if (outermost && opts.durable) this.setSync("FULL");
    this.txDepth++;
    let out: T;
    try {
      out = this.db.transaction(fn)();
    } catch (err) {
      this.vvCache = null;
      this.deferred.length = mark;
      for (let i = this.hooks.length - 1; i >= 0; i--) (this.hooks[i] as TxHook).restore(snaps[i]);
      throw err;
    } finally {
      this.txDepth--;
      if (outermost) this.setSync("NORMAL");
    }
    if (this.txDepth === 0) this.flushDeferred();
    return out;
  }

  /** Runs `fn` now, or after the outermost open `transaction()` commits (dropped if it rolls back). */
  afterCommit(fn: () => void): void {
    if (this.txDepth === 0) fn();
    else this.deferred.push(fn);
  }

  /** True while inside a `transaction()`. */
  get inTransaction(): boolean { return this.txDepth > 0; }

  private flushDeferred(): void {
    const fns = this.deferred;
    this.deferred = [];
    for (const fn of fns) fn();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const row = this.db.query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM migrations").get();
    const current = row?.v ?? 0;
    const has = (t: string) => !!this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    // A store a projects-lane build made (PRE4 RC Codex 1): its migration 11 was the boards, the number orch_messages
    // has here. Its version says 11 while orch_messages was never created, and the boards (12 here) already exist: the
    // missing table is created, and the boards migration is recorded without running it again.
    if (current > ORCH_MIGRATION && !has("orch_messages")) {
      this.db.transaction(() => { this.db.exec(MIGRATIONS[ORCH_MIGRATION] as string); })();
    }
    let claimIndexPending = false;
    for (let i = current; i < MIGRATIONS.length; i++) {
      if (i === 13) { this.migrateClaimIndex(); claimIndexPending = true; break; }
      this.db.transaction(() => {
        if (i === BOARDS_MIGRATION && has("board_projects")) this.rebuildLaneBoards();
        else if (i === 12) migrate13(this.db);
        else this.db.exec(MIGRATIONS[i] as string);
        this.db.query("INSERT INTO migrations(version, applied_at) VALUES (?, ?)").run(i + 1, Date.now());
      })();
    }
    // Ready once the claim index is: already built (every migration from 14 on runs above, in order) or built by its last batch.
    if (!claimIndexPending) this.claimIndexReady = true;
  }

  /** Create the derived index once; each later batch is a separate transaction. */
  private migrateClaimIndex(): void {
    const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(events)").all().map((r) => r.name));
    if (!columns.has("claim_schedule")) this.db.transaction(() => this.db.exec(MIGRATIONS[13] as string))();
    this.migrateClaimIndexBatch();
  }

  private migrateClaimIndexBatch(): void {
    try {
      const more = this.db.transaction(() => {
        const cursor = Number(this.getMeta("claim_index_cursor") ?? 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("invalid claim index migration cursor");
        const rows = this.db.query<{ rowid: number; id: string; body: string | null;
          channel: string | null; kind: string | null }, [number]>(
          "SELECT rowid, id, body, channel, kind FROM events WHERE rowid > ? ORDER BY rowid LIMIT 500").all(cursor);
        const write = this.db.query(`UPDATE events SET claim_schedule = ?, claim_at = ?, claim_term = ?, claim_after = ? WHERE id = ?`);
        for (const row of rows) {
          if (row.channel !== "talkie-schedules" || row.kind !== "msg.post") continue;
          let text: unknown;
          try { text = JSON.parse(row.body ?? "null")?.text; } catch { continue; }
          const claim = indexedClaim(text);
          if (claim) write.run(claim.schedule, claim.at, claim.term, claim.after, row.id);
        }
        if (rows.length < 500) {
          this.db.query("DELETE FROM meta WHERE key = 'claim_index_cursor'").run();
          this.db.query("INSERT INTO migrations(version, applied_at) VALUES (14, ?)").run(Date.now());
          this.db.exec(MIGRATIONS[14] as string);
          this.db.query("INSERT INTO migrations(version, applied_at) VALUES (15, ?)").run(Date.now());
          for (let i = AFTER_CLAIM_INDEX; i < MIGRATIONS.length; i++) {
            this.db.exec(MIGRATIONS[i] as string);
            this.db.query("INSERT INTO migrations(version, applied_at) VALUES (?, ?)").run(i + 1, Date.now());
          }
          return false;
        }
        this.setMeta("claim_index_cursor", String(rows.at(-1)!.rowid));
        return true;
      })();
      if (!more) { this.claimIndexReady = true; return; }
      this.claimIndexTimer = setTimeout(() => { this.claimIndexTimer = null; this.migrateClaimIndexBatch(); }, 0);
    } catch (err) {
      this.claimIndexFailure = err instanceof Error ? err.message : String(err);
      this.claimIndexTimer = setTimeout(() => { this.claimIndexTimer = null; this.migrateClaimIndexBatch(); }, 1_000);
    }
  }

  /**
   * The boards migration over a projects-lane store (PRE4 delta, Opus 4): the lane's own migration 11 took several
   * shapes (PROJECTS-1..6 had no `bop`/`fin` columns, no board_hidden, other board_cards columns), so shape is judged by
   * what exists, not by the table's presence. Everything derived is rebuilt: the board tables, triggers and indexes are
   * dropped and made again, the events columns are added only where missing, the hidden-op counters are recounted from
   * the rows, and the boards are re-folded from the event log at start (projects meta cleared).
   */
  private rebuildLaneBoards(): void {
    const cols = new Set(this.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('events')").all().map((c) => c.name));
    this.db.exec(`DROP TRIGGER IF EXISTS events_bh_ins; DROP TRIGGER IF EXISTS events_bh_del; DROP TRIGGER IF EXISTS events_bh_upd_old;
      DROP TRIGGER IF EXISTS events_bh_upd_new; DROP INDEX IF EXISTS events_board_final; DROP INDEX IF EXISTS events_board_curable;
      DROP INDEX IF EXISTS events_hidden_general; DROP TABLE IF EXISTS board_projects; DROP TABLE IF EXISTS board_cards;
      DROP TABLE IF EXISTS board_key_history; DROP TABLE IF EXISTS board_hidden; DROP TABLE IF EXISTS board_fts;`);
    const sql = (MIGRATIONS[BOARDS_MIGRATION] as string).split("\n")
      .filter((l) => { const m = /^\s*ALTER TABLE events ADD COLUMN (\w+)/.exec(l); return !m || !cols.has(m[1] as string); })
      .join("\n");
    this.db.exec(sql);
    this.db.exec(`INSERT INTO board_hidden(origin, channel, final_n, curable_bytes)
      SELECT origin, channel, SUM(fin), SUM((1 - fin) * length(CAST(json AS BLOB))) FROM events
      WHERE bop = 1 AND status = 'rejected' AND redacted = 0 GROUP BY origin, channel;
      DELETE FROM meta WHERE key IN ('projects_fold', 'projects_pending', 'projects_checkpoint');`);
  }

  /** Atomically claim delivery of events to an agent; returns the ids this call won. */
  claimDeliveries(agent: string, ids: readonly string[]): string[] {
    const ins = this.db.query("INSERT OR IGNORE INTO deliveries(agent, event_id, delivered_at) VALUES (?, ?, ?)");
    const now = Date.now();
    return this.db.transaction(() => ids.filter((id) => ins.run(agent, id, now).changes === 1))();
  }

  close(): void {
    if (this.claimIndexTimer) clearTimeout(this.claimIndexTimer);
    this.claimIndexTimer = null;
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort on shutdown */ }
    this.db.close(false);
  }

  // ---- meta ----
  // ---- the local orchestrator conversation (ORCH-FIX-11/12) ----
  /** Stores (or replaces) one message of this machine's orchestrator conversation. */
  putOrchMessage(m: OrchMessage): void {
    this.db.query("INSERT OR REPLACE INTO orch_messages(id, thread, role, text, ts, via, state, tools, reply_to) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(m.id, m.thread, m.role, m.text, m.ts, m.via ?? null, m.state ?? null, m.tools?.length ? JSON.stringify(m.tools) : null, m.reply_to ?? null);
  }
  orchMessage(id: string): OrchMessage | null {
    const r = this.db.query<OrchRow, [string]>("SELECT * FROM orch_messages WHERE id = ?").get(id);
    return r ? orchOf(r) : null;
  }
  /**
   * Messages oldest first: one conversation's, or the latest `limit` of all; with `since` (ms), the first `limit` sent at
   * or after it (a dashboard's resync after a reconnect).
   */
  orchMessages(q: { thread?: string; limit: number; since?: number }): OrchMessage[] {
    if (q.since !== undefined) {
      return this.db.query<OrchRow, [number, number]>("SELECT * FROM orch_messages WHERE ts >= ? ORDER BY ts ASC, id ASC LIMIT ?").all(q.since, q.limit).map(orchOf);
    }
    const rows = q.thread
      ? this.db.query<OrchRow, [string, number]>("SELECT * FROM orch_messages WHERE thread = ? ORDER BY ts DESC, id DESC LIMIT ?").all(q.thread, q.limit)
      : this.db.query<OrchRow, [number]>("SELECT * FROM orch_messages ORDER BY ts DESC, id DESC LIMIT ?").all(q.limit);
    return rows.reverse().map(orchOf);
  }

  getMeta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }
  listMeta(prefix: string): { key: string; value: string }[] {
    return this.db.query<{ key: string; value: string }, [number, string]>(
      "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix);
  }
  setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  deleteMeta(key: string): void { this.db.query("DELETE FROM meta WHERE key = ?").run(key); }
  pruneScheduleRequests(before: number): void {
    this.db.query(`DELETE FROM meta WHERE key LIKE 'schedule_request:%' AND json_valid(value)
      AND json_extract(value, '$.at') < ?`).run(before);
  }

  // ---- events ----
  getRow(id: string): EventRow | null {
    return this.db.query<EventRow, [string]>(
      `SELECT ${ROW_COLS} FROM events WHERE id = ?`).get(id);
  }
  /** A signed notice replicated from a different node, available to acknowledge on receipt. */
  peerNotice(text: string, self: string): Event | null {
    const row = this.db.query<{ json: string }, [string, string]>(
      `SELECT json FROM events WHERE kind = 'msg.post' AND channel = 'general' AND status = 'ok'
       AND redacted = 0 AND origin != ? AND json_extract(body, '$.text') = ?
       ORDER BY received_at DESC LIMIT 1`).get(self, text);
    if (!row) return null;
    try { return JSON.parse(row.json) as Event; } catch { return null; }
  }
  countEvents(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
  }

  /** Inserts a full event (status ok or rejected) and advances vv. This node's own rows commit durably (FULL). */
  insertEvent(ev: Event, status: "ok" | "rejected", reason: string | null, fin = false): void {
    const durable = ev.origin === this.selfId && this.txDepth === 0;
    if (durable) this.setSync("FULL");
    try {
      this.db.transaction(() => {
        this.insertFull(ev, status, reason, fin);
        this.advanceVv(ev.origin, ev.seq);
        if (ev.origin === this.selfId) this.raiseSelfSeq(ev.seq);
      })();
    } catch (err) {
      this.vvCache = null;
      throw err;
    } finally {
      if (durable) this.setSync("NORMAL");
    }
  }

  /**
   * This node's seq allocation (C3): the highest seq it has stored for itself, persisted in `meta`
   * and raised in the same transaction as the row, so it never depends on which rows survive (a
   * hidden row of our own may later be reduced to a header stub). Initialised once from the rows.
   */
  allocatedSelfSeq(origin: string): number {
    const v = this.getMeta("self_seq");
    if (v !== null) return Number(v);
    const init = this.maxSeq(origin);
    this.setMeta("self_seq", String(init));
    return init;
  }
  private raiseSelfSeq(seq: number): void {
    this.db.query(`INSERT INTO meta(key, value) VALUES ('self_seq', ?) ON CONFLICT(key) DO UPDATE SET value =
      CAST(MAX(CAST(meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`).run(String(seq));
  }

  /**
   * Stores a stub. status 'ok' = a restricted event this node may not see; 'junk' = a signed event
   * that failed for a reason no roster change can cure (or over the hidden cap): only its header is kept.
   */
  insertStub(stub: Stub, status: "ok" | "junk" = "ok", reason: string | null = null): void {
    try {
      this.db.transaction(() => {
        this.db.query(`INSERT INTO events(id, origin, seq, channel, redacted, status, reason, json, received_at)
          VALUES (?,?,?,?,1,?,?,?,?)`).run(stub.id, stub.origin, stub.seq, stub.channel ?? null, status, reason, JSON.stringify(stub), Date.now());
        this.advanceVv(stub.origin, stub.seq);
      })();
    } catch (err) {
      this.vvCache = null;
      throw err;
    }
  }

  /** Replaces a stored stub with the real event (a member later receives the full copy). */
  upgradeStub(ev: Event, status: "ok" | "rejected" = "ok", reason: string | null = null, fin = false): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM events WHERE id = ? AND redacted = 1").run(ev.id);
      if (status === "ok") this.db.query("DELETE FROM stub_fill WHERE id = ?").run(ev.id);
      this.insertFull(ev, status, reason, fin);
    })();
  }

  private insertFull(ev: Event, status: "ok" | "rejected", reason: string | null, fin: boolean): void {
    const claim = ev.kind === "msg.post" && ev.channel === "talkie-schedules"
      ? indexedClaim((ev.body as { text?: unknown }).text) : null;
    this.db.query(`INSERT INTO events(id, origin, seq, ts, kind, channel, thread, author_handle, author_agent, body, sig,
      redacted, status, reason, json, received_at, bop, fin, claim_schedule, claim_at, claim_term, claim_after)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?)`).run(
      ev.id, ev.origin, ev.seq, ev.ts, ev.kind, ev.channel ?? null, threadOf(ev), ev.author.handle,
      ev.author.agent ?? null, JSON.stringify(ev.body), ev.sig, status, reason, JSON.stringify(ev), Date.now(),
      isBoardOp(ev) ? 1 : 0, fin ? 1 : 0, claim?.schedule ?? null, claim?.at ?? null,
      claim?.term ?? null, claim?.after ?? null);
  }

  /** A junk stub whose full copy is now valid in a channel this node can't see: an ordinary stub again. */
  unjunkStub(id: string): void {
    this.db.query("UPDATE events SET status = 'ok', reason = NULL WHERE id = ? AND redacted = 1 AND status = 'junk'").run(id);
  }

  /**
   * Classifies board-op rows not examined yet (PRE4 delta, Codex): full `msg.post` rows of `p-` channels above the
   * examined high-water mark (meta `board_ops_rowid`), in pages. Rows this build stores are classified as they are
   * inserted; rows an older build wrote after a rollback (its inserts, stub upgrades included, are new rows) sit above
   * the mark and are examined at the next start. The mark stops below the lowest trailing header stub, so a stub an
   * older build later replaces in place of the highest row (SQLite may reuse that rowid) is examined too.
   * Returns how many rows were examined and how many newly marked as board ops.
   */
  classifyBoardOps(isBoardOp: (ev: Event) => boolean, page = 1_000): { examined: number; marked: number } {
    const from = Number(this.getMeta("board_ops_rowid") ?? "0");
    let after = Number.isSafeInteger(from) && from > 0 ? from : 0;
    const next = this.db.query<{ rid: number; id: string; json: string }, [number, number]>(
      `SELECT rowid AS rid, id, json FROM events WHERE rowid > ? AND kind = 'msg.post' AND channel LIKE 'p-%' AND redacted = 0 AND bop = 0
       ORDER BY rowid LIMIT ?`);
    const set = this.db.query("UPDATE events SET bop = 1 WHERE id = ?");
    let examined = 0, marked = 0;
    for (;;) {
      const rows = next.all(after, page);
      if (!rows.length) break;
      this.db.transaction(() => { for (const r of rows) if (isBoardOp(JSON.parse(r.json) as Event)) { set.run(r.id); marked++; } })();
      examined += rows.length;
      after = (rows[rows.length - 1] as { rid: number }).rid;
    }
    // Everything up to the last full row is examined (candidates or not); trailing stubs stay above the mark.
    const top = this.db.query<{ m: number }, []>("SELECT rowid AS m FROM events WHERE redacted = 0 ORDER BY rowid DESC LIMIT 1").get()?.m ?? 0;
    const mark = Math.max(after, from > 0 ? from : 0, top);
    this.setMeta("board_ops_rowid", String(mark));
    return { examined, marked };
  }

  /** Marks a stored stub as junk (its full event failed permanently): it is no longer a fill target. */
  markStubJunk(id: string, reason: string): void {
    this.db.query("UPDATE events SET status = 'junk', reason = ? WHERE id = ? AND redacted = 1").run(reason, id);
  }

  private advanceVv(origin: string, seq: number): void {
    const cur = this.db.query<{ seq: number }, [string]>("SELECT seq FROM vv WHERE origin = ?").get(origin)?.seq ?? 0;
    if (seq !== cur + 1) return;
    let next = cur + 1;
    const has = this.db.query<{ one: number }, [string, number]>("SELECT 1 AS one FROM events WHERE origin = ? AND seq = ?");
    while (has.get(origin, next + 1)) next++;
    this.db.query("INSERT INTO vv(origin, seq) VALUES (?, ?) ON CONFLICT(origin) DO UPDATE SET seq = excluded.seq").run(origin, next);
    if (this.vvCache) this.vvCache[origin] = next;
  }

  setVv(origin: string, seq: number): void {
    this.db.query("INSERT INTO vv(origin, seq) VALUES (?, ?) ON CONFLICT(origin) DO UPDATE SET seq = excluded.seq").run(origin, seq);
    if (this.vvCache) this.vvCache[origin] = seq;
  }

  vv(): Record<string, number> {
    if (!this.vvCache) {
      const snapshot: Record<string, number> = {};
      for (const r of this.db.query<{ origin: string; seq: number }, []>("SELECT origin, seq FROM vv").all()) snapshot[r.origin] = r.seq;
      this.vvCache = snapshot;
    }
    return { ...this.vvCache };
  }
  vvOf(origin: string): number {
    return this.db.query<{ seq: number }, [string]>("SELECT seq FROM vv WHERE origin = ?").get(origin)?.seq ?? 0;
  }
  maxSeq(origin: string): number {
    return this.db.query<{ m: number | null }, [string]>("SELECT MAX(seq) AS m FROM events WHERE origin = ?").get(origin)?.m ?? 0;
  }
  /**
   * This node's own seq counter: the highest full event it signed. Stubs never count (D3), and no
   * remote copy of a self-originated event is ever accepted, so nobody else can move it.
   */
  selfSeq(origin: string): number {
    return this.db.query<{ m: number }, [string]>(
      "SELECT seq AS m FROM events WHERE origin = ? AND redacted = 0 ORDER BY seq DESC LIMIT 1").get(origin)?.m ?? 0;
  }
  /**
   * Drops stubs claiming this node's own origin that only a forger could have produced (a pre-D3
   * build stored them). Our own hidden rows reduced by the hidden cap (junk, `hidden_cap`) stay.
   */
  deleteSelfStubs(origin: string): number {
    return this.db.query(
      "DELETE FROM events WHERE origin = ? AND redacted = 1 AND NOT (status = 'junk' AND reason IN ('hidden_cap', 'hidden_board_cap'))").run(origin).changes;
  }
  /** Hidden non-roster rows of an origin (the hidden cap's count; roster rows have their own cap). */
  hiddenCount(origin: string): number {
    return this.db.query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events WHERE status = 'rejected' AND origin = ? AND redacted = 0
       AND bop = 0 AND kind NOT IN ${ROSTER_KIND_SQL}`).get(origin)?.n ?? 0;
  }
  /** Hidden roster-kind rows of an origin (never stubbed; capped separately, F2). */
  hiddenRosterCount(origin: string): number {
    return this.db.query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events WHERE status = 'rejected' AND origin = ? AND redacted = 0
       AND kind IN ${ROSTER_KIND_SQL}`).get(origin)?.n ?? 0;
  }
  /** The newest ts of an origin's rows (events_origin_ts: only a query saying `ts IS NOT NULL` uses it; MAX skips NULLs anyway). */
  maxTs(origin: string): number {
    return this.db.query<{ m: number | null }, [string]>("SELECT MAX(ts) AS m FROM events WHERE origin = ? AND ts IS NOT NULL").get(origin)?.m ?? 0;
  }
  /** When this node stored a row (its own receipt clock), or null for an unknown id. */
  receivedAt(id: string): number | null {
    return this.db.query<{ received_at: number }, [string]>("SELECT received_at FROM events WHERE id = ?").get(id)?.received_at ?? null;
  }

  /** Events of one origin for replication: seq in (after, upto], ascending. */
  rowsForSync(origin: string, after: number, upto: number, limit: number): EventRow[] {
    return this.db.query<EventRow, [string, number, number, number]>(
      `SELECT id, origin, seq, ts, kind, channel, thread, sig, redacted, status, json FROM events
       WHERE origin = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?`).all(origin, after, upto, limit);
  }

  /** The team's accepted team.create (the head of the authority chain). */
  teamCreate(): Event | null {
    const row = this.db.query<{ json: string }, []>(
      "SELECT json FROM events WHERE kind = 'team.create' AND redacted = 0 AND status = 'ok' LIMIT 1").get();
    return row ? (JSON.parse(row.json) as Event) : null;
  }

  /** Full roster-kind events of one origin with after < seq <= upto (the chain walk, PROTOCOL §2). */
  rosterRows(origin: string, after: number, upto: number): Event[] {
    return this.db.query<{ json: string }, [string, number, number]>(
      `SELECT json FROM events WHERE origin = ? AND seq > ? AND seq <= ? AND redacted = 0 AND kind IN ${ROSTER_KIND_SQL}
       ORDER BY seq`).all(origin, after, upto).map((r) => JSON.parse(r.json) as Event);
  }

  setStatus(id: string, status: "ok" | "rejected", reason: string | null): void {
    this.db.query("UPDATE events SET status = ?, reason = ? WHERE id = ? AND redacted = 0").run(status, reason, id);
  }

  /** One page (by rowid) of full non-roster rows, accepted or hidden, that a re-validation job covers. */
  revalPage(job: RevalJob, afterRowid: number, limit: number): (EventRow & { rowid: number })[] {
    const base = `SELECT rowid, ${ROW_COLS} FROM events e WHERE rowid > ? AND redacted = 0 AND kind NOT IN ${ROSTER_KIND_SQL}
      AND status IN ('ok','rejected')`;
    type R = EventRow & { rowid: number };
    if (job.kind === "origin") {
      return this.db.query<R, [number, string, number, number]>(
        `${base} AND origin = ? AND seq >= ? ORDER BY rowid LIMIT ?`).all(afterRowid, job.origin, job.minSeq, limit);
    }
    if (job.kind === "channel") {
      return this.db.query<R, [number, string, string, number]>(
        `${base} AND channel = ? AND seq > COALESCE((SELECT value FROM json_each(?) WHERE key = e.origin), 0)
         ORDER BY rowid LIMIT ?`).all(afterRowid, job.channel, JSON.stringify(job.floor), limit);
    }
    if (job.kind === "answers") {
      return this.db.query<R, [number, string, number]>(
        `${base} AND thread = ? AND kind = 'answer' ORDER BY rowid LIMIT ?`).all(afterRowid, job.ask, limit);
    }
    return this.db.query<R, [number, number]>(`${base} ORDER BY rowid LIMIT ?`).all(afterRowid, limit);
  }

  /**
   * Up to `limit` hidden non-roster rows of an origin beyond its `cap` lowest seqs (the deterministic
   * hidden cap, PROTOCOL §2 rule 7). Callers repeat until it returns fewer than `limit`.
   */
  hiddenBeyond(origin: string, cap: number, limit: number): EventRow[] {
    if (this.hiddenCount(origin) <= cap) return [];
    return this.db.query<EventRow, [string, number, number]>(
      `SELECT ${ROW_COLS} FROM events WHERE status = 'rejected' AND origin = ? AND redacted = 0 AND bop = 0
       AND kind NOT IN ${ROSTER_KIND_SQL} ORDER BY seq LIMIT ? OFFSET ?`).all(origin, limit, cap);
  }

  /** Final hidden board ops (full rows) of an origin in a project channel, and the bytes of its curable ones. */
  boardHidden(origin: string, channel: string): { final_n: number; curable_bytes: number } {
    return this.db.query<{ final_n: number; curable_bytes: number }, [string, string]>(
      "SELECT final_n, curable_bytes FROM board_hidden WHERE origin = ? AND channel = ?").get(origin, channel)
      ?? { final_n: 0, curable_bytes: 0 };
  }
  /** The (origin, project channel) pairs with more than `cap` final hidden board ops. */
  boardOverCap(cap: number): Array<{ origin: string; channel: string }> {
    return this.db.query<{ origin: string; channel: string }, [number]>(
      "SELECT origin, channel FROM board_hidden WHERE final_n > ? ORDER BY origin, channel").all(cap);
  }
  /** The `limit` highest-seq final hidden board ops of an origin in a channel (those beyond its lowest `cap`). */
  boardFinalTop(origin: string, channel: string, limit: number): EventRow[] {
    return this.db.query<EventRow, [string, string, number]>(
      `SELECT ${ROW_COLS} FROM events WHERE origin = ? AND channel = ? AND bop = 1 AND fin = 1 AND status = 'rejected'
       AND redacted = 0 ORDER BY seq DESC LIMIT ?`).all(origin, channel, limit);
  }
  /** Whether an origin has curable hidden board ops with seq in (lo, hi] (they became anchored: re-judge them). */
  hasCurableBoard(origin: string, lo: number, hi: number): boolean {
    return !!this.db.query(`SELECT 1 FROM events WHERE origin = ? AND seq > ? AND seq <= ? AND bop = 1 AND fin = 0
      AND status = 'rejected' AND redacted = 0 LIMIT 1`).get(origin, lo, hi);
  }
  /** Marks a hidden board op's rejection final (anchored): it now counts toward the board bound. */
  setFinal(id: string): void {
    this.db.query("UPDATE events SET fin = 1 WHERE id = ? AND redacted = 0 AND bop = 1 AND fin = 0").run(id);
  }

  rowsByIds(ids: readonly string[]): EventRow[] {
    if (!ids.length) return [];
    return this.db.query<EventRow, string[]>(
      `SELECT ${ROW_COLS} FROM events WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY origin, seq`).all(...ids);
  }

  /** Whether any full answer row (accepted or hidden) references this ask (FIX-4: answers re-judged when it changes). */
  hasAnswers(askId: string): boolean {
    return !!this.db.query("SELECT 1 FROM events WHERE thread = ? AND kind = 'answer' AND redacted = 0 LIMIT 1").get(askId);
  }

  /** Channels that have fillable stubs (restricted events this node holds only as stubs). */
  stubChannels(): string[] {
    return this.db.query<{ channel: string }, []>(
      "SELECT DISTINCT channel FROM events WHERE redacted = 1 AND (status = 'ok' OR (status = 'junk' AND reason = 'hidden_cap' AND json_extract(json, '$.kind') = 'msg.post')) AND channel IS NOT NULL").all().map((r) => r.channel);
  }
  /** Only fillable rows in a signed authority term can hide schedule history. */
  unfilledAuthorityOrigin(channel: string, terms: readonly { authority: string; floor: number; ceiling: number | null }[]): string | null {
    const query = this.db.query("SELECT 1 FROM events WHERE channel = ? AND origin = ? AND redacted = 1 AND status = 'ok' AND seq > ? AND (? IS NULL OR seq < ?) LIMIT 1");
    for (const term of terms) {
      if (query.get(channel, term.authority, term.floor, term.ceiling, term.ceiling)) return term.authority;
    }
    return null;
  }
  /**
   * Stubs in these channels that are due for a fill attempt from `peer` (PROTOCOL §3): never tried at
   * that peer first, then the least recently tried there, skipping those in that peer's backoff
   * (baseMs * 2^attempts, at most maxMs). Attempts are per (stub, peer), so a peer that never serves
   * a stub can't use up the attempts meant for the peers that can (C4).
   */
  dueStubIds(channels: readonly string[], peer: string, now: number, baseMs: number, maxMs: number, limit: number, seatChannels: readonly string[] = [], validityVersion = ""): string[] {
    if (!channels.length) return [];
    return this.db.query<{ id: string }, (string | number)[]>(
      `SELECT e.id FROM events e LEFT JOIN stub_fill f ON f.id = e.id AND f.peer = ?
       WHERE NOT EXISTS (SELECT 1 FROM meta r WHERE r.key = 'stub_recovery:' || e.id AND r.value = ?)
       AND e.redacted = 1 AND (e.status = 'ok' OR (e.status = 'junk' AND e.reason = 'hidden_cap' AND json_extract(e.json, '$.kind') = 'msg.post' AND e.channel IN (${seatChannels.map(() => "?").join(",") || "NULL"}))) AND e.channel IN (${channels.map(() => "?").join(",")})
       AND (f.last_try IS NULL OR ? - f.last_try >= MIN(?, ? * (1 << MIN(f.attempts, 20))))
       ORDER BY COALESCE(f.last_try, 0), e.origin, e.seq LIMIT ?`).all(peer, validityVersion, ...seatChannels, ...channels, now, maxMs, baseMs, limit).map((r) => r.id);
  }
  markStubsTried(ids: readonly string[], peer: string, now: number): void {
    const q = this.db.query(`INSERT INTO stub_fill(id, peer, attempts, last_try) VALUES (?, ?, 1, ?)
      ON CONFLICT(id, peer) DO UPDATE SET attempts = attempts + 1, last_try = excluded.last_try`);
    this.db.transaction(() => { for (const id of ids) q.run(id, peer, now); })();
  }

  /**
   * Visible (ok, non-stub) events, newest first. Channel visibility is filtered by the caller.
   * The rows read are bounded by the query's shape (DAEMON-STALL-1): a channel or a thread bounds them, so its kind and
   * agent filters are written `+col` (SQLite can't then walk the kind index instead, e.g. through every agent.status
   * row); without one, several kinds are read one kind at a time, each newest first up to the limit, and merged.
   */
  queryEvents(f: EventFilter): EventRow[] {
    const scoped = !!(f.channel || f.thread);
    const kinds = f.kinds?.length ? [...new Set(f.kinds)] : [];
    if (scoped || kinds.length < 2) return this.queryEventsOnce(f, scoped);
    return kinds.flatMap((k) => this.queryEventsOnce({ ...f, kinds: [k] }, false)).sort(newestFirst).slice(0, f.limit);
  }

  /** The latest signed-order posts for one schedule; the first survives the age cutoff. */
  scheduleClaimEvents(schedule: string, sinceAt: number, limit: number, terms: readonly ClaimTerm[]): EventRow[] {
    if (!Number.isSafeInteger(sinceAt) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new RangeError("invalid schedule claim query bounds");
    if (!terms.length) return [];
    const validTerm = `EXISTS (SELECT 1 FROM json_each(?) AS t
      WHERE CAST(t.key AS INTEGER) = e.claim_term
        AND json_extract(t.value, '$.authority') = e.origin
        AND e.claim_after IS json_extract(t.value, '$.after')
        AND e.seq > json_extract(t.value, '$.floor')
        AND (json_extract(t.value, '$.ceiling') IS NULL OR e.seq < json_extract(t.value, '$.ceiling')))`;
    const base = `e.claim_schedule = ? AND e.redacted = 0 AND e.status = 'ok' AND ${validTerm}`;
    const encoded = JSON.stringify(terms);
    const rows = this.db.query<EventRow & { claim_at: number }, [string, string, number]>(
      `SELECT ${ROW_COLS}, claim_at FROM events e WHERE ${base}
       ORDER BY e.claim_term DESC, e.seq DESC LIMIT ?`).all(schedule, encoded, limit);
    return rows.filter((row, index) => index === 0 || row.claim_at >= sinceAt);
  }

  private queryEventsOnce(f: EventFilter, scoped: boolean): EventRow[] {
    const where = ["redacted = 0", "status = 'ok'"];
    const args: SQLQueryBindings[] = [];
    const col = (c: string) => (scoped ? `+${c}` : c);
    if (f.channel) { where.push("channel = ?"); args.push(f.channel); }
    if (f.thread) { where.push("(thread = ? OR id = ?)"); args.push(f.thread, f.thread); }
    if (f.kinds?.length) { where.push(`${col("kind")} IN (${f.kinds.map(() => "?").join(",")})`); args.push(...f.kinds); }
    if (f.before_ts !== undefined) { where.push("ts < ?"); args.push(f.before_ts); }
    if (f.since_ts !== undefined) { where.push("ts > ?"); args.push(f.since_ts); }
    if (f.agents?.length) { where.push(`${col("author_agent")} IN (${f.agents.map(() => "?").join(",")})`); args.push(...f.agents); }
    if (f.roots) where.push("+thread IS NULL"); // never the thread index's NULL entries: every root, statuses included
    args.push(f.limit);
    return this.db.query<EventRow, SQLQueryBindings[]>(
      `SELECT id, origin, seq, ts, kind, channel, thread, sig, redacted, status, json FROM events
       WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`).all(...args);
  }

  replies(id: string): EventRow[] {
    return this.db.query<EventRow, [string]>(
      `SELECT id, origin, seq, ts, kind, channel, thread, sig, redacted, status, json FROM events
       WHERE thread = ? AND redacted = 0 AND status = 'ok' ORDER BY ts ASC, id ASC`).all(id);
  }

  asks(): EventRow[] {
    return this.db.query<EventRow, []>(
      `SELECT id, origin, seq, ts, kind, channel, thread, sig, redacted, status, json FROM events
       WHERE kind = 'ask' AND redacted = 0 AND status = 'ok' ORDER BY ts DESC LIMIT 500`).all();
  }

  channelStats(): Map<string, { count: number; last_ts: number | null }> {
    const out = new Map<string, { count: number; last_ts: number | null }>();
    for (const r of this.db.query<{ channel: string; n: number; t: number | null }, []>(
      `SELECT channel, COUNT(*) AS n, MAX(ts) AS t FROM events WHERE channel IS NOT NULL AND redacted = 0
       AND status = 'ok' GROUP BY channel`).all()) out.set(r.channel, { count: r.n, last_ts: r.t });
    return out;
  }
  /** Accepted schedule records in one channel, including old records needed to reconstruct removed schedules. */
  channelEventCount(channel: string): number {
    if (channel === "talkie-schedules") {
      const cached = this.getMeta("schedule_channel_count");
      if (cached !== null) return Number(cached);
    }
    return this.db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM events WHERE channel = ? AND kind = 'msg.post' AND redacted = 0 AND status = 'ok'").get(channel)?.n ?? 0;
  }

  /** Drops the content of a stored event, leaving a stub (same id/seq): 'ok' = restricted, 'junk' = discarded. */
  replaceWithStub(stub: Stub, status: "ok" | "junk" = "ok", reason: string | null = null): void {
    this.db.query(`UPDATE events SET ts = NULL, kind = NULL, thread = NULL, author_handle = NULL, author_agent = NULL,
      body = NULL, sig = NULL, redacted = 1, status = ?, reason = ?, json = ? WHERE id = ?`).run(status, reason, JSON.stringify(stub), stub.id);
  }

  // ---- pending (PROTOCOL §2 rule 5) ----
  /** Holds an event until `dep` arrives; a re-hold keeps its place (ts, received_at) and updates the dependency. */
  addPending(ev: Event, reason: string, dep: string, relay: string | null, bytes: number): void {
    this.db.query(`INSERT INTO pending(id, origin, ts, json, reason, received_at, dep, relay, bytes) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, dep = excluded.dep`).run(
      ev.id, ev.origin, ev.ts, JSON.stringify(ev), reason, Date.now(), dep, relay, bytes);
  }
  hasPending(id: string): boolean {
    return !!this.db.query("SELECT 1 FROM pending WHERE id = ?").get(id);
  }
  pendingRow(id: string): PendingRow | null {
    return this.db.query<PendingRow, [string]>("SELECT * FROM pending WHERE id = ?").get(id);
  }
  hasPendingDep(dep: string): boolean {
    return !!this.db.query("SELECT 1 FROM pending WHERE dep = ? LIMIT 1").get(dep);
  }
  /** The next page of rows waiting for `dep`, after the (ts, id) cursor. */
  pendingByDep(dep: string, afterTs: number, afterId: string, limit: number): PendingRow[] {
    return this.db.query<PendingRow, [string, number, number, string, number]>(
      `SELECT * FROM pending WHERE dep = ? AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts, id LIMIT ?`).all(dep, afterTs, afterTs, afterId, limit);
  }
  /** The next page of held rows of one origin, whatever they wait for, after the (ts, id) cursor (FIX-4 F2). */
  pendingByOrigin(origin: string, afterTs: number, afterId: string, limit: number): PendingRow[] {
    return this.db.query<PendingRow, [string, number, number, string, number]>(
      `SELECT * FROM pending WHERE origin = ? AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts, id LIMIT ?`).all(origin, afterTs, afterTs, afterId, limit);
  }
  /** Held rows posted in one channel, whatever they wait for (FIX-4 re-audit #3). The pending table is capped, so no index. */
  pendingByChannel(channel: string, afterTs: number, afterId: string, limit: number): PendingRow[] {
    return this.db.query<PendingRow, [string, number, number, string, number]>(
      `SELECT * FROM pending WHERE json_extract(json, '$.channel') = ? AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts, id LIMIT ?`).all(channel, afterTs, afterTs, afterId, limit);
  }
  hasPendingChannel(channel: string): boolean {
    return !!this.db.query("SELECT 1 FROM pending WHERE json_extract(json, '$.channel') = ? LIMIT 1").get(channel);
  }
  hasPendingOrigin(origin: string): boolean {
    return !!this.db.query("SELECT 1 FROM pending WHERE origin = ? LIMIT 1").get(origin);
  }
  /** Every dependency some held row waits for (startup: re-check them once). */
  pendingDeps(limit: number): string[] {
    return this.db.query<{ dep: string }, [number]>("SELECT DISTINCT dep FROM pending LIMIT ?").all(limit).map((r) => r.dep);
  }
  pendingCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pending").get()?.n ?? 0;
  }
  pendingBytesOfRelay(relay: string): number {
    return this.db.query<{ n: number | null }, [string]>("SELECT SUM(bytes) AS n FROM pending WHERE relay = ?").get(relay)?.n ?? 0;
  }
  pendingBytesOfOrigin(origin: string): number {
    return this.db.query<{ n: number | null }, [string]>("SELECT SUM(bytes) AS n FROM pending WHERE origin = ?").get(origin)?.n ?? 0;
  }
  deletePending(id: string): void { this.db.query("DELETE FROM pending WHERE id = ?").run(id); }
  /** Drops held rows older than `maxAgeMs`, and those of a still-unknown origin older than `unknownOriginMs`. */
  expirePending(maxAgeMs: number, unknownOriginMs: number, now = Date.now()): number {
    return this.db.query("DELETE FROM pending WHERE received_at < ? OR (reason = 'unknown_origin' AND received_at < ?)").run(
      now - maxAgeMs, now - unknownOriginMs).changes;
  }

  // ---- agents ----
  /**
   * `ts` of the row is the event's, clamped to `maxTs` (the receipt clock plus the skew allowance,
   * FINAL Fable 8): a status stamped in the future by its machine goes stale like any other.
   */
  upsertAgent(ev: Event, maxTs = Number.MAX_SAFE_INTEGER): void {
    const b = ev.body as { agent: string };
    this.db.query(`INSERT INTO agents_latest(node, agent, handle, event_id, ts, body, recv_id, recv_at)
      VALUES (?,?,?,?,?,?,?,(SELECT received_at FROM events WHERE id = ?))
      ON CONFLICT(node, agent) DO UPDATE SET handle = excluded.handle, event_id = excluded.event_id, ts = excluded.ts,
      body = excluded.body, recv_id = excluded.recv_id, recv_at = excluded.recv_at WHERE excluded.ts > agents_latest.ts
        OR (excluded.ts = agents_latest.ts AND excluded.event_id > agents_latest.event_id)`).run(
      ev.origin, b.agent, ev.author.handle, ev.id, Math.min(ev.ts, maxTs), JSON.stringify(ev.body), ev.id, ev.id);
  }
  /** When this node received an agent row's latest status: remembered on the row, else read from its event. */
  agentReceivedAt(row: AgentRow): number | null {
    return row.recv_id === row.event_id && typeof row.recv_at === "number" ? row.recv_at : this.receivedAt(row.event_id);
  }
  agents(): AgentRow[] {
    return this.db.query<AgentRow, []>("SELECT * FROM agents_latest ORDER BY handle, node, agent").all();
  }
  /** One node's latest agent statuses whose names start with `prefix`: a range over the primary key (node, agent), no scan of the other agents. */
  agentsWithPrefix(node: string, prefix: string): AgentRow[] {
    const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return this.db.query<AgentRow, [string, string, string]>("SELECT * FROM agents_latest WHERE node = ? AND agent >= ? AND agent < ? ORDER BY agent").all(node, prefix, upper);
  }
  /** Deletes agents from the latest-status table (the Agent archive's cap and time limit); their events stay. */
  deleteAgents(keys: ReadonlyArray<{ node: string; agent: string }>): number {
    const del = this.db.query("DELETE FROM agents_latest WHERE node = ? AND agent = ?");
    return this.db.transaction(() => keys.reduce((n, k) => n + del.run(k.node, k.agent).changes, 0))();
  }
  /** The recorded provenance of an own agent's latest status (status-projection.ts), or null. */
  statusProvenance(agent: string): { event_id: string; prov: string } | null {
    return this.db.query<{ event_id: string; prov: string }, [string]>("SELECT event_id, prov FROM status_provenance WHERE agent = ?").get(agent);
  }
  setStatusProvenance(agent: string, eventId: string, prov: string): void {
    this.db.query(`INSERT INTO status_provenance(agent, event_id, prov) VALUES (?,?,?)
      ON CONFLICT(agent) DO UPDATE SET event_id = excluded.event_id, prov = excluded.prov`).run(agent, eventId, prov);
  }
  deleteStatusProvenance(agents: readonly string[]): void {
    const del = this.db.query("DELETE FROM status_provenance WHERE agent = ?");
    this.db.transaction(() => { for (const a of agents) del.run(a); })();
  }
  agent(node: string, agent: string): AgentRow | null {
    return this.db.query<AgentRow, [string, string]>("SELECT * FROM agents_latest WHERE node = ? AND agent = ?").get(node, agent);
  }
  /** Re-derives an agent's latest status from its accepted status events (after one was hidden). */
  recomputeAgent(node: string, agent: string, skewMs = Number.MAX_SAFE_INTEGER): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM agents_latest WHERE node = ? AND agent = ?").run(node, agent);
      const rows = this.db.query<{ json: string; received_at: number }, [string, string]>(
        `SELECT json, received_at FROM events WHERE origin = ? AND kind = 'agent.status' AND author_agent = ? AND redacted = 0 AND status = 'ok'
         ORDER BY ts DESC, id DESC LIMIT 1`).all(node, agent);
      for (const r of rows) this.upsertAgent(JSON.parse(r.json) as Event, r.received_at + skewMs); // clamped to its receipt, as at ingest
    })();
  }

  // ---- blobs ----
  addBlob(hash: string, size: number, mime: string | null, name: string | null): void {
    this.db.query("INSERT OR IGNORE INTO blobs(hash, size, mime, name, created_at) VALUES (?,?,?,?,?)").run(hash, size, mime, name, Date.now());
  }
  blob(hash: string): BlobRow | null {
    return this.db.query<BlobRow, [string]>("SELECT * FROM blobs WHERE hash = ?").get(hash);
  }
  addBlobRef(hash: string, eventId: string): void {
    this.db.query("INSERT OR IGNORE INTO blob_refs(hash, event_id) VALUES (?, ?)").run(hash, eventId);
  }
  /** This node may serve `hash` for `channel` (it uploaded it there, or fetched it for a share there). */
  addProvenance(channel: string, hash: string): void {
    this.db.query("INSERT OR IGNORE INTO blob_provenance(channel, hash) VALUES (?, ?)").run(channel, hash);
  }
  hasProvenance(channel: string, hash: string): boolean {
    return !!this.db.query("SELECT 1 FROM blob_provenance WHERE channel = ? AND hash = ?").get(channel, hash);
  }
  /**
   * Accepted artifact.share events for the blob (D5: only shares create references; a hash named
   * in msg.post/ask/answer `artifacts` authorizes nothing), and seat requests naming their repo bundle in a seats
   * channel (core.ts: the only posts that record one, SEATS-FIX-8). Callers apply channel visibility.
   */
  blobRefRows(hash: string): EventRow[] {
    return this.db.query<EventRow, [string]>(
      `SELECT e.id, e.origin, e.seq, e.ts, e.kind, e.channel, e.thread, e.sig, e.redacted, e.status, e.json
       FROM blob_refs r JOIN events e ON e.id = r.event_id
       WHERE r.hash = ? AND e.redacted = 0 AND e.status = 'ok' AND (e.kind = 'artifact.share' OR (e.kind = 'msg.post' AND e.channel LIKE 'seats-%'))`).all(hash);
  }

  // ---- conflicts ----
  addConflict(id: string, origin: string): void {
    this.db.query("INSERT INTO conflicts(id, origin, detected_at) VALUES (?,?,?)").run(id, origin, Date.now());
  }
  conflictOrigins(): { origin: string; n: number }[] {
    return this.db.query<{ origin: string; n: number }, []>("SELECT origin, COUNT(*) AS n FROM conflicts GROUP BY origin").all();
  }

  // ---- join requests (FINAL Fable 4: capped per login and per team, expiring after a day) ----
  /** Drops requests older than JOIN_REQUEST_TTL_MS. */
  expireJoinRequests(now = Date.now()): number {
    return this.db.query("DELETE FROM join_requests WHERE requested_at < ?").run(now - JOIN_REQUEST_TTL_MS).changes;
  }
  /** Throws JoinLimitError past the caps (a request the same node already has is updated, not counted twice). */
  addJoinRequest(j: JoinRequest): void {
    this.db.transaction(() => {
      this.expireJoinRequests(j.requested_at);
      if (!this.joinRequest(j.node_id)) {
        const byLogin = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM join_requests WHERE login = ?").get(j.login)?.n ?? 0;
        const total = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM join_requests").get()?.n ?? 0;
        if (byLogin >= MAX_JOIN_REQUESTS_PER_LOGIN) throw new JoinLimitError(`${MAX_JOIN_REQUESTS_PER_LOGIN} join requests are already waiting for this login`);
        if (total >= MAX_JOIN_REQUESTS_PER_TEAM) throw new JoinLimitError(`${MAX_JOIN_REQUESTS_PER_TEAM} join requests are already waiting for this team`);
      }
      this.db.query(`INSERT INTO join_requests(node_id, login, pubkey, hostname, ip, port, requested_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(node_id) DO UPDATE SET hostname = excluded.hostname, ip = excluded.ip, port = excluded.port,
        requested_at = excluded.requested_at`).run(j.node_id, j.login, j.pubkey, j.hostname, j.ip, j.port, j.requested_at);
    })();
  }
  joinRequests(now = Date.now()): JoinRequest[] {
    return this.db.query<JoinRequest, [number]>("SELECT * FROM join_requests WHERE requested_at >= ? ORDER BY requested_at").all(now - JOIN_REQUEST_TTL_MS);
  }
  joinRequest(nodeId: string, now = Date.now()): JoinRequest | null {
    return this.db.query<JoinRequest, [string, number]>("SELECT * FROM join_requests WHERE node_id = ? AND requested_at >= ?").get(nodeId, now - JOIN_REQUEST_TTL_MS);
  }
  deleteJoinRequest(nodeId: string): void { this.db.query("DELETE FROM join_requests WHERE node_id = ?").run(nodeId); }

  // ---- roster requests (PROTOCOL §2 "Roster requests") ----
  queueRequest(id: string, json: string): void {
    this.db.query("INSERT OR IGNORE INTO roster_requests(id, json, created_at) VALUES (?, ?, ?)").run(id, json, Date.now());
  }
  queuedRequests(limit = 100): QueuedRequest[] {
    return this.db.query<QueuedRequest, [number]>("SELECT * FROM roster_requests ORDER BY created_at, id LIMIT ?").all(limit);
  }
  requestFailed(id: string, error: string): void {
    this.db.query("UPDATE roster_requests SET attempts = attempts + 1, last_error = ? WHERE id = ?").run(error.slice(0, 300), id);
  }
  dequeueRequest(id: string): void { this.db.query("DELETE FROM roster_requests WHERE id = ?").run(id); }

  integrityCheck(): string {
    return this.db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check ?? "unknown";
  }
}

/** Newest first by (ts, id), as `ORDER BY ts DESC, id DESC` (ids are ASCII: code-unit order is SQLite's BINARY order). */
function newestFirst(a: EventRow, b: EventRow): number {
  const ta = a.ts ?? -Infinity, tb = b.ts ?? -Infinity;
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

interface OrchRow {
  id: string; thread: string; role: string; text: string; ts: number; via: string | null; state: string | null; tools: string | null;
  reply_to: string | null;
}
const ORCH_STATES: ReadonlySet<string> = new Set(["queued", "sent", "refused", "dropped"]);
function orchOf(r: OrchRow): OrchMessage {
  return {
    id: r.id, thread: r.thread, role: r.role === "orchestrator" ? "orchestrator" : "person", text: r.text, ts: r.ts,
    ...(r.via === "dashboard" || r.via === "cli" || r.via === "schedule" || r.via === "private" ? { via: r.via } : {}),
    ...(r.state !== null && ORCH_STATES.has(r.state) ? { state: r.state as NonNullable<OrchMessage["state"]> } : {}),
    ...(r.tools ? { tools: JSON.parse(r.tools) as string[] } : {}),
    ...(r.reply_to ? { reply_to: r.reply_to } : {}),
  };
}
