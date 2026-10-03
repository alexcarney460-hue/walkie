// Ephemeral seat users (PROTOCOL §11 "Seat users", SECURITY threat 13; SEATS-FIX-5): every seat runs as a user that
// is created for it and destroyed after it, and no uid or name is ever used twice. Reusing a uid let state cross runs
// in ways no wipe covers (home ACLs, files outside the home, the cron spool, launchd domains: Codex r5, Opus r5).
//
// This is the logic of the root helper `walkie-seat-admin` (installed root-owned by `walkie seats setup-user
// --apply`), which the daemon's user may run through sudo with exactly `seat-admin create <n>` or
// `seat-admin destroy <n>` (n an integer; the user is `walkie-s<n>`, uid 600000+n), or `seat-admin pending` (the
// ids of the calling person's that may still have something of them, for the daemon's restart). Those three answer
// only the Walkie that setup-user registered for this machine's seat users (WALK-103, instance.ts): root binds the
// daemon that ran sudo to the registered socket's instance lock first. The system calls sit behind
// AdminSys, so the grammar and every verification here are tested with fakes (test/unit/seats-fix5.test.ts,
// seats-fix6.test.ts); the real one is admin-sys.ts.
//
// Root never deletes a file outside the seat's home by path (Codex r6 CRITICAL 1, HIGH 2): the seat user's own files
// are removed by the seat user itself (the runner's `sweep`, sweep.ts), before its account is deleted; root only
// stops its processes and services, removes its crontab, removes an empty home or locks a verified macOS-protected
// home in a root-only tombstone, and deletes the account.
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeOut } from "../../cli/stdio.ts";
import { selfOp, type HomeRetirementStore, type Ledger, type OpId } from "./admin-ledger.ts";
import { SeatAdminBusyError, withSeatAdminLock, withSeatFileLock } from "./talkie-lock.ts";
import { schedulerProblem } from "./seat-user.ts";
import { SF_NOUNLINK, SF_RESTRICTED, UF_DATAVAULT } from "./fsat.ts";
import type { ResidueProof } from "./sweep.ts";
import type { SeatInstanceCheck } from "./instance.ts";

export const SEAT_USER_PREFIX = "walkie-s";
/** The sudo rule lets the daemon run the runner as any member of this group: every ephemeral seat user. */
export const SEATS_GROUP = "walkie-seats";
export const UID_BASE = 600_000;
export const MAX_N = 99_999;
export const SEAT_HOME_MARKER = ".walkie-seat-home";

export type AdminVerb = "create" | "destroy" | "pending" | "talkie-create" | "talkie-destroy" | "talkie-reconcile" | "talkie-repair" | "talkie-status" | "talkie-lock-init";
const TALKIE_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `seat-admin <create|destroy> <n>`, `seat-admin destroy <n> idle` (a leftover the daemon didn't make in this run:
 * refused while any process of it runs, WALK-103) or `seat-admin pending`, nothing else: the fixed grammar sudo allows
 * (`destroy *` in the sudo rules covers the trailing word).
 */
export function parseAdminArgv(argv: readonly string[]): { verb: AdminVerb; n: number; generation?: string; instance?: string; idle?: true } | null {
  if (argv.length === 1 && argv[0] === "pending") return { verb: "pending", n: 0 };
  if (argv.length === 1 && (argv[0] === "talkie-status" || argv[0] === "talkie-lock-init")) return { verb: argv[0], n: 0 };
  if (argv.length === 3 && (argv[0] === "talkie-create" || argv[0] === "talkie-reconcile")
    && TALKIE_GENERATION.test(argv[1] ?? "") && /^[0-9a-f]{64}$/.test(argv[2] ?? ""))
    return { verb: argv[0], n: 0, generation: argv[1], instance: argv[2] };
  if (argv.length === 2 && argv[0] === "talkie-destroy" && TALKIE_GENERATION.test(argv[1] ?? ""))
    return { verb: argv[0], n: 0, generation: argv[1] };
  if (argv.length === 2 && argv[0] === "talkie-repair" && (argv[1] === "legacy" || TALKIE_GENERATION.test(argv[1] ?? "")))
    return { verb: argv[0], n: 0, generation: argv[1] };
  if (argv.length === 3 && argv[0] === "destroy" && argv[2] === "idle" && /^[1-9]\d{0,4}$/.test(argv[1] ?? ""))
    return { verb: "destroy", n: Number(argv[1]), idle: true };
  if (argv.length !== 2) return null;
  const [verb, n] = argv;
  if (verb !== "create" && verb !== "destroy") return null;
  if (!/^[1-9]\d{0,4}$/.test(n ?? "")) return null;
  return { verb, n: Number(n) };
}

export const seatUserName = (n: number): string => `${SEAT_USER_PREFIX}${n}`;
export const seatUserUid = (n: number): number => UID_BASE + n;

type Stat = { uid: number; mode: number; dir: boolean; file: boolean; symlink: boolean };

