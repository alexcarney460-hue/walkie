// The real system calls of the root helper `walkie-seat-admin` (admin.ts): macOS (dscl, launchctl) and Linux
// (useradd/userdel, systemd). Runs as root, from the root-owned copy only, with cwd `/` and a fixed environment.
// Every inspection that can't tell throws (Codex r6 MEDIUM 6): "absent" is only ever a verified absence. Root never
// deletes a file outside a seat's home by path: the seat user's own sweep does that (sweepAsUser). The one exception is
// its crontab in the cron spool (a directory only root and cron itself write).
import { accessSync, chmodSync, chownSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { Database } from "bun:sqlite";
import { Ledger, processAlive, processStart, type HomeRetirementStore, type OpId, type TalkieOwnerRecord } from "./admin-ledger.ts";
import { AT_FDCWD, S_IFLNK, S_IFMT, closeFd, forceUnmount, listDir, mkdirAt, openDirAt, renameAtExclusive, statAt, userMounts, writeDurably } from "./fsat.ts";
import { validRoots } from "./runner-sweep.ts";
import { SEATS_GROUP, SEAT_HOME_MARKER, SEAT_USER_PREFIX, type AdminSys } from "./admin.ts";
import { DS_GROUP_ATTRS, macImplicitGids, parseDsGroups, parseDsUser } from "./mac-groups.ts";
import { runnerOp } from "./runner-child.ts";
import { verifySeatHomeResidue } from "./admin-home-residue.ts";
import { aclAllowsWrite, hasExtendedAcl, stripExtendedAcl } from "./admin-acl.ts";
import { SCHEDULER_FILES, SEAT_ROOTS_FILE, listAcl } from "./seat-user.ts";
import { sweep, type SweepResult } from "./sweep.ts";
import { instanceLockHeld } from "../instance-lock.ts";

const PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
let destroyDeadline = Infinity; // A root helper handles one command per process.

/** A connected Unix socket still has a daemon owner; a refused connection is a stale socket file. */
function liveSocket(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.setTimeout(1_000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") resolve(false);
      else reject(err);
    });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("shell socket probe timed out")); });
  });
}

type OpenFile = { fd: string; type: string; name: string; inode: string };

function openFiles(pid: number): OpenFile[] {
  const r = run(["lsof", "-nP", "-a", "-p", String(pid), "-Ffnti"], 5_000);
  if (r.code !== 0 || r.out.length > 1_000_000 || !r.out.startsWith(`p${pid}\n`))
    throw new Error("the invoking daemon's open files could not be checked");
  const files: OpenFile[] = [];
  let file: OpenFile | null = null;
  for (const line of r.out.split("\n")) {
    const tag = line[0];
    if (tag === "f") { if (file) files.push(file); file = { fd: line.slice(1), type: "", name: "", inode: "" }; }
    else if (file && tag === "t") file.type = line.slice(1);
    else if (file && tag === "n") file.name = line.slice(1);
    else if (file && tag === "i") file.inode = line.slice(1);
  }
  if (file) files.push(file);
  return files;
}

function sameLockName(openName: string, lockPath: string): boolean {
  if (!openName.startsWith("/")) return false;
  const name = openName.replace(/ \(deleted\)$/, "");
  if (basename(name) !== basename(lockPath)) return false;
  return join(realpathSync(dirname(name)), basename(name)) === join(realpathSync(dirname(lockPath)), basename(lockPath));
}

/** An unlinked old lock remains visible on its holder's fd; two holders for one pathname are ambiguous. */
function otherLockHolder(owner: number, lockPath: string, candidate: number): boolean {
  const r = run(["lsof", "-nP", "-u", String(owner), "-Fpfnti"], 5_000);
  if (r.code !== 0 || r.out.length > 16_000_000 || !r.out.startsWith("p"))
    throw new Error("the daemon's other lock holders could not be checked");
  let pid = 0;
  let file: OpenFile | null = null;
  const conflicting = () => pid !== candidate && file?.type === "REG" && /^\d/.test(file.fd)
    && sameLockName(file.name, lockPath);
  for (const line of r.out.split("\n")) {
    if (line[0] === "p") { if (conflicting()) return true; pid = Number(line.slice(1)); file = null; }
    else if (line[0] === "f") { if (conflicting()) return true; file = { fd: line.slice(1), type: "", name: "", inode: "" }; }
    else if (file && line[0] === "t") file.type = line.slice(1);
    else if (file && line[0] === "n") file.name = line.slice(1);
  }
  return !!conflicting();
}

