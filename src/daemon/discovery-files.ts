// A bounded async boundary around the existing checked session-file reader and other scan filesystem work.
// A timed-out worker is replaced; late replies cannot update a later scan's caches or result.
import type { RepoContext } from "../agent/identity.ts";
import type { FileKind, TailInfo } from "./activity.ts";
import type { KimiSession } from "./kimi-sessions.ts";
import type { Logger } from "./logger.ts";

const FILE_TIMEOUT_MS = 500;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const RETIRE_GRACE_MS = 5_000;
declare const WALKIE_EMBEDDED: boolean | undefined;
type Pending = { resolve: (value: unknown) => void; op: string; args: unknown[]; deadline: number;
  expiry: ReturnType<typeof setTimeout>; timer?: ReturnType<typeof setTimeout>; sent: boolean;
  settled: boolean; retries: number };
type ClaudeSession = { sessionId: string; startedAt?: number };

export function discoveryWorkerSpec(): string {
  return typeof WALKIE_EMBEDDED !== "undefined" && WALKIE_EMBEDDED === true
    ? "./daemon/discovery-files-worker.ts" : new URL("./discovery-files-worker.ts", import.meta.url).href;
}

export interface DiscoveryFilesOptions {
  spawn?: () => Worker;
  now?: () => number;
  retryBaseMs?: number;
}

export class DiscoveryFiles {
  private worker: Worker | null = null;
  private ready = false;
  private retiring: Worker | null = null;
  private retireTimer: ReturnType<typeof setTimeout> | null = null;
  private policyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: number[] = [];
  private activeId: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sessionReads = new Map<string, Promise<ClaudeSession | undefined>>();
  private nextId = 0;
  private detail: boolean;
  private closed = false;
  private failures = 0;
  private retryAt = 0;
  private warned = false;
  private readyLogged = false;
  private readonly spawnWorker: () => Worker;
  private readonly now: () => number;
  private readonly retryBaseMs: number;

  constructor(detail: boolean, private readonly log?: Pick<Logger, "warn" | "info">, opts: DiscoveryFilesOptions = {}) {
    this.detail = detail;
    this.spawnWorker = opts.spawn ?? (() => new Worker(discoveryWorkerSpec()));
    this.now = opts.now ?? Date.now;
    this.retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
    this.trySpawn();
  }

  private spawn(): Worker {
    const worker = this.spawnWorker();
    (worker as Worker & { unref?: () => void }).unref?.();
    worker.onmessage = (event: MessageEvent<{ id: number; started?: boolean; value?: unknown; error?: string }>) => {
      if (worker !== this.worker) return;
      const { id, value, error } = event.data;
      if (id === 0) {
        if (event.data.started) return;
        if (this.policyTimer) clearTimeout(this.policyTimer);
        this.policyTimer = null;
        if (error) this.replace(worker, true);
        else {
          this.ready = true;
          if (!this.readyLogged) { this.readyLogged = true; this.log?.info("agent_discovery_worker_ready"); }
          this.pump();
        }
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) return;
      if (event.data.started) return;
      if (pending.timer) clearTimeout(pending.timer);
      clearTimeout(pending.expiry);
      this.pending.delete(id);
      this.activeId = null;
      this.failures = 0;
      if (!pending.settled) pending.resolve(error || Date.now() >= pending.deadline ? null : value);
      this.pump();
    };
    worker.onerror = () => this.replace(worker, true);
    worker.addEventListener("close", () => {
      if (this.retiring === worker) {
        this.retiring = null;
        if (this.retireTimer) clearTimeout(this.retireTimer);
        this.retireTimer = null;
        this.trySpawn();
      } else this.replace(worker, true, true);
    });
    try {
      worker.postMessage({ id: 0, op: "policy", args: [this.detail] });
      this.policyTimer = setTimeout(() => this.replace(worker, true), FILE_TIMEOUT_MS);
    }
    catch (error) { void worker.terminate(); throw error; }
    return worker;
  }

  private trySpawn(): void {
    if (this.closed || this.worker || this.retiring || this.now() < this.retryAt) return;
    try { this.worker = this.spawn(); this.pump(); }
    catch (error) { this.failed(error); }
  }

