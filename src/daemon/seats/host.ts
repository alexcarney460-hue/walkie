import { superviseReserve } from "./reserve.ts";
// The seats host (PROTOCOL §11): on a machine whose person opted in, runs the seats allowed launchers ask for in
// `seats-<this node>` (rules.ts), one `claude -p` / `codex exec` child each, in its own process group and a fresh
// directory, on the person's own sign-in; streams progress and the result back as posts in that channel, and the
// seat's commits as a git bundle artifact. Revoking (`walkie seats deny`) or a daemon shutdown ends every seat.
// While the host's person uses the machine (`walkie seats busy`), at most their limit of seats run: the newest are
// paused (SIGSTOP of the group) and new launches queue until they resume (busy.ts).
import { codexAccessOnly } from "../../accounts/vault/codex-access.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { RELEASE_BUILD } from "../../license/service.ts";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { homeRelative } from "../../agent/identity.ts";
import { redactSecrets } from "../../protocol/safety.ts";
import type { BodyOf, Event } from "../../protocol/schemas.ts";
import { HttpError } from "../http.ts";
import {
  DEFAULT_HOST_MAX, DEFAULT_SEAT_MODE, MAX_SEAT_BRIEF, SEATS_AGENT, SEATS_POOL_CODE, SEATS_POOL_CONFLICT, SEAT_RUNTIMES_V1, SEAT_TASK_PROMPT, TURN_SEATS_OFF, hostText, isV2, seatAgentName, seatOf, seatsChannel, stateText,
  type AnySeatRun, type HostAvailability, type SeatHost, type SeatRun, type SeatRunV2, type SeatRuntime, type SeatState, type SeatsLocalView,
} from "../../protocol/seats.ts";
import type { AccountView } from "../../protocol/accounts.ts";
import { releaseLease, writeLease, type Lease } from "../../accounts/leases.ts";
import { ACCOUNT_NOT_USABLE, planSeatAccount, seatCredentials, type PoolContext, type SeatCredentials } from "./account.ts";
import { removeLeaseHome, sweepLeaseHomes, writeLeaseHome } from "../../accounts/vault/codex-lease-home.ts";
import { codexBaseHome } from "../../accounts/vault/codex-home.ts";
import {
  SeatRefusal, addWorktree, briefText, dropInRefs, freshClone, placeTask, planTask, readResultFile, recordLaneTip, releaseExclude, removeTask, resolveRepo, stageBundle,
  stageDir, sweepStaged, validLaneRecord, validTaskRecord,
  type ResultFile, type TaskFile,
} from "./v2.ts";
import { requestLease } from "../vault-lease.ts";
import { MAX_BLOB_BYTES, readBlob, sha256Hex, writeBlob } from "../blobs.ts";
import { blobServable } from "../blob-auth.ts";
import { saveFleetConfig, saveSeatsConfig, type FleetConfig, type SeatsConfig } from "../config.ts";
import type { Core } from "../core.ts";
import type { Logger } from "../logger.ts";
import type { PeerAddr, PeerClient } from "../peer-client.ts";
import { submitRequest, type CatchUp } from "../requests.ts";
import { activeNodes, type NodeRec } from "../roster.ts";
import { ClaudeChild, supportsPermissionPrompts } from "../orchestrator/process.ts";
import { userMessage } from "../orchestrator/claude-stream.ts";
import { SeatLimit, planPauses, planStarts } from "./busy.ts";
import { MAX_N, SEATS_GROUP, seatUserName, type AdminResult, type AdminVerb } from "./admin.ts";
import { evaluateIsolation, runtimeCopyProblem, seatUserCheck, type Isolation } from "./isolation.ts";
import { RunnerChild, adminCall, runnerOp, type RunnerOpResult } from "./runner-child.ts";
import type { UidOp } from "./runner-uid.ts";
import { RUNNER_MAX_STAGED, RUNNER_PROTOCOL, RUNNER_PROTOCOL_V2, SEAT_TOKEN_FILE } from "./runner.ts";
import {
  DEFAULT_ADMIN, DEFAULT_RUNNER, SCHEDULER_FILES, adminGroupIds, listAcl, lookupOsUser, makeSeatSocketDir, removeSeatSocketDir, selfAdminArgv, selfRunnerArgv, sudoSwitch,
  verifySeatSocketDir, type OsUser,
} from "./seat-user.ts";
import { HelperVersionCache, helperVersionProblem, type HelperVersionAsyncDeps, type StatFn } from "./helper-version.ts";
import { VERSION } from "../version.ts";
import { cloneBundle, readFile, readHead, seatOutcome } from "./git.ts";
import { writeDurably } from "./fsat.ts";
import { SEATS_PHRASES } from "../../protocol/status-projection.ts";
import type { StatusProvenance } from "../../protocol/status-projection.ts";
import { SeatApi } from "./seat-api.ts";
import { SeatStatusThrottle } from "./status-throttle.ts";
import { channelFit, decideRun, decideStop, desiredMembers, launcherHandles, parseLaunchers, type SeatsPolicy } from "./rules.ts";
import {
  KIMI_FULL_ACCESS_ONLY, claudeSeatArgs, claudeSeatParser, codexSeatArgs, codexSeatLine, findRuntime, kimiSeatArgs, kimiSeatLine, loginEnv, seatEnvFile, seatSystemPrompt, withBinDir, type SeatSignal,
} from "./runtime.ts";

export interface SeatsOptions {
  /** The environment seats start from (tests); default process.env. HOME in it is the person's home (~/walkie-seats, `~/` in seats.env_file). */
  env?: NodeJS.ProcessEnv;
  /** Requests older than this when they arrive are refused (default 10 min). */
  maxAgeMs?: number;
  /** Output is posted at most this often per seat (default 3 s). */
  flushMs?: number;
  reserveCheckMs?: number;
  /** Output posts per seat before only the tail is kept for the final post (default 200). */
  maxOutputPosts?: number;
  /** Launches per launcher per minute (default 10). */
  launchesPerMinute?: number;
  /**
   * How the daemon becomes a seat user (`seats.ephemeral`): the argv that runs `runner` as `user` (for a seat, or a uid op). Default
   * `sudo -n -u <user> <runner…>`; tests pass a fake that doesn't switch users (it can't without root).
   */
  userSwitch?: (user: string, runner: string[], purpose: "run" | UidOp) => string[];
  /** OS user lookup (tests: the fake helper's users; they can't create real ones). Default `id`. */
  lookupUser?: (name: string) => OsUser | null;
  /** The root helper (admin.ts) as a function (tests: over a fake system); default `sudo -n <admin> seat-admin …`. */
  admin?: (verb: AdminVerb, n: number) => Promise<AdminResult>;
  /** While busy, paused seats' users are stopped again this often (a SIGCONT from elsewhere is undone). Default 2 s. */
  busyReapplyMs?: number;
  /** Tests: the retry delay of the helper's pending-id reconciliation (default 30 s). */
  reconcileRetryMs?: number;
  /** Launches per launcher per day (default 200). */
  launchesPerDay?: number;
  /** Where the seats' socket directory is made (default /tmp). */
  socketRoot?: string;
  /** The cron/at allow and deny files (tests: temporary ones); default this platform's. */
  schedulerFiles?: { cron: [string, string]; at: [string, string] };
  /**
   * Tests: check the installed runner/helper copies' versions as a release build does (`release`), with these deps
   * (fake paths, a fake `version` run). Default: release builds only, the real copies.
   */
  helperVersion?: HelperVersionAsyncDeps & { release?: boolean; stat?: StatFn };
}

interface Seat {
  id: string;
  /** Launch order on this host (pauses take the newest first, resumes the oldest first). */
  order: number;
  launcher: string;
  run: AnySeatRun;
  /** A v2 request's host-side state (FO-2), or null for v1. */
  v2: V2Seat | null;
  dir: string;
  cwd: string;
  base: string | null;
  startedAt: number;
  child: ClaudeChild<SeatSignal[]> | null;
  /** Run as its own seat user (`seats.ephemeral`): its runner owns the runtime's group; `child` stays null. */
  runner: RunnerChild<SeatSignal[]> | null;
  /** The fresh user it runs as (`walkie-s<n>`), if any, and its n. */
  user: string | null;
  userN: number | null;
  /** Its runner ended before reporting the runtime's exit: the seat killed or lost it (Codex r3 HIGH 1). */
  lost: boolean;
  /** Its user's processes could not be verified gone: they may still run (the user is quarantined). */
  uncontrolled: boolean;
  /** A seat user's seat is paused only once every process of its user was verified stopped (Codex r4 MEDIUM 6). */
  pauseVerified: boolean;
  /** The child's start time as `ps` reports it (a crash-restart kills its group only if it is still that process). */
  childStarted: string | null;
  env: Record<string, string> | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** The wall-clock limit, which doesn't run while the seat is paused. */
  limit: SeatLimit;
  /** Paused because the host's person is using the machine: its group is SIGSTOPped (or will be at spawn). */
  paused: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  buf: string[];
  posts: number;
  lastText: string;
  activity: string;
  activityKind: "tool" | "reply" | null;
  lastOutputAt: number;
  statusTimer: ReturnType<typeof setInterval> | null;
  tail: string;
  truncated: number;
  final: { ok: boolean; text: string } | null;
  /** A v2 request refused while it prepared (a missing prerequisite, an account not usable): posted `refused`. */
  refusal: string | null;
  /** `local`: the host's person stopped it on this machine (its post-run git is aborted, like a revoke's). */
  stop: { reason: "stopped" | "timeout" | "revoked" | "shutdown" | "unadmitted" | "reserve"; by?: string; local?: boolean } | null;
  /** Aborted by a stop in any phase: preparing (env, clone), running, or the post-run git. */
  abort: AbortController;
  /** conclude() has started: the seat stays tracked (and counted) until its group is reaped and its state posted. */
  concluding: boolean;
  /** Resolves once the seat is over and its state was posted. */
  done: Promise<void>;
  finish: () => void;
}

/** A running seat as persisted: its child's pid (its process group) and that process's start time, when known. */
export interface SavedSeat {
  id: string; dir: string; pid?: number; started?: string; runner?: true; user?: number;
  /** FO-2: a same-user v2 seat's brief in the person's tree, removed at the next start if this daemon died first. */
  task?: { cwd: string; file: string; exclude?: string; hash?: string; tmp?: string };
  /** FO-2: a same-user v2 seat's lane branch, whose ownership record follows it at the next start after a crash. */
  lane?: { clone: string; branch: string };
}
/** The host's person is using the machine (`walkie seats busy`): at most `max` seats run; until `until` (ms), if set. */
export interface SeatsBusy { max: number; by: string; since: number; until?: number }
/**
 * `handled`: every request judged here, by id, with the time (ms) until which it must be remembered. `busy`: the
 * person's busy setting (it outlives a restart); `queued`: launches waiting (reported failed after a crash).
 */
interface Persisted {
  handled: Record<string, number>; running: SavedSeat[]; busy?: SeatsBusy; queued?: string[];
  /** Launch times per launcher over the last day (the daily bound outlives a restart: Codex r4 LOW 7). */
  launches?: Record<string, number[]>;
  /** Seat users made and not verified destroyed (a restart destroys them first); the highest id asked for. */
  users?: number[];
  user_high?: number;
}

/** A launch accepted while the machine is busy, waiting to start. */
interface Queued { ev: Event; run: AnySeatRun; launcher: string; at: number }

/** A v2 seat's host-side state (FO-2): its brief file, workspace, account and result file. */
interface V2Seat {
  run: SeatRunV2;
  /** The brief as the host fetched it (UTF-8). */
  brief: string | null;
  /** Where the brief landed (same-user seats; a seat user's runner reports nothing of it). */
  task: TaskFile | null;
  /** A linked worktree's git directories (the seat's `.git` file is never trusted). */
  dirs: { gitDir: string; commonDir: string } | null;
  /** The host's clone and the tag of its private refs (removed when the seat ends). */
  clone: string | null;
  tag: string;
  /** A bundle staged privately for a seat user's runner (streamed over its stdin), and the branch it checks out. */
  staged: { path: string; size: number } | null;
  branch: string | null;
  /** The account's run environment, a seat user's Codex auth, and the router lease held while it runs. */
  creds: SeatCredentials | null;
  lease: Lease | null;
  cancelReserve?: () => void;
  /** The result file as read after the run. */
  result: ResultFile | null;
  /** A lane worktree's HEAD as the seat ended (what Walkie's lane record may follow). */
  resultHead?: string | null;
}

/**
 * Judged requests remembered at once. Never evicted while they could still be accepted (their `ts` + the age limit,
 * plus a day): when this many are live, new requests are not acted on at all (fail closed) rather than forgetting one.
 */
const HANDLED_CAP = 5_000;
/** How long past its acceptance window a judged request is remembered; older stored requests are never judged. */
const HANDLED_KEEP_MS = 24 * 3_600_000;
const OUTPUT_CHUNK = 28_000;
const FLUSH_AT_CHARS = 8_000;
const TAIL_CHARS = 6_000;
const RECONCILE_RETRY_MS = 30_000;
/** The longest wait between requests to mark a seats channel an older authority keeps unmarked. */
const UNMARKED_MAX_MS = 60 * 60_000;
/** Launches waiting on a busy machine at once; more are refused. */
export const QUEUE_CAP = 32;
/** Availability changes are posted at most this often (coalesced). */
const PUBLISH_MS = 100;

/** What to do when the helper's list of seat users can't be read (doctor, pool refusal: Opus r11 LOW). */
export const HELPER_WAY_OUT = "sudo can't reach the seat user helper: run walkie seats setup-user --apply (it reinstalls the helper and its sudo rule); Walkie retries by itself every 30 s, no restart needed";

export interface SeatsDeps {
  core: Core; client: PeerClient; catchUp: CatchUp; log: Logger;
  /** FO-2: the team's accounts view (which machine holds which account, online), for a v2 seat's account check. */
  accounts?: () => AccountView[];
}

export class SeatsHost {
  private readonly core: Core;
  private readonly log: Logger;
  private readonly statePath: string;
  private current: SeatsConfig;
  /** FO-2: this machine's clones of the team's repos (config.json `fleet`). */
  private fleet: FleetConfig;
  private readonly seats = new Map<string, Seat>();
  /** Judged request ids → remember until (ms). Persisted before anything is acted on. */
  private handled = new Map<string, number>();
  private readonly launches = new Map<string, number[]>();
  private readonly launchesDay = new Map<string, number[]>();
  /** Whether and as whom seats may run (isolation.ts), from config.json and the OS; re-checked before each launch. */
  private iso: Isolation;
  /** The seats' socket directory while seats run as seat users (fresh, unpredictable, verified). */
  private socketDir: string | null = null;
  private socketError: string | null = null;
  /** Seat users whose removal couldn't be verified: retried, and counted against capacity meanwhile. */
  private readonly quarantine = new Set<string>();
  private readonly reapRetry = new Map<string, ReturnType<typeof setTimeout>>();
  private busyReapply: ReturnType<typeof setInterval> | null = null;
  /** A destroy in flight per seat user id (destroyUser). */
  private readonly destroys = new Map<number, Promise<CleanResult>>();
  /** Seat user ids made and not verified destroyed; the highest id ever asked for (ids only go up). */
  private readonly liveUsers = new Set<number>();
  /** The helper's pending ids being (or last) reconciled (reconcileHelper). */
  private helperReconciled: Promise<void> = Promise.resolve();
  /**
   * The helper's list was read successfully since this daemon started: before that, no seat user is made, whenever
   * seat users came on (at start, or later through `seats allow` / the isolation turning ephemeral: Codex r9 MEDIUM 4).
   */
  private reconciled = false;
  private listingHelper = false;
  /** Denies still stopping seats (poolBlock). */
  private denying = 0;
  /** init() has loaded seats.json: before that, poolBlock fails closed (Opus r11 MEDIUM, the startup window). */
  private initialized = false;
  /** Why the helper's pending ids couldn't be listed at start (new seat users wait), or null. */
  private reconcileError: string | null = null;
  private reconcileRetry: ReturnType<typeof setTimeout> | null = null;
  /** Why each quarantined seat user's destroy isn't verified (the helper's `left`), for the views. */
  private readonly quarantineWhy = new Map<string, string>();
  private userHigh = 0;
  private adminGids: number[] | null = null;
  /** Each seat user's uid operations, chained (in order). */
  private readonly userOps = new Map<string, Promise<RunnerOpResult | null>>();
  /** Process-group reaps still running (a seat that exited on its own): close() joins them. */
  private readonly reaping = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private closing = false;
  /** close() has finished: no uid operation starts any more. */
  private closed = false;
  private channelError: string | undefined;
  private reconciling: Promise<void> | null = null;
  private reconcileAgain = false;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRequest: { key: string; at: number } | null = null;
  private permissionPrompts: boolean | null = null;
  /**
   * Whether the environment seats get (the daemon's, with what the seat env file exports) carries a non-empty Claude token,
   * as last sourced (refreshLogin); null until then. Never guessed from the file's text (Codex r6 LOW 9).
   */
  private machineToken: { has: boolean; at: number } | null = null;
  private refreshingLogin: Promise<void> | null = null;
  private readonly startedAt = Date.now();
  private launchOrder = 0;
  /** Launches waiting while the machine is busy (or for a free seat after it resumed), oldest first. */
  private queue: Queued[] = [];
  private busy: SeatsBusy | null = null;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  /** The availability last posted in the channel (JSON), so an unchanged one isn't posted again. */
  private published: string | null = null;
  /** The seats' own socket: what a seat's Walkie calls reach instead of this daemon's local API (seat-api.ts). */
  private readonly api: SeatApi;
  /** The installed runner/helper copies' versions, read again only when a copy changes (helper-version.ts). */
  private readonly helperVersions: HelperVersionCache;
  private readonly seatStatuses: SeatStatusThrottle;

