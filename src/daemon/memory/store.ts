// Personal memory on this machine only (memory.db, mode 0600, next to walkie.db but never part of it).
// The caller passes the walkie home. There is no default, so opening the store cannot touch a real ~/.walkie by accident.
// Nothing here is replicated: no event, no peer message.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import type { LegacyDecision } from "./ownership.ts";
import { createLearningSchema, LearningLedger } from "./learning.ts";
import { SEMANTIC_FILE } from "./semantic.ts";
import { defaultClaudeMemPath, type ClaudeMemSettings } from "./claude-mem.ts";
import {
  MEMORY_BYTES_MAX, MEMORY_FULL_MESSAGE, MEMORY_LIST_MAX, MEMORY_QUERY_MAX, MEMORY_ROWS_MAX, MEMORY_TEXT_MAX,
  MemoryError, prepareMemory, prepareMemoryText, isMemoryKind, type MemoryKind,
} from "./text.ts";

export { MEMORY_TEXT_MAX };
export const MEMORY_FILE = "memory.db";

const ID_RE = /^m-[0-9a-f]{32}$/;
const COLS = "id, kind, body, sources, created_at, retracted, retracted_at, actor, redactions";
const QUARANTINED_OWNER = "!legacy-quarantined";

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  sources: string[];
  created_at: number;
  retracted: boolean;
  retracted_at: number | null;
  actor: string;
  redactions: string[];
}

export interface PrimerEntry {
  person: string;
  project: string;
  inProgress: string;
  nextStep: string;
  blockers: string[];
  updatedAt: number;
}

export interface MemoryOpenOptions {
  /** When false, do not create or query FTS5 (substring search). Production omits this. */
  fts?: boolean;
  /** Clock for created_at and retracted_at. Defaults to the local clock. Never taken from a request. */
  now?: () => number;
}

interface Row {
  id: string;
  kind: string;
  body: string;
  sources: string;
  created_at: number;
  retracted: number;
  retracted_at: number | null;
  actor: string;
  redactions: string;
}

function errno(err: unknown): string | undefined {
  return err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code) : undefined;
}

function ensureDir(home: string): void {
  let st: Stats | undefined;
  try { st = lstatSync(home); }
  catch (err) { if (errno(err) !== "ENOENT") throw err; }
  if (!st) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return;
  }
  // lstat, so a symlink home is not followed into somewhere else.
  if (st.isSymbolicLink() || !st.isDirectory()) throw new MemoryError("invalid", "personal memory home must be a directory");
  // Group or other bits: tighten this directory only. fchmod on a no-follow fd, so a swap to a symlink is not followed
  // and parent directories are never changed.
  if ((st.mode & 0o077) !== 0) tightenHome(home);
}

function tightenHome(home: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fchmodSync(fd, 0o700);
  } catch (err) {
    if (errno(err) === "ELOOP" || errno(err) === "ENOTDIR") throw new MemoryError("invalid", "personal memory home must be a directory");
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function createEmpty(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if (errno(err) === "EEXIST") return;
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertRegular(path: string): void {
  let st: Stats;
  try { st = lstatSync(path); }
  catch { throw new MemoryError("invalid", "memory.db must be a regular file"); }
  if (st.isSymbolicLink() || !st.isFile()) throw new MemoryError("invalid", "memory.db must be a regular file");
}

/** Sidecars that exist as regular files are tightened. A symlink is left alone: chmod would follow it. */
function chmodSidecars(path: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const side = path + suffix;
    let st: Stats;
    try { st = lstatSync(side); }
    catch { continue; }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    chmodSync(side, 0o600);
  }
}

/** The database file, then any journal still on disk. lstat first, so a swapped-in symlink is not followed. */
function tighten(path: string): void {
  assertRegular(path);
  chmodSync(path, 0o600);
  chmodSidecars(path);
}

function refuseSidecarLink(path: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    let st: Stats;
    try { st = lstatSync(path + suffix); }
    catch { continue; }
    if (st.isSymbolicLink()) throw new MemoryError("invalid", `memory.db${suffix} must be a regular file`);
  }
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_LIST_MAX) {
    throw new MemoryError("invalid", `limit must be 1..${MEMORY_LIST_MAX}`);
  }
  return limit;
}

