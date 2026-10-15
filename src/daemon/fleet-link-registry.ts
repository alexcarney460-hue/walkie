// The roster authority's record of fleet links (FLEET-LINK-1) and of every machine that presented one. Local SQLite,
// never an event, never replicated or served to a non-owner. The tables are created idempotently when the store opens
// (not a numbered migration: parallel lanes renumber those at merge time; an older build simply ignores them).
import type { Database } from "bun:sqlite";
import { JOIN_REQUEST_TTL_MS } from "./store.ts";

export interface LinkRow {
  id: string; issuer: string; created_by: string; handle: string; login: string; role: string;
  uses: number; approve: number; pos: number; created_at: number; expires_at: number;
  revoked_at: number | null; revoked_by: string | null;
}

export interface UseRow { link: string; node_id: string; hostname: string; state: string; reason: string | null; at: number; generation?: string | null }

/** Links one team's authority keeps (active or not); past it the oldest finished ones are forgotten. */
export const MAX_LINK_ROWS = 500;
/** Refused attempts kept per link (the newest), so a flood can't grow the table. */
export const MAX_REFUSED_PER_LINK = 100;

export function ensureFleetLinkSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_links(id TEXT PRIMARY KEY, issuer TEXT NOT NULL, created_by TEXT NOT NULL,
      handle TEXT NOT NULL, login TEXT NOT NULL, role TEXT NOT NULL, uses INTEGER NOT NULL, approve INTEGER NOT NULL,
      pos INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, revoked_by TEXT);
    CREATE TABLE IF NOT EXISTS fleet_link_uses(link TEXT NOT NULL, node_id TEXT NOT NULL, hostname TEXT NOT NULL,
      state TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL, PRIMARY KEY(link, node_id));
    CREATE INDEX IF NOT EXISTS fleet_link_uses_at ON fleet_link_uses(at);
    CREATE INDEX IF NOT EXISTS fleet_link_uses_node_at ON fleet_link_uses(node_id, at);`);
  const cols = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('join_requests')").all().map((c) => c.name);
  if (!cols.includes("link")) db.exec("ALTER TABLE join_requests ADD COLUMN link TEXT");
  if (!cols.includes("generation")) db.exec("ALTER TABLE join_requests ADD COLUMN generation TEXT");
  const useCols = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('fleet_link_uses')").all();
  if (!useCols.some((c) => c.name === "generation")) db.exec("ALTER TABLE fleet_link_uses ADD COLUMN generation TEXT");
}

export class FleetLinkRegistry {
  constructor(private readonly db: Database) {}

  insert(r: LinkRow): void {
    this.db.query(`INSERT INTO fleet_links(id, issuer, created_by, handle, login, role, uses, approve, pos, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(r.id, r.issuer, r.created_by, r.handle, r.login, r.role, r.uses, r.approve, r.pos, r.created_at, r.expires_at);
    // Keep the table bounded: forget the oldest links that can no longer admit anyone (revoked or expired).
    const n = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fleet_links").get()?.n ?? 0;
    if (n > MAX_LINK_ROWS) {
      const drop = this.db.query<{ id: string }, [number, number]>(
        "SELECT id FROM fleet_links WHERE revoked_at IS NOT NULL OR expires_at <= ? ORDER BY created_at LIMIT ?").all(r.created_at, n - MAX_LINK_ROWS);
      for (const d of drop) this.forget(d.id);
    }
  }

  /** Links that can still admit a machine (not revoked, not expired), for the per-team cap. */
  liveCount(now: number): number {
    return this.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM fleet_links WHERE revoked_at IS NULL AND expires_at > ?").get(now)?.n ?? 0;
  }

  get(id: string): LinkRow | null {
    return this.db.query<LinkRow, [string]>("SELECT * FROM fleet_links WHERE id = ?").get(id);
  }

  /** Ids starting with `prefix` (revoke by a short id). */
  byPrefix(prefix: string): LinkRow[] {
    return this.db.query<LinkRow, [string]>("SELECT * FROM fleet_links WHERE substr(id, 1, length(?1)) = ?1 ORDER BY created_at").all(prefix);
  }

  list(): LinkRow[] {
    return this.db.query<LinkRow, []>("SELECT * FROM fleet_links ORDER BY created_at DESC").all();
  }

  revoke(id: string, by: string, at: number): void {
    this.db.query("UPDATE fleet_links SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL").run(at, by, id);
  }

  /** Machines this link admitted, plus those waiting for approval whose join request is still live. */
  counted(id: string, now: number): { used: number; pending: number } {
    const used = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM fleet_link_uses WHERE link = ? AND state = 'admitted'").get(id)?.n ?? 0;
    const pending = this.db.query<{ n: number }, [string, number]>(`SELECT COUNT(*) AS n FROM fleet_link_uses u WHERE u.link = ?1 AND u.state = 'pending'
      AND EXISTS (SELECT 1 FROM join_requests j WHERE j.node_id = u.node_id AND j.link = ?1 AND j.generation IS u.generation AND j.requested_at >= ?2)`).get(id, now - JOIN_REQUEST_TTL_MS)?.n ?? 0;
    return { used, pending };
  }

  use(id: string, nodeId: string): UseRow | null {
    return this.db.query<UseRow, [string, string]>("SELECT * FROM fleet_link_uses WHERE link = ? AND node_id = ?").get(id, nodeId);
  }

  /** Most recent outcome for this authenticated key, for token-free approval polling. */
  latestUse(nodeId: string): UseRow | null {
    return this.db.query<UseRow, [string]>("SELECT * FROM fleet_link_uses WHERE node_id = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(nodeId);
  }

  /** Records (or updates) what happened when `nodeId` presented the link. */
  record(u: UseRow): void {
    this.db.query(`INSERT INTO fleet_link_uses(link, node_id, hostname, state, reason, at, generation) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(link, node_id) DO UPDATE SET hostname = excluded.hostname, state = excluded.state, reason = excluded.reason, at = excluded.at, generation = excluded.generation`)
      .run(u.link, u.node_id, u.hostname, u.state, u.reason, u.at, u.generation ?? null);
    if (u.state === "refused") {
      this.db.query(`DELETE FROM fleet_link_uses WHERE link = ?1 AND state = 'refused' AND node_id NOT IN
        (SELECT node_id FROM fleet_link_uses WHERE link = ?1 AND state = 'refused' ORDER BY at DESC LIMIT ?2)`).run(u.link, MAX_REFUSED_PER_LINK);
    }
  }

  uses(limit = 500): UseRow[] {
    return this.db.query<UseRow, [number]>("SELECT * FROM fleet_link_uses ORDER BY at DESC LIMIT ?").all(limit);
  }

  /** Pending machines of a link (to drop their join requests when it is revoked). */
  pendingNodes(id: string): string[] {
    return this.db.query<{ node_id: string }, [string]>("SELECT node_id FROM fleet_link_uses WHERE link = ? AND state = 'pending'").all(id).map((r) => r.node_id);
  }

  private forget(id: string): void {
    this.db.query("DELETE FROM fleet_link_uses WHERE link = ?").run(id);
    this.db.query("DELETE FROM fleet_links WHERE id = ?").run(id);
  }
}
