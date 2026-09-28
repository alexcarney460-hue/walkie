// Ephemeral seat users (PROTOCOL §11 "Seat users", SECURITY threat 13; SEATS-FIX-5): every seat runs as a user that
// is created for it and destroyed after it, and no uid or name is ever used twice. Reusing a uid let state cross runs
// in ways no wipe covers (home ACLs, files outside the home, the cron spool, launchd domains: Codex r5, Opus r5).
//
// This is the logic of the root helper `walkie-seat-admin` (installed root-owned by `walkie seats setup-user
// --apply`), which the daemon's user may run through sudo with exactly `seat-admin create <n>` or
// `seat-admin destroy <n>` (n an integer; the user is `walkie-s<n>`, uid 600000+n), or `seat-admin pending` (the
// ids of the calling person's that may still have something of them, for the daemon's restart). The system calls sit behind
// AdminSys, so the grammar and every verification here are tested with fakes (test/unit/seats-fix5.test.ts,
// seats-fix6.test.ts); the real one is admin-sys.ts.
//
// Root never deletes a file outside the seat's home by path (Codex r6 CRITICAL 1, HIGH 2): the seat user's own files
// are removed by the seat user itself (the runner's `sweep`, sweep.ts), before its account is deleted; root only
// stops its processes and services, removes its crontab, removes its home once the user emptied it (a directory of
// that user holding at most root's marker), and deletes the account.
import { readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { selfOp, type Ledger, type OpId } from "./admin-ledger.ts";
import { schedulerProblem } from "./seat-user.ts";

export const SEAT_USER_PREFIX = "walkie-s";
/** The sudo rule lets the daemon run the runner as any member of this group: every ephemeral seat user. */
export const SEATS_GROUP = "walkie-seats";
export const UID_BASE = 600_000;
export const MAX_N = 99_999;
export const SEAT_HOME_MARKER = ".walkie-seat-home";

export type AdminVerb = "create" | "destroy" | "pending";

/** `seat-admin <create|destroy> <n>` or `seat-admin pending`, nothing else: the fixed grammar sudo allows. */
export function parseAdminArgv(argv: readonly string[]): { verb: AdminVerb; n: number } | null {
  if (argv.length === 1 && argv[0] === "pending") return { verb: "pending", n: 0 };
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
  /** The id ledger (admin-ledger.ts). Throws when it can't be opened. */
  ledger(): Ledger;
  /** The person who asked (sudo's SUDO_UID): seat users are theirs, and only theirs are destroyed or listed. */
  caller(): number;
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
   * Its crontab removed (`crontab -u <name> -r`, only while the account exists), then the cron and at spools inspected
   * read-only by name and uid: the problem (something of it is scheduled, or the spools can't be read), or null.
   */
  removeSchedules(name: string, uid: number, exists: boolean): string | null;
  /** Mount points `uid` mounted (throws when it can't tell), and a forced unmount of one (Opus r7 4). */
  userMounts(uid: number): string[];
  unmount(path: string): void;
  /** The world-writable directories setup found on this machine, to sweep too (Opus r7 6). Throws when unknown. */
  extraRoots(): string[];
  /** The runner's `sweep` as the seat user (sweep.ts): verified, or what is left. */
  sweepAsUser(name: string, uid: number, roots: string[]): Promise<{ ok: boolean; left: string[] }>;
  sleep(ms: number): Promise<void>;
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
  ok: boolean; code?: "used" | "refused" | "failed" | "busy"; name?: string; uid?: number; home?: string; high?: number; why?: string;
  left?: string[]; ids?: number[];
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
    ledger.immediate(() => sys.denySchedulers(name)); // one helper at a time edits the deny files (Codex r6 HIGH 3)
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
async function endProcesses(uid: number, sys: AdminSys): Promise<void> {
  for (let i = 0; i < STOP_PASSES; i++) {
    const list = sys.procs(uid);
    if (list.every((p) => p.stat.startsWith("T"))) break;
    for (const p of list) try { sys.signal(p.pid, "SIGSTOP"); } catch { /* gone */ }
  }
  const wait = sys.killWaitMs ?? KILL_WAIT_MS;
  const until = Date.now() + wait;
  for (let list = sys.procs(uid); list.length; list = sys.procs(uid)) {
    if (Date.now() >= until) throw new Error(`${list.length} process${list.length === 1 ? "" : "es"} of it survived SIGKILL for ${wait / 1000} s`);
    for (const p of list) try { sys.signal(p.pid, "SIGKILL"); } catch { /* gone */ }
    await sys.sleep(50);
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

/**
 * `seat-admin destroy <n>`: everything of the user goes, verified, in an order every stage of which can run again
 * after partial progress (Codex r6 MEDIUM 5), and only while this destroy holds the id (Codex r7 HIGH 1: never at the
 * same time as its create or another destroy): its processes (a SIGSTOP sweep, then SIGKILL until none is left; any
 * survivor stops the destroy there, Codex r7 MEDIUM 2), its launchd/systemd services, its crontab (while the account
 * exists; the spools checked either way), its mounts (force-unmounted), its files (the user's own sweep, as itself,
 * while the account exists), its home (once empty), and only when all of that is verified, the account and its group.
 * A missing account means that stage was done: the account is deleted only after its files were verified gone and no
 * process of it was left. Anything unverified is listed in `left`; the uid is never reused anyway.
 */
export async function destroySeatUser(n: number, sys: AdminSys): Promise<AdminResult> {
  const name = seatUserName(n);
  const uid = seatUserUid(n);
  const home = seatHome(sys, n);
  let op: OpId;
  try { op = opOf(sys); } catch (err) { return { ok: false, name, uid, why: msg(err) }; }
  let ledger: Ledger;
  let taken: ReturnType<Ledger["takeForDestroy"]>;
  try {
    ledger = sys.ledger();
    const until = Date.now() + (sys.busyWaitMs ?? 20_000);
    for (taken = ledger.takeForDestroy(n, sys.caller(), op); !taken.ok && taken.busy && Date.now() < until; taken = ledger.takeForDestroy(n, sys.caller(), op)) await sys.sleep(250);
  } catch (err) { return { ok: false, why: `the helper's id ledger can't be used: ${msg(err)}` }; }
  if (!taken.ok) {
    return taken.busy
      ? { ok: false, code: "busy", name, uid, why: `a create or destroy of ${name} is still running (${taken.state}): not destroyed yet` }
      : { ok: false, name, uid, why: `${name}: ${taken.why}: not destroyed` };
  }
  if (taken.state === "cancelled") return { ok: true, name, uid }; // nothing was ever made for it
  const left: string[] = [];
  const step = <T>(what: string, f: () => T): T | undefined => { try { return f(); } catch (err) { left.push(`${what}: ${msg(err)}`); return undefined; } };
  const done = (): AdminResult => {
    const unique = [...new Set(left)];
    try {
      if (unique.length) ledger.release(n, op); else ledger.finish(n, op, "destroyed");
    } catch { /* the ledger keeps "destroying": a destroy again continues */ }
    return unique.length ? { ok: false, name, uid, left: unique, why: unique.join("; ") } : { ok: true, name, uid };
  };
  const u = step("the user", () => sys.lookup(name));
  if (u === undefined) return done();
  if (u && u.uid !== uid) { left.push(`${name} has uid ${u.uid}, not ${uid}: not this helper's, not touched`); return done(); }
  const exists = u !== null;
  const kill = async (when: string) => { try { await endProcesses(uid, sys); return true; } catch (err) { left.push(`processes (${when}): ${msg(err)}`); return false; } };
  if (!(await kill("before anything else"))) return done();
  const services = step("services", () => sys.stopUserServices(uid));
  if (services) left.push(`services: ${services}`);
  const schedules = step("schedules", () => sys.removeSchedules(name, uid, exists));
  if (schedules) left.push(`schedules: ${schedules}`);
  if (left.length || !(await kill("after its services"))) return done();
  // Mounts it made (a disk image, a FUSE mount) are unmounted by force: nothing of it hides under them (Opus r7 4).
  const mounts = step("mounts", () => sys.userMounts(uid));
  for (const m of mounts ?? []) step(`unmounting ${m}`, () => sys.unmount(m));
  const still = step("mounts", () => sys.userMounts(uid));
  if (still?.length) left.push(`mounts of it remain: ${still.slice(0, 3).join(", ")}`);
  if (left.length) return done();
  // An interrupted create's home, never handed to the user: removed by what setup made only (Codex r7 MEDIUM 4).
  const unused = step("its home", () => removeUnusedHome(home, uid, sys));
  if (unused) { left.push(`its home: ${unused}`); return done(); }
  if (exists) {
    const roots = step("the sweep's roots", () => sys.extraRoots());
    if (!roots) return done();
    // As the seat user itself: it can remove only what it may (Codex r6 CRITICAL 1, HIGH 2).
    const swept = await sys.sweepAsUser(name, uid, roots).catch((err: unknown) => ({ ok: false, left: [msg(err)] }));
    if (!swept.ok) left.push(`files it owns remain or couldn't be checked (${swept.left.slice(0, 5).join("; ") || "no answer"})`);
    if (left.length || !(await kill("after its sweep"))) return done();
  }
  const h = step("its home", () => removeEmptyHome(home, uid, sys));
  if (h) left.push(`its home: ${h}`);
  if (left.length || !(await kill("before its account is deleted"))) return done();
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
  try { return { ok: true, ids: sys.ledger().pending(sys.caller()) }; } catch (err) { return { ok: false, code: "refused", why: `the helper's id ledger can't be read: ${msg(err)}` }; }
}

/** `walkie seat-admin …`: root only, the fixed grammar only; one JSON line out. */
export async function runSeatAdmin(argv: readonly string[], sys: AdminSys): Promise<number> {
  const out = (r: AdminResult) => { process.stdout.write(`${JSON.stringify(r)}\n`); return r.ok ? 0 : 1; };
  if (process.getuid?.() !== 0) return out({ ok: false, code: "refused", why: "walkie seat-admin runs as root (through sudo) only" });
  const cmd = parseAdminArgv(argv);
  if (!cmd) return out({ ok: false, code: "refused", why: "usage: seat-admin create <n> | seat-admin destroy <n> | seat-admin pending" });
  try { sys.caller(); } catch (err) { return out({ ok: false, code: "refused", why: msg(err) }); }
  if (cmd.verb === "pending") return out(pendingSeatUsers(sys));
  return out(cmd.verb === "create" ? await createSeatUser(cmd.n, sys) : await destroySeatUser(cmd.n, sys));
}