function isBoundDaemon(pid: number, owner: number, instance: string): boolean {
  const files = openFiles(pid);
  const sockets = files.filter((f) => /^\d/.test(f.fd) && f.type === "unix" && f.name.startsWith("/")
    && createHash("sha256").update(resolve(f.name)).digest("hex") === instance);
  if (sockets.length !== 1) return false;
  const socketPath = sockets[0]!.name;
  const socket = lstatSync(socketPath);
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== owner) return false;
  const lockPath = `${socketPath}.lock`;
  const lock = lstatSync(lockPath);
  if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== owner || (lock.mode & 0o077) !== 0) return false;
  const locks = files.filter((f) => /^\d/.test(f.fd) && f.type === "REG" && f.name.startsWith("/")
    && realpathSync(f.name) === realpathSync(lockPath) && f.inode === String(lock.ino));
  if (locks.length !== 1 || !instanceLockHeld(lockPath)) return false;
  if (otherLockHolder(owner, lockPath, pid)) throw new Error("the invoking daemon's instance lock has another live holder");
  const executable = files.find((f) => f.fd === "txt" && f.type === "REG" && f.name.startsWith("/"));
  if (!executable) throw new Error("the invoking daemon's executable could not be checked");
  const executableFile = lstatSync(executable.name);
  if (!executableFile.isFile() || executableFile.isSymbolicLink() || executable.inode !== String(executableFile.ino))
    throw new Error("the invoking daemon's executable changed during inspection");
  // setup-user copies the release binary to the root helper path, so compare bytes rather than path names.
  const expected = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  return createHash("sha256").update(readFileSync(executable.name)).digest("hex") === expected;
}

/** Root binds the sudo caller's ancestor to its listening socket, held lock, and installed executable. */
export function callingTalkieDaemon(owner: number, instance: string, parent = process.ppid): OpId {
  if (!/^[0-9a-f]{64}$/.test(instance)) throw new Error("the invoking daemon's instance is invalid");
  let pid = parent;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const r = run(["/bin/ps", "-ww", "-p", String(pid), "-o", "ppid=,uid=,lstart=,command="], 5_000);
    if (r.code !== 0) throw new Error("the invoking daemon's process chain could not be checked");
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/m.exec(r.out);
    if (!match) throw new Error("the invoking daemon's process identity is ambiguous");
    const start = (match[3] as string).trim();
    if (Number(match[2]) === owner && isBoundDaemon(pid, owner, instance)) {
      if (processStart(pid) !== start) throw new Error("the invoking daemon changed during inspection");
      return { pid, start };
    }
    pid = Number(match[1]);
  }
  throw new Error("the invoking daemon could not be identified");
}

