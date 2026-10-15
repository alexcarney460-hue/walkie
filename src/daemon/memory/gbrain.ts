// Optional customer-installed GBrain. Each person has a separate local PGLite home.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MemoryStore, type MemoryEntry } from "./store.ts";

type Entry = MemoryEntry & { confidence: number };
type Manifest = Record<string, { id: string; sha256: string }>;
interface Settings { enabled: boolean; binary: string; unavailable?: string }
export interface GbrainStatus { state: "not_enabled" | "ready" | "unavailable"; reason?: string; version?: string; pageCount?: number }
export interface GbrainHit { id: string; slug: string; text: string; score: number; updatedAt: number }

const TIMEOUT_MS = 15_000;
const OUTPUT_MAX = 512_000;
const ID = /^(?:m|l)-[0-9a-f]{32}$/;

export function gbrainPaths(home: string, person: string) {
  if (!person) throw new Error("person is required");
  const directory = join(home, "people", createHash("sha256").update(person).digest("hex"));
  return { directory, brain: join(directory, "gbrain"), settings: join(directory, "gbrain-settings.json"), manifest: join(directory, "gbrain-manifest.json") };
}

function safeDirectory(path: string): void {
  if (existsSync(path)) {
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("invalid gbrain directory");
  } else mkdirSync(path, { mode: 0o700 });
}

function prepare(home: string, person: string) {
  const paths = gbrainPaths(home, person);
  safeDirectory(home);
  safeDirectory(join(home, "people"));
  safeDirectory(paths.directory);
  safeDirectory(paths.brain);
  if (existsSync(join(paths.brain, ".gbrain"))) safeDirectory(join(paths.brain, ".gbrain"));
  return verifiedPaths(paths);
}

function isInside(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part !== "" && part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}

function verifiedPaths(paths: ReturnType<typeof gbrainPaths>) {
  if (!existsSync(paths.directory) || !existsSync(paths.brain)) return paths;
  const directory = realpathSync(paths.directory);
  const brain = realpathSync(paths.brain);
  if (!isInside(directory, brain)) throw new Error("gbrain is outside personal store");
  return { directory, brain, settings: join(directory, "gbrain-settings.json"), manifest: join(directory, "gbrain-manifest.json") };
}

function inspect(home: string, person: string) {
  const paths = gbrainPaths(home, person);
  for (const path of [home, join(home, "people"), paths.directory, paths.brain, join(paths.brain, ".gbrain")]) {
    let st;
    try { st = lstatSync(path); }
    catch (err) { if (err instanceof Error && "code" in err && err.code === "ENOENT") continue; throw err; }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("invalid gbrain directory");
  }
  return verifiedPaths(paths);
}

function readJson(path: string, requirePrivate = true): unknown {
  if (!existsSync(path)) return undefined;
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || (requirePrivate && (st.mode & 0o077) !== 0) || st.size > 1_000_000) throw new Error("unsafe gbrain metadata");
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    const old = existsSync(path) ? lstatSync(path) : null;
    if (old && (!old.isFile() || old.isSymbolicLink())) throw new Error("unsafe gbrain metadata");
    // rename is atomic on the same volume; a crash leaves the prior manifest intact.
    renameSync(tmp, path);
  } finally { if (existsSync(tmp)) rmSync(tmp); }
}

function settings(path: string): Settings | null {
  const raw = readJson(path);
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Settings>;
  if (typeof value.enabled !== "boolean" || typeof value.binary !== "string") throw new Error("invalid gbrain settings");
  return { enabled: value.enabled, binary: value.binary, ...(typeof value.unavailable === "string" ? { unavailable: value.unavailable } : {}) };
}

function manifest(path: string): Manifest {
  const raw = readJson(path);
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid gbrain manifest");
  const result = raw as Manifest;
  if (Object.entries(result).some(([slug, row]) => !/^sq-[0-9a-f]{64}$/.test(slug) || !ID.test(row?.id)
    || !/^[0-9a-f]{64}$/.test(row?.sha256))) throw new Error("invalid gbrain manifest");
  return result;
}

function unavailable(path: string, current: Settings, reason: string): void {
  saveJson(path, { ...current, unavailable: reason });
}

