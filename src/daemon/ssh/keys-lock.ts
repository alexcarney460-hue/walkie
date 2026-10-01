import { dlopen, FFIType } from "bun:ffi";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;
type Flock = (fd: number, operation: number) => number;
let flockFn: Flock | null = null;

function flock(): Flock {
  if (flockFn) return flockFn;
  const lib = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const { symbols } = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  flockFn = (fd, operation) => symbols.flock(fd, operation) as number;
  return flockFn;
}

/** The sibling inode is never removed: another editor must not lock a replacement inode. */
export function withOwnerKeysLock<T>(keysPath: string, edit: () => T): T {
  const path = `${keysPath}.walkie.lock`;
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const held = fstatSync(fd);
    const named = lstatSync(path);
    if (!held.isFile() || !named.isFile() || held.dev !== named.dev || held.ino !== named.ino ||
      held.uid !== process.getuid?.() || (held.mode & 0o077) !== 0) {
      throw new Error("owner SSH key lock file is unsafe");
    }
    chmodSync(path, 0o600);
    if (flock()(fd, LOCK_EX | LOCK_NB) !== 0) throw new Error("owner SSH key edit is already in progress");
    const current = lstatSync(path);
    if (current.dev !== held.dev || current.ino !== held.ino) throw new Error("owner SSH key lock file changed");
    return edit();
  } finally { closeSync(fd); }
}