/** The root-owned process identity survives unlinking daemon-owned lease and socket paths. */
export async function checkTalkieDaemonStopped(root: string, owner: number, generation: string | null, daemon: OpId | null = null):
  Promise<{ ok: boolean; why?: string }> {
  try {
    if (!daemon || !Number.isSafeInteger(daemon.pid) || daemon.pid <= 1 || !daemon.start)
      throw new Error("the root-owned daemon process identity is missing");
    if (processAlive(daemon)) return { ok: false, why: "the recorded daemon process is still live; stop WalkieTalkie before repair" };
    const prefix = `walkie-seats-${owner}-`;
    for (const name of readdirSync(root)) {
      if (!name.startsWith(prefix) || !/^walkie-seats-\d+-[0-9a-f]{16}$/.test(name)) continue;
      const dir = join(root, name);
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== owner)
        throw new Error(`${dir} could not be verified as the daemon's socket directory`);
      const leasePath = join(dir, "uid-lease.json");
      try {
        const leaseStat = lstatSync(leasePath);
        if (!leaseStat.isFile() || leaseStat.isSymbolicLink() || leaseStat.uid !== owner || leaseStat.size > 4_096)
          throw new Error(`${leasePath} is not a trusted lease file`);
        const lease: unknown = JSON.parse(readFileSync(leasePath, "utf8"));
        if (!lease || typeof lease !== "object" || !("run" in lease) || typeof lease.run !== "string"
          || !("expires" in lease) || typeof lease.expires !== "number" || !Number.isFinite(lease.expires))
          throw new Error(`${leasePath} could not be verified`);
        if (Date.now() < lease.expires)
          return { ok: false, why: `the ${lease.run === generation ? "recorded " : "other "}daemon lease is still live; stop WalkieTalkie before repair` };
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      const socket = join(dir, "talkie.sock");
      try {
        const socketStat = lstatSync(socket);
        if (!socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.uid !== owner)
          throw new Error(`${socket} is not a trusted shell socket`);
        if (await liveSocket(socket)) return { ok: false, why: "the shell socket still has a live owner; stop WalkieTalkie before repair" };
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
    if (processAlive(daemon)) return { ok: false, why: "the recorded daemon process is still live; stop WalkieTalkie before repair" };
    return { ok: true };
  } catch (err) { return { ok: false, why: `the daemon process, lease and socket could not be checked: ${errCode(err)}` }; }
}

/** Root's empty-uid check has no proof that a noted mount or skipped subtree excludes the uid. */
export function emptyUidSweepVerification(result: SweepResult): { ok: boolean; left: string[] } {
  const left = [...result.left, ...result.problems, ...result.notes];
  return { ok: result.complete && left.length === 0, left: left.slice(0, 5) };
}

/** Find only an executable that the root helper's fixed PATH could run. */
export function crontabBinary(): string | null {
  for (const dir of PATH.split(":")) {
    const path = join(dir, "crontab");
    try { accessSync(path, constants.X_OK); return path; } catch { /* next directory */ }
  }
  return null;
}

/** macOS only: isolate a verified seat home without following its path as a symlink. */
export function retireSeatHome(home: string, uid: number, name: string, retirement: HomeRetirementStore): { path: string; bytes: number } | null {
  if (!/^walkie-s[1-9]\d{0,4}$/.test(name) || home !== `/Users/${name}` || uid !== 600_000 + Number(name.slice(8)))
    throw new Error("unexpected seat home identity");
  return retireSeatHomeIn("/Users", 0, 0, uid, name, retirement);
}

/** Handle-relative retirement. `usersRoot` and owner ids are injectable only for temporary-directory tests. */
export function retireSeatHomeIn(usersRoot: string, rootUid: number, rootGid: number, uid: number, name: string,
  retirement?: HomeRetirementStore): { path: string; bytes: number } | null {
  if (!/^walkie-s[1-9]\d{0,4}$/.test(name) || !usersRoot.startsWith("/") || name.includes("/"))
    throw new Error("unexpected seat home identity");
  const observedUsers = statAt(AT_FDCWD(), usersRoot);
  const users = openDirAt(AT_FDCWD(), usersRoot);
  try {
    const usersSt = fstatSync(users);
    if (usersSt.dev !== observedUsers.dev || usersSt.ino !== observedUsers.ino || !usersSt.isDirectory()
      || usersSt.uid !== rootUid || (usersSt.mode & 0o022) !== 0 || aclAllowsWrite(users))
      throw new Error("the users directory grants non-root write access");
    let source: ReturnType<typeof statAt> | null = null;
    try { source = statAt(users, name); } catch (err) { if ((err as { code?: string }).code !== "ENOENT") throw err; }
    let createdParent = false;
    if (source) try { mkdirAt(users, ".walkie-retired", 0o700); createdParent = true; }
      catch (err) { if ((err as { code?: string }).code !== "EEXIST") throw err; }
    let parentSt: ReturnType<typeof statAt>;
    try { parentSt = statAt(users, ".walkie-retired"); }
    catch (err) {
      if (!source && (err as { code?: string }).code === "ENOENT") {
        if (retirement?.read()) throw new Error("the recorded tombstone parent is missing");
        return null;
      }
      throw err;
    }
    const parent = openDirAt(users, ".walkie-retired");
    try {
      if (createdParent) {
        fchownSync(parent, rootUid, rootGid);
        fchmodSync(parent, 0o700);
        stripExtendedAcl(parent);
      }
      const parentOpened = fstatSync(parent);
      if (parentSt.dev !== parentOpened.dev || parentSt.ino !== parentOpened.ino || !parentOpened.isDirectory()
        || parentOpened.uid !== rootUid || parentOpened.gid !== rootGid || (parentOpened.mode & 0o777) !== 0o700
        || hasExtendedAcl(parent)) throw new Error("the retired-home directory is not root:wheel 0700 without ACLs");
      const priorRecord = retirement?.read() ?? null;
      if (priorRecord && (priorRecord.uid !== uid || !new RegExp(`^${name}-${uid}-[0-9a-f]{32}$`).test(priorRecord.tombstone)))
        throw new Error("the home retirement provenance is invalid");
      const destName = priorRecord?.tombstone ?? `${name}-${uid}-${createHash("sha256")
        .update(`${uid}\0${retirement?.op.pid ?? 0}\0${retirement?.op.start ?? "missing"}`).digest("hex").slice(0, 32)}`;
      const dest = join(usersRoot, ".walkie-retired", destName);
      if (!source) {
        if (!priorRecord) {
          const prefix = `${name}-${uid}`;
          if (listDir(parent).some((entry) => { const label = Buffer.from(entry).toString("utf8"); return label === prefix || label.startsWith(`${prefix}-`); }))
            throw new Error("an existing seat tombstone has no provenance");
          return null;
        }
        let previous: ReturnType<typeof statAt>;
        try { previous = statAt(parent, destName); } catch (err) {
          if ((err as { code?: string }).code === "ENOENT") throw new Error("the recorded tombstone is missing");
          throw err;
        }
        const prior = openDirAt(parent, destName);
        try {
          const st = fstatSync(prior);
          if (st.dev !== previous.dev || st.ino !== previous.ino || st.dev !== priorRecord.sourceDev || st.ino !== priorRecord.sourceIno)
            throw new Error("the existing tombstone does not match its provenance");
          if (!st.isDirectory() || st.uid !== rootUid
            || st.gid !== rootGid || (st.mode & 0o777) !== 0o700 || hasExtendedAcl(prior))
            throw new Error("the existing seat tombstone is not root:wheel 0700 without ACLs");
          return { path: dest, bytes: st.size };
        } finally { closeFd(prior); }
      }
      if ((source.mode & S_IFMT) !== 0o040000 || source.uid !== uid) throw new Error("the seat home is not its user's real directory");
      const fd = openDirAt(users, name);
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== source.dev || opened.ino !== source.ino || opened.uid !== uid)
          throw new Error("the seat home changed before retirement");
        if (!retirement) throw new Error("the home retirement has no provenance store");
        retirement.prepare({ uid, sourceDev: opened.dev, sourceIno: opened.ino, tombstone: destName });
        stripExtendedAcl(fd);
        fchmodSync(fd, 0o700);
        fchownSync(fd, rootUid, rootGid);
        const locked = fstatSync(fd);
        if (locked.uid !== rootUid || locked.gid !== rootGid || (locked.mode & 0o777) !== 0o700 || hasExtendedAcl(fd))
          throw new Error("the seat home could not be locked root:wheel 0700 without ACLs");
        // Accepted: a holder of an already-open ACL-writable child descriptor can add an entry after the residue walk.
        // It stays inside the root-only tombstone; retirement does not traverse that child again.
        renameAtExclusive(users, name, parent, destName);
        const moved = statAt(parent, destName);
        if (moved.dev !== opened.dev || moved.ino !== opened.ino) throw new Error("the seat home tombstone changed after rename");
        const movedFd = openDirAt(parent, destName);
        try {
          const st = fstatSync(movedFd);
          if (st.dev !== opened.dev || st.ino !== opened.ino || st.uid !== rootUid || st.gid !== rootGid
            || (st.mode & 0o777) !== 0o700 || hasExtendedAcl(movedFd))
            throw new Error("the seat home tombstone could not be verified");
          try { statAt(users, name); throw new Error("the original seat home still exists"); }
          catch (err) { if ((err as { code?: string }).code !== "ENOENT") throw err; }
          return { path: dest, bytes: st.size };
        } finally { closeFd(movedFd); }
      } finally { closeFd(fd); }
    } finally { closeFd(parent); }
  } finally { closeFd(users); }
}