  constructor(private readonly deps: SeatsDeps, private readonly opts: SeatsOptions = {}) {
    this.core = deps.core;
    this.log = deps.log;
    this.statePath = join(this.core.paths.home, "seats.json");
    this.current = this.core.config.seats ?? { allow: false };
    this.fleet = this.core.config.fleet ?? {};
    this.iso = this.evaluate(this.current);
    this.api = new SeatApi(join(this.core.paths.home, "seats.sock"), this, this.log);
    this.helperVersions = new HelperVersionCache(this.opts.helperVersion ?? {});
    this.seatStatuses = new SeatStatusThrottle((agent, body, provenance) => body.state === "offline"
      ? this.core.statuses.submitFinal(agent, body, provenance)
      : this.core.statuses.submit(agent, body, provenance), Date.now,
    (error) => this.log.warn("seat_status_flush", { err: String(error) }));
  }

  /**
   * The installed runner and user helper against this Walkie (SeatsLocalView.helper_version): release builds only (a
   * source build runs its own), once seat users are set up (configured, or the helper is installed); absent until the
   * first background check of the copies as they are ends.
   */
  private helperVersionView(): SeatsLocalView["helper_version"] | undefined {
    if (!(this.opts.helperVersion?.release ?? RELEASE_BUILD)) return undefined;
    const runner = this.current.runner ?? DEFAULT_RUNNER;
    const admin = this.current.admin ?? DEFAULT_ADMIN;
    if (this.current.ephemeral !== true && !existsSync(admin)) return undefined;
    const v = this.helperVersions.peek([runner, admin], VERSION); // checked in the background (never blocks the view)
    if (!v) return undefined;
    const problem = helperVersionProblem(v);
    return { state: v.state, want: v.want, copies: v.copies.map((c) => ({ ...c })), ...(problem ? { problem } : {}) };
  }

  /** isolation.ts for `cfg`, with this machine's facts. */
  private evaluate(cfg: SeatsConfig): Isolation {
    return evaluateIsolation(cfg, {
      platform: process.platform, daemonUid: process.getuid?.() ?? -1, daemonGid: process.getgid?.() ?? -1, home: this.home,
      release: RELEASE_BUILD, stat: (p) => { try { return statSync(p); } catch { return null; } }, acl: listAcl,
    });
  }

  /** Seats run as fresh users, one per run. */
  private get ephemeral(): boolean { return this.iso.mode === "ephemeral"; }

  /**
   * The seats' socket: 0600 in the daemon's 0700 home, or (seat users, who can't enter it) 0666 in a fresh 0711
   * directory of the daemon's under /tmp. Refused launches follow if it can't listen (Opus r3 LOW 5).
   */
  private startApi(): void {
    this.socketError = null;
    if (!this.ephemeral) {
      if (this.socketDir) { removeSeatSocketDir(this.socketDir); this.socketDir = null; }
      this.api.socket = join(this.core.paths.home, "seats.sock");
      this.api.start(false);
      return;
    }
    try {
      this.socketDir ??= makeSeatSocketDir(this.opts.socketRoot);
      this.api.socket = join(this.socketDir, "seats.sock");
      this.api.start(true);
      if (!this.api.listening) this.socketError = "the seats' socket isn't listening";
    } catch (err) {
      this.socketError = `the seats' socket directory couldn't be made: ${(err as Error).message}`;
      this.log.warn("seats_socket_dir_failed", { err: this.socketError });
    }
  }

  /** Why a seat can't start as a seat user right now (the socket must listen in a verified directory), or null. */
  private socketProblem(): string | null {
    if (!this.ephemeral) return null;
    if (this.socketError || !this.socketDir || !this.api.listening) return this.socketError ?? "the seats' socket isn't listening";
    try { verifySeatSocketDir(this.socketDir); return null; } catch (err) { return (err as Error).message; }
  }

  /**
   * One uid-wide operation (busy stop/cont) as a seat's user, through sudo like the seat itself. A user's operations
   * run one after another, in order: a re-applied stop never lands after the resume that followed it.
   */
  private uidOp(user: string, op: UidOp): Promise<RunnerOpResult | null> {
    const prev = this.userOps.get(user) ?? Promise.resolve(null);
    const next = prev.catch(() => null).then(() => {
      if (this.closed) return null; // a timer that fired after the daemon stopped: nothing starts any more
      // A stop re-applied by the busy timer is dropped once the seat was resumed meanwhile.
      if (op === "stop" && ![...this.seats.values()].some((s) => s.user === user && s.paused)) return null;
      return runnerOp(this.userArgv(user, op), op);
    }).catch((err: unknown) => {
      // The switch itself failed (it couldn't even be started): not verified, never a crash.
      this.log.warn("seats_uid_op_failed", { user, op, err: (err as Error).message });
      return null;
    });
    this.userOps.set(user, next);
    void next.then(() => { if (this.userOps.get(user) === next) this.userOps.delete(user); });
    return next;
  }

  /** The root helper: `sudo -n <admin> seat-admin <create|destroy> <n>` (admin.ts); tests pass a fake. */
  private adminOp(verb: AdminVerb, n: number): Promise<AdminResult | null> {
    if (this.opts.admin) return this.opts.admin(verb, n).catch(() => null);
    const admin = this.current.admin ? [this.current.admin, "seat-admin"] : selfAdminArgv();
    return adminCall(["sudo", "-n", ...admin, verb, ...(verb === "pending" ? [] : [String(n)])]);
  }

  /**
   * After a start: every id the helper still holds for this person (Codex r7 MEDIUM 3: `seats.json` may have lost one
   * in a power loss) is destroyed like the ones this daemon knew of. New seat users wait for this list.
   */
  /**
   * The helper's list matters while seat users are on (isolation ephemeral) or seats.json still holds one this daemon
   * made (Opus r11 LOW): with neither, nothing of a seat user can be left that the list would find... except one lost
   * from seats.json in a crash, which only matters once seat users are used again (then the list is read first).
   */
  private helperListMatters(): boolean { return this.ephemeral || this.liveUsers.size > 0 || this.quarantine.size > 0; }

  /**
   * The seat user helper is installed here (or configured, or a test's), whatever the isolation now: its held list is
   * read at every start, so seat users a lost seats.json forgot are found (and keep the pool off) even when seats are
   * no longer configured for seat users (Kimi seats r11 LOW 2).
   */
  private helperInstalled(): boolean { return !!this.opts.admin || !!this.current.admin || existsSync(DEFAULT_ADMIN); }

  /** Once the list no longer matters: no block, no retry (read again, first, if seat users come back on). */
  private settleHelperList(): void {
    if (this.helperListMatters()) return;
    if (this.reconcileRetry) { clearTimeout(this.reconcileRetry); this.reconcileRetry = null; }
    this.reconcileError = null;
  }

  /** Starts reading the helper's list unless it was read or is being read (one at a time). */
  private startReconcile(): void {
    if (this.reconciled || this.listingHelper) return;
    if (this.reconcileRetry) { clearTimeout(this.reconcileRetry); this.reconcileRetry = null; }
    this.listingHelper = true;
    this.helperReconciled = this.reconcileHelper().catch(() => undefined).finally(() => { this.listingHelper = false; });
  }

  private async reconcileHelper(): Promise<void> {
    const r = await this.adminOp("pending", 0);
    if (!r?.ok || !Array.isArray(r.ids)) {
      // Not reconciled: no new seat user until it is (Codex r8 MEDIUM 2), retried every 30 s, shown in the views.
      this.reconcileError = scrub(r?.why ?? "the user helper didn't answer").slice(0, 300);
      this.log.warn("seats_pending_unknown", { why: this.reconcileError });
      if (!this.closing && this.helperListMatters()) {
        this.reconcileRetry = setTimeout(() => { this.reconcileRetry = null; if (this.helperListMatters()) this.startReconcile(); else this.settleHelperList(); }, this.opts.reconcileRetryMs ?? 30_000);
      }
      return;
    }
    this.reconcileError = null;
    this.reconciled = true;
    let added = false;
    for (const n of r.ids) {
      if (!Number.isInteger(n) || n < 1) continue;
      if (n > this.userHigh) this.userHigh = n;
      if (this.liveUsers.has(n)) continue;
      this.log.warn("seats_pending_recovered", { user: seatUserName(n) });
      this.liveUsers.add(n);
      added = true;
      void this.destroyUser(n);
    }
    if (added || r.ids.length) this.save();
  }

  /**
   * A fresh user for one seat (Codex r5, Opus r5: a uid is never reused): the helper makes `walkie-s<n>` with n above
   * every id it ever used; this host then checks it (its uid, its groups by number, cron and at denying it). The id is
   * saved as this daemon's before the helper is asked (Codex r6 MEDIUM 4): whatever happens next (no answer, a
   * failure, a crash of this daemon), it is destroyed-and-verified like any other seat user, unless the helper said
   * it made nothing for it.
   */
  private async makeSeatUser(): Promise<{ name: string; n: number }> {
    // Every id the helper holds for this person is known first, however seat users came on (Codex r9 MEDIUM 4).
    if (!this.reconcileError) this.startReconcile();
    await this.helperReconciled;
    if (!this.reconciled) {
      throw new Error(`no seat user can be made yet: Walkie couldn't list the seat users its helper still holds (${this.reconcileError ?? "not listed yet"}); it retries every 30 s`);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const n = ++this.userHigh;
      if (n > MAX_N) {
        // Ids are never reused (1–99,999 per machine; Opus r8 LOW): past the last one, no seat user can be made.
        this.userHigh = MAX_N;
        throw new Error(`this machine has used all ${MAX_N} seat user ids (walkie-s1 … walkie-s${MAX_N}; they are never reused): see INSTALL.md §8`);
      }
      this.liveUsers.add(n);
      if (!this.save(true)) {
        this.liveUsers.delete(n);
        throw new Error("no seat user could be made: seats.json could not be written (check the Walkie home's disk and permissions)");
      }
      const r = await this.adminOp("create", n);
      if (!r?.ok) {
        if (r?.code === "used" || r?.code === "refused") {
          // The helper made nothing for it: not this daemon's to destroy.
          this.liveUsers.delete(n);
          if (r.high && r.high > this.userHigh) this.userHigh = r.high;
          this.save();
          if (r.code === "used") continue; // the helper has used more ids: above them
        } else {
          void this.destroyUser(n); // failed, or no answer: whatever of it exists is destroyed, verified (quarantined meanwhile)
        }
        throw new Error(`no seat user could be made: ${r?.why ?? "the user helper didn't answer"}`);
      }
      const name = seatUserName(n);
      const adminGids = this.adminGids ?? adminGroupIds();
      if (adminGids) this.adminGids = adminGids; // only a complete answer is kept (Codex r5 MEDIUM 6)
      const lookup = this.opts.lookupUser ?? lookupOsUser;
      const why = seatUserCheck(lookup(name), name, n, {
        daemonUid: process.getuid?.() ?? -1, daemonGid: process.getgid?.() ?? -1, adminGids, seatsGid: lookup(SEATS_GROUP)?.gid ?? null,
        schedulerFiles: this.opts.schedulerFiles ?? SCHEDULER_FILES[process.platform === "darwin" ? "darwin" : "linux"], readFile: readIfThere,
      });
      if (why) {
        void this.destroyUser(n);
        throw new Error(`the new seat user ${name} can't be used: ${why}`);
      }
      return { name, n };
    }
    throw new Error("no seat user could be made: the user helper keeps refusing new ids");
  }

  /**
   * Destroys a seat's user (admin.ts: every process, its services and schedules, every file it owns, its home, the
   * user), verified. One destroy per user at a time: a stop and the seat's end both ask, and join. Unverified: the
   * user stays quarantined (never reused anyway, and counted against the machine's seats while something of it may
   * run), retried every 60 s.
   */
  private destroyUser(n: number): Promise<CleanResult> {
    const inFlight = this.destroys.get(n);
    if (inFlight) return inFlight;
    this.quarantine.add(seatUserName(n));
    const p = this.destroyOnce(n).finally(() => this.destroys.delete(n));
    this.destroys.set(n, p);
    return p;
  }

  private async destroyOnce(n: number): Promise<CleanResult> {
    const name = seatUserName(n);
    const r = await this.adminOp("destroy", n);
    if (r?.ok) {
      this.quarantine.delete(name);
      this.quarantineWhy.delete(name);
      this.liveUsers.delete(n);
      this.save();
      const t = this.reapRetry.get(name);
      if (t) { clearTimeout(t); this.reapRetry.delete(name); }
      if (!this.closing) this.rebalance();
      return { ok: true };
    }
    this.log.warn("seats_destroy_unverified", { user: name, why: r?.why ?? "the user helper didn't answer", left: r?.left ?? null });
    this.quarantineWhy.set(name, scrub(r?.why ?? "the user helper didn't answer").slice(0, 400));
    if (!this.closing && !this.reapRetry.has(name)) {
      this.reapRetry.set(name, setTimeout(() => { this.reapRetry.delete(name); void this.destroyUser(n); }, 60_000));
    }
    return { ok: false, why: r?.why ?? "the user helper didn't answer" };
  }

  /** Seats that may run at once: the host's max, less the seat users whose destroy isn't verified yet. */
  private capacity(): number {
    return Math.max(0, this.hostMax - this.quarantine.size);
  }

  private get env(): NodeJS.ProcessEnv { return this.opts.env ?? process.env; }
  private get home(): string { return this.env.HOME ?? homedir(); }
  /** The file sourced for each seat's login environment (runtime.ts seatEnvFile). */
  private get envFile(): string { return seatEnvFile(this.core.paths.home, this.home, this.current.env_file); }
  private get maxAge(): number { return this.opts.maxAgeMs ?? 10 * 60_000; }
  private get flushMs(): number { return this.opts.flushMs ?? 3_000; }
  private get maxPosts(): number { return this.opts.maxOutputPosts ?? 200; }
  private get perMinute(): number { return this.opts.launchesPerMinute ?? 10; }
  get channel(): string { return seatsChannel(this.core.nodeId); }

  /** The argv that starts the runner as the seat user. */
  private userArgv(user: string, purpose: "run" | UidOp = "run"): string[] {
    const runner = this.current.runner ? [this.current.runner, "seat-runner"] : selfRunnerArgv();
    return this.opts.userSwitch ? this.opts.userSwitch(user, runner, purpose) : sudoSwitch(user, runner);
  }
  /**
   * Why the pool (split runs) must stay off on this machine now, or null (Opus seats r9 HIGH, Codex r10 HIGH): seats
   * are allowed, or anything of one may still run — a seat or a queued launch, a deny still stopping them, a seat user
   * not verified removed (quarantined, or being destroyed), or the helper's list of the ones it holds not read yet.
   */
  poolBlock(): string | null {
    // Before init() has read seats.json, the seat users a crash left behind aren't known yet: nothing of the pool.
    if (!this.initialized) return `${SEATS_POOL_CONFLICT}. Walkie is still starting and hasn't checked this machine's seats yet: try again in a moment`;
    if (this.current.allow === true) return TURN_SEATS_OFF;
    if (this.denying || this.seats.size || this.queue.length) {
      return `${SEATS_POOL_CONFLICT}. Seats are still stopping here: wait until they have (walkie seats)`;
    }
    const left = [...new Set([...this.quarantine, ...[...this.liveUsers].map(seatUserName)])].sort();
    if (left.length) {
      return `${SEATS_POOL_CONFLICT}. Seat users not verified removed yet (${left.join(", ")}): something of them may still run; walkie seats says why`;
    }
    // While the list is being read it may name users seats.json lost (fail closed); unreadable, it blocks only while
    // it matters (seat users on, or one held).
    if (this.listingHelper || (this.reconcileError && this.helperListMatters())) {
      return `${SEATS_POOL_CONFLICT}. Walkie hasn't yet listed the seat users its helper may still hold${this.reconcileError ? ` (${this.reconcileError})` : ""}: ${HELPER_WAY_OUT}`;
    }
    return null;
  }
  /** Seats may run: allowed in config.json AND isolated as required (a legacy or unsafe configuration runs nothing). */
  get allowed(): boolean { return this.current.allow === true && this.iso.problem === null; }
  /** Seats running at once on this machine, whoever launched them: the person's `max`, else DEFAULT_HOST_MAX. */
  get hostMax(): number { return this.current.max ?? DEFAULT_HOST_MAX; }
  /** This machine's seats settings (config.json `seats`) as last saved. */
  get settings(): SeatsConfig { return this.current; }

