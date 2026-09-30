// The root helper's id ledger (SEATS-FIX-6; Codex r6 HIGH 3, Opus r6 HIGH 1; SEATS-FIX-7: Codex r7 HIGH 1, MEDIUM 3):
// which seat user ids were ever handed out, to whom, and what may exist of each, in a root-owned SQLite database, so
// concurrent helpers can't lose a reservation, lower the high-water mark, hand an id out twice, or run a create and a
// destroy of the same id at once. Every change is one BEGIN IMMEDIATE transaction (one writer at a time across
// processes; synchronous=FULL, and on macOS fullfsync, so it is on the disk itself before it returns).
//
// Each id is held by at most one operation at a time (`op_pid` + `op_start`: the process and its start time, so a
// reused pid is never mistaken for it). An operation whose process is gone is taken over. States:
//   reserved   held by its create, nothing made yet (a create that finds the name taken ends it `cancelled`);
//   making     the account may exist (partly): destroy removes and verifies everything of it;
//   created    made and verified;
//   destroying a destroy started (and may have stopped part way: the next one continues);
//   destroyed  removed and verified;  cancelled  nothing was ever made.
// A destroy of a `reserved` id whose create is gone cancels it; a create never goes on once its id isn't `reserved`
// and held by itself any more.
import { Database } from "bun:sqlite";
import { chmodSync, lstatSync } from "node:fs";

export type LedgerState = "reserved" | "making" | "created" | "destroying" | "destroyed" | "cancelled";
/** A process's identity: its pid and its start time (`ps -o lstart=`). */
export interface OpId { pid: number; start: string }
export interface TalkieOwnerRecord { owner: number; state: string; generation: string | null; instance: string | null; op_pid: number | null; op_start: string | null; daemon_pid: number | null; daemon_start: string | null }
export interface TalkieResidueRecord { owner: number; folder: string; paths: string[] }
export interface HomeRetirement { uid: number; sourceDev: number; sourceIno: number; tombstone: string }
export interface HomeRetirementStore { read(): HomeRetirement | null; prepare(record: HomeRetirement): void; op: OpId }

export type Reservation = { ok: true } | { ok: false; high: number; why: string };
export type Take =
  | { ok: true; state: LedgerState; owner: number }
  | { ok: false; busy: true; state: LedgerState }
  | { ok: false; busy: false; why: string };

const LIVE: readonly LedgerState[] = ["reserved", "making", "created", "destroying"];

export class Ledger {
  private readonly db: Database;