export function openTalkieLedgerReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true, create: false });
  try { db.exec("PRAGMA busy_timeout = 5000"); return db; }
  catch (err) { db.close(); throw err; }
}

/** Old installed ledgers may lack newer ownership columns; absence is never treated as an owner match. */
export function readTalkieOwnerReadOnly(db: Database, uid: number): TalkieOwnerRecord | null {
  const columns = new Set((db.query("PRAGMA table_info(talkie_owner)").all() as Array<{ name: string }>).map((row) => row.name));
  if (columns.size === 0) return null;
  if (!columns.has("owner") || !columns.has("state")) throw new Error("the dedicated account owner ledger is incomplete");
  const optional = ["generation", "instance", "op_pid", "op_start", "daemon_pid", "daemon_start"] as const;
  const fields = optional.map((name) => columns.has(name) ? name : `NULL AS ${name}`);
  return db.query(`SELECT owner, state, ${fields.join(", ")} FROM talkie_owner WHERE uid = ?`).get(uid) as TalkieOwnerRecord | null;
}

/** A missing ledger has no reservations; an existing but old or unsafe one fails closed without migration. */
export function readSeatPendingReadOnly(path: string, owner: number, root = true): ReturnType<AdminSys["pendingReadOnly"]> {
  const empty = { ids: [], summary: { homes: 0, vaults: 0, knownBytes: 0 } };
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(path); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty; throw err; }
  if (!st.isFile() || (root && (st.uid !== 0 || (st.mode & 0o022) !== 0)))
    throw new Error("the root ownership ledger is unsafe");
  const db = openTalkieLedgerReadOnly(path);
  try {
    const ids = (db.query("SELECT n FROM ids WHERE (owner = ? OR owner = -1) AND state IN ('reserved','making','created','destroying') ORDER BY n")
      .all(owner) as Array<{ n: number }>).map((row) => row.n);
    const rows = db.query("SELECT kind, COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM seat_residue WHERE owner = ? GROUP BY kind")
      .all(owner) as Array<{ kind: string; count: number; bytes: number }>;
    return { ids, summary: { homes: rows.find((row) => row.kind === "home")?.count ?? 0,
      vaults: rows.find((row) => row.kind === "vault")?.count ?? 0,
      knownBytes: rows.reduce((sum, row) => sum + row.bytes, 0) } };
  } finally { db.close(); }
}

