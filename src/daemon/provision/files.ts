import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** The Walkie home is 0700. Never follow a preexisting grant/journal symlink. */
export function readPrivate(path: string): string | null {
  let stat;
  try { stat = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("provision state is not a private regular file");
  return readFileSync(path, "utf8");
}

export function writePrivate(path: string, value: unknown, syncDirectory: typeof fsyncSync = fsyncSync): void {
  const old = readPrivate(path);
  void old;
  const tmp = join(dirname(path), `.provision-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    const dir = openSync(dirname(path), "r");
    try { syncDirectory(dir); } finally { closeSync(dir); }
  } catch (e) { try { unlinkSync(tmp); } catch { /* absent */ } throw e; }
}
