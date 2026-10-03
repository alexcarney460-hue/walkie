// Shell-capable WalkieTalkie runs as a dedicated uid. The root-owned seat helper owns its lifecycle; a
// token-checked socket lets that uid use the daemon only as the reserved orchestrator agent.
import type { Server } from "bun";
import { chmodSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ORCHESTRATOR_AGENT, ORCHESTRATOR_TOKEN_HEADER } from "../../protocol/orchestrator.ts";
import type { AdminResult } from "../seats/admin.ts";
import { adminCall } from "../seats/runner-child.ts";
import { DEFAULT_ADMIN, DEFAULT_RUNNER, RUNTIMES_DIR, aclProblem, homeProblem, listAcl, lookupOsUser, makeSeatSocketDir, removeSeatSocketDir, runnerPathProblem } from "../seats/seat-user.ts";
import { TALKIE_UID, TALKIE_USER } from "../seats/talkie-user.ts";
import { helperVersion } from "../seats/helper-version.ts";
import { VERSION } from "../version.ts";
import { HttpError } from "../http.ts";
import { walkieArgv } from "../../hooks/install.ts";
import { UID_MONITOR_LEASE_MS, uidMonitorFailureFile, writeUidLease } from "./uid-monitor.ts";
import { CleanupObligation, cleanupDelay, newerGenerationOwnsCleanup, type PendingCleanup } from "./cleanup-obligation.ts";
import { selfOp, type OpId } from "../seats/admin-ledger.ts";
import { RecommendInput } from "./rec-input.ts";

export const SETUP_USER_COMMAND = "walkie seats setup-user --apply";
export const TALKIE_SHELL_HEADER = "X-Walkie-Talkie-Shell";

/** The shell user has the orchestrator token, so authorization must happen before its request reaches the daemon. */
export function talkieRouteAllowed(method: string, path: string): boolean {
  if (method === "GET") return [
    /^\/v1\/(healthz|me|team|peers|diag|events|asks|agents|projects|tasks|seats|orchestrator)\/?$/,
    /^\/v1\/(events|asks|tasks|artifacts)\/[^/]+(?:\/context)?$/,
    /^\/v1\/projects\/p-[0-9a-f]{8}$/,
    /^\/v1\/projects\/p-[0-9a-f]{8}\/room(?:\/.*)?$/,
    /^\/v1\/orchestrator\/messages$/,
    /^\/v1\/seats\/busy$/,
    /^\/v1\/talkie\/recs$/, // TALKIE-OPS-1: the recommendations it may list
  ].some((pattern) => pattern.test(path));
  if (method !== "POST") return false;
  return [
    /^\/v1\/(post|ask|answer|artifacts)$/,
    /^\/v1\/projects(?:\/p-[0-9a-f]{8}\/boards)?$/,
    /^\/v1\/tasks$/,
    /^\/v1\/tasks\/(?!automation$)[^/]+(?:\/comment)?$/,
    /^\/v1\/seats\/run$/,
    /^\/v1\/orchestrator\/(say|stop-reply)$/,
    /^\/v1\/team\/(invite-code|add-machine)$/,
    /^\/v1\/talkie\/recs$/, // TALKIE-OPS-1: recording one (never approving or dismissing: those are a person's)
  ].some((pattern) => pattern.test(path));
}

export function talkieBodyAllowed(path: string, body: ArrayBuffer): boolean {
  if (path === "/v1/talkie/recs") {
    try { return RecommendInput.safeParse(JSON.parse(new TextDecoder().decode(body))).success; } catch { return false; }
  }
  if (path === "/v1/team/invite-code" || path === "/v1/team/add-machine") {
    try {
      const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const fields = value as Record<string, unknown>;
      const keys = Object.keys(fields);
      const allowed = path === "/v1/team/invite-code" ? ["handle", "role"] : ["handle"];
      return typeof fields.handle === "string" && keys.every((key) => allowed.includes(key))
        && (path !== "/v1/team/invite-code" || fields.role === undefined || fields.role === "member");
    } catch { return false; }
  }
  if (path !== "/v1/projects" && path !== "/v1/tasks" && !/^\/v1\/tasks\/[^/]+$/.test(path)) return true;
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (path === "/v1/projects") return !keys.some((key) => ["private", "paths", "automations", "steward", "steward_node", "state"].includes(key));
    if (path === "/v1/tasks") return !keys.includes("state");
    return keys.every((key) => ["board", "column", "before", "after"].includes(key));
  } catch { return false; }
}
/** How long a stop waits for an ended uid monitor to be reaped before it moves on. */
const MONITOR_REAP_MS = 1_000;
const CLEANUP_OWNER_RENEW_MS = 2_000;
const CLEANUP_OWNER_INTERVAL_MS = 3_000; // Existing owner expiry is three intervals: at most nine seconds.
const CLEANUP_ADMIN_DEADLINE_MS = 180_000;

