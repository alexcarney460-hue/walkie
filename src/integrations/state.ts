// Local integration state in walkie.db (migrations 7-8): per-connector cursor + run status, external-id
// dedup with crash recovery, persisted retries (Wispr unfurls) and the Linear caches. Nothing here is
// replicated.
import type { Database } from "bun:sqlite";
import type { Store } from "../daemon/store.ts";
import type { ConnectorId } from "./config.ts";

export interface ConnectorStateRow {
  connector: string; cursor: string | null; last_run: number | null; last_ok: number | null;
  last_error: string | null; items_posted: number; failures: number; next_run: number | null;
}
export interface LinearSnapshot { issue_id: string; key: string; state_id: string; state_name: string; updated_at: string; seen_at: number }

/**
 * One external item: `claimed` while a run works on it (claimed_at = when), `posted` when done
 * (event_id = its post, or null for an item deliberately skipped). A claimed row may already carry the
 * post (event_id) without its attachment (share_id): the next attempt completes it instead of re-posting.
 */
export interface ItemRow { state: "claimed" | "posted"; claimed_at: number | null; event_id: string | null; share_id: string | null; created_at: number }

export interface RetryRow { external_id: string; payload: string; attempts: number; next_at: number; created_at: number }

/** A claim older than this belongs to a run that crashed: it is taken over, not treated as seen. */
export const STALE_CLAIM_MS = 10 * 60_000;

export class IntegrationStore {
  private readonly db: Database;

  constructor(private readonly store: Store) { this.db = store.db; }

  /**
   * Runs `fn` in one transaction (nested calls become savepoints) through the daemon store, so an
   * emit inside it publishes and pushes only once the transaction committed (#1).
   */
  atomically<T>(fn: () => T): T {
    return this.store.transaction(fn, { durable: true }); // it emits this node's own posts: on disk before they are pushed
  }

  row(id: ConnectorId): ConnectorStateRow | null {
    return this.db.query<ConnectorStateRow, [string]>("SELECT * FROM integration_state WHERE connector = ?").get(id) ?? null;
  }

  private ensure(id: ConnectorId): void {
    this.db.query("INSERT OR IGNORE INTO integration_state(connector) VALUES (?)").run(id);
  }

  cursor(id: ConnectorId): string | null { return this.row(id)?.cursor ?? null; }
  setCursor(id: ConnectorId, cursor: string): void {
    this.ensure(id);
    this.db.query("UPDATE integration_state SET cursor = ? WHERE connector = ?").run(cursor, id);
  }

  runOk(id: ConnectorId, at: number, posted: number, nextRun: number): void {
    this.ensure(id);
    this.db.query(`UPDATE integration_state SET last_run = ?, last_ok = ?, last_error = NULL, failures = 0,
      items_posted = items_posted + ?, next_run = ? WHERE connector = ?`).run(at, at, posted, nextRun, id);
  }

  /** Returns the new consecutive failure count. */
  runFailed(id: ConnectorId, at: number, error: string, posted: number, nextRun: number): number {
    this.ensure(id);
    this.db.query(`UPDATE integration_state SET last_run = ?, last_error = ?, failures = failures + 1,
      items_posted = items_posted + ?, next_run = ? WHERE connector = ?`).run(at, error, posted, nextRun, id);
    return this.row(id)?.failures ?? 1;
  }

  setNextRun(id: ConnectorId, nextRun: number | null): void {
    this.ensure(id);
    this.db.query("UPDATE integration_state SET next_run = ? WHERE connector = ?").run(nextRun, id);
  }

  /** Forget cursor, status, dedup marks and pending retries (on DELETE /v1/integrations/:id). */
  reset(id: ConnectorId): void {
    this.atomically(() => {
      this.db.query("DELETE FROM integration_state WHERE connector = ?").run(id);
      this.db.query("DELETE FROM integration_items WHERE connector = ?").run(id);
      this.db.query("DELETE FROM integration_retries WHERE connector = ?").run(id);
      if (id === "linear") {
        this.db.query("DELETE FROM linear_snapshots").run();
        this.db.query("DELETE FROM linear_issues").run();
      }
    });
  }

