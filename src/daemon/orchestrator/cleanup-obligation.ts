import { Database } from "bun:sqlite";
import { chmodSync, closeSync, lstatSync, openSync } from "node:fs";
import { redactSecrets } from "../../protocol/safety.ts";
import { processStart, type OpId } from "../seats/admin-ledger.ts";

export interface PendingCleanup { generation: string; attempts: number; diagnostic: string }
interface RetryOwner extends OpId { heartbeat: number; interval_ms: number }
const MAX_OWNER_CLOCK_SKEW_MS = 5_000;

function ownerActive(owner: RetryOwner, now: number): boolean {
  if (!Number.isSafeInteger(owner.heartbeat) || !Number.isSafeInteger(owner.interval_ms)
    || owner.interval_ms < 1 || owner.heartbeat - now > MAX_OWNER_CLOCK_SKEW_MS
    || now - owner.heartbeat >= 3 * owner.interval_ms) return false;
  try { return processStart(owner.pid) === owner.start; }
  catch { return true; } // Unknown ps result is tolerated only until the heartbeat expires.
}

/** One durable, generation-keyed cleanup obligation shared by the daemon and independent monitor. */
export class CleanupObligation {
  constructor(private readonly path: string) {}

  private withDb<T>(operation: (db: Database) => T): T {
    try { closeSync(openSync(this.path, "wx", 0o600)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    const file = lstatSync(this.path);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.()) throw new Error("unsafe uid cleanup state file");
    chmodSync(this.path, 0o600);
    const db = new Database(this.path, { create: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA journal_mode = DELETE");
      db.exec("CREATE TABLE IF NOT EXISTS obligation (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), generation TEXT NOT NULL, attempts INTEGER NOT NULL, diagnostic TEXT NOT NULL)");
      db.exec("CREATE TABLE IF NOT EXISTS completed (generation TEXT PRIMARY KEY)");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE IF NOT EXISTS retry_owner (generation TEXT PRIMARY KEY, pid INTEGER NOT NULL, start TEXT NOT NULL, heartbeat INTEGER NOT NULL DEFAULT 0, interval_ms INTEGER NOT NULL DEFAULT 1000)");
        const cols = new Set((db.query("PRAGMA table_info(retry_owner)").all() as Array<{ name: string }>).map((c) => c.name));
        if (!cols.has("heartbeat")) db.exec("ALTER TABLE retry_owner ADD COLUMN heartbeat INTEGER NOT NULL DEFAULT 0");
        if (!cols.has("interval_ms")) db.exec("ALTER TABLE retry_owner ADD COLUMN interval_ms INTEGER NOT NULL DEFAULT 1000");
        db.exec("COMMIT");
      } catch (err) { db.exec("ROLLBACK"); throw err; }
      return operation(db);
    } finally { db.close(); }
  }

  read(): PendingCleanup | null {
    return this.withDb((db) => db.query("SELECT generation, attempts, diagnostic FROM obligation WHERE singleton = 1").get() as PendingCleanup | null);
  }

  completed(generation: string): boolean {
    return this.withDb((db) => db.query("SELECT 1 FROM completed WHERE generation = ?").get(generation) !== null);
  }

  monitorOwner(generation: string): OpId | null {
    return this.withDb((db) => db.query("SELECT pid, start FROM retry_owner WHERE generation = ?").get(generation) as OpId | null);
  }

  ownerActive(generation: string): boolean {
    return this.withDb((db) => {
      const owner = db.query("SELECT pid, start, heartbeat, interval_ms FROM retry_owner WHERE generation = ?").get(generation) as RetryOwner | null;
      return owner !== null && ownerActive(owner, Date.now());
    });
  }

  record(generation: string, claimant?: OpId, retryIntervalMs = 1_000): boolean {
    if (claimant && (!Number.isSafeInteger(retryIntervalMs) || retryIntervalMs < 1)) throw new Error("invalid cleanup retry interval");
    return this.withDb((db) => {
      const observed = db.query("SELECT pid, start, heartbeat, interval_ms FROM retry_owner WHERE generation = ?").get(generation) as RetryOwner | null;
      const observedActive = observed ? ownerActive(observed, Date.now()) : false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const completed = db.query("SELECT 1 FROM completed WHERE generation = ?").get(generation);
        if (completed) { db.exec("COMMIT"); return false; }
        db.query("INSERT OR IGNORE INTO obligation VALUES (1, ?, 0, '')").run(generation);
        const current = db.query("SELECT generation FROM obligation WHERE singleton = 1").get() as { generation: string };
        if (current.generation === generation) {
          const owner = db.query("SELECT pid, start, heartbeat, interval_ms FROM retry_owner WHERE generation = ?").get(generation) as RetryOwner | null;
          const changed = owner && (!observed || owner.pid !== observed.pid || owner.start !== observed.start
            || owner.heartbeat !== observed.heartbeat || owner.interval_ms !== observed.interval_ms);
          if (owner && (!claimant || owner.pid !== claimant.pid || owner.start !== claimant.start) && (changed || observedActive)) {
            db.exec("COMMIT");
            return false;
          }
          if (claimant) db.query("INSERT INTO retry_owner (generation, pid, start, heartbeat, interval_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(generation) DO UPDATE SET pid = excluded.pid, start = excluded.start, heartbeat = excluded.heartbeat, interval_ms = excluded.interval_ms")
            .run(generation, claimant.pid, claimant.start, Date.now(), retryIntervalMs);
        }
        db.exec("COMMIT");
        return current.generation === generation;
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    });
  }

  releaseOwner(generation: string, owner: OpId): void {
    this.withDb((db) => {
      db.query("DELETE FROM retry_owner WHERE generation = ? AND pid = ? AND start = ?").run(generation, owner.pid, owner.start);
    });
  }

  failure(generation: string, message: string): void {
    const diagnostic = redactSecrets(message).text.replace(/\s+/g, " ").slice(0, 240);
    this.withDb((db) => {
      db.query("UPDATE obligation SET attempts = attempts + 1, diagnostic = ? WHERE singleton = 1 AND generation = ?")
        .run(diagnostic, generation);
    });
  }

  clear(generation: string): boolean {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const cleared = db.query("DELETE FROM obligation WHERE singleton = 1 AND generation = ?").run(generation).changes === 1;
        if (cleared) {
          db.query("DELETE FROM retry_owner WHERE generation = ?").run(generation);
          db.query("INSERT OR IGNORE INTO completed VALUES (?)").run(generation);
        }
        db.exec("COMMIT");
        return cleared;
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    });
  }
}

/** Fast retries stay capped; after twelve failures use five minutes with ±10% jitter. */
export function cleanupDelay(failures: number, random = Math.random()): number {
  if (failures < 12) return Math.min(30_000, 250 * 2 ** Math.max(0, failures - 1));
  return Math.round(300_000 * (0.9 + 0.2 * random));
}

export function newerGenerationOwnsCleanup(why: string | undefined): boolean {
  return why?.includes("dedicated account belongs to another run") === true;
}
