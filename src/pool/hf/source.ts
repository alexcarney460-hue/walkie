// Where the model list comes from. Fetched when a person asks (the dashboard through the daemon, or `walkie pool`), by the
// machine that asks, kept on disk for about a day, never on a timer. When Hugging Face cannot be used: the previous list
// if it is under 30 days old, else the list built into Walkie, and the view says which and why. A failure is remembered
// for 15 minutes so an offline machine is not retried on every command. docs/plans/LOCAL-MODELS-HF-1.md "Source".
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CATALOG, type Catalog } from "../catalog.ts";
import { CatalogSchema } from "../catalog-schema.ts";
import { buildCatalog } from "./build.ts";
import { HfClient, HfError } from "./client.ts";
import { lockPath, takeLock } from "./refresh-lock.ts";
import type { ModelsView } from "./view.ts";

export type { ModelsView };

export const DAY_MS = 24 * 3600_000;
/** A list older than this is not used even when nothing newer can be had. */
export const STALE_MS = 30 * DAY_MS;
export const FAILURE_BACKOFF_MS = 15 * 60_000;
/** Manual refreshes at least this far apart. */
export const REFRESH_GAP_MS = 60_000;
/** A whole refresh must be over in this long. */
export const REFRESH_DEADLINE_MS = 120_000;
const FILE_MAX = 2 << 20;

export const cachePath = (home: string): string => join(home, "pool", "hf-catalog.json");
export { lockPath };
const BUSY_NOTE = "Another Walkie process is reading Hugging Face right now; this is the list there is, try again in a minute.";

const Stats = z.object({ requests: z.number().int().nonnegative(), models: z.number().int().nonnegative(), skipped: z.record(z.string().max(30), z.number().int().nonnegative()) });
const CacheFile = z.object({
  v: z.literal(1),
  fetched_at: z.number().int().positive().optional(),
  catalog: CatalogSchema.optional(),
  stats: Stats.optional(),
  failed: z.object({ at: z.number().int().positive(), kind: z.string().max(20), message: z.string().max(300) }).optional(),
});
type CacheFile = z.infer<typeof CacheFile>;

export interface SourceOptions {
  home: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** The list shipped with Walkie. */
  builtin?: Catalog;
  minModels?: number;
  ttlMs?: number;
  /** Daemon log: event name and counts, never payloads. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  progress?: (note: string) => void;
  /** `false`: take no refresh lock (tests that race two reads on purpose; a source that cannot see the lock behaves so). */
  lock?: boolean;
}

export interface LoadOptions {
  /** Ask even though the list is fresh (not closer than a minute to the last attempt). */
  refresh?: boolean;
  /** Make no request: the list on disk if there is one, else the built-in one. */
  offline?: boolean;
}

const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function reasonOf(kind: string, message: string): string {
  switch (kind) {
    case "offline": return "Couldn't reach Hugging Face (no network)";
    case "rate_limited": return "Hugging Face is limiting this machine's requests right now";
    case "malformed": return `Hugging Face's answer wasn't usable (${message})`;
    case "timeout": return "Hugging Face took too long to answer";
    default: return `Couldn't read Hugging Face (${message})`;
  }
}

export class ModelSource {
  private readonly home: string;
  private readonly useLock: boolean;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly builtin: Catalog;
  private readonly ttl: number;
  private readonly minModels: number | undefined;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;
  private readonly progress: ((note: string) => void) | undefined;
  private inflight: Promise<ModelsView> | null = null;
  private memo: { key: string; file: CacheFile | null } | null = null;
  // If persistence is unavailable, this instance still remembers its result and retry window.
  private fallback: { key: string | null; file: CacheFile } | null = null;

  constructor(opts: SourceOptions) {
    this.home = opts.home;
    this.useLock = opts.lock !== false;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.builtin = opts.builtin ?? CATALOG;
    this.ttl = opts.ttlMs ?? DAY_MS;
    this.minModels = opts.minModels;
    this.log = opts.log ?? (() => undefined);
    this.progress = opts.progress;
  }

  get refreshing(): boolean { return this.inflight !== null; }

  /** The best list there is without any request: the one on disk (fresh or stale), else the built-in one. */
  peek(): ModelsView {
    const file = this.read();
    return this.view(file, null);
  }