function ftsTableExists(db: Database): boolean {
  try {
    const row = db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'",
    ).get();
    return Number(row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MemoryStore {
  /** Set once memory_fts is known to exist. A write looks again while this is false, so a table created later is used. */
  private ftsOn: boolean;
  /** opts.fts === false, or this SQLite has no FTS5 module. Do not look for the table. */
  private readonly ftsOff: boolean;
  /** 'on' once the FTS5 secure-delete option is stored. 'skip' when this SQLite refuses it. */
  private secureDelete: "on" | "skip" | "unknown" = "unknown";

  private constructor(
    private readonly db: Database,
    private readonly path: string,
    ftsOn: boolean,
    ftsOff: boolean,
    private readonly now: () => number,
  ) {
    this.ftsOn = ftsOn;
    this.ftsOff = ftsOff;
  }

  /** Whether search uses the full-text index. False means a substring search. */
  get fts(): boolean {
    if (this.ftsOff) return false;
    if (!this.ftsOn) this.ftsOn = ftsTableExists(this.db);
    return this.ftsOn;
  }

  get home(): string { return dirname(this.path); }

  static open(home: string, opts: MemoryOpenOptions = {}): MemoryStore {
    if (typeof home !== "string" || home === "") throw new MemoryError("invalid", "personal memory needs a walkie home");
    let db: Database | undefined;
    try {
      ensureDir(home);
      const path = join(home, MEMORY_FILE);
      // 0600 has no group or other bits, so the process umask cannot widen it. sqlite then opens this file
      // instead of creating one under the ambient umask. umask is left alone: it is process-global.
      createEmpty(path);
      assertRegular(path);
      refuseSidecarLink(path);
      db = new Database(path, { create: true });
      // DELETE, not WAL: a -wal/-shm file would be created beside the database and is easy to leave world-readable.
      // busy_timeout first. journal_mode takes a lock, and the default timeout is 0, so another process opening
      // this file fails at once with "database is locked". secure_delete overwrites bytes a retract removes.
      // It is a connection flag. An older SQLite that rejects the pragma still opens.
      db.exec("PRAGMA busy_timeout=3000;");
      try { db.exec("PRAGMA secure_delete=ON"); }
      catch { /* this build has no secure_delete; retracted columns are still cleared */ }
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY;");
      db.exec(`CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        sources TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        retracted INTEGER NOT NULL,
        retracted_at INTEGER,
        actor TEXT NOT NULL,
        redactions TEXT NOT NULL
      )`);
      // Local schema version 1. Existing memory.db files have no ledger; a transaction makes
      // the added ownership column and primer table appear together on upgrade.
      const migrated = db.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'memory_migrations'",
      ).get()?.n === 1 && !!db.query<{ version: number }, []>("SELECT version FROM memory_migrations WHERE version = 1").get();
      if (!migrated) db.transaction(() => {
        db!.exec("CREATE TABLE IF NOT EXISTS memory_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
        if (!db!.query<{ version: number }, []>("SELECT version FROM memory_migrations WHERE version = 1").get()) {
          db!.exec("ALTER TABLE memory ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
          db!.exec("ALTER TABLE memory ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7");
          db!.exec(`CREATE TABLE personal_primers (
            person TEXT NOT NULL, project TEXT NOT NULL, in_progress TEXT NOT NULL,
            next_step TEXT NOT NULL, blockers TEXT NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(person, project))`);
          db!.query("INSERT INTO memory_migrations(version, applied_at) VALUES (1, ?)").run(Date.now());
        }
      }).immediate();
      // Version 1 did not distinguish assigned legacy rows from new owned rows. Conservatively mark
      // all rows already present on upgrade; rows added by this version default to non-legacy.
      if (!db.query<{ version: number }, []>("SELECT version FROM memory_migrations WHERE version = 2").get()) db.transaction(() => {
        db!.exec("ALTER TABLE memory ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0");
        db!.exec("UPDATE memory SET legacy = 1");
        db!.exec(`CREATE TABLE memory_legacy_decision (
          id INTEGER PRIMARY KEY CHECK (id = 1), team TEXT NOT NULL, node TEXT NOT NULL, person TEXT NOT NULL
        )`);
        db!.query("INSERT INTO memory_migrations(version, applied_at) VALUES (2, ?)").run(Date.now());
      }).immediate();
      // All pre-v3 notes and primers used a handle. Even rows called non-legacy by v2 need
      // the same once-only migration before a later team can reuse that handle.
      if (!db.query<{ version: number }, []>("SELECT version FROM memory_migrations WHERE version = 3").get()) db.transaction(() => {
        db!.exec("UPDATE memory SET legacy = 1");
        db!.exec("ALTER TABLE personal_primers ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0");
        db!.exec("UPDATE personal_primers SET legacy = 1");
        db!.exec("CREATE TABLE memory_identity (id TEXT PRIMARY KEY)");
        db!.query("INSERT INTO memory_identity(id) VALUES (?)").run(randomBytes(16).toString("hex"));
        db!.query("INSERT INTO memory_migrations(version, applied_at) VALUES (3, ?)").run(Date.now());
      }).immediate();
      if (!db.query<{ version: number }, []>("SELECT version FROM memory_migrations WHERE version = 4").get()) db.transaction(() => {
        createLearningSchema(db!);
        db!.query("INSERT INTO memory_migrations(version, applied_at) VALUES (4, ?)").run(Date.now());
      }).immediate();
      if (!db.query<{ version: number }, []>("SELECT version FROM memory_migrations WHERE version = 5").get()) db.transaction(() => {
        db!.exec(`CREATE TABLE semantic_purge (
          store TEXT NOT NULL, record_id TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
          PRIMARY KEY(store, record_id));
          CREATE TRIGGER memory_semantic_purge_update AFTER UPDATE OF retracted, owner, body, sources ON memory
          WHEN OLD.retracted = 0 AND (NEW.retracted != 0 OR NEW.owner != OLD.owner
            OR NEW.body != OLD.body OR NEW.sources != OLD.sources)
          BEGIN
            INSERT OR REPLACE INTO semantic_purge VALUES ('memory', OLD.id,
              CASE WHEN NEW.retracted != 0 THEN 'retract' WHEN NEW.owner != OLD.owner THEN 'reassign'
                ELSE 'revision' END, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
          END;
          CREATE TRIGGER memory_semantic_purge_delete AFTER DELETE ON memory BEGIN
            INSERT OR REPLACE INTO semantic_purge VALUES ('memory', OLD.id, 'delete', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
          END;
          CREATE TRIGGER learning_semantic_purge_update
          AFTER UPDATE OF status, owner, rule, evidence ON personal_learnings
          WHEN OLD.status = 'active' AND (NEW.status != 'active' OR NEW.owner != OLD.owner
            OR NEW.rule != OLD.rule OR NEW.evidence != OLD.evidence)
          BEGIN
            INSERT OR REPLACE INTO semantic_purge VALUES ('learning', OLD.id,
              CASE WHEN NEW.status = 'superseded' THEN 'supersede'
                WHEN NEW.status = 'quarantined' THEN 'quarantine'
                WHEN NEW.status = 'retracted' THEN 'retract'
                WHEN NEW.owner != OLD.owner THEN 'reassign' ELSE 'revision' END,
              CAST(strftime('%s', 'now') AS INTEGER) * 1000);
          END;
          CREATE TRIGGER learning_semantic_purge_delete AFTER DELETE ON personal_learnings BEGIN
            INSERT OR REPLACE INTO semantic_purge VALUES ('learning', OLD.id, 'delete', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
          END;`);
        const migratedAt = Date.now();
        db!.query("INSERT INTO semantic_purge SELECT 'memory', id, 'migration', ? FROM memory WHERE retracted != 0")
          .run(migratedAt);
        db!.query("INSERT INTO semantic_purge SELECT 'learning', id, 'migration', ? FROM personal_learnings WHERE status != 'active'")
          .run(migratedAt);
        db!.query("INSERT INTO memory_migrations(version, applied_at) VALUES (5, ?)").run(Date.now());
      }).immediate();
      if (!db.query<{ version: number }, []>("SELECT version FROM memory_migrations WHERE version = 6").get()) db.transaction(() => {
        // The supported epoch range is SQLite's exact signed 64-bit integer range.
        // Overflow needs about 9.2 x 10^18 eligibility-changing writes.
        db!.exec(`CREATE TABLE eligibility_epoch (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
          INSERT INTO eligibility_epoch VALUES (1, 0);
          CREATE TRIGGER memory_epoch_insert AFTER INSERT ON memory BEGIN
            UPDATE eligibility_epoch SET value = value + 1 WHERE id = 1; END;
          CREATE TRIGGER memory_epoch_update AFTER UPDATE OF retracted, owner, body, sources ON memory
          WHEN NEW.retracted != OLD.retracted OR NEW.owner != OLD.owner OR NEW.body != OLD.body OR NEW.sources != OLD.sources
          BEGIN UPDATE eligibility_epoch SET value = value + 1 WHERE id = 1; END;
          CREATE TRIGGER memory_epoch_delete AFTER DELETE ON memory BEGIN
            UPDATE eligibility_epoch SET value = value + 1 WHERE id = 1; END;
          CREATE TRIGGER learning_epoch_insert AFTER INSERT ON personal_learnings BEGIN
            UPDATE eligibility_epoch SET value = value + 1 WHERE id = 1; END;
          CREATE TRIGGER learning_epoch_update AFTER UPDATE OF status, owner, rule, evidence, category, session, actor, machine, request_id ON personal_learnings
          WHEN NEW.status != OLD.status OR NEW.owner != OLD.owner OR NEW.rule != OLD.rule OR NEW.evidence != OLD.evidence
            OR NEW.category != OLD.category OR NEW.session != OLD.session OR NEW.actor != OLD.actor
            OR NEW.machine != OLD.machine OR NEW.request_id != OLD.request_id
          BEGIN UPDATE eligibility_epoch SET value = value + 1 WHERE id = 1; END;
          CREATE TRIGGER learning_epoch_delete AFTER DELETE ON personal_learnings BEGIN
            UPDATE eligibility_epoch SET value = value + 1 WHERE id = 1; END;
          CREATE TRIGGER learning_semantic_purge_safety
          AFTER UPDATE OF category, session, actor, machine, request_id ON personal_learnings
          WHEN OLD.status = 'active' AND (NEW.category != OLD.category OR NEW.session != OLD.session
            OR NEW.actor != OLD.actor OR NEW.machine != OLD.machine OR NEW.request_id != OLD.request_id)
          BEGIN
            INSERT OR REPLACE INTO semantic_purge VALUES ('learning', OLD.id, 'revision',
              CAST(strftime('%s', 'now') AS INTEGER) * 1000);
          END;`);
        db!.query("INSERT INTO memory_migrations(version, applied_at) VALUES (6, ?)").run(Date.now());
      }).immediate();
      if (!db.query<{ version: number }, []>("SELECT version FROM memory_migrations WHERE version = 7").get()) db.transaction(() => {
        db!.exec(`CREATE TABLE personal_claude_mem (
          owner TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL,
          freshness_days INTEGER NOT NULL DEFAULT 90, allowed_projects TEXT NOT NULL DEFAULT '[]'
        )`);
        db!.query("INSERT INTO memory_migrations(version, applied_at) VALUES (7, ?)").run(Date.now());
      }).immediate();
      try {
        db.exec("CREATE INDEX IF NOT EXISTS memory_recent ON memory (retracted, created_at DESC, id DESC)");
      } catch {
        db.exec("CREATE INDEX IF NOT EXISTS memory_recent ON memory (retracted, created_at, id)");
      }
      let ftsOn = false;
      let ftsOff = opts.fts === false;
      if (!ftsOff) {
        // A read. If the table is already there, search uses it even while another connection holds the write
        // lock. Creating it is the only step that needs that lock.
        if (ftsTableExists(db)) {
          ftsOn = true;
        } else {
          try {
            // Create and backfill in one transaction. Rows written while the table did not exist yet are copied
            // from active notes. A later open sees the table and does not insert them again.
            const opened = db;
            opened.transaction(() => {
              const had = Number(opened.query<{ n: number }, []>(
                "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'",
              ).get()?.n ?? 0);
              opened.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, body, sources)");
              // Overwrite index bytes on delete. The option needs SQLite 3.42.0 and writes FTS index format 5,
              // which FTS5 older than 3.42 cannot read or write. Older builds still keep the table.
              try { opened.exec("INSERT INTO memory_fts(memory_fts, rank) VALUES('secure-delete', 1)"); }
              catch { /* no secure-delete option; deletes still remove the row */ }
              if (had === 0) {
                opened.exec(
                  `INSERT INTO memory_fts (id, body, sources)
                   SELECT id, body, sources FROM memory WHERE retracted = 0`,
                );
              }
            }).immediate();
            ftsOn = true;
          } catch (err) {
            // No FTS5, or a lock while building the index. A bad backfill is still a real failure.
            // On a lock, look again: the table may already exist, and that read does not need the write lock.
            if (/no such module:\s*fts5/i.test(errorText(err))) ftsOff = true;
            else if (/database is locked|sqlite_busy/i.test(errorText(err))) ftsOn = ftsTableExists(db);
            else throw err;
          }
        }
      }
      // A rollback journal exists only inside this statement's transaction. Tighten it before it is removed.
      chmodSidecars(path);
      tighten(path);
      const store = new MemoryStore(db, path, ftsOn, ftsOff, opts.now ?? (() => Date.now()));
      if (ftsOn) store.observeSecureDelete();
      return store;
    } catch (err) {
      try { db?.close(); } catch { /* report the original failure */ }
      throw err;
    }
  }

  close(): void {
    try { tighten(this.path); }
    finally { this.db.close(); }
  }

  databaseId(): string {
    const id = this.db.query<{ id: string }, []>("SELECT id FROM memory_identity LIMIT 1").get()?.id;
    if (!id || !/^[0-9a-f]{32}$/.test(id)) throw new MemoryError("invalid", "memory database identity is invalid");
    return id;
  }

  learnings(): LearningLedger {
    return new LearningLedger(this.db, this.now, (fn) => this.write(fn));
  }

  claudeMemSettings(owner: string): ClaudeMemSettings {
    const row = this.db.query<{ enabled: number; path: string; freshness_days: number; allowed_projects: string }, [string]>(
      "SELECT enabled,path,freshness_days,allowed_projects FROM personal_claude_mem WHERE owner = ?",
    ).get(owner);
    if (!row) return { enabled: false, path: defaultClaudeMemPath(), freshnessDays: 90, allowedProjects: [] };
    const projects: unknown = JSON.parse(row.allowed_projects);
    if (!Array.isArray(projects) || projects.some((x) => typeof x !== "string")) throw new MemoryError("invalid", "claude-mem settings are unreadable");
    return { enabled: row.enabled === 1, path: row.path, freshnessDays: row.freshness_days, allowedProjects: projects };
  }

  setClaudeMemSettings(owner: string, value: ClaudeMemSettings): ClaudeMemSettings {
    if (!owner || owner.length > 512 || !Number.isInteger(value.freshnessDays) || value.freshnessDays < 1 || value.freshnessDays > 3650
      || value.allowedProjects.length > 100 || value.allowedProjects.some((x) => !x || x.length > 500)) {
      throw new MemoryError("invalid", "claude-mem settings are invalid");
    }
    this.db.query(`INSERT INTO personal_claude_mem(owner,enabled,path,freshness_days,allowed_projects)
      VALUES (?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET enabled=excluded.enabled,path=excluded.path,
      freshness_days=excluded.freshness_days,allowed_projects=excluded.allowed_projects`)
      .run(owner, value.enabled ? 1 : 0, value.path, value.freshnessDays, JSON.stringify([...new Set(value.allowedProjects)]));
    return this.claudeMemSettings(owner);
  }

  add(input: { kind?: string; text: string; sources?: readonly string[]; actor: string; owner?: string }): MemoryEntry {
    const prepared = prepareMemory(input);
    const id = `m-${randomBytes(16).toString("hex")}`;
    const created = this.now();
    const storedSources = JSON.stringify(prepared.sources);
    // prepareMemory has replaced unpaired surrogates, so this matches length(CAST(x AS BLOB)).
    const incoming = Buffer.byteLength(prepared.text) + Buffer.byteLength(storedSources);
    this.write(() => {
      const usage = this.db.query<{ n: number; bytes: number }, []>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(body AS BLOB)) + length(CAST(sources AS BLOB))), 0) AS bytes FROM memory WHERE retracted = 0",
      ).get();
      const rows = Number(usage?.n ?? 0);
      const bytes = Number(usage?.bytes ?? 0);
      if (rows >= MEMORY_ROWS_MAX || bytes + incoming > MEMORY_BYTES_MAX) throw new MemoryError("full", MEMORY_FULL_MESSAGE);
      this.db.query(
        `INSERT INTO memory (id, kind, body, sources, created_at, retracted, retracted_at, actor, redactions, owner)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      ).run(id, prepared.kind, prepared.text, storedSources, created, prepared.actor, JSON.stringify(prepared.redactions), input.owner ?? "");
      if (this.fts) {
        this.enableSecureDelete();
        this.db.query("INSERT INTO memory_fts (id, body, sources) VALUES (?, ?, ?)").run(id, prepared.text, prepared.sources.join("\n"));
      }
    });
    return this.must(id);
  }

  /**
   * Soft retract. A second call keeps the first retracted_at. The row stays. This write clears its text and
   * sources and deletes its full-text index entry, so it leaves search and stops counting toward the active caps.
   * A row an older build retracted still holds text; retracting it again clears that text and keeps its time.
   */
  retract(id: string, owner: string): MemoryEntry {
    if (!ID_RE.test(id)) throw new MemoryError("invalid", "that is not a memory id");
    if (!owner) throw new MemoryError("not_found", "no such memory");
    return this.write(() => {
      const existing = this.row(id, owner);
      if (!existing) throw new MemoryError("not_found", "no such memory");
      const blank = existing.body === "" && existing.sources === "[]";
      if (existing.retracted === 1 && blank) return this.entryOf(existing);
      const when = existing.retracted === 1 && typeof existing.retracted_at === "number" ? existing.retracted_at : this.now();
      this.db.query("UPDATE memory SET retracted = 1, retracted_at = ?, body = '', sources = '[]' WHERE id = ? AND owner = ?").run(when, id, owner);
      // id is UNINDEXED, so this scans. A personal file is small enough that a rowid map is not worth it.
      // Checked again here: the table may have appeared since this connection opened.
      if (this.fts) {
        this.enableSecureDelete();
        this.db.query("DELETE FROM memory_fts WHERE id = ?").run(id);
      }
      return this.must(id, owner);
    });
  }

  list(opts: { limit: number; includeRetracted: boolean; owner: string }): MemoryEntry[] {
    const n = clampLimit(opts.limit);
    if (!opts.owner) return [];
    const active = opts.includeRetracted ? "" : "AND retracted = 0 ";
    return this.db.query<Row, [string, number]>(
      `SELECT ${COLS} FROM memory WHERE owner = ? ${active}ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(opts.owner, n).map((r) => this.entryOf(r));
  }

  /** Only the local person's approved, active notes enter personal recall. */
  recallEntries(person: string): (MemoryEntry & { confidence: number })[] {
    if (!person) return [];
    const notes = this.db.query<Row & { confidence: number }, [string]>(
      `SELECT ${COLS}, confidence FROM memory WHERE owner = ? AND retracted = 0 ORDER BY created_at DESC LIMIT 5000`,
    ).all(person).map((row) => ({ ...this.entryOf(row), confidence: row.confidence }));
    const learnings = this.learnings().list(person, false, 5000).filter((learning) => learning.status === "active").map((learning) => ({
      id: learning.id, kind: "fact" as const, text: learning.rule, sources: [], created_at: learning.createdAt,
      retracted: false, retracted_at: null, actor: learning.actor, redactions: [], confidence: learning.effectiveConfidence,
    }));
    return [...notes, ...learnings];
  }

  /** Read the exact SQLite epoch, eligible records and pending invalidations in one source snapshot. */
  eligibilitySnapshot<T>(read: () => T): { epoch: string; records: T; purges: { store: string; record_id: string }[] } {
    return this.db.transaction(() => ({
      epoch: this.db.query<{ value: string }, []>("SELECT CAST(value AS TEXT) AS value FROM eligibility_epoch WHERE id = 1").get()!.value,
      records: read(),
      purges: this.db.query<{ store: string; record_id: string }, []>(
        "SELECT store, record_id FROM semantic_purge ORDER BY store, record_id",
      ).all(),
    }))();
  }

  eligibilityEpoch(): string {
    return this.db.query<{ value: string }, []>("SELECT CAST(value AS TEXT) AS value FROM eligibility_epoch WHERE id = 1").get()!.value;
  }

  /** Migrate handle rows only when the startup decision matches this database and roster. */
  resolveLegacy(proof: LegacyDecision | null, admitted = false): void {
    if (proof && (!proof.person || proof.person.length > 80 || !/^[0-9a-f]{16}$/.test(proof.team)
      || !/^[0-9a-f]{16}$/.test(proof.node))) {
      throw new MemoryError("invalid", "legacy ownership evidence is invalid");
    }
    if (!this.db.query("SELECT 1 FROM memory WHERE legacy = 1 LIMIT 1").get()
      && !this.db.query("SELECT 1 FROM personal_primers WHERE legacy = 1 LIMIT 1").get()) return;
    this.write(() => {
      const decided = this.db.query<LegacyDecision, []>("SELECT team, node, person FROM memory_legacy_decision WHERE id = 1").get();
      if (!decided) {
        this.db.query("INSERT INTO memory_legacy_decision (id, team, node, person) VALUES (1, ?, ?, ?)")
          .run(admitted ? proof?.team ?? "" : "", admitted ? proof?.node ?? "" : "", admitted ? proof?.person ?? "" : "");
      }
      const first = decided ?? proof;
      const matches = admitted && !!proof && !!first && first.team === proof.team && first.node === proof.node
        && first.person === proof.person;
      if (matches && proof) {
        this.db.query("UPDATE memory SET owner = ?, legacy = 0 WHERE legacy = 1 AND owner IN ('', ?)")
          .run(proof.identity, proof.person);
        this.db.query("UPDATE personal_primers SET person = ?, legacy = 0 WHERE legacy = 1 AND person = ?")
          .run(proof.identity, proof.person);
      }
      this.db.query("UPDATE memory SET owner = ? WHERE legacy = 1 AND owner != ?")
        .run(QUARANTINED_OWNER, QUARANTINED_OWNER);
      // Keep each old handle distinct in the composite primer primary key.
      this.db.query("UPDATE personal_primers SET person = ? || ':' || person WHERE legacy = 1 AND person NOT LIKE ?")
        .run(QUARANTINED_OWNER, `${QUARANTINED_OWNER}:%`);
    });
  }

  /** Person-only deletion of rows whose historical owner cannot be established. */
  deleteLegacy(): number {
    return this.write(() => {
      if (this.fts) {
        this.enableSecureDelete();
        this.db.query("DELETE FROM memory_fts WHERE id IN (SELECT id FROM memory WHERE owner IN ('', ?))").run(QUARANTINED_OWNER);
      }
      const notes = Number(this.db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM memory WHERE owner IN ('', ?)",
      ).get(QUARANTINED_OWNER)?.n ?? 0);
      this.db.query("DELETE FROM memory WHERE owner IN ('', ?)").run(QUARANTINED_OWNER);
      const primers = Number(this.db.query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM personal_primers WHERE person = ? OR person LIKE ?",
      ).get(QUARANTINED_OWNER, `${QUARANTINED_OWNER}:%`)?.n ?? 0);
      this.db.query("DELETE FROM personal_primers WHERE person = ? OR person LIKE ?")
        .run(QUARANTINED_OWNER, `${QUARANTINED_OWNER}:%`);
      return notes + primers;
    });
  }

  primer(person: string, project: string): PrimerEntry | null {
    const row = this.db.query<{ in_progress: string; next_step: string; blockers: string; updated_at: number }, [string, string]>(
      "SELECT in_progress, next_step, blockers, updated_at FROM personal_primers WHERE person = ? AND project = ?",
    ).get(person, project);
    if (!row) return null;
    const blockers = JSON.parse(row.blockers) as unknown;
    if (!Array.isArray(blockers) || blockers.some((v) => typeof v !== "string")) throw new MemoryError("invalid", "primer is unreadable");
    return { person, project, inProgress: row.in_progress, nextStep: row.next_step, blockers, updatedAt: row.updated_at };
  }

  setPrimer(person: string, project: string, value: { inProgress: string; nextStep: string; blockers: readonly string[] }): PrimerEntry {
    if (!person || person.length > 512 || !project || project.length > 80) throw new MemoryError("invalid", "primer identity is invalid");
    const { text: inProgress } = prepareMemoryText(value.inProgress);
    const { text: nextStep } = prepareMemoryText(value.nextStep);
    if (inProgress.length > 500 || nextStep.length > 500 || value.blockers.length > 8) throw new MemoryError("too_long", "primer exceeds its size limit");
    const blockers = value.blockers.map((b) => prepareMemoryText(b).text);
    if (blockers.some((b) => b.length > 300)) throw new MemoryError("too_long", "primer blocker exceeds its size limit");
    const at = this.now();
    this.write(() => this.db.query(
      `INSERT INTO personal_primers(person, project, in_progress, next_step, blockers, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(person, project) DO UPDATE SET in_progress = excluded.in_progress,
         next_step = excluded.next_step, blockers = excluded.blockers, updated_at = excluded.updated_at`,
    ).run(person, project, inProgress, nextStep, JSON.stringify(blockers), at));
    return this.primer(person, project) as PrimerEntry;
  }

  /**
   * Active notes only. With FTS5, a query that matches nothing stays empty: it does not fall through to LIKE,
   * so a mid-word fragment is not a hit. LIKE runs when FTS5 is off, or when FTS rejects the query.
   */
  search(q: string, limit: number, owner: string): MemoryEntry[] {
    if (q.includes("\0")) throw new MemoryError("invalid", "a search cannot contain a NUL character");
    const query = q.trim();
    if (!query) return [];
    if (query.length > MEMORY_QUERY_MAX) throw new MemoryError("invalid", `a search is at most ${MEMORY_QUERY_MAX} characters`);
    const n = clampLimit(limit);
    if (!owner) return [];
    if (this.fts) {
      const terms = query.split(/\s+/).map((t) => t.replace(/["*^:(){}]/g, "")).filter(Boolean).map((t) => `"${t}"*`);
      if (!terms.length) return [];
      try {
        const ids = this.db.query<{ id: string }, [string, string, number]>(
          `SELECT memory.id FROM memory_fts JOIN memory ON memory.id = memory_fts.id
           WHERE memory_fts MATCH ? AND memory.owner = ? AND memory.retracted = 0 ORDER BY rank LIMIT ?`,
        ).all(terms.join(" "), owner, n).map((r) => r.id);
        return this.hydrate(ids, owner);
      } catch { /* a query FTS5 can't parse: fall through to LIKE */ }
    }
    const like = `%${query.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const ids = this.db.query<{ id: string }, [string, string, string, number]>(
      `SELECT id FROM memory WHERE owner = ? AND retracted = 0 AND (body LIKE ? ESCAPE '\\' OR sources LIKE ? ESCAPE '\\')
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(owner, like, like, n).map((r) => r.id);
    return this.hydrate(ids, owner);
  }

  /** A read of the FTS config. Does not take a write lock. */
  private observeSecureDelete(): void {
    if (this.secureDelete !== "unknown") return;
    try {
      const row = this.db.query<{ v: number | string }, []>(
        "SELECT v FROM memory_fts_config WHERE k = 'secure-delete'",
      ).get();
      if (Number(row?.v) === 1) this.secureDelete = "on";
    } catch { /* a write sets the option, or gives up when this SQLite has no such config */ }
  }

  /** Persist FTS5 secure-delete before a row is inserted or removed. An older SQLite still writes the note. */
  private enableSecureDelete(): void {
    if (this.secureDelete !== "unknown") return;
    try {
      this.db.exec("INSERT INTO memory_fts(memory_fts, rank) VALUES('secure-delete', 1)");
      this.secureDelete = "on";
    } catch (err) {
      // A lock leaves the flag unknown so the next write can retry. Any other refusal will not change.
      if (!/database is locked|sqlite_busy/i.test(errorText(err))) this.secureDelete = "skip";
    }
  }

  private write<T>(fn: () => T): T {
    refuseSidecarLink(this.path);
    // Attach the optional local overlay before the source transaction so a retraction or
    // supersession removes its derived mentions in the same commit. A missing, locked or
    // unreadable overlay never blocks the canonical source write; recall withholds it.
    let semanticAttached = false;
    const semanticPath = join(this.home, SEMANTIC_FILE);
    // The optional overlay gets a short lock budget. The source-only retry keeps its normal budget.
    this.db.exec("PRAGMA busy_timeout=50");
    try {
      const st = lstatSync(semanticPath);
      if (st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0) {
        refuseSidecarLink(semanticPath);
        this.db.query("ATTACH DATABASE ? AS semantic").run(semanticPath);
        semanticAttached = !!this.db.query("SELECT 1 FROM semantic.sqlite_master WHERE type = 'table' AND name = 'mention'").get()
          && this.db.query<{ quick_check: string }, []>("PRAGMA semantic.quick_check").get()?.quick_check === "ok";
        if (!semanticAttached) this.db.exec("DETACH DATABASE semantic");
      }
    } catch {
      try { this.db.exec("DETACH DATABASE semantic"); } catch { /* no attached overlay */ }
    }
    if (!semanticAttached) this.db.exec("PRAGMA busy_timeout=3000");
    // chmod while the rollback journal still exists (commit removes it). Do not change process.umask:
    // two overlapping requests would restore the wrong mask.
    const commit = (): T => this.db.transaction(() => {
        const value = fn();
        if (semanticAttached) {
          this.db.exec(`DELETE FROM semantic.mention WHERE record_id IN
            (SELECT record_id FROM main.semantic_purge);
            DELETE FROM semantic.edge WHERE evidence_record_id IN
            (SELECT record_id FROM main.semantic_purge);`);
          this.db.exec(`DELETE FROM semantic.mention
          WHERE (record_id LIKE 'm-%' AND NOT EXISTS
            (SELECT 1 FROM main.memory WHERE id = semantic.mention.record_id AND owner = semantic.mention.owner AND retracted = 0))
          OR (record_id LIKE 'l-%' AND NOT EXISTS
            (SELECT 1 FROM main.personal_learnings WHERE id = semantic.mention.record_id AND owner = semantic.mention.owner AND status = 'active'))`);
          // The validated semantic sync acknowledges markers after its epoch check.
        }
        chmodSidecars(this.path);
        if (semanticAttached) chmodSidecars(semanticPath);
        return value;
      }).immediate();
    try {
      let result: T;
      try { result = commit(); }
      catch (err) {
        if (!semanticAttached) throw err;
        // A broken or locked derived file cannot veto a canonical source write.
        this.db.exec("DETACH DATABASE semantic");
        semanticAttached = false;
        this.db.exec("PRAGMA busy_timeout=3000");
        result = commit();
      }
      tighten(this.path);
      return result;
    } finally {
      if (semanticAttached) try { this.db.exec("DETACH DATABASE semantic"); } catch { /* next open withholds it */ }
      this.db.exec("PRAGMA busy_timeout=3000");
    }
  }

  private hydrate(ids: readonly string[], owner: string): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const id of ids) {
      const row = this.row(id, owner);
      if (!row || row.retracted === 1) continue;
      out.push(this.entryOf(row));
    }
    return out;
  }

  private row(id: string, owner?: string): Row | null {
    if (owner !== undefined) return this.db.query<Row, [string, string]>(`SELECT ${COLS} FROM memory WHERE id = ? AND owner = ?`).get(id, owner) ?? null;
    return this.db.query<Row, [string]>(`SELECT ${COLS} FROM memory WHERE id = ?`).get(id) ?? null;
  }

  private must(id: string, owner?: string): MemoryEntry {
    const row = this.row(id, owner);
    if (!row) throw new MemoryError("not_found", "no such memory");
    return this.entryOf(row);
  }

  private entryOf(row: Row): MemoryEntry {
    if (!isMemoryKind(row.kind)) throw new MemoryError("invalid", "personal memory row is unreadable");
    let sources: unknown;
    let redactions: unknown;
    try {
      sources = JSON.parse(row.sources);
      redactions = JSON.parse(row.redactions);
    } catch {
      throw new MemoryError("invalid", "personal memory row is unreadable");
    }
    if (!Array.isArray(sources) || sources.some((s) => typeof s !== "string")) throw new MemoryError("invalid", "personal memory row is unreadable");
    if (!Array.isArray(redactions) || redactions.some((s) => typeof s !== "string")) throw new MemoryError("invalid", "personal memory row is unreadable");
    const retracted = row.retracted === 1;
    return {
      id: row.id,
      kind: row.kind,
      // The stored body is empty after retract. Callers see a placeholder, not the note.
      text: retracted ? "(retracted)" : row.body,
      sources: retracted ? [] : sources,
      created_at: row.created_at,
      retracted,
      retracted_at: typeof row.retracted_at === "number" ? row.retracted_at : null,
      actor: row.actor,
      redactions,
    };
  }
}