  private policy(): SeatsPolicy {
    return {
      allow: this.allowed,
      launchers: parseLaunchers(this.current.launchers),
      runtimes: this.runtimes(),
    };
  }

  /**
   * The runtimes allowed here: `runtimes` (Claude/Codex, both when unset) plus Kimi only when its person (or, with
   * AGENT-ADMIN, their agent) turned it on (`walkie seats allow --runtimes …,kimi`): never on by default (FO-2 r1 MEDIUM 7).
   */
  private runtimes(): SeatRuntime[] {
    const kimi = this.current.kimi === true;
    return [...(this.current.runtimes ?? SEAT_RUNTIMES_V1), ...(kimi ? ["kimi" as const] : [])];
  }

  /** FO-2: this machine's repo clones for v2 seats, by repo id. */
  get repos(): Readonly<Record<string, string>> { return this.fleet.repos ?? {}; }

  /** Sets (or, with null, removes) a repo clone for v2 seats; config.json first, then in memory. */
  setRepo(id: string, path: string | null): Record<string, string> {
    const repos = { ...this.repos };
    if (path === null) delete repos[id]; else repos[id] = path;
    const next: FleetConfig = { ...this.fleet, repos };
    saveFleetConfig(this.core.paths.config, next);
    this.fleet = next;
    this.log.info("seats_repo_set", { repo: id, removed: path === null });
    return { ...repos };
  }

  private seatsDir(): string {
    const d = this.current.dir ?? "~/walkie-seats";
    return resolve(d === "~" ? this.home : d.startsWith("~/") ? join(this.home, d.slice(2)) : d);
  }

  // ---- lifecycle ---------------------------------------------------------------------------------

  /** Daemon start: listen for requests; seats that ran when the daemon last stopped abruptly are reported failed. */
  init(): void {
    const saved = this.load();
    const now = Date.now();
    this.handled = new Map(Object.entries(saved.handled).filter(([, until]) => until >= now));
    for (const [k, v] of Object.entries(saved.launches ?? {})) this.launchesDay.set(k, v);
    if (this.current.allow && this.iso.problem) this.log.warn("seats_disabled", { reason: this.iso.problem });
    this.userHigh = Math.max(this.userHigh, saved.user_high ?? 0);
    // FO-2: what a v2 seat left when this daemon died: staged bundles, and briefs in the person's trees.
    const swept = sweepStaged(this.core.paths.home);
    if (swept) this.log.warn("seats_stage_swept", { files: swept });
    for (const r of saved.running) {
      if (!r.task) continue;
      removeTask(r.task.cwd, { file: r.task.file, prompt: "", ...(r.task.exclude ? { exclude: r.task.exclude } : {}), ...(r.task.hash ? { hash: r.task.hash } : {}), ...(r.task.tmp ? { tmp: r.task.tmp } : {}) });
      releaseExclude({ file: r.task.file, prompt: "", ...(r.task.exclude ? { exclude: r.task.exclude } : {}) });
      this.log.warn("seats_brief_removed", { id: r.id });
    }
    for (const r of saved.running) {
      if (!r.lane) continue;
      const env = { PATH: this.env.PATH ?? "/usr/bin:/bin", HOME: this.home };
      // After a crash the seat's own result is unknown: nothing is claimed; a record whose branch is gone is dropped.
      void recordLaneTip(r.lane.clone, r.lane.branch, env).catch(() => undefined);
    }
    this.startApi();
    if (this.current.ephemeral) void this.refreshLogin();
    // Nothing of a seat user outlives a daemon: every one made and not verified destroyed is destroyed now, counted
    // against the machine's seats until that is verified.
    const leftUsers = new Set([...(saved.users ?? []), ...saved.running.map((r) => r.user).filter((u): u is number => u !== undefined)]);
    const destroyed = new Map<number, Promise<CleanResult>>();
    for (const n of leftUsers) { this.liveUsers.add(n); destroyed.set(n, this.destroyUser(n)); }
    if (this.ephemeral || this.helperInstalled()) this.startReconcile();
    this.initialized = true;
    this.unsubscribe = this.core.hub.subscribe((ev) => {
      try { this.onEvent(ev); } catch (err) { this.log.warn("seats_event_failed", { err: (err as Error).message }); }
    });
    // A daemon that died without stopping its seats left their process groups running (or what their tools started,
    // after the runtime itself exited): end every survivor now (killLeftover), then report them.
    for (const r of saved.running) {
      // A seat user's seat: said stopped only once its user's destroy is verified (Codex r5 MEDIUM 3), never assumed.
      if (r.runner && r.user !== undefined) {
        void (destroyed.get(r.user) ?? this.destroyUser(r.user)).then((d) => {
          this.log.warn("seats_leftover", { id: r.id, user: r.user, destroyed: d.ok });
          this.postState(r.id, {
            state: "failed", dir: homeRelative(r.dir),
            reason: `the host's Walkie daemon restarted while it ran${d.ok ? " (its processes were stopped)" : " (its seat user could not be verified removed: its processes may still be running; it is quarantined)"}`,
          });
          this.endSavedSeatCard(r.id);
        }).catch((err) => {
          this.log.warn("seats_leftover_cleanup_failed", { id: r.id, err: scrub((err as Error).message) });
          this.postState(r.id, { state: "failed", dir: homeRelative(r.dir), reason: "the host's Walkie daemon restarted; seat user cleanup failed and its processes may still be running" });
          this.endSavedSeatCard(r.id);
        });
        continue;
      }
      const killed = r.runner ? false : killLeftover(r);
      this.log.warn("seats_leftover", { id: r.id, pid: r.pid ?? null, killed });
      this.postState(r.id, { state: "failed", reason: `the host's Walkie daemon restarted while it ran${killed ? " (its processes were stopped)" : ""}`, dir: homeRelative(r.dir) });
      this.endSavedSeatCard(r.id);
    }
    for (const id of saved.queued ?? []) this.postState(id, { state: "failed", reason: "the host's Walkie daemon restarted while the seat was queued" });
    // The person's busy setting outlives a restart (they are still at the machine), unless its timer ran out.
    if (saved.busy && this.allowed && !(saved.busy.until !== undefined && saved.busy.until <= now)) {
      this.busy = saved.busy;
      this.armBusyTimer();
    }
    this.save();
    if (!this.allowed) return;
    this.published = this.lastPublished();
    this.status();
    this.publish();
    void this.reconcile();
    // Requests stored but not handled (they arrived while this daemon was starting): judged now, age included. If
    // seats.json couldn't be read, which requests ran is unknown: none of the stored ones is acted on (fail closed).
    for (const ev of this.storedRequests()) {
      if (this.handled.has(ev.id) || ev.ts < now - HANDLED_KEEP_MS) continue;
      if (saved.unreadable) this.remember(ev, true); else this.onEvent(ev);
    }
    if (saved.unreadable) this.save();
  }