/** End only this caller's wait; the cleanup promise retains its uid obligation and keeps running. */
function waitUnlessAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("shell preparation cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

/** Ends the uid monitor and waits for it to exit, but never past MONITOR_REAP_MS (a stuck process must not hold a Stop). */
async function endMonitor(monitor: { kill: () => void; exited?: Promise<number | null> } | null): Promise<void> {
  if (!monitor) return;
  monitor.kill();
  if (!monitor.exited) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, MONITOR_REAP_MS); });
  try { await Promise.race([monitor.exited.then(() => undefined, () => undefined), bound]); }
  finally { clearTimeout(timer); }
}

export interface TalkieOsDeps {
  /** Tests replace sudo and installed paths; the production path always uses the root-owned helper. */
  admin?: (verb: "talkie-create" | "talkie-destroy" | "talkie-reconcile" | "talkie-status", generation?: string,
    signal?: AbortSignal, instance?: string) => Promise<AdminResult | null>;
  ready?: () => boolean;
  runner?: string;
  runtime?: string;
  socketRoot?: string;
  /** Tests only: replace sudo with a local fake user switch. */
  userSwitch?: (name: string, runner: string) => string[];
  existing?: () => boolean;
  /** Tests only: inspect the person's home without relying on the test machine's permissions. */
  privateHome?: () => string | null;
  /** Tests only: fake Claude fixture paths, never used by a production helper. */
  testEnv?: Record<string, string>;
  /** Tests replace the independent process with a fake monitor. */
  monitor?: (file: string, run: string, cleanupFile: string) => { kill: () => void; exited?: Promise<number | null> };
  monitorFailure?: (reason: string) => void;
  leaseExpires?: () => number;
  cleanupFile?: string;
  /** Tests only: use a short deterministic wait for the retry timer. */
  retrySleep?: (ms: number) => Promise<void>;
  /** Tests only: shorten the qualified cleanup helper deadline. */
  cleanupDeadlineMs?: number;
}

export class TalkieOsUser {
  private server: Server<undefined> | null = null;
  private directory: string | null = null;
  private home: string | null = null;
  private cleaning: Promise<void> | null = null;
  private cleaningGeneration: string | null = null;
  private preparing: Promise<void> | null = null;
  private monitor: { kill: () => void; exited?: Promise<number | null> } | null = null;
  private monitorCanRun = false;
  private monitorRestarts = 0;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private monitorFile: string | null = null;
  private monitorHandoffGeneration: string | null = null;
  private generation: string | null = null;
  private volatilePending: PendingCleanup | null = null;
  private retryArmed = false;
  private retrying = false;
  private readonly instance: string;
  constructor(private readonly daemonSocket: string, private readonly tokenValid: (token: string) => boolean,
    private readonly deps: TalkieOsDeps = {}) {
    // A stable per-socket identity survives a daemon restart, but differs across dev and production sockets.
    this.instance = createHash("sha256").update(resolve(daemonSocket)).digest("hex");
  }