export interface AdminSys {
  platform: "darwin" | "linux";
  /** Where seat users' homes go (tests only; the real helper uses /Users or /var/lib/walkie-seats). */
  homesDir?: string;
  /** Tests only: fake system cache root; production uses /Library/Caches. */
  cacheDir?: string;
  /** Root's no-follow flag/ownership check for a reported Apple cache vault. */
  vaultStat(path: string): { uid: number; flags: number; bytes: number; symlink: boolean } | null;
  /** The id ledger (admin-ledger.ts). Throws when it can't be opened. */
  ledger(): Ledger;
  /** Pending ids and residue from a read-only database connection; never creates or migrates the ledger. */
  pendingReadOnly(owner: number): { ids: number[]; summary: { homes: number; vaults: number; knownBytes: number } };
  /** Stable dedicated-user lock inode, created before the account and never unlinked. */
  talkieLockPath?: string;
  /** Real root helper requires a root-owned, non-group-writable lock inode. */
  talkieLockRoot?: boolean;
  /** Root-held outer lock for all seat-user mutations; tests may supply a temporary path. */
  seatAdminLockPath?: string;
  /** Read-only root ledger probe; missing ledger means no owner row. */
  talkieOwnerReadOnly?(uid: number): import("./admin-ledger.ts").TalkieOwnerRecord | null;
  /** Read-only uid-owned file check after the account has disappeared; false or uncertainty blocks row release. */
  verifyEmptyTalkieUid?(uid: number): { ok: boolean; left: string[] };
  /** Root-verified process identity of the invoking daemon, recorded with the owner row. */
  talkieDaemonIdentity?(owner: number, instance: string): import("./admin-ledger.ts").OpId;
  /** Refuse owner release while the recorded daemon process, lease, or socket is live. */
  talkieGenerationStopped?(generation: string | null, owner: number, daemon: import("./admin-ledger.ts").OpId | null): Promise<{ ok: boolean; why?: string }>;
  /** The person who asked (sudo's SUDO_UID): seat users are theirs, and only theirs are destroyed or listed. */
  caller(): number;
  /**
   * WALK-103: whether the daemon that ran this helper is the Walkie setup-user registered for this machine's seat users
   * (admin-sys.ts checkSeatInstance: the record in SEAT_INSTANCE_FILE, and that daemon holding the recorded socket's
   * instance lock). `create`, `destroy` and `pending` answer only `registered`.
   */
  seatInstance(owner: number): SeatInstanceCheck;
  /** This helper process as an operation (its pid and start time). */
  self?(): OpId;
  /** Does a user or group with this name, or this uid/gid, exist? Throws when it can't tell. */
  nameTaken(name: string): boolean;
  idTaken(id: number): boolean;
  /** The user's uid, gid and every group id, or null when there is none (throws when it can't tell). */
  lookup(name: string): { uid: number; gid: number; gids: number[] } | null;
  /**
   * The ids among `gids` (the user's groups) that every local account is in anyway, so they aren't groups anyone gave
   * it (macOS: the built-in everyone/localaccounts groups and groups it is in only through them, judged by direct
   * membership in the local directory: mac-groups.ts). Linux, or absent: none. Throws when it can't tell.
   */
  implicitGroups?(name: string, gids: number[]): number[];
  createUser(u: { name: string; uid: number; home: string }): void;
  /** Removes the user and its group; one already gone is fine. */
  deleteUser(name: string): void;
  /**
   * The seat user's home: made root-owned 0700 with an empty root-owned `walkie-seats/` and root's marker, then
   * `walkie-seats/` and last the home handed to the user (an interruption leaves a home root can recognize and
   * remove: removeUnusedHome).
   */
  makeHome(home: string, uid: number): void;
  /** Root-only, no-follow home move after a verified seat-user sweep. */
  retireHome(home: string, uid: number, name: string, retirement: HomeRetirementStore): { path: string; bytes: number } | null;
  /** Root's descriptor-relative ownership and identity check for every home entry. */
  verifyHomeResidue(home: string, uid: number, proofs: readonly ResidueProof[]): string | null;
  /** `ls -led` / `getfacl -cp` of a path, null when it can't be read. */
  acl(path: string): string | null;
  /** lstat of a path: null when it doesn't exist (throws on any other error). */
  stat(path: string): Stat | null;
  /** Adds the user to the cron and at deny files (exact lines; called with the ledger's lock held). */
  denySchedulers(name: string): void;
  /** The scheduler allow/deny files' text (null: absent), for the exact-match check. */
  readSchedulerFile(path: string): string | null;
  schedulerFiles: { cron: [string, string]; at: [string, string] };
  /** Pids of every process of `uid` (root lists them all). Throws when it can't tell. */
  procs(uid: number): Array<{ pid: number; stat: string }>;
  signal(pid: number, sig: "SIGSTOP" | "SIGKILL"): void;
  /** launchd (macOS) `bootout user/<uid>` and `gui/<uid>`; systemd (Linux) the user's manager, verified. The problem, or null. */
  stopUserServices(uid: number): string | null;
  /**
   * Its crontab removed directly from the cron spool while the account exists, then the cron and at spools inspected
   * by name and uid: the problem (something of it is scheduled, or the spools can't be read), or null.
   */
  removeSchedules(name: string, uid: number, exists: boolean): string | null;
  /** Mount points `uid` mounted (throws when it can't tell), and a forced unmount of one (Opus r7 4). */
  userMounts(uid: number): string[];
  unmount(path: string): void;
  /** The world-writable directories setup found on this machine, to sweep too (Opus r7 6). Throws when unknown. */
  extraRoots(): string[];
  /** The runner's `sweep` as the seat user (sweep.ts): verified, or what is left. */
  sweepAsUser(name: string, uid: number, roots: string[], residueFolders?: string[], timeoutMs?: number): Promise<{ ok: boolean; left: string[]; leftoverDirs?: string[]; residuePaths?: string[]; residueProofs?: ResidueProof[] }>;
  /** Remove and verify the projected access token, independently of the general sweep. */
  dropClaudeProjection(name: string, uid: number, timeoutMs?: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** Real helper bounds each OS subprocess by the remaining destroy deadline. */
  setDestroyDeadline?(deadline: number | null): void;
  /** Tests: how long a destroy waits for another operation on the id (20 s), and for SIGKILL to take (10 s). */
  busyWaitMs?: number;
  killWaitMs?: number;
}

/**
 * `code`: `used` (nothing was made: the id is used or taken; ask again above `high`), `refused` (nothing was made,
 * and the helper can't make users now), `failed` (something may have been made: it was destroyed, see `left`), `busy`
 * (another create or destroy of the id is running: ask again).
 */
export interface AdminResult {
  ok: boolean; code?: "used" | "refused" | "failed" | "busy" | "running"; name?: string; uid?: number; home?: string; generation?: string; high?: number; why?: string;
  /**
   * WALK-103: refused because the asking daemon isn't the registered Walkie (`other`), none is recorded
   * (`unregistered`), or that couldn't be checked right now (`unchecked`, code `busy`: ask again).
   */
  scope?: "other" | "unregistered" | "unchecked";
  /** WALK-103: on a `pending` refused for scope, whether the id ledger reads (`ok`) or why not; never its ids. */
  ledger?: string;
  left?: string[]; ids?: number[]; idleIds?: number[]; leftoverDirs?: string[];
  residueSummary?: { homes: number; vaults: number; knownBytes: number };
  /** A helper process check found no live uid processes; absent means the check could not be made. */
  processesGone?: boolean;
  status?: { accountUid: number | null; uidTaken: boolean; processes: number[]; homeExists: boolean; ledgerOwner: string | null;
    generation?: string | null; instance?: string | null };
}

export function seatHome(sys: Pick<AdminSys, "platform" | "homesDir">, n: number): string {
  return `${sys.homesDir ?? (sys.platform === "darwin" ? "/Users" : "/var/lib/walkie-seats")}/${seatUserName(n)}`;
}

const msg = (err: unknown) => (err as Error).message;
const opOf = (sys: AdminSys): OpId => (sys.self ? sys.self() : selfOp());

/** `seat-admin create <n>`: a new user for one seat; n must be above every id ever used (the ledger decides). */
export async function createSeatUser(n: number, sys: AdminSys): Promise<AdminResult> {
  const name = seatUserName(n);
  const uid = seatUserUid(n);
  const home = seatHome(sys, n);
  let op: OpId;
  try { op = opOf(sys); } catch (err) { return { ok: false, code: "refused", why: msg(err) }; }
  let ledger: Ledger;
  try {
    ledger = sys.ledger();
    // Held by this create from the start, durably, before anything is made: a half-made user is never handed out
    // again, and a destroy of it waits for this create (Codex r7 HIGH 1).
    const r = ledger.reserve(n, sys.caller(), op);
    if (!r.ok) return { ok: false, code: "used", why: `${name}: ${r.why}`, high: r.high };
  } catch (err) {
    return { ok: false, code: "refused", why: `the helper's id ledger can't be used: ${msg(err)}` };
  }
  try {
    if (sys.nameTaken(name) || sys.idTaken(uid)) {
      ledger.finish(n, op, "cancelled");
      return { ok: false, code: "used", why: `${name} or id ${uid} exists already: never reused`, high: n };
    }
  } catch (err) {
    try { ledger.finish(n, op, "cancelled"); } catch { /* a destroy cancels it */ }
    return { ok: false, code: "refused", why: `can't tell whether ${name} exists: ${msg(err)}`, high: n };
  }
  try {
    if (!ledger.advance(n, op, "reserved", "making")) return { ok: false, code: "refused", why: `${name} was cancelled before it was made`, high: n };
  } catch (err) {
    return { ok: false, code: "refused", why: `the helper's id ledger can't be written: ${msg(err)}`, high: n };
  }
  try {
    sys.createUser({ name, uid, home });
    sys.makeHome(home, uid);
    // One helper at a time edits the deny files, without holding the id ledger while filesystem I/O runs.
    await withSeatFileLock(`${ledger.path}.schedulers.lock`, !!sys.talkieLockRoot, async () => sys.denySchedulers(name));
    const why = verifyCreated(n, sys);
    if (why) throw new Error(why);
    ledger.finish(n, op, "created");
    return { ok: true, name, uid, home, high: n };
  } catch (err) {
    const undone = await destroySeatUser(n, sys);
    return {
      ok: false, code: "failed", high: n, ...(undone.ok ? {} : { left: undone.left ?? [] }),
      why: `${name} could not be made clean: ${msg(err)}${undone.ok ? "" : ` (and undoing it left: ${(undone.left ?? [undone.why]).join("; ")})`}`,
    };
  }
}

/**
 * The new user is what it must be: its own uid and group, no other group but the seats' (and, on macOS, those every
 * local account is in), a 0700 home with no ACL.
 */
function verifyCreated(n: number, sys: AdminSys): string | null {
  const name = seatUserName(n);
  const uid = seatUserUid(n);
  const u = sys.lookup(name);
  if (!u) return `${name} doesn't exist after it was made`;
  if (u.uid !== uid || u.gid !== uid) return `${name} has uid ${u.uid} / gid ${u.gid}, not ${uid}`;
  const seatsGid = sys.lookup(SEATS_GROUP)?.gid;
  const others = u.gids.filter((g) => g !== uid && g !== seatsGid);
  // macOS puts every local account in everyone/localaccounts and the groups nesting them (SEATS-MACOS-FIX): not extra.
  const implicit = new Set(others.length && sys.implicitGroups ? sys.implicitGroups(name, others) : []);
  const extra = others.filter((g) => !implicit.has(g));
  if (extra.length) return `${name} is in other groups (${extra.join(", ")})`;
  const home = seatHome(sys, n);
  const st = sys.stat(home);
  if (!st || st.symlink || !st.dir || st.uid !== uid || (st.mode & 0o777) !== 0o700) return `${home} is not a 0700 directory of ${name}`;
  const listing = sys.acl(home);
  if (listing === null) return `can't read the access control list of ${home}`;
  const entries = listing.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  if (sys.platform === "darwin" ? entries.length : entries.some((l) => /^(user|group):[^:]+:/.test(l))) return `${home} has an access control list (${entries[0]})`;
  return schedulerProblem([name], sys.schedulerFiles, (p) => sys.readSchedulerFile(p));
}

const STOP_PASSES = 20;
const KILL_WAIT_MS = 10_000;

/**
 * Every process of `uid`: stopped first (nothing reacts, respawns or forks), then killed until none is left. Throws
 * unless none is left (Codex r7 MEDIUM 2: nothing after this runs while one may).
 */
export async function endProcesses(uid: number, sys: AdminSys, beforePass?: () => void, deadline = Infinity): Promise<void> {
  for (let i = 0; i < STOP_PASSES; i++) {
    const list = sys.procs(uid);
    if (list.every((p) => p.stat.startsWith("T"))) break;
    beforePass?.();
    for (const p of list) try { sys.signal(p.pid, "SIGSTOP"); } catch { /* gone */ }
  }
  const wait = sys.killWaitMs ?? KILL_WAIT_MS;
  const until = Math.min(deadline, Date.now() + wait);
  for (let list = sys.procs(uid); list.length; list = sys.procs(uid)) {
    beforePass?.();
    if (Date.now() >= until) throw new Error(`${list.length} process${list.length === 1 ? "" : "es"} of it survived SIGKILL for ${wait / 1000} s`);
    for (const p of list) try { sys.signal(p.pid, "SIGKILL"); } catch { /* gone */ }
    await sys.sleep(Math.min(50, Math.max(1, until - Date.now())));
  }
}

/**
 * The seat user's home, once the user emptied it: a directory of that user (never a link) holding at most root's
 * marker. Root removes the marker and the empty directory, nothing else (a home with anything else in it stays and
 * is reported). Its parent (/Users, /var/lib/walkie-seats) is root's, so the path can't be swapped under it.
 */
export function removeEmptyHome(home: string, uid: number, sys: Pick<AdminSys, "stat">): string | null {
  const st = sys.stat(home);
  if (!st) return null;
  if (st.symlink || !st.dir) return `${home} is not a directory`;
  if (st.uid !== uid) return `${home} is not the seat user's (uid ${st.uid})`;
  const entries = readdirSync(home);
  const others = entries.filter((e) => e !== SEAT_HOME_MARKER);
  if (others.length) return `${home} still holds ${others.length} entr${others.length === 1 ? "y" : "ies"} its user couldn't remove`;
  if (entries.length) {
    const m = sys.stat(join(home, SEAT_HOME_MARKER));
    if (!m || !m.file || m.uid !== 0) return `${home}/${SEAT_HOME_MARKER} is not root's marker`;
    unlinkSync(join(home, SEAT_HOME_MARKER));
  }
  rmdirSync(home);
  return null;
}

/**
 * A home whose creation was interrupted before it was handed to the user (Codex r7 MEDIUM 4): still root's, so the
 * user never wrote in it. Removed only when it holds nothing but what makeHome makes (root's marker, and an empty
 * `walkie-seats/` of root's or the user's), never through a link; anything else is reported.
 */
export function removeUnusedHome(home: string, uid: number, sys: Pick<AdminSys, "stat">): string | null {
  const st = sys.stat(home);
  if (!st || st.uid !== 0) return null; // none, or the user's (the sweep and removeEmptyHome handle it)
  if (st.symlink || !st.dir) return `${home} is not a directory`;
  for (const e of readdirSync(home)) {
    const es = sys.stat(join(home, e));
    if (e === SEAT_HOME_MARKER && es?.file && es.uid === 0) continue;
    if (e === "walkie-seats" && es?.dir && !es.symlink && (es.uid === 0 || es.uid === uid) && readdirSync(join(home, e)).length === 0) continue;
    return `${home} (never handed to its user) holds ${JSON.stringify(e)}, which setup didn't make`;
  }
  for (const e of readdirSync(home)) (e === "walkie-seats" ? rmdirSync : unlinkSync)(join(home, e));
  rmdirSync(home);
  return null;
}

/** Inspect the seat's home without following links; its run and Claude config directories live below it. */
function noClaudeProjection(home: string, accepted: ReadonlySet<string> = new Set()): boolean {
  const pending = [home];
  let inspected = 0;
  while (pending.length) {
    const path = pending.pop() as string;
    if (accepted.has(path)) continue;
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(path); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
    if (!st.isDirectory()) continue;
    let entries: string[];
    try { entries = readdirSync(path); } catch { return false; }
    for (const entry of entries) {
      if (++inspected > 2_000_000 || entry === ".credentials.json") return false;
      pending.push(join(path, entry));
    }
  }
  return true;
}

/** Root checks that the sweep reported every remaining entry before making the home inaccessible. */
function homeResidueProblem(home: string, uid: number, paths: readonly string[], proofs: readonly ResidueProof[], sys: AdminSys): string | null {
  if (!paths.length || paths.length !== proofs.length || paths.some((path) => !proofs.some((proof) => proof.path === path)))
    return "the home residue has no matching runner EPERM proof";
  return sys.verifyHomeResidue(home, uid, proofs);
}

/**
 * `seat-admin destroy <n>`: everything of the user goes, verified, in an order every stage of which can run again
 * after partial progress (Codex r6 MEDIUM 5), and only while this destroy holds the id (Codex r7 HIGH 1: never at the
 * same time as its create or another destroy): its processes (a SIGSTOP sweep, then SIGKILL until none is left; any
 * survivor stops the destroy there, Codex r7 MEDIUM 2), its launchd/systemd services, its crontab (while the account
 * exists; the spools checked either way), its mounts (force-unmounted), its files (the user's own sweep, as itself,
 * while the account exists), its home (once empty), and only when all of that is verified, the account and its group.
 * A missing account means that stage was done: the account is deleted only after its files were verified gone (apart
 * from recorded macOS-protected residue in its own per-user folder) and no process of it was left. This destroy
 * returns that residue only after the final account and process checks pass. Anything unverified is listed in `left`;
 * the uid remains in the ledger and is never reused.
 */
export async function destroySeatUser(n: number, sys: AdminSys, deadlineMs = 120_000): Promise<AdminResult> {
  const deadline = Date.now() + deadlineMs;
  sys.setDestroyDeadline?.(deadline);
  try { return await destroySeatUserWithin(n, sys, deadline); }
  finally { sys.setDestroyDeadline?.(null); }
}

async function destroySeatUserWithin(n: number, sys: AdminSys, deadline: number): Promise<AdminResult> {
  const name = seatUserName(n);
  const uid = seatUserUid(n);
  const home = seatHome(sys, n);
  let op: OpId;
  try { op = opOf(sys); } catch (err) { return { ok: false, name, uid, why: msg(err) }; }
  let ledger: Ledger;
  let taken: ReturnType<Ledger["takeForDestroy"]>;
  try {
    ledger = sys.ledger();
    const until = Math.min(deadline, Date.now() + (sys.busyWaitMs ?? 20_000));
    for (taken = ledger.takeForDestroy(n, sys.caller(), op); !taken.ok && taken.busy && Date.now() < until; taken = ledger.takeForDestroy(n, sys.caller(), op))
      await sys.sleep(Math.min(250, Math.max(1, until - Date.now())));
  } catch (err) { return { ok: false, why: `the helper's id ledger can't be used: ${msg(err)}` }; }
  if (!taken.ok) {
    if (Date.now() >= deadline) return { ok: false, name, uid, why: "cleanup timed out; retried later" };
    return taken.busy
      ? { ok: false, code: "busy", name, uid, why: `a create or destroy of ${name} is still running (${taken.state}): not destroyed yet` }
      : { ok: false, name, uid, why: `${name}: ${taken.why}: not destroyed` };
  }
  if (taken.state === "cancelled") return { ok: true, name, uid }; // nothing was ever made for it
  const left: string[] = [];
  let leftoverDirs: string[] = [];
  const timedOut = (): boolean => {
    if (Date.now() < deadline) return false;
    if (!left.includes("cleanup timed out; retried later")) left.push("cleanup timed out; retried later");
    return true;
  };
  const step = <T>(what: string, f: () => T): T | undefined => {
    if (timedOut()) return undefined;
    try { return f(); } catch (err) { left.push(`${what}: ${msg(err)}`); return undefined; }
  };
  const done = (): AdminResult => {
    const processes = timedOut() ? undefined : step("processes", () => sys.procs(uid));
    if (processes?.length) left.push("processes of it are still running");
    const unique = [...new Set(left)];
    let summary: AdminResult["residueSummary"];
    try { if (Date.now() < deadline) summary = ledger.seatResidueSummary(sys.caller()); }
    catch (err) { unique.push(`the helper's residue ledger could not be read: ${msg(err)}`); }
    try {
      if (unique.length) ledger.release(n, op); else ledger.finish(n, op, "destroyed");
    } catch (err) {
      unique.push(`the helper's id ledger could not record the result: ${msg(err)}`);
    }
    return unique.length ? { ok: false, name, uid, left: unique, why: unique.join("; "), ...(processes ? { processesGone: processes.length === 0 } : {}) }
      : { ok: true, name, uid, ...(leftoverDirs.length ? { leftoverDirs } : {}), ...(summary && (summary.homes || summary.vaults) ? { residueSummary: summary } : {}) };
  };
  const u = step("the user", () => sys.lookup(name));
  if (u === undefined) return done();
  if (u && u.uid !== uid) { left.push(`${name} has uid ${u.uid}, not ${uid}: not this helper's, not touched`); return done(); }
  const exists = u !== null;
  const kill = async (when: string) => {
    if (timedOut()) return false;
    try { await endProcesses(uid, sys, () => { if (timedOut()) throw new Error("cleanup timed out; retried later"); }, deadline); return !timedOut(); }
    catch (err) { left.push(`processes (${when}): ${msg(err)}`); return false; }
  };
  if (!(await kill("before anything else"))) return done();
  // An interrupted create may have left a root-owned setup home but no account. Remove that known layout first.
  if (!exists) {
    const unused = step("its home", () => removeUnusedHome(home, uid, sys));
    if (unused) left.push(`its home: ${unused}`);
  }
  // First cleanup step on every retry, including after a daemon restart. The general sweep must still run if it fails.
  const projection = exists && !timedOut() ? await sys.dropClaudeProjection(name, uid, Math.max(1, deadline - Date.now())).catch(() => false)
    : step("the Claude access projection", () => sys.stat(home)) === null;
  if (timedOut()) return done();
  const services = step("services", () => sys.stopUserServices(uid));
  if (services) left.push(`services: ${services}`);
  const schedules = step("schedules", () => sys.removeSchedules(name, uid, exists));
  if (schedules) left.push(`schedules: ${schedules}`);
  if (left.length && projection) return done(); // leave later stages untouched when services fail and the token is gone
  if (!(await kill("after its services"))) return done();
  // Mounts it made (a disk image, a FUSE mount) are unmounted by force: nothing of it hides under them (Opus r7 4).
  const mounts = step("mounts", () => sys.userMounts(uid));
  for (const m of mounts ?? []) step(`unmounting ${m}`, () => sys.unmount(m));
  const still = step("mounts", () => sys.userMounts(uid));
  if (still?.length) left.push(`mounts of it remain: ${still.slice(0, 3).join(", ")}`);
  if (!still || still.length) return done(); // a mounted tree may conceal the seat's files from the sweep
  if (timedOut()) return done();
  // An interrupted create's home, never handed to the user: removed by what setup made only (Codex r7 MEDIUM 4).
  const unused = step("its home", () => removeUnusedHome(home, uid, sys));
  if (unused) left.push(`its home: ${unused}`);
  let homeResidue: string[] = [];
  let homeProofs: ResidueProof[] = [];
  let cacheResidue: string[] = [];
  if (exists) {
    const roots = step("the sweep's roots", () => sys.extraRoots());
    if (!roots) { if (!projection) left.push("the Claude access projection could not be verified removed"); return done(); }
    // As the seat user itself: it can remove only what it may (Codex r6 CRITICAL 1, HIGH 2).
    const swept = await sys.sweepAsUser(name, uid, roots, [], Math.max(1, deadline - Date.now()))
      .catch((err: unknown) => ({ ok: false, left: [msg(err)], leftoverDirs: [] as string[], residuePaths: [] as string[], residueProofs: [] as ResidueProof[] }));
    if (timedOut()) {
      if (!swept.ok && swept.left.includes("runner did not exit")) left.push("runner did not exit");
      return done();
    }
    if (!swept.ok) left.push(`files it owns remain or couldn't be checked (${swept.left.slice(0, 5).join("; ") || "no answer"})`);
    else {
      leftoverDirs = swept.leftoverDirs ?? [];
      homeResidue = (swept.residuePaths ?? []).filter((p) => p.startsWith(`${home}/`));
      homeProofs = (swept.residueProofs ?? []).filter((p) => p.path.startsWith(`${home}/`));
      cacheResidue = (swept.residuePaths ?? []).filter((p) => dirname(p) === (sys.cacheDir ?? "/Library/Caches"));
    }
    if (!noClaudeProjection(home, new Set(homeResidue))) left.push("the Claude access projection could not be verified removed");
    if (left.length || !(await kill("after its sweep"))) return done();
  } else if (!noClaudeProjection(home)) {
    left.push("the Claude access projection could not be verified removed");
    return done();
  }
  if (cacheResidue.length) {
    const cache = sys.cacheDir ?? "/Library/Caches";
    const root = step("Apple cache root", () => sys.stat(cache));
    if (!root?.dir || root.symlink || root.uid !== 0) left.push(`${cache} is not root's real cache directory`);
    for (const path of cacheResidue) {
      const st = step(`Apple cache vault ${path}`, () => sys.vaultStat(path));
      if (!st || st.symlink || st.uid !== uid || (st.flags & (SF_RESTRICTED | UF_DATAVAULT)) === 0
        || (st.flags & ~(SF_NOUNLINK | SF_RESTRICTED | UF_DATAVAULT | 0x8000)) !== 0) {
        left.push(`${path} is not a verified seat-owned Apple data vault`);
        continue;
      }
      step(`recording Apple cache vault ${path}`, () => ledger.saveSeatResidue(n, sys.caller(), op, "vault", path, st.bytes));
    }
    if (left.length) return done();
  }
  const h = homeResidue.length && sys.platform === "darwin"
    ? step("its home", () => {
      const problem = homeResidueProblem(home, uid, homeResidue, homeProofs, sys);
      if (problem) return problem;
      const retired = sys.retireHome(home, uid, name, ledger.homeRetirementStore(n, sys.caller(), op));
      if (!retired) return "the protected home was not retired";
      ledger.saveSeatResidue(n, sys.caller(), op, "home", retired.path, retired.bytes);
      return null;
    })
    : step("its home", () => removeEmptyHome(home, uid, sys));
  if (h) left.push(`its home: ${h}`);
  if (!h && !left.length && !homeResidue.length && sys.platform === "darwin") {
    const remainingHome = step("its home", () => sys.stat(home));
    if (remainingHome === null) {
      const previous = step("its retired home", () => sys.retireHome(home, uid, name, ledger.homeRetirementStore(n, sys.caller(), op)));
      if (previous) step("recording its retired home", () => ledger.saveSeatResidue(n, sys.caller(), op, "home", previous.path, previous.bytes));
    }
  }
  if (left.length || !(await kill("before its account is deleted"))) return done();
  if (timedOut()) return done();
  step("the account", () => sys.deleteUser(name));
  // Verified, whatever was done above.
  step("processes", () => { if (sys.procs(uid).length) left.push("processes of it are still running"); });
  step("the account", () => { if (sys.nameTaken(name) || sys.idTaken(uid)) left.push(`${name} still exists`); });
  step("its home", () => { if (sys.stat(home)) left.push(`${home} remains`); });
  const again = step("schedules", () => sys.removeSchedules(name, uid, false));
  if (again) left.push(`schedules: ${again}`);
  return done();
}

/** `seat-admin pending`: the caller's ids that may still have something of them (restart reconciliation). */
export function pendingSeatUsers(sys: AdminSys): AdminResult {
  try {
    const { ids, summary } = sys.pendingReadOnly(sys.caller());
    const withSummary: AdminResult = { ok: true, ids, ...(summary.homes || summary.vaults ? { residueSummary: summary } : {}) };
    const base: AdminResult = Buffer.byteLength(`${JSON.stringify(withSummary)}\n`) <= 256 * 1024
      ? withSummary : { ok: true, ids };
    // Bound both process probes and the optional field; the full id list remains intact for restart recovery.
    const idleIds = ids.slice(0, 512).filter((n) => { try { return sys.procs(seatUserUid(n)).length === 0; } catch { return false; } });
    let low = 0;
    let high = idleIds.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const bytes = Buffer.byteLength(`${JSON.stringify({ ...base, idleIds: idleIds.slice(0, mid) })}\n`);
      if (bytes <= 256 * 1024) low = mid;
      else high = mid - 1;
    }
    return low ? { ...base, idleIds: idleIds.slice(0, low) } : base;
  } catch (err) { return { ok: false, code: "refused", why: `the helper's id ledger can't be read: ${msg(err)}` }; }
}

