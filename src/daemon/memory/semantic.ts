// Local, rebuildable semantic overlay. It is never an event or a replicated store.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, openSync, closeSync, constants, fchmodSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryStore } from "./store.ts";
import { eligibleRecords } from "./primer.ts";

export const SEMANTIC_FILE = "semantic.db";
export const EDGE_TYPES = ["part_of", "works_with", "owns", "uses", "supersedes", "related_to"] as const;
export type EdgeType = typeof EDGE_TYPES[number];
export interface SemanticRecord { id: string; store: "learning" | "file-note"; text: string; sources: readonly string[]; updatedAt: number; confidence: number; project?: string }
export interface EntityHit { id: string; name: string; stale: boolean; via: "direct" | "edge"; boost: number }
export interface SemanticStatus { status: "ready" | "withheld"; reason?: string; entities?: number; aliases?: number; mentions?: number }
export interface EntityInput { slug: string; kind: string; name: string; summary: string; validAsOf: number; confidence: number }
interface EntityRow { id: string; owner: string; kind: string; name: string; summary: string; valid_as_of: number; origin: string; confidence: number }
interface AliasRow { entity_id: string; text: string }
interface MentionRow { entity_id: string; store: string; record_id: string; weight: number; revision: string }
interface PreparedSemantic { mentions: readonly MentionRow[]; boosts: Map<string, EntityHit[]> }
const DAY = 86_400_000;
const NAME_MAX = 160;

