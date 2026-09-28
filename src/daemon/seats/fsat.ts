// Descriptor-relative file operations (openat / fstatat / unlinkat / fchmodat / fdopendir+readdir) through libc, for
// the seat user's own file sweep (sweep.ts, SEATS-FIX-6; Codex r6 CRITICAL 1, HIGH 2). Node has no *at() calls, and a
// path-based walk follows whatever an ancestor was swapped for between listing and deleting. Every call here acts on a
// directory descriptor and one entry name (raw bytes, so a name with a newline is one name), never follows a symlink,
// and throws an FsatError carrying the errno name.
//
// struct stat / struct dirent layouts differ per platform: they are listed below and checked against node:fs by
// selfTest() before any sweep (a mismatch refuses the sweep: nothing is deleted on a guess).
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

type Ptr = import("bun:ffi").Pointer;

interface Layout {
  lib: string;
  sym: { fstatat: string[]; fdopendir: string[]; readdir: string[]; errno: string };
  /** struct stat: st_dev (offset, bytes), st_ino, st_mode (offset, bytes), st_uid. */
  st: { dev: [number, 4 | 8]; ino: number; mode: [number, 2 | 4]; uid: number };
  /** struct dirent: where the name starts, and where its length is (macOS) or null (NUL-terminated, Linux). */
  dirent: { name: number; namlen: number | null };
  O: { RDONLY: number; NOFOLLOW: number; DIRECTORY: number; CLOEXEC: number; NONBLOCK: number };
  AT: { FDCWD: number; SYMLINK_NOFOLLOW: number; REMOVEDIR: number };
  errnos: Record<number, string>;
}

const MAC_ERR = { 1: "EPERM", 2: "ENOENT", 13: "EACCES", 16: "EBUSY", 18: "EXDEV", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 30: "EROFS", 62: "ELOOP", 66: "ENOTEMPTY", 17: "EEXIST", 45: "ENOTSUP", 24: "EMFILE" };
const LINUX_ERR = { 1: "EPERM", 2: "ENOENT", 13: "EACCES", 16: "EBUSY", 18: "EXDEV", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 30: "EROFS", 40: "ELOOP", 39: "ENOTEMPTY", 17: "EEXIST", 95: "ENOTSUP", 24: "EMFILE" };

function layout(): Layout | null {
  if (process.platform === "darwin") {
    const x64 = process.arch === "x64";
    const s = (n: string) => (x64 ? [`${n}$INODE64`, n] : [n]);
    return {
      lib: "libSystem.B.dylib",
      sym: { fstatat: s("fstatat"), fdopendir: s("fdopendir"), readdir: s("readdir"), errno: "__error" },
      st: { dev: [0, 4], ino: 8, mode: [4, 2], uid: 16 },
      dirent: { name: 21, namlen: 18 },
      O: { RDONLY: 0, NOFOLLOW: 0x100, DIRECTORY: 0x100000, CLOEXEC: 0x1000000, NONBLOCK: 0x4 },
      AT: { FDCWD: -2, SYMLINK_NOFOLLOW: 0x20, REMOVEDIR: 0x80 },
      errnos: MAC_ERR,
    };
  }
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    const arm = process.arch === "arm64";
    return {
      lib: "libc.so.6",
      sym: { fstatat: ["fstatat64", "fstatat"], fdopendir: ["fdopendir"], readdir: ["readdir64", "readdir"], errno: "__errno_location" },
      st: arm ? { dev: [0, 8], ino: 8, mode: [16, 4], uid: 24 } : { dev: [0, 8], ino: 8, mode: [24, 4], uid: 28 },
      dirent: { name: 19, namlen: null },
      O: arm
        ? { RDONLY: 0, NOFOLLOW: 0x8000, DIRECTORY: 0x4000, CLOEXEC: 0x80000, NONBLOCK: 0x800 }
        : { RDONLY: 0, NOFOLLOW: 0x20000, DIRECTORY: 0x10000, CLOEXEC: 0x80000, NONBLOCK: 0x800 },
      AT: { FDCWD: -100, SYMLINK_NOFOLLOW: 0x100, REMOVEDIR: 0x200 },
      errnos: LINUX_ERR,
    };
  }
  return null;
}

