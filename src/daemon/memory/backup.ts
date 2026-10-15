// Person-controlled, local encrypted copies of canonical personal memory.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KeyStore } from "../../accounts/vault/keystore.ts";
import { gbrainPaths } from "./gbrain.ts";
import { MemoryStore, MEMORY_FILE } from "./store.ts";
import { SemanticStore, SEMANTIC_FILE } from "./semantic.ts";

export type BackupCredentialStore = Pick<KeyStore, "kind" | "get" | "put">;
export interface BackupResult { digest: string; path: string; createdAt: string; warning?: string }
type Header = { version: 1; createdAt: string; personHash: string; schema: { memory: number; entities: 1 }; counts: Record<string, number>; digest: string };
type Payload = { database: string; entities: string; gbrainSettings: string | null };

const MAGIC = Buffer.from("WALKIEMB1");
// Every migrated table must be classified. Only the explicit person tables below are copied.
// Excluded schema plumbing is created afresh by MemoryStore, never copied from the source.
export const BACKUP_TABLE_CLASSIFICATION = {
  memory: {
    memory: { scope: "person", reason: "filter by owner" },
    personal_primers: { scope: "person", reason: "filter by person" },
    personal_learnings: { scope: "person", reason: "filter by owner" },
    personal_claude_mem: { scope: "person", reason: "filter by owner" },
    memory_identity: { scope: "person", reason: "one identity for the backed-up database" },
    memory_legacy_decision: { scope: "excluded", reason: "machine decision is made at daemon startup" },
    memory_migrations: { scope: "excluded", reason: "schema ledger, retained to reopen the image" },
    semantic_purge: { scope: "excluded", reason: "derived invalidation queue, cleared" },
    eligibility_epoch: { scope: "excluded", reason: "derived epoch, reset" },
    memory_fts: { scope: "excluded", reason: "derived full-text index, dropped" },
    memory_fts_data: { scope: "excluded", reason: "derived full-text shadow, dropped" },
    memory_fts_idx: { scope: "excluded", reason: "derived full-text shadow, dropped" },
    memory_fts_content: { scope: "excluded", reason: "derived full-text shadow, dropped" },
    memory_fts_docsize: { scope: "excluded", reason: "derived full-text shadow, dropped" },
    memory_fts_config: { scope: "excluded", reason: "derived full-text shadow, dropped" },
  },
  semantic: {
    entity: { scope: "person", reason: "export by owner" },
    alias: { scope: "person", reason: "export by owner" },
    edge: { scope: "person", reason: "export by owner" },
    mention: { scope: "excluded", reason: "derived from canonical records after restore" },
  },
} as const;
const TABLES = ["memory", "personal_primers", "personal_learnings", "memory_identity", "personal_claude_mem"] as const;
const PERSON_FILTERS = new Map<string, string | null>([
  ["memory", "owner"], ["personal_primers", "person"], ["personal_learnings", "owner"],
  ["memory_identity", null], ["personal_claude_mem", "owner"],
]);
const SEMANTIC_PERSON_FILTERS = new Map<string, string>([["entity", "owner"], ["alias", "owner"], ["edge", "owner"]]);
function assertClassified(db: Database, kind: keyof typeof BACKUP_TABLE_CLASSIFICATION): void {
  const classified = new Map<string, { scope: string }>(Object.entries(BACKUP_TABLE_CLASSIFICATION[kind]));
  const filters = kind === "memory" ? PERSON_FILTERS : SEMANTIC_PERSON_FILTERS;
  for (const [name, item] of classified) {
    if (item.scope === "person" && !filters.has(name)) throw new Error(`person-scoped ${kind} backup table has no filter: ${name}`);
    if (item.scope !== "person" && filters.has(name)) throw new Error(`excluded ${kind} backup table has a person filter: ${name}`);
  }
  const actual = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of actual) if (!classified.has(name)) throw new Error(`unclassified ${kind} backup table: ${name}`);
}
const MAX_FILE = 128 * 1024 * 1024;
const MAX_MEMORY_SCHEMA = 7;
const INFO = Buffer.from("walkie-personal-memory-backup-v1", "utf8");

