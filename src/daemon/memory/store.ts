// Personal memory on this machine only (memory.db, mode 0600, next to walkie.db but never part of it).
// The caller passes the walkie home. There is no default, so opening the store cannot touch a real ~/.walkie by accident.
// Nothing here is replicated: no event, no peer message.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_BYTES_MAX, MEMORY_FULL_MESSAGE, MEMORY_LIST_MAX, MEMORY_QUERY_MAX, MEMORY_ROWS_MAX, MEMORY_TEXT_MAX,
  MemoryError, prepareMemory, isMemoryKind, type MemoryKind,
} from "./text.ts";

export { MEMORY_TEXT_MAX };
export const MEMORY_FILE = "memory.db";

const ID_RE = /^m-[0-9a-f]{32}$/;
const COLS = "id, kind, body, sources, created_at, retracted, retracted_at, actor, redactions";

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

  add(input: { kind?: string; text: string; sources?: readonly string[]; actor: string }): MemoryEntry {
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
        `INSERT INTO memory (id, kind, body, sources, created_at, retracted, retracted_at, actor, redactions)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      ).run(id, prepared.kind, prepared.text, storedSources, created, prepared.actor, JSON.stringify(prepared.redactions));
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
  retract(id: string): MemoryEntry {
    if (!ID_RE.test(id)) throw new MemoryError("invalid", "that is not a memory id");
    return this.write(() => {
      const existing = this.row(id);
      if (!existing) throw new MemoryError("not_found", "no such memory");
      const blank = existing.body === "" && existing.sources === "[]";
      if (existing.retracted === 1 && blank) return this.entryOf(existing);
      const when = existing.retracted === 1 && typeof existing.retracted_at === "number" ? existing.retracted_at : this.now();
      this.db.query("UPDATE memory SET retracted = 1, retracted_at = ?, body = '', sources = '[]' WHERE id = ?").run(when, id);
      // id is UNINDEXED, so this scans. A personal file is small enough that a rowid map is not worth it.
      // Checked again here: the table may have appeared since this connection opened.
      if (this.fts) {
        this.enableSecureDelete();
        this.db.query("DELETE FROM memory_fts WHERE id = ?").run(id);
      }
      return this.must(id);
    });
  }

  list(opts: { limit: number; includeRetracted: boolean }): MemoryEntry[] {
    const n = clampLimit(opts.limit);
    const where = opts.includeRetracted ? "" : "WHERE retracted = 0 ";
    return this.db.query<Row, [number]>(
      `SELECT ${COLS} FROM memory ${where}ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(n).map((r) => this.entryOf(r));
  }

  /**
   * Active notes only. With FTS5, a query that matches nothing stays empty: it does not fall through to LIKE,
   * so a mid-word fragment is not a hit. LIKE runs when FTS5 is off, or when FTS rejects the query.
   */
  search(q: string, limit: number): MemoryEntry[] {
    if (q.includes("\0")) throw new MemoryError("invalid", "a search cannot contain a NUL character");
    const query = q.trim();
    if (!query) return [];
    if (query.length > MEMORY_QUERY_MAX) throw new MemoryError("invalid", `a search is at most ${MEMORY_QUERY_MAX} characters`);
    const n = clampLimit(limit);
    if (this.fts) {
      const terms = query.split(/\s+/).map((t) => t.replace(/["*^:(){}]/g, "")).filter(Boolean).map((t) => `"${t}"*`);
      if (!terms.length) return [];
      try {
        const ids = this.db.query<{ id: string }, [string, number]>(
          "SELECT id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?",
        ).all(terms.join(" "), n).map((r) => r.id);
        return this.hydrate(ids);
      } catch { /* a query FTS5 can't parse: fall through to LIKE */ }
    }
    const like = `%${query.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const ids = this.db.query<{ id: string }, [string, string, number]>(
      `SELECT id FROM memory WHERE retracted = 0 AND (body LIKE ? ESCAPE '\\' OR sources LIKE ? ESCAPE '\\')
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(like, like, n).map((r) => r.id);
    return this.hydrate(ids);
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
    // chmod while the rollback journal still exists (commit removes it). Do not change process.umask:
    // two overlapping requests would restore the wrong mask.
    const result = this.db.transaction(() => {
      const value = fn();
      chmodSidecars(this.path);
      return value;
    }).immediate();
    tighten(this.path);
    return result;
  }

  private hydrate(ids: readonly string[]): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const id of ids) {
      const row = this.row(id);
      if (!row || row.retracted === 1) continue;
      out.push(this.entryOf(row));
    }
    return out;
  }

  private row(id: string): Row | null {
    return this.db.query<Row, [string]>(`SELECT ${COLS} FROM memory WHERE id = ?`).get(id) ?? null;
  }

  private must(id: string): MemoryEntry {
    const row = this.row(id);
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