export class FsatError extends Error {
  constructor(readonly code: string, what: string) { super(`${what}: ${code}`); }
}

export interface StatAt { dev: number; ino: number; mode: number; uid: number }
export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;
export const isDir = (st: StatAt): boolean => (st.mode & S_IFMT) === S_IFDIR;

type Syms = {
  openat: (fd: number, name: Uint8Array, flags: number, mode: number) => number;
  unlinkat: (fd: number, name: Uint8Array, flags: number) => number;
  fchmodat: (fd: number, name: Uint8Array, mode: number, flags: number) => number;
  fstatat: (fd: number, name: Uint8Array, buf: Uint8Array, flags: number) => number;
  dup: (fd: number) => number;
  fdopendir: (fd: number) => Ptr | null;
  readdir: (dir: Ptr) => Ptr | null;
  closedir: (dir: Ptr) => number;
  errno: () => Ptr | null;
};

let loaded: { L: Layout; f: Syms; read: typeof import("bun:ffi").read; toArrayBuffer: typeof import("bun:ffi").toArrayBuffer } | null = null;

function lib(): NonNullable<typeof loaded> {
  if (loaded) return loaded;
  const L = layout();
  if (!L) throw new FsatError("ENOTSUP", `descriptor-relative file operations on ${process.platform}/${process.arch}`);
  const { dlopen, FFIType, read, toArrayBuffer } = require("bun:ffi") as typeof import("bun:ffi");
  const T = FFIType;
  const pick = (names: string[], def: Record<string, unknown>): string => {
    for (const n of names) {
      try { dlopen(L.lib, { [n]: def as never }).close(); return n; } catch { /* the next spelling */ }
    }
    throw new FsatError("ENOTSUP", `${names[0]} in ${L.lib}`);
  };
  const statDef = { args: [T.i32, T.ptr, T.ptr, T.i32], returns: T.i32 };
  const openDirDef = { args: [T.i32], returns: T.ptr };
  const readDef = { args: [T.ptr], returns: T.ptr };
  const n = { fstatat: pick(L.sym.fstatat, statDef), fdopendir: pick(L.sym.fdopendir, openDirDef), readdir: pick(L.sym.readdir, readDef) };
  const h = dlopen(L.lib, {
    openat: { args: [T.i32, T.ptr, T.i32, T.i32], returns: T.i32 },
    unlinkat: { args: [T.i32, T.ptr, T.i32], returns: T.i32 },
    fchmodat: { args: [T.i32, T.ptr, T.u16, T.i32], returns: T.i32 },
    [n.fstatat]: statDef,
    dup: { args: [T.i32], returns: T.i32 },
    [n.fdopendir]: openDirDef,
    [n.readdir]: readDef,
    closedir: { args: [T.ptr], returns: T.i32 },
    [L.sym.errno]: { args: [], returns: T.ptr },
  } as never) as unknown as { symbols: Record<string, (...a: unknown[]) => unknown> };
  const s = h.symbols;
  const f: Syms = {
    openat: (fd, name, flags, mode) => s.openat!(fd, name, flags, mode) as number,
    unlinkat: (fd, name, flags) => s.unlinkat!(fd, name, flags) as number,
    fchmodat: (fd, name, mode, flags) => s.fchmodat!(fd, name, mode, flags) as number,
    fstatat: (fd, name, buf, flags) => s[n.fstatat]!(fd, name, buf, flags) as number,
    dup: (fd) => s.dup!(fd) as number,
    fdopendir: (fd) => s[n.fdopendir]!(fd) as Ptr | null,
    readdir: (d) => s[n.readdir]!(d) as Ptr | null,
    closedir: (d) => s.closedir!(d) as number,
    errno: () => s[L.sym.errno]!() as Ptr | null,
  };
  loaded = { L, f, read, toArrayBuffer };
  return loaded;
}

