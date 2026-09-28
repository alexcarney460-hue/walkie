// Blocking writes to stdout/stderr. Bun's process.stdout.write to a pipe is asynchronous, and the CLI ends with
// process.exit(): whatever the pipe had not taken yet was lost, so `walkie who --json | jq` saw only the first
// 64 KB (WALKIE-MISSION-1). Every finite command's write goes through writeAll instead: it returns only once the kernel
// has taken every byte, waiting out EAGAIN on a non-blocking pipe, so an exit right after it loses nothing. (Finite
// commands install no SIGINT handler, so Ctrl-C still ends one blocked on a full pipe.) Streaming commands use
// writeStream, which waits asynchronously and reports a closed reader.
import { writeSync } from "node:fs";

const RETRY_MS = 2;

/** Writes all of `data` to the file descriptor, blocking until it is taken; a closed reader (EPIPE) ends quietly. */
export function writeAll(fd: number, data: string | Uint8Array): void {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let off = 0;
  while (off < buf.byteLength) {
    try {
      off += writeSync(fd, buf, off, buf.byteLength - off);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EINTR") { Bun.sleepSync(RETRY_MS); continue; }
      if (code === "EPIPE") return; // the reader went away (`walkie who | head`): nothing left to deliver
      throw err;
    }
  }
}

export const writeOut = (data: string | Uint8Array): void => writeAll(1, data);
export const writeErr = (data: string | Uint8Array): void => writeAll(2, data);

/** The reader of a stream's output went away (EPIPE): a streaming command ends (`walkie subscribe | head -n 1`). */
export class OutputClosed extends Error {
  constructor() { super("output closed"); }
}

/**
 * For streaming commands (fix round 1, Codex 9): writes all of `data` like writeAll, but waits out a full pipe
 * asynchronously, so a SIGINT handler still runs while the reader is slow, and throws OutputClosed on EPIPE instead of
 * returning, so the stream stops instead of running on with nobody reading.
 */
export async function writeStream(fd: number, data: string | Uint8Array): Promise<void> {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let off = 0;
  while (off < buf.byteLength) {
    try {
      off += writeSync(fd, buf, off, buf.byteLength - off);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EINTR") { await Bun.sleep(RETRY_MS); continue; }
      if (code === "EPIPE") throw new OutputClosed();
      throw err;
    }
  }
}