export function normalizeAlias(value: string): string { return value.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ").trim(); }
function matches(text: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(normalizeAlias(text));
}
function valid(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function revision(record: SemanticRecord): string {
  return createHash("sha256").update(JSON.stringify([record.store, record.id, record.text, record.sources, record.updatedAt, record.project])).digest("hex");
}
function count(db: Database, table: string, owner: string): number {
  // table is internal, never user input.
  return Number(db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE owner = ?`).get(owner)?.n ?? 0);
}
function safeHome(home: string, tighten: boolean): void {
  const st = lstatSync(home);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("semantic home is unsafe");
  if ((st.mode & 0o077) === 0) return;
  if (!tighten) throw new Error("semantic home is unsafe");
  const fd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
}
function safeSidecars(path: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      const st = lstatSync(path + suffix);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error("semantic sidecar is unsafe");
      if ((st.mode & 0o077) !== 0) chmodSync(path + suffix, 0o600);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") continue;
      throw err;
    }
  }
}

export class EligibilityChanged extends Error {
  constructor() { super("eligibility changed during semantic recall"); }
}

function hasPendingPurges(home: string): boolean {
  const sourcePath = join(home, "memory.db");
  try { lstatSync(sourcePath); } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return false;
    throw err;
  }
  const db = new Database(sourcePath, { readonly: true });
  try { return !!db.query("SELECT 1 FROM semantic_purge LIMIT 1").get(); }
  finally { db.close(); }
}

export class SemanticStore {
  private constructor(private readonly db: Database, private readonly path: string) {}

  static open(home: string): SemanticStore | null {
    safeHome(home, false);
    const path = join(home, SEMANTIC_FILE);
    let st;
    try { st = lstatSync(path); } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
      throw err;
    }
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error("semantic file is unsafe");
    safeSidecars(path);
    const db = new Database(path);
    try {
      db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY;");
      if (db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("semantic file is corrupt");
      for (const table of ["entity", "alias", "edge", "mention"]) {
        if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new Error("semantic schema is missing");
      }
      const sourcePath = join(home, "memory.db");
      const sourceStat = lstatSync(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("semantic source is unsafe");
      db.query("ATTACH DATABASE ? AS source").run(sourcePath);
      try {
        // Older builds indexed cards and project-scoped notes. Their visibility lives outside
        // the person's store, so remove those mentions before any status or query can use them.
        db.query(`DELETE FROM mention WHERE store = 'card' OR (
          store IN ('learning', 'file-note') AND EXISTS (
            SELECT 1 FROM source.memory AS m, json_each(m.sources) AS scope
            WHERE m.id = mention.record_id AND substr(scope.value, 1, 8) = 'project:'
          ))`).run();
      } finally { db.exec("DETACH DATABASE source"); }
      return new SemanticStore(db, path);
    } catch (err) { db.close(); throw err; }
  }

  static create(home: string): SemanticStore {
    safeHome(home, true);
    const path = join(home, SEMANTIC_FILE);
    let fd: number | undefined;
    try { fd = openSync(path, "wx", 0o600); } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    } finally { if (fd !== undefined) closeSync(fd); }
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error("semantic file is unsafe");
    safeSidecars(path);
    if (st.size > 0) {
      const existing = SemanticStore.open(home);
      if (existing) return existing;
    }
    // An empty file exists but has no schema yet.
    const db = new Database(path);
    try {
      db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY;");
      db.exec(`CREATE TABLE entity (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, summary TEXT NOT NULL, valid_as_of INTEGER NOT NULL, origin TEXT NOT NULL,
        confidence REAL NOT NULL);
        CREATE TABLE alias (owner TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
          text TEXT NOT NULL, PRIMARY KEY(owner, entity_id, text));
        CREATE TABLE edge (owner TEXT NOT NULL, source TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
          target TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE, type TEXT NOT NULL,
          evidence_record_id TEXT, PRIMARY KEY(owner, source, target, type));
        CREATE TABLE mention (owner TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
          store TEXT NOT NULL, record_id TEXT NOT NULL, weight REAL NOT NULL, revision TEXT NOT NULL,
          PRIMARY KEY(owner, entity_id, store, record_id));
        CREATE INDEX mention_record ON mention(owner, store, record_id);`);
      db.exec("PRAGMA foreign_keys=ON");
      chmodSync(path, 0o600);
      return new SemanticStore(db, path);
    } catch (err) { db.close(); throw err; }
  }

  close(): void { try { safeSidecars(this.path); } finally { this.db.close(); } }
  status(owner: string): SemanticStatus {
    if (hasPendingPurges(dirname(this.path))) return { status: "withheld", reason: "semantic purges pending" };
    return { status: "ready", entities: count(this.db, "entity", owner), aliases: count(this.db, "alias", owner), mentions: count(this.db, "mention", owner) };
  }
  private owns(owner: string, id: string): void {
    if (!this.db.query("SELECT 1 FROM entity WHERE id = ? AND owner = ?").get(id, owner)) throw new Error("no such entity");
  }
  addEntity(owner: string, input: EntityInput): string {
    if (!valid(owner, 512) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.slug)
      || !valid(input.kind, 48) || !valid(input.name, NAME_MAX) || !valid(input.summary, 300)
      || !Number.isSafeInteger(input.validAsOf) || !Number.isFinite(input.confidence)
      || input.confidence < 0 || input.confidence > 1) throw new Error("invalid entity");
    const id = `p:${encodeURIComponent(owner)}:${input.slug}`;
    this.db.transaction(() => {
      this.db.query("INSERT INTO entity VALUES (?, ?, ?, ?, ?, ?, 'person', ?)").run(id, owner, input.kind, input.name, input.summary, input.validAsOf, input.confidence);
      this.db.query("INSERT INTO alias VALUES (?, ?, ?)").run(owner, id, normalizeAlias(input.name));
    }).immediate();
    return id;
  }
  addAlias(owner: string, id: string, name: string): void {
    if (!valid(name, NAME_MAX)) throw new Error("invalid alias");
    this.owns(owner, id);
    this.db.query("INSERT OR IGNORE INTO alias VALUES (?, ?, ?)").run(owner, id, normalizeAlias(name));
  }
  link(owner: string, source: string, target: string, type: EdgeType, evidenceRecordId?: string): void {
    if (!EDGE_TYPES.includes(type) || source === target || (evidenceRecordId && !valid(evidenceRecordId, 128))) throw new Error("invalid edge");
    this.owns(owner, source); this.owns(owner, target);
    this.db.query("INSERT OR REPLACE INTO edge VALUES (?, ?, ?, ?, ?)").run(owner, source, target, type, evidenceRecordId ?? null);
  }
  unlink(owner: string, source: string, target: string, type: EdgeType): void {
    this.db.query("DELETE FROM edge WHERE owner = ? AND source = ? AND target = ? AND type = ?").run(owner, source, target, type);
  }
  remove(owner: string, id: string): void {
    this.owns(owner, id);
    this.db.transaction(() => {
      this.db.query("DELETE FROM mention WHERE owner = ? AND entity_id = ?").run(owner, id);
      this.db.query("DELETE FROM alias WHERE owner = ? AND entity_id = ?").run(owner, id);
      this.db.query("DELETE FROM edge WHERE owner = ? AND (source = ? OR target = ?)").run(owner, id, id);
      this.db.query("DELETE FROM entity WHERE owner = ? AND id = ?").run(owner, id);
    }).immediate();
  }
  list(owner: string): { entities: EntityRow[]; aliases: AliasRow[]; edges: unknown[] } {
    if (hasPendingPurges(dirname(this.path))) throw new Error("semantic purges pending");
    return { entities: this.db.query<EntityRow, [string]>("SELECT * FROM entity WHERE owner = ? ORDER BY id").all(owner),
      aliases: this.db.query<AliasRow, [string]>("SELECT entity_id, text FROM alias WHERE owner = ? ORDER BY entity_id, text").all(owner),
      edges: this.db.query("SELECT source, target, type, evidence_record_id FROM edge WHERE owner = ? ORDER BY source, target, type").all(owner) };
  }
  export(owner: string): string { return JSON.stringify({ version: 1, ...this.list(owner) }); }
  /** Backup reads only person-written graph rows; pending derived mention purges do not affect them. */
  exportCanonical(owner: string): string {
    return JSON.stringify({ version: 1,
      entities: this.db.query<EntityRow, [string]>("SELECT * FROM entity WHERE owner = ? ORDER BY id").all(owner),
      aliases: this.db.query<AliasRow, [string]>("SELECT entity_id, text FROM alias WHERE owner = ? ORDER BY entity_id, text").all(owner),
      edges: this.db.query("SELECT source, target, type, evidence_record_id FROM edge WHERE owner = ? ORDER BY source, target, type").all(owner),
    });
  }
  import(owner: string, raw: string): void {
    const parsed = JSON.parse(raw) as { version: number; entities: EntityRow[]; aliases: AliasRow[]; edges: { source: string; target: string; type: EdgeType; evidence_record_id?: string }[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.entities) || !Array.isArray(parsed.aliases) || !Array.isArray(parsed.edges)) throw new Error("invalid semantic export");
    this.db.transaction(() => {
      for (const e of parsed.entities) {
        const slug = e.id.split(":").at(-1) ?? "";
        if (e.owner !== owner || e.id !== `p:${encodeURIComponent(owner)}:${slug}` || e.origin !== "person"
          || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) || !valid(e.kind, 48) || !valid(e.name, NAME_MAX)
          || !valid(e.summary, 300) || !Number.isSafeInteger(e.valid_as_of)
          || !Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1) throw new Error("invalid semantic entity");
        const present = this.db.query<EntityRow, [string]>("SELECT * FROM entity WHERE id = ?").get(e.id);
        if (present && JSON.stringify(present) !== JSON.stringify(e)) throw new Error("conflicting semantic entity");
        if (!present) this.db.query("INSERT INTO entity VALUES (?, ?, ?, ?, ?, ?, 'person', ?)")
          .run(e.id, owner, e.kind, e.name, e.summary, e.valid_as_of, e.confidence);
        this.db.query("INSERT OR IGNORE INTO alias VALUES (?, ?, ?)").run(owner, e.id, normalizeAlias(e.name));
      }
      for (const a of parsed.aliases) this.addAlias(owner, a.entity_id, a.text);
      for (const e of parsed.edges) this.link(owner, e.source, e.target, e.type, e.evidence_record_id);
    }).immediate();
  }
  /** Recomputes every derived row from the caller's currently eligible records. */
  rebuild(owner: string, store: MemoryStore): void {
    // The same eligibility function is used by recall before ranking and output.
    const snapshot = store.eligibilitySnapshot(() => eligibleRecords(store, owner));
    this.sync(owner, snapshot.records, snapshot.epoch, snapshot.purges);
  }
  sync(owner: string, records: readonly SemanticRecord[], epoch: string,
    purges: readonly { store: string; record_id: string }[]): void {
    this.apply(owner, this.prepare(owner, "", records, Date.now()), epoch, purges);
  }
  apply(owner: string, prepared: PreparedSemantic, epoch: string,
    purges: readonly { store: string; record_id: string }[]): void {
    const sourcePath = join(dirname(this.path), "memory.db");
    const source = new Database(sourcePath);
    try {
      source.exec("PRAGMA busy_timeout=1000");
      source.query("ATTACH DATABASE ? AS semantic").run(this.path);
      source.transaction(() => {
        const current = source.query("SELECT 1 FROM eligibility_epoch WHERE id = 1 AND value = CAST(? AS INTEGER)").get(epoch);
        if (!current) throw new EligibilityChanged();
        const removeMention = source.query("DELETE FROM semantic.mention WHERE record_id = ?");
        const removeEdge = source.query("DELETE FROM semantic.edge WHERE evidence_record_id = ?");
        const clear = source.query("DELETE FROM semantic_purge WHERE store = ? AND record_id = ?");
        for (const marker of purges) {
          removeMention.run(marker.record_id);
          removeEdge.run(marker.record_id);
          clear.run(marker.store, marker.record_id);
        }
        source.query("DELETE FROM semantic.mention WHERE owner = ?").run(owner);
        const insert = source.query("INSERT OR IGNORE INTO semantic.mention VALUES (?, ?, ?, ?, ?, ?)");
        for (const mention of prepared.mentions) insert.run(owner, mention.entity_id, mention.store,
          mention.record_id, mention.weight, mention.revision);
        safeSidecars(sourcePath);
        safeSidecars(this.path);
      }).immediate();
    } finally { source.close(); }
  }
  prepare(owner: string, query: string, records: readonly SemanticRecord[], now: number): PreparedSemantic {
    const entities = this.db.query<EntityRow, [string]>("SELECT * FROM entity WHERE owner = ?").all(owner);
    const entityById = new Map(entities.map((e) => [e.id, e]));
    const aliases = this.db.query<AliasRow, [string]>("SELECT entity_id, text FROM alias WHERE owner = ?").all(owner);
    const direct = new Set(aliases.filter((a) => matches(query, a.text)).map((a) => a.entity_id));
    const mentionRows: MentionRow[] = records.flatMap((record) => aliases.filter((alias) => matches(record.text, alias.text))
      .map((alias) => ({ entity_id: alias.entity_id, store: record.store, record_id: record.id,
        weight: 1, revision: revision(record) })));
    const frequency = new Map<string, number>();
    for (const row of mentionRows) frequency.set(row.entity_id, (frequency.get(row.entity_id) ?? 0) + 1);
    const selected = new Map<string, { via: "direct" | "edge"; factor: number }>();
    for (const id of direct) selected.set(id, { via: "direct", factor: 1 });
    for (const id of direct) {
      if (records.length >= 25 && (frequency.get(id) ?? 0) / records.length > 0.08) continue;
      const edges = this.db.query<{ source: string; target: string }, [string, string, string]>(
        "SELECT source, target FROM edge WHERE owner = ? AND (source = ? OR target = ?)",
      ).all(owner, id, id);
      for (const edge of edges) {
        const other = edge.source === id ? edge.target : edge.source;
        if (records.length >= 25 && (frequency.get(other) ?? 0) / records.length > 0.08) continue;
        if (!selected.has(other)) selected.set(other, { via: "edge", factor: 0.25 });
      }
    }
    const hits = new Map<string, EntityHit[]>();
    const eligible = new Map(records.map((record) => [`${record.store}\0${record.id}`, record]));
    for (const row of mentionRows) {
      const selectedEntity = selected.get(row.entity_id);
      const entity = entityById.get(row.entity_id);
      const key = `${row.store}\0${row.record_id}`;
      const current = eligible.get(key);
      if (!selectedEntity || !entity || !current || revision(current) !== row.revision) continue;
      const n = records.length;
      const freq = frequency.get(row.entity_id) ?? 1;
      const idf = n <= 1 ? 1 : Math.log(n / freq) / Math.log(n);
      const boost = Math.round(20 * Math.max(0.05, idf) * selectedEntity.factor * 1000) / 1000;
      const hit = { id: entity.id, name: entity.name, stale: now - entity.valid_as_of > 45 * DAY,
        via: selectedEntity.via, boost } satisfies EntityHit;
      hits.set(key, [...(hits.get(key) ?? []), hit]);
    }
    return { mentions: mentionRows, boosts: hits };
  }
}

export function semanticStatus(home: string, owner: string): SemanticStatus {
  try {
    const db = SemanticStore.open(home);
    if (!db) return { status: "withheld", reason: "semantic.db missing" };
    try { return db.status(owner); } finally { db.close(); }
  } catch (err) { return { status: "withheld", reason: err instanceof Error ? err.message : "semantic.db unreadable" }; }
}
