import { dlopen, ptr, FFIType } from "bun:ffi";
import type { Socket } from "node:net";
import { agentProcessOf, readProcessStartTime, readProcessTable, type ProcRow } from "../../cli/agent-detect.ts";

export interface SshCaller { caller: string; claim?: string }

/** Caller classification is best effort; the socket peer start time rejects a reused PID. */
export function classifySshCaller(pid: number | null, table: ReadonlyMap<number, ProcRow> | null,
  claim?: string, peerStartTime?: string | null): SshCaller {
  let caller = "unverified caller";
  if (pid && table && peerStartTime && table.get(pid)?.startTime === peerStartTime) {
    const seen = new Set<number>();
    for (let current = pid, depth = 0; current > 1 && depth < 64 && !seen.has(current); depth++) {
      seen.add(current);
      const row = table.get(current);
      if (!row?.startTime || row.ppid < 1) break;
      // argv[0] and the command line can be rewritten by the caller. Only the
      // OS-reported executable is enough to name an agent in this audit hint.
      const observed = row.executable ? agentProcessOf(row.executable) : null;
      if (observed) { caller = observed; break; }
      current = row.ppid;
    }
  }
  return { caller, ...(claim ? { claim } : {}) };
}

/** OS credentials of this connected Unix socket, never a value from its request bytes. */
export function socketPeerPid(socket: Socket): number | null {
  const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd;
  if (!Number.isInteger(fd) || (fd as number) < 0) return null;
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") return null;
  try {
    const lib = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    try {
      const value = new Uint8Array(mac ? 4 : 12); // pid_t or Linux struct ucred
      const length = new Uint32Array([value.byteLength]);
      const ok = lib.symbols.getsockopt(fd as number, mac ? 0 : 1, mac ? 2 : 17, ptr(value), ptr(length));
      if (ok !== 0 || length[0]! < 4) return null;
      const pid = new DataView(value.buffer).getInt32(0, true);
      if (!mac && process.getuid && length[0]! >= 8 && new DataView(value.buffer).getUint32(4, true) !== process.getuid()) return null;
      return pid > 1 ? pid : null;
    } finally { lib.close(); }
  } catch { return null; }
}

export function observedSshCaller(socket: Socket, claim?: string): SshCaller {
  const pid = socketPeerPid(socket);
  const startTime = pid ? readProcessStartTime(pid) : null;
  return classifySshCaller(pid, startTime ? readProcessTable() : null, claim, startTime);
}