  /** Daemon shutdown: every seat is stopped (its whole process group) before this resolves. */
  async close(): Promise<void> {
    this.closing = true;
    this.seatStatuses.clearPending();
    for (const seat of this.seats.values()) {
      if (seat.statusTimer) clearInterval(seat.statusTimer);
      seat.statusTimer = null;
      if (seat.flushTimer) clearTimeout(seat.flushTimer);
      seat.flushTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    if (this.busyTimer) clearTimeout(this.busyTimer);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    if (this.busyReapply) clearInterval(this.busyReapply);
    for (const t of this.reapRetry.values()) clearTimeout(t);
    await this.stopAll("shutdown");
    await Promise.all([...this.reaping]);
    this.seatStatuses.stop();
    this.closed = true;
    if (this.busyReapply) clearInterval(this.busyReapply);
    for (const t of this.reapRetry.values()) clearTimeout(t);
    if (this.reconcileRetry) clearTimeout(this.reconcileRetry);
    this.api.stop();
    if (this.socketDir) removeSeatSocketDir(this.socketDir);
  }

  /** `walkie seats allow|deny` (people only, local). Deny stops every running seat. */
  async configure(next: SeatsConfig): Promise<SeatsLocalView> {
    // Deny first, whatever else changed (Codex r4 MEDIUM 3): every seat stops, by the identities it runs as.
    if (!next.allow) return this.deny(next);
    const nextIso = this.evaluate(next);
    const moving = nextIso.mode !== this.iso.mode;
    // A seat that is only finishing (its state already posted) is waited for, not counted as running.
    if (moving) await Promise.all([...this.seats.values()].filter((x) => x.concluding).map((x) => x.done));
    if (moving && (this.seats.size || this.queue.length)) {
      throw new HttpError(409, "conflict", "seats are running here: stop them (or walkie seats deny) before changing the users seats run as");
    }
    if (next.allow && nextIso.problem) {
      throw new HttpError(409, !next.ephemeral && nextIso.mode === "none" ? "seat_user_required" : "seat_user_unsafe", nextIso.problem);
    }
    // Never on while anything of the pool is (Opus seats r9 HIGH): checked with no await between here and `current`,
    // and the pool asks `on` synchronously before it starts anything, so neither can slip in behind the other.
    const pool = this.core.pool?.seatsConflict() ?? null;
    if (pool) throw new HttpError(409, SEATS_POOL_CODE, pool);
    // Nothing already in the channel is acted on because seats were (re)allowed: recorded before they are on.
    if (next.allow && !this.allowed) {
      for (const ev of this.storedRequests()) this.remember(ev, true);
      if (!this.save()) throw new HttpError(500, "internal", "seats.json could not be written, so seats stay off (check the Walkie home's disk and permissions)");
    }
    saveSeatsConfig(this.core.paths.config, next); // turning on (or changing): only once it is on disk
    this.current = next;
    this.iso = nextIso;
    if (this.ephemeral) this.startReconcile(); // seat users on now: the helper's list is read before the first one
    if (moving || (this.ephemeral && this.socketProblem())) {
      this.api.stop();
      this.startApi();
    }
    this.log.info("seats_configured", { allow: next.allow, launchers: next.launchers ?? "owners", runtimes: next.runtimes ?? "all", max: next.max ?? DEFAULT_HOST_MAX });
    await this.refreshLogin();
    mkdirSync(this.seatsDir(), { recursive: true, mode: 0o700 });
    this.status();
    await this.reconcile(true);
    this.rebalance(); // a larger `max` may start queued launches
    this.publish();
    return this.view();
  }

  /**
   * `walkie seats deny`: the emergency control. Seats stop here whatever happens to config.json (Codex r2 MEDIUM 3)
   * and whatever the isolation now says (Codex r4 MEDIUM 3). Nothing runs, so there is nothing to limit: the busy
   * setting ends with the seats.
   */
  private async deny(next: SeatsConfig): Promise<SeatsLocalView> {
    this.current = next;
    this.clearBusy();
    this.denying++; // the pool stays off until every seat has stopped (Codex r10 HIGH)
    try { await this.stopAll("revoked"); } finally { this.denying--; }
    this.save();
    this.status();
    try {
      saveSeatsConfig(this.core.paths.config, next);
    } catch (err) {
      this.log.warn("seats_config_write_failed", { allow: false, err: (err as Error).message });
      const q = [...this.quarantine].sort();
      const stopped = q.length
        ? `seats are off and every seat was told to stop, but these seat users could not be verified removed (their processes or files may remain; quarantined, retried every minute): ${q.join(", ")}.`
        : "every seat was stopped and seats are off";
      throw new HttpError(500, "internal", `${stopped}${q.length ? " And" : ", but"} config.json could not be written`
        + ` (${scrub((err as Error).message).slice(0, 200)}): they would be on again after a daemon restart. Free disk space or fix the Walkie home's permissions, then run: walkie seats deny`);
    }
    this.log.info("seats_configured", { allow: false });
    // Seat users set up while seats are off (walkie seats setup-user --apply) change where the seats' socket lives:
    // it moves now, so allowing them later finds it listening (found by the sign-up-link tests).
    const nextIso = this.evaluate(next);
    const moving = nextIso.mode !== this.iso.mode;
    this.iso = nextIso;
    if (moving) { this.api.stop(); this.startApi(); }
    this.settleHelperList(); // seat users off and none left: the helper's list stops blocking (Opus r11 LOW)
    return this.view();
  }

  view(): SeatsLocalView {
    // As it is now (a cron deny file edited, a home opened), not as at the last launch.
    const fresh = this.current.allow ? this.evaluate(this.current) : this.iso;
    const me = this.core.myHandle();
    const ch = this.core.roster.channels.get(this.channel);
    const fit = me ? channelFit(ch, me, launcherHandles(this.core.roster, this.policy())) : "not_in_team";
    const pool = this.core.pool?.seatsConflict() ?? null;
    const off = this.current.allow ? fresh.problem ?? this.socketProblem() ?? pool : null;
    const helperVersion = this.helperVersionView();
    return {
      ...(pool ? { pool_conflict: pool } : {}),
      allow: this.current.allow === true, launchers: this.current.launchers ?? [], runtimes: this.runtimes(),
      max: this.hostMax, ...(this.current.env?.length ? { env: [...this.current.env] } : {}),
      ephemeral: this.current.ephemeral === true, same_user: this.iso.mode === "same_user", readable_home: this.current.accept_readable_home === true,
      claude_login: this.claudeLogin(), codex_login: this.codexLogin(), ...(this.reconcileError ? { reconcile_error: this.reconcileError } : {}), ...(this.quarantine.size ? { quarantined: [...this.quarantine].sort() } : {}),
      ...(this.quarantineWhy.size ? { quarantine_why: Object.fromEntries([...this.quarantineWhy].filter(([u]) => this.quarantine.has(u))) } : {}),
      ...(off ? { disabled_reason: off } : {}),
      dir: homeRelative(this.seatsDir()),
      channel: this.core.teamId ? this.channel : null, channel_ok: fit === null,
      ...(this.allowed && fit ? { channel_error: this.channelError ?? fit } : {}),
      running: this.seats.size, paused: this.pausedCount(), queued: this.queue.length, availability: this.availability(),
      ...(helperVersion ? { helper_version: helperVersion } : {}),
    };
  }

  /** A stop from the host's own person (local API): any seat running (or paused, or queued) here. */
  /**
   * The machine's own stop. `verified`: its seat user's removal was verified (always, for a seat as the person or a
   * queued one); otherwise `why` says so (Codex r7 MEDIUM 6).
   */
  async stopLocal(id: string, by: string): Promise<{ stopped: boolean; verified: boolean; why?: string }> {
    if (this.dequeue(id, { reason: "stopped", by })) return { stopped: true, verified: true };
    const seat = this.seats.get(id);
    if (!seat) return { stopped: false, verified: true };
    // The machine's own emergency stop: like a revoke, the post-run git is aborted too (Opus r2 INFO 5).
    await this.stopSeat(seat, { reason: "stopped", by, local: true });
    if (!seat.uncontrolled) return { stopped: true, verified: true };
    const user = seat.user ?? "its seat user";
    return {
      stopped: true, verified: false,
      why: `Walkie could not verify that ${user} was removed: its processes or files may remain (quarantined, retried every minute${this.quarantineWhy.get(user) ? `: ${this.quarantineWhy.get(user)}` : ""})`,
    };
  }

  /** The seat runs here, is paused here or is queued here. */
  isRunning(id: string): boolean { return this.seats.has(id) || this.queue.some((q) => q.ev.id === id); }

  // ---- busy: the host's person is using the machine -------------------------------------------------------

  /** Whether this machine is busy, with its limit and counts (what the host post and the local views carry). */
  availability(): HostAvailability {
    if (!this.busy) return { state: "available" };
    const live = this.liveSeats();
    return {
      state: "busy", max: this.busy.max, running: live.filter((s) => !this.shownPaused(s)).length, paused: live.filter((s) => this.shownPaused(s)).length,
      queued: this.queue.length, by: this.busy.by, since: this.busy.since, ...(this.busy.until !== undefined ? { until: this.busy.until } : {}),
    };
  }

  /**
   * `walkie seats busy` (the machine's person, local only): at most `max` seats run here from now on (0 = none);
   * the newest running ones are paused, new launches queue. `forMs`: resume by itself after that long.
   */
  setBusy(opts: { max: number; forMs?: number; by: string }): SeatsLocalView {
    if (!this.allowed) throw new HttpError(409, "seats_off", "seats are off on this machine: nothing runs here to limit");
    const now = Date.now();
    this.busy = { max: opts.max, by: opts.by, since: this.busy?.since ?? now, ...(opts.forMs !== undefined ? { until: now + opts.forMs } : {}) };
    this.armBusyTimer();
    this.save();
    this.log.info("seats_busy", { max: opts.max, until: this.busy.until ?? null, by: opts.by });
    this.rebalance();
    this.status();
    this.publish();
    return this.view();
  }

  /** `walkie seats resume` (the person, or the busy timer): paused seats continue, queued ones start within the caps. */
  resume(by: string): SeatsLocalView {
    if (this.busy) {
      this.log.info("seats_resume", { by });
      this.clearBusy();
      this.save();
      this.rebalance();
      this.status();
      this.publish();
    }
    return this.view();
  }

  private clearBusy(): void {
    this.busy = null;
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
  }

  private armBusyTimer(): void {
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
    const until = this.busy?.until;
    if (until === undefined || this.closing) return;
    this.busyTimer = setTimeout(() => { this.busyTimer = null; this.resume("timer"); }, Math.max(0, until - Date.now()));
  }

  /** Paused as far as anyone is told: a seat user's seat only once verified. */
  private shownPaused(s: Seat): boolean { return s.paused && (!s.runner || s.pauseVerified); }

  /** Seats not ending (a stopping or concluding seat is left alone). */
  private liveSeats(): Seat[] {
    return [...this.seats.values()].filter((s) => !s.stop && !s.concluding);
  }

  private pausedCount(): number { return this.liveSeats().filter((s) => this.shownPaused(s)).length; }

  /**
   * Applies the busy limit (Infinity when not busy): pauses the newest running seats above it, continues the oldest
   * paused ones below it, then starts queued launches that fit (busy.ts).
   */
  private rebalance(): void {
    if (this.closing) return;
    const limit = this.busy ? this.busy.max : Infinity;
    const live = this.liveSeats();
    const plan = planPauses(live.filter((s) => !s.paused), live.filter((s) => s.paused), limit);
    for (const id of plan.pause) { const s = this.seats.get(id); if (s) this.pause(s); }
    for (const id of plan.resume) { const s = this.seats.get(id); if (s) this.unpause(s); }
    this.drain(limit);
    this.syncBusyReapply();
    this.publish();
  }

  /**
   * While seat users' seats are paused, they are stopped again every busyReapplyMs: a SIGCONT from anything else
   * (the person, a leftover) is undone. Nothing to do when none is paused.
   */
  private syncBusyReapply(): void {
    const paused = () => [...this.seats.values()].filter((s) => s.paused && s.pauseVerified && s.user && s.runner?.runtimePid && !s.stop && !s.concluding);
    if (!paused().length || this.closing) {
      if (this.busyReapply) clearInterval(this.busyReapply);
      this.busyReapply = null;
      return;
    }
    if (this.busyReapply) return;
    this.busyReapply = setInterval(() => {
      const list = paused();
      if (!list.length) { this.syncBusyReapply(); return; }
      for (const s of list) {
        void this.uidOp(s.user as string, "stop").then((r) => {
          if (this.closing || r?.verified || !s.paused) return;
          // Not verified any more, or no answer (Codex r5 MEDIUM 3, Codex r6 MEDIUM 8): no longer said paused until a
          // new stop is verified.
          this.log.warn("seats_pause_reapply_unverified", { id: s.id, user: s.user, why: r?.why ?? "no answer" });
          s.pauseVerified = false;
          this.publish();
          this.confirmPause(s);
        });
      }
    }, this.opts.busyReapplyMs ?? 2_000);
  }

  /** Signals a seat's whole process group (its runtime leads it); false when none of it is left. */
  private signal(seat: Seat, sig: "SIGSTOP" | "SIGCONT"): boolean {
    if (seat.runner) return false; // a seat user's seat: uid operations only (confirmPause, unpause, reap)
    if (!seat.child) return false;
    try { process.kill(-seat.child.pid, sig); return true; } catch { return false; }
  }

  /** SIGSTOP (no work lost, memory kept); its time limit stops too. A seat still preparing is stopped at spawn. */
  private pause(seat: Seat): void {
    seat.paused = true;
    if (seat.timer) clearTimeout(seat.timer);
    seat.timer = null;
    seat.limit.pause(Date.now());
    if (seat.runner) {
      // Every process of its user, and said only once verified (Codex r4 MEDIUM 6). Still preparing: at spawn.
      if (seat.runner.runtimePid !== null) this.confirmPause(seat);
      return;
    }
    const sent = this.signal(seat, "SIGSTOP");
    this.log.info("seats_paused", { id: seat.id, signalled: sent });
    this.postState(seat.id, { state: "paused", reason: "the host's person is using the machine", ...(this.busy?.until !== undefined ? { until: this.busy.until } : {}) });
  }

  /** A seat user's seat: SIGSTOP every process of its user; announced paused only once verified, else it runs on. */
  private confirmPause(seat: Seat): void {
    const user = seat.user as string;
    void this.uidOp(user, "stop").then((r) => {
      if (this.closing || !seat.paused || seat.stop || seat.concluding) return;
      if (r?.verified) {
        seat.pauseVerified = true;
        this.log.info("seats_paused", { id: seat.id, user });
        this.postState(seat.id, { state: "paused", reason: "the host's person is using the machine", ...(this.busy?.until !== undefined ? { until: this.busy.until } : {}) });
        this.syncBusyReapply();
      } else {
        this.log.warn("seats_pause_unverified", { id: seat.id, user, why: r?.why ?? "no answer" });
        seat.paused = false;
        this.armLimit(seat);
        this.postState(seat.id, { state: "running", reason: "it could not be paused (its processes may still be running)", dir: this.shownDir(seat) });
      }
      this.status();
      this.publish();
    });
  }

  /** SIGCONT; its time limit runs again with what was left. */
  private unpause(seat: Seat): void {
    seat.paused = false;
    seat.pauseVerified = false;
    if (!seat.child && !seat.runner?.runtimePid) return; // still preparing: spawn() starts it running and says so
    this.armLimit(seat);
    if (seat.runner && seat.user) {
      // Said resumed only once every process of its user was verified continued (Codex r6 MEDIUM 8).
      const user = seat.user;
      void this.uidOp(user, "cont").then((r) => {
        if (this.closing || seat.paused || seat.stop || seat.concluding) return;
        if (r?.verified) {
          this.log.info("seats_resumed", { id: seat.id, user });
          this.postState(seat.id, { state: "running", reason: "resumed", dir: this.shownDir(seat) });
          return;
        }
        this.log.warn("seats_resume_unverified", { id: seat.id, user, why: r?.why ?? "no answer" });
        this.postState(seat.id, { state: "running", reason: "Walkie could not verify that it resumed (some of its processes may still be stopped)", dir: this.shownDir(seat) });
      });
      return;
    }
    this.signal(seat, "SIGCONT");
    this.log.info("seats_resumed", { id: seat.id });
    this.postState(seat.id, { state: "running", reason: "resumed", dir: this.shownDir(seat) });
  }

  private armLimit(seat: Seat): void {
    if (seat.timer) clearTimeout(seat.timer);
    const ms = seat.limit.start(Date.now());
    seat.timer = setTimeout(() => { void this.stopSeat(seat, { reason: "timeout" }); }, ms);
  }

  /** Starts the queued launches that fit now, oldest first (their launcher is re-checked: it may have lost the right). */
  private drain(limit: number): void {
    if (!this.queue.length || !this.allowed || this.closing) return;
    const live = this.liveSeats();
    const byLauncher = new Map<string, number>();
    for (const s of this.seats.values()) byLauncher.set(s.launcher, (byLauncher.get(s.launcher) ?? 0) + 1);
    const starts = planStarts(
      this.queue.map((q) => ({ id: q.ev.id, launcher: q.launcher, maxConcurrent: q.run.max_concurrent })),
      { active: live.filter((s) => !s.paused).length, total: this.seats.size, byLauncher }, limit, this.capacity(),
    );
    if (!starts.length) return;
    const go = this.queue.filter((q) => starts.includes(q.ev.id));
    this.queue = this.queue.filter((q) => !starts.includes(q.ev.id));
    this.save();
    const me = this.core.myHandle();
    for (const q of go) {
      const d = me ? decideRun(q.ev, { roster: this.core.roster, node: this.core.nodeId, me, policy: this.policy(), now: this.core.clock(), maxAgeMs: this.maxAge, queued: true }) : null;
      if (!d?.ok) {
        const reason = d && !d.ok ? d.reason : "not_in_team";
        this.log.info("seats_refused", { id: q.ev.id, reason, from: q.launcher, queued: true });
        if (d && !d.ok && d.answer) this.postState(q.ev.id, { state: "refused", reason: REASONS[reason] ?? reason });
        continue;
      }
      this.log.info("seats_dequeued", { id: q.ev.id, waited_ms: Date.now() - q.at });
      void this.launch(q.ev, q.run, q.launcher);
    }
  }

  /** Removes a queued launch (stopped, revoked, shutdown…) and answers it; false when it isn't queued. */
  private dequeue(id: string, stop: NonNullable<Seat["stop"]>): boolean {
    const q = this.queue.find((x) => x.ev.id === id);
    if (!q) return false;
    this.queue = this.queue.filter((x) => x !== q);
    this.save();
    this.log.info("seats_queued_ended", { id, reason: stop.reason, by: stop.by ?? null });
    this.postState(id, { ...stopText(stop, q.run), ...(stop.reason === "stopped" ? { reason: `${stopText(stop, q.run).reason} (while queued)` } : {}) });
    this.status();
    this.publish();
    return true;
  }

  // ---- availability: the host post and the team-wide status -------------------------------------------------

  /** The availability this host last posted in its channel (after a restart), as JSON. */
  private lastPublished(): string | null {
    const rows = this.core.store.queryEvents({ channel: this.channel, kinds: ["msg.post"], agents: [SEATS_AGENT], roots: true, limit: 50 });
    for (const r of rows) {
      const ev = JSON.parse(r.json) as Event;
      if (ev.origin !== this.core.nodeId || ev.author.agent !== SEATS_AGENT) continue;
      const s = seatOf(ev.body);
      if (s?.op === "host") return JSON.stringify(stripHost(s));
    }
    return null;
  }

  /**
   * Posts the availability in the seats channel when it changed (coalesced over PUBLISH_MS), so launchers and
   * orchestrators schedule elsewhere while the person uses the machine. The first post is `busy`: a machine that
   * was never busy says nothing.
   */
  private publish(): void {
    if (this.publishTimer || this.closing) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      if (this.closing || !this.allowed) return;
      const a = this.availability();
      const key = JSON.stringify(a);
      if (key === this.published || (this.published === null && a.state === "available")) return;
      const me = this.core.myHandle();
      if (!me || !this.fit(me)) return;
      const body: SeatHost = { op: "host", v: 1, ...a };
      this.post(undefined, hostText(a, this.core.hostname), body as unknown as Record<string, unknown>);
      this.published = key;
    }, PUBLISH_MS);
  }

  // ---- channel ---------------------------------------------------------------------------------

  /**
   * Keeps `seats-<this node>` restricted to this machine's person and the launchers' people (the owners, by
   * default, change over time): created or narrowed through the roster authority. Debounced; one at a time.
   */
  private scheduleReconcile(): void {
    if (!this.allowed || this.closing || this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => { this.reconcileTimer = null; void this.reconcile(); }, 500);
  }

  private async reconcile(force = false): Promise<void> {
    if (this.reconciling) { this.reconcileAgain = true; return this.reconciling; }
    this.reconciling = (async () => {
      try {
        await this.reconcileOnce(force);
      } catch (err) {
        this.channelError = scrub((err as Error).message).slice(0, 300);
        this.log.warn("seats_channel_failed", { err: this.channelError });
      } finally {
        this.reconciling = null;
        if (this.reconcileAgain) { this.reconcileAgain = false; this.scheduleReconcile(); }
      }
    })();
    return this.reconciling;
  }

  /** The seats channel came back shaped but unmarked: when to ask again and the current wait (null: not seen). */
  private unmarked: { next: number; wait: number } | null = null;

  private async reconcileOnce(force: boolean): Promise<void> {
    const me = this.core.myHandle();
    if (!this.allowed || !me || !this.core.teamId) return;
    const want = desiredMembers(this.core.roster, me, this.policy());
    const ch = this.core.roster.channels.get(this.channel);
    // Marked as a seats channel too (PRE4 RC Codex 5): a same-named ordinary channel is re-shaped and marked once.
    if (ch?.members && !ch.archived && ch.seats && sameSet(ch.members, want)) { this.channelError = undefined; this.unmarked = null; return; }
    const key = want.join(",");
    const now = Date.now();
    // Shaped as asked but not marked: an older roster authority dropped the `seats` field (PRE4 delta, Opus 4). No
    // seat runs there (channelFit); the request is repeated only once per backoff window, doubling up to an hour, and
    // logged once.
    if (ch?.members && !ch.archived && !ch.seats && sameSet(ch.members, want) && this.lastRequest?.key === key) {
      if (!this.unmarked) {
        this.unmarked = { next: now + RECONCILE_RETRY_MS, wait: RECONCILE_RETRY_MS };
        this.log.warn("seats_channel_unmarked", { channel: this.channel });
      }
      this.channelError = "the roster authority didn't record this machine's seats channel as one (an older Walkie there?): no seat runs until it is updated";
      if (now < this.unmarked.next) return;
      const wait = Math.min(this.unmarked.wait * 2, UNMARKED_MAX_MS);
      this.unmarked = { next: now + wait, wait };
    } else if (!force && this.lastRequest?.key === key && now - this.lastRequest.at < RECONCILE_RETRY_MS) return;
    this.lastRequest = { key, at: now };
    const body = { name: this.channel, topic: `Seats on ${this.core.hostname}`, members: want, seats: true as const, ...(ch?.archived ? { archived: false } : {}) };
    if (this.core.isAuthority()) {
      this.core.emit("channel.upsert", body);
    } else {
      const res = await submitRequest(this.core, this.deps.client, this.deps.catchUp, "channel.upsert", body);
      if ("queued" in res) { this.channelError = "the roster authority is offline; the seats channel is queued"; return; }
    }
    this.channelError = undefined;
  }

  // ---- requests ----------------------------------------------------------------------------------

  private storedRequests(): Event[] {
    const rows = this.core.store.queryEvents({ channel: this.channel, kinds: ["msg.post"], limit: 500 });
    return rows.map((r) => JSON.parse(r.json) as Event).filter((e) => {
      const s = seatOf(e.body);
      return s?.op === "run" || s?.op === "stop";
    }).reverse();
  }

  private onEvent(ev: Event): void {
    if (this.closing) return;
    if (ev.kind === "channel.upsert" || ev.kind === "team.member" || ev.kind === "team.node") {
      this.checkAdmission();
      this.scheduleReconcile();
      return;
    }
    if (ev.kind !== "msg.post" || ev.channel !== this.channel || this.handled.has(ev.id)) return;
    const me = this.core.myHandle();
    if (!me) return;
    // Judged against the isolation as it is now (a deny file fixed, a home closed), not as at the last launch.
    if (this.current.allow) this.iso = this.evaluate(this.current);
    // A request's age by the node clock that stamps events (the same as Date.now outside tests).
    const ctx = { roster: this.core.roster, node: this.core.nodeId, me, policy: this.policy(), now: this.core.clock(), maxAgeMs: this.maxAge };
    const run = decideRun(ev, ctx);
    const stop = run ? null : decideStop(ev, ctx);
    const d = run ?? stop;
    if (!d) return;
    // Judged once: the decision is on disk before anything is acted on, or nothing is (fail closed).
    if (!this.markHandled(ev)) { this.log.warn("seats_not_acted_on", { id: ev.id, reason: "the request could not be recorded as judged" }); return; }
    if (!d.ok) {
      this.log.info("seats_refused", { id: ev.id, reason: d.reason, from: ev.author.handle });
      if (d.answer && seatOf(ev.body)?.op === "run") this.postState(ev.id, { state: "refused", reason: REASONS[d.reason] ?? d.reason });
      return;
    }
    if ("stop" in d) {
      const seat = this.seats.get(d.stop.seat);
      const q = this.queue.find((x) => x.ev.id === d.stop.seat);
      const queued = !!q;
      // Only the seat's own launcher (the person, from any of their machines or allowed agents) or the host's person
      // may stop it (Opus r2 LOW 4): another launcher can't end someone else's work.
      const owner = seat?.launcher ?? q?.launcher;
      if (owner !== undefined && owner !== d.launcher && !d.hostPerson) {
        this.log.info("seats_stop_refused", { seat: d.stop.seat, by: d.launcher, reason: "not_its_launcher" });
        return;
      }
      this.log.info("seats_stop_requested", { seat: d.stop.seat, by: d.launcher, running: !!seat, queued });
      if (queued) this.dequeue(d.stop.seat, { reason: "stopped", by: d.launcher });
      else if (seat) void this.stopSeat(seat, { reason: "stopped", by: d.launcher });
      return;
    }
    const v2why = isV2(d.run) ? this.v2Refusal(d.run, d.launcher) : null;
    if (v2why) {
      this.log.info("seats_refused", { id: ev.id, reason: v2why.split(":")[0] ?? "v2", from: d.launcher });
      this.postState(ev.id, { state: "refused", reason: v2why });
      return;
    }
    const why = this.admit(d.launcher, d.run);
    if (why === "queue") {
      this.queue = [...this.queue, { ev, run: d.run, launcher: d.launcher, at: Date.now() }];
      this.save();
      this.log.info("seats_queued", { id: ev.id, from: d.launcher, queued: this.queue.length });
      const until = this.busy?.until;
      this.postState(ev.id, { state: "queued", reason: "host busy: its person is using the machine", ...(until !== undefined ? { until } : {}) });
      this.status();
      this.publish();
      return;
    }
    if (why) {
      this.log.info("seats_refused", { id: ev.id, reason: why, from: d.launcher });
      this.postState(ev.id, { state: "refused", reason: why });
      return;
    }
    void this.launch(ev, d.run, d.launcher);
  }

  /**
   * Rate and capacity: launches per minute per launcher (queued ones count); this machine's cap (hostMax, 3 by
   * default) over every seat, the launcher's own cap (max_concurrent) over theirs, so a launcher gets at most
   * min(max_concurrent, hostMax). While the machine is busy, a launch that can't start now (the busy limit, or
   * either cap) is queued instead ("queue"), up to QUEUE_CAP; otherwise it is refused.
   */
  /**
   * What refuses a v2 request here before anything runs (FO-2): Kimi as a seat user (its rotating login can't be
   * handed over), a workspace in a repo this machine has no clone of, an account this machine may not use.
   */
  private v2Refusal(run: SeatRunV2, launcher: string): string | null {
    if (run.runtime === "kimi" && run.permission_mode !== "bypassPermissions") return KIMI_FULL_ACCESS_ONLY;
    if (run.runtime === "kimi" && this.ephemeral) {
      return "kimi seats run only as this machine's person (walkie seats allow --same-user): Kimi's login can't be handed to a seat user";
    }
    if (run.workspace && !this.repos[run.workspace.repo]) {
      return `this machine has no clone of repo ${run.workspace.repo} (walkie seats repo add ${run.workspace.repo} <path>)`;
    }
    if (!run.account) return null;
    const me = this.core.myHandle();
    if (!me) return `${ACCOUNT_NOT_USABLE}: this machine is not in the team`;
    let vault: ReturnType<NonNullable<Core["vault"]>["list"]> = [];
    try { vault = this.core.vault?.list() ?? []; } catch { return `${ACCOUNT_NOT_USABLE}: this machine's vault could not be read`; }
    const plan = planSeatAccount(run.account, { runtime: run.runtime, me, launcher, vault, pooled: this.deps.accounts?.() ?? [], pool: this.poolContext() });
    return plan.kind === "refused" ? plan.why : null;
  }

  /** COMPANY POOL (pre.8 merge): the team's pool as this machine knows it, and each handle's role, for a named account. */
  private poolContext(): PoolContext {
    return { team: this.core.teamPolicy(), roleOf: (h) => this.core.roster.members.get(h)?.role ?? null };
  }

  private admit(launcher: string, run: AnySeatRun): string | null {
    const now = Date.now();
    const recent = (this.launches.get(launcher) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.perMinute) return `rate limited: at most ${this.perMinute} launches per minute per launcher`;
    const today = (this.launchesDay.get(launcher) ?? []).filter((t) => now - t < 86_400_000);
    const perDay = this.opts.launchesPerDay ?? 200;
    if (today.length >= perDay) return `rate limited: at most ${perDay} launches a day per launcher`;
    const mine = [...this.seats.values()].filter((s) => s.launcher === launcher).length;
    const active = this.liveSeats().filter((s) => !s.paused).length;
    const cap = this.capacity();
    const full = this.seats.size >= cap
      ? (cap < this.hostMax ? `this machine is full: ${this.quarantine.size} seat user${this.quarantine.size === 1 ? " is" : "s are"} still being removed` : `this machine is full: ${this.seats.size} of ${this.hostMax} seats running`)
      : mine >= run.max_concurrent ? `at capacity: @${launcher} already runs ${mine} seat${mine === 1 ? "" : "s"} here (max_concurrent ${run.max_concurrent})`
      : null;
    if (this.busy && (full || active >= this.busy.max || this.queue.length)) {
      if (this.queue.length >= QUEUE_CAP) return `the host is busy and ${QUEUE_CAP} launches already wait there; try again later or elsewhere`;
    } else if (full) {
      return full;
    }
    this.launches.set(launcher, [...recent, now]);
    if (this.launches.size > 256) this.launches.delete(this.launches.keys().next().value as string);
    this.launchesDay.set(launcher, [...today, now]);
    if (this.launchesDay.size > 256) this.launchesDay.delete(this.launchesDay.keys().next().value as string);
    this.save();
    return this.busy && (full || active >= this.busy.max || this.queue.length) ? "queue" : null;
  }

  /**
   * Remembers a judged request until it can never be accepted again (its ts + the age limit), plus a day. `force`:
   * requests set aside without being run (at most the 500 stored ones) are remembered even past the cap.
   */
  private remember(ev: Event, force = false): boolean {
    const now = Date.now();
    for (const [id, until] of this.handled) if (until < now) this.handled.delete(id);
    if (this.handled.size >= HANDLED_CAP && !force) return false;
    this.handled.set(ev.id, Math.max(ev.ts, now) + this.maxAge + HANDLED_KEEP_MS);
    return true;
  }

  /** remember() and persist; false (act on nothing) when either fails. */
  private markHandled(ev: Event): boolean {
    if (!this.remember(ev)) { this.log.warn("seats_handled_full", { cap: HANDLED_CAP }); return false; }
    return this.save();
  }

  // ---- running a seat --------------------------------------------------------------------------------

  private async launch(req: Event, run: AnySeatRun, launcher: string): Promise<void> {
    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => { finish = r; });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    const dir = join(this.seatsDir(), `${stamp}-${seatAgentName(req.id).slice(5)}`);
    // Isolation is judged again right before a launch (Codex r3 HIGH 2): config.json or the OS may have changed.
    this.iso = this.evaluate(this.current);
    const unsafe = this.current.allow ? this.iso.problem ?? this.socketProblem() ?? this.core.pool?.seatsConflict() ?? null : "seats are turned off on this machine";
    const seat: Seat = {
      id: req.id, order: ++this.launchOrder, launcher, run, v2: isV2(run) ? newV2(run, req.id) : null, dir, cwd: dir, base: null, startedAt: Date.now(), child: null, runner: null, user: null, userN: null, lost: false, uncontrolled: false, pauseVerified: false, childStarted: null, env: null,
      timer: null, limit: new SeatLimit(run.timeout_s * 1000), paused: false, flushTimer: null, refusal: null,
      buf: [], posts: 0, lastText: "", activity: "", activityKind: null, lastOutputAt: 0, statusTimer: null,
      tail: "", truncated: 0, final: null, stop: null, abort: new AbortController(), concluding: false, done, finish,
    };
    this.seats.set(seat.id, seat);
    this.save();
    this.status();
    this.seatStatus(seat);
    seat.statusTimer = setInterval(() => this.seatStatus(seat), 15_000);
    this.log.info("seats_launch", {
      id: seat.id, launcher, runtime: run.runtime, model: run.model ?? null, mode: run.permission_mode ?? DEFAULT_SEAT_MODE,
      ...(isV2(run) ? { v: 2, workspace: run.workspace?.mode ?? null, account: !!run.account } : { bundle: !!run.bundle }),
    });
    if (unsafe) {
      this.log.warn("seats_not_launched", { id: seat.id, reason: unsafe });
      seat.final = { ok: false, text: `seats are off on this machine: ${unsafe}` };
      await this.conclude(seat, null, "");
      return;
    }
    const ephemeral = this.ephemeral;
    try {
      if (!ephemeral) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const { env, error } = await loginEnv(this.env, this.home, this.envFile, this.current.env ?? [], seat.abort.signal);
      if (error) this.log.warn("seats_env", { err: error });
      seat.env = env;
      this.machineToken = { has: !!env.CLAUDE_CODE_OAUTH_TOKEN?.trim(), at: Date.now() };
      if (seat.v2) await this.prepareV2(seat, seat.v2, env, ephemeral);
      if (seat.stop) { await this.conclude(seat, null, ""); return; }
      if (ephemeral) {
        // Claude on a machine whose login only the Keychain holds: nothing a fresh user could use (Codex r5 LOW 7).
        if (run.runtime === "claude" && !seat.v2?.creds && !this.claudeToken(env)?.trim() && !this.credentialsFile().claude_credentials) {
          throw new Error("this machine's Claude login is in its Keychain, which a seat user can't use: its person gives seats a token (claude setup-token, then walkie seats token set)");
        }
        if (run.runtime === "codex" && !seat.v2?.creds?.codexAuth && !this.codexAuthFile().codex_auth) {
          throw new Error("this machine's Codex isn't signed in where a seat user can use it (no ~/.codex/auth.json): its person runs codex login (file credential store), then walkie seats doctor");
        }
        // A fresh user for this run, never used before and destroyed after it (Codex r5, Opus r5).
        const made = await this.makeSeatUser();
        seat.user = made.name;
        seat.userN = made.n;
        this.save();
        if (seat.stop) { await this.conclude(seat, null, ""); return; }
        // As the seat user, the runner makes the seat's directory (under that user's home) and clones the bundle.
        const bytes = !isV2(run) && run.bundle ? await this.fetchBundle(run.bundle, seat.abort.signal) : null;
        if (seat.stop) { await this.conclude(seat, null, ""); return; }
        await this.spawn(seat, env, bytes);
        return;
      }
      if (seat.v2) {
        await this.v2Workspace(seat, seat.v2, env);
      } else if (!isV2(run) && run.bundle) {
        const bytes = await this.fetchBundle(run.bundle, seat.abort.signal);
        if (seat.stop) { await this.conclude(seat, null, ""); return; }
        const file = join(dir, "input.bundle");
        writeFileSync(file, bytes, { mode: 0o600 });
        const cloned = await cloneBundle(file, dir, env, seat.abort.signal);
        seat.cwd = cloned.repo;
        seat.base = cloned.base;
      } else {
        seat.cwd = join(dir, "work");
        mkdirSync(seat.cwd, { recursive: true, mode: 0o700 });
      }
      if (seat.stop) { await this.conclude(seat, null, ""); return; }
      await this.spawn(seat, env, null);
    } catch (err) {
      if (err instanceof SeatRefusal) seat.refusal = scrub(err.message).slice(0, 280);
      seat.final = { ok: false, text: scrub((err as Error).message) };
      await this.conclude(seat, null, "");
    }
  }

  /**
   * A v2 seat before its directory is used (FO-2): the brief (a blob this channel's request references), the
   * account's credentials (checked again against this machine's vault policy), and, for a seat user, the workspace
   * staged as a bundle of the exact commit (its runner clones it; it can't read the person's clone).
   */
  private async prepareV2(seat: Seat, v: V2Seat, env: Record<string, string>, ephemeral: boolean): Promise<void> {
    const bytes = await this.fetchBundle(v.run.brief, seat.abort.signal, "brief");
    v.brief = briefText(bytes, MAX_SEAT_BRIEF);
    if (v.brief === null) throw new SeatRefusal(`the brief isn't UTF-8 text of at most ${MAX_SEAT_BRIEF / 1000} KB`);
    this.seatStatus(seat);
    const refusal = this.v2Refusal(v.run, seat.launcher); // the vault, the policy and the repos as they are now
    if (refusal) throw new SeatRefusal(refusal);
    if (v.run.account) {
      const me = this.core.myHandle() as string;
      const plan = planSeatAccount(v.run.account, { runtime: v.run.runtime, me, launcher: seat.launcher, vault: this.core.vault?.list() ?? [], pooled: this.deps.accounts?.() ?? [], pool: this.poolContext() });
      if (plan.kind === "refused") throw new SeatRefusal(plan.why);
      try {
        v.creds = await seatCredentials(plan, me, ephemeral, {
          claudeToken: (id) => (this.core.vault as NonNullable<Core["vault"]>).claudeToken(id),
          lease: (id, node, provider) => this.leaseToken(id, node, seatAgentName(seat.id), provider),
          leaseHome: (grant, auth) => {
            sweepLeaseHomes(this.core.paths.home);
            return writeLeaseHome(this.core.paths.home, codexBaseHome(this.core.paths.home, this.env, this.home), grant, auth);
          },
          accessOnlyCodex,
        });
      } catch (err) {
        throw new SeatRefusal(`${ACCOUNT_NOT_USABLE}: ${scrub((err as Error).message).slice(0, 200)}`);
      }
      try {
        v.lease = writeLease(this.core.paths.home, { ...v.creds.lease, pid: process.pid, agent: seatAgentName(seat.id) });
      } catch (err) {
        this.log.warn("seats_lease_failed", { id: seat.id, err: scrub((err as Error).message).slice(0, 200) });
      }
      if (plan.kind === "peer" && plan.pooled) {
        v.cancelReserve = superviseReserve({
          read: () => this.deps.accounts?.().find((a) => a.key === v.run.account && a.provider === plan.provider)?.usage ?? null,
          refresh: async () => {
            const node = this.core.roster.nodes.get(plan.node);
            const addr = node ? this.deps.client.addrOf(node) : null;
            const grant = v.creds?.lease.grant;
            if (!addr || !grant) throw new Error("the lending machine or account grant is unavailable");
            return (await this.deps.client.borrowedUsage(addr, plan.id, grant)).usage;
          },
          stop: () => this.stopSeat(seat, { reason: "reserve" }),
          error: (err) => this.log.warn("seats_reserve_check", { id: seat.id, err: scrub(String(err)).slice(0, 200) }),
          everyMs: this.opts.reserveCheckMs,
        });
      }
      this.log.info("seats_account", { id: seat.id, account: v.creds.lease.account, from_node: v.creds.lease.from_node ?? null });
    }
    const ws = v.run.workspace;
    if (!ephemeral || !ws) return;
    const got = await this.resolveWorkspace(seat, v, ws, env);
    v.staged = await stageBundle(got.clone, got.sha, stageDir(this.core.paths.home), `in-${randomUUID().replace(/-/g, "")}.bundle`, RUNNER_MAX_STAGED, env, seat.abort.signal);
    v.branch = ws.mode === "branch" ? ws.branch ?? `lane/${v.run.label}` : null;
    seat.base = got.sha;
  }

  /** The host's clone for a v2 workspace, with the delta bundle (fetched like v1's bundle) in it and the ref resolved. */
  private async resolveWorkspace(seat: Seat, v: V2Seat, ws: NonNullable<SeatRunV2["workspace"]>, env: Record<string, string>): Promise<{ clone: string; sha: string }> {
    let delta: string | null = null;
    let tmp: string | null = null;
    try {
      if (ws.bundle) {
        const bytes = await this.fetchBundle(ws.bundle, seat.abort.signal, "workspace delta bundle");
        tmp = mkdtempSync(join(tmpdir(), "walkie-seat-delta-"));
        delta = join(tmp, "delta.bundle");
        writeFileSync(delta, bytes, { mode: 0o600 });
      }
      const got = await resolveRepo(this.repos, ws, delta, v.tag, env, seat.abort.signal, join(this.core.paths.home, "seats-mirror"));
      v.clone = got.clone;
      return got;
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** A same-user v2 seat's working directory: a worktree of the host's clone, a fresh copy of it, or a fresh dir. */
  private async v2Workspace(seat: Seat, v: V2Seat, env: Record<string, string>): Promise<void> {
    const ws = v.run.workspace;
    if (!ws) {
      seat.cwd = join(seat.dir, "work");
      mkdirSync(seat.cwd, { recursive: true, mode: 0o700 });
    } else {
      // The lane's worktree is claimed before the first await: two launches of one label never both get it.
      const claimed = this.repos[ws.repo] ?? null;
      if (ws.mode !== "fresh" && claimed && this.labelBusy(seat, v.run.label as string, claimed)) {
        throw new SeatRefusal(`lane ${v.run.label} already runs in this machine's clone`);
      }
      v.clone = claimed;
      const got = await this.resolveWorkspace(seat, v, ws, env);
      if (seat.stop) return;
      if (ws.mode === "fresh") {
        seat.cwd = (await freshClone(got.clone, got.sha, seat.dir, v.tag, env, seat.abort.signal)).cwd;
      } else {
        const wt = await addWorktree(got.clone, v.run.label as string, ws.mode, got.sha, ws.branch, env, seat.abort.signal);
        seat.cwd = wt.cwd;
        v.dirs = wt.dirs;
        v.branch = wt.branch ?? null;
      }
      seat.base = got.sha;
      await dropInRefs(got.clone, v.tag, env).catch(() => undefined);
    }
    // The cleanup intent is on disk (durably) before the brief is (FO-2 r2 MED 2): a crash at any point leaves a record
    // the next start acts on; removal is by the brief's hash, so nothing else of that name is ever touched.
    v.task = await planTask(seat.cwd, v.brief as string, env, seat.abort.signal);
    if (!this.save(true)) {
      v.task = null;
      throw new SeatRefusal("seats.json could not be written, so the brief isn't written either (check the Walkie home's disk and permissions)");
    }
    v.task = await placeTask(seat.cwd, v.brief as string, v.task, env, seat.abort.signal); // on failure: v.task stays the plan; endV2 cleans
  }

  /** Another live seat here works in the same clone's `.worktrees/<label>`. */
  private labelBusy(seat: Seat, label: string, clone: string): boolean {
    return [...this.seats.values()].some((s) => s !== seat && s.v2?.clone === clone && s.v2.run.label === label && !!s.v2.run.workspace && s.v2.run.workspace.mode !== "fresh");
  }

  /** A login handed out by the owner's machine for this seat (vault-lease.ts; never stored): a Claude setup-token or an access-only Codex auth.json. */
  private async leaseToken(id: string, node: string, agent: string, provider: "claude" | "codex"): Promise<{ token?: string; codex_auth?: string; grant: string }> {
    const client = this.deps.client as SeatsDeps["client"] & { addrOf?: (n: NodeRec) => PeerAddr | null; vaultLease?: PeerClient["vaultLease"] };
    const r = await requestLease(this.core, (_addr, body, n) => {
      const addr = client.addrOf ? client.addrOf(n) : { ip: n.ip, port: n.port };
      if (!addr) throw new Error("the owner's machine can't be reached from this machine");
      return this.deps.client.vaultLease(addr, body);
    }, { account: id, node, agent: agent.slice(0, 48), ...(provider === "codex" ? { provider } : {}) });
    return { ...(r.token ? { token: r.token } : {}), ...(r.codex_auth ? { codex_auth: r.codex_auth } : {}), grant: r.grant };
  }

  /** The launcher's repo bundle, from this store or an online teammate; a stop (`signal`) ends the search at once. */
  private async fetchBundle(hash: string, signal: AbortSignal, what = "repo bundle"): Promise<Uint8Array> {
    const channel = this.channel;
    const r = this.core.roster;
    const shared = this.core.store.blobRefRows(hash).some((s) => s.channel === channel);
    if (!shared) throw new Error(`the ${what} was not shared in this machine's seats channel`);
    const local = readBlob(this.core.paths.blobs, hash);
    if (local && blobServable(r, this.core.store, hash, channel, this.core.myHandle())) return local;
    const stopped = new Promise<null>((res) => {
      if (signal.aborted) res(null);
      signal.addEventListener("abort", () => res(null), { once: true });
    });
    // Where each peer is reached: the client's own choice of transport when it has one (Walkie Direct: the node's key,
    // not an ip:port, for a Direct-only host), else its tailnet address. Never a transport-specific guess here.
    const client = this.deps.client as SeatsDeps["client"] & { addrOf?: (n: NodeRec) => PeerAddr | null };
    for (const n of activeNodes(r)) {
      if (n.node_id === this.core.nodeId) continue;
      if (signal.aborted) throw new Error("stopped");
      const addr = client.addrOf ? client.addrOf(n) : { ip: n.ip, port: n.port };
      if (!addr) continue;
      const got = await Promise.race([this.deps.client.blob(addr, hash, channel, MAX_BLOB_BYTES).catch(() => null), stopped]);
      if (signal.aborted) throw new Error("stopped");
      if (!got || sha256Hex(got) !== hash) continue;
      writeBlob(this.core.paths.blobs, got);
      this.core.store.addProvenance(channel, hash);
      return got;
    }
    throw new Error(`the ${what} is not available from any online teammate`);
  }

  /** `bundle`: set (or null without a repo) when the seat runs as the seat user; undefined: as the daemon's user. */
  private async spawn(seat: Seat, base: Record<string, string>, bundle: Uint8Array | null | undefined): Promise<void> {
    const run = seat.run;
    // Seat users run the root-owned copies setup-user installed (a closed home hides the person's own installs).
    const bin = this.runtimeFor(seat, run.runtime, base);
    // Never this daemon's own socket or home: a seat's Walkie calls go to the seats' socket with a credential for
    // this seat only, which speaks as `seat-<id>` whatever the caller sends and can only post in its own thread. The
    // credential is a 0600 file in the seat's directory, named by WALKIE_SEAT_TOKEN_FILE: never in an environment,
    // where `ps -E` would show it to the machine's other processes (Opus r2 LOW 2).
    // A v2 seat's account (FO-2): its credentials replace the machine's default login for this run only.
    const env = withBinDir({ ...base, ...(seat.v2?.creds?.env ?? {}), WALKIE_AGENT: seatAgentName(seat.id) }, bin);
    const mode = run.permission_mode ?? DEFAULT_SEAT_MODE;
    // v2: the brief is TASK.md in the work tree; the prompt is only the fixed pointer to it (never the brief).
    const text = seat.v2 ? (seat.v2.task?.prompt ?? SEAT_TASK_PROMPT) : (run as SeatRun).prompt;
    let args: string[];
    let parse: (line: string) => SeatSignal[] | null;
    if (run.runtime === "kimi") {
      args = kimiSeatArgs({ prompt: text, ...(run.model ? { model: run.model } : {}) });
      parse = kimiSeatLine;
    } else if (run.runtime === "claude") {
      // A seat user's seat asks its runtime itself, as that user (the runner's probe): the daemon never runs a
      // binary a seat user could have written (Codex r4 MEDIUM 5).
      if (!seat.user && this.permissionPrompts === null) {
        const supported = await supportsPermissionPrompts(bin, env, seat.abort.signal);
        if (seat.abort.signal.aborted) { await this.conclude(seat, null, ""); return; }
        this.permissionPrompts = supported;
      }
      args = claudeSeatArgs({
        session: randomUUID(), mode, ...(run.model ? { model: run.model } : {}), permissionPrompts: !seat.user && this.permissionPrompts === true,
        systemPrompt: seatSystemPrompt(seat.launcher, this.core.hostname),
      });
      parse = (line) => claudeSeatParser(seat.cwd)(line); // the seat user's directory is known once it runs
    } else {
      args = codexSeatArgs({ cwd: seat.user ? "{cwd}" : seat.cwd, mode, ...(run.model ? { model: run.model } : {}) });
      parse = codexSeatLine;
    }
    if (seat.stop || this.closing) { await this.conclude(seat, null, ""); return; }
    // Still an admitted, non-observer member at the last moment (Codex r2 HIGH 1): a host demoted while this seat
    // prepared starts nothing.
    const me = this.core.me();
    if (!me || me.role === "observer") throw new Error("the host machine is no longer an admitted member of the team");
    // Kimi takes its (fixed) prompt on argv and nothing on stdin.
    const prompt = run.runtime === "claude" ? userMessage(text) : run.runtime === "kimi" ? "" : text;
    if (seat.user) { await this.spawnAsUser(seat, seat.user, bin, args, env, parse, bundle ?? null, prompt); return; }
    const tokenFile = join(seat.dir, SEAT_TOKEN_FILE);
    writeFileSync(tokenFile, this.api.issue(seat.id), { mode: 0o600 });
    const childEnv = { ...env, WALKIE_SOCKET: this.api.socket, WALKIE_SEAT_TOKEN_FILE: tokenFile };
    const child = new ClaudeChild<SeatSignal[]>(bin, args, seat.cwd, childEnv, {
      onSignal: (sigs) => { for (const s of sigs) this.onSignal(seat, s); },
      onExit: (code, stderr) => { void this.conclude(seat, code, stderr); },
    }, parse);
    seat.child = child;
    const reap = child.reaped;
    this.reaping.add(reap);
    void reap.then(() => this.reaping.delete(reap));
    // The prompt is data for the child's stdin: one stream-json user message (Claude) or the raw text (Codex).
    child.write(prompt);
    child.endInput();
    seat.childStarted = processStart(child.pid);
    this.save();
    this.log.info("seats_spawned", { id: seat.id, pid: child.pid, runtime: run.runtime, paused: seat.paused });
    // Paused while it was preparing (the person became busy meanwhile): it starts stopped, its limit not running.
    if (seat.paused) { this.signal(seat, "SIGSTOP"); return; }
    this.armLimit(seat);
    this.postState(seat.id, { state: "running", dir: this.shownDir(seat), ...(seat.v2?.branch ? { reason: `on branch ${seat.v2.branch}` } : {}) });
  }

  /**
   * The seat as the seat user (PROTOCOL §11 "Seat user"): the runner (through sudo) makes its directory under that
   * user's home, clones the bundle, runs the runtime in its own group and reports back; the daemon controls the
   * group through it. Nothing of the daemon's home, socket or token is reachable from there.
   */
  private async spawnAsUser(
    seat: Seat, user: string, bin: string, args: string[], env: Record<string, string>, parse: (line: string) => SeatSignal[] | null,
    bundle: Uint8Array | null, prompt: string,
  ): Promise<void> {
    const v = seat.v2;
    // A v2 seat's account (FO-2) wins over the dedicated seats token and the machine's own files.
    const account = v?.creds ?? null;
    const runner = new RunnerChild<SeatSignal[]>(this.userArgv(user), {
      rv: v ? RUNNER_PROTOCOL_V2 : RUNNER_PROTOCOL, dir_name: basename(seat.dir), bin, args, env: account ? env : this.withClaudeLogin(env, seat.run.runtime), token: this.api.issue(seat.id), socket: this.api.socket,
      ...(seat.run.runtime === "claude" ? { probe_permission_prompts: true } : {}),
      ...(seat.run.runtime === "claude" && !account && !this.claudeToken(env) ? this.credentialsFile() : {}),
      ...(seat.run.runtime === "codex" ? (account?.codexAuth ? { codex_auth: account.codexAuth } : account ? {} : this.codexAuthFile()) : {}),
      ...(v ? {
        task: v.brief as string, ...(v.branch ? { branch: v.branch } : {}),
        ...(v.run.result_file ? { result_file: v.run.result_file } : {}),
      } : {}),
    }, v?.staged ? { file: v.staged.path, size: v.staged.size } : bundle, prompt, (sigs) => { for (const s of sigs) this.onSignal(seat, s); }, parse);
    seat.runner = runner;
    const onAbort = () => runner.control("abort");
    if (seat.abort.signal.aborted) onAbort(); else seat.abort.signal.addEventListener("abort", onAbort, { once: true });
    const reap = runner.done.then(() => undefined);
    this.reaping.add(reap);
    void reap.then(() => this.reaping.delete(reap));
    void runner.done.then(async () => {
      const code = await runner.exited;
      if (runner.lost) seat.lost = true; // it ended without reporting the runtime's exit: nothing it said counts
      else if (runner.error && !seat.final) seat.final = { ok: false, text: runner.error };
      void this.conclude(seat, code, runner.diagnostic);
    });
    const ready = await runner.ready;
    if (!ready) return; // the runner failed or was stopped first: conclude() reports it once it is gone
    seat.dir = ready.dir;
    seat.cwd = ready.cwd;
    seat.base = ready.base;
    this.save();
    this.log.info("seats_spawned", { id: seat.id, runner: runner.pid, pid: ready.pid, user, runtime: seat.run.runtime, paused: seat.paused });
    if (seat.stop) return; // stopSeat() is ending it
    if (seat.paused) { this.confirmPause(seat); return; }
    this.armLimit(seat);
    this.postState(seat.id, { state: "running", dir: this.shownDir(seat), ...(seat.v2?.branch ? { reason: `on branch ${seat.v2.branch}` } : {}) });
  }

  /**
   * The runtime a seat runs. A seat user's: the root-owned copy in runtime_dir, checked like the runner before every
   * launch; in a release build never a fallback to the person's PATH (Opus r4 LOW 5). Otherwise the first on PATH.
   */
  private runtimeFor(seat: Seat, runtime: SeatRuntime, base: Record<string, string>): string {
    if (seat.user && this.current.runtime_dir) {
      const own = join(this.current.runtime_dir, runtime);
      if (RELEASE_BUILD) {
        const why = runtimeCopyProblem(own, { acl: listAcl, platform: process.platform });
        if (why) throw new Error(`the seat users' ${runtime} can't be used: ${why} (walkie seats setup-user --apply installs it)`);
        return own;
      }
      if (existsSync(own)) return own;
    } else if (seat.user && RELEASE_BUILD) {
      throw new Error("no runtimes are installed for the seat users: walkie seats setup-user --apply");
    }
    const bin = findRuntime(runtime, base.PATH, this.home, base.CODEX_HOME);
    if (!bin) throw new Error(`${runtime} was not found on this machine (install it and sign in)`);
    return bin;
  }

  /** `walkie seats token set`: a Claude token only seats use (optional; the machine's own login otherwise). */
  private get seatTokenPath(): string { return join(this.core.paths.home, "seats-claude-token"); }

  private dedicatedToken(): string | null {
    try { return readFileSync(this.seatTokenPath, "utf8").trim() || null; } catch { return null; }
  }

  /** The Claude token a seat's environment carries: the dedicated one, else the machine's own (env or the seat env file). */
  private claudeToken(env: Record<string, string>): string | null {
    return this.dedicatedToken() ?? env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
  }

  /** The seat's environment with its Claude token (the dedicated one overrides the machine's own). */
  private withClaudeLogin(env: Record<string, string>, runtime: SeatRuntime): Record<string, string> {
    const dedicated = runtime === "claude" ? this.dedicatedToken() : null;
    return dedicated ? { ...env, CLAUDE_CODE_OAUTH_TOKEN: dedicated } : env;
  }

  /**
   * Without a token in the environment: the machine's own Claude Code login file (`~/.claude/.credentials.json`, as
   * on Linux), handed to this run only; the runner writes it 0600 into the run's fresh config, removed with the user's home.
   */
  private credentialsFile(): { claude_credentials?: string } {
    const file = join(this.env.CLAUDE_CONFIG_DIR ?? join(this.home, ".claude"), ".credentials.json");
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 64 * 1024) return {};
      const copy = accessOnlyClaude(readFileSync(file, "utf8"), Date.now());
      return copy ? { claude_credentials: copy } : {};
    } catch {
      return {};
    }
  }

  /**
   * The machine's own Codex sign-in (`$CODEX_HOME/auth.json`, else `~/.codex/auth.json`), handed to a seat user's run
   * only, like the Claude credentials file; absent when Codex keeps it elsewhere (a keyring) or isn't signed in.
   */
  private codexAuthFile(): { codex_auth?: string } {
    const file = join(this.env.CODEX_HOME ?? join(this.home, ".codex"), "auth.json");
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 64 * 1024) return {};
      const copy = accessOnlyCodex(readFileSync(file, "utf8"));
      return copy ? { codex_auth: copy } : {};
    } catch {
      return {};
    }
  }

  /** Whether Codex seats have a sign-in: as the person, whatever their Codex uses; as seat users, the auth file. */
  codexLogin(): "machine" | "unavailable" {
    if (!this.current.ephemeral) return "machine";
    return this.codexAuthFile().codex_auth ? "machine" : "unavailable";
  }

  claudeLogin(): "dedicated" | "machine" | "unavailable" {
    if (this.dedicatedToken()) return "dedicated";
    if (!this.current.ephemeral) return "machine";
    if (!this.machineToken || Date.now() - this.machineToken.at > 30_000) void this.refreshLogin();
    if (this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || this.machineToken?.has || this.credentialsFile().claude_credentials) return "machine";
    return "unavailable";
  }

  /** Sources the seats' environment (as a launch does) to learn whether it carries a usable Claude token. */
  refreshLogin(): Promise<void> {
    this.refreshingLogin ??= loginEnv(this.env, this.home, this.envFile, this.current.env ?? [])
      .then(({ env }) => { this.machineToken = { has: !!env.CLAUDE_CODE_OAUTH_TOKEN?.trim(), at: Date.now() }; })
      .catch(() => { this.machineToken = { has: false, at: Date.now() }; })
      .finally(() => { this.refreshingLogin = null; });
    return this.refreshingLogin;
  }

  /** Sets (or, with null, clears) the dedicated seat token. The machine's person only (route). */
  async setSeatToken(token: string | null): Promise<void> {
    if (token === null) rmSync(this.seatTokenPath, { force: true });
    else writeFileSync(this.seatTokenPath, `${token}\n`, { mode: 0o600 });
    await this.refreshLogin();
  }

  /** The seat's directory as posted: home-relative, `~<seat user>/…` when it runs as the seat user. */
  private shownDir(seat: Seat): string {
    if (!seat.user) return homeRelative(seat.cwd);
    const i = seat.cwd.indexOf("/walkie-seats/");
    return i >= 0 ? `~${seat.user}${seat.cwd.slice(i)}` : seat.cwd;
  }

  private onSignal(seat: Seat, s: SeatSignal): void {
    if (this.closing || this.closed || seat.concluding) return;
    if (s.kind === "final") { seat.final = { ok: s.ok, text: s.text }; return; }
    const text = s.kind === "tool" ? `⚙ ${scrub(s.text).replace(/\s+/g, " ").slice(0, 200)}` : s.text;
    if (s.kind === "text") seat.lastText = s.text;
    seat.activity = scrub(s.text).trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";
    seat.activityKind = s.kind === "tool" ? "tool" : "reply";
    seat.lastOutputAt = Date.now();
    this.seatStatus(seat);
    seat.buf.push(text);
    const size = seat.buf.reduce((n, t) => n + t.length, 0);
    if (size >= FLUSH_AT_CHARS) { this.flush(seat); return; }
    if (!seat.flushTimer) seat.flushTimer = setTimeout(() => { seat.flushTimer = null; this.flush(seat); }, this.flushMs);
  }

  /** Posts the buffered output (scrubbed); past the post cap only the tail is kept for the final post. */
  private flush(seat: Seat, final = false): void {
    if (seat.flushTimer) clearTimeout(seat.flushTimer);
    seat.flushTimer = null;
    if (!seat.buf.length) return;
    const text = scrub(seat.buf.join("\n\n"));
    seat.buf = [];
    if (seat.posts >= this.maxPosts && !final) {
      seat.truncated += 1;
      seat.tail = (seat.tail + "\n\n" + text).slice(-TAIL_CHARS);
      return;
    }
    let body = text;
    if (final && seat.truncated) {
      body = `_(${seat.truncated} output update${seat.truncated === 1 ? "" : "s"} not posted; the end of the output:)_\n\n${(seat.tail + "\n\n" + text).slice(-TAIL_CHARS)}`;
    }
    for (let i = 0; i < body.length; i += OUTPUT_CHUNK) {
      seat.posts += 1;
      this.post(seat.id, body.slice(i, i + OUTPUT_CHUNK), { op: "output", v: 1, seat: seat.id, n: seat.posts, ...(final ? { final: true } : {}) });
    }
  }

  /**
   * Ends a seat in whatever phase it is: preparing (the env or clone is aborted), running (its process group:
   * SIGTERM, then SIGKILL) or concluding (its post-run git is aborted). Resolves once conclude() has posted its state.
   */
  private async stopSeat(seat: Seat, stop: NonNullable<Seat["stop"]>): Promise<void> {
    if (!seat.stop) seat.stop = stop;
    // Preparing: abort it. Running: a launcher's stop or the time limit ends the group and the commits still come back;
    // a revoke or shutdown aborts everything, the post-run git included (no result bundle).
    if (stop.reason === "revoked" || stop.reason === "shutdown" || stop.reason === "unadmitted" || stop.local || (!seat.child && !seat.runner?.runtimePid)) seat.abort.abort();
    this.log.info("seats_stopping", { id: seat.id, reason: stop.reason, by: stop.by ?? null, paused: seat.paused });
    // A paused group can't act on SIGTERM: it continues first, so it can exit (then the usual TERM, then KILL).
    if (seat.paused) { this.signal(seat, "SIGCONT"); seat.paused = false; }
    if (seat.child) await seat.child.close(0);
    else if (seat.runner) {
      await seat.runner.close(); // the runtime's group through its runner: the post-run git still runs for a stop
      // Then everything of its user, whatever it did to its runner or its group: the user is destroyed.
      if (seat.userN !== null && !(await this.destroyUser(seat.userN)).ok) seat.uncontrolled = true;
    }
    await seat.done;
  }

  private async stopAll(reason: "revoked" | "shutdown" | "unadmitted"): Promise<void> {
    for (const q of [...this.queue]) this.dequeue(q.ev.id, { reason });
    await Promise.all([...this.seats.values()].map((s) => this.stopSeat(s, { reason })));
  }

  /** This machine stopped being an admitted, non-observer member (removed, revoked, demoted): its seats end now. */
  private checkAdmission(): void {
    const me = this.core.me();
    if ((!this.seats.size && !this.queue.length) || (me && me.role !== "observer")) return;
    this.log.warn("seats_host_unadmitted", { running: this.seats.size, role: me?.role ?? null });
    void this.stopAll("unadmitted");
  }

  /**
   * The seat is over (or never started): output, commits (as a bundle artifact), and its final state. The seat
   * stays tracked until all of that is done, so a stop, revoke or shutdown meanwhile waits for it (and aborts its
   * git); nothing of the seat's process group is left when its repository is read.
   */
  private async conclude(seat: Seat, code: number | null, stderr: string): Promise<void> {
    if (seat.concluding || !this.seats.has(seat.id)) return;
    seat.concluding = true;
    if (seat.statusTimer) clearInterval(seat.statusTimer);
    seat.statusTimer = null;
    this.api.revoke(seat.id);
    if (seat.timer) clearTimeout(seat.timer);
    if (seat.child) {
      await Bun.sleep(30); // the last stdout lines are read after the exit is reported
      await seat.child.reaped; // what the seat's tools left in its group is gone (SIGTERM, then SIGKILL)
    }
    if (seat.runner) {
      await seat.runner.done; // the runner reaped the group and sent its outcome before it exited
    }
    // The seat's user is destroyed (every process, service, schedule and file of it), verified; unverified, it is
    // quarantined (never reused anyway) and the seat says so rather than "stopped".
    if (seat.userN !== null && !(await this.destroyUser(seat.userN)).ok) seat.uncontrolled = true;
    try {
      // Kimi (text output) says nothing when it is done: its clean exit is its result.
      if (seat.run.runtime === "kimi" && !seat.final && code === 0) seat.final = { ok: true, text: "" };
      const fin = seat.final;
      if (fin?.text.trim() && fin.ok && fin.text.trim() !== seat.lastText.trim()) seat.buf.push(fin.text);
      this.flush(seat, true);
      let outcome: Awaited<ReturnType<typeof seatOutcome>> = null;
      let bundle: string | undefined;
      const v = seat.v2;
      if (v?.dirs && seat.child) v.resultHead = readHead(v.dirs.gitDir, v.dirs.commonDir); // the seat's own last commit
      // v2: the result file (done, failed, stopped or timed out, and a stop by this machine's person too: a plain
      // file read, no git), then the brief leaves the tree.
      if (v && seat.child && !this.closing) {
        if (v.run.result_file) v.result = readResultFile(seat.cwd, v.run.result_file);
        removeTask(seat.cwd, v.task);
      }
      let briefCommitted = false;
      if (!this.closing && !seat.abort.signal.aborted && seat.env && seat.child) {
        outcome = await seatOutcome(seat.cwd, seat.base, join(seat.dir, "result.bundle"), seat.env, seat.abort.signal, undefined, v?.dirs ?? undefined, v?.task?.file).catch(() => null);
        briefCommitted = outcome?.brief === true;
        if (outcome?.bundle) bundle = this.shareBundle(seat, readFile(outcome.bundle));
      } else if (!this.closing && seat.runner && !seat.lost) {
        const o = await seat.runner.outcome; // computed by the runner, as the seat user (after an abort: the file only)
        const aborted = seat.abort.signal.aborted || o?.aborted === true;
        outcome = o && !aborted ? { commits: o.commits, dirty: o.dirty } : null;
        briefCommitted = o?.brief === true;
        if (o?.bundle && !aborted) bundle = this.shareBundle(seat, o.bundle);
        if (v?.run.result_file) v.result = o?.file ? { bytes: o.file } : { error: o?.file_error ?? "not returned by the seat's runner" };
      }
      if (briefCommitted) this.log.warn("seats_brief_committed", { id: seat.id });
      const file = v?.result && "bytes" in v.result ? this.shareResultFile(seat, v.run.result_file as string, v.result.bytes) : undefined;
      const fileError = v?.run.result_file && !file ? (v.result && "error" in v.result ? v.result.error : v.result ? "could not be shared" : "the seat didn't run") : undefined;
      if (!seat.user) rmSync(join(seat.dir, SEAT_TOKEN_FILE), { force: true });
      await this.endV2(seat); // before the state post: whoever reads "done" finds the clone and the lease as they end up
      const state = this.finalState(seat, code, stderr);
      this.seatStatus(seat, state.reason ?? (state.state === "done" ? "Seat finished" : `Seat ${state.state}`));
      this.postState(seat.id, {
        ...state, ...(briefCommitted ? { reason: `${state.reason ? `${state.reason} · ` : ""}its commits carry the brief file, so they were not returned` } : {}),
        dir: this.shownDir(seat), exit_code: code,
        ...(outcome ? { commits: outcome.commits, dirty: outcome.dirty } : {}), ...(bundle ? { bundle } : {}),
        ...(file ? { file } : {}), ...(fileError && state.state !== "refused" ? { file_error: fileError } : {}),
      });
      this.log.info("seats_ended", { id: seat.id, state: state.state, code, commits: outcome?.commits ?? 0 });
    } catch (err) {
      this.log.warn("seats_conclude_failed", { id: seat.id, err: scrub((err as Error).message) });
      this.seatStatus(seat, seat.stop?.reason ?? "the seat ended");
    } finally {
      await this.endV2(seat); // idempotent (a throw above skipped it)
      this.seats.delete(seat.id);
      this.save();
      this.status();
      seat.finish();
      this.rebalance(); // a freed seat: a paused one continues or a queued one starts, within the limits
    }
  }

  /** A v2 seat's leftovers: its router lease, a staged bundle, the delta bundle's private refs in the clone. */
  private async endV2(seat: Seat): Promise<void> {
    const v = seat.v2;
    if (!v) return;
    v.cancelReserve?.();
    v.cancelReserve = undefined;
    if (v.lease) { releaseLease(this.core.paths.home, v.lease); v.lease = null; }
    if (v.staged) { rmSync(v.staged.path, { force: true }); v.staged = null; }
    // The brief never outlives its seat in the person's tree, however the seat ended (FO-2 r1 MEDIUM 4).
    if (v.task && !seat.user) removeTask(seat.cwd, v.task);
    if (v.clone && seat.env) await dropInRefs(v.clone, v.tag, seat.env).catch(() => undefined);
    // A same-user lane: Walkie's ownership record follows the branch to where the seat left it.
    // (Only the seat's own result, read from the worktree's git directory as the seat ended: FO-2 r3 LOW 3.)
    if (v.clone && v.dirs && v.branch && seat.env && seat.base) {
      const head = v.resultHead ?? null;
      if (head) await recordLaneTip(v.clone, v.branch, seat.env, { base: seat.base, head }).catch(() => undefined);
    }
    v.clone = null;
    // The brief's exclude line leaves the clone with the last seat whose brief it hides.
    const ex = v.task?.exclude;
    if (ex && ![...this.seats.values()].some((x) => x !== seat && x.v2?.task?.exclude === ex && x.v2.task.file === v.task?.file)) releaseExclude(v.task);
    v.task = null;
    // A same-user seat's leased Codex home (COMPANY POOL) goes with the run; a crash leaves it to sweepLeaseHomes.
    if (v.creds?.leaseHome) {
      try { removeLeaseHome(v.creds.leaseHome, this.core.paths.home); } catch (err) { this.log.warn("seats_lease_home", { id: seat.id, err: scrub((err as Error).message).slice(0, 200) }); }
    }
    v.creds = null; // the account's token is held no longer than the run
  }

  /** The seat's result file as an artifact in its thread (scrubbed already by readResultFile / the runner). */
  private shareResultFile(seat: Seat, rel: string, bytes: Uint8Array): string | undefined {
    const me = this.core.myHandle();
    if (!me || !this.fit(me)) return undefined;
    const hash = writeBlob(this.core.paths.blobs, bytes);
    const name = `${seatAgentName(seat.id)}-${basename(rel)}`;
    const mime = rel.endsWith(".json") ? "application/json" : "text/plain";
    this.core.store.addBlob(hash, bytes.byteLength, mime, name);
    this.core.emit("artifact.share", {
      hash, name, size: bytes.byteLength, mime, note: `The seat's result file (${rel})`, thread: seat.id,
    }, { channel: this.channel, agent: SEATS_AGENT });
    this.core.store.addProvenance(this.channel, hash);
    return hash;
  }

  private finalState(seat: Seat, code: number | null, stderr: string): Pick<SeatState, "state" | "reason"> {
    if (seat.refusal) return { state: "refused", reason: seat.refusal };
    if (seat.uncontrolled) {
      return { state: "stopped", reason: "Walkie could not verify that its seat user was removed: its processes or files may remain (the seat user is quarantined)" };
    }
    if (seat.stop) return stopText(seat.stop, seat.run);
    if (seat.lost) return { state: "stopped", reason: "Walkie lost control of the seat (its runner ended before it did); every process of its seat user was stopped" };
    if (seat.final?.ok && code === 0) return { state: "done" };
    const tail = scrub(stderr).trim().split("\n").slice(-1)[0] ?? "";
    const why = !seat.final?.ok && seat.final?.text ? seat.final.text : tail || (code === null ? "did not start" : `exit code ${code}`);
    return { state: "failed", reason: failureReason(why) };
  }

  private shareBundle(seat: Seat, bytes: Uint8Array): string | undefined {
    if (bytes.byteLength > MAX_BLOB_BYTES) { this.log.warn("seats_bundle_too_large", { id: seat.id, size: bytes.byteLength }); return undefined; }
    const me = this.core.myHandle();
    if (!me || !this.fit(me)) return undefined;
    const hash = writeBlob(this.core.paths.blobs, bytes);
    const name = `${seatAgentName(seat.id)}.bundle`;
    this.core.store.addBlob(hash, bytes.byteLength, "application/x-git-bundle", name);
    this.core.emit("artifact.share", {
      hash, name, size: bytes.byteLength, mime: "application/x-git-bundle", note: "The seat's commits (git fetch <file> HEAD)", thread: seat.id,
    }, { channel: this.channel, agent: SEATS_AGENT });
    this.core.store.addProvenance(this.channel, hash);
    return hash;
  }

  // ---- posting + status ----------------------------------------------------------------------------

  /** A daemon restart ends persisted seats after their leftover processes have been handled. */
  private endSavedSeatCard(id: string): void {
    if (!this.core.teamId || !this.core.me()) return;
    const agent = seatAgentName(id);
    try {
      const row = this.core.store.agent(this.core.nodeId, agent);
      const previous = row ? JSON.parse(row.body) as BodyOf<"agent.status"> : null;
      const { observed_at: _observed, ...fields } = previous ?? {};
      this.core.statuses.submitFinal(agent, {
        ...fields, agent, parent: SEATS_AGENT, state: "offline", runtime: previous?.runtime ?? "other",
        activity: "the host's Walkie daemon restarted while the seat ran",
      }, { activity: "notification" });
    } catch (err) {
      this.log.warn("seats_status_failed", { id, err: scrub((err as Error).message) });
    }
  }

  /** The host signs each seat's status; periodic refresh turns quiet output idle. */
  private seatStatus(seat: Seat, endReason?: string): void {
    if (this.closed || (this.closing && !endReason) || !this.core.teamId || !this.core.me()) return;
    const brief = isV2(seat.run) ? seat.v2?.brief : seat.run.prompt;
    const title = brief?.split(/\r?\n/)[0]?.trim().slice(0, 200) || undefined;
    const active = !seat.paused && seat.lastOutputAt > 0 && Date.now() - seat.lastOutputAt < 30_000;
    const state = endReason ? "offline" : active ? "working" : "idle";
    const activity = endReason ?? (seat.paused ? "Seat paused" : isV2(seat.run) ? "Seat running" : seat.activity || "Seat running");
    const provenance: StatusProvenance = {
      ...(title ? { title: "prompt" } : {}),
      activity: endReason ? "notification" : isV2(seat.run) ? "phrase" : seat.activityKind ?? "phrase",
    };
    try {
      this.seatStatuses.submit(seatAgentName(seat.id), {
        agent: seatAgentName(seat.id), parent: SEATS_AGENT, launcher: seat.launcher, state,
        runtime: seat.run.runtime === "claude" ? "claude-code" : seat.run.runtime,
        ...(seat.run.model ? { model: seat.run.model } : {}),
        ...(title ? { title } : {}), activity, started_at: seat.startedAt, ask_policy: "off", launch: "headless",
      }, provenance);
    } catch (err) {
      this.log.warn("seats_status_failed", { id: seat.id, err: scrub((err as Error).message) });
    }
  }

  /**
   * A running seat's own post (the seats' socket, seat-api.ts): always as `seat-<id>`, only in this machine's seats
   * channel, only in the seat's own thread, scrubbed, rate-limited, and only while the channel is fit.
   */
  postAsSeat(seatId: string, body: { channel: string; text: string; thread?: string }): Event {
    const seat = this.seats.get(seatId);
    // Concluding: its token is revoked and its result is being read; a request authenticated before that posts nothing.
    if (!seat || seat.concluding) throw new HttpError(401, "unauthorized", "this seat is over");
    if (body.channel !== this.channel) throw new HttpError(403, "forbidden", `a seat posts only in #${this.channel}`);
    if (body.thread !== undefined && body.thread !== seatId) throw new HttpError(403, "forbidden", "a seat posts only in its own thread");
    const me = this.core.myHandle();
    if (!me || !this.fit(me)) throw new HttpError(409, "conflict", `#${this.channel} isn't private to this machine's person and the launchers`);
    if (!this.core.limiter.take(`seat:${seatId}`, this.core.limits.agentWrite)) throw new HttpError(429, "rate_limited", "too many writes; slow down");
    const text = scrub(body.text).trim() || "…";
    return this.core.emit("msg.post", { text, thread: seatId } as BodyOf<"msg.post">, { channel: this.channel, agent: seatAgentName(seatId) });
  }

  private fit(me: string): boolean {
    return channelFit(this.core.roster.channels.get(this.channel), me, launcherHandles(this.core.roster, this.policy())) === null;
  }

  /**
   * A post by the host daemon in its seats channel (in a seat's thread, or not threaded for the host's own
   * availability), only while the channel is private to the host and launchers.
   */
  private post(thread: string | undefined, text: string, seat: Record<string, unknown>): void {
    const me = this.core.myHandle();
    if (!me || !this.fit(me)) { this.log.warn("seats_post_withheld", { thread: thread ?? null, reason: "channel_not_fit" }); return; }
    try {
      this.core.emit("msg.post", { text: text.trim() || "…", ...(thread ? { thread } : {}), seat } as unknown as BodyOf<"msg.post">, { channel: this.channel, agent: SEATS_AGENT });
    } catch (err) {
      this.log.warn("seats_post_failed", { err: (err as Error).message });
    }
  }

  private postState(id: string, s: Omit<SeatState, "op" | "v" | "seat">): void {
    const state: SeatState = { op: "state", v: 1, seat: id, ...s, ...(s.reason ? { reason: scrub(s.reason).slice(0, 300) } : {}) };
    this.post(id, stateText(state), state as unknown as Record<string, unknown>);
  }

  /**
   * The team-wide `seats` status says only that this machine takes seats and how many run (never prompts, paths,
   * launchers or models: those stay in the private channel).
   */
  private status(): void {
    if (!this.core.teamId || !this.core.me()) return;
    const n = this.seats.size;
    const a = this.availability();
    // Fixed phrases only (the team-wide status projection, status-projection.ts, shares nothing else); the counts are
    // in the host's availability post and the seats views.
    const activity = !this.allowed ? SEATS_PHRASES.off : a.state === "busy" ? SEATS_PHRASES.busy : n ? SEATS_PHRASES.running : SEATS_PHRASES.allowed;
    try {
      this.core.statuses.submit(SEATS_AGENT, {
        agent: SEATS_AGENT, state: !this.allowed ? "offline" : n || this.queue.length ? "working" : "idle", runtime: "other", title: this.queue.length ? `Seats · ${this.queue.length} queued` : "Seats",
        activity, started_at: this.startedAt, ask_policy: "off",
      }, { title: "agent", activity: "phrase" });
    } catch (err) {
      this.log.warn("seats_status_failed", { err: (err as Error).message });
    }
  }

  // ---- persistence -------------------------------------------------------------------------------------

  private load(): Persisted & { unreadable?: true } {
    try {
      if (!existsSync(this.statePath)) return { handled: {}, running: [] };
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as { handled?: unknown; running?: Partial<SavedSeat>[] };
      const handled: Record<string, number> = {};
      if (Array.isArray(raw.handled)) {
        // Before v0.2: ids only, kept for as long as a request could have been dated ahead then.
        const until = Date.now() + this.maxAge + 2 * HANDLED_KEEP_MS;
        for (const id of raw.handled) if (typeof id === "string") handled[id] = until;
      } else if (typeof raw.handled === "object" && raw.handled !== null) {
        for (const [id, until] of Object.entries(raw.handled)) if (typeof until === "number") handled[id] = until;
      }
      const busy = parseBusy((raw as { busy?: unknown }).busy);
      const launches: Record<string, number[]> = {};
      const rawLaunches = (raw as { launches?: unknown }).launches;
      if (typeof rawLaunches === "object" && rawLaunches !== null) {
        for (const [k, v] of Object.entries(rawLaunches).slice(0, 256)) {
          if (Array.isArray(v)) launches[k] = v.filter((t): t is number => typeof t === "number" && Date.now() - t < 86_400_000).slice(-1_000);
        }
      }
      const queued = (raw as { queued?: unknown }).queued;
      return {
        handled,
        running: Array.isArray(raw.running) ? raw.running.filter((x) => typeof x?.id === "string" && typeof x?.dir === "string")
          .map((x) => ({
            id: x.id as string, dir: x.dir as string, ...(Number.isInteger(x.pid) && (x.pid as number) > 1 ? { pid: x.pid } : {}),
            ...(typeof x.started === "string" ? { started: x.started } : {}), ...(x.runner === true ? { runner: true as const } : {}),
            ...(Number.isInteger(x.user) ? { user: x.user } : {}),
            ...(validTaskRecord(x.task) ? { task: x.task } : {}),
            ...(validLaneRecord(x.lane) ? { lane: x.lane } : {}),
          })) : [],
        ...(busy ? { busy } : {}), launches,
        users: Array.isArray((raw as { users?: unknown }).users) ? ((raw as { users: unknown[] }).users).filter((x): x is number => Number.isInteger(x)) : [],
        user_high: Number.isInteger((raw as { user_high?: unknown }).user_high) ? (raw as { user_high: number }).user_high : 0,
        ...(Array.isArray(queued) ? { queued: queued.filter((id): id is string => typeof id === "string" && /^[0-9a-f]{16}:\d+$/.test(id)).slice(0, QUEUE_CAP) } : {}),
      };
    } catch (err) {
      this.log.warn("seats_state_unreadable", { err: (err as Error).message });
      return { handled: {}, running: [], unreadable: true };
    }
  }

  /**
   * Writes seats.json (atomically); false when it couldn't. `durable`: flushed to the disk itself, the file and its
   * directory (a seat user id about to be asked for: Codex r7 MEDIUM 3).
   */
  private save(durable = false): boolean {
    const data: Persisted = {
      handled: Object.fromEntries(this.handled),
      running: [...this.seats.values()].map((s) => ({
        id: s.id, dir: s.dir, ...(s.child ? { pid: s.child.pid } : {}), ...(s.childStarted ? { started: s.childStarted } : {}),
        ...(s.runner ? { runner: true as const } : {}), ...(s.userN !== null ? { user: s.userN } : {}),
        ...(s.v2?.clone && s.v2.dirs && s.v2.branch && !s.user ? { lane: { clone: s.v2.clone, branch: s.v2.branch } } : {}),
        ...(s.v2?.task && !s.user ? {
          task: { cwd: s.cwd, file: s.v2.task.file, ...(s.v2.task.exclude ? { exclude: s.v2.task.exclude } : {}), ...(s.v2.task.hash ? { hash: s.v2.task.hash } : {}),
            ...(s.v2.task.tmp ? { tmp: s.v2.task.tmp } : {}) },
        } : {}),
      })),
      ...(this.busy ? { busy: this.busy } : {}),
      ...(this.queue.length ? { queued: this.queue.map((q) => q.ev.id) } : {}),
      users: [...this.liveUsers], user_high: this.userHigh,
      launches: Object.fromEntries([...this.launchesDay].map(([k, v]) => [k, v.filter((t) => Date.now() - t < 86_400_000)]).filter(([, v]) => (v as number[]).length)),
    };
    const tmp = `${this.statePath}.tmp`;
    try {
      if (durable) {
        writeDurably(this.statePath, JSON.stringify(data) + "\n", 0o600);
        return true;
      }
      writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600 });
      renameSync(tmp, this.statePath);
      return true;
    } catch (err) {
      this.log.warn("seats_state_write_failed", { err: (err as Error).message });
      return false;
    }
  }
}

