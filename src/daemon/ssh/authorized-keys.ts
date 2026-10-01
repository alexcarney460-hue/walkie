import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, mkdirSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { readPrivate, writePrivate } from "../provision/files.ts";
import { withOwnerKeysLock } from "./keys-lock.ts";

const tagPart = /^[A-Za-z0-9_-]{1,80}$/;

function tag(team: string, handle: string): string {
  if (!tagPart.test(team) || !tagPart.test(handle)) throw new Error("invalid owner key tag");
  return `walkie-owner:${team}:${handle}`;
}

export function ownerKeyLine(team: string, handle: string, publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  if (parts[0] !== "ssh-ed25519" || !parts[1] || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) throw new Error("an ed25519 SSH public key is required");
  const raw = Buffer.from(parts[1], "base64");
  // OpenSSH's blob contains the algorithm name and exactly 32 public-key bytes.
  if (raw.toString("base64") !== parts[1] || raw.length !== 51 || raw.readUInt32BE(0) !== 11 ||
      raw.subarray(4, 15).toString() !== "ssh-ed25519" || raw.readUInt32BE(15) !== 32) throw new Error("invalid ed25519 SSH public key");
  return `from="127.0.0.1,::1" ssh-ed25519 ${parts[1]} ${tag(team, handle)}`;
}

function keysPath(home: string): string {
  const dir = join(home, ".ssh");
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(".ssh must be a directory, not a link");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(dir, { mode: 0o700 });
  }
  chmodSync(dir, 0o700);
  return join(dir, "authorized_keys");
}

function read(path: string): Buffer {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("authorized_keys must be a regular file, not a link");
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw err;
  }
}

interface KeyVersion { contents: Buffer; stat: BigIntStats | null; hash: string }
function version(path: string): KeyVersion {
  let stat: BigIntStats | null = null;
  try {
    stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("authorized_keys must be a regular file, not a link");
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const contents = stat ? readFileSync(path) : Buffer.alloc(0);
  return { contents, stat, hash: createHash("sha256").update(contents).digest("hex") };
}

function unchanged(a: KeyVersion, b: KeyVersion): boolean {
  if (!a.stat || !b.stat) return a.stat === b.stat;
  return a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino && a.stat.size === b.stat.size &&
    a.stat.mtimeNs === b.stat.mtimeNs && a.hash === b.hash;
}

/**
 * The mode the person's file already has: Walkie's edit must not change who can read it. sshd refuses a file that
 * others can write, so that is the only case tightened (to 0600); a file Walkie creates is private.
 */
function keptMode(stat: BigIntStats | null): number {
  if (!stat) return 0o600;
  const mode = Number(stat.mode & 0o777n);
  return mode & 0o022 ? 0o600 : mode;
}

/** An unchanged file other people can write is still tightened: sshd would refuse it. */
function refuseOthersWriting(path: string): void {
  if (lstatSync(path).mode & 0o022) chmodSync(path, 0o600);
}

/** The complete new bytes reach the disk under a temp name before anything is renamed over the person's file. */
function writeDurably(path: string, bytes: Buffer, mode: number, sync: typeof fsyncSync): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    for (let at = 0; at < bytes.length;) {
      const written = writeSync(fd, bytes, at, bytes.length - at);
      if (written <= 0) throw new Error("authorized_keys write made no progress");
      at += written;
    }
    fchmodSync(fd, mode);
    sync(fd);
  } finally { closeSync(fd); }
}

function syncDirectory(dir: string, sync: typeof fsyncSync): void {
  const fd = openSync(dir, "r");
  try { sync(fd); } finally { closeSync(fd); }
}

/**
 * Retry a competing editor's change without ever renaming bytes from a stale read. The temp file is synced before the
 * rename and the directory after it, as writePrivate does, so a crash leaves the old file or the new one, never an
 * empty or partial authorized_keys that locks the person out.
 */
function editKeys<T>(path: string, apply: (contents: Buffer) => { next: Buffer; result: T },
  beforeRename?: () => void, sync: typeof fsyncSync = fsyncSync): T {
  for (let attempt = 0; attempt < 4; attempt++) {
    const observed = version(path);
    const { next, result } = apply(observed.contents);
    if (next.equals(observed.contents)) return result;
    const tmp = `${path}.walkie-${randomBytes(8).toString("hex")}`;
    try {
      writeDurably(tmp, next, keptMode(observed.stat), sync);
      beforeRename?.();
      if (!unchanged(observed, version(path))) continue;
      renameSync(tmp, path);
      syncDirectory(dirname(path), sync);
      return result;
    } finally { rmSync(tmp, { force: true }); }
  }
  throw new Error("authorized_keys changed during Walkie's edit; retry after other key edits finish");
}

interface ManagedLine { line: string; added_separator: boolean; previous?: ManagedLine }
type ManagedKeys = Record<string, ManagedLine>;

function managedPath(home: string): string { return join(home, ".ssh", "walkie-owner-keys.json"); }

export interface OwnerKeySnapshot { readonly keys: Buffer | null; readonly managed: unknown | null }

/** Capture both files before install so a failed transaction can restore authorized_keys byte for byte. */
export function snapshotOwnerKeys(home: string): OwnerKeySnapshot {
  const path = keysPath(home);
  const keys = read(path);
  const exists = (() => { try { lstatSync(path); return true; } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  } })();
  const raw = readPrivate(managedPath(home));
  if (raw !== null) managed(home);
  return { keys: exists ? keys : null, managed: raw === null ? null : JSON.parse(raw) as unknown };
}

