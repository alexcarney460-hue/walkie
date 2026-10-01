import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = process.platform === "darwin" ? "/Library/Application Support/Walkie" : "/var/lib/walkie";
const CONTENT = '{"company_mode":true}\n';
const UNENROLLED = '{"company_mode":false}\n';
const testRoots = new Map<string, string>();

/** The root-owned directory the enrollment keeps its marker in (and stages root-batch scripts under): fixed per platform, never read from the environment. */
export function systemEnrollmentRoot(): string { return ROOT; }

/** Test harness only: isolated daemons must not alter the host's system enrollment state. */
export function setTestEnrollmentRoot(home: string, root: string): void { testRoots.set(resolve(home), root); }
export function enrollmentPath(home: string): string {
  const key = createHash("sha256").update(resolve(home)).digest("hex").slice(0, 24);
  return join(testRoots.get(resolve(home)) ?? ROOT, `enrolled-${key}.json`);
}
const unenrolledPath = (home: string): string => enrollmentPath(home).replace(/\.json$/, ".unenrolled.json");

function rootDir(home: string): string { return testRoots.get(resolve(home)) ?? ROOT; }
function testRoot(home: string): boolean { return testRoots.has(resolve(home)); }
export function secureMarkerMetadata(stat: { uid: number; mode: number; isFile(): boolean }): boolean {
  return stat.isFile() && stat.uid === 0 && (stat.mode & 0o777) === 0o644;
}
/** There is no root-owned enrollment marker (yet): the enrollment's administrator step installs it. */
export class RootMarkerRequired extends Error {}
/** A marker is there but is not what Walkie installed: not root-owned with mode 0644, its content changed, or its directory is not protected. */
export class RootMarkerInvalid extends Error {}

export function requireEnrollmentRoot(home: string): void {
  let present: boolean;
  try {
    if (testRoot(home) && !rootMarkerPresent(home)) writeRootMarker(home);
    present = rootMarkerPresent(home);
  } catch (error) { throw new RootMarkerInvalid((error as Error).message); }
  if (!present) throw new RootMarkerRequired("root enrollment marker is required before consent is recorded");
}
function directorySecure(home: string): void {
  const stat = lstatSync(rootDir(home));
  if (!stat.isDirectory() || (!testRoot(home) && (stat.uid !== 0 || (stat.mode & 0o022) !== 0))) {
    throw new Error("enrollment root directory is not root-owned and protected");
  }
}

export function rootMarkerPresent(home: string): boolean {
  const path = enrollmentPath(home);
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  directorySecure(home);
  if (testRoot(home) ? !stat.isFile() || (stat.mode & 0o777) !== 0o644 : !secureMarkerMetadata(stat)) {
    throw new Error("enrollment marker is not a root-owned regular file with mode 0644");
  }
  if (readFileSync(path, "utf8") !== CONTENT) throw new Error("enrollment marker is unreadable");
  return true;
}

export function rootUnenrolled(home: string): boolean {
  const path = unenrolledPath(home);
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  directorySecure(home);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o644 || (!testRoot(home) && stat.uid !== 0) ||
    readFileSync(path, "utf8") !== UNENROLLED) throw new Error("un-enrollment record is invalid");
  return true;
}

/** Runs only in the root helper (or an isolated test root). Never trusts caller-supplied marker paths. */
export function writeRootMarker(home: string): void {
  if (!testRoot(home) && process.geteuid?.() !== 0) throw new Error("root is required for enrollment marker");
  mkdirSync(rootDir(home), { recursive: true, mode: 0o755 });
  directorySecure(home);
  chmodSync(rootDir(home), 0o755);
  if (rootMarkerPresent(home)) return;
  const path = enrollmentPath(home);
  const tmp = join(rootDir(home), `.enrolled-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, CONTENT, { flag: "wx", mode: 0o644 });
    chmodSync(tmp, 0o644);
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (error) { try { unlinkSync(tmp); } catch { /* absent */ } throw error; }
  if (!rootMarkerPresent(home)) throw new Error("enrollment marker was not installed");
  if (rootUnenrolled(home)) unlinkSync(unenrolledPath(home));
}

export function removeRootMarker(home: string): void {
  if (!testRoot(home) && process.geteuid?.() !== 0) throw new Error("root is required for un-enrollment");
  if (!rootMarkerPresent(home)) throw new Error("enrollment marker is missing");
  const tmp = join(rootDir(home), `.unenrolled-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, UNENROLLED, { flag: "wx", mode: 0o644 });
    chmodSync(tmp, 0o644);
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, unenrolledPath(home));
  } catch (error) { try { unlinkSync(tmp); } catch { /* absent */ } throw error; }
  unlinkSync(enrollmentPath(home));
}