/** Refusal reasons as the launcher reads them. */
const REASONS: Record<string, string> = {
  seats_not_allowed: "seats are turned off on this machine",
  not_a_launcher: "you are not allowed to start seats on this machine",
  agent_not_allowed: "agents can't start or stop seats here unless the machine's person allows that agent by name",
  node_not_admitted: "the request's machine is not admitted to the team",
  host_not_admitted: "the host machine is not an admitted member of the team",
  author_node_mismatch: "the request's author doesn't match its machine",
  observer: "observers can't start seats",
  stale: "the request arrived too late (over 10 minutes old)",
  future: "the request is dated more than 2 minutes ahead of this machine's clock (check the launcher's clock)",
  runtime_not_allowed: "this machine doesn't allow that runtime",
};

/** A process's start time as `ps` prints it (stable for the process's life), or null when it isn't running. */
function processStart(pid: number): string | null {
  try {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } });
    const out = r.stdout.toString().trim();
    return r.exitCode === 0 && out ? out : null;
  } catch {
    return null;
  }
}

/** The processes of process group `pgid` and their start times (ms), from `ps`; [] when it can't tell. */
export function groupMembers(pgid: number): Array<{ pid: number; startMs: number }> {
  try {
    const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid=,lstart="], { stdout: "pipe", stderr: "ignore", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } });
    if (r.exitCode !== 0) return [];
    const out: Array<{ pid: number; startMs: number }> = [];
    for (const line of r.stdout.toString().split("\n")) {
      const t = line.trim().split(/\s+/);
      if (t.length < 3 || Number(t[1]) !== pgid) continue;
      const pid = Number(t[0]);
      const startMs = Date.parse(t.slice(2).join(" "));
      if (Number.isInteger(pid) && pid > 1 && Number.isFinite(startMs)) out.push({ pid, startMs });
    }
    return out;
  } catch {
    return [];
  }
}