  /** The list, read from Hugging Face first when it is missing or older than a day (and not tried too recently). */
  async load(opts: LoadOptions = {}): Promise<ModelsView> {
    if (opts.offline) return this.peek();
    if (this.inflight) return this.inflight;
    const file = this.read();
    const now = this.now();
    // A clock rollback (or a future date on disk) must not pin freshness or a retry window.
    const recent = (at: number | undefined, window: number): boolean => at !== undefined && at <= now && now - at < window;
    const fresh = file?.catalog && recent(file.fetched_at, this.ttl);
    if (fresh && !opts.refresh) return this.view(file, null);
    if (!opts.refresh && file?.failed && recent(file.failed.at, FAILURE_BACKOFF_MS)) return this.view(file, Math.ceil((FAILURE_BACKOFF_MS - (now - file.failed.at)) / 60_000));
    if (opts.refresh && (recent(file?.fetched_at, REFRESH_GAP_MS) || recent(file?.failed?.at, REFRESH_GAP_MS))) return this.view(file, null);
    this.inflight = this.refresh(file, opts.refresh === true).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** One refresh at a time across processes: the lock, then a second look at the cache (someone may have just finished). */
  private async refresh(before: CacheFile | null, forced: boolean): Promise<ModelsView> {
    const lock = this.useLock ? takeLock(this.home, { report: (reason) => this.log("pool_models_lock_unusable", { reason }) }) : () => undefined;
    if (lock === "busy") { const v = this.view(this.read(true), null); return { ...v, note: [v.note, BUSY_NOTE].filter(Boolean).join(" ") }; }
    try {
      const now = this.now();
      const cur = this.read(true);
      if (!forced && cur?.catalog && cur.fetched_at !== undefined && cur.fetched_at <= now && now - cur.fetched_at < this.ttl) return this.view(cur, null);
      return await this.readHub(cur ?? before);
    } finally { lock(); }
  }

  private async readHub(before: CacheFile | null): Promise<ModelsView> {
    const started = this.now();
    const client = new HfClient({ fetch: this.doFetch, deadline: started + REFRESH_DEADLINE_MS, now: this.now });
    try {
      const r = await buildCatalog({ client, now: new Date(started), template: this.builtin, ...(this.minModels !== undefined ? { minModels: this.minModels } : {}), ...(this.progress ? { progress: this.progress } : {}) });
      const stats = { requests: r.requests, models: r.catalog.models.length, skipped: Object.fromEntries(Object.entries(r.skipped).map(([k, n]) => [k, n ?? 0])) };
      // Stamped when the read is over, so a manual refresh waits its minute from the end of this one, not from its start.
      const file: CacheFile = { v: 1, fetched_at: this.now(), catalog: r.catalog, stats };
      this.write(file);
      this.log("pool_models_refresh_ok", { requests: r.requests, models: stats.models, skipped: stats.skipped, ms: this.now() - started });
      return this.view(file, null);
    } catch (err) {
      const kind = err instanceof HfError ? err.kind : "error";
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      this.log("pool_models_refresh_failed", { kind, requests: client.requests, ms: this.now() - started });
      // Another source may have published while this one awaited the Hub. Re-read without the
      // memo, and do not attach this older failure to a success from the same refresh window.
      const latest = this.read(true);
      if (latest?.catalog && latest.fetched_at !== undefined && latest.fetched_at >= started && latest.fetched_at <= this.now()) return this.view(latest, null);
      const previous = latest?.catalog ? latest : before;
      const file: CacheFile = { ...(previous?.catalog ? { catalog: previous.catalog, fetched_at: previous.fetched_at, ...(previous.stats ? { stats: previous.stats } : {}) } : {}), v: 1, failed: { at: this.now(), kind, message } };
      this.write(file);
      return this.view(file, null);
    }
  }

  private view(file: CacheFile | null, retryMinutes: number | null): ModelsView {
    const now = this.now();
    const usable = file?.catalog && file.fetched_at !== undefined && now >= file.fetched_at && now - file.fetched_at <= STALE_MS;
    const retry = retryMinutes === null ? "" : ` Walkie will try again in ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`;
    const why = file?.failed ? reasonOf(file.failed.kind, file.failed.message) : null;
    if (usable && file.catalog && file.fetched_at !== undefined) {
      const fresh = now - file.fetched_at < this.ttl;
      return {
        catalog: file.catalog, source: "huggingface", state: fresh ? "fresh" : "stale", checkedAt: file.fetched_at,
        note: why && !fresh ? `${why}; using the list read on ${utc(file.fetched_at)}.${retry}` : null,
        ...(file.stats ? { stats: file.stats } : {}),
      };
    }
    return {
      catalog: this.builtin, source: "built-in", state: "built-in", checkedAt: null,
      note: why ? `${why}, so this is the list built into Walkie (updated ${this.builtin.updated}).${retry}` : null,
    };
  }

  private diskKey(): string | null {
    try {
      const st = statSync(cachePath(this.home));
      return st.isFile() && st.size <= FILE_MAX ? `${st.dev}:${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}` : null;
    } catch { return null; }
  }

  private read(force = false): CacheFile | null {
    const path = cachePath(this.home);
    try {
      const key = this.diskKey();
      if (this.fallback?.key === key) return this.fallback.file;
      if (key === null) return null;
      if (!force && this.memo?.key === key) return this.memo.file;
      const parsed = CacheFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
      const file = parsed.success ? parsed.data : null;
      this.memo = { key, file };
      return file;
    } catch {
      return this.fallback?.file ?? null;
    }
  }

  /** Atomic: a temp file in the same folder, then a rename; 0600 in a 0700 folder. */
  private write(file: CacheFile): void {
    const dir = join(this.home, "pool");
    const path = cachePath(this.home);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      renameSync(tmp, path);
      this.memo = null;
      this.fallback = null;
    } catch (err) {
      this.fallback = { key: this.diskKey(), file };
      // ENOTDIR/EACCES can affect cleanup too; preserve the original failure and the fallback.
      try { rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
      this.log("pool_models_cache_failed", { message: (err as Error).message.slice(0, 200) });
    }
  }
}
