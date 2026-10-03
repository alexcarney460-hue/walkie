// A bounded async boundary around the existing checked session-file reader and other scan filesystem work.
// A timed-out worker is replaced; late replies cannot update a later scan's caches or result.
import type { RepoContext } from "../agent/identity.ts";
import type { FileKind, TailInfo } from "./activity.ts";
import type { KimiSession } from "./kimi-sessions.ts";
import type { Logger } from "./logger.ts";

const FILE_TIMEOUT_MS = 500;
/**
 * How long a new worker has to acknowledge its policy message. Separate from FILE_TIMEOUT_MS (one read): a worker's first load
 * is not a read. A freshly updated binary pages its embedded modules in from a cold disk, and a loaded machine starts the
 * thread late, so 500 ms replaced a healthy worker at daemon start and enrichment waited out the 1 s retry. A worker that
 * never acknowledges is still replaced, just later.
 */
const STARTUP_TIMEOUT_MS = 5_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const RETIRE_GRACE_MS = 5_000;
/**
 * Workers set aside (abandoned) because they ignored terminate() (blocked inside a native read), at most. Past this many, the
 * next worker that ignores terminate() is not set aside: it stays the one still being waited on and no further worker is built
 * until one exits. So a hung filesystem costs at most three stuck threads (two abandoned plus the one still being waited on)
 * and no more.
 */
const MAX_ABANDONED = 2;
declare const WALKIE_EMBEDDED: boolean | undefined;
/** What a pending operation resolves with when no worker answered it in time (never a value a worker sent). */
const FAILED = Symbol("discovery-files-failed");
/**
 * `openFile` returns this when the worker could not answer (timed out, replaced, unavailable, deadline passed): a statement
 * about the worker, not about the file. Only a null or a path is the worker's answer.
 */
export const LOOKUP_FAILED = Symbol("discovery-lookup-failed");
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
  /** Tests: the worker's startup acknowledgement deadline and the wait before a worker that ignores terminate() is abandoned. */
  startupTimeoutMs?: number;
  retireGraceMs?: number;
}

export class DiscoveryFiles {
  private worker: Worker | null = null;
  private ready = false;
  private retiring: Worker | null = null;
  /** Workers that ignored terminate() past the grace period; each is removed when it finally exits. */
  private readonly abandoned = new Set<Worker>();
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
  private readonly startupTimeoutMs: number;
  private readonly retireGraceMs: number;

  constructor(detail: boolean, private readonly log?: Pick<Logger, "warn" | "info">, opts: DiscoveryFilesOptions = {}) {
    this.detail = detail;
    this.spawnWorker = opts.spawn ?? (() => new Worker(discoveryWorkerSpec()));
    this.now = opts.now ?? Date.now;
    this.retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.retireGraceMs = opts.retireGraceMs ?? RETIRE_GRACE_MS;
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
      this.warned = false; // a later outage warns again
      if (!pending.settled) pending.resolve(Date.now() >= pending.deadline ? FAILED : error ? null : value);
      this.pump();
    };
    worker.onerror = () => this.replace(worker, true);
    worker.addEventListener("close", () => {
      if (this.abandoned.delete(worker)) { this.trySpawn(); return; }
      if (this.retiring === worker) {
        this.retiring = null;
        if (this.retireTimer) clearTimeout(this.retireTimer);
        this.retireTimer = null;
        this.trySpawn();
      } else this.replace(worker, true, true);
    });
    try {
      worker.postMessage({ id: 0, op: "policy", args: [this.detail] });
      this.policyTimer = setTimeout(() => this.replace(worker, true), this.startupTimeoutMs);
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
        if (!pending.settled) pending.resolve(FAILED);
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
      this.armRetireTimer(worker);
      try { void worker.terminate(); } catch { /* keep the retiring worker as the outstanding operation */ }
    }
    else this.trySpawn();
  }

  private armRetireTimer(worker: Worker): void {
    this.retireTimer = setTimeout(() => this.retireExpired(worker), this.retireGraceMs);
    this.retireTimer.unref?.();
  }

  /**
   * The worker still has not exited after terminate(): a native read that ignores it. Waiting for it forever would switch
   * enrichment off until the daemon restarted, so it is abandoned (it keeps running, unreferenced, and is dropped from the
   * set when it exits) and a replacement is built after the usual backoff. At most MAX_ABANDONED are set aside at once; a
   * further stuck worker is waited on instead (looked at again each grace period), so the bound is MAX_ABANDONED + 1 threads.
   */
  private retireExpired(worker: Worker): void {
    if (this.retiring !== worker) return;
    this.retireTimer = null;
    // Already at the limit of threads left behind: keep waiting on this one (looked at again each grace period).
    if (this.abandoned.size >= MAX_ABANDONED) { this.armRetireTimer(worker); return; }
    this.abandoned.add(worker);
    this.retiring = null;
    this.failed("worker did not terminate");
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
        if (!pending.settled) pending.resolve(FAILED);
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
    return new Promise<T>((resolve) => this.enqueue(op, args, deadline,
      (value) => resolve(value === FAILED || value === null ? fallback : value as T)));
  }

  private enqueue(op: string, args: unknown[], deadline: number, done: (value: unknown) => void): void {
    // A blocked native read can ignore terminate(): while that worker is retiring (until it exits, or the grace period
    // ends and it is abandoned) scans retain their census cards and skip file enrichment.
    if (this.closed || this.retiring || Date.now() >= deadline) { done(FAILED); return; }
    this.trySpawn();
    if (!this.worker && !this.retiring && this.now() < this.retryAt) { done(FAILED); return; }
    const id = ++this.nextId;
    const expiry = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending || pending.settled) return;
      pending.settled = true;
      pending.resolve(FAILED);
      if (!pending.sent) {
        this.pending.delete(id);
        const index = this.queue.indexOf(id);
        if (index !== -1) this.queue.splice(index, 1);
      }
    }, Math.max(1, deadline - Date.now()));
    this.pending.set(id, { resolve: done, op, args, deadline, expiry, sent: false, settled: false, retries: 0 });
    this.queue.push(id);
    this.pump();
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
  /** The path when it opens, null when it does not (the worker's answer), LOOKUP_FAILED when no worker answered. */
  openFile(path: string, deadline: number): Promise<string | null | typeof LOOKUP_FAILED> {
    return new Promise((resolve) => this.enqueue("openFile", [path], deadline,
      (value) => resolve(value === FAILED ? LOOKUP_FAILED : value as string | null)));
  }
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
      if (!pending.settled) pending.resolve(FAILED);
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
