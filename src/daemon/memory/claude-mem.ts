// Optional customer-installed claude-mem source. This module never creates or changes its database.
import { Database, constants as sqliteConstants } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { FULL_REDACTION_MAX, redactSecrets } from "../../protocol/safety.ts";
import { learningTextUnsafe } from "./learning.ts";

export interface ClaudeMemSettings {
  enabled: boolean;
  path: string;
  freshnessDays: number;
  allowedProjects: readonly string[];
}
export type ClaudeMemState = "disabled" | "no_allowed_project" | "ready" | "unavailable" | "withheld";
export interface ClaudeMemStatus { state: ClaudeMemState; reason?: string }
export interface ClaudeMemItem { id: number; project: string; date: string; text: string; updatedAt: number; score: number }
interface Observation {
  id: number; project: string; type: string; title: string | null; subtitle: string | null;
  narrative: string | null; text: string | null; facts: string | null; concepts: string | null;
  created_at_epoch: number; rank?: number;
}
interface Deps {
  scrub?: typeof redactSecrets;
  classify?: typeof learningTextUnsafe;
  open?: (uri: string, flags: number) => Database;
}
const REQUIRED = ["id", "project", "type", "title", "subtitle", "narrative", "text", "facts", "concepts", "created_at_epoch"];
const DAY = 86_400_000;
const MAX_RESULTS = 10;
const MAX_CANDIDATES = 200;
interface FileSnapshot { size: bigint; mtimeNs: bigint; dev: bigint; ino: bigint }
interface Opened { db?: Database; status: ClaudeMemStatus; snapshot?: FileSnapshot; path?: string }

export function defaultClaudeMemPath(home = homedir()): string { return join(home, ".claude-mem", "claude-mem.db"); }

/** Validate the chosen location before persisting it. A missing regular file can be enabled but stays unavailable. */
export function claudeMemPathAllowed(path: string, home = homedir()): boolean {
  if (!isAbsolute(path) || !isAbsolute(home)) return false;
  if (path.split(sep).includes("..")) return false;
  const abs = resolve(path);
  const base = resolve(home);
  const rel = relative(base, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  try {
    if (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()) return false;
    let current = base;
    let missing = false;
    const parts = rel.split(sep);
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      if (missing) continue;
      let stat;
      try { stat = lstatSync(current); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
        missing = true;
        continue;
      }
      if (stat.isSymbolicLink()) return false;
      if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
    }
    return true;
  } catch { return false; }
}

function safePath(path: string, home: string): boolean {
  if (!claudeMemPathAllowed(path, home)) return false;
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function absentSidecars(path: string): boolean {
  return ["-wal", "-shm"].every((suffix) => {
    try { lstatSync(`${path}${suffix}`); return false; }
    catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; }
  });
}