  get active(): boolean { return this.home !== null && this.directory !== null && this.server !== null; }
  get runner(): string { return this.deps.runner ?? DEFAULT_RUNNER; }
  get runtime(): string { return this.deps.runtime ?? `${RUNTIMES_DIR}/claude`; }
  get leaseDirectory(): string { if (!this.directory) throw new Error("WalkieTalkie's OS user is not ready"); return this.directory; }
  get userHome(): string { if (!this.home) throw new Error("WalkieTalkie's OS user is not ready"); return this.home; }
  get socket(): string { return join(this.leaseDirectory, "talkie.sock"); }
  private get cleanupFile(): string { return this.deps.cleanupFile ?? join(this.deps.socketRoot ?? dirname(this.daemonSocket), "orchestrator-uid-cleanup.sqlite"); }
  private get obligation(): CleanupObligation { return new CleanupObligation(this.cleanupFile); }
  get pendingCleanup(): PendingCleanup | null {
    if (this.volatilePending) {
      try {
        if (this.obligation.completed(this.volatilePending.generation)) this.volatilePending = null;
      } catch { /* keep the in-memory obligation visible */ }
      if (this.volatilePending) {
        try { return this.obligation.read() ?? this.volatilePending; }
        catch { return this.volatilePending; }
      }
    }
    return this.obligation.read();
  }

  /** A person verified removal without the helper; stop the monitor after the matching durable clear. */
  async finishRepairedCleanup(): Promise<boolean> {
    const run = this.generation ?? this.volatilePending?.generation;
    if (!run || !this.obligation.completed(run)) return false;
    this.volatilePending = null;
    this.home = null;
    this.generation = null;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    const monitor = this.monitor;
    this.monitor = null;
    this.monitorCanRun = false;
    this.monitorFile = null;
    await endMonitor(monitor);
    return monitor !== null;
  }

  assertInstalled(): void {
    const ready = this.deps.ready ?? (() => {
      const paths = [DEFAULT_ADMIN, this.runner, this.runtime];
      if (paths.some((p) => runnerPathProblem(p))) return false;
      if (helperVersion([DEFAULT_ADMIN, this.runner], VERSION).state !== "current") return false;
      try {
        return [DEFAULT_ADMIN, this.runner].every((path) => {
          const r = Bun.spawnSync([path, "talkie-capability"], {
            stdin: "ignore", stdout: "pipe", stderr: "ignore", cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeout: 5_000,
          });
          return r.exitCode === 0 && r.stdout.toString().trim() === "talkie-user-v3";
        });
      } catch { return false; }
    });
    if (!ready()) throw new HttpError(409, "seat_helper_required", `WalkieTalkie shell access needs the seat helper: ${SETUP_USER_COMMAND}`);
  }