function childEnv(brain: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: brain, GBRAIN_HOME: brain,
    GBRAIN_SELF_UPGRADE_MODE: "off", GBRAIN_NO_BANNER: "1" };
}

class GbrainDisabled extends Error {}

async function call(binary: string, brain: string, args: string[], input?: string): Promise<string> {
  // There is no await between this check and spawn, so a queued disable cannot be bypassed.
  if (!stillEnabled(brain)) throw new GbrainDisabled("gbrain not enabled");
  const proc = Bun.spawn([binary, ...args], { cwd: brain, env: childEnv(brain), stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe", stderr: "pipe" });
  if (input !== undefined && proc.stdin) { proc.stdin.write(input); proc.stdin.end(); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { proc.kill(); reject(new Error("gbrain timeout")); }, TIMEOUT_MS); }),
    ]);
    const [stdout, stderr, code] = output;
    if (stdout.length > OUTPUT_MAX || stderr.length > OUTPUT_MAX) throw new Error("gbrain output too large");
    if (code !== 0) throw new Error(/lock|busy|pglite/i.test(stderr) ? "gbrain PGLite lock or unavailable" : "gbrain command failed");
    return stdout.trim();
  } finally { if (timer) clearTimeout(timer); }
}

function containedPath(brain: string, value: string): boolean {
  if (!isAbsolute(value) || value.includes("\0") || value.split(sep).includes("..")) return false;
  let ancestor = value;
  const remaining: string[] = [];
  while (true) {
    try { lstatSync(ancestor); break; }
    catch (err) {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err;
      const slash = ancestor.lastIndexOf(sep);
      if (slash < 0) return false;
      remaining.unshift(ancestor.slice(slash + 1));
      ancestor = slash === 0 ? sep : ancestor.slice(0, slash);
    }
  }
  let actual = realpathSync(ancestor);
  for (const part of remaining) {
    if (part === "..") return false;
    const next = join(actual, part);
    try {
      const stat = lstatSync(next);
      if (stat.isSymbolicLink()) return false;
      actual = realpathSync(next);
    } catch (err) {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err;
      actual = next;
    }
  }
  const root = realpathSync(brain);
  return actual === root || actual.startsWith(`${root}${sep}`);
}

function localConfig(brain: string): boolean {
  const value = readJson(join(brain, ".gbrain", "config.json"), false);
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  const paths: unknown[] = [];
  const pending: unknown[] = [config];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) { pending.push(...node); continue; }
    for (const [key, item] of Object.entries(node)) {
      if (/(?:path|root|directory|dir|folder)$/i.test(key)) paths.push(item);
      else pending.push(item);
    }
  }
  if (!paths.every((path) => path === undefined || path === null || path === "" ||
    (typeof path === "string" && containedPath(brain, path)))) throw new Error("gbrain storage path outside personal brain");
  const model = config.embedding_model ?? config.embeddingModel ?? (config.embedding as Record<string, unknown> | undefined)?.model;
  if (typeof model !== "string" || !model.startsWith("ollama:")) return false;
  const urls: unknown[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 5) return;
    for (const [key, item] of Object.entries(node)) {
      const next = `${path}.${key}`.toLowerCase();
      if (/(?:ollama|embedding)/.test(next) && /(?:base.?url|endpoint|host|^url$)/i.test(key)) urls.push(item);
      else visit(item, next, depth + 1);
    }
  };
  visit(config, "", 0);
  return urls.every((item) => {
    if (item === undefined || item === null || item === "") return true;
    if (typeof item !== "string") return false;
    try { const url = new URL(item); return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); }
    catch { return false; }
  });
}

async function safeSources(binary: string, brain: string): Promise<void> {
  const raw: unknown = JSON.parse(await call(binary, brain, ["sources", "list", "--json"]));
  if (!raw || typeof raw !== "object" || !("sources" in raw) || !Array.isArray(raw.sources)
    || raw.sources.length !== 1) throw new Error("gbrain requires only its default source");
  const source: unknown = raw.sources[0];
  if (!source || typeof source !== "object" || !("id" in source) || source.id !== "default"
    || !("local_path" in source) || typeof source.local_path !== "string"
    || !containedPath(brain, source.local_path)) throw new Error("gbrain source outside personal brain or not default");
}

