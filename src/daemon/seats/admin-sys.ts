// The real system calls of the root helper `walkie-seat-admin` (admin.ts): macOS (dscl, launchctl) and Linux
// (useradd/userdel, systemd). Runs as root, from the root-owned copy only, with cwd `/` and a fixed environment.
// Every inspection that can't tell throws (Codex r6 MEDIUM 6): "absent" is only ever a verified absence. Root never
// deletes a file outside a seat's home by path: the seat user's own sweep does that (sweepAsUser). The one exception is
// its crontab in the cron spool (a directory only root and cron itself write).
import { accessSync, chmodSync, chownSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
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
import { O_CLOEXEC, instanceLockHeld } from "../instance-lock.ts";
import { SEAT_INSTANCE_FILE, canonicalPath, otherScopeWhy, readSeatRegistration, type SeatInstanceCheck } from "./instance.ts";

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

/**
 * lsof's NAME for a unix socket this process bound, or null.
 * Linux lsof 4.95 `-F` appends ` type=STREAM` (also DGRAM or SEQPACKET). `(LISTEN)` and `(CONNECTED)` are only in
 * lsof's default columns, not in `-F` (checked on lsof 4.95.0). macOS lsof prints the bound path alone in NAME, and
 * prints an accepted connection the same way (no inode). A connected peer is `->0x` plus a kernel address, never the
 * path, so a path-named socket belongs to the binding process. A name that says `(CONNECTED)` is a peer.
 * `(deleted)`, `type=…` and `(LISTEN)` may sit in either order, so each is peeled until the path is left.
 */
export function lsofBoundSocketPath(name: string): string | null {
  if (name.startsWith("->")) return null;
  let path = name;
  for (let i = 0; i < 4; i++) {
    if (/ \(CONNECTED\)$/.test(path)) return null;
    const next = path.replace(/ \((?:LISTEN|deleted)\)$/, "").replace(/ type=\S+$/, "");
    if (next === path) break;
    path = next;
  }
  if (/ \(CONNECTED\)$/.test(path) || !path.startsWith("/") || path.includes("\0")) return null;
  return path;
}

/** `lsof -nP -a -p <pid> -Ffnti`. Null when the output is not that one process. */
export function parseLsofOpenFiles(out: string, pid: number): OpenFile[] | null {
  if (!out.startsWith(`p${pid}\n`)) return null;
  const files: OpenFile[] = [];
  let file: OpenFile | null = null;
  for (const line of out.split("\n")) {
    const tag = line[0];
    if (tag === "f") { if (file) files.push(file); file = { fd: line.slice(1), type: "", name: "", inode: "" }; }
    else if (file && tag === "t") file.type = line.slice(1);
    else if (file && tag === "n") file.name = line.slice(1);
    else if (file && tag === "i") file.inode = line.slice(1);
  }
  if (file) files.push(file);
  return files;
}

/** True when a numeric fd is a unix socket bound to `socketPath` (peer `->` names do not count). */
export function lsofHoldsBoundSocket(files: readonly OpenFile[], socketPath: string): boolean {
  return acceptsPathNamedBoundSockets(files, socketPath);
}

/**
 * macOS: one or more path-named unix sockets at `socketPath` means this process bound it. lsof names the listening
 * socket and each accepted connection with that path (no inode), so exactly one would refuse the daemon whenever a
 * client is connected. A client is `->0x<address>` and counts as none. Linux still tells the listener from an accepted
 * fd by the socket inode; this predicate is the macOS half.
 */
export function acceptsPathNamedBoundSockets(files: readonly OpenFile[], socketPath: string): boolean {
  const want = canonicalPath(socketPath);
  let count = 0;
  for (const f of files) {
    if (!/^\d/.test(f.fd) || f.type !== "unix") continue;
    const bound = lsofBoundSocketPath(f.name);
    if (bound !== null && canonicalPath(bound) === want) count++;
  }
  return count >= 1;
}

function openFiles(pid: number): OpenFile[] {
  const r = run(["lsof", "-nP", "-a", "-p", String(pid), "-Ffnti"], 5_000);
  const files = r.code === 0 && r.out.length <= 1_000_000 ? parseLsofOpenFiles(r.out, pid) : null;
  if (!files) throw new Error("the invoking daemon's open files could not be checked");
  return files;
}

/** A vanished unrelated parent is not this lock; an unchecked candidate or any other read error still refuses. */
export function sameLockName(openName: string, lockPath: string): boolean {
  if (!openName.startsWith("/")) return false;
  const name = openName.replace(/ \(deleted\)$/, "");
  if (basename(name) !== basename(lockPath)) return false;
  const lockParent = realpathSync(dirname(lockPath));
  let openParent: string;
  try { openParent = realpathSync(dirname(name)); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
  return join(openParent, basename(name)) === join(lockParent, basename(lockPath));
}

/**
 * Same-uid processes other than `candidate` that have this lock inode open. On Linux this is always a `/proc`
 * scan: `lsof -u` reads all of `/proc/net/unix` and passes the check's time limit once that table is large.
 * macOS still uses lsof. The device compared here is `stat`'s, the same source as `lock`, including on a btrfs subvolume.
 */
const LOCK_HOLDERS = "the daemon's other lock holders could not be checked";

/** Yama ptrace scope hides another same-uid process's fds from a non-root caller, as lsof does. Root still fails closed. */
function procFdHidden(code: string | undefined): boolean {
  if (code === "ENOENT" || code === "ENOTDIR") return true;
  if (code !== "EACCES" && code !== "EPERM") return false;
  const euid = process.geteuid?.() ?? process.getuid?.() ?? -1;
  if (euid === 0) throw new Error(LOCK_HOLDERS);
  return true;
}

/**
 * Whether the fd's file is named `lockPath`, which lsof also reported: an unlinked or replaced lock file stays open on
 * its holder's fd under its old name, with " (deleted)" after it, and a second daemon could not tell from the inode.
 * A name whose directory is gone cannot be `lockPath`.
 */
function openFdNamesLock(pid: number, fd: string, lockPath: string): boolean {
  let link: string;
  try { link = readlinkSync(`/proc/${pid}/fd/${fd}`); }
  catch (err) {
    if (procFdHidden((err as NodeJS.ErrnoException).code)) return false;
    throw new Error(LOCK_HOLDERS);
  }
  try { return sameLockName(link, lockPath); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new Error(LOCK_HOLDERS);
  }
}

function otherLockHolderProc(owner: number, candidate: number, lockPath: string, lock: Stats): boolean {
  let names: string[];
  try { names = readdirSync("/proc"); }
  catch { throw new Error(LOCK_HOLDERS); }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === candidate) continue;
    let status: string;
    try { status = readFileSync(`/proc/${pid}/status`, "utf8"); }
    catch (err) {
      if (procFdHidden((err as NodeJS.ErrnoException).code)) continue;
      throw new Error(LOCK_HOLDERS);
    }
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    if (!Number.isInteger(uid) || uid !== owner) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${pid}/fd`); }
    catch (err) {
      if (procFdHidden((err as NodeJS.ErrnoException).code)) continue;
      throw new Error(LOCK_HOLDERS);
    }
    for (const fd of fds) {
      let st: Stats;
      try { st = statSync(`/proc/${pid}/fd/${fd}`); }
      catch (err) {
        if (procFdHidden((err as NodeJS.ErrnoException).code)) continue;
        throw new Error(LOCK_HOLDERS);
      }
      if (!st.isFile()) continue;
      if (st.ino === lock.ino && st.dev === lock.dev) return true;
      if (openFdNamesLock(pid, fd, lockPath)) return true;
    }
  }
  return false;
}

/** An unlinked old lock remains visible on its holder's fd; two holders for one pathname are ambiguous. */
function otherLockHolder(owner: number, lockPath: string, candidate: number, lock?: Stats): boolean {
  if (process.platform === "linux") {
    if (!lock) throw new Error(LOCK_HOLDERS);
    return otherLockHolderProc(owner, candidate, lockPath, lock);
  }
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

function inodeKey(inode: string): string {
  return /^\d+$/.test(inode) ? inode.replace(/^0+(?=\d)/, "") : "";
}

const LISTEN_CHECK = "the invoking daemon's listening socket could not be checked";

/** `/proc/self/fd/<n>/<name>` or `/proc/<pid>/fd/<n>/<name>`: how Linux records a bind of a path of 108 bytes or more. */
function procFdSocketForm(listed: string): { fd: string; name: string } | null {
  const match = /^\/proc\/(?:self|\d+)\/fd\/(\d+)\/([^/]+)$/.exec(listed);
  if (!match?.[1] || !match[2] || match[2] === "." || match[2] === ".." || match[2].includes("\0")) return null;
  return { fd: match[1], name: match[2] };
}

/**
 * The socket path a proc-fd bind names, from the candidate's own fd table: readlink `/proc/<pid>/fd/<n>` joined with
 * `<name>`, realpath'd. Null when `<n>` is closed, reused, or not that directory. A missing process is null; being
 * unable to read the fd table is the caller's unchecked failure.
 */
function resolveProcFdBindPath(pid: number, listed: string): string | null {
  const form = procFdSocketForm(listed);
  if (!form || !Number.isSafeInteger(pid) || pid <= 0) return null;
  let dir: string;
  try { dir = readlinkSync(`/proc/${pid}/fd/${form.fd}`); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EINVAL" || code === "ENOTDIR") return null;
    throw new Error(LISTEN_CHECK);
  }
  if (!dir.startsWith("/") || dir.includes("\0") || dir.endsWith(" (deleted)")) return null;
  let st: Stats;
  try { st = lstatSync(dir); } catch { return null; }
  if (!st.isDirectory() || st.isSymbolicLink()) return null;
  try { return realpathSync(join(dir, form.name)); } catch { return null; }
}

/** Seven leading fields, then the path bytes exactly (a run of spaces in the path is not collapsed). */
function parseProcNetUnixLine(line: string): { flags: string; inode: string; path: string } | null {
  const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s(.*))?$/.exec(line);
  if (!match?.[4] || !match[7]) return null;
  return { flags: match[4], inode: match[7], path: match[8] ?? "" };
}

type SocketFileId = { ino: number; dev: number };

const TCP_LISTEN = 10;

/**
 * The mount that contains `path`, from `/proc/self/mountinfo` text. Field 3 is `major:minor` of the
 * superblock (`sb->s_dev`). That is the device unix_diag stores. `stat` on a btrfs subvolume reports
 * a different anonymous device, so the two must not be compared with each other.
 * The longest mount point that is a prefix of `path` wins. Two lines with the same mount point are stacked:
 * the later line is the one on top. Octal escapes (`\040` for a space) are undone.
 * Null when no mount point covers the path.
 */
export function mountDeviceForPath(mountinfo: string, path: string): { major: number; minor: number } | null {
  if (!path.startsWith("/")) return null;
  let bestLen = -1;
  let best: { major: number; minor: number } | null = null;
  for (const line of mountinfo.split("\n")) {
    if (!line) continue;
    const fields = line.split(" ");
    const dev = fields[2];
    const pointRaw = fields[4];
    if (!dev || !pointRaw) continue;
    const colon = dev.indexOf(":");
    if (colon <= 0) continue;
    const major = Number(dev.slice(0, colon));
    const minor = Number(dev.slice(colon + 1));
    if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 0 || minor < 0) continue;
    let point = "";
    for (let i = 0; i < pointRaw.length; i++) {
      const octal = pointRaw[i] === "\\" && i + 3 < pointRaw.length
        && /[0-7]/.test(pointRaw[i + 1] ?? "") && /[0-7]/.test(pointRaw[i + 2] ?? "") && /[0-7]/.test(pointRaw[i + 3] ?? "");
      if (octal) {
        point += String.fromCharCode(Number.parseInt(pointRaw.slice(i + 1, i + 4), 8));
        i += 3;
      } else point += pointRaw[i];
    }
    if (!point.startsWith("/")) continue;
    const prefix = point.length > 1 && point.endsWith("/") ? point.slice(0, -1) : point;
    const matches = path === prefix || path.startsWith(prefix === "/" ? "/" : `${prefix}/`);
    if (!matches || prefix.length < bestLen) continue;
    bestLen = prefix.length;
    best = { major, minor };
  }
  return best;
}

/**
 * Whether unix_diag's file identity is `fileIno` on `mount`. The device compare uses the mount's
 * major:minor (kernel `dev_t`, `major << 20 | minor`), the same number unix_diag's `udiag_vfs_dev` is.
 * A null mount means the mount table did not name one: the inode alone matches, because a device taken
 * from `stat` is a different source and disagrees on btrfs subvolumes and overlayfs. An inode that does
 * not fit in the 32-bit unix_diag field does not match.
 */
export function unixDiagVfsMatchesFile(vfs: { ino: number; dev: number }, fileIno: number,
  mount: { major: number; minor: number } | null): boolean {
  if (!Number.isInteger(fileIno) || fileIno < 0 || fileIno > 0xffffffff) return false;
  if (!Number.isInteger(vfs.ino) || vfs.ino < 0 || vfs.ino > 0xffffffff) return false;
  if (!Number.isInteger(vfs.dev) || vfs.dev < 0) return false;
  if (vfs.ino !== fileIno) return false;
  if (!mount) return true;
  if (!Number.isInteger(mount.major) || !Number.isInteger(mount.minor)) return false;
  if (mount.major < 0 || mount.major > 0xfff || mount.minor < 0 || mount.minor > 0xfffff) return false;
  return vfs.dev === mount.major * 0x100000 + mount.minor;
}

type Netlink = {
  socket: (domain: number, type: number, protocol: number) => number;
  bind: (fd: number, addr: ReturnType<typeof ptr>, len: number) => number;
  setsockopt: (fd: number, level: number, name: number, value: ReturnType<typeof ptr>, len: number) => number;
  send: (fd: number, buf: ReturnType<typeof ptr>, len: number, flags: number) => number | bigint;
  recv: (fd: number, buf: ReturnType<typeof ptr>, len: number, flags: number) => number | bigint;
  close: (fd: number) => number;
  errno: () => number;
};
let netlinkLib: Netlink | null = null;

function netlink(): Netlink {
  if (netlinkLib) return netlinkLib;
  const { symbols } = dlopen("libc.so.6", {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  const errnoAt = symbols.__errno_location;
  if (!errnoAt) throw new Error(LISTEN_CHECK);
  netlinkLib = {
    socket: (domain, type, protocol) => symbols.socket(domain, type, protocol) as number,
    bind: (fd, addr, len) => symbols.bind(fd, addr, len) as number,
    setsockopt: (fd, level, name, value, len) => symbols.setsockopt(fd, level, name, value, len) as number,
    send: (fd, buf, len, flags) => symbols.send(fd, buf, len, flags) as number | bigint,
    recv: (fd, buf, len, flags) => symbols.recv(fd, buf, len, flags) as number | bigint,
    close: (fd) => symbols.close(fd) as number,
    errno: () => {
      const pointer = errnoAt();
      if (!pointer) return -1;
      return new Int32Array(toArrayBuffer(pointer as number, 0, 4))[0] ?? -1;
    },
  };
  return netlinkLib;
}

const nlAlign = (n: number) => (n + 3) & ~3;

type DiagSocket = { state: number; name: string | null; vfs: SocketFileId | null; uid: number | null };

/** NAME | VFS | UID. The uid is what a 32-bit inode wrap would otherwise leave unchecked. */
const UNIX_DIAG_SHOW = 0x1 | 0x2 | 0x40;
const UNIX_DIAG_UID = 7;

/** Test only: every UNIX_DIAG reply becomes this errno (negative). `null` uses the kernel. */
let unixDiagErrnoOverride: number | null = null;
/** Test only: `undefined` keeps the kernel's uid attribute; `null` pretends the kernel omitted it. */
let unixDiagUidOverride: number | null | undefined = undefined;
/** Uids from the last real replies for the candidate sockets. `null` means the attribute was absent. */
let unixDiagSeenUids: Array<number | null> = [];

export function setUnixDiagErrnoForTest(errno: number | null): void {
  unixDiagErrnoOverride = errno;
}

export function setUnixDiagUidForTest(uid: number | null | undefined): void {
  unixDiagUidOverride = uid;
}

export function unixDiagUidsForTest(): Array<number | null> {
  return unixDiagSeenUids.slice();
}

function syntheticDiagError(errno: number): Uint8Array {
  const buf = new Uint8Array(36);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 36, true);
  view.setUint16(4, 2, true); // NLMSG_ERROR
  view.setInt32(16, errno, true);
  return buf;
}

/**
 * A unix socket this process owns, so its own inode can be asked of UNIX_DIAG. It is left unbound: UNIX_DIAG answers for
 * an unbound socket too, and an autobind could fail once another user exhausts the namespace's abstract names, which
 * would make every check busy (WALK-104/106 r4 review LOW-2). Nothing to clean up but the fd.
 */
function openProbeUnix(lib: Netlink): { fd: number; inode: number } {
  const fd = lib.socket(1, 1 | 0x80000, 0); // AF_UNIX, SOCK_STREAM|SOCK_CLOEXEC
  if (fd < 0) throw new Error(LISTEN_CHECK);
  let link = "";
  try { link = readlinkSync(`/proc/self/fd/${fd}`); }
  catch { lib.close(fd); throw new Error(LISTEN_CHECK); }
  const inode = Number(/^socket:\[(\d+)\]$/.exec(link)?.[1]);
  if (!Number.isInteger(inode) || inode <= 0 || inode > 0xffffffff) { lib.close(fd); throw new Error(LISTEN_CHECK); }
  return { fd, inode };
}

/** Pathname from `UNIX_DIAG_NAME`. Abstract names start with a zero byte and are not a filesystem path. */
function pathnameFromDiag(payload: Uint8Array): string | null {
  if (payload.byteLength === 0 || payload[0] === 0) return null;
  let end = payload.byteLength;
  if (payload[end - 1] === 0) end -= 1;
  for (let i = 0; i < end; i++) if (payload[i] === 0) return null;
  const name = Buffer.from(payload.subarray(0, end)).toString("utf8");
  return name.startsWith("/") && !name.includes("\0") ? name : null;
}

/**
 * One exact `UNIX_DIAG` reply. `udiag_ino` is the sockfs inode, `udiag_state` 10 is listening, and the name
 * attribute is the bind path with its own length, so a newline in that path cannot forge another record.
 * `UNIX_DIAG_VFS` is `{ u32 ino, u32 dev }` (linux/unix_diag.h).
 */
function parseUnixDiagReply(buf: Uint8Array, size: number, inode: number): DiagSocket | "missing" | "unavailable" | "again" {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  while (off + 16 <= size) {
    const length = view.getUint32(off, true);
    const type = view.getUint16(off + 4, true);
    if (length < 16 || off + length > size) throw new Error(LISTEN_CHECK);
    if (type === 2) {
      if (length < 20) throw new Error(LISTEN_CHECK);
      const err = view.getInt32(off + 16, true);
      if (err === 0) { off += nlAlign(length); continue; }
      if (err === -2) return "missing"; // ENOENT: this inode is not a unix socket
      if (err === -22 || err === -95) return "unavailable"; // EINVAL, EOPNOTSUPP: this kernel has no exact query
      throw new Error(LISTEN_CHECK);
    }
    if (type === 20 && length >= 32 && view.getUint32(off + 20, true) === inode) {
      const state = view.getUint8(off + 18);
      let name: string | null = null;
      let vfs: SocketFileId | null = null;
      let uid: number | null = null;
      let attr = off + 32;
      const end = off + length;
      while (attr + 4 <= end) {
        const attrLen = view.getUint16(attr, true);
        const attrType = view.getUint16(attr + 2, true) & 0x3fff;
        if (attrLen < 4 || attr + attrLen > end) break;
        if (attrType === 0) name = pathnameFromDiag(buf.subarray(attr + 4, attr + attrLen));
        else if (attrType === 1 && attrLen >= 12) vfs = { ino: view.getUint32(attr + 4, true), dev: view.getUint32(attr + 8, true) };
        else if (attrType === UNIX_DIAG_UID) {
          if (attrLen < 8) throw new Error(LISTEN_CHECK);
          uid = view.getUint32(attr + 4, true);
        }
        attr += nlAlign(attrLen);
      }
      return { state, name, vfs, uid };
    }
    off += nlAlign(length);
  }
  return "again";
}

/**
 * One `UNIX_DIAG` get (`udiag_ino`, cookie `~0` so the kernel does not also match a socket pointer).
 * `recordUid` stores the kernel's uid for tests. A forced errno replaces the recv, which is how tests
 * simulate a kernel whose handler is missing.
 */
function queryUnixInode(lib: Netlink, fd: number, buf: Uint8Array, bufPtr: ReturnType<typeof ptr>, inode: number, seq: number, recordUid: boolean): DiagSocket | "missing" | "unavailable" | "again" {
  const msg = new Uint8Array(40);
  const header = new DataView(msg.buffer);
  header.setUint32(0, 40, true);
  header.setUint16(4, 20, true); // SOCK_DIAG_BY_FAMILY
  header.setUint16(6, 1, true); // NLM_F_REQUEST, not NLM_F_DUMP
  header.setUint32(8, seq, true);
  header.setUint8(16, 1); // AF_UNIX
  header.setUint32(20, 0xffffffff, true);
  header.setUint32(24, inode, true); // udiag_ino
  header.setUint32(28, UNIX_DIAG_SHOW, true);
  header.setUint32(32, 0xffffffff, true); // INET_DIAG_NOCOOKIE
  header.setUint32(36, 0xffffffff, true);
  const sent = lib.send(fd, ptr(msg), msg.length, 0);
  if ((typeof sent === "bigint" ? sent : BigInt(sent)) !== BigInt(msg.length)) throw new Error(LISTEN_CHECK);
  let got: DiagSocket | "missing" | "unavailable" | "again" = "again";
  for (let attempt = 0; attempt < 4 && got === "again"; attempt++) {
    if (unixDiagErrnoOverride !== null) {
      const forced = syntheticDiagError(unixDiagErrnoOverride);
      buf.set(forced);
      got = parseUnixDiagReply(buf, forced.length, inode);
      break;
    }
    const n = lib.recv(fd, bufPtr, buf.length, 0);
    const size = typeof n === "bigint" ? Number(n) : n;
    if (size < 0) {
      if (lib.errno() === 4) continue; // EINTR
      throw new Error(LISTEN_CHECK);
    }
    if (size === 0 || size >= buf.length) throw new Error(LISTEN_CHECK);
    got = parseUnixDiagReply(buf, size, inode);
  }
  if (typeof got !== "object") return got;
  if (recordUid && unixDiagUidOverride === undefined) unixDiagSeenUids.push(got.uid);
  if (unixDiagUidOverride !== undefined) return { ...got, uid: unixDiagUidOverride };
  return got;
}

/**
 * One `UNIX_DIAG` get per sockfs inode. The reply is one message. Its size does not depend on how many
 * sockets other users hold, and a failure here is never "there are too many sockets". The first query is a
 * unix socket this process has just created: `ENOENT` on that inode is what a kernel with no unix diag
 * handler answers for every socket, so it means the query is unavailable, not that the socket is missing.
 * Null when this kernel will not answer; the caller then reads `/proc/net/unix` and only for these inodes.
 * `ENOENT` on a later inode, once the probe has been answered, still means that inode is not a unix socket.
 */
function linuxUnixDiagByInode(inodes: readonly number[]): Map<number, DiagSocket> | null {
  const unique = [...new Set(inodes.filter((n) => Number.isInteger(n) && n > 0 && n <= 0xffffffff))];
  unixDiagSeenUids = [];
  if (unique.length === 0) return new Map();
  const lib = netlink();
  const fd = lib.socket(16, 3 | 0x80000, 4); // AF_NETLINK, SOCK_RAW|SOCK_CLOEXEC, NETLINK_SOCK_DIAG
  if (fd < 0) {
    if (new Set([1, 13, 19, 93, 95, 97]).has(lib.errno())) return null; // no such socket family here
    throw new Error(LISTEN_CHECK);
  }
  try {
    const addr = new Uint8Array(12);
    new DataView(addr.buffer).setUint16(0, 16, true);
    if (lib.bind(fd, ptr(addr), addr.length) !== 0) throw new Error(LISTEN_CHECK);
    const timeout = new Uint8Array(16);
    new DataView(timeout.buffer).setBigInt64(0, 2n, true); // SO_RCVTIMEO, 2s
    if (lib.setsockopt(fd, 1, 20, ptr(timeout), timeout.length) !== 0) throw new Error(LISTEN_CHECK);
    const buf = new Uint8Array(8192);
    const bufPtr = ptr(buf);
    const probe = openProbeUnix(lib);
    try {
      const support = queryUnixInode(lib, fd, buf, bufPtr, probe.inode, 1, false);
      if (support === "missing" || support === "unavailable") return null;
      if (typeof support !== "object") throw new Error(LISTEN_CHECK);
    } finally { lib.close(probe.fd); }
    const found = new Map<number, DiagSocket>();
    for (let i = 0; i < unique.length; i++) {
      const inode = unique[i]!;
      const got = queryUnixInode(lib, fd, buf, bufPtr, inode, i + 2, true);
      if (got === "unavailable") return null;
      if (got === "again") throw new Error(LISTEN_CHECK);
      if (got === "missing") continue;
      found.set(inode, got);
    }
    return found;
  } finally { lib.close(fd); }
}

const OTHER_NET = ["/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp", "/proc/net/udp6"];

/** Inodes listed in one `/proc/net/{tcp,tcp6,udp,udp6}` table that are also in `candidates`. */
function otherNetOverlap(candidates: ReadonlySet<number>, text: string): number[] {
  const hit: number[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("sl ") || trimmed.includes("local_address")) continue;
    const raw = trimmed.split(/\s+/)[9];
    if (!raw || !/^\d+$/.test(raw)) continue;
    const n = Number(raw);
    if (candidates.has(n)) hit.push(n);
  }
  return hit;
}

/**
 * Records for `inodes` from a `/proc/net/unix` table. A bind path that contains a newline is two lines once
 * the table is split; the same inode on two lines throws. A path containing a carriage return is skipped.
 * `otherNetInodes` are the candidates that are also in `/proc/net/{tcp,tcp6,udp,udp6}`. A unix line that names
 * one throws: those tables are world-readable, and a forged unix line can name a TCP or UDP socket of the
 * process without the inode appearing twice here. A candidate that only has a TCP or UDP socket, and no unix
 * line, is not a problem: the daemon has such sockets.
 */
export function procNetSocketsFromText(text: string, inodes: ReadonlySet<number>, otherNetInodes: ReadonlySet<number> = new Set()): Map<number, DiagSocket> {
  const found = new Map<number, { rec: DiagSocket; count: number }>();
  for (const line of text.split("\n")) {
    const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!raw || raw.startsWith("Num")) continue;
    const parsed = parseProcNetUnixLine(raw);
    if (!parsed || parsed.path.includes("\r")) continue;
    const ino = Number(inodeKey(parsed.inode));
    if (!inodes.has(ino)) continue;
    if (otherNetInodes.has(ino)) throw new Error(LISTEN_CHECK);
    const flags = Number.parseInt(parsed.flags, 16);
    if (!Number.isInteger(flags)) continue;
    const rec: DiagSocket = {
      state: (flags & 0x10000) !== 0 ? TCP_LISTEN : 0,
      name: parsed.path.startsWith("/") ? parsed.path : null,
      vfs: null,
      uid: null,
    };
    const prev = found.get(ino);
    if (prev) prev.count += 1;
    else found.set(ino, { rec, count: 1 });
  }
  if ([...found.values()].some((item) => item.count > 1)) throw new Error(LISTEN_CHECK);
  return new Map([...found].map(([ino, item]) => [ino, item.rec]));
}

/**
 * `/proc/net/unix` for `inodes` only, used when UNIX_DIAG cannot answer. A unix line that names an inode which is
 * also a TCP or UDP socket cannot be decided (`procNetSocketsFromText`). A table that cannot be read is "could not
 * be checked"; only a table that does not exist (a kernel built without IPv6 or UDP) is skipped.
 */
export function procNetSockets(inodes: ReadonlySet<number>): Map<number, DiagSocket> {
  const other = new Set<number>();
  for (const path of OTHER_NET) {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue; // no such table (IPv6 or UDP not built in): nothing of that kind exists
      throw new Error(LISTEN_CHECK);
    }
    for (const n of otherNetOverlap(inodes, text)) other.add(n);
  }
  let text: string;
  try { text = readFileSync("/proc/net/unix", "utf8"); }
  catch { throw new Error(LISTEN_CHECK); }
  return procNetSocketsFromText(text, inodes, other);
}

/** The kernel sent a uid and it is not this process's. The inode lookup returned someone else's socket. */
function diagSocketBelongsTo(rec: DiagSocket, owner: number): boolean {
  return rec.uid === null || rec.uid === owner;
}

/** Records for these sockfs inodes. UNIX_DIAG when the kernel answers it; the text table otherwise. */
function socketRecords(inodes: readonly number[]): { byInode: Map<number, DiagSocket>; fallback: boolean } {
  const filtered = inodes.filter((n) => Number.isInteger(n) && n > 0 && n <= 0xffffffff);
  const diag = linuxUnixDiagByInode(filtered);
  if (diag) return { byInode: diag, fallback: false };
  return { byInode: procNetSockets(new Set(filtered)), fallback: true };
}

function readMountinfo(): string {
  try { return readFileSync("/proc/self/mountinfo", "utf8"); }
  catch { throw new Error(LISTEN_CHECK); }
}

/** The kernel's file identity for this listening socket is the socket file at `socketPath`. */
function vfsMatchesPath(vfs: SocketFileId, socketPath: string, mountText: string): boolean {
  let st: Stats;
  try { st = lstatSync(socketPath); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return false;
    throw new Error(LISTEN_CHECK);
  }
  if (!st.isSocket() || st.isSymbolicLink()) return false;
  return unixDiagVfsMatchesFile(vfs, st.ino, mountDeviceForPath(mountText, socketPath));
}

function openSocketInodes(pid: number): number[] {
  let fds: string[];
  try { fds = readdirSync(`/proc/${pid}/fd`); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw new Error(LISTEN_CHECK);
  }
  const inodes: number[] = [];
  for (const fd of fds) {
    let link: string;
    try { link = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
    const raw = /^socket:\[(\d+)\]$/.exec(link)?.[1];
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n <= 0xffffffff) inodes.push(n);
  }
  return inodes;
}

/**
 * True when this record is the listening socket bound at `socketPath`. Only the candidate's own inodes are passed in.
 * In the text-table fallback a long bind whose directory fd is closed has no file identity, so it cannot be decided.
 */
function recordListensOn(pid: number, rec: DiagSocket, socketPath: string, want: string, mountText: string | null, owner: number, fallback: boolean): boolean {
  if (!diagSocketBelongsTo(rec, owner)) throw new Error(LISTEN_CHECK);
  if (rec.state !== TCP_LISTEN || !rec.name || rec.name.includes("\0") || rec.name.includes("\n") || rec.name.includes("\r")) return false;
  const form = procFdSocketForm(rec.name);
  // A plain name under /proc is not the socket's directory. Following it would use another process's cwd.
  if (!form) return rec.name !== "/proc" && !rec.name.startsWith("/proc/") && canonicalPath(rec.name) === want;
  // A long bind is stored as /proc/self/fd/<n>/<name>. Resolving <n> in THIS process would follow the helper's fd.
  if (form.name !== basename(want)) return false;
  const resolved = resolveProcFdBindPath(pid, rec.name);
  // readlink wins when the fd still names the registered directory. Replacing that fd with the registered
  // directory (dup2) therefore passes; the socket may have been bound in another directory. Same-user residual.
  if (resolved && canonicalPath(resolved) === want) return true;
  if (rec.vfs) return vfsMatchesPath(rec.vfs, socketPath, mountText ?? readMountinfo());
  // A resolved path that is not the socket is a decision. An unresolved one has nothing else to compare.
  if (resolved) return false;
  if (fallback) throw new Error(LISTEN_CHECK);
  return false;
}

function linuxListeningInodes(socketPath: string, pid: number, owner: number): Set<string> {
  const open = openSocketInodes(pid);
  if (open.length === 0) return new Set();
  const { byInode: records, fallback } = socketRecords(open);
  const want = canonicalPath(socketPath);
  let mountText: string | null = null;
  const found = new Set<string>();
  for (const ino of open) {
    const rec = records.get(ino);
    if (!rec) continue;
    if (rec.vfs && mountText === null && procFdSocketForm(rec.name ?? "")) mountText = readMountinfo();
    if (recordListensOn(pid, rec, socketPath, want, mountText, owner, fallback)) found.add(String(ino));
  }
  return found;
}

/** Paths this record is bound to. A proc-fd name whose directory fd is closed is recovered from an open lock plus VFS. */
function pathsForRecord(pid: number, rec: DiagSocket, lockPaths: readonly string[], mountText: () => string, owner: number, fallback: boolean): string[] {
  if (!diagSocketBelongsTo(rec, owner)) throw new Error(LISTEN_CHECK);
  if (!rec.name || rec.name.includes("\0") || rec.name.includes("\n") || rec.name.includes("\r")) return [];
  const form = procFdSocketForm(rec.name);
  if (!form) return rec.name.startsWith("/") && rec.name !== "/proc" && !rec.name.startsWith("/proc/") ? [rec.name] : [];
  const out: string[] = [];
  const resolved = resolveProcFdBindPath(pid, rec.name);
  if (resolved) out.push(resolved);
  if (rec.vfs) {
    for (const lockPath of lockPaths) {
      const socket = lockPath.slice(0, -".lock".length);
      if (!socket.startsWith("/") || basename(socket) !== form.name) continue;
      if (vfsMatchesPath(rec.vfs, socket, mountText())) out.push(socket);
    }
  } else if (fallback && !resolved && rec.state === TCP_LISTEN && lockPaths.some((lockPath) => basename(lockPath.slice(0, -".lock".length)) === form.name)) {
    // Only a listener named like a socket whose lock this process holds could be the registered one. Its file cannot be
    // identified without the directory fd, so it is undecidable. A listener with any other name is decided: not it.
    throw new Error(LISTEN_CHECK);
  }
  return out;
}

function procFdLinks(pid: number): { link: string }[] {
  let fds: string[];
  try { fds = readdirSync(`/proc/${pid}/fd`); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new Error("the invoking daemon's open files could not be checked");
    throw new Error("the invoking daemon's open files could not be checked");
  }
  const links: { link: string }[] = [];
  for (const fd of fds) {
    try { links.push({ link: readlinkSync(`/proc/${pid}/fd/${fd}`) }); } catch { /* closed meanwhile */ }
  }
  return links;
}

function lockFdCount(pid: number, lock: Stats): number {
  let count = 0;
  let fds: string[];
  try { fds = readdirSync(`/proc/${pid}/fd`); }
  catch { throw new Error("the invoking daemon's open files could not be checked"); }
  for (const fd of fds) {
    let st: Stats;
    try { st = statSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
    if (st.isFile() && st.ino === lock.ino && st.dev === lock.dev) count += 1;
  }
  return count;
}

function executableMatches(pid: number): boolean {
  let link: string;
  try { link = readlinkSync(`/proc/${pid}/exe`); }
  catch { throw new Error("the invoking daemon's executable could not be checked"); }
  const path = link.endsWith(" (deleted)") ? link.slice(0, -" (deleted)".length) : link;
  if (!path.startsWith("/")) throw new Error("the invoking daemon's executable could not be checked");
  let file: Stats;
  try { file = lstatSync(path); }
  catch { throw new Error("the invoking daemon's executable changed during inspection"); }
  let live: Stats;
  try { live = statSync(`/proc/${pid}/exe`); }
  catch { throw new Error("the invoking daemon's executable changed during inspection"); }
  if (!file.isFile() || file.isSymbolicLink() || live.ino !== file.ino || live.dev !== file.dev)
    throw new Error("the invoking daemon's executable changed during inspection");
  const expectedBytes = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  const got = createHash("sha256").update(readRegularNoFollow(path, file.dev, file.ino)).digest("hex");
  return got === expectedBytes;
}

/**
 * Linux WalkieTalkie check. Socket names come from UNIX_DIAG (or `/proc/net/unix` if the kernel cannot answer it),
 * not from lsof, which cuts a name at the first space. Only this process's socket inodes are queried.
 * An accepted connection carries the same path and is not listening, so one client does not hide the daemon.
 */
function isBoundDaemonLinux(pid: number, owner: number, instance: string, expectedSocket?: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const expected = expectedSocket ? canonicalPath(expectedSocket) : null;
  const hashOk = (path: string) => !path.includes("\0") && !path.includes("\n") && !path.includes("\r")
    && createHash("sha256").update(resolve(path)).digest("hex") === instance
    && (!expected || canonicalPath(path) === expected);
  const links = procFdLinks(pid);
  const sockets: number[] = [];
  const lockPaths: string[] = [];
  for (const item of links) {
    const raw = /^socket:\[(\d+)\]$/.exec(item.link)?.[1];
    if (raw) {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0 && n <= 0xffffffff) sockets.push(n);
      continue;
    }
    if (!item.link.startsWith("/")) continue;
    const name = item.link.endsWith(" (deleted)") ? item.link.slice(0, -" (deleted)".length) : item.link;
    if (name.endsWith(".lock")) lockPaths.push(name);
  }
  const { byInode: records, fallback } = socketRecords(sockets);
  // Mountinfo is only needed when a long bind's directory fd no longer names the socket. A short path does not read it.
  let mountText: string | null = null;
  const mounts = () => {
    if (mountText === null) mountText = readMountinfo();
    return mountText;
  };
  const bound: { path: string; listen: boolean }[] = [];
  for (const ino of sockets) {
    const rec = records.get(ino);
    if (!rec) continue;
    const paths = new Set(pathsForRecord(pid, rec, lockPaths, mounts, owner, fallback).filter(hashOk));
    for (const path of paths) bound.push({ path, listen: rec.state === TCP_LISTEN });
  }
  if (bound.length === 0) return false;
  const socketPath = bound[0]!.path;
  const socketCanon = canonicalPath(socketPath);
  if (bound.some((item) => canonicalPath(item.path) !== socketCanon)) return false;
  if (bound.filter((item) => item.listen).length !== 1) return false;
  let socketStat: Stats;
  try { socketStat = lstatSync(socketPath); } catch { return false; }
  if (!socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.uid !== owner) return false;
  const lockPath = `${socketPath}.lock`;
  let lock: Stats;
  try { lock = lstatSync(lockPath); } catch { return false; }
  if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== owner || (lock.mode & 0o077) !== 0) return false;
  if (lockFdCount(pid, lock) !== 1 || !instanceLockHeld(lockPath, { dev: lock.dev, ino: lock.ino })) return false;
  if (otherLockHolder(owner, lockPath, pid, lock)) throw new Error("the invoking daemon's instance lock has another live holder");
  return executableMatches(pid);
}

function isBoundDaemon(pid: number, owner: number, instance: string, expectedSocket?: string): boolean {
  if (process.platform === "linux") return isBoundDaemonLinux(pid, owner, instance, expectedSocket);
  const files = openFiles(pid);
  const expected = expectedSocket ? canonicalPath(expectedSocket) : null;
  // The daemon hashes resolve(socket) (os-user.ts). macOS lsof puts that path alone in NAME.
  const hashOk = (path: string) => createHash("sha256").update(resolve(path)).digest("hex") === instance
    && (!expected || canonicalPath(path) === expected);
  const bound: { file: OpenFile; path: string }[] = [];
  for (const file of files) {
    if (!/^\d/.test(file.fd) || file.type !== "unix") continue;
    const listed = lsofBoundSocketPath(file.name);
    if (!listed || procFdSocketForm(listed) || !hashOk(listed)) continue;
    bound.push({ file, path: listed });
  }
  if (bound.length === 0) return false;
  const socketPath = bound[0]!.path;
  if (bound.some((item) => canonicalPath(item.path) !== canonicalPath(socketPath))) return false;
  // macOS names the listening socket and each accepted connection with the path, and a client never has it.
  if (!acceptsPathNamedBoundSockets(bound.map((item) => item.file), socketPath)) return false;
  const socket = lstatSync(socketPath);
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== owner) return false;
  const lockPath = `${socketPath}.lock`;
  const lock = lstatSync(lockPath);
  if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== owner || (lock.mode & 0o077) !== 0) return false;
  // lsof names an unlinked fd "<path> (deleted)". realpath of that raw name throws; skip it. A file that is not the
  // lock must not fail the whole check (this scan runs once the socket hash matches, which it now does on Linux).
  let lockReal: string;
  try { lockReal = realpathSync(lockPath); } catch { return false; }
  const locks = files.filter((f) => {
    if (!/^\d/.test(f.fd) || f.type !== "REG" || !f.name.startsWith("/")) return false;
    let resolved: string;
    try { resolved = realpathSync(f.name.replace(/ \(deleted\)$/, "")); } catch { return false; }
    return resolved === lockReal && f.inode === String(lock.ino);
  });
  if (locks.length !== 1 || !instanceLockHeld(lockPath, { dev: lock.dev, ino: lock.ino })) return false;
  if (otherLockHolder(owner, lockPath, pid)) throw new Error("the invoking daemon's instance lock has another live holder");
  const executable = files.find((f) => f.fd === "txt" && f.type === "REG" && f.name.startsWith("/"));
  if (!executable) throw new Error("the invoking daemon's executable could not be checked");
  const executableFile = lstatSync(executable.name);
  if (!executableFile.isFile() || executableFile.isSymbolicLink() || executable.inode !== String(executableFile.ino))
    throw new Error("the invoking daemon's executable changed during inspection");
  // setup-user copies the release binary to the root helper path, so compare bytes rather than path names.
  const expectedBytes = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  return createHash("sha256").update(readRegularNoFollow(executable.name, executableFile.dev, executableFile.ino)).digest("hex") === expectedBytes;
}

/**
 * Root binds the sudo caller's nearest same-user ancestor to its listening socket, held lock, and installed
 * executable. sudo and its monitor run as root and are walked through. A same-user process that is not itself
 * the daemon (one its seat or shell started) does not stand in for a daemon further up. `expectedSocket`, when
 * set, is the registered daemon socket: a hash of some other socket this process holds does not count.
 */
export function callingTalkieDaemon(owner: number, instance: string, parent = process.ppid, expectedSocket?: string): OpId {
  if (!/^[0-9a-f]{64}$/.test(instance)) throw new Error("the invoking daemon's instance is invalid");
  let pid = parent;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const r = run(["/bin/ps", "-ww", "-p", String(pid), "-o", "ppid=,uid=,lstart=,command="], 5_000);
    if (r.code !== 0) throw new Error("the invoking daemon's process chain could not be checked");
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/m.exec(r.out);
    if (!match) throw new Error("the invoking daemon's process identity is ambiguous");
    const uid = Number(match[2]);
    const start = (match[3] as string).trim();
    if (uid === owner) {
      if (!isBoundDaemon(pid, owner, instance, expectedSocket)) throw new Error("the invoking daemon could not be identified");
      if (processStart(pid) !== start) throw new Error("the invoking daemon changed during inspection");
      return { pid, start };
    }
    if (uid !== 0) throw new Error("the invoking daemon could not be identified (another user is between it and sudo)");
    pid = Number(match[1]);
  }
  throw new Error("the invoking daemon could not be identified");
}

/**
 * The daemon allowed to make the first WalkieTalkie owner claim. When the root seat-instance record is present,
 * the caller-supplied socket hash is accepted only for that record's socket. When no record exists (a setup from
 * before the record), the hash is the caller's own, as before. A record that can't be trusted fails closed.
 */
export function callingTalkieClaimDaemon(owner: number, instance: string, parent = process.ppid,
  recordPath = SEAT_INSTANCE_FILE, root = true): OpId {
  if (!/^[0-9a-f]{64}$/.test(instance)) throw new Error("the invoking daemon's instance is invalid");
  const read = readSeatRegistration(recordPath, root);
  if (read.state === "absent") return callingTalkieDaemon(owner, instance, parent);
  if (read.state === "invalid") throw new Error(`the seat registration can't be trusted: ${read.why}`);
  const registered = read.registration;
  if (registered.uid !== owner) throw new Error(`another Walkie daemon owns shell access on this machine (${registered.user}'s, home ${registered.home})`);
  return callingTalkieDaemon(owner, instance, parent, registered.socket);
}

/**
 * A file the daemon's user controls, read by root (WALK-103 review): never through a symlink, never waiting on a FIFO
 * swapped in, and only the very inode checked before (`dev`, `ino`); anything else throws.
 */
export function readRegularNoFollow(path: string, dev: number, ino: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== dev || st.ino !== ino) throw new Error(`${path} changed during inspection`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** The asking daemon is definitely not the registered one (as opposed to: it couldn't be checked right now). */
export class SeatCallerMismatch extends Error {}

const GONE = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);
/** lstat that answers null for a path that isn't there (or is a link where a directory was); other errors throw. */
function lstatIfThere(path: string): Stats | null {
  try { return lstatSync(path); } catch (err) { if (GONE.has((err as NodeJS.ErrnoException).code ?? "")) return null; throw err; }
}

/**
 * Whether the open file that `/proc/<pid>/fdinfo/<fd>` describes holds the exclusive flock, taken by `pid` (Linux 4.1+:
 * the kernel lists there only the locks taken through that very open file, `lock:` lines). So a process that merely has
 * the lock file open while another holds the lock doesn't count, and nothing has to be matched by inode or device: a
 * global /proc/locks line can name the same inode on another device, and a device compare against stat's st_dev would
 * fail where that isn't the superblock's (btrfs subvolumes, WALK-103 review). Waiters (`-> FLOCK`) are not holders.
 */
export function fdHoldsFlock(pid: number, fdinfo: string): boolean {
  for (const line of fdinfo.split("\n")) {
    const m = /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s/.exec(line);
    if (m && Number(m[1]) === pid) return true;
  }
  return false;
}

/** True when `pid` has a listening unix socket fd for `socketPath`. A missing process is not a holder. */
function processHoldsListeningSocket(pid: number, socketPath: string, owner: number): boolean {
  const inodes = linuxListeningInodes(socketPath, pid, owner);
  if (inodes.size === 0) return false;
  let fds: string[];
  try { fds = readdirSync(`/proc/${pid}/fd`); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new Error("the invoking daemon's listening socket could not be checked");
  }
  for (const fd of fds) {
    let link: string;
    try { link = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
    const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
    if (inode && inodes.has(inodeKey(inode))) return true;
  }
  return false;
}

/**
 * Whether `pid` holds the instance lock of the daemon socket `socket` (instance-lock.ts: `<socket>.lock`, taken before
 * the socket is bound and held until the daemon exits) and that socket's listening fd. False when it doesn't (or the
 * socket or lock isn't there); throws only when that couldn't be checked right now. Linux: `pid` has that very lock
 * inode open (`/proc/<pid>/fd`) and the kernel lists the flock, taken by `pid`, on that open file
 * (`/proc/<pid>/fdinfo/<fd>`). The listening socket is one of the unix sockets that pid has open: each of those
 * inodes is asked of the kernel on its own (`UNIX_DIAG`), and the reply's state, name and, when the kernel sends
 * it, owning uid decide. The helper first asks about a unix socket it has just created: `ENOENT`, `EINVAL` or
 * `EOPNOTSUPP` on that inode means the query is unavailable. `/proc/net/unix` is used only then, and only for this
 * process's inodes. A newline in a bind path splits that table; the same inode on two lines, or a unix line that names
 * an inode which is also a TCP or UDP socket, is "could not be checked", not a listener. A path of 108 bytes or more is listed as
 * `/proc/self/fd/<n>/<name>` (Bun binds that way, then closes `<n>`): `<n>` in this pid is resolved when it is still
 * the socket's directory, and otherwise the kernel's record of that listening socket's file must be the registered
 * socket (inode, and the mount's device). The text table has no such record, so a closed directory fd there is
 * "could not be checked", not another Walkie. A file inode above 32 bits does not match once that directory fd is
 * closed. Root opens nothing of the daemon user's.
 * macOS: lsof shows the lock file open and the bound socket path in the unix socket's NAME (a peer's `->0x` address
 * does not count), and the lock is held (instanceLockHeld, opening only that same inode, without following links or
 * waiting). A same-user process that only has the lock file open does not hold the listening socket, so it does not
 * pass on either platform.
 */
export function holdsSeatInstanceLock(pid: number, owner: number, socket: string, platform: NodeJS.Platform = process.platform): boolean {
  const sock = lstatIfThere(socket);
  if (!sock || !sock.isSocket() || sock.uid !== owner) return false;
  const lockPath = `${socket}.lock`;
  const lock = lstatIfThere(lockPath);
  if (!lock || !lock.isFile() || lock.isSymbolicLink() || lock.uid !== owner || (lock.mode & 0o077) !== 0) return false;
  if (platform === "linux") {
    let held = false;
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let st: ReturnType<typeof lstatSync>;
      try { st = statSync(`/proc/${pid}/fd/${fd}`); } catch { continue; } // closed meanwhile
      if (!st.isFile() || st.ino !== lock.ino || st.dev !== lock.dev) continue;
      let info: string;
      try { info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8"); } catch { continue; } // closed meanwhile
      if (fdHoldsFlock(pid, info)) { held = true; break; }
    }
    if (!held) return false;
    return processHoldsListeningSocket(pid, socket, owner);
  }
  const files = openFiles(pid);
  const open = files.some((f) => /^\d/.test(f.fd) && f.type === "REG" && f.inode === String(lock.ino) && sameLockName(f.name, lockPath));
  if (!open) return false;
  try {
    if (!instanceLockHeld(lockPath, { dev: lock.dev, ino: lock.ino })) return false;
  } catch (err) { if (GONE.has((err as NodeJS.ErrnoException).code ?? "")) return false; throw err; }
  return lsofHoldsBoundSocket(files, socket);
}

/**
 * WALK-103: the daemon that ran this helper through sudo, bound to the registered socket. The nearest ancestor running
 * as the person is the process that ran sudo (sudo and its monitor run as root); it must itself hold the registered
 * socket's instance lock and its listening socket. A daemon further up (one whose seat or shell started a second
 * daemon) never stands in for it.
 * SeatCallerMismatch: definitely not it; any other error: it couldn't be checked right now.
 */
export function callingSeatDaemon(owner: number, socket: string, parent = process.ppid,
  holds: (pid: number) => boolean = (pid) => holdsSeatInstanceLock(pid, owner, socket)): OpId {
  let pid = parent;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const r = run(["/bin/ps", "-ww", "-p", String(pid), "-o", "ppid=,uid=,lstart="], 5_000);
    if (r.code !== 0) throw new Error("the invoking daemon's process chain could not be checked");
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s*$/m.exec(r.out);
    if (!match) throw new Error("the invoking daemon's process identity is ambiguous");
    const uid = Number(match[2]);
    if (uid === owner) {
      if (!holds(pid)) throw new SeatCallerMismatch("the Walkie that asked doesn't hold the registered Walkie's socket");
      const start = (match[3] as string).trim();
      if (processStart(pid) !== start) throw new Error("the invoking daemon changed during inspection");
      return { pid, start };
    }
    if (uid !== 0) throw new SeatCallerMismatch("the invoking daemon could not be identified (another user is between it and sudo)");
    pid = Number(match[1]);
  }
  throw new SeatCallerMismatch("the invoking daemon could not be identified");
}

/**
 * WALK-103: whether the daemon that ran this helper is the Walkie `walkie seats setup-user --apply` registered for this
 * machine's seat users (SEAT_INSTANCE_FILE, root's). Nothing recorded: `unregistered` (a setup from before the record);
 * a check that failed for a passing reason (ps or lsof timed out): `unchecked`, asked again later.
 */
export function checkSeatInstance(owner: number, path = SEAT_INSTANCE_FILE, bind: (owner: number, socket: string) => OpId = callingSeatDaemon,
  root = true): SeatInstanceCheck {
  const read = readSeatRegistration(path, root);
  if (read.state === "absent") {
    return { state: "unregistered", why: "this machine's seat users were set up by an earlier Walkie, which didn't record which Walkie on this machine owns them: the helper lists, makes and removes seat users again once walkie seats setup-user --apply records it" };
  }
  if (read.state === "invalid") return { state: "other", why: `${read.why}: run walkie seats setup-user --apply again` };
  const r = read.registration;
  if (r.uid !== owner) return { state: "other", why: otherScopeWhy(r) };
  try {
    bind(owner, r.socket);
    return { state: "registered" };
  } catch (err) {
    if (err instanceof SeatCallerMismatch) return { state: "other", why: `${otherScopeWhy(r)} (${err.message})` };
    return { state: "unchecked", why: `the helper couldn't check which Walkie asked right now (${(err as Error).message}): asked again later` };
  }
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
    seatInstance(owner) { return checkSeatInstance(owner); },
    talkieDaemonIdentity(owner, instance) { return callingTalkieClaimDaemon(owner, instance); },
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