function errnoCell(): Int32Array {
  const { f, toArrayBuffer } = lib();
  const p = f.errno();
  if (!p) throw new FsatError("EINVAL", "errno");
  return new Int32Array(toArrayBuffer(p, 0, 4));
}

function fail(what: string): never {
  const { L } = lib();
  const e = errnoCell()[0] as number;
  throw new FsatError(L.errnos[e] ?? `E${e}`, what);
}

/** A name as C wants it: its bytes and a NUL (a name holding a NUL or a slash is refused: never a path). */
function cname(name: Uint8Array | string): Uint8Array {
  const b = typeof name === "string" ? Buffer.from(name) : name;
  if (b.includes(0)) throw new FsatError("EINVAL", "a name with a NUL");
  const out = new Uint8Array(b.length + 1);
  out.set(b);
  return out;
}

function nameOk(name: Uint8Array): void {
  if (name.includes(0x2f) || name.length === 0) throw new FsatError("EINVAL", "an entry name with a slash");
}

export const AT_FDCWD = (): number => lib().L.AT.FDCWD;

/** lstat of `name` in directory `dirfd` (or of an absolute path with AT_FDCWD): never follows a symlink. */
export function statAt(dirfd: number, name: Uint8Array | string): StatAt {
  const { L, f } = lib();
  const buf = new Uint8Array(256);
  if (f.fstatat(dirfd, cname(name), buf, L.AT.SYMLINK_NOFOLLOW) !== 0) fail("fstatat");
  const v = new DataView(buf.buffer);
  const dev = L.st.dev[1] === 4 ? v.getInt32(L.st.dev[0], true) : Number(v.getBigUint64(L.st.dev[0], true));
  const mode = L.st.mode[1] === 2 ? v.getUint16(L.st.mode[0], true) : v.getUint32(L.st.mode[0], true);
  return { dev, ino: Number(v.getBigUint64(L.st.ino, true)), mode, uid: v.getUint32(L.st.uid, true) };
}

/** Opens directory `name` in `dirfd` (an absolute path with AT_FDCWD): a symlink or a non-directory is refused. */
export function openDirAt(dirfd: number, name: Uint8Array | string): number {
  const { L, f } = lib();
  if (typeof name !== "string") nameOk(name);
  const fd = f.openat(dirfd, cname(name), L.O.RDONLY | L.O.NOFOLLOW | L.O.DIRECTORY | L.O.CLOEXEC | L.O.NONBLOCK, 0);
  if (fd < 0) fail("openat");
  return fd;
}

/** Removes entry `name` of `dirfd` (a directory only when `dir`, and only when empty). */
export function unlinkAt(dirfd: number, name: Uint8Array, dir: boolean): void {
  const { L, f } = lib();
  nameOk(name);
  if (f.unlinkat(dirfd, cname(name), dir ? L.AT.REMOVEDIR : 0) !== 0) fail("unlinkat");
}

/**
 * chmod of entry `name` of `dirfd`, never through a symlink (AT_SYMLINK_NOFOLLOW on both platforms: glibc ≥ 2.32
 * applies it to a non-link and refuses a link; an older libc refusing the flag fails closed: Codex r7 LOW 7).
 */
export function chmodAt(dirfd: number, name: Uint8Array, mode: number): void {
  const { L, f } = lib();
  nameOk(name);
  if (f.fchmodat(dirfd, cname(name), mode, L.AT.SYMLINK_NOFOLLOW) !== 0) fail("fchmodat");
}

// ---- the owner's own protections, access, durability, mounts (SEATS-FIX-7) ----------------------------------