async function safeStorage(binary: string, brain: string): Promise<void> {
  if (!localConfig(brain)) throw new Error("needs a local model");
  await safeSources(binary, brain);
}

async function version(binary: string, brain: string): Promise<string> {
  const output = await call(binary, brain, ["--version"]);
  const match = /^gbrain (\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/m.exec(output);
  if (!match || Number(match[1]) < 0 || (Number(match[1]) === 0 && Number(match[2]) < 59)
    || (Number(match[1]) === 0 && Number(match[2]) === 59 && Number(match[3]) < 3)) throw new Error("gbrain 0.59.3 or newer is required");
  return match[0];
}

const personQueue = new Map<string, Promise<void>>();
const disableRequested = new Set<string>();

function personLockKey(home: string, person: string): string {
  const absolute = resolve(home);
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const base = resolve(realpathSync(ancestor), relative(ancestor, absolute));
  return gbrainPaths(base, person).brain;
}

function stillEnabled(brain: string): boolean {
  return !disableRequested.has(brain) && settings(join(dirname(brain), "gbrain-settings.json"))?.enabled === true;
}

async function withPersonLock<T>(home: string, person: string, work: () => Promise<T>): Promise<T> {
  const key = personLockKey(home, person);
  const prior = personQueue.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolveDone) => { release = resolveDone; });
  const queued = prior.then(() => done);
  personQueue.set(key, queued);
  await prior;
  try { return await work(); }
  finally {
    release();
    if (personQueue.get(key) === queued) personQueue.delete(key);
  }
}

export async function gbrainEnable(home: string, person: string, binary = "gbrain"): Promise<GbrainStatus> {
  if (binary.includes("/") && !isAbsolute(binary)) throw new Error("gbrain path must be absolute");
  return withPersonLock(home, person, async () => {
    try {
      const paths = prepare(home, person);
      saveJson(paths.settings, { enabled: true, binary });
      await version(binary, paths.brain);
      // Existing brains are not reset. Init only when config is absent.
      if (!existsSync(join(paths.brain, ".gbrain", "config.json"))) {
        await call(binary, paths.brain, ["init", "--pglite", "--embedding-model", "ollama:nomic-embed-text",
          "--embedding-dimensions", "768", "--non-interactive", "--skip-embed-check"]);
      }
      await safeStorage(binary, paths.brain);
      return statusUnlocked(home, person);
    } catch (err) {
      if (err instanceof GbrainDisabled) return { state: "not_enabled" };
      const reason = err instanceof Error ? err.message : "gbrain unavailable";
      try {
        const paths = inspect(home, person);
        const current = settings(paths.settings);
        if (current?.enabled) unavailable(paths.settings, current, reason);
      } catch { /* an unsafe path cannot store status */ }
      return { state: "unavailable", reason };
    }
  });
}

export async function gbrainDisable(home: string, person: string): Promise<GbrainStatus> {
  const key = personLockKey(home, person);
  disableRequested.add(key);
  try {
    return await withPersonLock(home, person, async () => {
      const paths = inspect(home, person);
      const current = settings(paths.settings);
      if (current) saveJson(paths.settings, { ...current, enabled: false });
      return { state: "not_enabled" };
    });
  } finally { disableRequested.delete(key); }
}

export async function gbrainDelete(home: string, person: string): Promise<void> {
  return withPersonLock(home, person, async () => {
    const paths = inspect(home, person);
    const current = settings(paths.settings);
    if (current?.enabled) throw new Error("disable gbrain before deleting its files");
    if (existsSync(paths.brain)) rmSync(paths.brain, { recursive: true });
    for (const path of [paths.settings, paths.manifest]) if (existsSync(path)) rmSync(path);
  });
}

async function statusUnlocked(home: string, person: string): Promise<GbrainStatus> {
  try {
    const paths = inspect(home, person);
    const current = settings(paths.settings);
    if (!current?.enabled) return { state: "not_enabled" };
    if (current.unavailable) return { state: "unavailable", reason: current.unavailable };
    await safeStorage(current.binary, paths.brain);
    const found = await version(current.binary, paths.brain);
    if (!stillEnabled(paths.brain)) return { state: "not_enabled" };
    return { state: "ready", version: found, pageCount: Object.keys(manifest(paths.manifest)).length };
  } catch (err) { return err instanceof GbrainDisabled ? { state: "not_enabled" }
    : { state: "unavailable", reason: err instanceof Error ? err.message : "gbrain unavailable" }; }
}

