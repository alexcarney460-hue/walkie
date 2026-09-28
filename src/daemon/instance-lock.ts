// One daemon per socket path (SEC-COOKIE-2). An exclusive flock(2) on `<socket>.lock`, taken before the socket
// is probed, unlinked or bound and held until the daemon stops, so two starters can't both decide a socket is
// stale and one unlink the other's fresh socket. The kernel drops the lock when its holder exits, however it
// exits, so a lockfile left behind is never "stale": the file is not deleted on stop (deleting it would let a
// waiting starter lock the old inode while a third locks a new one), and nothing ever needs to clean it up.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;

type Flock = (fd: number, op: number) => number;
let flockFn: Flock | null = null;

function flock(): Flock {
  if (flockFn) return flockFn;
  const lib = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const { symbols } = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  flockFn = (fd, op) => symbols.flock(fd, op) as number;
  return flockFn;
}

export interface InstanceLock { readonly path: string; release(): void }

/** Takes the lock without waiting, or throws "another walkie daemon is already running …". */
export function acquireInstanceLock(socketPath: string): InstanceLock {
  const path = `${socketPath}.lock`;
  const fd = openSync(path, "a", 0o600);
  if (flock()(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    throw new Error(`another walkie daemon is already running for ${socketPath} (it holds ${path})`);
  }
  let held = true;
  return {
    path,
    release() {
      if (!held) return;
      held = false;
      closeSync(fd); // closing the only descriptor releases the flock
    },
  };
}
