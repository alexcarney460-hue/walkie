// Small metadata files read on the daemon's hot paths (a session's .git/HEAD, Claude's sessions/<pid>.json, the hooks'
// state files): opened without following a final symlink and without blocking (a FIFO put in their place can't stall
// the daemon), read only when the opened descriptor is a regular file (of `uid`, when given) no larger than `max`
// (WALKIE-MISSION-1 fix round 2, Codex r2 #10).
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

export function readSmallFile(path: string, max: number, uid: number | null = null): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max || (uid !== null && st.uid !== uid)) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.byteLength) {
      const n = readSync(fd, buf, off, buf.byteLength - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** The same descriptor checks as readSmallFile, with filesystem work off the event loop. */
export async function readSmallFileAsync(path: string, max: number, uid: number | null = null): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const st = await file.stat();
    if (!st.isFile() || st.size > max || (uid !== null && st.uid !== uid)) return null;
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await file.read(buf, offset, buf.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset).toString("utf8");
  } catch { return null; }
  finally { await file?.close().catch(() => undefined); }
}