  // ---- dedup ------------------------------------------------------------------------

  item(id: ConnectorId, externalId: string): ItemRow | null {
    return this.db.query<ItemRow, [string, string]>(
      "SELECT state, claimed_at, event_id, share_id, created_at FROM integration_items WHERE connector = ? AND external_id = ?").get(id, externalId) ?? null;
  }

  /** Done, or claimed by a run that is still (plausibly) working on it. A stale claim is not seen. */
  seen(id: ConnectorId, externalId: string, now = Date.now()): boolean {
    const r = this.item(id, externalId);
    if (!r) return false;
    return r.state === "posted" || (r.claimed_at ?? 0) > now - STALE_CLAIM_MS;
  }

  /** Done for good (posted, or deliberately skipped). A claim, live or stale, is not. */
  posted(id: ConnectorId, externalId: string): boolean {
    return this.item(id, externalId)?.state === "posted";
  }

  /**
   * Startup (#5): every claim belongs to a run of the process that just ended, so none is live. They
   * become stale at once instead of blocking their items for ten minutes, and instead of being skipped
   * by a window or snapshot that then moves past them.
   */
  recoverClaims(): number {
    return this.db.query("UPDATE integration_items SET claimed_at = 0 WHERE state = 'claimed'").run().changes;
  }

  /**
   * The claims a configuration generation made become stale when it ends (#8): the work holding them
   * can't write anymore, so the next run (of the new generation) takes them over at once.
   */
  staleClaims(id: ConnectorId, externalIds: readonly string[]): void {
    const q = this.db.query("UPDATE integration_items SET claimed_at = 0 WHERE connector = ? AND external_id = ? AND state = 'claimed'");
    this.atomically(() => { for (const ext of externalIds) q.run(id, ext); });
  }

  /** Claims an external item before working on it; false = done, or claimed by a live run. */
  claim(id: ConnectorId, externalId: string, now: number): boolean {
    return this.atomically(() => {
      const fresh = this.db.query(`INSERT OR IGNORE INTO integration_items(connector, external_id, event_id, created_at, state, claimed_at)
        VALUES (?, ?, NULL, ?, 'claimed', ?)`).run(id, externalId, now, now).changes === 1;
      if (fresh) return true;
      return this.db.query(`UPDATE integration_items SET claimed_at = ? WHERE connector = ? AND external_id = ? AND state = 'claimed'
        AND COALESCE(claimed_at, 0) <= ?`).run(now, id, externalId, now - STALE_CLAIM_MS).changes === 1;
    });
  }

  /** Marks an item done: `eventId` is its post (null = deliberately skipped, never retried). */
  record(id: ConnectorId, externalId: string, eventId: string | null, now: number): void {
    this.db.query(`INSERT INTO integration_items(connector, external_id, event_id, created_at, state, claimed_at) VALUES (?, ?, ?, ?, 'posted', NULL)
      ON CONFLICT(connector, external_id) DO UPDATE SET event_id = COALESCE(excluded.event_id, integration_items.event_id),
      state = 'posted', claimed_at = NULL`).run(id, externalId, eventId, now);
  }

  /** The post of a claimed item exists (emitted in the same transaction as this write). */
  setPostEvent(id: ConnectorId, externalId: string, eventId: string): void {
    this.db.query("UPDATE integration_items SET event_id = ? WHERE connector = ? AND external_id = ?").run(eventId, id, externalId);
  }

  /** The attachment announcement of a claimed item exists. */
  setShareEvent(id: ConnectorId, externalId: string, eventId: string): void {
    this.db.query("UPDATE integration_items SET share_id = ? WHERE connector = ? AND external_id = ?").run(eventId, id, externalId);
  }

