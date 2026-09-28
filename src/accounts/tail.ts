// Reads the last bytes of a (possibly large, append-only) log file.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export function tailText(path: string, bytes: number): string {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