function run(argv: string[], timeoutMs = 60_000): { code: number; out: string; err: string } {
  const remaining = destroyDeadline - Date.now();
  if (remaining <= 0) throw new Error("cleanup timed out; retried later");
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: "/", env: { PATH, LC_ALL: "C" }, timeout: Math.max(1, Math.min(timeoutMs, remaining)) });
  if (Date.now() >= destroyDeadline) throw new Error("cleanup timed out; retried later");
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** macOS ps exit 1 is an empty list only after the numeric account is verified absent. */
export function psShowsNoProcesses(r: { code: number; out: string; err: string }, mac: boolean, accountGone: () => boolean): boolean {
  return r.code === 1 && r.out.trim() === "" && r.err.trim() === "" && (!mac || accountGone());
}

/** A successful bootout alone is not proof that a launchd user domain has disappeared. */
export function stopMacSeatServices(uid: number, exec: (argv: string[]) => { code: number; out: string; err: string } = run): string | null {
  const problems: string[] = [];
  const absent = /no such process|could not find domain|boot-out failed: 3:|boot-out failed: 113:/i;
  for (const domain of [`gui/${uid}`, `user/${uid}`]) {
    const stopped = exec(["launchctl", "bootout", domain]);
    if (stopped.code !== 0 && !absent.test(stopped.err + stopped.out)) {
      problems.push(`launchctl bootout ${domain} (${stopped.code}): ${stopped.err.trim().slice(0, 120)}`);
    }
    const checked = exec(["launchctl", "print", domain]);
    if (checked.code === 0) problems.push(`launchctl ${domain} remains loaded`);
    else if (!absent.test(checked.err + checked.out)) problems.push(`launchctl ${domain} could not be verified absent (${checked.code})`);
  }
  return problems.length ? problems.join("; ") : null;
}

function must(argv: string[]): string {
  const r = run(argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed (${r.code}): ${r.err.trim().slice(0, 200)}`);
  return r.out;
}

/**
 * A file replaced atomically and durably: an exclusive temporary file, flushed to the disk itself (F_FULLFSYNC on
 * macOS: Opus r7 INFO 9), renamed, the directory flushed too.
 */
export function writeRoot(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeDurably(path, text, mode);
}



/** A user of this name: true, false (verified absent), or throws. */
function userExists(name: string): boolean {
  const r = run(["id", "-u", name]);
  if (r.code === 0) return true;
  if (r.code === 1 && /no such user/i.test(r.err)) return false;
  throw new Error(`id ${name} failed (${r.code}): ${r.err.trim().slice(0, 120)}`);
}

/** A group of this name: true, false (verified absent), or throws. */
function groupExists(name: string, mac: boolean): boolean {
  if (mac) {
    const r = run(["dscl", ".", "-read", `/Groups/${name}`, "PrimaryGroupID"]);
    if (r.code === 0) return true;
    if (/eDSRecordNotFound|-14136/.test(r.err + r.out)) return false;
    throw new Error(`dscl -read /Groups/${name} failed (${r.code})`);
  }
  const r = run(["getent", "group", name]);
  if (r.code === 0) return true;
  if (r.code === 2) return false;
  throw new Error(`getent group ${name} failed (${r.code})`);
}

/** Entries of `dir` owned by `uid` (read-only; a missing directory holds none; anything else unreadable throws). */
function ownedIn(dir: string, uid: number): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => {
    try { return lstatSync(join(dir, n)).uid === uid; } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return false;
      throw err;
    }
  });
}

/** The cron spool directories that hold a user's crontab as `<dir>/<name>` (macOS: /usr/lib/cron is /var/at). */
export const CRON_TABS: Record<"darwin" | "linux", string[]> = {
  darwin: ["/usr/lib/cron/tabs", "/var/at/tabs"],
  linux: ["/var/spool/cron/crontabs", "/var/spool/cron"],
};

const errCode = (err: unknown) => (err as { code?: string }).code ?? (err as Error).message;

/**
 * A crontab of `name` removed from the root-only spool directly. Seat users are in cron.deny, so root unlinks
 * `<dir>/<name>` after lstat confirms it is a regular file, then verifies it gone. None there: nothing to remove.
 */
export function removeSpoolCrontab(name: string, tabs: readonly string[]): string | null {
  for (const d of tabs) {
    const p = join(d, name);
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(p); } catch (err) {
      if (errCode(err) === "ENOENT") continue;
      return `${p} can't be checked (${errCode(err)})`;
    }
    if (st.isDirectory()) return `${p} is a directory, not a crontab`;
    if (!st.isFile()) return `${p} is a ${st.isSymbolicLink() ? "symbolic link" : "non-file entry"}, not a crontab`;
    try { unlinkSync(p); } catch (err) {
      if (errCode(err) !== "ENOENT") return `${p} could not be removed (${errCode(err)})`;
    }
    try { lstatSync(p); return `${p} is still there after it was removed`; } catch (err) {
      if (errCode(err) !== "ENOENT") return `${p} can't be checked after it was removed (${errCode(err)})`;
    }
  }
  return null;
}