function hash(s: string): string { return createHash("sha256").update(s).digest("hex"); }
export function backupKeyId(person: string): string { return `memory-backup-${hash(person)}`; }
function keyFor(secret: Buffer): Buffer { return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INFO, 32)); }
function checksum(secret: Buffer): Buffer { return createHash("sha256").update("walkie-memory-recovery-v1").update(secret).digest().subarray(0, 4); }
function codeFor(secret: Buffer): string {
  const raw = Buffer.concat([secret, checksum(secret)]).toString("hex").toUpperCase();
  return raw.match(/.{1,8}/g)!.join("-");
}
function secretFor(code: string): Buffer {
  if (!/^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{8}){8}$/.test(code)) throw new Error("invalid recovery code");
  const raw = Buffer.from(code.replaceAll("-", ""), "hex");
  const secret = raw.subarray(0, 32);
  if (!checksum(secret).equals(raw.subarray(32))) throw new Error("invalid recovery code checksum");
  return secret;
}
export function recoveryKey(code: string): Buffer { return keyFor(secretFor(code)); }
function regular(path: string): boolean {
  try { const st = lstatSync(path); return st.isFile() && !st.isSymbolicLink(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
function targetExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
function privateTempOpen(dir: string): { path: string; fd: number } {
  const path = join(dir, `.memory-backup-${randomBytes(16).toString("hex")}`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  return { path, fd };
}
function privateTemp(dir: string): string {
  const { path, fd } = privateTempOpen(dir);
  closeSync(fd);
  return path;
}
let backupStep: ((name: string, path: string) => void) | undefined;
/** Fault injection is limited to this module's tests; production never sets it. */
export function setBackupStepForTests(fn: ((name: string, path: string) => void) | undefined): void { backupStep = fn; }
function canonical(db: Database, entities: string, gbrainSettings: string | null): { digest: string; counts: Record<string, number> } {
  const rows = TABLES.map((table) => {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((x) => x.name);
    const values = db.query(`SELECT * FROM ${table}`).all().map((row) => columns.map((name) => {
      const v = (row as Record<string, unknown>)[name];
      return v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v;
    }));
    return [table, columns, values.map((v) => JSON.stringify(v)).sort()] as const;
  });
  const graph = JSON.parse(entities) as { entities: unknown[]; aliases: unknown[]; edges: unknown[] };
  if (!Array.isArray(graph.entities) || !Array.isArray(graph.aliases) || !Array.isArray(graph.edges)) throw new Error("invalid entity export");
  const counts = { ...Object.fromEntries(rows.map(([table, , values]) => [table, values.length])), entities: graph.entities.length, aliases: graph.aliases.length, edges: graph.edges.length };
  const digest = hash(JSON.stringify([rows, graph, gbrainSettings]));
  return { digest, counts };
}
function personalImage(sourcePath: string, folder: string, person: string): string {
  const source = new Database(sourcePath, { readonly: true });
  try {
    assertClassified(source, "memory");
    const store = MemoryStore.open(folder, { fts: false });
    store.close();
    const path = join(folder, MEMORY_FILE);
    const target = new Database(path);
    try {
      target.transaction(() => {
        for (const table of TABLES) {
          const filter = PERSON_FILTERS.get(table);
          if (filter === undefined) throw new Error(`person-scoped memory backup table has no filter: ${table}`);
          const columns = target.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
          const sourceColumns = source.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
          if (JSON.stringify(columns) !== JSON.stringify(sourceColumns)) throw new Error(`unsupported memory backup table schema: ${table}`);
          const rows = source.query(`SELECT * FROM ${table}${filter ? ` WHERE ${filter} = ?` : ""}`).all(...(filter ? [person] : []));
          if (!filter && rows.length !== 1) throw new Error("memory backup requires exactly one database identity");
          if (!filter) target.exec(`DELETE FROM ${table}`);
          const insert = target.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
          for (const row of rows) insert.run(...columns.map((column) => {
            const value = (row as Record<string, SQLQueryBindings>)[column];
            if (value === undefined) throw new Error(`missing memory backup column: ${table}.${column}`);
            return value;
          }));
        }
        target.exec("DELETE FROM semantic_purge; UPDATE eligibility_epoch SET value = 0");
      }).immediate();
      target.exec("VACUUM");
    } finally { target.close(); }
    return path;
  } finally { source.close(); }
}
function snapshot(home: string, person: string): string {
  const store = MemoryStore.open(home, { fts: false });
  store.close();
  const folder = mkdtempSync(join(home, ".memory-snapshot-"));
  const raw = join(folder, "source.db");
  try {
    chmodSync(folder, 0o700);
    const source = new Database(join(home, MEMORY_FILE), { readonly: true });
    try {
      const oldUmask = process.umask(0o077);
      try { source.query("VACUUM INTO ?").run(raw); }
      finally { process.umask(oldUmask); }
    } finally { source.close(); }
    chmodSync(raw, 0o600);
    const path = personalImage(raw, folder, person);
    rmSync(raw);
    chmodSync(path, 0o600);
    backupStep?.("snapshot-ready", path);
    return path;
  } catch (err) { rmSync(folder, { recursive: true, force: true }); throw err; }
}
function entitiesOf(home: string, person: string): string {
  const semantic = SemanticStore.open(home);
  if (!semantic) return JSON.stringify({ version: 1, entities: [], aliases: [], edges: [] });
  try {
    const db = new Database(join(home, SEMANTIC_FILE), { readonly: true });
    try { assertClassified(db, "semantic"); } finally { db.close(); }
    return semantic.exportCanonical(person);
  } finally { semantic.close(); }
}
function settingsOf(home: string, person: string): string | null {
  const path = gbrainPaths(home, person).settings;
  if (!regular(path)) return null;
  const st = lstatSync(path);
  if ((st.mode & 0o077) !== 0 || st.size > 1_000_000) throw new Error("unsafe gbrain settings");
  const value = readFileSync(path, "utf8");
  JSON.parse(value);
  return value;
}
function statePath(home: string): string { return join(home, "memory-backup-state.json"); }
function hasRows(path: string, tables: readonly string[]): boolean {
  if (!regular(path)) return false;
  const db = new Database(path, { readonly: true });
  try { return tables.some((table) => !!db.query(`SELECT 1 FROM ${table} LIMIT 1`).get()); }
  finally { db.close(); }
}
function hasCanonicalRows(path: string): boolean {
  if (!regular(path)) return false;
  const db = new Database(path, { readonly: true });
  try {
    return [...TABLES, "memory_legacy_decision"].some((table) => {
      if (table === "memory_identity") {
        // A new store always contains one generated identity row.
        return (db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_identity").get()?.count ?? 0) > 1;
      }
      return !!db.query(`SELECT 1 FROM ${table} LIMIT 1`).get();
    });
  } finally { db.close(); }
}
export function backupStatus(home: string): BackupResult | null {
  const path = statePath(home);
  if (!regular(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as BackupResult;
  return typeof value.path === "string" && typeof value.digest === "string" && typeof value.createdAt === "string" ? value : null;
}

export async function backupInitForId(id: string, keys: BackupCredentialStore): Promise<string> {
  if (!/^memory-backup-[0-9a-f]{64}$/.test(id)) throw new Error("invalid backup identity");
  if (keys.kind !== "keychain") throw new Error("an OS credential store with create-only keys is required for memory backup init");
  if (await keys.get(id)) throw new Error("memory backup already initialized; keep the existing recovery code");
  const secret = randomBytes(32);
  const key = keyFor(secret);
  if (await keys.put(id, key) !== "created") throw new Error("memory backup key already exists");
  return codeFor(secret);
}
export async function backupInit(_home: string, person: string, keys: BackupCredentialStore): Promise<string> {
  if (!person) throw new Error("an enrolled person is required");
  return backupInitForId(backupKeyId(person), keys);
}

export async function backupExport(home: string, person: string, to: string, keys: BackupCredentialStore, replace = false): Promise<BackupResult> {
  if (!person || !to || !to.startsWith("/")) throw new Error("an enrolled person and absolute destination are required");
  if (keys.kind !== "keychain") throw new Error("memory backup needs the OS credential store");
  const key = await keys.get(backupKeyId(person));
  if (!key || key.length !== 32) throw new Error("memory backup is not initialized");
  if (targetExists(to) && (!replace || !regular(to))) throw new Error("backup target exists or is not a regular file; use --replace for an existing file");
  const dir = realpathSync(dirname(to));
  if (!lstatSync(dir).isDirectory()) throw new Error("backup directory is unsafe");
  const resolvedTo = join(dir, to.slice(dirname(to).length + 1));
  if (targetExists(resolvedTo) && (!replace || !regular(resolvedTo))) throw new Error("backup target exists or is not a regular file");
  // The destination shown to the person is the resolved directory and a final component that cannot be followed.
  const image = snapshot(home, person);
  let temp: string | undefined;
  try {
    const entities = entitiesOf(home, person);
    const gbrainSettings = settingsOf(home, person);
    const db = new Database(image, { readonly: true });
    let check: ReturnType<typeof canonical>;
    let schema: number;
    try {
      check = canonical(db, entities, gbrainSettings);
      schema = Number((db.query<{ version: number }, []>("SELECT MAX(version) AS version FROM memory_migrations").get()?.version) ?? 0);
    } finally { db.close(); }
    if (schema > MAX_MEMORY_SCHEMA) throw new Error("memory schema is newer than this backup format supports");
    const header: Header = { version: 1, createdAt: new Date().toISOString(), personHash: hash(person), schema: { memory: schema, entities: 1 }, counts: check.counts, digest: check.digest };
    const aad = Buffer.from(JSON.stringify(header));
    const payload: Payload = { database: readFileSync(image).toString("base64"), entities, gbrainSettings };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    const length = Buffer.alloc(4); length.writeUInt32BE(aad.length);
    const created = privateTempOpen(dir);
    temp = created.path;
    try {
      writeFileSync(created.fd, Buffer.concat([MAGIC, length, aad, iv, cipher.getAuthTag(), encrypted]));
      fchmodSync(created.fd, 0o600);
      fsyncSync(created.fd);
    } finally { closeSync(created.fd); }
    backupStep?.("publish-ready", temp);
    if (targetExists(resolvedTo) && (!replace || !regular(resolvedTo))) throw new Error("backup target changed before replacement");
    if (replace && targetExists(resolvedTo)) renameSync(temp, resolvedTo);
    else linkSync(temp, resolvedTo); // atomic no-overwrite publication of complete bytes
    const result = { path: resolvedTo, digest: check.digest, createdAt: header.createdAt };
    const stateTemp = privateTemp(home);
    try { writeFileSync(stateTemp, JSON.stringify(result), { mode: 0o600 }); renameSync(stateTemp, statePath(home)); }
    finally { rmSync(stateTemp, { force: true }); }
    return result;
  } finally { rmSync(dirname(image), { recursive: true, force: true }); if (temp) rmSync(temp, { force: true }); }
}

type SwapEntry = { name: string; dest: string; staged: string | null; safety: string; existed: boolean };
type SwapJournal = { version: 1; stage: string; entries: SwapEntry[] };
function journalPath(home: string): string { return join(home, "memory-restore-journal.json"); }
function publishJournal(home: string, journal: SwapJournal): void {
  const pending = privateTemp(home);
  try {
    writeFileSync(pending, JSON.stringify(journal), { mode: 0o600 });
    const fd = openSync(pending, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(pending, journalPath(home));
  } finally { rmSync(pending, { force: true }); }
}
let restoreStep: ((name: string) => void) | undefined;
/** Fault injection is limited to this module's tests; production never sets it. */
export function setRestoreStepForTests(fn: ((name: string) => void) | undefined): void { restoreStep = fn; }

export function recoverBackupRestore(home: string): void {
  const path = journalPath(home);
  if (!targetExists(path)) return;
  if (!regular(path)) throw new Error("unsafe memory restore journal");
  const journal = JSON.parse(readFileSync(path, "utf8")) as SwapJournal;
  if (journal.version !== 1 || !Array.isArray(journal.entries) || !journal.stage.startsWith(`${home}/.memory-restore-`))
    throw new Error("invalid memory restore journal");
  for (const entry of [...journal.entries].reverse()) {
    if (!entry.dest.startsWith(`${home}/`) || !entry.safety.startsWith(`${entry.dest}.safety-`)
      || (entry.staged && !entry.staged.startsWith(`${journal.stage}/`))) throw new Error("invalid memory restore journal entry");
    if (targetExists(entry.safety)) {
      if (targetExists(entry.dest)) rmSync(entry.dest);
      renameSync(entry.safety, entry.dest);
    } else if (!entry.existed && entry.staged && !targetExists(entry.staged) && targetExists(entry.dest)) {
      rmSync(entry.dest);
    }
  }
  rmSync(journal.stage, { recursive: true, force: true });
  rmSync(path);
}

export async function backupRestore(home: string, person: string, file: string, code: string | Buffer, replace = false, keys?: BackupCredentialStore): Promise<BackupResult> {
  if (!person || !regular(file)) throw new Error("an enrolled person and regular backup file are required");
  if (keys && keys.kind !== "keychain") throw new Error("memory restore needs the OS credential store");
  const bytes = readFileSync(file);
  if (bytes.length > MAX_FILE || bytes.length < MAGIC.length + 4 + 2 + 12 + 16 + 1 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("invalid or truncated memory backup");
  const n = bytes.readUInt32BE(MAGIC.length);
  if (n > 8192 || bytes.length < MAGIC.length + 4 + n + 12 + 16 + 1) throw new Error("invalid or truncated memory backup");
  const start = MAGIC.length + 4;
  const aad = bytes.subarray(start, start + n);
  const header = JSON.parse(aad.toString("utf8")) as Header;
  if (header.version !== 1 || header.personHash !== hash(person) || header.schema?.entities !== 1
    || !Number.isInteger(header.schema.memory) || header.schema.memory > MAX_MEMORY_SCHEMA)
    throw new Error("backup belongs to another person or has an unsupported version");
  const key = typeof code === "string" ? recoveryKey(code) : Buffer.from(code);
  if (key.length !== 32) throw new Error("invalid recovery key");
  const iv = bytes.subarray(start + n, start + n + 12);
  const tag = bytes.subarray(start + n + 12, start + n + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad); decipher.setAuthTag(tag);
  const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(start + n + 28)), decipher.final()]).toString("utf8")) as Payload;
  if (typeof payload.database !== "string" || typeof payload.entities !== "string") throw new Error("invalid backup content");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const homeStat = lstatSync(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error("memory home is unsafe");
  const homeFd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fchmodSync(homeFd, 0o700); } finally { closeSync(homeFd); }
  recoverBackupRestore(home);
  const stage = mkdtempSync(join(home, ".memory-restore-"));
  chmodSync(stage, 0o700);
  const image = join(stage, MEMORY_FILE);
  const incoming = join(stage, "incoming.db");
  try {
    writeFileSync(incoming, Buffer.from(payload.database, "base64"), { mode: 0o600 });
    const db = new Database(incoming, { readonly: true });
    try {
      if (db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("corrupt backup database");
      assertClassified(db, "memory");
      const check = canonical(db, payload.entities, payload.gbrainSettings);
      if (check.digest !== header.digest || JSON.stringify(check.counts) !== JSON.stringify(header.counts)) throw new Error("backup canonical digest mismatch");
      const schema = db.query<{ version: number }, []>("SELECT MAX(version) AS version FROM memory_migrations").get()?.version;
      if (schema !== header.schema.memory) throw new Error("backup schema version mismatch");
    } finally { db.close(); }
    personalImage(incoming, stage, person);
    rmSync(incoming);
    if (keys?.kind === "keychain") {
      const stored = await keys.get(backupKeyId(person));
      if (stored && !stored.equals(key)) throw new Error("this machine has a different memory backup key");
    }
    const dest = join(home, MEMORY_FILE);
    const semanticPath = join(home, SEMANTIC_FILE);
    const gbrainSettingsPath = gbrainPaths(home, person).settings;
    if ((targetExists(dest) && !regular(dest)) || (targetExists(semanticPath) && !regular(semanticPath))
      || (targetExists(gbrainSettingsPath) && !regular(gbrainSettingsPath))) throw new Error("personal memory store contains an unsafe file");
    const existing = regular(dest);
    const semanticExisting = regular(semanticPath);
    if (!replace && (hasCanonicalRows(dest)
      || hasRows(semanticPath, ["entity", "alias", "edge"]) || regular(gbrainSettingsPath)))
      throw new Error("personal memory store is non-empty; use --replace");
    if (payload.gbrainSettings !== null && typeof payload.gbrainSettings !== "string") throw new Error("invalid gbrain settings");
    if (payload.gbrainSettings !== null) JSON.parse(payload.gbrainSettings);
    const paths = gbrainPaths(home, person);
    for (const dir of [join(home, "people"), paths.directory]) {
      if (targetExists(dir)) {
        const st = lstatSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("unsafe gbrain settings directory");
      }
    }
    const memory = MemoryStore.open(stage);
    try {
      const semantic = SemanticStore.create(stage);
      try { semantic.import(person, payload.entities); semantic.rebuild(person, memory); }
      finally { semantic.close(); }
    } finally { memory.close(); }
    const settingsStage = join(stage, "gbrain-settings.json");
    if (payload.gbrainSettings !== null) writeFileSync(settingsStage, payload.gbrainSettings, { flag: "wx", mode: 0o600 });
    const restoredDb = new Database(image, { readonly: true });
    let restoredDigest: string;
    try { restoredDigest = canonical(restoredDb, entitiesOf(stage, person), payload.gbrainSettings).digest; }
    finally { restoredDb.close(); }
    if (restoredDigest !== header.digest) throw new Error("restored canonical digest mismatch");
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    const entries: SwapEntry[] = [
      { name: "memory", dest, staged: image, safety: `${dest}.safety-${randomBytes(8).toString("hex")}`, existed: existing },
      { name: "semantic", dest: semanticPath, staged: join(stage, SEMANTIC_FILE), safety: `${semanticPath}.safety-${randomBytes(8).toString("hex")}`, existed: semanticExisting },
      { name: "settings", dest: gbrainSettingsPath, staged: payload.gbrainSettings === null ? null : settingsStage,
        safety: `${gbrainSettingsPath}.safety-${randomBytes(8).toString("hex")}`, existed: regular(gbrainSettingsPath) },
    ];
    const journal: SwapJournal = { version: 1, stage, entries };
    publishJournal(home, journal); // complete journal before the first rename
    try {
      restoreStep?.("journal");
      for (const entry of entries) {
        if (entry.existed) renameSync(entry.dest, entry.safety);
        restoreStep?.(`move-${entry.name}`);
        if (entry.staged) renameSync(entry.staged, entry.dest);
        restoreStep?.(`install-${entry.name}`);
      }
      const installed = new Database(dest, { readonly: true });
      let installedDigest: string;
      try { installedDigest = canonical(installed, entitiesOf(home, person), settingsOf(home, person)).digest; }
      finally { installed.close(); }
      if (installedDigest !== header.digest) throw new Error("installed memory digest mismatch");
      rmSync(journalPath(home));
    } catch (err) { recoverBackupRestore(home); throw err; }
    let warning: string | undefined;
    if (keys?.kind === "keychain") {
      try {
        const current = await keys.get(backupKeyId(person));
        if (current && !current.equals(key)) throw new Error("memory backup key changed during restore");
        if (!current && await keys.put(backupKeyId(person), key) !== "created") {
          throw new Error("memory backup key changed during restore");
        }
      } catch {
        // The swap is committed. A failed or uncertain credential write cannot undo it.
        let stored: Buffer | null = null;
        try { stored = await keys.get(backupKeyId(person)); } catch { /* unavailable */ }
        if (!stored?.equals(key)) warning = "Restore succeeded, but the backup key could not be saved to the credential store. Run walkie memory backup init before the next export.";
      }
    }
    return { digest: restoredDigest, path: file, createdAt: header.createdAt, ...(warning ? { warning } : {}) };
  } finally { if (!targetExists(journalPath(home))) rmSync(stage, { recursive: true, force: true }); }
}