  private admin(verb: "talkie-create" | "talkie-destroy" | "talkie-reconcile" | "talkie-status", generation?: string, signal?: AbortSignal): Promise<AdminResult | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const instance = verb === "talkie-create" || verb === "talkie-reconcile" ? this.instance : undefined;
    const call = this.deps.admin ? this.deps.admin(verb, generation, signal, instance)
      : adminCall(["sudo", "-n", DEFAULT_ADMIN, "seat-admin", verb, ...(generation ? [generation] : []),
        ...(instance ? [instance] : [])], 180_000, undefined, signal);
    if (!signal) return call;
    return new Promise((resolve, reject) => {
      const abort = () => resolve(null);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void call.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
    });
  }

  private startMonitor(file: string, run: string): void {
    const monitor = this.deps.monitor?.(file, run, this.cleanupFile) ?? (this.deps.privateHome ? { kill: () => undefined } : (() => {
      const proc = Bun.spawn([...walkieArgv(), "--internal-orchestrator-uid-monitor", file, run, this.cleanupFile, String(process.pid)],
        { cwd: "/", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
      return { kill: () => proc.kill("SIGKILL"), exited: proc.exited };
    })());
    this.monitor = monitor;
    this.monitorCanRun = !!this.deps.monitor || !this.deps.privateHome;
    void monitor.exited?.then(
      (code) => this.monitorExited(monitor, file, run, code),
      () => this.monitorExited(monitor, file, run, null),
    );
  }

  private monitorExited(monitor: { kill: () => void }, file: string, run: string, code: number | null): void {
    if (this.monitor !== monitor || this.monitorFile !== file) return;
    const handedOff = this.monitorHandoffGeneration === run;
    const finishing = this.cleaning !== null || this.retrying;
    if (handedOff && (code === 0 || code === 3)) this.monitorHandoffGeneration = null;
    this.monitor = null;
    this.monitorCanRun = false;
    let verified = false;
    if (code === 0) {
      try { verified = this.obligation.completed(run); } catch { /* an unknown cleanup stays pending */ }
      if (verified) {
        this.volatilePending = null;
        if (this.generation === run) { this.home = null; this.generation = null; }
      }
    }
    if (code === 0 && (handedOff || finishing) && verified) { this.monitorFile = null; return; }
    if (code === 0 && (handedOff || finishing) && !verified) {
      this.monitorFile = null;
      this.armRetry(0);
      return;
    }
    if (code === 0) {
      // The monitor may have destroyed the uid beneath a healthy daemon. Close the old
      // socket and lease before a restart can prepare a fresh generation.
      this.server?.stop(true); this.server = null;
      if (this.monitorTimer) clearInterval(this.monitorTimer);
      this.monitorTimer = null;
      if (this.directory) { removeSeatSocketDir(this.directory); this.directory = null; }
    }
    if (code === 3 && handedOff) {
      this.monitorFile = null;
      this.armRetry(0);
      return;
    }
    if (code === 3) {
      try {
        const owner = this.obligation.monitorOwner(run);
        const self = selfOp();
        if (owner?.pid === self.pid && owner.start === self.start) {
          this.monitorFile = null;
          this.armRetry(0);
          return;
        }
      } catch { /* an unknown owner still fails closed below */ }
    }
    if (code !== 0 && code !== 2 && code !== 3 && this.monitorRestarts < 3) {
      this.monitorRestarts++;
      try { this.startMonitor(file, run); return; } catch { /* fail closed below */ }
    }
    this.monitorFile = null;
    let detail = "";
    try {
      const path = uidMonitorFailureFile(file);
      if (statSync(path).size <= 1024) detail = readFileSync(path, "utf8").trim().slice(0, 240);
    } catch { /* no diagnostic file */ }
    const reason = code === 0 ? "WalkieTalkie uid monitor cleaned the shell user while it was running"
      : code === 2 ? "WalkieTalkie uid monitor stopped because the seat helper was uninstalled"
      : code === 3 ? "another live uid monitor owns WalkieTalkie cleanup"
      : `WalkieTalkie uid monitor exited repeatedly (code ${code ?? "signal"})`;
    if (code !== 0) this.armRetry(0);
    if (this.deps.monitorFailure) this.deps.monitorFailure(detail ? `${reason}: ${detail}` : reason);
    else void this.destroy().catch(() => undefined);
  }

  /** After a daemon crash, no owner may still be using this uid. Reconcile before any automatic start. */
  async cleanupStale(): Promise<void> {
    if (this.pendingCleanup) { this.armRetry(UID_MONITOR_LEASE_MS * 2); return; }
    if (this.active || !(this.deps.existing ?? (() => lookupOsUser(TALKIE_USER) !== null))()) return;
    this.assertInstalled();
    const generation = await this.expectedStaleGeneration();
    const result = await this.admin("talkie-reconcile", generation);
    if (!result?.ok) throw new Error(`WalkieTalkie's stale uid was not cleaned: ${result?.why ?? "the helper did not answer"}`);
  }

  private async expectedStaleGeneration(signal?: AbortSignal): Promise<string> {
    const status = await this.admin("talkie-status", undefined, signal);
    if (!status?.ok || !status.status) throw new HttpError(409, "talkie_cleanup_failed", "WalkieTalkie's shell owner could not be checked");
    const { generation, instance } = status.status;
    if (instance !== this.instance || !generation) {
      throw new HttpError(409, "talkie_user_owned", instance
        ? "Another Walkie daemon owns shell access on this machine; stop it before starting here"
        : "WalkieTalkie's shell user has no recorded daemon owner; run walkie talkie cleanup --repair");
    }
    return generation;
  }

  private async emptyOwnerGeneration(signal?: AbortSignal): Promise<string | null> {
    const status = await this.admin("talkie-status", undefined, signal);
    // Legacy unit fixtures omit a status reply; installed helpers always provide one.
    if (this.deps.admin && status?.ok && !status.status) return null;
    if (!status?.ok || !status.status) throw new HttpError(409, "talkie_cleanup_failed", "WalkieTalkie's shell owner could not be checked; run walkie talkie cleanup --repair");
    if (!status.status.ledgerOwner) return null;
    const { generation, instance } = status.status;
    if (generation && instance === this.instance) return generation;
    throw new HttpError(409, "talkie_user_owned", instance
      ? "Another Walkie daemon owns shell access on this machine; run walkie talkie cleanup --repair if the uid is empty"
      : "WalkieTalkie's shell owner has no current daemon identity; run walkie talkie cleanup --repair");
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    if (this.preparing) return this.preparing;
    const preparing = this.prepareOnce(signal);
    this.preparing = preparing;
    try { await preparing; }
    finally { if (this.preparing === preparing) this.preparing = null; }
  }

  private async prepareOnce(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("shell preparation cancelled");
    const cleaningRun = this.cleaning ? this.cleaningGeneration : null;
    let cleanupError: unknown;
    if (this.cleaning) {
      try { await waitUnlessAborted(this.cleaning, signal); }
      catch (err) { cleanupError = err; }
    }
    if (signal?.aborted) throw new Error("shell preparation cancelled");
    if (this.active) return;
    if (this.pendingCleanup) throw new HttpError(409, "talkie_cleanup_pending", "WalkieTalkie shell user cleanup pending; the dedicated uid must be verified clean before another shell run");
    if (cleanupError) {
      let completed = false;
      try { completed = !!cleaningRun && this.obligation.completed(cleaningRun); }
      catch { /* an unverifiable cleanup must still fail Start */ }
      if (!completed) throw cleanupError;
    }
    this.assertInstalled();
    const homeIssue = this.deps.privateHome ? this.deps.privateHome() : (() => {
      const home = homedir();
      let st: ReturnType<typeof statSync> | null = null;
      try { st = statSync(home); } catch { /* fail closed */ }
      return homeProblem(home, st, []) ?? aclProblem(home, listAcl(home));
    })();
    if (homeIssue) throw new HttpError(409, "talkie_home_open", `WalkieTalkie shell access needs a private home: ${homeIssue}`);
    // The expected generation is fixed before queuing on the helper lock. An aborted call cannot sweep a newer run.
    const existing = (this.deps.existing ?? (() => lookupOsUser(TALKIE_USER) !== null))();
    const expected = existing ? await this.expectedStaleGeneration(signal) : await this.emptyOwnerGeneration(signal) ?? randomUUID();
    const old = await this.admin("talkie-reconcile", expected, signal);
    if (signal?.aborted) throw new Error("shell preparation cancelled");
    if (!old?.ok) throw new HttpError(409, "talkie_cleanup_failed", `WalkieTalkie's OS user could not be cleaned: ${old?.why ?? "the helper did not answer"}`);
    const run = randomUUID();
    // Record the generation before the helper runs: an interrupted create may already have changed OS state.
    this.generation = run;
    const created = await this.admin("talkie-create", run, signal);
    if (signal?.aborted) {
      await this.destroy(signal).catch(() => undefined);
      throw new Error("shell preparation cancelled");
    }
    if (!created?.ok || created.name !== TALKIE_USER || created.uid !== TALKIE_UID
      || !created.home?.startsWith("/") || !created.home.endsWith(`/${TALKIE_USER}`)
      || (!this.deps.privateHome && created.generation !== run)) {
      if (created?.ok === false && ["used", "refused", "busy"].includes(created.code ?? "")) this.generation = null;
      else void this.destroy().catch(() => undefined);
      throw new HttpError(409, "talkie_user_failed", `WalkieTalkie's OS user could not be created: ${created?.why ?? "the helper did not return its expected identity"}`);
    }
    this.home = created.home;
    this.generation = run;
    try {
      if (!this.deps.privateHome) {
        const user = lookupOsUser(TALKIE_USER);
        if (!user || user.uid !== TALKIE_UID) throw new HttpError(409, "talkie_user_failed", "WalkieTalkie's dedicated user identity could not be checked");
        const home = homedir();
        const why = homeProblem(home, statSync(home), user.gids);
        if (why) throw new HttpError(409, "talkie_home_open", `WalkieTalkie shell access needs a private home: ${why}`);
      }
      this.directory = makeSeatSocketDir(this.deps.socketRoot);
      this.server = Bun.serve({ unix: this.socket, maxRequestBodySize: 8 * 1024 * 1024,
        fetch: (req: Request) => this.forward(req),
      } as Parameters<typeof Bun.serve>[0]) as Server<undefined>;
      chmodSync(this.socket, 0o666);
      const file = join(this.directory, "uid-lease.json");
      let serial = 0;
      const renew = () => writeUidLease(file, { run, expires: this.deps.leaseExpires?.() ?? Date.now() + UID_MONITOR_LEASE_MS, renewed: Date.now(), serial: serial++ });
      renew();
      this.monitorFile = file;
      this.monitorRestarts = 0;
      this.startMonitor(file, run);
      this.monitorTimer = setInterval(() => { try { renew(); } catch { /* the monitor expires and cleans up */ } }, UID_MONITOR_LEASE_MS / 4);
      this.monitorTimer.unref?.();
    } catch (err) {
      await this.destroy(signal).catch(() => undefined);
      throw err;
    }
  }

  private async forward(req: Request): Promise<Response> {
    const token = req.headers.get(ORCHESTRATOR_TOKEN_HEADER) ?? "";
    if (!token || !this.tokenValid(token)) return new Response("unauthorized", { status: 401 });
    try {
      const url = new URL(req.url);
      if (!talkieRouteAllowed(req.method, url.pathname)) return new Response("forbidden", { status: 403 });
      const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
      if (body && !talkieBodyAllowed(url.pathname, body)) return new Response("forbidden", { status: 403 });
      const headers = new Headers();
      headers.set("X-Walkie-Agent", ORCHESTRATOR_AGENT);
      headers.set(TALKIE_SHELL_HEADER, "1");
      headers.set(ORCHESTRATOR_TOKEN_HEADER, token);
      const type = req.headers.get("content-type");
      if (type) headers.set("content-type", type);
      const upstream = await fetch(`http://walkie${url.pathname}${url.search}`, {
        unix: this.daemonSocket, method: req.method, headers,
        ...(body ? { body } : {}),
      } as RequestInit);
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    } catch { return new Response("Walkie daemon unavailable", { status: 503 }); }
  }

  /**
   * A signal bounds only the caller's wait. The helper and recorded cleanup obligation continue until verified.
   */
  destroy(signal?: AbortSignal): Promise<void> {
    if (!this.cleaning) {
      this.cleaningGeneration = this.generation;
      const cleaning = this.destroyOnce();
      this.cleaning = cleaning;
      void cleaning.finally(() => { if (this.cleaning === cleaning) { this.cleaning = null; this.cleaningGeneration = null; } }).catch(() => undefined);
    }
    return waitUnlessAborted(this.cleaning, signal);
  }

  private async destroyOnce(): Promise<void> {
    const run = this.generation;
    const monitorOwnsPending = !!run && this.volatilePending?.generation === run && this.monitorCanRun && this.monitor !== null;
    if (run && !this.volatilePending) this.volatilePending = { generation: run, attempts: 0, diagnostic: "uid cleanup in progress" };
    this.server?.stop(true); this.server = null;
    // Keep renewing the monitor lease during the daemon's immediate helper call. Once it finishes,
    // removing the lease hands failed cleanup to the monitor without concurrent helper retries.
    const cleaned = !run || (!monitorOwnsPending && await this.attemptCleanup(run));
    if (run && !cleaned && this.monitorCanRun && this.monitor) {
      this.monitorHandoffGeneration = run;
      try { this.obligation.releaseOwner(run, selfOp()); } catch { /* expiry still permits takeover */ }
      this.armRetry(UID_MONITOR_LEASE_MS * 3);
    }
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    if (this.monitorFile) {
      try { rmSync(this.monitorFile, { force: true }); } catch { /* expiry still ends the lease */ }
      try { rmSync(uidMonitorFailureFile(this.monitorFile), { force: true }); } catch { /* diagnostic only */ }
    }
    const monitor = this.monitor;
    if (this.directory) {
      try { rmSync(this.socket, { force: true }); } catch { /* the directory removal follows */ }
      removeSeatSocketDir(this.directory);
      this.directory = null;
    }
    if (cleaned) {
      this.monitorFile = null;
      this.monitor = null;
      this.monitorCanRun = false;
      await endMonitor(monitor);
      return;
    }
    if (!this.monitorCanRun || !monitor) {
      this.monitorFile = null;
      this.armRetry(cleanupDelay(this.pendingCleanup?.attempts ?? 1));
    }
    throw new Error(`WalkieTalkie uid cleanup was not verified: ${this.pendingCleanup?.diagnostic ?? "the helper did not answer"}`);
  }

  private async attemptCleanup(run: string, signal?: AbortSignal): Promise<boolean> {
    let recorded = false;
    let storageFailed = false;
    let operation: OpId;
    try { operation = selfOp(); }
    catch { return false; }
    try { recorded = this.obligation.record(run, operation, CLEANUP_OWNER_INTERVAL_MS); }
    catch { storageFailed = true; /* privileged cleanup still runs */ }
    if (!recorded && !storageFailed) return false;
    const renewal = recorded ? setInterval(() => {
      try { this.obligation.record(run, operation, CLEANUP_OWNER_INTERVAL_MS); }
      catch { /* an expired owner lets the monitor take over */ }
    }, CLEANUP_OWNER_RENEW_MS) : null;
    renewal?.unref?.();
    let why = "the helper did not answer";
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), this.deps.cleanupDeadlineMs ?? CLEANUP_ADMIN_DEADLINE_MS);
      });
      const result = await Promise.race([this.admin("talkie-destroy", run, signal), expired]);
      if (result?.ok || newerGenerationOwnsCleanup(result?.why)) {
        if (recorded) {
          try { this.obligation.clear(run); }
          catch { this.volatilePending = { generation: run, attempts: this.volatilePending?.attempts ?? 0,
            diagnostic: "cleanup pending (could not record)" }; return false; }
        }
        this.volatilePending = null;
        if (this.generation === run) { this.home = null; this.generation = null; }
        return true;
      }
      why = result?.why ?? why;
    } catch (err) { why = err instanceof Error ? err.message : String(err); }
    finally { if (deadline) clearTimeout(deadline); if (renewal) clearInterval(renewal); }
    const attempts = (this.volatilePending?.attempts ?? 0) + 1;
    this.volatilePending = { generation: run, attempts, diagnostic: recorded ? why : "cleanup pending (could not record)" };
    if (recorded) {
      try {
        this.obligation.failure(run, why);
      } catch { this.volatilePending = { generation: run, attempts,
        diagnostic: "cleanup pending (could not record)" }; }
    }
    return false;
  }

  private armRetry(ms: number): void {
    if (this.retryArmed || this.retrying) return;
    this.retryArmed = true;
    const fire = () => { this.retryArmed = false; void this.retryPending(); };
    if (this.deps.retrySleep) void this.deps.retrySleep(ms).then(fire, fire);
    else { const timer = setTimeout(fire, ms); timer.unref?.(); }
  }

  private async retryPending(): Promise<void> {
    if (this.retrying) return;
    this.retrying = true;
    let next: number | null = null;
    try {
      if (this.cleaning) await this.cleaning.catch(() => undefined);
      const pending = this.pendingCleanup;
      if (!pending) return;
      let anotherOwnerActive = false;
      try {
        const owner = this.obligation.monitorOwner(pending.generation);
        const self = selfOp();
        anotherOwnerActive = !!owner && (owner.pid !== self.pid || owner.start !== self.start)
          && this.obligation.ownerActive(pending.generation);
      }
      catch { /* storage failure must not prevent the qualified helper call */ }
      if (anotherOwnerActive) { next = UID_MONITOR_LEASE_MS; return; }
      if (!(await this.attemptCleanup(pending.generation))) {
        next = cleanupDelay(this.pendingCleanup?.attempts ?? pending.attempts + 1);
      }
    } catch { next = 300_000; }
    finally { this.retrying = false; if (next !== null) this.armRetry(next); }
  }
}