  private failed(error: unknown): void {
    const delay = Math.min(RETRY_MAX_MS, this.retryBaseMs * 2 ** Math.min(this.failures++, 16));
    this.retryAt = this.now() + delay;
    if (!this.warned) {
      this.warned = true;
      this.log?.warn("agent_discovery_worker_unavailable", { retry_ms: delay,
        error: error instanceof Error ? error.message : String(error) });
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.trySpawn(); }, delay);
  }

  private replace(worker: Worker | null, failed = false, exited = false, timedOutId?: number): void {
    if (worker !== this.worker) return;
    this.ready = false;
    if (this.policyTimer) clearTimeout(this.policyTimer);
    this.policyTimer = null;
    const activeId = this.activeId;
    this.activeId = null;
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = undefined;
      if (id === timedOutId || pending.settled || Date.now() >= pending.deadline || pending.retries >= 1) {
        clearTimeout(pending.expiry);
        this.pending.delete(id);
        if (!pending.settled) pending.resolve(null);
      } else if (id === activeId) {
        pending.sent = false;
        pending.retries++;
        this.queue.unshift(id);
      }
    }
    this.worker = null;
    if (failed) this.failed(timedOutId ? "worker operation timed out" : "worker failed to load or exited");
    if (worker && !exited) {
      this.retiring = worker;
      this.retireTimer = setTimeout(() => this.failed("worker did not terminate"), RETIRE_GRACE_MS);
      this.retireTimer.unref?.();
      try { void worker.terminate(); } catch { /* keep the retiring worker as the outstanding operation */ }
    }
    else this.trySpawn();
  }

  private pump(): void {
    if (!this.worker || !this.ready || this.activeId !== null) return;
    while (this.queue.length) {
      const id = this.queue.shift()!;
      const pending = this.pending.get(id);
      if (!pending) continue;
      if (Date.now() >= pending.deadline) {
        clearTimeout(pending.expiry);
        this.pending.delete(id);
        if (!pending.settled) pending.resolve(null);
        continue;
      }
      pending.sent = true;
      this.activeId = id;
      const worker = this.worker;
      pending.timer = setTimeout(() => this.replace(worker, true, false, id), FILE_TIMEOUT_MS);
      try { this.worker.postMessage({ id, op: pending.op, args: pending.args }); }
      catch (error) { this.replace(this.worker, true); }
      return;
    }
  }

  private call<T>(op: string, args: unknown[], fallback: T, deadline: number): Promise<T> {
    // A blocked native read can ignore terminate(). Keep one abandoned worker at most;
    // later scans retain their census cards and skip file enrichment until it exits.
    if (this.closed || this.retiring || Date.now() >= deadline) return Promise.resolve(fallback);
    this.trySpawn();
    if (!this.worker && !this.retiring && this.now() < this.retryAt) return Promise.resolve(fallback);
    return new Promise<T>((resolve) => {
      const id = ++this.nextId;
      const expiry = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending || pending.settled) return;
        pending.settled = true;
        pending.resolve(null);
        if (!pending.sent) {
          this.pending.delete(id);
          const index = this.queue.indexOf(id);
          if (index !== -1) this.queue.splice(index, 1);
        }
      }, Math.max(1, deadline - Date.now()));
      this.pending.set(id, { resolve: (value) => resolve(value === null ? fallback : value as T),
        op, args, deadline, expiry, sent: false, settled: false, retries: 0 });
      this.queue.push(id);
      this.pump();
    });
  }

  policy(detail: boolean): void {
    if (this.detail === detail) return;
    this.detail = detail;
    // The worker rebuilds its SessionFiles cache on this message. Keeping it
    // alive lets the same scan read activity under the new policy.
    if (this.worker) {
      try { this.worker.postMessage({ id: 0, op: "policy", args: [detail] }); }
      catch { this.replace(this.worker, true); }
    }
  }

  retain(paths: ReadonlySet<string>, deadline: number): Promise<void> { return this.call("retain", [[...paths]], undefined, deadline); }
  repoContext(cwd: string, deadline: number): Promise<RepoContext | null> { return this.call("repoContext", [cwd], null, deadline); }
  listKimiSessions(home: string, cwd: string, uid: number | null, deadline: number, ops: number): Promise<KimiSession[] | null> {
    return this.call("listKimiSessions", [home, cwd, uid, deadline, ops], null, deadline);
  }
  containedWire(session: KimiSession, deadline: number): Promise<boolean> { return this.call("containedWire", [session], false, deadline); }
  claudeTranscript(config: string, cwd: string | undefined, session: string, now: number, deadline: number): Promise<string | null> {
    return this.call("claudeTranscript", [config, cwd, session, now], null, deadline);
  }
  openFile(path: string, deadline: number): Promise<string | null> { return this.call("openFile", [path], null, deadline); }
  kimiFile(path: string, root: string, deadline: number): Promise<string | null> { return this.call("kimiFile", [path, root], null, deadline); }
  readAsync(path: string, kind: FileKind, cwd: string, deadline: number): Promise<{ mtime: number; info: TailInfo } | null> {
    return this.call("read", [path, kind, cwd], null, deadline);
  }
  subagentsMtime(path: string, deadline: number): Promise<number | null> { return this.call("subagentsMtime", [path], null, deadline); }
  firstPrompt(path: string, kind: FileKind, deadline: number): Promise<string | undefined> {
    return this.call("firstPrompt", [path, kind], undefined, deadline);
  }
  hookStates(home: string, agents: readonly string[], deadline: number): Promise<Record<string, HookState> | null> {
    return this.call("hookStates", [home, agents], null, deadline);
  }
  claudeSession(pid: number, configDir: string, deadline: number): Promise<ClaudeSession | undefined> {
    const key = `${configDir}\n${pid}`;
    const existing = this.sessionReads.get(key);
    if (existing) return existing;
    const read = this.call<ClaudeSession | undefined>("claudeSession", [pid, configDir], undefined, deadline);
    this.sessionReads.set(key, read);
    void read.then(() => { if (this.sessionReads.get(key) === read) this.sessionReads.delete(key); });
    return read;
  }
  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.expiry);
      if (pending.timer) clearTimeout(pending.timer);
      if (!pending.settled) pending.resolve(null);
    }
    this.pending.clear();
    this.queue.length = 0;
    this.replace(this.worker);
  }

  reopen(): void {
    if (!this.closed) return;
    this.closed = false;
    this.trySpawn();
  }
}

export interface HookState { title?: string; title_src?: string; task?: string; task_src?: string }