/** `ps` start times have 1 s resolution. */
const START_SLACK_MS = 2_000;

/**
 * Ends what is left of a seat's process group after its daemon died; true when anything was signalled. The group's
 * id is the runtime's pid (it leads its own session). While the runtime is alive, the group is ours only if that
 * pid is still the same process (its start time matches: a reused pid is never signalled). Once the runtime has
 * exited, its tools' processes may still be in the group: the kernel never gives a new process a pid that is still
 * in use as a process group id, so they are ours; as a second check each must have started no earlier than the
 * runtime did. Every such survivor gets SIGKILL (the group at once when all of it qualifies).
 */
export function killLeftover(r: SavedSeat): boolean {
  if (!r.pid || !r.started) return false;
  const leader = processStart(r.pid);
  if (leader !== null && leader !== r.started) return false; // the pid now belongs to another process
  const since = Date.parse(r.started);
  const members = groupMembers(r.pid);
  const ours = members.filter((m) => Number.isFinite(since) && m.startMs >= since - START_SLACK_MS);
  if (leader === null && !ours.length) return false;
  const targets = leader !== null || ours.length === members.length ? [-r.pid] : ours.map((m) => m.pid);
  let signalled = false;
  for (const t of targets) {
    try { process.kill(t, "SIGKILL"); signalled = true; } catch { /* already gone */ }
  }
  return signalled;
}