type Extra = {
  fchdir: (fd: number) => number;
  faccessat: (fd: number, name: Uint8Array, mode: number, flags: number) => number;
  fcntl?: (fd: number, cmd: number, arg: number) => number;
  lchflags?: (name: Uint8Array, flags: number) => number;
  aclInit?: (n: number) => Ptr | null;
  aclSetLink?: (name: Uint8Array, type: number, acl: Ptr) => number;
  aclFree?: (acl: Ptr) => number;
  getmntinfo?: (buf: BigUint64Array, flags: number) => number;
  unmount?: (path: Uint8Array, flags: number) => number;
  umount2?: (path: Uint8Array, flags: number) => number;
};
let extraLoaded: Extra | null = null;

function extra(): Extra {
  if (extraLoaded) return extraLoaded;
  const { L } = lib();
  const { dlopen, FFIType: T } = require("bun:ffi") as typeof import("bun:ffi");
  const mac = process.platform === "darwin";
  const mnt = mac && process.arch === "x64" ? "getmntinfo$INODE64" : "getmntinfo";
  const defs: Record<string, unknown> = {
    fchdir: { args: [T.i32], returns: T.i32 },
    faccessat: { args: [T.i32, T.ptr, T.i32, T.i32], returns: T.i32 },
    ...(mac ? {
      fcntl: { args: [T.i32, T.i32, T.i32], returns: T.i32 },
      lchflags: { args: [T.ptr, T.u32], returns: T.i32 },
      acl_init: { args: [T.i32], returns: T.ptr },
      acl_set_link_np: { args: [T.ptr, T.u32, T.ptr], returns: T.i32 },
      acl_free: { args: [T.ptr], returns: T.i32 },
      [mnt]: { args: [T.ptr, T.i32], returns: T.i32 },
      unmount: { args: [T.ptr, T.i32], returns: T.i32 },
    } : { umount2: { args: [T.ptr, T.i32], returns: T.i32 } }),
  };
  const s = (dlopen(L.lib, defs as never) as unknown as { symbols: Record<string, (...a: unknown[]) => unknown> }).symbols;
  extraLoaded = {
    fchdir: (fd) => s.fchdir!(fd) as number,
    faccessat: (fd, name, mode, flags) => s.faccessat!(fd, name, mode, flags) as number,
    ...(mac ? {
      fcntl: (fd: number, cmd: number, arg: number) => s.fcntl!(fd, cmd, arg) as number,
      lchflags: (name: Uint8Array, flags: number) => s.lchflags!(name, flags) as number,
      aclInit: (n: number) => s.acl_init!(n) as Ptr | null,
      aclSetLink: (name: Uint8Array, type: number, acl: Ptr) => s.acl_set_link_np!(name, type, acl) as number,
      aclFree: (acl: Ptr) => s.acl_free!(acl) as number,
      getmntinfo: (buf: BigUint64Array, flags: number) => s[mnt]!(buf, flags) as number,
      unmount: (path: Uint8Array, flags: number) => s.unmount!(path, flags) as number,
    } : { umount2: (path: Uint8Array, flags: number) => s.umount2!(path, flags) as number }),
  };
  return extraLoaded;
}

let rootFd: number | null = null;

/**
 * Runs `fn` with the process's working directory at `dirfd` (so a single-component name is resolved in that very
 * directory: macOS has no chflagsat / acl-at calls), then back at `/`. Synchronous: nothing else runs meanwhile.
 */
function inDir<T>(dirfd: number, fn: () => T): T {
  const x = extra();
  rootFd ??= openDirAt(AT_FDCWD(), "/");
  if (x.fchdir(dirfd) !== 0) fail("fchdir");
  try { return fn(); } finally { x.fchdir(rootFd); }
}

/**
 * The owner's own protections on entry `name` of `dirfd`, cleared so it can be removed (Opus r7 2): on macOS its
 * user flags (`uchg`, `uappnd`: lchflags 0, never following the entry) and its ACL (emptied: `chmod -N`); a directory
 * is also made 0700. System flags (`schg`) can't be cleared by a user: that fails, and the entry is reported. Linux
 * has neither user-settable immutable flags nor deny ACLs: only the directory's mode.
 */