/** `walkie seat-admin …`: root only, the fixed grammar only; one JSON line out. */
export async function runSeatAdmin(argv: readonly string[], sys: AdminSys, emit: (line: string) => void = writeOut): Promise<number> {
  const out = (r: AdminResult) => { emit(`${JSON.stringify(r)}\n`); return r.ok ? 0 : 1; };
  if (process.getuid?.() !== 0) return out({ ok: false, code: "refused", why: "walkie seat-admin runs as root (through sudo) only" });
  const cmd = parseAdminArgv(argv);
  if (!cmd) return out({ ok: false, code: "refused", why: "usage: seat-admin create <n> | destroy <n> [idle] | pending | talkie-create <generation> <instance> | talkie-reconcile <generation> <instance> | talkie-destroy <generation> | talkie-repair <generation|legacy> | talkie-status | talkie-lock-init" });
  let caller: number;
  try { caller = sys.caller(); } catch (err) { return out({ ok: false, code: "refused", why: msg(err) }); }
  if (cmd.verb === "pending" || cmd.verb === "create" || cmd.verb === "destroy") {
    // WALK-103: only the registered Walkie lists, makes or removes seat users; nothing is read or touched otherwise.
    let scope: SeatInstanceCheck;
    try { scope = sys.seatInstance(caller); } catch (err) { scope = { state: "other", why: `the asking Walkie could not be checked: ${msg(err)}` }; }
    if (scope.state !== "registered") {
      // The doctor's and setup's own `pending` probes land here (they aren't the daemon): say whether the ledger reads,
      // never what it holds.
      let ledger: string | undefined;
      if (cmd.verb === "pending") {
        try { sys.pendingReadOnly(caller); ledger = "ok"; } catch (err) { ledger = `the helper's id ledger can't be read: ${msg(err)}`; }
      }
      return out({ ok: false, code: scope.state === "unchecked" ? "busy" : "refused", scope: scope.state, why: scope.why, ...(ledger ? { ledger } : {}) });
    }
  }
  if (cmd.verb === "pending") return out(pendingSeatUsers(sys));
  if (cmd.verb === "talkie-status") {
    const { talkieStatus } = await import("./talkie-user.ts");
    return out(talkieStatus(sys));
  }
  // Always take this lock before Talkie's own lock, the scheduler lock, or a ledger claim. Every mutating verb
  // (seat create/destroy, WalkieTalkie create/destroy/reconcile/repair) runs under it; talkie-status stays read-only.
  try {
    const path = sys.seatAdminLockPath ?? `${sys.ledger().path}.cleanup.lock`;
    return await withSeatAdminLock(path, !!sys.talkieLockRoot, async () => {
      if (cmd.verb === "talkie-repair") {
        const { repairEmptyTalkieOwner } = await import("./talkie-user.ts");
        return out(await repairEmptyTalkieOwner(sys, cmd.generation === "legacy" ? null : cmd.generation as string));
      }
      if (cmd.verb === "talkie-lock-init") {
        const { withTalkieLock } = await import("./talkie-lock.ts");
        try { await withTalkieLock(sys, true, async () => undefined); return out({ ok: true }); }
        catch (err) { return out({ ok: false, code: "refused", why: `could not initialize the dedicated user lock: ${msg(err)}` }); }
      }
      if (cmd.verb === "talkie-create" || cmd.verb === "talkie-destroy" || cmd.verb === "talkie-reconcile") {
        const { createTalkieUser, destroyTalkieUser, reconcileTalkieUser } = await import("./talkie-user.ts");
        return out(cmd.verb === "talkie-create" ? await createTalkieUser(sys, cmd.generation as string, cmd.instance as string)
          : cmd.verb === "talkie-reconcile" ? await reconcileTalkieUser(sys, cmd.generation as string, cmd.instance as string)
            : await destroyTalkieUser(sys, cmd.generation as string));
      }
      if (cmd.verb === "destroy" && cmd.idle) {
        // A leftover the daemon found in the helper's list, not one of its own seats: never while it runs anything.
        let live: number;
        try { live = sys.procs(seatUserUid(cmd.n)).length; } catch (err) { return out({ ok: false, name: seatUserName(cmd.n), uid: seatUserUid(cmd.n), why: `can't tell whether ${seatUserName(cmd.n)} still runs anything (${msg(err)}): not removed` }); }
        if (live) return out({ ok: false, code: "running", name: seatUserName(cmd.n), uid: seatUserUid(cmd.n), processesGone: false,
          why: `${seatUserName(cmd.n)} still has ${live} running process${live === 1 ? "" : "es"} and isn't one of this Walkie's current seats: not removed while it runs (checked again later)` });
      }
      return out(cmd.verb === "create" ? await createSeatUser(cmd.n, sys) : await destroySeatUser(cmd.n, sys));
    });
  } catch (err) {
    return out(err instanceof SeatAdminBusyError
      ? { ok: false, code: "busy", why: err.message }
      : { ok: false, code: "refused", why: `could not lock seat admin cleanup: ${msg(err)}` });
  }
}