  /**
   * Opens (or makes) the ledger at `path`. `root`: the real helper's, which must be a regular file of root's that
   * nobody else can write (checked before it is opened, and made 0600). `alive`: whether an operation's process still
   * runs (tests pass their own).
   */
  constructor(readonly path: string, root = false, private readonly alive: (op: OpId) => boolean = processAlive) {
    if (root) {
      let st: ReturnType<typeof lstatSync> | null = null;
      try { st = lstatSync(path); } catch (err) { if ((err as { code?: string }).code !== "ENOENT") throw err; }
      if (st && (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0)) throw new Error(`${path} is not a file only root can write`);
    }
    this.db = new Database(path, { create: true });
    if (root) chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout = 120000");
    this.db.exec("PRAGMA synchronous = FULL");
    if (process.platform === "darwin") this.db.exec("PRAGMA fullfsync = ON"); // Opus r7 INFO 9
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.immediate(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ids (n INTEGER PRIMARY KEY, state TEXT NOT NULL, at INTEGER NOT NULL,
        owner INTEGER NOT NULL DEFAULT -1, op_pid INTEGER, op_start TEXT)`);
      this.db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS talkie_owner (uid INTEGER PRIMARY KEY, owner INTEGER NOT NULL, state TEXT NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS talkie_residue_folders (uid INTEGER NOT NULL, folder TEXT NOT NULL, owner INTEGER NOT NULL, paths TEXT NOT NULL, PRIMARY KEY(uid, folder))");
      this.db.exec("CREATE TABLE IF NOT EXISTS seat_residue (n INTEGER NOT NULL, owner INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(n, kind, path))");
      this.db.exec("CREATE TABLE IF NOT EXISTS seat_home_retirement (n INTEGER PRIMARY KEY, owner INTEGER NOT NULL, uid INTEGER NOT NULL, source_dev INTEGER NOT NULL, source_ino INTEGER NOT NULL, tombstone TEXT NOT NULL)");
      const oldResidue = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'talkie_residue'").get();
      if (oldResidue) {
        this.db.exec("INSERT OR IGNORE INTO talkie_residue_folders (uid, folder, owner, paths) SELECT uid, folder, owner, paths FROM talkie_residue WHERE folder <> ''");
        this.db.exec("DROP TABLE talkie_residue");
      }
      const talkieCols = new Set((this.db.query("PRAGMA table_info(talkie_owner)").all() as Array<{ name: string }>).map((c) => c.name));
      if (!talkieCols.has("generation")) this.db.exec("ALTER TABLE talkie_owner ADD COLUMN generation TEXT");
      if (!talkieCols.has("instance")) this.db.exec("ALTER TABLE talkie_owner ADD COLUMN instance TEXT");
      if (!talkieCols.has("op_pid")) this.db.exec("ALTER TABLE talkie_owner ADD COLUMN op_pid INTEGER");
      if (!talkieCols.has("op_start")) this.db.exec("ALTER TABLE talkie_owner ADD COLUMN op_start TEXT");
      if (!talkieCols.has("daemon_pid")) this.db.exec("ALTER TABLE talkie_owner ADD COLUMN daemon_pid INTEGER");
      if (!talkieCols.has("daemon_start")) this.db.exec("ALTER TABLE talkie_owner ADD COLUMN daemon_start TEXT");
      // A round-6 ledger (SEATS-FIX-6) had no owner or operation columns (Opus r8 LOW): added; its rows' owner is
      // unknown (-1), and the first person's helper that destroys or lists them takes them (a dev-only ledger).
      const cols = new Set((this.db.query("PRAGMA table_info(ids)").all() as Array<{ name: string }>).map((c) => c.name));
      if (!cols.has("owner")) this.db.exec("ALTER TABLE ids ADD COLUMN owner INTEGER NOT NULL DEFAULT -1");
      if (!cols.has("op_pid")) this.db.exec("ALTER TABLE ids ADD COLUMN op_pid INTEGER");
      if (!cols.has("op_start")) this.db.exec("ALTER TABLE ids ADD COLUMN op_start TEXT");
    });
  }

  /** `fn` inside one BEGIN IMMEDIATE transaction: no other helper writes meanwhile. */
  immediate<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  private highIn(): number {
    const meta = this.db.query("SELECT v FROM meta WHERE k = 'high'").get() as { v: number } | null;
    const ids = this.db.query("SELECT MAX(n) AS m FROM ids").get() as { m: number | null } | null;
    return Math.max(meta?.v ?? 0, ids?.m ?? 0);
  }

  private row(n: number): { state: LedgerState; owner: number; op_pid: number | null; op_start: string | null } | null {
    return this.db.query("SELECT state, owner, op_pid, op_start FROM ids WHERE n = ?").get(n) as never;
  }

  /**
   * Records `n` as used for `owner` (the calling person's uid) and held by `op` (the create), durably, before anything
   * is made, if it is above every id ever used.
   */
  reserve(n: number, owner: number, op: OpId): Reservation {
    return this.immediate((): Reservation => {
      const high = this.highIn();
      if (n <= high) return { ok: false, high, why: `id ${n} is not above every seat user id ever used (${high})` };
      this.db.query("INSERT INTO ids (n, state, at, owner, op_pid, op_start) VALUES (?, 'reserved', ?, ?, ?, ?)").run(n, Date.now(), owner, op.pid, op.start);
      this.db.query("INSERT INTO meta (k, v) VALUES ('high', ?) ON CONFLICT(k) DO UPDATE SET v = MAX(v, excluded.v)").run(n);
      return { ok: true };
    });
  }

  /** The create moves on (`from` → `to`) only while it still holds the id in state `from`. */
  advance(n: number, op: OpId, from: LedgerState, to: LedgerState): boolean {
    return this.immediate(() => {
      const r = this.row(n);
      if (!r || r.state !== from || r.op_pid !== op.pid || r.op_start !== op.start) return false;
      this.db.query("UPDATE ids SET state = ?, at = ? WHERE n = ?").run(to, Date.now(), n);
      return true;
    });
  }

  /**
   * A destroy takes the id: refused when it isn't `owner`'s, busy while another live operation holds it; a `reserved`
   * id whose create is gone is cancelled (nothing was made). Otherwise it is held by `op` in state `destroying`.
   */
  takeForDestroy(n: number, owner: number, op: OpId): Take {
    const observed = this.row(n);
    const observedHeld = !!observed && observed.op_pid !== null && observed.op_start !== null
      && !(observed.op_pid === op.pid && observed.op_start === op.start);
    const holderAlive = observedHeld ? this.alive({ pid: observed.op_pid as number, start: observed.op_start as string }) : false;
    return this.immediate((): Take => {
      const r = this.row(n);
      if (!r) return { ok: false, busy: false, why: "never made by this helper" };
      if (r.owner !== owner && r.owner !== -1) return { ok: false, busy: false, why: `not a seat user of this person's (uid ${owner})` };
      if (r.owner === -1) this.db.query("UPDATE ids SET owner = ? WHERE n = ?").run(owner, n); // a round-6 row: taken
      const held = r.op_pid !== null && r.op_start !== null && !(r.op_pid === op.pid && r.op_start === op.start);
      if (held && (holderAlive || r.op_pid !== observed?.op_pid || r.op_start !== observed?.op_start || r.state !== observed?.state))
        return { ok: false, busy: true, state: r.state };
      if (r.state === "reserved" || r.state === "cancelled") {
        this.db.query("UPDATE ids SET state = 'cancelled', at = ?, op_pid = NULL, op_start = NULL WHERE n = ?").run(Date.now(), n);
        return { ok: true, state: "cancelled", owner: r.owner };
      }
      this.db.query("UPDATE ids SET state = 'destroying', at = ?, op_pid = ?, op_start = ? WHERE n = ?").run(Date.now(), op.pid, op.start, n);
      return { ok: true, state: r.state, owner: r.owner };
    });
  }

  /** The operation ends: `state` recorded, the id released. */
  finish(n: number, op: OpId, state: LedgerState): void {
    this.immediate(() => {
      const result = this.db.query("UPDATE ids SET state = ?, at = ?, op_pid = NULL, op_start = NULL WHERE n = ? AND op_pid = ? AND op_start = ?")
        .run(state, Date.now(), n, op.pid, op.start);
      if (result.changes !== 1) throw new Error("the seat user operation no longer owns its id");
    });
  }

  /** Releases the id without changing its state (a destroy that couldn't finish: the next one continues). */
  release(n: number, op: OpId): void {
    this.immediate(() => {
      this.db.query("UPDATE ids SET op_pid = NULL, op_start = NULL WHERE n = ? AND op_pid = ? AND op_start = ?").run(n, op.pid, op.start);
    });
  }

  state(n: number): LedgerState | null { return this.row(n)?.state ?? null; }
  high(): number { return this.highIn(); }
  used(): number[] { return (this.db.query("SELECT n FROM ids ORDER BY n").all() as Array<{ n: number }>).map((r) => r.n); }

  /** Root-observed metadata for protected residue; only the operation destroying this id may write it. */
  saveSeatResidue(n: number, owner: number, op: OpId, kind: "home" | "vault", path: string, bytes: number): void {
    this.immediate(() => {
      const row = this.row(n);
      if (!row || row.state !== "destroying" || row.owner !== owner || row.op_pid !== op.pid || row.op_start !== op.start)
        throw new Error("the seat residue has no active destroy claim");
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid seat residue size");
      this.db.query("INSERT INTO seat_residue (n, owner, kind, path, bytes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(n, kind, path) DO UPDATE SET bytes = excluded.bytes")
        .run(n, owner, kind, path, bytes);
    });
  }

  /** Durable, immutable source identity recorded before any home rename. */
  homeRetirementStore(n: number, owner: number, op: OpId): HomeRetirementStore {
    const claim = () => {
      const row = this.row(n);
      if (!row || row.state !== "destroying" || row.owner !== owner || row.op_pid !== op.pid || row.op_start !== op.start)
        throw new Error("the home retirement has no active destroy claim");
    };
    const read = (): HomeRetirement | null => {
      claim();
      const row = this.db.query("SELECT owner, uid, source_dev, source_ino, tombstone FROM seat_home_retirement WHERE n = ?")
        .get(n) as (HomeRetirement & { owner: number; source_dev: number; source_ino: number }) | null;
      if (!row) return null;
      if (row.owner !== owner) throw new Error("the home retirement belongs to another owner");
      return { uid: row.uid, sourceDev: row.source_dev, sourceIno: row.source_ino, tombstone: row.tombstone };
    };
    return { op, read, prepare: (record) => this.immediate(() => {
      claim();
      if (!Number.isSafeInteger(record.uid) || !Number.isSafeInteger(record.sourceDev) || !Number.isSafeInteger(record.sourceIno)
        || record.sourceDev < 0 || record.sourceIno < 0 || !/^walkie-s[1-9]\d{0,4}-\d{6}-[0-9a-f]{32}$/.test(record.tombstone))
        throw new Error("invalid home retirement provenance");
      const prior = read();
      if (prior) {
        if (prior.uid !== record.uid || prior.sourceDev !== record.sourceDev || prior.sourceIno !== record.sourceIno
          || prior.tombstone !== record.tombstone) throw new Error("the home retirement provenance changed");
        return;
      }
      this.db.query("INSERT INTO seat_home_retirement (n, owner, uid, source_dev, source_ino, tombstone) VALUES (?, ?, ?, ?, ?, ?)")
        .run(n, owner, record.uid, record.sourceDev, record.sourceIno, record.tombstone);
    }) };
  }

  seatResidueSummary(owner: number): { homes: number; vaults: number; knownBytes: number } {
    const rows = this.db.query("SELECT kind, COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM seat_residue WHERE owner = ? GROUP BY kind")
      .all(owner) as Array<{ kind: string; count: number; bytes: number }>;
    return { homes: rows.find((r) => r.kind === "home")?.count ?? 0,
      vaults: rows.find((r) => r.kind === "vault")?.count ?? 0,
      knownBytes: rows.reduce((sum, r) => sum + r.bytes, 0) };
  }

  /** Durable proof that this helper claimed the dedicated account before creating it. */
  talkieOwner(uid: number): TalkieOwnerRecord | null {
    return this.db.query("SELECT owner, state, generation, instance, op_pid, op_start, daemon_pid, daemon_start FROM talkie_owner WHERE uid = ?").get(uid) as TalkieOwnerRecord | null;
  }
  talkieResidues(uid: number): TalkieResidueRecord[] {
    const rows = this.db.query("SELECT owner, folder, paths FROM talkie_residue_folders WHERE uid = ? ORDER BY folder")
      .all(uid) as Array<{ owner: number; folder: string; paths: string }>;
    return rows.map((row) => {
      const paths: unknown = JSON.parse(row.paths);
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) throw new Error("invalid dedicated-user residue record");
      return { owner: row.owner, folder: row.folder, paths };
    });
  }
  saveTalkieResidue(uid: number, owner: number, folder: string, paths: readonly string[]): void {
    this.immediate(() => {
      const record = this.talkieOwner(uid);
      if (record?.owner !== owner || record.state !== "destroying") throw new Error("dedicated-user residue has no destroy claim");
      if (!paths.length) this.db.query("DELETE FROM talkie_residue_folders WHERE uid = ? AND owner = ? AND folder = ?").run(uid, owner, folder);
      else this.db.query("INSERT INTO talkie_residue_folders (uid, owner, folder, paths) VALUES (?, ?, ?, ?) ON CONFLICT(uid, folder) DO UPDATE SET owner = excluded.owner, paths = excluded.paths")
        .run(uid, owner, folder, JSON.stringify(paths));
    });
  }
  claimTalkie(uid: number, owner: number, generation: string, instance: string, op: OpId, daemon: OpId | null = null): boolean {
    return this.immediate(() => {
      if (this.talkieOwner(uid) !== null) return false;
      this.db.query("INSERT INTO talkie_owner (uid, owner, state, generation, instance, op_pid, op_start, daemon_pid, daemon_start) VALUES (?, ?, 'making', ?, ?, ?, ?, ?, ?)")
        .run(uid, owner, generation, instance, op.pid, op.start, daemon?.pid ?? null, daemon?.start ?? null);
      return true;
    });
  }
  markTalkieCreated(uid: number, owner: number, generation: string, op: OpId): void {
    this.immediate(() => {
      const result = this.db.query("UPDATE talkie_owner SET state = 'created' WHERE uid = ? AND owner = ? AND generation = ? AND state = 'making' AND op_pid = ? AND op_start = ?")
        .run(uid, owner, generation, op.pid, op.start);
      if (result.changes !== 1) throw new Error("the dedicated account ownership record changed");
    });
  }
  takeTalkieForDestroy(uid: number, owner: number, generation: string | undefined, op: OpId):
    { ok: true; state: string } | { ok: false; why: string } {
    const observed = this.talkieOwner(uid);
    const observedHeld = !!observed && observed.op_pid !== null && observed.op_start !== null
      && (observed.op_pid !== op.pid || observed.op_start !== op.start);
    const holderAlive = observedHeld ? this.alive({ pid: observed.op_pid as number, start: observed.op_start as string }) : false;
    return this.immediate(() => {
      const row = this.db.query("SELECT owner, state, generation, op_pid, op_start FROM talkie_owner WHERE uid = ?").get(uid) as
        { owner: number; state: string; generation: string | null; op_pid: number | null; op_start: string | null } | null;
      if (!row) return { ok: false, why: "no dedicated account ownership record" };
      if (row.owner !== owner) return { ok: false, why: "the dedicated account belongs to another person" };
      if (generation !== undefined && row.generation !== generation) return { ok: false, why: "the dedicated account belongs to another run" };
      const held = row.op_pid !== null && row.op_start !== null && (row.op_pid !== op.pid || row.op_start !== op.start);
      if (held && (holderAlive || row.op_pid !== observed?.op_pid || row.op_start !== observed?.op_start || row.state !== observed?.state))
        return { ok: false, why: "another dedicated account operation is running" };
      this.db.query("UPDATE talkie_owner SET state = 'destroying', op_pid = ?, op_start = ? WHERE uid = ?")
        .run(op.pid, op.start, uid);
      return { ok: true, state: row.state };
    });
  }
  takeEmptyTalkieForRepair(uid: number, owner: number, generation: string | null, op: OpId):
    { ok: true } | { ok: false; why: string } {
    return this.immediate(() => {
      const row = this.talkieOwner(uid);
      if (!row) return { ok: false, why: "no dedicated account ownership record" };
      if (row.owner !== owner) return { ok: false, why: "the dedicated account belongs to another person" };
      if (row.generation !== generation) return { ok: false, why: "the dedicated account generation changed" };
      if (row.op_pid !== null && row.op_start !== null && (row.op_pid !== op.pid || row.op_start !== op.start)
        && this.alive({ pid: row.op_pid, start: row.op_start }))
        return { ok: false, why: "another dedicated account operation is running" };
      this.db.query("UPDATE talkie_owner SET op_pid = ?, op_start = ? WHERE uid = ?")
        .run(op.pid, op.start, uid);
      return { ok: true };
    });
  }
  releaseTalkieOp(uid: number, op: OpId): void {
    this.immediate(() => {
      this.db.query("UPDATE talkie_owner SET op_pid = NULL, op_start = NULL WHERE uid = ? AND op_pid = ? AND op_start = ?")
        .run(uid, op.pid, op.start);
    });
  }
  releaseTalkie(uid: number, owner: number, op: OpId): void {
    this.immediate(() => {
      this.db.query("DELETE FROM talkie_owner WHERE uid = ? AND owner = ? AND op_pid = ? AND op_start = ?")
        .run(uid, owner, op.pid, op.start);
    });
  }

  /** `owner`'s ids that may still have something of them (Codex r7 MEDIUM 3: the daemon reconciles against these). */
  pending(owner: number): number[] {
    const q = `SELECT n FROM ids WHERE (owner = ? OR owner = -1) AND state IN (${LIVE.map(() => "?").join(",")}) ORDER BY n`;
    return (this.db.query(q).all(owner, ...LIVE) as Array<{ n: number }>).map((r) => r.n);
  }

  close(): void { this.db.close(); }
}

/**
 * A process's start time as `ps` prints it, or null when it is verified not running (ps exit 1, nothing printed,
 * nothing on stderr). Throws when it can't tell (SEATS-FIX-8, Codex r8 MEDIUM 1).
 */
export function processStart(pid: number): string | null {
  const r = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe", cwd: "/", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  const out = r.stdout.toString().trim();
  if (r.exitCode === 0 && out) return out;
  if (r.exitCode === 1 && !out && !r.stderr.toString().trim()) return null;
  throw new Error(`ps -p ${pid} failed (exit ${r.exitCode})`);
}

/** Whether an operation's process still runs; when that can't be told, it counts as running (its id stays held). */
export function processAlive(op: OpId): boolean {
  try { return processStart(op.pid) === op.start; } catch { return true; }
}

let self: OpId | null = null;
/** This process as an operation; throws when its own start time can't be read (no operation without an identity). */
export function selfOp(): OpId {
  if (self) return self;
  const start = processStart(process.pid);
  if (!start) throw new Error("this helper's own process identity can't be read");
  self = { pid: process.pid, start };
  return self;
}