export function clearProtections(dirfd: number, name: Uint8Array, dir: boolean): void {
  nameOk(name);
  if (process.platform === "darwin") {
    const x = extra();
    inDir(dirfd, () => {
      if ((x.lchflags as NonNullable<Extra["lchflags"]>)(cname(name), 0) !== 0) fail("lchflags");
      const acl = (x.aclInit as NonNullable<Extra["aclInit"]>)(0);
      if (!acl) fail("acl_init");
      try {
        if ((x.aclSetLink as NonNullable<Extra["aclSetLink"]>)(cname(name), 0x100 /* ACL_TYPE_EXTENDED */, acl) !== 0) {
          const e = errnoCell()[0];
          if (e !== 45 /* ENOTSUP: no ACLs on this volume */ && e !== 102 /* EOPNOTSUPP */) fail("acl_set_link_np");
        }
      } finally { (x.aclFree as NonNullable<Extra["aclFree"]>)(acl); }
    });
  }
  if (dir) chmodAt(dirfd, name, 0o700);
}

/** Answers of faccessat that mean "no, it may not" (or it is gone); anything else is an inspection failure. */
const ACCESS_DENIED = new Set(["EACCES", "EPERM", "EROFS", "ENOENT"]);

/**
 * Whether this process (its effective ids, ACLs included) may create entries in directory `name` of `dirfd`. A check
 * that fails for any other reason than a denial throws (Codex r9 MEDIUM 3): the sweep then can't call itself verified.
 */
export function canWriteAt(dirfd: number, name: Uint8Array): boolean {
  nameOk(name);
  const accessEff = process.platform === "darwin" ? 0x10 : 0x200; // AT_EACCESS
  if (extra().faccessat(dirfd, cname(name), 2 | 1 /* W_OK | X_OK */, accessEff) === 0) return true;
  const { L } = lib();
  const e = errnoCell()[0] as number;
  if (ACCESS_DENIED.has(L.errnos[e] ?? "")) return false;
  throw new FsatError(L.errnos[e] ?? `E${e}`, "faccessat");
}

/** Flushed to the disk itself: F_FULLFSYNC on macOS (fsync there leaves the drive's cache; Opus r7 INFO 9). */
export function fullSync(fd: number): void {
  const x = process.platform === "darwin" ? extra() : null;
  if (x?.fcntl && x.fcntl(fd, 51 /* F_FULLFSYNC */, 0) === 0) return;
  fsyncSync(fd);
}

/**
 * A file replaced atomically and durably (Codex r7 MEDIUM 3, Opus r7 INFO 9): an exclusive temporary file, flushed
 * to the disk itself, renamed over `path`, and its directory flushed too.
 */
export function writeDurably(path: string, text: string, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, text);
    fullSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* */ }
    throw err;
  }
  closeSync(fd);
  try { renameSync(tmp, path); } catch (err) { try { unlinkSync(tmp); } catch { /* */ } throw err; }
  const dfd = openSync(dirname(path), "r");
  try { fullSync(dfd); } finally { closeSync(dfd); }
}

/** Mount points owned by (mounted by) `uid` (macOS: statfs f_owner of every mount; Linux: FUSE mounts' user_id). */
export function userMounts(uid: number): string[] {
  if (process.platform === "darwin") {
    const x = extra();
    const { read } = lib();
    const { CString } = require("bun:ffi") as typeof import("bun:ffi");
    const cell = new BigUint64Array(1);
    const n = (x.getmntinfo as NonNullable<Extra["getmntinfo"]>)(cell, 2 /* MNT_NOWAIT */);
    if (n <= 0) fail("getmntinfo");
    const base = Number(cell[0]);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * 2168; // sizeof(struct statfs), 64-bit inodes
      if (read.u32(base as unknown as Ptr, o + 56) === uid) out.push(new CString((base + o + 88) as unknown as Ptr).toString());
    }
    return out;
  }
  const text = readFileSync("/proc/self/mountinfo", "utf8");
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const [pre, post] = line.split(" - ");
    if (!pre || !post) continue;
    const mnt = pre.split(" ")[4];
    const [fstype, , opts] = post.split(" ");
    if (mnt && fstype?.startsWith("fuse") && (opts ?? "").split(",").includes(`user_id=${uid}`)) {
      out.push(mnt.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8))));
    }
  }
  return out;
}