export async function gbrainStatus(home: string, person: string): Promise<GbrainStatus> {
  return withPersonLock(home, person, () => statusUnlocked(home, person));
}

function slug(id: string): string { return `sq-${createHash("sha256").update(id).digest("hex")}`; }
function page(entry: Entry): string {
  const title = entry.text.split("\n")[0]?.slice(0, 80) || entry.id;
  return `---\ntitle: ${JSON.stringify(title)}\ntype: ${JSON.stringify(entry.kind)}\nsqwakie_record_id: ${JSON.stringify(entry.id)}\n---\n\n${entry.text}\n`;
}

function approvedEntries(home: string, person: string): Entry[] {
  const store = MemoryStore.open(home);
  try { return store.recallEntries(person).filter((entry) => ID.test(entry.id) && !entry.retracted); }
  finally { store.close(); }
}

function sameRevision(home: string, person: string, id: string, sha256: string): boolean {
  const entry = approvedEntries(home, person).find((row) => row.id === id);
  return !!entry && createHash("sha256").update(page(entry)).digest("hex") === sha256;
}

export async function gbrainSync(home: string, person: string): Promise<GbrainStatus> {
  return withPersonLock(home, person, () => syncUnlocked(home, person));
}

async function syncUnlocked(home: string, person: string): Promise<GbrainStatus> {
  try {
    const paths = inspect(home, person);
    const current = settings(paths.settings);
    if (!current?.enabled) return { state: "not_enabled" };
    await safeStorage(current.binary, paths.brain);
    const found = await version(current.binary, paths.brain);
    const old = manifest(paths.manifest);
    const eligible = approvedEntries(home, person);
    const desired = eligible.map((entry) => {
      const content = page(entry);
      return { key: slug(entry.id), content, row: { id: entry.id, sha256: createHash("sha256").update(content).digest("hex") } };
    });
    const desiredKeys = new Set(desired.map((item) => item.key));
    const removals = Object.keys(old).filter((key) => !desiredKeys.has(key));
    const puts = desired.filter((item) => old[item.key]?.sha256 !== item.row.sha256);
    let next: Manifest = { ...old };
    let failures: string[] = [];
    for (const key of removals) {
      try {
        await safeStorage(current.binary, paths.brain);
        await call(current.binary, paths.brain, ["delete", key, "--source-id", "default", "--force", "--purge"]);
        next = Object.fromEntries(Object.entries(next).filter(([slug]) => slug !== key));
        saveJson(paths.manifest, next);
      } catch (err) {
        if (err instanceof GbrainDisabled) return { state: "not_enabled" };
        failures = [...failures, err instanceof Error ? err.message : "gbrain removal failed"];
      }
    }
    for (const item of puts) {
      try {
        await safeStorage(current.binary, paths.brain);
        if (!sameRevision(home, person, item.row.id, item.row.sha256)) continue;
        await call(current.binary, paths.brain, ["put", item.key, "--source-id", "default", "--force"], item.content);
        next = { ...next, [item.key]: item.row };
        saveJson(paths.manifest, next);
        if (!sameRevision(home, person, item.row.id, item.row.sha256)) {
          await safeStorage(current.binary, paths.brain);
          await call(current.binary, paths.brain, ["delete", item.key, "--source-id", "default", "--force", "--purge"]);
          next = Object.fromEntries(Object.entries(next).filter(([key]) => key !== item.key));
          saveJson(paths.manifest, next);
        }
      } catch (err) {
        if (err instanceof GbrainDisabled) return { state: "not_enabled" };
        failures = [...failures, err instanceof Error ? err.message : "gbrain put failed"];
      }
    }
    const latest = settings(paths.settings);
    if (!stillEnabled(paths.brain) || !latest?.enabled) return { state: "not_enabled" };
    if (failures.length) {
      const reason = [...new Set(failures)].join("; ");
      unavailable(paths.settings, latest, reason);
      return { state: "unavailable", reason };
    }
    const { unavailable: _previous, ...ready } = latest;
    saveJson(paths.settings, ready);
    return { state: "ready", version: found, pageCount: Object.keys(next).length };
  } catch (err) {
    if (err instanceof GbrainDisabled) return { state: "not_enabled" };
    const reason = err instanceof Error ? err.message : "gbrain unavailable";
    try {
      const paths = inspect(home, person);
      const current = settings(paths.settings);
      if (current?.enabled) unavailable(paths.settings, current, reason);
    } catch { /* an unsafe path cannot store status; lexical recall still works */ }
    return { state: "unavailable", reason };
  }
}

