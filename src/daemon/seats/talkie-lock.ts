// Keep the lock separate from SQLite: on macOS flocking the database blocks its own transactions.
// The inode persists across operations; a missing one is made exclusively and then reopened.
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { aclAllowsWrite } from "./admin-acl.ts";
import type { AdminSys } from "./admin.ts";

const LOCK_EX = 2;
const LOCK_NB = 4;
type Flock = (fd: number, op: number) => number;
let flockFn: Flock | null = null;
let flockErrno: (() => number) | null = null;

function flock(): Flock {
  if (flockFn) return flockFn;
  const lib = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const errnoName = process.platform === "darwin" ? "__error" : "__errno_location";
  const { symbols } = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoName]: { args: [], returns: FFIType.ptr } });
  flockFn = (fd, op) => symbols.flock(fd, op) as number;
  const errnoSymbol = symbols[errnoName];
  if (!errnoSymbol) throw new Error("libc errno is unavailable");
  flockErrno = () => {
    const pointer = errnoSymbol();
    if (!pointer) throw new Error("libc errno pointer is unavailable");
    return new Int32Array(toArrayBuffer(pointer, 0, 4))[0] as number;
  };
  return flockFn;
}

export function unsafeTalkieLockPermissions(mode: number, uid: number, root: boolean): boolean {
  return root ? (mode & 0o777) !== 0o600 || uid !== 0 : (mode & 0o022) !== 0;
}

type LockParent = { dev: number; ino: number; uid: number; mode: number; directory: boolean; symlink: boolean; aclWritable: boolean };

function inspectLockParent(path: string): LockParent {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) return { dev: before.dev, ino: before.ino, uid: before.uid, mode: before.mode,
    directory: false, symlink: true, aclWritable: false };
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${path}: lock parent changed while opening`);
    return { dev: opened.dev, ino: opened.ino, uid: opened.uid, mode: opened.mode,
      directory: opened.isDirectory(), symlink: false, aclWritable: process.platform === "darwin" && aclAllowsWrite(fd) };
  } finally { closeSync(fd); }
}

/** Every ancestor must be a stable, root-controlled directory before a root lock path can be used. */
export function verifySeatLockParents(path: string, root: boolean,
  inspect: (part: string) => LockParent = inspectLockParent): LockParent[] {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("the seat lock path is not an absolute canonical path");
  if (!root) return []; // Temporary test locks do not run as the root helper.
  const parts = dirname(path).split(sep).filter(Boolean);
  const chain: string[] = [sep];
  for (const part of parts) chain.push(join(chain[chain.length - 1] as string, part));
  return chain.map((part) => {
    const state = inspect(part);
    if (state.symlink || !state.directory) throw new Error(`${part}: seat lock parent is a symlink or not a directory`);
    if (root && state.uid !== 0) throw new Error(`${part}: seat lock parent is not root-owned`);
    if (root && (state.mode & 0o022) !== 0) throw new Error(`${part}: seat lock parent is writable by group or others`);
    if (root && state.aclWritable) throw new Error(`${part}: seat lock parent ACL grants write access`);
    return state;
  });
}

function verifyParentsUnchanged(path: string, root: boolean, initial: readonly LockParent[]): void {
  if (!root) return;
  const held = verifySeatLockParents(path, root);
  if (held.some((part, i) => part.dev !== initial[i]?.dev || part.ino !== initial[i]?.ino))
    throw new Error("the seat lock parent path changed");
}

export async function withTalkieLock<T>(sys: AdminSys, create: boolean, work: () => Promise<T>,
  onCreateFailure?: (error: unknown) => Promise<T>): Promise<T> {
  if (create) sys.ledger(); // Initializes the root-owned directory before making the lock file.
  const path = sys.talkieLockPath ?? `${sys.ledger().path}.talkie.lock`;
  return withSeatFileLock(path, !!sys.talkieLockRoot, work, onCreateFailure);
}

/** A separate persistent inode serializes slow filesystem work without holding a SQLite write transaction. */
export async function withSeatFileLock<T>(path: string, root: boolean, work: () => Promise<T>,
  onCreateFailure?: (error: unknown) => Promise<T>): Promise<T> {
  const parents = verifySeatLockParents(path, root);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    try {
      const made = openSync(path, constants.O_RDONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(made);
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") {
        if (onCreateFailure) return onCreateFailure(createError);
        throw createError;
      }
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    if (!opened.isFile() || !current.isFile() || opened.ino !== current.ino || opened.dev !== current.dev
      || unsafeTalkieLockPermissions(opened.mode, opened.uid, root) || (root && opened.gid !== 0)) {
      throw new Error("the seat helper lock file is unsafe");
    }
    const deadline = Date.now() + 120_000;
    while (flock()(fd, LOCK_EX | LOCK_NB) !== 0) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for the dedicated user lock");
      await Bun.sleep(10);
    }
    // Detect a replaced path after waiting, before any account or ledger action.
    const held = lstatSync(path);
    if (held.ino !== opened.ino || held.dev !== opened.dev) throw new Error("the dedicated user lock file changed");
    verifyParentsUnchanged(path, root, parents);
    return await work();
  } finally { closeSync(fd); }
}

/** The root helper's outer lock. Held before any seat-user mutation, including Talkie operations. */
export async function withSeatAdminLock<T>(path: string, root: boolean, work: () => Promise<T>, waitMs = 3_000): Promise<T> {
  const parents = verifySeatLockParents(path, root);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
  }
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino
      || (opened.mode & 0o777) !== 0o600 || (root && (opened.uid !== 0 || opened.gid !== 0)))
      throw new Error("the seat admin cleanup lock file is unsafe");
    const deadline = Date.now() + waitMs;
    while (flock()(fd, LOCK_EX | LOCK_NB) !== 0) {
      const errno = flockErrno?.();
      if (errno !== (process.platform === "darwin" ? 35 : 11) && errno !== 4)
        throw new Error(`the seat admin cleanup lock could not be acquired (errno ${errno})`);
      if (errno !== 4 && Date.now() >= deadline) throw new SeatAdminBusyError();
      await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    const held = lstatSync(path);
    if (held.dev !== opened.dev || held.ino !== opened.ino) throw new Error("the seat admin cleanup lock file changed");
    verifyParentsUnchanged(path, root, parents);
    return await work();
  } finally { closeSync(fd); }
}

export class SeatAdminBusyError extends Error {
  constructor() { super("busy: another cleanup helper is still running"); }
}