/** Force-unmounts a mount point (root, the helper's destroy). */
export function forceUnmount(path: string): void {
  const x = extra();
  const r = process.platform === "darwin"
    ? (x.unmount as NonNullable<Extra["unmount"]>)(cname(path), 0x80000 /* MNT_FORCE */)
    : (x.umount2 as NonNullable<Extra["umount2"]>)(cname(path), 1 | 2 /* MNT_FORCE | MNT_DETACH */);
  if (r !== 0) fail("unmount");
}

/** The entry names of the directory `dirfd` refers to (raw bytes; not `.` or `..`). `dirfd` stays open. */
export function listDir(dirfd: number): Uint8Array[] {
  const { L, f, read, toArrayBuffer } = lib();
  const dup = f.dup(dirfd);
  if (dup < 0) fail("dup");
  const d = f.fdopendir(dup);
  if (!d) { try { closeSync(dup); } catch { /* */ } fail("fdopendir"); }
  const cell = errnoCell();
  const out: Uint8Array[] = [];
  try {
    for (;;) {
      cell[0] = 0;
      const e = f.readdir(d);
      if (!e) {
        if (cell[0] !== 0) fail("readdir");
        break;
      }
      let len: number;
      if (L.dirent.namlen !== null) len = read.u16(e, L.dirent.namlen);
      else { len = 0; while (len < 256 && read.u8(e, L.dirent.name + len) !== 0) len++; }
      const name = new Uint8Array(toArrayBuffer(e, L.dirent.name, len)).slice(); // copied: readdir reuses its buffer
      if ((len === 1 && name[0] === 0x2e) || (len === 2 && name[0] === 0x2e && name[1] === 0x2e)) continue;
      out.push(name);
    }
  } finally {
    f.closedir(d); // closes the dup
  }
  return out;
}

export function closeFd(fd: number): void {
  try { closeSync(fd); } catch { /* already closed */ }
}

export function fdIdentity(fd: number): { dev: number; ino: number } {
  const st = fstatSync(fd);
  return { dev: st.dev, ino: st.ino };
}

let tested: string | null | undefined;

/**
 * The layouts above, checked against node:fs on this machine (a directory, a sticky one, a symlink, a listing):
 * null when they agree, else why (and nothing is swept).
 */
export function selfTest(): string | null {
  if (tested !== undefined) return tested;
  try {
    const at = AT_FDCWD();
    for (const p of ["/", process.platform === "darwin" ? "/private/tmp" : "/tmp", "/usr/bin", process.platform === "darwin" ? "/tmp" : "/proc/self"]) {
      const a = statAt(at, p);
      const b = lstatSync(p);
      if (a.dev !== b.dev || a.ino !== b.ino || a.mode !== b.mode || a.uid !== b.uid) throw new Error(`fstatat disagrees with lstat on ${p}`);
    }
    const fd = openDirAt(at, "/");
    try {
      const mine = listDir(fd).map((n) => Buffer.from(n).toString()).sort();
      const theirs = readdirSync("/").sort();
      if (mine.join("\0") !== theirs.join("\0")) throw new Error("readdir disagrees with node:fs on /");
    } finally { closeFd(fd); }
    tested = null;
  } catch (err) {
    tested = `this platform's file layout couldn't be verified (${(err as Error).message})`;
  }
  return tested;
}