export async function gbrainSearch(home: string, person: string, query: string, entries: readonly Entry[], limit = 10): Promise<{ status: GbrainStatus; items: GbrainHit[] }> {
  return withPersonLock(home, person, () => searchUnlocked(home, person, query, entries, limit));
}

async function searchUnlocked(home: string, person: string, query: string, entries: readonly Entry[], limit: number): Promise<{ status: GbrainStatus; items: GbrainHit[] }> {
  const status = await statusUnlocked(home, person);
  if (status.state !== "ready") return { status, items: [] };
  try {
    const paths = inspect(home, person);
    const current = settings(paths.settings)!;
    await safeStorage(current.binary, paths.brain);
    const result = JSON.parse(await call(current.binary, paths.brain, ["search", query, "--json", "--limit", String(limit), "--source-id", "default"]));
    await safeStorage(current.binary, paths.brain);
    if (!Array.isArray(result)) throw new Error("malformed gbrain search output");
    const approved = new Map(entries.filter((entry) => ID.test(entry.id) && !entry.retracted).map((entry) => [entry.id, entry]));
    const index = manifest(paths.manifest);
    const seen = new Set<string>();
    const items: GbrainHit[] = result.slice(0, limit).map((raw: unknown) => {
      if (!raw || typeof raw !== "object") throw new Error("malformed gbrain search output");
      const row = raw as Record<string, unknown>;
      if (typeof row.slug !== "string" || typeof row.chunk_text !== "string" || row.source_id !== "default"
        || typeof row.score !== "number" || !Number.isFinite(row.score)) throw new Error("malformed gbrain search output");
      const id = index[row.slug]?.id;
      const entry = id ? approved.get(id) : undefined;
      return entry ? { id: entry.id, slug: row.slug, text: row.chunk_text.slice(0, 1200), score: row.score,
        updatedAt: entry.created_at } : null;
    }).filter((item): item is GbrainHit => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    if (!stillEnabled(paths.brain)) return { status: { state: "not_enabled" }, items: [] };
    return { status, items };
  } catch (err) {
    if (err instanceof GbrainDisabled) return { status: { state: "not_enabled" }, items: [] };
    const reason = err instanceof Error ? err.message : "gbrain unavailable";
    try {
      const paths = inspect(home, person);
      const current = settings(paths.settings);
      if (current?.enabled) unavailable(paths.settings, current, reason);
    } catch { /* an unsafe path cannot store status; lexical recall still works */ }
    return { status: { state: "unavailable", reason }, items: [] };
  }
}

// Used by the disposable real-binary smoke to inspect page persistence through the same child boundary.
export async function gbrainGet(home: string, person: string, slug: string, includeDeleted = false): Promise<string> {
  if (!/^sq-[0-9a-f]{64}$/.test(slug)) throw new Error("invalid gbrain slug");
  return withPersonLock(home, person, async () => {
    const status = await statusUnlocked(home, person);
    if (status.state !== "ready") throw new Error(status.reason ?? "gbrain not enabled");
    const paths = inspect(home, person);
    const current = settings(paths.settings);
    if (!current?.enabled) throw new Error("gbrain not enabled");
    const output = await call(current.binary, paths.brain, ["get", slug, "--include-content", "--source-id", "default",
      ...(includeDeleted ? ["--include-deleted"] : [])]);
    if (!stillEnabled(paths.brain)) throw new Error("gbrain not enabled");
    try {
      const parsed: unknown = JSON.parse(output);
      if (parsed && typeof parsed === "object" && "content" in parsed && typeof parsed.content === "string") return parsed.content;
    } catch { /* the CLI may print the canonical markdown directly */ }
    return output;
  });
}