function walReadPlan(path: string): { snapshot?: FileSnapshot } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = fstatSync(fd, { bigint: true });
    if (!file.isFile()) return null;
    const header = Buffer.alloc(2);
    if (readSync(fd, header, 0, 2, 18) !== 2) return null;
    if (header[0] !== 2 && header[1] !== 2) return {};
    const sidecars = ["-wal", "-shm"].map((suffix) => {
      try {
        const stat = lstatSync(`${path}${suffix}`);
        return stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() ? "safe" : "unsafe";
      } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe"; }
    });
    if (sidecars.every((state) => state === "safe")) return {};
    if (sidecars.every((state) => state === "absent")) {
      return { snapshot: { size: file.size, mtimeNs: file.mtimeNs, dev: file.dev, ino: file.ino } };
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function unchanged(probe: Opened): boolean {
  if (!probe.snapshot || !probe.path) return true;
  try {
    const file = lstatSync(probe.path, { bigint: true });
    const before = probe.snapshot;
    return file.isFile() && !file.isSymbolicLink() && absentSidecars(probe.path)
      && file.size === before.size && file.mtimeNs === before.mtimeNs
      && file.dev === before.dev && file.ino === before.ino;
  } catch { return false; }
}

function finishRead<T>(probe: Opened, result: ClaudeMemStatus & T, empty: T): ClaudeMemStatus & T {
  try { probe.db?.close(); } catch { return { state: "unavailable", reason: "claude-mem database could not be read", ...empty }; }
  return unchanged(probe) ? result : { state: "unavailable", reason: "claude-mem changed during the read", ...empty };
}

function opened(settings: ClaudeMemSettings, home: string, deps: Deps): Opened {
  if (!settings.enabled) return { status: { state: "disabled" } };
  if (!settings.allowedProjects.length) return { status: { state: "no_allowed_project" } };
  if (!safePath(settings.path, home)) return { status: { state: "unavailable", reason: "database path is missing, linked, or outside the person's home" } };
  const plan = walReadPlan(settings.path);
  if (!plan) return { status: { state: "unavailable", reason: "claude-mem WAL sidecars are missing or unsafe" } };
  let db: Database | undefined;
  try {
    const uri = `${pathToFileURL(settings.path).href}?mode=ro${plan.snapshot ? "&immutable=1" : ""}`;
    db = (deps.open ?? ((path, flags) => new Database(path, flags)))(uri,
      sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI);
    db.exec("PRAGMA busy_timeout=100; PRAGMA query_only=1; PRAGMA temp_store=MEMORY");
    const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(observations)").all().map((x) => x.name));
    const fts = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='observations_fts'").get();
    if (!REQUIRED.every((x) => cols.has(x)) || !fts?.sql?.toLowerCase().includes("fts5")) {
      db.close();
      return { status: { state: "unavailable", reason: "claude-mem schema is unsupported" } };
    }
    return { db, status: { state: "ready" }, snapshot: plan.snapshot, path: settings.path };
  } catch {
    try { db?.close(); } catch { /* preserve the unavailable result */ }
    return { status: { state: "unavailable", reason: "claude-mem database could not be read" } };
  }
}

function safeObservation(row: Observation, deps: Deps): boolean {
  const fields = [row.project, row.type, row.title, row.subtitle, row.narrative,
    row.text, row.facts, row.concepts].map((value) => value ?? "");
  const content = fields.join("\n");
  if (content.length > FULL_REDACTION_MAX) return false;
  return fields.map((value) => safeField(value, deps)).every(Boolean) && safeField(content, deps);
}

function safeField(value: string, deps: Deps): boolean {
  if (value.length > FULL_REDACTION_MAX) return false;
  const unsafe = (deps.classify ?? learningTextUnsafe)(value);
  const redacted = (deps.scrub ?? redactSecrets)(value).redactions.length > 0;
  return !unsafe && !redacted;
}

export function displayClaudeMemProject(name: string): string {
  try { return safeField(name, {}) ? name : "[withheld]"; }
  catch { return "[withheld]"; }
}

function timestamp(epoch: number): number { return epoch < 1_000_000_000_000 ? epoch * 1000 : epoch; }
function fresh(row: Observation, settings: ClaudeMemSettings, now: number): boolean {
  const at = timestamp(row.created_at_epoch);
  return Number.isFinite(at) && at <= now && at >= now - settings.freshnessDays * DAY;
}
function allowed(settings: ClaudeMemSettings): string[] {
  return [...new Set(settings.allowedProjects)].filter((p) => typeof p === "string" && p.length > 0 && p.length <= 500).slice(0, 100);
}
function rows(db: Database, settings: ClaudeMemSettings, where: string, args: (string | number)[]): Observation[] {
  const projects = allowed(settings);
  if (!projects.length) return [];
  const placeholders = projects.map(() => "?").join(",");
  return db.query<Observation, (string | number)[]>(`SELECT o.id,o.project,o.type,o.title,o.subtitle,o.narrative,o.text,o.facts,o.concepts,o.created_at_epoch
    ${where.includes("MATCH") ? ",bm25(observations_fts) AS rank" : ""}
    FROM observations o ${where.includes("MATCH") ? "JOIN observations_fts ON observations_fts.rowid=o.id" : ""}
    WHERE o.project IN (${placeholders}) AND ${where}
    ORDER BY ${where.includes("MATCH") ? "bm25(observations_fts) ASC," : ""} o.created_at_epoch DESC LIMIT ?`)
    .all(...projects, ...args, MAX_CANDIDATES);
}

export function claudeMemProjects(settings: ClaudeMemSettings, home = homedir(), deps: Deps = {}): ClaudeMemStatus & { projects: { name: string; count: number }[] } {
  // A person may inspect available projects before allowing any of them.
  const probe = opened({ ...settings, allowedProjects: ["__probe__"] }, home, deps);
  if (!probe.db) return { ...probe.status, projects: [] };
  const db = probe.db;
  const read = (): ClaudeMemStatus & { projects: { name: string; count: number }[] } => {
    let suppressing = false;
    try {
      const projects = db.query<{ name: string; count: number }, []>(
        "SELECT project AS name, COUNT(*) AS count FROM observations GROUP BY project ORDER BY project",
      ).all();
      suppressing = true;
      const safeProjects = projects.map((project) => ({ ...project,
        name: safeField(project.name, deps) ? project.name : "[withheld]" }));
      return { state: "ready", projects: safeProjects };
    } catch { return { state: suppressing ? "withheld" : "unavailable",
      reason: suppressing ? "claude-mem suppression check failed" : "claude-mem projects could not be read", projects: [] }; }
  };
  return finishRead(probe, read(), { projects: [] });
}

export function searchClaudeMem(settings: ClaudeMemSettings, query: string, home = homedir(), now = Date.now(), deps: Deps = {}): ClaudeMemStatus & { items: ClaudeMemItem[] } {
  const probe = opened(settings, home, deps);
  if (!probe.db) return { ...probe.status, items: [] };
  const db = probe.db;
  const read = (): ClaudeMemStatus & { items: ClaudeMemItem[] } => {
    let suppressing = false;
    try {
      const terms = [...new Set(query.match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 12);
      if (!terms.length) return { state: "ready", items: [] };
      const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
      const candidates = rows(db, settings, "observations_fts MATCH ?", [expression]);
      const items: ClaudeMemItem[] = [];
      for (const row of candidates) {
        if (!fresh(row, settings, now)) continue;
        suppressing = true;
        if (!safeObservation(row, deps)) continue;
        suppressing = false;
        const updatedAt = timestamp(row.created_at_epoch);
        const text = row.text || row.narrative || row.facts || row.title || "";
        if (!text) continue;
        items.push({ id: row.id, project: row.project, date: new Date(updatedAt).toISOString().slice(0, 10),
          text: text.slice(0, 1200), updatedAt,
          score: Math.round((3 + Math.min(1, Math.max(0, -(row.rank ?? 0)))
            + Math.max(0, 1 - (now - updatedAt) / (settings.freshnessDays * DAY))) * 1000) / 1000 });
      }
      return { state: "ready", items: items.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, MAX_RESULTS) };
    } catch {
      return { state: suppressing ? "withheld" : "unavailable",
        reason: suppressing ? "claude-mem suppression check failed" : "claude-mem source could not be queried", items: [] };
    }
  };
  return finishRead(probe, read(), { items: [] });
}

export function claudeMemEligible(settings: ClaudeMemSettings, home = homedir(), now = Date.now(), deps: Deps = {}): ClaudeMemStatus & { ids: number[]; revision: string } {
  const empty = createHash("sha256").update("[]").digest("hex");
  const probe = opened(settings, home, deps);
  if (!probe.db) return { ...probe.status, ids: [], revision: empty };
  const db = probe.db;
  const read = (): ClaudeMemStatus & { ids: number[]; revision: string } => {
    try {
      const projects = allowed(settings);
      const placeholders = projects.map(() => "?").join(",");
      const ids: number[] = [];
      const revision = createHash("sha256").update(JSON.stringify([settings.allowedProjects, settings.freshnessDays]));
      let after = 0;
      db.exec("BEGIN");
      for (;;) {
        const page = db.query<Observation, (string | number)[]>(`SELECT id,project,type,title,subtitle,narrative,text,facts,concepts,created_at_epoch
          FROM observations WHERE project IN (${placeholders}) AND id > ? ORDER BY id LIMIT ?`)
          .all(...projects, after, MAX_CANDIDATES);
        if (!page.length) break;
        for (const row of page) if (fresh(row, settings, now) && safeObservation(row, deps)) {
          ids.push(row.id);
          revision.update(JSON.stringify(row));
        }
        after = page[page.length - 1]!.id;
      }
      db.exec("COMMIT");
      return { state: "ready", ids, revision: revision.digest("hex") };
    } catch { return { state: "withheld", reason: "claude-mem eligibility could not be verified", ids: [], revision: empty }; }
  };
  return finishRead(probe, read(), { ids: [], revision: empty });
}