  /**
   * A failed attempt gives its claim back. Nothing emitted yet: the row goes. A post already emitted:
   * the row stays (with its post) as a stale claim, so the next run completes it instead of re-posting.
   */
  release(id: ConnectorId, externalId: string): void {
    this.atomically(() => {
      this.db.query("DELETE FROM integration_items WHERE connector = ? AND external_id = ? AND state = 'claimed' AND event_id IS NULL").run(id, externalId);
      this.db.query("UPDATE integration_items SET claimed_at = 0 WHERE connector = ? AND external_id = ? AND state = 'claimed'").run(id, externalId);
    });
  }

  eventFor(id: ConnectorId, externalId: string): string | null {
    return this.item(id, externalId)?.event_id ?? null;
  }

  // ---- persisted retries (Wispr unfurls) ------------------------------------------------

  /** Queues work for later; an existing entry keeps its attempts and schedule. */
  enqueueRetry(id: ConnectorId, externalId: string, payload: string, nextAt: number, now: number): void {
    this.db.query(`INSERT OR IGNORE INTO integration_retries(connector, external_id, payload, attempts, next_at, created_at)
      VALUES (?, ?, ?, 0, ?, ?)`).run(id, externalId, payload, nextAt, now);
  }

  retry(id: ConnectorId, externalId: string): RetryRow | null {
    return this.db.query<RetryRow, [string, string]>(
      "SELECT external_id, payload, attempts, next_at, created_at FROM integration_retries WHERE connector = ? AND external_id = ?").get(id, externalId) ?? null;
  }

  dueRetries(id: ConnectorId, now: number, limit: number): RetryRow[] {
    return this.db.query<RetryRow, [string, number, number]>(
      `SELECT external_id, payload, attempts, next_at, created_at FROM integration_retries WHERE connector = ? AND next_at <= ?
       ORDER BY next_at ASC, external_id ASC LIMIT ?`).all(id, now, limit);
  }

  nextRetryAt(id: ConnectorId): number | null {
    return this.db.query<{ t: number | null }, [string]>("SELECT MIN(next_at) AS t FROM integration_retries WHERE connector = ?").get(id)?.t ?? null;
  }

  rescheduleRetry(id: ConnectorId, externalId: string, attempts: number, nextAt: number): void {
    this.db.query("UPDATE integration_retries SET attempts = ?, next_at = ? WHERE connector = ? AND external_id = ?").run(attempts, nextAt, id, externalId);
  }

  dropRetry(id: ConnectorId, externalId: string): void {
    this.db.query("DELETE FROM integration_retries WHERE connector = ? AND external_id = ?").run(id, externalId);
  }

  // ---- linear ------------------------------------------------------------------------

  linearCached(keys: readonly string[], maxAgeMs: number, now: number): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (!keys.length) return out;
    const rows = this.db.query<{ key: string; json: string | null; fetched_at: number }, string[]>(
      `SELECT key, json, fetched_at FROM linear_issues WHERE key IN (${keys.map(() => "?").join(",")})`).all(...keys);
    for (const r of rows) if (now - r.fetched_at < maxAgeMs) out.set(r.key, r.json);
    return out;
  }

  /** json null = the key doesn't exist (negative cache entry). */
  cacheLinear(key: string, json: string | null, now: number): void {
    this.db.query(`INSERT INTO linear_issues(key, json, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`).run(key, json, now);
  }

  snapshot(issueId: string): LinearSnapshot | null {
    return this.db.query<LinearSnapshot, [string]>("SELECT * FROM linear_snapshots WHERE issue_id = ?").get(issueId) ?? null;
  }

  setSnapshot(s: LinearSnapshot): void {
    this.db.query(`INSERT INTO linear_snapshots(issue_id, key, state_id, state_name, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET key = excluded.key, state_id = excluded.state_id, state_name = excluded.state_name,
      updated_at = excluded.updated_at, seen_at = excluded.seen_at`).run(s.issue_id, s.key, s.state_id, s.state_name, s.updated_at, s.seen_at);
  }
}

/** Methods of IntegrationStore that only read (everything else writes and is generation-checked). */
export const STORE_READS: ReadonlySet<string> = new Set([
  "row", "cursor", "item", "seen", "posted", "eventFor", "retry", "dueRetries", "nextRetryAt", "linearCached", "snapshot",
]);