/**
 * A failed seat's reason as posted: redacted WHOLE first (a secret cut at the limit would no longer be recognised,
 * Codex r2 MEDIUM 4), then one line of at most 280 characters.
 */
export function failureReason(text: string): string {
  return scrub(text).replace(/\s+/g, " ").slice(0, 280);
}

/** A seat user's clean-up: done, or which stage couldn't be verified. */
interface CleanResult { ok: boolean; why?: string }

/** A file's text, null when it doesn't exist; throws when it exists but can't be read (fail closed). */
function readIfThere(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/** A seat's final state and reason when it was stopped (by a person, its limit, a revoke, a shutdown…). */
function stopText(stop: NonNullable<Seat["stop"]>, run: AnySeatRun): Pick<SeatState, "state" | "reason"> {
  switch (stop.reason) {
    case "reserve": return { state: "stopped", reason: "borrowed account returned to preserve its person’s 10% reserve" };
    case "timeout": return { state: "timeout", reason: `stopped after the ${Math.round(run.timeout_s / 60)} min limit` };
    case "stopped": return { state: "stopped", reason: stop.by ? `stopped by @${stop.by}` : "stopped" };
    case "revoked": return { state: "stopped", reason: "seats were turned off on this machine" };
    case "shutdown": return { state: "stopped", reason: "the host's Walkie daemon stopped" };
    case "unadmitted": return { state: "stopped", reason: "the host machine is no longer an admitted member of the team" };
  }
}

/** seats.json `busy`, validated (null when absent or malformed). */
function parseBusy(raw: unknown): SeatsBusy | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  if (!int(b.max, 0, 64) || typeof b.by !== "string" || !b.by || b.by.length > 64 || !int(b.since, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (b.until !== undefined && !int(b.until, 0, Number.MAX_SAFE_INTEGER)) return null;
  return { max: b.max as number, by: b.by, since: b.since as number, ...(b.until !== undefined ? { until: b.until as number } : {}) };
}

/** A host post's availability without its op/v (what views and the dedupe compare). */
function stripHost(h: SeatHost): HostAvailability {
  const { op: _op, v: _v, ...rest } = h;
  return rest;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function scrub(text: string): string { return redactSecrets(text).text; }

/** One seats host per daemon (routes look it up by the daemon's Core). */
const hosts = new WeakMap<Core, SeatsHost>();
export function registerSeats(core: Core, host: SeatsHost): void { hosts.set(core, host); }
export function seatsFor(core: Core): SeatsHost | undefined { return hosts.get(core); }

/**
 * What of the machine's Claude credentials file a seat gets (SEATS-FIX-8, Opus r8 2): the access token only, never
 * the refresh token (a seat refreshing with it could sign the machine out where refresh tokens are single-use, and
 * it would outlive the seat). Null when there is none, or it expires within 10 minutes (the seat couldn't refresh it).
 */
export function accessOnlyClaude(text: string, now: number): string | null {
  try {
    const o = JSON.parse(text) as { claudeAiOauth?: Record<string, unknown> };
    const a = o.claudeAiOauth;
    if (!a || typeof a.accessToken !== "string" || !a.accessToken) return null;
    if (typeof a.expiresAt === "number" && a.expiresAt < now + 10 * 60_000) return null;
    const { refreshToken: _drop, ...rest } = a;
    return JSON.stringify({ claudeAiOauth: rest });
  } catch {
    return null;
  }
}

/**
 * What of the machine's Codex `auth.json` a seat gets (SEATS-FIX-8, Opus r8 2): its access and id tokens, never the
 * refresh token or an API key. Null when it has no access token. The copy carries an EMPTY `refresh_token`: codex-cli
 * 0.156.1 refuses an auth.json without the field ("missing field `refresh_token`"), so the seat could not sign in.
 */
export function accessOnlyCodex(text: string): string | null {
  return codexAccessOnly(text)?.json ?? null;
}

/** A v2 seat's host-side state before it prepares. */
function newV2(run: SeatRunV2, id: string): V2Seat {
  return {
    run, brief: null, task: null, dirs: null, clone: null, tag: seatAgentName(id).slice(5), staged: null, branch: null, creds: null, lease: null, result: null,
  };
}