/** Remove a live account's crontab from the spool, then inspect every known spool by both name and uid. */
export function removeSeatSchedules(name: string, uid: number, exists: boolean, tabs: readonly string[], jobs: readonly string[]): string | null {
  if (exists) {
    const why = removeSpoolCrontab(name, tabs);
    if (why) return why;
  }
  const left: string[] = [];
  for (const d of tabs) {
    const st = (() => { try { return lstatSync(join(d, name)); } catch (err) { if ((err as { code?: string }).code === "ENOENT") return null; throw err; } })();
    if (st) left.push(`${d}/${name}`);
    left.push(...ownedIn(d, uid).map((f) => `${d}/${f}`));
  }
  for (const d of jobs) left.push(...ownedIn(d, uid).map((f) => `${d}/${f}`));
  return left.length ? `scheduled jobs of it remain (${[...new Set(left)].slice(0, 5).join(", ")})` : null;
}

export function realAdminSys(): AdminSys {
  const mac = process.platform === "darwin";
  const platform = mac ? "darwin" : "linux";
  // /var is a symlink on macOS; use its real root-owned directory chain for lock verification.
  const ledgerPath = mac ? "/private/var/db/walkie-seat-admin.sqlite" : "/var/lib/walkie/seat-admin.sqlite";
  const files = SCHEDULER_FILES[platform];
  // The runner is the helper's sibling in the root-owned install directory (walkie seats setup-user --apply).
  const runnerPath = join(dirname(process.execPath), "walkie-seat-runner");
  const rootsPath = join(dirname(process.execPath), SEAT_ROOTS_FILE);
  let ledger: Ledger | null = null;
  return {
    platform,
    setDestroyDeadline: (deadline) => { destroyDeadline = deadline ?? Infinity; },
    schedulerFiles: files,
    caller() {
      // sudo sets SUDO_UID itself (the caller can't): the person whose daemon asked.
      const v = process.env.SUDO_UID;
      if (!v || !/^\d{1,10}$/.test(v)) throw new Error("walkie seat-admin runs through sudo only (no SUDO_UID)");
      return Number(v);
    },
    userMounts,
    unmount: forceUnmount,
    extraRoots() {
      const st = lstatSync(rootsPath); // missing: throws (setup-user --apply writes it)
      if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0) throw new Error(`${rootsPath} is not a file only root can write`);
      const roots = validRoots(JSON.parse(readFileSync(rootsPath, "utf8")));
      if (!roots) throw new Error(`${rootsPath} doesn't hold a list of directories (re-run: walkie seats setup-user --apply)`);
      return roots;
    },
    ledger() {
      if (!ledger) { mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o755 }); ledger = new Ledger(ledgerPath, true); }
      return ledger;
    },
    pendingReadOnly: (owner) => readSeatPendingReadOnly(ledgerPath, owner),
    talkieLockPath: `${ledgerPath}.talkie.lock`,
    talkieLockRoot: true,
    seatAdminLockPath: `${ledgerPath}.cleanup.lock`,
    talkieOwnerReadOnly(uid) {
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(ledgerPath); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0)
        throw new Error("the root ownership ledger is unsafe");
      const db = openTalkieLedgerReadOnly(ledgerPath);
      try { return readTalkieOwnerReadOnly(db, uid); }
      finally { db.close(); }
    },
    verifyEmptyTalkieUid(uid) {
      // The account is gone, so sudo -u cannot perform the normal destructive sweep. Inspect the
      // same shared roots as root, including all macOS per-user folders, without changing entries.
      const roots = mac ? ["/private/tmp", "/private/var/tmp", "/Users/Shared", "/Library/Caches", "/private/var/folders"]
        : ["/tmp", "/var/tmp", "/dev/shm", `/run/user/${uid}`];
      const result = sweep([...roots, ...this.extraRoots()].map((path) => ({ path })), (st) => st.uid === uid,
        { remove: false, canWrite: () => true, verifySkippedSubtrees: true });
      return emptyUidSweepVerification(result);
    },
    talkieDaemonIdentity(owner, instance) { return callingTalkieDaemon(owner, instance); },
    talkieGenerationStopped(generation, owner, daemon) { return checkTalkieDaemonStopped("/tmp", owner, generation, daemon); },
    nameTaken(name) { return userExists(name) || groupExists(name, mac); },
    idTaken(id) {
      if (mac) {
        // id uses the system directory service, including network-bound accounts; dscl . sees only local users.
        const global = run(["id", "-nu", String(id)]);
        if (global.code === 0) return true;
        if (global.code !== 1 || !/no such user/i.test(global.err)) throw new Error(`id -nu ${id} failed (${global.code})`);
        const u = must(["dscl", ".", "-search", "/Users", "UniqueID", String(id)]);
        const g = must(["dscl", ".", "-search", "/Groups", "PrimaryGroupID", String(id)]);
        return u.trim() !== "" || g.trim() !== "";
      }
      const found = (db: string) => {
        const r = run(["getent", db, String(id)]);
        if (r.code === 0) return true;
        if (r.code === 2) return false;
        throw new Error(`getent ${db} ${id} failed (${r.code})`);
      };
      return found("passwd") || found("group");
    },
    lookup(name) {
      if (name === SEATS_GROUP && !userExists(name)) {
        if (!groupExists(name, mac)) return null;
        const g = mac ? must(["dscl", ".", "-read", `/Groups/${name}`, "PrimaryGroupID"]) : must(["getent", "group", name]);
        const m = mac ? /PrimaryGroupID:\s*(\d+)/.exec(g) : /^[^:]*:[^:]*:(\d+):/.exec(g);
        if (!m) throw new Error(`the ${name} group has no id`);
        return { uid: -1, gid: Number(m[1]), gids: [] };
      }
      if (!userExists(name)) return null;
      return { uid: Number(must(["id", "-u", name]).trim()), gid: Number(must(["id", "-g", name]).trim()), gids: must(["id", "-G", name]).trim().split(/\s+/).map(Number) };
    },
    implicitGroups(name, gids) {
      if (!mac) return [];
      // Direct membership in the local directory, not `id -G` (which also counts nesting of everyone/localaccounts).
      const user = parseDsUser(must(["dscl", ".", "-read", `/Users/${name}`, "GeneratedUID", "PrimaryGroupID"]));
      const groups = parseDsGroups(must(["dscl", ".", "-readall", "/Groups", ...DS_GROUP_ATTRS]));
      if (!groups.length) throw new Error("dscl listed no local groups");
      return macImplicitGids({ name, ...user }, gids, groups);
    },
    createUser({ name, uid, home }) {
      if (mac) {
        const g = `/Groups/${name}`;
        const u = `/Users/${name}`;
        must(["dscl", ".", "-create", g]);
        must(["dscl", ".", "-create", g, "PrimaryGroupID", String(uid)]);
        must(["dscl", ".", "-create", u]);
        for (const [k, v] of [["UserShell", "/usr/bin/false"], ["RealName", `Walkie seat ${name.slice(SEAT_USER_PREFIX.length)}`], ["UniqueID", String(uid)],
          ["PrimaryGroupID", String(uid)], ["NFSHomeDirectory", home], ["Password", "*"], ["IsHidden", "1"]] as const) {
          must(["dscl", ".", "-create", u, k, v]);
        }
        must(["dseditgroup", "-o", "edit", "-a", name, "-t", "user", SEATS_GROUP]);
      } else {
        must(["groupadd", "-g", String(uid), name]);
        must(["useradd", "-u", String(uid), "-g", String(uid), "-G", SEATS_GROUP, "-M", "-d", home, "-s", "/usr/sbin/nologin", name]);
      }
    },
    deleteUser(name) {
      if (mac) {
        if (userExists(name)) {
          run(["dseditgroup", "-o", "edit", "-d", name, "-t", "user", SEATS_GROUP]);
          must(["dscl", ".", "-delete", `/Users/${name}`]);
        }
        if (groupExists(name, true)) must(["dscl", ".", "-delete", `/Groups/${name}`]);
      } else {
        if (userExists(name)) must(["userdel", name]);
        if (groupExists(name, false)) must(["groupdel", name]);
      }
    },
    makeHome(home, uid) {
      // Root's until the very end: an interruption leaves a home the user never wrote in (Codex r7 MEDIUM 4).
      mkdirSync(home, { mode: 0o700 }); // not recursive: fresh
      chmodSync(home, 0o700);
      mkdirSync(join(home, "walkie-seats"), { mode: 0o700 });
      writeFileSync(join(home, SEAT_HOME_MARKER), "", { mode: 0o444, flag: "wx" }); // root's
      chownSync(join(home, "walkie-seats"), uid, uid);
      chownSync(home, uid, uid);
    },
    retireHome: retireSeatHome,
    verifyHomeResidue: verifySeatHomeResidue,
    acl: listAcl,
    stat(path) {
      try {
        const st = lstatSync(path);
        return { uid: st.uid, mode: st.mode, dir: st.isDirectory(), file: st.isFile(), symlink: st.isSymbolicLink() };
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return null;
        throw err;
      }
    },
    vaultStat(path) {
      try {
        const native = statAt(AT_FDCWD(), path);
        const node = lstatSync(path);
        if (native.dev !== node.dev || native.ino !== node.ino || native.uid !== node.uid)
          throw new Error(`${path} changed while checking Apple cache protection`);
        return { uid: native.uid, flags: native.flags ?? 0, bytes: node.size,
          symlink: (native.mode & S_IFMT) === S_IFLNK || node.isSymbolicLink() };
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return null;
        throw err;
      }
    },
    denySchedulers(name) {
      for (const f of [files.cron[1], files.at[1]]) {
        const text = existsSync(f) ? readFileSync(f, "utf8") : "";
        if (text.split("\n").includes(name)) continue;
        writeRoot(f, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${name}\n`, 0o644);
      }
    },
    readSchedulerFile(p) { return existsSync(p) ? readFileSync(p, "utf8") : null; },
    procs(uid) {
      const r = run(["ps", "-U", String(uid), "-o", "pid=,stat="]);
      if (psShowsNoProcesses(r, mac, () => !this.idTaken(uid))) return [];
      if (r.code !== 0) throw new Error(`ps failed (${r.code})`);
      return r.out.split("\n").map((l) => /^\s*(\d+)\s+(\S+)/.exec(l)).filter((m): m is RegExpExecArray => !!m && !(m[2] as string).startsWith("Z"))
        .map((m) => ({ pid: Number(m[1]), stat: m[2] as string }));
    },
    signal(pid, sig) { process.kill(pid, sig); },
    stopUserServices(uid) {
      if (mac) return stopMacSeatServices(uid);
      if (!existsSync("/usr/bin/systemctl") && !existsSync("/bin/systemctl")) return null; // no systemd: no user manager
      const unit = `user@${uid}.service`;
      const stop = run(["systemctl", "stop", unit]);
      if (stop.code !== 0 && !(stop.code === 5 && /not loaded/i.test(stop.err))) return `systemctl stop ${unit} failed (${stop.code}): ${stop.err.trim().slice(0, 120)}`;
      // `is-active` exits 0 only when active; otherwise it names the state. Anything else can't tell (Codex r7 MEDIUM 5).
      const r = run(["systemctl", "is-active", unit]);
      const active = r.out.trim();
      if (r.code !== 0 && ["inactive", "failed", "unknown"].includes(active)) return null;
      return r.code === 0 ? `${unit} is ${active || "active"}` : `systemctl is-active ${unit} couldn't tell (${r.code}: ${JSON.stringify(active)})`;
    },
    removeSchedules(name, uid, exists) {
      const tabs = CRON_TABS[platform];
      const jobs = mac ? ["/usr/lib/cron/jobs"] : ["/var/spool/cron/atjobs", "/var/spool/at"];
      return removeSeatSchedules(name, uid, exists, tabs, jobs);
    },
    async sweepAsUser(name, _uid, roots, residueFolders = [], timeoutMs = 30 * 60_000) {
      // root → the seat user through sudo (initgroups: its own groups only), cwd /, a fixed environment.
      const op = residueFolders.length ? "talkie-sweep" : "sweep";
      const r = await runnerOp(["sudo", "-n", "-u", name, "--", runnerPath, "seat-runner"], op, timeoutMs,
        { roots, residueFolders });
      if (!r) return { ok: false, left: ["the seat user's sweep didn't answer"] };
      return { ok: r.verified, left: r.verified ? [] : [...(r.samples ?? []), ...(r.why ? [r.why] : []), ...(r.left !== undefined ? [`${r.left} left`] : [])], leftoverDirs: r.verified ? r.leftoverDirs : [], residuePaths: r.verified ? r.residuePaths : [], residueProofs: r.verified ? r.residueProofs : [] };
    },
    async dropClaudeProjection(name, _uid, timeoutMs = 30_000) {
      const r = await runnerOp(["sudo", "-n", "-u", name, "--", runnerPath, "seat-runner"], "drop-claude", Math.min(30_000, timeoutMs));
      return r?.verified === true;
    },
    sleep: (ms) => Bun.sleep(ms),
  };
}