export function restoreOwnerKeys(home: string, snapshot: OwnerKeySnapshot, sync: typeof fsyncSync = fsyncSync): void {
  const path = keysPath(home);
  withOwnerKeysLock(path, () => {
    const current = managed(home);
    const before = snapshot.keys ?? Buffer.alloc(0);
    editKeys(path, (contents) => {
      let next = contents;
      for (const entry of Object.values(current)) {
        for (const part of [entry, entry.previous]) {
          if (part && lineStart(before, part.line) < 0) next = withoutManaged(next, part).next;
        }
      }
      return { next, result: undefined };
    }, undefined, sync);
    if (snapshot.managed === null) rmSync(managedPath(home), { force: true });
    else writePrivate(managedPath(home), snapshot.managed);
  });
}

function managed(home: string): ManagedKeys {
  const raw = readPrivate(managedPath(home));
  if (raw === null) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("managed SSH keys record is invalid");
  for (const entry of Object.values(value)) {
    const current = entry as ManagedLine | null;
    if (!current || typeof current !== "object" || typeof current.line !== "string" || !/^[\x20-\x7e]+$/.test(current.line) ||
        typeof current.added_separator !== "boolean" ||
        (current.previous !== undefined && (!current.previous || typeof current.previous.line !== "string" ||
          !/^[\x20-\x7e]+$/.test(current.previous.line) || typeof current.previous.added_separator !== "boolean" || current.previous.previous !== undefined))) {
      throw new Error("managed SSH keys record is invalid");
    }
  }
  return value as ManagedKeys;
}

function lineStart(contents: Buffer, line: string): number {
  const marker = Buffer.from(line, "ascii");
  let start = contents.indexOf(marker);
  while (start >= 0) {
    if ((start === 0 || contents[start - 1] === 10) &&
        (start + marker.length === contents.length || contents[start + marker.length] === 10)) return start;
    start = contents.indexOf(marker, start + 1);
  }
  return -1;
}

function withoutManaged(contents: Buffer, entry: ManagedLine): { next: Buffer; removed: boolean } {
  const start = lineStart(contents, entry.line);
  if (start < 0) return { next: contents, removed: false };
  const lineEnd = start + Buffer.byteLength(entry.line, "ascii");
  const end = lineEnd + (contents[lineEnd] === 10 ? 1 : 0);
  const cut = entry.added_separator && start > 0 && end === contents.length ? start - 1 : start;
  return { next: Buffer.concat([contents.subarray(0, cut), contents.subarray(end)]), removed: true };
}

/** Only lines recorded when Walkie installed them are replaced; arbitrary matching comments are untouched. */
export function authorizeOwnerKey(home: string, team: string, handle: string, publicKey: string,
  afterWrite?: (step: "record_prepared" | "before_rename" | "key_written" | "record_finalized") => void,
  sync: typeof fsyncSync = fsyncSync): void {
  const line = ownerKeyLine(team, handle, publicKey);
  const path = keysPath(home);
  withOwnerKeysLock(path, () => {
    const key = tag(team, handle);
    const records = managed(home);
    const previous = records[key];
    if (previous?.line === line && lineStart(read(path), line) >= 0) { refuseOthersWriting(path); return; }
    // A prepared record includes both generations until the replacement is verified.
    writePrivate(managedPath(home), { ...records, [key]: { line, added_separator: false,
      ...(previous ? { previous: { line: previous.line, added_separator: previous.added_separator } } : {}) } });
    afterWrite?.("record_prepared");
    let nextEntry: ManagedLine = { line, added_separator: false };
    editKeys(path, (old) => {
      const retained = previous ? [previous, previous.previous].filter((entry): entry is ManagedLine => !!entry)
        .reduce((contents, entry) => withoutManaged(contents, entry).next, old) : old;
      if (lineStart(retained, line) >= 0) throw new Error("identical untracked SSH key already exists");
      const separator = retained.length > 0 && retained[retained.length - 1] !== 10;
      nextEntry = { line, added_separator: separator };
      writePrivate(managedPath(home), { ...records, [key]: { ...nextEntry,
        ...(previous ? { previous: { line: previous.line, added_separator: previous.added_separator } } : {}) } });
      return { next: Buffer.concat([retained, Buffer.from(`${separator ? "\n" : ""}${line}\n`, "ascii")]), result: undefined };
    }, () => afterWrite?.("before_rename"), sync);
    afterWrite?.("key_written");
    writePrivate(managedPath(home), { ...records, [key]: nextEntry });
    afterWrite?.("record_finalized");
  });
}

export function revokeOwnerKeys(home: string, team: string, handle: string,
  beforeRename?: () => void, sync: typeof fsyncSync = fsyncSync): number {
  const path = keysPath(home);
  return withOwnerKeysLock(path, () => {
    const key = tag(team, handle);
    const records = managed(home);
    const entry = records[key];
    if (!entry) return 0;
    const removed = editKeys(path, (old) => {
      const result = [entry, entry.previous].filter((part): part is ManagedLine => !!part)
        .reduce((state, part) => {
          const removal = withoutManaged(state.next, part);
          return { next: removal.next, removed: state.removed + (removal.removed ? 1 : 0) };
        }, { next: old, removed: 0 });
      return { next: result.next, result: result.removed };
    }, beforeRename, sync);
    const { [key]: ignored, ...retained } = records;
    void ignored;
    writePrivate(managedPath(home), retained);
    return removed;
  });
}

export function hasOwnerKey(home: string, team: string, handle: string, publicKey?: string): boolean {
  const expected = publicKey ? ownerKeyLine(team, handle, publicKey) : null;
  const line = managed(home)[tag(team, handle)]?.line;
  return !!line && (!expected || expected === line) && lineStart(read(keysPath(home)), line) >= 0;
}
